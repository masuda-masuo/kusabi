// Disposition — pure functions for chain round disposition and rework strategy
// decisions.  No I/O, no imports from kusabi-companion.mjs.

/**
 * Pure function: decide which levers to pull for a rework round.
 *
 * Receives evidence from the finished round and returns the tier delta,
 * whether to start a new session, whether to restore artifacts from base,
 * and a human-readable reason.
 *
 * Default ladder (when no countervailing evidence):
 *   | rework | tier   | session  | artifacts |
 *   |--------|--------|----------|-----------|
 *   | 1st    | same   | continue | keep      |
 *   | 2nd    | +1     | new      | keep      |
 *   | 3rd    | +1     | new      | keep      |
 *
 * checkpoint_restore fires only when the evidence says the current artifacts
 * are worth less than base. Round number alone must never trigger it.
 * Restore is suppressed when either:
 *   - the previous round resolved all of the findings it was given, or
 *   - the previous round's findings were unavailable (unparseable or empty).
 *
 * @param {object} opts
 * @param {number}  opts.reworkCount                — How many reworks have been done
 *                                                    so far (0 = first rework).
 * @param {boolean} opts.repeatedAreas              — Whether the same file areas are
 *                                                    still being flagged (proxy for
 *                                                    whether prior findings were resolved).
 * @param {boolean} opts.previousFindingsAvailable  — Whether the previous round had
 *                                                    parseable, non-empty findings.
 * @param {boolean} opts.strategized                — Whether a strategize was triggered.
 * @returns {{ tierDelta: number, newSession: boolean, restoreBase: boolean, reason: string }}
 */
export function deriveReworkStrategy({ reworkCount, repeatedAreas, previousFindingsAvailable, strategized }) {
  // ---- Base values from the default ladder (B3) ----
  let tierDelta;
  let newSession;
  let reason;

  if (reworkCount === 0) {
    // 1st rework: same tier, continue session, keep artifacts
    tierDelta = 0;
    newSession = false;
    reason = "1st rework: same tier, continue session, keep artifacts";
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

  // Strategized always forces a fresh session (anchoring break per §3.4).
  if (strategized && !newSession) {
    newSession = true;
    reason += " + new session (strategized)";
  }

  // ---- Restore-base decision (B4) ----
  // checkpoint_restore fires only when the current artifacts are worth less
  // than base.  Round number alone never triggers it.
  //
  // Restore is suppressed when:
  //   1. Previous round resolved all findings (no repeated areas)
  //   2. Previous round's findings were unavailable (unparseable or empty)
  //
  // Therefore restore fires only when BOTH:
  //   - previous findings were available (non-empty, parseable)
  //   - AND the same areas are still being flagged (not resolved)
  const priorFindingsResolved = !repeatedAreas && previousFindingsAvailable;
  const shouldRestoreBase = previousFindingsAvailable && !priorFindingsResolved;

  if (shouldRestoreBase) {
    reason += " + restore base (prior findings unresolved)";
  }

  return { tierDelta, newSession, restoreBase: shouldRestoreBase, reason };
}

/**
 * @param {object} opts
 * @param {"approve"|"approve-partial"|"needs-attention"|"discard"} opts.verdict
 * @param {boolean} opts.probesGreen  — all deterministic probes passed
 * @param {number}  opts.round        — 1-based current round number
 * @param {number}  opts.maxRounds
 * @param {boolean} opts.repeatedAreas — same file area flagged 2+ rounds
 * @param {string[]} [opts.findingSeverities] — severity strings from the round's review findings
 * @param {boolean} [opts.strategizeEligible] — true on first stagnation to get strategize instead of escalate
 * @returns {{ disposition: "accept"|"accept-with-followup"|"strategize"|"rework"|"escalate", reason?: string }}
 */
export function deriveDisposition({ verdict, probesGreen, round, maxRounds, repeatedAreas, findingSeverities, strategizeEligible }) {
  // Decision 5: accept-with-followup (economic cutoff)
  // Checked BEFORE max-rounds escalate so it takes precedence for the needs-attention case.
  if (probesGreen && verdict === "needs-attention" && Array.isArray(findingSeverities) && findingSeverities.length > 0 && findingSeverities.every(function (s) { return s === "low" || s === "medium"; })) {
    return { disposition: "accept-with-followup", reason: "probes green; remaining findings all minor" };
  }

  // Hard limit: max rounds reached without acceptance → escalate
  if (round >= maxRounds && verdict !== "approve") {
    return { disposition: "escalate", reason: `max rounds (${maxRounds}) reached without acceptance` };
  }

  if (verdict === "approve" && probesGreen) {
    return { disposition: "accept" };
  }

  // All other cases have a reason
  let disposition;
  let reason;

  switch (verdict) {
    case "approve":
      disposition = "rework";
      reason = "deterministic probes failed";
      break;

    case "approve-partial":
      disposition = "escalate";
      reason = "approve-partial: unverified items remain";
      break;

    case "needs-attention": {
      if (repeatedAreas) {
        if (strategizeEligible === true) {
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

    default:
      disposition = "escalate";
      reason = `unexpected verdict: ${verdict}`;
      break;
  }

  return { disposition, reason };
}
