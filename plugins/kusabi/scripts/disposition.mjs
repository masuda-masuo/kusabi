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
 * @param {string[]} [opts.findingSeverities] — severity strings from the round's review findings
 * @param {boolean} [opts.strategizeEligible] — true on first stagnation to get strategize instead of
 *   escalate; combined internally with `round < maxRounds` (see strategizeAllowed) because a
 *   strategist job produced on the final round has no next round left to consume its output, so
 *   the final round never strategizes even when strategizeEligible is true.
 * @param {boolean|string} [opts.oracleViolation] — the deterministic oracle marker (kusabi #197):
 *   a P5 (frozen tests) or P6 (collected count) probe failed this round.  Truthy routes the round
 *   to `escalate`; a string additionally NAMES the violation in the reason, which is what puts it
 *   in front of the human on the escalate line.
 * @returns {{ disposition: "accept"|"accept-with-followup"|"strategize"|"rework"|"escalate", reason?: string }}
 */
export function deriveDisposition({ verdict, probesGreen, round, maxRounds, repeatedAreas, findingSeverities, strategizeEligible, oracleViolation }) {
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
    case "partial":
      disposition = "escalate";
      reason = "partial review: stream ended before the verdict line";
      break;

    default:
      disposition = "escalate";
      reason = `unexpected verdict: ${verdict}`;
      break;
  }

  return { disposition, reason };
}
