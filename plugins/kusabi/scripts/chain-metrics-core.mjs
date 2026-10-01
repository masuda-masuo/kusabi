// chain-metrics-core.mjs — Shared semantics for kusabi chain metrics and reporting.
//
// Pure domain logic for dispositions, escalate splits, time-window scoping,
// and round/finding definitions.  Used by both filesystem-based reporting
// (chain-stats.mjs) and database-backed reporting (metrics-report.mjs) to ensure
// identical semantics across reporting surfaces.

import {
  classifyEscalate as substanceClassifyEscalate,
  roundWorktreeChanged,
  roundWorkerProducedChange,
} from "./chain-substance.mjs";

export { roundWorktreeChanged, roundWorkerProducedChange };

// =========================================================================
// Dispositions
// =========================================================================

/**
 * Standard final disposition vocabulary.
 */
export const DISPOSITIONS = new Set([
  "accept",
  "accept-with-followup",
  "rework",
  "strategize",
  "escalate",
  "discard",
]);

/**
 * Standard display order for dispositions.
 */
export const DISPOSITION_ORDER = [
  "accept",
  "accept-with-followup",
  "escalate",
  "rework",
  "strategize",
  "discard",
];

/**
 * Extract raw disposition string from a round.
 * Supports:
 * - raw JSON round records: `{ disposition: { disposition: "accept" } }`
 * - normalized SQL round rows: `{ disposition: "accept" }`
 * - direct string / null / undefined
 *
 * @param {object|null|undefined} round
 * @returns {string|null}
 */
export function extractRoundDisposition(round) {
  if (!round || typeof round !== "object") return null;
  if (typeof round.disposition === "string") return round.disposition;
  if (round.disposition && typeof round.disposition === "object") {
    if (typeof round.disposition.disposition === "string") {
      return round.disposition.disposition;
    }
  }
  return null;
}

/**
 * Normalize a raw disposition string to a known disposition, "other", or null.
 *
 * @param {string|null|undefined} disp
 * @returns {string|null}
 */
export function normalizeDisposition(disp) {
  if (disp === null || disp === undefined || disp === "") return null;
  return DISPOSITIONS.has(disp) ? disp : "other";
}

/**
 * Create a fresh disposition counts object covering all standard buckets and "other".
 *
 * @returns {Record<string, number>}
 */
export function createDispositionCounts() {
  return {
    accept: 0,
    "accept-with-followup": 0,
    rework: 0,
    strategize: 0,
    escalate: 0,
    discard: 0,
    other: 0,
  };
}

/**
 * Find the last round of a chain (round = MAX(round)).
 *
 * @param {object[]} rounds
 * @returns {object|null}
 */
export function findFinalRound(rounds) {
  if (!Array.isArray(rounds) || rounds.length === 0) return null;
  let hasNumbered = false;
  let maxRound = -Infinity;
  let maxEntry = null;
  for (const r of rounds) {
    if (r && typeof r.round === "number" && Number.isFinite(r.round)) {
      hasNumbered = true;
      if (maxEntry === null || r.round > maxRound) {
        maxRound = r.round;
        maxEntry = r;
      }
    }
  }
  if (hasNumbered) {
    return maxEntry;
  }
  return rounds[rounds.length - 1];
}

/**
 * Final disposition = disposition of the chain's LAST round (round = MAX(round)).
 * Same definition chain-stats.mjs already uses (now lives here); the two surfaces must not
 * disagree about what "final" means.
 *
 * Supports two calling conventions:
 * 1. `finalDisposition(rounds)` — pass an array of round objects (raw JSON or SQL rows)
 * 2. `finalDisposition(chainId, roundsByChain)` — pass chainId and Map/Object of rounds
 *
 * @param {string|object[]} chainIdOrRounds
 * @param {Map<string, object[]>|Record<string, object[]>} [roundsByChain]
 * @returns {string|null}
 */
export function finalDisposition(chainIdOrRounds, roundsByChain) {
  let rounds;
  if (Array.isArray(chainIdOrRounds)) {
    rounds = chainIdOrRounds;
  } else if (roundsByChain && typeof roundsByChain.get === "function") {
    rounds = roundsByChain.get(chainIdOrRounds) || [];
  } else if (roundsByChain && typeof roundsByChain === "object") {
    rounds = roundsByChain[chainIdOrRounds] || [];
  } else {
    rounds = [];
  }

  const lastRound = findFinalRound(rounds);
  if (!lastRound) return null;

  const rawDisp = extractRoundDisposition(lastRound);
  if (!rawDisp) return null;

  return normalizeDisposition(rawDisp);
}

// =========================================================================
// Escalate split
// =========================================================================

/**
 * Create a fresh escalate split tracking object.
 *
 * @param {{ includeEscalated?: boolean }} [options]
 * @returns {{ escalated?: number, substantive: number, noWork: number, unknown: number }}
 */
export function createEscalateSplit(options = {}) {
  const { includeEscalated = false } = options;
  if (includeEscalated) {
    return { escalated: 0, substantive: 0, noWork: 0, unknown: 0 };
  }
  return { substantive: 0, noWork: 0, unknown: 0 };
}

/**
 * Classify whether an escalated chain produced substantive work, no work, or is unknown.
 * Supports both raw JSON rounds and SQL round rows.
 *
 * @param {object[]} rounds
 * @returns {"substantive"|"no-work"|"unknown"}
 */
export function classifyEscalate(rounds) {
  return substanceClassifyEscalate(rounds);
}

/**
 * Record an escalated chain in an escalateSplit object.
 * Increments `escalated` if the property exists on the split object.
 *
 * @param {{ escalated?: number, substantive: number, noWork: number, unknown: number }} split
 * @param {object[]} rounds
 * @returns {"substantive"|"no-work"|"unknown"}
 */
export function recordEscalate(split, rounds) {
  if (Object.hasOwn(split, "escalated")) {
    split.escalated += 1;
  }
  // Classify over the SAME in-range rounds that produced the
  // disposition, so the split never disagrees with the count.
  // kusabi #380: classifyEscalate (chain-substance.mjs) now derives the
  // substantive/no-work verdict from a round's closed stopReason when the
  // record carries one; records without the field keep the original
  // worktreeChanged heuristic unchanged (criterion #3).  The unknown
  // sentinel and every non-completed reason fail closed into no-work,
  // never into substantive.
  const label = classifyEscalate(rounds);
  if (label === "substantive") {
    split.substantive += 1;
  } else if (label === "no-work") {
    split.noWork += 1;
  } else {
    split.unknown += 1;
  }
  return label;
}

// =========================================================================
// Time window scoping
// =========================================================================

/**
 * Parse a `--since`/`--until` bound to epoch ms. Returns undefined for an
 * absent bound. An unparseable bound is a fatal error — this surface never
 * degrades to string comparison the way chain-stats does.
 *
 * @param {string|undefined} value
 * @param {string} flagLabel  e.g. "--since"
 * @returns {number|undefined}
 */
export function parseTimeBound(value, flagLabel) {
  if (value === undefined || value === null || value === "") return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`${flagLabel}: not a parseable timestamp: ${value}`);
  }
  return ms;
}

/**
 * Lenient parse bound to epoch ms or null (for chain-stats fallback).
 *
 * @param {string|undefined} value
 * @returns {number|null}
 */
export function parseLenientTimeBound(value) {
  if (value === undefined || value === null || value === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Check whether a timestamp in epoch ms falls within [sinceMs, untilMs).
 *
 * @param {number|null|undefined} ms
 * @param {number|undefined} sinceMs
 * @param {number|undefined} untilMs
 * @param {boolean} hasBound
 * @returns {boolean}
 */
export function instantInWindow(ms, sinceMs, untilMs, hasBound) {
  if (!hasBound) return true;
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return false;
  if (sinceMs !== undefined && ms < sinceMs) return false;
  if (untilMs !== undefined && ms >= untilMs) return false;
  return true;
}

/**
 * A chain's window key: MIN(round.started_ms) over its rounds; if that is
 * unavailable, Date.parse(orch_date + "T00:00:00Z"); if that is also
 * unusable, null (undated).
 *
 * @param {object} chain
 * @param {Map<string, object[]>|Record<string, object[]>} [roundsByChain]
 * @returns {number|null}
 */
export function chainWindowKeyMs(chain, roundsByChain) {
  if (!chain || typeof chain !== "object") return null;

  let rounds;
  const chainId = chain.chain_id ?? chain.chainId;
  if (roundsByChain && typeof roundsByChain.get === "function") {
    rounds = roundsByChain.get(chainId) || [];
  } else if (roundsByChain && typeof roundsByChain === "object") {
    rounds = roundsByChain[chainId] || [];
  } else if (Array.isArray(chain.rounds)) {
    rounds = chain.rounds;
  } else {
    rounds = [];
  }

  let min;
  for (const r of rounds) {
    let ms = null;
    if (typeof r.started_ms === "number" && Number.isFinite(r.started_ms)) {
      ms = r.started_ms;
    } else if (typeof r.startedAt === "string") {
      const parsed = Date.parse(r.startedAt);
      if (Number.isFinite(parsed)) ms = parsed;
    }
    if (ms === null) continue;
    if (min === undefined || ms < min) min = ms;
  }
  if (min !== undefined) return min;

  const orchDate = chain.orch_date ?? chain.orchDate ?? chain.orchestrator?.orchDate ?? chain.meta?.orchDate;
  if (typeof orchDate === "string") {
    const ms = Date.parse(`${orchDate}T00:00:00Z`);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

/**
 * Check whether a chain window key falls within the active window.
 *
 * @param {number|null|undefined} keyMs
 * @param {number|undefined} sinceMs
 * @param {number|undefined} untilMs
 * @param {boolean} hasBound
 * @returns {boolean}
 */
export function chainInWindow(keyMs, sinceMs, untilMs, hasBound) {
  return instantInWindow(keyMs, sinceMs, untilMs, hasBound);
}

/**
 * Check whether a turn falls within the active window.
 *
 * @param {object} t
 * @param {number|undefined} sinceMs
 * @param {number|undefined} untilMs
 * @param {boolean} hasBound
 * @returns {boolean}
 */
export function turnInWindow(t, sinceMs, untilMs, hasBound) {
  return instantInWindow(t?.ts_ms, sinceMs, untilMs, hasBound);
}

/**
 * A job's window key: started_ms, else finished_ms, else null (undated).
 *
 * @param {object} job
 * @returns {number|null}
 */
export function jobWindowKeyMs(job) {
  if (!job || typeof job !== "object") return null;
  if (job.started_ms !== null && job.started_ms !== undefined) return job.started_ms;
  if (job.finished_ms !== null && job.finished_ms !== undefined) return job.finished_ms;
  if (job.created_ms !== null && job.created_ms !== undefined) return job.created_ms;
  return null;
}

/**
 * Check whether a job falls within the active window.
 *
 * @param {object} job
 * @param {number|undefined} sinceMs
 * @param {number|undefined} untilMs
 * @param {boolean} hasBound
 * @returns {boolean}
 */
export function jobInWindow(job, sinceMs, untilMs, hasBound) {
  if (!hasBound) return true;
  const k = jobWindowKeyMs(job);
  return instantInWindow(k, sinceMs, untilMs, hasBound);
}

/**
 * Check whether a round record's startedAt string passes the chain-stats time filter.
 * Preserves the exact behavior of chain-stats: instant comparison when parseable,
 * fallback to lexicographic string comparison when unparseable.
 *
 * @param {string|undefined} startedAt
 * @param {string|undefined} since
 * @param {string|undefined} until
 * @param {number|null} sinceMs
 * @param {number|null} untilMs
 * @returns {boolean}
 */
export function roundPassesTimeFilter(startedAt, since, until, sinceMs, untilMs) {
  if (since === undefined && until === undefined) return true;
  if (!startedAt) return false;
  // Compare as instants, not as strings.  `startedAt` is always written as
  // UTC (`...Z`), but a human writing `--since` / `--compare` naturally
  // reaches for local time (`2026-07-26T10:53:49+09:00`).  Lexicographic
  // comparison puts that same instant on the wrong side of the cutoff --
  // silently, with a plausible-looking table.  Unparseable bounds fall back
  // to string comparison so a malformed flag degrades no worse than before.
  const at = Date.parse(startedAt);
  if (sinceMs !== null && Number.isFinite(at)) {
    if (at < sinceMs) return false;
  } else if (since !== undefined && startedAt < since) {
    return false;
  }
  if (untilMs !== null && Number.isFinite(at)) {
    if (at >= untilMs) return false;
  } else if (until !== undefined && startedAt >= until) {
    return false;
  }
  return true;
}

// =========================================================================
// Round and finding definitions
// =========================================================================

/** Known severity vocabulary, in display order.  Unknown severities render
 * verbatim after these; NULL severity renders as its own "(no severity)"
 * bucket (the finding_files generation has no severity at all). */
export const SEVERITY_ORDER = ["low", "medium", "high", "critical"];

/**
 * Set of known finding severities.
 */
export const KNOWN_SEVERITIES = new Set(SEVERITY_ORDER);

/**
 * Extract findings text from a round record (findingsText, or joined titles of findings).
 *
 * @param {object} round
 * @returns {string}
 */
export function extractRoundFindingsText(round) {
  if (!round || typeof round !== "object") return "";
  if (typeof round.findingsText === "string" && round.findingsText.length > 0) {
    return round.findingsText;
  }
  if (Array.isArray(round.findings)) {
    return round.findings.map((f) => f?.title || "").join(" ");
  }
  return "";
}

/**
 * Textual markers for prior unresolved findings.
 */
// Search for textual markers in findingsText (fallback) or finding titles.
export const PRIOR_UNRESOLVED_PATTERNS = [
  /prior\s+finding[,\s]*not\s+addressed/i,
  /prior\s+finding\s*#\d+\s+unresolved/i,
  /prior\s+finding.*unresolved/i,
  /not\s+addressed\s*\(prior/i,
  /previous\s+finding.*not\s+(?:addressed|resolved)/i,
  /still\s+unresolved/i,
];

/**
 * Test whether text contains any prior-unresolved finding pattern.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasPriorUnresolvedFinding(text) {
  if (!text || typeof text !== "string") return false;
  return PRIOR_UNRESOLVED_PATTERNS.some((p) => p.test(text));
}

/**
 * Section B — disposition × severity table (round-level).
 *
 * Per disposition (verbatim — an unknown disposition is its own row): the
 * round count and the finding count of those rounds, with the severity
 * breakdown.  The complementary distribution is the payload: if
 * accept-with-followup rounds carry exclusively low/medium findings while
 * rework carries the high/critical ones, the table shows it.  Known
 * severities are always present (zero is a measurement, and the zeros ARE
 * the signal); unknown severities render verbatim; NULL severity is its own
 * "(no severity)" bucket (the finding_files generation).
 *
 * Supports:
 * - SQL round rows with findingsByRound map (`${chainId}\0${round}`)
 * - raw JSON round records containing `round.findings` array
 *
 * @param {object[]} inWindowRounds
 * @param {Map<string, object[]>} findingsByRound  keyed by
 *   `${chain_id}\u0000${round}` — only in-window rounds are looked up.
 * @returns {Array<{ disposition: string, rounds: number, findings: number, severities: Record<string, number> }>}
 */
export function computeDispositionSeverity(inWindowRounds, findingsByRound) {
  const byDisposition = new Map();
  for (const r of inWindowRounds) {
    const rawDisp = extractRoundDisposition(r);
    const disp = rawDisp === null ? "(no disposition)" : String(rawDisp);
    let row = byDisposition.get(disp);
    if (!row) {
      row = { disposition: disp, rounds: 0, findings: 0, severities: {} };
      byDisposition.set(disp, row);
    }
    row.rounds += 1;

    let findings = [];
    if (findingsByRound) {
      const chainId = r.chain_id ?? r.chainId;
      const key = `${chainId}\0${r.round}`;
      findings = findingsByRound.get(key) || [];
    } else if (Array.isArray(r.findings)) {
      findings = r.findings;
    }

    for (const f of findings) {
      row.findings += 1;
      const sev = f.severity === null || f.severity === undefined ? "(no severity)" : String(f.severity);
      row.severities[sev] = (row.severities[sev] || 0) + 1;
    }
  }

  const rows = [...byDisposition.values()];
  for (const row of rows) {
    // The four known severities always appear — a zero is a real count and
    // the complement (e.g. no high/critical on accept-with-followup) is the
    // point of the table.
    for (const sev of SEVERITY_ORDER) {
      if (row.severities[sev] === undefined) row.severities[sev] = 0;
    }
  }
  rows.sort((a, b) => a.disposition.localeCompare(b.disposition));
  return rows;
}

/**
 * Verdicts considered review output pathology.
 */
export const REVIEW_PATHOLOGY_VERDICTS = new Set(["unparseable", "partial"]);

/** Known verdict_source vocabulary (kusabi #235): "probe" = the P3
 * empty-change-set discard written WITHOUT dispatching a review (not review
 * output); "recovered-from-token" = the review ran but its output was
 * unparseable and the verdict was recovered from the model token stream
 * (review output).  The issue's comment lists the vocabulary as non-
 * exhaustive ("probe" / "recovered-from-token" など), so ANY other non-NULL
 * value is an unrecognized future source: it is NOT known to be review
 * output and must not be folded into the review bucket at the report
 * surface — it gets its own "other" bucket with the raw value rendered. */
export const REVIEW_SOURCE_VALUES = new Set(["probe", "recovered-from-token"]);

/**
 * Section C — review-output pathology rate (round-level, one number).
 *
 * Numerator: rounds whose verdict is in REVIEW_PATHOLOGY_VERDICTS and was
 * review-issued or unknown-source.  Denominator: rounds with a recorded
 * verdict that is review-issued or unknown-source — probe-issued verdicts
 * (the P3 empty-change-set discard, review never dispatched) are NOT review
 * output and are excluded from BOTH sides; their count is reported beside
 * the ratio so the exclusion is visible.  The same exclusion applies to an
 * unrecognized NON-NULL verdict_source (not in {probe,
 * recovered-from-token}): it is not known to be review output, so it must
 * not silently inflate the denominator — it is excluded from both sides,
 * counted (`otherIssued`) with the verbatim value(s) for disclosure.  A
 * store without the verdict_source column cannot tell probe-issued from
 * review-issued, so every verdict round is in the denominator and the ratio
 * is stated with that caveat.
 *
 * @param {object[]} inWindowRounds
 * @param {boolean} verdictSourceAvailable
 * @returns {object}
 */
export function computeReviewPathology(inWindowRounds, verdictSourceAvailable) {
  let pathologyCount = 0;
  let denominator = 0;
  let probeIssued = 0;
  let otherIssued = 0;
  const otherValues = new Set();
  for (const r of inWindowRounds) {
    if (r.verdict === null || r.verdict === undefined) continue;
    if (r.verdict_source === "probe") {
      probeIssued += 1;
      continue;
    }
    if (r.verdict_source !== null && r.verdict_source !== undefined && !REVIEW_SOURCE_VALUES.has(r.verdict_source)) {
      // Unrecognized non-NULL source — the same failure class the probe
      // exclusion exists for (a non-review verdict counted as review-issued
      // would corrupt the very scorecard this section exists to produce).
      // Excluded from both sides; counted with the verbatim value so the
      // exclusion is visible, never silent.
      otherIssued += 1;
      otherValues.add(r.verdict_source);
      continue;
    }
    denominator += 1;
    if (REVIEW_PATHOLOGY_VERDICTS.has(String(r.verdict))) pathologyCount += 1;
  }
  return {
    pathologyCount,
    denominator,
    pct: denominator === 0 ? null : (pathologyCount / denominator) * 100,
    verdictSourceAvailable,
    probeIssued,
    otherIssued,
    otherValues: [...otherValues].sort(),
  };
}

/** Empty section C shape (missing/empty stores) — no denominator to state. */
export function emptyReviewPathology() {
  return {
    pathologyCount: 0,
    denominator: 0,
    pct: null,
    verdictSourceAvailable: false,
    probeIssued: 0,
    otherIssued: 0,
    otherValues: [],
  };
}
