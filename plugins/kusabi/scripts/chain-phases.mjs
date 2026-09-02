// chain-phases.mjs — Round lifecycle phases for cmdChain.
//
// Every function in this module receives cross-round state (baseSha,
// strategized, records) as explicit arguments and returns results as
// explicit return values — nothing is captured from an enclosing scope.
//
// Probe functions (runHeadCleanProbe, runVerifyProbe, runDeliverablesProbe,
// runSmokeProbe, runSmokeEntry) live in chain-probes.mjs and are imported
// from there by runProbePhase.
//
// Review functions (runReviewPhase, parseReviewResult, buildReviewRepairPrompt,
// shouldSkipReview, renderProbeReport, renderReviewPriorFindings) live in
// chain-review.mjs (kusabi #435).
//
// Outcome rendering (renderAcceptOutcome, renderAcceptWithFollowupOutcome,
// renderEscalateOutcome, renderRefusalOutcome, renderBriefSyntaxDefectOutcome,
// renderMaxRoundsOutcome, renderProviderExhaustedOutcome, handleProviderExhaustion)
// lives in chain-outcomes.mjs (kusabi #439).


import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  implementDenyTools,
  reviewDenyTools,
  backendSupportsResume,
  resolveModelBackend,
} from "./cli.mjs";
import {
  renderContainerReviewInput,
  renderPriorFindings,
  renderStrategistPrompt,
  renderReviewRecord,
  groupFindingsByKind,
} from "./render.mjs";
import {
  hasSectionHeading,
  parseDeliverables,
  parseFrozenTests,
  parseSmoke,
} from "./brief-parsing.mjs";
import {
  parseRefusalBlock,
} from "./probe-decisions.mjs";
import { deriveReworkStrategy } from "./disposition.mjs";
// resolveRoundResume is defined below and is the only resume-resolution
// mechanism.  checkpoint_restore was removed in issue #114 — the chain
// never rolls the worktree back.
import { writeJson } from "./state-paths.mjs";
// effectiveStatus powers resolveChainResume (kusabi #153①): a chain whose
// pid is gone is an abnormal stop that may be resumed; a live process or a
// finished status is not.  chain-control has no imports from this module, so
// there is no cycle.
import { effectiveStatus } from "./chain-control.mjs";
import { dispatchWithFallback } from "./prompt-execution.mjs";
import { deriveStopReason } from "./stop-reason.mjs";
import {
  readExecCapture,
  buildVerifyBaseline,
  runHeadCleanProbe,
  runVerifyProbe,
  runDeliverablesProbe,
  runSmokeProbe,
  runFrozenProbe,
  runCollectedProbe,
  summariseOracleViolations,
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
 * Prepend the workspace header naming the exact container ID, or return the
 * text unchanged when there is no container.
 *
 * Extracted from buildImplementText (kusabi #289) because the single-shot
 * `task --container <cid>` path needs the SAME sentence: the chain injected
 * the id into its implement prompt while `task` only recorded it on the job,
 * so a worker dispatched by `task --phase implement --container <cid>` with a
 * brief that carried no `## Workplace` section had nothing to read the id out
 * of — one such job guessed ten `sandbox_attach` names, all failed, and
 * finished 171s with zero edits.  One function, one wording: a brief that
 * also names its workplace is then a harmless duplicate, and a stale id in a
 * brief loses to the fresh `--container` value stated first.
 *
 * @param {string} text                     The prompt text to prefix.
 * @param {string|null|undefined} container  The container ID, if any.
 * @returns {string}
 */
export function withContainerWorkspace(text, container) {
  if (!container) return text;
  return "The workspace lives inside container `" + container + "`. Pass this exact ID as `container_id` to every sunaba tool call. Do not guess container names or call sandbox_attach.\n\n" + text;
}

/**
 * Build the implement prompt text for a chain round.
 *
 * When `container` is given, a header naming the exact container ID is
 * prepended to the returned text for every round (mirroring the review-prompt
 * injection). Without `container` the output is byte-for-byte what this
 * function produced before.
 *
 * `reworkScope` (kusabi #60 step 2) is the resolved scope for this round — the
 * result of `resolveReworkScope(previousRecord)` — decided by the caller so
 * the round loop's budget accounting and the prompt text can never disagree.
 * When absent, or when its `scope` is "full", the output is byte-identical to
 * the pre-scheduling text.  For a scoped round the prior-findings block is
 * replaced by the scope sentence + the FULL per-finding rendering of the
 * scoped subset (`renderPriorFindings` over a record-shaped subset — bodies,
 * recommendations and the same budget bound as the full-scope path), keeping
 * the rest of the prompt structure (instruction / strategist / acceptance
 * criteria) unchanged.
 */
export function buildImplementText({ round, brief, previousRecord, container, reworkScope }) {
  let text;
  if (round === 1) {
    text = brief;
  } else if (previousRecord) {
    let strategistSection = "";
    if (previousRecord.strategistRecommendation) {
      strategistSection = "\n\n## Strategist recommendation (structural change for this rework)\n" + previousRecord.strategistRecommendation + "\n";
    }
    const scope = reworkScope || { scope: "full", findings: [] };
    let priorFindingsText;
    if (scope.scope === "full") {
      // Byte-identical to the pre-scheduling text (kusabi #60 step 2).
      priorFindingsText = renderPriorFindings(previousRecord);
    } else {
      const scopeSentence = scope.scope === "mechanical"
        ? "This round resolves ONLY the following mechanical checklist; other known findings are deliberately out of scope this round."
        : "This round resolves ONLY the following design finding; other known findings are deliberately out of scope this round.";
      // Followup: a scoped round renders its subset with the FULL per-finding
      // renderer (bodies + recommendations, same budget bound as the full
      // path) - a scoped round must give its finding the same deliberate
      // treatment the full path gives the whole set, not a one-line summary.
      priorFindingsText = scopeSentence + "\n\n" + renderPriorFindings({ findings: scope.findings });
    }
    text = "## Prior findings\n" + priorFindingsText + "\n\n## Instruction\nResolve each prior finding in this round. If a finding cannot be fully resolved, you must explain why and report what remains." + strategistSection + "\n\n## Acceptance criteria\n" + brief;
  } else {
    text = brief;
  }
  return withContainerWorkspace(text, container);
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
 * Run the implement phase: dispatch the implement job via dispatchWithFallback
 * and return the initial round record with implement-related fields.
 *
 * The returned roundRecord is a partial record; subsequent phases add more
 * fields (probes, review, disposition).
 */
export async function runImplementPhase({
  cwd, chainId, round, isFirstRound, implementText, modelChain, tierIndex,
  useNewSession, session, sessionProvenance, previousRecord, resumeMethod, flagsModel,
  backend = "opencode",
  _dispatchWithFallback: _dispatch = dispatchWithFallback,
}) {
  // Session lineage guard (kusabi #199 shape, #316 resume): a session is
  // carried into a backend only when the backend can resume one AND the
  // session's provenance is established.  For agy both halves matter: the
  // dispatch itself refuses a bare UUID without the caller's provenance
  // signal (assertNoAgySession), so a chain that forwarded an unproven
  // session would throw at dispatch instead of running — this seam must
  // either prove the session (from the previous round's record, below) or
  // pass through the caller's proof (chain-resume's initialSession
  // provenance, established at command start where the job store is in
  // hand).  claude and opencode ignore the signal; the forwarding is
  // byte-identical for them.
  let resolvedSession = backendSupportsResume(backend) ? session : undefined;
  let resolvedSessionProvenance = null;
  if (resolvedSession) {
    // The injected session (chain-resume's `initialSession` / the driver's
    // cross-round carry) is proven when the caller says so; when it IS the
    // previous round's session, the record itself is the proof.
    resolvedSessionProvenance =
      previousRecord && previousRecord.sessionID === resolvedSession
        ? (previousRecord.backend ?? "opencode")
        : (sessionProvenance ?? null);
  }
  if (!resolvedSession && !isFirstRound && previousRecord?.sessionID && backendSupportsResume(backend)) {
    // Session lineage guard, part 2 (kusabi #192 invariant 5): a rework
    // implement round may only continue a session created by the implement
    // backend; a session attributable to a record of the OTHER backend is
    // dropped and the round starts fresh.  Records without a `backend` field
    // predate the backend split and count as "opencode" (readers' convention).
    if (!useNewSession && (previousRecord.backend ?? "opencode") === backend) {
      resolvedSession = previousRecord.sessionID;
      resolvedSessionProvenance = previousRecord.backend ?? "opencode";
    }
  }

  const { job, resultText } = await _dispatch({
    cwd,
    kind: "task",
    title: "chain: " + chainId + " round " + round + " implement",
    promptText: implementText,
    agent: "kusabi-implement",
    phase: "implement",
    session: useNewSession ? undefined : resolvedSession,
    sessionProvenance: useNewSession ? undefined : resolvedSessionProvenance,
    tools: implementDenyTools(),
    timeoutS: 3600,
    watchdogS: 900,
    tiers: modelChain,
    tierIndex, // decoupled from round counter (B1)
    round,
    explicitModel: isFirstRound ? flagsModel : null,
  });

  // The report text is read for exactly one thing (kusabi #293): the
  // structured refusal block a worker writes when it stops without editing
  // because the brief contradicts itself.  Only the PARSED descriptor leaves
  // this function -- the report itself can carry a whole git diff, and the
  // round record must not grow one.  Gated on `completed` for the same reason
  // the review retry is: a failed job's text is empty or garbage, and a
  // refusal must never be inferred from a job that died.
  //
  // The descriptor is stamped onto the round record AT PARSE TIME because the
  // driver has a designed interruption point between this phase and
  // finishRound (the stop-check after the probes, kusabi #153①): the
  // partial round is persisted as-is at that stop, and the review-resume path
  // must route the refusal that round carried -- without the stamp, a resumed
  // refusal round would classify as a worker discard.  Stamped here, the
  // record is the single source of truth for both the fresh path (which
  // passes the same descriptor to finishRound) and the resume path (which
  // reads it back); no second measurement exists.
  const implementRefusal = job.status === "completed" ? parseRefusalBlock(resultText) : null;

  // ---- report the session this round's dispatch used or created ----
  // The returned session is the next round's carry, and the invariant is
  // that it is one round N's dispatch USED or CREATED -- observed beats
  // told.  The job records the id the dispatch actually got back
  // (`job.sessionID`); whenever that exists we report it, whether the round
  // resumed or ran fresh.  The candidate this round was TOLD to resume
  // (`resolvedSession`, from the carry or the previous-record fallback) is
  // reported ONLY as a dead-round fallback: a resuming round whose job died
  // before any id was observed -- the next round then still has a
  // conversation worth trying.  A fresh round with a null `job.sessionID`
  // reports null exactly as before.
  //
  // Why observed beats told (kusabi #324): measured 2026-08-21, a real agy
  // record (chain-msxhipgq1cef round 2, continue_session) was passed the
  // candidate `a784b853-…` yet the job stamped `2a177486-…` -- agy can mint
  // a NEW conversation id on resume (its `job.sessionID` is stamped from the
  // stream init event's `conversation_id`, agy-dispatch.mjs), so the
  // candidate and the observed id CAN diverge.  opencode held 16/16 same-
  // backend `continue_session` rounds and a claude n=1 probe held the id, so
  // this is real divergence, not a constant rewrite.  Reporting the candidate
  // there would be the old kusabi #320 defect's mirror: round N+1 would
  // resume a conversation round N's dispatch never used.  Fresh-round
  // behaviour is unchanged (kusabi #320/#323 semantics intact).
  //
  // Provenance follows the session: the owner of an observed id is the
  // backend this round dispatched on (it created or re-bound the
  // conversation); the owner of the fallback candidate is
  // `resolvedSessionProvenance` (the previous record or the caller's proof);
  // null when nothing is reported.
  //
  // Failure path: the dead-round fallback above is the resuming case.  A
  // fresh round whose job died before any session id was observed
  // (dispatchWithFallback's no-route error job, a backend job that never
  // returned an id) leaves `job.sessionID` null with no candidate to fall
  // back to: the carry is null and the next round starts fresh -- a dead
  // fresh round resumes nothing, by construction.
  const isResumingRound = !useNewSession && !!resolvedSession;
  const reportedSession = job.sessionID ?? (isResumingRound ? resolvedSession : null);
  const reportedProvenance = job.sessionID ? backend : (isResumingRound ? resolvedSessionProvenance : null);

  return {
    roundRecord: {
      round,
      resumeMethod,
      startedAt: new Date().toISOString(),
      verdict: null,
      probesGreen: false,
      modelEntry: job.modelEntry || null,
      modelVariant: job.modelVariant || null,
      fallbacks: job.fallbacks || null,
      implementJobId: job.id,
      sessionID: job.sessionID,
      implementUsage: job.usage || null,
      // Failure TEXT on the round record (kusabi #373): a job that ended in
      // status error must be distinguishable without opening job.json.  Written
      // only when present so a healthy round's record is unchanged.
      ...(job.error ? { implementJobError: job.error } : {}),
      // The parsed refusal descriptor, stamped at parse time (see above);
      // null when the report carried no block -- the ordinary case.  The
      // caller still decides what it means: whether a refusal is genuine
      // depends on the change set, which this phase has not measured yet.
      implementRefusal,
      // Closed terminal reason (kusabi #380): at this point the implement job
      // is folded into the round record but the chain layer has not yet
      // measured substance (worktreeChanged is unmeasured here, so a
      // completed job records "completed").  finishRound re-derives this with
      // the measured substance signal so empty rounds land as infra-death /
      // empty-completion.
      stopReason: deriveStopReason({
        status: job.status,
        stats: job.stats,
        worktreeChanged: null,
      }),
    },
    implementJobStatus: job.status,
    implementJobSteps: (job.stats && typeof job.stats.steps === "number") ? job.stats.steps : 0,
    implementJobError: job.error || null,
    // Structured terminal-failure classification (kusabi #215): null for
    // generic failures; { kind: "quota-exhaustion", ... } when the dispatch
    // classified the terminal payload.  The chain's provider-exhaustion
    // renderer uses it to show the classification instead of the generic
    // capacity advice.
    implementJobFailure: job.failure || classifyDispatchQuotaExhaustion(job.error) || null,
    // The parsed refusal block (kusabi #293), or null when the report carried
    // none -- the ordinary case.  The caller decides what it means; whether a
    // refusal is genuine depends on the change set, which this phase has not
    // measured yet.
    implementRefusal,
    session: reportedSession,
    sessionProvenance: reportedProvenance,
  };
}

/**
 * Run deterministic probes P1–P6 via sunaba-rpc.
 *
 * Returns probe results and side data needed by the review phase, plus
 * `oracleViolation` — the P5/P6 marker that routes the round to `escalate`
 * (kusabi #197).  It is `false` when no oracle probe was violated, and a
 * string naming every violation when one was.
 */
export async function runProbePhase({ baseSha, container, brief, callTool, worktreeBaseline, verifyBaseline }) {
  const chainDeliverables = parseDeliverables(brief);
  let probesGreen = false;
  const probeResults = [];
  let chainChangedPaths = [];
  let chainNewlyChanged = [];
  let worktreeChanged = null;
  let chainStatusObserved = false;
  let chainStatusOutput = "";
  let chainStatusTruncation = null;
  let changeScope = null;

  try {
    if (baseSha) {
      changeScope = await collectChangeScope({
        callTool,
        container,
        base: baseSha,
        head: "HEAD",
      });
    }

    const p1Result = await runHeadCleanProbe({ baseSha, callTool, container, sourceLabel: "chain" });
    probeResults.push(p1Result);

    const p2Result = await runVerifyProbe({ callTool, container, baseline: verifyBaseline });
    probeResults.push(p2Result);

    const p3Result = await runDeliverablesProbe({
      deliverables: chainDeliverables,
      headingPresent: hasSectionHeading(brief, "Deliverables"),
      callTool,
      container,
      baseline: worktreeBaseline,
    });
    chainChangedPaths = p3Result.changedPaths;
    // `newlyChangedPaths` is null when the comparison could not be made — the
    // chain-start baseline is missing, or this round's capture failed.  Either
    // way the answer is "unknown", and unknown must not be read as "nothing
    // changed": that would discard a round because the measurement broke.  Fall
    // back to the full changed set, which is what the probe used before
    // baselines existed.
    chainNewlyChanged = p3Result.newlyChangedPaths ?? chainChangedPaths;
    worktreeChanged = p3Result.worktreeChanged;
    chainStatusOutput = p3Result.statusOutput;
    chainStatusTruncation = p3Result.statusTruncation ?? null;
    chainStatusObserved = true;
    probeResults.push(p3Result);

    const chainSmokeEntries = parseSmoke(brief);
    const chainSmokeHeadingPresent = hasSectionHeading(brief, "Smoke");
    const p4Result = await runSmokeProbe({
      entries: chainSmokeEntries,
      callTool,
      container,
      headingPresent: chainSmokeHeadingPresent,
    });
    probeResults.push(p4Result);

    // ---- P5: frozen (kusabi #197) ----
    // Reuses the round's newly-changed set exactly as computed above,
    // fallback rule included: there is one change-collection mechanism in the
    // chain and this is not a second one.
    const p5Result = runFrozenProbe({
      frozen: parseFrozenTests(brief),
      headingPresent: hasSectionHeading(brief, "Frozen Tests"),
      changedPaths: chainNewlyChanged,
    });
    probeResults.push(p5Result);

    // ---- P6: collected (kusabi #197) ----
    // Reads P2's count.  No second verify_in_container call is issued: the
    // round already paid for that run.
    const p6Result = runCollectedProbe({
      collected: p2Result.collected ?? null,
      baselineCollected: verifyBaseline?.captured === true
        ? (verifyBaseline.collected ?? null)
        : null,
    });
    probeResults.push(p6Result);

    probesGreen = probeResults.every(function (p) { return p.passed; });
  } catch (probeErr) {
    probeResults.push({ probe: "sunaba-rpc", passed: false, detail: String(probeErr) });
    probesGreen = false;
  }

  // Base log + untracked for review context (read-only; failures yield
  // empty strings, never errors).
  const baseCtx = await collectContainerBaseContext(callTool, container);

  return {
    probesGreen, probeResults, chainChangedPaths, chainNewlyChanged,
    chainStatusObserved, chainStatusOutput,
    chainBaseLog: baseCtx.chainBaseLog, chainDeliverables,
    chainUntracked: baseCtx.chainUntracked,
    chainTruncation: { ...baseCtx.chainTruncation, status: chainStatusTruncation },
    worktreeChanged,
    // A probe-phase exception is not an oracle violation: it means the round
    // could not be measured, which probesGreen=false already routes.  Only a
    // P5/P6 result that actually fired sets this.
    oracleViolation: summariseOracleViolations(probeResults),
    changeScope,
  };
}


/**
 * Collect the container-side context the review prompt renders: the base log
 * and the untracked files, each with what sandbox_exec reported about its own
 * paging.  Read-only sandbox_exec calls; every failure yields an empty string
 * rather than an error.
 *
 * The working diff used to be captured here too and inlined into the review
 * input.  It was one default-paged `sandbox_exec` call, so what the reviewer
 * received was page one and nothing else -- a truncated, cruder copy of a
 * diff the reviewer fetches itself with `diff_in_container` anyway.  The
 * capture is gone rather than widened (kusabi #208); what the reviewer cannot
 * work out for itself is the base, and that it still gets.
 *
 * @param {Function} callTool   The RPC callTool function (injectable).
 * @param {string}   container  Container ID.
 * @returns {Promise<{ chainBaseLog: string, chainUntracked: string,
 *   chainTruncation: { baseLog: object|null, untracked: object|null } }>}
 */
export async function collectContainerBaseContext(callTool, container) {
  // Base log for review context (own try/catch so failure does not affect probesGreen).
  // `git log --oneline -5` is five lines by construction: it is captured for
  // truncation the same way as the lists, but it cannot page.
  let chainBaseLog = "";
  let baseLogTruncation = null;
  try {
    const baseLogResult = await callTool("sandbox_exec", {
      container_id: container,
      commands: ["git log --oneline -5"],
    });
    const capture = readExecCapture(baseLogResult);
    chainBaseLog = capture.text;
    baseLogTruncation = capture.truncation;
  } catch { /* chainBaseLog stays "" */ }

  // Untracked files for review context (own try/catch).  This list has no
  // bound -- a round that adds 60 files pages -- so its paging is recorded and
  // rendered as a truncation label.
  let chainUntracked = "";
  let untrackedTruncation = null;
  try {
    const untrackedResult = await callTool("sandbox_exec", {
      container_id: container,
      commands: ["git ls-files --others --exclude-standard"],
    });
    const capture = readExecCapture(untrackedResult);
    chainUntracked = capture.text;
    untrackedTruncation = capture.truncation;
  } catch { /* chainUntracked stays "" */ }

  return {
    chainBaseLog,
    chainUntracked,
    chainTruncation: { baseLog: baseLogTruncation, untracked: untrackedTruncation },
  };
}

export const CHANGE_SCOPE_CONTAINER_PATH = "/tmp/kusabi-change-scope.mjs";
export const CHANGE_SCOPE_HOST_PATH = fileURLToPath(new URL("change-scope.mjs", import.meta.url));

/**
 * Run `change-scope.mjs` in the container to collect the authoritative change scope (kusabi #379, #400).
 * Injects the companion script to /tmp/kusabi-change-scope.mjs outside /workspace and executes it with argv.
 * Fails closed on inject failure, non-zero exit, empty stdout, or invalid JSON/contract.
 *
 * @param {object} opts
 * @param {Function} opts.callTool
 * @param {string} opts.container
 * @param {string} opts.base Commit SHA the change set is measured against.
 * @param {string} [opts.head="HEAD"] Pre-reset HEAD ref or commit.
 * @returns {Promise<object>} The parsed changeScope object (formatVersion: 1).
 * @throws {Error} when injection or collection fails or produces invalid JSON
 */
export async function collectChangeScope({ callTool, container, base, head = "HEAD" }) {
  if (!base) {
    throw new Error("change-scope: base commit ref must be provided");
  }

  if (!fs.existsSync(CHANGE_SCOPE_HOST_PATH)) {
    throw new Error(`change-scope companion script missing at ${CHANGE_SCOPE_HOST_PATH}`);
  }

  try {
    const injectResult = await callTool("copy_file", {
      container_id: container,
      local_src_file: CHANGE_SCOPE_HOST_PATH,
      dest_path: CHANGE_SCOPE_CONTAINER_PATH,
    });
    if (injectResult && (injectResult.error || injectResult.status === "error" || (typeof injectResult.exit_code === "number" && injectResult.exit_code !== 0))) {
      const detail = (injectResult.error || injectResult.stderr || injectResult.output || "").trim();
      throw new Error(detail || "copy_file returned error");
    }
  } catch (err) {
    throw new Error(`change-scope inject failed in container ${container}: ${err.message}`);
  }

  let execResult;
  try {
    execResult = await callTool("sandbox_exec", {
      container_id: container,
      argv: ["node", CHANGE_SCOPE_CONTAINER_PATH, "--base", base, "--head", head],
    });
  } catch (err) {
    // If a mock callTool throws TypeError (e.g. legacy test stubs expecting params.commands[0]),
    // retry with commands so those older suites do not crash on undefined params.commands
    if (err instanceof TypeError) {
      try {
        execResult = await callTool("sandbox_exec", {
          container_id: container,
          commands: [`node ${CHANGE_SCOPE_CONTAINER_PATH} --base ${base} --head ${head}`],
        });
      } catch (fallbackErr) {
        throw new Error(`change-scope failed in container ${container}: ${fallbackErr.message}`);
      }
    } else {
      throw new Error(`change-scope failed in container ${container}: ${err.message}`);
    }
  }

  if (execResult && typeof execResult.exit_code === "number" && execResult.exit_code !== 0) {
    const detail = (execResult.error || execResult.stderr || execResult.output || "").trim();
    throw new Error(`change-scope failed with exit code ${execResult.exit_code}: ${detail}`);
  }

  const raw = (execResult?.output ?? "").trim();
  if (!raw) {
    const detail = (execResult?.error || execResult?.stderr || "").trim();
    throw new Error(`change-scope produced empty output${detail ? `: ${detail}` : ""}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`change-scope produced invalid JSON: ${err.message}`);
  }

  if (!parsed || parsed.formatVersion !== 1 || !parsed.resolved || !parsed.paths) {
    throw new Error(`change-scope JSON contract mismatch (formatVersion must be 1): ${raw.slice(0, 100)}`);
  }

  return parsed;
}

// A base ref is interpolated into a single-quoted shell word inside the
// container, so the character set is restricted to what git refs and object
// expressions actually use.  Anything else -- quotes, spaces, `$`, `;`, `&` --
// is rejected rather than escaped: an unusable ref must fail loudly, never be
// mangled into a diff of something else.
const BASE_REF_PATTERN = /^[A-Za-z0-9._@\/^~{}:+-]+$/;

/**
 * Validate a user-supplied base ref before it reaches a shell command.
 *
 * @param {string} base
 * @throws {Error} when the ref contains characters outside BASE_REF_PATTERN.
 */
export function assertContainerBaseRef(base) {
  if (!BASE_REF_PATTERN.test(base)) {
    throw new Error(`--base ${base} is not a usable git revision (allowed characters: letters, digits and ._@/^~{}:+-)`);
  }
}

/**
 * Build the reviewer's input for a container review, reading the container
 * through the existing sunaba RPC tooling (kusabi #204).
 *
 * This is the collection half of the container review input; the rendering
 * half is `renderContainerReviewInput`.  The chain's review phase already has
 * these facts from its probes and renders them directly, so it does not call
 * this; `task --phase review --container <cid>` does, because nothing else on
 * that path reads the container's git state before the job is dispatched.
 *
 * `base`:
 *   - null (the chain's default) -- base commit is HEAD, exactly what the
 *     chain's review renders.
 *   - a ref -- base commit is that ref resolved to a sha.
 *
 * Either way the base commit is the ref the rendered input names as the one
 * to diff against; the diff body itself is no longer captured or inlined
 * (kusabi #208), so `base` reaches the reviewer as an instruction rather than
 * as a truncated `git diff` capture.
 *
 * An unusable `--base` throws: the caller asked for a specific comparison and
 * silently reviewing a different one (or nothing) is the failure mode this
 * whole change exists to remove.  Every OTHER read degrades to "(unavailable)"
 * the way the chain's does -- a flaky container must not abort the review.
 *
 * @param {object}   opts
 * @param {string}   opts.container
 * @param {Function} opts.callTool        RPC callTool (injectable).
 * @param {string|null} [opts.base=null]  Ref the review is measured against.
 * @returns {Promise<string>} The rendered review input.
 * @throws {Error} when `base` is malformed or does not resolve in the container.
 */
export async function collectContainerReviewInput({ container, callTool, base = null, changeScope = undefined }) {
  let baseSha = "";
  if (base) {
    assertContainerBaseRef(base);
    // `|| echo <sentinel>` keeps the exit status zero so the transport reports
    // the outcome in the output rather than as an RPC-level failure.
    let revOutput;
    try {
      const revResult = await callTool("sandbox_exec", {
        container_id: container,
        commands: [`git rev-parse --verify --quiet '${base}^{commit}' || echo __KUSABI_BASE_UNRESOLVED__`],
      });
      revOutput = (revResult?.output ?? "").trim();
    } catch (err) {
      throw new Error(`--base ${base} could not be resolved in container ${container}: ${err.message}`);
    }
    if (!revOutput || revOutput.includes("__KUSABI_BASE_UNRESOLVED__")) {
      throw new Error(`--base ${base} is not a valid revision in container ${container}`);
    }
    baseSha = revOutput.split("\n").pop().trim();
  } else {
    try {
      const headResult = await callTool("sandbox_exec", {
        container_id: container,
        commands: ["git rev-parse HEAD"],
      });
      baseSha = (headResult?.output ?? "").trim();
    } catch { /* baseSha stays "" -> renderBaseFacts says "(unavailable)" */ }
  }

  let effectiveChangeScope = null;
  if (changeScope !== false && changeScope !== null) {
    if (changeScope) {
      effectiveChangeScope = changeScope;
    } else if (baseSha) {
      effectiveChangeScope = await collectChangeScope({
        callTool,
        container,
        base: baseSha,
        head: "HEAD",
      });
    }
  }

  let statusOutput = "";
  let statusTruncation = null;
  try {
    const statusResult = await callTool("sandbox_exec", {
      container_id: container,
      commands: ["git status --porcelain"],
    });
    const capture = readExecCapture(statusResult);
    statusOutput = capture.text;
    statusTruncation = capture.truncation;
  } catch { /* statusOutput stays "" -> "(empty change set)" */ }

  const baseCtx = await collectContainerBaseContext(callTool, container);

  return renderContainerReviewInput({
    container,
    baseSha: effectiveChangeScope?.resolved?.baseSha ?? baseSha,
    baseLog: baseCtx.chainBaseLog,
    statusOutput,
    untrackedFiles: baseCtx.chainUntracked,
    truncation: { ...baseCtx.chainTruncation, status: statusTruncation },
    changeScope: effectiveChangeScope,
  });
}

/**
 * Collect the review-phase context for a round WITHOUT running the probes.
 *
 * Used by chain-resume (kusabi #153①) when a cancelled chain resumes at the
 * review phase of an interrupted round: the probes already ran and their
 * results are on the persisted round record; only the context the review
 * prompt renders (status, base log, untracked) is re-collected from
 * the container.
 *
 * `worktreeBaseline` should be null here: the interrupted round's changes ARE
 * the review target, and comparing them against a baseline captured at resume
 * time would read as "nothing changed since baseline" and skip the review
 * entirely (shouldSkipReview discards an empty change set).
 *
 * @param {object}  opts
 * @param {string}  opts.container
 * @param {string}  opts.brief
 * @param {Function} opts.callTool
 * @param {object|null} [opts.worktreeBaseline=null]
 * @returns {Promise<object>} The same context fields runProbePhase returns
 *   minus the probe results (probesGreen / probeResults).
 */
export async function collectReviewContext({ container, brief, callTool, worktreeBaseline = null }) {
  const chainDeliverables = parseDeliverables(brief);
  // Degraded-container guard (#153① review): this runs on the RECOVERY path,
  // so a transient container/RPC failure here must degrade, not throw the
  // resumed chain into the terminal "failed" state.  Mirror runProbePhase:
  // on failure the status was NOT observed (chainStatusObserved=false), which
  // shouldSkipReview never reads as "nothing changed" — the review still runs.
  let chainChangedPaths = [];
  let chainNewlyChanged = [];
  let worktreeChanged = false;
  let chainStatusOutput = "";
  let chainStatusTruncation = null;
  let chainStatusObserved = false;
  try {
    const p3Result = await runDeliverablesProbe({
      deliverables: chainDeliverables,
      headingPresent: hasSectionHeading(brief, "Deliverables"),
      callTool,
      container,
      baseline: worktreeBaseline,
    });
    chainChangedPaths = p3Result.changedPaths;
    // `newlyChangedPaths` is null when the comparison could not be made — fall
    // back to the full changed set (same rule as runProbePhase).
    chainNewlyChanged = p3Result.newlyChangedPaths ?? chainChangedPaths;
    worktreeChanged = p3Result.worktreeChanged;
    chainStatusOutput = p3Result.statusOutput;
    chainStatusTruncation = p3Result.statusTruncation ?? null;
    chainStatusObserved = true;
  } catch {
    // Degraded: fields keep their "unknown" defaults.
  }
  const baseCtx = await collectContainerBaseContext(callTool, container);

  return {
    chainChangedPaths,
    chainNewlyChanged,
    chainStatusObserved,
    chainStatusOutput,
    chainBaseLog: baseCtx.chainBaseLog,
    chainDeliverables,
    chainUntracked: baseCtx.chainUntracked,
    chainTruncation: { ...baseCtx.chainTruncation, status: chainStatusTruncation },
    worktreeChanged,
  };
}

/**
 * Every field on a round record that describes the ROUND'S REVIEW, and that a
 * replacement review seat (kusabi #248) therefore rewrites.
 *
 * The list must stay complete, because several of these are written only
 * CONDITIONALLY by runReviewPhase — `reviewPartial` only when the stream was
 * partial, `verdictSource` only when the result was unparseable, the
 * `reviewFirst*` trio only when the unparseable retry fired.  A field left
 * behind would keep describing the DEAD seat next to the replacement's
 * verdict: a clean `approve` still flagged partial, or sourced
 * "recovered-from-token".  That is exactly the fail-open edge this feature
 * must not add, so archiving CLEARS them rather than trusting the overwrite.
 */
const REVIEW_SEAT_RECORD_FIELDS = [
  "verdict", "verdictSource", "reviewParseable", "salvagedVerdict",
  "reviewPartial", "reviewFindingCount", "reviewPartialDiagnosis",
  "reviewJobId", "reviewUsage", "reviewModelEntry", "reviewModelVariant",
  "reviewFallbacks", "reviewJobFailure", "reviewJobError",
  "reviewUnparseableRetried", "reviewSchemaRepaired", "reviewFirstJobId", "reviewFirstUsage", "reviewFirstFallbacks",
  "findingsText", "findings", "findingFiles",
  "disposition",
];

/**
 * Move a round record's FAILED review seat into `reviewSeatFailures` and clear
 * the live review fields, so a replacement seat (kusabi #248) can write its
 * own verdict without the dead seat's state surviving underneath it.
 *
 * The failed seat is preserved, never silently overwritten: the record keeps
 * saying that a first review died and how (`verdict`, its escalate
 * disposition, its job id and spend), and chain-show renders both it and the
 * replacement verdict.  The round itself is NOT duplicated — the same record
 * object is continued in place, so metrics ingest still sees one round row.
 *
 * Called by the driver's review-resume branch, once, immediately before the
 * replacement review is dispatched.  Idempotent in shape (repeated seat
 * failures append), so a chain that burns a second seat archives that one too.
 *
 * @param {object} roundRecord — the round record being resumed, mutated in place.
 * @returns {object} the same record.
 */
export function archiveFailedReviewSeat(roundRecord) {
  if (!roundRecord || typeof roundRecord !== "object") return roundRecord;
  if (!Array.isArray(roundRecord.reviewSeatFailures)) roundRecord.reviewSeatFailures = [];

  const seat = { seat: roundRecord.reviewSeatFailures.length + 1 };
  for (const field of REVIEW_SEAT_RECORD_FIELDS) {
    if (roundRecord[field] !== undefined) seat[field] = roundRecord[field];
    delete roundRecord[field];
  }
  roundRecord.reviewSeatFailures.push(seat);
  return roundRecord;
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

// =========================================================================
// Chain resume (kusabi #153①) — resume-position resolution
// =========================================================================

// ---- replacement review seat (kusabi #248) ------------------------------
//
// A chain can terminate on `escalate` for two very different reasons: the
// review JUDGED the work and found it wanting, or the review SEAT itself died
// mid-stream and never produced a judgement.  Only the second is a spent seat
// over an intact implementation, and only it may be re-bought by chain-resume.
//
// The two seat-failure states the review parser can produce (`partial`,
// `unparseable`) each escalate through deriveDisposition with a reason
// starting with one of these base strings (suffixed by partialDiagnosis
// when available, kusabi #312); the map is keyed by verdict so a seat-failure
// verdict carrying the other verdict's reason reads as inconsistent records,
// not as eligible.
// `needs-attention` and `discard` are deliberately absent: those are completed
// reviews judging the work, and they keep today's refusal.
const REVIEW_SEAT_FAILURE_REASONS = {
  partial: "partial review: stream ended before the verdict line",
  unparseable: "unexpected verdict: unparseable",
};

// The deterministic probes a replacement seat requires a record to COVER.
// runProbePhase always records at least these four (P1 HEAD clean / P2 verify
// gate / P3 deliverables / P4 smoke) on a run that got far enough to be green;
// a shorter list means the probe phase threw partway, so the record cannot
// testify that the work is intact.
//
// P5/P6 (kusabi #197) are deliberately NOT added here: this is a coverage
// floor, and records written before those probes existed must stay resumable.
// It costs nothing in strictness — the all-green check below runs over EVERY
// entry the record holds, so a red P5 disqualifies a seat replacement whether
// or not P5 is named in this list.
const REVIEW_SEAT_PROBES = ["P1", "P2", "P3", "P4"];

/** Not a seat failure at all — the caller keeps its existing refusal verbatim. */
const NOT_A_SEAT_FAILURE = Object.freeze({ eligible: false, detail: null });

/** Seat-failure SHAPE, but the records cannot decide it — name the field. */
function seatRecordsUndecidable(detail) {
  return { eligible: false, detail };
}

/** Append a fail-closed detail to a refusal, when there is one. */
function withSeatDetail(error, detail) {
  return detail ? `${error} — ${detail}` : error;
}

/**
 * Decide whether a chain's FINAL round may buy a replacement review seat
 * (kusabi #248).  Pure: reads only the persisted records, never an LLM and
 * never the worktree.
 *
 * Eligible iff all four hold for the last round record:
 *   1. probes P1–P4 all green,
 *   2. the review verdict is `partial` or `unparseable` (a dead seat — NOT
 *      `needs-attention`, which is a completed review judging the work),
 *   3. the escalate came from that seat failure (not discard, not max-rounds,
 *      not repeated-areas — each of those carries a different
 *      `disposition.reason`),
 *   4. the records needed to decide 1–3 are present and unambiguous.
 *
 * Fail closed (the resume guard's #192 history): a missing or ambiguous field
 * refuses and NAMES the field.  The two negative results are distinct on
 * purpose — `detail: null` means "this escalate was never a seat failure", so
 * the caller's existing refusal stands verbatim; a non-null `detail` means
 * "seat-failure shaped, but undecidable", and it is appended to that refusal.
 *
 * @param {object|null} chainJson — chain.json record.
 * @param {object} [opts]
 * @param {{ backend?: string|null, model?: string|null }|null} [opts.explicitRoute]
 *        — operator-named replacement route (chain-resume `--backend` /
 *        `--model`).  A quota-exhausted seat is never eligible on the SAME
 *        route (kusabi #373); an explicit different route may buy a new seat.
 * @returns {{ eligible: boolean, detail: string|null }}
 */
export function classifyReviewSeatReplacement(chainJson, { explicitRoute } = {}) {
  const records = Array.isArray(chainJson?.records) ? chainJson.records : [];
  const last = records.length > 0 ? records[records.length - 1] : null;
  if (!last || typeof last !== "object") return NOT_A_SEAT_FAILURE;
  if (last.disposition?.disposition !== "escalate") return NOT_A_SEAT_FAILURE;

  // Quota exhaustion is not an unreadable payload (kusabi #373): buying the
  // same seat cannot work.  An explicit different route is the one exception.
  const quota = recordQuotaExhaustion(last);
  const reroutingQuota = quota && explicitRouteDiffersFromRecord(last, explicitRoute);
  if (quota && !reroutingQuota) {
    return seatRecordsUndecidable(quotaReplacementRefusal(quota));
  }

  // The round number addresses the phase the driver re-dispatches; a record
  // that cannot name its own round has no position to resume at.
  if (!Number.isInteger(last.round) || last.round < 1) {
    return seatRecordsUndecidable(
      "the final round record has no usable `round` number — there is no position to resume at"
    );
  }
  const where = `round ${last.round}`;

  // ---- condition 2: a dead SEAT, not a review judgement ----
  // Skipped when rerouting a quota-dead seat: the disposition reason names
  // the exhausted pool, not `unexpected verdict: unparseable`, so the
  // verdict/reason pairing below would refuse a route the operator just named.
  if (!reroutingQuota) {
  const verdict = last.verdict;
  if (typeof verdict !== "string" || verdict === "") {
    return seatRecordsUndecidable(
      "the final round record has no review `verdict` — a dead review seat cannot be told from a completed review"
    );
  }
  const expectedReason = Object.prototype.hasOwnProperty.call(REVIEW_SEAT_FAILURE_REASONS, verdict)
    ? REVIEW_SEAT_FAILURE_REASONS[verdict]
    : null;
  // approve / approve-partial / needs-attention / discard and anything else:
  // a completed review, so this escalate is not a spent seat.
  if (!expectedReason) return NOT_A_SEAT_FAILURE;

  // ---- condition 3: the escalate came from THAT seat failure ----
  const reason = last.disposition?.reason;
  if (typeof reason !== "string" || reason === "") {
    return seatRecordsUndecidable(
      `${where} record has no \`disposition.reason\` — the escalate cause cannot be established`
    );
  }
  if (!reason.startsWith(expectedReason)) {
    // The OTHER seat-failure reason next to this verdict is contradictory
    // records; anything else (max-rounds, discard, repeated areas) is simply
    // a different escalate, which keeps the refusal verbatim.
    const isOtherSeatFailure = Object.entries(REVIEW_SEAT_FAILURE_REASONS).some(
      ([otherVerdict, otherBase]) => otherVerdict !== verdict && reason.startsWith(otherBase)
    );
    return isOtherSeatFailure
      ? seatRecordsUndecidable(
        `${where} record is inconsistent: verdict \`${verdict}\` with \`disposition.reason\` "${reason}"`
      )
      : NOT_A_SEAT_FAILURE;
  }
  } // !reroutingQuota: verdict/reason pairing

  // A replacement review judges an implementation; there must be one.
  if (typeof last.implementJobId !== "string" || !last.implementJobId) {
    return seatRecordsUndecidable(
      `${where} record has no \`implementJobId\` — there is no implementation for a replacement review to judge`
    );
  }

  // ---- condition 1: probes P1–P4 all green ----
  const probeResults = last.probeResults;
  if (!Array.isArray(probeResults) || probeResults.length === 0) {
    return seatRecordsUndecidable(
      `${where} record has no \`probeResults\` — P1–P4 cannot be confirmed green`
    );
  }
  const probeLabels = probeResults.map(function (p) {
    return typeof p?.probe === "string" ? p.probe.split(":")[0].trim() : "";
  });
  const missingProbes = REVIEW_SEAT_PROBES.filter(function (p) { return !probeLabels.includes(p); });
  if (missingProbes.length > 0) {
    return seatRecordsUndecidable(
      `${where} \`probeResults\` does not cover ${missingProbes.join(", ")} — P1–P4 cannot be confirmed green`
    );
  }
  const redProbes = probeResults.filter(function (p) { return p?.passed !== true; });
  if (redProbes.length > 0) {
    const names = redProbes.map(function (p) { return typeof p?.probe === "string" ? p.probe : "(unnamed)"; });
    return seatRecordsUndecidable(
      `${where} \`probeResults\` is not all green (${names.join(", ")}) — the work is not known intact`
    );
  }
  // The summary flag must agree with the entries: `probesGreen` is what the
  // disposition machinery read, so a disagreement is ambiguous records.
  if (last.probesGreen !== true) {
    return seatRecordsUndecidable(
      `${where} record has \`probesGreen\`: ${JSON.stringify(last.probesGreen ?? null)} — a replacement review seat requires green P1–P4`
    );
  }

  return { eligible: true, detail: null };
}

/**
 * Decide where a stopped chain resumes, from its persisted state alone.
 *
 * Pure function: reads nothing, writes nothing.  The caller still validates
 * container reachability before re-running (a resumed chain's work lives in
 * the recorded container; the state root is machine-local).
 *
 * Preconditions (explicit errors for everything else):
 *   - The chain must be stopped: status "cancelled", or "running" with a dead
 *     pid (stale — abnormal stop).  A live process (running / stopping) and
 *     any finished status (completed / failed) are errors — with the single
 *     replacement-review-seat exception below, which is decided BEFORE this
 *     gate because such a chain finished normally (status "completed").
 *
 * Resume position, from the LAST round record in chain.json:
 *   - Last record has implement done but no review/disposition (an
 *     interrupted round persisted at stop time) → resume at that round's
 *     REVIEW phase, continuing the persisted partial record.
 *   - Last record is complete with disposition rework/strategize → resume at
 *     the NEXT round's IMPLEMENT phase (rework: with the escalated
 *     tier/reworkCount; strategize: with the fresh-session lever from the
 *     record's pendingReworkStrategy).
 *   - Terminal dispositions (accept / accept-with-followup / escalate) mean
 *     the chain already finished — error.  ONE exception (kusabi #248): an
 *     `escalate` that classifyReviewSeatReplacement finds eligible — probes
 *     P1–P4 green, verdict `partial`/`unparseable`, and that seat failure is
 *     the recorded escalate cause — resumes at the SAME round's REVIEW phase
 *     to buy a replacement seat.  Never implement: the implementation is
 *     intact and only the seat was consumed, so no round-budget slot is spent
 *     (the return sits before the budget-derived guard).
 *
 * Cross-round state (reworkCount, currentTierIndex, strategized, session,
 * baseSha) is derived from the record fields so the resumed run continues the
 * ladder exactly where the original left off.
 *
 * `currentTierIndex` addresses the chain the NEXT round dispatches on
 * (kusabi #192 axis 2): the implement chain for a round-1 resume, the REWORK
 * chain from round 2 on when a models.phases.rework chain was configured
 * (rework rounds run the tier ladder over the rework chain; the persisted
 * tierAfter/tierBefore were recorded against it).  The driver re-dispatches
 * rework rounds on the rework resolution restored from chain.json, so the
 * index is applied to the same chain it was recorded against.
 *
 * @param {object}  opts
 * @param {object|null} opts.control    — control.json record.
 * @param {object|null} opts.chainJson  — chain.json record.
 * @returns {{ ok: true, position: object } | { ok: false, error: string }}
 *   `position`:
 *   - `phase`        — "review" | "implement"
 *   - `round`        — round to continue at
 *   - `roundRecord`  — the persisted partial record (review-resume only)
 *   - `records`      — chain.json records array (continued in place)
 *   - `reviewSeatReplacement` — true only for the kusabi #248 escalate
 *     exception; tells the driver to archive the failed seat on the record
 *     before dispatching the replacement review
 *   - `reworkCount`, `currentTierIndex`, `strategized`, `session`, `baseSha`
 */
export function resolveChainResume({ control, chainJson, explicitRoute = null }) {
  if (!control) {
    return { ok: false, error: "no control record (control.json missing)" };
  }
  if (!chainJson) {
    return { ok: false, error: "no chain.json (nothing was persisted)" };
  }

  const { status, stale } = effectiveStatus(control);
  if (status === "running" || status === "stopping") {
    return {
      ok: false,
      error: `chain is still running (pid ${control.pid}) — stop it first (chain-cancel)`,
    };
  }

  // Replacement review seat (kusabi #248), classified from the records alone
  // and BEFORE the finished-status gate: a chain that escalated on a dead
  // review seat finished NORMALLY (status "completed"), so the gate below
  // would refuse it before the disposition branch ever ran.  `detail` is the
  // fail-closed field name for a seat-shaped escalate whose records cannot
  // decide it; it is null for every other chain, leaving the refusals verbatim.
  const seat = classifyReviewSeatReplacement(chainJson, { explicitRoute });

  if (status !== "cancelled" && !stale && !seat.eligible) {
    return {
      ok: false,
      error: withSeatDetail(`chain already finished (status: ${status})`, seat.detail),
    };
  }

  if (!Array.isArray(chainJson.modelChain) || chainJson.modelChain.length === 0) {
    return { ok: false, error: "chain.json has no modelChain to dispatch with" };
  }
  if (typeof chainJson.brief !== "string" || !chainJson.brief.trim()) {
    return { ok: false, error: "chain.json has no brief to continue with" };
  }

  const maxRounds = Number.isInteger(chainJson.maxRounds) && chainJson.maxRounds > 0
    ? chainJson.maxRounds
    : 4;
  const records = Array.isArray(chainJson.records) ? chainJson.records : [];
  const last = records.length > 0 ? records[records.length - 1] : null;
  const strategized = !!chainJson.strategized;
  const baseSha = chainJson.baseSha ?? null;

  if (!last) {
    return {
      ok: false,
      error: "no round records to resume from (the chain stopped before completing a round)",
    };
  }

  const lastDisposition = last.disposition?.disposition;
  if (lastDisposition) {
    // ---- replacement review seat (kusabi #248) ----
    // The ONE terminal disposition that is resumable: an escalate caused by a
    // dead review seat over green probes.  The resume dispatches the SAME
    // round's REVIEW phase in a fresh session (each phase is a new session;
    // review seats are never reused) — never implement, which is why this
    // returns a review position instead of falling through to the
    // next-round/implement path.  It also returns BEFORE the budget-derived
    // guard below: the round already spent its slot, and re-buying its review
    // spends no new one.
    if (lastDisposition === "escalate" && seat.eligible) {
      return {
        ok: true,
        position: {
          phase: "review",
          round: last.round,
          roundRecord: last,
          records,
          reviewSeatReplacement: true,
          reworkCount: last.reworkCount ?? 0,
          currentTierIndex: last.tierBefore ?? 0,
          strategized,
          session: last.sessionID ?? undefined,
          baseSha,
        },
      };
    }
    if (lastDisposition === "accept" || lastDisposition === "accept-with-followup" || lastDisposition === "escalate") {
      return {
        ok: false,
        error: withSeatDetail(
          `chain already finished (last round ${last.round} disposition: ${lastDisposition})`,
          seat.detail,
        ),
      };
    }
    // A refused-brief-defect ends the chain as terminal (kusabi #293): the
    // brief itself is defective, so resuming would only re-run the same
    // defective brief.  Refuse regardless of control freshness -- even a
    // stale control must not re-dispatch implement on a defective brief.
    if (lastDisposition === "refused-brief-defect") {
      return {
        ok: false,
        error: `chain ended in refused-brief-defect at round ${last.round} \u2014 the brief is defective; fix the brief and re-dispatch a new chain (resume would re-run the same defective brief)`,
      };
    }
    const nextRound = (last.round ?? records.length) + 1;
    // ---- budget-derived guard (kusabi #60 step 2) ----
    // Mirrors the driver's budget semantics: maxRounds buys design/full
    // rounds only, mechanical rounds are free, so the raw round number may
    // legitimately exceed maxRounds (hard cap 2 × maxRounds).  Resume is
    // refused only when the derived budget is spent or the hard cap would be
    // exceeded — never on the raw round count alone.
    //
    // Records without a `reworkScope` field predate the scheduling change;
    // for such chains the round number IS the budget (every round was full),
    // so the legacy guard applies: nextRound > maxRounds means the budget is
    // spent.  Once any record carries `reworkScope`, the budget is derived
    // by counting non-mechanical records exactly as the driver does.
    const anyScoped = records.some((r) => r.reworkScope !== undefined);
    const budgetExhausted = anyScoped
      ? records.filter((r) => r.reworkScope !== "mechanical").length >= maxRounds
        || nextRound > 2 * maxRounds
      : nextRound > maxRounds;
    if (budgetExhausted) {
      return {
        ok: false,
        error: `max rounds (${maxRounds}) already reached at round ${last.round}`,
      };
    }
    return {
      ok: true,
      position: {
        phase: "implement",
        round: nextRound,
        roundRecord: null,
        records,
        // A rework consumed one rework; a strategize did not.
        reworkCount: (last.reworkCount ?? 0) + (lastDisposition === "rework" ? 1 : 0),
        currentTierIndex: last.tierAfter ?? last.tierBefore ?? 0,
        strategized,
        session: last.sessionID ?? undefined,
        baseSha,
      },
    };
  }

  // No disposition → partial (interrupted) round.
  if (!last.implementJobId) {
    return {
      ok: false,
      error: `round ${last.round ?? "?"} record has no implement job — no phase boundary to resume at`,
    };
  }
  if (last.reviewJobId || last.verdict) {
    return {
      ok: false,
      error: `round ${last.round} record is inconsistent (review present but no disposition) — manual inspection required`,
    };
  }
  return {
    ok: true,
    position: {
      phase: "review",
      round: last.round,
      roundRecord: last,
      records,
      reworkCount: last.reworkCount ?? 0,
      currentTierIndex: last.tierBefore ?? 0,
      strategized,
      session: last.sessionID ?? undefined,
      baseSha,
    },
  };
}
