// luna-reconcile.mjs — kusabi #531: deterministic stale-state reconciliation
// for luna mission resume.
//
// `luna-resume` reconciles stale state BEFORE invoking the driver seam.  This
// module owns the settlement rules, all deterministic and idempotent:
//
//   - a dead mission pid never blocks resume (the driver re-arms the control
//     record when it actually takes over);
//   - a stale inner chain — a chain recorded on the mission whose process is
//     gone — is settled through the EXISTING chain stop lever
//     (requestChainStop): its stale-pid branch finalises status `cancelled`
//     with a finishedAt and emits the existing host-side terminal
//     notification, so chain finalization and notification semantics stay
//     authoritative; an already-terminal chain is never touched again;
//   - a stale Luna/Sol job record — a job-store row whose title starts with
//     `luna mission <mission-id>:` (the exact pattern realCoordinatorDispatch
//     and realSolDispatch emit) — settles to a terminal status with a
//     finishedAt when its recorded process is gone;
//   - a genuinely LIVE mission seat job refuses the resume outright (the
//     resume guard, not settlement).
//
// Repeated reconciliation is idempotent: a second run changes nothing — no
// second notification, no status churn, no rewrites.  Reconciliation never
// spawns a watcher or waiter process (it is an inline state operation).

import fs from "node:fs";
import path from "node:path";
import { readChainControl, requestChainStop, isPidAlive } from "./chain-control.mjs";
import { listJobs, saveJob } from "./job-store.mjs";

/**
 * The job-title prefix that attributes a seat job to a mission (the frozen
 * reconciliation assumption, documented in luna-reconcile.test.mjs): the
 * exact title pattern realCoordinatorDispatch and realSolDispatch emit.
 *
 * @param {string} missionId
 * @returns {string}
 */
export function missionJobTitlePrefix(missionId) {
  return `luna mission ${missionId}:`;
}

/**
 * The mission's seat jobs: job-store records whose title starts with
 * `luna mission <mission-id>:`.
 *
 * @param {string} stateDir
 * @param {string} missionId
 * @returns {Array<object>} job records.
 */
export function missionJobs(stateDir, missionId) {
  const prefix = missionJobTitlePrefix(missionId);
  return listJobs(stateDir).filter((j) => typeof j?.title === "string" && j.title.startsWith(prefix));
}

/**
 * Whether any recorded mission seat job is genuinely still running: a job
 * with status "running" whose recorded process is alive.  Such a job means
 * the previous driver may still be dispatching — resume must refuse.
 *
 * @param {string} stateDir
 * @param {string} missionId
 * @returns {boolean}
 */
export function missionHasLiveJob(stateDir, missionId) {
  return missionJobs(stateDir, missionId).some((j) => jobIsRunningLive(j));
}

/** A job counts as live-running when its record says running and its process is alive. */
function jobIsRunningLive(job) {
  if (job?.status !== "running") return false;
  const pid = job?.process?.pid;
  return isPidAlive(pid);
}

/**
 * Settle a stale inner chain through the existing chain stop lever.  A chain
 * still `running` (live or stale pid) gets requestChainStop(chainDir, "luna")
 * — which either writes the stop request for a live process or finalises a
 * dead process's record to cancelled with the existing terminal
 * notification.  An already-terminal chain is left untouched (no
 * re-notification, no rewrite).
 *
 * @param {string} stateDir
 * @param {string} chainId
 * @returns {{ settled: boolean, chainId: string }}
 */
function settleStaleChain(stateDir, chainId) {
  const chainDir = path.join(stateDir, "chains", chainId);
  if (!fs.existsSync(chainDir)) return { settled: false, chainId };
  const control = readChainControl(chainDir);
  if (!control) return { settled: false, chainId };
  if (control.status !== "running") return { settled: false, chainId };
  requestChainStop(chainDir, "luna");
  return { settled: true, chainId };
}

/**
 * Settle a stale mission seat job: a job that says `running` whose recorded
 * process is gone (or was never recorded) is settled to `cancelled` with a
 * finishedAt through the job-store chokepoint (the terminal-status invariant
 * and kaiba retirement semantics stay authoritative).  A live-running job is
 * NEVER settled here — the resume guard refuses before this runs.
 *
 * @param {string} stateDir
 * @param {object} job
 * @param {string} [now] — injected time (ISO).
 * @returns {{ settled: boolean, jobId: string }}
 */
function settleStaleJob(stateDir, job, now) {
  if (job?.status !== "running") return { settled: false, jobId: job?.id };
  if (jobIsRunningLive(job)) return { settled: false, jobId: job?.id };
  const settled = {
    ...job,
    status: "cancelled",
    finishedAt: now,
    settledBy: "luna-reconcile",
  };
  saveJob(stateDir, settled);
  return { settled: true, jobId: job?.id };
}

/**
 * Reconcile a mission's stale state deterministically (kusabi #531 criterion
 * 6).  Idempotent by construction: terminal chains and settled jobs are
 * skipped on every run, so a second run changes nothing.
 *
 * @param {object} opts
 * @param {string} opts.stateDir
 * @param {string} opts.missionId
 * @param {object|null} opts.record — the mission record (for record.chains).
 * @param {string} [opts.now] — injected time (ISO), for deterministic tests.
 * @returns {{ settledChains: string[], settledJobs: string[] }}
 */
export function reconcileMissionState({ stateDir, missionId, record, now = new Date().toISOString() }) {
  const settledChains = [];
  const chains = Array.isArray(record?.chains) ? record.chains : [];
  for (const chainId of chains) {
    if (typeof chainId === "string") {
      const r = settleStaleChain(stateDir, chainId);
      if (r.settled) settledChains.push(r.chainId);
    }
  }
  const settledJobs = [];
  for (const job of missionJobs(stateDir, missionId)) {
    if (!job?.id) continue;
    const r = settleStaleJob(stateDir, job, now);
    if (r.settled) settledJobs.push(r.jobId);
  }
  return { settledChains, settledJobs };
}