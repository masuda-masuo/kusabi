// chain-control.mjs — Chain stop lever and ownership tracking.
//
// Pure functions for the file-based control protocol between a chain process
// and external CLI processes (cancel, serve-stop, status). No I/O from other
// modules; the single-writer rules are enforced by which functions each call
// site uses, not by this module.
//
// Single-writer rules (enforced by call sites):
//   - The chain process is the only writer of status, pid, container, round.
//   - The stop-requesting process only writes the stop request fields.
//   - Exception: when the chain process is gone (pid no longer exists),
//     the stop-requesting process may finalise the status.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { readJson, writeJson } from "./state-paths.mjs";
import { notifyChainTerminal, stateDirForChain } from "./chain-notify.mjs";
import { retireJobProgress } from "./kaiba-progress-retire.mjs";

/**
 * Extract the human-readable title from a chain brief.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function briefTitle(text) {
  if (typeof text !== "string" || text.length === 0) return "";

  const lines = text.split(/\r?\n/);
  const titleRegion = [];

  for (const line of lines) {
    if (/^\s*#{2,6}(?:\s+|$)/.test(line)) break;
    titleRegion.push(line);
  }

  let title = "";
  for (const line of titleRegion) {
    const heading = line.match(/^\s*#\s+(.*?)\s*$/);
    if (heading && heading[1].trim()) {
      title = heading[1].trim();
      break;
    }
  }

  if (!title) {
    for (const line of titleRegion) {
      const candidate = line.trim();
      if (
        candidate &&
        !candidate.startsWith("Orchestrator:") &&
        !candidate.startsWith("Container:")
      ) {
        title = candidate;
        break;
      }
    }
  }

  if (Array.from(title).length > 120) {
    title = Array.from(title).slice(0, 119).join("") + "…";
  }
  return title;
}

/**
 * The round's disposition, which is `{disposition, reason}` on live records
 * and a bare string on some older ones.
 *
 * Resolves the disposition string of the last record in a chain that has one,
 * or null.
 *
 * @param {object|Array} chainJsonOrRecords — parsed chain.json or its records array
 * @returns {string|null}
 */
export function dispositionOf(chainJsonOrRecords) {
  const records = Array.isArray(chainJsonOrRecords)
    ? chainJsonOrRecords
    : Array.isArray(chainJsonOrRecords?.records)
      ? chainJsonOrRecords.records
      : null;
  if (!records) return null;

  for (let i = records.length - 1; i >= 0; i -= 1) {
    const value = records[i]?.disposition;
    if (typeof value === "string") return value;
    if (value && typeof value.disposition === "string") return value.disposition;
  }
  return null;
}

/**
 * Build args for notifyChainTerminal from a chain directory + control record.
 * Shared by finalizeChainControl and the stale-pid path in requestChainStop.
 *
 * @param {string} chainDir
 * @param {object} existing — control record
 * @param {string} status — completed / cancelled / failed
 * @returns {object}
 */
export function buildNotifyArgs(chainDir, existing, status) {
  return buildNotifyArgsWithOptions(chainDir, existing, status);
}

function buildNotifyArgsWithOptions(chainDir, existing, status, options = {}) {
  if (existing?.terminalNotifyArgs && typeof existing.terminalNotifyArgs === "object") {
    return { ...existing.terminalNotifyArgs };
  }

  const chainJson = readJson(path.join(chainDir, "chain.json"));
  const chainId = existing.chainId || (chainJson && chainJson.chainId) || path.basename(chainDir);
  const disposition = Object.hasOwn(options, "disposition")
    ? options.disposition
    : dispositionOf(chainJson);
  const container = existing.container || chainJson?.container || null;
  const cwdLabel = briefTitle(chainJson?.brief);
  return {
    stateDir: stateDirForChain(chainDir),
    chainId,
    status,
    disposition,
    container,
    cwdLabel,
    ...(existing.errorReason !== undefined ? { errorReason: existing.errorReason } : {}),
    ...(existing.artifactsSurvive !== undefined ? { artifactsSurvive: existing.artifactsSurvive } : {}),
    ...(existing.artifactReference !== undefined ? { artifactReference: existing.artifactReference } : {}),
  };
}

/** @returns {string} */
export function chainControlFilePath(chainDir) {
  return path.join(chainDir, "control.json");
}

/**
 * Read the control record for a chain. Returns null if the file does not
 * exist or is unreadable.
 *
 * @param {string} chainDir
 * @returns {object|null}
 */
export function readChainControl(chainDir) {
  return readJson(chainControlFilePath(chainDir));
}

/**
 * Write a control record. The caller must supply the full record — this
 * function does not merge; that is the caller's responsibility.
 *
 * @param {string} chainDir
 * @param {object} control
 */
export function writeChainControl(chainDir, control) {
  writeJson(chainControlFilePath(chainDir), control);
}

/**
 * Create a fresh control record for a newly started chain.
 *
 * @param {object} opts
 * @param {string} opts.chainId
 * @param {string} opts.container
 * @param {number} opts.pid
 * @returns {object}
 */
export function createChainControl({ chainId, container, pid }) {
  return {
    chainId,
    container,
    pid,
    status: "running",
    round: 0,
    startedAt: new Date().toISOString(),
  };
}

/**
 * Write a stop request into the control file. This is called from a
 * *different* process than the chain. It only writes stop-request fields,
 * never status/pid/container.
 *
 * If the chain process is already gone (pid does not exist), it also
 * finalises the status to "cancelled" because otherwise no one ever will.
 *
 * @param {string} chainDir
 * @param {string} requestedBy — human-readable identity (e.g. "cli", "user")
 * @returns {{ chainId: string, wasRunning: boolean, wasStale: boolean }}
 */
export function requestChainStop(chainDir, requestedBy) {
  const observed = readChainControl(chainDir);
  if (!observed) {
    throw new Error(`no control record found for chain in ${chainDir}`);
  }

  const outcome = withControlWriteLock(chainDir, () => {
    const latest = readChainControl(chainDir);
    if (!latest) {
      throw new Error(`no control record found for chain in ${chainDir}`);
    }
    if (runMarker(latest) !== runMarker(observed)) {
      return { superseded: true, control: latest };
    }

    // Another stop from this run may have completed while this caller waited.
    // Reuse its durable result without replacing its lifecycle fields.
    if (latest.status !== "running") {
      if (latest.status === "cancelled" && observed.status === "running") {
        const claim = readOrCreateTerminalOccurrenceClaim(chainDir, latest, "cancelled");
        const control = {
          ...latest,
          terminalOccurrenceId: claim.terminalOccurrenceId,
          terminalNotifyArgs: claim.terminalNotifyArgs,
          finishedAt: claim.finishedAt,
        };
        notifyAndRetireTerminalRun(chainDir, control, "cancelled");
        return { control, wasStale: true };
      }
      const control = {
        ...latest,
        stopRequestedAt: new Date().toISOString(),
        stopRequestedBy: requestedBy,
      };
      writeChainControl(chainDir, control);
      return { control, wasRunning: false, wasStale: false };
    }

    const wasRunning = latest.status === "running";
    if (wasRunning && latest.pid != null && !isPidAlive(latest.pid)) {
      const notifyOptions = latest.resumedAt ? { disposition: null } : {};
      const control = persistTerminalControlLocked(chainDir, latest, "cancelled", {
        stopRequestedBy: requestedBy,
        stopRequestedAt: new Date().toISOString(),
      }, notifyOptions);
      notifyAndRetireTerminalRun(chainDir, control, "cancelled");
      return { control, wasStale: true };
    }

    const control = {
      ...latest,
      stopRequestedAt: new Date().toISOString(),
      stopRequestedBy: requestedBy,
    };
    writeChainControl(chainDir, control);
    return { control, wasRunning, wasStale: false };
  });

  if (outcome.superseded) {
    return {
      chainId: outcome.control.chainId,
      wasRunning: false,
      wasStale: false,
      superseded: true,
    };
  }

  if (outcome.wasStale) {
    const control = outcome.control;
    return {
      chainId: control.chainId,
      wasRunning: false,
      wasStale: true,
      terminalOccurrenceId: control.terminalOccurrenceId,
      terminalNotifyArgs: { ...control.terminalNotifyArgs },
    };
  }
  return {
    chainId: outcome.control.chainId,
    wasRunning: outcome.wasRunning,
    wasStale: false,
  };
}

/**
 * Check whether a PID corresponds to a living process.
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  if (!pid || typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the effective status of a control record, detecting stale records.
 *
 * A record that says "running" whose pid is gone is **stale** — reported as
 * "stale" rather than "running" or silently as "finished".
 *
 * @param {object} control
 * @returns {{ status: string, stale: boolean }}
 */
export function effectiveStatus(control) {
  if (!control) return { status: "unknown", stale: false };

  if (control.status === "running") {
    if (control.pid == null || !isPidAlive(control.pid)) {
      return { status: "stale", stale: true };
    }
    if (control.stopRequestedAt) {
      return { status: "stopping", stale: false };
    }
    return { status: "running", stale: false };
  }

  return { status: control.status, stale: false };
}

/**
 * The single predicate: should this chain stop now?
 *
 * Called by the chain process only. Returns true if either:
 *   - A file-based stop request exists (control.json has stopRequestedAt)
 *   - The caller passes `signalReceived: true` (SIGTERM/SIGINT was caught)
 *
 * Both paths go through the same predicate so no exit path is scattered.
 *
 * @param {object} opts
 * @param {string}  opts.chainDir
 * @param {boolean} [opts.signalReceived=false]
 * @returns {boolean}
 */
export function shouldStopNow({ chainDir, signalReceived = false }) {
  if (signalReceived) return true;

  const control = readChainControl(chainDir);
  if (!control) return false;
  return !!control.stopRequestedAt;
}

/**
 * Update the chain control record for a completed / cancelled round.
 * Only the chain process should call this.
 *
 * @param {object} opts
 * @param {string} opts.chainDir
 * @param {number} opts.round
 */
export function updateChainControlRound({ chainDir, round }) {
  const observed = readChainControl(chainDir);
  if (!observed) return;
  withControlWriteLock(chainDir, () => {
    const latest = readChainControl(chainDir);
    if (!latest || runMarker(latest) !== runMarker(observed)) return;
    writeChainControl(chainDir, { ...latest, round });
  });
}

/**
 * Re-arm a control record for a resumed run (kusabi #153①).
 *
 * Called by chain-resume before re-running the chain driver: sets status back
 * to "running" with the new process pid, advances the round counter to match
 * the resume position, clears the stop-request fields — shouldStopNow() keys
 * off stopRequestedAt, so a fresh stop must be requested for the resumed
 * run — and records resumedAt as the recovery trace.
 *
 * @param {object} opts
 * @param {string} opts.chainDir
 * @param {number} opts.round  — the round the resumed run continues at (the
 *        interrupted round for a review-resume, the last completed round
 *        otherwise).
 * @returns {object} The new control record.
 */
export function rearmChainControl({ chainDir, round }) {
  return withControlWriteLock(chainDir, () => {
    const existing = readChainControl(chainDir);
    if (!existing) {
      throw new Error(`no control record found for chain in ${chainDir}`);
    }
    const priorClaimPath = terminalOccurrenceClaimPath(chainDir, existing);
    const next = {
      ...existing,
      status: "running",
      pid: process.pid,
      round,
      stopRequestedAt: undefined,
      stopRequestedBy: undefined,
      finishedAt: undefined,
      terminalOccurrenceId: undefined,
      terminalNotifyArgs: undefined,
      terminalRunId: randomUUID(),
      resumedAt: new Date().toISOString(),
    };
    writeChainControl(chainDir, next);
    // A crash before cleanup leaves only harmless prior-run claim data: the
    // new terminalRunId selects a different claim path for the next occurrence.
    try {
      fs.unlinkSync(priorClaimPath);
    } catch {
      // Cleanup is best-effort after the rearm has become durable.
    }
    return next;
  });
}

/**
 * Finalise the chain control record on exit. Only the chain process should
 * call this. The stop request fields (if any) are preserved.
 *
 * @param {object} opts
 * @param {string} opts.chainDir
 * @param {string} opts.status — "completed", "cancelled", "failed"
 * @param {number} opts.round  — current round at exit time
 * @param {string} [opts.errorReason] — terminal guard reason
 * @param {boolean} [opts.artifactsSurvive] — whether implement artifacts remain
 * @param {string|null} [opts.artifactReference] — surviving implement job reference
 */
export function finalizeChainControl({ chainDir, status, round, errorReason, artifactsSurvive, artifactReference }) {
  const observed = readChainControl(chainDir);
  if (!observed) return;
  const isTerminal = ["completed", "cancelled", "failed"].includes(status);
  const outcome = withControlWriteLock(chainDir, () => {
    const latest = readChainControl(chainDir);
    if (!latest || runMarker(latest) !== runMarker(observed)) return { superseded: true };
    if (isTerminal) {
      const updates = {
        round,
        ...(errorReason !== undefined ? { errorReason } : {}),
        ...(artifactsSurvive !== undefined ? { artifactsSurvive } : {}),
        ...(artifactReference !== undefined ? { artifactReference } : {}),
      };
      const control = persistTerminalControlLocked(chainDir, latest, status, updates);
      notifyAndRetireTerminalRun(chainDir, control, status);
      return { control };
    }
    const control = { ...latest, status, round, finishedAt: new Date().toISOString() };
    writeChainControl(chainDir, control);
    return { control };
  });
  if (outcome.superseded) return;
}

function notifyAndRetireTerminalRun(chainDir, control, status) {
  // Keep terminal side effects inside the control-write lock so rearm cannot
  // make this run stale between its durable finalization and notification.
  try {
    notifyChainTerminal(buildNotifyArgs(chainDir, control, status));
  } catch {
    // Best-effort — never fail the chain for notify errors
  }
  // Job-scoped kaiba progress retirement is authoritative for this run only.
  sweepChainJobRetirement(chainDir);
}

function persistTerminalControlLocked(chainDir, latest, status, updates = {}, notifyOptions = {}) {
  const claim = readOrCreateTerminalOccurrenceClaim(chainDir, { ...latest, ...updates }, status, notifyOptions);
  const control = {
    ...latest,
    ...updates,
    status,
    finishedAt: claim.finishedAt,
    terminalOccurrenceId: claim.terminalOccurrenceId,
    terminalNotifyArgs: claim.terminalNotifyArgs,
  };
  writeChainControl(chainDir, control);
  return control;
}

function runMarker(control) {
  return control.terminalRunId || control.resumedAt || control.startedAt || "initial";
}

const CONTROL_LOCK_TIMEOUT_MS = 10_000;
const CONTROL_LOCK_ORPHAN_GRACE_MS = 30_000;

function withControlWriteLock(chainDir, fn) {
  const lockDir = path.join(chainDir, ".control-write.lock");
  const token = randomUUID();
  const deadline = Date.now() + CONTROL_LOCK_TIMEOUT_MS;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let acquired = false;

  while (!acquired) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({
        pid: process.pid,
        token,
      }), { flag: "wx" });
      acquired = true;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        try {
          fs.rmSync(lockDir, { recursive: true, force: true });
        } catch {
          // If cleanup fails, the orphan grace period lets another caller recover it.
        }
        throw error;
      }
      reclaimDeadControlLock(lockDir);
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for chain control lock in ${chainDir}`);
      }
      Atomics.wait(pause, 0, 0, 10);
    }
  }

  try {
    return fn();
  } finally {
    try {
      const ownerPath = path.join(lockDir, "owner.json");
      const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
      if (owner.token === token) fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // The lock may have been reclaimed after an owner crash.
    }
  }
}

function reclaimDeadControlLock(lockDir) {
  let owner;
  try {
    owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
  } catch {
    try {
      if (Date.now() - fs.statSync(lockDir).mtimeMs < CONTROL_LOCK_ORPHAN_GRACE_MS) return;
    } catch {
      return;
    }
  }
  if (owner) {
    try {
      process.kill(owner.pid, 0);
      return;
    } catch (error) {
      if (error?.code !== "ESRCH") return;
    }
  }
  const abandonedPath = lockDir + ".abandoned-" + randomUUID();
  try {
    fs.renameSync(lockDir, abandonedPath);
    fs.rmSync(abandonedPath, { recursive: true, force: true });
  } catch {
    // Another contender removed or replaced the stale directory.
  }
}

/**
 * Resolve a durable terminal claim path scoped to one chain run. The
 * terminalRunId changes on rearm, so stale prior-run claims cannot be reused.
 *
 * @param {string} chainDir
 * @param {object} control
 * @returns {string}
 */
function terminalOccurrenceClaimPath(chainDir, control) {
  const runKey = Buffer.from(runMarker(control)).toString("hex");
  return path.join(chainDir, ".terminal-occurrence-" + runKey + ".claim");
}

/**
 * Atomically publish one immutable event claim. The complete candidate is
 * written to a same-directory temp file before linkSync publishes it at the
 * unique claim path. linkSync chooses one winner; losers read that complete
 * record. This durable record is not a lock: after a crash, another caller can
 * reuse it and finish control persistence.
 *
 * @param {string} chainDir
 * @param {object} existing
 * @param {string} status
 * @returns {{terminalOccurrenceId:string, terminalNotifyArgs:object, finishedAt:string}}
 */
function readOrCreateTerminalOccurrenceClaim(chainDir, existing, status, notifyOptions = {}) {
  const claimPath = terminalOccurrenceClaimPath(chainDir, existing);
  const persistedId =
    typeof existing.terminalOccurrenceId === "string" && existing.terminalOccurrenceId.length > 0
      ? existing.terminalOccurrenceId
      : null;
  const persistedArgs =
    existing.terminalNotifyArgs &&
    typeof existing.terminalNotifyArgs === "object" &&
    !Array.isArray(existing.terminalNotifyArgs)
      ? existing.terminalNotifyArgs
      : null;
  const candidate = {
    terminalOccurrenceId: persistedId || randomUUID(),
    terminalNotifyArgs: persistedId && persistedArgs
      ? { ...persistedArgs, occurrenceId: persistedId }
      : {
          ...buildNotifyArgsWithOptions(chainDir, existing, status, notifyOptions),
          occurrenceId: persistedId || undefined,
        },
    finishedAt: existing.finishedAt || new Date().toISOString(),
  };
  if (!candidate.terminalNotifyArgs.occurrenceId) {
    candidate.terminalNotifyArgs.occurrenceId = candidate.terminalOccurrenceId;
  }

  const tmpPath = path.join(
    chainDir,
    ".terminal-occurrence-" + process.pid + "-" + randomUUID() + ".tmp",
  );
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(candidate) + "\n", { flag: "wx" });
    try {
      fs.linkSync(tmpPath, claimPath);
      return candidate;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      const winner = JSON.parse(fs.readFileSync(claimPath, "utf8"));
      if (
        typeof winner.terminalOccurrenceId !== "string" ||
        !winner.terminalOccurrenceId ||
        !winner.terminalNotifyArgs ||
        winner.terminalNotifyArgs.occurrenceId !== winner.terminalOccurrenceId ||
        typeof winner.finishedAt !== "string"
      ) {
        throw new Error("invalid terminal occurrence claim in " + chainDir);
      }
      return winner;
    }
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort temp cleanup; the claim is already durable if published.
    }
  }
}

/**
 * Retire the kaiba progress rows of every unique job id recorded in a chain's
 * chain.json — the implement, review, and replacement-review seats, including
 * each round record's top-level `reviewFirstJobId` — each exactly once
 * (Set-deduped), best-effort and idempotent. The chain id itself is never
 * retired: retirement is job-scoped and only `progress.job` values recorded by
 * dispatched workers are valid targets. Invalid/missing ids are skipped by
 * kaiba-progress-retire.mjs; malformed records are ignored. Never throws — a
 * sweep failure must not prevent chain finalisation.
 *
 * @param {string} chainDir
 */
function sweepChainJobRetirement(chainDir) {
  try {
    const chainJson = readJson(path.join(chainDir, "chain.json"));
    const records = Array.isArray(chainJson?.records) ? chainJson.records : [];
    const ids = new Set();
    for (const record of records) {
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      if (typeof record.implementJobId === "string") ids.add(record.implementJobId);
      if (typeof record.reviewJobId === "string") ids.add(record.reviewJobId);
      if (typeof record.reviewFirstJobId === "string") ids.add(record.reviewFirstJobId);
      if (Array.isArray(record.reviewSeatFailures)) {
        for (const seat of record.reviewSeatFailures) {
          if (!seat || typeof seat !== "object" || Array.isArray(seat)) continue;
          if (typeof seat.reviewJobId === "string") ids.add(seat.reviewJobId);
          if (typeof seat.reviewFirstJobId === "string") ids.add(seat.reviewFirstJobId);
        }
      }
    }
    for (const id of ids) {
      retireJobProgress({ jobId: id });
    }
  } catch {
    // Best-effort — never fail the chain for sweep errors.
  }
}

/**
 * Find the chain id for a given job, based on the job's title.
 * Chain job titles follow the pattern "chain: <chainId> round <N> <phase>".
 *
 * @param {object} job
 * @returns {string|null}
 */
export function chainIdForJob(job) {
  if (!job?.title) return null;
  const m = job.title.match(/^chain:\s+(\S+)\s+round\s+\d+/);
  return m ? m[1] : null;
}

/**
 * List all chain directories under the given state directory.
 *
 * @param {string} stateDir
 * @returns {string[]} Array of chain directory paths.
 */
export function listChainDirs(stateDir) {
  const chainsDir = path.join(stateDir, "chains");
  if (!fs.existsSync(chainsDir)) return [];
  try {
    return fs.readdirSync(chainsDir)
      .filter(function (name) { return name.startsWith("chain-"); })
      .map(function (name) { return path.join(chainsDir, name); })
      .filter(function (dir) {
        try { return fs.statSync(dir).isDirectory(); } catch { return false; }
      });
  } catch {
    return [];
  }
}

/**
 * Collect status information for all chains in the workspace.
 *
 * @param {string} stateDir
 * @returns {Array<{ chainId: string, status: string, round: number, container: string|null, stale: boolean }>}
 */
export function collectChainStatuses(stateDir) {
  const dirs = listChainDirs(stateDir);
  const results = [];
  for (const dir of dirs) {
    const control = readChainControl(dir);
    if (!control) continue;
    const { status, stale } = effectiveStatus(control);
    results.push({
      chainId: control.chainId,
      status,
      round: control.round ?? 0,
      container: control.container ?? null,
      stale,
    });
  }
  return results;
}
