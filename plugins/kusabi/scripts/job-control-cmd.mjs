// job-control-cmd: the cancel / serve-stop command surfaces moved out of
// kusabi-companion.mjs verbatim (pure move refactor): stopRunningJob,
// stopSpawnedCliJob, stopOpencodeJob, cmdCancel, liveRunningJobs and
// cmdServeStop.  No behaviour change.

import { stateRoot, stateDirFor, readJson } from "./state-paths.mjs";
import { loadJob, saveJob, listJobs, latestJob } from "./job-store.mjs";
import { stopRecordedProcess } from "./process-identity.mjs";
import {
  runningRecordIsStale,
  isOurServe,
  api,
  serverHealthy,
} from "./serve-lifecycle.mjs";
import {
  readChainControl,
  effectiveStatus,
  chainIdForJob,
} from "./chain-control.mjs";
import { CLAUDE_BACKEND } from "./claude-dispatch.mjs";
import { AGY_BACKEND } from "./agy-dispatch.mjs";
import { CODEX_BACKEND } from "./codex-dispatch.mjs";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * Stop the process behind a running job, per backend, and report what was
 * OBSERVED (kusabi #209).
 *
 * The incident this exists for: a claude-backend job was "cancelled", the
 * record was rewritten and `cancelled <id>` printed, and the process kept
 * writing files into the container for another 17 minutes.  The damage came
 * from the false confirmation, not from the failure to kill — an operator
 * told the job stopped goes on to reuse the container.
 *
 * `note` describes a stop that actually happened (or a process proven
 * already gone).  `failure` is non-null whenever the job may still be
 * running: the caller must then leave the record `running` and exit nonzero.
 * Exactly one of the two is set.
 *
 * @param {string} stateDir
 * @param {object} job
 * @returns {Promise<{note: string|null, failure: string|null}>}
 */
async function stopRunningJob(stateDir, job) {
  // Records written before the backend split carry no `backend` field and
  // are opencode by definition (same rule every other reader uses).
  const backend = job.backend ?? "opencode";
  // Spawned-CLI backends (claude, agy, codex) are stopped the same way and for
  // the same reason: their job records have no session to abort, so the
  // recorded process is the only lever.  Keyed on the recorded-process shape
  // rather than on one backend's name — routing an agy job to the opencode
  // path would try to abort a session that does not exist and then report
  // success, which is precisely the false confirmation kusabi #209 exists to
  // prevent.
  if (backend === CLAUDE_BACKEND || backend === AGY_BACKEND || backend === CODEX_BACKEND) {
    return stopSpawnedCliJob(job, backend);
  }
  return stopOpencodeJob(stateDir, job);
}

// claude / agy backends: there is no session to abort — the record's
// sessionID is null by construction until the CLI returns one — so the
// recorded process is the only lever, and it is verified before it is
// signalled.
async function stopSpawnedCliJob(job, backend) {
  const stop = await stopRecordedProcess(job.process);
  const tail = "The record is left `running`; nothing here proves the job stopped.";
  switch (stop.outcome) {
    case "stopped":
      return { note: `Stopped process group ${stop.pid} (SIGKILL): the ${backend} process and its children are gone.`, failure: null };
    case "already-gone":
      return { note: `Nothing to signal — ${stop.reason}. The record is finalised.`, failure: null };
    case "identity-mismatch":
      // Refusing to signal here is the point: a recorded pid outlives its
      // process, and one recycled pid already cost an unrelated live server
      // 22 minutes of downtime.  The job's own process is gone.
      return { note: `Not signalled: ${stop.reason}. This job's own process is gone; the record is finalised.`, failure: null };
    case "no-record":
      // #175/#176: a `running` record whose driver died without rewriting it
      // is a fossil.  With no pid recorded there is no process to observe, so
      // the staleness rule is the only evidence available — and it can only
      // ever conclude "gone", never "stopped".
      if (runningRecordIsStale(job)) {
        return { note: `${job.id} names no process and has had no activity for over 6 hours — a fossil record (its driver died without rewriting it). Nothing to signal; the record is finalised.`, failure: null };
      }
      return {
        note: null,
        failure: [
          `could not stop ${job.id}: the job record names no process id, so there is nothing to signal.`,
          "This record predates process recording (kusabi #209). The job may still be running — find it (ps) and kill it by hand.",
          tail,
        ].join("\n"),
      };
    case "unverifiable":
      return {
        note: null,
        failure: [
          `could not stop ${job.id}: pid ${stop.pid} could not be verified as this job's process — ${stop.reason}.`,
          "Refusing to signal a pid that may belong to something else. The job may still be running; check pid " +
            `${stop.pid} and kill it by hand if it is this job's.`,
          tail,
        ].join("\n"),
      };
    default: // "alive" — signalled, and something survived
      return {
        note: null,
        failure: [
          `could not stop ${job.id}: ${stop.reason}.`,
          `pid ${stop.pid} is STILL RUNNING and still writing into its container — do not reuse that container.`,
          `Kill it by hand (kill -9 -${stop.pid}) and re-run cancel.`,
          tail,
        ].join("\n"),
      };
  }
}

// opencode backend: the executor is the serve, and the lever is the session
// abort.  The request's outcome is now surfaced — a failed abort used to be
// swallowed by a bare `.catch(() => {})` and still print `cancelled`.
async function stopOpencodeJob(stateDir, job) {
  const server = readJson(path.join(stateDir, "server.json"));
  if (!(await serverHealthy(server))) {
    // No live serve answers for this workspace, so nothing is executing the
    // session: the record is a fossil to finalise, not a running job
    // (#175/#176).  Said out loud rather than implied by silence.
    return { note: "No healthy opencode serve answers for this workspace, so nothing can still be executing this job. Nothing was aborted; the record is finalised.", failure: null };
  }
  if (typeof job.sessionID !== "string" || job.sessionID === "") {
    // Never build `/session/null/abort`: it aborts nothing and its failure
    // is exactly what used to be swallowed.
    return {
      note: null,
      failure: [
        `could not stop ${job.id}: the record names no session, so there is nothing to abort on the serve.`,
        "The serve is healthy, so the job may still be running. Stop it by hand (kusabi-companion serve-stop --force stops the whole serve).",
        "The record is left `running`; nothing here proves the job stopped.",
      ].join("\n"),
    };
  }
  try {
    await api(server, "POST", `/session/${job.sessionID}/abort`);
  } catch (err) {
    return {
      note: null,
      failure: [
        `could not stop ${job.id}: the abort request for session ${job.sessionID} failed — ${err.message}`,
        "The job may still be running. The record is left `running`; nothing here proves the job stopped.",
      ].join("\n"),
    };
  }
  return { note: `Aborted opencode session ${job.sessionID} on the serve.`, failure: null };
}

export async function cmdCancel(cwd, { text }) {
  const stateDir = stateDirFor(cwd);
  const jobId = text.split(/\s+/).filter(Boolean)[0];
  const job = jobId ? loadJob(stateDir, jobId) : latestJob(stateDir, (j) => j.status === "running");
  if (!job) return jobId ? `no such job: ${jobId}` : "no running jobs to cancel.";
  if (job.status !== "running") return `${job.id} is not running (status: ${job.status}).`;

  const { note, failure } = await stopRunningJob(stateDir, job);
  if (failure) {
    // The record stays `running` because, as far as anything here can prove,
    // it IS running.  The nonzero exit is the other half: a caller that only
    // reads the status code must not be able to mistake this for a cancel.
    return { text: failure, exitCode: 1 };
  }

  job.status = "cancelled";
  job.finishedAt = new Date().toISOString();
  saveJob(stateDir, job);

  const lines = [`cancelled ${job.id}${job.sessionID ? ` (session ${job.sessionID})` : ""}.`];
  if (note) lines.push(note);

  // A job that belongs to a chain does not stop the chain: cancelling it only
  // ends one phase, and the chain starts the next round.  Say so — but say what
  // was actually observed, not an assumption about the chain's state.
  const chainId = chainIdForJob(job);
  if (chainId) {
    const control = readChainControl(path.join(stateDir, "chains", chainId));
    const { status } = effectiveStatus(control);
    if (status === "running" || status === "stopping") {
      lines.push(`This job belongs to chain ${chainId}, which is still running — cancelling a job does not stop the chain.`);
      lines.push(`To stop the chain itself: kusabi-companion chain-cancel ${chainId}`);
    } else if (status === "stale") {
      lines.push(`This job belongs to chain ${chainId}, whose process is gone (record is stale).`);
      lines.push(`To finalise that record: kusabi-companion chain-cancel ${chainId}`);
    } else if (status === "unknown") {
      lines.push(`This job belongs to chain ${chainId}, whose state is unknown (no control record — chain predates the stop lever).`);
      lines.push(`Cancelling a job does not stop a chain. To stop it: kusabi-companion chain-cancel ${chainId}`);
    } else {
      lines.push(`This job belongs to chain ${chainId}, which is already ${status}.`);
    }
  }

  return lines.join("\n");
}

// A `running` job record whose last activity is older than RUNNING_STALE_MS
// is a fossil (the driver died without rewriting it) and does not count as a
// live job — it must not block stopping the serve.  Shared by cmdServeStop
// and the chain driver's finally guard so both use the same staleness rule
// (kusabi #175).  Exported because that guard now lives in chain-driver.mjs
// (kusabi #264 PR 2/2) — the rule must stay one function, not two copies.
export function liveRunningJobs(stateDir) {
  return listJobs(stateDir).filter(function (j) {
    return j.status === "running" && !runningRecordIsStale(j);
  });
}

export function cmdServeStop(cwd, { flags } = {}) {
  const stateDir = stateDirFor(cwd);

  // Check for running jobs. If any exist, decline unless --force is passed.
  // A `running` record whose last activity is older than 6 hours is a fossil
  // (the driver died without rewriting it) and does not count — it must not
  // block stopping the serve (kusabi #162 follow-up).
  const runningJobs = liveRunningJobs(stateDir);
  if (runningJobs.length > 0) {
    if (!flags?.force) {
      const jobList = runningJobs.map(function (j) { return j.id; }).join(", ");
      const messages = [
        `${runningJobs.length} job(s) still running: ${jobList}`,
        "serve-stop does not stop a running chain — the chain spawns a new serve on its next dispatch.",
        "To stop a chain: kusabi-companion chain-cancel <chainId>",
        "To force-stop the serve regardless: kusabi-companion serve-stop --force",
      ];
      return messages.join("\n");
    }
  }

  const serverFile = path.join(stateDir, "server.json");
  const server = readJson(serverFile);
  if (!server?.pid) return "no server recorded for this directory.";

  // Never signal a pid we cannot attribute to one of our own serves: the
  // record can outlive the serve by days, and the pid may by then belong to
  // something else entirely (a recycled pid, or a TID of an unrelated
  // process).  The decline is said out loud: this is an explicit user-facing
  // command, and going quiet would read as "stopped" when nothing was
  // stopped (kusabi #181).
  const identity = isOurServe(server.pid, { root: stateRoot(), stateDir });
  if (!identity.ours) {
    if (identity.class === "refuted") {
      // The record positively names a process that is not our serve (or is
      // gone): the record is what is invalid — delete it, kill nothing.
      try { fs.unlinkSync(serverFile); } catch { /* best-effort */ }
      return `declined to stop pid ${server.pid}: ${identity.reason} (server.json removed; no signal sent).`;
    }
    // 'unverifiable' (hidepid, older marker set, /proc-less platform): the
    // pid may well be our serve — we just cannot prove it.  Deleting the
    // record would strand a live serve (it could never be stopped again and
    // the next dispatch would spawn a duplicate), so the record is kept and
    // the next ensureServer() health probe can still reuse the serve.
    return `declined to stop pid ${server.pid}: ${identity.reason} (server.json kept; no signal sent).`;
  }

  try {
    process.kill(server.pid);
    try { fs.unlinkSync(serverFile); } catch { /* best-effort */ }
    return `stopped opencode server (pid ${server.pid}).`;
  } catch {
    try { fs.unlinkSync(serverFile); } catch { /* best-effort */ }
    return `server pid ${server.pid} was not running.`;
  }
}
