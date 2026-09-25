// render-mission.mjs — kusabi #532 criterion 3: the additive mission
// rendering surface.
//
// The mission digest stays byte-identical for pre-#532 records (the legacy
// mission-show lines render first, unchanged); a #532 record gains a stable
// provenance banner (one line per seat with provider/model, requested,
// actual, substituted and reasoning effort — naming every seat explicitly,
// so a substitution is loud) and the recorded gate consultation origins.
//
// Plain-chain rendering is untouched: renderMissionChain renders a plain
// chain through the existing renderChainShow with the same arguments, so the
// bytes are identical to the chain surface's.
//
// The banner never fabricates a seat fact: a legacy record without reasoning
// effort degrades the banner (the reasoning-effort clause is only rendered
// when BOTH seats record one — never a partial, half-claimed picture), and
// the digest appends nothing at all when the record carries no #532
// observability fields.

import { renderChainShow } from "./render-chain.mjs";
import { renderMissionShow } from "./luna-cmd.mjs";
import { oneLine } from "./one-line.mjs";

/**
 * The stable provenance banner: one line per seat with provider/model,
 * requested, actual, substituted and reasoning effort.  Deterministic —
 * identical records produce identical bytes.  No trailing newline.
 *
 * The reasoning-effort clause appears only when BOTH seats record a
 * reasoning effort: a legacy record that never measured it must not read as
 * a partial, half-claimed picture, and the clause is never fabricated.
 *
 * @param {object} record — the mission record.
 * @returns {string}
 */
export function renderMissionProvenanceBanner(record) {
  const coordinator = record?.coordinator ?? {};
  const auditor = record?.auditor ?? {};
  const reasoningEffortKnown =
    typeof coordinator.reasoningEffort === "string" &&
    typeof auditor.reasoningEffort === "string";
  const seatLine = (role, seat) => {
    const provider = typeof seat.provider === "string" ? seat.provider : "?";
    const model = typeof seat.model === "string" ? seat.model : "?";
    const requested = typeof seat.requested === "string" ? seat.requested : model;
    const actual = typeof seat.actual === "string" ? seat.actual : model;
    const substituted = seat.substituted === true ? "true" : "false";
    const effort = reasoningEffortKnown ? `, reasoning effort: ${seat.reasoningEffort}` : "";
    return (
      `provenance: ${role} ${provider}/${model} ` +
      `(requested: ${requested}, actual: ${actual}, substituted: ${substituted}${effort})`
    );
  };
  return [seatLine("coordinator", coordinator), seatLine("auditor", auditor)].join("\n");
}

/**
 * The recorded gate consultation-origin lines (additive).
 *
 * @param {object} record — the mission record.
 * @returns {string[]}
 */
export function renderGateOrigins(record) {
  const gates = Array.isArray(record?.auditGates) ? record.auditGates : [];
  if (gates.length === 0) return [];
  const lines = ["audit gates:"];
  for (const gate of gates) {
    if (!gate || typeof gate !== "object") continue;
    const phase = typeof gate.phase === "string" ? gate.phase : "?";
    const origin = typeof gate.origin === "string" ? gate.origin : "not recorded";
    const verdict = typeof gate.verdict === "string" ? gate.verdict : "none";
    const shadow =
      typeof gate.shadowDisposition === "string"
        ? gate.shadowDisposition
        : "not recorded";
    lines.push(
      `  ${gate.gateId} (${phase}, origin: ${origin}, verdict: ${verdict}, shadow disposition: ${shadow})`,
    );
    if ((verdict === "block" || verdict === "rework") && gate.verdictRecord && typeof gate.verdictRecord === "object") {
      if (typeof gate.verdictRecord.summary === "string") {
        const summary = oneLine(gate.verdictRecord.summary);
        lines.push(`    summary: ${summary}`);
      }
      if (typeof gate.verdictRecord.block_reason === "string" && gate.verdictRecord.block_reason.trim() !== "") {
        const blockReason = oneLine(gate.verdictRecord.block_reason);
        lines.push(`    block_reason: ${blockReason}`);
      }
    }
  }
  return lines;
}

/**
 * Whether the record carries any #532 observability field worth appending:
 * a reasoning effort on either seat, or recorded audit gates.  A pure legacy
 * record gets the legacy digest byte-for-byte.
 */
function has532Observability(record) {
  if (typeof record?.coordinator?.reasoningEffort === "string") return true;
  if (typeof record?.auditor?.reasoningEffort === "string") return true;
  if (Array.isArray(record?.auditGates) && record.auditGates.length > 0) return true;
  return false;
}

/**
 * Render the read-only mission digest: the legacy mission-show lines
 * (byte-identical, contiguous prefix) followed by the #532 provenance banner
 * and the recorded gate consultation origins when the record carries them.
 *
 * @param {object} snapshot — the readMissionSnapshot shape.
 * @returns {string}
 */
export function renderMissionDigest(snapshot) {
  const legacy = renderMissionShow(snapshot);
  const record = snapshot?.record ?? {};
  if (!has532Observability(record)) return legacy;
  const lines = [legacy, renderMissionProvenanceBanner(record), ...renderGateOrigins(record)];
  return lines.join("\n");
}

/**
 * Render a plain chain through the mission surface.  Byte-identical to
 * renderChainShow(chain, rounds, [], control, opts) — the mission renderer
 * never alters plain-chain rendering.
 *
 * @param {object} chain
 * @param {Array} rounds
 * @param {object|null} [control]
 * @param {object} [opts]
 * @returns {string}
 */
export function renderMissionChain(chain, rounds, control = null, opts = {}) {
  return renderChainShow(chain, rounds, [], control, opts);
}