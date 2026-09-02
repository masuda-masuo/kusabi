// chain-outcomes.mjs — Terminal outcome rendering and provider exhaustion
// for cmdChain (kusabi #439).
//
// Pure functions that render operator-facing outcome strings and construct
// the terminal chain state for provider-exhaustion exits.

import {
  renderReview,
  renderFollowupDraft,
  renderEscalationDecisions,
  roundDiscardReason,
  roundChangedColumn,
} from "./render.mjs";
import { computeChainTotals } from "./chain-persist.mjs";

/**
 * Render the outcome string when the chain is accepted.
 */
export function renderAcceptOutcome({ chainId, round, chainParsedReview, chainFindingsText }) {
  const acceptReviewText = chainParsedReview
    ? renderReview(chainParsedReview, chainFindingsText || "")
    : "(no review text available)";
  return "Chain " + chainId + " accepted at round " + round + ".\n\n" + acceptReviewText;
}

/**
 * Render the outcome string for accept-with-followup.
 */
export function renderAcceptWithFollowupOutcome({ chainId, round, chainParsedReview, chainFindingsText, chainFollowupDraft, brief }) {
  const briefTitle = brief ? brief.split("\n")[0].trim() : "";
  const awfDraft = chainFollowupDraft || renderFollowupDraft({
    chainId,
    briefTitle,
    findings: chainParsedReview?.findings || [],
  });
  const awfReviewText = chainParsedReview
    ? renderReview(chainParsedReview, chainFindingsText || "")
    : "(no review text available)";
  return "Chain " + chainId + " accepted-with-followup at round " + round + ".\n\n" + awfReviewText + "\n\n" + awfDraft;
}

/**
 * Render the outcome string for escalation.
 */
export function renderEscalateOutcome({ chainId, round, disposition, orchestrator, roundRecord, records }) {
  // The first line carries the reason an orchestrator reads first.  For a
  // probe-sourced discard the recorded reason is deriveDisposition's generic
  // "reviewer discarded the work" — the wrong thing to hand over over an
  // intact worktree (kusabi #299): say the round was empty and whether the
  // worktree still holds the prior rounds' work.  Reviewer-verdict discards
  // keep the recorded reason.  roundDiscardReason owns the condition.
  const reason = roundDiscardReason(roundRecord, disposition.reason || "unknown");
  const orchLine = orchestrator?.model ? "orchestrator=" + orchestrator.model : "";
  const lines = [
    "Chain " + chainId + " escalated at round " + round + ": " + reason,
    orchLine,
    "",
  ];

  // kusabi #336: carry the decisions, not just a task list. When the terminal
  // round record carries a structured `findings` array, render each finding's
  // body and recommendation as a decision for the orchestrator (severity-
  // ordered, budget-bounded). Old records without `findings` keep the current
  // one-line `findingsText` rendering, and a round with no findings at all
  // states that plainly (the first line's reason already says why).
  const findings = roundRecord?.findings;
  if (Array.isArray(findings) && findings.length > 0) {
    lines.push(renderEscalationDecisions(findings, { roundNumber: round }));
  } else {
    const ft = roundRecord?.findingsText;
    if (ft && typeof ft === "string" && ft.length > 0) {
      lines.push("Remaining findings:");
      lines.push(ft);
    } else {
      lines.push("(no findings recorded for this round)");
    }
  }
  lines.push("");

  for (let ri = 0; ri < records.length; ri++) {
    const r = records[ri];
    const detail = r.resumeMethod.detail ? ": " + r.resumeMethod.detail : "";
    const changed = roundChangedColumn(r);
    lines.push("Round " + (ri + 1) + ": model=" + (r.modelEntry || "?") + ", verdict=" + r.verdict + ", probesGreen=" + r.probesGreen + ", changed=" + changed + ", resume=" + r.resumeMethod.type + detail);
  }
  lines.push("", "Hand over to orchestrator for final judgement.");
  return lines.join("\n");
}

/**
 * Render the outcome string for a qualifying refusal (kusabi #293).
 *
 * Reads like the escalate outcome on purpose -- both hand the chain to the
 * orchestrator -- but says the opposite thing about WHOSE defect it is, and
 * names the two contradicting items on their own lines so the orchestrator
 * can open both without reading the round record.  The absence of findings
 * is stated rather than left blank: this round never ran a review.
 */
export function renderRefusalOutcome({ chainId, round, disposition, orchestrator, roundRecord, records }) {
  const refusal = roundRecord?.refusal || null;
  const orchLine = orchestrator?.model ? "orchestrator=" + orchestrator.model : "";
  const lines = [
    "Chain " + chainId + " refused at round " + round + ": the brief contradicts itself.",
    orchLine,
    "",
    "Contradicting items named by the worker:",
  ];
  const anchors = Array.isArray(refusal?.anchors) ? refusal.anchors : [];
  if (anchors.length > 0) {
    for (const a of anchors) lines.push("- " + a.text + "  [" + a.kind + "]");
  } else {
    // Unreachable through the driver (the disposition requires two named
    // anchors), but a renderer must never present an empty list as a fact.
    lines.push("- (not recorded)");
  }
  lines.push("", "Why they cannot both hold:", refusal?.why || "(not recorded)", "");
  for (let ri = 0; ri < records.length; ri++) {
    const r = records[ri];
    const detail = r.resumeMethod?.detail ? ": " + r.resumeMethod.detail : "";
    const changed = roundChangedColumn(r);
    lines.push("Round " + (ri + 1) + ": model=" + (r.modelEntry || "?") + ", outcome=" + (r.roundOutcome || r.verdict) + ", changed=" + changed + ", resume=" + (r.resumeMethod?.type || "?") + detail);
  }
  lines.push(
    "",
    "No review was dispatched (the round changed nothing) and no rework was spent.",
    "This is a BRIEF defect, not a worker failure: fix the contradiction in the brief " +
      "and dispatch again, or decide which of the two items gives way.",
    disposition?.reason ? "Recorded reason: " + disposition.reason : "",
  );
  return lines.join("\n");
}

/**
 * Render the outcome string for a brief-syntax defect (kusabi #303).
 *
 * Same terminal family as the worker's refusal above -- both hand the chain
 * back to the brief's author -- but the contradiction here was found by a
 * PROBE, not by the worker, so the offending section is named from the probe
 * marker and the round summary is the ordinary one.  The two facts an
 * orchestrator needs first are on their own lines: which section cannot be
 * read, and that no rework was spent because none could have won.
 */
export function renderBriefSyntaxDefectOutcome({ chainId, round, disposition, orchestrator, roundRecord, records }) {
  const orchLine = orchestrator?.model ? "orchestrator=" + orchestrator.model : "";
  const lines = [
    "Chain " + chainId + " stopped at round " + round + ": the brief has a section a probe cannot read.",
    orchLine,
    "",
    "Offending brief section(s):",
    roundRecord?.briefSyntaxDefect || "(not recorded)",
    "",
  ];
  for (let ri = 0; ri < records.length; ri++) {
    const r = records[ri];
    const detail = r.resumeMethod?.detail ? ": " + r.resumeMethod.detail : "";
    const changed = roundChangedColumn(r);
    lines.push("Round " + (ri + 1) + ": model=" + (r.modelEntry || "?") + ", outcome=" + (r.roundOutcome || r.verdict) + ", changed=" + changed + ", resume=" + (r.resumeMethod?.type || "?") + detail);
  }
  lines.push(
    "",
    "No rework was dispatched and no rework round was spent: the probe's input is the BRIEF, " +
      "which the worker cannot edit, so every further round would fail on the same syntax.",
    "This is a BRIEF defect, not a worker failure: add entries to the section, or delete the " +
      "heading entirely (an empty section must omit its heading), then re-dispatch.",
    disposition?.reason ? "Recorded reason: " + disposition.reason : "",
  );
  return lines.join("\n");
}

/**
 * Render the outcome string when max rounds are reached without acceptance.
 */
export function renderMaxRoundsOutcome({ chainId, maxRounds, records, orchestrator }) {
  const lastRecord = records.length > 0 ? records[records.length - 1] : {};
  const finalFindings = lastRecord.findingsText || "(none)";
  const orchLine = orchestrator?.model ? "orchestrator=" + orchestrator.model : "";
  const lines = [
    "Chain " + chainId + " reached max rounds (" + maxRounds + ") without acceptance.",
    orchLine,
    "",
    "Remaining findings:",
    finalFindings,
    "",
  ];
  for (let ri2 = 0; ri2 < records.length; ri2++) {
    const r2 = records[ri2];
    const detail2 = r2.resumeMethod.detail ? ": " + r2.resumeMethod.detail : "";
    const changed2 = roundChangedColumn(r2);
    lines.push("Round " + (ri2 + 1) + ": model=" + (r2.modelEntry || "?") + ", verdict=" + r2.verdict + ", probesGreen=" + r2.probesGreen + ", changed=" + changed2 + ", resume=" + r2.resumeMethod.type + detail2);
  }
  lines.push("", "Hand over to orchestrator for final judgement.");
  return lines.join("\n");
}

/**
 * Render the outcome string when a dispatch has exhausted every route
 * (provider/capacity failure, distinct from escalate or quality failure).
 *
 * @param {object}   opts
 * @param {string}   opts.chainId       — Chain identifier.
 * @param {number}   opts.round         — Round number where exhaustion occurred.
 * @param {string}   opts.phase         — Phase name: "implement", "review", "strategize".
 * @param {string}   opts.jobError      — Error message from the exhausted job
 *                                        (already contains the "All routes
 *                                        exhausted:" text from the wrapper).
 * @param {object|null} [opts.jobFailure=null] — Structured terminal-failure
 *                                        classification (kusabi #215): when the
 *                                        exhausted job's record carries
 *                                        `{ kind: "quota-exhaustion", ... }`,
 *                                        the classified job error (which
 *                                        already holds the operator-facing
 *                                        advice) is shown WITHOUT the generic
 *                                        "Retry when provider is available"
 *                                        capacity footer — that advice is
 *                                        actively wrong for a session-limit
 *                                        block.
 * @param {object[]} opts.records       — Round records so far (includes the
 *                                        aborted partial round).
 * @returns {string}
 */
export function renderProviderExhaustedOutcome({ chainId, round, phase, jobError, records, jobFailure = null }) {
  const lines = [
    "Chain " + chainId + " stopped at round " + round + ": " + phase + " provider exhausted.",
    "",
    jobError || "(no error detail)",
    "",
  ];

  // Include prior round summaries so the operator sees what was attempted.
  if (records.length > 0) {
    lines.push("Prior rounds:");
    for (let ri = 0; ri < records.length; ri++) {
      const r = records[ri];
      const detail = r.resumeMethod?.detail ? ": " + r.resumeMethod.detail : "";
      const changed = roundChangedColumn(r);
      lines.push(
        "  Round " + (ri + 1) + ": model=" + (r.modelEntry || "?") +
        ", verdict=" + (r.verdict || "n/a") +
        ", probesGreen=" + (r.probesGreen ?? "n/a") +
        ", changed=" + changed + ", resume=" + (r.resumeMethod?.type || "?") + detail,
      );
    }
    lines.push("");
  }

  if (jobFailure?.kind === "quota-exhaustion") {
    // Classified quota failures: the job error already carries the
    // operator-facing advice (which quota, reset time, backend blocked,
    // what to do instead of retrying — set by the dispatch, kusabi #215).
    // The generic capacity footer below would CONTRADICT it ("Retry when
    // provider is available" is exactly wrong for a session-limit block),
    // so it is omitted and the machine-readable classification is pointed
    // at instead.
    lines.push("Quota exhaustion — the failed job record's `failure` field carries the classification.");
  } else {
    lines.push("Capacity problem — not a quality failure. Retry when provider is available.");
  }
  return lines.join("\n");
}

/**
 * Handle provider exhaustion for a chain phase.
 *
 * Pure function that decides what goes into `records`, what gets persisted,
 * and what outcome is rendered when a phase job returns
 * `status === "provider-error"`.
 *
 * Whether the round still needs pushing depends on where the failing phase
 * sits relative to phase 7's unconditional push: implement and review return
 * before it, strategize (phase 9) runs after it.  **That is detected here, not
 * passed in.**  A caller that got such a flag wrong would silently duplicate or
 * drop the round — the exact defect PR #119 fixed — and no test of this
 * function could catch a mistake made at the call site.
 *
 * @param {Object} opts
 * @param {Array}  opts.records             - Chain records so far (mutated in place).
 * @param {Object} opts.roundRecord          - Current round record (mutated: tierAfter set).
 * @param {number} opts.currentTierIndex     - Tier index to record as `tierAfter`.
 * @param {string} opts.phase               - Phase name ("implement", "review", "strategize").
 * @param {string|null} [opts.jobError=null] - Provider error detail.
 * @param {object|null} [opts.jobFailure=null] - Structured terminal-failure
 *        classification from the failed job record (kusabi #215):
 *        `{ kind: "quota-exhaustion", quota, backendBlocked, reset }` when
 *        the dispatch classified quota exhaustion, else null.  The renderer
 *        uses it to show the classification instead of the generic capacity
 *        advice ("Retry when provider is available" is exactly wrong for a
 *        session-limit block).
 * @param {string} opts.chainId
 * @param {number} opts.round
 * @param {string} opts.container
 * @param {string} opts.model
 * @param {Array}  opts.modelChain
 * @param {string|object|null} [opts.reviewModel=null]       — review dispatch
 *        model, persisted verbatim so chain-resume keeps the review context.
 * @param {Array|null} [opts.reviewModelChain=null]          — review dispatch
 *        route chain, persisted verbatim (same contract as persistChainState).
 * @param {string|object|null} [opts.reworkModel=null]       — rework dispatch
 *        model, persisted verbatim so chain-resume keeps the rework context
 *        (kusabi #192 axis 2).
 * @param {Array|null} [opts.reworkModelChain=null]          — rework dispatch
 *        route chain, persisted verbatim (same contract as persistChainState).
 * @param {"opencode"|"claude"|null} [opts.reworkBackend=null] — rework
 *        dispatch backend, persisted verbatim so chain-resume re-dispatches
 *        rework rounds on the backend they originally ran on.
 * @param {number} opts.maxRounds
 * @param {string} opts.brief
 * @param {string} opts.orchestrator
 * @param {string} opts.baseSha
 * @param {boolean} opts.strategized
 * @param {string|null} [opts.chainFollowupDraft=null]
 * @returns {{ records: Array, chainState: Object, outcome: string }}
 *   - `records`   — the (mutated) records array with roundRecord present exactly once.
 *   - `chainState` — the object that should be written to chain.json.
 *   - `outcome`    — the rendered outcome string for the operator.
 */
export function handleProviderExhaustion({
  records,
  roundRecord,
  currentTierIndex,
  phase,
  jobError = null,
  jobFailure = null,
  chainId,
  round,
  container,
  model,
  modelChain,
  reviewModel = null,
  reviewModelChain = null,
  reworkModel = null,
  reworkModelChain = null,
  reworkBackend = null,
  maxRounds,
  brief,
  orchestrator,
  baseSha,
  strategized,
  chainFollowupDraft = null,
  verifyBaseline = null,
}) {
  // Record the tier after this round
  roundRecord.tierAfter = currentTierIndex;

  // Whether the round was already pushed depends on where the failing phase sits
  // relative to phase 7's unconditional push: implement and review return before
  // it, strategize runs after it.  That is derived here rather than passed in by
  // the caller — a caller that got the flag wrong would silently duplicate or
  // drop the round, which is the exact bug PR #119 fixed.
  if (!records.includes(roundRecord)) {
    records.push(roundRecord);
  }

  // Compute totals across all rounds
  const chainTotals = computeChainTotals(records);

  // Build the chain state object (what would be persisted to chain.json)
  const chainState = {
    chainId,
    container,
    model,
    modelChain,
    // Per-phase review dispatch context (kusabi #192): carried verbatim so
    // provider-exhaustion chain.json writes keep the review context that
    // persistChainState would have persisted — a later chain-resume must not
    // fall back reviewModelChain ?? modelChain and re-dispatch the review on
    // the implement's claude chain.
    reviewModel,
    reviewModelChain,
    // Per-round rework dispatch context (kusabi #192 axis 2): carried
    // verbatim for the same reason — provider-exhaustion chain.json writes
    // must keep the rework context persistChainState would have persisted,
    // or a later chain-resume re-dispatches rework rounds on the implement
    // resolution (wrong backend / wrong chain).
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
    // Chain-start verify baseline (kusabi #173) — carried on every chain.json
    // write so chain-resume reuses the recorded baseline.
    verifyBaseline,
  };

  // Render outcome
  const outcome = renderProviderExhaustedOutcome({
    chainId,
    round,
    phase,
    jobError,
    jobFailure,
    records,
  });

  return { records, chainState, outcome };
}
