// codex-dispatch.mjs — Codex CLI backend for kusabi job dispatch (kusabi #527).
//
// Backend contract: a function with the SAME call/return shape as
// `dispatchWithFallback` (prompt-execution.mjs) and `claudeDispatch` /
// `agyDispatch` / `cursorDispatch`: it receives the dispatch options object
// (cwd, kind, title, promptText, agent, phase, session, sessionProvenance,
// tools, timeoutS, watchdogS, tiers, round, explicitModel) and resolves to
// `{ job, resultText, stateDir }`.  kusabi-companion.mjs picks this function
// per phase; the chain phases stay backend-blind.
//
// WHY a fifth backend: on 2026-09-20 the operator accepted an opt-in
// trusted-seat evaluation model in which kusabi dispatches to the Codex CLI
// (`codex exec`) for the exact seat models `gpt-5.6-luna` and `gpt-5.6-sol`.
// The backend reuses the shared process runner exactly like cursor/agy and
// preserves exact model/reasoning provenance by cross-checking the CLI's own
// rollout record after the process closes.
//
// ---------------------------------------------------------------------------
// The CLI contract (field-verified by a hand run, 2026-09-20, codex-cli
// 0.154.0 — MEASURED. Do not re-derive, do not doubt.)
// ---------------------------------------------------------------------------
//
// Fresh command shape:
//
//   codex exec --ignore-user-config --ignore-rules --skip-git-repo-check
//     -C <cwd> -s read-only --json -m <exact-model>
//     -c 'model_reasoning_effort="high"' -c 'mcp_servers={}' -
//
// Prompt on **stdin** (the trailing `-`), never argv.
//
// stdout is NDJSON, one event object per line, discriminated by `type`:
//
//   {"type":"thread.started","thread_id":"…", ...}
//   {"type":"turn.started", ...}
//   {"type":"item.completed","item":{"agent_message":{"text":"…"}}, ...}
//   {"type":"turn.completed","usage":{"input_tokens":…,"cached_input_tokens":…,
//       "cache_write_input_tokens":…,"output_tokens":…}, ...}
//
// `thread.started.thread_id` is the thread/session id the job records as
// sessionID.  Terminal assistant text is the LAST
// `item.completed.item.agent_message.text` (earlier ones are commentary).  `--output-schema` returns the
// terminal JSON text in that SAME agent-message item, so extraction is
// identical for both framings; only the argv differs.
//
// Resume shape (measured): `codex exec resume` has no `--sandbox`, so the
// read-only sandbox and the never-approval policy are passed as config:
//
//   codex exec resume <thread_id> --ignore-user-config --ignore-rules
//     --skip-git-repo-check -C <cwd> -m <exact-model>
//     -c 'model_reasoning_effort="high"' -c 'mcp_servers={}'
//     -c 'sandbox_mode="read-only"' -c 'approval_policy="never"'
//     --json [-]
//
// Resume under the same CODEX_HOME preserves the thread id (measured); the
// thread id is passed explicitly AND the job-owned CODEX_HOME is reused, so
// the continuation cannot attach to a different thread.  `-a` is never passed
// to `codex exec` (measured: the resume subcommand has no approval flag and
// passing one is an error).
//
// Dedicated state: EVERY invocation sets both HOME and CODEX_HOME to a
// job-owned directory under the job record, so the child never inherits the
// orchestrator's config/rules/sessions/MCP servers.  The one exception is the
// minimum auth bridge: for a ChatGPT-subscription login, `auth.json` in the
// job-owned CODEX_HOME is a symlink to the operator's own auth cache.  This
// is deliberate under the accepted same-user trusted-seat model — credential
// non-readability is NOT claimed.  Auth contents are never copied into result
// text, events, usage, or publishable files.
//
// Capability honesty (accepted trust model):
//   - `--read-only` is the FIXED invocation boundary (`-s read-only`); the
//     sandbox is always read-only, and `--read-only` on the command line is
//     accepted because it states what the invocation already enforces.
//   - For Luna/Sol coordinator and auditor seats, no MCP servers are
//     configured (`mcp_servers={}`), but Codex retains its BUILT-IN COMMAND
//     TOOL inside the sandbox.
//   - Worker seats get only the job-owned MCP tables derived from Claude's
//     allowlist; a denied MCP tool is enforced by omission from
//     `enabled_tools`.  Denies for tools outside that grant remain recorded
//     as unenforced, never presented as applied.
//   - The backend is NEVER described as tool-free or credential-isolated; the
//     job record carries `codexCommandTool: true` and the fixed read-only
//     sandbox boundary.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { firstRoute, WRITE_TOOL_NAMES } from "./cli.mjs";
import { readAgentSystemPrompt } from "./agent-system-prompt.mjs";
import {
  allowedToolsForAgent,
  applyToolDenies,
  translateDenyTools,
  DISALLOWED_TOOLS,
} from "./tool-permissions.mjs";
import { newJobId, saveJob, jobDir, appendEvent } from "./job-store.mjs";
import { stateDirFor, writeJson, kusabiOpencodeConfigHome } from "./state-paths.mjs";
import { durationS } from "./render.mjs";
import { resolveCompletedResult } from "./result-recovery.mjs";
import { deriveStopReason } from "./stop-reason.mjs";
import { startKaibaProgressWatch } from "./kaiba-progress-watch.mjs";
import { isUsableTimeoutS, runBackendProcess } from "./backend-process-runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");

export const CODEX_BACKEND = "codex";

// The exact seat ids this backend can execute (accepted trust model, #527).
// v1 is deliberately closed: an explicit pin must be ONE of these exact ids,
// and provenance cross-checking compares the requested id byte-for-byte
// against the model the CLI's own rollout records.
export const CODEX_SUPPORTED_MODELS = ["gpt-5.6-luna", "gpt-5.6-sol"];

// The default chain may contain the exact supported seat ids.  ONE tier with
// both seats, first route first: this backend pins one model per phase and
// never walks a fallback after a terminal failure, so the tier carries
// interchangeable routes exactly like the other pinning backends' defaults.
export const CODEX_DEFAULT_CHAIN = [["gpt-5.6-luna", "gpt-5.6-sol"]];

// Reasoning effort is FIXED to high in v1 (measured fresh invocation).  It is
// not configurable and never translated from a :variant suffix.
export const CODEX_REASONING_EFFORT = "high";

// The sandbox every invocation runs in (measured `-s read-only`).
export const CODEX_SANDBOX_POLICY = "read-only";

// The agent whose output contract IS the review verdict.  When a dispatch
// carries it, `--output-schema` enforces the shape at the CLI (the measured
// `--output-schema` framing returns the terminal JSON text in the
// agent-message item, which the same extraction path reads).
export const REVIEW_AGENT = "kusabi-review";

// Tests point CODEX_BIN at a fake script.  The real binary is a host install
// (`codex` from codex-cli) that exists in neither CI nor the sunaba
// container; no test may ever require it.
export function codexBin() {
  return process.env.CODEX_BIN || "codex";
}

// =========================================================================
// model syntax — pure
// =========================================================================

/**
 * Validate a model entry for the codex backend.
 *
 * Accepted: exactly the supported seat ids (`gpt-5.6-luna`, `gpt-5.6-sol`).
 * A `:variant` suffix is rejected with an explicit error — reasoning effort
 * is fixed to `high` and never translated from a variant.  Any other id is
 * rejected too: v1 executes the exact seats and nothing else, so an unknown
 * id fails at command start instead of becoming a silently-different run.
 *
 * @param {string|null|undefined} value
 * @returns {string|null} The normalized model string, or null when absent.
 * @throws {Error} When the entry carries a `:variant` suffix or is not an
 *         exact supported seat id.
 */
export function validateCodexModel(value) {
  if (value === undefined || value === null || value === "") return null;
  const v = String(value);
  if (v.indexOf(":") >= 0) {
    throw new Error(
      `codex backend does not support the :variant suffix in model "${v}" — ` +
      "reasoning effort is fixed to high; use one of the exact supported seat ids: " +
      "gpt-5.6-luna or gpt-5.6-sol"
    );
  }
  if (!CODEX_SUPPORTED_MODELS.includes(v)) {
    throw new Error(
      `codex backend does not support model "${v}" — v1 executes the exact seat ids ` +
      "gpt-5.6-luna and gpt-5.6-sol, and an explicit pin is never substituted with another model"
    );
  }
  return v;
}

/**
 * Validate EVERY route of a (tiered) chain for the codex backend.
 *
 * @param {(string|string[])[]} chain
 * @returns {(string|string[])[]} The chain, unchanged.
 * @throws {Error} Naming the offending entry.
 */
export function validateCodexChain(chain) {
  for (const tier of Array.isArray(chain) ? chain : []) {
    const routes = Array.isArray(tier) ? tier : [tier];
    for (const route of routes) {
      try {
        validateCodexModel(route);
      } catch (err) {
        throw new Error(
          `codex backend: chain entry "${route}" is not a supported codex model — ` +
          "configure models.chain with exact seat ids (gpt-5.6-luna or gpt-5.6-sol): " +
          err.message
        );
      }
    }
  }
  return chain;
}

/**
 * Resolve the model for the codex backend, mirroring `resolveAgyModel`.
 *
 * @param {object}   opts
 * @param {string}   [opts.flag]   — `--model` flag value.
 * @param {string}   [opts.phase]  — phase name (for models.phases.<phase>).
 * @param {object}   [opts.config] — loaded kusabi config.
 * @returns {{ model: string|undefined, chain: (string|string[])[] }}
 */
export function resolveCodexModel({ flag, phase, config }) {
  let chain;
  if (config?.models?.chain) {
    chain = [...config.models.chain];
  } else {
    chain = [...CODEX_DEFAULT_CHAIN];
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
// MCP allowlists + worker configuration
// =========================================================================
//
// The Claude backend owns the permission tables. Codex consumes the same
// exported accessor and translates Claude's mcp__<server>__<tool> spelling to
// the bare tool names Codex expects in each server's enabled_tools list.
//
// Worker endpoints and commands are operator-owned in the JSONC file seeded by
// install-agents. The operator's ~/.codex/config.toml is never read: Codex is
// invoked with explicit -c overrides because --ignore-user-config ignores it.
export const CODEX_MCP_AGENTS = new Set([
  "kusabi-implement",
  "kusabi-review",
  "kusabi-plan",
  "kusabi-test-author",
  "kusabi-investigate",
]);

function bareMcpToolName(name) {
  const match = /^mcp__([^_]+)__([\s\S]+)$/.exec(name);
  return match ? { server: match[1], tool: match[2] } : null;
}

/**
 * Compute the Codex MCP grants from the Claude backend's canonical allowlist.
 *
 * @param {string|null|undefined} agent
 * @param {object|null|undefined} tools - the phase/user deny map
 * @returns {Record<string, string[]>|null} server -> enabled tool names
 */
export function codexMcpToolsForAgent(agent, tools = null) {
  if (!CODEX_MCP_AGENTS.has(agent)) return null;

  const deniedAllowlist = applyToolDenies(
    allowedToolsForAgent(agent),
    translateDenyTools(tools),
  );
  const disallowed = new Set(DISALLOWED_TOOLS);
  const servers = {};

  for (const name of deniedAllowlist.split(",").filter(Boolean)) {
    const parsed = bareMcpToolName(name);
    if (!parsed) continue;
    const tool = `mcp__${parsed.server}__${parsed.tool}`;
    // Codex must never receive a hardcoded disallowed tool, including the
    // investigate-only Claude exception for issue writes.
    if (disallowed.has(tool)) continue;
    const list = servers[parsed.server] ?? (servers[parsed.server] = []);
    const bare = parsed.tool === "*" ? "*" : parsed.tool;
    if (!list.includes(bare)) list.push(bare);
  }

  return servers;
}

function stripJsoncComments(source) {
  let out = "";
  let quote = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (ch === "\n") {
        lineComment = false;
        out += ch;
      }
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i += 1;
      } else if (ch === "\n") {
        out += ch;
      }
      continue;
    }
    if (quote) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') {
      quote = true;
      out += ch;
    } else if (ch === "/" && next === "/") {
      lineComment = true;
      i += 1;
    } else if (ch === "/" && next === "*") {
      blockComment = true;
      i += 1;
    } else {
      out += ch;
    }
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

/**
 * Read kusabi's operator-owned worker MCP config.
 *
 * @param {string} [configFile] absolute JSONC config path
 * @returns {object}
 */
export function readCodexWorkerMcpConfig(
  configFile = path.join(kusabiOpencodeConfigHome(), "opencode", "opencode.jsonc"),
) {
  if (!fs.existsSync(configFile)) {
    throw new Error(`Codex worker MCP config is missing: ${configFile}`);
  }
  let config;
  try {
    config = JSON.parse(stripJsoncComments(fs.readFileSync(configFile, "utf8")));
  } catch (err) {
    throw new Error(`Codex worker MCP config is not valid JSONC: ${configFile}: ${err.message}`);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`Codex worker MCP config must be an object: ${configFile}`);
  }
  if (!config.mcp || typeof config.mcp !== "object" || Array.isArray(config.mcp)) {
    throw new Error(`Codex worker MCP config has no mcp object: ${configFile}`);
  }
  return config;
}

/**
 * Resolve granted servers from the seeded worker config.
 *
 * @param {Record<string, string[]>} toolsByServer
 * @param {string} [configFile]
 * @returns {Record<string, object>}
 */
export function codexMcpServerDefinitions(
  toolsByServer,
  configFile = path.join(kusabiOpencodeConfigHome(), "opencode", "opencode.jsonc"),
) {
  const configured = readCodexWorkerMcpConfig(configFile).mcp;
  const out = {};

  for (const [server, enabledTools] of Object.entries(toolsByServer ?? {})) {
    const entry = configured[server];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Codex worker MCP server "${server}" is missing from ${configFile}`);
    }
    if (entry.enabled === false) continue;

    if (entry.type === "remote") {
      if (typeof entry.url !== "string" || entry.url.length === 0) {
        throw new Error(`Codex worker MCP server "${server}" has no remote url in ${configFile}`);
      }
      out[server] = {
        url: server === "sunaba" && process.env.KUSABI_SUNABA_URL
          ? process.env.KUSABI_SUNABA_URL
          : entry.url,
        ...(entry.environment === undefined ? {} : { env: entry.environment }),
        enabledTools,
      };
      continue;
    }

    if (entry.type === "local") {
      if (!Array.isArray(entry.command) || entry.command.length === 0 ||
          entry.command.some((part) => typeof part !== "string" || part.length === 0)) {
        throw new Error(`Codex worker MCP server "${server}" has no valid local command in ${configFile}`);
      }
      out[server] = {
        command: entry.command[0],
        args: entry.command.slice(1),
        env: entry.environment ?? {},
        enabledTools,
      };
      continue;
    }

    throw new Error(`Codex worker MCP server "${server}" has unsupported type in ${configFile}`);
  }

  return out;
}

function tomlLiteral(value) {
  return JSON.stringify(value);
}

/**
 * Add explicit Codex config overrides for the granted worker servers.
 *
 * @param {Record<string, object>} definitions
 * @returns {string[]}
 */
export function codexMcpArgv(definitions) {
  const args = [];
  for (const [server, definition] of Object.entries(definitions ?? {})) {
    const prefix = `mcp_servers.${server}`;
    if (definition.url) args.push("-c", `${prefix}.url=${tomlLiteral(definition.url)}`);
    if (definition.command) args.push("-c", `${prefix}.command=${tomlLiteral(definition.command)}`);
    if (definition.args?.length) args.push("-c", `${prefix}.args=${tomlLiteral(definition.args)}`);
    // One `-c` per env key: a JSON object is not a TOML inline table, and
    // Codex rejects `env="{...}"` as a string where a map is expected
    // (measured 2026-09-27, codex-cli 0.155.1).
    for (const [key, value] of Object.entries(definition.env ?? {})) {
      args.push("-c", `${prefix}.env.${key}=${tomlLiteral(value)}`);
    }
    args.push("-c", `${prefix}.enabled_tools=${tomlLiteral(definition.enabledTools)}`);
    args.push("-c", `${prefix}.default_tools_approval_mode=${tomlLiteral("approve")}`);
  }
  return args;
}


/**
 * Compose the prompt text handed to `codex exec` on stdin.
 * Codex has no `--append-system-prompt` in the measured argv list, so the
 * agent's role body is prepended inside a `<role>` block (agy/cursor pattern).
 *
 * @param {object} opts
 * @param {string|null} [opts.systemPrompt]
 * @param {string} [opts.promptText]
 * @returns {string}
 */
export function buildCodexPrompt({ systemPrompt, promptText }) {
  const body = promptText ?? "";
  if (!systemPrompt) return body;
  return `<role>\n${systemPrompt}\n</role>\n\n${body}`;
}

/**
 * Project the canonical review schema into the strict subset accepted by
 * Codex's `--output-schema` response format.
 *
 * This is deliberately pure: callers own the canonical input and receive a
 * recursively cloned projection.  Codex requires every declared property to
 * be required, so properties that are optional in the canonical schema are
 * made nullable to preserve their original optionality.
 *
 * @param {unknown} schema
 * @returns {unknown}
 */
export function toCodexStrictSchema(schema) {
  if (Array.isArray(schema)) return schema.map((value) => toCodexStrictSchema(value));
  if (schema === null || typeof schema !== "object") return schema;

  const projected = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$schema" || key === "if" || key === "then" || key === "else") continue;
    projected[key] = toCodexStrictSchema(value);
  }

  if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    const originalRequired = new Set(Array.isArray(schema.required) ? schema.required : []);
    projected.required = Object.keys(schema.properties);
    projected.properties = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      const property = toCodexStrictSchema(value);
      if (!originalRequired.has(key) && property && typeof property === "object" && !Array.isArray(property)) {
        if (property.type !== undefined) {
          const types = Array.isArray(property.type) ? [...property.type] : [property.type];
          if (!types.includes("null")) types.push("null");
          property.type = types;
        }
        if (Array.isArray(property.enum) && !property.enum.includes(null)) {
          property.enum = [...property.enum, null];
        }
      }
      projected.properties[key] = property;
    }
  }

  return projected;
}

/**
 * Load and project the one canonical review schema.  The returned text is
 * used only as the contents of the per-job schema file.
 *
 * @param {string|null|undefined} agent
 * @returns {string|null}
 */
export function codexJsonSchemaFor(agent) {
  if (agent !== REVIEW_AGENT) return null;
  const raw = fs.readFileSync(path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json"), "utf8");
  return JSON.stringify(toCodexStrictSchema(JSON.parse(raw)));
}

/**
 * Remove nulls that Codex emits for properties made nullable by the strict
 * projection.  Required canonical properties intentionally remain untouched.
 *
 * @param {unknown} value
 * @param {object} schema
 * @returns {unknown}
 */
export function stripCodexOptionalNulls(value, schema) {
  if (Array.isArray(value)) {
    return value.map((item) => stripCodexOptionalNulls(item, schema?.items));
  }
  if (value === null || typeof value !== "object" || !schema || typeof schema !== "object") {
    return value;
  }

  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? schema.properties
    : {};
  const clean = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === null && Object.hasOwn(properties, key) && !required.has(key)) continue;
    clean[key] = stripCodexOptionalNulls(child, properties[key]);
  }
  return clean;
}

/**
 * Parse and clean a Codex review JSON result.  Malformed/non-JSON text is
 * returned unchanged for the existing downstream parser to report.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripCodexOptionalNullsFromText(text) {
  if (typeof text !== "string") return text;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  return JSON.stringify(stripCodexOptionalNulls(value, loadCanonicalReviewSchema()));
}

function loadCanonicalReviewSchema() {
  const raw = fs.readFileSync(path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json"), "utf8");
  return JSON.parse(raw);
}

/**
 * Build the argv for a `codex exec` dispatch.
 *
 * MEASURED contract (2026-09-20, codex-cli 0.154.0):
 *
 * Fresh:
 *   codex exec --ignore-user-config --ignore-rules --skip-git-repo-check
 *     -C <cwd> -s read-only --json -m <model>
 *     -c 'model_reasoning_effort="high"' -c 'mcp_servers={}' [-]
 *
 * Resume:
 *   codex exec resume <thread_id> --ignore-user-config --ignore-rules
 *     --skip-git-repo-check -C <cwd> -m <model>
 *     -c 'model_reasoning_effort="high"' -c 'mcp_servers={}'
 *     -c 'sandbox_mode="read-only"' -c 'approval_policy="never"'
 *     --json [-]
 *
 * The one measured difference from the one-shot probe is deliberate:
 * `--ephemeral` is NEVER passed, because persistence is required — the
 * rollout/session state must survive under the job-owned CODEX_HOME so
 * resume and model verification work.  Isolation comes from the dedicated
 * home, not from ephemerality.
 *
 * `-s read-only` appears on the FRESH invocation only: `codex exec resume`
 * has no `--sandbox`, so the resume invocation carries the sandbox as
 * `-c 'sandbox_mode="read-only"'` (and the never-approval policy as
 * `-c 'approval_policy="never"'`).  `-a` is never passed to `codex exec`.
 *
 * The prompt is on STDIN only (the trailing `-`), never argv.
 *
 * @param {object} opts
 * @param {string} opts.model — an exact supported seat id.
 * @param {string} opts.cwd — the working directory (`-C`).
 * @param {string|null|undefined} [opts.sessionId] — the recorded thread id;
 *        present => the resume subcommand shape.
 * @param {string|null} [opts.jsonSchema] — schema file path, or null.
 * @param {Record<string, object>|null} [opts.mcpServers] — concrete worker
 *        MCP definitions; each server becomes explicit -c overrides.
 * @param {boolean} [opts.mcpEnabled] — compatibility shorthand for callers
 *        that only need to select the MCP argv shape.
 * @returns {string[]}
 */
export function buildCodexArgs({ model, cwd, sessionId, jsonSchema, mcpServers = null, mcpEnabled = false }) {
  const mcpGranted = mcpEnabled || (mcpServers && Object.keys(mcpServers).length > 0);
  const mcpOverrides = mcpGranted ? codexMcpArgv(mcpServers) : [];
  const common = [
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "-C", cwd,
  ];
  const modelAndEffort = [
    "-m", model,
    "-c", `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`,
    ...mcpOverrides,
    ...(mcpGranted ? [] : ["-c", "mcp_servers={}"]),
  ];
  const jsonOut = ["--json"];
  const schemaArgs = jsonSchema ? ["--output-schema", jsonSchema] : [];

  if (typeof sessionId === "string" && sessionId !== "") {
    // Resume: no `-s` (the resume subcommand has no --sandbox) and no `-a`
    // (never passed to `codex exec`).  The sandbox and approval policy ride
    // as config overrides; the thread id is passed explicitly.
    return [
      "exec", "resume", sessionId,
      ...common,
      ...modelAndEffort,
      "-c", `sandbox_mode="${CODEX_SANDBOX_POLICY}"`,
      "-c", 'approval_policy="never"',
      ...jsonOut,
      ...schemaArgs,
      "-",
    ];
  }
  return [
    "exec",
    ...common,
    "-s", CODEX_SANDBOX_POLICY,
    ...jsonOut,
    ...modelAndEffort,
    ...schemaArgs,
    "-",
  ];
}

// =========================================================================
// stream parsing — pure
// =========================================================================

/**
 * Parse one line of the codex NDJSON stream.  Returns null for blank lines
 * and non-JSON prose (the same tolerance every backend applies).
 *
 * @param {string} line
 * @returns {object|null}
 */
export function parseCodexStreamLine(line) {
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
 * Pull the thread id off a `thread.started` event (measured: top-level
 * `thread_id`).  This is the thread/session id the job records as sessionID
 * and the resume invocation passes back.
 *
 * @param {object} evt
 * @returns {string|null}
 */
export function codexThreadIdFromEvent(evt) {
  return typeof evt?.thread_id === "string" && evt.thread_id ? evt.thread_id : null;
}

/**
 * Extract assistant text from an `item.completed` event.
 *
 * Two measured shapes:
 *   - CURRENT flat shape (live codex-cli 0.154.0, incident
 *     mission-mucn5qb2a76e2095): `item.type === "agent_message"` with the
 *     terminal text on `item.text`.
 *   - LEGACY nested shape (the previously measured contract):
 *     `item.agent_message.text`.
 *
 * Non-agent items (tool_call, custom_tool_call, ...) and malformed shapes
 * contribute no text and never throw.
 *
 * @param {object} evt
 * @returns {string}
 */
export function codexAssistantTextFromEvent(evt) {
  const item = evt?.item;
  if (!item || typeof item !== "object") return "";
  if (item.type === "agent_message" && typeof item.text === "string") {
    return item.text;
  }
  const legacy = item.agent_message?.text;
  return typeof legacy === "string" ? legacy : "";
}

/**
 * A fresh accumulator for folding a codex NDJSON stream into job stats.
 *
 * @returns {{ events: number, steps: number, lastTool: string|null,
 *             lastActivity: string|null, models: string[],
 *             threadId: string|null, assistantText: string,
 *             usageEvent: object|null }}
 */
export function initCodexStreamAccumulator() {
  return {
    events: 0,
    steps: 0,
    lastTool: null,
    lastActivity: null,
    models: [],
    threadId: null,
    assistantText: "",
    usageEvent: null,
  };
}

/**
 * Fold one parsed stream event into the accumulator (mutates and returns
 * it).  Every parsed object bumps `events` and `lastActivity`; the measured
 * kinds contribute:
 *
 *   - `thread.started` — the thread id (top-level `thread_id`).
 *   - `item.completed` — assistant text from `item.agent_message.text`
 *     (terminal text for both the text and `--output-schema` framings);
 *     each completed item also counts one step (a message or a tool item).
 *   - `turn.completed` — the `usage` event kept as `usageEvent`; a later one
 *     replaces an earlier one.
 *
 * Unknown kinds and malformed shapes must not throw.
 *
 * @param {object} acc
 * @param {object} evt
 * @param {string} [now]
 * @returns {object}
 */
export function applyCodexStreamEvent(acc, evt, now = new Date().toISOString()) {
  if (!acc || typeof acc !== "object") return acc;
  if (!evt || typeof evt !== "object") return acc;
  acc.events += 1;
  acc.lastActivity = now;
  try {
    const type = evt.type;
    if (type === "thread.started") {
      const id = codexThreadIdFromEvent(evt);
      if (id) acc.threadId = id;
    } else if (type === "item.completed") {
      acc.steps += 1;
      // The LAST agent message is the answer; earlier ones are commentary.
      // A turn can complete several agent_message items (phase commentary
      // before tool calls, then final_answer); concatenating them glued
      // three JSONL batches together with no separator and the coordinator
      // parser refused the whole stream as truncated (mission-mudmmnaub60f0b20,
      // job-mudmn0ba8267: 481 + 555 + 555 = the 1591 assistantChars recorded).
      const text = codexAssistantTextFromEvent(evt);
      if (text) acc.assistantText = text;
    } else if (type === "turn.completed") {
      acc.usageEvent = evt;
    }
  } catch {
    // A malformed event must never take down the dispatch.
  }
  return acc;
}

/**
 * Map the terminal `turn.completed.usage` object onto the job-record usage
 * shape the other backends already store.  MEASURED snake-case token fields
 * (codex-cli 0.154.0, same vocabulary codex-usage-ingest.mjs reads):
 * input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens.
 * `total_tokens` / `reasoning_tokens` / `cost_usd` are mapped when present;
 * total defaults to the sum of the four measured counters.
 *
 * @param {object|null} result
 * @returns {object}
 */
export function mapCodexUsage(result) {
  const u = result?.usage ?? {};
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const cacheRead = u.cached_input_tokens ?? 0;
  const cacheWrite = u.cache_write_input_tokens ?? 0;
  return {
    available: true,
    input,
    output,
    reasoning: u.reasoning_tokens ?? 0,
    cacheRead,
    cacheWrite,
    total: u.total_tokens ?? (input + output + cacheRead + cacheWrite),
    cost: u.cost_usd ?? 0,
    model: result?.model ?? null,
  };
}

/**
 * A short, faithful description of what arrived — quoted into failure
 * messages so the error names the received payload.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function describeCodexResult(value) {
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
 * Fail-closed check on a RESOLVED codexDispatch result: a job that did not
 * reach status "completed" is a dispatch/seat failure, never an empty
 * stream.  The Luna coordinator and Sol audit seams share this check so a
 * failed Codex job surfaces as a dispatch/audit-seat failure naming the job
 * id, status and recorded error — it must never be parsed as an empty
 * coordinator/verdict stream (the mission-mucn5qb2a76e2095 mislabel).
 *
 * Throws when the job is not completed; otherwise returns the result
 * unchanged so the caller keeps the public `{ job, resultText, stateDir }`
 * contract.
 *
 * @param {{ job: object, resultText: string, stateDir: string }} result
 * @param {string} [label] — the caller's slot name for the error message.
 * @returns {{ job: object, resultText: string, stateDir: string }}
 */
export function assertCodexDispatchSucceeded({ job, resultText, stateDir }, label = "codex") {
  if (job?.status === "completed") return { job, resultText, stateDir };
  const id = job?.id ?? "unknown";
  const status = job?.status ?? "unknown";
  const error = job?.error ?? "no error recorded";
  throw new Error(`codex dispatch failed (${label}): job ${id} resolved ${status}: ${error}`);
}

// =========================================================================
// dedicated state + auth bridge
// =========================================================================

/**
 * The job-owned Codex home for one job: a directory under the job record.
 * Every invocation sets BOTH HOME and CODEX_HOME to this directory, so the
 * child never inherits the orchestrator's config/rules/sessions/MCP files.
 * The CLI's own rollout/session state persists here, which is what makes
 * resume and post-close model verification work (this is the deliberate
 * difference from the one-shot probe, which used --ephemeral).
 *
 * @param {string} stateDir
 * @param {string} jobId
 * @returns {string}
 */
export function codexHomeForJob(stateDir, jobId) {
  return path.join(jobDir(stateDir, jobId), "codex-home");
}

/**
 * The operator's own Codex home, resolved from the PARENT environment (the
 * child's env is overridden to the job-owned home, so this must be read
 * before the spawn).  Defaults to `~/.codex`, the CLI's own default.
 *
 * @returns {string}
 */
export function operatorCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

/**
 * Create the MINIMUM auth bridge the real CLI needs for a ChatGPT
 * subscription login: `auth.json` in the job-owned home symlinked to the
 * operator's own auth cache.  Acceptable under the explicitly accepted
 * same-user trust model; credential non-readability is NOT claimed.  The
 * bridge never reads auth contents, so nothing of them can leak into result
 * text, events, usage, or publishable files.
 *
 * A missing operator auth file is a normal outcome (the CLI will fail on
 * auth itself) and yields `{ bridge: "none" }` — no error, no invented file.
 *
 * @param {string} jobCodexHome
 * @returns {{bridge: "symlinked"}|{bridge: "none", reason: string}}
 */
export function linkOperatorAuth(jobCodexHome) {
  const operatorAuth = path.join(operatorCodexHome(), "auth.json");
  let stat = null;
  try {
    stat = fs.statSync(operatorAuth);
  } catch {
    return { bridge: "none", reason: "operator-auth-file-absent" };
  }
  if (!stat.isFile()) {
    return { bridge: "none", reason: "operator-auth-file-not-a-file" };
  }
  fs.mkdirSync(jobCodexHome, { recursive: true });
  const target = path.join(jobCodexHome, "auth.json");
  try {
    fs.symlinkSync(operatorAuth, target);
    return { bridge: "symlinked" };
  } catch (err) {
    if (err?.code === "EEXIST") return { bridge: "symlinked" };
    return { bridge: "none", reason: `symlink-failed: ${err?.code ?? err?.message ?? err}` };
  }
}

// =========================================================================
// rollout provenance verification — pure over JSONL text
// =========================================================================

/**
 * Parse Codex rollout JSONL text into the provenance fields the adapter can
 * verify.  Tolerant: non-JSON lines are skipped, and a missing field stays
 * null (absent, not asserted).  The rollout vocabulary (codex-usage-ingest
 * reads the same records) is:
 *
 *   {"type":"session_meta","payload":{"id","cwd", model, model_reasoning_effort,
 *      approval_policy, sandbox_policy, network_policy, ...}}
 *   {"type":"turn_context","payload":{"turn_id","model", model_reasoning_effort, ...}}
 *
 * The actual model may live on session_meta or turn_context payloads; effort
 * and the policies are read from either record type when present.
 *
 * The per-record arrays (`sessionMetas`, `turns`) preserve FILE ORDER so a
 * RESUMED dispatch can bind to the evidence the resumed invocation itself
 * produced (its turn_context is the LAST one in the thread's rollout) instead
 * of a stale matching turn from the original session.  The flat aggregate
 * fields keep the fresh-dispatch semantics exactly as they have always been
 * (last session_meta wins, first named turn as the model fallback).
 *
 * @param {string} content — the full text of one or more rollout files.
 * @returns {{ found: boolean, model: string|null, reasoningEffort: string|null,
 *             approvalPolicy: string|null, sandboxPolicy: string|null,
 *             networkPolicy: string|null,
 *             sessionMetas: object[], turns: Array<{model: string|null,
 *               reasoningEffort: string|null}> }}
 */
export function parseRolloutProvenance(content) {
  const sessionMetas = [];
  const turns = [];
  const turnModels = [];
  let found = false;
  const lines = typeof content === "string" ? content.split("\n") : [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) continue;
    const payload = rec.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    if (rec.type === "session_meta") {
      found = true;
      const meta = {
        model: typeof payload.model === "string" && payload.model ? payload.model : null,
        reasoningEffort: typeof payload.model_reasoning_effort === "string" && payload.model_reasoning_effort
          ? payload.model_reasoning_effort
          : null,
        approvalPolicy: typeof payload.approval_policy === "string" && payload.approval_policy
          ? payload.approval_policy
          : null,
        sandboxPolicy: (typeof payload.sandbox_policy === "string" && payload.sandbox_policy)
          ? payload.sandbox_policy
          : (typeof payload.sandbox_mode === "string" && payload.sandbox_mode ? payload.sandbox_mode : null),
        networkPolicy: typeof payload.network_policy === "string" && payload.network_policy
          ? payload.network_policy
          : null,
      };
      sessionMetas.push(meta);
    } else if (rec.type === "turn_context") {
      found = true;
      const model = typeof payload.model === "string" && payload.model ? payload.model : null;
      const reasoningEffort = typeof payload.model_reasoning_effort === "string" && payload.model_reasoning_effort
        ? payload.model_reasoning_effort
        : null;
      if (model) turnModels.push(model);
      turns.push({ model, reasoningEffort });
    }
  }
  const lastMeta = sessionMetas[sessionMetas.length - 1] ?? null;
  return {
    found,
    model: lastMeta?.model || turnModels[0] || null,
    reasoningEffort: lastMeta?.reasoningEffort ?? null,
    approvalPolicy: lastMeta?.approvalPolicy ?? null,
    sandboxPolicy: lastMeta?.sandboxPolicy ?? null,
    networkPolicy: lastMeta?.networkPolicy ?? null,
    sessionMetas,
    turns,
  };
}

/**
 * Verify a parsed rollout against the requested model and the fixed
 * reasoning effort.
 *
 *   state: "verified"      — the bound evidence's model matches the requested
 *                            one (and its effort, when present, matches the
 *                            fixed "high").
 *   state: "unverifiable"  — no rollout, or the bound evidence carries no
 *                            model field to check: represented EXPLICITLY as
 *                            unverifiable, never silently treated as verified.
 *   state: "mismatch"      — a present field contradicts the request.  The
 *                            caller fails the job closed on this: no
 *                            successful result, no fallback/substitution.
 *
 * `resumed: true` changes WHICH evidence is bound (kusabi #527 review
 * follow-up): the rollout of a resumed thread holds the ORIGINAL session's
 * records first and the resumed invocation's records last, and only the
 * resumed invocation's own evidence may verify the run.  The resumed turn is
 * the LAST turn_context in the rollout; a matching turn_context from the
 * original session is never accepted in its place, so a model or effort
 * mismatch on the resumed turn fails closed.  A resumed dispatch whose
 * rollout carries no turn_context at all is unverifiable (the resumed
 * invocation produced no turn evidence to bind to).
 *
 * @param {object} opts
 * @param {object} opts.rollout — output of `parseRolloutProvenance`.
 * @param {string} opts.requestedModel — the exact model the invocation asked for.
 * @param {string} [opts.requestedEffort] — defaults to CODEX_REASONING_EFFORT.
 * @param {boolean} [opts.resumed] — bind to the resumed invocation's own
 *        (last) turn_context evidence instead of the fresh-path aggregate.
 * @returns {object}
 */
export function verifyRolloutProvenance({ rollout, requestedModel, requestedEffort = CODEX_REASONING_EFFORT, resumed = false }) {
  if (!rollout?.found) {
    return { state: "unverifiable", reason: "no-rollout-record" };
  }
  if (resumed) {
    // Bind to the evidence the RESUMED invocation itself produced.  The
    // thread's rollout holds the original session's records first and the
    // resumed run's records last, so the resumed turn is the LAST
    // turn_context.  A stale matching turn_context from the original session
    // must never verify a resumed run whose own turn mismatches.
    const turns = Array.isArray(rollout.turns) ? rollout.turns : [];
    const turn = turns[turns.length - 1] ?? null;
    if (!turn) {
      return { state: "unverifiable", reason: "no-resumed-turn-evidence" };
    }
    if (!turn.model) {
      return { state: "unverifiable", reason: "rollout-model-field-absent" };
    }
    if (turn.model !== requestedModel) {
      return {
        state: "mismatch",
        kind: "model",
        requested: requestedModel,
        actual: turn.model,
      };
    }
    if (turn.reasoningEffort && turn.reasoningEffort !== requestedEffort) {
      return {
        state: "mismatch",
        kind: "reasoning-effort",
        requested: requestedEffort,
        actual: turn.reasoningEffort,
      };
    }
    return {
      state: "verified",
      model: turn.model,
      reasoningEffort: turn.reasoningEffort ?? null,
      approvalPolicy: rollout.approvalPolicy ?? null,
      sandboxPolicy: rollout.sandboxPolicy ?? null,
      networkPolicy: rollout.networkPolicy ?? null,
    };
  }
  if (rollout.model && rollout.model !== requestedModel) {
    return {
      state: "mismatch",
      kind: "model",
      requested: requestedModel,
      actual: rollout.model,
    };
  }
  if (!rollout.model) {
    return { state: "unverifiable", reason: "rollout-model-field-absent" };
  }
  if (rollout.reasoningEffort && rollout.reasoningEffort !== requestedEffort) {
    return {
      state: "mismatch",
      kind: "reasoning-effort",
      requested: requestedEffort,
      actual: rollout.reasoningEffort,
    };
  }
  return {
    state: "verified",
    model: rollout.model,
    reasoningEffort: rollout.reasoningEffort ?? null,
    approvalPolicy: rollout.approvalPolicy ?? null,
    sandboxPolicy: rollout.sandboxPolicy ?? null,
    networkPolicy: rollout.networkPolicy ?? null,
  };
}

/**
 * Locate the rollout files under a job-owned Codex home.  The CLI persists
 * `$CODEX_HOME/sessions/<thread-id>/rollout-<timestamp>.jsonl`; a recursive
 * scan tolerates layout drift (the exact nesting is the CLI's, not ours).
 *
 * @param {string} codexHome
 * @returns {string[]} sorted absolute rollout file paths (possibly empty).
 */
export function findRolloutFiles(codexHome) {
  const root = path.join(codexHome, "sessions");
  const results = [];
  try {
    fs.readdirSync(root);
  } catch {
    return results;
  }
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let children;
    try {
      children = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      const full = path.join(dir, child.name);
      if (child.isDirectory()) {
        stack.push(full);
      } else if (child.isFile() && child.name.startsWith("rollout-") && child.name.endsWith(".jsonl")) {
        results.push(full);
      }
    }
  }
  return results.sort();
}

/**
 * Read the rollout provenance for a finished run: parse every rollout file
 * under the job-owned home and verify it.  Never throws — a read failure is
 * represented as `unverifiable` with the reason named.
 *
 * @param {object} opts
 * @param {string} opts.codexHome — the job-owned home.
 * @param {string} opts.requestedModel — the exact model that was requested.
 * @param {boolean} [opts.resumed] — true for a resumed dispatch: bind to
 *        the resumed invocation's own (last) turn_context evidence.
 * @returns {object} the `verifyRolloutProvenance` result.
 */
export function readRolloutProvenance({ codexHome, requestedModel, resumed = false }) {
  try {
    const files = findRolloutFiles(codexHome);
    if (files.length === 0) {
      return verifyRolloutProvenance({ rollout: { found: false }, requestedModel, resumed });
    }
    const content = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
    return verifyRolloutProvenance({ rollout: parseRolloutProvenance(content), requestedModel, resumed });
  } catch (err) {
    return { state: "unverifiable", reason: `rollout-read-failed: ${err?.message ?? err}` };
  }
}

// =========================================================================
// cross-backend session guard — pure
// =========================================================================

/**
 * Reject a session that must not be resumed on the codex backend, naming the
 * reasons.  Mirrors assertNoAgySession:
 *
 *   - `ses_*` — an opencode session id.  Shape alone decides it.
 *   - anything else — a codex thread id is only resumed on POSITIVE
 *     provenance: the caller must have established from the job store that a
 *     codex job recorded this id (`provenance: "codex"`).  Unknown or
 *     cross-backend ownership fails closed here, so an unproven id can never
 *     silently become a `codex exec resume` argument.
 *
 * @param {string|null|undefined} session
 * @param {object} [opts]
 * @param {string|null|undefined} [opts.provenance] — the backend the caller
 *        PROVED created this session (from the job store), or nothing.
 * @throws {Error} When a session was given without codex provenance.
 */
export function assertNoCodexSession(session, { provenance } = {}) {
  if (typeof session !== "string" || session === "") return;
  if (session.startsWith("ses_")) {
    throw new Error(
      `opencode session ${session} cannot be resumed on the codex backend — ` +
      "ses_* session ids belong to opencode; run the command without --backend codex " +
      "(or drop --session / --resume-last)"
    );
  }
  if (provenance === "codex") return;
  const attribution = provenance
    ? `the job store attributes it to the ${provenance} backend`
    : "no kusabi job record reports it, so its backend cannot be established";
  throw new Error(
    `session ${session} cannot be resumed on the codex backend — ${attribution}. ` +
    "A codex thread id is passed to `codex exec resume` only when a codex job recorded it; " +
    "an unproven id would silently start a fresh-looking run instead of continuing one. " +
    "Drop --session / --resume-last, or pass a thread id that a codex job on this directory recorded"
  );
}

// =========================================================================
// process — spawn/IO
// =========================================================================

/**
 * Spawn the codex CLI and fold its NDJSON event stream as it arrives.
 *
 * Delegates the mechanical lifecycle (spawn, line framing, timeout, silence
 * watchdog, process-group kill, close handling) to the shared
 * `runBackendProcess` module.  Codex-specific concerns — the parse function
 * for the silence clock, the stdin prompt transport (`-`), and the dedicated
 * job-owned HOME/CODEX_HOME env — are wired here.
 *
 * @param {object} opts
 * @param {string} opts.bin
 * @param {string[]} opts.args
 * @param {string} opts.cwd
 * @param {string} opts.promptText
 * @param {number|null} [opts.timeoutS]
 * @param {number|null} [opts.watchdogS]
 * @param {object} [opts.env] — extra env overrides for the child (the
 *        job-owned HOME/CODEX_HOME).
 * @param {(info: {pid: number}) => void} [opts.onStart]
 * @param {(line: string) => void} [opts.onLine]
 * @param {(event: {kind: "fired", silenceS: number}|{kind: "kill"}) => void}
 *        [opts.onWatchdog]
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string,
 *                     timedOut: boolean, stalled: boolean,
 *                     spawnError: Error|null }>}
 */
export function runCodexProcess({ bin, args, cwd, promptText, timeoutS, watchdogS, env, onStart, onLine, onWatchdog }) {
  return runBackendProcess({
    bin, args, cwd, promptText, timeoutS, watchdogS, env, onStart, onLine, onWatchdog,
    parseLine: parseCodexStreamLine,
  });
}

// =========================================================================
// codexDispatch — the dispatchWithFallback-shaped entry point
// =========================================================================

/**
 * Dispatch one prompt through the Codex CLI (`codex exec`).  Same call/return
 * contract as `dispatchWithFallback` / `claudeDispatch` / `agyDispatch`.
 *
 * v1 shape: one exact model per phase (`explicitModel` or the chain's first
 * route — a supported seat id), no tier walk, no capacity fallback, no
 * retry, reasoning effort fixed to `high`, every invocation in the fixed
 * read-only sandbox.  A session resumes (`codex exec resume <thread_id>`)
 * only when the caller establishes its provenance (`sessionProvenance:
 * "codex"`).  Every failure mode — spawn error, nonzero exit, unparseable
 * stdout, a payload-less run, timeout, stalled watchdog — produces a FAILED
 * JOB RECORD whose `error` carries the underlying text.  A config-level
 * error (a session that cannot be resumed, no model resolved) throws BEFORE
 * any job record exists.
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} [opts.kind]
 * @param {string} [opts.title]
 * @param {string} [opts.promptText]
 * @param {string|null} [opts.agent]
 * @param {string|null} [opts.phase]
 * @param {string|null|undefined} [opts.session] — resumed via
 *        `codex exec resume <thread_id>` ONLY when `sessionProvenance`
 *        proves it a codex thread id; see assertNoCodexSession.
 * @param {string|null|undefined} [opts.sessionProvenance]
 * @param {object|null|undefined} [opts.tools] — deny map.  For worker
 *        agents this is applied to the MCP enabled_tools list; for MCP-less
 *        seats only the fixed read-only sandbox can enforce write denies.
 * @param {unknown} [opts.timeoutS] — positive finite seconds arms the outer
 *        timer; anything else arms nothing (kusabi #328).
 * @param {unknown} [opts.watchdogS] — positive finite seconds arms the
 *        silence watchdog; anything else arms none.
 * @param {(string|string[])[]} [opts.tiers]
 * @param {number} [opts.round]
 * @param {string|null} [opts.explicitModel]
 * @returns {Promise<{ job: object, resultText: string, stateDir: string }>}
 */
export async function codexDispatch(opts) {
  // ---- cross-backend / provenance session guard ----
  // Before anything is spawned and before any job record exists: this is a
  // config-level error, not a failed job.
  assertNoCodexSession(opts.session, { provenance: opts.sessionProvenance });

  // The thread id of a resumed dispatch, known BEFORE the run: the CLI was
  // asked to continue this exact thread.  A successful resumed job must
  // persist it even when the resume stream omits a fresh `thread.started`
  // event, or a later --resume-last would silently start fresh (kusabi #527
  // review follow-up).
  const resumedSessionId = typeof opts.session === "string" && opts.session !== "" ? opts.session : null;

  // v1 model selection: explicit model, else the chain's first route.  The
  // tier ladder is NOT walked — one exact model per phase, never a fallback
  // after a terminal failure.
  const modelEntry = validateCodexModel(opts.explicitModel || firstRoute(opts.tiers || []));
  if (!modelEntry) {
    throw new Error("codex backend: no model resolved — pass --model codex/<seat> or configure models.chain with codex entries");
  }
  const stateDir = stateDirFor(opts.cwd);

  // ---- pre-flight (still before the job record exists) ----
  const systemPrompt = readAgentSystemPrompt(opts.agent);
  const promptText = buildCodexPrompt({ systemPrompt, promptText: opts.promptText });
  const bin = codexBin();
  const timeoutS = isUsableTimeoutS(opts.timeoutS) ? opts.timeoutS : null;
  const watchdogS = isUsableTimeoutS(opts.watchdogS) ? opts.watchdogS : null;
  const jsonSchema = codexJsonSchemaFor(opts.agent);
  const codexMcpTools = codexMcpToolsForAgent(opts.agent, opts.tools);
  const codexMcpDefinitions = codexMcpTools === null
    ? {}
    : codexMcpServerDefinitions(codexMcpTools);
  const codexMcpEnabled = Object.keys(codexMcpDefinitions).length > 0;

  // Deny maps arrive from the chain phases unconditionally (implementDenyTools
  // / reviewDenyTools) and from the operator's --read-only.  The canonical
  // write-tool names (WRITE_TOOL_NAMES) ARE the read-only boundary the fixed
  // sandbox enforces, so denying them is sandbox-enforced, never "unenforced"
  // (kusabi #527 finding 2).  Any other denied name is a per-tool/MCP claim
  // the codex CLI cannot enforce (it has no per-job tool-deny flags), so it
  // stays genuinely unenforced — a phase deny like sunaba_copy_project is
  // never erased merely because --read-only is also active.
  const deniedToolNames = Object.entries(opts.tools ?? {})
    .filter(([, allowed]) => allowed === false)
    .map(([name]) => name);
  const codexSandboxEnforcedDenies = codexMcpEnabled
    ? []
    : deniedToolNames.filter((name) => WRITE_TOOL_NAMES.includes(name));
  const translatedDeniedToolNames = Object.entries(translateDenyTools(opts.tools) ?? {})
    .filter(([, allowed]) => allowed === false)
    .map(([name]) => name.startsWith("sunaba_") ? `mcp__sunaba__${name.slice("sunaba_".length)}` : name);
  const grantedMcpToolNames = new Set(
    Object.entries(codexMcpToolsForAgent(opts.agent) ?? {}).flatMap(([server, names]) =>
      names.includes("*") ? [] : names.map((name) => `mcp__${server}__${name}`)),
  );
  const codexMcpEnforcedDenies = codexMcpEnabled
    ? translatedDeniedToolNames.filter((name) => grantedMcpToolNames.has(name))
    : [];
  const enforcedMcpDenies = new Set(codexMcpEnforcedDenies);
  const unenforcedDenies = codexMcpEnabled
    ? deniedToolNames.filter((name) => {
      const translated = translateDenyTools({ [name]: false });
      const normalized = Object.keys(translated ?? {}).map((key) => key.startsWith("sunaba_") ? `mcp__sunaba__${key.slice("sunaba_".length)}` : key);
      return !normalized.some((key) => enforcedMcpDenies.has(key));
    })
    : deniedToolNames.filter((name) => !WRITE_TOOL_NAMES.includes(name));

  // The deny map as supplied (null when no tools map was passed at all) and
  // the truthful tool profile derived from it (kusabi #529 spec 8).  A
  // no-tools dispatch records `toolDenies: null` and `toolProfile: "no-mcp"`.
  // Worker dispatches instead record their derived MCP profile and applied
  // omissions; a deny outside that grant remains genuinely unenforced.
  const toolDenies =
    opts.tools && typeof opts.tools === "object" && Object.keys(opts.tools).length > 0
      ? opts.tools
      : null;
  const toolProfile = codexMcpEnabled
    ? (toolDenies === null ? "mcp-allowlist" : "mcp-allowlist-deny-map")
    : (toolDenies === null ? "no-mcp" : "deny-map");

  // ---- job record (opencode-path shape + backend) ----
  const job = {
    id: newJobId(),
    kind: opts.kind || "task",
    title: opts.title || "",
    status: "running",
    backend: CODEX_BACKEND,
    sessionID: null,
    // Filled the instant the child exists — the `cancel` lever (kusabi #209).
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
    // Fixed v1 invocation boundaries, recorded truthfully (capability
    // honesty): reasoning effort is always "high", the sandbox is always
    // "read-only", and the built-in command tool remains inside the
    // sandbox.  Worker MCP grants are job-owned and listed exactly below;
    // credential isolation is NOT claimed.
    reasoningEffort: CODEX_REASONING_EFFORT,
    sandboxPolicy: CODEX_SANDBOX_POLICY,
    mcpServersConfigured: codexMcpEnabled,
    codexMcpServers: codexMcpTools ?? {},
    codexCommandTool: true,
    // kusabi #529 spec 8: the truthful no-tool record.  `toolProfile:
    // "no-mcp"` and `toolDenies: null` describe a dispatch with no MCP
    // servers AND no deny map — the honest proof that no tools were granted.
    // A supplied deny map flips the profile to "deny-map" and records the
    // map as `toolDenies`; the unenforced entries ride in
    // `toolDeniesUnenforced`.  `streamFraming` is "json" because every
    // invocation passes `--json` (the watchdog treats non-JSON lines as
    // activity, so nobody reads "no stall" as "structured activity").
    // `substituted` starts as null (provenance is not yet known) and is set
    // from the post-run rollout cross-check (kusabi #529 finding 4): false
    // only when the actual model is verified equal, true for an observed
    // mismatch, null when provenance is unverifiable — never a claimed value.
    toolProfile,
    toolDenies,
    streamFraming: "json",
    substituted: null,
    // Filled after the process closes: { state: "verified"|"unverifiable"|
    // "mismatch", ... } — see readRolloutProvenance.
    codexProvenance: null,
    // Without MCP, the fixed read-only sandbox is the only enforceable
    // write boundary.  With MCP, denied tools are enforced by omission from
    // codexMcpServers, and are recorded separately.
    codexSandboxEnforcedDenies,
    codexMcpEnforcedDenies,
    toolDeniesUnenforced: unenforcedDenies,
    jsonSchemaEnforced: jsonSchema !== null,
    error: null,
    failure: null,
    retry: null,
    fallbacks: null,
  };
  // The job-owned Codex home, persisted on the record so rendering can print
  // an EXECUTABLE continuation command pointing HOME/CODEX_HOME at it
  // (kusabi #527 finding 1).  The path lives under the job's own directory
  // and carries no auth material (the auth bridge is a symlink, never a copy
  // of the operator's cache).
  const codexHome = codexHomeForJob(stateDir, job.id);
  job.codexHome = codexHome;
  saveJob(stateDir, job);
  fs.writeFileSync(path.join(jobDir(stateDir, job.id), "prompt.md"), promptText, "utf8");

  // ---- dedicated state ----
  // HOME and CODEX_HOME both point at the job-owned directory.  The child
  // never inherits the orchestrator's config/rules/sessions/MCP files; the
  // only bridge is the minimum auth symlink (same-user trusted-seat model).
  // The dedicated home always exists (it is the child's state dir), even
  // when there is no operator auth file to bridge.
  fs.mkdirSync(codexHome, { recursive: true });
  // The CLI consumes a path here, not schema text.  Keep the projected
  // schema beside this job's codex-home so it cannot be confused with a
  // shared or checked-in generated schema.
  const codexSchemaPath = jsonSchema === null
    ? null
    : path.join(jobDir(stateDir, job.id), "codex-output-schema.json");
  if (codexSchemaPath !== null) {
    fs.writeFileSync(codexSchemaPath, jsonSchema, "utf8");
  }
  const args = buildCodexArgs({
    model: modelEntry,
    cwd: opts.cwd,
    sessionId: opts.session,
    jsonSchema: codexSchemaPath,
    mcpServers: codexMcpDefinitions,
  });
  // config.toml is intentionally not written: --ignore-user-config ignores
  // the job-owned file, so every grant is already present in argv above.
  saveJob(stateDir, job);
  const authBridge = linkOperatorAuth(codexHome);
  const childEnv = { HOME: codexHome, CODEX_HOME: codexHome };

  const progressWatch = startKaibaProgressWatch({ stateDir, jobId: job.id });

  try {

  appendEvent(stateDir, job.id, {
    type: "companion.codex.dispatch",
    backend: CODEX_BACKEND,
    model: modelEntry,
    bin,
    reasoningEffort: CODEX_REASONING_EFFORT,
    sandboxPolicy: CODEX_SANDBOX_POLICY,
    resume: typeof opts.session === "string" && opts.session !== "",
    // The bridge KIND only — auth contents are never written to events.
    authBridge: authBridge.bridge,
    jsonSchemaEnforced: job.jsonSchemaEnforced,
    codexMcpServers: codexMcpTools ?? {},
    codexSandboxEnforcedDenies,
    codexMcpEnforcedDenies,
    toolDeniesUnenforced: unenforcedDenies,
  });

  // ---- run: fold the NDJSON stream as it arrives ----
  const streamAcc = initCodexStreamAccumulator();
  let lastStatsSaveAt = 0;
  const STATS_SAVE_INTERVAL_MS = 1000;
  const onLine = (rawLine) => {
    const evt = parseCodexStreamLine(rawLine);
    if (evt === null) {
      // Not fatal (the real CLI may print non-JSON warning lines) — just not
      // countable as a parsed event.
      return;
    }
    applyCodexStreamEvent(streamAcc, evt);
    if (streamAcc.threadId) job.sessionID = streamAcc.threadId;
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

  const { code, stdout, stderr, timedOut, stalled, spawnError } = await runCodexProcess({
    bin,
    args,
    cwd: opts.cwd,
    promptText,
    timeoutS,
    watchdogS,
    env: childEnv,
    onStart: ({ pid, startTime }) => {
      // The identity token (runner's /proc start time) lets `cancel` verify
      // the recorded pid before signalling the group (kusabi #209): a
      // recycled pid must never be killed on a stale record's say-so.
      job.process = { pid, startTime, recordedAt: new Date().toISOString() };
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

  // The thread/session id of THIS run, decided ONCE for every terminal path:
  // the thread id the stream reported when it reported one (a fresh job, and
  // a resume whose CLI re-emits thread.started), else the known thread id a
  // resumed dispatch was asked to continue, else null.  Recording the known
  // resumed id even when the resume stream omits thread.started keeps the
  // session chain intact \u2014 later --resume-last selection and rendering both
  // read this field (kusabi #527 review follow-up).
  job.sessionID = streamAcc.threadId ?? resumedSessionId ?? null;

  // ---- provenance cross-check after close ----
  // The rollout lives under the job-owned CODEX_HOME.  A different actual
  // model or reasoning effort is an integrity failure: the job errors, names
  // requested vs actual, writes no successful result, and never retries
  // another model.  A missing rollout is UNVERIFIABLE, never silently
  // verified.  For a resumed dispatch the verification binds to the resumed
  // invocation's OWN turn_context evidence, never a stale matching turn from
  // the original session.
  const provenance = readRolloutProvenance({ codexHome, requestedModel: modelEntry, resumed: resumedSessionId !== null });
  job.codexProvenance = provenance;
  // `substituted` is set from post-run provenance (kusabi #529 finding 4):
  // `false` only when the actual model is verified equal to the requested
  // one, `true` for an observed mismatch, and `null` when provenance is
  // unverifiable (no rollout / no model field in the rollout) — never a
  // claimed value.  The fail-closed mismatch handling below is unchanged: a
  // mismatch is a hard error, no result and no substitute model.
  job.substituted = provenance.state === "verified" ? false : provenance.state === "mismatch" ? true : null;

  // ---- classification (all failure text preserved on the record) ----
  let resultText = "";
  if (spawnError) {
    job.status = "error";
    job.error = `codex dispatch failed: could not start ${bin}: ${spawnError.message}`;
  } else if (stalled) {
    job.status = "stalled";
    job.error = `watchdog: no events for ${watchdogS}s (process killed)`;
  } else if (timedOut) {
    job.status = "timeout";
    job.error = `timed out after ${timeoutS}s`;
  } else if (provenance.state === "mismatch") {
    // Fail closed: no successful result, no fallback/substitution.
    job.status = "error";
    job.error =
      `codex provenance mismatch: requested ${provenance.kind} ${provenance.requested} ` +
      `but the recorded rollout shows ${provenance.actual} — integrity failure; ` +
      "no result was written and no substitute model was attempted";
  } else if (code !== 0 && code !== null) {
    job.status = "error";
    const detail = (stderr || stdout || "(no output)").trim();
    job.error = `codex exited with code ${code}: ${describeCodexResult(detail)}`;
  } else if (!streamAcc.assistantText) {
    job.status = "error";
    job.error =
      "codex produced no terminal assistant message. " +
      `Received: ${describeCodexResult((stdout || "").trim() || "(empty stdout)")}`;
  } else {
    job.status = "completed";
    job.usage = {
      ...mapCodexUsage(streamAcc.usageEvent),
      phase: job.phase,
      durationSeconds: durationS(job),
    };
    writeJson(path.join(jobDir(stateDir, job.id), "usage.json"), job.usage);
    const resolved = resolveCompletedResult({
      backend: CODEX_BACKEND,
      fetched: { ok: true, text: streamAcc.assistantText },
      coords: { sessionId: job.sessionID },
    });
    resultText = resolved.text ?? streamAcc.assistantText;
    if (opts.agent === REVIEW_AGENT) {
      resultText = stripCodexOptionalNullsFromText(resultText);
    }
    job.result = resolved.record;
    fs.writeFileSync(path.join(jobDir(stateDir, job.id), "result.md"), resultText, "utf8");
  }

  appendEvent(stateDir, job.id, {
    type: "companion.codex.finished",
    status: job.status,
    sessionId: job.sessionID,
    exitCode: code,
    provenanceState: provenance.state,
    assistantChars: streamAcc.assistantText.length,
  });

  // Record the closed terminal reason (kusabi #388).  codex finalizes its
  // job.json on this path, so stamp here at the terminal write.
  job.stopReason = deriveStopReason({ status: job.status, stats: job.stats });
  saveJob(stateDir, job);

  return { job, resultText, stateDir };
  } finally {
    progressWatch.stop();
  }
}
