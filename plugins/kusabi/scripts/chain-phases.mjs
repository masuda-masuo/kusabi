// chain-phases.mjs — Round lifecycle phases for cmdChain.
//
// Every function in this module receives cross-round state (baseSha,
// strategized, records) as explicit arguments and returns results as
// explicit return values — nothing is captured from an enclosing scope.
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
  resolveModelBackend,
} from "./cli.mjs";
import {
  renderStrategistPrompt,
  renderReviewRecord,
  groupFindingsByKind,
} from "./render.mjs";
import { deriveReworkStrategy } from "./disposition.mjs";
// resolveRoundResume is defined below and is the only resume-resolution
// mechanism.  checkpoint_restore was removed in issue #114 — the chain
// never rolls the worktree back.
import { writeJson } from "./state-paths.mjs";
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

// =========================================================================
// Dispatch-failure quota classification (kusabi #373)
//
// A review (or implement) job that produced NO payload is not an unreadable
// verdict: `verdict: unparseable` means a payload arrived and could not be
// read.  When the backend named a quota-exhausted pool in the failure text,
// the round record must carry that as its own field so chain-show and
// chain-resume can tell the two failures apart without opening job.json.
//
// Classify ONLY phrases that have been observed.  A false positive here
// hard-stops a chain that could have continued (agy-dispatch.mjs documents
// the same principle for its own quota handling).
// Observed:
//   agy:      "Individual quota reached. Please upgrade your subscription
//              to increase your limits. Resets in 1h1m21s."
//   opencode: "Free usage exceeded, subscribe to Go"
// Claude already classifies from the structured payload (kusabi #215) and
// writes job.failure; this layer fills in when the adapter left failure null.
// =========================================================================

const AGY_QUOTA_MARKER = "Individual quota reached";
const OPENCODE_QUOTA_MARKER = "Free usage exceeded";

/**
 * Classify a dispatch-failure text as quota exhaustion of a named backend.
 * Returns null when the text does not contain an observed phrase.
 *
 * @param {string|null|undefined} errorText
 * @returns {null | {
 *   kind: "quota-exhaustion",
 *   backend: "agy" | "opencode",
 *   quota: "individual" | "free-tier",
 *   backendBlocked: boolean,
 *   reset: string | null,
 * }}
 */
export function classifyDispatchQuotaExhaustion(errorText) {
  if (typeof errorText !== "string" || errorText.length === 0) return null;
  if (errorText.includes(AGY_QUOTA_MARKER)) {
    const resetMatch = errorText.match(/Resets in ([^\s.]+)/);
    return {
      kind: "quota-exhaustion",
      backend: "agy",
      quota: "individual",
      backendBlocked: true,
      reset: resetMatch ? resetMatch[1] : null,
    };
  }
  if (errorText.includes(OPENCODE_QUOTA_MARKER)) {
    return {
      kind: "quota-exhaustion",
      backend: "opencode",
      quota: "free-tier",
      backendBlocked: true,
      reset: null,
    };
  }
  return null;
}

/**
 * The escalate reason chain-show prints for a quota-exhausted review seat.
 * Named so the digest never reads as `unexpected verdict: unparseable`.
 *
 * @param {object} failure — `{ kind: "quota-exhaustion", ... }`
 * @returns {string}
 */
export function quotaExhaustionReason(failure) {
  const backend = failure?.backend || "provider";
  const pool = failure?.quota === "free-tier"
    ? "free-tier pool"
    : failure?.quota === "individual"
      ? "individual pool"
      : failure?.quota
        ? failure.quota + " pool"
        : "pool";
  const reset = failure?.reset
    ? (/^\d/.test(String(failure.reset)) ? "; resets in " + failure.reset : "; resets " + failure.reset)
    : "";
  return "quota exhausted (" + backend + " " + pool + ")" + reset;
}

/**
 * chain-resume refusal when the recorded failure was quota exhaustion and
 * the operator did not name a different route.
 *
 * @param {object} failure
 * @returns {string}
 */
export function quotaReplacementRefusal(failure) {
  const backend = failure?.backend || "the current backend";
  const quota = failure?.quota ? " (" + failure.quota + ")" : "";
  return (
    "review seat died of quota exhaustion on " + backend + quota +
    ". Buying the same seat cannot work. Route the replacement with " +
    "--backend opencode|claude|agy|cursor or --model <id> (a different backend or model)."
  );
}

/**
 * The structured quota-exhaustion fact on a round record, or null.
 *
 * @param {object|null|undefined} record
 * @returns {object|null}
 */
export function recordQuotaExhaustion(record) {
  const failure = record?.reviewJobFailure;
  if (failure && failure.kind === "quota-exhaustion") return failure;
  return null;
}

/**
 * True when the operator named a model or backend that is not the recorded
 * review seat's route — the one case where buying a replacement after quota
 * exhaustion can work.
 *
 * @param {object} record
 * @param {{ backend?: string|null, model?: string|null }|null|undefined} explicitRoute
 * @returns {boolean}
 */
export function explicitRouteDiffersFromRecord(record, explicitRoute) {
  if (!explicitRoute || typeof explicitRoute !== "object") return false;
  const recordedBackend = record.reviewBackend ?? record.backend ?? "opencode";
  if (explicitRoute.backend && explicitRoute.backend !== recordedBackend) return true;
  if (explicitRoute.model) {
    let spec;
    try {
      spec = resolveModelBackend(explicitRoute.model);
    } catch {
      spec = null;
    }
    if (spec?.backend && spec.backend !== recordedBackend) return true;
    const recordedModel = record.reviewModelEntry ?? "";
    const wanted = spec?.model ?? explicitRoute.model;
    if (wanted && wanted !== recordedModel && explicitRoute.model !== recordedModel) return true;
  }
  return false;
}

/**
 * Compute chain-wide usage totals from all round records.
 *
 * Archived review seats (kusabi #248) count too: a seat that died mid-stream
 * still burned tokens, and its spend moved off the live `reviewUsage` field
 * when the replacement seat was bought.  Dropping it here would make the
 * chain's reported cost quietly cheaper than the run actually was.
 */
export function computeChainTotals(records) {
  const chainTotals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const rec of records) {
    const seatUsages = Array.isArray(rec.reviewSeatFailures)
      ? rec.reviewSeatFailures.flatMap(function (s) { return [s?.reviewUsage, s?.reviewFirstUsage]; })
      : [];
    for (const usage of [rec.implementUsage, rec.reviewUsage, rec.reviewFirstUsage, ...seatUsages]) {
      if (usage && usage.available) {
        chainTotals.input += usage.input || 0;
        chainTotals.output += usage.output || 0;
        chainTotals.reasoning += usage.reasoning || 0;
        chainTotals.cacheRead += usage.cacheRead || 0;
        chainTotals.cacheWrite += usage.cacheWrite || 0;
        chainTotals.cost += usage.cost || 0;
      }
    }
  }
  return chainTotals;
}

/**
 * Persist a round record and update chain.json.
 *
 * Writes both `round-N.json` and `chain.json` to the chain directory.
 *
 * `interrupted` (kusabi #153①): the chain stopped at a phase boundary inside
 * this round (implement + probes done, review not run).  The record is marked
 * `interrupted` so chain-show renders it as a partial round and chain-resume
 * can pick up at the next phase.  control.json is finalised by the caller.
 *
 * The round is pushed into `records` idempotently: a chain-resumed round was
 * already pushed when its partial state was persisted at stop time.
 */
export function persistChainState({
  chainDir, round, roundRecord, chainId, container, model, modelChain,
  reviewModel = null, reviewModelChain = null,
  reworkModel = null, reworkModelChain = null, reworkBackend = null,
  maxRounds, brief, orchestrator, records, baseSha, chainTotals,
  strategized, chainFollowupDraft, interrupted = false, verifyBaseline = null,
}) {
  if (interrupted) {
    roundRecord.interrupted = true;
    roundRecord.interruptedAfter = "probes";
  } else if (roundRecord.interrupted) {
    // The round completed after a resume: `interrupted` means "still
    // partial", so a completed round must not keep claiming it (#153①
    // review — chain-show would render a finished, dispositioned round as
    // "interrupted" forever).  The history moves to a separate trace field;
    // `resumed: true` stays for the recovery narrative.
    delete roundRecord.interrupted;
    delete roundRecord.interruptedAfter;
    roundRecord.wasInterrupted = true;
  }
  if (!records.includes(roundRecord)) {
    records.push(roundRecord);
  }
  writeJson(path.join(chainDir, "round-" + round + ".json"), roundRecord);
  writeJson(path.join(chainDir, "chain.json"), {
    chainId,
    container,
    model,
    modelChain,
    // Per-phase review dispatch context (kusabi #192): the review phase's
    // own model + route chain, so chain-resume re-dispatches review on the
    // same backend/model it originally ran on.  Old chain.json files lack
    // these; chain-resume falls back to modelChain / the record's backend.
    reviewModel,
    reviewModelChain,
    // Per-round rework dispatch context (kusabi #192 axis 2): the rework
    // phase's own model, route chain and backend, so chain-resume
    // re-dispatches rework rounds on the same backend/model they originally
    // ran on.  Null on chains without models.phases.rework (rework rounds
    // then continue on the implement resolution); chain.json files written
    // before the key existed lack these keys and chain-resume treats key
    // absence as legacy.
    reworkModel,
    reworkModelChain,
    reworkBackend,
    maxRounds,
    brief,
    orchestrator,
    records,
    baseSha,
    chainTotals,
    strategized,
    followupIssueDraft: chainFollowupDraft,
    // Chain-start verify baseline (kusabi #173): captured on the pristine
    // base before round-1 implement, reused verbatim by chain-resume.
    verifyBaseline,
  });
}

/**
 * Write the chain's postable review record (kusabi #52).
 *
 * Rendered by the pure `renderReviewRecord` (render.mjs) and written to the
 * chain's state directory as `review-record.md`. Written on terminal
 * dispositions (accept / accept-with-followup / escalate / max-rounds) and
 * as a provisional record on non-completed exits (cancelled / failed) when the
 * last round has probe results. Regeneration overwrites the previous record.
 * The companion only writes the local file and returns its path — posting it
 * to the archive repository is orchestrator-exclusive.
 *
 * @param {object} opts
 * @param {string} opts.chainDir
 * @param {string} opts.chainId
 * @param {string} opts.container
 * @param {Array}  [opts.modelChain]
 * @param {number} [opts.maxRounds]
 * @param {string} [opts.brief]
 * @param {object|null} [opts.orchestrator]
 * @param {Array}  [opts.records]       — round records (used as-is).
 * @param {object} [opts.chainTotals]   — existing chainTotals; recomputed
 *                                       from records only when not given.
 * @param {{disposition: string, round: number, reason?: string|null}} opts.disposition
 *                                       — the FINAL disposition.
 * @param {string} [opts.label]         — repo/cwd label for the header.
 * @param {string} [opts.finishedAt]    — ISO timestamp; defaults to now.
 * @param {boolean} [opts.provisional]  — true when chain ended at a non-completed exit.
 * @returns {string} The absolute path of the written record file.
 */
export function writeReviewRecord({
  chainDir, chainId, container, modelChain, maxRounds, brief, orchestrator,
  records, chainTotals, disposition, round, label, finishedAt, provisional,
}) {
  const safeRecords = Array.isArray(records) ? records : [];
  const markdown = renderReviewRecord({
    chainId,
    container,
    label,
    brief,
    orchestrator,
    modelChain,
    maxRounds,
    records: safeRecords,
    chainTotals: chainTotals ?? computeChainTotals(safeRecords),
    disposition: {
      disposition: typeof disposition === "string" ? disposition : (disposition?.disposition ?? "unknown"),
      round,
      reason: disposition?.reason ?? null,
    },
    finishedAt,
    provisional,
  });
  const recordPath = path.join(chainDir, "review-record.md");
  fs.mkdirSync(chainDir, { recursive: true });
  // Atomic write: readers must never observe a truncated record — the file is
  // posted as authoritative by the orchestrator.
  const tmpPath = recordPath + ".tmp";
  fs.writeFileSync(tmpPath, markdown, "utf8");
  fs.renameSync(tmpPath, recordPath);
  return recordPath;
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
