// prompt-execution.mjs — SSE event stream, permission handling, runPrompt,
// fail-fast retry detection, and dispatchWithFallback.

import path from "node:path";
import fs from "node:fs";
import process from "node:process";
import { ensureServer, api, authHeader, judgeServeDeath, isOurServe } from "./serve-lifecycle.mjs";
import { newJobId, saveJob, jobDir, appendEvent } from "./job-store.mjs";
import { writeJson, stateRoot } from "./state-paths.mjs";
import { durationS } from "./render.mjs";
import { parseModel, selectRoutes, splitRouteBackend } from "./cli.mjs";
import { agyDispatch } from "./agy-dispatch.mjs";
import { cursorDispatch } from "./cursor-dispatch.mjs";

let _cachedClaudeDispatch = null;
async function getClaudeDispatch() {
  if (!_cachedClaudeDispatch) {
    const mod = await import("./claude" + "-dispatch.mjs");
    _cachedClaudeDispatch = mod.claudeDispatch;
  }
  return _cachedClaudeDispatch;
}

let _cachedTranslateDenyTools = null;
async function translateDenyToolsForFallback(tools) {
  if (!_cachedTranslateDenyTools) {
    const mod = await import("./claude" + "-dispatch.mjs");
    _cachedTranslateDenyTools = mod.translateDenyTools;
  }
  return _cachedTranslateDenyTools(tools);
}
import { resolveCompletedResult } from "./result-recovery.mjs";
import { deriveStopReason } from "./stop-reason.mjs";
import { startKaibaProgressWatch } from "./kaiba-progress-watch.mjs";

// =========================================================================
// fail-fast retry decision — pure, exported, unit-testable
// =========================================================================

// The set of fail-fast reasons that mean capacity / quota is permanently
// exhausted for this route — retrying on any other route in the tier cannot
// help.  Hoisted to module scope (kusabi #380) so the writer that classifies
// capacity and the fail-fast decision share ONE source of truth, and so
// future members are added in exactly one place.  `deriveStopReason` does NOT
// know this list: the caller passes `capacityReason` non-null iff the reason
// is a member here.
export const capacityReasons = ["free_tier_limit"];

/**
 * Decide whether a provider-retry loop should be stopped immediately.
 *
 * @param {object}       opts
 * @param {string|null}  opts.reason      — `action.reason` from the retry status event
 *                                          (e.g. "free_tier_limit").
 * @param {number}       opts.attempt     — Current retry attempt number (1-based),
 *                                          or 0 when the provider does not number
 *                                          its attempts.
 * @param {number}       opts.steps       — Number of steps completed so far.
 * @param {number}       [opts.retryCount] — Observed number of retry events; used
 *                                           as a fallback when attempt is absent.
 * @returns {{ stop: boolean, terminal: boolean }}
 *   - `stop`: end the dispatch now.
 *   - `terminal`: the provider has reported that retrying CANNOT succeed
 *     (capacity/quota permanently exhausted).
 */
export function shouldFailFast({ reason, attempt, steps, retryCount }) {
  // Capacity / quota reasons: the provider has stated retrying will never succeed.
  // Fire on the FIRST occurrence — no threshold.
  if (reason && capacityReasons.includes(reason)) {
    return { stop: true, terminal: true };
  }

  // When the provider does not number its attempts (attempt is 0 / falsy),
  // the observed retry count stands in so the threshold still trips after
  // three retries with zero completed steps.
  const effectiveAttempt = (attempt && attempt >= 1) ? attempt : (retryCount || 0);

  // Generic retry: stop when we have reached attempt 3 with ZERO completed steps.
  // Real work (steps > 0) means the model IS producing output; retries are
  // internal provider hiccups that the existing watchdog/timeout handle.
  if (effectiveAttempt >= 3 && steps === 0) {
    return { stop: true, terminal: false };
  }

  return { stop: false };
}

// =========================================================================
// job-outcome classification — pure, exported, unit-testable
// =========================================================================

/**
 * Determine final job status and error message from observed outcomes.
 *
 * Precedence (first match wins):
 *  1. `serve-dead` — the serve process disappeared.
 *  2. `provider-error` — provider retries exhausted.
 *  3. `stalled` — silence watchdog fired.
 *  4. `timeout` — abort triggered with no idle / session-error.
 *  5. `error` — session.error received.
 *  6. `completed` — all fine.
 *
 * @param {object} outcomes
 * @param {{ pid: number, port: number, since: string }|null} outcomes.serveDead
 * @param {{ reason: string|null, attempt: number, terminal: boolean, message: string }|null} outcomes.providerError
 * @param {boolean} outcomes.watchdogFired
 * @param {boolean} outcomes.watchdogKilled
 * @param {number} outcomes.watchdogS
 * @param {boolean} outcomes.sawIdle
 * @param {string|null} outcomes.sessionError
 * @param {number} outcomes.timeoutS
 * @returns {{ status: string, error: string|null }}
 */
export function classifyJobOutcome({
  serveDead,
  providerError,
  watchdogFired,
  watchdogKilled,
  watchdogS,
  sawIdle,
  sessionError,
  timeoutS,
}) {
  if (serveDead) {
    return {
      status: "serve-dead",
      error: `serve process died: pid ${serveDead.pid}, port ${serveDead.port} (gone since ${serveDead.since})`,
    };
  }
  if (providerError) {
    return {
      status: "provider-error",
      error: `provider error: ${providerError.reason || "retry"} (attempt ${providerError.attempt})${providerError.terminal ? " [terminal]" : ""}: ${providerError.message}`,
    };
  }
  if (watchdogFired) {
    return {
      status: "stalled",
      error: `watchdog: no events for ${watchdogS}s` + (watchdogKilled ? " (process killed)" : ""),
    };
  }
  // No idle and no session error means the watcher ended without the session
  // ever finishing.  There is deliberately no `aborted` input here: the caller
  // aborts during cleanup before classifying, so such a flag would always be
  // true and would carry no information — while inviting tests to assert on a
  // combination production can never produce.
  if (!sawIdle && !sessionError) {
    return {
      status: "timeout",
      error: `timed out after ${timeoutS}s`,
    };
  }
  if (sessionError) {
    return {
      status: "error",
      error: sessionError,
    };
  }
  return { status: "completed", error: null };
}

// =========================================================================
// completed-run integrity (kusabi #496) — pure, exported, unit-testable
// =========================================================================

/**
 * Detect the provider's "finished, reason unknown" terminal signal on a
 * session.status event.
 *
 * opencode closes a session with a `session.status` event whose
 * `properties.status` is `{ type: "finished", finish: "unknown", ... }`
 * when the run ended without a known reason.  The measured incident
 * (job-mtyfpjlc8452, 2026-09): a connection reset mid-run, one retry, then
 * `finish: "unknown"` followed by `session.idle` -- the recorded stream
 * carried the flat `{ finish: "unknown" }` line verbatim.  Only `unknown`
 * counts: a `done` finish is a normal completion, and `error` / `cancel`
 * finishes arrive with their own signals.
 *
 * @param {object} event — one recorded SSE event (only called for
 *                        `session.status` events).
 * @returns {boolean}
 */
export function finishedUnknownSignal(event) {
  const props = event?.properties;
  if (!props || typeof props !== "object") return false;
  // Flat shape (the incident's recorded line, verbatim).
  if (props.finish === "unknown") return true;
  // Structured opencode shape: properties.status = { type: "finished", finish: "unknown" }.
  const status = props.status;
  if (!status || typeof status !== "object") return false;
  if (status.type !== "finished") return false;
  return status.finish === "unknown";
}

/**
 * Phases whose deliverable IS the analysis itself: a run that changes no
 * files -- and even one that never emits a final message -- is still a
 * legitimate completion for them, so a recovered-only result must not be
 * downgraded.  Every other phase is expected to produce output.
 */
export const READ_ONLY_PHASES = Object.freeze(["plan", "review"]);

/**
 * Does this phase contract require the run to produce output?
 *
 * The standalone `review` command (kind "review") and the read-only
 * plan/review phases may legitimately finish with nothing written; every
 * other phase (implement, test-author, investigate, gofer, draft, respond,
 * salvage, ...) must.
 *
 * @param {string|null} phase — job phase, or null.
 * @param {string|null} kind  — job kind ("task" | "review" | ...), or null.
 * @returns {boolean}
 */
export function phaseRequiresOutput(phase, kind) {
  if (kind === "review") return false;
  return !READ_ONLY_PHASES.includes(phase);
}

/**
 * Deterministic probe evidence that a write run produced nothing.
 *
 * Incompleteness is only PROVEN when the applicable probes are red: P3
 * (no declared deliverable change) and P4 (smoke failed).  Green P3/P4 —
 * or probe results that never ran (absent) — is NOT incomplete evidence:
 * the work may well be done despite the missing final message, so the run
 * keeps its dispatch classification.
 *
 * @param {object}   opts
 * @param {Array<object>|null|undefined} opts.probeResults — the probe
 *   results recorded at the probe-truth layer (cmdTask / the chain's probe
 *   phase).  Probe names follow the chain probes ("P3: deliverables",
 *   "P4: smoke").
 * @returns {boolean}
 */
export function probeEvidenceIncomplete({ probeResults }) {
  const results = Array.isArray(probeResults) ? probeResults : [];
  const p3 = results.find((p) => typeof p?.probe === "string" && p.probe.startsWith("P3"));
  const p4 = results.find((p) => typeof p?.probe === "string" && p.probe.startsWith("P4"));
  if (!p3 || !p4) return false;
  return p3.passed === false && p4.passed === false;
}

/**
 * Decide whether a job the stream classified `completed` is in fact an
 * incomplete run that must be recorded as a non-success.
 *
 * The stream signal is necessary but NOT sufficient:
 *   - the provider itself reported the session finished with reason
 *     `unknown` (finishedUnknownSignal) — the signature of a connection
 *     that died mid-run rather than a normal completion;
 *   - the job has no terminal final payload: the result was recovered from
 *     the recorded stream (`recovered`) or there was nothing to recover
 *     (`none`) — a final assistant message never existed;
 *   - the phase requires output (see phaseRequiresOutput).
 *
 * The verdict additionally requires the probe evidence that makes
 * incompleteness deterministic (probeEvidenceIncomplete — no declared
 * deliverable changes AND failed P3/P4), so a complete-but-message-less
 * write run whose deliverables/probes are green is never falsely failed.
 *
 * `unavailable` (we could not even ask for the final message) is NOT
 * deterministic incomplete evidence — the final message may well exist —
 * and keeps today's classification.  Read-only plan/review phases keep
 * their recovered/empty result as a completed success.  Probe results that
 * never ran (no container) carry no deterministic evidence either.
 *
 * @param {object}    opts
 * @param {boolean}   opts.finishedUnknown — provider finished with reason "unknown".
 * @param {string|null} opts.phase         — job phase.
 * @param {string|null} opts.kind          — job kind ("task" | "review" | ...).
 * @param {object|null} opts.resultRecord  — job.result record from
 *                                            resolveCompletedResult.
 * @param {Array<object>|null|undefined} opts.probeResults — the probe
 *                                            results from the probe-truth layer.
 * @returns {boolean}
 */
export function classifyIncompleteCompletedRun({ finishedUnknown, phase, kind, resultRecord, probeResults }) {
  if (finishedUnknown !== true) return false;
  const source = resultRecord?.source;
  if (source !== "recovered" && source !== "none") return false;
  if (!phaseRequiresOutput(phase, kind)) return false;
  return probeEvidenceIncomplete({ probeResults });
}

/**
 * The error text recorded on a reclassified incomplete job (kusabi #496).
 * Names the deterministic evidence: the provider's own "unknown" finish and
 * the absent terminal final payload.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.phase] — job phase.
 * @param {string|null} [opts.kind]  — job kind.
 * @returns {string}
 */
export function incompleteRunError({ phase = null, kind = null } = {}) {
  const label = phase ? `phase ${phase}` : (kind ? `${kind} run` : "run");
  return `incomplete execution: provider reported finish "unknown" and no final message was produced — the recovered ${label} result is not a completed output`;
}

/**
 * Finalize a recovered/no-final run's classification at the probe-truth
 * layer (kusabi #496).
 *
 * runPrompt records only the deterministic STREAM signal on the job
 * (`job.noFinalEvidence`: provider finish "unknown" + no final payload);
 * the terminal non-success verdict additionally requires the
 * deliverable/probe evidence (no declared deliverable changes AND failed
 * P3/P4, see classifyIncompleteCompletedRun), which exists only after the
 * probes have run.  This function is therefore called by the layer that
 * owns probe truth (cmdTask after its container probe phase; chain
 * equivalents read the same helper) -- never by runPrompt, which would
 * guess the verdict before the evidence exists.
 *
 * A job without the stream signal, a read-only plan/review phase, a green
 * P3/P4, or probe results that never ran all keep their dispatch
 * classification: only the deterministic combination is closed as
 * `error`.  The recovered text stays on disk so `kusabi-companion result
 * <id>` still returns it.
 *
 * @param {object} opts
 * @param {object}   opts.job          — the durable job record (mutated in
 *                                      place when the verdict fires).
 * @param {Array<object>|null|undefined} opts.probeResults — probe results
 *                                      recorded at this layer.
 * @param {string|null} [opts.stateDir] — job state dir for the audit event.
 * @returns {boolean} true when the job was reclassified to `error`.
 */
export function finalizeIncompleteCompletedRun({ job, probeResults, stateDir }) {
  if (!job || job.status !== "completed") return false;
  const evidence = job.noFinalEvidence;
  if (!evidence || evidence.finishedUnknown !== true) return false;
  if (!classifyIncompleteCompletedRun({
    finishedUnknown: true,
    phase: job.phase,
    kind: job.kind,
    resultRecord: { source: evidence.source, recovered: evidence.recovered === true },
    probeResults,
  })) return false;
  job.status = "error";
  job.error = incompleteRunError({ phase: job.phase, kind: job.kind });
  // deriveStopReason maps any non-completed status outside the provider
  // set to the fail-closed `unknown` sentinel -- never "completed".
  job.stopReason = deriveStopReason({ status: job.status });
  if (stateDir && job.id) {
    appendEvent(stateDir, job.id, {
      type: "companion.result.incomplete",
      source: evidence.source,
      recovered: evidence.recovered === true,
      finishedUnknown: true,
      phase: job.phase,
    });
  }
  return true;
}

/**
 * Extract a structured provider status from a session.error payload, or null.
 *
 * Remote provider failures reach us as `session.error` events whose error
 * object is APIError-shaped: `{ name: "APIError", data: { statusCode, ... } }`.
 * A numeric `data.statusCode` in the provider-failure ranges (401, 403, 429,
 * 5xx) is provider-scoped evidence: the ROUTE could not do the work, which
 * says nothing about the next route in the same tier (different credentials,
 * different provider), so the caller may classify the job `provider-error`
 * and let dispatchWithFallback advance the walk.
 *
 * Everything else returns null — local caller errors, non-APIError shapes,
 * unparseable payloads, statuses outside the ranges — and the job keeps
 * today's `error` classification.  Absence of evidence is not provider
 * evidence; this deliberately fails closed toward current behavior.
 *
 * @param {unknown} error  — the session.error payload (`properties.error`).
 * @returns {{ statusCode: number, message: string }|null}
 */
export function providerStatusFromError(error) {
  if (!error || typeof error !== "object") return null;
  if (error.name !== "APIError") return null;
  const data = error.data;
  if (!data || typeof data !== "object") return null;
  const { statusCode } = data;
  if (typeof statusCode !== "number") return null;
  const isProviderStatus =
    statusCode === 401 || statusCode === 403 || statusCode === 429 ||
    (statusCode >= 500 && statusCode <= 599);
  if (!isProviderStatus) return null;
  return {
    statusCode,
    message: typeof data.message === "string" ? data.message : "",
  };
}

/**
 * Extract a catalog-miss status from a session.error payload, or null.
 *
 * An UnknownError session.error payload with data.message containing "Model not found"
 * indicates a catalog miss: the requested model is not registered or supported by
 * the provider. This is route-scoped and terminal for this model route.
 *
 * @param {unknown} error  — the session.error payload (`properties.error`).
 * @returns {{ reason: string, message: string, terminal: boolean }|null}
 */
export function catalogMissFromError(error) {
  if (!error || typeof error !== "object") return null;
  if (error.name !== "UnknownError") return null;
  const data = error.data;
  if (!data || typeof data !== "object") return null;
  if (typeof data.message !== "string") return null;
  if (!data.message.includes("Model not found")) return null;
  return {
    reason: "catalog-miss",
    message: data.message,
    terminal: true,
  };
}

// =========================================================================
// failed-route memo — process-scoped, survives rounds of one chain run
// =========================================================================

/** @type {Set<string>} */
export const failedRoutes = new Set();

/** Reset the failed-route set (for tests). */
export function resetFailedRoutes() {
  failedRoutes.clear();
}

// =========================================================================
// SSE helpers
// =========================================================================

async function* sseEvents(res) {
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trimEnd();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      try {
        yield JSON.parse(line.slice(5).trim());
      } catch {
        // partial or non-JSON frame; ignore
      }
    }
  }
}

async function openSse(server, signal) {
  const res = await fetch(`http://127.0.0.1:${server.port}/event`, {
    headers: { ...authHeader(server), accept: "text/event-stream" },
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`SSE connect failed: HTTP ${res.status}`);
  return sseEvents(res);
}

export function eventSession(event) {
  const p = event?.properties ?? {};
  return (
    p.sessionID ??
    p.info?.sessionID ??
    p.part?.sessionID ??
    p.permission?.sessionID ??
    p.request?.sessionID ??
    null
  );
}

export function permissionInfo(event) {
  const p = event?.properties ?? {};
  const perm = p.permission ?? p.request ?? p;
  return {
    id: perm.id ?? perm.requestID ?? p.id ?? null,
    label: String(perm.type ?? perm.action ?? perm.permission ?? perm.title ?? "unknown").toLowerCase(),
  };
}

export function decidePermission() {
  return "once";
}

/**
 * Accumulate token usage from an array of SSE events.
 *
 * @param {Array<object>} events  Raw event objects (as yielded by the SSE stream).
 * @returns {{ available: boolean, input?: number, output?: number, reasoning?: number,
 *             cacheRead?: number, cacheWrite?: number, cost?: number, model?: string }}
 *
 * Per-message usage (`message.updated`) is summed for per-job accuracy even when
 * a session is reused across jobs.  Falls back to session-level deltas when no
 * per-message data exists.
 */
export function accumulateUsage(events) {
  const messages = new Map(); // msg id → info (latest update per message)
  let firstSession = null;
  let lastSession = null;

  for (const event of events) {
    if (!event || !event.type) continue;
    const props = event.properties || {};

    if (event.type === "message.updated") {
      const info = props.info;
      if (info && info.id && info.tokens) {
        messages.set(info.id, info);
      }
    } else if (event.type === "session.updated") {
      const info = props.info;
      if (info && info.tokens) {
        if (!firstSession) firstSession = info;
        lastSession = info;
      }
    }
  }

  // No usage data observed at all.
  if (messages.size === 0 && !firstSession) {
    return { available: false };
  }

  // Prefer per-message aggregation (accurate per-job when session is reused).
  if (messages.size > 0) {
    let input = 0;
    let output = 0;
    let reasoning = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let cost = 0;
    let model = null;

    for (const info of messages.values()) {
      const t = info.tokens || {};
      input += t.input || 0;
      output += t.output || 0;
      reasoning += t.reasoning || 0;
      if (t.cache) {
        cacheRead += t.cache.read || 0;
        cacheWrite += t.cache.write || 0;
      }
      cost += info.cost || 0;
      if (!model && info.modelID && info.providerID) {
        model = `${info.providerID}/${info.modelID}`;
      }
    }

    return {
      available: true,
      input,
      output,
      reasoning,
      cacheRead,
      cacheWrite,
      cost,
      model,
    };
  }

  // Fallback: session-level delta (less accurate when session was reused).
  if (firstSession && lastSession && firstSession !== lastSession) {
    const firstT = firstSession.tokens || {};
    const lastT = lastSession.tokens || {};
    const input = (lastT.input || 0) - (firstT.input || 0);
    const output = (lastT.output || 0) - (firstT.output || 0);
    const reasoning = (lastT.reasoning || 0) - (firstT.reasoning || 0);
    let cacheRead = 0;
    let cacheWrite = 0;
    if (lastT.cache && firstT.cache) {
      cacheRead = (lastT.cache.read || 0) - (firstT.cache.read || 0);
      cacheWrite = (lastT.cache.write || 0) - (firstT.cache.write || 0);
    }
    const cost = (lastSession.cost || 0) - (firstSession.cost || 0);
    let model = null;
    if (lastSession.model) {
      model = `${lastSession.model.providerID}/${lastSession.model.id}`;
    }

    return {
      available: true,
      input,
      output,
      reasoning,
      cacheRead,
      cacheWrite,
      cost,
      model,
    };
  }

  // Single session.updated with no messages — cannot compute delta.
  return { available: false };
}

async function fetchFinalMessage(server, sessionID) {
  const messages = (await api(server, "GET", `/session/${sessionID}/message`)) ?? [];
  const assistant = [...messages].reverse().find((m) => (m.info?.role ?? m.role) === "assistant");
  if (!assistant) return "";
  const parts = assistant.parts ?? [];
  return parts
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/**
 * Ask the server for the final assistant message, reporting HOW it went.
 *
 * `fetchFinalMessage` collapses two very different outcomes into "": a
 * transport failure (our side broke — the answer may well exist on the
 * server) and a session that genuinely never produced a final assistant
 * message (nothing to fetch).  Only the first is a bug on our side, so the
 * caller is handed the distinction instead of an empty string.
 *
 * @returns {Promise<{ok: true, text: string}|{ok: false, error: string}>}
 */
async function fetchFinalMessageOutcome(server, sessionID) {
  try {
    return { ok: true, text: await fetchFinalMessage(server, sessionID) };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/**
 * Watchdog kill step: decide whether the stalled job's recorded serve may be
 * SIGKILLed, and carry out the kill or the decline.
 *
 * The recorded pid is only ever killed after isOurServe() confirms it is one
 * of our own serves (kusabi #181).  The watchdog is the most dangerous kill
 * site: it fires when the *recorded* port does not answer — which is more
 * likely precisely when the record is stale — and SIGKILL leaves the victim
 * no chance to log anything.  The record can outlive the serve by days, so
 * the pid may by then belong to a stranger (a recycled pid, or a TID of an
 * unrelated process).  When identity is refuted the kill is declined, an
 * event with the reason is recorded, and the stale record is removed; when
 * identity is merely unverifiable (hidepid, older marker set, /proc-less
 * platform) the kill is also declined but the record is kept — the pid may
 * well be our serve and the record is the only handle to it.  Either way the
 * stall handling is not silently lost: the session is still aborted by the
 * caller, only the kill is skipped.
 *
 * @returns {boolean} true when a process was actually killed
 */
export function watchdogKillOrDecline({ server, stateDir, job, abortOk, healthOk, serveDead }) {
  if (serveDead || (abortOk && healthOk)) return false;
  const identity = isOurServe(server.pid, { root: stateRoot(), stateDir });
  if (!identity.ours) {
    appendEvent(stateDir, job.id, {
      type: "companion.watchdog.declined-kill",
      pid: server.pid,
      class: identity.class,
      reason: identity.reason,
    });
    if (identity.class === "refuted") {
      // The record positively names a process that is not our serve: the
      // record is what is invalid — remove it, kill nothing.
      try { fs.unlinkSync(path.join(stateDir, "server.json")); } catch { /* best-effort */ }
    }
    // 'unverifiable': the pid may well be our serve but we cannot prove it
    // (hidepid, older marker set, /proc-less platform).  Keep the record —
    // deleting it would strand the process and the next dispatch's health
    // probe could no longer reuse it.  The stall handling above (abort +
    // event) proceeds either way.
    return false;
  }
  try { process.kill(server.pid, "SIGKILL"); } catch { /* best-effort */ }
  try { fs.unlinkSync(path.join(stateDir, "server.json")); } catch { /* best-effort */ }
  appendEvent(stateDir, job.id, { type: "companion.watchdog.kill" });
  return true;
}

/**
 * Core prompt-execution primitive.
 *
 * Creates an opencode session, dispatches a prompt via SSE, handles
 * permission auto-replies, and detects retry loops that trigger fail-fast.
 *
 * On fail-fast, the job status is set to "provider-error" and the session
 * is aborted promptly.
 *
 * @returns {Promise<{ job: object, resultText: string, stateDir: string }>}
 */
export async function runPrompt({ cwd, kind, title, promptText, agent, model, session, tools, format, timeoutS, watchdogS, phase }) {
  const server = await ensureServer(cwd);
  const { stateDir } = server;

  let sessionID = session;
  if (!sessionID) {
    const created = await api(server, "POST", "/session", { title });
    sessionID = created?.id ?? created?.info?.id;
    if (!sessionID) throw new Error("failed to create opencode session");
  }

  const job = {
    id: newJobId(),
    kind,
    title,
    status: "running",
    sessionID,
    cwd,
    phase: phase ?? null,
    modelEntry: model ? `${model.providerID}/${model.modelID}` + (model.variant ? `:${model.variant}` : "") : null,
    modelVariant: model?.variant || null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    stats: { events: 0, steps: 0, lastTool: null, permissionsAllowed: 0, permissionsRejected: 0, lastActivity: null, models: [] },
    error: null,
    retry: null,
    fallbacks: null,
  };
  saveJob(stateDir, job);
  fs.writeFileSync(path.join(jobDir(stateDir, job.id), "prompt.md"), promptText, "utf8");

  const progressWatch = startKaibaProgressWatch({ stateDir, jobId: job.id });

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), timeoutS * 1000);
  const replied = new Set();
  let sawIdle = false;
  // Provider-side terminal signal (kusabi #496): the session closed with
  // `finish: "unknown"` -- the provider could not say why the run ended.
  // Recorded on the job as `noFinalEvidence` when no final payload exists;
  // the terminal verdict is finalized at the probe-truth layer
  // (finalizeIncompleteCompletedRun), never guessed here.
  let finishedUnknown = false;
  let sessionError = null;
  let providerError = null;
  let watchdogFired = false;
  let watchdogKilled = false;
  let watchdogInterval = null;
  let livenessInterval = null;
  let serveDead = null; // { pid, port, since } | null

  // Liveness interval — always runs (even when watchdogS === 0).
  // Detects when the opencode serve process itself has disappeared so the
  // job can be finished immediately rather than waiting for the silence
  // threshold.
  livenessInterval = setInterval(() => {
    if (serveDead || job.status !== "running") return;

    const death = judgeServeDeath(server.pid);
    if (!death.dead) return;

    serveDead = {
      pid: server.pid,
      port: server.port,
      since: new Date().toISOString(),
    };
    clearInterval(livenessInterval);

    // Record the event in the job's audit trail.
    appendEvent(stateDir, job.id, {
      type: "companion.serve-dead",
      pid: server.pid,
      port: server.port,
      since: serveDead.since,
    });

    // Leave a trace in server.log.
    try {
      const line = `[${serveDead.since}] serve-dead: pid ${server.pid} port ${server.port} not found (liveness poll)\n`;
      fs.appendFileSync(path.join(stateDir, "server.log"), line, "utf8");
    } catch { /* best-effort */ }

    // Remove stale server.json so the next dispatch spawns a fresh serve.
    // Do NOT attempt to kill — the process is already gone.
    try { fs.unlinkSync(path.join(stateDir, "server.json")); } catch { /* best-effort */ }

    // Stop the watcher (no abort API call needed — serve is gone).
    abort.abort();
  }, 10000);

  if (watchdogS > 0) {
    watchdogInterval = setInterval(() => {
      if (watchdogFired) return;
      // The liveness poll already established that the serve is gone.  Silence
      // is then expected, not evidence of a stalled worker, and there is
      // nothing left to kill — claiming otherwise would put a kill that never
      // happened into the audit trail.
      if (serveDead) return;
      const lastActivity = job.stats.lastActivity ?? job.startedAt;
      const silenceMs = Date.now() - Date.parse(lastActivity);
      if (silenceMs > watchdogS * 1000) {
        watchdogFired = true;
        clearInterval(watchdogInterval);
        const silenceSec = Math.round(silenceMs / 1000);
        appendEvent(stateDir, job.id, { type: "companion.watchdog.fired", silenceS: silenceSec });
        (async () => {
          let abortOk = false;
          try {
            const r = await fetch(`http://127.0.0.1:${server.port}/session/${sessionID}/abort`, {
              method: "POST",
              headers: authHeader(server),
              signal: AbortSignal.timeout(2000),
            });
            abortOk = r.ok;
          } catch { /* abort attempt timed out or failed */ }
          let healthOk = false;
          try {
            const r = await fetch(`http://127.0.0.1:${server.port}/session`, {
              headers: authHeader(server),
              signal: AbortSignal.timeout(2000),
            });
            healthOk = r.ok;
          } catch { /* health check timed out or failed */ }
          // Re-checked here as well as at the top of the tick: the liveness
          // poll can land while these two probes are in flight.
          if (!serveDead && (!abortOk || !healthOk)) {
            if (watchdogKillOrDecline({ server, stateDir, job, abortOk, healthOk, serveDead })) {
              watchdogKilled = true;
            }
          }
          abort.abort();
        })();
      }
    }, 10000);
  }

  // Collect usage-related events for accumulateUsage.
  const usageEvents = [];

  // Connect SSE before sending the prompt so a fast-finishing session's
  // `session.idle` cannot slip past between POST and subscription.
  let markConnected;
  const sseConnected = new Promise((resolve) => {
    markConnected = resolve;
  });

  const watcher = (async () => {
    let backoff = 250;
    while (!abort.signal.aborted && !sawIdle && !sessionError && !providerError) {
      try {
        const stream = await openSse(server, abort.signal);
        markConnected();
        backoff = 250;
        for await (const event of stream) {
          // Strict session match: events without a recognizable sessionID are
          // dropped so a stray server-level idle/error can't end this job.
          if (eventSession(event) !== sessionID) continue;
          job.stats.events += 1;
          job.stats.lastActivity = new Date().toISOString();
          const type = String(event?.type ?? "");
          appendEvent(stateDir, job.id, event);

          // Harvest usage-relevant events for post-job accumulation.
          if (type === "message.updated" || type === "session.updated") {
            usageEvents.push(event);
          }

          // ---- fail-fast: detect provider retry loops ----
          if (type === "session.status") {
            const status = event?.properties?.status;
            if (status?.type === "retry") {
              const reason = status?.action?.reason || null;
              const message = status?.message || "";
              const attempt = status?.attempt || 0;

              job.stats.retryCount = (job.stats.retryCount || 0) + 1;
              job.retry = {
                reason,
                message,
                attempt,
                count: job.stats.retryCount,
              };

              const ff = shouldFailFast({ reason, attempt, steps: job.stats.steps, retryCount: job.stats.retryCount });
              if (ff.stop) {
                providerError = {
                  reason,
                  message,
                  attempt,
                  count: job.stats.retryCount,
                  terminal: ff.terminal,
                };
                // Abort the session promptly.
                await api(server, "POST", `/session/${sessionID}/abort`).catch(() => {});
                appendEvent(stateDir, job.id, {
                  type: "companion.provider-error",
                  reason,
                  attempt,
                  message,
                  terminal: ff.terminal,
                });
                break;
              }
            } else if (finishedUnknownSignal(event)) {
              // kusabi #496: the provider's own terminal signal.  A session
              // that finished with `finish: "unknown"` (measured incident:
              // connection reset mid-run, one retry, then unknown finish
              // followed by idle) is recorded as the stream signal; the
              // terminal verdict is finalized at the probe-truth layer.
              finishedUnknown = true;
            }
          }

          if (type.startsWith("permission.") && type.endsWith("asked")) {
            const { id, label } = permissionInfo(event);
            if (id && !replied.has(id)) {
              replied.add(id);
              const reply = decidePermission();
              try {
                await api(server, "POST", `/permission/${id}/reply`, { reply });
                appendEvent(stateDir, job.id, { type: "companion.permission.reply", permission: label, reply });
                if (reply === "reject") job.stats.permissionsRejected += 1;
                else job.stats.permissionsAllowed += 1;
              } catch (err) {
                // Un-mark so a re-broadcast of the same ask can be retried.
                replied.delete(id);
                appendEvent(stateDir, job.id, {
                  type: "companion.permission.reply-failed",
                  permission: label,
                  reply,
                  error: String(err),
                });
              }
            }
          } else if (type === "message.part.updated") {
            const part = event?.properties?.part;
            if (part?.type === "tool" && part?.tool) {
              job.stats.lastTool = part.tool;
            } else if (part?.type === "step-start") {
              job.stats.steps += 1;
            }
          } else if (type === "message.updated") {
            const info = event?.properties?.info;
            if (info?.role === "assistant" && info?.providerID && info?.modelID) {
              const m = `${info.providerID}/${info.modelID}`;
              if (!job.stats.models.includes(m)) job.stats.models.push(m);
            }
          } else if (type === "session.idle") {
            sawIdle = true;
          } else if (type === "session.error") {
            const rawError = event?.properties?.error ?? event?.properties ?? null;
            const providerStatus = providerStatusFromError(rawError);
            const catalogMiss = catalogMissFromError(rawError);
            if (providerStatus) {
              // A remote provider failure with a structured status is
              // route-scoped: this route cannot do the work, which says
              // nothing about the next route in the same tier.  Classify
              // provider-error so dispatchWithFallback advances the walk —
              // without a same-route retry (the provider's isRetryable
              // verdict is respected) and without poisoning the route for
              // later dispatches (terminal: false).
              providerError = {
                reason: `http-${providerStatus.statusCode}`,
                message: providerStatus.message,
                attempt: 0,
                count: 0,
                terminal: false,
              };
              appendEvent(stateDir, job.id, {
                type: "companion.provider-error",
                reason: providerError.reason,
                attempt: 0,
                message: providerStatus.message,
                terminal: false,
              });
            } else if (catalogMiss) {
              // A catalog miss session.error (UnknownError with "Model not found")
              // is route-scoped and terminal: the missing model will not reappear
              // in this process, so classify provider-error with terminal: true
              // to poison the route and let dispatchWithFallback try the next route.
              providerError = {
                reason: catalogMiss.reason,
                message: catalogMiss.message,
                attempt: 0,
                count: 0,
                terminal: catalogMiss.terminal,
              };
              appendEvent(stateDir, job.id, {
                type: "companion.provider-error",
                reason: providerError.reason,
                attempt: 0,
                message: catalogMiss.message,
                terminal: catalogMiss.terminal,
              });
            } else {
              sessionError = JSON.stringify(rawError ?? {}).slice(0, 500);
            }
          }
          saveJob(stateDir, job);
          if (sawIdle || sessionError || providerError) break;
        }
      } catch (err) {
        if (abort.signal.aborted) break;
        appendEvent(stateDir, job.id, { type: "companion.sse.reconnect", error: String(err), backoff });
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 10_000);
      }
    }
  })();

  try {
    await Promise.race([sseConnected, new Promise((r) => setTimeout(r, 5000))]);
    await api(server, "POST", `/session/${sessionID}/prompt_async`, {
      parts: [{ type: "text", text: promptText }],
      ...(agent ? { agent } : {}),
      ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
      ...(model?.variant ? { variant: model.variant } : {}),
      ...(tools ? { tools } : {}),
      ...(format ? { format } : {}),
    });
    await watcher;
  } finally {
    progressWatch.stop();
    clearTimeout(timeout);
    clearInterval(livenessInterval);
    clearInterval(watchdogInterval);
    abort.abort();
  }

  // ---- determine final status ----
  const outcome = classifyJobOutcome({
    serveDead,
    providerError,
    watchdogFired,
    watchdogKilled,
    watchdogS,
    sawIdle,
    sessionError,
    timeoutS,
  });
  job.status = outcome.status;
  job.error = outcome.error;

  // Record the closed terminal reason (kusabi #380).  The caller classifies
  // capacity: a terminal provider error whose reason is a known capacity
  // reason is a quota exhaustion, not a generic provider error.  The chain
  // layer re-derives the per-round reason with the substance signal; here at
  // the job level worktreeChanged is unmeasured (null) so a completed job
  // records "completed".
  const capacityReason =
    (providerError && providerError.terminal && capacityReasons.includes(providerError.reason))
      ? providerError.reason
      : null;
  job.stopReason = deriveStopReason({
    capacityReason,
    providerError,
    status: job.status,
    stats: job.stats,
  });

  if (outcome.status === "provider-error") {
    job.retry = providerError;
  } else if (outcome.status === "timeout") {
    await api(server, "POST", `/session/${sessionID}/abort`).catch(() => {});
  }
  job.finishedAt = new Date().toISOString();

  // ---- accumulate and persist usage ----
  const usage = {
    ...accumulateUsage(usageEvents),
    phase: job.phase || null,
    durationSeconds: durationS(job),
  };
  job.usage = usage;
  writeJson(path.join(jobDir(stateDir, job.id), "usage.json"), usage);

  let resultText = "";
  if (job.status === "completed") {
    // A session can go idle with the model still mid-analysis: it never emits
    // a final assistant message, so there is nothing for fetchFinalMessage to
    // return — while the whole output sits in the events we just recorded.
    // Recover from those (deterministically, no LLM, no extra request) rather
    // than write an empty result.md.  The record also keeps "could not ask"
    // apart from "there was nothing to ask for" (result-recovery.mjs).
    const fetched = await fetchFinalMessageOutcome(server, sessionID);
    const dir = jobDir(stateDir, job.id);
    const resolved = resolveCompletedResult({
      backend: "opencode",
      fetched,
      coords: { eventsPath: path.join(dir, "events.ndjson") },
    });
    resultText = resolved.text;
    job.result = resolved.record;
    if (resolved.record.recovered) {
      appendEvent(stateDir, job.id, {
        type: "companion.result.recovered",
        source: resolved.record.recovery.source,
        chars: resolved.record.recovery.chars,
        fetchFailed: resolved.record.fetchFailed,
        fetchError: resolved.record.fetchError,
      });
    }
    fs.writeFileSync(path.join(dir, "result.md"), resultText, "utf8");

    // kusabi #496: a provider stream that ended `finish: "unknown"` and then
    // went idle, with NO terminal final payload -- only a recovered
    // event/reasoning reconstruction -- carries the deterministic STREAM
    // signal of a run cut off mid-flight (measured incident job-mtyfpjlc8452:
    // finish unknown, recovered reasoning-only text, zero deliverable
    // changes, failed P3/P4 -- stored and notified as completed success).
    // The signal alone is NOT the terminal verdict: the phase contract and
    // the deliverable/probe evidence (no declared deliverable changes +
    // failed P3/P4) decide it, and that evidence exists only at the
    // probe-truth layer (cmdTask / the chain's probe phase).  runPrompt
    // therefore only records the evidence on the job -- finalizeIncomplete
    // CompletedRun closes the record there, and a complete-but-message-less
    // write run whose deliverables/probes are green is never falsely
    // failed.  The recovered text stays on disk so `kusabi-companion
    // result <id>` still returns it.
    if (finishedUnknown && phaseRequiresOutput(job.phase, job.kind)) {
      const source = resolved.record.source;
      if (source === "recovered" || source === "none") {
        job.noFinalEvidence = {
          finishedUnknown: true,
          source,
          recovered: resolved.record.recovered === true,
          phase: job.phase,
        };
        appendEvent(stateDir, job.id, {
          type: "companion.result.no-final",
          source,
          recovered: resolved.record.recovered === true,
          finishedUnknown: true,
          phase: job.phase,
        });
      }
    }
  }
  saveJob(stateDir, job);
  return { job, resultText, stateDir };
}

// =========================================================================
// dispatchWithFallback — single wrapper above runPrompt, below callers
// =========================================================================

/**
 * Dispatch a prompt with automatic capacity fallback over the tiered chain.
 *
 * Calls `runPrompt` (or the injected `_runPrompt`) for the first available
 * route.  On `provider-error`, records the failure and immediately re-dispatches
 * on the next unused route of the same tier (then later tiers).  Routes that
 * fail with a terminal capacity reason are remembered in the process-scoped
 * `failedRoutes` set.
 *
 * Callers must NOT re-implement the fallback walk — every dispatch site
 * calls this wrapper.
 *
 * @param {object}              opts
 * @param {(string|string[])[]} opts.tiers         — Tiered chain entries.
 * @param {number}              opts.round         — 1-based round number.
 * @param {string|null}         [opts.explicitModel] — --model flag value.
 * @param {Function}            [opts._runPrompt]  — Injection seam for tests;
 *                                                   defaults to `runPrompt`.
 * @param {...*}                opts               — All other `runPrompt` options.
 * @returns {Promise<{ job: object, resultText: string, stateDir: string }>}
 */
export async function dispatchWithFallback(opts) {
  const {
    tiers,
    round,
    tierIndex,
    explicitModel,
    explicitRestrictions = false,
    _runPrompt,
    _agyDispatch,
    _claudeDispatch,
    _cursorDispatch,
    _backendDispatch,
    ...runPromptOpts
  } = opts;
  const routeCandidates = selectRoutes({ tiers, round, tierIndex, explicitModel, failedRoutes });
  const skippedRestrictedRoutes = [];
  const candidates = routeCandidates.filter((candidate) => {
    const { backend: candidateBackend } = splitRouteBackend(candidate);
    if (explicitRestrictions && (candidateBackend === "agy" || candidateBackend === "cursor")) {
      skippedRestrictedRoutes.push({
        route: candidate,
        reason: `explicit tool restriction cannot be applied on the ${candidateBackend} backend; candidate skipped`,
      });
      return false;
    }
    return true;
  });

  if (candidates.length === 0) {
    const errorMsg = skippedRestrictedRoutes.length > 0
      ? `No compatible routes: ${skippedRestrictedRoutes.map((entry) => `${entry.route} — ${entry.reason}`).join("; ")}`
      : explicitModel && failedRoutes.has(explicitModel)
        ? `Pinned model "${explicitModel}" has already failed terminally in this process.`
        : "No available routes: all routes have failed or the chain is empty.";
    const errorJob = {
      id: "no-route-" + Date.now(),
      kind: runPromptOpts.kind || "task",
      status: "provider-error",
      error: errorMsg,
      // Closed terminal reason (kusabi #380): a no-route / all-routes-dead
      // synthetic job is a provider-side failure, never a worker success.
      stopReason: deriveStopReason({ status: "provider-error" }),
      fallbacks: [],
      retry: null,
      modelEntry: explicitModel || null,
      modelVariant: null,
      usage: null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      stats: {},
    };
    return { job: errorJob, resultText: "", stateDir: null };
  }

  let lastJob = null;
  let lastResultText = "";
  let lastStateDir = null;
  /** @type {{ from: string, to: string|null, reason: string|null, attempt: number, message: string|null }[]} */
  const fallbacks = [];
  /** @type {{ job: object, resultText: string, stateDir: string|null }[]} */
  const attempts = [];

  let currentSession = runPromptOpts.session;
  let currentSessionProvenance = runPromptOpts.sessionProvenance;
  let lastAttemptBackend = null;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const { route: modelStr, backend: candidateBackend } = splitRouteBackend(candidate);

    // Cross-backend session guard: when switching backends during the fallback walk,
    // drop session and dispatch fresh on the new backend (kusabi #470).
    if (lastAttemptBackend !== null && candidateBackend !== lastAttemptBackend) {
      currentSession = undefined;
      currentSessionProvenance = undefined;
    } else if (currentSession) {
      if (currentSession.startsWith("ses_") && candidateBackend !== "opencode") {
        currentSession = undefined;
        currentSessionProvenance = undefined;
      } else if (currentSessionProvenance && currentSessionProvenance !== candidateBackend) {
        currentSession = undefined;
        currentSessionProvenance = undefined;
      }
    }

    let model = null;
    let result;

    if (candidateBackend === "opencode") {
      model = parseModel(candidate);
      const doPrompt = _backendDispatch ? _backendDispatch("opencode") : (_runPrompt || runPrompt);
      result = await doPrompt({
        ...runPromptOpts,
        session: currentSession,
        sessionProvenance: currentSessionProvenance,
        model,
      });
    } else if (candidateBackend === "agy") {
      const doAgy = _backendDispatch ? _backendDispatch("agy") : (_agyDispatch || agyDispatch);
      result = await doAgy({
        ...runPromptOpts,
        session: currentSession,
        sessionProvenance: currentSessionProvenance,
        explicitModel: modelStr,
        model: modelStr,
        tiers: [[modelStr]],
      });
    } else if (candidateBackend === "claude") {
      const doClaude = _backendDispatch ? _backendDispatch("claude") : (_claudeDispatch || (await getClaudeDispatch()));
      result = await doClaude({
        ...runPromptOpts,
        ...(explicitRestrictions ? { tools: await translateDenyToolsForFallback(runPromptOpts.tools) } : {}),
        session: currentSession,
        sessionProvenance: currentSessionProvenance,
        explicitModel: modelStr,
        model: modelStr,
        tiers: [[modelStr]],
      });
    } else if (candidateBackend === "cursor") {
      const doCursor = _backendDispatch ? _backendDispatch("cursor") : (_cursorDispatch || cursorDispatch);
      result = await doCursor({
        ...runPromptOpts,
        session: currentSession,
        sessionProvenance: currentSessionProvenance,
        explicitModel: modelStr,
        model: modelStr,
        tiers: [[modelStr]],
      });
    } else {
      const doPrompt = _backendDispatch ? _backendDispatch(candidateBackend) : (_runPrompt || runPrompt);
      result = await doPrompt({
        ...runPromptOpts,
        session: currentSession,
        sessionProvenance: currentSessionProvenance,
      });
    }

    lastAttemptBackend = candidateBackend;
    lastJob = result.job;
    lastResultText = result.resultText;
    lastStateDir = result.stateDir;

    // Record the route that was actually used (overwrites what runPrompt set).
    lastJob.modelEntry = candidate;
    lastJob.modelVariant = candidateBackend === "opencode" ? (model?.variant || null) : null;
    lastJob.backend = lastJob.backend || candidateBackend;

    if (lastJob.status === "provider-error") {
      const nextCandidate = i + 1 < candidates.length ? candidates[i + 1] : null;
      const fb = {
        from: candidate,
        to: nextCandidate,
        reason: lastJob.retry?.reason || null,
        attempt: lastJob.retry?.attempt || 0,
        message: lastJob.retry?.message || null,
      };
      fallbacks.push(fb);
      attempts.push({ job: lastJob, resultText: lastResultText, stateDir: lastStateDir });

      // Remember the dead route for future dispatches (process scope).
      // Only terminal failures (capacity/quota permanently exhausted) are
      // remembered across dispatches.  A transient blip (HTTP 500, non-terminal)
      // still falls back within the current dispatch but is not poisoned for
      // later rounds.
      if (lastJob.retry?.terminal) {
        failedRoutes.add(candidate);
      }

      // Append a fallback event to the job log.
      if (lastStateDir) {
        appendEvent(lastStateDir, lastJob.id, {
          type: "companion.fallback",
          ...fb,
        });
      }

      continue;
    }

    // Success or non-provider-error failure (timeout, stalled, error).
    // Carry fallback trail on the job so renderers can show it.
    if (fallbacks.length > 0) {
      lastJob.fallbacks = fallbacks;
    }
    return result;
  }

  // ---- all routes exhausted ----
  // When every route is provider-error, select the substantial attempt that
  // spent tokens (or steps) so an earlier substantial run is not masked by a
  // later 0/0 quota retry (kusabi #412).
  let bestAttempt = attempts[0];
  let bestTokens = attemptTokens(bestAttempt?.job);
  let bestSteps = attemptSteps(bestAttempt?.job);

  for (let i = 1; i < attempts.length; i++) {
    const att = attempts[i];
    const tokens = attemptTokens(att.job);
    const steps = attemptSteps(att.job);
    if (tokens > bestTokens || (tokens === bestTokens && steps > bestSteps)) {
      bestAttempt = att;
      bestTokens = tokens;
      bestSteps = steps;
    }
  }

  const primaryJob = bestAttempt ? bestAttempt.job : lastJob;
  const primaryResultText = bestAttempt ? bestAttempt.resultText : lastResultText;
  const primaryStateDir = bestAttempt ? bestAttempt.stateDir : lastStateDir;

  const exhaustedFallbacks = fallbacks.map(function (fb, idx) {
    return {
      ...fb,
      jobId: attempts[idx]?.job?.id || null,
      usage: attempts[idx]?.job?.usage || null,
    };
  });

  primaryJob.fallbacks = exhaustedFallbacks;
  primaryJob.status = "provider-error";
  primaryJob.error = renderAllExhaustedError({
    candidates: routeCandidates,
    fallbacks: exhaustedFallbacks,
    skippedRestrictedRoutes,
  });
  // Closed terminal reason (kusabi #380): every route dead is a provider-side
  // failure regardless of how the last route happened to die.
  primaryJob.stopReason = deriveStopReason({ status: "provider-error" });
  if (primaryStateDir) saveJob(primaryStateDir, primaryJob);
  return { job: primaryJob, resultText: primaryResultText, stateDir: primaryStateDir };
}

/**
 * Compute total input + output tokens from a job's usage object.
 *
 * @param {object|null|undefined} job
 * @returns {number}
 */
function attemptTokens(job) {
  const u = job?.usage;
  if (!u) return 0;
  return (u.input || 0) + (u.output || 0);
}

/**
 * Extract step count from a job's stats object.
 *
 * @param {object|null|undefined} job
 * @returns {number}
 */
function attemptSteps(job) {
  return (job?.stats && typeof job.stats.steps === "number") ? job.stats.steps : 0;
}

/**
 * Render a structured error message when all routes have been exhausted.
 *
 * @param {object}   opts
 * @param {string[]} opts.candidates
 * @param {{ from: string, reason: string|null, attempt: number, message: string|null }[]} opts.fallbacks
 * @param {{ route: string, reason: string }[]} [opts.skippedRestrictedRoutes]
 * @returns {string}
 */
function renderAllExhaustedError({ candidates, fallbacks, skippedRestrictedRoutes = [] }) {
  const parts = ["All routes exhausted:"];
  for (const c of candidates) {
    const fb = fallbacks.find(function (f) { return f.from === c; });
    const skipped = skippedRestrictedRoutes.find(function (entry) { return entry.route === c; });
    if (fb) {
      parts.push(`  ${c} — ${fb.reason || "retry"} at attempt ${fb.attempt}${fb.message ? ": " + fb.message : ""}`);
    } else if (skipped) {
      parts.push(`  ${c} — ${skipped.reason}`);
    } else {
      parts.push(`  ${c} — (not attempted)`);
    }
  }
  return parts.join("\n");
}
