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
  lines.push("");
  lines.push("## Inner-chain brief contract (run_chain / rework_chain `brief`)");
  lines.push("");
  lines.push("The inner-chain brief is authored by Luna, but the deterministic driver owns its");
  lines.push("signature and validates its semantic sections before any chain work starts:");
  if (schema.inner_brief && typeof schema.inner_brief === "object") {
    const rules = schema.inner_brief.properties ?? {};
    for (const key of Object.keys(rules)) {
      const rule = rules[key];
      if (rule && typeof rule.description === "string" && rule.description !== "") {
        lines.push(`- ${rule.description}`);
      }
    }
  }
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
/**
 * The remaining deterministic budget for a mission, derived from the
 * PERSISTED mission record and its canonical effective budget (record.budget
 * — the single source of budget truth).  `read_probe` consumes probe budget;
 * `run_chain` / `rework_chain` jointly consume both attempt and chain
 * budgets; `consult_sol` consumes consult budget; `finish` /
 * `escalate_to_host` consume none; `maxRework` stays Sol-gate-owned and is
 * not exposed here.
 *
 * There is deliberately NO second hand-maintained source of budget truth: the
 * same derivation feeds the coordinator prompt and the evidence ledger on
 * every dispatch/resume, so the values always read max − persisted usage.
 *
 * @param {object} [record] — the persisted mission record (must carry its
 *        effective `budget`; the driver persists it before any dispatch).
 * @returns {{probes: number, attempts: number, chains: number, consults: number}}
 */
export function remainingMissionBudget(record = {}) {
  const budget = record?.budget ?? {};
  const count = (arr) => (Array.isArray(arr) ? arr.length : 0);
  const remaining = (max, used) => Math.max(0, (max ?? 0) - used);
  return {
    probes: remaining(budget.maxProbes, count(record?.probes)),
    attempts: remaining(budget.maxAttempts, count(record?.attempts)),
    chains: remaining(budget.maxChains, count(record?.chains)),
    consults: remaining(budget.maxConsults, count(record?.consults)),
  };
}

/**
 * Render the remaining deterministic budget as the single prompt/evidence
 * text (decision 6: the real coordinator dispatch prompt and the evidence
 * envelope ledger expose the CURRENT remaining probes / attempts / chains /
 * consults on every dispatch/resume, computed from the persisted mission
 * record plus its canonical budget — never the bare caps and never just the
 * consumed counts).
 *
 * @param {object} [record] — the persisted mission record.
 * @returns {string}
 */
export function renderRemainingBudget(record = {}) {
  const r = remainingMissionBudget(record);
  return [
    "Remaining deterministic budget (derived from the persisted mission record and its effective budget):",
    `- remaining probes: ${r.probes}`,
    `- remaining attempts: ${r.attempts}`,
    `- remaining chains: ${r.chains}`,
    `- remaining consults: ${r.consults}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// bounded brief-correction feedback (kusabi #553 follow-up)
// ---------------------------------------------------------------------------

/**
 * The bounded inner-brief correction feedback surface (kusabi #553 follow-up):
 * after a pre-seam refusal of a Luna-authored inner-chain brief, the driver
 * persists structured `briefCorrectionsDetails` entries and the NEXT
 * coordinator turn must see WHY the brief was refused — otherwise Luna
 * repeats the malformed brief (the empty-`## Frozen Tests` incident after PR
 * #553: the heading was correctly refused pre-seam, but its deterministic
 * correction was never shown to the next coordinator turn).
 *
 * The renderer is pure and deterministic (no I/O, no clock, no randomness)
 * and reads ONLY `briefCorrectionsDetails` (criterion 4): arbitrary
 * coordinator error text, probe output, tool output and exception messages
 * are never rendered — correction detail is driver-generated validator
 * output only.
 *
 * The bounded window (criterion 2):
 *   - an entry is `{ at, action, detail }`; an entry without a usable
 *     non-empty string `detail` contributes nothing;
 *   - unique-by-detail keeps the LAST occurrence of each distinct detail
 *     (older duplicates are the stale ones the window must drop) and the
 *     remaining window renders in record order;
 *   - "last <=3" keeps the three most recent unique details;
 *   - every rendered correction is bounded to BRIEF_CORRECTION_MAX_BYTES
 *     UTF-8 bytes (truncation never splits a code point) and C0 control
 *     characters are stripped while useful line breaks (`\n`) are preserved;
 *   - the output is the empty string when there are no corrections.
 *
 * @param {object} [record] — the persisted mission record.
 * @returns {string} the rendered corrections text, or "" when none.
 */
export const BRIEF_CORRECTION_MAX_ITEMS = 3;

/** The per-correction UTF-8 byte bound of the bounded feedback window. */
export const BRIEF_CORRECTION_MAX_BYTES = 1200;

/**
 * Sanitize one correction detail deterministically: strip every C0 control
 * character except `\n` (so a `\r\n` line break normalizes to the preserved
 * `\n`), then bound the result to BRIEF_CORRECTION_MAX_BYTES UTF-8 bytes
 * without ever splitting a code point.  The SAME transform is applied when
 * the driver persists a correction and when the renderer exposes it, so the
 * persisted record and the rendered feedback can never disagree.
 *
 * @param {unknown} detail — the raw validator detail (string coercion).
 * @returns {string} the sanitized, bounded detail.
 */
export function sanitizeBriefCorrectionDetail(detail) {
  const text = String(detail ?? "");
  const sanitized = text.replace(/[\x00-\x1f]/g, (ch) => (ch === "\n" ? "\n" : ""));
  const buf = Buffer.from(sanitized, "utf8");
  if (buf.length <= BRIEF_CORRECTION_MAX_BYTES) return sanitized;
  // Walk back from the bound to a UTF-8 code-point boundary: a continuation
  // byte is 0b10xxxxxx, so stopping at a non-continuation byte never splits a
  // code point.
  let end = BRIEF_CORRECTION_MAX_BYTES;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf8");
}

/**
 * Render the bounded brief-correction feedback text from a mission record,
 * or the empty string when there is nothing to render.  See the module-level
 * comment above for the frozen window semantics.
 *
 * @param {object} [record] — the persisted mission record.
 * @returns {string}
 */
export function renderBriefCorrections(record = {}) {
  const details = record?.briefCorrectionsDetails;
  if (!Array.isArray(details)) return "";
  const usable = [];
  for (const entry of details) {
    if (!entry || typeof entry !== "object" || typeof entry.detail !== "string") continue;
    if (entry.detail.trim() === "") continue;
    usable.push(entry.detail);
  }
  if (usable.length === 0) return "";
  // unique-by-detail: keep the LAST occurrence of each distinct detail (the
  // last-occurrence indices are the record-order of the kept window).
  const lastIndexOf = new Map();
  usable.forEach((detail, i) => lastIndexOf.set(detail, i));
  const unique = [...lastIndexOf.values()].sort((a, b) => a - b).map((i) => usable[i]);
  // last <=3 unique details, rendered in record order.
  const window = unique.slice(-BRIEF_CORRECTION_MAX_ITEMS);
  return window.map(sanitizeBriefCorrectionDetail).join("\n\n");
}
