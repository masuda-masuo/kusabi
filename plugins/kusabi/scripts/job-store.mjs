// job-store.mjs — on-disk job record persistence
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { readJson, writeJson } from "./state-paths.mjs";

export function newJobId() {
  return `job-${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
}

export function jobDir(stateDir, jobId) {
  return path.join(stateDir, "jobs", jobId);
}

// A job's verdict: what it ended as, and why.  `failure` belongs with the
// other three because it is only the machine-readable half of `error` — a
// record left `cancelled` while still carrying a `provider-error`
// classification would be exactly the pollution this guards against.
const VERDICT_FIELDS = ["status", "error", "finishedAt", "failure"];

// The terminal-status invariant (kusabi #213):
//
//   once the on-disk record for a job id has `status: "cancelled"`, no later
//   save may change its verdict.
//
// Two processes write one job record and neither owns it.  `cancel` (the
// companion CLI) proves the stop and writes `cancelled`, but the dispatch
// process is still alive: it observes its child's death, classifies it as a
// failure and writes `status: "error"` over the top, so the final on-disk
// status of a successfully cancelled job was normally `error` — a deliberate
// cancel indistinguishable from a genuine dispatch failure to everything
// chain-stats and metrics-ingest aggregate.  claude-dispatch's stats cadence
// is worse still: it re-saves the in-memory record (status `running`) at ~1s
// intervals while the child lives, so it can resurrect a cancelled job.
//
// The invariant is therefore enforced here, at the single write chokepoint
// every writer already goes through, rather than per dispatch — which closes
// it for claude, agy and opencode at once, stats cadence included.
// `cancelled` is the only sticky status: `completed` needs no protection,
// because `cancel` refuses a job that is not running and the dispatch is the
// sole writer of `completed`.
//
// A demoted save is not discarded silently.  Its intended verdict is appended
// to `overridden` (machine-readable — never prose bolted onto `error`), and
// everything only the dispatch knows (`stats`, `usage`, `sessionID`,
// `result`, …) is still merged: the point is the verdict, not freezing the
// whole record.  The passed `job` object is updated to the preserved terminal
// fields too, so a caller's later saves and its rendering agree with disk.
//
// The read-check-write below is TOCTOU-racy in theory: a cancel landing
// between the read and the write would still be overwritten.  That residual
// window (sub-millisecond, against a cancel a human just typed) is accepted —
// closing it needs locking this store does not have.
export function saveJob(stateDir, job) {
  const file = path.join(jobDir(stateDir, job.id), "job.json");
  const existing = readJson(file);
  if (existing?.status === "cancelled") demoteToCancelled(job, existing);
  writeJson(file, job);
}

// Rewrites `job` in place so its verdict is the one already on disk, keeping
// the verdict it was trying to write on `overridden`.
function demoteToCancelled(job, existing) {
  const preserved = Array.isArray(existing.overridden) ? existing.overridden : null;
  if (job.status !== existing.status) {
    // A genuinely different verdict was attempted — record it.  An incoming
    // save that already agrees (the same caller saving again after an earlier
    // demotion) adds nothing.
    const attempted = {
      status: job.status ?? null,
      error: job.error ?? null,
      at: new Date().toISOString(),
    };
    if (job.failure != null) attempted.failure = job.failure;
    job.overridden = [...(preserved ?? []), attempted];
  } else {
    job.overridden = preserved ?? [];
  }
  for (const field of VERDICT_FIELDS) {
    if (field in existing) job[field] = existing[field];
    else delete job[field];
  }
}

export function loadJob(stateDir, jobId) {
  return readJson(path.join(jobDir(stateDir, jobId), "job.json"));
}

export function listJobs(stateDir) {
  const root = path.join(stateDir, "jobs");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .map((id) => loadJob(stateDir, id))
    .filter(Boolean)
    .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
}

export function latestJob(stateDir, predicate = () => true) {
  return listJobs(stateDir).find(predicate) ?? null;
}

export function appendEvent(stateDir, jobId, event) {
  const dir = jobDir(stateDir, jobId);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "events.ndjson"), `${JSON.stringify(event)}\n`, "utf8");
}
