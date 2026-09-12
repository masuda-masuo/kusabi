// watch-chain.mjs — detached model-free watcher for kusabi chains AND tasks.
//
// The kusabi-codex-notify plugin bridges detached kusabi work back into the
// originating Codex thread: `chain-detach` / `task-detach` return immediately
// (the launcher is model-free), so no completion signal ever travels back to
// the caller.  This module owns the at-most-once notification side:
//
//   - for a CHAIN subject it runs one blocking
//     `kusabi-companion chain-wait <chainId>` invocation, parses the terminal
//     chain state (status / disposition / container), and queues exactly one
//     `codex queue --thread <threadId>` message;
//   - for a TASK subject it runs one blocking
//     `kusabi-companion task-wait <jobId>` invocation, parses the compact
//     digest (status, phase, failure), reads the durable job record for the
//     authoritative backend/model (including the fallback trail when one was
//     recorded), and queues exactly one notification that distinguishes the
//     four terminal classes (completed, provider-error/error,
//     timeout/stalled/serve-dead, cancelled) and names the exact recovery
//     commands (`kusabi-companion result <jobId>` / `status <jobId>`).
//
// A task-wait infrastructure failure (non-zero exit, missing digest, or a
// job id that disagrees with the requested one) is a SEPARATE watcher failure
// (OUTCOME_TASK_WAIT_FAILURE): it never queues and never touches the durable
// job record — result recovery through `result <job-id>` stays available.
//
// Chain and task registrations never collide: every record and claim persists
// an explicit `subject: { kind: "chain"|"task", id }`, and the on-disk keys
// (records/, claims/, claims/*.lock) are namespaced by kind rather than
// inferred from token shape.  Records and claims written by the previous
// kairanban-era plugin (unprefixed `records/<chainId>.json` /
// `claims/<chainId>.claim`) are still read as legacy chain subjects, so an
// upgrade in place never re-delivers an already-delivered chain.
//
// The two-phase claim machine, process identity checks, bounded queue retries
// and fail-closed in-flight boundary are shared by both kinds unchanged.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const OUTCOME_DELIVERED = "delivered";
export const OUTCOME_CLOSED_OR_UNAVAILABLE = "source Codex session/thread closed or unavailable";
export const OUTCOME_QUEUE_FAILURE = "queue command failure";
export const OUTCOME_CHAIN_WAIT_FAILURE = "chain-wait failure";
export const OUTCOME_TASK_WAIT_FAILURE = "task-wait failure";
export const OUTCOME_MALFORMED_REGISTRATION = "malformed registration";
export const OUTCOME_ALREADY_DELIVERED = "already delivered";
export const OUTCOME_AMBIGUOUS_DELIVERY = "ambiguous queue delivery";

export const MAX_DELIVERY_ATTEMPTS = 3;

/**
 * Terminal task statuses (the task-wait digest contract, mirroring
 * TERMINAL_TASK_STATUSES in plugins/kusabi/scripts/task-wait.mjs).  Every one
 * of them is a successful terminal OBSERVATION for the wait: they differ only
 * in how the notification classifies them.
 */
export const TASK_TERMINAL_STATUSES = new Set([
  "completed",
  "timeout",
  "cancelled",
  "provider-error",
  "error",
  "stalled",
  "serve-dead",
]);

export function getStateDir(customStateDir, env = process.env) {
  if (customStateDir && typeof customStateDir === "string" && customStateDir.trim()) {
    return path.resolve(customStateDir.trim());
  }
  if (env.KUSABI_CODEX_NOTIFY_STATE_DIR && env.KUSABI_CODEX_NOTIFY_STATE_DIR.trim()) {
    return path.resolve(env.KUSABI_CODEX_NOTIFY_STATE_DIR.trim());
  }
  const baseKusabi = env.KUSABI_STATE_DIR || path.join(os.homedir(), ".kusabi");
  return path.join(path.resolve(baseKusabi), "codex-notify");
}

/**
 * Computes kusabi workspace hash:
 * Kusabi's stateDirFor hashes path.resolve(cwd) as supplied, without realpath.
 */
export function getKusabiWorkspaceHash(cwd) {
  const resolved = path.resolve(cwd || process.cwd());
  return crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 12);
}

export function sanitizeIdentifier(id) {
  if (!id) return `unnamed-${Date.now()}`;
  return String(id).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
}

/**
 * Normalise a subject reference to `{ kind, id }`.
 * A bare string is a CHAIN id (the legacy call shape); an object must name
 * `kind` explicitly — the kind is never inferred from the id's token shape.
 */
export function normalizeSubject(subject) {
  if (subject && typeof subject === "object") {
    return { kind: subject.kind === "task" ? "task" : "chain", id: subject.id };
  }
  return { kind: "chain", id: subject };
}

export function subjectKey(subject) {
  const { kind, id } = normalizeSubject(subject);
  return `${kind}:${id}`;
}

/** Canonical record file for a subject: records/<kind>-<id>.json. */
export function getRecordPath(stateDir, subject) {
  const { kind, id } = normalizeSubject(subject);
  const safeId = sanitizeIdentifier(id);
  return path.join(stateDir, "records", `${kind}-${safeId}.json`);
}

/** Canonical claim file for a subject: claims/<kind>-<id>.claim. */
export function getClaimPath(stateDir, subject) {
  const { kind, id } = normalizeSubject(subject);
  const safeId = sanitizeIdentifier(id);
  return path.join(stateDir, "claims", `${kind}-${safeId}.claim`);
}

/**
 * Legacy (kairanban-era) record path for a CHAIN subject.  Task subjects have
 * no legacy layout — the previous plugin only ever watched chains.  Used so an
 * upgrade in place keeps reading already-delivered chain state instead of
 * re-delivering it.
 */
export function getLegacyRecordPath(stateDir, subject) {
  const { kind, id } = normalizeSubject(subject);
  if (kind !== "chain") return null;
  return path.join(stateDir, "records", `${sanitizeIdentifier(id)}.json`);
}

export function getLegacyClaimPath(stateDir, subject) {
  const { kind, id } = normalizeSubject(subject);
  if (kind !== "chain") return null;
  return path.join(stateDir, "claims", `${sanitizeIdentifier(id)}.claim`);
}

/**
 * The record file to READ and WRITE for a subject: the canonical
 * kind-prefixed path when it exists (or nothing else does), otherwise a
 * legacy chain record path.  A subject has exactly one record file — writing
 * through this resolver migrates nothing and duplicates nothing.
 */
export function resolveRecordPath(stateDir, subject) {
  const canonical = getRecordPath(stateDir, subject);
  if (fs.existsSync(canonical)) return canonical;
  const legacy = getLegacyRecordPath(stateDir, subject);
  if (legacy && fs.existsSync(legacy)) return legacy;
  return canonical;
}

export function resolveClaimPath(stateDir, subject) {
  const canonical = getClaimPath(stateDir, subject);
  if (fs.existsSync(canonical)) return canonical;
  const legacy = getLegacyClaimPath(stateDir, subject);
  if (legacy && fs.existsSync(legacy)) return legacy;
  return canonical;
}

export function writeRecordAtomic(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${Date.now()}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2) + "\n", "utf8");
  fs.renameSync(tmpPath, filePath);
}

export function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function validateSubjectRegistration({ id, idLabel, threadId, cwd }) {
  if (!id || typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id) || id.length > 128) {
    return { valid: false, reason: `Invalid ${idLabel} "${id}": must be a non-empty string matching ^[a-zA-Z0-9_-]+$` };
  }
  if (!threadId || typeof threadId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(threadId) || threadId.length > 128) {
    return { valid: false, reason: `Invalid thread ID "${threadId}": must be a non-empty string matching ^[a-zA-Z0-9_-]+$` };
  }
  if (!cwd || typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    return { valid: false, reason: `Invalid cwd "${cwd}": must be an absolute path` };
  }
  try {
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      return { valid: false, reason: `Invalid cwd "${cwd}": directory does not exist` };
    }
  } catch (err) {
    return { valid: false, reason: `Invalid cwd "${cwd}": ${err.message}` };
  }
  return { valid: true };
}

export function validateRegistration({ chainId, threadId, cwd }) {
  return validateSubjectRegistration({ id: chainId, idLabel: "chain ID", threadId, cwd });
}

export function validateTaskRegistration({ jobId, threadId, cwd }) {
  return validateSubjectRegistration({ id: jobId, idLabel: "job ID", threadId, cwd });
}

export function getProcessStartTime(pid, procRoot = "/proc") {
  if (!pid || typeof pid !== "number" || pid <= 0) return null;
  try {
    const stat = fs.readFileSync(path.join(procRoot, String(pid), "stat"), "utf8");
    const lastParen = stat.lastIndexOf(")");
    if (lastParen === -1) return null;
    const rest = stat.slice(lastParen + 2).trim().split(/\s+/);
    return rest[19] || null;
  } catch {
    return null;
  }
}

export function getProcessCmdline(pid, procRoot = "/proc") {
  if (!pid || typeof pid !== "number" || pid <= 0) return null;
  try {
    return fs.readFileSync(path.join(procRoot, String(pid), "cmdline"), "utf8");
  } catch {
    return null;
  }
}

/**
 * Checks process identity against procfs.
 * Returns { alive: boolean, verified: boolean, identity: string }.
 * If procfs is missing/restricted, identity is "unknown" and verified is false.
 *
 * `idToken` is the subject id as it appears in the watcher argv (`chainId`
 * for chains, `jobId` for tasks) — process identity is never inferred from
 * token shape.
 */
export function checkWatcherProcess(pid, expectedStartTime = null, idToken = null, procRoot = "/proc") {
  if (!pid || typeof pid !== "number" || pid <= 0) {
    return { alive: false, verified: false, identity: "invalid_pid" };
  }
  try {
    process.kill(pid, 0);
  } catch {
    return { alive: false, verified: false, identity: "dead" };
  }

  const statFile = path.join(procRoot, String(pid), "stat");
  const cmdlineFile = path.join(procRoot, String(pid), "cmdline");

  if (fs.existsSync(statFile)) {
    let stat;
    try {
      stat = fs.readFileSync(statFile, "utf8");
    } catch {
      return { alive: true, verified: false, identity: "unknown" };
    }

    const lastParen = stat.lastIndexOf(")");
    if (lastParen === -1) {
      return { alive: true, verified: false, identity: "unknown" };
    }
    const rest = stat.slice(lastParen + 2).trim().split(/\s+/);
    const state = rest[0];
    if (state === "Z" || state === "X") {
      return { alive: false, verified: false, identity: "dead" };
    }
    const currentStartTime = rest[19] || null;

    if (expectedStartTime && currentStartTime && String(currentStartTime) !== String(expectedStartTime)) {
      return { alive: false, verified: false, identity: "unrelated" };
    }

    let cmdline = null;
    try {
      cmdline = fs.readFileSync(cmdlineFile, "utf8");
    } catch {
      return { alive: true, verified: false, identity: "unknown" };
    }

    if (cmdline !== null) {
      if (!cmdline.includes("watch-chain") && !cmdline.includes("register-watch")) {
        return { alive: false, verified: false, identity: "unrelated" };
      }
      if (idToken && !cmdline.includes(idToken)) {
        return { alive: false, verified: false, identity: "unrelated" };
      }
    }

    return { alive: true, verified: true, identity: "verified", startTime: currentStartTime };
  }

  // Missing or restricted procfs
  return { alive: true, verified: false, identity: "unknown" };
}

export function isWatcherProcessAlive(pid, expectedStartTime = null, idToken = null, procRoot = "/proc") {
  const res = checkWatcherProcess(pid, expectedStartTime, idToken, procRoot);
  return res.alive && (res.verified || res.identity === "unknown");
}

export function isPidAlive(pid) {
  return isWatcherProcessAlive(pid);
}

/**
 * Atomic lock for claims to ensure mutual exclusion across concurrent processes.
 * Lock names are kind-namespaced like the claims themselves.
 */
export function acquireClaimLock(claimsDir, subject, { lockTimeoutMs = 10000, procRoot = "/proc" } = {}) {
  const { kind, id } = normalizeSubject(subject);
  const safeId = sanitizeIdentifier(id);
  const lockDir = path.join(claimsDir, `${kind}-${safeId}.lock`);
  const startTime = Date.now();

  while (true) {
    try {
      fs.mkdirSync(lockDir);
      const info = { pid: process.pid, time: Date.now() };
      fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify(info), "utf8");
      return {
        release: () => {
          try {
            fs.rmSync(lockDir, { recursive: true, force: true });
          } catch { /* best-effort */ }
        },
      };
    } catch (err) {
      if (err && err.code === "EEXIST") {
        try {
          const ownerFile = path.join(lockDir, "owner.json");
          let owner = null;
          if (fs.existsSync(ownerFile)) {
            owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
          }
          const stat = fs.statSync(lockDir);
          const age = Date.now() - stat.mtimeMs;

          let ownerDead = false;
          if (owner && typeof owner.pid === "number") {
            const idResult = checkWatcherProcess(owner.pid, owner.startTime || null, id, procRoot);
            if (!idResult.alive || idResult.identity === "unrelated") {
              ownerDead = true;
            }
            // If idResult.alive is true (verified or unknown), ownerDead remains false.
            // A lock owned by a kill(0)-live process is never stolen via age timeout alone.
          } else if (age > lockTimeoutMs) {
            ownerDead = true;
          }

          if (ownerDead) {
            fs.rmSync(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch { /* best-effort */ }

        const elapsed = Date.now() - startTime;
        if (elapsed > lockTimeoutMs) {
          throw new Error(`Timeout acquiring claim lock for ${subjectKey(subject)}`);
        }
        const delayEnd = Date.now() + 15;
        while (Date.now() < delayEnd) { /* short spin: the lock holder is expected to release within ~ms */ }
      } else {
        throw err;
      }
    }
  }
}

/**
 * Two-phase claim state machine with mutual exclusion.  The claim payload
 * persists the explicit `subject: { kind, id }` so chain and task claims can
 * never collide even for equal id strings.
 *
 * Phases:
 * - "preparing": Claim actively held while preparing notification state. Safe to recover if owner dies.
 * - "queue_inflight": Set immediately before spawning codex queue. Ambiguous if owner dies; never auto-retried.
 * - "delivered": Confirmed delivered (terminal).
 * - "failed_retryable": Definitive queue failure before delivery; retryable up to maxAttempts.
 * - "failed_terminal": Max attempts exceeded or destination closed/unavailable.
 * - "ambiguous": Interrupted in flight during queue execution; side effects ambiguous, NEVER auto-retried.
 */
export function tryAcquireClaim(claimsDir, subject, { maxAttempts = MAX_DELIVERY_ATTEMPTS, procRoot = "/proc" } = {}) {
  fs.mkdirSync(claimsDir, { recursive: true });
  const { kind, id } = normalizeSubject(subject);
  const safeId = sanitizeIdentifier(id);
  const canonicalClaimPath = path.join(claimsDir, `${kind}-${safeId}.claim`);
  const legacyClaimPath = kind === "chain" ? path.join(claimsDir, `${safeId}.claim`) : null;
  const claimPath = fs.existsSync(canonicalClaimPath) || !legacyClaimPath
    ? canonicalClaimPath
    : (fs.existsSync(legacyClaimPath) ? legacyClaimPath : canonicalClaimPath);

  const lock = acquireClaimLock(claimsDir, subject, { procRoot });
  try {
    const now = new Date().toISOString();
    const currentStartTime = getProcessStartTime(process.pid, procRoot);

    if (!fs.existsSync(claimPath)) {
      const payload = {
        subject: { kind, id },
        chainId: id,
        phase: "preparing",
        pid: process.pid,
        startTime: currentStartTime,
        claimedAt: now,
        updatedAt: now,
        attempts: 1,
        maxAttempts,
      };
      fs.writeFileSync(claimPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
      return { acquired: true, claimPath, claim: payload };
    }

    const existing = readJson(claimPath);
    if (!existing) {
      return { acquired: false, claimPath, reason: "corrupted_or_locked" };
    }

    if (existing.phase === "delivered") {
      return { acquired: false, claimPath, outcome: OUTCOME_ALREADY_DELIVERED, claim: existing };
    }

    if (existing.phase === "ambiguous") {
      return { acquired: false, claimPath, outcome: OUTCOME_AMBIGUOUS_DELIVERY, claim: existing };
    }

    if (existing.phase === "failed_terminal") {
      return { acquired: false, claimPath, outcome: OUTCOME_QUEUE_FAILURE, claim: existing };
    }

    if (existing.phase === "failed_retryable") {
      const attempts = (existing.attempts || 1) + 1;
      if (attempts > maxAttempts) {
        const terminalPayload = {
          ...existing,
          phase: "failed_terminal",
          updatedAt: now,
        };
        writeRecordAtomic(claimPath, terminalPayload);
        return { acquired: false, claimPath, outcome: OUTCOME_QUEUE_FAILURE, claim: terminalPayload };
      }

      // Mutually exclusive reclaim: transition from failed_retryable -> preparing
      const retryPayload = {
        ...existing,
        subject: { kind, id },
        phase: "preparing",
        pid: process.pid,
        startTime: currentStartTime,
        updatedAt: now,
        attempts,
        maxAttempts,
      };
      writeRecordAtomic(claimPath, retryPayload);
      return { acquired: true, claimPath, claim: retryPayload };
    }

    if (existing.phase === "preparing") {
      const idResult = checkWatcherProcess(existing.pid, existing.startTime, id, procRoot);
      if (idResult.alive && (idResult.identity === "verified" || idResult.identity === "unknown")) {
        return { acquired: false, claimPath, reason: "active_owner", claim: existing };
      }

      // Owner process is dead (kill(0) failed or zombie) or unrelated recycled PID
      // No external side effect was ever spawned; this state is recoverable.
      const attempts = existing.attempts || 1;
      if (attempts > maxAttempts) {
        const termPayload = { ...existing, phase: "failed_terminal", updatedAt: now };
        writeRecordAtomic(claimPath, termPayload);
        return { acquired: false, claimPath, outcome: OUTCOME_QUEUE_FAILURE, claim: termPayload };
      }

      const recoveredPayload = {
        ...existing,
        subject: { kind, id },
        phase: "preparing",
        pid: process.pid,
        startTime: currentStartTime,
        updatedAt: now,
        recoveredFromPid: existing.pid,
      };
      writeRecordAtomic(claimPath, recoveredPayload);
      return { acquired: true, claimPath, claim: recoveredPayload };
    }

    if (existing.phase === "queue_inflight" || existing.phase === "delivering") {
      const idResult = checkWatcherProcess(existing.pid, existing.startTime, id, procRoot);
      if (idResult.alive && idResult.identity === "verified") {
        return { acquired: false, claimPath, reason: "active_owner", claim: existing };
      }

      // Owner process terminated OR unknown process identity while queue was in flight:
      // Fail closed as ambiguous — side effects may have occurred, NEVER automatically retried!
      const ambPayload = {
        ...existing,
        subject: { kind, id },
        phase: "ambiguous",
        updatedAt: now,
        reason: !idResult.alive
          ? "Owner process terminated while queue execution was in flight"
          : "Unknown process identity while queue execution was in flight",
      };
      writeRecordAtomic(claimPath, ambPayload);
      return { acquired: false, claimPath, outcome: OUTCOME_AMBIGUOUS_DELIVERY, claim: ambPayload };
    }

    return { acquired: false, claimPath, reason: "unknown_claim_state", claim: existing };
  } finally {
    lock.release();
  }
}

export function updateClaim(claimPath, updates) {
  const current = readJson(claimPath) || {};
  const updated = {
    ...current,
    ...updates,
    updatedAt: new Date().toISOString(),
  };
  writeRecordAtomic(claimPath, updated);
  return updated;
}

/**
 * Runs a process with process-group isolation, signal forwarding, and bounded escalation to SIGKILL.
 */
export function runProcess(command, args, { cwd, env = process.env, timeout = 0, onSpawn = null, isolateProcessGroup = true } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child = null;
    let settled = false;
    let timeoutTimer = null;
    let escalationTimer = null;
    let childPgid = null;

    function finish(result) {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
      cleanupSignalListeners();
      resolve(result);
    }

    function killProcessTree(sig = "SIGTERM") {
      if (isolateProcessGroup && process.platform !== "win32" && childPgid) {
        try {
          process.kill(-childPgid, sig);
        } catch { /* best-effort */ }
      }
      if (child) {
        try {
          child.kill(sig);
        } catch { /* best-effort */ }
      }
    }

    function onSignal(sig) {
      killProcessTree("SIGTERM");
      const escTimer = setTimeout(() => {
        killProcessTree("SIGKILL");
      }, 500);
      escTimer.unref?.();

      finish({
        exitCode: 128 + (sig === "SIGINT" ? 2 : sig === "SIGTERM" ? 15 : 1),
        stdout,
        stderr: stderr ? `${stderr}\nProcess terminated by ${sig}` : `Process terminated by ${sig}`,
        error: new Error(`Terminated by ${sig}`),
        signal: sig,
      });
    }

    const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
    const signalHandlers = {};
    for (const sig of signals) {
      signalHandlers[sig] = () => onSignal(sig);
      process.once(sig, signalHandlers[sig]);
    }

    function cleanupSignalListeners() {
      for (const sig of signals) {
        process.removeListener(sig, signalHandlers[sig]);
      }
    }

    const spawnOptions = {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    };

    if (isolateProcessGroup && process.platform !== "win32") {
      spawnOptions.detached = true;
    }

    try {
      child = spawn(command, args, spawnOptions);
      if (child.pid) {
        childPgid = child.pid;
      }
    } catch (err) {
      finish({
        exitCode: 1,
        stdout: "",
        stderr: err.message,
        error: err,
        signal: null,
      });
      return;
    }

    if (onSpawn && typeof onSpawn === "function") {
      onSpawn(child);
    }

    if (timeout > 0) {
      timeoutTimer = setTimeout(() => {
        killProcessTree("SIGTERM");
        const escTimer = setTimeout(() => {
          killProcessTree("SIGKILL");
        }, 500);
        escTimer.unref?.();
        finish({
          exitCode: 124,
          stdout,
          stderr: stderr ? `${stderr}\nProcess timed out` : "Process timed out",
          error: new Error("Process timed out"),
          signal: "SIGKILL",
          timedOut: true,
        });
      }, timeout);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      finish({
        exitCode: 1,
        stdout,
        stderr: stderr ? `${stderr}\n${err.message}` : err.message,
        error: err,
        signal: null,
      });
    });

    child.on("close", (code, signal) => {
      finish({
        exitCode: code !== null ? code : (signal ? 128 : 0),
        stdout,
        stderr,
        error: null,
        signal: signal || null,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// chain state reading
// ---------------------------------------------------------------------------

export function readChainState(chainId, cwd, kusabiStateRoot) {
  const resolved = path.resolve(cwd || process.cwd());
  const hash = getKusabiWorkspaceHash(resolved);

  const candidateDirs = [
    path.join(kusabiStateRoot, hash, "chains", chainId),
    path.join(kusabiStateRoot, "chains", chainId),
    path.join(kusabiStateRoot, chainId),
    path.join(resolved, ".kusabi", hash, "chains", chainId),
    path.join(resolved, ".kusabi", "chains", chainId),
  ];

  // Probe realpath hash as fallback for reading old/mixed state
  try {
    const real = fs.realpathSync(resolved);
    if (real !== resolved) {
      const realHash = crypto.createHash("sha256").update(real).digest("hex").slice(0, 12);
      candidateDirs.push(
        path.join(kusabiStateRoot, realHash, "chains", chainId),
        path.join(real, ".kusabi", realHash, "chains", chainId)
      );
    }
  } catch { /* best-effort */ }

  let control = null;
  let chainData = null;
  let inboxData = null;

  for (const dir of candidateDirs) {
    if (fs.existsSync(dir)) {
      const controlFile = path.join(dir, "control.json");
      const chainFile = path.join(dir, "chain.json");
      if (fs.existsSync(controlFile)) {
        control = readJson(controlFile);
      }
      if (fs.existsSync(chainFile)) {
        chainData = readJson(chainFile);
      }
      const inboxFile = path.join(path.dirname(path.dirname(dir)), "inbox", `${chainId}.md`);
      if (fs.existsSync(inboxFile)) {
        try { inboxData = fs.readFileSync(inboxFile, "utf8"); } catch { /* best-effort */ }
      }
      if (control || chainData || inboxData) break;
    }
  }

  let status = control?.status || null;
  let container = control?.container || control?.container_id || control?.containerId || null;
  let disposition = null;

  if (chainData?.records && Array.isArray(chainData.records) && chainData.records.length > 0) {
    const lastRecord = chainData.records[chainData.records.length - 1];
    if (typeof lastRecord.disposition === "string") {
      disposition = lastRecord.disposition;
    } else if (lastRecord.disposition && typeof lastRecord.disposition.disposition === "string") {
      disposition = lastRecord.disposition.disposition;
    }
  }

  if (inboxData) {
    if (!status) {
      const m = inboxData.match(/-\s+\*\*status\*\*:\s*([^\n]+)/);
      if (m) status = m[1].trim();
    }
    if (!disposition) {
      const m = inboxData.match(/-\s+\*\*disposition\*\*:\s*([^\n]+)/);
      if (m) disposition = m[1].trim();
    }
    if (!container) {
      const m = inboxData.match(/-\s+\*\*container\*\*:\s*([^\n]+)/);
      if (m) container = m[1].trim();
    }
  }

  return { status, disposition, container };
}

export function getRecommendedNextAction(chainId, status, disposition) {
  const normDisp = String(disposition || "").toLowerCase();
  const normStatus = String(status || "").toLowerCase();

  if (normDisp === "accept" || normDisp === "accept-with-followup") {
    return `Inspect review record and publish changes or update agenda (\`kusabi-companion chain-show ${chainId}\`).`;
  }
  if (normDisp === "escalate" || normDisp === "refused-brief-defect") {
    return `Inspect chain outcome and review blockers (\`kusabi-companion chain-show ${chainId}\`).`;
  }
  if (normStatus === "cancelled") {
    return `Inspect cancelled chain state (\`kusabi-companion chain-show ${chainId}\`).`;
  }
  if (normStatus === "failed" || normDisp === "failed") {
    return `Diagnose failure in logs and container state (\`kusabi-companion chain-show ${chainId}\`).`;
  }
  return `Inspect chain state (\`kusabi-companion chain-show ${chainId}\`).`;
}

export function formatNotificationMessage({ chainId, status, disposition, container, nextAction }) {
  const containerValue = container || "unavailable";
  return [
    `[kusabi] Chain ${chainId} ${status}.`,
    `- Status: ${status}`,
    `- Disposition: ${disposition}`,
    `- Container: ${containerValue}`,
    `- Next action: ${nextAction}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// task state reading
// ---------------------------------------------------------------------------

/**
 * Read the durable kusabi job record for a task subject (read-only — the
 * notifier never writes job.json / result.md / events.ndjson; result recovery
 * through `result <job-id>` stays available).
 */
export function readTaskJob(jobId, cwd, kusabiStateRoot) {
  const resolved = path.resolve(cwd || process.cwd());
  const hash = getKusabiWorkspaceHash(resolved);

  const candidateDirs = [
    path.join(kusabiStateRoot, hash, "jobs", jobId),
    path.join(kusabiStateRoot, "jobs", jobId),
    path.join(resolved, ".kusabi", hash, "jobs", jobId),
    path.join(resolved, ".kusabi", "jobs", jobId),
  ];

  // Probe realpath hash as fallback for reading old/mixed state
  try {
    const real = fs.realpathSync(resolved);
    if (real !== resolved) {
      const realHash = crypto.createHash("sha256").update(real).digest("hex").slice(0, 12);
      candidateDirs.push(
        path.join(kusabiStateRoot, realHash, "jobs", jobId),
        path.join(real, ".kusabi", realHash, "jobs", jobId)
      );
    }
  } catch { /* best-effort */ }

  for (const dir of candidateDirs) {
    if (fs.existsSync(dir)) {
      const jobFile = path.join(dir, "job.json");
      if (fs.existsSync(jobFile)) {
        return readJson(jobFile);
      }
    }
  }
  return null;
}

/**
 * Parse the compact `task-wait` digest line:
 *   task <jobId>: status=... [phase=...] [failure=...|error=...] waited=Ns
 * The digest is the authoritative selector output — the job id inside it must
 * match the job the watcher was registered for; a mismatch is a watcher
 * failure, never a guessed re-bind.
 */
export function parseTaskWaitDigest(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).filter(Boolean);
  const line = lines[lines.length - 1] || "";
  const m = line.match(/^task\s+(\S+):\s*(.*)$/);
  if (!m) return null;
  const fields = {};
  for (const kv of m[2].matchAll(/([A-Za-z-]+)=([^\s]+)/g)) fields[kv[1]] = kv[2];
  return { jobId: m[1], ...fields };
}

/**
 * The four terminal classes the notification must distinguish:
 * completed | failed (provider-error/error) | stalled (timeout/stalled/serve-dead) | cancelled.
 */
export function classifyTaskStatusClass(status) {
  switch (status) {
    case "completed":
      return "completed";
    case "provider-error":
    case "error":
      return "failed";
    case "timeout":
    case "stalled":
    case "serve-dead":
      return "stalled";
    case "cancelled":
      return "cancelled";
    default:
      return "unknown";
  }
}

/**
 * Backend/model rendering for a task notification, including the fallback
 * trail when the job record carries one (`job.fallbacks[].from -> to`).
 * Values captured at launch are only the fallback when the durable job record
 * did not record the field.
 */
export function describeTaskBackendModel(job, { backend = null, model = null } = {}) {
  const recordedBackend = job?.backend || backend || "opencode";
  const modelEntry = job?.modelEntry || model || null;
  const routes = [];
  if (modelEntry) routes.push(modelEntry);
  if (Array.isArray(job?.fallbacks)) {
    for (const fb of job.fallbacks) {
      if (fb?.from && !routes.includes(fb.from)) routes.push(fb.from);
      if (fb?.to && !routes.includes(fb.to)) routes.push(fb.to);
    }
  }
  if (routes.length === 0) return recordedBackend;
  return `${recordedBackend} (${routes.join(" -> ")})`;
}

/** Exact recovery commands a task notification must name. */
export function getTaskRecoveryCommands(jobId) {
  return `kusabi-companion result ${jobId} | kusabi-companion status ${jobId}`;
}

export function formatTaskNotificationMessage({ jobId, status, phase, backendModel, container }) {
  const containerValue = container || "unavailable";
  return [
    `[kusabi] Task ${jobId} ${status}.`,
    `- Status: ${status}`,
    `- Class: ${classifyTaskStatusClass(status)}`,
    `- Phase: ${phase || "unknown"}`,
    `- Backend/Model: ${backendModel}`,
    `- Container: ${containerValue}`,
    `- Recover: ${getTaskRecoveryCommands(jobId)}`,
  ].join("\n");
}

export function evaluateQueueResult(queueResult) {
  if (queueResult.exitCode === 0) {
    return { outcome: OUTCOME_DELIVERED, error: null };
  }
  if (queueResult.signal) {
    return {
      outcome: OUTCOME_AMBIGUOUS_DELIVERY,
      error: {
        message: `Queue process interrupted by signal ${queueResult.signal}`,
        signal: queueResult.signal,
        exitCode: queueResult.exitCode,
        stderr: queueResult.stderr,
      },
    };
  }

  const combinedOutput = `${queueResult.stderr || ""} ${queueResult.stdout || ""}`.toLowerCase();

  // Narrow to thread-specific diagnostics; generic "command not found" or "file not found" must not match
  const isThreadDiagnostic =
    /(?:thread|session)\s+.*(?:closed|unavailable|not found|unknown|inactive|does not exist)/i.test(combinedOutput) ||
    /(?:unknown|no such|cannot find)\s+(?:thread|session)/i.test(combinedOutput) ||
    /(?:thread|session)\s+(?:is\s+)?(?:closed|unavailable|inactive)/i.test(combinedOutput);

  if (isThreadDiagnostic) {
    return {
      outcome: OUTCOME_CLOSED_OR_UNAVAILABLE,
      error: {
        message: "Source Codex session/thread closed or unavailable",
        exitCode: queueResult.exitCode,
        stderr: queueResult.stderr,
      },
    };
  }

  return {
    outcome: OUTCOME_QUEUE_FAILURE,
    error: {
      message: "Queue command failure",
      exitCode: queueResult.exitCode,
      stderr: queueResult.stderr,
    },
  };
}

// ---------------------------------------------------------------------------
// the chain watcher
// ---------------------------------------------------------------------------

export async function watchChain({
  chainId,
  threadId,
  cwd: rawCwd,
  stateDir: customStateDir,
  companionBin,
  codexBin,
  remote,
  maxAttempts = MAX_DELIVERY_ATTEMPTS,
  procRoot = "/proc",
  env = process.env,
}) {
  const cwd = path.resolve(rawCwd || process.cwd());
  const stateDir = getStateDir(customStateDir, env);
  const recordsDir = path.join(stateDir, "records");
  const claimsDir = path.join(stateDir, "claims");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(claimsDir, { recursive: true });

  const subject = { kind: "chain", id: chainId };
  const recordPath = resolveRecordPath(stateDir, subject);
  const now = new Date().toISOString();

  // Validate
  const validation = validateRegistration({ chainId, threadId, cwd });
  if (!validation.valid) {
    const malformedRecord = {
      subject,
      chainId: chainId || null,
      threadId: threadId || null,
      cwd: cwd || null,
      status: "malformed_registration",
      outcome: OUTCOME_MALFORMED_REGISTRATION,
      registeredAt: now,
      updatedAt: now,
      error: { message: validation.reason },
    };
    writeRecordAtomic(recordPath, malformedRecord);
    return { outcome: OUTCOME_MALFORMED_REGISTRATION, record: malformedRecord };
  }

  // Load existing or initialize
  let currentRecord = readJson(recordPath) || {
    subject,
    chainId,
    threadId,
    cwd,
    status: "waiting",
    outcome: null,
    registeredAt: now,
    updatedAt: now,
    pid: process.pid,
    startTime: getProcessStartTime(process.pid, procRoot),
    attempts: 0,
  };

  // Duplicate suppression
  if (currentRecord.outcome === OUTCOME_DELIVERED || currentRecord.status === "delivered") {
    return { outcome: OUTCOME_ALREADY_DELIVERED, record: currentRecord };
  }
  if (currentRecord.outcome === OUTCOME_AMBIGUOUS_DELIVERY || currentRecord.status === "ambiguous") {
    return { outcome: OUTCOME_AMBIGUOUS_DELIVERY, record: currentRecord };
  }
  if (currentRecord.status === "queue_failed" && currentRecord.retryable === false) {
    return { outcome: OUTCOME_QUEUE_FAILURE, record: currentRecord };
  }

  currentRecord.status = "waiting";
  currentRecord.pid = process.pid;
  currentRecord.startTime = getProcessStartTime(process.pid, procRoot);
  currentRecord.updatedAt = new Date().toISOString();
  writeRecordAtomic(recordPath, currentRecord);

  // 1. Run chain-wait
  const companionCmd = companionBin || env.KUSABI_COMPANION_BIN || "kusabi-companion";
  const companionArgs = ["chain-wait", chainId];
  const waitResult = await runProcess(companionCmd, companionArgs, { cwd, env });

  if (waitResult.exitCode !== 0) {
    currentRecord = {
      ...currentRecord,
      status: "chain_wait_failed",
      outcome: OUTCOME_CHAIN_WAIT_FAILURE,
      updatedAt: new Date().toISOString(),
      chainWait: {
        exitCode: waitResult.exitCode,
        stdout: waitResult.stdout,
        stderr: waitResult.stderr,
      },
      error: {
        message: waitResult.signal ? `chain-wait interrupted by ${waitResult.signal}` : `chain-wait exited with code ${waitResult.exitCode}`,
        exitCode: waitResult.exitCode,
        stderr: waitResult.stderr,
      },
    };
    writeRecordAtomic(recordPath, currentRecord);
    return { outcome: OUTCOME_CHAIN_WAIT_FAILURE, record: currentRecord };
  }

  // 2. Parse machine-readable chain state
  const kusabiStateRoot = env.KUSABI_STATE_DIR || path.join(os.homedir(), ".kusabi");
  const chainState = readChainState(chainId, cwd, kusabiStateRoot);

  if (!chainState.status) {
    const m = waitResult.stdout.match(/status=([a-zA-Z0-9_-]+)/);
    if (m) chainState.status = m[1];
  }
  if (!chainState.disposition) {
    const m = waitResult.stdout.match(/disposition=([a-zA-Z0-9_-]+)/);
    if (m) chainState.disposition = m[1];
  }
  if (!chainState.container) {
    const m = waitResult.stdout.match(/container=([a-zA-Z0-9_-]+)/);
    if (m) chainState.container = m[1];
  }

  // Missing container metadata is represented as "unavailable" and does NOT fail terminal wait
  if (!chainState.container) {
    chainState.container = "unavailable";
  }

  // Authoritative terminal status: required
  if (!chainState.status) {
    currentRecord = {
      ...currentRecord,
      status: "chain_wait_failed",
      outcome: OUTCOME_CHAIN_WAIT_FAILURE,
      updatedAt: new Date().toISOString(),
      chainWait: {
        exitCode: waitResult.exitCode,
        stdout: waitResult.stdout,
        stderr: waitResult.stderr,
      },
      error: {
        message: "Required terminal status missing from chain state and stdout",
        parsedState: chainState,
      },
    };
    writeRecordAtomic(recordPath, currentRecord);
    return { outcome: OUTCOME_CHAIN_WAIT_FAILURE, record: currentRecord };
  }

  if (!chainState.disposition) {
    chainState.disposition = chainState.status;
  }

  // 3. Atomically ensure at-most-once delivery via durable two-phase claim
  const claimResult = tryAcquireClaim(claimsDir, subject, { maxAttempts, procRoot });
  if (!claimResult.acquired) {
    if (claimResult.outcome === OUTCOME_ALREADY_DELIVERED) {
      const latestRecord = readJson(recordPath) || currentRecord;
      return { outcome: OUTCOME_ALREADY_DELIVERED, record: latestRecord };
    }
    if (claimResult.outcome === OUTCOME_AMBIGUOUS_DELIVERY) {
      currentRecord = {
        ...currentRecord,
        status: "ambiguous",
        outcome: OUTCOME_AMBIGUOUS_DELIVERY,
        updatedAt: new Date().toISOString(),
        error: { message: "Delivery previously interrupted or died during execution; ambiguous state" },
      };
      writeRecordAtomic(recordPath, currentRecord);
      return { outcome: OUTCOME_AMBIGUOUS_DELIVERY, record: currentRecord };
    }
    if (claimResult.outcome === OUTCOME_QUEUE_FAILURE) {
      currentRecord = {
        ...currentRecord,
        status: "queue_failed",
        outcome: OUTCOME_QUEUE_FAILURE,
        retryable: false,
        updatedAt: new Date().toISOString(),
        error: { message: "Queue failure: maximum retry attempts exceeded" },
      };
      writeRecordAtomic(recordPath, currentRecord);
      return { outcome: OUTCOME_QUEUE_FAILURE, record: currentRecord };
    }
    const latestRecord = readJson(recordPath) || currentRecord;
    return { outcome: latestRecord.outcome || "already claimed", record: latestRecord };
  }

  const claimPath = claimResult.claimPath;
  const currentAttempt = claimResult.claim?.attempts || 1;

  // 4. Format notification message (still in "preparing" phase)
  const nextAction = getRecommendedNextAction(chainId, chainState.status, chainState.disposition);
  const summaryMessage = formatNotificationMessage({
    chainId,
    status: chainState.status,
    disposition: chainState.disposition,
    container: chainState.container,
    nextAction,
  });

  // 5. Mark queue-in-flight immediately before spawn (fail-closed boundary for at-most-once)
  updateClaim(claimPath, {
    phase: "queue_inflight",
    inflightAt: new Date().toISOString(),
  });

  // 6. Call codex queue
  const codexCmd = codexBin || env.CODEX_BIN || "codex";
  const codexArgs = ["queue"];
  if (remote) codexArgs.push("--remote", remote);
  codexArgs.push("--thread", threadId, "--message", summaryMessage);
  const queueResult = await runProcess(codexCmd, codexArgs, { cwd, env });

  const evalResult = evaluateQueueResult(queueResult);

  if (evalResult.outcome === OUTCOME_DELIVERED) {
    updateClaim(claimPath, {
      phase: "delivered",
      deliveredAt: new Date().toISOString(),
    });
    currentRecord = {
      ...currentRecord,
      status: "delivered",
      outcome: OUTCOME_DELIVERED,
      attempts: currentAttempt,
      retryable: false,
      updatedAt: new Date().toISOString(),
      chainWait: {
        exitCode: waitResult.exitCode,
        stdout: waitResult.stdout,
        stderr: waitResult.stderr,
      },
      chainState,
      notification: {
        message: summaryMessage,
        deliveredAt: new Date().toISOString(),
      },
      queue: {
        exitCode: queueResult.exitCode,
        stdout: queueResult.stdout,
        stderr: queueResult.stderr,
      },
      error: null,
    };
    writeRecordAtomic(recordPath, currentRecord);
    return { outcome: OUTCOME_DELIVERED, record: currentRecord };
  }

  if (evalResult.outcome === OUTCOME_AMBIGUOUS_DELIVERY) {
    updateClaim(claimPath, {
      phase: "ambiguous",
      interruptedAt: new Date().toISOString(),
      signal: queueResult.signal,
    });
    currentRecord = {
      ...currentRecord,
      status: "ambiguous",
      outcome: OUTCOME_AMBIGUOUS_DELIVERY,
      attempts: currentAttempt,
      retryable: false,
      updatedAt: new Date().toISOString(),
      chainWait: {
        exitCode: waitResult.exitCode,
        stdout: waitResult.stdout,
        stderr: waitResult.stderr,
      },
      chainState,
      notification: {
        message: summaryMessage,
        deliveredAt: null,
      },
      queue: {
        exitCode: queueResult.exitCode,
        stdout: queueResult.stdout,
        stderr: queueResult.stderr,
      },
      error: evalResult.error,
    };
    writeRecordAtomic(recordPath, currentRecord);
    return { outcome: OUTCOME_AMBIGUOUS_DELIVERY, record: currentRecord };
  }

  if (evalResult.outcome === OUTCOME_CLOSED_OR_UNAVAILABLE) {
    updateClaim(claimPath, {
      phase: "failed_terminal",
      terminalReason: "closed_or_unavailable",
    });
    currentRecord = {
      ...currentRecord,
      status: "closed_or_unavailable",
      outcome: OUTCOME_CLOSED_OR_UNAVAILABLE,
      attempts: currentAttempt,
      retryable: false,
      updatedAt: new Date().toISOString(),
      chainWait: {
        exitCode: waitResult.exitCode,
        stdout: waitResult.stdout,
        stderr: waitResult.stderr,
      },
      chainState,
      notification: {
        message: summaryMessage,
        deliveredAt: null,
      },
      queue: {
        exitCode: queueResult.exitCode,
        stdout: queueResult.stdout,
        stderr: queueResult.stderr,
      },
      error: evalResult.error,
    };
    writeRecordAtomic(recordPath, currentRecord);
    return { outcome: OUTCOME_CLOSED_OR_UNAVAILABLE, record: currentRecord };
  }

  // Definitive queue failure before delivery
  const isRetryable = currentAttempt < maxAttempts;
  updateClaim(claimPath, {
    phase: isRetryable ? "failed_retryable" : "failed_terminal",
    lastError: evalResult.error,
    attempts: currentAttempt,
  });

  currentRecord = {
    ...currentRecord,
    status: "queue_failed",
    outcome: OUTCOME_QUEUE_FAILURE,
    attempts: currentAttempt,
    retryable: isRetryable,
    updatedAt: new Date().toISOString(),
    chainWait: {
      exitCode: waitResult.exitCode,
      stdout: waitResult.stdout,
      stderr: waitResult.stderr,
    },
    chainState,
    notification: {
      message: summaryMessage,
      deliveredAt: null,
    },
    queue: {
      exitCode: queueResult.exitCode,
      stdout: queueResult.stdout,
      stderr: queueResult.stderr,
    },
    error: evalResult.error,
  };
  writeRecordAtomic(recordPath, currentRecord);
  return { outcome: OUTCOME_QUEUE_FAILURE, record: currentRecord };
}

// ---------------------------------------------------------------------------
// the task watcher
// ---------------------------------------------------------------------------

/**
 * Watch one detached task job to terminal state and deliver at most one
 * notification.  Owns exactly one `kusabi-companion task-wait <jobId>`
 * process; the terminal status is taken from the wait's digest, the
 * authoritative phase / backend / model (with fallback trail) come from the
 * durable job record, and the container comes from the launch-captured input
 * (jobs do not carry a container field; missing metadata renders as
 * "unavailable").
 *
 * A task-wait infrastructure failure (non-zero exit, unparseable digest, a
 * job id inside the digest that disagrees with the registered one, or a
 * missing terminal status) is OUTCOME_TASK_WAIT_FAILURE — a watcher failure,
 * never a queue attempt.  Queue failures preserve the job/result records
 * (this module is read-only over the job store) and stay retryable under the
 * same bounded claim protocol as chains.
 */
export async function watchTask({
  jobId,
  threadId,
  cwd: rawCwd,
  stateDir: customStateDir,
  companionBin,
  codexBin,
  remote,
  maxAttempts = MAX_DELIVERY_ATTEMPTS,
  procRoot = "/proc",
  env = process.env,
  container = null,
  phase = null,
  backend = null,
  model = null,
}) {
  const cwd = path.resolve(rawCwd || process.cwd());
  const stateDir = getStateDir(customStateDir, env);
  const recordsDir = path.join(stateDir, "records");
  const claimsDir = path.join(stateDir, "claims");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(claimsDir, { recursive: true });

  const subject = { kind: "task", id: jobId };
  const recordPath = resolveRecordPath(stateDir, subject);
  const now = new Date().toISOString();

  // Validate
  const validation = validateTaskRegistration({ jobId, threadId, cwd });
  if (!validation.valid) {
    const malformedRecord = {
      subject,
      jobId: jobId || null,
      threadId: threadId || null,
      cwd: cwd || null,
      status: "malformed_registration",
      outcome: OUTCOME_MALFORMED_REGISTRATION,
      registeredAt: now,
      updatedAt: now,
      error: { message: validation.reason },
    };
    writeRecordAtomic(recordPath, malformedRecord);
    return { outcome: OUTCOME_MALFORMED_REGISTRATION, record: malformedRecord };
  }

  // Load existing or initialize
  let currentRecord = readJson(recordPath) || {
    subject,
    jobId,
    threadId,
    cwd,
    status: "waiting",
    outcome: null,
    registeredAt: now,
    updatedAt: now,
    pid: process.pid,
    startTime: getProcessStartTime(process.pid, procRoot),
    attempts: 0,
    launch: {
      container: container || null,
      phase: phase || null,
      backend: backend || null,
      model: model || null,
    },
  };

  // Duplicate suppression
  if (currentRecord.outcome === OUTCOME_DELIVERED || currentRecord.status === "delivered") {
    return { outcome: OUTCOME_ALREADY_DELIVERED, record: currentRecord };
  }
  if (currentRecord.outcome === OUTCOME_AMBIGUOUS_DELIVERY || currentRecord.status === "ambiguous") {
    return { outcome: OUTCOME_AMBIGUOUS_DELIVERY, record: currentRecord };
  }
  if (currentRecord.status === "queue_failed" && currentRecord.retryable === false) {
    return { outcome: OUTCOME_QUEUE_FAILURE, record: currentRecord };
  }

  currentRecord.status = "waiting";
  currentRecord.pid = process.pid;
  currentRecord.startTime = getProcessStartTime(process.pid, procRoot);
  currentRecord.updatedAt = new Date().toISOString();
  if (container || phase || backend || model) {
    currentRecord.launch = {
      container: container || currentRecord.launch?.container || null,
      phase: phase || currentRecord.launch?.phase || null,
      backend: backend || currentRecord.launch?.backend || null,
      model: model || currentRecord.launch?.model || null,
    };
  }
  writeRecordAtomic(recordPath, currentRecord);

  // 1. Run task-wait — the watcher owns this single blocking process
  const companionCmd = companionBin || env.KUSABI_COMPANION_BIN || "kusabi-companion";
  const waitResult = await runProcess(companionCmd, ["task-wait", jobId], { cwd, env });

  const taskWait = {
    exitCode: waitResult.exitCode,
    stdout: waitResult.stdout,
    stderr: waitResult.stderr,
  };

  const failTaskWait = (message, extra = {}) => {
    currentRecord = {
      ...currentRecord,
      status: "task_wait_failed",
      outcome: OUTCOME_TASK_WAIT_FAILURE,
      updatedAt: new Date().toISOString(),
      taskWait,
      error: { message, ...extra },
    };
    writeRecordAtomic(recordPath, currentRecord);
    return { outcome: OUTCOME_TASK_WAIT_FAILURE, record: currentRecord };
  };

  if (waitResult.exitCode !== 0) {
    return failTaskWait(
      waitResult.signal
        ? `task-wait interrupted by ${waitResult.signal}`
        : `task-wait exited with code ${waitResult.exitCode}`,
      { exitCode: waitResult.exitCode, stderr: waitResult.stderr },
    );
  }

  // 2. Parse the digest and read the durable job record
  const digest = parseTaskWaitDigest(waitResult.stdout);
  const kusabiStateRoot = env.KUSABI_STATE_DIR || path.join(os.homedir(), ".kusabi");
  const job = readTaskJob(jobId, cwd, kusabiStateRoot);

  // The digest's job id is authoritative — never guess or re-bind
  if (digest && digest.jobId && digest.jobId !== jobId) {
    return failTaskWait(
      `task-wait resolved job ${digest.jobId}, expected ${jobId} — refusing to guess`,
      { digest },
    );
  }

  let status = digest?.status || null;
  if (!status && job && typeof job.status === "string") {
    status = job.status;
  }

  // Authoritative terminal status: required, and must be a known terminal class
  if (!status || !TASK_TERMINAL_STATUSES.has(status)) {
    return failTaskWait(
      status
        ? `Required terminal status "${status}" is not a known task terminal status`
        : "Required terminal status missing from task-wait digest and job record",
      { digest, jobStatus: job?.status ?? null },
    );
  }

  // 3. Atomically ensure at-most-once delivery via durable two-phase claim
  const claimResult = tryAcquireClaim(claimsDir, subject, { maxAttempts, procRoot });
  if (!claimResult.acquired) {
    if (claimResult.outcome === OUTCOME_ALREADY_DELIVERED) {
      const latestRecord = readJson(recordPath) || currentRecord;
      return { outcome: OUTCOME_ALREADY_DELIVERED, record: latestRecord };
    }
    if (claimResult.outcome === OUTCOME_AMBIGUOUS_DELIVERY) {
      currentRecord = {
        ...currentRecord,
        status: "ambiguous",
        outcome: OUTCOME_AMBIGUOUS_DELIVERY,
        updatedAt: new Date().toISOString(),
        error: { message: "Delivery previously interrupted or died during execution; ambiguous state" },
      };
      writeRecordAtomic(recordPath, currentRecord);
      return { outcome: OUTCOME_AMBIGUOUS_DELIVERY, record: currentRecord };
    }
    if (claimResult.outcome === OUTCOME_QUEUE_FAILURE) {
      currentRecord = {
        ...currentRecord,
        status: "queue_failed",
        outcome: OUTCOME_QUEUE_FAILURE,
        retryable: false,
        updatedAt: new Date().toISOString(),
        error: { message: "Queue failure: maximum retry attempts exceeded" },
      };
      writeRecordAtomic(recordPath, currentRecord);
      return { outcome: OUTCOME_QUEUE_FAILURE, record: currentRecord };
    }
    const latestRecord = readJson(recordPath) || currentRecord;
    return { outcome: latestRecord.outcome || "already claimed", record: latestRecord };
  }

  const claimPath = claimResult.claimPath;
  const currentAttempt = claimResult.claim?.attempts || 1;

  // 4. Format notification message (still in "preparing" phase)
  const phaseValue = job?.phase || phase || currentRecord.launch?.phase || null;
  const containerValue =
    job?.container || job?.container_id || job?.containerId ||
    container || currentRecord.launch?.container || "unavailable";
  const backendModel = describeTaskBackendModel(job, {
    backend: backend || currentRecord.launch?.backend || null,
    model: model || currentRecord.launch?.model || null,
  });
  const summaryMessage = formatTaskNotificationMessage({
    jobId,
    status,
    phase: phaseValue,
    backendModel,
    container: containerValue,
  });

  // 5. Mark queue-in-flight immediately before spawn (fail-closed boundary for at-most-once)
  updateClaim(claimPath, {
    phase: "queue_inflight",
    inflightAt: new Date().toISOString(),
  });

  // 6. Call codex queue
  const codexCmd = codexBin || env.CODEX_BIN || "codex";
  const codexArgs = ["queue"];
  if (remote) codexArgs.push("--remote", remote);
  codexArgs.push("--thread", threadId, "--message", summaryMessage);
  const queueResult = await runProcess(codexCmd, codexArgs, { cwd, env });

  const evalResult = evaluateQueueResult(queueResult);

  const baseRecord = {
    taskWait,
    digest,
    taskState: {
      jobId,
      status,
      phase: phaseValue,
      container: containerValue,
      backendModel,
      job: job || null,
    },
  };

  if (evalResult.outcome === OUTCOME_DELIVERED) {
    updateClaim(claimPath, {
      phase: "delivered",
      deliveredAt: new Date().toISOString(),
    });
    currentRecord = {
      ...currentRecord,
      status: "delivered",
      outcome: OUTCOME_DELIVERED,
      attempts: currentAttempt,
      retryable: false,
      updatedAt: new Date().toISOString(),
      ...baseRecord,
      notification: {
        message: summaryMessage,
        deliveredAt: new Date().toISOString(),
      },
      queue: {
        exitCode: queueResult.exitCode,
        stdout: queueResult.stdout,
        stderr: queueResult.stderr,
      },
      error: null,
    };
    writeRecordAtomic(recordPath, currentRecord);
    return { outcome: OUTCOME_DELIVERED, record: currentRecord };
  }

  if (evalResult.outcome === OUTCOME_AMBIGUOUS_DELIVERY) {
    updateClaim(claimPath, {
      phase: "ambiguous",
      interruptedAt: new Date().toISOString(),
      signal: queueResult.signal,
    });
    currentRecord = {
      ...currentRecord,
      status: "ambiguous",
      outcome: OUTCOME_AMBIGUOUS_DELIVERY,
      attempts: currentAttempt,
      retryable: false,
      updatedAt: new Date().toISOString(),
      ...baseRecord,
      notification: {
        message: summaryMessage,
        deliveredAt: null,
      },
      queue: {
        exitCode: queueResult.exitCode,
        stdout: queueResult.stdout,
        stderr: queueResult.stderr,
      },
      error: evalResult.error,
    };
    writeRecordAtomic(recordPath, currentRecord);
    return { outcome: OUTCOME_AMBIGUOUS_DELIVERY, record: currentRecord };
  }

  if (evalResult.outcome === OUTCOME_CLOSED_OR_UNAVAILABLE) {
    updateClaim(claimPath, {
      phase: "failed_terminal",
      terminalReason: "closed_or_unavailable",
    });
    currentRecord = {
      ...currentRecord,
      status: "closed_or_unavailable",
      outcome: OUTCOME_CLOSED_OR_UNAVAILABLE,
      attempts: currentAttempt,
      retryable: false,
      updatedAt: new Date().toISOString(),
      ...baseRecord,
      notification: {
        message: summaryMessage,
        deliveredAt: null,
      },
      queue: {
        exitCode: queueResult.exitCode,
        stdout: queueResult.stdout,
        stderr: queueResult.stderr,
      },
      error: evalResult.error,
    };
    writeRecordAtomic(recordPath, currentRecord);
    return { outcome: OUTCOME_CLOSED_OR_UNAVAILABLE, record: currentRecord };
  }

  // Definitive queue failure before delivery — the durable job record is
  // untouched and the claim stays retryable up to maxAttempts
  const isRetryable = currentAttempt < maxAttempts;
  updateClaim(claimPath, {
    phase: isRetryable ? "failed_retryable" : "failed_terminal",
    lastError: evalResult.error,
    attempts: currentAttempt,
  });

  currentRecord = {
    ...currentRecord,
    status: "queue_failed",
    outcome: OUTCOME_QUEUE_FAILURE,
    attempts: currentAttempt,
    retryable: isRetryable,
    updatedAt: new Date().toISOString(),
    ...baseRecord,
    notification: {
      message: summaryMessage,
      deliveredAt: null,
    },
    queue: {
      exitCode: queueResult.exitCode,
      stdout: queueResult.stdout,
      stderr: queueResult.stderr,
    },
    error: evalResult.error,
  };
  writeRecordAtomic(recordPath, currentRecord);
  return { outcome: OUTCOME_QUEUE_FAILURE, record: currentRecord };
}

// CLI entrypoint
function parseArgs(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        flags[key] = args[++i];
      } else {
        flags[key] = true;
      }
    }
  }
  return flags;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const flags = parseArgs(process.argv.slice(2));
  const common = {
    threadId: flags.thread,
    cwd: flags.cwd || process.cwd(),
    stateDir: flags["state-dir"],
    companionBin: flags["companion-bin"],
    codexBin: flags["codex-bin"],
    remote: flags.remote,
  };
  const exitFor = ({ outcome }) => {
    if (outcome === OUTCOME_DELIVERED || outcome === OUTCOME_ALREADY_DELIVERED) {
      process.exit(0);
    } else {
      process.exit(1);
    }
  };
  const run = flags.task
    ? watchTask({
        jobId: flags.task,
        ...common,
        container: flags.container || null,
        phase: flags.phase || null,
        backend: flags.backend || null,
        model: flags.model || null,
      })
    : watchChain({ chainId: flags.chain, ...common });
  run.then(exitFor).catch((err) => {
    console.error(`watch-chain unhandled error: ${err.message}`);
    process.exit(1);
  });
}