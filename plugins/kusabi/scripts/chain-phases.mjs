// chain-phases.mjs — Round lifecycle phases for cmdChain.
//
// Every function in this module receives cross-round state (baseSha,
// strategized, records) as explicit arguments and returns results as
// explicit return values — nothing is captured from an enclosing scope.
//
// Quota classification and recorded-failure / explicit-route helpers
// (classifyDispatchQuotaExhaustion, quotaExhaustionReason, quotaReplacementRefusal,
// recordQuotaExhaustion, explicitRouteDiffersFromRecord) live in
// chain-quota.mjs (kusabi #453).
//
// Chain-wide usage totals, round/chain.json persistence, and review-record.md
// writing (computeChainTotals, persistChainState, writeReviewRecord) live in
// chain-persist.mjs (kusabi #451).
//
// Container-context collection (collectContainerBaseContext,
// CHANGE_SCOPE_CONTAINER_PATH, CHANGE_SCOPE_HOST_PATH, collectChangeScope,
// assertContainerBaseRef, collectContainerReviewInput, collectReviewContext)
// lives in chain-collect.mjs (kusabi #449).
//
// Implement prompt assembly, implement dispatch, and probe orchestration
// (withContainerWorkspace, buildImplementText, runImplementPhase, runProbePhase)
// live in chain-run.mjs (kusabi #447).
//
// Probe functions (runHeadCleanProbe, runVerifyProbe, runDeliverablesProbe,
// runSmokeProbe, runSmokeEntry) live in chain-probes.mjs.
//
// Review functions (runReviewPhase, parseReviewResult, buildReviewRepairPrompt,
// shouldSkipReview, renderProbeReport, renderReviewPriorFindings) live in
// chain-review.mjs (kusabi #435).
//
// Outcome rendering (renderAcceptOutcome, renderAcceptWithFollowupOutcome,
// renderEscalateOutcome, renderRefusalOutcome, renderBriefSyntaxDefectOutcome,
// renderMaxRoundsOutcome, renderProviderExhaustedOutcome, handleProviderExhaustion)
// lives in chain-outcomes.mjs (kusabi #439).
//
// Resume position and replacement review seat resolution (resolveChainResume,
// classifyReviewSeatReplacement, archiveFailedReviewSeat) live in
// chain-resume-resolve.mjs (kusabi #441).


import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  reviewDenyTools,
} from "./cli.mjs";
import {
  renderStrategistPrompt,
  groupFindingsByKind,
} from "./render.mjs";
import { deriveReworkStrategy } from "./disposition.mjs";
// resolveRoundResume is defined below and is the only resume-resolution
// mechanism.  checkpoint_restore was removed in issue #114 — the chain
// never rolls the worktree back.
import { dispatchWithFallback } from "./prompt-execution.mjs";
import {
  buildVerifyBaseline,
} from "./chain-probes.mjs";

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

// =========================================================================
// Setup / initialisation
// =========================================================================

/**
 * Create a new chain directory and return its identity.
 */
export function createChainDir(stateDir) {
  const chainId = `chain-${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
  const chainDir = path.join(stateDir, "chains", chainId);
  fs.mkdirSync(chainDir, { recursive: true });
  return { chainId, chainDir };
}

/**
 * Capture the base SHA from the container at chain start.
 * Returns null on failure (probes will catch it per-round).
 */
export async function captureBaseSha(callTool, container) {
  try {
    const gitRev = await callTool("sandbox_exec", {
      container_id: container,
      commands: ["git rev-parse HEAD"],
    });
    return (gitRev?.output ?? "").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Capture the chain-start verify baseline (kusabi #173).
 *
 * Runs `verify_in_container` ONCE on the pristine base worktree (before the
 * round-1 implement dispatch) and records the base's lint/type violation
 * counts plus the raw verify result.  This is the only moment the base is
 * guaranteed unmodified — chain-resume REUSES the recorded baseline from
 * chain.json and never re-captures on a modified worktree.
 *
 * The returned object is stored on chain.json as `verifyBaseline`:
 *   { captured: true, gate_passed, lint, types, raw }
 * When the RPC call itself fails the capture degrades to
 *   { captured: false, error }
 * — the chain still runs, but P2 falls back to today's strict behaviour
 * (a missing baseline is never invented).
 *
 * Counting authority: the `lint` / `types` arrays of the verify result are
 * complete (one element per violation; verified against live sunaba output),
 * so array length is the authoritative count.  When an array is absent the
 * gate's summary line in `gate_fail_reasons` (e.g. "lint (eslint): 3
 * violation(s)") is the fallback; when neither yields a number the count is
 * null and the probe records the limitation instead of passing blind.
 *
 * @param {Function} callTool
 * @param {string}   container
 * @returns {Promise<object>} Baseline record (see above).
 */
export async function captureVerifyBaseline(callTool, container) {
  try {
    const verifyResult = await callTool("verify_in_container", {
      container_id: container,
      path: ".",
    });
    return buildVerifyBaseline(verifyResult);
  } catch (err) {
    return { captured: false, error: err?.message ?? String(err) };
  }
}

// =========================================================================
// Per-round phases
// =========================================================================

/**
 * Resolve the resume method for a round.
 *
 * This is now a pure synchronous function.  The chain never rolls the
 * worktree back (checkpoint_restore was removed in issue #114).
 * A new session starts fresh on the existing worktree.
 *
 * @param {object}  opts
 * @param {boolean} opts.useNewSession  — whether to start a new session
 * @returns {{ resumeMethod: { type: "continue_session"|"fresh_session" }, useNewSession: boolean }}
 */
export function resolveRoundResume({ useNewSession }) {
  return {
    resumeMethod: {
      type: useNewSession ? "fresh_session" : "continue_session",
    },
    useNewSession,
  };
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
 * Run the strategize sub-phase: build prompt, dispatch strategist job,
 * and update the roundRecord with strategist findings.
 *
 * Uses dispatchWithFallback so capacity fallback applies to the strategist
 * dispatch as well.
 */
export async function runStrategizePhase({ cwd, chainId, round, brief, previousRecord, roundRecord, modelChain, _dispatchWithFallback: _dispatch = dispatchWithFallback } = {}) {
  // Build the strategist prompt from the brief's acceptance criteria and
  // the last two rounds' findings.
  const strategistRounds = [];
  if (previousRecord) {
    strategistRounds.push({ round: previousRecord.round, findingsText: previousRecord.findingsText || "" });
  }
  strategistRounds.push({ round, findingsText: roundRecord.findingsText || "" });

  const strategistPromptText = renderStrategistPrompt({
    brief,
    rounds: strategistRounds,
  });

  const { job: strategistJob, resultText: strategistResultText } = await _dispatch({
    cwd,
    kind: "strategist",
    title: "chain: " + chainId + " round " + round + " strategist",
    promptText: strategistPromptText,
    agent: "kusabi-investigate",
    tools: reviewDenyTools(),
    timeoutS: 1800,
    watchdogS: 900,
    tiers: modelChain,
    // Tier 1, not the round's tier: the strategist runs once per chain and is
    // not part of the quality ladder.  (Before fallback existed this dispatch
    // passed no model at all and took opencode's default.)
    round: 1,
  });

  roundRecord.strategistJobId = strategistJob.id;
  roundRecord.strategistUsage = strategistJob.usage || null;
  roundRecord.strategistModelEntry = strategistJob.modelEntry || null;
  roundRecord.strategistModelVariant = strategistJob.modelVariant || null;
  roundRecord.strategistFallbacks = strategistJob.fallbacks || null;
  roundRecord.strategistRecommendation = (strategistResultText || "").trim() || "(no recommendation)";

  return {
    strategistJobStatus: strategistJob.status,
    strategistJobError: strategistJob.error || null,
    // Structured terminal-failure classification (kusabi #215): null for
    // generic failures; { kind: "quota-exhaustion", ... } when the dispatch
    // classified the terminal payload (see implementJobFailure).
    strategistJobFailure: strategistJob.failure || null,
  };
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
