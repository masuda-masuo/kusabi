// chain-driver: the round loop shared by `chain` and `chain-resume`
// (kusabi #153①, #422).
//
// Extracted from kusabi-companion.mjs unchanged (kusabi #264 PR 2/2): same
// output strings, same exit codes, same persisted records.  The companion
// keeps only the CLI dispatch for these two subcommands; the small read-only
// chain commands (chain-cancel / chain-show / chain-stats) stayed there.
//
// The `chain` and `chain-resume` command surfaces (cmdChain, cmdChainResume,
// renderChainBanner, sessionProvenanceRefusal, defaultReviewResolution,
// resolveQuotaReviewReroute) moved to chain-cmd.mjs (kusabi #422 Job 2).
// That module imports from both kusabi-companion.mjs and this module; this
// module does NOT import from chain-cmd.mjs.
//
// IMPORT DIRECTION.  This module imports from kusabi-companion.mjs for
// backendDispatch / backendPinsModel / phaseDispatchFor / liveRunningJobs /
// cmdServeStop -- helpers used by the round loop and the driver section.
// The companion cycle (companion <-> chain-cmd) is documented in chain-cmd.mjs.
//
// The backend table (backendDispatch / backendPinsModel / phaseDispatchFor) is
// imported from the companion rather than moved, even though only this module
// calls it today.  It is one cohesive row-per-backend table together with
// resolveBackend / resolveDispatchBackend / assertSessionBackendCompatible,
// which must stay behind for `task` and `review`; splitting three rows out of
// it would leave the table describing backends in two files.

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
import {
  shouldStopNow,
  updateChainControlRound,
  finalizeChainControl,
} from "./chain-control.mjs";
import { dispatchWithFallback } from "./prompt-execution.mjs";
import { deriveStopReason } from "./stop-reason.mjs";
import {
  captureBaseSha,
  resolveRoundResume,
  buildImplementText,
  resolveReworkScope,
  runImplementPhase,
  runProbePhase,
  runReviewPhase,
  computeChainTotals,
  persistChainState,
  writeReviewRecord,
  runStrategizePhase,
  renderAcceptOutcome,
  renderAcceptWithFollowupOutcome,
  renderEscalateOutcome,
  renderRefusalOutcome,
  renderBriefSyntaxDefectOutcome,
  renderMaxRoundsOutcome,
  handleProviderExhaustion,
  recordReworkEscalation,
  shouldSkipReview,
  archiveFailedReviewSeat,
  collectReviewContext,
  quotaExhaustionReason,
  runSmokeProbe,
  runVerifyProbe,
  runDeliverablesProbe,
  runFrozenProbe,
  runCollectedProbe,
  summariseOracleViolations,
} from "./chain-phases.mjs";
import { captureWorktreeState } from "./worktree-baseline.mjs";

// The companion side of the round loop's import needs.
import {
  backendDispatch,
  backendPinsModel,
  phaseDispatchFor,
  liveRunningJobs,
  cmdServeStop,
} from "./kusabi-companion.mjs";

// ---------------------------------------------------------------------------
// chain
// ---------------------------------------------------------------------------

// Ladder accounting is backend-aware (kusabi #192 follow-up): a chain on a
// model-pinning backend never walks its tiers — that backend's dispatch pins
// every phase to the command-start model — so everywhere a tier count feeds
// ACCOUNTING (the chain-start banner, the recordReworkEscalation clamp) such
// a chain has an effective tier count of min(1, length).  Dispatch behaviour
// is untouched; this only makes printed/recorded numbers match the ladder the
// backend actually climbs.  opencode chains keep their full length.  Keyed on
// `backendPinsModel`, so the agy backend (kusabi #199 — also one model per
// phase) reports its real ladder without a second branch here.
export function effectiveTierCount(chain, backend) {
  if (!chain) return 0;
  if (backendPinsModel(backend)) return Math.min(1, chain.length);
  return chain.length;
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

/**
 * The chain-start refusal for a `--session` whose provenance cannot be
 * established on the agy backend (kusabi #321), or null when the chain may
 * proceed.
 *
 * A REFUSAL, not a note, and a property-shaped gate, not a flag-shaped one:
 * it fires on "this id's provenance is not provably agy", never on "the
 * operator typed --session".  The provenance is computed at command start,
 * where the job store is in hand: the owner record of the session names its
 * backend, and no owner means the id's provenance is unknown.  Without this
 * gate an unprovable id sailed through the whole of setup — chain
 * directory, verify baseline, smoke baseline, container work — and only
 * then failed inside agyDispatch, leaving a chain record that cannot be
 * resumed: the expensive half ran first, and the thing it was waiting to
 * discover was knowable before any of it started.
 *
 * The property shape needs no flag-shaped branch: an id the caller
 * resolved FROM the job store arrives with its owner record and is
 * provable by construction, so the gate never fires on it — no special case
 * and no exemption exist.  An id whose owner record names a DIFFERENT
 * backend is the same class of problem as an id with no owner at all: it is
 * the operator's input, it is knowable now, and running the chain cannot
 * make it correct — both refuse here.  The module-level backstop in
 * agy-dispatch.mjs (assertNoAgySession) stays exactly as it is; this is the
 * early, friendly refusal in front of it, not a replacement.
 *
 * @param {object} opts
 * @param {string|null|undefined} [opts.session] — the --session flag value.
 * @param {"opencode"|"claude"|"agy"|null|undefined} [opts.provenance] — the
 *        backend the job store established as the session's owner, or null
 *        when no owner record exists.
 * @param {"opencode"|"claude"|"agy"} opts.implementBackend — the resolved
 *        implement backend of the chain about to start.
 * @returns {string|null}
 */

// ---------------------------------------------------------------------------
// chain driver — shared by `chain` and `chain-resume` (kusabi #153①)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// chain driver — shared by `chain` and `chain-resume` (kusabi #153①)
// ---------------------------------------------------------------------------

/**
 * Resolve the review phase's dispatch for runChainDriver.
 *
 * An explicit `injectedReviewDispatch` wins.  Otherwise the implement
 * dispatch is reused ONLY when the review backend equals the implement
 * backend — the pre-#192 single-dispatch contract (one dispatch threaded
 * through every phase).  Under per-phase mixing the implement dispatch
 * belongs to the OTHER backend, so reusing it for review would silently run
 * the review job on the wrong backend while the round record claims
 * `reviewBackend` — the chain-resume bug this resolves (kusabi #192):
 * cmdChainResume used to pass an undefined review seam for an opencode
 * review, and the driver fell back to the claude implement dispatch.  The
 * fallback for a differing backend is the CANONICAL dispatch of the review
 * backend (`backendDispatch`), so a review routed to any backend — including
 * the agy one (kusabi #199) — reaches that backend's own dispatch.
 *
 * @param {object} opts
 * @param {Function|null|undefined} [opts.injectedReviewDispatch] — explicit
 *        review seam (always given by cmdChain; cmdChainResume passes one
 *        too, so this fallback mainly serves legacy single-dispatch callers).
 * @param {Function} [opts.injectedDispatch] — the implement dispatch.
 * @param {"opencode"|"claude"|"agy"} opts.backend — implement backend.
 * @param {"opencode"|"claude"|"agy"} opts.reviewBackend — review backend.
 * @returns {Function} The dispatch the review phase will use.
 */
export function resolveReviewDispatch({ injectedReviewDispatch, injectedDispatch, backend, reviewBackend }) {
  if (injectedReviewDispatch) return injectedReviewDispatch;
  if (reviewBackend === backend) return injectedDispatch ?? dispatchWithFallback;
  return backendDispatch(reviewBackend);
}

export function resolveResumeReviewContext(chainJson) {
  return {
    reviewModel: ("reviewModel" in chainJson) ? chainJson.reviewModel : (chainJson.model ?? null),
    reviewModelChain: ("reviewModelChain" in chainJson) ? chainJson.reviewModelChain : (chainJson.modelChain ?? null),
  };
}

export function resolveResumeReworkContext(chainJson) {
  return {
    reworkModel: ("reworkModel" in chainJson) ? chainJson.reworkModel : (chainJson.model ?? null),
    reworkModelChain: ("reworkModelChain" in chainJson) ? chainJson.reworkModelChain : (chainJson.modelChain ?? null),
    reworkBackend: ("reworkBackend" in chainJson) ? chainJson.reworkBackend : null,
  };
}

export function resolveResumeDispatches({ resumeBackend, resumeReviewBackend, model, reviewModel }) {
  return {
    // The implement seam keeps its pre-#192 shape: `undefined` for opencode
    // so the driver uses its own real dispatchWithFallback, and the
    // backend's own dispatch — clamped to the recorded model — for a
    // model-pinning backend (claude, agy).
    dispatchWithFallback: backendPinsModel(resumeBackend)
      ? phaseDispatchFor(resumeBackend, backendDispatch(resumeBackend), model)
      : undefined,
    // The review seam is ALWAYS explicit (see the doc above): an undefined
    // seam would let the driver fall back to the implement dispatch, which
    // on a mixed chain belongs to the other backend.
    reviewDispatchWithFallback: phaseDispatchFor(
      resumeReviewBackend, backendDispatch(resumeReviewBackend), reviewModel),
  };
}

/**
 * Run the chain round loop.  Shared by cmdChain (fresh chain) and
 * cmdChainResume (resumed chain); `resume` carries the position resolved by
 * resolveChainResume, or null for a fresh chain.
 *
 * Exported so tests can drive the loop with fake callTool / dispatch; the
 * CLI wrappers install signal handlers and (for resume) validate the
 * container before calling this.
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} opts.stateDir
 * @param {string} opts.chainDir
 * @param {string} opts.chainId
 * @param {string} opts.container
 * @param {string|null} opts.model
 * @param {Array} opts.modelChain
 * @param {number} opts.maxRounds
 * @param {string} opts.brief
 * @param {object|null} opts.orchestrator
 * @param {string|null} opts.baseSha        — null → captured from the container.
 * @param {object|null} opts.worktreeBaseline — null → captured from the container.
 * @param {object|null} opts.verifyBaseline — chain-start verify baseline
 *        (kusabi #173).  Fresh chains: captured by cmdChain on the pristine
 *        base.  Resumed chains: read from chain.json by cmdChainResume.  Never
 *        re-captured here — a resumed worktree is modified, so a fresh capture
 *        would measure the round's changes, not the base.
 * @param {Function} opts.callTool
 * @param {Function} [opts.dispatchWithFallback] — injection seam for the
 *        IMPLEMENT phase and the strategist (defaults to the real
 *        dispatchWithFallback; phase functions receive it as their own
 *        _dispatchWithFallback seam).  claudeDispatch when the chain's
 *        implement phase runs on the claude backend (kusabi #184).
 * @param {Function} [opts.reviewDispatchWithFallback] — injection seam for
 *        the REVIEW phase; when not given, resolveReviewDispatch picks it
 *        from the backends: the implement dispatch for a same-backend review
 *        (single-backend chains behave exactly as before), else the canonical
 *        dispatch of the review backend — never the other backend's dispatch
 *        (kusabi #192).  Resolved per phase from models.phases.review.
 * @param {"opencode"|"claude"} [opts.backend] — implement dispatch backend,
 *        recorded on every round record; readers treat a missing field as
 *        "opencode".  Default "opencode".
 * @param {"opencode"|"claude"} [opts.reviewBackend] — review dispatch
 *        backend, recorded as `reviewBackend` on every round record (always
 *        set; readers treat a missing field as the record's implement
 *        backend).  Defaults to the implement backend (legacy
 *        single-dispatch callers run the whole chain on one backend).
 * @param {Array} [opts.reviewModelChain] — the review phase's route chain
 *        (defaults to modelChain for single-chain chains).  Persisted to
 *        chain.json so chain-resume re-dispatches review on the same route.
 * @param {string|object|null} [opts.reviewModel] — the review phase's
 *        command-start resolved model (claude string, or opencode parseModel
 *        object); persisted for chain-resume.
 * @param {Array} [opts.reworkModelChain] — the rework phase's route chain
 *        (kusabi #192 axis 2).  Implement rounds AFTER round 1 (rework
 *        rounds) dispatch from it, and the tier ladder climbs over it; null
 *        (no models.phases.rework key) keeps rework rounds on the implement
 *        chain and ladder — byte-identical to today.  Persisted to
 *        chain.json so chain-resume re-dispatches rework rounds on the same
 *        route.
 * @param {string|object|null} [opts.reworkModel] — the rework phase's
 *        command-start resolved model; persisted for chain-resume.
 * @param {"opencode"|"claude"|null} [opts.reworkBackend] — the rework
 *        phase's dispatch backend; null/absent means rework rounds keep the
 *        implement backend.  Recorded on every rework round record's
 *        `backend` field; persisted to chain.json for chain-resume.
 * @param {Function} [opts.reworkDispatchWithFallback] — injection seam for
 *        REWORK implement rounds (rounds after round 1); when not given the
 *        implement dispatch is used (no rework key configured).  claude
 *        rework rounds get the clamped claude dispatch pinned to the rework
 *        model (kusabi #184 finding 1 applies per phase).
 * @param {string} [opts.initialSession]
 * @param {string|null} [opts.sessionProvenance] — the backend the caller
 *        established (from the job store) as the creator of `initialSession`
 *        (and of the resumed `resume.session`, which is the same value).
 *        The agy dispatch's resume gate: a bare UUID reaches
 *        `--conversation` only with `"agy"` here.
 * @param {string|null} [opts.flagsModel]
 * @param {Function} [opts.signalReceived]  — getter: has SIGTERM/SIGINT fired?
 * @param {boolean} [opts.keepServe]
 * @param {object|null} [opts.resume]       — resolveChainResume position or null.
 * @returns {Promise<string>} Outcome text for the operator.
 */
export async function runChainDriver({
  cwd, stateDir, chainDir, chainId, container, model, modelChain, maxRounds,
  brief, orchestrator, baseSha, worktreeBaseline, verifyBaseline, callTool,
  dispatchWithFallback: injectedDispatch = dispatchWithFallback,
  backend = "opencode",
  reviewDispatchWithFallback: injectedReviewDispatch = null,
  // Default reviewBackend to the implement backend: a caller that threads a
  // single dispatch (every pre-#192 caller) runs the whole chain on one
  // backend, so its records should claim that backend for review too.
  reviewBackend = backend,
  reviewModelChain = null,
  reviewModel = null,
  // Rework context (kusabi #192 axis 2): defaults collapse to the implement
  // resolution, so callers without a models.phases.rework key (and every
  // pre-axis-2 caller) get byte-identical behaviour.
  reworkModelChain = null,
  reworkModel = null,
  reworkBackend = null,
  reworkDispatchWithFallback = null,
  initialSession, flagsModel = null, reviewFlagsModel = null, signalReceived = () => false,
  keepServe = false, resume = null, sessionProvenance = null,
}) {
  // Per-phase dispatch (kusabi #192): the review phase dispatches through its
  // own backend-specific dispatch unless the caller threads a single one
  // (single-backend chains — and every pre-#192 caller — stay identical).
  // The fallback is backend-aware: the implement dispatch is reused only for
  // a same-backend review; under mixing the review phase gets the canonical
  // dispatch of ITS backend, never the other backend's dispatch (kusabi #192
  // finding — chain-resume used to route review through the claude implement
  // dispatch while recording reviewBackend=opencode).
  const reviewDispatch = resolveReviewDispatch({
    injectedReviewDispatch,
    injectedDispatch,
    backend,
    reviewBackend,
  });
  // The review phase's route chain: its own when per-phase config resolved
  // one, else the implement chain (pre-#192 behaviour).
  const effectiveReviewChain = reviewModelChain ?? modelChain;
  // The REWORK phase's effective resolution (kusabi #192 axis 2): its own
  // chain / backend / dispatch when a models.phases.rework key resolved one,
  // else the implement resolution — the `??` collapses exactly to it, so
  // chains without the key (and every pre-axis-2 caller) are byte-identical.
  const effectiveReworkChain = reworkModelChain ?? modelChain;
  const effectiveReworkBackend = reworkBackend ?? backend;
  const effectiveReworkDispatch = reworkDispatchWithFallback ?? injectedDispatch;
  // baseSha: a resume keeps the ORIGINAL chain base — the resumed round's diff
  // is measured against it (P1 auto-resets HEAD to it); a fresh chain captures
  // it from the container.
  const effectiveBaseSha = baseSha ?? await captureBaseSha(callTool, container);
  // worktreeBaseline: captured once per run.  A resumed chain re-captures at
  // resume time — the pre-cancel baseline is not persisted, and the resumed
  // run measures what IT changes from here on.  The interrupted round's
  // review-resume path deliberately bypasses it (see collectReviewContext).
  const effectiveBaseline = worktreeBaseline ?? await captureWorktreeState(callTool, container);
  // verifyBaseline (kusabi #173): NEVER re-captured here.  Fresh chains get it
  // from cmdChain (pristine base); resumed chains reuse the value recorded in
  // chain.json — the worktree is modified by resume time, so a re-capture
  // would measure the round's changes and silently ratchet the baseline.
  const effectiveVerifyBaseline = verifyBaseline ?? null;

  // ---- round loop state (cross-round) ----
  const records = resume ? resume.records : [];
  let strategized = resume ? resume.strategized : false;
  let session = resume ? resume.session : initialSession;
  let provenance = session ? sessionProvenance : null;
  let reworkCount = resume ? resume.reworkCount : 0;
  let currentTierIndex = resume ? resume.currentTierIndex : 0;
  const startRound = resume ? resume.round : 1;

  // ---- terminal finalisation: write the postable review record and append
  // its path to the outcome text.  Every terminal disposition funnels
  // through here (accept / accept-with-followup / escalate / max-rounds), so
  // `chain` and `chain-resume` cannot diverge.  Cancelled and failed chains
  // never reach it (kusabi #52).  The record is a convenience artifact: a
  // write failure must not take the already-decided chain outcome down with
  // it, so it degrades to a visible note instead of throwing.
  function finaliseChain(text, disposition, round) {
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
  function finaliseProvisionalChain(text, disposition, round) {
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
  function repoPathExists(name) {
    try {
      return fs.existsSync(path.join(cwd, name));
    } catch {
      return false;
    }
  }

  // Phases 5–13 (review → disposition → persistence → strategize), shared by
  // fresh rounds and review-resumes.  Mutates the cross-round state above in
  // place; returns { done: true, text } when the chain ended.
  async function finishRound({ round, roundRecord, previousRecord, probeCtx, implementRefusal = null, reworkScope }) {
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
    // decided on, so routing here can only ever DIVIDE that population --
    // a round that changed files takes the same path it did before, and an
    // empty round whose report carries no qualifying block still discards
    // byte for byte.
    //
    // The parse is shape-only; the NAMED items must exist before the block
    // may qualify (phase-chain.md §3.5.4a): a brief-section anchor must be a
    // heading the brief really has, and a repo-path anchor must be a file or
    // directory the worktree really contains -- a forged `src/nonexistent.mjs`
    // or an invented heading counts as unnamed, disqualifying unless two real
    // items remain.  Both inputs are in scope here: the chain's own brief
    // text, and the worktree at `cwd`.  The fresh path and the review-resume
    // path (which also lands here, descriptor read back off the record)
    // therefore derive the same verdict.  The verified descriptor replaces
    // the parse-time stamp on the record, so the record never keeps a
    // shape-only verdict that classification has already rejected.
    let refusalPathExists = repoPathExists;
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
      // reading the brief correctly -- the pressure this whole path exists to
      // remove.  `verdictSource` stays "probe" (no reviewer decided this).
      roundRecord.roundOutcome = "refusal";
      roundRecord.refusal = refusalOutcome.refusal;
      roundRecord.verdict = "refusal";
      roundRecord.verdictSource = "probe";
      roundRecord.findingsText = "(no review — the worker refused the brief as self-contradictory)";
    } else if (refusalOutcome.strayRefusal) {
      // The worker wrote a refusal block AND edited files.  That is not a
      // refusal, so nothing about the routing changes -- but the
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
    // -- the worker cannot edit it, so no rework is winnable and the chain
    // must terminate at the FIRST occurrence rather than spend the budget on
    // reworks that cannot succeed (the chain-msvwhslx6e60 incident).
    //
    // Derived from the brief text with the probes' own parsers, not from the
    // probe results: heading-present-and-zero-entries is exactly the
    // condition those probes fail on, so the two cannot disagree, and the
    // value is identical on every path that reaches here -- a fresh round, a
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
      // measured -- it is a true statement about the work the round did, and
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
      return { done: true, text: finaliseProvisionalChain(outcome, "failed", round) };
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
        tierCount: effectiveTierCount(effectiveReworkChain, effectiveReworkBackend),
        // Anchoring-override evidence (#62): verdict, probes and the
        // cross-round repeated-areas signal from the finished round.
        chainVerdict,
        chainRepeatedAreas,
        probesGreen,
      });

      // Update cross-round state for the next iteration
      pendingReworkStrategy = escalation.strategy;
      reworkCount += 1;
      currentTierIndex = escalation.currentTierIndex;
    } else if (disposition.disposition === "strategize") {
      // Strategize doesn't consume a rework count, but it sets strategized=true
      // which affects the next rework strategy.
    }

    // Record the pending rework strategy on the round record so the next
    // round can read it, and so chain-show can display what levers were pulled.
    roundRecord.pendingReworkStrategy = pendingReworkStrategy;
    roundRecord.tierAfter = currentTierIndex;

    persistChainState({
      chainDir, round, roundRecord, chainId, container, model, modelChain,
      reviewModel, reviewModelChain,
      reworkModel, reworkModelChain, reworkBackend,
      maxRounds, brief, orchestrator, records, baseSha: effectiveBaseSha,
      chainTotals, strategized, chainFollowupDraft,
      verifyBaseline: effectiveVerifyBaseline,
    });

    // Update the chain control round counter
    updateChainControlRound({ chainDir, round });

    // ---- phase 8: disposition handling ----
    // A qualifying refusal is terminal and lands in the orchestrator's hands
    // (kusabi #293).  `completed` like every other decided chain: the chain
    // ran correctly and produced a decision -- what is defective is the
    // brief, which the outcome text says in as many words.
    if (disposition.disposition === "refused-brief-defect") {
      finalizeChainControl({ chainDir, status: "completed", round });
      // Two ways into this terminal, and they hand over different evidence:
      // the worker named the contradiction itself (kusabi #293), or a probe
      // could not read a brief section (kusabi #303).  The renderer follows
      // the round's own outcome, which phases 5b/5c stamped -- a worker
      // refusal is the more specific statement and wins when both hold.
      const refusalRendered = roundRecord.roundOutcome === "refusal"
        ? renderRefusalOutcome({ chainId, round, disposition, orchestrator, roundRecord, records })
        : renderBriefSyntaxDefectOutcome({ chainId, round, disposition, orchestrator, roundRecord, records });
      return { done: true, text: finaliseChain(
        refusalRendered,
        { disposition: "refused-brief-defect", round, reason: disposition.reason || null },
        round,
      ) };
    }

    if (disposition.disposition === "accept") {
      finalizeChainControl({ chainDir, status: "completed", round });
      return { done: true, text: finaliseChain(
        renderAcceptOutcome({ chainId, round, chainParsedReview, chainFindingsText }),
        { disposition: "accepted", round },
        round,
      ) };
    }

    if (disposition.disposition === "accept-with-followup") {
      finalizeChainControl({ chainDir, status: "completed", round });
      return { done: true, text: finaliseChain(
        renderAcceptWithFollowupOutcome({ chainId, round, chainParsedReview, chainFindingsText, chainFollowupDraft, brief }),
        { disposition: "accepted-with-followup", round },
        round,
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
          currentTierIndex, phase: "strategize", jobError: strategistJobError,
          jobFailure: strategistJobFailure,
          chainId, round, container, model, modelChain,
          reviewModel, reviewModelChain,
          reworkModel, reworkModelChain, reworkBackend,
          maxRounds, brief, orchestrator, baseSha: effectiveBaseSha,
          strategized, chainFollowupDraft,
          verifyBaseline: effectiveVerifyBaseline,
        });
        writeJson(path.join(chainDir, "round-" + round + ".json"), roundRecord);
        writeJson(path.join(chainDir, "chain.json"), chainState);
        finalizeChainControl({ chainDir, status: "failed", round });
        return { done: true, text: finaliseProvisionalChain(outcome, "failed", round) };
      }

      strategized = true;

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

  try {
    // Round loop (kusabi #60 step 2).  The for-condition is the HARD CAP:
    // total rounds never exceed 2 × maxRounds (every mechanical round is
    // bought by the design/full round that preceded it), so a chain can never
    // run unbounded.  The budget check inside the body stops the loop when
    // maxRounds design/full rounds are spent.
    for (let round = startRound; round <= 2 * maxRounds; round++) {
      // ---- stop check: honour file-based stop request or signal ----
      if (shouldStopNow({ chainDir, signalReceived: signalReceived() })) {
        finalizeChainControl({ chainDir, status: "cancelled", round: round - 1 });
        const text = `Chain ${chainId} cancelled at round ${round} (stop requested).`;
        return finaliseProvisionalChain(text, "cancelled", round - 1);
      }

      const isFirstRound = !resume && round === 1;
      const hasPreviousRound = round > 1 && records.length > 0;
      const previousRecord = hasPreviousRound ? records[records.length - 1] : null;

      // ---- review-resume: continue this round from its review phase ----
      // Two ways in: the round was INTERRUPTED before review ran (#153①), or
      // its review seat died and the chain escalated on it, so the resume
      // buys a replacement seat for the same round (#248).  Both continue the
      // persisted record in place and dispatch review, never implement.
      if (resume && resume.phase === "review" && round === resume.round) {
        const roundRecord = resume.roundRecord;
        roundRecord.resumed = true;
        const reviewCtx = await collectReviewContext({
          container, brief, callTool,
          // The interrupted round's changes ARE the review target.  A baseline
          // captured now would read as "nothing changed since baseline" and
          // skip the review (shouldSkipReview discards an empty change set);
          // use the full changed set instead.
          worktreeBaseline: null,
        });
        // ---- replacement review seat (kusabi #248) ----
        // This round already ran a review; the SEAT died mid-stream and the
        // chain escalated on it.  Archive that seat before the replacement
        // review writes over the record's review fields, so the record keeps
        // saying a first seat failed instead of silently claiming the
        // replacement's verdict was the only one.  The round record itself is
        // continued in place (no second record, no second round row).
        if (resume.reviewSeatReplacement) {
          // ---- loud refusal on an empty change set (kusabi #248 follow-up) ----
          // A replacement review reviews the CHANGES this round made.  When
          // the collected change set is empty, the container no longer holds
          // the round's changes (fresh clone, reset worktree): the review/skip
          // machinery would skip the review and hand the user a silent
          // discard-escalate.  Refuse loudly instead.  Nothing is persisted on
          // this path, so the chain record stays exactly as the escalate left
          // it -- it never claims a review happened -- and the user is told to
          // re-run the chain.  Only the seat-replacement entry refuses: an
          // interrupted round (#153) legitimately reviews whatever the
          // worktree holds -- its escalate-on-empty is pre-existing behaviour.
          if (shouldSkipReview({
            chainStatusObserved: reviewCtx.chainStatusObserved,
            chainChangedPaths: reviewCtx.chainChangedPaths,
            chainNewlyChanged: reviewCtx.chainNewlyChanged,
            chainDeliverables: reviewCtx.chainDeliverables,
          })) {
            throw new Error(
              `cannot resume chain ${chainId} with a replacement review seat: the container no longer holds ` +
              `round ${round}'s changes (the collected change set is empty -- fresh clone or reset worktree), ` +
              `so a replacement review has nothing to review.  Re-run the chain instead; the chain record was ` +
              `left untouched (no review was dispatched, nothing was escalated).`
            );
          }
          archiveFailedReviewSeat(roundRecord);
        }
        const probeCtx = {
          probesGreen: roundRecord.probesGreen ?? false,
          // The probe truth here is RECORDED — measured before the stop or
          // the seat escalate, on a worktree that may have moved since.  It
          // is good enough to buy a rework (whose own round re-measures), but
          // an accept must re-measure before finalising on it (kusabi #262);
          // this flag is what tells finishRound the truth is second-hand.
          probesFromRecord: true,
          // The oracle marker is recorded truth too (kusabi #197): a round
          // that escalated on a frozen-path edit must still escalate when a
          // replacement review seat approves it.  Old records have no field;
          // absent reads as "no violation recorded", which is what it was.
          oracleViolation: roundRecord.oracleViolation ?? false,
          chainChangedPaths: reviewCtx.chainChangedPaths,
          chainNewlyChanged: reviewCtx.chainNewlyChanged,
          chainStatusObserved: reviewCtx.chainStatusObserved,
          chainStatusOutput: reviewCtx.chainStatusOutput,
          chainBaseLog: reviewCtx.chainBaseLog,
          chainDeliverables: reviewCtx.chainDeliverables,
          chainUntracked: reviewCtx.chainUntracked,
          chainTruncation: reviewCtx.chainTruncation,
          worktreeChanged: reviewCtx.worktreeChanged,
          changeScope: roundRecord.changeScope ?? null,
        };
        // The interrupted round is the last record in `records`; the
        // previous COMPLETE round is the one before it.  Named once because
        // both the review's previousRecord and the scope derivation below
        // must see the SAME record.
        const resumePreviousRecord = records.length >= 2 ? records[records.length - 2] : null;
        const result = await finishRound({
          round,
          roundRecord,
          previousRecord: resumePreviousRecord,
          probeCtx,
          // No implement job runs on this path, so the refusal is READ from
          // the persisted record (kusabi #293): runImplementPhase stamps the
          // parsed descriptor at parse time, and the interrupted round was
          // persisted with it -- a stop between implement and finishRound
          // (kusabi #153①) must not convert an honest refusal into a worker
          // discard on resume.  Records predating the stamp read as null and
          // route exactly as they did before refusals existed.
          implementRefusal: roundRecord.implementRefusal ?? null,
          // Kusabi #334: this path has no fresh-round block, so the scope is
          // re-derived from the SAME single decision point
          // (resolveReworkScope) on the SAME previous record.  The function
          // is deterministic in its input, so the resume derives exactly the
          // scope the fresh path derived (and the interrupted record's
          // reworkScope field records) for this round.
          reworkScope: resolveReworkScope(resumePreviousRecord),
        });
        if (result.done) return result.text;
        continue;
      }

      // ---- budget check (kusaba #60 step 2) ----
      // maxRounds buys design/full rounds only; mechanical rounds are free.
      // Budget is DERIVED from the records (never persisted), so a resumed
      // chain recomputes it from records alone.  Placed after the
      // review-resume branch: a resumed interrupted round already spent its
      // budget slot and must be allowed to finish its review.
      const budgetUsed = records.filter(function (r) {
        return r.reworkScope !== "mechanical";
      }).length;
      if (budgetUsed >= maxRounds) break;

      // ---- rework scope for this round (kusabi #60 step 2) ----
      // Single decision point: resolveReworkScope maps the previous round's
      // findings to "full" | "mechanical" | "design" plus the scoped subset.
      // The result feeds both the implement brief and the budget accounting;
      // the round record stores the scope it was RUN with.
      const scopeResolution = resolveReworkScope(previousRecord);

      // ---- phase 1: resume strategy (B2: derive rework levers when rework) ----
      let useNewSession = false;
      let reworkStrategyReason = null;
      let reworkStrategy = null;

      if (isFirstRound) {
        // First round: no session to continue from.
        useNewSession = false;
      } else if (previousRecord?.pendingReworkStrategy) {
        // Use the rework strategy computed at the end of the previous round.
        reworkStrategy = previousRecord.pendingReworkStrategy;
        useNewSession = reworkStrategy.newSession;
        reworkStrategyReason = reworkStrategy.reason;
      }

      const { resumeMethod } = resolveRoundResume({ useNewSession });

      // ---- phase 2: round model selection ----
      // Use currentTierIndex (never round) so tier is decoupled from the round counter.
      // For review, the reviewer stays on tier 0 (round 1) — that's handled in
      // runReviewPhase which passes round=1 to dispatchWithFallback.

      // ---- per-round implement dispatch context (kusabi #192 axis 2) ----
      // Round 1 dispatches from the implement resolution; every LATER round
      // is a rework round and dispatches from the rework resolution when
      // models.phases.rework is configured (absent key \u2192 the implement
      // resolution \u2014 byte-identical to today).  The tier ladder climbs over
      // the same chain the round dispatches on: currentTierIndex addresses
      // the implement chain during round 1 and the rework chain from
      // round 2 on (the first rework starts at the rework chain's tier 0).
      const isReworkRound = !isFirstRound;
      const roundModelChain = isReworkRound ? effectiveReworkChain : modelChain;
      const roundBackend = isReworkRound ? effectiveReworkBackend : backend;
      const roundDispatch = isReworkRound ? effectiveReworkDispatch : injectedDispatch;

      // ---- session lineage guard (kusabi #192 invariant 5) ----
      // A session never crosses backends: a rework implement round may only
      // continue a session created by the backend THIS round dispatches on
      // (the rework backend on rework rounds); otherwise it starts fresh.
      // The cross-round `session` is the implement job's session, so when it
      // traces to a record of the OTHER backend (only possible across a
      // chain-resume or a round-1/rework backend switch) it is dropped here,
      // and the same guard inside runImplementPhase covers its
      // previousRecord.sessionID fallback.  Its provenance is dropped with
      // it — an agy dispatch must never see a claude-attributed id.
      if (session && !isFirstRound && previousRecord && (previousRecord.backend ?? "opencode") !== roundBackend) {
        session = null;
        provenance = null;
      }

      // ---- phase 3: implement text + dispatch ----
      const implementText = buildImplementText({ round, brief, previousRecord, container, reworkScope: scopeResolution });
      const {
        roundRecord,
        session: resolvedSession,
        sessionProvenance,
        implementJobStatus,
        implementJobSteps,
        implementJobError,
        implementJobFailure,
        implementRefusal,
      } = await runImplementPhase({
        cwd, chainId, round, isFirstRound, implementText, modelChain: roundModelChain,
        tierIndex: currentTierIndex,
        useNewSession, session, sessionProvenance: provenance, previousRecord, resumeMethod, flagsModel,
        backend: roundBackend,
        _dispatchWithFallback: roundDispatch,
      });
      session = resolvedSession;
      // The provenance follows the session: the next round's dispatch needs
      // it when (and only when) it cannot re-derive it from the round record
      // (runImplementPhase falls back to this for a session that is not the
      // previous record's — a chain-resume's initialSession whose recorded
      // job returned a different id, say).
      provenance = sessionProvenance ?? null;

      // No compensation here (kusabi #323): runImplementPhase now reports the
      // session its dispatch actually used or created — for a useNewSession
      // round that is the conversation the fresh dispatch CREATED, never the
      // one it was told to walk away from — so the carry is already the right
      // hand-off for round N+1.  (kusabi #320 cleared it here; that
      // compensation was removed when the seam started reporting the truth.)
      // The carry still crosses no backend: the lineage guard above and
      // runImplementPhase's previousRecord fallback refuse foreign sessions.

      // The chain record carries the dispatch backends (kusabi #184 / #192);
      // the phase functions stay backend-blind, so they are stamped here.
      // Round records persist them via persistChainState (round-N.json and
      // the records array in chain.json); readers treat a missing `backend`
      // field as "opencode" and a missing `reviewBackend` as the record's
      // implement backend.  `reviewBackend` is always set.  Each round's
      // `backend` is the backend its implement job ACTUALLY used \u2014 round 1
      // the implement backend, rework rounds the rework backend (axis 2).
      roundRecord.backend = roundBackend;
      roundRecord.reviewBackend = reviewBackend;

      // Record lever info on the round record (B8)
      roundRecord.tierBefore = currentTierIndex;
      roundRecord.reworkStrategyReason = reworkStrategyReason;
      roundRecord.reworkCount = reworkCount;

      // The scope this round was RUN with (kusabi #60 step 2): "full" when
      // not a scoped rework.  Stored verbatim like every other record field;
      // budget is never persisted — it is derived by counting records whose
      // reworkScope is not "mechanical".
      roundRecord.reworkScope = scopeResolution.scope;

      // Resume trace: this round was (re)started by chain-resume.
      if (resume && resume.phase === "implement" && round === resume.round) {
        roundRecord.resumed = true;
      }

      // ---- stop on implement provider exhaustion ----
      if (implementJobStatus === "provider-error") {
        const { chainState, outcome } = handleProviderExhaustion({
          records, roundRecord,
          currentTierIndex, phase: "implement", jobError: implementJobError,
          jobFailure: implementJobFailure,
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
        return finaliseProvisionalChain(outcome, "failed", round);
      }

      // ---- phase 4: deterministic probes (P1–P6) ----
      const probeResult = await runProbePhase({
        baseSha: effectiveBaseSha, container, brief, callTool,
        worktreeBaseline: effectiveBaseline, verifyBaseline: effectiveVerifyBaseline,
      });
      roundRecord.probesGreen = probeResult.probesGreen;
      roundRecord.probeResults = probeResult.probeResults;
      roundRecord.worktreeChanged = probeResult.worktreeChanged;
      roundRecord.changeScope = probeResult.changeScope ?? null;
      // Closed terminal reason (kusabi #380): re-derive now that the chain
      // layer has measured substance.  A completed round whose worktree did
      // not change records infra-death (steps 0) or empty-completion
      // (steps > 0); a completed round that changed the worktree, or any
      // non-completed status, keeps the job-level reason runImplementPhase
      // already stamped.  Unknown/future values fail closed (deriveStopReason
      // returns "unknown") — never silently read as success.
      roundRecord.stopReason = deriveStopReason({
        status: implementJobStatus,
        stats: { steps: implementJobSteps ?? 0 },
        worktreeChanged: roundRecord.worktreeChanged ?? null,
      });
      // The P5/P6 oracle marker (kusabi #197) is persisted like any other
      // probe truth: a review-resume of this round reads it back, so a frozen
      // edit cannot be forgotten by the round that carried it.
      roundRecord.oracleViolation = probeResult.oracleViolation;

      // ---- stop check: a stop requested during implement must not buy a
      // review job, and must not leave the container busy while the
      // orchestrator inspects it.  Placed after the probes rather than
      // before them so the worktree is left in the canonical post-P1 state
      // (HEAD == base, changes unstaged) that the orchestrator publishes from.
      // The partial round (implement + probes done) is PERSISTED so the chain
      // is resumable (kusabi #153①) and control round matches actual progress.
      if (shouldStopNow({ chainDir, signalReceived: signalReceived() })) {
        const partialTotals = computeChainTotals([...records, roundRecord]);
        persistChainState({
          chainDir, round, roundRecord, chainId, container, model, modelChain,
          reviewModel, reviewModelChain,
          reworkModel, reworkModelChain, reworkBackend,
          maxRounds, brief, orchestrator, records, baseSha: effectiveBaseSha,
          chainTotals: partialTotals, strategized, chainFollowupDraft: null,
          interrupted: true,
          verifyBaseline: effectiveVerifyBaseline,
        });
        finalizeChainControl({ chainDir, status: "cancelled", round });
        const text = `Chain ${chainId} cancelled during round ${round} (stop requested after probes, before review). Progress preserved — resume with chain-resume ${chainId}.`;
        return finaliseProvisionalChain(text, "cancelled", round);
      }

      const result = await finishRound({
        round,
        roundRecord,
        previousRecord,
        probeCtx: probeResult,
        implementRefusal,
        // The scope resolution computed above (kusabi #334) is carried into
        // the review seam so the review prompt and the repeated-areas signal
        // derive from the SAME decision that shaped the implement brief.
        reworkScope: scopeResolution,
      });
      if (result.done) return result.text;
    }

    // ---- max rounds reached without acceptance ----
    // The budget/hard-cap terminal can fire after more than maxRounds RAW
    // rounds (mechanical rounds are free), so the recorded round is the
    // actual number of completed rounds — never the nominal maxRounds —
    // keeping control.round and the review record consistent with the
    // persisted round-N.json files (kusabi #60 step 2 review).
    const actualRounds = records.length;
    finalizeChainControl({ chainDir, status: "completed", round: actualRounds });
    return finaliseChain(
      renderMaxRoundsOutcome({ chainId, maxRounds, records, orchestrator }),
      { disposition: "max-rounds", round: actualRounds },
      actualRounds,
    );
  } catch (err) {
    // Exception thrown mid-round — record failure and rethrow
    finalizeChainControl({ chainDir, status: "failed", round: records.length });
    finaliseProvisionalChain("", "failed", records.length);
    throw err;
  } finally {
    // Stop the serve for this cwd unless --keep-serve or another job is running
    if (!keepServe) {
      try {
        // liveRunningJobs applies the same fossil rule as cmdServeStop: a
        // `running` record whose driver died (no activity for 6+ hours) does
        // not count as a live job and must not pin the serve (kusabi #175).
        const hasRunning = liveRunningJobs(stateDir).length > 0;
        if (!hasRunning) {
          cmdServeStop(cwd);
        }
      } catch { /* best-effort */ }
    }
  }
}
