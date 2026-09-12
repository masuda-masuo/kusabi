// task-wait.mjs — block until a task job reaches a terminal state.
//
// `task` dispatches a single-shot job that runs to completion in a detached
// process: the launcher (`task-detach`) returns immediately, so no completion
// signal travels back to the caller.  `task-wait` is the read-only primitive
// that owns the completion wait — the same role chain-wait.mjs plays for
// chains, but over the durable JOB store (stateDir/jobs/<id>/job.json) that
// every task, review and chain-phase already writes through job-store.mjs.
// It never reaches for a second, alternate job store: it reads the very
// records the dispatch wrote.
//
// The contract mirrors chain-wait.mjs exactly:
//   - a TERMINAL task job (whatever its status — completed, timeout,
//     cancelled, provider-error, error, stalled, or serve-dead) resolves
//     the wait, because reporting the outcome is the digest's job and
//     judging it is the orchestrator's;
//   - every way the WAIT itself failed throws a TaskWaitError: an unknown job
//     id, a --next that timed out before any job appeared, a malformed
//     duration, or a job record that stalled without observable movement.
//
// It is a pure poll loop over job.json: no LLM, no serve, no resources to
// clean up, safe to SIGTERM at any moment, and strictly read-only — waiting
// never writes, rewrites or deletes job.json, result.md or events.ndjson, so
// concurrent waits and a later notification failure can never corrupt the
// durable record (result recovery through `result <job-id>` stays available).

import fs from "node:fs";
import path from "node:path";
import { loadJob, jobDir } from "./job-store.mjs";

/**
 * Job statuses that mean the task process is done with this job.  Written by
 * the dispatch path on every exit path (see classifyJobOutcome and the
 * backend adapters).  Each is a successful terminal OBSERVATION for a wait:
 * they differ only in how the digest reports them.  There is no artificial
 * `failed` status in the durable job store — real closed failures land as
 * provider-error / error / stalled / serve-dead (plus timeout / cancelled).
 */
export const TERMINAL_TASK_STATUSES = new Set([
  "completed",
  "timeout",
  "cancelled",
  "provider-error",
  "error",
  "stalled",
  "serve-dead",
]);

export const DEFAULT_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_APPEAR_TIMEOUT_MS = 120_000;
export const DEFAULT_PROGRESS_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * Every way the wait itself failed.  `code` is the machine-readable half:
 * "unknown-job", "no-job-appeared", "stalled", "usage".
 */
export class TaskWaitError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "TaskWaitError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// state reading
// ---------------------------------------------------------------------------

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * A read-only snapshot of one job's terminal-ness and its observable movement.
 * `fingerprint` is any observable change, including a rewrite that changed no
 * field we render: a task still writing is a task still working.
 */
export function readTaskSnapshot(stateDir, jobId) {
  const job = loadJob(stateDir, jobId);
  const exists = job !== null;
  const status = exists && typeof job.status === "string" ? job.status : null;
  return {
    jobId,
    exists,
    job,
    status,
    terminal: exists && TERMINAL_TASK_STATUSES.has(status),
    fingerprint: JSON.stringify([
      exists,
      status,
      job?.finishedAt ?? null,
      job?.error ?? null,
      job?.failure ?? null,
      mtimeOf(path.join(jobDir(stateDir, jobId), "job.json")),
    ]),
  };
}

/**
 * Job ids under a jobs directory that have a real job.json record (missing
 * directory -> none).  A bare directory with no record is a dispatch that died
 * before writing anything and is never a candidate a wait should resolve on.
 */
export function listJobIds(stateDir) {
  const root = path.join(stateDir, "jobs");
  try {
    return fs.readdirSync(root).filter((name) => {
      try {
        return (
          fs.statSync(path.join(root, name)).isDirectory() &&
          fs.existsSync(path.join(root, name, "job.json"))
        );
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/** Creation stamp of a job directory; birthtime where the filesystem keeps
 * one, ctime otherwise.  0 when it cannot be read at all. */
export function jobDirCreatedAt(stateDir, jobId) {
  try {
    const stat = fs.statSync(jobDir(stateDir, jobId));
    return Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

/**
 * Compact, bounded rendering of `job.failure` for the one-line digest.
 * Structured failure objects must never stringify as `[object Object]`.
 */
export function formatFailureForDigest(failure) {
  if (failure == null || failure === "") return null;
  if (typeof failure === "string" || typeof failure === "number" || typeof failure === "boolean") {
    return String(failure);
  }
  if (typeof failure !== "object") return String(failure);
  const kind = typeof failure.kind === "string" && failure.kind ? failure.kind : null;
  const message =
    (typeof failure.message === "string" && failure.message) ||
    (typeof failure.error === "string" && failure.error) ||
    (typeof failure.quota === "string" && failure.quota) ||
    null;
  if (kind && message) return `${kind}:${message}`;
  if (kind) return kind;
  if (message) return message;
  return "object";
}

/** Compact one-line digest a completed wait prints (not a full status dump). */
export function formatTaskDigest(snapshot, { waitedMs = 0 } = {}) {
  const parts = [`status=${snapshot.status}`];
  if (snapshot.job?.phase) parts.push(`phase=${snapshot.job.phase}`);
  const failureText = formatFailureForDigest(snapshot.job?.failure);
  if (failureText) parts.push(`failure=${failureText}`);
  else if (typeof snapshot.job?.error === "string" && snapshot.job.error) {
    const err = snapshot.job.error.replace(/\s+/g, " ").slice(0, 120);
    parts.push(`error=${err}`);
  }
  return `task ${snapshot.jobId}: ${parts.join(" ")} waited=${Math.round(waitedMs / 1000)}s`;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// the wait
// ---------------------------------------------------------------------------

/**
 * The `--next` selection rule, built once per wait — the job analogue of the
 * chain selector in chain-wait.mjs.
 *
 * With an explicit `since` stamp: any job whose directory was created at or
 * after it, terminal or not.  That is the precise tool, and it is what keeps
 * `--next --since` from latching an older preexisting job.
 *
 * By default: any job new since the wait started, OR one that was already
 * there and has not reached a terminal state.  The second half is what makes
 * the dispatch-then-wait ordering work: `task-detach` creates the job record
 * as it spawns, racing the wait's start, and a pure "was not in the set at
 * start" baseline would turn a healthy dispatch that won that race into a job
 * that never appeared.  Terminal jobs stay excluded, so last week's accepted
 * job can never resolve a wait instantly.  Newest first.
 */
function makeNextJobCandidateSelector({ stateDir, since, startedAt, appearTimeoutMs, reportIgnored, createdAt = jobDirCreatedAt }) {
  const preexisting = since == null ? new Set(listJobIds(stateDir)) : null;
  const reported = new Set();
  const isCandidate = (id) => {
    if (preexisting === null) return createdAt(stateDir, id) >= since;
    if (!preexisting.has(id)) return true;
    const snapshot = readTaskSnapshot(stateDir, id);
    if (snapshot.terminal) return false;
    if (snapshot.job === null && createdAt(stateDir, id) < startedAt - appearTimeoutMs) {
      if (!reported.has(id)) {
        reported.add(id);
        reportIgnored(id);
      }
      return false;
    }
    return true;
  };
  return () =>
    listJobIds(stateDir)
      .filter(isCandidate)
      .map((id) => ({ id, createdAt: createdAt(stateDir, id) }))
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

function reportIgnoredDefault(jobId) {
  console.error(`ignoring ${jobId}: no job.json record, older than appear window`);
}

/**
 * Wait for a job record to appear under --next.
 *
 * A dispatch can die before writing job.json (a `task` that aborts during
 * pre-flight inside the child).  Without a bound that death is silent; with
 * one it is a named non-zero exit.  Selection is the rule above; the newest
 * eligible job id wins.
 */
async function waitForTaskToAppear({ candidates, stateDir, since, pollIntervalMs, appearTimeoutMs, sleep, now, startedAt }) {
  for (;;) {
    const list = candidates();
    if (list.length > 0) return list[0].id;

    if (now() - startedAt >= appearTimeoutMs) {
      const scope = since == null
        ? "new since this wait started, or already present and not yet terminal"
        : `created at or after ${new Date(since).toISOString()}`;
      throw new TaskWaitError(
        `no job appeared within ${Math.round(appearTimeoutMs / 1000)}s (looked for a task job ` +
        `${scope}; searched ${path.join(stateDir, "jobs")}) — the dispatch produced no job ` +
        `record to wait on, so it died before writing one.`,
        "no-job-appeared",
      );
    }

    await sleep(pollIntervalMs);
  }
}

/**
 * Block until a task job reaches a terminal state.
 *
 * Resolves with `{ ...snapshot, digest }` when the job is terminal, whatever
 * its status.  Throws TaskWaitError when the WAIT failed: unknown job id,
 * nothing appeared in --next mode, or the job record stalled.
 *
 * Everything the loop cannot decide from files is injected — `sleep` and `now`
 * are the seams the tests fake.
 *
 * @param {object} opts
 * @param {string} opts.stateDir            - `<stateDir>` (workspace state dir).
 * @param {string|null} [opts.jobId]        - the job to wait on.
 * @param {boolean} [opts.next]             - wait for a job to APPEAR first.
 * @param {number|null} [opts.since]        - appear-mode start stamp (epoch ms).
 * @param {number} [opts.pollIntervalMs]
 * @param {number} [opts.appearTimeoutMs]   - also bounds a job dir that exists
 *                                            but never got a job.json record.
 * @param {number} [opts.progressTimeoutMs]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {() => number} [opts.now]
 * @param {(jobId: string) => void} [opts.reportIgnored]
 * @param {(stateDir: string, jobId: string) => number} [opts.createdAt]
 */
export async function waitForTask({
  stateDir,
  jobId = null,
  next = false,
  since = null,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  appearTimeoutMs = DEFAULT_APPEAR_TIMEOUT_MS,
  progressTimeoutMs = DEFAULT_PROGRESS_TIMEOUT_MS,
  sleep = defaultSleep,
  now = Date.now,
  reportIgnored = reportIgnoredDefault,
  createdAt = jobDirCreatedAt,
} = {}) {
  const startedAt = now();

  let id = jobId;
  let candidates = null;
  if (next) {
    candidates = makeNextJobCandidateSelector({
      stateDir, since, startedAt, appearTimeoutMs, reportIgnored, createdAt,
    });
    id = await waitForTaskToAppear({
      candidates, stateDir, since, pollIntervalMs, appearTimeoutMs, sleep, now, startedAt,
    });
  } else {
    if (!id) {
      throw new TaskWaitError("task-wait needs a job id (or --next to wait for one to appear)", "usage");
    }
    if (!fs.existsSync(path.join(jobDir(stateDir, id), "job.json"))) {
      throw new TaskWaitError(`unknown job: ${id} (searched ${path.join(stateDir, "jobs")})`, "unknown-job");
    }
  }

  const done = (snapshot) => ({ ...snapshot, digest: formatTaskDigest(snapshot, { waitedMs: now() - startedAt }) });
  const stall = (snapshot, staleMs, reason) => new TaskWaitError(
    `task ${snapshot.jobId} stalled: status=${snapshot.status}, unchanged for ` +
    `${Math.round(staleMs / 1000)}s (${reason}). ` +
    `Job state is written as it advances, so it can no longer change — ` +
    `inspect with: kusabi-companion status ${snapshot.jobId}`,
    "stalled",
  );

  let fingerprint = null;
  let lastProgressAt = startedAt;

  for (;;) {
    const snapshot = readTaskSnapshot(stateDir, id);
    if (snapshot.terminal) return done(snapshot);

    if (snapshot.fingerprint !== fingerprint) {
      fingerprint = snapshot.fingerprint;
      lastProgressAt = now();
    }

    // A selected job whose record disappeared / never landed: nothing here can
    // advance it.  In --next mode a newer eligible job that appears may win;
    // otherwise bound it with the appear window.
    if (snapshot.job === null) {
      if (candidates !== null) {
        const lockedAt = createdAt(stateDir, id);
        const target = candidates().find((c) => c.createdAt >= lockedAt && c.id !== id);
        if (target) {
          id = target.id;
          continue;
        }
      }
      if (now() - startedAt >= appearTimeoutMs) {
        throw stall(
          snapshot,
          now() - startedAt,
          `no job.json record in ${jobDir(stateDir, id)} after ${Math.round(appearTimeoutMs / 1000)}s`,
        );
      }
    }

    const staleMs = now() - lastProgressAt;
    if (staleMs >= progressTimeoutMs) {
      throw stall(snapshot, staleMs, `no progress for ${Math.round(progressTimeoutMs / 1000)}s`);
    }

    await sleep(pollIntervalMs);
  }
}