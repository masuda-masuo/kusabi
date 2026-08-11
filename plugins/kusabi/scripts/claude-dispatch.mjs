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

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { firstRoute } from "./cli.mjs";
import { newJobId, saveJob, jobDir, appendEvent } from "./job-store.mjs";
import { stateDirFor, stateRoot, readJson, writeJson } from "./state-paths.mjs";
import { durationS } from "./render.mjs";
import { resolveCompletedResult } from "./result-recovery.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");

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
// permissions — hardcoded allowlists + disallowed tools (v1)
// =========================================================================

// Tool naming: Claude Code addresses MCP tools as `mcp__<server>__<tool>`
// (e.g. `mcp__sunaba__sandbox_attach`), verified against the real CLI
// (kusabi #184 followup).  The opencode naming (`sunaba_sandbox_attach`,
// `shiori_search`) matches NOTHING in a claude session, so every name and
// pattern in these lists — and in every flag built below — uses claude
// naming (I6).

// Allowlists mirroring the opencode agent permission tables at authoring
// time, in claude naming:
//   - implement: plugins/kusabi/opencode-agents/kusabi-implement.md
//     (every `allow` entry except the skill grant, which maps to claude's
//     `Skill` tool for the `kusabi-*` skills; the table grants no shiori).
//   - review:    plugins/kusabi/opencode-agents/kusabi-review.md
//     (the `shiori*` glob is granted IN FULL as `mcp__shiori__*` — the
//     round-2 3-tool expansion was a narrowing and is replaced by the glob,
//     which is valid in claude permission rules, I4).
// Passed to `claude -p` via --allowedTools.  NEVER
// --dangerously-skip-permissions.
const IMPLEMENT_ALLOWED_TOOLS = [
  "mcp__sunaba__sandbox_attach",
  "mcp__sunaba__read_file_range",
  "mcp__sunaba__search_in_container",
  "mcp__sunaba__list_files",
  "mcp__sunaba__diff_in_container",
  "mcp__sunaba__issue_view",
  "mcp__sunaba__write_file",
  "mcp__sunaba__edit_file",
  "mcp__sunaba__transform_file",
  "mcp__sunaba__undo_file_edit",
  "mcp__sunaba__checkpoint",
  "mcp__sunaba__checkpoint_restore",
  "mcp__sunaba__checkpoint_list",
  "mcp__sunaba__package_install",
  "mcp__sunaba__sandbox_exec",
  "mcp__sunaba__sandbox_exec_background",
  "mcp__sunaba__sandbox_exec_check",
  "mcp__sunaba__run_python",
  "mcp__sunaba__verify_in_container",
  "mcp__sunaba__lint_in_container",
  "mcp__sunaba__type_check_in_container",
  "Skill", // mirrors `skill: kusabi-*: allow` in kusabi-implement.md
];

const REVIEW_ALLOWED_TOOLS = [
  "mcp__sunaba__sandbox_attach",
  "mcp__sunaba__read_file_range",
  "mcp__sunaba__search_in_container",
  "mcp__sunaba__list_files",
  "mcp__sunaba__diff_in_container",
  "mcp__sunaba__issue_view",
  "mcp__shiori__*", // the FULL `shiori*` glob of kusabi-review.md (I4)
  "mcp__sunaba__verify_in_container",
  "mcp__sunaba__lint_in_container",
  "mcp__sunaba__type_check_in_container",
  "mcp__sunaba__sandbox_exec",
];

// kusabi-investigate.md grants issue write: the standalone investigate
// deliverable is appending the brief to the target issue.  The chain
// strategist dispatches with the same agent but passes reviewDenyTools(),
// which denies sunaba_sandbox_issue_write — normalized to the claude name
// and removed from this list by applyToolDenies, so the strategist keeps
// the review-shaped toolset while a standalone `task --phase investigate`
// can write the issue (kusabi #184 finding 3).
const INVESTIGATE_ALLOWED_TOOLS = [
  ...REVIEW_ALLOWED_TOOLS,
  "mcp__sunaba__sandbox_issue_write",
];

export const ALLOWED_TOOLS = {
  implement: IMPLEMENT_ALLOWED_TOOLS.join(","),
  review: REVIEW_ALLOWED_TOOLS.join(","),
  investigate: INVESTIGATE_ALLOWED_TOOLS.join(","),
};

/**
 * Resolve the allowed-tools CSV for an agent name.
 *
 * v1 hardcodes three allowlists (implement, review, investigate), each
 * mirroring the corresponding opencode agent permission table.  `kusabi-review`
 * and `kusabi-investigate` are distinct lists: the strategist phase
 * dispatches with the investigate agent but a review-shaped DENY map
 * (reviewDenyTools — issue writes denied), so its effective toolset is the
 * review one; a standalone `task --phase investigate` passes no deny map and
 * keeps the issue-write grant.  A bare `task` (no agent) gets the implement
 * list — the worker toolset, matching the opencode default agent's full tool
 * access.
 *
 * @param {string|null|undefined} agent
 * @returns {string} CSV of allowed tool names.
 * @throws {Error} For agents with no v1 allowlist.
 */
export function allowedToolsForAgent(agent) {
  if (agent === "kusabi-implement" || agent === undefined || agent === null) {
    return ALLOWED_TOOLS.implement;
  }
  if (agent === "kusabi-review") {
    return ALLOWED_TOOLS.review;
  }
  if (agent === "kusabi-investigate") {
    return ALLOWED_TOOLS.investigate;
  }
  throw new Error(
    `claude backend: no permission allowlist for agent "${agent}" ` +
    "(v1 hardcodes the implement, review, and investigate allowlists only)"
  );
}

// The claude/sunaba equivalents of the opencode tool names in
// WRITE_TOOL_NAMES (cli.mjs).  The user-facing deny map built by cmdTask
// (--read-only, --deny) speaks the opencode vocabulary; on the claude
// backend the tools that actually exist are the `mcp__sunaba__*` ones, so
// the deny must be translated before applyToolDenies can remove them from
// the allowlist — otherwise --read-only / --deny bash silently no-op while
// the write tools stay granted (kusabi #184 finding 2).
//
// Phase-level deny maps (implementDenyTools / reviewDenyTools) are NOT
// translated: their opencode-vocabulary names (bash, write, ...) are
// intentional no-ops there (the allowlist is the permission mechanism — the
// agent tables already deny the opencode builtin tools via `"*": deny`),
// and their real tool names (sunaba_copy_project, sunaba_copy_file,
// sunaba_sandbox_issue_write, ...) are normalized to mcp__sunaba__* and
// removed by exact match inside applyToolDenies.
export const OPCODE_DENY_TO_CLAUDE = {
  bash: ["mcp__sunaba__sandbox_exec"],
  write: ["mcp__sunaba__write_file"],
  edit: ["mcp__sunaba__edit_file"],
  patch: ["mcp__sunaba__transform_file"],
  task: [], // no claude/sunaba equivalent — nothing to remove
};

/**
 * Translate a user-facing deny map from the opencode vocabulary into the
 * claude/sunaba tool names that exist in the allowlists.  Names that are
 * not in the opencode vocabulary (e.g. `mcp__sunaba__write_file` passed
 * straight to --deny) are kept verbatim.
 *
 * @param {object|null|undefined} tools
 * @returns {object|null|undefined} The translated deny map.
 */
export function translateDenyTools(tools) {
  if (!tools || typeof tools !== "object") return tools;
  const out = {};
  for (const [name, value] of Object.entries(tools)) {
    const mapped = OPCODE_DENY_TO_CLAUDE[name];
    if (mapped === undefined) {
      out[name] = value;
    } else {
      for (const target of mapped) out[target] = value;
    }
  }
  return out;
}

/**
 * Normalize a deny-map tool name to the claude naming used in the
 * allowlists: a bare `sunaba_*` name (the phase-level deny maps' real tool
 * names, e.g. `sunaba_sandbox_issue_write`) becomes `mcp__sunaba__*`.
 * Names already in claude naming pass through unchanged.
 *
 * @param {string} name
 * @returns {string}
 */
export function normalizeDenyName(name) {
  return name.startsWith("sunaba_") ? `mcp__sunaba__${name.slice("sunaba_".length)}` : name;
}

/**
 * Apply a deny map ({ name: false, ... }) to an allowlist CSV: entries the
 * caller explicitly denies are removed so a deny is never silently ignored
 * on the claude backend.  Removal is by exact match AFTER normalizing bare
 * sunaba_* names to mcp__sunaba__* (phase-level deny maps' real tool names
 * come through verbatim and must still match the claude allowlist);
 * opencode-vocabulary names from user flags are translated by
 * translateDenyTools at the cmdTask level before this runs.
 *
 * @param {string} csv
 * @param {object|null|undefined} tools
 * @returns {string}
 */
export function applyToolDenies(csv, tools) {
  if (!tools || typeof tools !== "object") return csv;
  const denied = Object.entries(tools)
    .filter(([, v]) => v === false)
    .map(([k]) => normalizeDenyName(k));
  if (denied.length === 0) return csv;
  const kept = csv.split(",").filter((name) => !denied.includes(name));
  return kept.join(",");
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
// system prompt (agent md frontmatter stripping) — pure I/O helper
// =========================================================================

/**
 * Strip a leading YAML frontmatter block (--- ... ---) from an agent md
 * file.  The body after the block is the system prompt passed via
 * `--append-system-prompt`.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripFrontmatter(text) {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return m ? text.slice(m[0].length).trim() : text.trim();
}

/**
 * Read the opencode agent definition for `agent` and return its body
 * (frontmatter stripped).  The opencode `agent:` name maps directly to
 * `plugins/kusabi/opencode-agents/<agent>.md`.
 *
 * @param {string|null|undefined} agent
 * @returns {string|null} The system prompt body, or null when no agent.
 * @throws {Error} When the agent file cannot be read.
 */
export function readAgentSystemPrompt(agent) {
  if (!agent) return null;
  const file = path.join(PLUGIN_ROOT, "opencode-agents", `${agent}.md`);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`claude backend: cannot read agent file ${file} (agent "${agent}"): ${err.message}`);
  }
  return stripFrontmatter(text);
}

// =========================================================================
// MCP config — sunaba entry extracted from the host claude config
// =========================================================================

/**
 * Path of the source claude config the sunaba MCP entry is extracted from.
 * Overridable via KUSABI_CLAUDE_MCP_SOURCE (tests point it at a fixture).
 *
 * @returns {string}
 */
export function claudeMcpSourcePath() {
  return process.env.KUSABI_CLAUDE_MCP_SOURCE || path.join(os.homedir(), ".claude.json");
}

/**
 * Extract the `mcpServers.sunaba` entry from a claude config file.
 *
 * @param {string} sourcePath
 * @returns {object} The sunaba server entry.
 * @throws {Error} When the file is unreadable/unparseable or the entry is
 *         missing — the error names the source path and the env override.
 */
export function extractSunabaMcp(sourcePath) {
  let raw;
  try {
    raw = fs.readFileSync(sourcePath, "utf8");
  } catch (err) {
    throw new Error(
      `claude backend: cannot read MCP source config ${sourcePath}: ${err.message} ` +
      "(set KUSABI_CLAUDE_MCP_SOURCE to override the source file)"
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`claude backend: MCP source config ${sourcePath} is not valid JSON: ${err.message}`);
  }
  const sunaba = parsed?.mcpServers?.sunaba;
  if (!sunaba) {
    throw new Error(
      `claude backend: no mcpServers.sunaba entry in ${sourcePath} — ` +
      "the claude backend needs the sunaba MCP server to run worker tools " +
      "(set KUSABI_CLAUDE_MCP_SOURCE to point at a config that has it)"
    );
  }
  return sunaba;
}

/**
 * Write a generated MCP config containing ONLY the sunaba server entry and
 * return its path.  The generated file is what `--mcp-config` points at, so
 * the claude session never sees the host config's other servers.
 *
 * @param {string} stateDir
 * @param {object} sunabaEntry
 * @returns {string} Path of the generated config file.
 */
export function writeClaudeMcpConfig(stateDir, sunabaEntry) {
  const file = path.join(stateDir, "claude-mcp.json");
  writeJson(file, { mcpServers: { sunaba: sunabaEntry } });
  return file;
}

// =========================================================================
// arg construction + result parsing — pure (contract fixes stay cheap)
// =========================================================================

// Belt-and-braces deny list (I1/I3): tools that must never run in a worker
// session even if an allowlist bug or a settings leak would grant them.
// `Bash`/`Edit`/`Write`/`NotebookEdit` are the CLI's own built-in tools — a
// kusabi worker acts exclusively through the sunaba MCP tools, so they are
// denied outright.  `mcp__sunaba__sandbox_issue_write` is the ONE exception:
// a standalone `task --phase investigate` (agent kusabi-investigate)
// delivers by appending the brief to the issue.  The chain strategist also
// dispatches with the investigate agent, but its review-shaped deny map
// still strips issue write from the allowlist — the exception cannot grant
// it there.
const DISALLOWED_TOOLS = [
  "mcp__sunaba__publish",
  "mcp__sunaba__sandbox_issue_write",
  "mcp__sunaba__sandbox_pr_review_write",
  "mcp__sunaba__secret_scan_override",
  "mcp__sunaba__sandbox_stop",
  "mcp__sunaba__sandbox_initialize",
  "mcp__sunaba__copy_file",
  "mcp__sunaba__copy_project",
  "mcp__sunaba__run_container_and_exec",
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
];

/**
 * Resolve the `--disallowedTools` CSV for an agent.  The issue-write tool is
 * exempted for kusabi-investigate only (its deliverable is the issue write);
 * every other agent denies it.
 *
 * @param {string|null|undefined} agent
 * @returns {string}
 */
export function disallowedToolsForAgent(agent) {
  return DISALLOWED_TOOLS.filter(
    (t) => !(t === "mcp__sunaba__sandbox_issue_write" && agent === "kusabi-investigate"),
  ).join(",");
}

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
// NDJSON stream parsing — pure (kusabi #215 Job B)
// =========================================================================
//
// `claude -p --output-format stream-json --verbose` prints one JSON event
// object per stdout line.  These two functions are the whole parse/fold
// contract, kept pure and separate from the spawn/IO code so they are cheap
// to unit-test against fixture event sequences.

/**
 * Parse one line of the NDJSON stream.
 *
 * Returns null for anything that is not a JSON object on that line —
 * blank lines, and non-JSON prose (the real CLI has been observed printing
 * a "no stdin data" warning line ahead of the stream).  The caller counts
 * nulls for debugging but never treats one as fatal.
 *
 * @param {string} line
 * @returns {object|null}
 */
export function parseClaudeStreamLine(line) {
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
 * A fresh accumulator for folding a claude NDJSON stream into job stats.
 *
 * @returns {{ events: number, steps: number, lastTool: string|null,
 *             lastActivity: string|null, models: string[],
 *             sessionIdFromInit: string|null, resultEvent: object|null,
 *             rateLimit: {info: object, observedAt: string}|null }}
 */
export function initClaudeStreamAccumulator() {
  return {
    events: 0,
    steps: 0,
    lastTool: null,
    lastActivity: null,
    models: [],
    sessionIdFromInit: null,
    resultEvent: null,
    rateLimit: null,
  };
}

/**
 * Fold one parsed stream event into the accumulator (mutates and returns
 * it).  Every recognized event type contributes:
 *
 *   - `system` / `init`      — the session id, kept in case the stream ends
 *                               with no terminal `result` event.
 *   - `rate_limit_event`     — the live quota feed (kusabi #215 Job B item
 *                               4): the most recent `rate_limit_info`,
 *                               stamped with when it was observed.
 *   - `assistant`            — `message.model` (deduped into `models`) and
 *                               each `tool_use` content block (`steps` +
 *                               `lastTool`).
 *   - `result`               — kept as `resultEvent`; a later one replaces
 *                               an earlier one, so a stream carrying more
 *                               than one keeps the LAST (the terminal one).
 *
 * `events` and `lastActivity` update for every recognized call regardless
 * of type: `events` is "parsed event lines", not "assistant events".
 *
 * @param {object} acc — an accumulator from `initClaudeStreamAccumulator`.
 * @param {object} evt — one parsed stream event.
 * @param {string} [now] — ISO timestamp; overridable for tests.
 * @returns {object} The same accumulator, mutated.
 */
export function applyClaudeStreamEvent(acc, evt, now = new Date().toISOString()) {
  acc.events += 1;
  acc.lastActivity = now;

  const type = evt?.type;
  if (type === "system" && evt.subtype === "init") {
    if (typeof evt.session_id === "string" && evt.session_id) {
      acc.sessionIdFromInit = evt.session_id;
    }
  } else if (type === "rate_limit_event") {
    if (evt.rate_limit_info && typeof evt.rate_limit_info === "object") {
      acc.rateLimit = { info: evt.rate_limit_info, observedAt: now };
    }
  } else if (type === "assistant") {
    const message = evt.message;
    if (message && typeof message === "object") {
      if (typeof message.model === "string" && message.model && !acc.models.includes(message.model)) {
        acc.models.push(message.model);
      }
      const content = Array.isArray(message.content) ? message.content : [];
      for (const block of content) {
        if (block && typeof block === "object" && block.type === "tool_use") {
          acc.steps += 1;
          if (typeof block.name === "string" && block.name) acc.lastTool = block.name;
        }
      }
    }
  } else if (type === "result") {
    acc.resultEvent = evt;
  }
  return acc;
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

// =========================================================================
// pre-dispatch session-quota guard (kusabi #215)
// =========================================================================
//
// A dispatch can START into a session window that is already nearly spent.
// The job then dies mid-run on the session limit: measured 2026-08-11,
// $2.39 and 256s burned for zero edits — and because `claude -p` shares the
// operator's OWN account window, that failed spend also ate the operator's
// remaining session.  The classification above explains such a run
// AFTERWARDS; this guard stops the spend from starting.
//
// The probe is FREE.  `claude -p --output-format json "/usage"` is a
// control-plane dispatch with NO inference: measured on Claude Code 2.1.227
// (kusabi #215), `cost_usd: 0`, `num_turns: 0`, `api_ms: 0`, ~450ms wall, no
// model called (`--model` is irrelevant to it).  It consumes no tokens and no
// quota, which is the only reason it can run before every claude dispatch.
// One probe per dispatch, always fresh: no caching, no background refresh —
// a stale quota reading is exactly the thing this guard exists to avoid.
//
// Everything here FAILS OPEN, loudly.  What it parses is human-readable prose
// with NO stability contract:
//
//   Current session: 41% used · resets Aug 11, 1:59pm (Asia/Tokyo)
//   Current week (all models): 37% used · resets Aug 16, 1:59am (Asia/Tokyo)
//   Current week (Fable): 42% used · resets Aug 16, 1:59am (Asia/Tokyo)
//
// so the pattern WILL break on some future CLI build.  When it does — or the
// subprocess cannot be started, times out, or exits nonzero — the guard
// records "could not read the quota" on the job record and the dispatch
// proceeds exactly as it does today.  A guard that failed closed on a
// formatting change would be worse than no guard at all, so nothing in here
// may throw out of `claudeDispatch`.
//
// The number is a LOWER BOUND either way: /usage measures this machine only
// ("does not include other devices or claude.ai").
//
// Only the SESSION line is read.  The weekly lines are deliberately ignored:
// session is the binding limit (the one the real incident hit), and a weekly
// guard would refuse work that the session window can still complete.

// The refusal threshold used when the config names none.
export const CLAUDE_SESSION_GUARD_DEFAULT_PERCENT = 90;

// How long the /usage probe is given to answer before it is killed and the
// reading is treated as unreadable.  The measured wall time is ~450ms; the
// bound is short on purpose — this cost is paid by EVERY claude dispatch, and
// a probe that has to be waited out is a probe that already told us nothing.
// Overridable so tests can drive the timeout path without a 5s wait (mirrors
// KUSABI_CANCEL_KILL_WAIT_MS above).
const USAGE_PROBE_TIMEOUT_MS = 5000;
// Bound on how much of a rogue answer is kept in memory: the real one is a
// few hundred bytes.
const USAGE_PROBE_OUTPUT_CAP = 64 * 1024;

export function usageProbeTimeoutMs() {
  const raw = process.env.KUSABI_CLAUDE_USAGE_PROBE_TIMEOUT_MS;
  if (raw === undefined || raw === "") return USAGE_PROBE_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : USAGE_PROBE_TIMEOUT_MS;
}

/**
 * The kusabi config, read straight from the state root for the guard's own
 * use.  `claudeDispatch` is handed no config (the dispatch contract it shares
 * with `dispatchWithFallback` / `agyDispatch` carries none, and the chain
 * phases that call it never saw one), so the guard reads the ONE key it needs
 * itself rather than threading a config object through every phase.
 *
 * Read-only and fail-quiet: `readJson` returns null for a missing or
 * unparseable file.  A genuinely broken config never reaches here — every
 * command loads and validates it (loadConfig, kusabi-companion.mjs) before
 * any dispatch happens.
 *
 * @returns {object|null}
 */
export function loadClaudeGuardConfig() {
  return readJson(path.join(stateRoot(), "config.json"));
}

/**
 * The guard's settings for this dispatch.
 *
 * Config shape (documented in README.md, "Backends"):
 *
 *   { "claude": { "sessionGuardPercent": 90 } }
 *
 *   - key absent / true      → guard on at the default threshold (90)
 *   - a positive number      → guard on at that threshold
 *   - `false` / `0` / `<0`   → guard OFF: no probe at all, byte-identical to
 *                              the pre-#215 dispatch
 *   - anything unreadable    → guard on at the default threshold; a
 *                              malformed threshold must not silently switch
 *                              the guard off
 *
 * NO config file at all → guard OFF.  This is a real boundary, not an
 * oversight: the guard's threshold is an operator decision, and this dispatch
 * has no other channel to receive one, so a workspace that has never been
 * configured is left byte-identical to today.  Enable it with the two lines
 * above (or `"sessionGuardPercent": true` to take the default).
 *
 * @param {object|null|undefined} config — output of loadClaudeGuardConfig().
 * @returns {{ enabled: boolean, threshold: number|null, reason: string }}
 */
export function resolveClaudeSessionGuard(config) {
  if (config === null || config === undefined || typeof config !== "object" || Array.isArray(config)) {
    return { enabled: false, threshold: null, reason: "no-config" };
  }
  const raw = config.claude === null || typeof config.claude !== "object" || Array.isArray(config.claude)
    ? undefined
    : config.claude.sessionGuardPercent;
  if (raw === false) return { enabled: false, threshold: null, reason: "disabled" };
  if (raw === undefined || raw === null || raw === true) {
    return { enabled: true, threshold: CLAUDE_SESSION_GUARD_DEFAULT_PERCENT, reason: "default" };
  }
  const parsed = typeof raw === "number"
    ? raw
    : (typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN);
  if (!Number.isFinite(parsed)) {
    return { enabled: true, threshold: CLAUDE_SESSION_GUARD_DEFAULT_PERCENT, reason: "unreadable-setting" };
  }
  if (parsed <= 0) return { enabled: false, threshold: null, reason: "disabled" };
  return { enabled: true, threshold: parsed, reason: "configured" };
}

/**
 * The probe invocation, exactly as it was measured (kusabi #215): the bare
 * `/usage` slash command through `-p`, with the json envelope so the prose
 * arrives in a named field instead of mixed into raw stdout.  Nothing else is
 * passed — no --model (it is not consulted), no MCP config, no allow/deny
 * lists: this is a control-plane call, and every flag added here is a flag
 * that can make it fail.
 *
 * @returns {string[]}
 */
export function claudeUsageProbeArgs() {
  return ["-p", "--output-format", "json", "/usage"];
}

// "Current session: 41% used" — the ONLY line this guard reads.  Anchored on
// the two words together so a weekly line ("Current week (Fable): 42% used")
// can never be mistaken for it.
const SESSION_USAGE_RE = /current\s+session\s*:\s*([0-9]{1,3}(?:\.[0-9]+)?)\s*%\s*used/i;

/**
 * The session usage percentage, and the reset time named next to it, from a
 * /usage answer.
 *
 * Accepts either the `--output-format json` envelope (prose in `result`) or
 * bare prose — the shape has no contract, so neither is assumed.  Anything
 * that does not carry a "Current session: NN% used" reading returns
 * `{ percent: null }`, which the caller treats as "could not read the quota"
 * and proceeds.
 *
 * @param {string} text — the probe's stdout.
 * @returns {{ percent: number|null, reset: string|null }}
 */
export function parseClaudeSessionUsage(text) {
  const raw = typeof text === "string" ? text : "";
  let prose = raw;
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed !== null && typeof parsed === "object" && typeof parsed.result === "string") {
      prose = parsed.result;
    }
  } catch { /* not the json envelope: read the raw text */ }
  const m = prose.match(SESSION_USAGE_RE);
  if (!m) return { percent: null, reset: null };
  const percent = Number(m[1]);
  if (!Number.isFinite(percent)) return { percent: null, reset: null };
  return { percent, reset: sessionResetFrom(prose, m.index) };
}

/**
 * The "resets <when>" phrase from the SAME line the session reading was found
 * on — never a neighbouring weekly line, whose reset is a different window
 * (and days away).
 *
 * @param {string} prose
 * @param {number} matchIndex — index of the session reading inside `prose`.
 * @returns {string|null}
 */
function sessionResetFrom(prose, matchIndex) {
  const lineStart = prose.lastIndexOf("\n", matchIndex) + 1;
  const lineEnd = prose.indexOf("\n", matchIndex);
  const line = prose.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  const m = line.match(/resets?\s+(?:at\s+)?(.+?)\s*$/i);
  return m ? m[1].trim() : null;
}

/**
 * Run the /usage probe and report what it said — or why nothing could be
 * read.  NEVER rejects: every failure mode resolves to `readable: false`,
 * because the caller's only correct response to a broken probe is to proceed.
 *
 * The child runs in its OWN process group and a probe that has to be killed
 * takes that whole group with it, exactly like the worker spawn: a
 * control-plane call must not leave anything running in the operator's
 * session.
 *
 * @param {object} opts
 * @param {string} opts.bin — the resolved claude binary (claudeBin()).
 * @param {string} [opts.cwd]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ readable: true, percent: number, reset: string|null, reason: null,
 *                     detail: null, elapsedMs: number }
 *                  | { readable: false, percent: null, reset: null,
 *                      reason: "spawn-failed"|"timeout"|"exit-nonzero"|"unparsed",
 *                      detail: string, elapsedMs: number }>}
 */
export function probeClaudeSessionUsage({ bin, cwd, timeoutMs = usageProbeTimeoutMs() } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const unreadable = (reason, detail) => resolve({
      readable: false, percent: null, reset: null, reason, detail,
      elapsedMs: Date.now() - startedAt,
    });

    let child;
    try {
      child = spawn(bin, claudeUsageProbeArgs(), {
        cwd,
        // The probe must see the operator's environment: `claude` resolves its
        // credentials from it exactly as the worker does.
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch (err) {
      unreadable("spawn-failed", err.message);
      return;
    }

    let stdout = "";
    let stderr = "";
    let spawnError = null;
    let timedOut = false;

    if (child.stdin) {
      child.stdin.on("error", () => {});
      // The probe's prompt is on argv, so stdin is closed at once: the real
      // CLI otherwise waits on it and warns after 3s, which would double the
      // guard's cost for nothing.
      child.stdin.end("");
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { if (stdout.length < USAGE_PROBE_OUTPUT_CAP) stdout += chunk; });
    child.stderr.on("data", (chunk) => { if (stderr.length < USAGE_PROBE_OUTPUT_CAP) stderr += chunk; });
    child.on("error", (err) => { spawnError = err; });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child);
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (spawnError) {
        unreadable("spawn-failed", `could not start ${bin}: ${spawnError.message}`);
        return;
      }
      if (timedOut) {
        unreadable("timeout", `${bin} /usage did not answer within ${timeoutMs}ms (killed)`);
        return;
      }
      if (code !== 0) {
        const detail = (stderr || stdout || "(no output)").trim().slice(0, 300);
        unreadable("exit-nonzero", `${bin} /usage exited with code ${code}: ${detail}`);
        return;
      }
      const { percent, reset } = parseClaudeSessionUsage(stdout);
      if (percent === null) {
        unreadable("unparsed", `no "Current session: NN% used" reading in: ${stdout.trim().slice(0, 300) || "(empty stdout)"}`);
        return;
      }
      resolve({ readable: true, percent, reset, reason: null, detail: null, elapsedMs: Date.now() - startedAt });
    });
  });
}

/**
 * Fold the guard's settings and the probe's answer into the observation that
 * is persisted on the job record and on the events trail — and the decision.
 *
 * A refused dispatch and a mid-run quota death must never be confusable in
 * the record, and a dispatch that ran PAST the guard has to show what the
 * guard knew when it let it through (including "nothing").  Pure, so the
 * threshold semantics are testable without a subprocess.
 *
 * @param {{threshold: number}} guard — output of resolveClaudeSessionGuard.
 * @param {object} probe — output of probeClaudeSessionUsage.
 * @param {string} [now]
 * @returns {{ threshold: number, percent: number|null, reset: string|null,
 *             readable: boolean, reason: string|null, detail: string|null,
 *             decision: "refused"|"proceeded", observedAt: string,
 *             probeMs: number|null }}
 */
export function claudeSessionGuardObservation(guard, probe, now = new Date().toISOString()) {
  // `>=`: at the threshold the window is already as spent as the operator
  // said they were willing to start into.
  const refuse = probe.readable === true && probe.percent >= guard.threshold;
  return {
    threshold: guard.threshold,
    percent: probe.readable ? probe.percent : null,
    reset: probe.readable ? probe.reset : null,
    readable: probe.readable === true,
    reason: probe.readable ? null : (probe.reason ?? "unknown"),
    detail: probe.readable ? null : (probe.detail ?? null),
    decision: refuse ? "refused" : "proceeded",
    observedAt: now,
    probeMs: typeof probe.elapsedMs === "number" ? probe.elapsedMs : null,
  };
}

/**
 * The detail line the refusal's error text is built around: it must be
 * unmistakably a PRE-dispatch refusal (nothing ran, nothing was spent), and
 * it must carry the measured number and the threshold that rejected it.  The
 * surrounding session-limit advice comes from renderClaudeQuotaError — the
 * same wording a mid-run session limit prints, because the operator's next
 * move is identical.
 *
 * @param {{percent: number, threshold: number}} observation
 * @returns {string}
 */
export function renderClaudeSessionGuardRefusal(observation) {
  return (
    `pre-dispatch session-quota guard refused this dispatch — /usage reports ` +
    `${observation.percent}% of the claude session window already used ` +
    `(refuse at ${observation.threshold}%). No worker was started: this job spent nothing, ` +
    `and the run did not fail mid-flight`
  );
}

// =========================================================================
// spawn — one child per dispatch, bounded by timeoutS
// =========================================================================

/**
 * SIGKILL the whole process group of a detached child (claude AND everything
 * it spawned — its sunaba MCP server, running tool commands).  Killing only
 * the direct child would orphan the grandchildren in the shared container,
 * where their work (e.g. a long verify) keeps mutating the tree the next
 * dispatch/round is probing (kusabi #184 finding 4).
 *
 * @param {import("node:child_process").ChildProcess} child
 */
function killProcessGroup(child) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

// =========================================================================
// process identity — what makes a recorded pid safe to signal later
// =========================================================================
//
// `cancel` runs in a DIFFERENT process from the dispatch, so the only way it
// can reach the spawned child is through the pid persisted on the job
// record.  A pid on its own is not a safe kill target: pids are recycled and
// a record can outlive its process by days.  Measured on this machine: a pid
// recorded 8 days earlier had been reused as an unrelated process's thread
// id, and signalling it took down a live server for 22 minutes.
//
// So every recorded pid is stored with an IDENTITY TOKEN and re-verified
// immediately before anything is signalled.  The token is field 22 of
// /proc/<pid>/stat, `starttime` (clock ticks since boot).  That is
// sufficient here because:
//   - it is assigned once when the process is forked and never changes for
//     the rest of its life (exec included), so it is stable between the
//     dispatch that records it and the cancel that checks it;
//   - it is not inherited: a recycled pid necessarily belongs to a process
//     that started later, so its starttime differs.  (pid, starttime) is the
//     kernel's own process identity — the same pair pidfd-less tooling has
//     always used;
//   - it does not lie for a thread id either: /proc/<tid>/stat carries that
//     thread's own starttime, so the TID-reuse case above is refused too;
//   - reading it needs no privileges and no cooperation from the process.
//
// Everything here fails CLOSED: when /proc cannot be read, or the token is
// missing, or it does not match, NOTHING is signalled.  A leaked process
// costs a wasted container; a mis-aimed SIGKILL costs someone else's work.

// How long a signalled process group is given to actually disappear before
// the stop is reported as failed.  kill() returning means the signal was
// delivered, not that anything died, so the disappearance is polled for.
// Overridable so tests can drive the could-not-stop path without a 5 s wait
// (mirrors KUSABI_SERVE_READY_TIMEOUT_MS in serve-lifecycle.mjs).
const KILL_CONFIRM_WAIT_MS = 5000;
const KILL_CONFIRM_POLL_MS = 50;

export function killConfirmWaitMs() {
  const raw = process.env.KUSABI_CANCEL_KILL_WAIT_MS;
  if (raw === undefined || raw === "") return KILL_CONFIRM_WAIT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : KILL_CONFIRM_WAIT_MS;
}

/**
 * Parse the /proc/<pid>/stat fields identity and liveness need.  Throws the
 * underlying fs error when the entry cannot be read — with /proc present,
 * ENOENT means the pid is gone.
 *
 * @param {number} pid
 * @returns {{ state: string, pgrp: number, startTime: string }}
 */
export function readProcessStat(pid) {
  const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  // Fields 1 (pid) and 2 (comm) are skipped by hand: comm is the executable
  // name in parentheses and may itself contain spaces and parentheses, so
  // only the LAST ")" reliably ends it.  After it, field N sits at index
  // N-3: state = 3, pgrp = 5, starttime = 22.
  const rest = text.slice(text.lastIndexOf(")") + 2).split(" ");
  return { state: rest[0], pgrp: Number(rest[2]), startTime: rest[19] };
}

// True when /proc is present at all (Linux); false where it is not (macOS),
// which is what tells "the pid is gone" apart from "this platform cannot
// answer".
function procAvailable() {
  try {
    return fs.existsSync("/proc/self/stat");
  } catch {
    return false;
  }
}

// A pid in state Z (zombie) or X (dead) exists as a /proc entry but is NOT
// alive: it runs no code and holds no resources, it is just an exit status
// waiting to be reaped.  kill(pid, 0) cannot tell the difference — the state
// field can, and must, or a group kill would never read as complete while an
// orphaned grandchild waits for init to reap it.
function liveState(state) {
  return state !== "Z" && state !== "X";
}

/**
 * The identity token to persist next to a pid, or null when it cannot be
 * read.  A null token is not a licence to kill: stopRecordedProcess refuses
 * to signal a pid it cannot verify.
 *
 * @param {number} pid
 * @returns {string|null}
 */
export function processStartToken(pid) {
  try {
    return readProcessStat(pid).startTime ?? null;
  } catch {
    return null;
  }
}

/**
 * The live (non-zombie) members of process group *pgid*, or null when the
 * group cannot be enumerated (no /proc).
 *
 * @param {number} pgid
 * @returns {number[]|null}
 */
export function processGroupMembers(pgid) {
  let entries;
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return null;
  }
  const members = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const stat = readProcessStat(pid);
      if (stat.pgrp === pgid && liveState(stat.state)) members.push(pid);
    } catch { /* vanished or unreadable between readdir and read */ }
  }
  return members;
}

// True when nothing is left running in process group *pgid*.  /proc is the
// primary source (it sees zombies for what they are); where it is absent,
// kill(-pgid, 0) is the only probe available and ESRCH is the answer.
function groupIsGone(pgid) {
  const members = processGroupMembers(pgid);
  if (members !== null) return members.length === 0;
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (err) {
    return err?.code === "ESRCH";
  }
}

function stopResult(outcome, pid, signalled, reason, survivors = []) {
  return { outcome, pid, signalled, reason, survivors };
}

/**
 * Stop a dispatch's process group from another process, using the identity
 * recorded on the job record (kusabi #209).
 *
 * Never signals a pid it cannot prove is the recorded process, and never
 * reports a stop it did not watch happen: after the SIGKILL the group is
 * polled until it is empty or the bounded wait runs out.
 *
 * @param {{pid?: number, startTime?: string}|null|undefined} recorded
 *        the job record's `process` field.
 * @param {{waitMs?: number, pollMs?: number}} [opts]
 * @returns {Promise<{outcome: "stopped"|"already-gone"|"identity-mismatch"|"unverifiable"|"no-record"|"alive",
 *                    pid: number|null, signalled: boolean, reason: string, survivors: number[]}>}
 *   - `stopped`          — signalled, and the whole group was observed gone.
 *   - `already-gone`     — nothing to signal; the process had already exited.
 *   - `identity-mismatch`— the pid is live but is NOT this job's process
 *                          (recycled pid / thread id): not signalled, and the
 *                          job's own process is therefore gone.
 *   - `unverifiable`     — the pid may well be the process, it just cannot be
 *                          proven: not signalled, and the job may still run.
 *   - `no-record`        — the record names no pid at all.
 *   - `alive`            — signalled, and something in the group survived.
 */
export async function stopRecordedProcess(recorded, { waitMs, pollMs = KILL_CONFIRM_POLL_MS } = {}) {
  const pid = Number(recorded?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return stopResult("no-record", null, false, "the job record carries no process id");
  }
  const token = recorded?.startTime ?? null;

  let stat;
  try {
    stat = readProcessStat(pid);
  } catch (err) {
    if (procAvailable() && err?.code === "ENOENT") {
      return stopResult("already-gone", pid, false, `pid ${pid} is no longer running`);
    }
    return stopResult("unverifiable", pid, false, `cannot read /proc/${pid}/stat (${err?.code ?? err?.message ?? err})`);
  }
  if (!liveState(stat.state)) {
    return stopResult("already-gone", pid, false, `pid ${pid} is an unreaped corpse (process state ${stat.state}), not a running process`);
  }
  if (!token) {
    return stopResult("unverifiable", pid, false, `the record carries pid ${pid} with no identity token, so the live pid cannot be proven to be this job's process`);
  }
  if (stat.startTime !== String(token)) {
    return stopResult("identity-mismatch", pid, false, `pid ${pid} now belongs to a different process (recorded start time ${token}, observed ${stat.startTime})`);
  }
  if (stat.pgrp !== pid) {
    // Every child this dispatch spawns is detached, i.e. the leader of its
    // own group (pgrp == pid).  A verified pid that is not a group leader is
    // a shape this code has never produced, so refuse rather than guess
    // which group `kill(-pid)` would hit.
    return stopResult("unverifiable", pid, false, `pid ${pid} is not the leader of its process group (pgrp ${stat.pgrp}); a dispatch child always is`);
  }

  // Identity confirmed.  SIGKILL the whole GROUP, exactly as the in-dispatch
  // timeout does: the CLI has its own children (its sunaba MCP server, tool
  // commands) and killing only the leader would leave them writing into the
  // container the operator is about to reuse.
  try {
    process.kill(-pid, "SIGKILL");
  } catch (err) {
    if (err?.code === "ESRCH") {
      return stopResult("already-gone", pid, false, `process group ${pid} vanished before it could be signalled`);
    }
    return stopResult("alive", pid, false, `SIGKILL to process group ${pid} failed: ${err?.code ?? err?.message ?? err}`);
  }

  const deadline = Date.now() + (waitMs ?? killConfirmWaitMs());
  for (;;) {
    if (groupIsGone(pid)) {
      return stopResult("stopped", pid, true, `process group ${pid} is gone`);
    }
    if (Date.now() >= deadline) {
      const survivors = processGroupMembers(pid) ?? [];
      return stopResult(
        "alive",
        pid,
        true,
        `process group ${pid} still has live members after SIGKILL${survivors.length ? ` (pids ${survivors.join(", ")})` : ""}`,
        survivors,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
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
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string,
 *                     timedOut: boolean, stalled: boolean, spawnError: Error|null }>}
 */
export function runClaudeProcess({ bin, args, cwd, timeoutS, watchdogS, promptText, onStart, onLine, onWatchdog }) {
  return new Promise((resolve) => {
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
    let spawnError = null;
    let lineBuffer = "";
    let lastEventAt = Date.now();

    // Delivers one complete NDJSON line to the caller and resets the
    // silence clock the watchdog measures against — the clock starts at
    // spawn (above), not at the first event, so a child that never prints
    // anything at all still trips the watchdog.  Only a PARSED event
    // resets the clock: an unparseable prose line (the real CLI's leading
    // warning) is stream noise, not activity — it must not masquerade as
    // an event and hold the watchdog off (kusabi #215 Job B item 3).
    function deliverLine(line) {
      if (parseClaudeStreamLine(line) !== null) lastEventAt = Date.now();
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
          if (timedOut || stalled) return;
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
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (watchdogTimer) clearInterval(watchdogTimer);
      if (lineBuffer) deliverLine(lineBuffer);
      resolve({ code, stdout, stderr, timedOut, stalled, spawnError });
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
 * @param {string|null} [opts.phase]
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
  // ---- cross-backend session guard (the single decision point for "may
  // this session be resumed here") ----
  // An opencode session id (`ses_*`) can never be resumed on the claude
  // backend: transcripts live under different roots and `claude -p --resume`
  // would silently start a fresh-looking session the user thinks continues
  // their opencode work.  Fail LOUDLY, before any process is spawned or any
  // job record exists — this is a config-level error, not a failed job.
  if (typeof opts.session === "string" && opts.session.startsWith("ses_")) {
    throw new Error(
      `opencode session ${opts.session} cannot be resumed on the claude backend \u2014 ` +
      "ses_* session ids belong to opencode; run the command without --backend claude " +
      "(or resume the claude session id on this backend)"
    );
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
  const sunabaEntry = extractSunabaMcp(claudeMcpSourcePath());
  const mcpConfigPath = writeClaudeMcpConfig(stateDir, sunabaEntry);
  const systemPrompt = readAgentSystemPrompt(opts.agent);
  const allowedTools = applyToolDenies(allowedToolsForAgent(opts.agent), opts.tools);
  const disallowedTools = disallowedToolsForAgent(opts.agent);
  const bin = claudeBin();
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
  const job = {
    id: newJobId(),
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
  saveJob(stateDir, job);
  fs.writeFileSync(path.join(jobDir(stateDir, job.id), "prompt.md"), opts.promptText || "", "utf8");
  appendEvent(stateDir, job.id, {
    type: "companion.claude.dispatch",
    backend: CLAUDE_BACKEND,
    model: modelEntry,
    bin,
  });

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
    job.sessionGuard = observation;
    saveJob(stateDir, job);
    appendEvent(stateDir, job.id, { type: "companion.claude.session-guard", ...observation });

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
      job.failure = failure;
      job.status = "provider-error";
      job.finishedAt = new Date().toISOString();
      job.error = renderClaudeQuotaError(failure, renderClaudeSessionGuardRefusal(observation));
      appendEvent(stateDir, job.id, {
        type: "companion.claude.dispatch-refused",
        reason: "session-quota-guard",
        percent: observation.percent,
        threshold: observation.threshold,
        reset: observation.reset ?? null,
      });
      // The trail keeps its dispatch/finished bookends so auditing tools see
      // no hole; `spawned: false` is what tells this apart from a run.
      appendEvent(stateDir, job.id, {
        type: "companion.claude.finished",
        status: job.status,
        sessionId: null,
        exitCode: null,
        streamEvents: 0,
        malformedLines: 0,
        spawned: false,
      });
      saveJob(stateDir, job);
      return { job, resultText: "", stateDir };
    }
  }

  // ---- run: parse the NDJSON stream as it arrives (kusabi #215 Job B) ----
  const streamAcc = initClaudeStreamAccumulator();
  let malformedLines = 0;
  let lastStatsSaveAt = 0;
  const STATS_SAVE_INTERVAL_MS = 1000;
  const onLine = (rawLine) => {
    const evt = parseClaudeStreamLine(rawLine);
    if (evt === null) {
      // Not fatal (a leading non-JSON warning line has been observed on
      // the real CLI) — just not countable as a parsed event.
      malformedLines += 1;
      return;
    }
    applyClaudeStreamEvent(streamAcc, evt);
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
    if (streamAcc.rateLimit) job.rateLimit = streamAcc.rateLimit;
    // Bounded cadence, not every line: a chatty stream must not turn into a
    // write per event, but `kusabi status` still needs to see the job
    // record move while the child is running, not only once it exits.
    const now = Date.now();
    if (now - lastStatsSaveAt >= STATS_SAVE_INTERVAL_MS) {
      lastStatsSaveAt = now;
      saveJob(stateDir, job);
    }
  };

  const { code, stdout, stderr, timedOut, stalled, spawnError } = await runClaudeProcess({
    bin,
    args,
    cwd: opts.cwd,
    timeoutS: opts.timeoutS,
    watchdogS: opts.watchdogS,
    promptText: opts.promptText || "",
    // Persist the child's identity on the record while it is still running,
    // so `cancel` can verify and stop it (kusabi #209).
    onStart: ({ pid, startTime }) => {
      job.process = { pid, startTime, recordedAt: new Date().toISOString() };
      saveJob(stateDir, job);
    },
    onLine,
    // The SAME event types the opencode watchdog writes
    // (prompt-execution.mjs), so stall auditing over events.ndjson is
    // backend-agnostic and finally counts claude stalls too — until now the
    // claude watchdog mirrored opencode's status and wording but left no
    // trace in the trail at all.  There is deliberately no
    // `companion.watchdog.declined-kill` counterpart: that event exists on
    // opencode because a shared serve's pid may not be ours to signal, while
    // this child is ours alone, so the kill always runs.
    onWatchdog: ({ kind, silenceS }) => {
      if (kind === "fired") {
        appendEvent(stateDir, job.id, { type: "companion.watchdog.fired", silenceS });
      } else {
        appendEvent(stateDir, job.id, { type: "companion.watchdog.kill" });
      }
    },
  });

  job.finishedAt = new Date().toISOString();

  // ---- failure classification (all failure text preserved on the record) ----
  let parsed = null;
  if (spawnError) {
    job.status = "error";
    job.error = `claude dispatch failed: could not start ${bin}: ${spawnError.message}`;
  } else if (stalled) {
    // Mirrors the opencode watchdog's own status and wording exactly (kusabi
    // #215 Job B item 3), so a chain treats a stalled claude worker like a
    // stalled opencode one.  The kill always ran (runClaudeProcess only sets
    // `stalled` after killProcessGroup), so the wording always names it —
    // there is no "declined kill" case here, unlike the opencode serve
    // watchdog: this process is ours alone, nothing to verify ownership of.
    job.status = "stalled";
    job.error = `watchdog: no events for ${opts.watchdogS}s (process killed)`;
  } else if (timedOut) {
    // Same failure status/text the opencode path uses for timeouts.
    job.status = "timeout";
    job.error = `timed out after ${opts.timeoutS}s`;
  } else if (code !== 0 && streamAcc.resultEvent?.is_error !== true) {
    // Nonzero exit with nothing to classify: no terminal payload at all, or
    // one that does not itself claim failure.  Generic error, exactly as
    // before.  (A terminal payload that DOES claim failure skips this branch
    // — see the comment on the classification branch below.)
    job.status = "error";
    const detail = (stderr || stdout || "(no output)").trim();
    job.error = `claude exited with code ${code}: ${detail}`;
  } else if (streamAcc.resultEvent === null) {
    // The process exited 0 but the stream never carried a terminal `result`
    // event — garbage output, or a shape this parser does not recognize.
    // Still a failed job, never a stuck "running" record.
    job.status = "error";
    const snippet = stdout.trim().slice(0, 300);
    job.error = `claude stream produced no terminal result event ` +
      `(${streamAcc.events} parsed, ${malformedLines} unparseable line(s)): ${snippet || "(empty stdout)"}`;
  } else {
    parsed = streamAcc.resultEvent;
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
      const failure = classifyClaudeTerminalFailure(parsed, { rateLimit: job.rateLimit });
      const detail = typeof parsed.result === "string" && parsed.result.trim()
        ? parsed.result.trim()
        : "claude reported is_error: true";
      job.failure = failure;
      if (failure) {
        // Quota exhaustion gets the provider-error status so the chain's
        // provider-exhaustion stop renders the classification instead of
        // the generic error text (kusabi #215); the error text carries
        // the operator-facing advice (which quota, reset, what to do).
        job.status = "provider-error";
        job.error = renderClaudeQuotaError(failure, detail, {
          // Provenance of the reset the classifier settled on: the payload
          // names one, or it fell back to the live rate feed. Asked the same
          // way the classifier asks it, so the two can never disagree.
          resetFromRateFeed: failure.reset !== null && extractClaudeQuotaReset(parsed) === null,
        });
      } else {
        job.status = "error";
        // Nonzero exit with stderr/stdout text: keep the CLI's own
        // diagnostic on the record — a terse is_error payload says what
        // happened, not why.  The quota arm never appends it: the
        // classification names the failure and stderr would be noise.
        // Exit-0 rendering is unchanged (this suffix is exit-gated).
        const exitDiagnostic = (stderr || stdout || "").trim();
        job.error = code !== 0 && exitDiagnostic
          ? `claude dispatch failed: ${detail} (exited with code ${code}: ${exitDiagnostic})`
          : `claude dispatch failed: ${detail}`;
      }
    } else {
      job.status = "completed";
      job.sessionID = parsed.session_id ?? null;
      job.usage = {
        ...mapClaudeUsage(parsed),
        phase: job.phase,
        durationSeconds: durationS(job),
      };
      writeJson(path.join(jobDir(stateDir, job.id), "usage.json"), job.usage);
    }
  }

  // A stream that never reached (or never carried) a terminal `result`
  // event still leaves whatever `system`/`init` reported — the only source
  // of a session id when nothing else names one (kusabi #215 Job B item 5).
  if (!job.sessionID && streamAcc.sessionIdFromInit) {
    job.sessionID = streamAcc.sessionIdFromInit;
  }

  appendEvent(stateDir, job.id, {
    type: "companion.claude.finished",
    status: job.status,
    sessionId: job.sessionID,
    exitCode: code,
    streamEvents: streamAcc.events,
    malformedLines,
  });
  saveJob(stateDir, job);

  let resultText = "";
  if (job.status === "completed" && parsed !== null) {
    // A run can end with no final message and the whole output still on disk
    // — for this backend in Claude Code's own transcript, since `claude -p`
    // is a child process and there is no stream of ours to record.  Recover
    // from it (deterministically, no LLM, no extra request) rather than write
    // an empty result.md (result-recovery.mjs).
    const resolved = resolveCompletedResult({
      backend: CLAUDE_BACKEND,
      fetched: claudeFinalMessage(parsed),
      coords: { sessionId: job.sessionID },
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
    saveJob(stateDir, job);
    fs.writeFileSync(path.join(jobDir(stateDir, job.id), "result.md"), resultText, "utf8");
  }

  return { job, resultText, stateDir };
}
