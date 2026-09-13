// register-watch.mjs — registration and hook entrypoint for kusabi-codex-notify
//
// Registers detached kusabi CHAINS (chain-wait) and TASKS (task-wait) for
// at-most-once terminal notification.  Two launch surfaces, both model-free:
//
//   - `--launch`      runs `kusabi-companion chain-detach` via argv, resolves
//                     the real chain id from the exact `chain-wait --next
//                     --since <ISO>` selector output, and registers the chain
//                     watcher;
//   - `--launch-task` runs `kusabi-companion task-detach` via argv, captures
//                     the authoritative cwd/thread/container/phase/backend/
//                     model inputs, resolves the real job id from the exact
//                     `task-wait --next --since <ISO>` selector output, and
//                     registers the task watcher.
//
// Both launchers return promptly: the heavy lifting (the blocking wait, the
// queue call) happens in a detached background watcher process.
//
// Subject kinds are explicit everywhere — a chain registration is
// subject { kind: "chain", id }, a task registration { kind: "task", id } —
// so chain and task registrations can never collide and nothing is inferred
// from token shape.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  OUTCOME_DELIVERED,
  OUTCOME_QUEUE_FAILURE,
  OUTCOME_MALFORMED_REGISTRATION,
  OUTCOME_ALREADY_DELIVERED,
  OUTCOME_AMBIGUOUS_DELIVERY,
  MAX_DELIVERY_ATTEMPTS,
  getStateDir,
  resolveRecordPath,
  getKusabiWorkspaceHash,
  writeRecordAtomic,
  readJson,
  validateRegistration,
  validateTaskRegistration,
  sanitizeIdentifier,
  normalizeSubject,
  getProcessStartTime,
  checkWatcherProcess,
  isWatcherProcessAlive,
  runProcess,
  watchChain,
  watchTask,
} from "./watch-chain.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WATCH_CHAIN_SCRIPT = path.join(__dirname, "watch-chain.mjs");

/** Default appearance timeout in ms, matching chain-wait --appear-timeout (120s). */
export const DEFAULT_APPEAR_TIMEOUT_MS = 120_000;

const KUSABI_SUBCOMMANDS = new Set([
  "chain-detach",
  "chain-wait",
  "chain-cancel",
  "chain-resume",
  "chain-show",
  "chain-stats",
  "task-detach",
  "task-wait",
]);

/**
 * Identify tokens that are subcommands, log names, or incidental chain-* terms,
 * never legitimate chain IDs.
 */
export function isIncidentalOrSubcommandToken(candidate) {
  if (!candidate || typeof candidate !== "string") return true;
  if (KUSABI_SUBCOMMANDS.has(candidate)) return true;
  if (candidate.startsWith("chain-detach")) return true;
  if (candidate.startsWith("chain-wait")) return true;
  if (candidate.startsWith("task-detach")) return true;
  if (candidate.startsWith("task-wait")) return true;
  if (/^chain-(?:detach|wait|cancel|resume|show|stats|ops|phases|cmd|control|probes|driver|next)(?:[-_]|$)/.test(candidate)) {
    return true;
  }
  return false;
}

function kusabiStateRootFor(env = process.env) {
  return env.KUSABI_STATE_DIR || path.join(os.homedir(), ".kusabi");
}

/** Creation stamp of a job directory; birthtime where the filesystem keeps
 * one, ctime otherwise.  0 when it cannot be read at all. */
function jobDirCreatedAt(jobsDir, jobId) {
  try {
    const stat = fs.statSync(path.join(jobsDir, jobId));
    return Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs;
  } catch {
    return 0;
  }
}

/**
 * Resolve job ID from kusabi jobs directory using the authoritative --since
 * timestamp emitted by `task-detach` in its `task-wait --next --since <ISO>`
 * selector line.
 *
 * Selection mirrors task-wait's own rule: any job directory created at or
 * after the stamp is eligible, and the newest eligible directory wins.  The
 * directory creation stamp is authoritative even when job.json.startedAt
 * disagrees with it.
 */
export function resolveJobIdFromSince(sinceStamp, cwd, env = process.env) {
  const stateRoot = kusabiStateRootFor(env);
  const hash = getKusabiWorkspaceHash(cwd);
  const jobsDir = path.join(stateRoot, hash, "jobs");
  if (!fs.existsSync(jobsDir)) return null;

  try {
    const entries = fs.readdirSync(jobsDir);
    const candidates = [];
    for (const entry of entries) {
      if (isIncidentalOrSubcommandToken(entry)) continue;
      try {
        const jobDirPath = path.join(jobsDir, entry);
        const stat = fs.statSync(jobDirPath);
        if (!stat.isDirectory()) continue;
        const jobFile = path.join(jobDirPath, "job.json");
        if (!fs.existsSync(jobFile)) continue; // dispatch died before writing a record
        const itemTime = jobDirCreatedAt(jobsDir, entry);
        if (itemTime >= sinceStamp) {
          candidates.push({ entry, time: itemTime });
        }
      } catch { /* best-effort */ }
    }

    if (candidates.length > 0) {
      // Order eligible candidates newest-first (align with kusabi makeNextCandidateSelector)
      candidates.sort((a, b) => (b.time - a.time) || a.entry.localeCompare(b.entry));
      return candidates[0].entry;
    }
  } catch { /* best-effort */ }
  return null;
}

/**
 * Resolve chain ID from kusabi chains directory using authoritative --since timestamp.
 */
export function resolveChainFromSince(sinceStamp, cwd, env = process.env) {
  const stateRoot = kusabiStateRootFor(env);
  const hash = getKusabiWorkspaceHash(cwd);
  const chainsDir = path.join(stateRoot, hash, "chains");
  if (!fs.existsSync(chainsDir)) return null;

  try {
    const entries = fs.readdirSync(chainsDir);
    const candidates = [];
    for (const entry of entries) {
      if (entry.startsWith("chain-") && !isIncidentalOrSubcommandToken(entry)) {
        try {
          const chainDirPath = path.join(chainsDir, entry);
          const stat = fs.statSync(chainDirPath);
          if (!stat.isDirectory()) continue;
          let itemTime = Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs;
          if (!Number.isFinite(itemTime) || itemTime <= 0) itemTime = stat.mtimeMs;
          const controlFile = path.join(chainDirPath, "control.json");
          if (fs.existsSync(controlFile)) {
            const cData = readJson(controlFile);
            if (cData?.createdAt) {
              const cTime = Date.parse(cData.createdAt);
              if (!Number.isNaN(cTime)) itemTime = cTime;
            }
          }
          if (itemTime >= sinceStamp) {
            candidates.push({ entry, time: itemTime, mtime: stat.mtimeMs });
          }
        } catch { /* best-effort */ }
      }
    }

    if (candidates.length > 0) {
      // Order eligible candidates newest-first (align with kusabi makeNextCandidateSelector)
      candidates.sort((a, b) => (b.time - a.time) || (b.mtime - a.mtime) || b.entry.localeCompare(a.entry));
      return candidates[0].entry;
    }
  } catch { /* best-effort */ }
  return null;
}

/**
 * Fallback resolution of newest chain directory when only --next was emitted.
 */
export function resolveNewestChain(cwd, env = process.env) {
  const stateRoot = kusabiStateRootFor(env);
  const hash = getKusabiWorkspaceHash(cwd);
  const chainsDir = path.join(stateRoot, hash, "chains");
  if (!fs.existsSync(chainsDir)) return null;

  try {
    const entries = fs.readdirSync(chainsDir);
    const candidates = [];
    for (const entry of entries) {
      if (entry.startsWith("chain-") && !isIncidentalOrSubcommandToken(entry)) {
        try {
          const chainDirPath = path.join(chainsDir, entry);
          const stat = fs.statSync(chainDirPath);
          if (!stat.isDirectory()) continue;
          let itemTime = Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs;
          if (!Number.isFinite(itemTime) || itemTime <= 0) itemTime = stat.mtimeMs;
          const controlFile = path.join(chainDirPath, "control.json");
          if (fs.existsSync(controlFile)) {
            const cData = readJson(controlFile);
            if (cData?.createdAt) {
              const cTime = Date.parse(cData.createdAt);
              if (!Number.isNaN(cTime)) itemTime = cTime;
            }
          }
          candidates.push({ entry, time: itemTime, mtime: stat.mtimeMs });
        } catch { /* best-effort */ }
      }
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => (b.time - a.time) || (b.mtime - a.mtime) || b.entry.localeCompare(a.entry));
      return candidates[0].entry;
    }
  } catch { /* best-effort */ }
  return null;
}

/**
 * Inspect hook stdin payload to extract dispatch details.
 * Supports Codex tool execution payloads, hooks, and raw text.
 *
 * Returns `{ chainId, threadId, cwd, command, response, hasValidSince,
 * subjectKind, jobId }` — the subject kind is explicit ("chain" | "task"),
 * never inferred from the id's shape.
 */
export function extractDispatchFromHookInput(rawInput, env = process.env) {
  let parsed;
  try {
    parsed = typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput;
  } catch {
    parsed = { tool_response: String(rawInput || "") };
  }

  if (!parsed || typeof parsed !== "object") return null;

  const command = String(
    parsed.command ||
    parsed.tool_input?.command ||
    parsed.tool_input?.cmd ||
    parsed.input?.command ||
    parsed.args?.command ||
    (parsed.arguments && typeof parsed.arguments === "object" ? parsed.arguments.command : "") ||
    ""
  );

  const response = String(
    parsed.response ||
    parsed.output ||
    parsed.result ||
    parsed.stdout ||
    parsed.tool_response ||
    parsed.tool_output ||
    ""
  );

  const textToScan = `${command}\n${response}`;

  const isKusabiDispatch =
    /kusabi-companion\s+(?:chain-detach|chain|task-detach|task)/i.test(command) ||
    /Detached chain launched/i.test(response) ||
    /Detached task launched/i.test(response) ||
    /kusabi-companion\s+chain-wait/i.test(response) ||
    /kusabi-companion\s+chain-wait/i.test(command) ||
    /kusabi-companion\s+task-wait/i.test(response) ||
    /kusabi-companion\s+task-wait/i.test(command);

  if (!isKusabiDispatch) {
    return null;
  }

  const cwd = path.resolve(parsed.cwd || process.cwd());
  const threadId =
    parsed.thread_id ||
    parsed.threadId ||
    parsed.session_id ||
    parsed.sessionId ||
    env.CODEX_THREAD_ID ||
    env.CODEX_SESSION_ID ||
    null;

  // Check for dispatch refusal first — a refused dispatch creates no chain/task
  const isRefusal =
    /dispatch refused/i.test(textToScan) ||
    /brief refusal/i.test(textToScan) ||
    /\brefusal:\b/i.test(textToScan);

  if (isRefusal) {
    return { chainId: null, jobId: null, threadId, cwd, command, response, refused: true, hasValidSince: false };
  }

  // --- task dispatch branch ---
  const isTaskDispatch = /kusabi-companion\s+task-detach/i.test(command) || /Detached task launched/i.test(textToScan);
  if (isTaskDispatch) {
    let jobId = null;

    // 1. Explicit task-wait <jobId> line (registered-by-id surface)
    const taskWaitIdRegex = /(?:kusabi-companion\s+)?task-wait\s+([^\s]+)/;
    const respTaskMatch = response.match(taskWaitIdRegex);
    if (respTaskMatch && !respTaskMatch[1].startsWith("--") && !isIncidentalOrSubcommandToken(respTaskMatch[1])) {
      jobId = respTaskMatch[1];
    }
    if (!jobId) {
      const cmdTaskMatch = command.match(taskWaitIdRegex);
      if (cmdTaskMatch && !cmdTaskMatch[1].startsWith("--") && !isIncidentalOrSubcommandToken(cmdTaskMatch[1])) {
        jobId = cmdTaskMatch[1];
      }
    }

    // 2. Authoritative --since selector: task-wait --next --since <ISO>
    let hasValidSince = false;
    const sinceMatch = textToScan.match(/--since\s+([^\s]+)/);
    if (sinceMatch) {
      const sinceStamp = Date.parse(sinceMatch[1]);
      if (!Number.isNaN(sinceStamp)) {
        hasValidSince = true;
        if (!jobId) {
          jobId = resolveJobIdFromSince(sinceStamp, cwd, env);
        }
      }
    }

    return {
      chainId: null,
      jobId,
      subjectKind: "task",
      threadId,
      cwd,
      command,
      response,
      hasValidSince,
      refused: false,
    };
  }

  // --- chain dispatch branch (unchanged) ---
  let chainId = null;

  // 1. Prefer explicit chain ID from the wait line in tool response
  const waitLineRegex = /(?:kusabi-companion\s+)?chain-wait\s+([^\s]+)/;
  const respWaitMatch = response.match(waitLineRegex);
  if (respWaitMatch && !respWaitMatch[1].startsWith("--") && !isIncidentalOrSubcommandToken(respWaitMatch[1])) {
    chainId = respWaitMatch[1];
  }

  // 2. If not found in response, check command line
  if (!chainId) {
    const cmdWaitMatch = command.match(waitLineRegex);
    if (cmdWaitMatch && !cmdWaitMatch[1].startsWith("--") && !isIncidentalOrSubcommandToken(cmdWaitMatch[1])) {
      chainId = cmdWaitMatch[1];
    }
  }

  // 3. Check for authoritative --since selector
  let hasValidSince = false;
  const sinceMatch = textToScan.match(/--since\s+([^\s]+)/);
  if (sinceMatch) {
    const sinceStamp = Date.parse(sinceMatch[1]);
    if (!Number.isNaN(sinceStamp)) {
      hasValidSince = true;
      if (!chainId) {
        chainId = resolveChainFromSince(sinceStamp, cwd, env);
      }
    }
  }

  // 4. Fallback to newest chain directory only if --next was used without --since
  if (!hasValidSince && !chainId && /--next\b/.test(textToScan)) {
    chainId = resolveNewestChain(cwd, env);
  }

  // 5. Last resort: scan explicit chain tokens (never matching chain-detach-* log names or subcommands)
  // ONLY if no valid --since selector was specified
  if (!hasValidSince && !chainId) {
    const scanTokens = (text) => {
      const matches = text.matchAll(/\b(chain-[a-zA-Z0-9_-]+)\b/g);
      for (const m of matches) {
        const candidate = m[1];
        if (!isIncidentalOrSubcommandToken(candidate)) {
          return candidate;
        }
      }
      return null;
    };
    chainId = scanTokens(response) || scanTokens(command);
  }

  return {
    chainId,
    jobId: null,
    subjectKind: "chain",
    threadId,
    cwd,
    command,
    response,
    hasValidSince,
    refused: false,
  };
}

/**
 * Register a CHAIN for watching and launch the watcher process
 * (subject kind is explicitly "chain").
 */
export async function registerWatch({
  chainId,
  threadId: rawThreadId,
  cwd: rawCwd,
  stateDir: customStateDir,
  companionBin,
  codexBin,
  remote,
  sync = false,
  procRoot = "/proc",
  env = process.env,
}) {
  return registerSubjectWatch({
    subject: { kind: "chain", id: chainId },
    threadId: rawThreadId,
    cwd: rawCwd,
    stateDir: customStateDir,
    companionBin,
    codexBin,
    remote,
    sync,
    procRoot,
    env,
  });
}

/**
 * Register a TASK job for watching and launch the watcher process
 * (subject kind is explicitly "task").  The launch-captured container/phase/
 * backend/model inputs travel on the record so the watcher can render them
 * even when the durable job record lacks the field.
 */
export async function registerTaskWatch({
  jobId,
  threadId: rawThreadId,
  cwd: rawCwd,
  stateDir: customStateDir,
  companionBin,
  codexBin,
  remote,
  sync = false,
  procRoot = "/proc",
  env = process.env,
  container = null,
  phase = null,
  backend = null,
  model = null,
}) {
  return registerSubjectWatch({
    subject: { kind: "task", id: jobId },
    threadId: rawThreadId,
    cwd: rawCwd,
    stateDir: customStateDir,
    companionBin,
    codexBin,
    remote,
    sync,
    procRoot,
    env,
    container,
    phase,
    backend,
    model,
  });
}

/**
 * Shared registration core.  `subject` names the kind explicitly; everything
 * downstream (record/claim files, resume, duplicate suppression) is keyed on
 * it.  Spawns a detached background watcher (watch-chain.mjs --chain <id> or
 * --task <jobId>) unless `sync` is set.
 */
async function registerSubjectWatch({
  subject: rawSubject,
  threadId: rawThreadId,
  cwd: rawCwd,
  stateDir: customStateDir,
  companionBin,
  codexBin,
  remote,
  sync = false,
  procRoot = "/proc",
  env = process.env,
  container = null,
  phase = null,
  backend = null,
  model = null,
}) {
  const subject = normalizeSubject(rawSubject);
  const isTask = subject.kind === "task";
  const id = subject.id;

  const threadId =
    rawThreadId ||
    env.CODEX_THREAD_ID ||
    env.CODEX_SESSION_ID ||
    null;
  const cwd = path.resolve(rawCwd || process.cwd());
  const stateDir = getStateDir(customStateDir, env);
  const recordsDir = path.join(stateDir, "records");
  const claimsDir = path.join(stateDir, "claims");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(claimsDir, { recursive: true });

  const now = new Date().toISOString();

  // Validate inputs
  const validation = isTask
    ? validateTaskRegistration({ jobId: id, threadId, cwd })
    : validateRegistration({ chainId: id, threadId, cwd });
  if (!validation.valid) {
    const safeId = sanitizeIdentifier(id || `malformed-${Date.now()}`);
    const recordPath = path.join(recordsDir, `${subject.kind}-${safeId}.json`);
    const malformedRecord = {
      subject,
      [isTask ? "jobId" : "chainId"]: id || null,
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

  const recordPath = resolveRecordPath(stateDir, subject);
  const existingRecord = readJson(recordPath);

  // Duplicate suppression
  if (existingRecord?.outcome === OUTCOME_DELIVERED || existingRecord?.status === "delivered") {
    return { outcome: OUTCOME_ALREADY_DELIVERED, record: existingRecord };
  }
  if (existingRecord?.outcome === OUTCOME_AMBIGUOUS_DELIVERY || existingRecord?.status === "ambiguous") {
    return { outcome: OUTCOME_AMBIGUOUS_DELIVERY, record: existingRecord };
  }

  // If a watcher is actively running for this subject, do not spawn another
  if (
    existingRecord?.status === "waiting" &&
    existingRecord?.pid &&
    isWatcherProcessAlive(existingRecord.pid, existingRecord.startTime, id, procRoot)
  ) {
    return { outcome: "already running", record: existingRecord };
  }

  // If previous attempt had a non-retryable queue failure, do not re-run
  if (existingRecord?.status === "queue_failed" && existingRecord?.retryable === false) {
    return { outcome: OUTCOME_QUEUE_FAILURE, record: existingRecord };
  }

  // Initialize/update record to waiting
  const initialRecord = {
    subject,
    [isTask ? "jobId" : "chainId"]: id,
    threadId,
    cwd,
    status: "waiting",
    outcome: null,
    registeredAt: existingRecord?.registeredAt || now,
    updatedAt: now,
    pid: null,
    startTime: null,
    attempts: existingRecord?.attempts || 0,
    retryable: true,
  };
  if (isTask && (container || phase || backend || model)) {
    initialRecord.launch = { container, phase, backend, model };
  }
  writeRecordAtomic(recordPath, initialRecord);

  if (sync) {
    // In-process execution (for tests or synchronous debugging)
    const result = isTask
      ? await watchTask({
          jobId: id,
          threadId,
          cwd,
          stateDir,
          companionBin,
          codexBin,
          remote,
          procRoot,
          env,
          container,
          phase,
          backend,
          model,
        })
      : await watchChain({
          chainId: id,
          threadId,
          cwd,
          stateDir,
          companionBin,
          codexBin,
          remote,
          procRoot,
          env,
        });
    return result;
  }

  // Spawn detached background watcher
  const spawnArgs = [
    WATCH_CHAIN_SCRIPT,
    isTask ? "--task" : "--chain",
    id,
    "--thread", threadId,
    "--cwd", cwd,
    "--state-dir", stateDir,
  ];
  if (companionBin) spawnArgs.push("--companion-bin", companionBin);
  if (codexBin) spawnArgs.push("--codex-bin", codexBin);
  if (remote) spawnArgs.push("--remote", remote);
  if (isTask) {
    if (container) spawnArgs.push("--container", container);
    if (phase) spawnArgs.push("--phase", phase);
    if (backend) spawnArgs.push("--backend", backend);
    if (model) spawnArgs.push("--model", model);
  }

  const child = spawn(process.execPath, spawnArgs, {
    cwd,
    detached: true,
    stdio: "ignore",
    shell: false,
    env: { ...env },
  });

  if (child.unref) child.unref();

  const childStartTime = getProcessStartTime(child.pid, procRoot);
  initialRecord.pid = child.pid;
  initialRecord.startTime = childStartTime;
  initialRecord.updatedAt = new Date().toISOString();
  writeRecordAtomic(recordPath, initialRecord);

  return {
    outcome: "registered",
    pid: child.pid,
    record: initialRecord,
  };
}

// ---------------------------------------------------------------------------
// delayed detached-refusal detection
//
// chain-detach / task-detach run their pre-flight checks synchronously, then
// spawn a detached child (the actual `chain` / `task` run, stdio redirected
// to the printed log) and return immediately.  The child itself can still
// reach a terminal refusal — e.g. the lossy-smoke refusal — after the
// launcher already reported success.  That refusal is written only to the
// detached log; no chain/job directory is ever created, so the --since
// selector wait would otherwise burn the whole appearance window for a
// subject that can never appear.
//
// While resolving the subject, the wrapper therefore also observes whether
// the detached child has terminated.  Positive termination before any
// selectable state exists means the dispatch refused: read the log, surface
// the useful diagnostic, state plainly that no watch was registered, and
// exit promptly/nonzero.  A live (or unobservable) child stays eligible
// until the normal appearance deadline.
// ---------------------------------------------------------------------------

/**
 * Extract the detached child pid and log path from detach command output.
 * `startTime` is captured immediately so later termination checks can prove
 * identity — a pid alone can be recycled to an unrelated process.
 */
export function extractDetachedChild(output, { procRoot = "/proc" } = {}) {
  const combined = String(output || "");
  const pidMatch = combined.match(/Detached (?:chain|task) launched \(pid (\d+)\)/);
  const logMatch = combined.match(/^Log:\s*(\S+)/m);
  let pid = null;
  if (pidMatch) {
    const n = Number(pidMatch[1]);
    if (Number.isInteger(n) && n > 0) pid = n;
  }
  return {
    pid,
    startTime: pid ? getProcessStartTime(pid, procRoot) : null,
    logPath: logMatch ? logMatch[1] : null,
  };
}

/**
 * True when `dir` exists as a directory (procfs mounted / fake root usable).
 */
function procRootPresent(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read /proc/<pid>/stat for process state and startTime.  Returns
 * `{ state, startTime }` on success; `{ absent: true }` when the entry is
 * authoritatively gone (ENOENT/ENOTDIR/ESRCH against a present procfs); and
 * `{ transient: true, error }` when the read failed for an observability
 * reason (EACCES/EIO/resource exhaustion, or procfs itself unavailable).
 * `startTime` is field 22 (index 19 after the comm), exactly as watch-chain's
 * getProcessStartTime reads it.
 */
function readProcStat(pid, procRoot) {
  let stat;
  try {
    stat = fs.readFileSync(path.join(procRoot, String(pid), "stat"), "utf8");
  } catch (err) {
    const code = err && err.code;
    if ((code === "ENOENT" || code === "ENOTDIR" || code === "ESRCH") && procRootPresent(procRoot)) {
      // The pid is not in procfs while procfs itself is mounted: the process
      // is authoritatively gone (exited and reaped, or never spawned).
      return { absent: true };
    }
    // EACCES / EIO / resource exhaustion / a missing procfs: the process may
    // well be alive but momentarily unobservable — never a refusal.
    return { transient: true, error: err };
  }
  const lastParen = stat.lastIndexOf(")");
  if (lastParen === -1) return { transient: true };
  const rest = stat.slice(lastParen + 2).trim().split(/\s+/);
  if (rest.length < 20) return { transient: true };
  return { state: rest[0], startTime: rest[19] };
}

/**
 * Positive evidence that the detached child has terminated: the pid is gone
 * from procfs, the pid is a zombie (exited, awaiting reaping — the log may
 * outlive it briefly), or the pid was recycled to an unrelated process.
 *
 * Absence is authoritative whenever procfs is present: the launcher printed
 * this pid a moment ago and the kernel cannot recycle a pid in that window,
 * so a missing entry means the announced child has exited (or never spawned)
 * — with or without a startTime anchor.  With an anchor, identity is provable
 * in every branch: a live pid whose startTime differs is a recycled process,
 * and the reuse is never mistaken for the child itself.
 *
 * Transient observation failures (EACCES/EIO, a missing procfs) fail open: a
 * live-but-unobservable child must stay eligible until the appearance
 * deadline and must never produce a false refusal or lose its watcher.
 */
export function detachedChildTerminated(pid, expectedStartTime = null, procRoot = "/proc") {
  if (!pid || typeof pid !== "number" || pid <= 0) return false;
  const proc = readProcStat(pid, procRoot);
  if (proc.absent) return true; // authoritative: the announced pid is not running
  if (proc.transient) return false; // live-but-unobservable: stay eligible
  if (expectedStartTime && proc.startTime !== expectedStartTime) return true; // pid reused
  if (proc.state === "Z" || proc.state === "X") return true; // ours, exited
  return false;
}

/** Best-effort tail of a file (bytes), capped.  Empty string when unreadable. */
function readFileTail(filePath, maxBytes = 8192) {
  try {
    const size = fs.statSync(filePath).size;
    if (size <= 0) return "";
    const fd = fs.openSync(filePath, "r");
    try {
      const start = Math.max(0, size - maxBytes);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

/**
 * Extract a concise refusal diagnostic from the detached child's log.
 * Returns `{ diagnostic, logTail }` — diagnostic is the refusal lines joined
 * into one line (or the tail's last lines when no refusal marker matches).
 */
export function readDetachedRefusal(logPath, { maxBytes = 8192, maxLines = 8 } = {}) {
  const logTail = readFileTail(logPath, maxBytes);
  if (!logTail) return { diagnostic: null, logTail: "" };
  const lines = logTail.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const refusalPattern =
    /dispatch refused|brief refusal|\brefusal\b|nothing was dispatched|no job and no round state|kusabi-companion error|error:/i;
  const matched = lines.filter((l) => refusalPattern.test(l)).slice(0, maxLines);
  const picked = matched.length > 0 ? matched : lines.slice(-Math.min(3, lines.length));
  return { diagnostic: picked.join(" ") || null, logTail };
}

/**
 * Failure result for a detached dispatch whose child terminated before any
 * chain/job state became selectable.  Carries the log diagnostic, the raw
 * log tail, and an explicit statement that no watch was registered — the
 * caller must not be pointed at a second appearance wait.
 */
function detachedRefusalResult({ kind, stdout, stderr, child }) {
  const { diagnostic, logTail } = readDetachedRefusal(child.logPath);
  const isTask = kind === "task";
  const stateWord = isTask ? "job" : "chain";
  const watchWord = isTask ? "task" : "chain";
  const message =
    `Detached ${kind} dispatch refused before creating any ${stateWord} state — ` +
    `no ${watchWord} watch was registered` +
    (diagnostic ? `: ${diagnostic}` : ".") +
    (child.logPath ? ` (log: ${child.logPath})` : "");
  const result = {
    success: false,
    exitCode: 1,
    stdout,
    stderr,
    registration: null,
    refusal: { pid: child.pid, logPath: child.logPath, diagnostic, logTail },
    error: new Error(message),
  };
  if (isTask) result.jobId = null;
  else result.chainId = null;
  return result;
}

/**
 * Model-free launch wrapper for CHAINS:
 * Invokes kusabi-companion chain-detach directly with argv (no shell),
 * captures the emitted explicit "chain-wait <id>" line from stdout,
 * immediately registers the detached watcher for the originating thread/cwd,
 * and prints/returns the normal dispatch output.
 */
export async function launchAndWatch({
  companionBin,
  codexBin,
  args = [],
  threadId: rawThreadId,
  cwd: rawCwd,
  stateDir,
  remote,
  sync = false,
  procRoot = "/proc",
  env = process.env,
  timeoutMs = DEFAULT_APPEAR_TIMEOUT_MS,
} = {}) {
  const companionCmd = companionBin || env.KUSABI_COMPANION_BIN || "kusabi-companion";
  const cwd = path.resolve(rawCwd || process.cwd());
  const threadId = rawThreadId || env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || null;

  // Build argv: ensure "chain-detach" is subcommand
  const dispatchArgs = args[0] === "chain-detach" ? args : ["chain-detach", ...args];

  const dispatchResult = await runProcess(companionCmd, dispatchArgs, { cwd, env });

  const stdout = dispatchResult.stdout;
  const stderr = dispatchResult.stderr;
  const combined = `${stdout}\n${stderr}`;

  const isRefusal =
    dispatchResult.exitCode !== 0 ||
    /dispatch refused/i.test(combined) ||
    /brief refusal/i.test(combined) ||
    /\brefusal:\b/i.test(combined);

  if (isRefusal) {
    return {
      success: false,
      exitCode: dispatchResult.exitCode || 1,
      stdout,
      stderr,
      chainId: null,
      registration: null,
      error: dispatchResult.error || new Error(stderr.trim() || stdout.trim() || `chain-detach exited with code ${dispatchResult.exitCode}`),
    };
  }

  // Extract chainId from dispatch output
  const dispatch = extractDispatchFromHookInput({ command: dispatchArgs.join(" "), output: stdout, cwd }, env);
  let chainId = dispatch?.chainId || null;
  let hasValidSince = dispatch?.hasValidSince || false;

  // Bounded poll for --since selector if chain directory hasn't appeared yet
  const sinceMatch = combined.match(/--since\s+([^\s]+)/);
  if (sinceMatch) {
    const sinceStamp = Date.parse(sinceMatch[1]);
    if (!Number.isNaN(sinceStamp)) {
      hasValidSince = true;
      if (!chainId) {
        const child = extractDetachedChild(combined, { procRoot });
        const startTime = Date.now();
        const boundMs = timeoutMs;
        while (true) {
          chainId = resolveChainFromSince(sinceStamp, cwd, env);
          if (chainId) break;
          // Re-anchor if the very first read raced the child's spawn.
          if (child.pid && !child.startTime) {
            child.startTime = getProcessStartTime(child.pid, procRoot);
          }
          // The detached child may have reached a terminal refusal without
          // creating any chain state — surface the log diagnostic promptly
          // instead of burning the whole appearance window.
          if (detachedChildTerminated(child.pid, child.startTime, procRoot)) {
            // Brief settle so state written in the same instant is not missed.
            await new Promise((r) => setTimeout(r, 100));
            chainId = resolveChainFromSince(sinceStamp, cwd, env);
            if (chainId) break;
            return detachedRefusalResult({ kind: "chain", stdout, stderr, child });
          }
          if (Date.now() - startTime >= boundMs) break;
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    }
  }

  // Fallback to newest chain directory only if --next was used without --since
  if (!hasValidSince && !chainId && /--next\b/.test(combined)) {
    chainId = resolveNewestChain(cwd, env);
  }

  if (!chainId) {
    return {
      success: false,
      exitCode: 1,
      stdout,
      stderr,
      chainId: null,
      registration: null,
      error: new Error("No chain ID could be resolved from chain-detach output"),
    };
  }

  const registration = await registerWatch({
    chainId,
    threadId,
    cwd,
    stateDir,
    companionBin: companionCmd,
    codexBin,
    remote,
    sync,
    procRoot,
    env,
  });

  return {
    success: true,
    exitCode: 0,
    stdout,
    stderr,
    chainId,
    registration,
    error: null,
  };
}

/**
 * Model-free launch wrapper for TASKS (--launch-task):
 * Invokes kusabi-companion task-detach directly with argv (no shell), captures
 * the authoritative cwd/thread/container/phase/backend/model inputs, resolves
 * the real job id from the exact `task-wait --next --since <ISO>` selector
 * output (bounded poll for the job record to appear, no guessing), registers
 * the detached task watcher, and returns promptly with the dispatch output.
 */
export async function launchTaskAndWatch({
  companionBin,
  codexBin,
  args = [],
  threadId: rawThreadId,
  cwd: rawCwd,
  stateDir,
  remote,
  sync = false,
  procRoot = "/proc",
  env = process.env,
  timeoutMs = DEFAULT_APPEAR_TIMEOUT_MS,
} = {}) {
  const companionCmd = companionBin || env.KUSABI_COMPANION_BIN || "kusabi-companion";
  const cwd = path.resolve(rawCwd || process.cwd());
  const threadId = rawThreadId || env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || null;

  // Build argv: ensure "task-detach" is subcommand
  const dispatchArgs = args[0] === "task-detach" ? args : ["task-detach", ...args];

  const dispatchResult = await runProcess(companionCmd, dispatchArgs, { cwd, env });

  const stdout = dispatchResult.stdout;
  const stderr = dispatchResult.stderr;
  const combined = `${stdout}\n${stderr}`;

  const isRefusal =
    dispatchResult.exitCode !== 0 ||
    /dispatch refused/i.test(combined) ||
    /brief refusal/i.test(combined) ||
    /\brefusal:\b/i.test(combined);

  if (isRefusal) {
    return {
      success: false,
      exitCode: dispatchResult.exitCode || 1,
      stdout,
      stderr,
      jobId: null,
      registration: null,
      error: dispatchResult.error || new Error(stderr.trim() || stdout.trim() || `task-detach exited with code ${dispatchResult.exitCode}`),
    };
  }

  // Authoritative launch-captured inputs (the job record may not carry them)
  const captureFlag = (name) => {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
  };
  const captured = {
    container: captureFlag("container"),
    phase: captureFlag("phase") || captureFlag("agent") || null,
    backend: captureFlag("backend"),
    model: captureFlag("model"),
  };

  // Resolve the real job id from the exact task-wait --since selector output
  let jobId = null;
  const sinceMatch = combined.match(/--since\s+([^\s]+)/);
  if (sinceMatch) {
    const sinceStamp = Date.parse(sinceMatch[1]);
    if (!Number.isNaN(sinceStamp)) {
      // Bounded poll: task-detach creates the job record as it spawns, racing
      // this launcher — the job may legitimately appear a moment later.
      const child = extractDetachedChild(combined, { procRoot });
      const startTime = Date.now();
      while (true) {
        jobId = resolveJobIdFromSince(sinceStamp, cwd, env);
        if (jobId) break;
        // Re-anchor if the very first read raced the child's spawn.
        if (child.pid && !child.startTime) {
          child.startTime = getProcessStartTime(child.pid, procRoot);
        }
        // The detached child may have reached a terminal refusal without
        // creating any job state — surface the log diagnostic promptly
        // instead of burning the whole appearance window.
        if (detachedChildTerminated(child.pid, child.startTime, procRoot)) {
          // Brief settle so state written in the same instant is not missed.
          await new Promise((r) => setTimeout(r, 100));
          jobId = resolveJobIdFromSince(sinceStamp, cwd, env);
          if (jobId) break;
          return detachedRefusalResult({ kind: "task", stdout, stderr, child });
        }
        if (Date.now() - startTime >= timeoutMs) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }

  if (!jobId) {
    return {
      success: false,
      exitCode: 1,
      stdout,
      stderr,
      jobId: null,
      registration: null,
      error: new Error("No job ID could be resolved from task-detach selector output"),
    };
  }

  const registration = await registerTaskWatch({
    jobId,
    threadId,
    cwd,
    stateDir,
    companionBin: companionCmd,
    codexBin,
    remote,
    sync,
    procRoot,
    env,
    container: captured.container,
    phase: captured.phase,
    backend: captured.backend,
    model: captured.model,
  });

  return {
    success: true,
    exitCode: 0,
    stdout,
    stderr,
    jobId,
    captured,
    registration,
    error: null,
  };
}

/**
 * Resume all pending/interrupted watches after process or system restart.
 * Covers interrupted "waiting" watches as well as retryable "queue_failed"
 * states, for chain AND task records alike (each record persists its explicit
 * subject kind).  Missing or restricted procfs does not trust kill(0); durable
 * claim state dictates recovery.
 */
export async function resumePendingWatches({
  stateDir: customStateDir,
  companionBin,
  codexBin,
  sync = false,
  procRoot = "/proc",
  env = process.env,
} = {}) {
  const stateDir = getStateDir(customStateDir, env);
  const recordsDir = path.join(stateDir, "records");
  const claimsDir = path.join(stateDir, "claims");
  if (!fs.existsSync(recordsDir)) return { resumed: 0, subjects: [], chains: [] };

  const entries = fs.readdirSync(recordsDir);
  const resumedSubjects = [];

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const recordFile = path.join(recordsDir, entry);
    const record = readJson(recordFile);
    if (!record) continue;

    // Subject kind is persisted explicitly; a record without one predates the
    // kind split and is a chain (the previous plugin only watched chains).
    const kind = record.subject?.kind === "task" ? "task" : "chain";
    const id = record.subject?.id || (kind === "task" ? record.jobId : record.chainId);
    if (!id) continue;
    const subject = { kind, id };

    const isPending = record.status === "waiting" || record.status === "pending";
    const isRetryableQueue =
      record.status === "queue_failed" &&
      record.retryable !== false &&
      (record.attempts || 0) < MAX_DELIVERY_ATTEMPTS;

    if (isPending || isRetryableQueue) {
      // Check process identity
      const idResult = checkWatcherProcess(record.pid, record.startTime, id, procRoot);

      let shouldResume = false;
      if (!idResult.alive || idResult.identity === "unrelated") {
        // Process is dead or PID recycled to an unrelated process: safe to recover
        shouldResume = true;
      } else if (idResult.identity === "unknown") {
        // Procfs is missing/restricted and process is live (kill(0) succeeded):
        // Treat as active for duplicate suppression; do not reclaim preparing claim!
        const claimFile = resolveRecordClaimPath(claimsDir, subject);
        const claim = readJson(claimFile);
        if (claim && (claim.phase === "queue_inflight" || claim.phase === "delivering")) {
          // Unknown process identity while queue was in flight: mark ambiguous
          const ambPayload = {
            ...claim,
            phase: "ambiguous",
            updatedAt: new Date().toISOString(),
            reason: "Unknown process identity while queue was in flight",
          };
          writeRecordAtomic(claimFile, ambPayload);
          record.status = "ambiguous";
          record.outcome = OUTCOME_AMBIGUOUS_DELIVERY;
          record.updatedAt = new Date().toISOString();
          writeRecordAtomic(recordFile, record);
        }
        // Live unknown process is active: do not resume/reclaim
        shouldResume = false;
      }

      if (shouldResume) {
        resumedSubjects.push(subject);
        if (kind === "task") {
          await registerTaskWatch({
            jobId: id,
            threadId: record.threadId,
            cwd: record.cwd,
            stateDir,
            companionBin,
            codexBin,
            sync,
            procRoot,
            env,
            container: record.launch?.container || null,
            phase: record.launch?.phase || null,
            backend: record.launch?.backend || null,
            model: record.launch?.model || null,
          });
        } else {
          await registerWatch({
            chainId: id,
            threadId: record.threadId,
            cwd: record.cwd,
            stateDir,
            companionBin,
            codexBin,
            sync,
            procRoot,
            env,
          });
        }
      }
    }
  }

  return { resumed: resumedSubjects.length, subjects: resumedSubjects, chains: resumedSubjects.filter((s) => s.kind === "chain").map((s) => s.id) };
}

/** Claim path resolver usable from resume (claimsDir-relative, kind-aware). */
function resolveRecordClaimPath(claimsDir, subject) {
  const { kind, id } = normalizeSubject(subject);
  const safeId = sanitizeIdentifier(id);
  const canonical = path.join(claimsDir, `${kind}-${safeId}.claim`);
  if (fs.existsSync(canonical)) return canonical;
  if (kind === "chain") {
    const legacy = path.join(claimsDir, `${safeId}.claim`);
    if (fs.existsSync(legacy)) return legacy;
  }
  return canonical;
}

function parseArgs(args) {
  const flags = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      flags._ = args.slice(i + 1);
      break;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith("--") && args[i + 1] !== "--") {
        flags[key] = args[++i];
      } else {
        flags[key] = true;
      }
    } else {
      flags._.push(arg);
    }
  }
  return flags;
}

async function readStdinAll() {
  if (process.stdin.isTTY) return "";
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => { resolve(data); });
    process.stdin.on("error", () => { resolve(""); });
  });
}

/**
 * Emit a launch result the way a human should read it.  On a delayed
 * detached refusal the launcher's "To wait for completion" advice must NOT
 * be echoed — it would send the caller into a second futile appearance wait
 * for a subject that can never appear.  The refusal diagnostic and the
 * explicit "no watch was registered" statement replace it.
 */
function emitLaunchOutput(res) {
  if (res.refusal) {
    if (res.stdout) {
      const withoutAdvice = String(res.stdout).replace(
        /\n*To wait for completion, run:\n[^\n]*\n?\s*$/,
        ""
      );
      if (withoutAdvice) process.stdout.write(withoutAdvice);
    }
    if (res.stderr) process.stderr.write(res.stderr);
    process.stderr.write(`${res.error.message}\n`);
    if (res.refusal.logTail) {
      process.stderr.write(`--- detached log tail ---\n${res.refusal.logTail}\n`);
    }
    return;
  }
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
}

export async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags["launch-task"]) {
    const res = await launchTaskAndWatch({
      companionBin: flags["companion-bin"],
      codexBin: flags["codex-bin"],
      args: flags._,
      threadId: flags.thread,
      cwd: flags.cwd,
      stateDir: flags["state-dir"],
      remote: flags.remote,
      sync: !!flags.sync,
    });
    emitLaunchOutput(res);
    if (!res.success) {
      process.exit(res.exitCode || 1);
    }
    return;
  }

  if (flags.launch || flags.detach) {
    const res = await launchAndWatch({
      companionBin: flags["companion-bin"],
      codexBin: flags["codex-bin"],
      args: flags._,
      threadId: flags.thread,
      cwd: flags.cwd,
      stateDir: flags["state-dir"],
      remote: flags.remote,
      sync: !!flags.sync,
    });
    emitLaunchOutput(res);
    if (!res.success) {
      process.exit(res.exitCode || 1);
    }
    return;
  }

  if (flags.list) {
    const stateDir = getStateDir(flags["state-dir"]);
    const recordsDir = path.join(stateDir, "records");
    if (!fs.existsSync(recordsDir)) {
      console.log("No registered subjects.");
      return;
    }
    const entries = fs.readdirSync(recordsDir);
    for (const entry of entries) {
      if (entry.endsWith(".json")) {
        const record = readJson(path.join(recordsDir, entry));
        if (record) {
          const kind = record.subject?.kind || "chain";
          const id = record.subject?.id || record.chainId || record.jobId || entry;
          console.log(`${kind} ${id}: status=${record.status} outcome=${record.outcome || "pending"}`);
        }
      }
    }
    return;
  }

  if (flags["resume-all"]) {
    const res = await resumePendingWatches({
      stateDir: flags["state-dir"],
      companionBin: flags["companion-bin"],
      codexBin: flags["codex-bin"],
      sync: !!flags.sync,
    });
    console.log(`Resumed ${res.resumed} pending watches.`);
    return;
  }

  if (flags.task) {
    const res = await registerTaskWatch({
      jobId: flags.task,
      threadId: flags.thread,
      cwd: flags.cwd || process.cwd(),
      stateDir: flags["state-dir"],
      companionBin: flags["companion-bin"],
      codexBin: flags["codex-bin"],
      remote: flags.remote,
      sync: !!flags.sync,
      container: flags.container || null,
      phase: flags.phase || null,
      backend: flags.backend || null,
      model: flags.model || null,
    });
    if (res.outcome === OUTCOME_MALFORMED_REGISTRATION) {
      console.error(`Registration failed: ${res.record?.error?.message}`);
      process.exit(1);
    }
    return;
  }

  if (flags.chain) {
    const res = await registerWatch({
      chainId: flags.chain,
      threadId: flags.thread,
      cwd: flags.cwd || process.cwd(),
      stateDir: flags["state-dir"],
      companionBin: flags["companion-bin"],
      codexBin: flags["codex-bin"],
      remote: flags.remote,
      sync: !!flags.sync,
    });
    if (res.outcome === OUTCOME_MALFORMED_REGISTRATION) {
      console.error(`Registration failed: ${res.record?.error?.message}`);
      process.exit(1);
    }
    return;
  }

  // Hook entrypoint: read from stdin
  const stdinData = await readStdinAll();
  if (stdinData.trim()) {
    const dispatch = extractDispatchFromHookInput(stdinData);
    if (dispatch && dispatch.threadId && !dispatch.refused) {
      if (dispatch.subjectKind === "task" && dispatch.jobId) {
        await registerTaskWatch({
          jobId: dispatch.jobId,
          threadId: dispatch.threadId,
          cwd: dispatch.cwd,
          stateDir: flags["state-dir"],
          companionBin: flags["companion-bin"],
          codexBin: flags["codex-bin"],
        });
      } else if (dispatch.chainId) {
        await registerWatch({
          chainId: dispatch.chainId,
          threadId: dispatch.threadId,
          cwd: dispatch.cwd,
          stateDir: flags["state-dir"],
          companionBin: flags["companion-bin"],
          codexBin: flags["codex-bin"],
        });
      }
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(`register-watch error: ${err.message}`);
    process.exit(0);
  });
}