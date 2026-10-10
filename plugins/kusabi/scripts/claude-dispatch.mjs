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
// One model per phase; upstream resolves prefixes and validates/clamps the chain.
// Resume records the CLI-reported session id and rejects cross-backend ids.
// Silence, write, and repeat watchdogs have distinct stall diagnoses.
// The session guard fails open except for a measured threshold refusal.
// Rationale: docs/design/backend-dispatch.md#claude-quota-and-watchdogs
// Repeat-call identity uses full deep-key-sorted inputs; denied calls count.
// Untracked bookkeeping calls are transparent to the repeat chain (kusabi #234).
// stream-json requires --verbose; malformed lines are counted and skipped.
// Parsed events drive measured stats and bounded-cadence saves while the child runs.

import process from "node:process";

import { assertSessionResumable } from "./backend-session-guard.mjs";

import { firstRoute } from "./cli.mjs";
import { newJobId, saveJob, jobDir, appendEvent } from "./job-store.mjs";
import { stateDirFor } from "./state-paths.mjs";
import { resolveBoundS, runBackendProcess } from "./backend-process-runner.mjs";
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
import { allowedToolsForAgent, applyToolDenies, disallowedToolsForAgent, sunabaProfileForAgent, toolDeniesEnforced } from "./tool-permissions.mjs";

export const CLAUDE_BACKEND = "claude";

// Claude-native default: the first route is used; no tier ladder is walked.
// Rationale: docs/design/backend-dispatch.md#claude-model-selection
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
 * Parse a terminal result object from stream-json or single-object JSON.
 * The dispatch folds NDJSON through applyClaudeStreamEvent; this pure parser
 * supports the single-object call shape and unit tests.
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
 * Non-string results use JSON.stringify so their final-message bytes are preserved.
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
 * @returns {{ available: boolean, input: number|null, output: number|null, reasoning: number|null,
 *             cacheRead: number|null, cacheWrite: number|null, total: number|null, cost: number|null,
 *             model: string|null }}
 */
export function mapClaudeUsage(result) {
  const u = result?.usage ?? {};
  return {
    available: true,
    input: typeof u.input_tokens === "number" ? u.input_tokens : null,
    output: typeof u.output_tokens === "number" ? u.output_tokens : null,
    reasoning: null,
    cacheRead: typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : null,
    cacheWrite: typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : null,
    total: typeof u.total_tokens === "number" ? u.total_tokens : (typeof result?.total_tokens === "number" ? result.total_tokens : null),
    cost: typeof result?.total_cost_usd === "number" ? result.total_cost_usd : (typeof u.total_cost_usd === "number" ? u.total_cost_usd : null),
    model: result?.model ?? null,
  };
}

// =========================================================================
// terminal failure classification — quota exhaustion (kusabi #215)
// =========================================================================
//
// Session quota blocks the account across Claude models; other 429 kinds do not.
// Classification is structured on job.failure, never inferred from subtype.
// Rationale: docs/design/backend-dispatch.md#claude-quota-and-watchdogs
const SESSION_LIMIT_RE = /\bsession[\s_-]?limit\b/i;
// Qualified phrases avoid false positives that hard-stop a viable chain.
// Rationale: docs/design/backend-dispatch.md#claude-quota-and-watchdogs
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
  // Reject implausible seconds: a misleading reset time is worse than none.
  // (kusabi #219)
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
 * @param {number|null} [opts.timeoutS] — absolute wall-clock bound in seconds;
 *        arms only when isUsableTimeoutS holds (positive finite number).
 * @param {number|null} [opts.watchdogS] — silence bound in seconds; arms
 *        only when isUsableTimeoutS holds (positive finite number).
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
export async function runClaudeProcess({
  bin,
  args,
  cwd,
  timeoutS,
  watchdogS,
  promptText,
  onStart,
  onLine,
  onWatchdog,
  writeWatchdog = null,
  onWriteWatchdog,
  repeatWatchdog = null,
  onRepeatWatchdog,
  env,
}) {
  let writeStalled = false;
  let repeatStalled = false;

  const notifyWriteWatchdog = (event) => {
    if (typeof onWriteWatchdog !== "function") return;
    try { onWriteWatchdog(event); } catch { /* best-effort audit trail */ }
  };
  const notifyRepeatWatchdog = (event) => {
    if (typeof onRepeatWatchdog !== "function") return;
    try { onRepeatWatchdog(event); } catch { /* best-effort audit trail */ }
  };

  const result = await runBackendProcess({
    bin,
    args,
    cwd,
    env,
    timeoutS,
    watchdogS,
    promptText: promptText ?? "",
    onStart,
    onLine,
    onWatchdog,
    parseLine: parseClaudeStreamLine,
    extend: (ctl) => {
      // The write-tool clock (kusabi #215 item 3, #619).  Starts at spawn, like the
      // silence clock: captured before spawn() so a parent stalled during setup
      // cannot shorten the measured idle.  A worker that never writes anything
      // at all must trip this, not be held off by the absence of a first write to
      // measure from.
      let lastWriteAt = ctl.spawnedAt;
      let writeWarned = false;

      // The repeat-tool chain (kusabi #234).  Count-based, so there is no
      // clock and no timer: the chain folds synchronously at line delivery
      // and the kill lands the instant the killThreshold-th identical call
      // arrives.  `repeatChain` remembers the last tracked call's key and how
      // many times it has appeared in a row.
      let repeatChain = null;
      let repeatWarned = false;

      // Separate, fail-open timer: a write-watchdog fault must not break silence kill.
      // Rationale: docs/design/backend-dispatch.md#claude-quota-and-watchdogs
      const writeWatchdogTimer = writeWatchdog && writeWatchdog.warnS > 0
        ? ctl.addInterval(() => {
            try {
              // `repeatStalled` joins the guards for the same reason
              // `writeStalled` is there: once a sibling has killed the group,
              // this watchdog must not report (or overwrite) a stall it did
              // not cause (kusabi #234).
              if (ctl.isKilled() || writeStalled || repeatStalled) return;
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
                ctl.clearInterval(writeWatchdogTimer);
                // Measured idle seconds here; the configured bound is what the
                // job's error text names (renderClaudeWriteWatchdogError) —
                // the same split the silence watchdog makes.
                notifyWriteWatchdog({ kind: "fired", idleS });
                ctl.kill();
                notifyWriteWatchdog({ kind: "kill" });
              }
            } catch { /* fail open: never take the dispatch down */ }
          }, 250)
        : null;

      return {
        onParsed(parsedLine) {
          // Only file-mutating calls reset this clock; detection fails open (kusabi #215).
          if (writeWatchdog) {
            try {
              if (eventHasClaudeWriteTool(parsedLine)) lastWriteAt = Date.now();
            } catch { /* fail open: no reset, never a broken stream */ }
          }
          // The repeat-tool chain folds at the SAME parsed-event point the
          // write clock does (kusabi #234): every assistant event's tool_use
          // blocks, in stream order.  Wrapped like the write fold — a detection
          // bug must never break line delivery or the sibling watchdogs that
          // share this path.
          if (repeatWatchdog) {
            try {
              foldClaudeRepeatCalls(parsedLine, (toolName, chainKey) => {
                // Once ANY bound has killed the group the stream is winding
                // down; no further chain work, and no event noise on a run
                // another watchdog already diagnosed.
                if (ctl.isKilled() || writeStalled || repeatStalled) return;
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
                  ctl.kill();
                  notifyRepeatWatchdog({ kind: "kill" });
                }
              });
            } catch { /* fail open: no detection, never a broken stream */ }
          }
        },
        onClose() {
          // Check idle once more after final line delivery, before close clears timers.
          // Skip runs already diagnosed by another bound.
          // Rationale: docs/design/backend-dispatch.md#claude-quota-and-watchdogs
          if (writeWatchdog && !writeWarned && !writeStalled && !repeatStalled && !ctl.isKilled()) {
            try {
              const idleMs = Date.now() - lastWriteAt;
              if (idleMs > writeWatchdog.warnS * 1000) {
                writeWarned = true;
                notifyWriteWatchdog({ kind: "warned", idleS: Math.round(idleMs / 1000) });
              }
            } catch { /* fail open */ }
          }
        },
      };
    },
  });

  return {
    ...result,
    writeStalled,
    repeatStalled,
  };
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

  // Invalid repeat-watchdog values throw before any job record or spawn.
  // Only an unreadable config file fails open (kusabi #234).
  // Rationale: docs/design/backend-dispatch.md#claude-preflight
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
  // tool definitions (kusabi #274).  Agents with no profile (anything
  // unknown) keep the full list.  Extraction and validation stay
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
  const timeoutS = resolveBoundS(opts.timeoutS);
  const watchdogS = resolveBoundS(opts.watchdogS);
  // Each job owns its MCP config, preventing overlapping dispatches overwriting it.
  // Write only after all throw-capable preflight checks pass (kusabi #276, #391).
  // Rationale: docs/design/backend-dispatch.md#claude-preflight
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
    // Counters are measured from parsed events; lastActivity is null until the first.
    // Idle reaping falls back to startedAt while no event has arrived (kusabi #215).
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
    timeoutS,
    // Shared watchdog event types/status/text keep stall auditing backend-agnostic.
    // This child is ours alone: there is no declined-kill case.
    // Rationale: docs/design/backend-dispatch.md#claude-quota-and-watchdogs
    watchdogS,
    stream,
    resultBackend: CLAUDE_BACKEND,
    beforeSpawn: async ({ job: j, stateDir: sd }) => {
      // Probe after recording the job/prompt and before spending quota on a worker.
      // The guard is fail-open; refusals remain finalised, auditable jobs (kusabi #215).
      // Rationale: docs/design/backend-dispatch.md#claude-quota-and-watchdogs
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
      // for it and the phase is one whose deliverable is an edit — a review
      // job legitimately never writes a file.
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
        // Add the watchdog key only when armed; disabled dispatches carry no new key.
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
        // Add the watchdog key only when armed; count tracks the last warn/kill event.
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
        timeoutS,
        watchdogS,
        promptText: opts.promptText || "",
        ...hooks,
        // Null unless the config armed it AND the phase is one that must edit.
        writeWatchdog: writeWatchdog?.enabled
          ? { warnS: writeWatchdog.warnS, killS: writeWatchdog.killS }
          : null,
        // Shared audit vocabulary; also persist warnings for kusabi status (kusabi #215).
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
        // Shared audit vocabulary; also persist warnings for kusabi status (kusabi #234).
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
        // Classify is_error on any exit code; subtype never overrides that signal.
        // (kusabi #219)
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
