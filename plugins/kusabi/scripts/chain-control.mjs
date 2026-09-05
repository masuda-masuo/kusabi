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
import { readJson, writeJson } from "./state-paths.mjs";
import { notifyChainTerminal, stateDirForChain } from "./chain-notify.mjs";

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
  const chainJson = readJson(path.join(chainDir, "chain.json"));
  const chainId = existing.chainId || (chainJson && chainJson.chainId) || path.basename(chainDir);
  const disposition = chainJson?.disposition?.disposition ?? null;
  const container = existing.container || chainJson?.container || null;
  let cwdLabel = "";
  if (chainJson?.brief) {
    cwdLabel = path.basename(chainJson.brief, path.extname(chainJson.brief));
  }
  return {
    stateDir: stateDirForChain(chainDir),
    chainId,
    status,
    disposition,
    container,
    cwdLabel,
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
  const existing = readChainControl(chainDir);
  if (!existing) {
    throw new Error(`no control record found for chain in ${chainDir}`);
  }

  const wasRunning = existing.status === "running";

  // Check liveness of the chain process
  if (wasRunning && existing.pid != null) {
    const alive = isPidAlive(existing.pid);
    if (!alive) {
      // The chain process is gone — finalise the status.
      // This is the exception to the single-writer rule.
      writeChainControl(chainDir, {
        ...existing,
        status: "cancelled",
        stopRequestedBy: requestedBy,
        stopRequestedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });
      // Host-side terminal notification for stale-chain cancellation
      try {
        notifyChainTerminal(buildNotifyArgs(chainDir, existing, "cancelled"));
      } catch {
        // Best-effort — never fail the chain for notify errors
      }
      return { chainId: existing.chainId, wasRunning: false, wasStale: true };
    }
  }

  // Write the stop request (only the stop-request fields are new).
  writeChainControl(chainDir, {
    ...existing,
    stopRequestedAt: new Date().toISOString(),
    stopRequestedBy: requestedBy,
  });

  return { chainId: existing.chainId, wasRunning, wasStale: false };
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
  const existing = readChainControl(chainDir);
  if (!existing) return;
  writeChainControl(chainDir, {
    ...existing,
    round,
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
  const existing = readChainControl(chainDir);
  if (!existing) {
    throw new Error(`no control record found for chain in ${chainDir}`);
  }
  const next = {
    ...existing,
    status: "running",
    pid: process.pid,
    round,
    stopRequestedAt: undefined,
    stopRequestedBy: undefined,
    finishedAt: undefined,
    resumedAt: new Date().toISOString(),
  };
  writeChainControl(chainDir, next);
  return next;
}

/**
 * Finalise the chain control record on exit. Only the chain process should
 * call this. The stop request fields (if any) are preserved.
 *
 * @param {object} opts
 * @param {string} opts.chainDir
 * @param {string} opts.status — "completed", "cancelled", "failed"
 * @param {number} opts.round  — current round at exit time
 */
export function finalizeChainControl({ chainDir, status, round }) {
  const existing = readChainControl(chainDir);
  if (!existing) return;
  writeChainControl(chainDir, {
    ...existing,
    status,
    round,
    finishedAt: new Date().toISOString(),
  });

  // Host-side terminal notification: inbox file + best-effort kaiba agenda.
  // Fail-soft — notify errors must never prevent the chain from finalising.
  if (["completed", "cancelled", "failed"].includes(status)) {
    try {
      notifyChainTerminal(buildNotifyArgs(chainDir, existing, status));
    } catch {
      // Best-effort — never fail the chain for notify errors
    }
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
