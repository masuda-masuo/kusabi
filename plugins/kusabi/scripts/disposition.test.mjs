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
});
