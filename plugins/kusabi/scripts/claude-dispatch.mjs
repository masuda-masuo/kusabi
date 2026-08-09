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
// v1 limits (deliberate, see docs/DESIGN.md §3.5.11):
//   - ONE model per phase: `explicitModel` when given, else the first route
//     of the tiered chain.  No tier ladder, no capacity fallback, no retry
//     walk — a failed dispatch returns a failed job and the chain's existing
//     escalate path handles it.  The whole chain is validated at command
//     start (validateClaudeChain) and chain commands clamp later phases to
//     the command-start model, so the model can never change — or fail —
//     mid-chain.  The default chain is claude-native (CLAUDE_DEFAULT_CHAIN);
//     the opencode built-in chain is never used by this backend.
//   - No session resume: the `session` option is ignored and every dispatch
//     starts a fresh `claude -p` session (resume is Job B).  The fresh
//     session id is recorded on the job record like the opencode path does.
//   - watchdogS (stall detection) is a NO-OP in v1: the child is bounded
//     only by timeoutS, which SIGKILLs the child's WHOLE process group
//     (claude + its children — MCP server, running tool commands) so no
//     orphaned work keeps running in the shared container.  Documented, not
//     silently dropped — see the comment at the spawn site.
//   - `:variant` model suffixes are rejected with an explicit error (never
//     silently ignored): `--allowedTools` has no variant concept and the
//     opencode variant knob has no claude equivalent.

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { firstRoute } from "./cli.mjs";
import { newJobId, saveJob, jobDir, appendEvent } from "./job-store.mjs";
import { stateDirFor, writeJson } from "./state-paths.mjs";
import { durationS } from "./render.mjs";

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
 * both work.
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
 * --setting-sources "" --output-format json --model <m> --allowedTools <csv>
 * --disallowedTools <csv> --mcp-config <path>
 * [--append-system-prompt <agent-body>]`.  The prompt is NOT on argv (I5) —
 * it is written to the child's stdin, so it cannot leak into `ps` output or
 * argv-logged transcripts, and it is never length-limited by the argv cap.
 * `--strict-mcp-config` + `--setting-sources ""` (I2) isolate the session
 * from ambient settings: only the generated `--mcp-config` applies, so an
 * MCP tool call without a matching `--allowedTools` entry is blocked (the
 * deny-by-default posture).  `--disallowedTools` (I1/I3) is the
 * belt-and-braces deny for tools that must never run.
 *
 * @param {object} opts
 * @param {string} opts.model
 * @param {string} opts.allowedTools    — CSV.
 * @param {string} opts.disallowedTools — CSV.
 * @param {string} opts.mcpConfigPath
 * @param {string|null} [opts.systemPrompt]
 * @returns {string[]}
 */
export function buildClaudeArgs({ model, allowedTools, disallowedTools, mcpConfigPath, systemPrompt }) {
  const args = [
    "-p",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--output-format", "json",
    "--model", model,
    "--allowedTools", allowedTools,
    "--disallowedTools", disallowedTools,
    "--mcp-config", mcpConfigPath,
  ];
  if (systemPrompt) {
    args.push("--append-system-prompt", systemPrompt);
  }
  return args;
}

/**
 * Parse the single JSON object `claude -p --output-format json` prints on
 * stdout.
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

/**
 * Spawn `claude -p` and collect its stdout/stderr.  The prompt is written
 * to the child's stdin and the stream is ended (I5) — `claude -p` with no
 * prompt argument reads it from stdin, so the prompt never appears on argv.
 * The child runs in its own process group (detached) and the WHOLE GROUP is
 * killed (SIGKILL) when timeoutS elapses; watchdogS (stall detection) is a
 * NO-OP in v1 — the child either exits or is killed by the timeout, so a
 * stalled claude costs at most timeoutS (the opencode path's watchdog is
 * not ported because there is no SSE stream to measure silence against).
 * A process that deliberately detaches itself (setsid) escapes the group
 * kill — that is the documented v1 limit, everything else dies with the
 * timeout.
 *
 * @param {object} opts
 * @param {string} opts.bin
 * @param {string[]} opts.args
 * @param {string} [opts.cwd]
 * @param {number} [opts.timeoutS]
 * @param {string} [opts.promptText] — written to child stdin, then closed.
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string,
 *                     timedOut: boolean, spawnError: Error|null }>}
 */
export function runClaudeProcess({ bin, args, cwd, timeoutS, promptText }) {
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
    let spawnError = null;

    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
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
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} [opts.kind]
 * @param {string} [opts.title]
 * @param {string} [opts.promptText]
 * @param {string|null} [opts.agent]
 * @param {string|null} [opts.phase]
 * @param {string|null|undefined} [opts.session] — IGNORED in v1 (resume is
 *        Job B): every dispatch starts a fresh session.
 * @param {object|null|undefined} [opts.tools]  — deny map, applied to the
 *        allowlist so explicit denies are never silently ignored (user
 *        flags are translated to mcp__sunaba__* tool names by cmdTask
 *        first; phase-level maps' bare sunaba_* names are normalized
 *        inside applyToolDenies).
 * @param {number} [opts.timeoutS]
 * @param {number} [opts.watchdogS] — NO-OP in v1 (see runClaudeProcess).
 * @param {(string|string[])[]} [opts.tiers]
 * @param {number} [opts.round]
 * @param {number} [opts.tierIndex]
 * @param {string|null} [opts.explicitModel]
 * @returns {Promise<{ job: object, resultText: string, stateDir: string }>}
 */
export async function claudeDispatch(opts) {
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
  });

  // ---- job record (opencode-path shape + backend) ----
  const job = {
    id: newJobId(),
    kind: opts.kind || "task",
    title: opts.title || "",
    status: "running",
    backend: CLAUDE_BACKEND,
    sessionID: null,
    cwd: opts.cwd,
    phase: opts.phase ?? null,
    modelEntry,
    modelVariant: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    stats: { events: 0, steps: 0, lastTool: null, permissionsAllowed: 0, permissionsRejected: 0, lastActivity: null, models: [] },
    error: null,
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

  // ---- run ----
  const { code, stdout, stderr, timedOut, spawnError } = await runClaudeProcess({
    bin,
    args,
    cwd: opts.cwd,
    timeoutS: opts.timeoutS,
    promptText: opts.promptText || "",
  });

  job.finishedAt = new Date().toISOString();

  // ---- failure classification (all failure text preserved on the record) ----
  let parsed = null;
  if (spawnError) {
    job.status = "error";
    job.error = `claude dispatch failed: could not start ${bin}: ${spawnError.message}`;
  } else if (timedOut) {
    // Same failure status/text the opencode path uses for timeouts.
    job.status = "timeout";
    job.error = `timed out after ${opts.timeoutS}s`;
  } else if (code !== 0) {
    job.status = "error";
    const detail = (stderr || stdout || "(no output)").trim();
    job.error = `claude exited with code ${code}: ${detail}`;
  } else {
    try {
      parsed = parseClaudeResult(stdout);
    } catch (err) {
      job.status = "error";
      const snippet = stdout.trim().slice(0, 300);
      job.error = `claude produced unparseable output (${err.message}): ${snippet || "(empty stdout)"}`;
    }
    if (parsed !== null) {
      if (parsed.is_error === true) {
        job.status = "error";
        const detail = typeof parsed.result === "string" && parsed.result.trim()
          ? parsed.result.trim()
          : "claude reported is_error: true";
        job.error = `claude dispatch failed: ${detail}`;
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
  }

  appendEvent(stateDir, job.id, {
    type: "companion.claude.finished",
    status: job.status,
    sessionId: job.sessionID,
    exitCode: code,
  });
  saveJob(stateDir, job);

  let resultText = "";
  if (job.status === "completed" && parsed !== null) {
    resultText = typeof parsed.result === "string" ? parsed.result : JSON.stringify(parsed.result ?? "");
    fs.writeFileSync(path.join(jobDir(stateDir, job.id), "result.md"), resultText, "utf8");
  }

  return { job, resultText, stateDir };
}
