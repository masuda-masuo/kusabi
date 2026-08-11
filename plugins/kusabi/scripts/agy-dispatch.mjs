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
//   agy -p <prompt> --output-format json --model <id> [--json-schema <schema>]
//
// and a single JSON object on stdout:
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
//   - FRESH DISPATCH ONLY.  `conversation_id` is recorded as the job's
//     `sessionID`, but nothing resumes it: `--session` / `--resume-last`
//     against an agy dispatch are rejected up front (kusabi-companion.mjs
//     consults `backendSupportsResume`), and the chain seams never
//     manufacture a session for a backend that cannot use one.  This module
//     keeps its own defensive guard for both shapes an id can arrive in.
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
//   - No event stream: `--output-format json` prints one object at the end,
//     so there is nothing to measure silence against.  `job.stats` is marked
//     `instrumented: false` (the same marker pre-#215 claude records carry,
//     which every reader already handles) and `watchdogS` is not applicable
//     — `timeoutS`, an absolute wall-clock bound, is the only bound.
//   - A BRIEF HAS A HARD CEILING HERE that the other backends do not have.
//     The prompt rides argv, and Linux caps a single argv string at
//     MAX_ARG_STRLEN (131072 bytes); past it the spawn fails with E2BIG.
//     `checkAgyArgvSize` refuses such a dispatch before the spawn with an
//     error that names the oversized element and the way out, rather than
//     letting a raw errno surface as a generic dispatch failure.  It is a
//     caller error (`status: "error"`), not a provider outage.
//   - Per-job tool permissions cannot be expressed: agy takes no allow/deny
//     flags.  A deny map that reaches this dispatch (the chain phases pass
//     implementDenyTools / reviewDenyTools unconditionally) is recorded on
//     the job record as `toolDeniesUnenforced` rather than silently dropped;
//     an operator-typed `--read-only` / `--deny` is rejected at command
//     start instead (kusabi-companion.mjs), because a restriction that
//     cannot be applied must never look applied.
//
// ---------------------------------------------------------------------------
// Assumptions this module makes and does NOT manage
// ---------------------------------------------------------------------------
// agy reaches sandbox containers through the sunaba MCP server, configured
// GLOBALLY in `~/.gemini/antigravity-cli/mcp_config.json` — the same route
// Claude Code uses.  That file is the operator's; this dispatch neither
// writes, validates, nor overrides it (contrast the claude backend, which
// generates its own `--mcp-config`).  If sunaba is not configured there, the
// worker simply has no container tools and says so in its own output.

import path from "node:path";
import fs from "node:fs";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { firstRoute } from "./cli.mjs";
import { readAgentSystemPrompt } from "./claude-dispatch.mjs";
import { newJobId, saveJob, jobDir, appendEvent } from "./job-store.mjs";
import { stateDirFor, writeJson } from "./state-paths.mjs";
import { durationS } from "./render.mjs";
import { resolveCompletedResult } from "./result-recovery.mjs";

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

/**
 * Build the argv for an `agy -p` dispatch.
 *
 * Contract (field-verified, kusabi #199):
 * `agy -p <prompt> --output-format json --model <id> [--json-schema <schema>]`
 * — and NOTHING else.  Every flag here appears in that contract; no flag is
 * invented, and `--dangerously-skip-permissions` is never passed (not
 * needed, and blocked by the orchestrator-side classifier).
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
 * @returns {string[]}
 */
export function buildAgyArgs({ model, promptText, jsonSchema }) {
  const args = [
    "-p", promptText ?? "",
    "--output-format", "json",
    "--model", model,
  ];
  if (jsonSchema) {
    args.push("--json-schema", jsonSchema);
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
 * Parse the single JSON object `agy --output-format json` prints on stdout.
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
 *     the shape that arrived rather than guess at it.
 *
 * When both are present, `response` wins: it is the text the review-parsing
 * path already knows how to read (a schema-enforced run puts clean JSON
 * there, which `extractJson` parses trivially — there is deliberately no
 * second parsing path).  `structured_output` is the fallback for the run
 * that filled the schema but printed nothing.
 *
 * @param {object|null} parsed — output of `parseAgyResult`.
 * @returns {{ok: true, text: string, payloadSource: "response"|"structured_output"}
 *          |{ok: false, error: string}}
 */
export function agyPayload(parsed) {
  const response = parsed?.response;
  if (typeof response === "string" && response.trim() !== "") {
    return { ok: true, text: response, payloadSource: "response" };
  }
  const structured = parsed?.structured_output;
  if (structured !== null && structured !== undefined) {
    return { ok: true, text: JSON.stringify(structured), payloadSource: "structured_output" };
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
 * Two shapes, one rule ("a session belongs to the backend that made it"):
 *
 *   - `ses_*` — an opencode session id.  Shape alone decides it, which is
 *     the same guard `claudeDispatch` has had since kusabi #184; kusabi #199
 *     makes it SYMMETRIC so an opencode id cannot reach agy either.
 *   - anything else (an agy `conversation_id` is a bare UUID, and so is a
 *     claude session id — shape cannot tell them apart) — rejected because
 *     v1 is fresh-dispatch only: there is no resume to attempt.  The
 *     PROVENANCE check that distinguishes an agy UUID from a claude one runs
 *     where the job store is in hand (kusabi-companion.mjs); this is the
 *     backstop that cannot be bypassed by a caller who skips it.
 *
 * @param {string|null|undefined} session
 * @throws {Error} When a session was given.
 */
export function assertNoAgySession(session) {
  if (typeof session !== "string" || session === "") return;
  if (session.startsWith("ses_")) {
    throw new Error(
      `opencode session ${session} cannot be resumed on the agy backend — ` +
      "ses_* session ids belong to opencode; run the command without --backend agy " +
      "(or drop --session / --resume-last)"
    );
  }
  throw new Error(
    `session ${session} cannot be resumed on the agy backend — ` +
    "the agy backend is fresh-dispatch only in v1 (kusabi #199): it records the CLI's " +
    "conversation_id on the job record but cannot continue one. Drop --session / --resume-last, " +
    "or run the phase on the opencode or claude backend, which do resume"
  );
}

// =========================================================================
// process — spawn/IO
// =========================================================================

/**
 * Kill the child's whole process group.  agy spawns MCP servers and tool
 * subprocesses of its own; signalling only the direct child leaves those
 * running against the shared container after the job record says timeout.
 *
 * @param {import("node:child_process").ChildProcess} child
 */
function killProcessGroup(child) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The group may already be gone; fall back to the direct child.
    try { child.kill("SIGKILL"); } catch { /* already dead */ }
  }
}

/**
 * Spawn the agy CLI and collect its single JSON object.
 *
 * There is no stream to fold, so this is deliberately much smaller than
 * `runClaudeProcess`: one absolute `timeoutS` bound and a process-group
 * kill.  A silence watchdog is NOT implemented rather than faked — with
 * `--output-format json` nothing arrives until the end, so any silence
 * measurement would be measuring the normal case.
 *
 * @param {object} opts
 * @param {string} opts.bin
 * @param {string[]} opts.args
 * @param {string} opts.cwd
 * @param {number} [opts.timeoutS]
 * @param {(info: {pid: number}) => void} [opts.onStart] — called with the
 *        child's pid the instant it exists, so `cancel` has a lever.
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string,
 *                     timedOut: boolean, spawnError: Error|null }>}
 */
export function runAgyProcess({ bin, args, cwd, timeoutS, onStart }) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, KUSABI_WORKER_CONTEXT: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group (session leader): the timeout kill targets the
      // group, so agy's children die with it.
      detached: true,
    });
    if (typeof onStart === "function" && child.pid) {
      try { onStart({ pid: child.pid }); } catch { /* best-effort */ }
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError = null;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => { spawnError = err; });

    const timer = timeoutS && timeoutS > 0
      ? setTimeout(() => {
          timedOut = true;
          killProcessGroup(child);
        }, timeoutS * 1000)
      : null;

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, spawnError });
    });
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
 * v1: one model per phase (`explicitModel` or the chain's first route), no
 * tier walk, no capacity fallback, no retry, no resume.  Every failure mode
 * — spawn error, nonzero exit, unparseable stdout, a payload-less result,
 * timeout — produces a FAILED JOB RECORD whose `error` carries the
 * underlying text; the chain's existing escalate path picks it up.  A
 * config-level error (a session that cannot be resumed, no model resolved)
 * throws BEFORE any job record exists, so it can never leave a stuck
 * "running" record behind.
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} [opts.kind]
 * @param {string} [opts.title]
 * @param {string} [opts.promptText]
 * @param {string|null} [opts.agent]
 * @param {string|null} [opts.phase]
 * @param {string|null|undefined} [opts.session] — rejected; see
 *        assertNoAgySession.
 * @param {object|null|undefined} [opts.tools] — deny map.  agy takes no
 *        permission flags, so it is RECORDED as unenforced rather than
 *        applied (see the module header).
 * @param {number} [opts.timeoutS]
 * @param {number} [opts.watchdogS] — accepted for contract parity; not
 *        applicable (no event stream to measure silence against).
 * @param {(string|string[])[]} [opts.tiers]
 * @param {number} [opts.round]
 * @param {number} [opts.tierIndex]
 * @param {string|null} [opts.explicitModel]
 * @returns {Promise<{ job: object, resultText: string, stateDir: string }>}
 */
export async function agyDispatch(opts) {
  // ---- cross-backend / no-resume session guard ----
  // Before anything is spawned and before any job record exists: this is a
  // config-level error, not a failed job.
  assertNoAgySession(opts.session);

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
  const args = buildAgyArgs({ model: modelEntry, promptText, jsonSchema });

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
    // No event stream (`--output-format json`), so these counters are
    // structural, not measured — the same marker pre-#215 claude records
    // carry, which `kusabi status` already renders as "not instrumented".
    stats: {
      instrumented: false,
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
    saveJob(stateDir, job);
    return { job, resultText: "", stateDir };
  }

  appendEvent(stateDir, job.id, {
    type: "companion.agy.dispatch",
    backend: AGY_BACKEND,
    model: modelEntry,
    bin,
    jsonSchemaEnforced: job.jsonSchemaEnforced,
    toolDeniesUnenforced: unenforcedDenies,
  });

  const { code, stdout, stderr, timedOut, spawnError } = await runAgyProcess({
    bin,
    args,
    cwd: opts.cwd,
    timeoutS: opts.timeoutS,
    onStart: ({ pid }) => {
      job.process = { pid, startTime: null, recordedAt: new Date().toISOString() };
      saveJob(stateDir, job);
    },
  });

  job.finishedAt = new Date().toISOString();

  // ---- classification (all failure text preserved on the record) ----
  let payload = null;
  if (spawnError) {
    job.status = "error";
    job.error = `agy dispatch failed: could not start ${bin}: ${spawnError.message}`;
  } else if (timedOut) {
    // Same failure status/text the opencode and claude paths use.
    job.status = "timeout";
    job.error = `timed out after ${opts.timeoutS}s`;
  } else {
    // Parse FIRST, exit code second.  The payload rule is about not throwing
    // away completed work on a signal that is not authoritative, and a
    // nonzero exit accompanying a complete payload is the same class of
    // signal as `status: "ERROR"`.  A nonzero exit with NO payload still
    // fails, and its error names the exit code.
    let parsed = null;
    let parseError = null;
    try {
      parsed = parseAgyResult(stdout);
    } catch (err) {
      parseError = err;
    }

    if (parsed !== null) {
      job.agyStatus = typeof parsed.status === "string" ? parsed.status : null;
      const outcome = agyPayload(parsed);
      if (outcome.ok) {
        job.status = "completed";
        job.sessionID = parsed.conversation_id ?? null;
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
        job.sessionID = parsed.conversation_id ?? null;
        job.error = `agy dispatch failed: ${outcome.error}`;
      }
    } else if (code !== 0) {
      job.status = "error";
      const detail = (stderr || stdout || "(no output)").trim();
      job.error = `agy exited with code ${code}: ${detail}`;
    } else {
      job.status = "error";
      const snippet = (stdout || "").trim().slice(0, 300);
      job.error = `agy dispatch failed: ${parseError.message}: ${snippet || "(empty stdout)"}`;
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
  });
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
}
