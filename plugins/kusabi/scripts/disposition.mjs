// Disposition — pure functions for chain round disposition and rework strategy
// decisions.  No I/O, no imports from kusabi-companion.mjs.

/**
 * Pure function: decide which levers to pull for a rework round.
 *
 * Receives evidence from the finished round and returns the tier delta,
 * whether to start a new session, and a human-readable reason.
 *
 * Artifacts are always carried over — the chain never rolls the worktree
 * back.  A new session starts fresh on the existing worktree.
 *
 * Default ladder (when no countervailing evidence):
 *   | rework | tier   | session  |
 *   |--------|--------|----------|
 *   | 1st    | same   | continue |
 *   | 2nd    | +1     | new      |
 *   | 3rd    | +1     | new      |
 *
 * Anchoring override (kusabi #62), FIRST rework only: when the finished
 * round's evidence shows the worker is anchored to a false claim, session
 * continuity is the wrong lever even on the 1st rework — the tier stays,
 * only the session lever moves.  Two evidence conditions trigger it:
 *   - the reviewer verdict was `approve` while `probesGreen` was false
 *     (a machine-refuted success claim), and
 *   - `repeatedAreas` (same file area flagged across rounds) at reworkCount 0
 *     (rare today, but the lever must not depend on that scheduling accident).
 *
 * @param {object} opts
 * @param {number}  opts.reworkCount   — How many reworks have been done
 *                                       so far (0 = first rework).
 * @param {boolean} opts.strategized   — Whether a strategize was triggered.
 * @param {"approve"|"approve-partial"|"needs-attention"|"discard"|undefined} [opts.verdict]
 *                                     — The finished round's review verdict
 *                                       (evidence for the anchoring override).
 * @param {boolean} [opts.probesGreen] — Whether the finished round's
 *                                       deterministic probes passed.
 * @param {boolean} [opts.repeatedAreas] — Same file area flagged across rounds.
 * @returns {{ tierDelta: number, newSession: boolean, reason: string }}
 */
export function deriveReworkStrategy({ reworkCount, strategized, verdict, probesGreen, repeatedAreas }) {
  // ---- Base values from the default ladder (B3) ----
  let tierDelta;
  let newSession;
  let reason;

  if (reworkCount === 0) {
    // 1st rework: same tier, continue session, keep artifacts
    tierDelta = 0;
    newSession = false;
    reason = "1st rework: same tier, continue session, keep artifacts";

    // Anchoring override (kusabi #62).  No new tier escalation is introduced
    // here — the tier stays, only the session lever moves.
    const overrides = [];
    if (verdict === "approve" && probesGreen === false) {
      overrides.push("worker claimed done, probes red: anchoring break");
    }
    // Defensive guard: presently unreachable through the driver —
    // deriveDisposition returns "rework" only when repeatedAreas is false,
    // and recordReworkEscalation runs only for disposition "rework", so
    // this trigger becomes live only if the disposition table changes.
    if (repeatedAreas) {
      overrides.push("same file area flagged across rounds: anchoring break");
    }
    if (overrides.length > 0) {
      newSession = true;
      reason = "1st rework: same tier, new session (" + overrides.join("; ") + "), keep artifacts";
    }
  } else if (reworkCount === 1) {
    // 2nd rework: +1 tier, new session, keep artifacts
    tierDelta = 1;
    newSession = true;
    reason = "2nd rework: escalate tier, new session, keep artifacts";
  } else {
    // 3rd+ rework: +1 tier, new session, keep artifacts
    tierDelta = 1;
    newSession = true;
    reason = `${reworkCount + 1}th rework: escalate tier, new session, keep artifacts`;
  }

  // Strategized always forces a fresh session (anchoring break per
  // docs/design/phase-chain.md §3.4).
  if (strategized && !newSession) {
    newSession = true;
    reason += " + new session (strategized)";
  }

  return { tierDelta, newSession, reason };
}

/**
 * @param {object} opts
 * @param {"approve"|"approve-partial"|"needs-attention"|"discard"|"partial"|"unparseable"} opts.verdict
 *   — the four schema verdicts, plus the two states the parser can produce:
 *     `"partial"` (JSONL stream with findings but no verdict line, kusabi
 *     #202) and `"unparseable"`; both escalate.
 * @param {boolean} opts.probesGreen  — all deterministic probes passed
 * @param {number}  opts.round        — 1-based current round number
 * @param {number}  opts.maxRounds
 * @param {boolean} opts.repeatedAreas — same file area flagged 2+ rounds
 * @param {string[]} [opts.findingSeverities] — severity strings from the round's review findings.
 *   Absent, non-array or EMPTY means the review named no findings at all; with `needs-attention`
 *   over green probes that is an incomplete review and escalates (kusabi #299), because a rework
 *   round would be dispatched with an empty work list.
 * @param {boolean} [opts.strategizeEligible] — true on first stagnation to get strategize instead of
 *   escalate; combined internally with `round < maxRounds` (see strategizeAllowed) because a
 *   strategist job produced on the final round has no next round left to consume its output, so
 *   the final round never strategizes even when strategizeEligible is true.
 * @param {boolean|string} [opts.refusal] — a QUALIFYING refusal (kusabi #293): the round changed
 *   nothing and its report named two contradicting items (see `classifyRefusalOutcome` in
 *   probe-decisions.mjs).  Truthy routes the round to the terminal `refused-brief-defect`; a string
 *   additionally NAMES the two items in the reason, which is what puts the contradiction in front
 *   of the orchestrator.  It is checked FIRST, ahead of every other row including the oracle and
 *   the max-rounds terminal, because a defective brief invalidates the premise those rows judge.
 * @param {boolean|string} [opts.briefSyntaxDefect] — a BRIEF-REACHABLE probe failure (kusabi #303):
 *   a `## Deliverables` / `## Smoke` / `## Frozen Tests` heading that parses to zero entries, so
 *   P3/P4/P5 fails on brief syntax (see `briefSyntaxDefectSummary` in brief-parsing.mjs).  The
 *   probe's input is the brief file, which the worker cannot edit, so no rework can win: truthy
 *   routes the round to the terminal `refused-brief-defect`, and a string additionally NAMES the
 *   offending section(s) in the reason.  Checked after the worker's refusal and before the oracle.
 *   Worktree-reachable failures (verify red, deliverables untouched, smoke exit mismatch, frozen
 *   intersection, collected-count drop) do NOT set it and keep their existing routing.
 * @param {boolean|string} [opts.oracleViolation] — the deterministic oracle marker (kusabi #197):
 *   a P5 (frozen tests) or P6 (collected count) probe failed this round.  Truthy routes the round
 *   to `escalate`; a string additionally NAMES the violation in the reason, which is what puts it
 *   in front of the human on the escalate line.
 * @returns {{ disposition: "accept"|"accept-with-followup"|"strategize"|"rework"|"escalate"|"refused-brief-defect", reason?: string }}
 */
export function deriveDisposition({ verdict, probesGreen, round, maxRounds, repeatedAreas, findingSeverities, strategizeEligible, oracleViolation, refusal, briefSyntaxDefect, partialDiagnosis }) {
  // ---- qualifying refusal (kusabi #293) ----
  // The worker read the brief, found it self-contradictory, named both items
  // and stopped without editing.  Nothing below this line can judge that
  // round, because every other row assumes a coherent brief: an empty change
  // set reads as a discard, a rework would send the worker back to satisfy
  // requirements that cannot both be satisfied, and the max-rounds terminal
  // would spend the remaining budget on the same impossibility.  The defect
  // is the BRIEF's, so the chain ends here and the brief's author decides.
  // It must never auto-accept, and it never buys a rework round: finishRound
  // computes a rework strategy only for disposition `rework`, so the rework
  // counter is untouched by construction.
  //
  // Spurious refusals are the abuse case, and they are bounded on the OTHER
  // side: the block only qualifies when it names two items a human can look
  // up, and a refusal always lands in front of the orchestrator rather than
  // buying the worker an early exit.
  const refused =
    refusal === true ||
    (typeof refusal === "string" && refusal.trim() !== "");
  // A same-round oracle violation (P5 frozen intersection / P6 collected
  // count drop) must not vanish behind either refused-brief-defect terminal
  // below: the operator re-dispatches, the fresh chain starts from a clean
  // worktree and re-baselines the collected count, so the evidence dies with
  // this chain and would never resurface on its own.  When the oracle marker
  // is also set, the terminal reason appends it instead of dropping it
  // (kusabi #306; the worker-refusal sibling was flagged in the same review).
  const oracleNamed = typeof oracleViolation === "string" && oracleViolation.trim() !== ""
    ? " — " + oracleViolation.trim()
    : "";
  const oracleSuffix = (oracleViolation === true || oracleNamed !== "")
    ? " ADDITIONALLY a deterministic oracle violation was measured this same round" + oracleNamed +
      "; review it before re-dispatching — the evidence dies with this chain (a fresh chain starts " +
      "from a clean worktree and re-baselines the collected count), so it will not resurface on its own."
    : "";

  if (refused) {
    const named = typeof refusal === "string" ? " — " + refusal.trim() : "";
    return {
      disposition: "refused-brief-defect",
      reason: "worker refused: the brief contradicts itself, no implementation satisfies both items" + named + oracleSuffix,
    };
  }

  // ---- brief-syntax defect (kusabi #303) ----
  // A probe whose INPUT is the brief, not the worktree, cannot be turned
  // green by the worker: `## Frozen Tests` followed by prose fails P5 with
  // "heading present but no entries parsed" this round, next round and every
  // round after, whatever the worker writes.  Routing that through the normal
  // table (probesGreen=false -> rework) buys reworks that are unwinnable by
  // construction -- the incident (chain-msvwhslx6e60, 2026-08-17) burned a
  // full 4-round budget on exactly that.
  //
  // So it terminates here, in the same family as the worker's own refusal
  // above: the defect is the BRIEF's, the round budget is untouched (no
  // rework strategy is computed for a non-`rework` disposition), and the
  // reason names the offending section plus the only fix there is.
  //
  // Checked AFTER the worker's refusal (that block names a contradiction only
  // a human can resolve, and it is the more specific statement) and BEFORE
  // the oracle: an unreadable declaration is not a violated one, and every
  // row below assumes the brief the probes read is at least parseable.
  //
  // Defense in depth only: the dispatch-time lint (kusabi #302) refuses these
  // briefs before a chain exists, using the same parsers, so a chain that
  // reaches this row started before the lint or bypassed it.
  const briefDefective =
    briefSyntaxDefect === true ||
    (typeof briefSyntaxDefect === "string" && briefSyntaxDefect.trim() !== "");
  if (briefDefective) {
    const named = typeof briefSyntaxDefect === "string" ? " — " + briefSyntaxDefect.trim() : "";
    return {
      disposition: "refused-brief-defect",
      reason: "brief-syntax defect: a probe reads a brief section that declares nothing" + named +
        ". The probe's input is the brief, not the worktree, so no worker edit can turn it green " +
        "and no rework is winnable; this is the brief author's defect, not the worker's. " +
        "Fix the brief and re-dispatch." + oracleSuffix,
    };
  }

  // ---- deterministic oracle violation (kusabi #197) ----
  // A frozen-test edit or a drop in the collected test count must reach a
  // HUMAN, never a rework round: the correct resolution may be "this deletion
  // is legitimate, I approve it", and no worker can decide that.  So this
  // takes precedence over every rework/strategize/accept row below —
  // including accept-with-followup, and including an `approve` verdict with
  // green probes, which is exactly the case the pair exists to catch.
  //
  // `discard` is the one row it does not preempt: that round is already
  // heading out of the chain on the reviewer's own judgement, and its reason
  // is the more informative one to show.  Both end in `escalate` either way,
  // so there is no state where the chain can neither accept nor escalate
  // (kusabi #173: a deterministic check must never dead-end a chain).
  const oracleViolated =
    oracleViolation === true ||
    (typeof oracleViolation === "string" && oracleViolation.trim() !== "");
  if (oracleViolated && verdict !== "discard") {
    const named = typeof oracleViolation === "string" ? " — " + oracleViolation.trim() : "";
    return {
      disposition: "escalate",
      reason: "deterministic oracle violation (P5 frozen tests / P6 collected count); " +
        "a human must adjudicate, never an automatic rework" + named,
    };
  }

  // strategize only pays off if there is a next round to spend its output on —
  // on the final round the strategist job would be produced and then discarded
  // (the chain loop's post-strategize `continue` just exits the loop). Gate
  // eligibility on a round remaining so the final round never buys it.
  const strategizeAllowed = strategizeEligible === true && round < maxRounds;

  // Decision 5: accept-with-followup (economic cutoff)
  // Checked BEFORE max-rounds escalate so it takes precedence for the needs-attention case.
  // repeatedAreas does NOT preempt this branch: probes green + all findings low/medium is a
  // ship decision regardless of stagnation (policy decision, #117, 2026-07-29). strategize only
  // has value for rounds that cannot ship as-is.
  if (probesGreen && verdict === "needs-attention" && Array.isArray(findingSeverities) && findingSeverities.length > 0 && findingSeverities.every(function (s) { return s === "low" || s === "medium"; })) {
    return { disposition: "accept-with-followup", reason: "probes green; remaining findings all minor" };
  }

  // ---- needs-attention that named ZERO findings (kusabi #299) ----
  // The reviewer said the work needs attention and then named nothing that
  // needs it.  Over GREEN probes there is no work item anywhere: not in the
  // findings (the list is empty or absent) and not in the probes (they
  // passed).  A rework round would therefore dispatch an implement with an
  // empty work list, which is the incident this row exists for
  // (chain-msvthdq26fdc, 2026-08-16): the rework had nothing to fix, changed
  // no files, P3 discarded the empty round, and the chain escalated reading
  // "reviewer discarded the work" over a worktree whose earlier rounds were
  // intact and eventually shipped.
  //
  // So this is an INCOMPLETE REVIEW, the same family as `partial` (findings
  // without a verdict line, kusabi #202) and `approve-partial`: it is not an
  // approval, it must not silently buy a rework round, and only a human can
  // judge whether "needs attention, nothing named" is a clean bill of health
  // or a review that fell over.  Escalate, with the zero-findings fact in the
  // reason so the digest says it without the operator opening the record.
  //
  // Two deliberate exclusions:
  //   - `probesGreen === false`: a probe failure IS concrete work for the
  //     implement even when the reviewer named nothing, so the rework /
  //     repeatedAreas rows below keep that case unchanged.
  //   - `repeatedAreas`: those rows (strategize, stagnation escalate) name a
  //     concrete stall, which is the more informative thing to tell the
  //     operator, and they already route away from a blind rework.
  const noFindingsNamed = !Array.isArray(findingSeverities) || findingSeverities.length === 0;
  if (probesGreen && verdict === "needs-attention" && !repeatedAreas && noFindingsNamed) {
    return {
      disposition: "escalate",
      reason: "needs-attention with an empty finding list (zero findings named) over green probes: " +
        "the review is incomplete and there is nothing to rework, so a human decides",
    };
  }

  // Hard limit: max rounds reached without acceptance → escalate
  if (round >= maxRounds && verdict !== "approve") {
    const reason = repeatedAreas
      ? `max rounds (${maxRounds}) reached without acceptance; same file area flagged for two consecutive rounds`
      : `max rounds (${maxRounds}) reached without acceptance`;
    return { disposition: "escalate", reason };
  }

  if (verdict === "approve" && probesGreen) {
    return { disposition: "accept" };
  }

  // All other cases have a reason
  let disposition;
  let reason;

  switch (verdict) {
    case "approve": {
      // Reachable only when probesGreen is false (the probesGreen && approve
      // case returns "accept" above). Mirrors the needs-attention branch:
      // repeats + a next round available => strategize; repeats without a
      // next round => escalate with the stagnation reason surfaced.
      if (repeatedAreas) {
        if (strategizeAllowed) {
          disposition = "strategize";
          reason = "deterministic probes failed and same file area flagged twice; structural re-diagnosis before next rework";
        } else {
          disposition = "escalate";
          reason = "deterministic probes failed; same file area flagged for two consecutive rounds";
          // Surface budget exhaustion too: approve is exempt from the max-rounds
          // early return above, so this branch is where an operator would
          // otherwise miss that the round budget also ran out.
          if (round >= maxRounds) {
            reason += `; max rounds (${maxRounds}) reached`;
          }
        }
      } else {
        disposition = "rework";
        reason = "deterministic probes failed";
      }
      break;
    }

    case "approve-partial":
      disposition = "escalate";
      reason = "approve-partial: unverified items remain";
      break;

    case "needs-attention": {
      if (repeatedAreas) {
        if (strategizeAllowed) {
          disposition = "strategize";
          reason = "same file area flagged twice; structural re-diagnosis before next rework";
        } else {
          disposition = "escalate";
          reason = "same file area flagged for two consecutive rounds";
        }
      } else {
        disposition = "rework";
        reason = "needs-attention";
      }
      break;
    }

    case "discard":
      disposition = "escalate";
      reason = "reviewer discarded the work";
      break;

    // A partial review (kusabi #202): the reviewer's JSONL stream carried
    // findings but ended before the verdict line.  It is NOT an approval and
    // must not silently buy a rework round — the review is incomplete, and
    // only a human can judge whether partial coverage suffices.  Named
    // explicitly rather than left to the `default` branch below, so the
    // escalation is a decision with an honest reason instead of reading like
    // an internal error.
    case "partial": {
      disposition = "escalate";
      const diagSuffix = typeof partialDiagnosis === "string" && partialDiagnosis.trim() !== ""
        ? ` (${partialDiagnosis.trim()})`
        : "";
      reason = `partial review: stream ended before the verdict line${diagSuffix}`;
      break;
    }

    default:
      disposition = "escalate";
      reason = `unexpected verdict: ${verdict}`;
      break;
  }

  return { disposition, reason };
}
