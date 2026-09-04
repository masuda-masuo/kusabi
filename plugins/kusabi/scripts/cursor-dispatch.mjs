// cursor-dispatch.mjs — Cursor CLI backend for kusabi job dispatch (kusabi #374).
//
// Backend contract: a function with the SAME call/return shape as
// `dispatchWithFallback` (prompt-execution.mjs) and `claudeDispatch` /
// `agyDispatch`: it receives the dispatch options object (cwd, kind, title,
// promptText, agent, phase, session, tools, timeoutS, watchdogS, tiers,
// round, tierIndex, explicitModel) and resolves to
// `{ job, resultText, stateDir }`.  kusabi-companion.mjs picks this function
// per phase; the chain phases stay backend-blind.
//
// WHY a fourth backend: on 2026-08-23 the opencode free tier and the agy
// quota both ran out within an hour of each other while Cursor stayed
// available.  Cursor CLI was already used by hand for implement and review
// seats, but without an adapter those jobs sat outside the chain (no
// probes, no review seat, no chain-wait).
//
// ---------------------------------------------------------------------------
// The CLI contract (field-verified by a hand run, 2026-08-23 — MEASURED.
// Do not re-derive, do not doubt.)
// ---------------------------------------------------------------------------
//
//   cursor-agent -p --approve-mcps --force --output-format stream-json
//         [--resume <sessionId>] [--model <id>]
//
// Prompt on **stdin** (not argv).  This backend has no argv-size problem.
//
// stdout is NDJSON, one object per line, discriminated by `type` (the
// claude vocabulary, NOT agy's `event`).  Observed kinds:
//
//   {"type":"thinking","subtype":"delta"|"completed", ...}
//   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
//   {"type":"tool_call","subtype":"started"|"completed","call_id":"call-…",
//     "tool_call":{…}}  MEASURED 2026-08-23 from 318 real lines (156 started /
//     162 completed).  `call_id` is on EVERY line; distinct ids = 162 =
//     completed count.  job.stats.steps is that distinct count.  The inner
//     key is `mcpToolCall` (290; name = args.name, e.g. "kaiba-agenda"),
//     `getMcpToolsToolCall` (14; stem "getMcpTools"), or `readToolCall`
//     (14; stem "read") — never report "mcp" for mcpToolCall.
//   {"type":"system"} (subtype init), {"type":"user"},
//   {"type":"connection","subtype":"reconnecting"|"reconnected"},
//   {"type":"retry","subtype":"starting"|"resuming"}
//   {"type":"result","subtype":"success","is_error":false,"result":"ALPHA-7",
//     "session_id":"92f5e07b-…","usage":{"inputTokens":10543,"outputTokens":34,
//     "cacheReadTokens":5376,"cacheWriteTokens":0}}
//
// Every line carries `session_id`; it is the id `--resume` takes.
// Resume works and carries context (MEASURED: a fresh call answered
// ALPHA-7; a second call with `--resume <session_id>` asked "what token
// did you just say" and answered ALPHA-7 again, with inputTokens 143
// instead of 10,543 — the transcript lived on the server, not re-sent).
//
// **The `--model` residue trap (MEASURED).**  Passing `--model` writes the
// choice into `~/.cursor/cli-config.json` and changes every later invocation
// on that machine, including interactive ones.  Therefore this adapter NEVER
// passes `--model` unless the model was explicitly pinned.  The default chain
// entry is the literal `default`, meaning "whatever the CLI is configured to
// use".  This module never writes any file under `~/.cursor/` itself.
//
// **`is_error` is NOT authoritative in either direction.**  Success is
// decided by PAYLOAD PRESENCE — a non-empty `result` string on the terminal
// line.  `is_error` is recorded as advisory metadata (`job.cursorIsError`).
//
// ---------------------------------------------------------------------------
// Assumptions this module makes and does NOT claim to have measured
// ---------------------------------------------------------------------------
//   - Process-group kill / timeout / silence-watchdog: copied from the agy
//     adapter's spawn path.  Not re-measured against cursor-agent.
//   - Role body is prepended to the stdin prompt (agy pattern).  Cursor CLI
//     has no `--append-system-prompt` in the measured argv list.
//   - No `--json-schema` / inner print-timeout flag (not in the measured
//     invocation).
//   - `ses_*` ids are refused on shape (opencode).  A bare UUID is passed
//     through as `--resume`; companion-level provenance is the caller's job.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { firstRoute } from "./cli.mjs";
import { readAgentSystemPrompt } from "./claude-dispatch.mjs";
import { newJobId, saveJob, jobDir, appendEvent } from "./job-store.mjs";
import { stateDirFor, writeJson } from "./state-paths.mjs";
import { durationS } from "./render.mjs";
import { resolveCompletedResult } from "./result-recovery.mjs";
import { deriveStopReason } from "./stop-reason.mjs";
import { startKaibaProgressWatch } from "./kaiba-progress-watch.mjs";
import { isUsableTimeoutS, runBackendProcess } from "./backend-process-runner.mjs";

export const CURSOR_BACKEND = "cursor";

// ONE tier on purpose: this backend walks no ladder.  The literal `default`
// means "whatever cursor-agent is already configured to use" — it is
// recorded as the model so the job record stays honest, and it is NOT
// passed as `--model` (see the residue trap above).
export const CURSOR_DEFAULT_CHAIN = [["default"]];
export const DEFAULT_CURSOR_MODEL = "default";

// Tests point CURSOR_BIN at a fake script.  The real binary is a host
// install (`cursor-agent`) that exists in neither CI nor the sunaba
// container; no test may ever require it.
export function cursorBin() {
  return process.env.CURSOR_BIN || "cursor-agent";
}

// =========================================================================
// model syntax — pure
// =========================================================================

/**
 * Validate a model entry for the cursor backend.
 *
 * Accepted: any non-empty id, plus the literal `default`.  A `:variant`
 * suffix is rejected with an explicit error — it must never be silently
 * ignored (mirrors validateAgyModel).
 *
 * @param {string|null|undefined} value
 * @returns {string|null}
 * @throws {Error} When the entry carries a `:variant` suffix.
 */
export function validateCursorModel(value) {
  if (value === undefined || value === null || value === "") return null;
  const v = String(value);
  if (v.indexOf(":") >= 0) {
    throw new Error(
      `cursor backend does not support the :variant suffix in model "${v}" — ` +
      "use a plain cursor model id or the literal default"
    );
  }
  return v;
}

/**
 * Validate EVERY route of a (tiered) chain for the cursor backend.
 *
 * @param {(string|string[])[]} chain
 * @returns {(string|string[])[]}
 * @throws {Error} Naming the offending entry.
 */
export function validateCursorChain(chain) {
  for (const tier of Array.isArray(chain) ? chain : []) {
    const routes = Array.isArray(tier) ? tier : [tier];
    for (const route of routes) {
      try {
        validateCursorModel(route);
      } catch (err) {
        throw new Error(
          `cursor backend: chain entry "${route}" is not a cursor model — ` +
          "configure models.chain with plain cursor model ids or the literal default: " +
          err.message
        );
      }
    }
  }
  return chain;
}

/**
 * Resolve the model for the cursor backend, mirroring resolveAgyModel.
 *
 * @param {object} opts
 * @param {string} [opts.flag]
 * @param {string} [opts.phase]
 * @param {object} [opts.config]
 * @returns {{ model: string|undefined, chain: (string|string[])[] }}
 */
export function resolveCursorModel({ flag, phase, config } = {}) {
  let chain;
  if (config?.models?.chain) {
    chain = [...config.models.chain];
  } else {
    chain = [...CURSOR_DEFAULT_CHAIN];
  }

  if (flag) {
    return { model: flag, chain };
  }

  if (phase && config?.models?.phases?.[phase]) {
    const phaseChain = config.models.phases[phase];
    const first = firstRoute(phaseChain);
    if (first) {
      return { model: first, chain: phaseChain };
    }
  }

  const firstGlobal = firstRoute(chain);
  if (firstGlobal) {
    return { model: firstGlobal, chain };
  }

  return { model: undefined, chain };
}

// =========================================================================
// argv + prompt construction — pure
// =========================================================================

/**
 * Compose the prompt text handed to cursor-agent on stdin.
 * Cursor has no `--append-system-prompt` in the measured argv list, so the
 * agent's role body is prepended inside a `<role>` block.
 *
 * @param {object} opts
 * @param {string|null} [opts.systemPrompt]
 * @param {string} [opts.promptText]
 * @returns {string}
 */
export function buildCursorPrompt({ systemPrompt, promptText }) {
  const body = promptText ?? "";
  if (!systemPrompt) return body;
  return `<role>\n${systemPrompt}\n</role>\n\n${body}`;
}

/**
 * True when `--model` must be passed: the resolved model is a real id, not
 * the literal `default` (or absent).  A non-default resolved model is a pin,
 * whether it arrived via `--model cursor/<id>` or a config chain entry.
 *
 * @param {string|null|undefined} model
 * @returns {boolean}
 */
export function cursorModelIsPinned(model) {
  return typeof model === "string" && model !== "" && model !== DEFAULT_CURSOR_MODEL;
}

/**
 * Build the argv for a `cursor-agent -p` dispatch.
 *
 * MEASURED contract (2026-08-23):
 * `cursor-agent -p --approve-mcps --force --output-format stream-json
 * [--resume <sessionId>] [--model <id>]` — and NOTHING else.  The prompt is
 * NOT on argv.
 *
 * @param {object} opts
 * @param {string} [opts.model]
 * @param {boolean} [opts.pinned]
 * @param {string|null|undefined} [opts.sessionId]
 * @returns {string[]}
 */
export function buildCursorArgs({ model, pinned, sessionId } = {}) {
  const args = [
    "-p",
    "--approve-mcps",
    "--force",
    "--output-format",
    "stream-json",
  ];
  if (pinned) {
    args.push("--model", model);
  }
  if (typeof sessionId === "string" && sessionId !== "") {
    args.push("--resume", sessionId);
  }
  return args;
}

// =========================================================================
// stream parsing — pure
// =========================================================================

/**
 * Parse one line of the cursor NDJSON stream.  Returns null for blank lines
 * and non-JSON prose.  Discriminated by `type` (claude vocabulary).
 *
 * @param {string} line
 * @returns {object|null}
 */
export function parseCursorStreamLine(line) {
  const trimmed = typeof line === "string" ? line.trim() : "";
  if (!trimmed) return null;
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
  return obj;
}

/**
 * Extract assistant text from a `type:"assistant"` event.
 * MEASURED shape: message.content[] of `{type:"text", text}`.
 *
 * @param {object} evt
 * @returns {string}
 */
export function assistantTextFromEvent(evt) {
  const content = evt?.message?.content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (part && part.type === "text" && typeof part.text === "string") {
      out += part.text;
    }
  }
  return out;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function nameFromToolCallKey(key) {
  if (typeof key !== "string" || !key.endsWith("ToolCall") || key.length <= 8) return null;
  const base = key.slice(0, -8);
  return base.charAt(0).toLowerCase() + base.slice(1);
}

/**
 * Pull a tool name off a `type:"tool_call"` event.
 *
 * MEASURED 2026-08-23 from 318 real tool_call lines (one 33-minute run):
 *   mcpToolCall        290  — the tool name is `tool_call.mcpToolCall.args.name`
 *                             (e.g. "kaiba-agenda"), NOT the key stem "mcp".
 *   getMcpToolsToolCall 14  — stem with first letter lowercased: "getMcpTools".
 *   readToolCall        14  — stem: "read".
 *
 * `mcpToolCall` is special-cased first so we never report "mcp" for the
 * dominant case.  Unrecognisable shapes return null and must not throw.
 *
 * @param {object} evt
 * @returns {string|null}
 */
export function cursorToolNameFromEvent(evt) {
  try {
    if (!evt || typeof evt !== "object") return null;
    const tc = evt.tool_call;
    if (tc && typeof tc === "object" && !Array.isArray(tc)) {
      if ("mcpToolCall" in tc) {
        return nonEmptyString(tc.mcpToolCall?.args?.name);
      }
      for (const key of Object.keys(tc)) {
        const stem = nameFromToolCallKey(key);
        if (stem) return stem;
      }
      for (const key of ["name", "tool", "tool_name", "toolName"]) {
        const n = nonEmptyString(tc[key]);
        if (n) return n;
      }
    }
    for (const key of ["name", "tool", "tool_name", "toolName"]) {
      const n = nonEmptyString(evt[key]);
      if (n) return n;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Fresh accumulator for folding a cursor NDJSON stream into job.stats.
 * Same public fields the agy accumulator writes (`events`, `steps`,
 * `lastTool`, `lastActivity`, `models`) so readers stay backend-blind.
 * `callIds` is internal: MEASURED 2026-08-23, every tool_call line carries
 * a top-level `call_id`, and distinct ids equal the completed count (162).
 *
 * @returns {{ events: number, steps: number, lastTool: string|null,
 *             lastActivity: string|null, models: string[], callIds: Set<string> }}
 */
export function initCursorStreamAccumulator() {
  return {
    events: 0,
    steps: 0,
    lastTool: null,
    lastActivity: null,
    models: [],
    callIds: new Set(),
  };
}

/**
 * Fold one parsed stream event into the accumulator (mutates and returns
 * it).  `connection` / `retry` / unknown kinds bump `events` and
 * `lastActivity` and nothing else — they must not throw.
 *
 * A `type:"tool_call"` line (MEASURED 2026-08-23):
 *   - `steps` is the number of distinct top-level `call_id`s seen on
 *     started OR completed.  A completed whose started never arrived still
 *     counts (156 started vs 162 completed in the measured run).  When
 *     `call_id` is missing, fall back to counting `started` (or a missing
 *     subtype) and not `completed`.
 *   - `lastTool` follows `cursorToolNameFromEvent` on every such line,
 *     completed included, so the most recent call wins.  Unrecognisable
 *     names leave `lastTool` unchanged (including null) and still count.
 *
 * @param {object} acc
 * @param {object} evt
 * @param {string} [now]
 * @returns {object}
 */
export function applyCursorStreamEvent(acc, evt, now = new Date().toISOString()) {
  if (!acc || typeof acc !== "object") return acc;
  if (!evt || typeof evt !== "object") return acc;
  acc.events += 1;
  acc.lastActivity = now;
  try {
    if (evt.type === "tool_call") {
      const name = cursorToolNameFromEvent(evt);
      if (name) acc.lastTool = name;
      if (!(acc.callIds instanceof Set)) acc.callIds = new Set();
      const id = nonEmptyString(evt.call_id);
      if (id) {
        if (!acc.callIds.has(id)) {
          acc.callIds.add(id);
          acc.steps += 1;
        }
      } else if (evt.subtype !== "completed") {
        acc.steps += 1;
      }
    }
  } catch {
    // Malformed tool_call must not take down the dispatch.
  }
  return acc;
}
/**
 * A short, faithful description of what arrived — quoted into failure
 * messages so the error names the received payload.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function describeCursorResult(value) {
  if (value === null || value === undefined) return "(nothing)";
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

/**
 * Decide whether a terminal `type:"result"` object carries a completed
 * job's payload.  PAYLOAD PRESENCE decides: a non-empty `result` string.
 * `is_error` is ignored for the ok/fail decision.
 *
 * @param {object|null} parsed
 * @returns {{ok: true, text: string, isError: boolean, sessionId: string|null}
 *          |{ok: false, error: string, isError: boolean, sessionId: string|null}}
 */
export function cursorPayload(parsed) {
  const sessionId =
    typeof parsed?.session_id === "string" && parsed.session_id !== ""
      ? parsed.session_id
      : null;
  const isError = parsed?.is_error === true;
  const result = parsed?.result;
  if (typeof result === "string" && result.trim() !== "") {
    return { ok: true, text: result, isError, sessionId };
  }
  return {
    ok: false,
    error:
      "cursor returned no payload: terminal result line has an empty or missing `result`. " +
      `Received: ${describeCursorResult(parsed)}`,
    isError,
    sessionId,
  };
}

/**
 * Map the terminal `usage` object onto the job-record shape the other
 * backends already store.  Cursor reports camelCase counters (MEASURED):
 * inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens.  There is
 * no thinking/total field in the measured payload — `reasoning` and `total`
 * are 0, not a fourth shape.
 *
 * @param {object|null} result
 * @returns {object}
 */
export function mapCursorUsage(result) {
  const u = result?.usage ?? {};
  return {
    available: true,
    input: u.inputTokens ?? 0,
    output: u.outputTokens ?? 0,
    reasoning: 0,
    cacheRead: u.cacheReadTokens ?? 0,
    cacheWrite: u.cacheWriteTokens ?? 0,
    total: 0,
    cost: 0,
    model: result?.model ?? null,
  };
}

// =========================================================================
// session guard — pure
// =========================================================================

/**
 * Refuse an opencode `ses_*` id on shape.  Bare UUIDs pass through.
 *
 * @param {string|null|undefined} session
 * @throws {Error}
 */
export function assertNoOpencodeSessionOnCursor(session) {
  if (typeof session !== "string" || session === "") return;
  if (session.startsWith("ses_")) {
    throw new Error(
      `opencode session ${session} cannot be resumed on the cursor backend — ` +
      "ses_* session ids belong to opencode; run the command without --backend cursor " +
      "(or drop --session / --resume-last)"
    );
  }
}

/**
 * Spawn cursor-agent, write the prompt on stdin, and fold its NDJSON stream.
 *
 * Delegates the mechanical lifecycle (spawn, line framing, timeout, silence
 * watchdog, process-group kill, close handling) to the shared
 * `runBackendProcess` module (kusabi #462).  Cursor-specific concerns — the
 * parse function for the silence clock, stdin prompt transport — are wired
 * here.
 *
 * @param {object} opts
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string,
 *                     timedOut: boolean, stalled: boolean,
 *                     spawnError: Error|null }>}
 */
export function runCursorProcess({
  bin, args, cwd, promptText, timeoutS, watchdogS, onStart, onLine, onWatchdog,
}) {
  return runBackendProcess({
    bin, args, cwd, promptText, timeoutS, watchdogS, onStart, onLine, onWatchdog,
    parseLine: parseCursorStreamLine,
  });
}

// =========================================================================
// cursorDispatch — the dispatchWithFallback-shaped entry point
// =========================================================================

/**
 * Dispatch one prompt through the Cursor CLI (`cursor-agent -p`).
 * Same call/return contract as `agyDispatch` / `claudeDispatch`.
 *
 * @param {object} opts
 * @returns {Promise<{ job: object, resultText: string, stateDir: string }>}
 */
export async function cursorDispatch(opts) {
  assertNoOpencodeSessionOnCursor(opts.session);

  const modelEntry =
    validateCursorModel(opts.explicitModel || firstRoute(opts.tiers || [])) || DEFAULT_CURSOR_MODEL;
  const pinned = cursorModelIsPinned(modelEntry);
  const stateDir = stateDirFor(opts.cwd);

  const systemPrompt = readAgentSystemPrompt(opts.agent);
  const promptText = buildCursorPrompt({ systemPrompt, promptText: opts.promptText });
  const bin = cursorBin();
  const timeoutS = isUsableTimeoutS(opts.timeoutS) ? opts.timeoutS : null;
  const watchdogS = isUsableTimeoutS(opts.watchdogS) ? opts.watchdogS : null;
  const args = buildCursorArgs({
    model: modelEntry,
    pinned,
    sessionId: opts.session,
  });

  const unenforcedDenies = Object.entries(opts.tools ?? {})
    .filter(([, allowed]) => allowed === false)
    .map(([name]) => name);

  const job = {
    id: newJobId(),
    kind: opts.kind || "task",
    title: opts.title || "",
    status: "running",
    backend: CURSOR_BACKEND,
    sessionID: null,
    process: null,
    cwd: opts.cwd,
    phase: opts.phase ?? null,
    modelEntry,
    modelVariant: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    stats: {
      instrumented: true,
      events: 0,
      steps: 0,
      lastTool: null,
      permissionsAllowed: 0,
      permissionsRejected: 0,
      lastActivity: null,
      models: [],
    },
    cursorIsError: null,
    modelResidueHazard: pinned
      ? `--model ${modelEntry} was passed; Cursor CLI writes ~/.cursor/cli-config.json and this changes later invocations on the machine`
      : null,
    toolDeniesUnenforced: unenforcedDenies,
    error: null,
    failure: null,
    retry: null,
    fallbacks: null,
  };
  saveJob(stateDir, job);
  fs.writeFileSync(path.join(jobDir(stateDir, job.id), "prompt.md"), promptText, "utf8");

  const progressWatch = startKaibaProgressWatch({ stateDir, jobId: job.id });

  try {
    appendEvent(stateDir, job.id, {
    type: "companion.cursor.dispatch",
    backend: CURSOR_BACKEND,
    model: modelEntry,
    pinned,
    bin,
    toolDeniesUnenforced: unenforcedDenies,
    modelResidueHazard: job.modelResidueHazard,
  });

  let assistantText = "";
  let lastResult = null;
  const streamAcc = initCursorStreamAccumulator();
  let lastStatsSaveAt = 0;
  const STATS_SAVE_INTERVAL_MS = 1000;
  const onLine = (rawLine) => {
    const evt = parseCursorStreamLine(rawLine);
    if (evt === null) return;
    applyCursorStreamEvent(streamAcc, evt);
    if (evt.type === "assistant") {
      assistantText += assistantTextFromEvent(evt);
    } else if (evt.type === "result") {
      lastResult = evt;
    }
    if (typeof evt.session_id === "string" && evt.session_id) {
      job.sessionID = evt.session_id;
    }
    job.stats = {
      instrumented: true,
      events: streamAcc.events,
      steps: streamAcc.steps,
      lastTool: streamAcc.lastTool,
      permissionsAllowed: job.stats.permissionsAllowed,
      permissionsRejected: job.stats.permissionsRejected,
      lastActivity: streamAcc.lastActivity,
      models: streamAcc.models,
    };
    const now = Date.now();
    if (now - lastStatsSaveAt >= STATS_SAVE_INTERVAL_MS) {
      lastStatsSaveAt = now;
      saveJob(stateDir, job);
    }
  };

  const { code, stdout, stderr, timedOut, stalled, spawnError } = await runCursorProcess({
    bin,
    args,
    cwd: opts.cwd,
    promptText,
    timeoutS,
    watchdogS,
    onStart: ({ pid }) => {
      job.process = { pid, recordedAt: new Date().toISOString() };
      saveJob(stateDir, job);
    },
    onLine,
    onWatchdog: ({ kind, silenceS }) => {
      if (kind === "fired") {
        appendEvent(stateDir, job.id, { type: "companion.watchdog.fired", silenceS });
      } else {
        appendEvent(stateDir, job.id, { type: "companion.watchdog.kill" });
      }
    },
  });

  job.finishedAt = new Date().toISOString();

  let resultText = "";
  if (spawnError) {
    job.status = "error";
    job.error = `cursor dispatch failed: could not start ${bin}: ${spawnError.message}`;
  } else if (stalled) {
    job.status = "stalled";
    job.error = `watchdog: no events for ${watchdogS}s (process killed)`;
  } else if (timedOut) {
    job.status = "timeout";
    job.error = `timed out after ${timeoutS}s`;
  } else if (code !== 0 && code !== null) {
    job.status = "error";
    const detail = (stderr || stdout || "(no output)").trim();
    job.error =
      `cursor exited with code ${code}: ${describeCursorResult(detail)}` +
      (lastResult ? `; terminal line: ${describeCursorResult(lastResult)}` : "");
    if (lastResult) {
      job.cursorIsError = lastResult.is_error === true;
      if (typeof lastResult.session_id === "string") job.sessionID = lastResult.session_id;
    }
  } else if (!lastResult) {
    job.status = "error";
    job.error =
      "cursor produced no terminal result line. " +
      `Received: ${describeCursorResult((stdout || "").trim() || "(empty stdout)")}`;
  } else {
    const outcome = cursorPayload(lastResult);
    job.cursorIsError = outcome.isError;
    if (outcome.sessionId) job.sessionID = outcome.sessionId;
    if (outcome.ok) {
      job.status = "completed";
      job.usage = {
        ...mapCursorUsage(lastResult),
        phase: job.phase,
        durationSeconds: durationS(job),
      };
      writeJson(path.join(jobDir(stateDir, job.id), "usage.json"), job.usage);
      const resolved = resolveCompletedResult({
        backend: CURSOR_BACKEND,
        fetched: { ok: true, text: outcome.text },
        coords: { sessionId: job.sessionID },
      });
      resultText = resolved.text ?? outcome.text;
      job.result = resolved.record;
      fs.writeFileSync(path.join(jobDir(stateDir, job.id), "result.md"), resultText, "utf8");
    } else {
      job.status = "error";
      job.error = outcome.error;
    }
  }

  appendEvent(stateDir, job.id, {
    type: "companion.cursor.finished",
    status: job.status,
    cursorIsError: job.cursorIsError,
    sessionId: job.sessionID,
    exitCode: code,
    assistantChars: assistantText.length,
  });

  // Record the closed terminal reason (kusabi #388).  Cursor finalizes its
  // job.json on this path and never calls deriveStopReason via the opencode
  // SSE fold, so stamp here at the terminal write.  worktreeChanged is left
  // unmeasured at job level, matching the opencode path: a completed wrapper
  // records "completed"; error/timeout/stalled fall through to "unknown".
  job.stopReason = deriveStopReason({ status: job.status, stats: job.stats });
  saveJob(stateDir, job);

  return { job, resultText, stateDir };
  } finally {
    progressWatch.stop();
  }
}
