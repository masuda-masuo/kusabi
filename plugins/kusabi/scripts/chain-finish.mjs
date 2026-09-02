// chain-finish: functions lifted from the runChainDriver nested closure
// (kusabi #422 Job 3).
//
// These functions close over round-loop state.  They receive it via an
// explicit context object (`ctx`) instead of closing over the loop locals.
// The context is owned by the loop in chain-driver.mjs.

import fs from "node:fs";
import path from "node:path";

import { renderFollowupDraft, roundDiscardReason } from "./render.mjs";
import {
  hasSectionHeading,
  parseDeliverables,
  parseFrozenTests,
  parseSmoke,
  briefSyntaxDefectSummary,
} from "./brief-parsing.mjs";
import { classifyRefusalOutcome, verifyRefusalAnchors, refusalRepoPaths } from "./probe-decisions.mjs";
import { deriveDisposition } from "./disposition.mjs";
import { stateRoot, writeJson } from "./state-paths.mjs";
import { countUnfilledReviewRecords } from "./review-record-scan.mjs";
import { finalizeChainControl, updateChainControlRound } from "./chain-control.mjs";
import { runReviewPhase } from "./chain-review.mjs";
import {
  computeChainTotals,
  persistChainState,
  writeReviewRecord,
  runStrategizePhase,
  renderAcceptOutcome,
  renderAcceptWithFollowupOutcome,
  renderEscalateOutcome,
  renderRefusalOutcome,
  renderBriefSyntaxDefectOutcome,
  handleProviderExhaustion,
  recordReworkEscalation,
  quotaExhaustionReason,
} from "./chain-phases.mjs";
import {
  runVerifyProbe,
  runSmokeProbe,
  runDeliverablesProbe,
  runFrozenProbe,
  runCollectedProbe,
  summariseOracleViolations,
} from "./chain-probes.mjs";

/**
 * Write a final review record and append an unfilled-records note.
 *
 * @param {string} text - The outcome text to append the record path to.
 * @param {object} disposition - The disposition object for the record.
 * @param {number} round - The round number.
 * @param {object} ctx - The context object (immutable config + mutable state).
 * @returns {string} The outcome text with the record path appended.
 */
export function finaliseChain(text, disposition, round, ctx) {
  const { chainDir, chainId, container, modelChain, maxRounds, brief, orchestrator, records, cwd } = ctx;
  let recordPath = null;
  let writeError = null;
  try {
    recordPath = writeReviewRecord({
      chainDir, chainId, container, modelChain, maxRounds, brief, orchestrator,
      records, chainTotals: computeChainTotals(records),
      disposition, round,
      label: path.basename(cwd) || null,
    });
  } catch (err) {
    // Best-effort — the outcome text stays intact, but the failure must be
    // observable or renderer defects hide behind a silently absent record.
    writeError = err;
  }
  const baseText = recordPath
    ? text + "\n\n" + "review record: " + recordPath
    : text + "\n\n" + "review record: (write failed: " + (writeError?.message || "unknown error") + " — chain state dir " + chainDir + ")";

  let unfilledNote = "";
  try {
    const unfilled = countUnfilledReviewRecords(stateRoot());
    if (unfilled > 0) {
      unfilledNote = `\nunadjudicated review records: ${unfilled}`;
    }
  } catch {
    // Best-effort — non-fatal scan failure degrades to silence
  }
  return baseText + unfilledNote;
}

// ---- provisional finalisation: write a provisional review record at non-completed exits
// when the predicate holds (records >= 1 and last round has probeResults).
/**
 * Write a provisional review record for non-completed exits.
 *
 * @param {string} text - The outcome text to append the record path to.
 * @param {object|string} disposition - The disposition for the record.
 * @param {number|null} round - The round number.
 * @param {object} ctx - The context object (immutable config + mutable state).
 * @returns {string} The outcome text with the record path appended.
 */
export function finaliseProvisionalChain(text, disposition, round, ctx) {
  const { chainDir, chainId, container, modelChain, maxRounds, brief, orchestrator, records, cwd } = ctx;
  const last = records.length >= 1 ? records[records.length - 1] : null;
  const predicateHolds = Boolean(
    records.length >= 1 &&
    last &&
    Array.isArray(last.probeResults) &&
    last.probeResults.length > 0
  );
  if (!predicateHolds) {
    return text;
  }

  let recordPath = null;
  let writeError = null;
  try {
    const dispObj = typeof disposition === "string" ? { disposition } : (disposition ?? { disposition: "unknown" });
    const recRound = round ?? (last ? last.round : records.length);
    recordPath = writeReviewRecord({
      chainDir, chainId, container, modelChain, maxRounds, brief, orchestrator,
      records, chainTotals: computeChainTotals(records),
      disposition: dispObj, round: recRound,
      label: path.basename(cwd) || null,
      provisional: true,
    });
  } catch (err) {
    writeError = err;
  }
  const baseText = recordPath
    ? text + "\n\n" + "review record: " + recordPath
    : text + "\n\n" + "review record: (write failed: " + (writeError?.message || "unknown error") + " — chain state dir " + chainDir + ")";

  let unfilledNote = "";
  try {
    const unfilled = countUnfilledReviewRecords(stateRoot());
    if (unfilled > 0) {
      unfilledNote = `\nunadjudicated review records: ${unfilled}`;
    }
  } catch {
    // Best-effort — non-fatal scan failure degrades to silence
  }
  return baseText + unfilledNote;
}

// Existence predicate for refusal anchors (kusabi #293, #351):
//   - when `container` is set, finishRound queries the container filesystem
//     at /workspace via `sandbox_exec` (`test -e`);
//   - when `container` is not set (host worktree), `repoPathExists` inspects
//     the host filesystem at `cwd` via `fs.existsSync`.
// `verifyRefusalAnchors` rejects `..` and `.git` paths before asking, so
// the join cannot escape the worktree; a miss is `false`, never a throw.
function repoPathExists(name, cwd) {
  try {
    return fs.existsSync(path.join(cwd, name));
  } catch {
    return false;
  }
}

// P1 in re-validation mode (kusabi #262 follow-up): COMPARE HEAD against the
// recorded baseSha and report red on mismatch — never reset.  Detail strings
// mirror the shared P1 (chain-phases runHeadCleanProbe) so the records read
// alike; the mismatch wording names both SHAs so the operator sees exactly
// what moved.
async function runHeadCompareProbe({ baseSha, callTool, container }) {
  let passed = false;
  let detail = "";
  if (baseSha) {
    const gitRev = await callTool("sandbox_exec", {
      container_id: container,
      commands: ["git rev-parse HEAD"],
    });
    const headSha = (gitRev?.output ?? "").trim();
    if (headSha !== baseSha) {
      detail = "HEAD " + headSha + " != base " + baseSha + " (compare-only)";
    } else {
      passed = true;
      detail = "HEAD matches base " + baseSha;
    }
  } else {
    detail = "baseSha not recorded at chain start; cannot check HEAD";
  }
  return { probe: "P1: HEAD clean", passed, detail };
}

// Re-validation probe phase (kusabi #262): a review-resumed round's accept
// re-measures the RECORDED probe truth on the current worktree before
// finalising.  This phase is deliberately NOT runProbePhase: that phase's P1
// auto-resets a moved HEAD (`git reset --mixed <baseSha>`) — the right
// fix-up for a round whose own implement moved the worktree, but a MUTATION
// of the very state this re-run exists to measure (kusabi #262 follow-up).
// A measurement must not change what it measures: the operator must find
// the worktree exactly as it was, and the red P1 alone must carry the
// verdict.  P2–P6 are the shared probes; the assembly mirrors
// runProbePhase's so the two phases cannot drift.
//
// P5/P6 (kusabi #197) ARE re-run here (kusabi #197 follow-up).  The recorded
// marker only covers violations measured BEFORE the stop/escalate, and this
// phase exists precisely because the worktree can move in the gap — P5's
// subject (the change set) and P6's subject (the collected count) are exactly
// the truths that move.  A frozen-path edit landed in the gap is invisible to
// P1–P4 (HEAD unchanged → P1 green, tests still pass → P2 green), so an accept
// could finalise with no violation recorded at all.  Detection must never
// depend on per-round attention (kusabi #197), so the fresh marker — derived
// from the FRESH results, not the recorded one — is what finishRound re-derives
// the disposition with.
async function runRevalidationProbePhase({ baseSha, container, brief, callTool, verifyBaseline }) {
  const probeResults = [];
  let worktreeChanged = null;
  try {
    probeResults.push(await runHeadCompareProbe({ baseSha, callTool, container }));

    // P2 keeps the chain-start verify baseline (kusabi #173): re-capturing
    // it here would measure the round's own changes as the baseline.
    const p2Result = await runVerifyProbe({ callTool, container, baseline: verifyBaseline });
    probeResults.push(p2Result);

    const p3Result = await runDeliverablesProbe({
      deliverables: parseDeliverables(brief),
      headingPresent: hasSectionHeading(brief, "Deliverables"),
      callTool,
      container,
      // null for the same reason the recorded run passes null: the resumed
      // round's changes ARE the subject, and a baseline captured at resume
      // time would measure them as "changed".  No baseline means P3 cannot
      // measure worktreeChanged; the caller preserves the recorded value
      // instead of overwriting it with null.
      baseline: null,
    });
    worktreeChanged = p3Result.worktreeChanged;
    probeResults.push(p3Result);

    probeResults.push(await runSmokeProbe({
      entries: parseSmoke(brief),
      callTool,
      container,
      headingPresent: hasSectionHeading(brief, "Smoke"),
    }));

    // ---- P5: frozen (kusabi #197) ----
    // The same probe function and the same fallback rule as the normal round
    // (runProbePhase): the fresh change set is this run's newly-changed paths,
    // falling back to the full changed set when the comparison could not be
    // made.  Here that fallback is the ONLY case — P3 above runs with no
    // worktree baseline (the resumed round's changes ARE the subject), so
    // `newlyChangedPaths` is null and P5 is evaluated against the full set.
    // No second collection: there is one change-collection mechanism.
    probeResults.push(runFrozenProbe({
      frozen: parseFrozenTests(brief),
      headingPresent: hasSectionHeading(brief, "Frozen Tests"),
      changedPaths: p3Result.newlyChangedPaths ?? p3Result.changedPaths,
    }));

    // ---- P6: collected (kusabi #197) ----
    // Reads the FRESH P2's count against the chain-start baseline recorded on
    // chain.json — never a re-captured one (kusabi #173), so the resumed round
    // is compared against the same base as round 1.  Null-tolerant on either
    // side, exactly as in the round: an unknown is not a decrease.
    probeResults.push(runCollectedProbe({
      collected: p2Result.collected ?? null,
      baselineCollected: verifyBaseline?.captured === true
        ? (verifyBaseline.collected ?? null)
        : null,
    }));
  } catch (probeErr) {
    probeResults.push({ probe: "sunaba-rpc", passed: false, detail: String(probeErr) });
  }
  return {
    probesGreen: probeResults.every(function (p) { return p.passed; }),
    probeResults,
    worktreeChanged,
    // Measured on the CURRENT worktree, so it supersedes the recorded marker
    // in the re-derivation (kusabi #197 follow-up).  A probe-phase exception
    // is not a violation — only a P5/P6 result that actually fired sets this,
    // exactly as in runProbePhase.
    oracleViolation: summariseOracleViolations(probeResults),
  };
}

/**
 * Run the review, disposition, record-keeping, and termination logic for
 * one round of the chain.
 *
 * @param {object} args - Round-specific arguments (already explicit).
 * @param {number} args.round
 * @param {object} args.roundRecord
 * @param {object|null} args.previousRecord
 * @param {object} args.probeCtx
 * @param {object|null} args.implementRefusal
 * @param {object} args.reworkScope
 * @param {object} ctx - Context object owned by the loop in chain-driver.mjs.
 *   Immutable config (chainDir, chainId, container, cwd, model, modelChain,
 *   maxRounds, brief, orchestrator, callTool, flagsModel, reviewFlagsModel,
 *   effectiveReviewChain, effectiveReworkChain, effectiveReworkBackend,
 *   effectiveBaseSha, effectiveVerifyBaseline, reviewModel, reviewModelChain,
 *   reworkModel, reworkModelChain, reworkBackend, reviewDispatch,
 *   injectedDispatch, reworkTierCount) plus mutable cross-round state
 *   (records, strategized, reworkCount, currentTierIndex).
 * @returns {Promise<{done: boolean, text?: string}>}
 */
export async function finishRound(
  { round, roundRecord, previousRecord, probeCtx, implementRefusal = null, reworkScope },
  ctx,
) {
  const {
    chainDir, chainId, container, cwd, model, modelChain, maxRounds, brief, orchestrator, callTool,
    flagsModel, reviewFlagsModel, effectiveReviewChain,
    effectiveBaseSha, effectiveVerifyBaseline, reviewModel, reviewModelChain,
    reworkModel, reworkModelChain, reworkBackend, reviewDispatch, injectedDispatch,
    reworkTierCount,
    // Mutable cross-round state
    records, strategized, reworkCount, currentTierIndex,
  } = ctx;

  const {
    chainChangedPaths, chainNewlyChanged, chainStatusObserved,
    chainStatusOutput, chainBaseLog, chainDeliverables, chainUntracked, chainTruncation,
    changeScope,
  } = probeCtx;
  // NOT const: an accept finalising on RECORDED probe truth re-measures it
  // first (kusabi #262), and everything downstream of the disposition —
  // the re-derivation itself, recordReworkEscalation's evidence — must see
  // the fresh value, never the recorded one.
  let probesGreen = probeCtx.probesGreen;

  // ---- phase 5: review (or skip when change set empty) ----
  // Single conduit (kusabi #100): runReviewPhase writes everything that
  // belongs on the record onto roundRecord and returns only what is not
  // record state; the values the disposition phase needs that ARE record
  // state (verdict, findingsText) are read back from roundRecord here.
  const {
    chainParsedReview, chainRepeatedAreas, skipReview,
    reviewJobStatus, reviewJobError,
  } = await runReviewPhase({
    container, brief, modelChain: effectiveReviewChain, chainId, cwd, previousRecord, baseSha: effectiveBaseSha,
    chainStatusOutput, chainBaseLog, chainUntracked, chainTruncation, roundRecord,
    chainChangedPaths, chainNewlyChanged, chainStatusObserved, chainDeliverables,
    flagsModel: reviewFlagsModel ?? flagsModel, _dispatchWithFallback: reviewDispatch,
    // The round's resolved scope (kusabi #334), carried from the driver's
    // single decision point — the same value buildImplementText already
    // receives — so the review prompt and the repeated-areas signal are
    // derived from the SAME decision, never from a second copy of the
    // branch table.  runReviewPhase falls back to resolveReworkScope on
    // the same previousRecord when this is absent (review-resume callers
    // without a fresh scopeResolution, older callers).
    reworkScope,
    changeScope: changeScope ?? roundRecord.changeScope ?? null,
  });
  // ---- phase 5b: qualifying refusal (kusabi #293) ----
  // `skipReview` is the empty-change-set signal the discard has always been
  // decided on, so routing here can only ever DIVIDE that population —
  // a round that changed files takes the same path it did before, and an
  // empty round whose report carries no qualifying block still discards
  // byte for byte.
  //
  // The parse is shape-only; the NAMED items must exist before the block
  // may qualify (phase-chain.md §3.5.4a): a brief-section anchor must be a
  // heading the brief really has, and a repo-path anchor must be a file or
  // directory the worktree really contains — a forged `src/nonexistent.mjs`
  // or an invented heading counts as unnamed, disqualifying unless two real
  // items remain.  Both inputs are in scope here: the chain's own brief
  // text, and the worktree at `cwd`.  The fresh path and the review-resume
  // path (which also lands here, descriptor read back off the record)
  // therefore derive the same verdict.  The verified descriptor replaces
  // the parse-time stamp on the record, so the record never keeps a
  // shape-only verdict that classification has already rejected.
  let refusalPathExists = (name) => repoPathExists(name, cwd);
  let containerCheckWarning = null;

  if (implementRefusal && container) {
    const repoPaths = refusalRepoPaths(implementRefusal);
    if (repoPaths.length > 0) {
      const cmdParts = repoPaths.map((p) => {
        const q = "'" + p.replace(/'/g, "'\\''") + "'";
        return `test -e ${q} && echo 'OK ${p.replace(/'/g, "'\\''")}' || echo 'NO ${p.replace(/'/g, "'\\''")}'`;
      });
      const command = cmdParts.join(" && ");
      try {
        const execRes = await callTool("sandbox_exec", {
          container_id: container,
          commands: [command],
        });
        const output = execRes?.output;
        if (typeof output !== "string") {
          containerCheckWarning = "container path existence check failed: unparseable sandbox_exec output";
          refusalPathExists = () => false;
        } else {
          const okSet = new Set();
          for (const line of output.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (trimmed.startsWith("OK ")) {
              okSet.add(trimmed.slice(3).trim());
            }
          }
          refusalPathExists = (p) => okSet.has(p);
        }
      } catch (err) {
        containerCheckWarning = "container path existence check failed: " + (err?.message || String(err));
        refusalPathExists = () => false;
      }
    }
  }

  let verifiedRefusal = implementRefusal
    ? verifyRefusalAnchors(implementRefusal, {
        brief,
        pathExists: refusalPathExists,
      })
    : null;

  if (containerCheckWarning && verifiedRefusal) {
    verifiedRefusal = {
      ...verifiedRefusal,
      qualifies: false,
      disqualification: verifiedRefusal.disqualification
        ? verifiedRefusal.disqualification + "; " + containerCheckWarning
        : containerCheckWarning,
    };
    roundRecord.warnings = Array.isArray(roundRecord.warnings)
      ? [...roundRecord.warnings, containerCheckWarning]
      : [containerCheckWarning];
  }
  if (implementRefusal) roundRecord.implementRefusal = verifiedRefusal;
  const refusalOutcome = classifyRefusalOutcome({
    changeSetEmpty: skipReview,
    refusal: verifiedRefusal,
  });
  if (refusalOutcome.outcome === "refusal") {
    // The round's outcome is a refusal, NOT a discard: seat metrics count
    // `verdict`, and leaving `discard` there would charge the worker for
    // reading the brief correctly — the pressure this whole path exists to
    // remove.  `verdictSource` stays "probe" (no reviewer decided this).
    roundRecord.roundOutcome = "refusal";
    roundRecord.refusal = refusalOutcome.refusal;
    roundRecord.verdict = "refusal";
    roundRecord.verdictSource = "probe";
    roundRecord.findingsText = "(no review — the worker refused the brief as self-contradictory)";
  } else if (refusalOutcome.strayRefusal) {
    // The worker wrote a refusal block AND edited files.  That is not a
    // refusal, so nothing about the routing changes — but the
    // inconsistency is the orchestrator's to see, not the record's to
    // swallow.
    roundRecord.strayRefusalBlock = {
      anchors: refusalOutcome.strayRefusal.anchors,
      why: refusalOutcome.strayRefusal.why,
      note: refusalOutcome.detail,
    };
  } else if (refusalOutcome.detail) {
    // Empty round, refusal ATTEMPTED but the block did not qualify.  The
    // routing is the pre-existing discard; recording why it fell short
    // keeps the orchestrator from reading the round as a lazy empty one.
    roundRecord.refusalRejected = refusalOutcome.detail;
  }

  // ---- phase 5c: brief-syntax defect (kusabi #303) ----
  // A zero-entry `## Deliverables` / `## Smoke` / `## Frozen Tests` section
  // fails P3/P4/P5 on syntax, and the input those probes read is the BRIEF
  // — the worker cannot edit it, so no rework is winnable and the chain
  // must terminate at the FIRST occurrence rather than spend the budget on
  // reworks that cannot succeed (the chain-msvwhslx6e60 incident).
  //
  // Derived from the brief text with the probes' own parsers, not from the
  // probe results: heading-present-and-zero-entries is exactly the
  // condition those probes fail on, so the two cannot disagree, and the
  // value is identical on every path that reaches here — a fresh round, a
  // review-resume reading recorded probe truth, and the accept
  // re-validation (kusabi #262), which re-measures the worktree but never
  // the brief.
  //
  // The dispatch-time lint (kusabi #302) refuses these briefs before a
  // chain exists, using the same parsers; this row is defense in depth for
  // a chain that started before the lint or bypassed it.
  const briefSyntaxDefect = briefSyntaxDefectSummary(brief);
  if (briefSyntaxDefect) {
    roundRecord.briefSyntaxDefect = briefSyntaxDefect;
    // The round's outcome names WHOSE defect this is.  `verdict` is left as
    // measured — it is a true statement about the work the round did, and
    // the attribution lives here and in the disposition reason.  A worker
    // refusal is the more specific statement and keeps its own outcome.
    if (roundRecord.roundOutcome !== "refusal") {
      roundRecord.roundOutcome = "brief-syntax-defect";
    }
  }

  const chainVerdict = roundRecord.verdict;
  const chainFindingsText = roundRecord.findingsText;
  // ---- stop on review provider exhaustion ----
  if (reviewJobStatus === "provider-error") {
    const { chainState, outcome } = handleProviderExhaustion({
      records, roundRecord,
      currentTierIndex, phase: "review", jobError: reviewJobError,
      jobFailure: roundRecord.reviewJobFailure || null,
      chainId, round, container, model, modelChain,
      reviewModel, reviewModelChain,
      reworkModel, reworkModelChain, reworkBackend,
      maxRounds, brief, orchestrator, baseSha: effectiveBaseSha,
      strategized, chainFollowupDraft: null,
      verifyBaseline: effectiveVerifyBaseline,
    });
    writeJson(path.join(chainDir, "round-" + round + ".json"), roundRecord);
    writeJson(path.join(chainDir, "chain.json"), chainState);
    finalizeChainControl({ chainDir, status: "failed", round });
    return { done: true, text: finaliseProvisionalChain(outcome, "failed", round, ctx) };
  }

  // ---- phase 6: derive disposition ----
  // Malformed-review guard (kusabi #153): `findings` may be a non-array.
  const findingSeverities = Array.isArray(chainParsedReview?.findings)
    ? chainParsedReview.findings.map(function (f) { return f.severity; })
    : undefined;

  // Budget-adjusted round (kusabi #60 step 2): maxRounds buys design/full
  // rounds only; mechanical rounds are free.  The `round` handed to
  // deriveDisposition is the current round's ordinal WITHIN the budget (a
  // mechanical round does not advance it), so the `round >= maxRounds`
  // terminal fires on budget, not raw round count.  The count comes from
  // the records alone (budget is never persisted); a review-resumed round
  // is already in `records`, so it is excluded before counting.
  const budgetUsedBefore = records.filter(function (r) {
    return r !== roundRecord && r.reworkScope !== "mechanical";
  }).length;
  const budgetRound = budgetUsedBefore + (roundRecord.reworkScope !== "mechanical" ? 1 : 0);

  // The derivation is a closure because it runs twice on the re-validation
  // path below (kusabi #262): once on the truth this round arrived with,
  // once on the truth re-measured for an accept.  Every input except the
  // two the probes measure — probesGreen and the oracle marker — is
  // identical between the two calls, so they cannot drift.
  //
  // The P5/P6 oracle marker (kusabi #197) is probe truth like probesGreen,
  // so it moves with it: the recorded marker decides the first derivation,
  // and the one re-measured on the current worktree decides the second
  // (kusabi #197 follow-up).  A frozen-path edit or a collected-count drop
  // that landed AFTER the stop/escalate is invisible to the recorded marker
  // — it is exactly what the re-validation exists to catch.
  const recordedOracleViolation = probeCtx.oracleViolation ?? false;
  const deriveWith = function (green, oracleViolation) {
    return deriveDisposition({
      verdict: chainVerdict || "needs-attention",
      probesGreen: green,
      round: budgetRound,
      maxRounds,
      repeatedAreas: chainRepeatedAreas,
      findingSeverities,
      strategizeEligible: !strategized,
      oracleViolation,
      // A qualifying refusal (kusabi #293) is fixed for the round: it is
      // measured from the change set and the report, neither of which the
      // re-validation below re-measures, so both derivations see the same
      // value.  The named items travel in the string so the terminal line
      // carries them.
      refusal: refusalOutcome.outcome === "refusal" ? refusalOutcome.detail : null,
      // Fixed for the round for the same reason (kusabi #303): it is a
      // function of the brief alone, and the re-validation below re-measures
      // the worktree, never the brief.
      briefSyntaxDefect,
      partialDiagnosis: roundRecord.reviewPartialDiagnosis ?? chainParsedReview?.partialDiagnosis,
    });
  };
  let disposition = deriveWith(probesGreen, recordedOracleViolation);

  // ---- lazy re-validation of RECORDED probe truth (kusabi #262) ----
  // A review-resumed round (the #153 interrupted round, or the #248
  // replacement review seat) carries probe truth measured BEFORE the
  // stop/escalate.  The container worktree can have moved since then
  // (operator hand-edits, another job, a partial restore), so an accept
  // derived from that record would finalise on an estimate while the
  // authoritative check is one probe run away.  Re-measure and re-derive.
  //
  // Only the accept family triggers it, deliberately: a rework buys a next
  // round whose own probes re-measure everything anyway, so re-running here
  // would pay for truth that round produces regardless.  Only an accept
  // CONSUMES the recorded truth, so only an accept must re-measure it.
  //
  // At most once per round: `probesRevalidated` is the guard, so a
  // re-derived rework/strategize cannot re-trigger it.  Non-resumed rounds
  // never set `probesFromRecord` and are untouched — their probe truth was
  // measured in-round, minutes ago, on this worktree.
  if (
    probeCtx.probesFromRecord
    && !roundRecord.probesRevalidated
    && (disposition.disposition === "accept" || disposition.disposition === "accept-with-followup")
  ) {
    const fresh = await runRevalidationProbePhase({
      baseSha: effectiveBaseSha, container, brief, callTool,
      verifyBaseline: effectiveVerifyBaseline,
    });
    // Preserve the recorded truth the way #248 preserves a dead seat: the
    // record must keep saying "recorded green, then re-validated", never
    // silently swap one measurement for the other.
    roundRecord.probesRevalidated = {
      reason: "accept finalisation after a review-resume (kusabi #262)",
      at: new Date().toISOString(),
      recordedDisposition: disposition,
      probesGreen,
      probeResults: roundRecord.probeResults ?? null,
      worktreeChanged: roundRecord.worktreeChanged ?? null,
      // The recorded P5/P6 marker is preserved for the same reason as the
      // recorded probe results (kusabi #197 follow-up): the live field now
      // carries the freshly measured one.
      oracleViolation: recordedOracleViolation,
    };
    probesGreen = fresh.probesGreen;
    roundRecord.probesGreen = fresh.probesGreen;
    roundRecord.probeResults = fresh.probeResults;
    // The live marker is the fresh measurement, so a later reader (a second
    // review-resume of this round) reads what the current worktree said.
    roundRecord.oracleViolation = fresh.oracleViolation;
    // Overwrite a live record field only with an actually measured value.
    // This run carries no worktree baseline (see runRevalidationProbePhase),
    // so P3 cannot measure worktreeChanged — it is null.  A recorded true
    // must stay true, not degrade to unknown (kusabi #262 follow-up).
    if (fresh.worktreeChanged !== null && fresh.worktreeChanged !== undefined) {
      roundRecord.worktreeChanged = fresh.worktreeChanged;
    }
    // Fresh green → the accept stands unchanged.  Fresh red → this is the
    // disposition of a round with red probes, exactly as a normal round
    // would derive it; the accept never finalises.  A fresh P5/P6 violation
    // escalates the resumed round the same way it escalates a normal one
    // (kusabi #197 follow-up), so the marker handed over is the fresh one.
    disposition = deriveWith(probesGreen, fresh.oracleViolation);
  }
  if (roundRecord.reviewJobFailure?.kind === "quota-exhaustion") {
    disposition = {
      disposition: "escalate",
      reason: quotaExhaustionReason(roundRecord.reviewJobFailure),
    };
  }
  roundRecord.disposition = disposition;

  // ---- phase 7: record keeping + persistence ----
  // Idempotent push: a review-resumed round is already in `records` (its
  // partial state was persisted at stop time).
  if (!records.includes(roundRecord)) records.push(roundRecord);

  // Compute totals across all rounds so far
  const chainTotals = computeChainTotals(records);

  // When review was skipped, ensure findingsText is set
  if (skipReview && !roundRecord.findingsText) {
    roundRecord.findingsText = "(no review — change set was empty)";
  }

  // Followup draft for accept-with-followup
  let chainFollowupDraft = null;
  if (disposition.disposition === "accept-with-followup" && chainParsedReview?.findings) {
    const briefTitle = brief ? brief.split("\n")[0].trim() : "";
    chainFollowupDraft = renderFollowupDraft({
      chainId,
      briefTitle,
      findings: chainParsedReview.findings,
    });
    roundRecord.followupIssueDraft = chainFollowupDraft;
  }

  // ---- Compute rework strategy for the NEXT round (if rework needed) ----
  let pendingReworkStrategy = null;
  if (disposition.disposition === "rework") {
    // Tier escalation is clamped to the modelChain range (kusabi #153):
    // selectRoutes already keeps dispatch at the top tier, so the
    // recorded tier must match the model actually used — never "0 → 1"
    // on a single-tier chain.  The clamp fields (tierClamped /
    // tierClampReason) land on the round record here.
    // The tier ladder climbs over the chain the NEXT round dispatches on
    // (kusabi #192 axis 2): a rework round addresses the REWORK chain, so
    // the escalation clamps against its tier count — the implement chain's
    // count when no rework chain is configured (unchanged behaviour).
    // The count is backend-aware (kusabi #192 follow-up): a claude-native
    // ladder has an effective tier count of min(1, length), so tierAfter
    // can never exceed 0 on a claude ladder — the model never changes
    // there, and a recorded 0 → 1 would contradict the pinned model.
    const escalation = recordReworkEscalation({
      roundRecord,
      currentTierIndex,
      reworkCount,
      strategized,
      tierCount: reworkTierCount,
      // Anchoring-override evidence (#62): verdict, probes and the
      // cross-round repeated-areas signal from the finished round.
      chainVerdict,
      chainRepeatedAreas,
      probesGreen,
    });

    // Update cross-round state for the next iteration
    pendingReworkStrategy = escalation.strategy;
    ctx.reworkCount += 1;
    ctx.currentTierIndex = escalation.currentTierIndex;
  } else if (disposition.disposition === "strategize") {
    // Strategize doesn't consume a rework count, but it sets strategized=true
    // which affects the next rework strategy.
  }

  // Record the pending rework strategy on the round record so the next
  // round can read it, and so chain-show can display what levers were pulled.
  roundRecord.pendingReworkStrategy = pendingReworkStrategy;
  roundRecord.tierAfter = ctx.currentTierIndex;

  persistChainState({
    chainDir, round, roundRecord, chainId, container, model, modelChain,
    reviewModel, reviewModelChain,
    reworkModel, reworkModelChain, reworkBackend,
    maxRounds, brief, orchestrator, records, baseSha: effectiveBaseSha,
    chainTotals, strategized: ctx.strategized, chainFollowupDraft,
    verifyBaseline: effectiveVerifyBaseline,
  });

  // Update the chain control round counter
  updateChainControlRound({ chainDir, round });

  // ---- phase 8: disposition handling ----
  // A qualifying refusal is terminal and lands in the orchestrator's hands
  // (kusabi #293).  `completed` like every other decided chain: the chain
  // ran correctly and produced a decision — what is defective is the
  // brief, which the outcome text says in as many words.
  if (disposition.disposition === "refused-brief-defect") {
    finalizeChainControl({ chainDir, status: "completed", round });
    // Two ways into this terminal, and they hand over different evidence:
    // the worker named the contradiction itself (kusabi #293), or a probe
    // could not read a brief section (kusabi #303).  The renderer follows
    // the round's own outcome, which phases 5b/5c stamped — a worker
    // refusal is the more specific statement and wins when both hold.
    const refusalRendered = roundRecord.roundOutcome === "refusal"
      ? renderRefusalOutcome({ chainId, round, disposition, orchestrator, roundRecord, records })
      : renderBriefSyntaxDefectOutcome({ chainId, round, disposition, orchestrator, roundRecord, records });
    return { done: true, text: finaliseChain(
      refusalRendered,
      { disposition: "refused-brief-defect", round, reason: disposition.reason || null },
      round,
      ctx,
    ) };
  }

  if (disposition.disposition === "accept") {
    finalizeChainControl({ chainDir, status: "completed", round });
    return { done: true, text: finaliseChain(
      renderAcceptOutcome({ chainId, round, chainParsedReview, chainFindingsText }),
      { disposition: "accepted", round },
      round,
      ctx,
    ) };
  }

  if (disposition.disposition === "accept-with-followup") {
    finalizeChainControl({ chainDir, status: "completed", round });
    return { done: true, text: finaliseChain(
      renderAcceptWithFollowupOutcome({ chainId, round, chainParsedReview, chainFindingsText, chainFollowupDraft, brief }),
      { disposition: "accepted-with-followup", round },
      round,
      ctx,
    ) };
  }

  if (disposition.disposition === "escalate") {
    finalizeChainControl({ chainDir, status: "completed", round });
    return { done: true, text: finaliseChain(
      renderEscalateOutcome({ chainId, round, disposition, orchestrator, roundRecord, records }),
      // The persisted final record's reason must not read "reviewer
      // discarded the work" for a round no reviewer ever saw (kusabi #299):
      // a probe-sourced discard substitutes the probe wording, exactly as
      // the outcome text does.  Reviewer-verdict discards keep the recorded
      // reason.  roundDiscardReason owns the condition.
      { disposition: "escalated", round, reason: roundDiscardReason(roundRecord, disposition.reason || null) },
      round,
      ctx,
    ) };
  }

  // ---- phase 9: strategize (structural re-diagnosis before next rework) ----
  if (disposition.disposition === "strategize") {
    const { strategistJobStatus, strategistJobError, strategistJobFailure } = await runStrategizePhase({
      cwd, chainId, round, brief, previousRecord, roundRecord, modelChain,
      _dispatchWithFallback: injectedDispatch,
    });

    // ---- stop on strategize provider exhaustion ----
    if (strategistJobStatus === "provider-error") {
      // roundRecord was already pushed onto records during phase 7;
      // handleProviderExhaustion detects that and does not push again.
      const { chainState, outcome } = handleProviderExhaustion({
        records, roundRecord,
        currentTierIndex: ctx.currentTierIndex, phase: "strategize", jobError: strategistJobError,
        jobFailure: strategistJobFailure,
        chainId, round, container, model, modelChain,
        reviewModel, reviewModelChain,
        reworkModel, reworkModelChain, reworkBackend,
        maxRounds, brief, orchestrator, baseSha: effectiveBaseSha,
        strategized: ctx.strategized, chainFollowupDraft,
        verifyBaseline: effectiveVerifyBaseline,
      });
      writeJson(path.join(chainDir, "round-" + round + ".json"), roundRecord);
      writeJson(path.join(chainDir, "chain.json"), chainState);
      finalizeChainControl({ chainDir, status: "failed", round });
      return { done: true, text: finaliseProvisionalChain(outcome, "failed", round, ctx) };
    }

    ctx.strategized = true;

    // The next round must use a fresh session to break anchoring
    // (docs/design/phase-chain.md §3.4).
    // Set a pendingReworkStrategy so the loop picks it up at phase 1.
    roundRecord.pendingReworkStrategy = {
      tierDelta: 0,
      newSession: true,
      reason: "strategized: new session (anchoring break per docs/design/phase-chain.md §3.4)",
    };

    // Re-persist after strategize updates roundRecord and strategized flag
    const updatedTotals = computeChainTotals(records);
    persistChainState({
      chainDir, round, roundRecord, chainId, container, model, modelChain,
      reviewModel, reviewModelChain,
      reworkModel, reworkModelChain, reworkBackend,
      maxRounds, brief, orchestrator, records, baseSha: effectiveBaseSha,
      chainTotals: updatedTotals, strategized: true, chainFollowupDraft,
      verifyBaseline: effectiveVerifyBaseline,
    });
  }
  return { done: false };
}
