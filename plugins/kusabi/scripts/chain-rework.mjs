// chain-rework.mjs — Rework-tier helpers for cmdChain (kusabi #457).
//
// Extracted from chain-phases.mjs (kusabi #457).
// Owns path-normalised stall detection (normalizeFilePath, hasRepeatedAreas),
// scoped-rework scheduling (resolveReworkScope, inScopeFindingFiles),
// and rework tier escalation / clamp (applyTierEscalation, recordReworkEscalation).
//
// Does not import chain-phases.mjs, kusabi-companion.mjs, chain-driver.mjs,
// chain-finish.mjs, chain-cmd.mjs, chain-run.mjs, chain-review.mjs,
// chain-stats.mjs, or chain-resume-resolve.mjs.

import {
  groupFindingsByKind,
} from "./render.mjs";
import { deriveReworkStrategy } from "./disposition.mjs";

/**
 * Normalise a file path for cross-round file-path comparison.
 *
 * Strips leading/trailing whitespace so that minor formatting differences
 * do not affect suffix matching.  Path-form equivalence (absolute vs
 * relative) is handled by suffix-based matching in hasRepeatedAreas.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function normalizeFilePath(filePath) {
  if (!filePath) return "";
  if (typeof filePath !== "string") return String(filePath);
  return filePath.trim();
}

/**
 * Check whether any finding file from the current round matches a file
 * that appeared in a previous round.
 *
 * Two paths match when one is a suffix of the other on path-segment
 * boundaries (split by "/").  This handles the common case where one
 * reviewer uses an absolute in-container path like
 * "/workspace/src/a/b.py" and another uses the repository-relative
 * "src/a/b.py" — the shorter path's segments are a suffix of the longer.
 *
 * Old records without the findingFiles field are handled gracefully
 * (previousFindingFiles is undefined/null → no match).
 *
 * @param {string[]|undefined|null} previousFindingFiles
 * @param {Array|undefined|null} currentFindings  — findings array from
 *        the parsed review (each element has a .file property).
 * @returns {boolean}
 */
export function hasRepeatedAreas(previousFindingFiles, currentFindings) {
  if (!previousFindingFiles?.length) return false;
  if (!currentFindings?.length) return false;

  // Path-segment suffix match: split on "/" and check if one array
  // of segments is a suffix of the other.
  function suffixMatch(a, b) {
    const segA = a.split("/");
    const segB = b.split("/");
    const shorter = segA.length <= segB.length ? segA : segB;
    const longer = segA.length > segB.length ? segA : segB;
    if (shorter.length === 0) return false;
    const offset = longer.length - shorter.length;
    for (let i = 0; i < shorter.length; i++) {
      if (longer[offset + i] !== shorter[i]) return false;
    }
    return true;
  }

  for (let fi = 0; fi < currentFindings.length; fi++) {
    const currentPath = normalizeFilePath(currentFindings[fi]?.file);
    if (!currentPath) continue;
    for (let pi = 0; pi < previousFindingFiles.length; pi++) {
      const prevPath = normalizeFilePath(previousFindingFiles[pi]);
      if (!prevPath) continue;
      if (suffixMatch(currentPath, prevPath)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Decide the scope of a rework round from the previous round's findings
 * (kusabi #60 step 2: scheduling by finding kind).
 *
 * Single decision point for scoped reworks.  The budget invariant: maxRounds
 * buys design/full rounds only; mechanical rounds are free (a mechanical
 * checklist needs no design judgement, so it must not eat the design budget).
 * Missing/invalid `kind` on a finding counts as design (same consumption-point
 * default as groupFindingsByKind).
 *
 * Branch table:
 *   - no findings (probe-failure rework, old records)            -> full, []
 *   - previous round mechanical + any design finding present     -> design, [first]
 *   - findings contain BOTH kinds                                -> mechanical, mechanicalOnly
 *   - findings all design, length > 1                            -> design, [first]
 *   - findings all design, length == 1                           -> design, all
 *   - findings all mechanical                                    -> mechanical, all
 *
 * Array order is preserved: the scoped subset keeps the findings' original
 * order, and the one-per-round design case takes the FIRST design finding in
 * array order.
 *
 * @param {object|null|undefined} previousRecord
 * @returns {{ scope: "full"|"mechanical"|"design", findings: Array }}
 *   `findings` is the subset the round should resolve; for scope "full" it is
 *   empty because the full path renders the entire prior-findings block.
 */
export function resolveReworkScope(previousRecord) {
  if (!previousRecord) {
    return { scope: "full", findings: [] };
  }
  const findings = previousRecord.findings;
  if (!Array.isArray(findings) || findings.length === 0) {
    // Probe-failure rework (or old records without structured findings):
    // current behavior — whole prior findingsText.
    return { scope: "full", findings: [] };
  }
  const { design, mechanical } = groupFindingsByKind(findings);
  if (previousRecord.reworkScope === "mechanical" && design.length > 0) {
    // Followup: no two consecutive mechanical rounds while a design finding
    // is pending.  After a mechanical round, a pending design finding gets
    // the next round even in a mixed set; the mechanical items wait for the
    // following mechanical batch.  Unchanged for any other previous scope
    // (including old records without a reworkScope field).
    return { scope: "design", findings: [design[0]] };
  }
  if (design.length > 0 && mechanical.length > 0) {
    // Mixed: the mechanical checklist first; design findings are held back.
    return { scope: "mechanical", findings: mechanical };
  }
  if (design.length > 1) {
    // All design, several: one per round, in array order.
    return { scope: "design", findings: [design[0]] };
  }
  if (design.length === 1) {
    return { scope: "design", findings: design };
  }
  if (mechanical.length === 0) {
    // Findings array held nothing groupable (non-object entries): treat like
    // no findings rather than claiming a scoped subset.
    return { scope: "full", findings: [] };
  }
  return { scope: "mechanical", findings: mechanical };
}

/**
 * Narrow the previous round's finding files to the ones the reviewed round
 * was actually asked to resolve (kusabi #334).
 *
 * hasRepeatedAreas is shared surface with chain-stats (docs/design/
 * phase-chain.md), so its name, signature and semantics are frozen — this
 * function narrows what is PASSED to it, it does not fork the detector.  A
 * full-scope round passes previousRecord.findingFiles exactly as the
 * pre-scoping code did: every prior finding was in scope, so the computed
 * signal is identical to today's.  A scoped round passes only the in-scope
 * findings' files — a finding the round was told to leave alone is not
 * evidence of a stall.
 *
 * @param {object|null|undefined} previousRecord
 * @param {{scope: string, findings: Array}|undefined|null} reworkScope
 * @returns {string[]|undefined}
 */
export function inScopeFindingFiles(previousRecord, reworkScope) {
  if (!reworkScope || reworkScope.scope === "full") {
    return previousRecord?.findingFiles;
  }
  const inScope = Array.isArray(reworkScope.findings) ? reworkScope.findings : [];
  return inScope.map((f) => normalizeFilePath(f.file));
}

/**
 * Clamp a rework tier escalation to the modelChain's tier range.
 *
 * Pure function.  The model ladder is 0..tierCount-1; `selectRoutes` already
 * clamps dispatch, so an escalation past the top tier never changes the
 * model actually used — but the *recorded* tier must match it too (kusabi
 * #153: a 1-tier chain recorded "0 → 1" while the job stayed on flash, and
 * the orchestrator misread it as a stronger-model re-run).
 *
 * @param {object} opts
 * @param {number} opts.currentTierIndex  - Tier index before this escalation.
 * @param {number} opts.tierDelta         - Escalation step (normally +1).
 * @param {number} opts.tierCount         - Number of tiers in modelChain.
 * @returns {{ tierIndex: number, clamped: boolean, reason: string|null }}
 *   - `tierIndex` — min(current + delta, tierCount - 1).
 *   - `clamped`   — true when the raw escalation exceeded the top tier.
 *   - `reason`    — human-readable why (null when not clamped).
 */
export function applyTierEscalation({ currentTierIndex, tierDelta, tierCount }) {
  const nextTier = currentTierIndex + tierDelta;
  if (!Number.isFinite(tierCount) || tierCount <= 0) {
    // No usable ladder: nothing to clamp against.
    return { tierIndex: nextTier, clamped: false, reason: null };
  }
  const maxTier = tierCount - 1;
  if (nextTier <= maxTier) {
    return { tierIndex: nextTier, clamped: false, reason: null };
  }
  const reason = tierCount === 1
    ? "single-tier chain"
    : "escalation beyond top tier (modelChain has " + tierCount + " tiers)";
  return { tierIndex: maxTier, clamped: true, reason };
}

/**
 * Apply the rework levers for the NEXT round and record them on the current
 * round record, with the tier escalation clamped to the modelChain range.
 *
 * This is the driver's rework branch, extracted so the round-record contract
 * (tierAfter / tierClamped / tierClampReason) is testable without running a
 * chain.  Mutates roundRecord with the clamp fields only; the caller still
 * records `tierAfter` and `pendingReworkStrategy` on the round record and
 * persists cross-round state as before.
 *
 * @param {object} opts
 * @param {object} opts.roundRecord       - Current round record (mutated: tierClamped/tierClampReason).
 * @param {number} opts.currentTierIndex  - Tier index before this escalation.
 * @param {number} opts.reworkCount       - Reworks done so far (pre-increment).
 * @param {boolean} opts.strategized      - Whether a strategize already ran.
 * @param {number} opts.tierCount         - Number of tiers in modelChain.
 * @param {string} [opts.chainVerdict]    - Finished round's review verdict (anchoring-override evidence, #62).
 * @param {boolean} [opts.chainRepeatedAreas] - Same file area flagged across rounds.
 * @param {boolean} [opts.probesGreen]    - Finished round's deterministic probes passed.
 * @returns {{ currentTierIndex: number, strategy: { tierDelta: number, newSession: boolean, reason: string } }}
 */
export function recordReworkEscalation({ roundRecord, currentTierIndex, reworkCount, strategized, tierCount, chainVerdict, chainRepeatedAreas, probesGreen }) {
  const strategy = deriveReworkStrategy({
    reworkCount, strategized,
    verdict: chainVerdict, probesGreen, repeatedAreas: chainRepeatedAreas,
  });
  const { tierIndex, clamped, reason } = applyTierEscalation({
    currentTierIndex,
    tierDelta: strategy.tierDelta,
    tierCount,
  });
  roundRecord.tierClamped = clamped;
  roundRecord.tierClampReason = clamped ? reason : null;
  if (clamped && strategy.tierDelta > 0) {
    // The stored/rendered strategy reason must never claim an escalation
    // that dispatch did not perform (#153④): chain-show prints this string
    // right next to the clamped tier line, and "escalate tier" there reads
    // as a stronger-model re-run.
    strategy.reason = strategy.reason.replace(
      /escalate tier/g,
      `tier unchanged (escalation clamped: ${reason})`,
    );
  }
  return { currentTierIndex: tierIndex, strategy };
}
