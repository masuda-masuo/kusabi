// audit-verdict.mjs — Sol audit verdict validation, binding, and immutable
// override records (kusabi #524 slice 3, #528).
//
// A Sol verdict is machine-validated INPUT to the deterministic driver: this
// module makes sure a verdict is (a) schema-valid against
// schemas/audit-verdict.schema.json using the existing generic validator
// (review-validate.mjs), (b) bound to the exact gate and evidence envelope it
// claims to judge, and (c) never rewritten or erased by a later human
// override — an override is an additive immutable record that EMBEDS the
// original verdict byte-for-byte.
//
// The module is pure and I/O-injection friendly: the only filesystem access
// is the schema load (same pattern as review-validate.mjs), no mission
// directories are created, and time is never read from the clock — every
// timestamp is injected by the caller.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSchema } from "./review-validate.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = path.resolve(SCRIPT_DIR, "../schemas/audit-verdict.schema.json");
const LEGACY_SCHEMA_FILE = path.resolve(SCRIPT_DIR, "../schemas/audit-verdict.v1.schema.json");

/** Verdict schema version (mirrors `schema_version` const in the schema file). */
export const AUDIT_VERDICT_SCHEMA_VERSION = 2;

/** The verdict enum — `clear` is the only clearing verdict. */
export const AUDIT_VERDICTS = ["clear", "rework", "block"];

/**
 * The closed enum of machine-readable human resolutions an override record
 * carries.  A consumer reads `resolution` — it must never infer the human's
 * decision from the free-text `reason`.
 */
export const AUDIT_OVERRIDE_RESOLUTIONS = ["clear", "rework", "block"];

/**
 * The verdict values a human may override.  Both can block progression:
 * `block` always blocks, and `rework` fails closed on a mandatory gate.  A
 * `clear` verdict never blocks anything, so there is nothing to override —
 * overriding one is rejected deterministically (`nothing-to-override`).
 */
export const OVERRIDABLE_VERDICTS = new Set(["block", "rework"]);

/** The exact shape an evidence-envelope hash must have. */
export const ENVELOPE_SHA256_RE = /^[0-9a-f]{64}$/;

/** Bounded summary length (the design caps the verdict summary at 500 chars). */
export const SUMMARY_MAX_LENGTH = 500;

/** Bounded block-reason length. */
export const BLOCK_REASON_MAX_LENGTH = 200;

/** Bounded per-invariant finding and per-criterion note length. */
export const AUDIT_VERDICT_ITEM_TEXT_MAX_LENGTH = 300;

/** Every way a verdict is rejected.  `code` is the machine-readable half. */
export class AuditVerdictError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = "AuditVerdictError";
    this.code = code;
    if (details !== null) this.details = details;
  }
}

let cachedLegacySchema = null;

function loadLegacyAuditVerdictSchema() {
  if (!cachedLegacySchema) {
    cachedLegacySchema = JSON.parse(fs.readFileSync(LEGACY_SCHEMA_FILE, "utf8"));
  }
  return cachedLegacySchema;
}

let cachedSchema = null;

export function loadAuditVerdictSchema() {
  if (!cachedSchema) {
    cachedSchema = JSON.parse(fs.readFileSync(SCHEMA_FILE, "utf8"));
  }
  return cachedSchema;
}

/**
 * Validate a verdict record against audit-verdict.schema.json plus the
 * code-level bounds the generic validator cannot express (`pattern` and
 * `maxLength` are not implemented keywords):
 *   - `envelope_sha256` must be exactly 64 lowercase hex chars;
 *   - `summary` is bounded to 500 chars;
 *   - `block_reason` is bounded to 200 chars.
 *
 * @param {any} record — the verdict record under test.
 * @param {object} [options] — passed through to validateSchema
 *   ({schema} override included).
 * @returns {{ valid: boolean, errors: Array<{path, expected, actual}> }}
 */
export function validateAuditVerdict(record, options = {}) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return {
      valid: false,
      errors: [{
        path: "/",
        expected: "type: object",
        actual: record === null ? "null" : Array.isArray(record) ? "array" : typeof record,
      }],
    };
  }

  const schema = options.schema ||
    (record.schema_version === 1 && options.requireV2 !== true
      ? loadLegacyAuditVerdictSchema()
      : loadAuditVerdictSchema());
  const errors = [];
  validateSchema(schema, record, "", options, errors);
  if (record.schema_version !== 1 && record.schema_version !== AUDIT_VERDICT_SCHEMA_VERSION) {
    errors.push({ path: "/schema_version", expected: "1 or " + AUDIT_VERDICT_SCHEMA_VERSION, actual: record.schema_version });
  }

  if (options.requireV2 === true && record.schema_version !== AUDIT_VERDICT_SCHEMA_VERSION) {
    errors.push({
      path: "/schema_version",
      expected: "const " + AUDIT_VERDICT_SCHEMA_VERSION,
      actual: record.schema_version,
    });
  }

  if (typeof record.envelope_sha256 === "string" && !ENVELOPE_SHA256_RE.test(record.envelope_sha256)) {
    errors.push({ path: "/envelope_sha256", expected: "string matching ^[0-9a-f]{64}$", actual: record.envelope_sha256 });
  }
  if (typeof record.summary === "string" && record.summary.length > SUMMARY_MAX_LENGTH) {
    errors.push({ path: "/summary", expected: "string with length <= " + SUMMARY_MAX_LENGTH, actual: record.summary.length });
  }
  if (typeof record.block_reason === "string" && record.block_reason.length > BLOCK_REASON_MAX_LENGTH) {
    errors.push({ path: "/block_reason", expected: "string with length <= " + BLOCK_REASON_MAX_LENGTH, actual: record.block_reason.length });
  }

  if (record.schema_version === AUDIT_VERDICT_SCHEMA_VERSION) {
    const invariantEntries = Array.isArray(record.invariants) ? record.invariants : [];
    const criterionEntries = Array.isArray(record.criteria) ? record.criteria : [];
    const expectedInvariantIds = expectedIds(options.invariantIds ?? options.invariants);
    const expectedCriterionIds = expectedIds(options.criteria ?? options.acceptanceCriteria);
    validatePerItemIds(invariantEntries, expectedInvariantIds, "/invariants", errors);
    validatePerItemIds(criterionEntries, expectedCriterionIds, "/criteria", errors);

    invariantEntries.forEach((entry, index) => {
      if (entry && entry.held === false) {
        if (typeof entry.finding !== "string" || entry.finding.trim() === "") {
          errors.push({ path: "/invariants/" + index + "/finding", expected: "required non-empty string when held is false", actual: entry.finding });
        }
      }
      if (entry && typeof entry.finding === "string" && entry.finding.length > AUDIT_VERDICT_ITEM_TEXT_MAX_LENGTH) {
        errors.push({ path: "/invariants/" + index + "/finding", expected: "string with length <= " + AUDIT_VERDICT_ITEM_TEXT_MAX_LENGTH, actual: entry.finding.length });
      }
    });

    const rawEnvelopePaths = options.envelopeItemPaths ?? options.envelopePaths;
    const envelopePaths = new Set(
      (Array.isArray(rawEnvelopePaths) ? rawEnvelopePaths : [])
        .filter((value) => typeof value === "string"),
    );
    criterionEntries.forEach((entry, index) => {
      if (!entry || typeof entry !== "object") return;
      if (entry.status === "met" || entry.status === "not_met") {
        if (typeof entry.evidence !== "string" || entry.evidence.trim() === "") {
          errors.push({ path: "/criteria/" + index + "/evidence", expected: "required envelope item path when status is met or not_met", actual: entry.evidence });
        } else if (!envelopePaths.has(entry.evidence)) {
          errors.push({ path: "/criteria/" + index + "/evidence", expected: "path of an item in the current envelope", actual: entry.evidence });
        }
      } else if (typeof entry.evidence === "string" && !envelopePaths.has(entry.evidence)) {
        errors.push({ path: "/criteria/" + index + "/evidence", expected: "path of an item in the current envelope", actual: entry.evidence });
      }
      if (typeof entry.note === "string" && entry.note.length > AUDIT_VERDICT_ITEM_TEXT_MAX_LENGTH) {
        errors.push({ path: "/criteria/" + index + "/note", expected: "string with length <= " + AUDIT_VERDICT_ITEM_TEXT_MAX_LENGTH, actual: entry.note.length });
      }
    });

    if (record.verdict === "clear") {
      if (invariantEntries.some((entry) => entry && entry.held === false)) {
        errors.push({ path: "/verdict", expected: "rework or block when an invariant is not held", actual: record.verdict });
      }
      if (criterionEntries.some((entry) => entry && entry.status === "not_met")) {
        errors.push({ path: "/verdict", expected: "rework or block when a criterion is not_met", actual: record.verdict });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function expectedIds(value) {
  if (!Array.isArray(value)) return null;
  return value.map((item) => typeof item === "string" ? item : item?.id).filter((id) => typeof id === "string");
}

function validatePerItemIds(entries, expected, prefix, errors) {
  const seen = new Map();
  entries.forEach((entry, index) => {
    const id = entry?.id;
    if (typeof id !== "string" || id.trim() === "") return;
    if (seen.has(id)) {
      errors.push({ path: prefix + "/" + index + "/id", expected: "unique id", actual: id });
    } else {
      seen.set(id, index);
    }
    if (expected && !expected.includes(id)) {
      errors.push({ path: prefix + "/" + index + "/id", expected: "known id", actual: id });
    }
  });
  if (expected) {
    for (const id of expected) {
      if (!seen.has(id)) errors.push({ path: prefix, expected: "entry with id " + id, actual: "missing" });
    }
    for (const id of new Set(expected)) {
      if (expected.filter((candidate) => candidate === id).length > 1) {
        errors.push({ path: prefix, expected: "unique expected ids", actual: id });
      }
    }
  }
}


/**
 * Bind a verdict record to the gate and evidence envelope it is being judged
 * against.  A verdict naming a different gate, or an envelope hash that is
 * not the current envelope's, is stale or forged and is rejected outright —
 * the driver must never act on a verdict for a different gate.
 *
 * @param {object} record — the verdict record (schema-validated first).
 * @param {object} binding
 * @param {string} binding.gateId — the gate the driver is actually evaluating.
 * @param {string} binding.envelopeSha256 — the current evidence envelope hash.
 * @returns {object} the same record, unmodified, when binding holds.
 * @throws {AuditVerdictError}
 */
export function bindAuditVerdict(record, { gateId, envelopeSha256, ...validationOptions }) {
  const { valid, errors } = validateAuditVerdict(record, validationOptions);
  if (!valid) {
    throw new AuditVerdictError(
      `invalid audit verdict record: ${errors.map((e) => `${e.path} ${e.expected}`).join("; ")}`,
      "invalid-verdict",
      { errors },
    );
  }
  if (record.gate_id !== gateId) {
    throw new AuditVerdictError(
      `audit verdict gate mismatch: record claims gate_id=${JSON.stringify(record.gate_id)}, ` +
        `but the gate being evaluated is ${JSON.stringify(gateId)}`,
      "gate-mismatch",
    );
  }
  if (record.envelope_sha256 !== envelopeSha256) {
    throw new AuditVerdictError(
      `audit verdict envelope mismatch (stale or forged): record binds ${record.envelope_sha256}, ` +
        `current envelope is ${envelopeSha256}`,
      "envelope-mismatch",
    );
  }
  return record;
}

/**
 * The single writer seam for a persisted audit verdict.  Validation and
 * binding happen here, before anything can be persisted; the actual write is
 * injected (`persist`) so this module stays deterministic and never creates
 * mission directories.  With no `persist` the record is only validated and
 * returned.
 *
 * The persisted record is the exact validated record — never a rewritten
 * copy — so the original verdict survives byte-for-byte.
 *
 * @param {object} record — the verdict record.
 * @param {object} [opts]
 * @param {string} opts.gateId — required binding target.
 * @param {string} opts.envelopeSha256 — required binding target.
 * @param {(record: object) => Promise<void>|void} [opts.persist] — injected writer.
 * @returns {Promise<object>} the validated, bound record.
 * @throws {AuditVerdictError}
 */
export async function recordAuditVerdict(record, { gateId, envelopeSha256, persist, ...validationOptions } = {}) {
  const bound = bindAuditVerdict(record, { gateId, envelopeSha256, ...validationOptions });
  if (typeof persist === "function") {
    await persist(bound);
  }
  return bound;
}

/**
 * Parse the Sol JSONL wire stream (kusabi #524 §11): finding records and the
 * closing verdict record.  The `type` discriminator is consumed on findings
 * (whose schema forbids it) and kept on the verdict record (whose schema
 * requires it).
 *
 *   {"type":"finding","severity":"high","title":"...","body":"..."}
 *   {"type":"verdict","schema_version":1,"gate_id":"gate-3",
 *    "envelope_sha256":"...","verdict":"block","block_reason":"wrong_premise",
 *    "acknowledgement_required":true,"summary":"..."}
 *
 * Finding records are collected in order; any line that is not a recognised
 * record is ignored (prose, fences, junk) and counted.  Records pass through
 * unvalidated — the caller runs validateAuditVerdict / bindAuditVerdict on
 * the result.
 *
 * Exactly ONE verdict record is required.  A second verdict record — even an
 * identical duplicate — makes the stream AMBIGUOUS: a block followed by a
 * clear (or the reverse) cannot be resolved by the parser, and silently
 * preferring the last could drop a veto.  The parse fails closed: `verdict`
 * becomes null and the ambiguity is reported in the result so the caller
 * must not treat the gate as cleared.
 *
 * @param {string} text — the seat's raw output.
 * @returns {{
 *   verdict: object|null,      // the single verdict record (kept whole,
 *                              //   including `type: "verdict"`); null when no
 *                              //   verdict arrived OR the stream is ambiguous
 *   findings: object[],        // finding records in order (wire `type` stripped)
 *   ignoredLines: number,      // non-record lines skipped
 *   verdictCount: number,      // verdict records seen (0, 1, or more)
 *   ambiguous: boolean,        // true when >1 verdict records (even identical)
 * }}
 */
export function parseAuditVerdictJsonl(text) {
  if (typeof text !== "string") {
    throw new AuditVerdictError("parseAuditVerdictJsonl: input must be a string", "invalid-verdict");
  }

  const findings = [];
  let verdict = null;
  let verdictCount = 0;
  let ignoredLines = 0;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (!line.startsWith("{")) {
      ignoredLines++;
      continue;
    }
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      ignoredLines++;
      continue;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      ignoredLines++;
      continue;
    }
    if (value.type === "finding") {
      // Findings are evidence lines; the review-output schema they will be
      // validated against forbids `type`, so the discriminator is consumed.
      findings.push(withoutType(value));
    } else if (value.type === "verdict") {
      // The verdict record keeps `type: "verdict"` — audit-verdict.schema.json
      // requires it, so the record can be validated exactly as written.
      verdictCount++;
      if (verdictCount === 1) {
        verdict = value;
      } else {
        // Second (or later) verdict record: ambiguous, never prefer the last
        // — a veto would be silently dropped.  Fail closed: no verdict.
        verdict = null;
      }
    } else {
      ignoredLines++;
    }
  }

  return {
    verdict,
    findings,
    ignoredLines,
    verdictCount,
    ambiguous: verdictCount > 1,
  };
}

/** Copy a record without its wire-level `type` key, preserving key order. */
function withoutType(record) {
  const out = {};
  for (const key of Object.keys(record)) {
    if (key !== "type") out[key] = record[key];
  }
  return out;
}

/**
 * Create a human override record — the ONLY way a Sol block is ever
 * reconsidered (the authority matrix of the accepted #524 design: the human
 * overrides, never Luna, never the model).  The override is an ADDITIVE
 * IMMUTABLE record: it embeds the original verdict record byte-for-byte and
 * never rewrites or erases it.
 *
 * The override carries an explicit machine-readable `resolution` (one of
 * `clear | rework | block`) — the human's decision on the gate.  A consumer
 * must read `resolution` and never infer the decision from the free-text
 * `reason`.
 *
 * Only verdicts that can block progression may be overridden: `block`
 * (always blocks) and `rework` (fails closed on a mandatory gate).  A
 * `clear` original never blocks anything, so overriding it is rejected
 * deterministically — there is no veto to reconsider.
 *
 * Luna/model-originated input cannot flow in here: there is no field for a
 * model's output to become the override — the constructor takes the ORIGINAL
 * verdict (which is the model's own record, being overridden) plus human-only
 * attribution (`resolution`, `by`, `reason`, `timestamp`), and every
 * attribution field is required.  An override cannot override an override.
 *
 * @param {object} args
 * @param {object} args.original — the original verdict record (schema-valid,
 *   verdict `block` or `rework`).
 * @param {"clear"|"rework"|"block"} args.resolution — the machine-readable
 *   human decision on the gate.
 * @param {string} args.by — the human identifier authorising the override.
 * @param {string} args.reason — the human's reason, persisted verbatim.
 * @param {number|string} args.timestamp — injected time (epoch ms or ISO
 *   string); never read from the clock, so the record is deterministic.
 * @returns {object} the immutable override record.
 * @throws {AuditVerdictError}
 */
export function createAuditOverride({ original, resolution, by, reason, timestamp }) {
  if (!isPlainObject(original)) {
    throw new AuditVerdictError(
      "cannot override something that is not a verdict record",
      "invalid-verdict",
    );
  }
  if (original.kind === "audit-override") {
    throw new AuditVerdictError(
      "an override is itself an immutable record — an override of an override is not allowed",
      "override-of-override",
    );
  }
  const { valid, errors } = validateAuditVerdict(original);
  if (!valid) {
    throw new AuditVerdictError(
      `cannot override an invalid verdict record: ${errors.map((e) => `${e.path} ${e.expected}`).join("; ")}`,
      "invalid-verdict",
      { errors },
    );
  }
  if (!OVERRIDABLE_VERDICTS.has(original.verdict)) {
    throw new AuditVerdictError(
      `cannot override a verdict that never blocks progression (verdict=${JSON.stringify(original.verdict)}): ` +
        "only a `block` (always blocks) or `rework` (fails closed on a mandatory gate) verdict " +
        "carries a veto to override",
      "nothing-to-override",
    );
  }
  if (!AUDIT_OVERRIDE_RESOLUTIONS.includes(resolution)) {
    throw new AuditVerdictError(
      `a human override requires a machine-readable resolution, one of ` +
        `${AUDIT_OVERRIDE_RESOLUTIONS.join(", ")} (got ${JSON.stringify(resolution)})`,
      "invalid-resolution",
    );
  }
  if (typeof by !== "string" || by.trim() === "") {
    throw new AuditVerdictError(
      "a human override requires a human identifier (`by`)",
      "not-a-human-override",
    );
  }
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new AuditVerdictError(
      "a human override requires a non-empty reason",
      "not-a-human-override",
    );
  }
  const timestampValid =
    (typeof timestamp === "number" && Number.isFinite(timestamp)) ||
    (typeof timestamp === "string" && timestamp.trim() !== "");
  if (!timestampValid) {
    throw new AuditVerdictError(
      "a human override requires an injected timestamp (epoch ms number or ISO string)",
      "not-a-human-override",
    );
  }

  // Freeze a copy of the original verdict into the override: byte-for-byte
  // identical to the source record when serialised, and immutable from here on.
  const originalFrozen = Object.freeze({ ...original });
  return {
    kind: "audit-override",
    schema_version: AUDIT_VERDICT_SCHEMA_VERSION,
    gate_id: original.gate_id,
    envelope_sha256: original.envelope_sha256,
    original: originalFrozen,
    resolution,
    by,
    reason,
    timestamp,
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}