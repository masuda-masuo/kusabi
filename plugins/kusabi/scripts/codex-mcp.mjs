// codex-mcp.mjs — Codex worker MCP server configuration and allowlists.
//
// Split out of codex-dispatch.mjs (pure move, no behaviour change): computing
// the Codex MCP grants from Claude's canonical allowlists, reading the
// operator-owned worker JSONC config, resolving server definitions, and
// formatting `-c mcp_servers.*` argv overrides.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  allowedToolsForAgent,
  applyToolDenies,
  DISALLOWED_TOOLS,
} from "./tool-permissions.mjs";
import { kusabiOpencodeConfigHome } from "./state-paths.mjs";

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
    tools,
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

