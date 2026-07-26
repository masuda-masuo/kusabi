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
});

// deriveReworkStrategy — default ladder and evidence rules (B2/B3/B4/B5)
// ---------------------------------------------------------------------------

describe("deriveReworkStrategy", () => {
  // B3: Default ladder
  it("1st rework: same tier, continue session, keep artifacts", () => {
    const result = deriveReworkStrategy({
      reworkCount: 0,
      repeatedAreas: false,
      previousFindingsAvailable: true,
      strategized: false,
    });
    assert.equal(result.tierDelta, 0);
    assert.equal(result.newSession, false);
    assert.equal(result.restoreBase, false);
    assert.match(result.reason, /1st rework/);
    assert.match(result.reason, /same tier/);
    assert.match(result.reason, /continue session/);
  });

  it("2nd rework: +1 tier, new session, keep artifacts", () => {
    const result = deriveReworkStrategy({
      reworkCount: 1,
      repeatedAreas: false,
      previousFindingsAvailable: true,
      strategized: false,
    });
    assert.equal(result.tierDelta, 1);
    assert.equal(result.newSession, true);
    assert.equal(result.restoreBase, false);
    assert.match(result.reason, /2nd rework/);
    assert.match(result.reason, /escalate tier/);
    assert.match(result.reason, /new session/);
  });

  it("3rd rework: +1 tier, new session, keep artifacts", () => {
    const result = deriveReworkStrategy({
      reworkCount: 2,
      repeatedAreas: false,
      previousFindingsAvailable: true,
      strategized: false,
    });
    assert.equal(result.tierDelta, 1);
    assert.equal(result.newSession, true);
    assert.equal(result.restoreBase, false);
    assert.match(result.reason, /3th rework/);
    assert.match(result.reason, /escalate tier/);
    assert.match(result.reason, /new session/);
  });

  // B4: Restore suppression rules
  it("restore suppressed when previous round resolved all findings (no repeated areas)", () => {
    // previousFindingsAvailable=true but !repeatedAreas => priorFindingsResolved => restore=false
    const result = deriveReworkStrategy({
      reworkCount: 1,
      repeatedAreas: false,
      previousFindingsAvailable: true,
      strategized: false,
    });
    assert.equal(result.restoreBase, false);
    assert.ok(!result.reason.includes("restore base"));
  });

  it("restore suppressed when previous findings unavailable (unparseable)", () => {
    const result = deriveReworkStrategy({
      reworkCount: 1,
      repeatedAreas: true,
      previousFindingsAvailable: false,
      strategized: false,
    });
    assert.equal(result.restoreBase, false);
    assert.ok(!result.reason.includes("restore base"));
  });

  it("restore suppressed when previous findings empty", () => {
    const result = deriveReworkStrategy({
      reworkCount: 1,
      repeatedAreas: false,
      previousFindingsAvailable: false,
      strategized: false,
    });
    assert.equal(result.restoreBase, false);
  });

  it("restore fires when previous findings available and unresolved (repeated areas)", () => {
    const result = deriveReworkStrategy({
      reworkCount: 1,
      repeatedAreas: true,
      previousFindingsAvailable: true,
      strategized: false,
    });
    assert.equal(result.restoreBase, true);
    assert.match(result.reason, /restore base/);
    assert.match(result.reason, /prior findings unresolved/);
  });

  // B5: New session does not imply restoring artifacts
  it("new session with artifacts kept: restoreBase=false, newSession=true", () => {
    const result = deriveReworkStrategy({
      reworkCount: 1,
      repeatedAreas: false,
      previousFindingsAvailable: true,
      strategized: false,
    });
    // Default 2nd rework: new session, keep artifacts
    assert.equal(result.newSession, true);
    assert.equal(result.restoreBase, false);
  });

  // Strategized forces fresh session
  it("strategized forces new session on 1st rework", () => {
    const result = deriveReworkStrategy({
      reworkCount: 0,
      repeatedAreas: false,
      previousFindingsAvailable: true,
      strategized: true,
    });
    assert.equal(result.newSession, true); // Would be false without strategized
    assert.equal(result.tierDelta, 0);
    assert.match(result.reason, /new session.*strategized/);
  });

  // B4 guarantee: no call path in which a round both lacks prior findings and restores artifacts
  it("AC5: no restore when previous findings unavailable", () => {
    const result = deriveReworkStrategy({
      reworkCount: 0,
      repeatedAreas: true,
      previousFindingsAvailable: false,
      strategized: false,
    });
    assert.equal(result.restoreBase, false);
  });

  it("AC5: no restore when previous findings resolved", () => {
    const result = deriveReworkStrategy({
      reworkCount: 1,
      repeatedAreas: false,
      previousFindingsAvailable: true,
      strategized: false,
    });
    assert.equal(result.restoreBase, false);
  });

  it("AC5: no restore when both conditions (unavailable + resolved) hold", () => {
    const result = deriveReworkStrategy({
      reworkCount: 1,
      repeatedAreas: false,
      previousFindingsAvailable: false,
      strategized: false,
    });
    assert.equal(result.restoreBase, false);
  });
});
