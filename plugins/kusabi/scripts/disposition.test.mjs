import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveDisposition,
  deriveReworkStrategy,
} from "./disposition.mjs";

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

  it("rework: needs-attention without repeated areas", () => {
    const result = deriveDisposition({ verdict: "needs-attention", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false });
    assert.deepEqual(result, { disposition: "rework", reason: "needs-attention" });
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

  it("rework (unchanged): one high among lows → not eligible for accept-with-followup", () => {
    const result = deriveDisposition({ verdict: "needs-attention", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false, findingSeverities: ["low", "high", "low"] });
    assert.deepEqual(result, { disposition: "rework", reason: "needs-attention" });
  });

  it("rework (unchanged): probes red + minors → not eligible for accept-with-followup", () => {
    const result = deriveDisposition({ verdict: "needs-attention", probesGreen: false, round: 1, maxRounds: 3, repeatedAreas: false, findingSeverities: ["low", "medium"] });
    assert.deepEqual(result, { disposition: "rework", reason: "needs-attention" });
  });

  it("escalate (unchanged): approve-partial + minors → not eligible for accept-with-followup", () => {
    const result = deriveDisposition({ verdict: "approve-partial", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false, findingSeverities: ["low", "low"] });
    assert.deepEqual(result, { disposition: "escalate", reason: "approve-partial: unverified items remain" });
  });

  it("today's behavior: undefined findingSeverities", () => {
    const result = deriveDisposition({ verdict: "needs-attention", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false });
    assert.deepEqual(result, { disposition: "rework", reason: "needs-attention" });
  });

  it("today's behavior: empty findingSeverities array", () => {
    const result = deriveDisposition({ verdict: "needs-attention", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false, findingSeverities: [] });
    assert.deepEqual(result, { disposition: "rework", reason: "needs-attention" });
  });

  it("rework (unchanged): critical severity among lows", () => {
    const result = deriveDisposition({ verdict: "needs-attention", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false, findingSeverities: ["critical", "low"] });
    assert.deepEqual(result, { disposition: "rework", reason: "needs-attention" });
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

  it("escalate: needs-attention + repeatedAreas + a high finding + round === maxRounds → reason mentions same file area", () => {
    const result = deriveDisposition({ verdict: "needs-attention", probesGreen: true, round: 3, maxRounds: 3, repeatedAreas: true, findingSeverities: ["high", "low"] });
    assert.equal(result.disposition, "escalate");
    assert.match(result.reason, /same file area flagged/);
  });

  // Regression guard: repeats + eligible + round < maxRounds still strategizes
  // (already covered above by "strategize: repeatedAreas + strategizeEligible true", round 2 of 3).
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
      { input: { verdict: "needs-attention", probesGreen: true }, expected: { disposition: "rework", reason: "needs-attention" } },
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
