// luna-prompt.mjs — kusabi #530/#531 follow-up (mission-mucv2fzt47784ba9):
// the single pure prompt-contract renderer for the Luna coordinator and Sol
// auditor seats.
//
// The live integration failure was a prompt gap, not a driver gap: the real
// coordinator prompt only communicated `action` + `envelope_sha256`, so the
// model emitted `probe:{paths:[...]}` twice and was refused with tool
// "undefined" — the read_probe body contract lived nowhere the seat could
// read.  This module closes that gap WITHOUT weakening the deterministic
// driver:
//
//   - the repository schemas stay the machine authority:
//     `schemas/coordinator-output.schema.json` (the closed action enum, the
//     probe-tool enum, the finish recommendation vocabulary, and the
//     per-action / per-tool body-field maps) and
//     `schemas/audit-verdict.schema.json` (the Sol verdict record contract);
//   - this module renders deterministic, concise guidance text FROM those
//     two schema files — there is exactly ONE prompt renderer and no
//     hand-maintained verbatim schema copies anywhere else;
//   - `realCoordinatorDispatch` (luna-driver.mjs) and `realSolDispatch`
//     (luna-sol-gate.mjs) splice the rendered contract into the ACTUAL Codex
//     prompt, so the seat sees the same contract the post-hoc validator and
//     the driver enforce;
//   - the driver enums derive from the same schema file (luna-driver.mjs),
//     so schema, prompt, and driver can never drift apart (the frozen
//     drift tests pin the equality).
//
// The module is pure and deterministic: no I/O beyond the cached schema
// loads, no clock, no randomness — the same schema bytes render the same
// text in every process.  Both renderers accept the parsed schema as an
// optional argument (defaulting to the canonical file) so tests can pin the
// rendering against a fixed input.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const COORDINATOR_SCHEMA_FILE = path.resolve(SCRIPT_DIR, "../schemas/coordinator-output.schema.json");
const SOL_SCHEMA_FILE = path.resolve(SCRIPT_DIR, "../schemas/audit-verdict.schema.json");

let cachedCoordinatorSchema = null;
let cachedSolSchema = null;

/** Load (once) the canonical coordinator-output schema. */
export function loadCoordinatorSchema() {
  if (cachedCoordinatorSchema === null) {
    cachedCoordinatorSchema = JSON.parse(fs.readFileSync(COORDINATOR_SCHEMA_FILE, "utf8"));
  }
  return cachedCoordinatorSchema;
}

/** Load (once) the canonical audit-verdict schema. */
export function loadSolSchema() {
  if (cachedSolSchema === null) {
    cachedSolSchema = JSON.parse(fs.readFileSync(SOL_SCHEMA_FILE, "utf8"));
  }
  return cachedSolSchema;
}

/**
 * Render the coordinator request contract as deterministic guidance text,
 * derived from `schemas/coordinator-output.schema.json`.
 *
 * The rendered text states, for every valid action, the exact required and
 * optional body fields; the read_probe tool enum and per-tool callTool
 * argument names; the inner-chain brief (`## Deliverables`) requirement; the
 * reason fields; the closed finish recommendation vocabulary; the
 * one-record-per-line JSONL framing; and the envelope hash binding.  The
 * concrete envelope hash is NOT embedded here — the dispatch seam binds it
 * (the current hash is a property of the live dispatch, not of the
 * contract).
 *
 * @param {object} [schema] — the parsed coordinator schema (default: the
 *        canonical file, loaded once).
 * @returns {string}
 */
export function renderCoordinatorContract(schema = loadCoordinatorSchema()) {
  const actions = [...schema.properties.action.enum];
  const tools = [...schema.properties.tool.enum];
  const recommendations = [...schema.properties.recommendation.enum];
  const actionBodies = schema.actions.properties;
  const probeTools = schema.probe_tools.properties;

  const lines = [];
  lines.push("## Coordinator request contract (rendered from schemas/coordinator-output.schema.json)");
  lines.push("");
  lines.push("Framing: emit exactly ONE request record per line (JSONL), nothing else. Every record");
  lines.push("MUST carry these two framing fields:");
  lines.push(`- \`action\`: one of ${actions.join(" | ")} — the closed allow-list. Any other verb is`);
  lines.push("  rejected deterministically and counted as a coordinator error; it never executes.");
  lines.push("- `envelope_sha256`: the current envelope hash — the 64-char lowercase hex value shown");
  lines.push("  above. Every record must be bound to it: a stale, missing, or malformed hash voids");
  lines.push("  the whole stream (nothing in it executes).");
  lines.push("");
  lines.push("Per-action body fields:");
  for (const action of actions) {
    const body = actionBodies[action];
    const required = Array.isArray(body?.required) ? body.required : [];
    const optional = Array.isArray(body?.optional) ? body.optional : [];
    const parts = [];
    if (required.length > 0) {
      parts.push(`requires ${required.map((f) => `\`${f}\``).join(" and ")}`);
    }
    if (optional.length > 0) {
      parts.push(`optional ${optional.map((f) => `\`${f}\``).join(", ")}`);
    }
    const requirement = parts.length > 0 ? ` — ${parts.join("; ")}` : " — no body fields";
    lines.push(`- \`${action}\`${requirement}.`);
    if (action === "read_probe") {
      const toolNames = tools.map((t) => `\`${t}\``).join(", ");
      lines.push(`  - \`tool\` must be one of ${toolNames} (the probe tool allow-list).`);
      lines.push("  - Per-tool required fields and call arguments the driver passes to the tool seam");
      lines.push("    (the container id is always supplied by the driver — you never name it):");
      for (const tool of tools) {
        const entry = probeTools[tool];
        const required = Array.isArray(entry?.required) ? entry.required : [];
        const callArgs = Array.isArray(entry?.call_args) ? entry.call_args : [];
        lines.push(
          `    - ${tool} -> requires ${required.map((f) => `\`${f}\``).join(", ")}; ` +
          `calls with ${callArgs.map((a) => `\`${a}\``).join(", ")}`,
        );
      }
      lines.push("  - For `search_in_container` the `pattern` must be non-empty and non-whitespace: a");
      lines.push("    missing, empty, or whitespace-only `pattern` is refused before any tool call");
      lines.push("    (the driver never fabricates one).");
      lines.push("  - A read_probe is a REQUEST, not a capability: the driver executes it on your");
      lines.push("    behalf and returns the raw output in the next envelope.");
    } else if (action === "run_chain" || action === "rework_chain") {
      lines.push("  - The `brief` is an inner-chain brief: it requires a non-empty `## Deliverables`");
      lines.push("    section (a brief without one is refused before any chain work starts).");
    } else if (action === "finish") {
      lines.push(`  - \`recommendation\` must be one of ${recommendations.join(" | ")} — the closed finish`);
      lines.push("    recommendation vocabulary.");
    }
  }
  lines.push("");
  lines.push("A stream containing any rejected or malformed record is never partially executable:");
  lines.push("the whole parse fails closed. Keep the stream clean — one record per line, no prose");
  lines.push("between records, every record bound to the current envelope hash.");
  return lines.join("\n");
}

/**
 * Render the Sol verdict contract as deterministic guidance text, derived
 * from `schemas/audit-verdict.schema.json`.
 *
 * The rendered text states the required common fields (including `summary`)
 * and the verdict-specific fields for `block` (`block_reason` +
 * `acknowledgement_required`), matching exactly what the post-hoc validator
 * and the fail-closed gate enforce.
 *
 * @param {object} [schema] — the parsed audit-verdict schema (default: the
 *        canonical file, loaded once).
 * @returns {string}
 */
export function renderSolContract(schema = loadSolSchema()) {
  const verdicts = [...schema.properties.verdict.enum];
  const commonRequired = [...schema.required];
  const blockOnly = [...schema.then.required];
  const typeConst = schema.properties.type.const;
  const schemaVersion = schema.properties.schema_version.const;

  const lines = [];
  lines.push("## Sol verdict contract (rendered from schemas/audit-verdict.schema.json)");
  lines.push("");
  lines.push("Answer with line-oriented JSON records: any finding records, then exactly one verdict");
  lines.push("record. The verdict record MUST carry every common field, and the block-only fields");
  lines.push("when the verdict is `block`:");
  lines.push("");
  lines.push("Common fields (every verdict):");
  // Derive the common-field statements from the schema's `required` array so
  // the rendered contract and the validator can never drift: a field added
  // to the schema appears here automatically.
  const fieldNote = {
    type: `"${typeConst}"`,
    schema_version: String(schemaVersion),
    gate_id: "the gate named in the envelope above — a verdict naming a different gate is rejected",
    envelope_sha256:
      "the current envelope hash (the 64-char lowercase hex value shown above) — a verdict bound to any other envelope is rejected as evidence-mismatch",
    verdict: `one of ${verdicts.join(" | ")}`,
    summary: "a non-empty string summarising the judgement (bounded to 500 characters)",
  };
  for (const field of commonRequired) {
    lines.push(`- \`${field}\`: ${fieldNote[field] ?? "required"}`);
  }
  lines.push("");
  lines.push(`Block-only fields (required when \`verdict\` is "block"):`);
  for (const field of blockOnly) {
    lines.push(`- \`${field}\`${field === "acknowledgement_required" ? ": true — the veto is not self-overrulable" : ": a non-empty reason for the block (bounded to 200 characters)"}.`);
  }
  lines.push("");
  lines.push(`A \`clear\` or \`rework\` verdict never carries the block-only fields; a \`block\` verdict`);
  lines.push("missing any of them stays malformed and the gate fails closed.");
  return lines.join("\n");
}