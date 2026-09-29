// backend-dispatch-core.mjs — shared dispatch lifecycle for CLI backends
//
// Shared execution lifecycle extracted from dispatch adapters (kusabi step 5).
// Owns the mechanical job-level lifecycle: initial save, prompt persistence,
// progress watch, start event, stats saving throttle, process identity & watchdog
// recording, failure classification dispatch, usage & completed result persistence,
// finished event, stop reason assignment, and final save.
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

const STATS_SAVE_INTERVAL_MS = 1000;

/**
 * Run the standard backend dispatch lifecycle.
 *
 * @param {object} opts
 * @param {string} opts.stateDir - State directory root.
 * @param {object} opts.job - Initial job record (already populated, status "running").
 * @param {string} opts.promptText - Prompt content to persist in prompt.md.
 * @param {object} [opts.dispatchEvent] - Start event payload appended to events.ndjson.
 * @param {Function} [opts.beforeSpawn] - Optional hook () => null | { status, error, event, resultText }.
 * @param {Function} opts.runProcess - (hooks: { onStart, onLine, onWatchdog }) => Promise<{ code, stdout, stderr, timedOut, stalled, spawnError }>.
 * @param {object} [opts.stream] - Stream handling { init, state, onLine: (state, rawLine, job) => void }.
 * @param {object} [opts.labels] - String labels e.g. { spawnErrorPrefix, bin }.
 * @param {string} [opts.bin] - Process binary path.
 * @param {number|null} [opts.timeoutS] - Timeout in seconds.
 * @param {number|null} [opts.watchdogS] - Watchdog silence threshold in seconds.
 * @param {Function} [opts.afterProcess] - Hook run after process exit before classification.
 * @param {Function} [opts.classifyExit] - ({ code, stdout, stderr, state, job }) => ExitOutcome.
 * @param {Function|object} [opts.finishedEvent] - Finished event payload or builder function.
 * @param {string} [opts.resultBackend] - Backend identifier for result recovery.
 * @param {Function} [opts.transformResultText] - Optional (text, { job, state }) => string.
 * @param {boolean} [opts.deferResultWrite] - If true, write result.md after finished event and final save.
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
  finishedEvent,
  resultBackend,
  transformResultText,
  deferResultWrite = false,
}) {
  const bin = binOpt ?? labels?.bin;
  const spawnErrorPrefix = labels?.spawnErrorPrefix ?? "dispatch failed";

  saveJob(stateDir, job);
  fs.writeFileSync(path.join(jobDir(stateDir, job.id), "prompt.md"), promptText, "utf8");

  const progressWatch = startKaibaProgressWatch({ stateDir, jobId: job.id });

  try {
    if (typeof beforeSpawn === "function") {
      const refusal = await beforeSpawn({ job, stateDir });
      if (refusal) {
        job.status = refusal.status ?? "error";
        job.error = refusal.error;
        job.finishedAt = new Date().toISOString();
        if (refusal.event) {
          appendEvent(stateDir, job.id, refusal.event);
        }
        job.stopReason = deriveStopReason({ status: job.status, stats: job.stats });
        saveJob(stateDir, job);
        return { job, resultText: refusal.resultText ?? "", stateDir };
      }
    }

    if (dispatchEvent) {
      appendEvent(stateDir, job.id, dispatchEvent);
    }

    const streamState = typeof stream?.init === "function" ? stream.init() : (stream?.state ?? {});
    let lastStatsSaveAt = 0;

    const onLine = (rawLine) => {
      if (typeof stream?.onLine === "function") {
        const handled = stream.onLine(streamState, rawLine, job);
        if (handled === false || handled === null) return;
      }
      const now = Date.now();
      if (now - lastStatsSaveAt >= STATS_SAVE_INTERVAL_MS) {
        lastStatsSaveAt = now;
        saveJob(stateDir, job);
      }
    };

    const onStart = ({ pid, startTime }) => {
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

    const { code, stdout, stderr, timedOut, stalled, spawnError } = await runProcess({
      onStart,
      onLine,
      onWatchdog,
    });

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
      });

      if (exitOutcome) {
        if (exitOutcome.status) job.status = exitOutcome.status;
        if (exitOutcome.error !== undefined) job.error = exitOutcome.error;
        if (exitOutcome.sessionID) job.sessionID = exitOutcome.sessionID;
        for (const [key, val] of Object.entries(exitOutcome)) {
          if (!["status", "error", "usage", "text", "sessionID"].includes(key) && val !== undefined) {
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

      if (!deferResultWrite) {
        const rawText = exitOutcome?.text ?? "";
        const resolved = resolveCompletedResult({
          backend: resultBackend,
          fetched: { ok: true, text: rawText },
          coords: { sessionId: job.sessionID },
        });
        resultText = resolved.text ?? rawText;
        if (typeof transformResultText === "function") {
          resultText = transformResultText(resultText, { job, state: streamState });
        }
        job.result = resolved.record;
        fs.writeFileSync(path.join(jobDir(stateDir, job.id), "result.md"), resultText, "utf8");
      }
    }

    const finishedPayload = typeof finishedEvent === "function"
      ? finishedEvent({ state: streamState, job, code, resultText })
      : finishedEvent;
    if (finishedPayload) {
      appendEvent(stateDir, job.id, finishedPayload);
    }

    // Record the closed terminal reason (kusabi #388). The dispatch finalizes its
    // job.json on this path and never calls deriveStopReason via an SSE fold,
    // so stamp here at the terminal write. worktreeChanged is left
    // unmeasured at job level, matching the shared path: a completed wrapper
    // records "completed"; error/timeout/stalled fall through to "unknown".
    job.stopReason = deriveStopReason({ status: job.status, stats: job.stats });
    saveJob(stateDir, job);

    if (deferResultWrite && job.status === "completed") {
      const rawText = exitOutcome?.text ?? "";
      const resolved = resolveCompletedResult({
        backend: resultBackend,
        fetched: { ok: true, text: rawText },
        coords: { sessionId: job.sessionID },
      });
      resultText = resolved.text ?? rawText;
      if (typeof transformResultText === "function") {
        resultText = transformResultText(resultText, { job, state: streamState });
      }
      job.result = resolved.record;
      saveJob(stateDir, job);
      fs.writeFileSync(path.join(jobDir(stateDir, job.id), "result.md"), resultText, "utf8");
    }

    return { job, resultText, stateDir };
  } finally {
    progressWatch.stop();
  }
}
