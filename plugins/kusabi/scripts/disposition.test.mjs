import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveDisposition,
  resolveResumeMethod,
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

// resolveResumeMethod — pure function for resume strategy decisions
// ---------------------------------------------------------------------------

describe("resolveResumeMethod", () => {
  it("round 1 returns continue_session", () => {
    const result = resolveResumeMethod({ round: 1, strategized: false });
    assert.deepEqual(result, { type: "continue_session" });
  });

  it("round 1 returns continue_session even when strategized is true (impossible but defensive)", () => {
    const result = resolveResumeMethod({ round: 1, strategized: true });
    assert.deepEqual(result, { type: "continue_session" });
  });

  it("round 2 with strategized=false returns continue_session", () => {
    const result = resolveResumeMethod({ round: 2, strategized: false });
    assert.deepEqual(result, { type: "continue_session" });
  });

  it("round 2 with strategized=true returns fresh_session (after strategize, force new session)", () => {
    const result = resolveResumeMethod({ round: 2, strategized: true });
    assert.deepEqual(result, { type: "fresh_session" });
  });

  it("round 3 with strategized=false returns fresh_session", () => {
    const result = resolveResumeMethod({ round: 3, strategized: false });
    assert.deepEqual(result, { type: "fresh_session" });
  });

  it("round 3 with strategized=true returns fresh_session", () => {
    const result = resolveResumeMethod({ round: 3, strategized: true });
    assert.deepEqual(result, { type: "fresh_session" });
  });

  it("round 4+ always returns fresh_session", () => {
    assert.deepEqual(resolveResumeMethod({ round: 4, strategized: false }), { type: "fresh_session" });
    assert.deepEqual(resolveResumeMethod({ round: 5, strategized: true }), { type: "fresh_session" });
  });
});

