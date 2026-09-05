// Postable review record rendering.

import { roundChangedColumn } from "./render-chain.mjs";

// =========================================================================
// Review record rendering (kusabi #52)
//
// The postable markdown record generated when a chain reaches a terminal
// disposition.  Pure: no I/O, no imports from kusabi-companion.mjs.  Same
// tolerance discipline as renderChainShow — partial or minimal records render
// with placeholders/omissions, never throw.
// =========================================================================

const REVIEW_RECORD_BRIEF_TRUNCATE = 80;

/**
 * First line of the brief, truncated for the record title line.
 *
 * @param {string|undefined} brief
 * @returns {string}
 */
function reviewRecordBriefFirstLine(brief) {
  if (!brief || typeof brief !== "string") return "(no brief)";
  const first = brief.split("\n")[0].trim();
  if (first.length > REVIEW_RECORD_BRIEF_TRUNCATE) {
    return first.slice(0, REVIEW_RECORD_BRIEF_TRUNCATE) + "...";
  }
  return first;
}

/**
 * The "Orchestrator:" signature line from the brief (scanned in the first 5
 * lines, mirroring parseOrchestratorSignature), falling back to the parsed
 * orchestrator object when the brief has no line.
 *
 * @param {object} record
 * @returns {string}
 */
function reviewRecordOrchestratorLine(record) {
  const brief = record.brief;
  if (typeof brief === "string") {
    const lines = brief.split("\n");
    const maxLines = Math.min(lines.length, 5);
    for (let i = 0; i < maxLines; i++) {
      const t = (lines[i] || "").trim();
      if (t.startsWith("Orchestrator:")) {
        return t.slice("Orchestrator:".length).trim() || "(none)";
      }
    }
  }
  const o = record.orchestrator;
  if (o && typeof o === "object") {
    const parts = [];
    if (o.model) parts.push(o.model);
    if (o.session) parts.push("session " + o.session);
    if (o.date) parts.push(o.date);
    if (parts.length > 0) return parts.join(" | ");
  }
  return "(none)";
}

/**
 * Format the configured ladder: tiers joined with " → ", routes within a
 * tier with ", ". Empty when nothing was recorded.
 *
 * @param {*} modelChain
 * @returns {string}
 */
function formatConfiguredModelChain(modelChain) {
  if (!Array.isArray(modelChain) || modelChain.length === 0) return "";
  return modelChain.map(function (tier) {
    return Array.isArray(tier) ? tier.map(String).join(", ") : String(tier);
  }).join(" → ");
}

/**
 * Models that actually ran, in round order, first occurrence of each.
 * Prefers per-round `modelEntry`, then `model`.
 *
 * @param {object} record
 * @returns {string[]}
 */
function reviewRecordRanModels(record) {
  const seen = [];
  const rounds = Array.isArray(record.records) ? record.records : [];
  for (const r of rounds) {
    const m = r?.modelEntry || r?.model;
    if (m && !seen.includes(m)) seen.push(m);
  }
  return seen;
}

/**
 * Model-chain label: what ran (per-round models, unique, round order).
 * When a configured ladder is present and differs from what ran, it is
 * appended labelled as configured so it cannot be mistaken for the models
 * that did the work. Records with neither source render "(unknown)".
 *
 * @param {object} record
 * @returns {string}
 */
function reviewRecordModelChain(record) {
  const ran = reviewRecordRanModels(record);
  const ranLabel = ran.length > 0 ? ran.join(" → ") : "(unknown)";
  const configured = formatConfiguredModelChain(record.modelChain);
  if (configured && configured !== ranLabel) {
    return ranLabel + " (configured: " + configured + ")";
  }
  return ranLabel;
}

/**
 * finished: timestamp — the record's own when present and parseable, else
 * the current instant.
 *
 * @param {object} record
 * @returns {string} ISO 8601 string.
 */
function reviewRecordFinishedAt(record) {
  if (record.finishedAt) {
    const d = new Date(record.finishedAt);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

/**
 * One-line probe summary for the record: "P1: HEAD clean — PASS (detail)".
 * Structured JSON details (verify gate) are compacted to their salient
 * fields, like renderChainShow does; plain-text details are truncated.
 *
 * @param {object|null|undefined} probe
 * @returns {string}
 */
function reviewRecordProbeLine(probe) {
  if (!probe || typeof probe !== "object") return "? — unknown";
  const name = probe.probe || "probe";
  const status = probe.passed ? "PASS" : "FAIL";
  let detail = "";
  if (probe.detail) {
    let parsed = null;
    try { parsed = JSON.parse(probe.detail); } catch { /* plain text */ }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const parts = [];
      if (parsed.gate_passed !== undefined) parts.push("gate_passed=" + parsed.gate_passed);
      if (parsed.diff_summary && typeof parsed.diff_summary === "object") {
        const ds = parsed.diff_summary;
        const counts = [];
        if (ds.changed_files !== undefined) counts.push("changed=" + ds.changed_files);
        if (ds.untracked !== undefined) counts.push("untracked=" + ds.untracked);
        if (counts.length > 0) parts.push(counts.join(", "));
      }
      detail = parts.join(", ");
    } else {
      const text = String(probe.detail).replace(/\s+/g, " ").trim();
      detail = text.length > 100 ? text.slice(0, 100) + "..." : text;
    }
  }
  return `${name} — ${status}${detail ? " (" + detail + ")" : ""}`;
}

/**
 * Structured findings of one round: `{severity, text}` rows.
 *
 * Prefers the structured `findings` array; falls back to parsing the
 * machine-generated one-line findingsText ("[severity] title (file:line)").
 * Marker strings like "(no structured findings)" are not findings and are
 * skipped.  Rounds without findings data yield an empty array.
 *
 * @param {object} round
 * @returns {Array<{severity: string, text: string}>}
 */
function reviewRecordRoundFindings(round) {
  const structured = Array.isArray(round.findings)
    ? round.findings.filter(function (f) { return f && typeof f === "object"; })
    : [];
  if (structured.length > 0) {
    return structured.map(function (f) {
      const loc = f.file ? ` (${f.file}${f.line_start !== undefined ? ":" + f.line_start : ""})` : "";
      return { severity: f.severity || "unknown", text: (f.title || "(untitled)") + loc };
    });
  }
  if (typeof round.findingsText === "string" && round.findingsText.trim() !== "") {
    const rows = [];
    for (const raw of round.findingsText.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(/^\[([^\]]+)\]\s*(.+)$/);
      if (!m) continue;
      rows.push({ severity: m[1], text: m[2] });
    }
    return rows;
  }
  return [];
}

/**
 * Render the postable review record for a finished chain (kusabi #52).
 *
 * The record is generated when the chain reaches a terminal disposition
 * (accepted, or terminated by escalate / max-rounds) and is later posted to
 * the archive repository by the orchestrator — the companion never posts.
 * The two "fill at inspection" sections (findings adjudication and precedent)
 * are deliberately left blank for the orchestrator to fill by hand before
 * posting; they are always present, even when the chain produced no findings.
 *
 * Never throws: missing fields render as placeholders/omissions.
 *
 * @param {object|null|undefined} record
 *   - chainId, label (repo/cwd), brief, orchestrator, modelChain, container
 *   - maxRounds, records (round records), chainTotals
 *   - disposition: { disposition, round, reason? } — the FINAL disposition
 *   - finishedAt (ISO, optional; defaults to now)
 * @returns {string} The rendered markdown.
 */
function isReviewUndelivered(r) {
  if (!r || typeof r !== "object") return false;
  if (r.verdictSource === "probe") return false;
  if (Array.isArray(r.probeResults) && r.probeResults.length > 0 && !r.verdict) return true;
  if (r.reviewParseable === false) return true;
  if (r.verdict === "unparseable") return true;
  if (r.verdictSource === "recovered-from-token") return true;
  if (Boolean(r.reviewJobFailure)) return true;
  return false;
}

export function renderReviewRecord(record) {
  const rec = record ?? {};
  const chainId = rec.chainId || "(unknown)";
  const lines = [];

  // ---- header ----
  lines.push(`# [review-record] ${rec.label || "(unknown)"} ${chainId} — ${reviewRecordBriefFirstLine(rec.brief)}`);
  lines.push("");
  lines.push(`Orchestrator: ${reviewRecordOrchestratorLine(rec)} | finished: ${reviewRecordFinishedAt(rec)}`);
  lines.push(`Model chain: ${reviewRecordModelChain(rec)} | container: ${rec.container || "(unknown)"}`);
  if (rec.provisional) {
    lines.push("Note: PROVISIONAL RECORD — chain did not reach a disposition and may be superseded by chain-resume.");
  }
  const disp = rec.disposition || {};
  lines.push(`Final disposition: ${disp.disposition || "unknown"} at round ${disp.round ?? "?"} of ${rec.maxRounds ?? "?"}`);
  lines.push("");

  // ---- rounds ----
  lines.push("## Rounds");
  lines.push("");
  const rounds = Array.isArray(rec.records) ? rec.records : [];
  if (rounds.length === 0) {
    lines.push("(no round records)");
    lines.push("");
  }
  rounds.forEach(function (r, idx) {
    const round = r ?? {};
    const roundNo = round.round ?? idx + 1;
    const model = round.modelEntry || round.model || "?";
    const verdict = round.verdict || "?";
    const verdictSource = round.verdictSource || "parsed";
    const roundDisposition = round.disposition?.disposition ?? "?";
    // The shared changed-column describer (kusabi #299) folds the
    // probe-discard case in; this record's style is lowercase "no" for an
    // ordinary no-change round, so the plain NO value is mapped down (a
    // probe-discard round's value carries the dirty-vs-base wording and is
    // passed through as-is).
    const changedCol = roundChangedColumn(round);
    const changed = changedCol === "NO" ? "no" : changedCol;
    lines.push(`Round ${roundNo} — model: ${model}, verdict: ${verdict} (${verdictSource}), disposition: ${roundDisposition}, changed: ${changed}`);
    // Replacement review seats (kusabi #248): the verdict above came from the
    // LAST seat this round bought.  A seat that died mid-stream is named here
    // so the postable record cannot read as a single clean review.
    for (const seat of (Array.isArray(round.reviewSeatFailures) ? round.reviewSeatFailures : [])) {
      if (!seat || typeof seat !== "object") continue;
      lines.push(`  review seat ${seat.seat ?? "?"}: FAILED (verdict: ${seat.verdict ?? "?"}) — replaced by chain-resume`);
    }
    const probes = Array.isArray(round.probeResults) ? round.probeResults : [];
    for (const probe of probes) {
      lines.push("  " + reviewRecordProbeLine(probe));
    }
    const findings = reviewRecordRoundFindings(round);
    if (findings.length > 0) {
      lines.push("  findings:");
      for (const f of findings) {
        lines.push(`  - [${f.severity}] ${f.text}`);
      }
    }
    lines.push("");
  });

  // ---- findings adjudication (fill at inspection) ----
  lines.push("## Findings adjudication (fill at inspection)");
  lines.push("");
  const allFindings = [];
  for (const r of rounds) {
    allFindings.push(...reviewRecordRoundFindings(r ?? {}));
  }
  if (allFindings.length === 0) {
    const hasUndeliveredReview = rounds.length > 0 && rounds.some(isReviewUndelivered);
    if (hasUndeliveredReview) {
      lines.push("_No review verdict was delivered for this chain — implementation remains unadjudicated._");
      lines.push("");
      lines.push("| # | severity | finding | 採否 | 理由 |");
      lines.push("|---|---|---|---|---|");
      lines.push("| 1 | unknown | _No review verdict delivered — unadjudicated implementation_ | _fill_ | _fill_ |");
    } else {
      lines.push("_No findings were produced by this chain — nothing to adjudicate._");
    }
  } else {
    lines.push("| # | severity | finding | 採否 | 理由 |");
    lines.push("|---|---|---|---|---|");
    allFindings.forEach(function (f, i) {
      lines.push(`| ${i + 1} | ${f.severity} | ${f.text} | _fill_ | _fill_ |`);
    });
  }
  lines.push("");

  // ---- precedent (fill at inspection) ----
  lines.push("## 判例として (fill at inspection)");
  lines.push("");
  lines.push("_fill: reusable precedent, if any_");
  lines.push("");

  // ---- usage (from the chain's chainTotals, never recomputed) ----
  lines.push("## Usage");
  lines.push("");
  const t = rec.chainTotals ?? {};
  const num = function (v) { return Number.isFinite(v) ? v : 0; };
  lines.push(`input=${num(t.input)} output=${num(t.output)} reasoning=${num(t.reasoning)} cacheRead=${num(t.cacheRead)} cacheWrite=${num(t.cacheWrite)} cost=$${num(t.cost)}`);

  return lines.join("\n");
}
