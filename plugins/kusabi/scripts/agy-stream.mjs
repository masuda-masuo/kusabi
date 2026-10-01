// agy-stream.mjs — agy backend output and NDJSON event stream parsing (kusabi #332).
//
// Split out of agy-dispatch.mjs (pure move, no behaviour change): parsing
// agy's output / NDJSON event stream, accumulator state, watchdog calculations,
// usage mapping, and payload extraction.

import { resolveBoundS } from "./backend-process-runner.mjs";
import { collectAgyDeniedActions } from "./agy-home.mjs";

// =========================================================================
// output parsing — pure
// =========================================================================

/**
 * Parse a single JSON object of the shape agy's result payload carries.
 *
 * Since kusabi #332 the CLI is invoked with `--output-format stream-json`,
 * so this is no longer the primary reading — the terminal payload now
 * arrives as the `result` event's inner object, folded by the stream
 * accumulator.  It is kept as the LEGACY reading for a stream that never
 * carried a terminal `result` event (a CLI build that ignores
 * stream-json and prints the old single object still delivers work), and
 * as the tolerant fallback that turns an unparseable stream into the
 * established, quoted failure text instead of a bare parse error.
 *
 * Tolerant of surrounding noise in ONE narrow way: leading/trailing
 * whitespace.  Anything else (prose, NDJSON, an array) is a parse failure
 * that the dispatch turns into a failed job carrying the raw text — never a
 * silent empty result.
 *
 * @param {string} stdout
 * @returns {object} The parsed result object.
 * @throws {Error} When stdout is not a single JSON object.
 */
export function parseAgyResult(stdout) {
  const text = typeof stdout === "string" ? stdout.trim() : "";
  if (!text) throw new Error("agy produced no output");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`agy output is not JSON: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("agy output is not a JSON object");
  }
  return parsed;
}

// =========================================================================
// NDJSON stream parsing — pure (kusabi #332)
// =========================================================================
//
// `agy -p --output-format stream-json` prints one JSON event object per
// stdout line, discriminated by the `event` key (NOT `type` — the claude
// vocabulary; the two backends are deliberately not unified).  These three
// functions are the whole parse/fold contract, kept pure and separate from
// the spawn/IO code so they are cheap to unit-test against fixture event
// sequences — the same shape that made the claude side's tests cheap
// (kusabi #215 Job B).

/**
 * Parse one line of the agy NDJSON stream.
 *
 * Returns null for anything that is not a JSON object on that line — blank
 * lines, and non-JSON prose (the real CLI has been observed printing
 * non-JSON warning lines, on the claude side and presumably here too).  The
 * caller counts nulls for debugging but never treats one as fatal.
 *
 * @param {string} line
 * @returns {object|null}
 */
export function parseAgyStreamLine(line) {
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
 * A fresh accumulator for folding an agy NDJSON stream into job stats.
 *
 * `toolStepIndexes` backs the count-once-per-step rule: the same
 * `step_index` is emitted ACTIVE then DONE (or ERROR), so a step is counted
 * only the first time its index is seen, while `lastTool` still follows the
 * most recent tool line.
 *
 * @returns {{ events: number, steps: number, lastTool: string|null,
 *             lastActivity: string|null, models: string[],
 *             conversationIdFromInit: string|null, resultEvent: object|null,
 *             toolStepIndexes: Set<number> }}
 */
export function initAgyStreamAccumulator() {
  return {
    events: 0,
    steps: 0,
    lastTool: null,
    lastActivity: null,
    models: [],
    conversationIdFromInit: null,
    resultEvent: null,
    toolStepIndexes: new Set(),
  };
}

/**
 * Fold one parsed stream event into the accumulator (mutates and returns
 * it).  Every recognized event kind contributes:
 *
 *   - `init`          — `conversation_id` at the TOP level (the field's
 *                       observed position; measured 2026-08-20), kept in
 *                       case the stream ends with no terminal `result`
 *                       event so the run stays resumable; the echoed
 *                       `init.model` joins `models` (deduped).
 *   - `step_update`   — a `step_type: "tool"` line contributes to `steps`
 *                       ONCE per `step_index` (the same index is re-emitted
 *                       for every state transition: ACTIVE, then DONE or
 *                       ERROR) and refreshes `lastTool` from `tool_name` on
 *                       every such line — the ERROR line included, so a
 *                       failed tool call is still the most recent tool.
 *   - `result`        — kept as `resultEvent`; a later one replaces an
 *                       earlier one, so a stream carrying more than one
 *                       keeps the LAST (the terminal one).
 *
 * `events` and `lastActivity` update for every parsed object regardless of
 * kind: `events` is "parsed event lines", not "recognized kinds".
 *
 * @param {object} acc — an accumulator from `initAgyStreamAccumulator`.
 * @param {object} evt — one parsed stream event.
 * @param {string} [now] — ISO timestamp; overridable for tests.
 * @returns {object} The same accumulator, mutated.
 */
export function applyAgyStreamEvent(acc, evt, now = new Date().toISOString()) {
  acc.events += 1;
  acc.lastActivity = now;

  const event = evt?.event;
  if (event === "init") {
    // The conversation id is a TOP-LEVEL sibling of the `init` object, not
    // a field of it (measured 2026-08-20).
    if (typeof evt.conversation_id === "string" && evt.conversation_id) {
      acc.conversationIdFromInit = evt.conversation_id;
    }
    const init = evt.init;
    if (init && typeof init === "object") {
      const model = init.model;
      if (typeof model === "string" && model && !acc.models.includes(model)) {
        acc.models.push(model);
      }
    }
  } else if (event === "step_update") {
    const su = evt.step_update;
    if (su && typeof su === "object" && su.step_type === "tool") {
      // One step per step_index, not one per state transition: the observed
      // protocol re-emits the SAME index for ACTIVE then DONE (or ERROR),
      // so counting every line would count each tool call up to three times.
      // A line without a numeric index cannot be deduped safely, so it is
      // not counted — but it still refreshes lastTool below.
      if (typeof su.step_index === "number" && !acc.toolStepIndexes.has(su.step_index)) {
        acc.toolStepIndexes.add(su.step_index);
        acc.steps += 1;
      }
      if (typeof su.tool_name === "string" && su.tool_name) {
        acc.lastTool = su.tool_name;
      }
    }
  } else if (event === "result") {
    acc.resultEvent = evt;
  }
  return acc;
}

// The FLOOR of the armed silence-watchdog interval, in seconds (kusabi
// #332).
//
// WHY 120s: the real agy CLI emits NOTHING for the first ~11 seconds of a
// healthy run — even the `init` line is not flushed until then (measured
// 2026-08-20: the output file stayed at 0 bytes for ~11s, grew at 11s,
// 13s, 17s, finishing at 11847B).  A silence watchdog armed below that
// would kill correct runs on every dispatch.  The floor is enforced HERE,
// in code, and never left to callers passing a sane value.
export const AGY_WATCHDOG_FLOOR_S = 120;

/**
 * Resolve the silence-watchdog bound for an agy dispatch: the one place
 * that decides whether a usable interval was supplied and what number is
 * armed.
 *
 * The floor is applied AFTER the refusal: a positive finite number is
 * raised to AGY_WATCHDOG_FLOOR_S when below it, and passes through
 * unchanged at or above it — the armed interval is NEVER less than the
 * floor, whatever the caller passes.  Anything that is not a positive
 * finite number (absent, null, zero, negative, NaN, Infinity, a string)
 * arms NO watchdog at all: the same refusal discipline resolveBoundS
 * applies to the outer bound, so the two bound decisions cannot disagree
 * about a shape.
 *
 * `agyDispatch` calls this ONCE and hands the same value to runAgyProcess
 * (which re-checks with the same function, idempotently) and to the stall
 * error text, so the armed interval and the interval the error names can
 * never disagree.
 *
 * @param {unknown} value — the raw `opts.watchdogS` from the dispatch options.
 * @returns {number|null} the armed interval in seconds (floored), or null
 *          when no usable interval was supplied.
 */
export function agyWatchdogSeconds(value) {
  const resolved = resolveBoundS(value);
  if (resolved === null) return null;
  return Math.max(resolved, AGY_WATCHDOG_FLOOR_S);
}

/**
 * Decide whether a parsed agy result carries a completed job's payload, and
 * report it in the `{ok, text}` / `{ok, error}` shape both other backends
 * use — so `resolveCompletedResult` applies unchanged.
 *
 * THE PAYLOAD-OVER-STATUS RULE.  `status` is never consulted here:
 *
 *   ok: true  — a non-empty `response`, or (schema runs) a present
 *     `structured_output`.  The job produced work.  `status: "ERROR"` next
 *     to a complete payload is the REAL, observed shape: agy reports ERROR
 *     when any tool call failed anywhere in the transcript, including a
 *     mid-run MCP kwarg typo the model then recovered from.
 *   ok: false — no payload.  A failed job regardless of `status: "SUCCESS"`,
 *     with an error that QUOTES what was received so the operator can see
 *     the shape that arrived rather than guess at it.  When the empty result
 *     also carries a non-empty `denied_actions` array, the failure text says
 *     the run was DENIED instead of merely empty: headless agy auto-denies
 *     tool calls that are not allow-listed (it cannot prompt), and an empty
 *     payload plus `status: SUCCESS` is exactly the shape of a denied run —
 *     indistinguishable from "returned nothing" without reading the field.
 *     `ok` stays `false`; the error names the denied actions and points at
 *     `permissions.allow` in the settings.json of the HOME the run used.
 *
 * When both are present, `response` wins: it is the text the review-parsing
 * path already knows how to read (a schema-enforced run puts clean JSON
 * there, which `extractJson` parses trivially — there is deliberately no
 * second parsing path).  `structured_output` is the fallback for the run
 * that filled the schema but printed nothing.  A denial mid-turn does NOT
 * void a completed payload: agy can deny one tool call and still finish the
 * turn, so a non-empty `denied_actions` next to a payload leaves `ok: true`
 * — the payload wins.
 *
 * @param {object|null} parsed — output of `parseAgyResult`.
 * @param {object} [opts]
 * @param {string} [opts.settingsPath] — the settings.json of the HOME this
 *        run used (the resolved role home, or the ambient one), named in the
 *        denied error so the operator is pointed at the exact file.
 * @param {string|null} [opts.deniedTool] — `"<server>/<tool>"` when the
 *        denied MCP tool was identified from the conversation record (kusabi
 *        #545).  Non-null only when an `mcp` class was among the denials;
 *        the other classes are fully named by `display_name` and must never
 *        produce a tool line.  When set, the denied error adds the exact
 *        `mcp(<deniedTool>)` line to paste into the allowlist.
 * @param {boolean} [opts.deniedToolUnresolved] — true when an `mcp` class
 *        was denied but the tool could NOT be identified (conversation
 *        database missing/unreadable, or its last tool step completed).  The
 *        denied error then says so EXPLICITLY rather than letting the reader
 *        assume the class was all there was — an estimate must never be
 *        presented as an authoritative finding.
 * @returns {{ok: true, text: string, payloadSource: "response"|"structured_output"}
 *          |{ok: false, error: string}}
 */
export function agyPayload(parsed, { settingsPath, deniedTool = null, deniedToolUnresolved = false } = {}) {
  const response = parsed?.response;
  if (typeof response === "string" && response.trim() !== "") {
    return { ok: true, text: response, payloadSource: "response" };
  }
  const structured = parsed?.structured_output;
  if (structured !== null && structured !== undefined) {
    return { ok: true, text: JSON.stringify(structured), payloadSource: "structured_output" };
  }
  const denied = collectAgyDeniedActions(parsed);
  if (denied.length > 0) {
    const where = settingsPath ?? "<HOME>/.gemini/antigravity-cli/settings.json";
    // The denial diagnosis, in the shape the operator can act on.  The
    // paste-ready `mcp(<server>/<tool>)` line is added only when the tool
    // was actually identified; a class that could not be pinned down is
    // called out as such instead of being silently dropped.
    const toolLine =
      deniedTool !== null
        ? ` The exact line to paste: mcp(${deniedTool}).`
        : deniedToolUnresolved
          ? " The specific tool could not be determined from the conversation record."
          : "";
    return {
      ok: false,
      error:
        "agy returned no payload and the run was DENIED: headless agy cannot prompt, so the " +
        "tool call(s) that are not allow-listed were auto-denied: " +
        `${denied.map((d) => d.label).join(", ")}.` +
        toolLine +
        ` Allow them under permissions.allow in ${where} (the permission table this run's HOME used). ` +
        `Received: ${describeAgyResult(parsed)}`,
    };
  }
  return {
    ok: false,
    error:
      "agy returned no payload: neither a non-empty `response` nor a `structured_output`. " +
      `Received: ${describeAgyResult(parsed)}`,
  };
}

/**
 * A short, faithful description of the object that arrived — quoted into the
 * no-payload error so the failure names what was received instead of
 * asserting what was not.  Bounded so a huge object cannot flood the record.
 *
 * @param {object|null} parsed
 * @returns {string}
 */
export function describeAgyResult(parsed) {
  if (parsed === null || parsed === undefined) return "(nothing)";
  let text;
  try {
    text = JSON.stringify(parsed);
  } catch {
    text = String(parsed);
  }
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

/**
 * Map an agy result's usage fields onto the kusabi usage shape.  ALL FIVE
 * reported counters survive the mapping — `thinking_tokens` in particular,
 * which is the bulk of a reasoning model's billable output and is exactly
 * the number a "which backend costs what" question turns on:
 *
 *   input_tokens      → input
 *   output_tokens     → output
 *   thinking_tokens   → reasoning   (the opencode path's own name for it)
 *   cache_read_tokens → cacheRead
 *   total_tokens      → total       (agy-only; no other backend reports one)
 *
 * `cacheWrite` and `cost` are null because agy reports neither;
 * an absent counter is not a measured zero; null is skipped by aggregators.
 *
 * @param {object} result
 * @returns {{ available: boolean, input: number|null, output: number|null, reasoning: number|null,
 *             cacheRead: number|null, cacheWrite: number|null, total: number|null, cost: number|null,
 *             model: string|null }}
 */
export function mapAgyUsage(result) {
  const u = result?.usage ?? {};
  return {
    available: true,
    input: typeof u.input_tokens === "number" ? u.input_tokens : null,
    output: typeof u.output_tokens === "number" ? u.output_tokens : null,
    reasoning: typeof u.thinking_tokens === "number" ? u.thinking_tokens : null,
    cacheRead: typeof u.cache_read_tokens === "number" ? u.cache_read_tokens : null,
    cacheWrite: null,
    total: typeof u.total_tokens === "number" ? u.total_tokens : null,
    cost: null,
    model: result?.model ?? null,
  };
}
