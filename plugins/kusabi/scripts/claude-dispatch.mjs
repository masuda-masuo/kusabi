// claude-dispatch.mjs — Claude Code CLI backend for kusabi job dispatch (kusabi #184).
//
// Backend contract: a function with the SAME call/return shape as
// `dispatchWithFallback` (prompt-execution.mjs): it receives the dispatch
// options object (cwd, kind, title, promptText, agent, phase, session,
// tools, timeoutS, watchdogS, tiers, round, tierIndex, explicitModel) and
// resolves to `{ job, resultText, stateDir }`.  kusabi-companion.mjs picks
// this function instead of dispatchWithFallback when `--backend claude` is
// given; the chain phases stay backend-blind.
//
// v1 limits (deliberate, see docs/design/phase-chain.md §3.5.11):
//   - ONE model per phase: `explicitModel` when given, else the first route
//     of the tiered chain.  No tier ladder, no capacity fallback, no retry
//     walk — a failed dispatch returns a failed job and the chain's existing
//     escalate path handles it.  The whole chain is validated at command
//     start (validateClaudeChain) and chain commands clamp later phases to
//     the command-start model, so the model can never change — or fail —
//     mid-chain.  The default chain is claude-native (CLAUDE_DEFAULT_CHAIN);
//     the opencode built-in chain is never used by this backend.
//   - Per-entry `claude/` prefixes (kusabi #192) are handled UPSTREAM:
//     resolveDispatchBackend (kusabi-companion.mjs) strips the prefix before
//     this module ever sees a chain or model, so claudeDispatch /
//     validateClaudeChain / resolveClaudeModel receive only bare aliases and
//     full model ids — exactly the pre-#192 shapes.  This module is
//     intentionally prefix-unaware.
//   - Session resume: the `session` option is honored \u2014 `--resume
//     <session-id>` is appended to argv, so chain rework rounds, chain-resume,
//     and `--session` / `--resume-last` continue the previous session instead
//     of starting blank.  The session id recorded on the job record comes
//     from the CLI's terminal result event, falling back to the stream's
//     `system`/`init` event when the run died before a result (never from
//     the `session` option); an
//     opencode-shaped session id (`ses_*`) is rejected with a loud
//     cross-backend error before anything is spawned.
//   - `:variant` model suffixes are rejected with an explicit error (never
//     silently ignored): `--allowedTools` has no variant concept and the
//     opencode variant knob has no claude equivalent.
//
// Real event stream (kusabi #215 Job B): the child runs with
// `--output-format stream-json --verbose` (the CLI refuses stream-json
// without --verbose) and stdout is NDJSON, one event object per line — the
// terminal `result` event carries the SAME shape the old `--output-format
// json` single object did, so quota classification and usage mapping apply
// unchanged.  Lines that fail to parse as JSON are skipped and counted,
// never fatal: the real CLI has been observed printing a non-JSON warning
// line ahead of the stream.  `job.stats` is populated from the parsed
// events (events/steps/lastTool/lastActivity/models) and marked
// `instrumented: true`; the on-disk job record is saved at a bounded
// cadence while the child runs, so `kusabi status` shows live movement
// instead of a frozen record.  `instrumented: false` now marks only
// legacy/pre-#215 records — kusabi-companion.mjs's "not instrumented"
// rendering is a reader concession to those, not something this dispatch
// writes anymore.  `watchdogS` is LIVE: no parsed stream event for
// `watchdogS` seconds kills the child's whole process group (the same kill
// `timeoutS` uses) and the job finishes `status: "stalled"`, with the
// opencode watchdog's own wording, so chains treat a stalled claude worker
// exactly like a stalled opencode one.  `timeoutS` is unchanged — an
// absolute wall-clock bound, independent of stream activity.  A stream
// that ends with no terminal `result` event (killed, stalled, crashed)
// still yields a failed job record carrying whatever was learned: the
// session id from `system`/`init` when the CLI got that far, and the stats
// accumulated up to that point.
//
// Pre-dispatch session-quota guard (kusabi #215): before any worker is
// spawned, `claude -p --output-format json "/usage"` is asked how much of the
// account's SESSION window is already spent — a free control-plane call (no
// inference, no tokens, no quota; ~450ms measured).  At or above the
// configured threshold the dispatch is REFUSED before the spawn and the job
// is finalised with the same structured session-quota failure a mid-run
// session limit produces, so the chain's provider-exhaustion stop needs no
// new logic.  The guard fails OPEN in every other case, records what it saw
// on the job record either way, and is off unless the config asks for it
// (see resolveClaudeSessionGuard).
//
// Write-tool watchdog (kusabi #215 item 3): the silence watchdog above only
// asks whether events ARRIVE, so a worker that reads files forever holds it
// off indefinitely — the recorded incident was an implement job that ran
// 256s, cost $2.39 and made zero edits.  On an implement-phase dispatch, and
// only when `claude.writeWatchdog` is configured, a second clock measures the
// time since the last FILE-MUTATING tool call: at `warnS` it warns once
// (`companion.write-watchdog.warned`, also recorded on the job), and at
// `killS` — opt-in on top of the warning, and only when it is later than
// `warnS` — it kills the child's process group exactly as the silence
// watchdog does, finishing the job `status: "stalled"` with its own distinct
// error text.  Off by default, warn-only unless a kill bound is configured,
// never killing on a malformed config, and fail-open throughout (see
// resolveClaudeWriteWatchdog).
// (now in claude-watchdogs.mjs)
//
// Repeat-tool watchdog (kusabi #234): both siblings measure TIME — the
// silence watchdog the time since any parsed event, the write watchdog the
// time since any file-mutating call — so a worker that calls the SAME tool
// with the SAME arguments satisfies both clocks forever (chatty, writing,
// and saying the same thing every time; the neighbour of the recorded #215
// incident).  On an implement-phase dispatch, and only when
// `claude.repeatWatchdog` is configured, a CHAIN counts consecutive
// identical calls — keyed on `(tool name, deep-key-sorted
// JSON.stringify(input))` at the same fold point the write watchdog already
// observes, so it needs no new I/O.  At `threshold` it warns once
// (`companion.repeat-watchdog.warned`, also recorded on the job), and at
// `killThreshold` it kills the child's process group exactly as its siblings
// do, finishing the job `status: "stalled"` with its own distinct error
// text.  Untracked bookkeeping calls are transparent to the chain, denied
// calls count, argument identity is always the FULL normalized string (only
// the event preview is ever truncated), and an invalid config fails LOUDLY
// at load — never off, never a killing configuration the operator did not
// write (see resolveClaudeRepeatWatchdog).
// (now in claude-watchdogs.mjs)
//
// The claude backend adapter, kept lean by a pure-move split (no behaviour
// change): tool permission tables -> tool-permissions.mjs, agent system prompt
// loading -> agent-system-prompt.mjs, the write/repeat watchdog helpers ->
// claude-watchdogs.mjs, and process identity / safe kill -> process-identity.mjs.
// What stays here: model syntax + clamp, arg construction / result parsing,
// terminal quota classification, runClaudeProcess (spawn + the watchdog timers)
// and claudeDispatch — the dispatchWithFallback-shaped entry point resolving to
// `{ job, resultText, stateDir }`, picked by kusabi-companion.mjs for
// `--backend claude`.  v1 limits unchanged (docs/design/phase-chain.md §3.5.11).

import process from "node:process";
import { spawn } from "node:child_process";

import { assertSessionResumable } from "./backend-session-guard.mjs";

import { firstRoute } from "./cli.mjs";
import { newJobId, saveJob, jobDir, appendEvent } from "./job-store.mjs";
import { stateDirFor } from "./state-paths.mjs";
import { killProcessGroup } from "./backend-process-runner.mjs";
import { runBackendDispatch } from "./backend-dispatch-core.mjs";
import {
  claudeMcpSourcePath,
  extractSunabaMcp,
  extractKaibaMcp,
  applyWorkerKaibaIdentity,
  applySunabaProfile,
  writeClaudeMcpConfig,
} from "./claude-mcp.mjs";
import {
  parseClaudeStreamLine,
  initClaudeStreamAccumulator,
  applyClaudeStreamEvent,
} from "./claude-stream.mjs";
import {
  loadClaudeGuardConfig,
  resolveClaudeSessionGuard,
  probeClaudeSessionUsage,
  claudeSessionGuardObservation,
  renderClaudeSessionGuardRefusal,
} from "./claude-session-guard.mjs";
import { readAgentSystemPrompt } from "./agent-system-prompt.mjs";
import {
  eventHasClaudeWriteTool,
  foldClaudeRepeatCalls,
  claudeRepeatChainAdvance,
  claudeRepeatArgsPreview,
  resolveClaudeWriteWatchdog,
  writeWatchdogAppliesToPhase,
  resolveClaudeRepeatWatchdog,
  renderClaudeWriteWatchdogError,
  renderClaudeRepeatWatchdogError,
} from "./claude-watchdogs.mjs";
import { processStartToken } from "./process-identity.mjs";
import { allowedToolsForAgent, applyToolDenies, disallowedToolsForAgent, sunabaProfileForAgent, toolDeniesEnforced } from "./tool-permissions.mjs";

export const CLAUDE_BACKEND = "claude";

// The claude backend's default chain when the config has no models.chain /
// models.phases.<phase> entry.  Claude-native shape (bare aliases): the
// tier ladder is not walked in v1, so the first route is the model every
// phase uses.  The opencode BUILTIN_DEFAULT_CHAIN is deliberately NOT
// reused — its entries are provider/model:variant strings that the claude
// backend rejects, so `--backend claude` must work out of the box with a
// claude-shaped default instead of failing on a model the user never typed.
export const CLAUDE_DEFAULT_CHAIN = [["sonnet"], ["opus"]];

// The binary is resolved through CLAUDE_BIN so tests can point the dispatch
// at a fake `claude` script (mirrors the OPENCODE_BIN pattern in
// serve-lifecycle.mjs).
export function claudeBin() {
  return process.env.CLAUDE_BIN || "claude";
}

// =========================================================================
// model syntax — pure
// =========================================================================

/**
 * Validate a model entry for the claude backend.
 *
 * Accepted: bare alias (`opus`, `sonnet`, `haiku`) or a full model id
 * (e.g. `claude-sonnet-4-5`).  A `:variant` suffix is rejected with an
 * explicit error naming the limitation — it must never be silently ignored.
 *
 * @param {string|null|undefined} value
 * @returns {string|null} The normalized model string, or null when absent.
 * @throws {Error} When the entry carries a `:variant` suffix.
 */
export function validateClaudeModel(value) {
  if (value === undefined || value === null || value === "") return null;
  const v = String(value);
  if (v.indexOf(":") >= 0) {
    throw new Error(
      `claude backend does not support the :variant suffix in model "${v}" — ` +
      "use a bare alias (opus, sonnet, haiku) or a full model id (e.g. claude-sonnet-4-5)"
    );
  }
  return v;
}

/**
 * Validate EVERY route of a (tiered) chain for the claude backend.
 *
 * The chain is handed to claudeDispatch on every phase dispatch, and a
 * rework/strategize/resume round derives its model from it when no
 * explicit model is passed.  Validating the whole chain at command start
 * guarantees a bad (e.g. opencode-shaped) models.chain fails LOUDLY before
 * createChainDir / before any job is dispatched — never mid-flight after
 * round 1 (kusabi #184 finding 1).
 *
 * @param {(string|string[])[]} chain — tiered chain entries.
 * @returns {(string|string[])[]} The chain, unchanged.
 * @throws {Error} Naming the offending entry when any route carries a
 *         `:variant` suffix or is otherwise not a claude model.
 */
export function validateClaudeChain(chain) {
  for (const tier of Array.isArray(chain) ? chain : []) {
    const routes = Array.isArray(tier) ? tier : [tier];
    for (const route of routes) {
      try {
        validateClaudeModel(route);
      } catch (err) {
        throw new Error(
          `claude backend: chain entry "${route}" is not a claude model — ` +
          "configure models.chain with bare aliases (opus, sonnet, haiku) or " +
          `full model ids (e.g. claude-sonnet-4-5): ${err.message}`
        );
      }
    }
  }
  return chain;
}

/**
 * Resolve the model for the claude backend, mirroring `resolveModel`'s
 * precedence (explicit flag → per-phase chain → global chain → built-in
 * default) but with claude model syntax: the entries are passed through
 * verbatim (no `provider/model` split), so bare aliases and full model ids
 * both work.  `claude/`-prefixed entries (kusabi #192) are stripped by
 * resolveDispatchBackend AFTER this returns — the caller is responsible for
 * prefix handling; this mirror stays prefix-unaware.
 *
 * @param {object}   opts
 * @param {string}   [opts.flag]   — `--model` flag value.
 * @param {string}   [opts.phase]  — phase name (for models.phases.<phase>).
 * @param {object}   [opts.config] — loaded kusabi config.
 * @returns {{ model: string|undefined, chain: (string|string[])[] }}
 */
export function resolveClaudeModel({ flag, phase, config }) {
  let chain;
  if (config?.models?.chain) {
    chain = [...config.models.chain];
  } else {
    chain = [...CLAUDE_DEFAULT_CHAIN];
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
// model clamp — one model per phase, never a mid-flight switch
// =========================================================================

/**
 * Wrap a dispatch so phases that pass no explicitModel (rework rounds, the
 * strategist, chain-resume) reuse the command-start model instead of
 * re-deriving the chain's first route.  The claude backend has no tier
 * ladder, so the model must never change mid-chain: a `--model` given at
 * command start stays in force for every phase of the chain (kusabi #184
 * finding 1).  When neither the phase nor `model` supplies one, the value
 * falls through to null and claudeDispatch falls back to the (already
 * command-start-validated) chain's first route.
 *
 * @param {Function} dispatch
 * @param {string|null|undefined} model — the command-start resolved model.
 * @returns {Function} Wrapped dispatch.
 */
export function clampModelDispatch(dispatch, model) {
  return async (opts) => dispatch({ ...opts, explicitModel: opts.explicitModel ?? model ?? null });
}

// =========================================================================
// arg construction + result parsing — pure (contract fixes stay cheap)
// =========================================================================

/**
 * Build the argv for a `claude -p` dispatch.
 *
 * Contract (field-verified, kusabi #184): `claude -p --strict-mcp-config
 * --setting-sources "" --output-format stream-json --verbose --model <m>
 * --allowedTools <csv> --disallowedTools <csv> --mcp-config <path>
 * [--append-system-prompt <agent-body>] [--resume <session-id>]`.  The prompt
 * is NOT on argv (I5) — it is written to the child's stdin, so it cannot leak
 * into `ps` output or argv-logged transcripts, and it is never
 * length-limited by the argv cap.  `--strict-mcp-config` + `--setting-sources
 * ""` (I2) isolate the session from ambient settings: only the generated
 * `--mcp-config` applies, so an MCP tool call without a matching
 * `--allowedTools` entry is blocked (the deny-by-default posture).
 * `--disallowedTools` (I1/I3) is the belt-and-braces deny for tools that must
 * never run.  `--resume <session-id>` is appended when a session is given —
 * a resumed session gets the SAME isolation flags (strict MCP config,
 * allow/deny lists) as a fresh one; resume is a transport detail, not a
 * permission change.
 *
 * @param {object} opts
 * @param {string} opts.model
 * @param {string} opts.allowedTools    — CSV.
 * @param {string} opts.disallowedTools — CSV.
 * @param {string} opts.mcpConfigPath
 * @param {string|null} [opts.systemPrompt]
 * @param {string|null|undefined} [opts.session] — when present, append
 *        `--resume <session>`.  The opencode-shaped `ses_*` guard lives in
 *        claudeDispatch (the single decision point), not here.
 * @returns {string[]}
 */
export function buildClaudeArgs({ model, allowedTools, disallowedTools, mcpConfigPath, systemPrompt, session }) {
  const args = [
    "-p",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--output-format", "stream-json",
    "--verbose",
    "--model", model,
    "--allowedTools", allowedTools,
    "--disallowedTools", disallowedTools,
    "--mcp-config", mcpConfigPath,
  ];
  if (systemPrompt) {
    args.push("--append-system-prompt", systemPrompt);
  }
  if (session) {
    args.push("--resume", session);
  }
  return args;
}

/**
 * Parse the terminal `result` event — the shape `claude -p` prints as its
 * last `--output-format stream-json` line, and as its single
 * `--output-format json` object before kusabi #215 Job B (the two are the
 * same object).  Kept as a pure, exported parse for the legacy single-
 * object call shape and for unit tests; the dispatch itself now takes the
 * result event from the NDJSON stream (applyClaudeStreamEvent) and no
 * longer calls this.
 *
 * Contract shape: `{ type: "result", is_error, result, session_id,
 * usage: { input_tokens, output_tokens, cache_creation_input_tokens,
 * cache_read_input_tokens }, total_cost_usd, duration_ms, num_turns }`.
 *
 * @param {string} stdout
 * @returns {object} The parsed result object.
 * @throws {Error} When stdout is not JSON or not a `result` object.
 */
export function parseClaudeResult(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`claude output is not JSON: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("claude output is not a JSON object");
  }
  if (parsed.type !== "result") {
    throw new Error(`claude output has unexpected type: ${JSON.stringify(parsed.type)}`);
  }
  return parsed;
}

/**
 * Report the final message the CLI handed back, and HOW that went — the same
 * `{ok, text}` / `{ok, error}` shape the opencode path reports from its
 * final-message fetch, so both backends can share `resolveCompletedResult`.
 *
 * The two outcomes this keeps apart:
 *
 *   ok: true  — the CLI's JSON carried a `result`.  An EMPTY one is a real
 *     answer to the question: the run genuinely produced no final message
 *     (it was cancelled, or the model stopped talking mid-analysis).
 *   ok: false — the JSON carried no `result` field at all.  We could not read
 *     the final message, which is the claude-side equivalent of a failed
 *     fetch: the answer may exist, we just did not get it.
 *
 * A non-string `result` keeps its long-standing JSON.stringify rendering so a
 * job that does have a final message writes exactly the bytes it always has.
 *
 * @param {object|null} parsed — output of `parseClaudeResult`.
 * @returns {{ok: true, text: string}|{ok: false, error: string}}
 */
export function claudeFinalMessage(parsed) {
  const result = parsed?.result;
  if (typeof result === "string") return { ok: true, text: result };
  if (result !== null && result !== undefined) return { ok: true, text: JSON.stringify(result) };
  return { ok: false, error: "claude result JSON carried no result field" };
}

/**
 * Map a claude result's usage fields onto the kusabi usage shape
 * (test-asserted mapping):
 *   input_tokens                   → input
 *   output_tokens                  → output
 *   cache_creation_input_tokens    → cacheWrite
 *   cache_read_input_tokens        → cacheRead
 *   total_cost_usd                 → cost
 *
 * @param {object} result
 * @returns {{ available: boolean, input: number, output: number, reasoning: number,
 *             cacheRead: number, cacheWrite: number, cost: number, model: string|null }}
 */
export function mapClaudeUsage(result) {
  const u = result?.usage ?? {};
  return {
    available: true,
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    reasoning: 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cost: result?.total_cost_usd ?? 0,
    model: result?.model ?? null,
  };
}

// =========================================================================
// terminal failure classification — quota exhaustion (kusabi #215)
// =========================================================================
//
// An `is_error: true` result collapses today into a generic `error` job.
// Quota exhaustion needs its own machine-readable classification: a
// *session* limit (HTTP 429 + "session limit" text, real 2026-08-11
// incident job-msnf4qph5ccd) means the WHOLE claude backend is blocked for
// the account window — including the operator's own Claude Code session —
// so retrying, or walking other claude models, is actively wrong; the
// actionable response is switching the phase to the opencode backend
// (a `--model <provider>/<model>` identifier carries its backend, kusabi
// #210).  Other 429 kinds (per-model / per-request rate limits) do not
// imply that.
//
// The classification is STRUCTURED on the job record (`job.failure`) so a
// reader never has to grep prose.  `subtype` is deliberately NOT consulted:
// a terminal payload can carry `subtype: "success"` next to
// `is_error: true` — it must never influence success/failure.
const SESSION_LIMIT_RE = /\bsession[\s_-]?limit\b/i;
// Every alternative is a qualified multi-word phrase on purpose: a bare word
// ("quota", "resets") matches unrelated failure prose — "disk quota exceeded",
// "git reset failed" — and a false positive here does not merely mislabel, it
// flips the job to provider-error and hard-stops the chain.  When in doubt,
// leave the word out: an unclassified quota failure degrades to the generic
// error path, which is survivable.
const QUOTA_TEXT_RE = /\b(session[\s_-]?limit|rate[\s_-]?limit|spend[\s_-]?limit|daily[\s_-]?limit|monthly[\s_-]?limit|limit[\s_-]?(reached|exceeded)|too[\s_-]?many[\s_-]?requests)\b/i;
// The kind said back to the operator must come from the text, never from
// precedence: only an explicit rate-limit phrase may be called "rate".
const RATE_LIMIT_RE = /\b(rate[\s_-]?limit|too[\s_-]?many[\s_-]?requests)\b/i;

/**
 * Classify a terminal (`is_error: true`) claude result payload.
 *
 * Conservative by design: only HTTP 429 (`api_error_status`) or an
 * unambiguous quota phrase in `terminal_reason` / `result` classifies;
 * anything else returns `null` and the job fails exactly as a generic
 * error today.
 *
 * @param {object|null} parsed — output of `parseClaudeResult`.
 * @returns {null | {
 *   kind: "quota-exhaustion",
 *   quota: "session" | "rate" | "unknown",
 *   backendBlocked: boolean,
 *   reset: string | null,
 * }} `null` when the payload carries no quota marker.
 *
 * @param {object} [ctx]
 * @param {{info: object, observedAt: string}|null} [ctx.rateLimit] — the
 *        most recent `rate_limit_event` seen on the stream (kusabi #215 Job
 *        B item 4).  Consulted ONLY as a reset fallback, when the payload
 *        itself names none — payload text always wins when present.
 */
export function classifyClaudeTerminalFailure(parsed, { rateLimit } = {}) {
  if (!parsed || typeof parsed !== "object") return null;
  const is429 = parsed.api_error_status === 429;
  const reason = typeof parsed.terminal_reason === "string" ? parsed.terminal_reason : "";
  const result = typeof parsed.result === "string" ? parsed.result : "";
  const text = `${reason} ${result}`;
  if (!is429 && !QUOTA_TEXT_RE.test(text)) return null;

  const quota = SESSION_LIMIT_RE.test(text)
    ? "session"
    : RATE_LIMIT_RE.test(text)
      ? "rate"
      : "unknown";
  return {
    kind: "quota-exhaustion",
    quota,
    // A session limit blocks the whole claude backend (the operator's own
    // Claude Code session shares the same account window); per-model /
    // per-request rate limits do not.
    backendBlocked: quota === "session",
    reset: extractClaudeQuotaReset(parsed) ?? extractResetFromRateLimitInfo(rateLimit),
  };
}

// Upper bound for a value claiming to be epoch SECONDS: past this it is a
// millisecond epoch (1e12 s already lands in year 33658) or garbage.
const MAX_PLAUSIBLE_RESET_EPOCH_S = 1e12;

/**
 * The reset time from a streamed `rate_limit_event` (kusabi #215 Job B item
 * 4) — the fallback used ONLY when the terminal payload itself names no
 * reset.  `resetsAt` is epoch seconds on the live quota feed; rendered as
 * an ISO timestamp so it prints the same way a structured payload
 * `resetAt` would.  Values that cannot be a sane epoch-seconds timestamp
 * are rejected outright (see below) rather than rendered.
 *
 * @param {{info: object, observedAt: string}|null|undefined} rateLimit
 * @returns {string|null}
 */
function extractResetFromRateLimitInfo(rateLimit) {
  const resetsAt = rateLimit?.info?.resetsAt;
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return null;
  // Plausibility bounds (cross-review of PR #219).  Any finite number used
  // to pass: `0` rendered "1970-01-01T00:00:00.000Z" and a MILLISECOND-epoch
  // value (the same field, wrong unit) rendered year 58579 — both presented
  // to the operator as this quota's reset time.  A reset time we cannot
  // believe is worse than none at all: the operator schedules around it.
  if (resetsAt <= 0 || resetsAt > MAX_PLAUSIBLE_RESET_EPOCH_S) return null;
  return new Date(resetsAt * 1000).toISOString();
}

/**
 * The reset time from the payload: a `resetAt` / `reset` field when the CLI
 * carries one, else the "resets <when>" phrase inside the result text
 * (e.g. "You've hit your session limit · resets 1:20am (Asia/Tokyo)").
 *
 * @param {object|null} parsed
 * @returns {string|null}
 */
function extractClaudeQuotaReset(parsed) {
  for (const key of ["resetAt", "reset"]) {
    if (typeof parsed?.[key] === "string" && parsed[key].trim()) return parsed[key].trim();
  }
  const result = typeof parsed?.result === "string" ? parsed.result : "";
  const m = result.match(/resets?\s+(?:at\s+)?(.+?)(?:[.;!]|$)/i);
  return m ? m[1].trim() : null;
}

/**
 * The operator-facing error text for a classified quota failure.  Says which
 * quota, carries the reset time when the payload had one, and — for the
 * session limit — that the WHOLE claude backend is blocked (including the
 * operator's own Claude Code session) and what to do instead of retrying.
 * The raw CLI result text stays at the front, so no information is lost.
 *
 * @param {{quota: string, reset: string|null}} failure — classification.
 * @param {string} detail — the raw terminal result text.
 * @param {object} [opts]
 * @param {boolean} [opts.resetFromRateFeed] — the reset came from the live
 *        rate feed fallback, not from the payload itself (cross-review of
 *        PR #219).  The two are not equally trustworthy: the payload states
 *        the reset for THIS failure, while the feed's `resetsAt` is the last
 *        window boundary the stream happened to mention, which may belong to
 *        a different limit than the one that just fired.  Rendering both as
 *        a bare "resets X" presents a guess as the provider's own claim, so
 *        the fallback is marked as what it is.
 * @returns {string}
 */
export function renderClaudeQuotaError(failure, detail, { resetFromRateFeed = false } = {}) {
  const resetPart = failure.reset
    ? (resetFromRateFeed
        ? ` (resets ~${failure.reset}, from live rate feed)`
        : ` (resets ${failure.reset})`)
    : "";
  if (failure.quota === "session") {
    return (
      `claude dispatch failed: ${detail} — session limit exhausted${resetPart}: ` +
      "the whole claude backend is blocked, including your own Claude Code " +
      "session (same account window). Switch the phase to the opencode " +
      "backend (--model <provider>/<model>); do not retry claude."
    );
  }
  // "rate" comes from an explicit rate-limit phrase; "unknown" is a bare 429
  // whose kind the classifier could not determine — never assert a kind the
  // classification itself does not claim.  No wording may promise a retry:
  // the chain driver hard-stops on this status, so the honest guidance is
  // re-running after the reset window or switching backend.
  const kindPart = failure.quota === "rate"
    ? "claude rate limit active"
    : "claude quota limit hit (kind unknown)";
  return (
    `claude dispatch failed: ${detail} — ${kindPart}${resetPart}: ` +
    "this dispatch is not retried automatically — re-run after the reset " +
    "window, or switch the phase to the opencode backend " +
    "(--model <provider>/<model>); walking other claude models will not help."
  );
}

/**
 * Spawn `claude -p` and collect its stdout/stderr.  The prompt is written
 * to the child's stdin and the stream is ended (I5) — `claude -p` with no
 * prompt argument reads it from stdin, so the prompt never appears on argv.
 * The child runs in its own process group (detached) and the WHOLE GROUP is
 * killed (SIGKILL) when timeoutS elapses (absolute wall-clock bound) OR when
 * watchdogS elapses with no parsed stream event (silence bound, kusabi #215
 * Job B) — whichever fires first; once either has fired the other's check
 * is a no-op.  A process that deliberately detaches itself (setsid) escapes
 * the group kill — that is the documented v1 limit, everything else dies
 * with either bound.
 *
 * @param {object} opts
 * @param {string} opts.bin
 * @param {string[]} opts.args
 * @param {string} [opts.cwd]
 * @param {number} [opts.timeoutS]
 * @param {number} [opts.watchdogS] — silence bound in seconds; <= 0 disables it.
 * @param {string} [opts.promptText] — written to child stdin, then closed.
 * @param {(proc: {pid: number, startTime: string|null}) => void} [opts.onStart]
 *        — called once, synchronously, as soon as the child exists, with the
 *        pid and the identity token to persist alongside it.  This is the
 *        only moment the pid is knowable, and `cancel` (a different process)
 *        can stop nothing the record does not name (kusabi #209).
 * @param {(line: string) => void} [opts.onLine] — called synchronously for
 *        each complete stdout line (plus a final unterminated one at close),
 *        AS IT ARRIVES — this is what lets the caller fold stats and reset
 *        the silence clock while the child is still running, not only after
 *        it exits.
 * @param {(event: {kind: "fired"|"kill", silenceS?: number}) => void} [opts.onWatchdog]
 *        — called when the silence watchdog fires (`kind: "fired"`, with the
 *        measured silence in seconds) and again once the group kill has been
 *        issued (`kind: "kill"`), in that order.  The caller turns these into
 *        the job's watchdog audit events; only the watchdog path calls it (a
 *        timeout kill is a different failure and reports itself elsewhere).
 * @param {{warnS: number, killS: number|null}|null} [opts.writeWatchdog] — the
 *        write-tool watchdog's resolved bounds (kusabi #215 item 3), or null
 *        (the default) to leave it entirely off.  `killS: null` is warn-only:
 *        the warning is reported and the child is never killed by it.
 * @param {(event: {kind: "warned"|"fired"|"kill", idleS?: number}) => void} [opts.onWriteWatchdog]
 *        — called once with `kind: "warned"` when `warnS` passes with no
 *        write-tool call, and (kill mode only) with `fired` then `kill`
 *        around the group kill, mirroring onWatchdog's pair.
 * @param {{threshold: number, killThreshold: number}|null} [opts.repeatWatchdog] — the
 *        repeat-tool watchdog's resolved thresholds (kusabi #234), or null
 *        (the default) to leave it entirely off.  Both thresholds are
 *        required: a count watchdog has no warn-only shape.
 * @param {(event: {kind: "warned"|"fired"|"kill", tool?: string, count?: number, argsPreview?: string}) => void} [opts.onRepeatWatchdog]
 *        — called with `kind: "warned"` the first time `threshold`
 *        consecutive identical calls arrive (with the repeated tool, the
 *        count, and a truncated args preview), then — kill mode only — with
 *        `fired` and `kill` around the group kill.
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string,
 *                     timedOut: boolean, stalled: boolean, writeStalled: boolean,
 *                     repeatStalled: boolean, spawnError: Error|null }>}
 */
export function runClaudeProcess({ bin, args, cwd, timeoutS, watchdogS, promptText, onStart, onLine, onWatchdog, writeWatchdog = null, onWriteWatchdog, repeatWatchdog = null, onRepeatWatchdog }) {
  return new Promise((resolve) => {
    const spawnedAt = Date.now();
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, KUSABI_WORKER_CONTEXT: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group (session leader): the timeout kill targets the
      // group, so claude's children die with it — no orphaned work keeps
      // running in the shared container after the job is recorded timeout.
      detached: true,
    });
    // Hand the pid and its identity token to the caller before the child can
    // do any work, so a `cancel` issued a second later already has something
    // to aim at.  Wrapped: a failed recording must degrade the stop lever,
    // never take down the dispatch it was meant to protect.
    if (typeof onStart === "function" && child.pid) {
      try { onStart({ pid: child.pid, startTime: processStartToken(child.pid) }); } catch { /* best-effort */ }
    }
    // Prompt transport is stdin (I5).  The error handler is swallowed: a
    // failed spawn surfaces through the child 'error' event (spawnError
    // below), and an EPIPE on the write race would otherwise crash the
    // parent with an unhandled 'error' on the stdin stream.
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(promptText ?? "");
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let stalled = false;
    let writeStalled = false;
    let spawnError = null;
    let lineBuffer = "";
    // The silence clock starts at spawn (kusabi #215 Job B item 3, #619),
    // captured before spawn() so a parent stalled during setup cannot
    // shorten the measured idle.
    let lastEventAt = spawnedAt;
    // The write-tool clock (kusabi #215 item 3, #619).  Starts at spawn, like the
    // silence clock: captured before spawn() so a parent stalled during setup
    // cannot shorten the measured idle.  A worker that never writes anything
    // at all must trip this, not be held off by the absence of a first write to
    // measure from.
    let lastWriteAt = spawnedAt;
    let writeWarned = false;
    // The repeat-tool chain (kusabi #234).  Count-based, so there is no
    // clock and no timer: the chain folds synchronously at line delivery
    // and the kill lands the instant the killThreshold-th identical call
    // arrives.  `repeatChain` remembers the last tracked call's key and how
    // many times it has appeared in a row.
    let repeatChain = null;
    let repeatWarned = false;
    let repeatStalled = false;

    // Delivers one complete NDJSON line to the caller and resets the
    // silence clock the watchdog measures against — the clock starts at
    // spawn (above), not at the first event, so a child that never prints
    // anything at all still trips the watchdog.  Only a PARSED event
    // resets the clock: an unparseable prose line (the real CLI's leading
    // warning) is stream noise, not activity — it must not masquerade as
    // an event and hold the watchdog off (kusabi #215 Job B item 3).
    function deliverLine(line) {
      const parsedLine = parseClaudeStreamLine(line);
      if (parsedLine !== null) lastEventAt = Date.now();
      // The write clock resets ONLY on a file-mutating tool call (kusabi
      // #215 item 3) — reads, searches and execs are exactly what the
      // incident job did all day.  Wrapped: a detection bug must never
      // break line delivery or the silence watchdog that shares this path.
      if (writeWatchdog && parsedLine !== null) {
        try {
          if (eventHasClaudeWriteTool(parsedLine)) lastWriteAt = Date.now();
        } catch { /* fail open: no reset, never a broken stream */ }
      }
      // The repeat-tool chain folds at the SAME parsed-event point the
      // write clock does (kusabi #234): every assistant event's tool_use
      // blocks, in stream order.  Wrapped like the write fold — a detection
      // bug must never break line delivery or the sibling watchdogs that
      // share this path.
      if (repeatWatchdog && parsedLine !== null) {
        try {
          foldClaudeRepeatCalls(parsedLine, (toolName, chainKey) => {
            // Once ANY bound has killed the group the stream is winding
            // down; no further chain work, and no event noise on a run
            // another watchdog already diagnosed.
            if (timedOut || stalled || writeStalled || repeatStalled) return;
            repeatChain = claudeRepeatChainAdvance(repeatChain, chainKey);
            if (!repeatWarned && repeatChain.count >= repeatWatchdog.threshold) {
              // Exactly once per job, like the siblings' warnings: a
              // repeating warning is noise the operator learns to ignore.
              repeatWarned = true;
              notifyRepeatWatchdog({
                kind: "warned",
                tool: toolName,
                count: repeatChain.count,
                argsPreview: claudeRepeatArgsPreview(chainKey),
              });
            }
            if (repeatChain.count >= repeatWatchdog.killThreshold) {
              repeatStalled = true;
              // Measured count here; the configured thresholds ride in the
              // events and the record (the same split the siblings make).
              notifyRepeatWatchdog({ kind: "fired", tool: toolName, count: repeatChain.count });
              killProcessGroup(child);
              notifyRepeatWatchdog({ kind: "kill" });
            }
          });
        } catch { /* fail open: no detection, never a broken stream */ }
      }
      if (typeof onLine === "function") {
        try { onLine(line); } catch { /* a stats-fold bug must not take down the dispatch */ }
      }
    }

    // UTF-8 decoding must be stream-level, not chunk-level: a multibyte
    // character split across two "data" chunks decodes to U+FFFD under
    // per-chunk toString(), corrupting the JSON line it sits in — and a
    // corrupted terminal result line is a lost run (and a lost quota
    // classification).  setEncoding routes chunks through a StringDecoder
    // that holds partial byte sequences back until they complete.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      lineBuffer += chunk;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop(); // last element: an unterminated partial line, or ""
      for (const line of lines) deliverLine(line);
    });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => { spawnError = err; });

    const timer = timeoutS && timeoutS > 0
      ? setTimeout(() => {
          timedOut = true;
          killProcessGroup(child);
        }, timeoutS * 1000)
      : null;
    // Silence watchdog (kusabi #215 Job B): polled rather than a single
    // deadline timer, since the bound restarts on every stream event.
    // 250ms resolution keeps a small test watchdogS tight without adding
    // meaningful overhead against the real multi-minute defaults.
    // Reports each watchdog step to the caller so the stall lands in the
    // job's audit trail AT THE MOMENT it is detected, not after the process
    // has closed and the record is being finalized.  Wrapped: appending to
    // an audit trail must never take down the kill that is the watchdog's
    // actual job — note the "fired" notification runs BEFORE killProcessGroup.
    const notifyWatchdog = (event) => {
      if (typeof onWatchdog !== "function") return;
      try { onWatchdog(event); } catch { /* best-effort audit trail */ }
    };
    const watchdogTimer = watchdogS && watchdogS > 0
      ? setInterval(() => {
          // `writeStalled` and `repeatStalled` join the existing guards for
          // one reason: once a SIBLING watchdog has killed the group the
          // stream stops, so silence would grow and this watchdog would
          // report a stall it did not cause (and overwrite the distinct
          // error text).  With both siblings off, this reads exactly as it
          // did before (kusabi #215 item 3, #234).
          if (timedOut || stalled || writeStalled || repeatStalled) return;
          const silenceMs = Date.now() - lastEventAt;
          if (silenceMs > watchdogS * 1000) {
            stalled = true;
            clearInterval(watchdogTimer);
            // Measured silence, rounded to seconds — the same quantity the
            // opencode watchdog reports, not the configured bound.
            notifyWatchdog({ kind: "fired", silenceS: Math.round(silenceMs / 1000) });
            killProcessGroup(child);
            notifyWatchdog({ kind: "kill" });
          }
        }, 250)
      : null;

    // Write-tool watchdog (kusabi #215 item 3).  A SEPARATE interval from
    // the silence watchdog on purpose: the two measure different clocks, and
    // a fault in this one must not be able to take the silence kill down
    // with it.  Same 250ms resolution, same group kill, and the whole body
    // is wrapped — an exception thrown inside a timer callback is an
    // uncaught exception that would kill the parent process, and this
    // feature's contract is to fail open.
    const notifyWriteWatchdog = (event) => {
      if (typeof onWriteWatchdog !== "function") return;
      try { onWriteWatchdog(event); } catch { /* best-effort audit trail */ }
    };
    const notifyRepeatWatchdog = (event) => {
      if (typeof onRepeatWatchdog !== "function") return;
      try { onRepeatWatchdog(event); } catch { /* best-effort audit trail */ }
    };
    const writeWatchdogTimer = writeWatchdog && writeWatchdog.warnS > 0
      ? setInterval(() => {
          try {
            // `repeatStalled` joins the guards for the same reason
            // `writeStalled` is there: once a sibling has killed the group,
            // this watchdog must not report (or overwrite) a stall it did
            // not cause (kusabi #234).
            if (timedOut || stalled || writeStalled || repeatStalled) return;
            const idleMs = Date.now() - lastWriteAt;
            const idleS = Math.round(idleMs / 1000);
            if (!writeWarned && idleMs > writeWatchdog.warnS * 1000) {
              // Exactly once per job: a repeating warning is noise the
              // operator learns to ignore (and is an explicit non-goal).
              writeWarned = true;
              notifyWriteWatchdog({ kind: "warned", idleS });
            }
            const killS = writeWatchdog.killS;
            if (killS && idleMs > killS * 1000) {
              writeStalled = true;
              clearInterval(writeWatchdogTimer);
              // Measured idle seconds here; the configured bound is what the
              // job's error text names (renderClaudeWriteWatchdogError) —
              // the same split the silence watchdog makes.
              notifyWriteWatchdog({ kind: "fired", idleS });
              killProcessGroup(child);
              notifyWriteWatchdog({ kind: "kill" });
            }
          } catch { /* fail open: never take the dispatch down */ }
        }, 250)
      : null;

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (watchdogTimer) clearInterval(watchdogTimer);
      if (writeWatchdogTimer) clearInterval(writeWatchdogTimer);
      if (lineBuffer) deliverLine(lineBuffer);
      // Final write-clock reading (kusabi #215 item 3).  A polled interval
      // can be beaten to the finish line: when this process is descheduled
      // the child's whole output can arrive buffered together with its exit,
      // and the close callback (poll phase) then clears the interval before
      // the timers phase ever gets to observe the idle time.  The warning is
      // an audit fact about the run, not a property of scheduler luck, so it
      // is evaluated once more here — same condition, same measurement, so
      // this can only emit a warning the interval would have emitted itself.
      // Deliberately AFTER the final line is delivered (a write on the last
      // line still resets the clock) and never on a run some other bound
      // already killed: those carry their own diagnosis.
      if (writeWatchdog && !writeWarned && !writeStalled && !stalled && !repeatStalled && !timedOut) {
        try {
          const idleMs = Date.now() - lastWriteAt;
          if (idleMs > writeWatchdog.warnS * 1000) {
            writeWarned = true;
            notifyWriteWatchdog({ kind: "warned", idleS: Math.round(idleMs / 1000) });
          }
        } catch { /* fail open */ }
      }
      resolve({ code, stdout, stderr, timedOut, stalled, writeStalled, repeatStalled, spawnError });
    });
  });
}

// =========================================================================
// claudeDispatch — the dispatchWithFallback-shaped entry point
// =========================================================================

/**
 * Dispatch one prompt through the official Claude Code CLI in headless mode
 * (`claude -p`).  Same call/return contract as `dispatchWithFallback`
 * (prompt-execution.mjs), so kusabi-companion.mjs can substitute it without
 * touching the chain phases.
 *
 * v1: one model per phase (`explicitModel` or the chain's first route), no
 * tier walk, no capacity fallback, no retry.  The chain is validated in
 * full at command start (validateClaudeChain in resolveDispatchBackend) and
 * the chain commands wrap this dispatch with clampModelDispatch so later
 * rounds reuse the command-start model — the resolution below can therefore
 * never throw mid-chain on a model the user never typed.  Every failure
 * mode — spawn error, nonzero exit, unparseable/garbage stdout, `is_error`
 * result, timeout — produces a failed job record whose `error` carries the
 * underlying text; the chain's existing escalate path picks it up.
 *
 * When the config enables it, the pre-dispatch session-quota guard runs
 * between the job record and the spawn: at or above the threshold the
 * dispatch is refused with a `provider-error` job carrying the session-quota
 * classification and NO worker is started; otherwise what the guard saw is
 * recorded on `job.sessionGuard` and the dispatch continues.  The guard never
 * throws and never refuses on a reading it could not take (kusabi #215).
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} [opts.kind]
 * @param {string} [opts.title]
 * @param {string} [opts.promptText]
 * @param {string|null} [opts.agent]
 * @param {string|null} [opts.phase] — also the write watchdog's gate: it is
 *        armed only for `implement` (which is what every chain rework round
 *        dispatches under), and only when the config configures it.
 * @param {string|null|undefined} [opts.session] — when present, the dispatch
 *        resumes that session via `claude -p --resume <session>` (chain
 *        rework rounds, chain-resume, and `--session` / `--resume-last` all
 *        resolve to this).  An opencode-shaped id (`ses_*`) is rejected with
 *        a cross-backend error before anything is spawned.  The session id
 *        recorded on the job comes from the CLI's JSON result, never from
 *        this option.
 * @param {object|null|undefined} [opts.tools]  — deny map, applied to the
 *        allowlist so explicit denies are never silently ignored (user
 *        flags are translated to mcp__sunaba__* tool names by cmdTask
 *        first; phase-level maps' bare sunaba_* names are normalized
 *        inside applyToolDenies).
 * @param {number} [opts.timeoutS]
 * @param {number} [opts.watchdogS] — silence bound in seconds; no parsed
 *        stream event for this long kills the process group and finishes
 *        the job `status: "stalled"` (kusabi #215 Job B; see runClaudeProcess).
 * @param {(string|string[])[]} [opts.tiers]
 * @param {number} [opts.round]
 * @param {number} [opts.tierIndex]
 * @param {string|null} [opts.explicitModel]
 * @returns {Promise<{ job: object, resultText: string, stateDir: string }>}
 */
export async function claudeDispatch(opts) {
  assertSessionResumable(opts.session, {
    backend: "claude",
    provenance: opts.sessionProvenance,
    detail: "A claude session id and an agy conversation_id are both bare UUIDs, so kusabi passes an id to `claude --resume` only when a claude job recorded it.",
    tail: "a session id that a claude job on this directory recorded",
  });

  // ---- repeat-tool watchdog config (kusabi #234) ----
  // Resolved in PRE-FLIGHT, unlike its two siblings: an invalid
  // `claude.repeatWatchdog` VALUE must fail the dispatch LOUDLY before any
  // job record exists, before anything is written or spawned — a config
  // error is a loud throw, not a stuck "running" record, and never a
  // silently-disarmed watchdog.  Only the config FILE read fails open (the
  // siblings' discipline: reading a settings file must never be the thing
  // that fails a dispatch); an unreadable file is not an invalid VALUE, and
  // every invalid value throws from resolveClaudeRepeatWatchdog below.
  let repeatWatchdog;
  let repeatWatchdogConfig;
  try {
    repeatWatchdogConfig = loadClaudeGuardConfig();
  } catch (err) {
    repeatWatchdogConfig = null;
    repeatWatchdog = {
      enabled: false,
      threshold: null,
      killThreshold: null,
      reason: `config-unreadable: ${err.message}`,
    };
  }
  if (repeatWatchdog === undefined) {
    // May THROW — loudly, and that is the point (see resolveClaudeRepeatWatchdog).
    repeatWatchdog = resolveClaudeRepeatWatchdog(repeatWatchdogConfig);
  }

  // v1 model selection: explicit model, else the chain's first route.
  // tiers/round/tierIndex are accepted for contract parity but the tier
  // ladder is NOT walked — one model per phase.  The fallback route below
  // is only reachable with a chain that command-start validation
  // (validateClaudeChain) already accepted, so it never throws on a
  // :variant suffix here.
  const modelEntry = validateClaudeModel(opts.explicitModel || firstRoute(opts.tiers || []));
  if (!modelEntry) {
    throw new Error("claude backend: no model resolved — pass --model or configure models.chain");
  }
  const stateDir = stateDirFor(opts.cwd);

  // ---- pre-flight (before the job record exists, so a config error is a
  // loud throw, not a stuck "running" record) ----
  // The agent decides the sunaba tool profile: the generated config's URL
  // carries `?profile=<name>` so the session only ever loads that profile's
  // tool definitions (kusabi #274).  Agents with no profile (investigate,
  // anything unknown) keep the full list.  Extraction and validation stay
  // AHEAD of every other pre-flight step: a missing or malformed
  // `mcpServers.sunaba` entry must fail the dispatch loudly before anything
  // is written or spawned (kusabi #276).
  const sunabaEntry = applySunabaProfile(
    extractSunabaMcp(claudeMcpSourcePath()),
    sunabaProfileForAgent(opts.agent),
  );
  // kaiba is OPTIONAL (kusabi #279, #391) — deliberately the opposite of
  // sunaba: a host config without an `mcpServers.kaiba` entry keeps
  // dispatching exactly as it does today (no kaiba in the generated config,
  // no error), while a present entry is rewritten so the worker files
  // conclusions and writes progress under `worker` — never the operator's
  // own registration, whatever KAIBA_AGENT the host entry said — and stamps
  // the minted KAIBA_JOB.  The rewrite comes back on a copy; the source
  // entry is never touched.  Absence is silent, but a present entry that
  // could not be a server entry throws HERE, in pre-flight, before any
  // job record exists — the same fail-loud posture as the sunaba entry
  // (kusabi #279 follow-up).
  const rawKaibaEntry = extractKaibaMcp(claudeMcpSourcePath());
  const systemPrompt = readAgentSystemPrompt(opts.agent);
  const allowedTools = applyToolDenies(allowedToolsForAgent(opts.agent), opts.tools);
  const disallowedTools = disallowedToolsForAgent(opts.agent);
  const unenforcedDenies = [];
  const enforcedDenies = toolDeniesEnforced(opts.tools, unenforcedDenies);
  const bin = claudeBin();
  // The job id is minted here, in pre-flight, so the generated MCP config
  // can be named after its job (kusabi #276) and stamp KAIBA_JOB on the
  // kaiba entry (kusabi #391): the file lives in the job's OWN directory,
  // so two dispatches in the same cwd whose spawn windows overlap each hand
  // their claude process a config file only they write — one dispatch's
  // profile can never overwrite another's.  The write is deliberately the
  // LAST pre-flight step, after every throw-capable check above has passed,
  // so a loud failure never leaves a stray config behind.
  const jobId = newJobId();
  const kaibaEntry = applyWorkerKaibaIdentity(rawKaibaEntry, jobId);
  const mcpConfigPath = writeClaudeMcpConfig(jobDir(stateDir, jobId), sunabaEntry, kaibaEntry);
  const args = buildClaudeArgs({
    model: modelEntry,
    allowedTools,
    disallowedTools,
    mcpConfigPath,
    systemPrompt,
    // Resume: the session (from --session / --resume-last / a chain rework
    // round / chain-resume) becomes `--resume <session-id>` on argv.  The
    // ses_* guard above already rejected opencode-shaped ids; the id
    // recorded on the job comes from the CLI's JSON result (below), never
    // from this option.
    session: opts.session,
  });

  // ---- job record (opencode-path shape + backend) ----
  // `id` was already minted in pre-flight (the generated MCP config is named
  // after the job, kusabi #276); the record is created here, as always, only
  // after every loud pre-flight check has passed.
  const job = {
    id: jobId,
    kind: opts.kind || "task",
    title: opts.title || "",
    status: "running",
    backend: CLAUDE_BACKEND,
    sessionID: null,
    // Filled the instant the child exists (below).  `cancel` runs in another
    // process and this is the only thing that can point it at the spawned
    // CLI: with `sessionID: null` by construction there is no session to
    // abort, so without this the claude backend has no stop lever at all
    // (kusabi #209).
    process: null,
    cwd: opts.cwd,
    phase: opts.phase ?? null,
    modelEntry,
    modelVariant: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    // The child runs `--output-format stream-json --verbose`, so counters
    // here are MEASURED from the parsed event stream, not structural
    // (kusabi #215 Job B).  `instrumented: true` marks every dispatch this
    // module makes from here on; `instrumented: false` now identifies only
    // legacy/pre-#215 records on disk — kusabi-companion.mjs keeps its "not
    // instrumented" rendering for those.  `lastActivity` starts null (no
    // event has arrived yet); the serve-lifecycle idle-reap fallback
    // (`stats.lastActivity ?? startedAt`) covers that gap the same way it
    // always has.
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
    // The most recent `rate_limit_event` observed on the stream (kusabi
    // #215 Job B item 4): `{ info: <rate_limit_info>, observedAt }`, or
    // null when the stream never carried one.  Machine-readable — this is
    // the live quota feed, independent of whether the job ever fails.
    rateLimit: null,
    toolDeniesEnforced: enforcedDenies,
    toolDeniesUnenforced: unenforcedDenies,
    error: null,
    // Terminal-failure classification (kusabi #215): null for generic
    // failures; { kind: "quota-exhaustion", quota, backendBlocked, reset }
    // when the terminal payload was classified.  Machine-readable — never
    // derived by grepping `error` prose.
    failure: null,
    // What the pre-dispatch session-quota guard saw and decided (kusabi
    // #215), or null when the guard was off for this dispatch.  Recorded on
    // EVERY guarded dispatch, refused or not: a refused dispatch must be
    // distinguishable from a mid-run quota death, and a dispatch that ran
    // past the guard must show what it knew — including that it could read
    // nothing.
    sessionGuard: null,
    retry: null,
    fallbacks: null,
  };

  let writeWatchdog;

  const stream = {
    init: () => ({
      streamAcc: initClaudeStreamAccumulator(),
    }),
    onLine: (state, rawLine, j) => {
      const evt = parseClaudeStreamLine(rawLine);
      if (evt === null) {
        // Not fatal (a leading non-JSON warning line has been observed on
        // the real CLI) — just not countable as a parsed event.
        return false;
      }
      applyClaudeStreamEvent(state.streamAcc, evt);
      if (state.streamAcc.sessionIdFromInit) {
        j.sessionID = state.streamAcc.sessionIdFromInit;
      }
      j.stats = {
        instrumented: true,
        events: state.streamAcc.events,
        steps: state.streamAcc.steps,
        lastTool: state.streamAcc.lastTool,
        permissionsAllowed: 0,
        permissionsRejected: 0,
        lastActivity: state.streamAcc.lastActivity,
        models: state.streamAcc.models,
      };
      if (state.streamAcc.rateLimit) j.rateLimit = state.streamAcc.rateLimit;
    },
  };

  return runBackendDispatch({
    stateDir,
    job,
    promptText: opts.promptText || "",
    dispatchEvent: {
      type: "companion.claude.dispatch",
      backend: CLAUDE_BACKEND,
      model: modelEntry,
      bin,
      resume: typeof opts.session === "string" && opts.session !== "",
      toolDeniesEnforced: enforcedDenies,
      toolDeniesUnenforced: unenforcedDenies,
    },
    bin,
    labels: { spawnErrorPrefix: `${CLAUDE_BACKEND} dispatch failed` },
    // Same failure status/text the opencode path uses for timeouts.
    timeoutS: opts.timeoutS,
    // The SAME event types the opencode watchdog writes
    // (prompt-execution.mjs), so stall auditing over events.ndjson is
    // backend-agnostic and finally counts claude stalls too — until now the
    // claude watchdog mirrored opencode's status and wording but left no
    // trace in the trail at all.  There is deliberately no
    // `companion.watchdog.declined-kill` counterpart: that event exists on
    // opencode because a shared serve's pid may not be ours to signal, while
    // this child is ours alone, so the kill always runs.
    //
    // Mirrors the opencode watchdog's own status and wording exactly (kusabi
    // #215 Job B item 3), so a chain treats a stalled claude worker like a
    // stalled opencode one.  The kill always ran (runClaudeProcess only sets
    // `stalled` after killProcessGroup), so the wording always names it —
    // there is no "declined kill" case here, unlike the opencode serve
    // watchdog: this process is ours alone, nothing to verify ownership of.
    watchdogS: opts.watchdogS,
    stream,
    resultBackend: CLAUDE_BACKEND,
    beforeSpawn: async ({ job: j, stateDir: sd }) => {
      // ---- pre-dispatch session-quota guard (kusabi #215) ----
      // Runs AFTER the record exists (so a refusal is a finalised job record with
      // a prompt and an audit trail, not a silent nothing) and BEFORE any worker
      // is spawned — which is the whole point: at a spent session window the
      // spawn is what costs money and takes the operator's own session down with
      // it.  Wrapped end to end: the guard may cost a dispatch its worker, never
      // the dispatch itself.
      let guard;
      try {
        guard = resolveClaudeSessionGuard(loadClaudeGuardConfig());
      } catch (err) {
        // Reading a settings file must never be the thing that fails a dispatch.
        guard = { enabled: false, threshold: null, reason: `config-unreadable: ${err.message}` };
      }
      if (guard.enabled) {
        let probe;
        try {
          probe = await probeClaudeSessionUsage({ bin, cwd: opts.cwd });
        } catch (err) {
          // probeClaudeSessionUsage is written never to reject; if it ever does,
          // that is still not a reason to fail a dispatch.
          probe = { readable: false, percent: null, reset: null, reason: "probe-threw", detail: err.message, elapsedMs: null };
        }
        const observation = claudeSessionGuardObservation(guard, probe);
        j.sessionGuard = observation;
        saveJob(sd, j);
        appendEvent(sd, j.id, { type: "companion.claude.session-guard", ...observation });

        if (observation.decision === "refused") {
          // The SAME structured classification a mid-run session limit produces,
          // so the chain's provider-exhaustion stop and every reader react
          // identically — no new chain logic, no second vocabulary for "the
          // claude backend is blocked".
          const failure = {
            kind: "quota-exhaustion",
            quota: "session",
            backendBlocked: true,
            reset: observation.reset ?? null,
          };
          return {
            status: "provider-error",
            failure,
            error: renderClaudeQuotaError(failure, renderClaudeSessionGuardRefusal(observation)),
            events: [
              {
                type: "companion.claude.dispatch-refused",
                reason: "session-quota-guard",
                percent: observation.percent,
                threshold: observation.threshold,
                reset: observation.reset ?? null,
              },
            ],
          };
        }
      }

      // ---- write-tool watchdog (kusabi #215 item 3) ----
      // Resolved independently of the session guard above (its own config read,
      // its own try/catch): the two guards must not be able to break each other,
      // and this one is the destructive one.  Off unless BOTH the config asks
      // for it and the phase is one whose deliverable is an edit — a review or
      // investigate job legitimately never writes a file.
      try {
        writeWatchdog = resolveClaudeWriteWatchdog(loadClaudeGuardConfig());
      } catch (err) {
        // Reading a settings file must never be the thing that fails a dispatch.
        writeWatchdog = { enabled: false, warnS: null, killS: null, reason: `config-unreadable: ${err.message}` };
      }
      if (writeWatchdog.enabled && !writeWatchdogAppliesToPhase(opts.phase)) {
        writeWatchdog = { enabled: false, warnS: null, killS: null, reason: "phase-not-gated" };
      }
      if (writeWatchdog.enabled) {
        // Recorded ONLY when armed: a dispatch with the feature off must leave a
        // job record byte-identical to the pre-item-3 one (no new key at all).
        j.writeWatchdog = {
          warnS: writeWatchdog.warnS,
          killS: writeWatchdog.killS,
          reason: writeWatchdog.reason,
          warned: false,
          warnedAt: null,
          idleS: null,
          killed: false,
        };
        saveJob(sd, j);
      }

      // ---- repeat-tool watchdog (kusabi #234) ----
      // Config was resolved (and validated) in pre-flight, above.  Here the
      // watchdog is GATED exactly like its siblings: armed only when the config
      // enabled it AND the phase is one whose deliverable is an edit — the same
      // implement-only gate the write watchdog uses (every chain rework round
      // dispatches under "implement").
      if (repeatWatchdog.enabled && !writeWatchdogAppliesToPhase(opts.phase)) {
        repeatWatchdog = { enabled: false, threshold: null, killThreshold: null, reason: "phase-not-gated" };
      }
      if (repeatWatchdog.enabled) {
        // Recorded ONLY when armed: an unarmed dispatch must leave a job record
        // byte-identical to the pre-#234 one (no new key at all).  `count` is
        // the chain length at the last recorded event (the warn, or the kill).
        j.repeatWatchdog = {
          threshold: repeatWatchdog.threshold,
          killThreshold: repeatWatchdog.killThreshold,
          reason: repeatWatchdog.reason,
          warned: false,
          warnedAt: null,
          tool: null,
          count: 0,
        };
        saveJob(sd, j);
      }

      return null;
    },
    runProcess: (hooks) =>
      runClaudeProcess({
        bin,
        args,
        cwd: opts.cwd,
        timeoutS: opts.timeoutS,
        watchdogS: opts.watchdogS,
        promptText: opts.promptText || "",
        ...hooks,
        // Null unless the config armed it AND the phase is one that must edit.
        writeWatchdog: writeWatchdog?.enabled
          ? { warnS: writeWatchdog.warnS, killS: writeWatchdog.killS }
          : null,
        // Naming parity with the silence pair from day one (kusabi #215 finding
        // 4): `companion.write-watchdog.{warned,fired,kill}`, so stall auditing
        // over events.ndjson needs no second vocabulary.  The warn is ALSO put
        // on the job record — a warning nobody can see in `kusabi status` is a
        // warning that changes nothing.
        onWriteWatchdog: ({ kind, idleS }) => {
          if (kind === "warned") {
            // Trail first, record second: this callback is wrapped end to end,
            // so a failing record save must not be able to swallow the audit
            // event that is the warning's whole point.
            appendEvent(stateDir, job.id, {
              type: "companion.write-watchdog.warned",
              idleS,
              warnS: writeWatchdog.warnS,
              killS: writeWatchdog.killS,
              phase: job.phase,
            });
            if (job.writeWatchdog) {
              job.writeWatchdog.warned = true;
              job.writeWatchdog.warnedAt = new Date().toISOString();
              job.writeWatchdog.idleS = idleS;
              saveJob(stateDir, job);
            }
          } else if (kind === "fired") {
            appendEvent(stateDir, job.id, { type: "companion.write-watchdog.fired", idleS, killS: writeWatchdog.killS });
          } else {
            if (job.writeWatchdog) job.writeWatchdog.killed = true;
            appendEvent(stateDir, job.id, { type: "companion.write-watchdog.kill" });
          }
        },
        // Null unless the config armed it AND the phase is one that must edit
        // (resolved in pre-flight, gated above).
        repeatWatchdog: repeatWatchdog?.enabled
          ? { threshold: repeatWatchdog.threshold, killThreshold: repeatWatchdog.killThreshold }
          : null,
        // Naming parity with the two siblings (kusabi #234):
        // `companion.repeat-watchdog.{warned,fired,kill}`, so stall auditing
        // over events.ndjson needs no third vocabulary.  The warn is ALSO put
        // on the job record — a warning nobody can see in `kusabi status` is a
        // warning that changes nothing.
        onRepeatWatchdog: ({ kind, tool, count, argsPreview }) => {
          if (kind === "warned") {
            // Trail first, record second (the write watchdog's discipline): a
            // failing record save must not be able to swallow the audit event
            // that is the warning's whole point.
            appendEvent(stateDir, job.id, {
              type: "companion.repeat-watchdog.warned",
              tool,
              count,
              argsPreview,
              threshold: repeatWatchdog.threshold,
              killThreshold: repeatWatchdog.killThreshold,
              phase: job.phase,
            });
            if (job.repeatWatchdog) {
              job.repeatWatchdog.warned = true;
              job.repeatWatchdog.warnedAt = new Date().toISOString();
              job.repeatWatchdog.tool = tool;
              job.repeatWatchdog.count = count;
              saveJob(stateDir, job);
            }
          } else if (kind === "fired") {
            appendEvent(stateDir, job.id, {
              type: "companion.repeat-watchdog.fired",
              tool,
              count,
              killThreshold: repeatWatchdog.killThreshold,
            });
            // The record's tool/count follow the chain to the kill, so the
            // finalised record shows what actually repeated.
            if (job.repeatWatchdog) {
              job.repeatWatchdog.tool = tool;
              job.repeatWatchdog.count = count;
            }
          } else {
            appendEvent(stateDir, job.id, { type: "companion.repeat-watchdog.kill" });
          }
        },
      }),
    classifyExit: ({ code, stdout, stderr, state, job: j, runResult, streamEvents, malformedLines }) => {
      const { writeStalled, repeatStalled } = runResult || {};
      if (repeatStalled) {
        // The repeat-tool watchdog killed the group (kusabi #234).  Same
        // `stalled` STATUS as both siblings — a chain must treat all three the
        // same way — but a DISTINCT error text, because this failure has its
        // own cause and fix: the worker called one tool with one argument shape
        // over and over, satisfying both time-based clocks the whole way.
        // Checked before the write branch so the kill that actually happened is
        // the one reported (the flags are mutually exclusive by construction:
        // each watchdog sets only its own, and once any of them has killed the
        // group the others' paths go quiet).
        return {
          status: "stalled",
          error: renderClaudeRepeatWatchdogError(
            j.repeatWatchdog?.tool ?? "an unknown tool",
            j.repeatWatchdog?.count ?? 0,
          ),
        };
      }
      if (writeStalled) {
        // The write-tool watchdog killed the group (kusabi #215 item 3).  Same
        // `stalled` STATUS as the silence watchdog — a chain must treat both the
        // same way — but a DISTINCT error text, because the two failures have
        // different causes and different fixes: this one says the worker was
        // busy and producing nothing, not that it went quiet.  Checked BEFORE
        // the silence branch so the kill that actually happened is the one
        // reported.
        return {
          status: "stalled",
          error: renderClaudeWriteWatchdogError(writeWatchdog.killS),
        };
      }
      if (code !== 0 && state.streamAcc.resultEvent?.is_error !== true) {
        // Nonzero exit with nothing to classify: no terminal payload at all, or
        // one that does not itself claim failure.  Generic error, exactly as
        // before.  (A terminal payload that DOES claim failure skips this branch
        // — see the comment on the classification branch below.)
        const detail = (stderr || stdout || "(no output)").trim();
        return {
          status: "error",
          error: `claude exited with code ${code}: ${detail}`,
        };
      }
      if (state.streamAcc.resultEvent === null) {
        // The process exited 0 but the stream never carried a terminal `result`
        // event — garbage output, or a shape this parser does not recognize.
        // Still a failed job, never a stuck "running" record.
        const snippet = stdout.trim().slice(0, 300);
        return {
          status: "error",
          error: `claude stream produced no terminal result event ` +
            `(${streamEvents} parsed, ${malformedLines} unparseable line(s)): ${snippet || "(empty stdout)"}`,
        };
      }

      const parsed = state.streamAcc.resultEvent;
      if (parsed.is_error === true) {
        // Reached on exit 0 AND on a nonzero exit (cross-review of PR #219).
        // The exit code decides nothing this payload does not already say: a
        // terminal event with `is_error: true` names the failure, and whether
        // it is quota exhaustion. Gating the classification on `code === 0`
        // made the provider-exhaustion stop and its operator advice hostage to
        // an exit code the real CLI is not documented to set either way — the
        // one captured session-limit run exited 0, and a future build exiting 1
        // on the same payload would have silently downgraded it to a generic
        // error. The exit code is still recorded (companion.claude.finished).
        //
        // `subtype` is NEVER consulted here: a terminal payload can carry
        // `subtype: "success"` next to `is_error: true` (real 2026-08-11
        // session-limit payload) — the failure signal is is_error alone.
        const failure = classifyClaudeTerminalFailure(parsed, { rateLimit: j.rateLimit });
        const detail = typeof parsed.result === "string" && parsed.result.trim()
          ? parsed.result.trim()
          : "claude reported is_error: true";
        if (failure) {
          // Quota exhaustion gets the provider-error status so the chain's
          // provider-exhaustion stop renders the classification instead of
          // the generic error text (kusabi #215); the error text carries
          // the operator-facing advice (which quota, reset, what to do).
          return {
            status: "provider-error",
            failure,
            error: renderClaudeQuotaError(failure, detail, {
              // Provenance of the reset the classifier settled on: the payload
              // names one, or it fell back to the live rate feed. Asked the same
              // way the classifier asks it, so the two can never disagree.
              resetFromRateFeed: failure.reset !== null && extractClaudeQuotaReset(parsed) === null,
            }),
          };
        }
        // Nonzero exit with stderr/stdout text: keep the CLI's own
        // diagnostic on the record — a terse is_error payload says what
        // happened, not why.  The quota arm never appends it: the
        // classification names the failure and stderr would be noise.
        // Exit-0 rendering is unchanged (this suffix is exit-gated).
        const exitDiagnostic = (stderr || stdout || "").trim();
        return {
          status: "error",
          failure: null,
          error: code !== 0 && exitDiagnostic
            ? `claude dispatch failed: ${detail} (exited with code ${code}: ${exitDiagnostic})`
            : `claude dispatch failed: ${detail}`,
        };
      }

      // A run can end with no final message and the whole output still on disk
      // — for this backend in Claude Code's own transcript, since `claude -p`
      // is a child process and there is no stream of ours to record.  Recover
      // from it (deterministically, no LLM, no extra request) rather than write
      // an empty result.md (result-recovery.mjs).
      return {
        status: "completed",
        sessionID: parsed.session_id ?? null,
        usage: mapClaudeUsage(parsed),
        fetched: claudeFinalMessage(parsed),
      };
    },
    // A stream that never reached (or never carried) a terminal `result`
    // event still leaves whatever `system`/`init` reported — the only source
    // of a session id when nothing else names one (kusabi #215 Job B item 5).
    fallbackSessionId: ({ state }) => state.streamAcc.sessionIdFromInit ?? null,
    finishedEvent: ({ state, job: j, code }) => {
      const result = state.streamAcc.resultEvent?.result;
      return {
        type: "companion.claude.finished",
        status: j.status,
        sessionId: j.sessionID,
        exitCode: code,
        assistantChars: typeof result === "string" ? result.length : 0,
      };
    },
  });
}
