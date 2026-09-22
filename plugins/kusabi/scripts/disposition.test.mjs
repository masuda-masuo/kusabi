import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveDisposition,
  deriveReworkStrategy,
} from "./disposition.mjs";
import { ORACLE_UNCHECKED } from "./chain-probes.mjs";

// deriveDisposition — all branches
// ---------------------------------------------------------------------------

describe("deriveDisposition", () => {
  it("accept: approve + probesGreen", () => {
    const result = deriveDisposition({ verdict: "approve", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false });
    assert.deepEqual(result, { disposition: "accept" });
  });

  it("rework: approve + probes not green", () => {
    const result = deriveDisposition({ verdict: "approve", probesGreen: false, round: 1, maxRounds: 3, repeatedAreas: false });
    assert.deepEqual(result, { disposition: "rework", reason: "deterministic probes failed" });
  });

  it("escalate: approve-partial (unverified items remain)", () => {
    const result = deriveDisposition({ verdict: "approve-partial", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false });
    assert.deepEqual(result, { disposition: "escalate", reason: "approve-partial: unverified items remain" });
  });

  it("escalate: needs-attention with high finding escalates to orchestrator (kusabi #336)", () => {
    const result = deriveDisposition({ verdict: "needs-attention", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false, findingSeverities: ["high"] });
    assert.equal(result.disposition, "escalate");
    assert.match(result.reason, /consequential findings/);
  });

  it("escalate: needs-attention with repeated areas (same file 2 rounds)", () => {
    const result = deriveDisposition({ verdict: "needs-attention", probesGreen: true, round: 2, maxRounds: 3, repeatedAreas: true });
    assert.deepEqual(result, { disposition: "escalate", reason: "same file area flagged for two consecutive rounds" });
  });

  it("escalate: discard", () => {
    const result = deriveDisposition({ verdict: "discard", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false });
    assert.deepEqual(result, { disposition: "escalate", reason: "reviewer discarded the work" });
  });

  // ---- partial review (kusabi #202) ----
  // A JSONL stream with findings but no verdict line: the review is
  // INCOMPLETE.  It escalates to the orchestrator — it is not an approval and
  // it must not silently buy a rework round.

  it("escalate: partial (stream ended before the verdict line)", () => {
    const result = deriveDisposition({ verdict: "partial", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false });
    assert.deepEqual(result, { disposition: "escalate", reason: "partial review: stream ended before the verdict line" });
  });

  it("partial does not take the accept-with-followup cutoff even with probes green and only minor findings", () => {
    // The same evidence under `needs-attention` returns accept-with-followup.
    // Partial must not ship on partial coverage.
    const partial = deriveDisposition({
      verdict: "partial", probesGreen: true, round: 1, maxRounds: 3,
      repeatedAreas: false, findingSeverities: ["low", "medium"],
    });
    const needsAttention = deriveDisposition({
      verdict: "needs-attention", probesGreen: true, round: 1, maxRounds: 3,
      repeatedAreas: false, findingSeverities: ["low", "medium"],
    });

    assert.equal(partial.disposition, "escalate");
    assert.equal(needsAttention.disposition, "accept-with-followup");
  });

  it("partial never reworks or strategizes, whatever the other evidence says", () => {
    const cases = [
      { probesGreen: false, repeatedAreas: false, strategizeEligible: true },
      { probesGreen: true, repeatedAreas: true, strategizeEligible: true },
      { probesGreen: false, repeatedAreas: true, strategizeEligible: false },
    ];
    for (const evidence of cases) {
      const result = deriveDisposition({ verdict: "partial", round: 1, maxRounds: 3, ...evidence });
      assert.equal(result.disposition, "escalate", JSON.stringify(evidence));
    }
  });

  it("partial is not reported as an unexpected verdict", () => {
    // The `default` branch's wording would read like an internal error; the
    // partial state is a decision with its own reason.
    const partial = deriveDisposition({ verdict: "partial", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false });
    const unknown = deriveDisposition({ verdict: "who-knows", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false });

    assert.doesNotMatch(partial.reason, /unexpected verdict/);
    assert.match(unknown.reason, /unexpected verdict: who-knows/);
  });

  it("escalate: max rounds reached without accept", () => {
    const result = deriveDisposition({ verdict: "needs-attention", probesGreen: false, round: 3, maxRounds: 3, repeatedAreas: false });
    assert.deepEqual(result, { disposition: "escalate", reason: "max rounds (3) reached without acceptance" });
  });

  it("accept on last round when approve + green", () => {
    const result = deriveDisposition({ verdict: "approve", probesGreen: true, round: 3, maxRounds: 3, repeatedAreas: false });
    assert.deepEqual(result, { disposition: "accept" });
  });

  it("escalate: unknown verdict", () => {
    const result = deriveDisposition({ verdict: "unknown", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false });
    assert.equal(result.disposition, "escalate");
    assert.match(result.reason, /unexpected verdict/);
  });

  it("accept-with-followup: needs-attention + probesGreen + all-minor severities", () => {
    const result = deriveDisposition({ verdict: "needs-attention", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false, findingSeverities: ["low", "medium", "low"] });
    assert.deepEqual(result, { disposition: "accept-with-followup", reason: "probes green; remaining findings all minor" });
  });

  it("accept-with-followup on final round: needs-attention + probesGreen + all-minor → accept-with-followup, not escalate", () => {
    const result = deriveDisposition({ verdict: "needs-attention", probesGreen: true, round: 3, maxRounds: 3, repeatedAreas: false, findingSeverities: ["low"] });
    assert.deepEqual(result, { disposition: "accept-with-followup", reason: "probes green; remaining findings all minor" });
  });

  it("escalate: one high among lows → escalates to orchestrator (kusabi #336)", () => {
    const result = deriveDisposition({ verdict: "needs-attention", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false, findingSeverities: ["low", "high", "low"] });
    assert.equal(result.disposition, "escalate");
    assert.match(result.reason, /consequential findings/);
  });

  it("rework (unchanged): probes red + minors → not eligible for accept-with-followup", () => {
    const result = deriveDisposition({ verdict: "needs-attention", probesGreen: false, round: 1, maxRounds: 3, repeatedAreas: false, findingSeverities: ["low", "medium"] });
    assert.deepEqual(result, { disposition: "rework", reason: "needs-attention" });
  });

  it("escalate (unchanged): approve-partial + minors → not eligible for accept-with-followup", () => {
    const result = deriveDisposition({ verdict: "approve-partial", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false, findingSeverities: ["low", "low"] });
    assert.deepEqual(result, { disposition: "escalate", reason: "approve-partial: unverified items remain" });
  });

  // ---- needs-attention naming ZERO findings (kusabi #299) ----
  // Both of these used to buy a rework round whose work list was empty.  They
  // now escalate: over green probes there is nothing anywhere for an
  // implement to act on, so the REVIEW is what is incomplete.

  it("escalate: undefined findingSeverities + probes green (nothing to rework)", () => {
    const result = deriveDisposition({ verdict: "needs-attention", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false });
    assert.equal(result.disposition, "escalate");
    // The reason must name the empty finding list, so the digest says why
    // without the operator opening the round record.
    assert.match(result.reason, /empty finding list|zero findings/);
  });

  it("escalate: empty findingSeverities array + probes green (nothing to rework)", () => {
    const result = deriveDisposition({ verdict: "needs-attention", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false, findingSeverities: [] });
    assert.equal(result.disposition, "escalate");
    assert.match(result.reason, /empty finding list|zero findings/);
  });

  it("escalate: a non-array findingSeverities is read as zero findings, not as a rework", () => {
    // The malformed-review guard upstream can hand us a non-array; it means
    // the same thing as an absent list: the reviewer named nothing.
    const result = deriveDisposition({ verdict: "needs-attention", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false, findingSeverities: "high" });
    assert.equal(result.disposition, "escalate");
    assert.match(result.reason, /empty finding list|zero findings/);
  });

  it("rework (unchanged): probes RED + zero findings still reworks — the probe failure is the work", () => {
    for (const findingSeverities of [undefined, []]) {
      const result = deriveDisposition({ verdict: "needs-attention", probesGreen: false, round: 1, maxRounds: 3, repeatedAreas: false, findingSeverities });
      assert.deepEqual(result, { disposition: "rework", reason: "needs-attention" }, JSON.stringify(findingSeverities));
    }
  });

  it("accept-with-followup (unchanged): non-empty minor findings still ship with a follow-up", () => {
    const result = deriveDisposition({ verdict: "needs-attention", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false, findingSeverities: ["low", "medium"] });
    assert.deepEqual(result, { disposition: "accept-with-followup", reason: "probes green; remaining findings all minor" });
  });

  it("the zero-findings row does not preempt the repeatedAreas rows", () => {
    // repeatedAreas names a concrete stall, which is the more informative
    // thing to tell the operator; those rows keep their own reasons.
    const strategize = deriveDisposition({ verdict: "needs-attention", probesGreen: true, round: 2, maxRounds: 3, repeatedAreas: true, strategizeEligible: true });
    assert.equal(strategize.disposition, "strategize");
    const escalate = deriveDisposition({ verdict: "needs-attention", probesGreen: true, round: 2, maxRounds: 3, repeatedAreas: true });
    assert.deepEqual(escalate, { disposition: "escalate", reason: "same file area flagged for two consecutive rounds" });
  });

  it("the zero-findings row never fires for another verdict", () => {
    // approve + green is still a clean accept; discard/approve-partial keep
    // their own reasons.  Only needs-attention has the empty-work-list problem.
    assert.deepEqual(
      deriveDisposition({ verdict: "approve", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false }),
      { disposition: "accept" },
    );
    assert.deepEqual(
      deriveDisposition({ verdict: "discard", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false }),
      { disposition: "escalate", reason: "reviewer discarded the work" },
    );
    assert.deepEqual(
      deriveDisposition({ verdict: "approve-partial", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false }),
      { disposition: "escalate", reason: "approve-partial: unverified items remain" },
    );
  });

  it("a qualifying refusal and an oracle violation still take precedence over the zero-findings row", () => {
    const refused = deriveDisposition({
      verdict: "needs-attention", probesGreen: true, round: 1, maxRounds: 3,
      repeatedAreas: false, findingSeverities: [], refusal: "## A vs b.mjs",
    });
    assert.equal(refused.disposition, "refused-brief-defect");
    const oracle = deriveDisposition({
      verdict: "needs-attention", probesGreen: true, round: 1, maxRounds: 3,
      repeatedAreas: false, findingSeverities: [], oracleViolation: "P5: frozen — tests/a.test.mjs",
    });
    assert.equal(oracle.disposition, "escalate");
    assert.match(oracle.reason, /oracle violation/);
  });

  it("escalate: critical severity among lows (kusabi #336)", () => {
    const result = deriveDisposition({ verdict: "needs-attention", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false, findingSeverities: ["critical", "low"] });
    assert.equal(result.disposition, "escalate");
    assert.match(result.reason, /consequential findings/);
  });

  it("rework (unchanged): unknown severity string", () => {
    const result = deriveDisposition({ verdict: "needs-attention", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false, findingSeverities: ["low", "info", "low"] });
    assert.deepEqual(result, { disposition: "rework", reason: "needs-attention" });
  });

  // ---- Decision 4 strategize tests ----

  it("strategize: repeatedAreas + strategizeEligible true", () => {
    const result = deriveDisposition({ verdict: "needs-attention", probesGreen: true, round: 2, maxRounds: 3, repeatedAreas: true, strategizeEligible: true });
    assert.equal(result.disposition, "strategize");
    assert.match(result.reason, /same file area flagged twice/);
  });

  it("escalate (unchanged): repeatedAreas + strategizeEligible false", () => {
    const result = deriveDisposition({ verdict: "needs-attention", probesGreen: true, round: 2, maxRounds: 3, repeatedAreas: true, strategizeEligible: false });
    assert.deepEqual(result, { disposition: "escalate", reason: "same file area flagged for two consecutive rounds" });
  });

  it("escalate (unchanged): repeatedAreas + strategizeEligible undefined", () => {
    const result = deriveDisposition({ verdict: "needs-attention", probesGreen: true, round: 2, maxRounds: 3, repeatedAreas: true });
    // No strategizeEligible passed = undefined, should escalate
    assert.deepEqual(result, { disposition: "escalate", reason: "same file area flagged for two consecutive rounds" });
  });

  it("accept-with-followup takes precedence over strategize: repeatedAreas + all-minor", () => {
    const result = deriveDisposition({ verdict: "needs-attention", probesGreen: true, round: 2, maxRounds: 3, repeatedAreas: true, findingSeverities: ["low", "medium"], strategizeEligible: true });
    assert.deepEqual(result, { disposition: "accept-with-followup", reason: "probes green; remaining findings all minor" });
  });

  it("approve unaffected by strategizeEligible", () => {
    const result = deriveDisposition({ verdict: "approve", probesGreen: true, round: 2, maxRounds: 3, repeatedAreas: true, strategizeEligible: true });
    assert.deepEqual(result, { disposition: "accept" });
  });

  it("discard unaffected by strategizeEligible", () => {
    const result = deriveDisposition({ verdict: "discard", probesGreen: true, round: 2, maxRounds: 3, repeatedAreas: true, strategizeEligible: true });
    assert.deepEqual(result, { disposition: "escalate", reason: "reviewer discarded the work" });
  });

  // ---- kusabi#117: approve + probes red must also see repeatedAreas ----

  it("strategize: approve + probes red + repeatedAreas + strategizeEligible + round < maxRounds", () => {
    const result = deriveDisposition({ verdict: "approve", probesGreen: false, round: 1, maxRounds: 3, repeatedAreas: true, strategizeEligible: true });
    assert.deepEqual(result, { disposition: "strategize", reason: "deterministic probes failed and same file area flagged twice; structural re-diagnosis before next rework" });
  });

  it("escalate: approve + probes red + repeatedAreas + strategizeEligible false", () => {
    const result = deriveDisposition({ verdict: "approve", probesGreen: false, round: 1, maxRounds: 3, repeatedAreas: true, strategizeEligible: false });
    assert.deepEqual(result, { disposition: "escalate", reason: "deterministic probes failed; same file area flagged for two consecutive rounds" });
  });

  it("escalate (not strategize): approve + probes red + repeatedAreas + strategizeEligible true but round === maxRounds", () => {
    const result = deriveDisposition({ verdict: "approve", probesGreen: false, round: 3, maxRounds: 3, repeatedAreas: true, strategizeEligible: true });
    assert.deepEqual(result, { disposition: "escalate", reason: "deterministic probes failed; same file area flagged for two consecutive rounds; max rounds (3) reached" });
  });

  it("accept unaffected: approve + probesGreen + repeatedAreas", () => {
    const result = deriveDisposition({ verdict: "approve", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: true });
    assert.deepEqual(result, { disposition: "accept" });
  });

  // ---- kusabi#117: max-rounds escalate reason surfaces the stagnation signal ----

  it("escalate: needs-attention + repeatedAreas + a high finding + round === maxRounds → high/critical gate wins over maxRounds reason (kusabi #336)", () => {
    const result = deriveDisposition({ verdict: "needs-attention", probesGreen: true, round: 3, maxRounds: 3, repeatedAreas: true, findingSeverities: ["high", "low"] });
    assert.equal(result.disposition, "escalate");
    assert.match(result.reason, /consequential findings/);
  });

  // Regression guard: repeats + eligible + round < maxRounds still strategizes
  // (already covered above by "strategize: repeatedAreas + strategizeEligible true", round 2 of 3).
});

// deriveDisposition — high/critical severity escalation gate (kusabi #336)
// ---------------------------------------------------------------------------

describe("deriveDisposition — high/critical severity escalation gate (kusabi #336)", () => {
  it("needs-attention + green probes + ['high'] → escalate with all 3 contract facts in reason", () => {
    const result = deriveDisposition({
      verdict: "needs-attention", probesGreen: true, round: 1, maxRounds: 3,
      repeatedAreas: false, findingSeverities: ["high"],
    });
    assert.equal(result.disposition, "escalate");
    assert.match(result.reason, /1 high and 0 critical/);
    assert.match(result.reason, /decision for the orchestrator, not a rework the implementer decides/);
    assert.match(result.reason, /does not include a same-pattern sweep/);
  });

  it("same with ['critical'] and mix ['low','critical','medium']", () => {
    const criticalRes = deriveDisposition({
      verdict: "needs-attention", probesGreen: true, round: 1, maxRounds: 3,
      repeatedAreas: false, findingSeverities: ["critical"],
    });
    assert.equal(criticalRes.disposition, "escalate");
    assert.match(criticalRes.reason, /0 high and 1 critical/);
    assert.match(criticalRes.reason, /decision for the orchestrator/);
    assert.match(criticalRes.reason, /same-pattern sweep/);

    const mixRes = deriveDisposition({
      verdict: "needs-attention", probesGreen: true, round: 1, maxRounds: 3,
      repeatedAreas: false, findingSeverities: ["low", "critical", "medium"],
    });
    assert.equal(mixRes.disposition, "escalate");
    assert.match(mixRes.reason, /0 high and 1 critical/);
  });

  it("needs-attention + red probes + ['high'] → escalate (gate ignores probesGreen)", () => {
    const result = deriveDisposition({
      verdict: "needs-attention", probesGreen: false, round: 1, maxRounds: 3,
      repeatedAreas: false, findingSeverities: ["high"],
    });
    assert.equal(result.disposition, "escalate");
    assert.match(result.reason, /consequential findings/);
  });

  it("needs-attention + repeatedAreas: true + strategizeEligible: true + round < maxRounds + ['high'] → escalate, not strategize", () => {
    const result = deriveDisposition({
      verdict: "needs-attention", probesGreen: true, round: 1, maxRounds: 3,
      repeatedAreas: true, strategizeEligible: true, findingSeverities: ["high"],
    });
    assert.equal(result.disposition, "escalate");
    assert.match(result.reason, /consequential findings/);
  });

  it("oracleViolation set + needs-attention + ['high'] → oracle reason wins (order guard)", () => {
    const result = deriveDisposition({
      verdict: "needs-attention", probesGreen: true, round: 1, maxRounds: 3,
      repeatedAreas: false, findingSeverities: ["high"], oracleViolation: "P5: frozen tests changed",
    });
    assert.equal(result.disposition, "escalate");
    assert.match(result.reason, /oracle violation/);
    assert.doesNotMatch(result.reason, /consequential findings/);
  });

  it("discard verdict + ['critical'] → still reviewer discarded the work", () => {
    const result = deriveDisposition({
      verdict: "discard", probesGreen: true, round: 1, maxRounds: 3,
      repeatedAreas: false, findingSeverities: ["critical"],
    });
    assert.equal(result.disposition, "escalate");
    assert.equal(result.reason, "reviewer discarded the work");
  });

  it("approve + green + ['high'] → still accept", () => {
    const result = deriveDisposition({
      verdict: "approve", probesGreen: true, round: 1, maxRounds: 3,
      repeatedAreas: false, findingSeverities: ["high"],
    });
    assert.deepEqual(result, { disposition: "accept" });
  });

  it("['low','medium'] still → accept-with-followup (Decision 5 untouched)", () => {
    const result = deriveDisposition({
      verdict: "needs-attention", probesGreen: true, round: 1, maxRounds: 3,
      repeatedAreas: false, findingSeverities: ["low", "medium"],
    });
    assert.deepEqual(result, { disposition: "accept-with-followup", reason: "probes green; remaining findings all minor" });
  });
});

// deriveReworkStrategy — default ladder and strategize rule
// Artifacts are always carried over; restoreBase is never returned.
// ---------------------------------------------------------------------------

describe("deriveReworkStrategy", () => {
  // B3: Default ladder
  it("1st rework: same tier, continue session, keep artifacts", () => {
    const result = deriveReworkStrategy({
      reworkCount: 0,
      strategized: false,
    });
    assert.equal(result.tierDelta, 0);
    assert.equal(result.newSession, false);
    assert.match(result.reason, /1st rework/);
    assert.match(result.reason, /same tier/);
    assert.match(result.reason, /continue session/);
  });

  it("2nd rework: +1 tier, new session, keep artifacts", () => {
    const result = deriveReworkStrategy({
      reworkCount: 1,
      strategized: false,
    });
    assert.equal(result.tierDelta, 1);
    assert.equal(result.newSession, true);
    assert.match(result.reason, /2nd rework/);
    assert.match(result.reason, /escalate tier/);
    assert.match(result.reason, /new session/);
  });

  it("3rd rework: +1 tier, new session, keep artifacts", () => {
    const result = deriveReworkStrategy({
      reworkCount: 2,
      strategized: false,
    });
    assert.equal(result.tierDelta, 1);
    assert.equal(result.newSession, true);
    assert.match(result.reason, /3th rework/);
    assert.match(result.reason, /escalate tier/);
    assert.match(result.reason, /new session/);
  });

  // Artifacts are always carried over — no restoreBase returned
  it("artifacts carried over on 1st rework (no restore)", () => {
    const result = deriveReworkStrategy({
      reworkCount: 0,
      strategized: false,
    });
    // No restoreBase property exists in the return value
    assert.equal(Object.prototype.hasOwnProperty.call(result, "restoreBase"), false);
  });

  it("artifacts carried over on 2nd rework (no restore)", () => {
    const result = deriveReworkStrategy({
      reworkCount: 1,
      strategized: false,
    });
    assert.equal(Object.prototype.hasOwnProperty.call(result, "restoreBase"), false);
  });

  // B5: New session does not imply restoring artifacts
  it("new session with artifacts kept: newSession=true, no restoreBase", () => {
    const result = deriveReworkStrategy({
      reworkCount: 1,
      strategized: false,
    });
    // Default 2nd rework: new session, keep artifacts
    assert.equal(result.newSession, true);
    assert.equal(Object.prototype.hasOwnProperty.call(result, "restoreBase"), false);
  });

  // Strategized forces fresh session
  it("strategized forces new session on 1st rework", () => {
    const result = deriveReworkStrategy({
      reworkCount: 0,
      strategized: true,
    });
    assert.equal(result.newSession, true); // Would be false without strategized
    assert.equal(result.tierDelta, 0);
    assert.match(result.reason, /new session.*strategized/);
  });

  // AC5: every remaining parameter is exercised by the tests
  it("reworkCount=0 is exercised", () => {
    // Covered by "1st rework" test
  });

  it("reworkCount=1 is exercised", () => {
    // Covered by "2nd rework" test
  });

  it("reworkCount=2 is exercised", () => {
    // Covered by "3rd rework" test
  });

  it("strategized=true is exercised", () => {
    // Covered by "strategized forces new session" test
  });

  it("strategized=false is exercised in default ladder tests", () => {
    // Covered by 1st/2nd/3rd rework tests
  });

  // ---- Anchoring override (kusabi #62) ----
  // On the FIRST rework, machine-refuted success claims and cross-round
  // repetition force a NEW session with the tier unchanged.  The lever
  // function must not depend on the scheduling accident that repetition
  // normally implies a later rework.

  it("anchoring override: approve + probes red on 1st rework forces a new session with same tier", () => {
    const result = deriveReworkStrategy({
      reworkCount: 0,
      strategized: false,
      verdict: "approve",
      probesGreen: false,
      repeatedAreas: false,
    });
    assert.equal(result.newSession, true);
    assert.equal(result.tierDelta, 0);
    assert.match(result.reason, /worker claimed done, probes red: anchoring break/);
    assert.match(result.reason, /1st rework/);
    assert.match(result.reason, /same tier/);
    assert.match(result.reason, /new session/);
  });

  it("anchoring override: repeatedAreas on 1st rework forces a new session with same tier", () => {
    const result = deriveReworkStrategy({
      reworkCount: 0,
      strategized: false,
      verdict: "needs-attention",
      probesGreen: false,
      repeatedAreas: true,
    });
    assert.equal(result.newSession, true);
    assert.equal(result.tierDelta, 0);
    assert.match(result.reason, /same file area flagged across rounds: anchoring break/);
  });

  it("anchoring override: both triggers on 1st rework name both in the reason", () => {
    const result = deriveReworkStrategy({
      reworkCount: 0,
      strategized: false,
      verdict: "approve",
      probesGreen: false,
      repeatedAreas: true,
    });
    assert.equal(result.newSession, true);
    assert.equal(result.tierDelta, 0);
    assert.match(result.reason, /worker claimed done, probes red: anchoring break/);
    assert.match(result.reason, /same file area flagged across rounds: anchoring break/);
  });

  it("no override: needs-attention + probes red on 1st rework still continues the session", () => {
    const result = deriveReworkStrategy({
      reworkCount: 0,
      strategized: false,
      verdict: "needs-attention",
      probesGreen: false,
      repeatedAreas: false,
    });
    assert.equal(result.newSession, false);
    assert.equal(result.tierDelta, 0);
    assert.match(result.reason, /continue session/);
  });

  it("no override: approve + probes green on 1st rework is not triggered (not machine-refuted)", () => {
    const result = deriveReworkStrategy({
      reworkCount: 0,
      strategized: false,
      verdict: "approve",
      probesGreen: true,
      repeatedAreas: false,
    });
    assert.equal(result.newSession, false);
    assert.equal(result.tierDelta, 0);
    assert.match(result.reason, /continue session/);
  });

  it("override does not change the 2nd rework ladder row", () => {
    const result = deriveReworkStrategy({
      reworkCount: 1,
      strategized: false,
      verdict: "approve",
      probesGreen: false,
      repeatedAreas: true,
    });
    // 2nd rework row wins: +1 tier, new session, standard reason.
    assert.equal(result.tierDelta, 1);
    assert.equal(result.newSession, true);
    assert.match(result.reason, /2nd rework/);
    assert.match(result.reason, /escalate tier/);
  });
});


// deriveDisposition — the deterministic oracle marker (kusabi #197)
// ---------------------------------------------------------------------------
//
// A P5 (frozen tests) or P6 (collected count) failure must reach a HUMAN.  It
// must never buy a rework round: the correct resolution may be "this deletion
// is legitimate, I approve it", which no worker can decide.  So the marker
// takes precedence over every rework/strategize/accept row — and the table is
// byte-for-byte unchanged when the marker is absent.

describe("deriveDisposition — oracle violation routing (kusabi #197)", () => {
  it("escalates an approve with green probes (the case the oracle exists to catch)", () => {
    const result = deriveDisposition({
      verdict: "approve", probesGreen: true, round: 1, maxRounds: 3,
      repeatedAreas: false, oracleViolation: true,
    });
    assert.equal(result.disposition, "escalate");
    assert.match(result.reason, /oracle violation/);
    assert.match(result.reason, /never an automatic rework/);
  });

  it("never reworks and never strategizes, whatever the other evidence says", () => {
    const cases = [
      { verdict: "approve", probesGreen: false, repeatedAreas: false },
      { verdict: "approve", probesGreen: false, repeatedAreas: true, strategizeEligible: true },
      { verdict: "needs-attention", probesGreen: false, repeatedAreas: false },
      { verdict: "needs-attention", probesGreen: true, repeatedAreas: true, strategizeEligible: true },
      { verdict: "approve-partial", probesGreen: true, repeatedAreas: false },
      { verdict: "partial", probesGreen: true, repeatedAreas: false },
    ];
    for (const evidence of cases) {
      const result = deriveDisposition({ round: 1, maxRounds: 3, oracleViolation: true, ...evidence });
      assert.equal(result.disposition, "escalate", JSON.stringify(evidence));
    }
  });

  it("preempts the accept-with-followup economic cutoff", () => {
    // Same evidence without the marker ships with a follow-up issue.  A round
    // that edited a frozen test must not ship on "all findings are minor".
    const withMarker = deriveDisposition({
      verdict: "needs-attention", probesGreen: true, round: 1, maxRounds: 3,
      repeatedAreas: false, findingSeverities: ["low", "medium"], oracleViolation: true,
    });
    const without = deriveDisposition({
      verdict: "needs-attention", probesGreen: true, round: 1, maxRounds: 3,
      repeatedAreas: false, findingSeverities: ["low", "medium"],
    });
    assert.equal(withMarker.disposition, "escalate");
    assert.deepEqual(without, { disposition: "accept-with-followup", reason: "probes green; remaining findings all minor" });
  });

  it("names the violation in the reason when the marker is a string", () => {
    // This is what puts the offending path in front of the human: the escalate
    // outcome line renders `disposition.reason` verbatim.
    const result = deriveDisposition({
      verdict: "approve", probesGreen: false, round: 1, maxRounds: 3, repeatedAreas: false,
      oracleViolation: "P5: frozen: frozen path(s) changed: [tests/a.test.mjs]; frozen: [tests/a.test.mjs]",
    });
    assert.equal(result.disposition, "escalate");
    assert.match(result.reason, /tests\/a\.test\.mjs/);
  });

  it("does not preempt discard — that round keeps the reviewer's own reason", () => {
    const result = deriveDisposition({
      verdict: "discard", probesGreen: true, round: 1, maxRounds: 3,
      repeatedAreas: false, oracleViolation: true,
    });
    // Both routes end in escalate, so there is no state where the chain can
    // neither accept nor escalate (kusabi #173).
    assert.deepEqual(result, { disposition: "escalate", reason: "reviewer discarded the work" });
  });

  it("leaves the table unchanged when the marker is absent, false, or an empty string", () => {
    const rows = [
      { input: { verdict: "approve", probesGreen: true }, expected: { disposition: "accept" } },
      { input: { verdict: "approve", probesGreen: false }, expected: { disposition: "rework", reason: "deterministic probes failed" } },
      // The named finding is what keeps this a rework row: a needs-attention
      // naming nothing over green probes escalates on its own (kusabi #299),
      // which would make this row test that rule instead of the marker.
      { input: { verdict: "needs-attention", probesGreen: false, findingSeverities: ["low"] }, expected: { disposition: "rework", reason: "needs-attention" } },
      { input: { verdict: "discard", probesGreen: true }, expected: { disposition: "escalate", reason: "reviewer discarded the work" } },
      { input: { verdict: "approve-partial", probesGreen: true }, expected: { disposition: "escalate", reason: "approve-partial: unverified items remain" } },
    ];
    for (const marker of [undefined, false, "", "   "]) {
      for (const row of rows) {
        const result = deriveDisposition({
          round: 1, maxRounds: 3, repeatedAreas: false, oracleViolation: marker, ...row.input,
        });
        assert.deepEqual(result, row.expected, `${JSON.stringify(marker)} / ${JSON.stringify(row.input)}`);
      }
    }
  });
});

// deriveDisposition — deterministic oracle NOT executed (kusabi #541)
// ---------------------------------------------------------------------------
// When the P5/P6 probes never ran, the persisted marker on `oracleViolation`
// is the ORACLE_UNCHECKED string — evidence that measurement did NOT happen,
// never a violation of the measured kind.  The flag must escalate, must not
// claim a measured violation on the refusal / brief-syntax terminals that
// keep precedence over it, and must not claim the P1-P4 evidence that DID
// run is absent.

describe("deriveDisposition — oracle unchecked (kusabi #541)", () => {
  const UNCHECKED = ORACLE_UNCHECKED;
  const NAMED = "## Frozen tests vs src/foo.test.mjs — the test pins the old output";
  const DEFECT = "P5: frozen: ## Frozen Tests heading present but no entries parsed";

  it("escalates an unchecked oracle and claims only missing P5/P6 evidence", () => {
    const result = deriveDisposition({
      verdict: "approve", probesGreen: true, round: 1, maxRounds: 3,
      repeatedAreas: false, oracleViolation: UNCHECKED, oracleUnchecked: true,
    });
    assert.equal(result.disposition, "escalate");
    // The reason names the unchecked state and the missing oracle evidence...
    assert.match(result.reason, /P5\/P6 oracle probes did not execute/);
    assert.match(result.reason, /UNCHECKED/);
    assert.match(result.reason, /no P5\/P6 oracle evidence/);
    // ...and must NOT claim a measured violation, nor that P1-P4 evidence
    // (which may have run before the throw) is absent.
    assert.doesNotMatch(result.reason, /deterministic oracle violation was measured/);
    assert.doesNotMatch(result.reason, /no deterministic acceptance evidence/);
    assert.doesNotMatch(result.reason, /never an automatic rework/);
  });

  it("never reworks and never strategizes, whatever the other evidence says", () => {
    const cases = [
      { verdict: "approve", probesGreen: false, repeatedAreas: false },
      { verdict: "approve", probesGreen: true, repeatedAreas: false },
      { verdict: "needs-attention", probesGreen: false, repeatedAreas: false, findingSeverities: ["high"] },
      { verdict: "needs-attention", probesGreen: true, repeatedAreas: true, strategizeEligible: true },
      { verdict: "approve-partial", probesGreen: true, repeatedAreas: false },
      { verdict: "discard", probesGreen: true, repeatedAreas: false },
    ];
    for (const evidence of cases) {
      const result = deriveDisposition({
        round: 1, maxRounds: 3, oracleViolation: UNCHECKED, oracleUnchecked: true, ...evidence,
      });
      assert.equal(result.disposition, "escalate", JSON.stringify(evidence));
      assert.match(result.reason, /did not execute/);
    }
  });

  it("the flag wins over a (contradictory) measured-violation marker", () => {
    // In practice the two are mutually exclusive — a throw before P5/P6 is
    // the only way the flag is set — but if both arrive the flag must win.
    const result = deriveDisposition({
      verdict: "approve", probesGreen: true, round: 1, maxRounds: 3,
      repeatedAreas: false, oracleViolation: "P5: frozen — tests/a.test.mjs", oracleUnchecked: true,
    });
    assert.equal(result.disposition, "escalate");
    assert.match(result.reason, /did not execute/);
    assert.doesNotMatch(result.reason, /deterministic oracle violation was measured/);
  });

  it("refusal + unchecked: the terminal reason never claims a measured violation", () => {
    const result = deriveDisposition({
      verdict: "approve", probesGreen: false, round: 1, maxRounds: 4,
      repeatedAreas: false, refusal: NAMED, oracleViolation: UNCHECKED, oracleUnchecked: true,
    });
    assert.equal(result.disposition, "refused-brief-defect");
    assert.match(result.reason, /brief contradicts itself/);
    // The unchecked state rides along accurately — as missing oracle evidence,
    // never as a violation of the measured kind, and the sentinel string
    // itself is never rendered.
    assert.match(result.reason, /P5\/P6 oracle probes did not execute/);
    assert.match(result.reason, /no P5\/P6 oracle evidence/);
    assert.doesNotMatch(result.reason, /deterministic oracle violation was measured/);
    assert.doesNotMatch(result.reason, /unchecked: P5\/P6 oracle probes did not execute/);
  });

  it("brief-syntax + unchecked: same boundary — no measured-violation claim", () => {
    const result = deriveDisposition({
      verdict: "needs-attention", probesGreen: false, round: 1, maxRounds: 4,
      repeatedAreas: false, findingSeverities: ["high"], briefSyntaxDefect: DEFECT,
      oracleViolation: UNCHECKED, oracleUnchecked: true,
    });
    assert.equal(result.disposition, "refused-brief-defect");
    assert.match(result.reason, /brief-syntax defect/);
    assert.match(result.reason, /P5\/P6 oracle probes did not execute/);
    assert.match(result.reason, /no P5\/P6 oracle evidence/);
    assert.doesNotMatch(result.reason, /deterministic oracle violation was measured/);
  });

  it("a same-round MEASURED violation still appends the measured-violation sentence on refusal", () => {
    // Guard against over-suppression: the #306 suffix must still render when
    // the oracle genuinely executed and measured a violation.
    const result = deriveDisposition({
      verdict: "approve", probesGreen: false, round: 1, maxRounds: 4,
      repeatedAreas: false, refusal: NAMED,
      oracleViolation: "P5: frozen — tests/a.test.mjs", oracleUnchecked: false,
    });
    assert.equal(result.disposition, "refused-brief-defect");
    assert.match(result.reason, /ADDITIONALLY a deterministic oracle violation was measured this same round/);
    assert.doesNotMatch(result.reason, /did not execute this round/);
  });

  it("is inert when absent or false — every existing row is unchanged", () => {
    const rows = [
      { input: { verdict: "approve", probesGreen: true }, expected: { disposition: "accept" } },
      { input: { verdict: "approve", probesGreen: false }, expected: { disposition: "rework", reason: "deterministic probes failed" } },
      { input: { verdict: "needs-attention", probesGreen: false, findingSeverities: ["low"] }, expected: { disposition: "rework", reason: "needs-attention" } },
      { input: { verdict: "discard", probesGreen: true }, expected: { disposition: "escalate", reason: "reviewer discarded the work" } },
      { input: { verdict: "approve-partial", probesGreen: true }, expected: { disposition: "escalate", reason: "approve-partial: unverified items remain" } },
    ];
    for (const flag of [undefined, false]) {
      for (const row of rows) {
        const result = deriveDisposition({
          round: 1, maxRounds: 3, repeatedAreas: false, oracleUnchecked: flag, ...row.input,
        });
        assert.deepEqual(result, row.expected, `${JSON.stringify(flag)} / ${JSON.stringify(row.input)}`);
      }
    }
  });
});

// deriveDisposition — qualifying refusal (kusabi #293)
// ---------------------------------------------------------------------------
// The row exists so an honest stop stops being indistinguishable from a lazy
// empty round.  What matters is that it is TERMINAL and that it is distinct:
// not accept (nothing was built), not rework (the worker cannot fix a brief),
// not escalate/discard (the failure is not the worker's).

describe("deriveDisposition qualifying refusal (kusabi #293)", () => {
  const NAMED = "## Frozen tests vs src/foo.test.mjs — the test pins the old output";

  it("routes a qualifying refusal to refused-brief-defect and names the items", () => {
    const result = deriveDisposition({
      verdict: "discard", probesGreen: false, round: 1, maxRounds: 4,
      repeatedAreas: false, refusal: NAMED,
    });
    assert.equal(result.disposition, "refused-brief-defect");
    assert.match(result.reason, /brief contradicts itself/);
    assert.match(result.reason, /## Frozen tests vs src\/foo\.test\.mjs/);
  });

  it("accepts a bare `true` marker, with no named items in the reason", () => {
    const result = deriveDisposition({
      verdict: "discard", probesGreen: false, round: 1, maxRounds: 4,
      repeatedAreas: false, refusal: true,
    });
    assert.equal(result.disposition, "refused-brief-defect");
    assert.doesNotMatch(result.reason, /—/);
  });

  it("takes precedence over the P5/P6 oracle violation", () => {
    const result = deriveDisposition({
      verdict: "approve", probesGreen: false, round: 1, maxRounds: 4,
      repeatedAreas: false, oracleViolation: "P5: frozen — tests/frozen.test.mjs",
      refusal: NAMED,
    });
    assert.equal(result.disposition, "refused-brief-defect");
  });

  it("takes precedence over the max-rounds terminal (never spends the last round)", () => {
    const result = deriveDisposition({
      verdict: "needs-attention", probesGreen: false, round: 4, maxRounds: 4,
      repeatedAreas: true, refusal: NAMED,
    });
    assert.equal(result.disposition, "refused-brief-defect");
  });

  it("never accepts, whatever the verdict says", () => {
    const result = deriveDisposition({
      verdict: "approve", probesGreen: true, round: 1, maxRounds: 4,
      repeatedAreas: false, refusal: NAMED,
    });
    assert.equal(result.disposition, "refused-brief-defect");
  });

  it("is inert when absent, false, or an empty string — every other row is untouched", () => {
    for (const refusal of [undefined, null, false, "", "   "]) {
      const result = deriveDisposition({
        verdict: "approve", probesGreen: true, round: 1, maxRounds: 4,
        repeatedAreas: false, refusal,
      });
      assert.deepEqual(result, { disposition: "accept" }, "refusal=" + JSON.stringify(refusal));
    }
  });
});

// deriveDisposition — brief-syntax defect (kusabi #303)
// ---------------------------------------------------------------------------
// A probe whose INPUT is the brief cannot be turned green by the worker, so
// the normal table's `probesGreen=false → rework` row buys rounds that are
// unwinnable by construction.  The row below is terminal, attributes the
// defect to the brief, and must not disturb any worktree-reachable failure.

describe("deriveDisposition brief-syntax defect (kusabi #303)", () => {
  const DEFECT = "P5: frozen: ## Frozen Tests heading present but no entries parsed";

  it("routes a brief-syntax probe failure to the terminal refused-brief-defect", () => {
    const result = deriveDisposition({
      verdict: "needs-attention", probesGreen: false, round: 1, maxRounds: 4,
      repeatedAreas: false, findingSeverities: ["high"], briefSyntaxDefect: DEFECT,
    });
    assert.equal(result.disposition, "refused-brief-defect");
    // The three properties the terminal must carry.
    assert.match(result.reason, /## Frozen Tests/);            // names the section
    assert.match(result.reason, /brief author's defect, not the worker's/); // attribution
    assert.match(result.reason, /Fix the brief and re-dispatch/);           // the fix
  });

  it("replaces the rework the same evidence would otherwise have bought", () => {
    // Same inputs, marker removed: this is the rework #303 stops buying.
    const withoutMarker = deriveDisposition({
      verdict: "needs-attention", probesGreen: false, round: 1, maxRounds: 4,
      repeatedAreas: false, findingSeverities: ["low"],
    });
    assert.equal(withoutMarker.disposition, "rework");
  });

  it("accepts a bare `true` marker, with no section named in the reason", () => {
    const result = deriveDisposition({
      verdict: "needs-attention", probesGreen: false, round: 1, maxRounds: 4,
      repeatedAreas: false, briefSyntaxDefect: true,
    });
    assert.equal(result.disposition, "refused-brief-defect");
    assert.doesNotMatch(result.reason, /—/);
  });

  it("yields to the worker's own refusal, which is the more specific statement", () => {
    const result = deriveDisposition({
      verdict: "discard", probesGreen: false, round: 1, maxRounds: 4,
      repeatedAreas: false,
      refusal: "## Frozen tests vs src/foo.test.mjs — the test pins the old output",
      briefSyntaxDefect: DEFECT,
    });
    assert.equal(result.disposition, "refused-brief-defect");
    assert.match(result.reason, /brief contradicts itself/);
  });

  it("takes precedence over the oracle, the max-rounds terminal and every accept row", () => {
    const rows = [
      { verdict: "approve", probesGreen: false, round: 1, oracleViolation: "P5: frozen — tests/a.test.mjs" },
      { verdict: "needs-attention", probesGreen: false, round: 4, repeatedAreas: true },
      { verdict: "approve", probesGreen: true, round: 1 },
      { verdict: "needs-attention", probesGreen: true, round: 1, findingSeverities: ["low"] },
      { verdict: "discard", probesGreen: false, round: 2 },
    ];
    for (const row of rows) {
      const result = deriveDisposition({
        maxRounds: 4, repeatedAreas: false, ...row, briefSyntaxDefect: DEFECT,
      });
      assert.equal(result.disposition, "refused-brief-defect", JSON.stringify(row));
    }
  });

  it("appends a same-round oracle violation to the terminal reason instead of dropping it", () => {
    const result = deriveDisposition({
      verdict: "approve", probesGreen: false, round: 1, maxRounds: 4,
      repeatedAreas: false, briefSyntaxDefect: DEFECT,
      oracleViolation: "P6: collected count dropped from 142 to 141",
    });
    assert.equal(result.disposition, "refused-brief-defect");
    // The terminal still names the brief section...
    assert.match(result.reason, /## Frozen Tests/);
    // ...and now also names the measured oracle violation, so the operator
    // re-dispatches knowing a count drop was measured this same round (a
    // fresh chain re-baselines the collected count and the measurement
    // would otherwise never recur).
    assert.match(result.reason, /ADDITIONALLY a deterministic oracle violation was measured this same round/);
    assert.match(result.reason, /P6: collected count dropped from 142 to 141/);
    // The wording must hold for P5 frozen violations too, so it speaks of the
    // evidence dying with the chain rather than of re-baselining alone
    // (replacement-seat finding, kusabi #306).
    assert.match(result.reason, /so it will not resurface on its own/);
  });

  it("appends the same oracle sentence to the worker-refusal terminal (kusabi #306 sibling)", () => {
    const result = deriveDisposition({
      verdict: "approve", probesGreen: false, round: 1, maxRounds: 4,
      repeatedAreas: false, refusal: "Deliverables vs Non-goals name the same file",
      oracleViolation: "P5: frozen: tests/a.test.mjs changed",
    });
    assert.equal(result.disposition, "refused-brief-defect");
    assert.match(result.reason, /worker refused/);
    assert.match(result.reason, /ADDITIONALLY a deterministic oracle violation was measured this same round/);
    assert.match(result.reason, /P5: frozen: tests\/a\.test\.mjs changed/);
  });

  it("keeps the worker-refusal reason verbatim when no oracle violation rides along", () => {
    const result = deriveDisposition({
      verdict: "approve", probesGreen: false, round: 1, maxRounds: 4,
      repeatedAreas: false, refusal: "Deliverables vs Non-goals name the same file",
    });
    assert.equal(result.disposition, "refused-brief-defect");
    assert.equal(
      result.reason,
      "worker refused: the brief contradicts itself, no implementation satisfies both items — " +
        "Deliverables vs Non-goals name the same file",
    );
  });

  it("keeps today's reason verbatim when no oracle violation rides along", () => {
    const result = deriveDisposition({
      verdict: "needs-attention", probesGreen: false, round: 1, maxRounds: 4,
      repeatedAreas: false, findingSeverities: ["high"], briefSyntaxDefect: DEFECT,
    });
    assert.equal(result.disposition, "refused-brief-defect");
    assert.equal(
      result.reason,
      "brief-syntax defect: a probe reads a brief section that declares nothing — " + DEFECT +
        ". The probe's input is the brief, not the worktree, so no worker edit can turn it green " +
        "and no rework is winnable; this is the brief author's defect, not the worker's. " +
        "Fix the brief and re-dispatch.",
    );
  });

  it("is inert when absent, false, or an empty string — worktree-reachable failures route as before", () => {
    for (const marker of [undefined, null, false, "", "   "]) {
      // verify red / deliverables untouched: still a rework.
      assert.equal(
        deriveDisposition({
          verdict: "approve", probesGreen: false, round: 1, maxRounds: 4,
          repeatedAreas: false, briefSyntaxDefect: marker,
        }).disposition,
        "rework",
        "marker=" + JSON.stringify(marker),
      );
      // a frozen-path intersection: still the oracle escalate.
      assert.equal(
        deriveDisposition({
          verdict: "approve", probesGreen: false, round: 1, maxRounds: 4,
          repeatedAreas: false, oracleViolation: "P5: frozen — tests/a.test.mjs",
          briefSyntaxDefect: marker,
        }).disposition,
        "escalate",
      );
      // green everything: still an accept.
      assert.deepEqual(
        deriveDisposition({
          verdict: "approve", probesGreen: true, round: 1, maxRounds: 4,
          repeatedAreas: false, briefSyntaxDefect: marker,
        }),
        { disposition: "accept" },
      );
    }
  });
});


// deriveDisposition — Sol audit veto (kusabi #524/#528)
// ---------------------------------------------------------------------------
// The deterministic audit policy decides WHEN Sol is mandatory; the Sol seat
// produces the verdict; this row turns a veto into the terminal sol-blocked
// disposition.  Precedence: refusal → briefSyntaxDefect → oracleViolation
// → sol-blocked → existing table.

describe("deriveDisposition — Sol audit veto (sol-blocked)", () => {
  it("a valid `block` verdict yields sol-blocked even on a sampled-only gate", () => {
    const result = deriveDisposition({
      verdict: "approve", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false,
      solVerdict: "block", solGateRequired: false,
    });
    assert.equal(result.disposition, "sol-blocked");
    assert.match(result.reason, /verdict=block/);
    assert.match(result.reason, /human override/);
  });

  it("a required gate with no valid verdict fails closed (fail-closed, not fail-open)", () => {
    const result = deriveDisposition({
      verdict: "approve", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false,
      solVerdict: null, solGateRequired: true,
    });
    assert.equal(result.disposition, "sol-blocked");
    assert.match(result.reason, /mandatory/);
    assert.match(result.reason, /fails closed/);
  });

  it("rework is NOT a clearing verdict — a required gate with rework fails closed", () => {
    const result = deriveDisposition({
      verdict: "approve", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false,
      solVerdict: "rework", solGateRequired: true,
    });
    assert.equal(result.disposition, "sol-blocked");
    assert.match(result.reason, /verdict="rework"/);
  });

  it("a required gate with a valid `clear` verdict clears — the existing table decides", () => {
    const result = deriveDisposition({
      verdict: "approve", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false,
      solVerdict: "clear", solGateRequired: true,
    });
    assert.deepEqual(result, { disposition: "accept" });
  });

  it("sampled-only Sol FAILURE fails open — no verdict on a non-required gate is not a block", () => {
    const result = deriveDisposition({
      verdict: "needs-attention", probesGreen: false, round: 1, maxRounds: 3,
      repeatedAreas: false, findingSeverities: ["low"],
      solVerdict: null, solGateRequired: false,
    });
    // The existing table routes this as before; the chain is NOT sol-blocked.
    assert.deepEqual(result, { disposition: "rework", reason: "needs-attention" });
  });

  it("sampled-only rework is not a block either — only an actual block veto blocks", () => {
    const result = deriveDisposition({
      verdict: "approve", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false,
      solVerdict: "rework", solGateRequired: false,
    });
    assert.deepEqual(result, { disposition: "accept" });
  });

  it("precedence: refusal → briefSyntaxDefect → oracleViolation → sol-blocked", () => {
    const refused = deriveDisposition({
      verdict: "approve", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false,
      refusal: "## A vs b.mjs", solVerdict: "block", solGateRequired: true,
    });
    assert.equal(refused.disposition, "refused-brief-defect");

    const brief = deriveDisposition({
      verdict: "approve", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false,
      briefSyntaxDefect: "P5: ## Frozen Tests heading present but no entries parsed",
      solVerdict: "block", solGateRequired: true,
    });
    assert.equal(brief.disposition, "refused-brief-defect");

    const oracle = deriveDisposition({
      verdict: "approve", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false,
      oracleViolation: "P5: frozen — tests/a.test.mjs", solVerdict: "block", solGateRequired: true,
    });
    assert.equal(oracle.disposition, "escalate");
    assert.match(oracle.reason, /oracle violation/);
  });

  it("sol-blocked preempts the high/critical gate, max-rounds, strategize and every accept/rework row", () => {
    const rows = [
      { verdict: "needs-attention", probesGreen: true, findingSeverities: ["high"] },
      { verdict: "needs-attention", probesGreen: true, round: 3, maxRounds: 3, findingSeverities: ["low"] },
      { verdict: "needs-attention", probesGreen: true, repeatedAreas: true, strategizeEligible: true },
      { verdict: "needs-attention", probesGreen: true, findingSeverities: ["low", "medium"] },
      { verdict: "approve", probesGreen: false },
      { verdict: "approve", probesGreen: true },
      { verdict: "needs-attention", probesGreen: false },
      { verdict: "discard", probesGreen: true },
      { verdict: "approve-partial", probesGreen: true },
    ];
    for (const row of rows) {
      const result = deriveDisposition({
        round: 1, maxRounds: 3, repeatedAreas: false,
        ...row, solVerdict: "block", solGateRequired: false,
      });
      assert.equal(result.disposition, "sol-blocked", JSON.stringify(row));
    }
  });

  // ---- audit input validation (kusabi #528 repair) ----
  // The audit inputs are validated BEFORE the precedence table: an unknown,
  // type-confused, or whitespace-padded `solVerdict` (or a non-boolean
  // `solGateRequired`) must fail loudly and must NEVER fall through to the
  // ordinary table, where an approve+green round would be accepted.

  it("an unknown solVerdict fails loudly even on the exact accept-shaped round", () => {
    // The trap the repair closes: approve + green probes + an unrecognised
    // verdict would previously sail through to `accept`.
    assert.throws(
      () => deriveDisposition({
        verdict: "approve", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false,
        solVerdict: "maybe", solGateRequired: false,
      }),
      /solVerdict must be null or one of clear, rework, block/,
    );
    assert.throws(
      () => deriveDisposition({
        verdict: "approve", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false,
        solVerdict: "maybe", solGateRequired: true,
      }),
      /solVerdict must be null or one of clear, rework, block/,
    );
  });

  it("type-confused and whitespace-padded solVerdict values fail loudly, never accept", () => {
    for (const bad of [3, "CLEAR", " clear ", "", true, ["block"]]) {
      assert.throws(
        () => deriveDisposition({
          verdict: "approve", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false,
          solVerdict: bad,
        }),
        /solVerdict must be null or one of clear, rework, block/,
        JSON.stringify(bad),
      );
    }
  });

  it("solGateRequired must be a boolean when supplied", () => {
    for (const bad of ["yes", 1, null, "true", {}]) {
      assert.throws(
        () => deriveDisposition({
          verdict: "approve", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false,
          solVerdict: "block", solGateRequired: bad,
        }),
        /solGateRequired must be a boolean/,
        JSON.stringify(bad),
      );
    }
  });

  it("audit input validation runs BEFORE the precedence table — even a refusal cannot mask it", () => {
    assert.throws(
      () => deriveDisposition({
        verdict: "approve", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false,
        refusal: "## A vs b.mjs", solVerdict: "maybe",
      }),
      /solVerdict must be null or one of clear, rework, block/,
    );
  });

  it("the inert audit spellings never throw and leave every row unchanged", () => {
    for (const audit of [undefined, { solVerdict: null }, { solGateRequired: false }, { solVerdict: null, solGateRequired: false }]) {
      const result = deriveDisposition({
        verdict: "approve", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false, ...audit,
      });
      assert.deepEqual(result, { disposition: "accept" }, JSON.stringify(audit));
    }
  });

  it("regression: absent audit inputs leave every existing row deep-equal, with no new keys", () => {
    const cases = [
      { input: { verdict: "approve", probesGreen: true }, expected: { disposition: "accept" } },
      { input: { verdict: "approve", probesGreen: false }, expected: { disposition: "rework", reason: "deterministic probes failed" } },
      { input: { verdict: "needs-attention", probesGreen: false, findingSeverities: ["low"] }, expected: { disposition: "rework", reason: "needs-attention" } },
      { input: { verdict: "needs-attention", probesGreen: true, findingSeverities: ["low", "medium"] }, expected: { disposition: "accept-with-followup", reason: "probes green; remaining findings all minor" } },
      { input: { verdict: "needs-attention", probesGreen: true, repeatedAreas: true, strategizeEligible: true }, expected: { disposition: "strategize", reason: "same file area flagged twice; structural re-diagnosis before next rework" } },
      { input: { verdict: "needs-attention", probesGreen: false, round: 3, maxRounds: 3, findingSeverities: ["low"] }, expected: { disposition: "escalate", reason: "max rounds (3) reached without acceptance" } },
      { input: { verdict: "discard", probesGreen: true }, expected: { disposition: "escalate", reason: "reviewer discarded the work" } },
      { input: { verdict: "approve-partial", probesGreen: true }, expected: { disposition: "escalate", reason: "approve-partial: unverified items remain" } },
      { input: { verdict: "approve", probesGreen: false, repeatedAreas: true }, expected: { disposition: "escalate", reason: "deterministic probes failed; same file area flagged for two consecutive rounds" } },
    ];
    // Both spellings of "no audit inputs": the parameter absent, and the
    // explicit inert defaults (null / false).
    for (const audit of [undefined, { solVerdict: null, solGateRequired: false }]) {
      for (const row of cases) {
        const result = deriveDisposition({
          round: 1, maxRounds: 3, repeatedAreas: false, ...row.input, ...audit,
        });
        assert.deepEqual(result, row.expected, `${JSON.stringify(audit)} / ${JSON.stringify(row.input)}`);
        // No undefined/null keys introduced on old records.
        assert.deepEqual(Object.keys(result).sort(), Object.keys(row.expected).sort());
      }
    }
  });
});
