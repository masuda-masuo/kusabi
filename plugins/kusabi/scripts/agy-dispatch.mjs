// agy-dispatch.mjs — Antigravity CLI backend for kusabi job dispatch (kusabi #199).
//
// Backend contract: a function with the SAME call/return shape as
// `dispatchWithFallback` (prompt-execution.mjs) and `claudeDispatch`
// (claude-dispatch.mjs): it receives the dispatch options object (cwd, kind,
// title, promptText, agent, phase, session, tools, timeoutS, watchdogS,
// tiers, round, tierIndex, explicitModel) and resolves to
// `{ job, resultText, stateDir }`.  kusabi-companion.mjs picks this function
// per phase; the chain phases stay backend-blind.
//
// WHY a third backend: agy draws on a separate quota pool (Gemini, metered
// apart from both the opencode and the claude pool) and adds a third model
// family, which is what cross-family review needs.  There is NO
// read-only-phase restriction — any phase may route here.
//
// ---------------------------------------------------------------------------
// The CLI contract (field-verified by a hand run, 2026-08-11)
// ---------------------------------------------------------------------------
//
//   agy -p <prompt> --output-format stream-json --model <id> --print-timeout <duration>
//         [--json-schema <schema>] [--conversation <id>]
//
// and an NDJSON event stream on stdout, one object per line, discriminated
// by the `event` key (NOT `type` — that is the claude vocabulary; agy uses
// `event`).  Three event kinds were field-verified on 2026-08-20:
//
//   {"event":"init","conversation_id":"<uuid>","init":{model,cwd,tools,
//     permission_mode,json_schema}}                     — the conversation id
//                                                         sits at the TOP level
//   {"event":"step_update","step_update":{conversation_id,step_index,state,
//     step_type,tool_name?,tool_info?,usage?,…}}        — repeated per step; a
//                                                         tool step appears as
//                                                         ACTIVE then DONE (or
//                                                         ERROR), same index
//   {"event":"result","result":{…}}                     — the terminal line; the
//                                                         inner `result` object
//                                                         is BYTE-SHAPE-IDENTICAL
//                                                         to the whole object
//                                                         `--output-format json`
//                                                         used to print
//
// The terminal `result.result` payload therefore keeps that shape:
//
//   {"conversation_id":"<uuid>","status":"SUCCESS","response":"<text>",
//    "duration_seconds":152.4,"num_turns":2,
//    "structured_output":{…},"json_schema":{…},
//    "usage":{"input_tokens":…,"output_tokens":…,"thinking_tokens":…,
//             "cache_read_tokens":…,"total_tokens":…}}
//
// `structured_output` / `json_schema` appear only when `--json-schema` was
// passed.  No flag outside that list is ever constructed here — in
// particular NEVER `--dangerously-skip-permissions`: it is not needed (the
// sunaba/shiori tools are auto-approved server-side) and the
// orchestrator-side classifier blocks it.
//
// **The outer `status` field is NOT authoritative.**  A run whose transcript
// contains any failed tool call reports `status: "ERROR"` even when
// `response` and `structured_output` are complete and correct (observed: one
// MCP kwarg validation error mid-run, full verdict delivered).  Success is
// therefore decided by PAYLOAD PRESENCE — a non-empty `response`, or a
// present `structured_output` — and `status` is recorded as advisory
// metadata (`job.agyStatus`) only.  A missing/empty payload is a failed job
// regardless of what `status` claims.  Reading it the other way round would
// throw away completed, paid-for work on a mid-run tool typo.
//
// ---------------------------------------------------------------------------
// v1 limits (deliberate; see docs/design/phase-chain.md §3.5.14)
// ---------------------------------------------------------------------------
//   - ONE model per phase: `explicitModel` when given, else the first route
//     of the tiered chain.  No tier ladder, no capacity fallback, no retry
//     walk — same shape as the claude backend's v1 (kusabi #184 Job A).
//   - RESUME VIA `--conversation` (kusabi #316).  The CLI has always taken
//     `--conversation <id>` (and `-c` / `--continue` for the most recent
//     conversation); #199's survey simply did not list it, so v1 recorded
//     the CLI's `conversation_id` as the job's `sessionID` and resumed
//     nothing.  A resuming dispatch now passes the recorded id back:
//     `agy -p <prompt> --output-format stream-json --model <id> --conversation
//     <id>`.  One gate is NOT like the other backends': an agy
//     `conversation_id` and a claude session id are BOTH bare UUIDs, so
//     shape cannot tell them apart — this module resumes a session only
//     when the caller states its provenance (an explicit signal, see
//     `assertNoAgySession`), and fails closed otherwise.  The job store,
//     where the distinguishing record lives, is consulted by the caller
//     (kusabi-companion.mjs / the chain seams); this module never touches
//     the store itself.
//   - `:variant` suffixes are rejected: agy has no variant concept, and a
//     silently ignored suffix is how an operator ends up billed for a model
//     they did not ask for.
//   - MODEL IDS ARE NOT ENUMERATED HERE.  The list drifts (as of 2026-08-10:
//     gemini-3.6-flash-high|medium|low, gemini-3.5-flash-high|medium|low,
//     gemini-3.1-pro-high|low, claude-sonnet-4-6, claude-opus-4-6-thinking,
//     gpt-oss-120b-medium).  The agy CLI itself is the validator of record;
//     kusabi validates only the SHAPE (non-empty, no `:variant`), so a model
//     added upstream works the day it ships instead of the day kusabi is
//     updated.
//   - THE EVENT STREAM IS FOLDED WHILE IT RUNS (kusabi #332).  `stream-json`
//     prints one event per line as it happens, so `job.stats` is MEASURED, not
//     structural: `instrumented: true` with real `events`, `steps`, `lastTool`,
//     `lastActivity`, `models` (the marker post-#215 claude records carry,
//     which every reader already handles).  A tool step is counted ONCE per
//     step_index — the same index is emitted ACTIVE then DONE (or ERROR) —
//     and `lastTool` is the tool_name of the most recent tool line, ERROR
//     included.  `watchdogS` is LIVE: no parsed event for that long kills the
//     child's whole process group and the job finishes `stalled`, exactly like
//     the claude silence watchdog.  The armed interval is floored at
//     AGY_WATCHDOG_FLOOR_S (120s): the real CLI emits NOTHING — not even
//     `init` — for the first ~11 seconds of a healthy run (measured
//     2026-08-20), so a short interval would kill correct runs; the floor is
//     enforced in code, never left to callers.  `timeoutS`, an absolute
//     wall-clock bound, is the OUTER bound: the
//     spawned process carries its own INNER bound (`--print-timeout`, kusabi
//     #326) that kusabi sets so the outer one always expires first.  That
//     ordering is what keeps the outer bound authoritative — a too-long job
//     is classified through the `timedOut` path ("timed out after Ns")
//     instead of arriving as a well-formed JSON object with an empty
//     `response` that reads as "agy returned no payload".  The direction is
//     deliberately REVERSED vs kusabi-companion.mjs's `DEFAULT_WATCHDOG_S =
//     900`: there opencode's inner 600s `mcp_timeout` trips FIRST because
//     its error is the more informative one; here agy's inner failure (an
//     empty payload that names no cause) is the LESS informative one, so
//     kusabi's own bound is the one that fires.
//   - A BRIEF HAS A HARD CEILING HERE that the other backends do not have.
//     The prompt rides argv, and Linux caps a single argv string at
//     MAX_ARG_STRLEN (131072 bytes); past it the spawn fails with E2BIG.
//     `checkAgyArgvSize` refuses such a dispatch before the spawn with an
//     error that names the oversized element and the way out, rather than
//     letting a raw errno surface as a generic dispatch failure.  It is a
//     caller error (`status: "error"`), not a provider outage.
//   - Per-dispatch tool permissions cannot be expressed: agy takes no
//     allow/deny flags.  A deny map that reaches this dispatch (the chain
//     phases pass implementDenyTools / reviewDenyTools unconditionally) is
//     recorded on the job record as `toolDeniesUnenforced` rather than
//     silently dropped; an operator-typed `--read-only` / `--deny` is
//     rejected at command start instead (kusabi-companion.mjs), because a
//     restriction that cannot be applied must never look applied.  What CAN
//     be expressed is a PER-ROLE permission table: agy's allow-list lives in
//     `<HOME>/.gemini/antigravity-cli/settings.json`, and HOME is derived
//     from nothing else, so `agy.homes` (see resolveAgyHome) hands each role
//     its own HOME — and with it its own allow-list, MCP config, and rules.
//     A role with no configured home runs under the ambient HOME exactly as
//     before; a configured home whose settings.json is unusable refuses the
//     dispatch (fail closed) instead of widening back to the operator's own
//     machine-wide table.
//
// ---------------------------------------------------------------------------
// Assumptions this module makes and does NOT manage
// ---------------------------------------------------------------------------
// agy reaches sandbox containers through the sunaba MCP server, configured
// in `<HOME>/.gemini/config/mcp_config.json` (`agy mcp add` writes it there;
// the older `~/.gemini/antigravity-cli/mcp_config.json` path is gone) — the
// same route Claude Code uses, and per-HOME like every other `.gemini` file
// (see resolveAgyHome).  That file is the operator's; this dispatch neither
// writes, validates, nor overrides it (contrast the claude backend, which
// generates its own `--mcp-config`).  If sunaba is not configured there, the
// worker simply has no container tools and says so in its own output.

import path from "node:path";
import fs from "node:fs";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { firstRoute } from "./cli.mjs";
import { readAgentSystemPrompt } from "./claude-dispatch.mjs";
import { newJobId, saveJob, jobDir, appendEvent } from "./job-store.mjs";
import { stateDirFor, writeJson, readJson, stateRoot } from "./state-paths.mjs";
import { durationS } from "./render.mjs";
import { resolveCompletedResult } from "./result-recovery.mjs";
import { deriveStopReason } from "./stop-reason.mjs";
import { startKaibaProgressWatch } from "./kaiba-progress-watch.mjs";
import { isUsableTimeoutS, runBackendProcess } from "./backend-process-runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");

export const AGY_BACKEND = "agy";

// The agy backend's default chain when the config has no models.chain /
// models.phases.<phase> entry.  ONE tier on purpose: this backend walks no
// ladder, so a multi-tier default would describe a climb that never happens.
// The opencode BUILTIN_DEFAULT_CHAIN and CLAUDE_DEFAULT_CHAIN are both
// deliberately NOT reused — their entries are other backends' model
// spellings, so `--backend agy` must work out of the box with an agy-shaped
// default instead of failing on a model the operator never typed.  The id
// WILL drift (see the model-id note above); it is a starting point, not a
// contract.
export const AGY_DEFAULT_CHAIN = [["gemini-3.6-flash-high"]];

// The agent whose output contract IS the review verdict.  When a dispatch
// carries it, `--json-schema` enforces the shape at the CLI (see
// agyJsonSchemaFor).
export const REVIEW_AGENT = "kusabi-review";

// The binary is resolved through AGY_BIN so tests can point the dispatch at
// a fake `agy` script (exactly the CLAUDE_BIN / OPENCODE_BIN precedent).
// The real binary is a WSL host install (`~/.local/bin/agy`) that exists in
// neither CI nor the dev container, so no test may ever require it.
export function agyBin() {
  return process.env.AGY_BIN || "agy";
}

// =========================================================================
// model syntax — pure
// =========================================================================

/**
 * Validate a model entry for the agy backend.
 *
 * Accepted: any non-empty id (`gemini-3.6-flash-high`, `claude-sonnet-4-6`,
 * `gpt-oss-120b-medium`, …).  The agy CLI is the validator of record for
 * WHICH ids exist; this checks only the shape kusabi is entitled to have an
 * opinion about.  A `:variant` suffix is rejected with an explicit error —
 * it must never be silently ignored (mirrors validateClaudeModel).
 *
 * @param {string|null|undefined} value
 * @returns {string|null} The normalized model string, or null when absent.
 * @throws {Error} When the entry carries a `:variant` suffix.
 */
export function validateAgyModel(value) {
  if (value === undefined || value === null || value === "") return null;
  const v = String(value);
  if (v.indexOf(":") >= 0) {
    throw new Error(
      `agy backend does not support the :variant suffix in model "${v}" — ` +
      "use a plain agy model id (e.g. gemini-3.6-flash-high); the agy CLI validates which ids exist"
    );
  }
  return v;
}

/**
 * Validate EVERY route of a (tiered) chain for the agy backend.
 *
 * The chain is handed to agyDispatch on every phase dispatch and a
 * rework/strategize round derives its model from it when no explicit model
 * is passed.  Validating the whole chain at command start guarantees a bad
 * (e.g. opencode-shaped) chain fails LOUDLY before createChainDir / before
 * any job is dispatched — never mid-flight after round 1 (the kusabi #184
 * finding 1 rule, applied to the third backend).
 *
 * @param {(string|string[])[]} chain — tiered chain entries.
 * @returns {(string|string[])[]} The chain, unchanged.
 * @throws {Error} Naming the offending entry.
 */
export function validateAgyChain(chain) {
  for (const tier of Array.isArray(chain) ? chain : []) {
    const routes = Array.isArray(tier) ? tier : [tier];
    for (const route of routes) {
      try {
        validateAgyModel(route);
      } catch (err) {
        throw new Error(
          `agy backend: chain entry "${route}" is not an agy model — ` +
          "configure models.chain with plain agy model ids " +
          `(e.g. gemini-3.6-flash-high): ${err.message}`
        );
      }
    }
  }
  return chain;
}

/**
 * Resolve the model for the agy backend, mirroring `resolveModel`'s
 * precedence (explicit flag → per-phase chain → global chain → built-in
 * default) with agy model syntax: entries pass through verbatim (no
 * `provider/model` split).  `agy/`-prefixed entries are stripped by
 * resolveDispatchBackend AFTER this returns — this mirror stays
 * prefix-unaware, exactly like resolveClaudeModel.
 *
 * @param {object}   opts
 * @param {string}   [opts.flag]   — `--model` flag value.
 * @param {string}   [opts.phase]  — phase name (for models.phases.<phase>).
 * @param {object}   [opts.config] — loaded kusabi config.
 * @returns {{ model: string|undefined, chain: (string|string[])[] }}
 */
export function resolveAgyModel({ flag, phase, config }) {
  let chain;
  if (config?.models?.chain) {
    chain = [...config.models.chain];
  } else {
    chain = [...AGY_DEFAULT_CHAIN];
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
 * The `--json-schema` argument for a dispatch, or null when the phase's
 * output contract is free text.
 *
 * This is PREVENTION for the review-verdict shape problem: when the phase's
 * contract IS the review verdict, the CLI enforces it, so the model cannot
 * hand back prose where the chain expects JSON.  The schema is not a new
 * artifact — it is `schemas/review-output.schema.json`, the EXISTING verdict
 * contract that the review prompt already embeds and `parseReviewResult`
 * already reads.  One contract, two enforcement points; there is no schema
 * registry and no per-phase schema config key (out of scope by design).
 *
 * Re-serialised compactly so argv is stable and the file's formatting is not
 * part of the invocation.
 *
 * @param {string|null|undefined} agent
 * @returns {string|null} Compact JSON schema text, or null.
 */
export function agyJsonSchemaFor(agent) {
  if (agent !== REVIEW_AGENT) return null;
  const raw = fs.readFileSync(path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json"), "utf8");
  return JSON.stringify(JSON.parse(raw));
}

/**
 * Compose the prompt text handed to `agy -p`.
 *
 * agy has no `--append-system-prompt` equivalent, so the agent's role body
 * (the same `plugins/kusabi/opencode-agents/<agent>.md` body the claude
 * backend passes as a system prompt, frontmatter stripped) is prepended to
 * the prompt inside a `<role>` block.  Composing OUR OWN prompt is not the
 * same as inventing a CLI flag: the transport stays exactly the documented
 * one.  Without an agent, the prompt is byte-identical to the caller's.
 *
 * @param {object} opts
 * @param {string|null} [opts.systemPrompt]
 * @param {string} [opts.promptText]
 * @returns {string}
 */
export function buildAgyPrompt({ systemPrompt, promptText }) {
  const body = promptText ?? "";
  if (!systemPrompt) return body;
  return `<role>\n${systemPrompt}\n</role>\n\n${body}`;
}

// kusabi #326: the headroom given to agy's INNER bound (`--print-timeout`)
// over kusabi's own outer `timeoutS`.
//
// WHY 300s: both timers start at process launch — kusabi's the instant
// spawn() returns, agy's once its print-mode wait begins, which if
// anything LAGS the spawn.  The ordering therefore holds whenever the
// inner value exceeds the outer one, and the only thing the margin must
// absorb is the skew between the two start points: sub-second in the worst
// case.  300s is agy's OWN default print timeout — the smallest headroom
// this module ever grants is the tool's own idea of a full wait budget,
// two orders of magnitude above any plausible skew.
//
// The direction is deliberately REVERSED vs kusabi-companion.mjs's
// `DEFAULT_WATCHDOG_S = 900`, where opencode's inner 600s `mcp_timeout` is
// allowed to trip FIRST because the inner error is the more informative
// one.  For agy the inner failure is the LESS informative one — a
// well-formed JSON object with an empty `response`, which kusabi reads as
// "returned no payload", with no mention of time.  So the inner bound is
// set to lose the race, and the outer bound is the one that fires.
export const AGY_PRINT_TIMEOUT_MARGIN_S = 300;

/**
 * Render a whole number of seconds the way Go's `time.Duration.String()`
 * would — the dialect agy itself prints (`--help` shows `5m0s`).
 *
 * Whole seconds only by construction (timeoutS is a whole number and so is
 * the margin), so no fractional part ever needs rendering.  The compound
 * h/m/s form is used rather than a bare seconds count because it is the
 * exact form the tool itself prints; whether a bare number is also
 * accepted is not established, so the safe spelling is the tool's own.
 *
 * @param {number} totalSeconds
 * @returns {string}
 */
export function formatGoDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  let out = "";
  if (h > 0) out += `${h}h`;
  if (h > 0 || m > 0) out += `${m}m`;
  return `${out}${s % 60}s`;
}

// =========================================================================
// timeoutS resolution — the ONE decision (kusabi #328)
// =========================================================================

/**
 * Resolve the OUTER timeout bound for an agy dispatch: the one place that
 * decides whether a usable timeout was supplied and what number it is.
 *
 * REFUSES rather than coerces.  A string (`"3600"`), `NaN`, zero, a
 * negative number, `Infinity`, `null`, or an absent value is not a usable
 * positive number of seconds, and none of them arms either bound.  kusabi's
 * own callers pass positive whole numbers (the CLI seam converts with
 * `Number(...)`, the defaults are literals); any other shape is a caller
 * bug, and the honest handling of a bug is to leave the timeout unset —
 * not to guess at a number the caller never explicitly resolved.  In
 * particular, coercing `"3600"` would arm the OUTER timer while the inner
 * bound stayed off wherever the coercion did not propagate — the
 * half-armed state this issue exists to remove, in a new suit.
 *
 * `agyDispatch` calls this ONCE and hands the SAME value to both consumers
 * (buildAgyArgs, runAgyProcess), so the two sites consume one decision
 * instead of re-deciding.  Each site re-checks with the same predicate on
 * that value, so even a direct call to one site cannot reach a different
 * conclusion from the other.
 *
 * @param {unknown} value — the raw `opts.timeoutS` from the dispatch options.
 * @returns {number|null} the resolved timeout in seconds, or null when no
 *          usable timeout was supplied.
 */
export function resolveAgyTimeoutS(value) {
  if (!isUsableTimeoutS(value)) return null;
  return value;
}

/**
 * Build the argv for an `agy -p` dispatch.
 *
 * Contract (field-verified, kusabi #199; resume flag #316; timeout #326;
 * stream format #332):
 * `agy -p <prompt> --output-format stream-json --model <id> --print-timeout <duration>
 * [--json-schema <schema>] [--conversation <id>]`
 * — and NOTHING else.  Every flag here appears in that contract; no flag is
 * invented, and `--dangerously-skip-permissions` is never passed (not
 * needed, and blocked by the orchestrator-side classifier).
 *
 * `--print-timeout` carries agy's INNER bound: the resolved `timeoutS`
 * plus AGY_PRINT_TIMEOUT_MARGIN_S, formatted as a Go duration.  The outer
 * bound is kusabi's own timer (runAgyProcess); giving the inner bound
 * strictly MORE time makes the outer one the one that fires, so a
 * too-long job is classified through the `timedOut` path instead of
 * arriving as an empty payload (see the margin constant for why the
 * direction is reversed from the opencode watchdog convention).  When no
 * positive `timeoutS` is resolved there is no outer bound to keep
 * authoritative, so no inner bound is invented either — agy's own default
 * is then its business, not kusabi's.
 *
 * The prompt is on argv because that is the documented transport (unlike the
 * claude backend, which was field-verified to accept stdin).  The tradeoff
 * is real and accepted for v1: the prompt is visible in `ps` output on the
 * host for the life of the child.  Briefs are not secrets; credentials never
 * appear in one.  A stdin transport would need field verification against
 * the real CLI before it could replace this.
 *
 * @param {object} opts
 * @param {string} opts.model
 * @param {string} opts.promptText  — already composed (buildAgyPrompt).
 * @param {string|null} [opts.jsonSchema] — compact schema text, or null.
 * @param {string|null|undefined} [opts.conversationId] — an id the CALLER
 *        has proven to be an agy conversation (assertNoAgySession's
 *        provenance gate has already run); appends `--conversation <id>`.
 * @param {number|null} [opts.timeoutS] — the value agyDispatch already
 *        resolved (resolveAgyTimeoutS): a positive finite number, or null
 *        when none was supplied.  The guard below is the SAME predicate
 *        runAgyProcess arms its outer timer with, on the SAME value, so
 *        the two bound sites cannot reach different conclusions (kusabi
 *        #328); when it holds, appends `--print-timeout <timeoutS +
 *        AGY_PRINT_TIMEOUT_MARGIN_S>` as a Go duration string.
 * @returns {string[]}
 */
export function buildAgyArgs({ model, promptText, jsonSchema, conversationId, timeoutS }) {
  const args = [
    "-p", promptText ?? "",
    "--output-format", "stream-json",
    "--model", model,
  ];
  // The SAME predicate runAgyProcess arms its outer timer with and
  // resolveAgyTimeoutS decides with — isUsableTimeoutS, the one rule in one
  // place (kusabi #328).  A truthy-only check would accept "3600" and render
  // `"3600" + 300` as "3600300" — the string half-arm, banned at the door;
  // a hand-copied `typeof === "number" && > 0` would accept Infinity, which
  // the resolver refuses.
  if (isUsableTimeoutS(timeoutS)) {
    args.push("--print-timeout", formatGoDuration(timeoutS + AGY_PRINT_TIMEOUT_MARGIN_S));
  }
  if (jsonSchema) {
    args.push("--json-schema", jsonSchema);
  }
  if (typeof conversationId === "string" && conversationId !== "") {
    args.push("--conversation", conversationId);
  }
  return args;
}

// =========================================================================
// argv size guard — pure
// =========================================================================

// Linux caps EACH SINGLE argv/env string at MAX_ARG_STRLEN = PAGE_SIZE * 32.
// With the 4096-byte pages this project runs on that is 131072 bytes
// (measured, not assumed).  This is NOT ARG_MAX (2097152 on the same host):
// ARG_MAX bounds the argv+env TOTAL, and a single oversized brief hits the
// per-string cap first by an order of magnitude.
//
// It matters HERE and nowhere else.  agy has no stdin prompt transport (field
// verification, kusabi #199): the composed prompt rides `-p <promptText>` and
// the schema rides `--json-schema <json>`, so both are single argv strings
// subject to this cap.  The claude backend feeds its prompt over stdin and
// opencode goes over HTTP — neither can reach this failure, and neither gets
// a size check.
export const AGY_MAX_ARG_STRLEN = 131072;

// The size one agy argv element may reach before this backend refuses.
//
// MAX_ARG_STRLEN less a 1024-byte margin, for two reasons worth stating:
//   - The kernel measures the string WITH its NUL terminator (`copy_strings`
//     compares `strnlen_user`'s count, which includes it), so 131072 content
//     bytes is already E2BIG *at* the documented limit — the usable maximum
//     is 131071, and a guard set exactly at 131072 would still let one size
//     through to the kernel.
//   - Refusing a kilobyte early buys a legible, actionable error instead of a
//     raw errno surfacing as a generic dispatch failure.  Nothing about a
//     brief's usefulness turns on its last kilobyte.
export const AGY_MAX_ARG_BYTES = AGY_MAX_ARG_STRLEN - 1024;

// Human names for the argv elements a size refusal can name.  Keyed by the
// flag that PRECEDES the value, because that is what identifies it — the
// values themselves are just strings.
const AGY_ARG_ELEMENT_NAMES = {
  "-p": "prompt",
  "--json-schema": "schema",
  "--model": "model",
  "--output-format": "output-format",
  "--print-timeout": "print timeout",
  "--conversation": "conversation id",
};

/**
 * Check every element of an agy argv against the per-string kernel cap.
 *
 * Checked ELEMENT BY ELEMENT, not as a total: the cap is per string, and the
 * schema is a separate oversized-capable string from the prompt.  Checking
 * only the prompt would miss criterion-2's failure entirely.
 *
 * Measured in BYTES (`Buffer.byteLength`), never `.length`: the kernel counts
 * bytes, and a Japanese brief is ~3 bytes per character, so a `.length` check
 * would pass a prompt three times over the real limit.
 *
 * Pure and exported so the size rule is testable without spawning anything.
 *
 * @param {string[]} args — the argv from buildAgyArgs.
 * @param {number} [limit] — byte ceiling per element; defaults to
 *        AGY_MAX_ARG_BYTES (overridable so tests need not build 128KiB
 *        strings to exercise the rule).
 * @returns {{ok: true, limit: number, oversized: []}
 *          |{ok: false, limit: number,
 *             oversized: {index: number, element: string, flag: string|null, bytes: number}[],
 *             message: string}}
 */
export function checkAgyArgvSize(args, limit = AGY_MAX_ARG_BYTES) {
  const list = Array.isArray(args) ? args : [];
  const oversized = [];
  for (let i = 0; i < list.length; i += 1) {
    const value = typeof list[i] === "string" ? list[i] : String(list[i] ?? "");
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes <= limit) continue;
    const flag = i > 0 && Object.hasOwn(AGY_ARG_ELEMENT_NAMES, list[i - 1]) ? list[i - 1] : null;
    oversized.push({
      index: i,
      element: flag ? AGY_ARG_ELEMENT_NAMES[flag] : `argv[${i}]`,
      flag,
      bytes,
    });
  }
  if (oversized.length === 0) return { ok: true, limit, oversized: [] };

  const named = oversized
    .map((o) => `the ${o.element}${o.flag ? ` (${o.flag})` : ""} is ${o.bytes} bytes`)
    .join(", and ");
  return {
    ok: false,
    limit,
    oversized,
    message:
      `agy dispatch refused before spawn: ${named}, over the ${limit}-byte per-argument ` +
      `limit (Linux MAX_ARG_STRLEN is ${AGY_MAX_ARG_STRLEN} bytes for a single argv string; ` +
      "kusabi refuses just under it so this says what happened instead of E2BIG). " +
      "The agy CLI has no stdin transport — the prompt and the JSON schema both ride argv — " +
      "so this job cannot be dispatched on agy as written: shrink the brief, or run it on a " +
      "backend that passes the prompt over stdin (--model claude/… or an opencode model).",
  };
}

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
 * arms NO watchdog at all: the same refusal discipline resolveAgyTimeoutS
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
  if (!isUsableTimeoutS(value)) return null;
  return Math.max(value, AGY_WATCHDOG_FLOOR_S);
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
 * `cacheWrite` and `cost` are 0, not null: agy reports neither, and the
 * shape's consumers (`chain-stats`, `metrics-db`) sum these fields.  A 0
 * here means "reported as nothing to add", which is what an absent
 * cache-write counter means for a running total.
 *
 * @param {object} result
 * @returns {{ available: boolean, input: number, output: number, reasoning: number,
 *             cacheRead: number, cacheWrite: number, total: number, cost: number,
 *             model: string|null }}
 */
export function mapAgyUsage(result) {
  const u = result?.usage ?? {};
  return {
    available: true,
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    reasoning: u.thinking_tokens ?? 0,
    cacheRead: u.cache_read_tokens ?? 0,
    cacheWrite: 0,
    total: u.total_tokens ?? 0,
    cost: 0,
    model: result?.model ?? null,
  };
}

// =========================================================================
// cross-backend session guard — pure
// =========================================================================

/**
 * Reject a session that must not be resumed on the agy backend, naming BOTH
 * backends.
 *
 * Two id shapes, two gates (kusabi #316 replaced the v1 blanket refusal):
 *
 *   - `ses_*` — an opencode session id.  Shape alone decides it, which is
 *     the same guard `claudeDispatch` has had since kusabi #184; kusabi #199
 *     makes it SYMMETRIC so an opencode id cannot reach agy either.  This
 *     check always fires on shape, whatever provenance says.
 *   - anything else — an agy `conversation_id` is a bare UUID, and so is a
 *     claude session id: shape CANNOT tell them apart.  The one thing that
 *     can is the job store, and the store lives in the CALLER's hand
 *     (kusabi-companion.mjs's `assertSessionBackendCompatible` / the chain
 *     seams), not this module's.  So the module requires POSITIVE EVIDENCE
 *     rather than inferring: the caller passes `provenance: "agy"` only
 *     when it has established from the store that an agy job recorded this
 *     id.  Anything else — no signal (a caller that skipped the
 *     companion-level check), or a signal naming another backend — is
 *     refused HERE, so an id whose provenance is unknown to this module can
 *     never silently become a `--conversation` argument.  This is the
 *     backstop: it fails closed on exactly the callers that forgot to
 *     check.
 *
 * @param {string|null|undefined} session
 * @param {object} [opts]
 * @param {string|null|undefined} [opts.provenance] — the backend the caller
 *        PROVED created this session (from the job store), or nothing when
 *        no such proof exists.  Only `"agy"` lets a bare UUID through.
 * @throws {Error} When a session was given without agy provenance.
 */
export function assertNoAgySession(session, { provenance } = {}) {
  if (typeof session !== "string" || session === "") return;
  if (session.startsWith("ses_")) {
    throw new Error(
      `opencode session ${session} cannot be resumed on the agy backend — ` +
      "ses_* session ids belong to opencode; run the command without --backend agy " +
      "(or drop --session / --resume-last)"
    );
  }
  if (provenance === "agy") return;
  const attribution = provenance
    ? `the job store attributes it to the ${provenance} backend`
    : "no kusabi job record reports it, so its backend cannot be established";
  throw new Error(
    `session ${session} cannot be resumed on the agy backend — ${attribution}. ` +
    "An agy conversation_id and a claude session id are both bare UUIDs, so kusabi passes an id to " +
    "`agy --conversation` only when an agy job recorded it. " +
    "Drop --session / --resume-last, or pass a conversation id that an agy job on this directory recorded"
  );
}

// =========================================================================
// per-role HOME resolution \u2014 pure
// =========================================================================
//
// agy takes no allow/deny flags, but its permission table is per-HOME:
// `<HOME>/.gemini/antigravity-cli/settings.json` carries `permissions.allow`,
// the CLI derives that path from HOME and nothing else, and a dispatch under
// a separate HOME is governed by the separate table (measured 2026-09-22:
// a tool allow-listed only in the main HOME is refused under the separate
// one, so the main table does not leak).  So the per-role restriction that
// `--deny` cannot express IS expressible: give the role its own HOME.  The
// MCP config (`~/.gemini/config/mcp_config.json`, written by `agy mcp add`)
// and the always-on `~/.gemini/config/rules/AGENTS.md` are per-HOME too, so
// a role home scopes the whole permission surface, not just the allow-list.

/**
 * The kusabi config, read straight from the state root for the home
 * resolver's own use.  `agyDispatch` is handed no config (the dispatch
 * contract it shares with `dispatchWithFallback` / `claudeDispatch` carries
 * none, and the chain phases that call it never saw one), so the resolver
 * reads the ONE key it needs itself rather than threading a config object
 * through every phase \u2014 exactly the loadClaudeGuardConfig precedent.
 *
 * Read-only and fail-quiet: `readJson` returns null for a missing or
 * unparseable file.  A genuinely broken config never reaches here \u2014 every
 * command loads and validates it (loadConfig, kusabi-companion.mjs) before
 * any dispatch happens.
 *
 * @returns {object|null}
 */
export function loadAgyHomeConfig() {
  return readJson(path.join(stateRoot(), "config.json"));
}

/**
 * Resolve the HOME an agy dispatch should run under, from the `agy.homes`
 * map in the kusabi config.
 *
 * Config shape (documented in README.md, "Backends"):
 *
 *   { "agy": { "homes": { "implement": "/home/u/.agy-homes/implement",
 *                         "review":    "/home/u/.agy-homes/review",
 *                         "default":   "/home/u/.agy-homes/default" } } }
 *
 * `home: null` means "do not override HOME" \u2014 the spawn is byte-identical
 * to today's dispatch.  Resolution table \u2014 every row is a test:
 *
 *   | input | result | reason |
 *   |---|---|---|
 *   | no config file, or not an object | `null` | `no-config` |
 *   | `agy.homes` absent | `null` | `absent` |
 *   | `agy.homes` not an object (string, array, number) | `null` | `malformed` |
 *   | `phase` has an entry, non-empty string | that path | `phase` |
 *   | `phase` absent from `homes`, `homes.default` present | the default path | `default` |
 *   | `phase` absent and no `default` | `null` | `absent` |
 *   | the selected value is `""`, `false`, `0`, `null`, a number or an object | `null` | `malformed` |
 *   | the selected value is a relative path | **throw** | \u2014 |
 *
 * There is deliberately NO `rework` row: a rework round dispatches as the
 * implement phase (`runImplementPhase` passes `phase: "implement"` for every
 * round), so it is meant to share `homes.implement`.  A `rework` key would
 * document a home no production caller ever selects, and a phase that is not
 * an entry falls to `default` or `null` — never to another seat's home.
 *
 * A relative path throws rather than resolving: the spawn's cwd is the repo
 * under test, so a relative HOME would silently point somewhere different per
 * dispatch.  The message names the key and the value.
 *
 * @param {object} opts
 * @param {string|null|undefined} [opts.phase] \u2014 the dispatch's phase; a key
 *        into `homes`.
 * @param {object|null|undefined} [opts.config] \u2014 output of
 *        loadAgyHomeConfig().
 * @returns {{ home: string|null, reason: string }}
 * @throws {Error} When the selected value is a relative path.
 */
export function resolveAgyHome({ phase, config }) {
  if (config === null || config === undefined || typeof config !== "object" || Array.isArray(config)) {
    return { home: null, reason: "no-config" };
  }
  const agy = config.agy;
  const homes = (agy === null || typeof agy !== "object" || Array.isArray(agy)) ? undefined : agy.homes;
  if (homes === undefined) return { home: null, reason: "absent" };
  if (homes === null || typeof homes !== "object" || Array.isArray(homes)) {
    return { home: null, reason: "malformed" };
  }

  // Selection: the phase's own entry wins; otherwise `default`.  Presence is
  // what selects; the selected VALUE is validated below, so a present-but-
  // malformed entry reports `malformed`, never a silent fall-through.  An
  // unrecognised or null phase falls to `default` or `null` — never to
  // another seat's home (there is no rework row on purpose, see the doc
  // comment).
  let key;
  let value;
  let reason;
  if (typeof phase === "string" && phase !== "" && Object.hasOwn(homes, phase)) {
    key = phase;
    value = homes[phase];
    reason = "phase";
  } else if (Object.hasOwn(homes, "default")) {
    key = "default";
    value = homes.default;
    reason = "default";
  } else {
    return { home: null, reason: "absent" };
  }

  if (typeof value !== "string" || value === "") {
    return { home: null, reason: "malformed" };
  }
  if (!path.isAbsolute(value)) {
    throw new Error(
      `agy backend: agy.homes.${key} must be an ABSOLUTE path, got "${value}" \u2014 ` +
      "a relative HOME would silently point somewhere different per dispatch " +
      "(the spawn's cwd is the repo under test). Use an absolute path, or " +
      "remove the key to run under the ambient HOME."
    );
  }
  return { home: value, reason };
}

/**
 * The config key that produced a resolved home, for error messages.
 *
 * The resolver's contract is `{ home, reason }`; the key is recoverable from
 * the reason, so it is derived here rather than carried on the record.  Only
 * the two home-producing reasons are ever passed.
 *
 * @param {string} reason \u2014 a `reason` from resolveAgyHome.
 * @param {string|null|undefined} [phase]
 * @returns {string} e.g. `agy.homes.implement`.
 */
export function agyHomeConfigKey(reason, phase) {
  if (reason === "default") return "agy.homes.default";
  return `agy.homes.${typeof phase === "string" ? phase : ""}`;
}

/**
 * The settings.json an agy role's permission table lives in.
 *
 * This is the ONE file this module reads from a role home.  It is derived
 * from HOME and nothing else (measured 2026-09-22), so the same path that
 * the CLI consults is the path this module checks.
 *
 * @param {string} home \u2014 a resolved role home.
 * @returns {string}
 */
export function agyHomeSettingsPath(home) {
  return path.join(home, ".gemini", "antigravity-cli", "settings.json");
}

/**
 * Fail-closed check on a resolved role home, run BEFORE the spawn.
 *
 * When `agy.homes` names a home, kusabi requires that home's permission
 * table to be usable: the settings.json must exist, parse as JSON, and carry
 * `permissions` as an object with `permissions.allow` either absent or an
 * array.  Anything else throws a config-level error (never a failed job):
 * a missing or unreadable role table would silently fall back to the
 * ambient HOME \u2014 the operator's own machine-wide table \u2014 running with
 * MORE access than configured, which is the failure this whole mechanism
 * exists to prevent.  There is deliberately no fallback path.
 *
 * Reading this file is the only filesystem access the HOME mechanism adds;
 * it is a read, and it happens once per dispatch, before anything is
 * spawned.
 *
 * @param {object} opts
 * @param {string} opts.home \u2014 the resolved role home.
 * @param {string|null|undefined} [opts.phase] \u2014 named in the error.
 * @param {string} opts.configKey \u2014 e.g. `agy.homes.implement`, named in the
 *        error so the operator can find the line to fix.
 * @throws {Error} When the table is missing, unparseable, or misshaped.
 */
export function assertAgyHomeSettings({ home, phase, configKey }) {
  const settingsPath = agyHomeSettingsPath(home);
  const phaseName = JSON.stringify(phase ?? null);
  const base = `agy backend: phase ${phaseName} resolves HOME "${home}" from ${configKey}, `;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch (err) {
    throw new Error(
      `${base}but ${settingsPath} is missing or not readable as JSON (${err.message}) \u2014 ` +
      "kusabi refuses rather than falling back to the ambient HOME: a missing role table would " +
      "silently widen the permission surface back to the operator's own machine-wide table. " +
      `Fix the file, or remove ${configKey}.`
    );
  }
  const problem =
    parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
      ? "the file does not parse to a JSON object"
      : (() => {
          const permissions = parsed.permissions;
          if (permissions !== undefined && (permissions === null || typeof permissions !== "object" || Array.isArray(permissions))) {
            return "`permissions` is not an object";
          }
          const allow = permissions === undefined ? undefined : permissions.allow;
          if (allow !== undefined && !Array.isArray(allow)) {
            return "`permissions.allow` is present but not an array";
          }
          return null;
        })();
  if (problem !== null) {
    throw new Error(
      `${base}but ${settingsPath} is not a usable permission table: ${problem}. ` +
      "kusabi refuses rather than falling back to the ambient HOME: a malformed role table would " +
      "silently widen the permission surface back to the operator's own machine-wide table. " +
      `Fix the file, or remove ${configKey}.`
    );
  }
}

// =========================================================================
// denied_actions \u2014 pure
// =========================================================================
//
// Headless agy cannot prompt, so a tool that is not allow-listed is
// auto-denied and the terminal result reports it as `denied_actions` while
// `status` stays SUCCESS and `response` is empty:
//
//   {"status":"SUCCESS","response":"","denied_actions":[{"action":"command",
//    "display_name":"RunCommand"}]}
//
// Without reading that field the result is indistinguishable from "the
// provider returned nothing" (observed 2026-08-22: an implement worker chose
// the host `bash`, was denied, and burned 84 seconds with zero edits).  The
// field is taken DEFENSIVELY: entries may lack `display_name`, and the field
// may be absent entirely on older CLI versions.

/**
 * The denied tool-call names a result reports, as a bare string array.
 *
 * Each entry contributes its `action` when that is a non-empty string,
 * falling back to `display_name` when the action is missing \u2014 a name is
 * better than a dropped entry.  Entries that are not objects, and entries
 * with neither field, are skipped.  Absent or non-array `denied_actions`
 * yields `[]` (older CLI versions).
 *
 * @param {object|null|undefined} parsed \u2014 an agy result object.
 * @returns {string[]}
 */
export function agyDeniedActionNames(parsed) {
  return collectAgyDeniedActions(parsed).map((d) => d.name);
}

/**
 * The structured reading of `denied_actions`: `name` for the record,
 * `label` for the error text (the action with its display name attached).
 *
 * @param {object|null|undefined} parsed
 * @returns {{name: string, label: string}[]}
 */
function collectAgyDeniedActions(parsed) {
  const raw = parsed?.denied_actions;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const action = typeof entry.action === "string" && entry.action.trim() !== "" ? entry.action : null;
    const displayName = typeof entry.display_name === "string" && entry.display_name.trim() !== "" ? entry.display_name : null;
    if (action === null && displayName === null) continue;
    const name = action ?? displayName;
    const label = action !== null && displayName !== null ? `${action} (${displayName})` : name;
    out.push({ name, label });
  }
  return out;
}

/**
 * Identify the MCP tool behind an `mcp` denial by reading agy's own
 * per-conversation SQLite record.
 *
 * WHY this exists.  `denied_actions` carries only the action CLASS: for an
 * MCP call the entry is `{"action":"mcp","display_name":"CallMcpTool"}` —
 * "one MCP call was denied" is known, *which* tool is not, and `cli.log` does
 * not name it either (`soft-denying tool confirmation "CallMcpTool" at step
 * 20`).  The whole point of recording a denial is to fix the allowlist, and
 * the line to add cannot be derived from any of that.  The name does exist,
 * as plaintext inside a protobuf BLOB in agy's conversation database:
 *
 *   <home>/.gemini/antigravity-cli/conversations/<conversation_id>.db
 *
 * whose `steps.step_payload` contains `{"Arguments":{...},"ServerName":
 * "sunaba","ToolName":"sandbox_list_containers",...}`.  Reading it is the
 * ONLY way to turn a class into a fixable line.
 *
 * WHY "last matching row, status ≠ 3".  The rule was derived from measured
 * runs (12 conversations, 2026-09): `status` 3 is a COMPLETED step, while a
 * denied tool step carries 6 or 7.  The LAST tool step is the one that
 * governs — an earlier failure followed by a later success must report
 * null, because that later step belongs to a call the model recovered from,
 * and attributing the denial to it would be a guess.  `status ≠ 3` is
 * deliberately NOT `status ∈ {6, 7}`: the two observed denial statuses are
 * the sample we have seen, not an enumeration we can trust the CLI to stop
 * at, so the rule keys on the one status that is certain (3 = done) rather
 * than on the ones that merely were observed.
 *
 * DEFENSIVE BY CONTRACT.  This is diagnostic enrichment — it must never
 * break the dispatch.  Every failure — missing file, not a database, no
 * `steps` table, no matching row, an unreadable BLOB — returns `null`
 * instead of throwing, and the handle is closed on every path including the
 * failure paths.  Nothing else in the conversation database is read: not
 * prompts, not usage, not metadata.  This lookup exists for denial
 * diagnosis and nothing else.
 *
 * @param {object} opts
 * @param {string} opts.dbPath — the conversation database to read.
 * @returns {{server: string, tool: string}|null}
 */
export function agyDeniedToolFromConversation({ dbPath }) {
  if (typeof dbPath !== "string" || dbPath === "") return null;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    // Missing file, not a SQLite database, unreadable — all the same to
    // the caller: nothing was identified.
    return null;
  }
  try {
    let rows;
    try {
      rows = db.prepare("SELECT idx, status, step_payload FROM steps ORDER BY idx").all();
    } catch {
      // No `steps` table (or an unreadable one): nothing to conclude.
      return null;
    }
    let last = null;
    for (const row of rows) {
      const raw = row.step_payload;
      if (raw === null || raw === undefined) continue;
      // BLOBs come back as Uint8Array; decode as latin1 (each byte is one
      // character, so the ASCII JSON substring inside the protobuf noise is
      // preserved verbatim — this is the "find it inside a blob" path).
      const text =
        typeof raw === "string" ? raw
        : raw instanceof Uint8Array ? Buffer.from(raw).toString("latin1")
        : String(raw);
      const match = text.match(/"ServerName":"([^"]+)","ToolName":"([^"]+)"/);
      if (match !== null) {
        last = { server: match[1], tool: match[2], status: row.status };
      }
    }
    if (last === null) return null;
    // 3 is a completed step.  The last tool step of a run whose denial is
    // NOT this call is exactly that shape — reporting its tool would
    // misattribute the denial (see the "last matching row" note above).
    if (last.status === 3) return null;
    return { server: last.server, tool: last.tool };
  } finally {
    db.close();
  }
}

// =========================================================================
// process — spawn/IO
// =========================================================================

/**
 * Spawn the agy CLI and fold its NDJSON event stream as it arrives.
 *
 * Delegates the mechanical lifecycle (spawn, line framing, timeout, silence
 * watchdog, process-group kill, close handling) to the shared
 * `runBackendProcess` module (kusabi #462).  agy-specific concerns — the
 * parse function for the silence clock, no stdin transport — are wired here.
 *
 * @param {object} opts
 * @param {string} opts.bin
 * @param {string[]} opts.args
 * @param {string} opts.cwd
 * @param {object} [opts.env] — extra environment overrides passed straight
 *        through to `runBackendProcess` (ADDITIVE: merged on top of the
 *        parent env there, never a replacement).  The per-role HOME override
 *        (`agy.homes`, see resolveAgyHome) rides this; when the resolver
 *        returns null the caller passes nothing and the child inherits the
 *        parent env byte-for-byte.  No merging logic lives here — the shared
 *        runner already merges onto `process.env`.
 * @param {number|null} [opts.timeoutS]
 * @param {number|null} [opts.watchdogS]
 * @param {(info: {pid: number}) => void} [opts.onStart]
 * @param {(line: string) => void} [opts.onLine]
 * @param {(event: {kind: "fired", silenceS: number}|{kind: "kill"}) => void}
 *        [opts.onWatchdog]
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string,
 *                     timedOut: boolean, stalled: boolean,
 *                     spawnError: Error|null }>}
 */
export function runAgyProcess({ bin, args, cwd, env, timeoutS, watchdogS, onStart, onLine, onWatchdog }) {
  return runBackendProcess({
    bin, args, cwd, env, timeoutS, watchdogS, onStart, onLine, onWatchdog,
    parseLine: parseAgyStreamLine,
  });
}

// =========================================================================
// agyDispatch — the dispatchWithFallback-shaped entry point
// =========================================================================

/**
 * Dispatch one prompt through the Antigravity CLI in headless mode
 * (`agy -p`).  Same call/return contract as `dispatchWithFallback` and
 * `claudeDispatch`, so kusabi-companion.mjs can substitute it per phase
 * without touching the chain phases.
 *
 * v1 shape with resume (kusabi #316): one model per phase (`explicitModel`
 * or the chain's first route), no tier walk, no capacity fallback, no
 * retry.  A session resumes when the caller establishes its provenance
 * (`sessionProvenance: "agy"` — the job store proved an agy job recorded
 * it); without that signal a session is a config-level error, never a
 * silently resumed `--conversation`.  Every failure mode — spawn error,
 * nonzero exit, unparseable stdout, a payload-less result, timeout —
 * produces a FAILED JOB RECORD whose `error` carries the underlying text;
 * the chain's existing escalate path picks it up.  A config-level error (a
 * session that cannot be resumed, no model resolved, an `agy.homes` entry
 * whose settings.json is unusable) throws BEFORE any job record exists, so
 * it can never leave a stuck "running" record behind.
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} [opts.kind]
 * @param {string} [opts.title]
 * @param {string} [opts.promptText]
 * @param {string|null} [opts.agent]
 * @param {string|null} [opts.phase]
 * @param {string|null|undefined} [opts.session] — resumed via
 *        `--conversation` ONLY when `sessionProvenance` proves it an agy
 *        conversation; see assertNoAgySession.
 * @param {string|null|undefined} [opts.sessionProvenance] — the backend
 *        the caller established from the job store as the creator of
 *        `session`.  The dispatch-level backstop (assertNoAgySession)
 *        requires `"agy"` for any bare-UUID session; a caller that forgets
 *        to establish provenance fails closed here.
 * @param {object|null|undefined} [opts.tools] — deny map.  agy takes no
 *        permission flags, so it is RECORDED as unenforced rather than
 *        applied (see the module header).
 * @param {unknown} [opts.timeoutS] — the raw timeout; resolved ONCE here
 *        (resolveAgyTimeoutS).  A positive finite number arms both bounds
 *        (the outer timer and `--print-timeout`); any other shape — a
 *        string, NaN, zero, negative, Infinity, null, absent — arms
 *        neither (kusabi #328).
 * @param {number} [opts.watchdogS] — the raw silence bound in seconds;
 *        resolved ONCE here (agyWatchdogSeconds, which FLOORS it at
 *        AGY_WATCHDOG_FLOOR_S).  No parsed stream event for the armed
 *        interval kills the process group and the job finishes
 *        `status: "stalled"` (kusabi #332).
 * @param {(string|string[])[]} [opts.tiers]
 * @param {number} [opts.round]
 * @param {number} [opts.tierIndex]
 * @param {string|null} [opts.explicitModel]
 * @returns {Promise<{ job: object, resultText: string, stateDir: string }>}
 */
export async function agyDispatch(opts) {
  // ---- cross-backend / provenance session guard ----
  // Before anything is spawned and before any job record exists: this is a
  // config-level error, not a failed job.  `ses_*` ids are refused on shape
  // alone; a bare UUID is resumed only when the caller established (from
  // the job store, which this module never touches) that an agy job
  // recorded it — assertNoAgySession.
  assertNoAgySession(opts.session, { provenance: opts.sessionProvenance });

  // v1 model selection: explicit model, else the chain's first route.
  // tiers/round/tierIndex are accepted for contract parity but the tier
  // ladder is NOT walked — one model per phase.
  const modelEntry = validateAgyModel(opts.explicitModel || firstRoute(opts.tiers || []));
  if (!modelEntry) {
    throw new Error("agy backend: no model resolved — pass --model or configure models.chain");
  }
  const stateDir = stateDirFor(opts.cwd);

  // ---- pre-flight (still before the job record exists) ----
  const systemPrompt = readAgentSystemPrompt(opts.agent);
  const jsonSchema = agyJsonSchemaFor(opts.agent);
  const promptText = buildAgyPrompt({ systemPrompt, promptText: opts.promptText });
  const bin = agyBin();
  // ---- the ONE per-role HOME decision (kusabi #542) ----
  // agy's permission table is `<HOME>/.gemini/antigravity-cli/settings.json`,
  // derived from HOME and nothing else — so the per-role restriction that the
  // flag-less CLI cannot express IS expressible as a per-role HOME.  Resolve
  // it ONCE here from `agy.homes` (resolveAgyHome); when it resolves to a
  // home, verify that home's settings.json is usable BEFORE anything is
  // spawned, and fail closed (throw, never a failed job) if it is not: a
  // missing role table would silently fall back to the operator's own
  // machine-wide table, running with MORE access than configured.  When it
  // resolves to null the spawn is byte-identical to today's dispatch (no
  // HOME override at all).
  const homeConfig = loadAgyHomeConfig();
  const { home: agyHome, reason: agyHomeReason } = resolveAgyHome({
    phase: opts.phase,
    config: homeConfig,
  });
  if (agyHome !== null) {
    assertAgyHomeSettings({
      home: agyHome,
      phase: opts.phase,
      configKey: agyHomeConfigKey(agyHomeReason, opts.phase),
    });
  }
  // The settings.json the run's HOME will consult — the resolved role home
  // when there is one, else the ambient one.  Named in a denied-run error so
  // the operator is pointed at the exact file to edit.
  const agySettingsPath = agyHome !== null
    ? agyHomeSettingsPath(agyHome)
    : path.join(process.env.HOME || "~", ".gemini", "antigravity-cli", "settings.json");
  // ---- the ONE timeout decision (kusabi #328) ----
  // `timeoutS` is resolved and validated ONCE here, and the SAME value
  // feeds both consumers below: buildAgyArgs (the INNER bound,
  // `--print-timeout`) and runAgyProcess (the OUTER timer).
  // resolveAgyTimeoutS REFUSES every shape that is not a positive finite
  // number (strings, NaN, zero, negatives, Infinity, null, absent) and
  // returns null for them; null arms NEITHER bound.  Half-armed — an outer
  // timer without `--print-timeout`, or the reverse — is impossible,
  // because there is only one resolution and both sites consume it.
  const timeoutS = resolveAgyTimeoutS(opts.timeoutS);
  // ---- the ONE watchdog decision (kusabi #332) ----
  // `watchdogS` is resolved and floored ONCE here, and the SAME value feeds
  // runAgyProcess (the armed interval) and the stall error text, so the two
  // can never disagree about the interval.  agyWatchdogSeconds REFUSES every
  // shape that is not a positive finite number (null arms NO watchdog) and
  // raises any positive value below AGY_WATCHDOG_FLOOR_S up to the floor —
  // the real CLI emits nothing, not even `init`, for the first ~11 seconds
  // of a healthy run (measured 2026-08-20), so a shorter interval would
  // kill correct runs.  The floor is enforced in code, never left to
  // callers passing a sane value.
  const watchdogS = agyWatchdogSeconds(opts.watchdogS);
  // `session` survived assertNoAgySession, so it is either absent or a
  // provenance-proven agy conversation id — the only shape that may become
  // a `--conversation` argument.  `timeoutS` becomes agy's INNER bound
  // (`--print-timeout`) sized so this dispatch's OUTER bound (the timer in
  // runAgyProcess) is the one that fires.
  const args = buildAgyArgs({
    model: modelEntry,
    promptText,
    jsonSchema,
    conversationId: opts.session,
    timeoutS,
  });

  // Deny maps arrive from the chain phases unconditionally; agy cannot
  // enforce them.  Record the names rather than drop them, so a record can
  // never be mistaken for one where the denies applied.
  const unenforcedDenies = Object.entries(opts.tools ?? {})
    .filter(([, allowed]) => allowed === false)
    .map(([name]) => name);

  // ---- job record (opencode-path shape + backend) ----
  const job = {
    id: newJobId(),
    kind: opts.kind || "task",
    title: opts.title || "",
    status: "running",
    backend: AGY_BACKEND,
    sessionID: null,
    // Filled the instant the child exists.  `cancel` runs in another process
    // and this is the only thing that can point it at the spawned CLI: with
    // `sessionID: null` by construction there is no session to abort, so
    // without this the agy backend would have no stop lever at all (the
    // kusabi #209 rule, applied to the third backend).
    process: null,
    cwd: opts.cwd,
    phase: opts.phase ?? null,
    modelEntry,
    modelVariant: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    // The stream is folded while the child runs (kusabi #332): the marker
    // starts `true` because every dispatch this module makes now measures
    // its stream, and the fold below replaces the zeros with measured
    // values as events arrive.  `instrumented: false` keeps its meaning
    // for records written before this change — they are never rewritten.
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
    // The CLI's own `status` field — ADVISORY ONLY.  Success was decided by
    // payload presence (see agyPayload); this records what agy claimed so a
    // reader can see the disagreement rather than infer it.
    agyStatus: null,
    // Deny-map entries this backend cannot enforce (agy takes no permission
    // flags).  Empty array when nothing was asked for.
    toolDeniesUnenforced: unenforcedDenies,
    // The permission surface this run was actually governed by — recorded on
    // EVERY record, exactly like `toolDeniesUnenforced`, so a record can
    // never be ambiguous about which table applied:
    //   agyHome        — the resolved role home, or null (ambient HOME used).
    //   agyHomeReason  — how it was chosen (no-config/absent/malformed/
    //                    phase/default).
    //   agyDeniedActions — tool calls headless agy auto-denied (they were
    //                    not allow-listed); filled from the terminal result,
    //                    [] until then and on every failure before parsing.
    //   agyDeniedTool   — the MCP tool behind an `mcp` denial, `"<server>/
    //                    <tool>"` when identified from the conversation
    //                    record (kusabi #545), null otherwise — including
    //                    when the classes are all non-`mcp` (display_name
    //                    already names those, and the database is never
    //                    consulted for them).
    agyHome,
    agyHomeReason,
    agyDeniedActions: [],
    agyDeniedTool: null,
    // Whether the run's output shape was enforced by `--json-schema`.
    jsonSchemaEnforced: jsonSchema !== null,
    error: null,
    // Terminal-failure classification: always null in v1.  Quota/failure
    // classification beyond the payload rule waits for the first real agy
    // quota failure in the wild (#215's claude classification is the
    // template); guessing at phrases we have never seen would be the false
    // positive that hard-stops a chain.
    failure: null,
    retry: null,
    fallbacks: null,
  };
  saveJob(stateDir, job);
  // prompt.md is written BEFORE the size guard runs, on purpose: the operator
  // of a refused dispatch is the one who most needs to see what was too big.
  fs.writeFileSync(path.join(jobDir(stateDir, job.id), "prompt.md"), promptText, "utf8");

  const progressWatch = startKaibaProgressWatch({ stateDir, jobId: job.id });

  // ---- argv size guard (kusabi #221 residual) ----
  // The last thing before the spawn.  An oversized argument would fail with a
  // raw E2BIG that says nothing about which string was too long or what to do
  // about it; this refuses first and says both.
  //
  // `status: "error"`, NOT `provider-error`: nothing upstream is blocked and
  // no capacity is exhausted.  This is a CALLER error — the same brief would
  // fail identically on the next agy dispatch, so marking it a provider
  // outage would send a retry walk at a wall.  The record is finalised here
  // and NO process is started: `job.process` stays null because there is no
  // child to point `cancel` at.
  const argvSize = checkAgyArgvSize(args);
  if (!argvSize.ok) {
    job.status = "error";
    job.error = argvSize.message;
    job.finishedAt = new Date().toISOString();
    appendEvent(stateDir, job.id, {
      type: "companion.agy.argv-too-large",
      backend: AGY_BACKEND,
      model: modelEntry,
      limit: argvSize.limit,
      // The measured sizes, element by element — what the guard actually saw,
      // so the refusal can be checked rather than taken on faith.
      oversized: argvSize.oversized,
    });
    // Record the closed terminal reason (kusabi #388): an argv-too-large
    // refusal finalises the record here, error -> "unknown".
    job.stopReason = deriveStopReason({ status: job.status, stats: job.stats });
    saveJob(stateDir, job);
    progressWatch.stop();
    return { job, resultText: "", stateDir };
  }

  try {

  appendEvent(stateDir, job.id, {
    type: "companion.agy.dispatch",
    backend: AGY_BACKEND,
    model: modelEntry,
    bin,
    jsonSchemaEnforced: job.jsonSchemaEnforced,
    toolDeniesUnenforced: unenforcedDenies,
    // The permission surface this spawn will run under — written BEFORE the
    // child starts so the trail and the record can never disagree about it.
    agyHome,
    agyHomeReason,
    agyDeniedActions: [],
    // Unknown until the terminal result arrives — null here mirrors the
    // record's initial value so the trail and the record never disagree.
    agyDeniedTool: null,
  });

  // ---- run: fold the NDJSON stream as it arrives (kusabi #332) ----
  // Each complete stdout line is parsed and folded into the accumulator the
  // moment it arrives; `job.stats` is rewritten from the accumulator on
  // every parsed event.  Bounded cadence for the SAVE, not for the fold: a
  // chatty stream must not turn into a write per event, but `kusabi status`
  // still needs to see the record move while the child is running.
  const streamAcc = initAgyStreamAccumulator();
  let lastStatsSaveAt = 0;
  const STATS_SAVE_INTERVAL_MS = 1000;
  const onLine = (rawLine) => {
    const evt = parseAgyStreamLine(rawLine);
    if (evt === null) {
      // Not fatal (the real CLI has been observed printing non-JSON
      // warning lines) — just not countable as a parsed event.
      return;
    }
    applyAgyStreamEvent(streamAcc, evt);
    job.stats = {
      instrumented: true,
      events: streamAcc.events,
      steps: streamAcc.steps,
      lastTool: streamAcc.lastTool,
      permissionsAllowed: 0,
      permissionsRejected: 0,
      lastActivity: streamAcc.lastActivity,
      models: streamAcc.models,
    };
    const now = Date.now();
    if (now - lastStatsSaveAt >= STATS_SAVE_INTERVAL_MS) {
      lastStatsSaveAt = now;
      saveJob(stateDir, job);
    }
  };

  const { code, stdout, stderr, timedOut, stalled, spawnError } = await runAgyProcess({
    bin,
    args,
    cwd: opts.cwd,
    // The resolved role HOME (or nothing when `agy.homes` resolved to null,
    // so the child inherits the parent env byte-for-byte).  runBackendProcess
    // merges this on top of `process.env`, so the override is additive.
    env: agyHome !== null ? { HOME: agyHome } : undefined,
    // The already-resolved values (the TWO decisions above) — the same
    // values buildAgyArgs and the stall text consumed, so every bound was
    // decided together.
    timeoutS,
    watchdogS,
    onStart: ({ pid }) => {
      job.process = { pid, startTime: null, recordedAt: new Date().toISOString() };
      saveJob(stateDir, job);
    },
    onLine,
    // The SAME event types the opencode and claude watchdogs write
    // (prompt-execution.mjs, claude-dispatch.mjs), so stall auditing over
    // events.ndjson is backend-agnostic and finally counts agy stalls too.
    onWatchdog: ({ kind, silenceS }) => {
      if (kind === "fired") {
        appendEvent(stateDir, job.id, { type: "companion.watchdog.fired", silenceS });
      } else {
        appendEvent(stateDir, job.id, { type: "companion.watchdog.kill" });
      }
    },
  });

  job.finishedAt = new Date().toISOString();

  // ---- classification (all failure text preserved on the record) ----
  let payload = null;
  if (spawnError) {
    job.status = "error";
    job.error = `agy dispatch failed: could not start ${bin}: ${spawnError.message}`;
  } else if (stalled) {
    // The silence watchdog killed the group (kusabi #332).  Same `stalled`
    // STATUS and the opencode/claude watchdog's own wording, so a chain
    // treats a stalled agy worker exactly like a stalled opencode/claude
    // one.  The kill always ran (runAgyProcess only sets `stalled` after
    // killProcessGroup), so the wording always names it.  The interval the
    // text names is the ARMED one — the floored value, never what the
    // caller happened to pass.
    job.status = "stalled";
    job.error = `watchdog: no events for ${watchdogS}s (process killed)`;
    // The run stays resumable even though no terminal `result` arrived:
    // the conversation id seen on `init` is the session.
    job.sessionID = streamAcc.conversationIdFromInit ?? null;
  } else if (timedOut) {
    // Same failure status/text the opencode and claude paths use.
    job.status = "timeout";
    // The resolved value — the timer only fires when it is a positive
    // number, so this renders the same number the timer was armed with.
    job.error = `timed out after ${timeoutS}s`;
    // Same resumability rule as the stall path: the init id survives a run
    // the outer bound cut short.
    job.sessionID = streamAcc.conversationIdFromInit ?? null;
  } else {
    // Parse FIRST, exit code second.  The payload rule is about not throwing
    // away completed work on a signal that is not authoritative, and a
    // nonzero exit accompanying a complete payload is the same class of
    // signal as `status: "ERROR"`.  A nonzero exit with NO payload still
    // fails, and its error names the exit code.
    let parsed = null;
    let parseError = null;
    // The terminal payload is the stream's LAST `result` event's inner
    // object — byte-shape-identical to what `--output-format json` used to
    // print (measured 2026-08-20), so every downstream consumer receives
    // the exact object it receives today.  When no terminal `result` event
    // arrived, fall back to the LEGACY single-object reading: a stream that
    // collapses to the old shape (a CLI build that ignores stream-json)
    // still delivers its work; anything else is a failed job whose error
    // names the exit code or the parse failure.
    const resultObj = streamAcc.resultEvent?.result ?? null;
    if (resultObj !== null && typeof resultObj === "object" && !Array.isArray(resultObj)) {
      parsed = resultObj;
    } else {
      try {
        parsed = parseAgyResult(stdout);
      } catch (err) {
        parseError = err;
      }
    }

    if (parsed !== null) {
      job.agyStatus = typeof parsed.status === "string" ? parsed.status : null;
      // The tool calls headless agy auto-denied, taken defensively (entries
      // may lack display_name; the field may be absent on older CLIs).
      job.agyDeniedActions = agyDeniedActionNames(parsed);
      // Denial diagnosis (kusabi #545): an `mcp` class names ONLY the class —
      // which MCP tool was denied is not in the result, nor in cli.log.  The
      // name lives as plaintext inside a protobuf BLOB in agy's conversation
      // database, so when (and ONLY when) `mcp` is among the classes, read
      // that database and record the tool.  The other classes (read_file,
      // read_url, command, write_file, browser) are FULLY NAMED by
      // `display_name`, and the last tool step of such a run belongs to a
      // successful call — consulting the database for them would misattribute
      // the denial.  `agyDeniedTool` is the string `<server>/<tool>` when
      // identified, else null; it is present on every record from the initial
      // write below, exactly like `agyHome`.  The lookup is defensive: any
      // database failure yields null and the dispatch proceeds as today — this
      // is diagnostic enrichment, not a gate, and never changes the terminal
      // decision.
      let deniedToolUnresolved = false;
      if (job.agyDeniedActions.includes("mcp")) {
        const conversationId = parsed.conversation_id ?? streamAcc.conversationIdFromInit ?? null;
        const home = agyHome ?? process.env.HOME ?? null;
        if (conversationId !== null && home !== null) {
          const dbPath = path.join(
            home, ".gemini", "antigravity-cli", "conversations", `${conversationId}.db`,
          );
          const found = agyDeniedToolFromConversation({ dbPath });
          if (found !== null) {
            job.agyDeniedTool = `${found.server}/${found.tool}`;
          } else {
            // An mcp class WAS denied but the tool could not be pinned down.
            // The error must say so rather than let the reader assume the
            // class was all there was.
            deniedToolUnresolved = true;
          }
        } else {
          // No conversation id (or no home at all) — nothing to consult.
          deniedToolUnresolved = true;
        }
      }
      // `settingsPath` is the file this run's HOME would consult — named in a
      // denied-run error so the operator is pointed at the exact table.
      const outcome = agyPayload(parsed, {
        settingsPath: agySettingsPath,
        deniedTool: job.agyDeniedTool,
        deniedToolUnresolved,
      });
      if (outcome.ok) {
        job.status = "completed";
        job.sessionID = parsed.conversation_id ?? streamAcc.conversationIdFromInit ?? null;
        job.payloadSource = outcome.payloadSource;
        payload = outcome;
        job.usage = {
          ...mapAgyUsage(parsed),
          phase: job.phase,
          durationSeconds: durationS(job),
        };
        writeJson(path.join(jobDir(stateDir, job.id), "usage.json"), job.usage);
      } else {
        job.status = "error";
        // The session id is still worth recording: a payload-less run is the
        // one an operator most wants to open in the agy UI.
        job.sessionID = parsed.conversation_id ?? streamAcc.conversationIdFromInit ?? null;
        job.error = `agy dispatch failed: ${outcome.error}`;
      }
    } else if (code !== 0) {
      job.status = "error";
      const detail = (stderr || stdout || "(no output)").trim();
      job.error = `agy exited with code ${code}: ${detail}`;
      job.sessionID = streamAcc.conversationIdFromInit ?? null;
    } else {
      job.status = "error";
      const snippet = (stdout || "").trim().slice(0, 300);
      job.error = `agy dispatch failed: ${parseError.message}: ${snippet || "(empty stdout)"}`;
      job.sessionID = streamAcc.conversationIdFromInit ?? null;
    }
  }

  appendEvent(stateDir, job.id, {
    type: "companion.agy.finished",
    status: job.status,
    // Advisory: what the CLI claimed, next to what kusabi decided from the
    // payload.  Recorded side by side on purpose — the two disagreeing is
    // the normal case for a run with one failed tool call.
    agyStatus: job.agyStatus,
    sessionId: job.sessionID,
    exitCode: code,
    // The tool calls headless agy auto-denied, as measured on this run's
    // terminal result ([] when none, or when the run never produced one).
    agyDeniedActions: job.agyDeniedActions,
    // The MCP tool behind an `mcp` denial, when it could be identified from
    // the conversation record (null otherwise — non-`mcp` denials are fully
    // named by `display_name` and never consult the database).
    agyDeniedTool: job.agyDeniedTool,
  });

  // Record the closed terminal reason (kusabi #388).  agy finalizes its
  // job.json on this path and never calls deriveStopReason via the opencode
  // SSE fold, so stamp here at the terminal write.  worktreeChanged is left
  // unmeasured at job level, matching the opencode path: a completed wrapper
  // records "completed"; error/timeout/stalled fall through to "unknown".
  job.stopReason = deriveStopReason({ status: job.status, stats: job.stats });
  saveJob(stateDir, job);

  let resultText = "";
  if (job.status === "completed" && payload !== null) {
    // `resolveCompletedResult` selects a recovery source by backend and has
    // none for agy (its transcripts are the CLI's own, in a location kusabi
    // does not read): an empty payload therefore records
    // `no-recovery-source-for-backend` instead of pretending to recover.
    // Unreachable in practice — an empty payload is a FAILED job under the
    // payload rule — but the shared path keeps the record shape identical
    // across backends.
    const resolved = resolveCompletedResult({
      backend: AGY_BACKEND,
      fetched: { ok: true, text: payload.text },
      coords: { sessionId: job.sessionID },
    });
    resultText = resolved.text;
    job.result = resolved.record;
    saveJob(stateDir, job);
    fs.writeFileSync(path.join(jobDir(stateDir, job.id), "result.md"), resultText, "utf8");
  }

  return { job, resultText, stateDir };
  } finally {
    progressWatch.stop();
  }
}
