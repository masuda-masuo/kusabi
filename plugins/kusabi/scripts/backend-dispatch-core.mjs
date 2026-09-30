// backend-dispatch-core.mjs — shared dispatch lifecycle for CLI backends
//
// Shared execution lifecycle extracted from dispatch adapters (kusabi step 5).
// Owns the mechanical job-level lifecycle: initial save, prompt persistence,
// start event, pre-spawn hook, process execution with stats saving throttle,
// failure classification dispatch, completed result persistence (usage, recovery,
// result.md), fallback session id, finished event with spawned flag, stop reason
// assignment, and final save.
//
// Backend-specific policy (argument building, stream event parsing, exit
// classification logic, and event payloads) remains in the caller.

import fs from "node:fs";
import path from "node:path";
import { saveJob, jobDir, appendEvent } from "./job-store.mjs";
import { writeJson } from "./state-paths.mjs";
import { durationS } from "./render.mjs";
import { resolveCompletedResult } from "./result-recovery.mjs";
import { deriveStopReason } from "./stop-reason.mjs";
import { startKaibaProgressWatch } from "./kaiba-progress-watch.mjs";

// Bounded cadence, not every line: a chatty stream must not turn into a
// write per event, but `kusabi status` still needs to see the job
// record move while the child is running, not only once it exits.
const STATS_SAVE_INTERVAL_MS = 1000;

// A terminal failure the backend already named a quota exhaustion becomes
// "quota-exhausted" (kusabi #388); any other provider-error stays
// "provider-error".  Used on the refusal path and the normal path alike, so
// a backend opts in only by putting `failure` on the job.
function capacityReasonOf(job) {
  return (job.status === "provider-error" && job.failure?.kind === "quota-exhaustion")
    ? (job.failure?.quota ?? "quota-exhaustion")
    : null;
}

// The trail keeps its dispatch/finished bookends so auditing tools see no
// hole; `spawned` tells a refusal apart from a run, and stream health counts
// (streamEvents, malformedLines) reflect what arrived before finish.
function appendFinishedEvent(stateDir, jobId, finishedEvent, {
  state,
  job,
  code,
  resultText,
  streamEvents,
  malformedLines,
  spawned,
}) {
  const finishedPayload = typeof finishedEvent === "function"
    ? finishedEvent({ state, job, code, resultText, streamEvents, malformedLines })
    : finishedEvent;
  if (finishedPayload) {
    appendEvent(stateDir, jobId, {
      ...finishedPayload,
      streamEvents,
      malformedLines,
      spawned,
    });
  }
}

/**
 * Run the standard backend dispatch lifecycle.
 *
 * @param {object} opts
 * @param {string} opts.stateDir - State directory root.
 * @param {object} opts.job - Initial job record (already populated, status "running").
 * @param {string} opts.promptText - Prompt content to persist in prompt.md.
 * @param {object} [opts.dispatchEvent] - Start event payload appended to events.ndjson.
 * @param {Function} [opts.beforeSpawn] - Optional hook () => null | { status, error, event, events, failure, resultText }. A backend opts in to capacity classification by returning failure.
 * @param {Function} opts.runProcess - (hooks: { onStart, onLine, onWatchdog }) => Promise<{ code, stdout, stderr, timedOut, stalled, spawnError }>.
 * @param {object} [opts.stream] - Stream handling { init, state, onLine: (state, rawLine, job) => void }.
 * @param {object} [opts.labels] - String labels e.g. { spawnErrorPrefix, bin }.
 * @param {string} [opts.bin] - Process binary path.
 * @param {number|null} [opts.timeoutS] - Timeout in seconds.
 * @param {number|null} [opts.watchdogS] - Watchdog silence threshold in seconds.
 * @param {Function} [opts.afterProcess] - Hook run after process exit before classification.
 * @param {Function} [opts.classifyExit] - ({ code, stdout, stderr, state, job, runResult, streamEvents, malformedLines }) => ExitOutcome. A backend opts in to capacity classification by returning failure. Exit-code-versus-payload precedence is the backend's decision, see docs/design/phase-chain.md.
 * @param {Function} [opts.fallbackSessionId] - Optional ({ state, job }) => string|null for fallback session ID before finished event.
 * @param {Function|object} [opts.finishedEvent] - Finished event payload or builder function ({ state, job, code, resultText, streamEvents, malformedLines }) => object.
 * @param {string} [opts.resultBackend] - Backend identifier for result recovery.
 * @param {Function} [opts.transformResultText] - Optional (text, { job, state }) => string.
 * @returns {Promise<{ job: object, resultText: string, stateDir: string }>}
 */
export async function runBackendDispatch({
  stateDir,
  job,
  promptText,
  dispatchEvent,
  beforeSpawn,
  runProcess,
  stream,
  labels,
  bin: binOpt,
  timeoutS,
  watchdogS,
  afterProcess,
  classifyExit,
  fallbackSessionId,
  finishedEvent,
  resultBackend,
  transformResultText,
}) {
  const bin = binOpt ?? labels?.bin;
  const spawnErrorPrefix = labels?.spawnErrorPrefix ?? "dispatch failed";

  saveJob(stateDir, job);
  fs.writeFileSync(path.join(jobDir(stateDir, job.id), "prompt.md"), promptText, "utf8");

  if (dispatchEvent) {
    appendEvent(stateDir, job.id, dispatchEvent);
  }

  const progressWatch = startKaibaProgressWatch({ stateDir, jobId: job.id });

  try {
    const streamState = typeof stream?.init === "function" ? stream.init() : (stream?.state ?? {});

    if (typeof beforeSpawn === "function") {
      const refusal = await beforeSpawn({ job, stateDir });
      if (refusal) {
        job.status = refusal.status ?? "error";
        job.error = refusal.error;
        job.finishedAt = new Date().toISOString();
        if (refusal.failure !== undefined) {
          job.failure = refusal.failure;
        }
        for (const [key, val] of Object.entries(refusal)) {
          if (!["status", "error", "event", "events", "resultText", "failure"].includes(key) && val !== undefined) {
            job[key] = val;
          }
        }
        if (Array.isArray(refusal.events)) {
          for (const evt of refusal.events) {
            appendEvent(stateDir, job.id, evt);
          }
        } else if (refusal.event) {
          appendEvent(stateDir, job.id, refusal.event);
        }
        appendFinishedEvent(stateDir, job.id, finishedEvent, {
          state: streamState,
          job,
          code: null,
          resultText: "",
          streamEvents: 0,
          malformedLines: 0,
          spawned: false,
        });
        job.stopReason = deriveStopReason({
          status: job.status,
          stats: job.stats,
          capacityReason: capacityReasonOf(job),
        });
        saveJob(stateDir, job);
        return { job, resultText: refusal.resultText ?? "", stateDir };
      }
    }

    let spawned = false;
    let streamEvents = 0;
    let malformedLines = 0;
    let lastStatsSaveAt = 0;

    const onLine = (rawLine) => {
      const isBlank = typeof rawLine === "string" ? !rawLine.trim() : !rawLine;
      if (typeof stream?.onLine === "function") {
        const handled = stream.onLine(streamState, rawLine, job);
        if (handled === false || handled === null) {
          if (!isBlank) {
            malformedLines += 1;
          }
          return;
        }
      } else if (isBlank) {
        return;
      }
      streamEvents += 1;
      const now = Date.now();
      if (now - lastStatsSaveAt >= STATS_SAVE_INTERVAL_MS) {
        lastStatsSaveAt = now;
        saveJob(stateDir, job);
      }
    };

    const onStart = ({ pid, startTime }) => {
      spawned = true;
      // The identity token (runner's /proc start time) lets `cancel` verify
      // the recorded pid before signalling the group (kusabi #209): a
      // recycled pid must never be killed on a stale record's say-so.
      job.process = { pid, startTime, recordedAt: new Date().toISOString() };
      saveJob(stateDir, job);
    };

    const onWatchdog = ({ kind, silenceS }) => {
      if (kind === "fired") {
        appendEvent(stateDir, job.id, { type: "companion.watchdog.fired", silenceS });
      } else {
        appendEvent(stateDir, job.id, { type: "companion.watchdog.kill" });
      }
    };

    const processResult = await runProcess({
      onStart,
      onLine,
      onWatchdog,
    });
    const { code, stdout, stderr, timedOut, stalled, spawnError } = processResult;
    if (spawnError) {
      spawned = false;
    }

    job.finishedAt = new Date().toISOString();

    if (typeof afterProcess === "function") {
      await afterProcess({
        code,
        stdout,
        stderr,
        timedOut,
        stalled,
        spawnError,
        state: streamState,
        job,
        runResult: processResult,
      });
    }

    let resultText = "";
    let exitOutcome = null;

    if (spawnError) {
      job.status = "error";
      job.error = `${spawnErrorPrefix}: could not start ${bin}: ${spawnError.message}`;
    } else if (stalled) {
      job.status = "stalled";
      job.error = `watchdog: no events for ${watchdogS}s (process killed)`;
    } else if (timedOut) {
      job.status = "timeout";
      job.error = `timed out after ${timeoutS}s`;
    } else if (typeof classifyExit === "function") {
      exitOutcome = await classifyExit({
        code,
        stdout,
        stderr,
        state: streamState,
        job,
        runResult: processResult,
        streamEvents,
        malformedLines,
      });

      if (exitOutcome) {
        if (exitOutcome.status) job.status = exitOutcome.status;
        if (exitOutcome.error !== undefined) job.error = exitOutcome.error;
        if (exitOutcome.sessionID) job.sessionID = exitOutcome.sessionID;
        for (const [key, val] of Object.entries(exitOutcome)) {
          if (!["status", "error", "usage", "text", "sessionID", "fetched"].includes(key) && val !== undefined) {
            job[key] = val;
          }
        }
      }
    }

    if (job.status === "completed") {
      const rawUsage = exitOutcome?.usage ?? job.usage;
      if (rawUsage) {
        job.usage = {
          ...rawUsage,
          phase: job.phase,
          durationSeconds: durationS(job),
        };
        writeJson(path.join(jobDir(stateDir, job.id), "usage.json"), job.usage);
      }

      const rawText = exitOutcome?.text ?? "";
      const fetched = exitOutcome?.fetched ?? { ok: true, text: rawText };
      const resolved = resolveCompletedResult({
        backend: resultBackend,
        fetched,
        coords: { sessionId: job.sessionID },
      });
      resultText = resolved.text ?? rawText;
      if (typeof transformResultText === "function") {
        resultText = transformResultText(resultText, { job, state: streamState });
      }
      job.result = resolved.record;
      if (resolved.record?.recovered) {
        appendEvent(stateDir, job.id, {
          type: "companion.result.recovered",
          source: resolved.record.recovery.source,
          chars: resolved.record.recovery.chars,
          fetchFailed: resolved.record.fetchFailed,
          fetchError: resolved.record.fetchError,
        });
      }
      fs.writeFileSync(path.join(jobDir(stateDir, job.id), "result.md"), resultText, "utf8");
    }

    if (!job.sessionID && typeof fallbackSessionId === "function") {
      const fallback = fallbackSessionId({ state: streamState, job });
      if (fallback) {
        job.sessionID = fallback;
      }
    }

    appendFinishedEvent(stateDir, job.id, finishedEvent, {
      state: streamState,
      job,
      code,
      resultText,
      streamEvents,
      malformedLines,
      spawned,
    });

    // Record the closed terminal reason (kusabi #388). The dispatch finalizes its
    // job.json on this path and never calls deriveStopReason via an SSE fold,
    // so stamp here at the terminal write. worktreeChanged is left
    // unmeasured at job level, matching the shared path: a completed wrapper
    // records "completed"; error/timeout/stalled fall through to "unknown".
    job.stopReason = deriveStopReason({
      status: job.status,
      stats: job.stats,
      capacityReason: capacityReasonOf(job),
    });
    saveJob(stateDir, job);

    return { job, resultText, stateDir };
  } finally {
    progressWatch.stop();
  }
}
