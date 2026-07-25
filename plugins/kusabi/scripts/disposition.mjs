// Disposition — pure functions for chain round disposition and resume method
// decisions.  No I/O, no imports from kusabi-companion.mjs.

/**
 * Pure function: determine the resume method strategy for a chain round.
 *
 * Round 1 always continues fresh (no prior session).
 * After a strategize intervention, the next rework must use a fresh session
 * (checkpoint_restore) to break anchoring per §3.4.
 * Otherwise: round 2 continues the same session; round 3+ forces fresh.
 *
 * @param {object} opts
 * @param {number}  opts.round       — 1-based round number
 * @param {boolean} opts.strategized — true when a strategize has occurred earlier in the chain
 * @returns {{ type: "continue_session" | "fresh_session" }}
 */
export function resolveResumeMethod({ round, strategized }) {
  if (round >= 3) return { type: "fresh_session" };
  if (round > 1 && strategized) return { type: "fresh_session" };
  return { type: "continue_session" };
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
