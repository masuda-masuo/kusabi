// agent-system-prompt.mjs — agent system prompt loading (frontmatter stripping).
//
// Split out of claude-dispatch.mjs (pure move, no behaviour change): reads an
// opencode agent definition md under plugins/kusabi/opencode-agents/ and
// strips the leading YAML frontmatter to yield the body passed via
// `--append-system-prompt`.  Imported by the claude, agy, and codex
// backends.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");

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
