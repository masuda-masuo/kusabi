// companion-config: the kusabi config file loader, the orchestrator record
// resolver and the PHASE_AGENTS seat map, moved out of kusabi-companion.mjs
// verbatim (pure move refactor).  No behaviour change: every function body
// below is byte-identical to the base.

import { parseOrchestratorSignature } from "./brief-parsing.mjs";
import { validateChainEntries } from "./cli.mjs";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// The environment variable Claude Code exports into every subprocess it
// spawns (harness 2.1.226).  When the companion is dispatched from an
// orchestrator session, this IS that session's identity — authoritative in a
// way a hand-typed signature field can never be.
export const ORCH_SESSION_ENV = "CLAUDE_CODE_SESSION_ID";

/**
 * The orchestrator record to persist on a job / chain: the signature line
 * parsed out of the brief, with `session` taken from the environment
 * whenever the environment has one (kusabi #227), and only then from the
 * hand-typed signature session.
 *
 * Why the env wins: metrics-report joins `chain.orch_session` as a PREFIX of
 * transcript session ids (kusabi #135).  A hand-typed label ("wsl-claude",
 * "cc-20260811-215", "(current)") can never join, which is what left 27 of
 * 122 chains orphaned.  The signature line stays the
 * source of model/date, and the fallback for session.
 *
 * Resolution happens HERE, at record-write time, not inside
 * parseOrchestratorSignature — that stays a pure text parser.  Same shape as
 * the #195 backend resolution: the writer decides, the readers stay verbatim.
 * chain-ingest.mjs / metrics-report.mjs keep reading `model` / `session` /
 * `date` exactly as before.
 *
 * `sessionSource: "env"` marks a session that came from the environment, so
 * a reader can tell the provenances apart.  Its absence means signature (or
 * no session at all), which is exactly what every record written before #227
 * means.  Env set, or env unset, stays byte-identical to today.
 *
 * @param {string|null|undefined} briefText
 * @param {Record<string, string|undefined>} [env]  Defaults to process.env.
 * @returns {{model: string|null, session: string|null, date: string|null,
 *            sessionSource?: "env"} | null}
 */
export function resolveOrchestratorRecord(briefText, env = process.env) {
  const signature = parseOrchestratorSignature(briefText);
  const raw = env ? env[ORCH_SESSION_ENV] : undefined;
  const envSession = typeof raw === "string" ? raw.trim() : "";
  if (envSession !== "") {
    return {
      model: signature?.model ?? null,
      session: envSession,
      date: signature?.date ?? null,
      sessionSource: "env",
    };
  }

  // No usable env session: today's behaviour,
  // byte for byte — the signature record, or null when the brief carries no
  // signature line at all.
  return signature;
}



/**
 * Resume strategy for a chain round: now handled by
 * resolveRoundResume in chain-phases.mjs which is a pure synchronous
 * function.  checkpoint_restore was removed in issue #114 — the chain
 * never rolls the worktree back.  A new session starts fresh on the
 * existing worktree.
 */

export const PHASE_AGENTS = {
  investigate: "kusabi-investigate",
  implement: "kusabi-implement",
  review: "kusabi-review",
  respond: "kusabi-respond",
  gofer: "kusabi-gofer",
  "test-author": "kusabi-test-author",
  plan: "kusabi-plan",
};

// kusabi #529 — the Luna coordinator seat.  Registered NON-ENUMERABLY:
// PHASE_AGENTS.coordinate is the seat prompt contract only (the phase is
// unreachable from the CLI until the #530 mission driver lands), and the
// existing contract that the map "contains 9 entries" (Object.keys length,
// kusabi-companion.test.mjs) must stay byte-identical for every pre-#529
// consumer.  Direct access — PHASE_AGENTS.coordinate — is what the frozen
// #529 registration assertion reads, and the coordinate seat is a CODEX seat
// definition (zero tools, "*": deny, no MCP), intentionally excluded from the
// generic opencode worker permission loop in agent-permissions.test.mjs.
Object.defineProperty(PHASE_AGENTS, "coordinate", {
  value: "kusabi-coordinate",
  writable: true,
  enumerable: false,
  configurable: true,
});

// ---------------------------------------------------------------------------
// config loading & model resolution
// ---------------------------------------------------------------------------


/**
 * Load the kusabi config file from the state root.
 * @param {string} stateRootDir - The state root directory (e.g. ~/.kusabi)
 * @returns {object|null} Config object or null if the file does not exist.
 * @throws {Error} If the file exists but is unparseable or has wrong shape.
 */
export function loadConfig(stateRootDir) {
  const configPath = path.join(stateRootDir, "config.json");
  if (!fs.existsSync(configPath)) return null;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new Error(`kusabi config file ${configPath} is not valid JSON: ${err.message}`);
  }

  // Validate shape: must be an object with an optional "models" key
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`kusabi config file ${configPath} must contain a JSON object`);
  }

  const models = parsed.models;
  if (models !== undefined) {
    if (typeof models !== "object" || Array.isArray(models) || models === null) {
      throw new Error(`kusabi config file ${configPath}: "models" must be a JSON object`);
    }
    if (models.chain !== undefined) {
      try {
        validateChainEntries(models.chain, "models.chain");
      } catch (err) {
        // Prefix the config path for user-facing error messages.
        throw new Error(`kusabi config file ${configPath}: ${err.message}`);
      }
    }
    if (models.phases !== undefined) {
      if (typeof models.phases !== "object" || Array.isArray(models.phases) || models.phases === null) {
        throw new Error(`kusabi config file ${configPath}: "models.phases" must be a JSON object`);
      }
      for (const [phaseName, chain] of Object.entries(models.phases)) {
        try {
          validateChainEntries(chain, `models.phases.${phaseName}`);
        } catch (err) {
          throw new Error(`kusabi config file ${configPath}: ${err.message}`);
        }
      }
    }
  }

  return parsed;
}
