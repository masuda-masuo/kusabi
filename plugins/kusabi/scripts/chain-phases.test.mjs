import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  shouldSkipReview,
  runReviewPhase,
} from "./chain-review.mjs";
import {
  resolveReworkScope,
  computeChainTotals,
  resolveRoundResume,
  captureVerifyBaseline,
  runStrategizePhase,
  normalizeFilePath,
  hasRepeatedAreas,
  applyTierEscalation,
  recordReworkEscalation,
  persistChainState,
  writeReviewRecord,
  collectContainerBaseContext,
  collectContainerReviewInput,
  collectChangeScope,
  assertContainerBaseRef,
  collectReviewContext,
  classifyDispatchQuotaExhaustion,
  quotaExhaustionReason,
} from "./chain-phases.mjs";
import { renderPriorFindings } from "./render.mjs";
import { readJson } from "./state-paths.mjs";

describe("captureVerifyBaseline", () => {
  it("records gate_passed, counts, and the raw result from a gate-failing base", async () => {
    const verifyResult = {
      gate_passed: false,
      lint: [{ rule: "no-unused-vars" }, { rule: "no-undef" }],
      types: [],
      tests: { status: "skipped", message: "precondition gate failed; tests not run" },
      gate_fail_reasons: ["lint (eslint): 2 violation(s)"],
    };
    const fakeTool = async (toolName) => (toolName === "verify_in_container" ? verifyResult : { output: "" });
    const baseline = await captureVerifyBaseline(fakeTool, "fake-cid");
    assert.equal(baseline.captured, true);
    assert.equal(baseline.gate_passed, false);
    assert.equal(baseline.lint, 2);
    assert.equal(baseline.types, 0);
    assert.equal(baseline.raw, verifyResult);
  });

  it("records a clean gate-failing base with zero lint and types", async () => {
    const fakeTool = async () => ({
      gate_passed: true,
      lint: [],
      types: [],
      tests: { full: { status: "ok", passed: 100, total: 100 } },
    });
    const baseline = await captureVerifyBaseline(fakeTool, "fake-cid");
    assert.equal(baseline.captured, true);
    assert.equal(baseline.gate_passed, true);
    assert.equal(baseline.lint, 0);
    assert.equal(baseline.types, 0);
  });

  it("degrades to captured:false when the RPC call throws", async () => {
    const fakeTool = async () => { throw new Error("container unreachable"); };
    const baseline = await captureVerifyBaseline(fakeTool, "fake-cid");
    assert.equal(baseline.captured, false);
    assert.match(baseline.error, /container unreachable/);
  });
});

// resolveReworkScope — kusabi #60 step 2: rework scheduling by finding kind
// =========================================================================
// Single decision point mapping the previous round's findings to the scope
// of the next rework round: "full" | "mechanical" | "design" plus the scoped
// subset.  Missing/invalid kind counts as design (same consumption-point
// default as groupFindingsByKind); subset order follows array order.

describe("resolveReworkScope", () => {
  const mech = (n, file) => ({ severity: "medium", title: "Mech " + n, file, line_start: 1, kind: "mechanical" });
  const design = (n, file) => ({ severity: "high", title: "Design " + n, file, line_start: 1, kind: "design" });

  it("returns full scope with no findings when there is no previous record", () => {
    assert.deepEqual(resolveReworkScope(null), { scope: "full", findings: [] });
    assert.deepEqual(resolveReworkScope(undefined), { scope: "full", findings: [] });
  });

  it("returns full scope when the previous round has no findings (probe-failure rework)", () => {
    assert.deepEqual(resolveReworkScope({ findings: [] }), { scope: "full", findings: [] });
    assert.deepEqual(resolveReworkScope({}), { scope: "full", findings: [] });
    // Old records without a structured findings array keep today's behavior.
    assert.deepEqual(resolveReworkScope({ findingsText: "(no structured findings)" }), { scope: "full", findings: [] });
  });

  it("returns full scope when the findings array holds nothing groupable", () => {
    assert.deepEqual(resolveReworkScope({ findings: [42, "x"] }), { scope: "full", findings: [] });
  });

  it("returns mechanical scope with only the mechanical findings when both kinds are present", () => {
    const findings = [design(1, "src/a.js"), mech(1, "src/b.js"), mech(2, "src/c.js")];
    const result = resolveReworkScope({ findings });
    assert.equal(result.scope, "mechanical");
    assert.deepEqual(result.findings, [findings[1], findings[2]]);
  });

  it("after a mechanical round a mixed set schedules the FIRST design finding (no two mechanical rounds in a row)", () => {
    // Followup: the mixed -> mechanical branch must not starve a pending
    // design finding; the mechanical items wait for the next batch.
    const findings = [design(1, "src/a.js"), mech(1, "src/b.js"), mech(2, "src/c.js")];
    const result = resolveReworkScope({ findings, reworkScope: "mechanical" });
    assert.equal(result.scope, "design");
    assert.deepEqual(result.findings, [findings[0]]);
  });

  it("mixed sets stay mechanical-first when the previous round was NOT mechanical-scoped", () => {
    const findings = [design(1, "src/a.js"), mech(1, "src/b.js")];
    // Explicit other scopes and old records without a reworkScope field all
    // keep the pre-followup behavior.
    assert.equal(resolveReworkScope({ findings, reworkScope: "full" }).scope, "mechanical");
    assert.equal(resolveReworkScope({ findings, reworkScope: "design" }).scope, "mechanical");
    assert.equal(resolveReworkScope({ findings }).scope, "mechanical");
    assert.equal(resolveReworkScope({ findings, reworkScope: undefined }).scope, "mechanical");
  });

  it("mechanical-only sets stay mechanical even right after a mechanical round (no design pending)", () => {
    const findings = [mech(1, "src/b.js"), mech(2, "src/c.js")];
    const result = resolveReworkScope({ findings, reworkScope: "mechanical" });
    assert.equal(result.scope, "mechanical");
    assert.deepEqual(result.findings, findings);
  });

  it("all-design sets are unaffected by the previous round's scope", () => {
    const findings = [design(1, "src/a.js"), design(2, "src/b.js")];
    const result = resolveReworkScope({ findings, reworkScope: "mechanical" });
    assert.equal(result.scope, "design");
    assert.deepEqual(result.findings, [findings[0]]);
    const single = resolveReworkScope({ findings: [findings[0]], reworkScope: "mechanical" });
    assert.equal(single.scope, "design");
    assert.deepEqual(single.findings, [findings[0]]);
  });

  it("treats a missing kind as design when grouping mixed findings", () => {
    const findings = [
      { severity: "high", title: "No kind", file: "src/a.js", line_start: 1 },
      mech(1, "src/b.js"),
    ];
    const result = resolveReworkScope({ findings });
    assert.equal(result.scope, "mechanical");
    assert.deepEqual(result.findings, [findings[1]]);
  });

  it("returns design scope with the FIRST design finding in array order when all design and length > 1", () => {
    const findings = [design(1, "src/a.js"), design(2, "src/b.js"), design(3, "src/c.js")];
    const result = resolveReworkScope({ findings });
    assert.equal(result.scope, "design");
    assert.deepEqual(result.findings, [findings[0]]);
    // Array-order stability: the first finding in the array wins, regardless
    // of title/severity.
    const reversed = [design(9, "src/z.js"), design(2, "src/b.js")];
    assert.deepEqual(resolveReworkScope({ findings: reversed }).findings, [reversed[0]]);
  });

  it("returns design scope with the single finding when all design and length == 1", () => {
    const findings = [design(1, "src/a.js")];
    const result = resolveReworkScope({ findings });
    assert.equal(result.scope, "design");
    assert.deepEqual(result.findings, findings);
  });

  it("returns mechanical scope with all findings when every finding is mechanical", () => {
    const findings = [mech(1, "src/b.js"), mech(2, "src/c.js")];
    const result = resolveReworkScope({ findings });
    assert.equal(result.scope, "mechanical");
    assert.deepEqual(result.findings, findings);
  });
});
// renderPriorFindings — pure function exported from render.mjs
// =========================================================================

describe("renderPriorFindings", () => {

  it("returns '(none)' when previousRecord is null", () => {
    assert.equal(renderPriorFindings(null), "(none)");
  });

  it("returns '(none)' when previousRecord is undefined", () => {
    assert.equal(renderPriorFindings(undefined), "(none)");
  });

  it("falls back to findingsText when no structured findings array", () => {
    const prev = { findingsText: "[high] thing (f:1)" };
    const result = renderPriorFindings(prev);
    assert.equal(result, "[high] thing (f:1)");
  });

  it("falls back to '(none)' when no findingsText and no findings array", () => {
    const prev = {};
    assert.equal(renderPriorFindings(prev), "(none)");
  });

  // ---- kusabi #60 step 1: grouped rework brief ----
  // Design findings come FIRST, explicitly flagged as requiring deliberate
  // individual treatment; mechanical findings follow as a checklist.  When
  // every finding is one kind, a single section is emitted.

  it("groups mixed-kind findings: design section first, mechanical checklist after", () => {
    const prev = {
      findings: [
        { severity: "low", title: "Rename", file: "a.js", line_start: 1, kind: "mechanical", body: "b1", recommendation: "rename it" },
        { severity: "high", title: "Policy call", file: "b.js", line_start: 2, kind: "design", body: "b2", recommendation: "decide" },
        { severity: "medium", title: "Dead code", file: "c.js", line_start: 3, kind: "mechanical", body: "b3", recommendation: "remove" },
      ],
    };
    const result = renderPriorFindings(prev);
    const designIdx = result.indexOf("Design findings (require deliberate individual treatment)");
    const mechIdx = result.indexOf("Mechanical findings (checklist)");
    assert.ok(designIdx >= 0, result);
    assert.ok(mechIdx >= 0, result);
    // Design FIRST, mechanical AFTER.
    assert.ok(designIdx < mechIdx, result);
    // The design finding (and its full body/recommendation) precedes the
    // mechanical checklist entries.
    assert.ok(result.indexOf("Policy call") < result.indexOf("Rename"));
    assert.ok(result.indexOf("decide") < result.indexOf("rename it"));
    // Every finding keeps its full block rendering.
    assert.ok(result.includes("### [high] Policy call (b.js:2)"));
    assert.ok(result.includes("### [low] Rename (a.js:1)"));
    assert.ok(result.includes("### [medium] Dead code (c.js:3)"));
  });

  it("emits a single design section when every finding lacks a kind tag", () => {
    const prev = {
      findings: [
        { severity: "low", title: "No kind", file: "a.js", line_start: 1 },
        { severity: "medium", title: "Also no kind", file: "b.js", line_start: 2 },
      ],
    };
    const result = renderPriorFindings(prev);
    assert.ok(result.includes("Design findings (require deliberate individual treatment)"), result);
    assert.ok(!result.includes("Mechanical findings (checklist)"), result);
    assert.ok(result.includes("### [low] No kind (a.js:1)"));
    assert.ok(result.includes("### [medium] Also no kind (b.js:2)"));
  });

  it("emits a single mechanical section when every finding is mechanical", () => {
    const prev = {
      findings: [
        { severity: "low", title: "Rename", file: "a.js", line_start: 1, kind: "mechanical" },
        { severity: "low", title: "Remove", file: "b.js", line_start: 2, kind: "mechanical" },
      ],
    };
    const result = renderPriorFindings(prev);
    assert.ok(result.includes("Mechanical findings (checklist)"), result);
    assert.ok(!result.includes("Design findings (require deliberate individual treatment)"), result);
  });

  it("treats an invalid kind as design in the grouped prior findings", () => {
    const prev = {
      findings: [
        { severity: "high", title: "Odd kind", file: "a.js", line_start: 1, kind: "whatever" },
      ],
    };
    const result = renderPriorFindings(prev);
    assert.ok(result.includes("Design findings (require deliberate individual treatment)"), result);
    assert.ok(!result.includes("Mechanical findings (checklist)"), result);
    assert.ok(result.includes("### [high] Odd kind (a.js:1)"));
  });
});

describe("computeChainTotals", () => {
  it("returns zero totals for empty records", () => {
    const result = computeChainTotals([]);
    assert.deepEqual(result, { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  });

  it("sums implement usage across a single record", () => {
    const rec = {
      implementUsage: { available: true, input: 100, output: 200, reasoning: 30, cacheRead: 50, cacheWrite: 10, cost: 0.001 },
    };
    const result = computeChainTotals([rec]);
    assert.equal(result.input, 100);
    assert.equal(result.output, 200);
    assert.equal(result.reasoning, 30);
    assert.equal(result.cacheRead, 50);
    assert.equal(result.cacheWrite, 10);
    assert.equal(result.cost, 0.001);
  });

  it("sums implement + review usage across multiple records", () => {
    const records = [
      {
        implementUsage: { available: true, input: 50, output: 60, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
        reviewUsage: { available: true, input: 30, output: 40, reasoning: 10, cacheRead: 20, cacheWrite: 0, cost: 0.002 },
      },
      {
        implementUsage: { available: true, input: 70, output: 80, reasoning: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
        // review was skipped (no reviewUsage field)
      },
    ];
    const result = computeChainTotals(records);
    assert.equal(result.input, 150);   // 50+30+70
    assert.equal(result.output, 180);  // 60+40+80
    assert.equal(result.reasoning, 15); // 0+10+5
    assert.equal(result.cacheRead, 20); // 0+20+0
    assert.equal(result.cacheWrite, 0);
    assert.equal(result.cost, 0.004);  // 0.001+0.002+0.001
  });

  it("skips usage entries where available is false", () => {
    const records = [{
      implementUsage: { available: false, input: 999, output: 999 },
      reviewUsage: { available: true, input: 10, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
    }];
    const result = computeChainTotals(records);
    assert.equal(result.input, 10);
    assert.equal(result.output, 20);
  });

  it("includes reviewFirstUsage from retried rounds", () => {
    const records = [{
      implementUsage: { available: true, input: 50, output: 60, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
      reviewUsage: { available: true, input: 30, output: 40, reasoning: 10, cacheRead: 20, cacheWrite: 0, cost: 0.002 },
      reviewFirstUsage: { available: true, input: 5, output: 6, reasoning: 1, cacheRead: 2, cacheWrite: 0, cost: 0.0005 },
    }];
    const result = computeChainTotals(records);
    assert.equal(result.input, 85);    // 50+30+5
    assert.equal(result.output, 106);  // 60+40+6
    assert.equal(result.reasoning, 11); // 0+10+1
    assert.equal(result.cacheRead, 22); // 0+20+2
    assert.equal(result.cacheWrite, 0);
    assert.equal(result.cost, 0.0035); // 0.001+0.002+0.0005
  });

  it("handles missing usage fields as zeros", () => {
    const records = [
      { implementUsage: { available: true, input: 10, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.001 } },
      {}, // no usage fields at all
    ];
    const result = computeChainTotals([records[0]]);
    assert.equal(result.input, 10);
    assert.equal(result.output, 20);
  });
});

// resolveRoundResume  —  pure, synchronous, no container-mutating calls
// =========================================================================

describe("resolveRoundResume", () => {
  it("returns continue_session when useNewSession is false", () => {
    const result = resolveRoundResume({ useNewSession: false });
    assert.deepEqual(result, {
      resumeMethod: { type: "continue_session" },
      useNewSession: false,
    });
  });

  // AC4: a new session yields fresh_session with no container-mutating call
  it("returns fresh_session when useNewSession is true (no restore)", () => {
    const result = resolveRoundResume({ useNewSession: true });
    assert.equal(result.resumeMethod.type, "fresh_session");
    assert.equal(result.useNewSession, true);
    // No checkpoint_restore or checkpoint_restore_failed type
    assert.notEqual(result.resumeMethod.type, "checkpoint_restore");
    assert.notEqual(result.resumeMethod.type, "checkpoint_restore_failed");
  });
});

// =========================================================================
// classifyDispatchQuotaExhaustion (kusabi #373)
// =========================================================================

describe("classifyDispatchQuotaExhaustion", () => {
  it("classifies the observed agy individual-quota phrase and extracts the reset", () => {
    const text = "agy dispatch failed: agy returned no payload {\"status\":\"ERROR\",\"response\":\"\",\"error\":\"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h1m21s.\"}";
    const failure = classifyDispatchQuotaExhaustion(text);
    assert.equal(failure.kind, "quota-exhaustion");
    assert.equal(failure.backend, "agy");
    assert.equal(failure.quota, "individual");
    assert.equal(failure.backendBlocked, true);
    assert.equal(failure.reset, "1h1m21s");
    assert.match(quotaExhaustionReason(failure), /quota exhausted \(agy individual pool\)/);
    assert.match(quotaExhaustionReason(failure), /resets in 1h1m21s/);
    assert.doesNotMatch(quotaExhaustionReason(failure), /unparseable/);
  });

  it("classifies the observed opencode free-tier phrase", () => {
    const failure = classifyDispatchQuotaExhaustion("Free usage exceeded, subscribe to Go");
    assert.equal(failure.kind, "quota-exhaustion");
    assert.equal(failure.backend, "opencode");
    assert.equal(failure.quota, "free-tier");
    assert.equal(failure.reset, null);
    assert.match(quotaExhaustionReason(failure), /opencode free-tier pool/);
  });

  it("does not classify unrelated dispatch failures, including a claude session-limit string", () => {
    assert.equal(classifyDispatchQuotaExhaustion(null), null);
    assert.equal(classifyDispatchQuotaExhaustion(""), null);
    assert.equal(classifyDispatchQuotaExhaustion("claude dispatch failed: session limit"), null);
    assert.equal(classifyDispatchQuotaExhaustion("All routes exhausted"), null);
    assert.equal(classifyDispatchQuotaExhaustion("quota reached"), null);
  });
});

// =========================================================================
// phase functions carry the failure classification (kusabi #215)
// =========================================================================

describe("phase functions carry the failure classification (kusabi #215)", () => {
  const QUOTA_FAILURE = {
    kind: "quota-exhaustion",
    quota: "session",
    backendBlocked: true,
    reset: "1:20am (Asia/Tokyo)",
  };

  function failingDispatch(status, failure) {
    return async () => ({
      job: {
        id: "job-fail", status, modelEntry: "opus", modelVariant: null,
        fallbacks: null, sessionID: null,
        usage: null, error: "claude dispatch failed: session limit",
        failure: failure ?? null,
      },
      resultText: "",
    });
  }

  it("runReviewPhase writes reviewJobFailure onto the round record (single conduit)", async () => {
    const roundRecord = { round: 1 };
    const dispatch = async () => {
      // A review job that died on quota exhaustion — no output to parse.
      return {
        job: {
          id: "job-rev-fail", status: "provider-error", modelEntry: "opus",
          modelVariant: null, fallbacks: null, sessionID: null,
          usage: null, error: "claude dispatch failed: session limit",
          failure: QUOTA_FAILURE,
        },
        resultText: "",
      };
    };
    const result = await runReviewPhase({
      container: "cid-1", brief: "brief", modelChain: [["opus"]], chainId: "chain-test",
      cwd: "/tmp", previousRecord: null, baseSha: "abc123",
      chainStatusOutput: "", chainBaseLog: "", chainUntracked: "", chainTruncation: null,
      roundRecord,
      chainChangedPaths: ["src/a.js"], chainNewlyChanged: ["src/a.js"],
      chainStatusObserved: true, chainDeliverables: [],
      flagsModel: null,
      _dispatchWithFallback: dispatch,
    });
    assert.equal(result.reviewJobStatus, "provider-error");
    assert.deepEqual(roundRecord.reviewJobFailure, QUOTA_FAILURE);
  });

  it("runReviewPhase classifies an agy quota error onto the round record (kusabi #373)", async () => {
    const roundRecord = { round: 1 };
    const agyError = "agy dispatch failed: agy returned no payload {\"status\":\"ERROR\",\"response\":\"\",\"error\":\"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h1m21s.\"}";
    const dispatch = async () => ({
      job: {
        id: "job-rev-agy-quota", status: "error", modelEntry: "gemini-3.6-flash-high",
        modelVariant: null, fallbacks: null, sessionID: null,
        usage: null, error: agyError, failure: null,
      },
      resultText: "",
    });
    const result = await runReviewPhase({
      container: "cid-1", brief: "brief", modelChain: [["gemini-3.6-flash-high"]], chainId: "chain-test",
      cwd: "/tmp", previousRecord: null, baseSha: "abc123",
      chainStatusOutput: "", chainBaseLog: "", chainUntracked: "", chainTruncation: null,
      roundRecord,
      chainChangedPaths: ["src/a.js"], chainNewlyChanged: ["src/a.js"],
      chainStatusObserved: true, chainDeliverables: [],
      flagsModel: null,
      _dispatchWithFallback: dispatch,
    });
    assert.equal(result.reviewJobStatus, "error");
    assert.equal(result.reviewJobError, agyError);
    assert.equal(roundRecord.reviewJobError, agyError);
    assert.equal(roundRecord.reviewJobFailure.kind, "quota-exhaustion");
    assert.equal(roundRecord.reviewJobFailure.backend, "agy");
    assert.equal(roundRecord.reviewJobFailure.quota, "individual");
    assert.equal(roundRecord.reviewJobFailure.reset, "1h1m21s");
    assert.equal(roundRecord.verdict, "unparseable");
  });

  it("runReviewPhase carries a stalled review's watchdog text onto the record, without a quota fact (kusabi #373)", async () => {
    // The third terminal state, from a real incident (chain-mt5jul99b21a,
    // 2026-08-23): not "error", not quota — the watchdog killed a seat that
    // had gone silent.  Its reason must still reach the round record, and it
    // must NOT be classified as an exhausted pool.
    const roundRecord = { round: 1 };
    const stalledError = "watchdog: no events for 900s (process killed)";
    const dispatch = async () => ({
      job: {
        id: "job-rev-stalled", status: "stalled", modelEntry: "default",
        modelVariant: null, fallbacks: null, sessionID: null,
        usage: null, error: stalledError, failure: null,
      },
      resultText: "",
    });
    const result = await runReviewPhase({
      container: "cid-1", brief: "brief", modelChain: [["default"]], chainId: "chain-test",
      cwd: "/tmp", previousRecord: null, baseSha: "abc123",
      chainStatusOutput: "", chainBaseLog: "", chainUntracked: "", chainTruncation: null,
      roundRecord,
      chainChangedPaths: ["src/a.js"], chainNewlyChanged: ["src/a.js"],
      chainStatusObserved: true, chainDeliverables: [],
      flagsModel: null,
      _dispatchWithFallback: dispatch,
    });
    assert.equal(result.reviewJobStatus, "stalled");
    assert.equal(roundRecord.reviewJobError, stalledError);
    assert.equal(roundRecord.reviewJobFailure, null);
    assert.equal(roundRecord.verdict, "unparseable");
  });

  it("runReviewPhase leaves a completed unreadable payload as unparseable with no quota fact", async () => {
    const roundRecord = { round: 1 };
    const dispatch = async () => ({
      job: {
        id: "job-rev-garbage", status: "completed", modelEntry: "opus",
        modelVariant: null, fallbacks: null, sessionID: null,
        usage: null, error: null, failure: null,
      },
      resultText: "definitely not JSON and no VERDICT token here at all",
    });
    await runReviewPhase({
      container: "cid-1", brief: "brief", modelChain: [["opus"]], chainId: "chain-test",
      cwd: "/tmp", previousRecord: null, baseSha: "abc123",
      chainStatusOutput: "", chainBaseLog: "", chainUntracked: "", chainTruncation: null,
      roundRecord,
      chainChangedPaths: ["src/a.js"], chainNewlyChanged: ["src/a.js"],
      chainStatusObserved: true, chainDeliverables: [],
      flagsModel: null,
      _dispatchWithFallback: dispatch,
    });
    assert.equal(roundRecord.verdict, "unparseable");
    assert.equal(roundRecord.reviewJobFailure, null);
    assert.equal(Object.prototype.hasOwnProperty.call(roundRecord, "reviewJobError"), false);
  });

  it("runStrategizePhase returns strategistJobFailure from the failed job's record", async () => {
    const result = await runStrategizePhase({
      cwd: "/tmp", chainId: "chain-test", round: 1, brief: "brief",
      previousRecord: null, roundRecord: { round: 1 }, modelChain: [["opus"]],
      _dispatchWithFallback: failingDispatch("provider-error", QUOTA_FAILURE),
    });
    assert.equal(result.strategistJobStatus, "provider-error");
    assert.deepEqual(result.strategistJobFailure, QUOTA_FAILURE);
  });
});

// applyTierEscalation — tier clamping (kusabi #153)
// =========================================================================

describe("applyTierEscalation", () => {
  it("clamps an escalation past the top of a single-tier chain", () => {
    const result = applyTierEscalation({ currentTierIndex: 0, tierDelta: 1, tierCount: 1 });
    assert.deepEqual(result, { tierIndex: 0, clamped: true, reason: "single-tier chain" });
  });

  it("clamps repeated escalations on a single-tier chain", () => {
    const result = applyTierEscalation({ currentTierIndex: 0, tierDelta: 2, tierCount: 1 });
    assert.equal(result.tierIndex, 0);
    assert.equal(result.clamped, true);
  });

  it("does not clamp an in-range escalation on a multi-tier chain", () => {
    const result = applyTierEscalation({ currentTierIndex: 0, tierDelta: 1, tierCount: 2 });
    assert.deepEqual(result, { tierIndex: 1, clamped: false, reason: null });
  });

  it("clamps an escalation past the top of a multi-tier chain", () => {
    const result = applyTierEscalation({ currentTierIndex: 1, tierDelta: 1, tierCount: 2 });
    assert.equal(result.tierIndex, 1);
    assert.equal(result.clamped, true);
    assert.equal(result.reason, "escalation beyond top tier (modelChain has 2 tiers)");
  });

  it("never clamps when there is no usable ladder", () => {
    const result = applyTierEscalation({ currentTierIndex: 0, tierDelta: 1, tierCount: 0 });
    assert.deepEqual(result, { tierIndex: 1, clamped: false, reason: null });
  });
});

// recordReworkEscalation — driver rework branch (round-record contract)
// =========================================================================

describe("recordReworkEscalation", () => {
  it("records the clamp on the round record for a single-tier chain", () => {
    const roundRecord = { tierBefore: 0 };
    const result = recordReworkEscalation({
      roundRecord,
      currentTierIndex: 0,
      reworkCount: 1, // 2nd rework: tierDelta +1
      strategized: false,
      tierCount: 1,
    });

    assert.equal(result.currentTierIndex, 0); // clamped: stays on tier 0
    assert.equal(result.strategy.tierDelta, 1);
    assert.equal(roundRecord.tierClamped, true);
    assert.equal(roundRecord.tierClampReason, "single-tier chain");
  });

  it("amends the strategy reason on a clamped escalation so it never claims 'escalate tier'", () => {
    // #153④: chain-show renders the strategy reason verbatim next to the
    // clamped tier line — "escalate tier" there reads as a stronger-model
    // re-run that dispatch never performed.
    const roundRecord = { tierBefore: 0 };
    const result = recordReworkEscalation({
      roundRecord,
      currentTierIndex: 0,
      reworkCount: 1, // 2nd rework: tierDelta +1, clamped on a 1-tier chain
      strategized: false,
      tierCount: 1,
    });

    assert.ok(!result.strategy.reason.includes("escalate tier"), result.strategy.reason);
    assert.ok(
      result.strategy.reason.includes("tier unchanged (escalation clamped: single-tier chain)"),
      result.strategy.reason,
    );
  });

  it("keeps the plain 'escalate tier' wording for an in-range escalation", () => {
    const roundRecord = { tierBefore: 0 };
    const result = recordReworkEscalation({
      roundRecord,
      currentTierIndex: 0,
      reworkCount: 1, // 2nd rework: tierDelta +1 -> tier 1 of 2, no clamp
      strategized: false,
      tierCount: 2,
    });

    assert.ok(result.strategy.reason.includes("escalate tier"), result.strategy.reason);
  });

  it("records no clamp when escalation stays within range", () => {
    const roundRecord = { tierBefore: 0 };
    const result = recordReworkEscalation({
      roundRecord,
      currentTierIndex: 0,
      reworkCount: 0, // 1st rework: tierDelta 0
      strategized: false,
      tierCount: 2,
    });

    assert.equal(result.currentTierIndex, 0);
    assert.equal(roundRecord.tierClamped, false);
    assert.equal(roundRecord.tierClampReason, null);
  });

  it("records no clamp for an in-range escalation on a multi-tier chain", () => {
    const roundRecord = { tierBefore: 0 };
    const result = recordReworkEscalation({
      roundRecord,
      currentTierIndex: 0,
      reworkCount: 1, // 2nd rework: tierDelta +1 -> tier 1 of 2
      strategized: false,
      tierCount: 2,
    });

    assert.equal(result.currentTierIndex, 1);
    assert.equal(roundRecord.tierClamped, false);
    assert.equal(roundRecord.tierClampReason, null);
  });

  it("keeps the recorded tierAfter consistent with the model actually used", () => {
    // Driver contract: after recordReworkEscalation the driver stores
    // roundRecord.tierAfter = result.currentTierIndex.  For a single-tier
    // chain that must stay 0 (never "0 → 1").
    const roundRecord = { tierBefore: 0 };
    const escalation = recordReworkEscalation({
      roundRecord,
      currentTierIndex: 0,
      reworkCount: 1,
      strategized: false,
      tierCount: 1,
    });
    roundRecord.tierAfter = escalation.currentTierIndex;
    assert.equal(roundRecord.tierAfter, 0);
    assert.equal(roundRecord.tierClamped, true);
  });

  it("wires the anchoring-override evidence through to deriveReworkStrategy on the 1st rework", () => {
    // Kusabi #62: a round that ended `approve` + probes red must schedule its
    // 1st rework with a NEW session, tier unchanged, and a reason naming the
    // anchoring trigger — the same lever the driver will read back as
    // reworkStrategyReason.
    const roundRecord = { tierBefore: 0 };
    const result = recordReworkEscalation({
      roundRecord,
      currentTierIndex: 0,
      reworkCount: 0,
      strategized: false,
      tierCount: 2,
      chainVerdict: "approve",
      chainRepeatedAreas: false,
      probesGreen: false,
    });
    assert.equal(result.strategy.newSession, true);
    assert.equal(result.strategy.tierDelta, 0);
    assert.match(result.strategy.reason, /worker claimed done, probes red: anchoring break/);
    assert.equal(result.currentTierIndex, 0);
    assert.equal(roundRecord.tierClamped, false);
    assert.equal(roundRecord.tierClampReason, null);
  });

  it("wires the repeatedAreas anchoring-override evidence through on the 1st rework", () => {
    const roundRecord = { tierBefore: 0 };
    const result = recordReworkEscalation({
      roundRecord,
      currentTierIndex: 0,
      reworkCount: 0,
      strategized: false,
      tierCount: 2,
      chainVerdict: "needs-attention",
      chainRepeatedAreas: true,
      probesGreen: false,
    });
    assert.equal(result.strategy.newSession, true);
    assert.equal(result.strategy.tierDelta, 0);
    assert.match(result.strategy.reason, /same file area flagged across rounds: anchoring break/);
  });

  it("does not trigger the override from the default ladder inputs alone", () => {
    // Existing callers that pass no evidence keep the plain 1st-rework row:
    // continue session, same tier.
    const roundRecord = { tierBefore: 0 };
    const result = recordReworkEscalation({
      roundRecord,
      currentTierIndex: 0,
      reworkCount: 0,
      strategized: false,
      tierCount: 2,
    });
    assert.equal(result.strategy.newSession, false);
    assert.equal(result.strategy.tierDelta, 0);
  });
});

// normalizeFilePath — path normalisation for cross-round comparison
// =========================================================================

describe("normalizeFilePath", () => {
  it("trims whitespace from paths", () => {
    assert.equal(normalizeFilePath("  src/a/b.py  "), "src/a/b.py");
  });

  it("returns empty string for null / undefined", () => {
    assert.equal(normalizeFilePath(null), "");
    assert.equal(normalizeFilePath(undefined), "");
  });

  it("returns the path unchanged when there is no leading/trailing whitespace", () => {
    assert.equal(normalizeFilePath("/workspace/src/a/b.py"), "/workspace/src/a/b.py");
    assert.equal(normalizeFilePath("src/a/b.py"), "src/a/b.py");
  });
});

// hasRepeatedAreas — cross-round file-path comparison.
// =========================================================================

describe("hasRepeatedAreas", () => {
  it("detects repeat when absolute and relative paths refer to same file", () => {
    // round 1 findingFiles stored /workspace/src/secret_scan.py;
    // round 2 reports src/secret_scan.py — suffix match catches it.
    const previousFindingFiles = ["/workspace/src/sunaba/tools/secret_scan.py"];
    const currentFindings = [
      { file: "src/sunaba/tools/secret_scan.py", severity: "high", title: "Issue", line_start: 10 },
    ];
    assert.equal(hasRepeatedAreas(previousFindingFiles, currentFindings), true);
  });

  it("does not false-positive on parentheses in finding titles", () => {
    // The old regex-based approach parsed findingsText and would have
    // matched "(src/helper.js)" from the title.  hasRepeatedAreas reads
    // f.file from the structured data, which ignores the title entirely.
    const previousFindingFiles = ["src/helper.js"];
    const currentFindings = [
      { file: "src/other.js", severity: "high", title: "The (src/helper.js) function is unused", line_start: 15 },
    ];
    assert.equal(hasRepeatedAreas(previousFindingFiles, currentFindings), false);
  });

  it("returns false for genuinely different files across rounds", () => {
    const previousFindingFiles = ["src/alpha.js", "src/beta.js"];
    const currentFindings = [
      { file: "src/gamma.js", severity: "low", title: "Different file", line_start: 5 },
    ];
    assert.equal(hasRepeatedAreas(previousFindingFiles, currentFindings), false);
  });

  it("returns false when previousFindingFiles is missing (undefined, old records)", () => {
    const currentFindings = [
      { file: "src/file.js", severity: "high", title: "Something", line_start: 10 },
    ];
    assert.equal(hasRepeatedAreas(undefined, currentFindings), false);
  });

  it("returns false when previousFindingFiles is null (first round)", () => {
    const currentFindings = [
      { file: "src/file.js", severity: "low", title: "First issue", line_start: 1 },
    ];
    assert.equal(hasRepeatedAreas(null, currentFindings), false);
  });

  it("returns false when currentFindings is null (unparseable review)", () => {
    // Critical regression: chainParsedReview is null when the review
    // output could not be parsed — must not throw.
    const previousFindingFiles = ["src/file.js"];
    assert.equal(hasRepeatedAreas(previousFindingFiles, null), false);
  });

  it("returns false when currentFindings is empty array", () => {
    const previousFindingFiles = ["src/file.js"];
    assert.equal(hasRepeatedAreas(previousFindingFiles, []), false);
  });

  it("detects repeat when current round has a finding in a previously-flagged file", () => {
    const previousFindingFiles = ["src/shared.js", "src/other.js"];
    const currentFindings = [
      { file: "/workspace/src/shared.js", severity: "high", title: "Same file", line_start: 42 },
      { file: "src/new.js", severity: "low", title: "New file", line_start: 1 },
    ];
    assert.equal(hasRepeatedAreas(previousFindingFiles, currentFindings), true);
  });

  it("matches when one path is a suffix of the other on path-segment boundaries", () => {
    // Round 1: absolute container path; Round 2: relative repo path
    assert.equal(
      hasRepeatedAreas(
        ["/workspace/src/a/b/c.py"],
        [{ file: "src/a/b/c.py" }],
      ),
      true,
    );
    // Round 1: relative; Round 2: absolute
    assert.equal(
      hasRepeatedAreas(
        ["src/a/b/c.py"],
        [{ file: "/workspace/src/a/b/c.py" }],
      ),
      true,
    );
    // Different segments, same suffix length
    assert.equal(
      hasRepeatedAreas(
        ["/other/root/src/foo.py"],
        [{ file: "src/foo.py" }],
      ),
      true,
    );
  });

  it("does not match partial segment overlap", () => {
    // "src/foo-bar.py" is NOT a suffix of "src/foo.py" on segment boundaries
    assert.equal(
      hasRepeatedAreas(
        ["src/foo.py"],
        [{ file: "src/foo-bar.py" }],
      ),
      false,
    );
  });
});

//
// There used to be `assert.ok(runReviewPhase.toString().includes("diff_in_container"))`.
// The tool list now lives in renderContainerReviewInput (render.mjs), so that
// assertion survived only on the strength of a comment naming the tool:
// with line comments stripped, the string is absent from runReviewPhase.
// A test green for a reason unrelated to its claim is worse than no test.
//
// Two replacements were tried and both were worse than nothing.  Matching a
// call shape against comment-stripped source cannot tell code from prose: a
// `/* renderContainerReviewInput( */` breadcrumb still matches, while a URL
// on the same line as a real call destroys it, so the guard both misses
// regressions and breaks valid refactors.
//
// What actually covers this is behavioural and already present: the chain
// review prompt byte-identity tests below run runReviewPhase through a stub
// dispatch and compare the whole rendered prompt.  Verified by mutation —
// changing one line of the tool list inside renderContainerReviewInput fails
// exactly 2 tests in this file.  That catches the tool list changing AND
// runReviewPhase ceasing to delegate, which is strictly more than the source
// guard ever did.
//
// If you are tempted to re-add a `.toString()` guard here, read the above.

// ---------------------------------------------------------------------------
// runReviewPhase / runStrategizePhase — stubbed dispatch route recording
// ---------------------------------------------------------------------------

describe("runStrategizePhase — stubbed dispatch route recording", () => {
  it("records strategistModelEntry and strategistModelVariant on the roundRecord", async () => {
    function stubbedDispatch() {
      return {
        job: {
          id: "strat-job-1",
          status: "completed",
          modelEntry: "test-org/test-strategist-model:max",
          modelVariant: "max",
          fallbacks: null,
          usage: null,
          error: null,
        },
        resultText: "Switch to a Map data structure",
      };
    }

    const roundRecord = { round: 1 };

    await runStrategizePhase({
      cwd: process.cwd(),
      chainId: "test-chain",
      round: 1,
      brief: "test brief",
      previousRecord: null,
      roundRecord,
      modelChain: ["test-org/test-flash", "test-org/test-pro"],
      _dispatchWithFallback: stubbedDispatch,
    });

    assert.equal(roundRecord.strategistModelEntry, "test-org/test-strategist-model:max");
    assert.equal(roundRecord.strategistModelVariant, "max");
    assert.equal(roundRecord.strategistFallbacks, null);
  });
});

// ---------------------------------------------------------------------------
// Fallback trails: the three states must stay distinguishable on disk
//
// The stats layer separates three states — key absent (pre-feature record),
// present-but-null (no fallback fired), present array (fallback fired) — and
// reports the first as n/a rather than folding it into "no fallback".  These
// tests lock the write side of that contract.
//
// Note for future readers: `|| null` is correct here.  An empty array is
// *truthy* in JavaScript, so `[] || null` is `[]`, not `null`; `??` would be
// equivalent for every value `fallbacks` can hold (undefined / null / array).
// A review finding claiming otherwise was refuted by mutating the operator and
// observing that no test changed colour.
// ---------------------------------------------------------------------------


// =========================================================================
// persistChainState — interrupted-round persistence (kusabi #153①)
// =========================================================================

describe("persistChainState interrupted round", () => {
  function makeChainDir() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-persist-"));
    return path.join(tmp, "chain-test");
  }

  const chainCtx = {
    chainId: "chain-test",
    container: "cid-1",
    model: "fake/model",
    modelChain: [["fake/model"]],
    maxRounds: 4,
    brief: "Implement X.",
    orchestrator: null,
    baseSha: "abc123",
    strategized: false,
    chainFollowupDraft: null,
  };

  it("marks the record interrupted and writes it into chain.json records (stop-after-probes path)", () => {
    const chainDir = makeChainDir();
    fs.mkdirSync(chainDir, { recursive: true });
    const roundRecord = {
      round: 3, implementJobId: "job-3", verdict: null,
      probesGreen: true, tierBefore: 0, reworkCount: 2,
    };
    const records = [];
    persistChainState({
      chainDir, round: 3, roundRecord, records,
      chainTotals: computeChainTotals([roundRecord]),
      ...chainCtx,
      interrupted: true,
    });

    assert.equal(roundRecord.interrupted, true);
    assert.equal(roundRecord.interruptedAfter, "probes");

    const written = readJson(path.join(chainDir, "round-3.json"));
    assert.equal(written.interrupted, true);
    assert.equal(written.interruptedAfter, "probes");

    const chainJson = readJson(path.join(chainDir, "chain.json"));
    assert.equal(chainJson.records.length, 1);
    assert.equal(chainJson.records[0].round, 3);
    assert.equal(chainJson.records[0].implementJobId, "job-3");
    assert.equal(chainJson.records[0].interrupted, true);
  });

  it("does not mark the record when interrupted is not requested", () => {
    const chainDir = makeChainDir();
    fs.mkdirSync(chainDir, { recursive: true });
    const roundRecord = { round: 1, implementJobId: "job-1" };
    persistChainState({
      chainDir, round: 1, roundRecord, records: [roundRecord],
      chainTotals: computeChainTotals([roundRecord]),
      ...chainCtx,
    });
    assert.equal(roundRecord.interrupted, undefined);
    const chainJson = readJson(path.join(chainDir, "chain.json"));
    assert.equal(chainJson.records.length, 1);
  });

  it("does not duplicate a record that is already in records (review-resume path)", () => {
    const chainDir = makeChainDir();
    fs.mkdirSync(chainDir, { recursive: true });
    const roundRecord = { round: 3, implementJobId: "job-3" };
    const records = [roundRecord]; // already pushed at stop time
    persistChainState({
      chainDir, round: 3, roundRecord, records,
      chainTotals: computeChainTotals(records),
      ...chainCtx,
    });
    const chainJson = readJson(path.join(chainDir, "chain.json"));
    assert.equal(chainJson.records.length, 1);
  });

  it("persists the chain-start verify baseline into chain.json (kusabi #173)", () => {
    const chainDir = makeChainDir();
    fs.mkdirSync(chainDir, { recursive: true });
    const roundRecord = { round: 1, implementJobId: "job-1" };
    const verifyBaseline = {
      captured: true,
      gate_passed: false,
      lint: 190,
      types: 0,
      raw: { gate_passed: false, lint: [{ rule: "x" }], types: [] },
    };
    persistChainState({
      chainDir, round: 1, roundRecord, records: [roundRecord],
      chainTotals: computeChainTotals([roundRecord]),
      ...chainCtx,
      verifyBaseline,
    });
    const chainJson = readJson(path.join(chainDir, "chain.json"));
    assert.deepEqual(chainJson.verifyBaseline, verifyBaseline);
  });

  it("defaults chain.json verifyBaseline to null when not recorded", () => {
    const chainDir = makeChainDir();
    fs.mkdirSync(chainDir, { recursive: true });
    const roundRecord = { round: 1, implementJobId: "job-1" };
    persistChainState({
      chainDir, round: 1, roundRecord, records: [roundRecord],
      chainTotals: computeChainTotals([roundRecord]),
      ...chainCtx,
    });
    const chainJson = readJson(path.join(chainDir, "chain.json"));
    assert.equal(chainJson.verifyBaseline, null);
  });

  it("persists the review-phase model and chain for chain-resume (kusabi #192)", () => {
    const chainDir = makeChainDir();
    fs.mkdirSync(chainDir, { recursive: true });
    const roundRecord = { round: 1, implementJobId: "job-1" };
    persistChainState({
      chainDir, round: 1, roundRecord, records: [roundRecord],
      chainTotals: computeChainTotals([roundRecord]),
      ...chainCtx,
      reviewModel: "opus",
      reviewModelChain: [["opus"]],
    });
    const chainJson = readJson(path.join(chainDir, "chain.json"));
    assert.equal(chainJson.reviewModel, "opus");
    assert.deepEqual(chainJson.reviewModelChain, [["opus"]]);
  });

  it("defaults chain.json review fields to null when not given (pre-#192 chains)", () => {
    const chainDir = makeChainDir();
    fs.mkdirSync(chainDir, { recursive: true });
    const roundRecord = { round: 1, implementJobId: "job-1" };
    persistChainState({
      chainDir, round: 1, roundRecord, records: [roundRecord],
      chainTotals: computeChainTotals([roundRecord]),
      ...chainCtx,
    });
    const chainJson = readJson(path.join(chainDir, "chain.json"));
    assert.equal(chainJson.reviewModel, null);
    assert.equal(chainJson.reviewModelChain, null);
  });

  it("persists the rework-phase model, chain and backend for chain-resume (kusabi #192 axis 2)", () => {
    const chainDir = makeChainDir();
    fs.mkdirSync(chainDir, { recursive: true });
    const roundRecord = { round: 1, implementJobId: "job-1" };
    persistChainState({
      chainDir, round: 1, roundRecord, records: [roundRecord],
      chainTotals: computeChainTotals([roundRecord]),
      ...chainCtx,
      reworkModel: "deepseek-v4-flash",
      reworkModelChain: [["opencode-go/deepseek-v4-flash"]],
      reworkBackend: "opencode",
    });
    const chainJson = readJson(path.join(chainDir, "chain.json"));
    assert.equal(chainJson.reworkModel, "deepseek-v4-flash");
    assert.deepEqual(chainJson.reworkModelChain, [["opencode-go/deepseek-v4-flash"]]);
    assert.equal(chainJson.reworkBackend, "opencode");
  });

  it("defaults chain.json rework fields to null when not given (no models.phases.rework key)", () => {
    const chainDir = makeChainDir();
    fs.mkdirSync(chainDir, { recursive: true });
    const roundRecord = { round: 1, implementJobId: "job-1" };
    persistChainState({
      chainDir, round: 1, roundRecord, records: [roundRecord],
      chainTotals: computeChainTotals([roundRecord]),
      ...chainCtx,
    });
    const chainJson = readJson(path.join(chainDir, "chain.json"));
    assert.equal(chainJson.reworkModel, null);
    assert.equal(chainJson.reworkModelChain, null);
    assert.equal(chainJson.reworkBackend, null);
  });
});

// =========================================================================
// writeReviewRecord — postable review record at a terminal disposition
// (kusabi #52)
// =========================================================================

describe("writeReviewRecord", () => {
  function makeChainDir() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-review-record-"));
    const chainDir = path.join(tmp, "chains", "chain-1");
    fs.mkdirSync(chainDir, { recursive: true });
    return chainDir;
  }

  const records = [
    {
      round: 1,
      modelEntry: "flash/quick",
      verdict: "approve",
      disposition: { disposition: "accept" },
      worktreeChanged: true,
      probeResults: [{ probe: "P1: HEAD clean", passed: true, detail: "HEAD matches base abc123" }],
      findings: [{ severity: "high", title: "Null pointer", file: "src/x.js", line_start: 42 }],
    },
  ];

  it("writes review-record.md with the rendered markdown and returns its path", () => {
    const chainDir = makeChainDir();
    const recordPath = writeReviewRecord({
      chainDir,
      chainId: "chain-1",
      container: "cid-1",
      label: "repo",
      modelChain: [["flash/quick"]],
      maxRounds: 4,
      brief: "Implement X.",
      orchestrator: null,
      records,
      disposition: { disposition: "accepted", round: 1 },
      round: 1,
      finishedAt: "2026-08-08T00:00:00.000Z",
    });

    assert.equal(recordPath, path.join(chainDir, "review-record.md"));
    assert.ok(fs.existsSync(recordPath));

    const text = fs.readFileSync(recordPath, "utf8");
    assert.match(text, /# \[review-record\] repo chain-1 — Implement X\./);
    assert.match(text, /Final disposition: accepted at round 1 of 4/);
    assert.match(text, /Round 1 — model: flash\/quick, verdict: approve \(parsed\), disposition: accept, changed: yes/);
    assert.match(text, /- \[high\] Null pointer \(src\/x\.js:42\)/);
    assert.match(text, /\| 1 \| high \| Null pointer \(src\/x\.js:42\) \| _fill_ \| _fill_ \|/);
    assert.match(text, /## 判例として \(fill at inspection\)/);
    // Usage comes from the chain's existing chainTotals (zero here — nothing
    // recomputed from records).
    assert.match(text, /input=0 output=0 reasoning=0 cacheRead=0 cacheWrite=0 cost=\$0/);
  });

  it("uses the given chainTotals verbatim instead of recomputing from rounds", () => {
    const chainDir = makeChainDir();
    writeReviewRecord({
      chainDir,
      chainId: "chain-1",
      container: "cid-1",
      records,
      disposition: { disposition: "escalated", round: 1 },
      round: 1,
      chainTotals: { input: 7, output: 5, reasoning: 1, cacheRead: 20, cacheWrite: 2, cost: 0.11 },
      finishedAt: "2026-08-08T00:00:00.000Z",
    });
    const text = fs.readFileSync(path.join(chainDir, "review-record.md"), "utf8");
    assert.match(text, /input=7 output=5 reasoning=1 cacheRead=20 cacheWrite=2 cost=\$0\.11/);
    // The escalate reason flows into the record when given.
    assert.match(text, /Final disposition: escalated at round 1 of \?/);
  });

  it("regeneration overwrites the previous record", () => {
    const chainDir = makeChainDir();
    writeReviewRecord({
      chainDir,
      chainId: "chain-1",
      container: "cid-1",
      records,
      disposition: { disposition: "accepted", round: 1 },
      round: 1,
      finishedAt: "2026-08-08T00:00:00.000Z",
    });
    writeReviewRecord({
      chainDir,
      chainId: "chain-1",
      container: "cid-1",
      records,
      disposition: { disposition: "accepted", round: 2 },
      round: 2,
      brief: "Second brief.",
      finishedAt: "2026-08-08T01:00:00.000Z",
    });
    const text = fs.readFileSync(path.join(chainDir, "review-record.md"), "utf8");
    assert.match(text, /Final disposition: accepted at round 2 of \?/);
    assert.match(text, /Second brief\./);
    assert.doesNotMatch(text, /Final disposition: accepted at round 1/);
  });
});

// =========================================================================
// =========================================================================
// collectReviewContext — review context without re-running probes (resume)
// =========================================================================

describe("collectReviewContext", () => {
  function fakeReviewContextCallTool({ statusOutput = "" } = {}) {
    return async (toolName, params) => {
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands[0];
      if (cmd === "git status --porcelain") return { output: statusOutput };
      if (cmd === "git log --oneline -5") return { output: "abc123 latest change\n" };
      if (cmd === "git ls-files --others --exclude-standard") return { output: "untracked.txt\n" };
      return { output: "" };
    };
  }

  it("collects status/changed paths, base log and untracked without running probes", async () => {
    const callTool = fakeReviewContextCallTool({ statusOutput: " M src/foo.js\n" });
    const ctx = await collectReviewContext({
      container: "fake-cid",
      brief: "Implement X.\n\n## Deliverables\n- src/foo.js\n",
      callTool,
      worktreeBaseline: null,
    });

    assert.deepEqual(ctx.chainChangedPaths, ["src/foo.js"]);
    assert.deepEqual(ctx.chainNewlyChanged, ["src/foo.js"]); // baseline null → full changed set
    assert.equal(ctx.chainStatusObserved, true);
    assert.equal(ctx.chainStatusOutput, " M src/foo.js\n");
    assert.equal(ctx.chainBaseLog, "abc123 latest change\n");
    assert.equal(ctx.chainUntracked, "untracked.txt\n");
    assert.deepEqual(ctx.chainDeliverables, ["src/foo.js"]);
    // No diff is collected on the resume path either (kusabi #208).
    assert.equal(ctx.chainDiff, undefined);
  });

  it("carries the paging facts of the captures it made", async () => {
    const callTool = async (toolName, params) => {
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands[0];
      if (cmd === "git status --porcelain") {
        // Live-server shape for a cut response: shown === total_lines, and
        // next_offset is the number of lines actually returned.
        return { output: " M src/foo.js\n", shown: 137, total_lines: 137, truncated: true, has_more: true, next_offset: 1 };
      }
      if (cmd === "git ls-files --others --exclude-standard") return { output: "untracked.txt\n" };
      return { output: "" };
    };
    const ctx = await collectReviewContext({
      container: "fake-cid",
      brief: "Implement X.\n\n## Deliverables\n- src/foo.js\n",
      callTool,
      worktreeBaseline: null,
    });
    assert.deepEqual(ctx.chainTruncation.status, { truncated: true, total: 137 });
    assert.equal(ctx.chainTruncation.untracked.truncated, false);
  });

  it("yields empty strings for unreadable context calls instead of throwing", async () => {
    const callTool = async (toolName, params) => {
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands[0];
      if (cmd === "git status --porcelain") return { output: "" };
      throw new Error("sandbox unreachable");
    };
    const ctx = await collectReviewContext({
      container: "fake-cid",
      brief: "Implement X.",
      callTool,
      worktreeBaseline: null,
    });
    assert.equal(ctx.chainBaseLog, "");
    assert.equal(ctx.chainUntracked, "");
    assert.deepEqual(ctx.chainChangedPaths, []);
    // A capture that never happened is not a capture that was cut.
    assert.equal(ctx.chainTruncation.baseLog, null);
    assert.equal(ctx.chainTruncation.untracked, null);
  });

  it("degrades to unobserved status when the probe RPC fails instead of throwing (#153①)", async () => {
    // This context is collected on the RECOVERY path — a transient
    // container/RPC failure must not turn the resumed chain terminal.
    const callTool = async () => { throw new Error("container unreachable"); };
    const ctx = await collectReviewContext({
      container: "fake-cid",
      brief: "Implement X.\n\n## Deliverables\n- src/foo.js\n",
      callTool,
      worktreeBaseline: null,
    });
    assert.equal(ctx.chainStatusObserved, false); // unknown — never "nothing changed"
    assert.deepEqual(ctx.chainChangedPaths, []);
    assert.equal(ctx.chainBaseLog, "");
    // An unobserved status must not skip the review as an empty change set.
    assert.equal(
      shouldSkipReview({
        chainStatusObserved: ctx.chainStatusObserved,
        chainChangedPaths: ctx.chainChangedPaths,
        chainNewlyChanged: ctx.chainNewlyChanged,
        chainDeliverables: ctx.chainDeliverables,
      }),
      false,
    );
  });

  it("collectContainerBaseContext alone returns the two context strings", async () => {
    const callTool = fakeReviewContextCallTool({});
    const baseCtx = await collectContainerBaseContext(callTool, "fake-cid");
    assert.equal(baseCtx.chainBaseLog, "abc123 latest change\n");
    assert.equal(baseCtx.chainUntracked, "untracked.txt\n");
    assert.equal(baseCtx.chainDiff, undefined);
  });

  it("collectContainerBaseContext issues no git diff at all", async () => {
    // The capture is removed, not widened: it read one default-paged page and
    // the reviewer fetches the diff itself (kusabi #208).
    const commands = [];
    const callTool = async (tool, params) => {
      commands.push(params.commands?.[0] ?? "");
      return { output: "" };
    };
    await collectContainerBaseContext(callTool, "fake-cid");
    assert.deepEqual(commands, ["git log --oneline -5", "git ls-files --others --exclude-standard"]);
  });
});

// ---------------------------------------------------------------------------
// readExecCapture — believe the server about its own paging (kusabi #208)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// collectContainerReviewInput — the task path's review input (kusabi #204)
// ---------------------------------------------------------------------------

describe("collectContainerReviewInput", () => {
  // Records every command issued so the tests can assert on what was actually
  // run in the container, not only on the rendered text.
  function recordingTool(handler) {
    const commands = [];
    return {
      commands,
      callTool: async (tool, params) => {
        const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
        commands.push(cmd);
        return handler(cmd, params);
      },
    };
  }

  const DUMMY_SCOPE = {
    formatVersion: 1,
    repositoryRoot: "/workspace",
    input: { base: "deadbeefcafe", head: "HEAD" },
    resolved: { baseSha: "deadbeefcafe", headSha: "deadbeefcafe", mergeBaseSha: "deadbeefcafe" },
    paths: { committed: [], staged: [], unstaged: ["src/foo.js"], untracked: ["src/new.js"] },
  };

  function defaultHandler(cmd, params) {
    const fullCmd = params?.commands?.[0] ?? params?.argv?.join(" ") ?? (typeof cmd === "string" ? cmd : "");
    if (fullCmd.includes("change-scope.mjs")) {
      return { output: JSON.stringify(DUMMY_SCOPE) };
    }
    if (fullCmd === "git rev-parse HEAD") return { output: "deadbeefcafe\n" };
    if (fullCmd === "git status --porcelain") return { output: " M src/foo.js\n" };
    if (fullCmd === "git log --oneline -5") return { output: "deadbee latest\n" };
    if (fullCmd === "git ls-files --others --exclude-standard") return { output: "src/new.js\n" };
    return { output: "" };
  }

  it("without --base, renders the container block against HEAD and captures no diff", async () => {
    const { commands, callTool } = recordingTool(defaultHandler);
    const input = await collectContainerReviewInput({ container: "cid123", callTool });

    assert.ok(input.startsWith("## Review target"));
    assert.ok(input.includes("container `cid123`"));
    assert.ok(input.includes("`diff_in_container`"));
    assert.ok(input.includes("- Base commit: `deadbeefcafe`"));
    assert.ok(input.includes('"formatVersion": 1'));
    assert.ok(input.includes('"src/foo.js"'));
    assert.ok(input.includes('"src/new.js"'));
    // The base is what the reviewer cannot derive, so it is named as the ref
    // to fetch against; the diff body is not captured at all (kusabi #208).
    assert.ok(input.includes("Fetching the diff is YOUR job"));
    assert.ok(input.includes("`base` set to `deadbeefcafe`"));
    assert.ok(!input.includes("diff --git"));
    // Same default the chain uses: HEAD.
    assert.ok(commands.includes("git rev-parse HEAD"));
    assert.ok(commands.some((c) => c.includes("change-scope.mjs")));
    assert.ok(
      !commands.some((c) => c.startsWith("git diff")),
      `no git diff may be issued, got: ${JSON.stringify(commands)}`,
    );
  });

  it("with --base, resolves that ref and names it as the ref to diff against", async () => {
    const { commands, callTool } = recordingTool((cmd, params) => {
      const fullCmd = params?.commands?.[0] ?? params?.argv?.join(" ") ?? (typeof cmd === "string" ? cmd : "");
      if (fullCmd.includes("change-scope.mjs")) {
        return {
          output: JSON.stringify({
            formatVersion: 1,
            repositoryRoot: "/workspace",
            input: { base: "c355fa61a7fee5402ed7ba999bd2fe2eeb46a842", head: "HEAD" },
            resolved: { baseSha: "c355fa61a7fee5402ed7ba999bd2fe2eeb46a842", headSha: "deadbeefcafe", mergeBaseSha: "c355fa61a7fee5402ed7ba999bd2fe2eeb46a842" },
            paths: { committed: [], staged: [], unstaged: ["src/foo.js"], untracked: [] },
          }),
        };
      }
      if (fullCmd.startsWith("git rev-parse --verify")) return { output: "c355fa61a7fee5402ed7ba999bd2fe2eeb46a842\n" };
      if (fullCmd === "git status --porcelain") return { output: " M src/foo.js\n" };
      if (fullCmd === "git log --oneline -5") return { output: "c355fa6 base\n" };
      return { output: "" };
    });
    const input = await collectContainerReviewInput({ container: "cid123", callTool, base: "c355fa6" });

    assert.ok(commands.some((c) => c.startsWith("git rev-parse --verify --quiet 'c355fa6^{commit}'")));
    assert.ok(commands.some((c) => c.includes("change-scope.mjs")));
    assert.ok(
      !commands.some((c) => c.startsWith("git diff")),
      `--base must reach the reviewer as an instruction, not a capture, got: ${JSON.stringify(commands)}`,
    );
    assert.ok(input.includes("- Base commit: `c355fa61a7fee5402ed7ba999bd2fe2eeb46a842`"));
    assert.ok(input.includes("`base` set to `c355fa61a7fee5402ed7ba999bd2fe2eeb46a842`"));
    assert.ok(input.includes('"formatVersion": 1'));
  });

  it("labels a change-set list the container paged, counting the lines it actually shows", async () => {
    // The defect #208 fixes: a one-page capture that reads as the whole thing.
    // What is captured now is a file list, and a file list can page too.
    //
    // The envelope is the live server's cut shape: 50 lines returned out of
    // 137, reported as shown=137 (== total_lines) with next_offset=50.  The
    // numerator in the label must come from the 50 lines in the block, NOT
    // from `shown` -- rendering `shown` gives "showing 137 of 137", a
    // truncation label that says nothing was withheld.
    const { callTool } = recordingTool((cmd) => {
      if (cmd === "git rev-parse HEAD") return { output: "deadbeefcafe\n" };
      if (cmd === "git status --porcelain") {
        return {
          status: "ok",
          output: Array.from({ length: 50 }, (_, i) => " M src/f" + i + ".js").join("\n") + "\n",
          shown: 137,
          total_lines: 137,
          truncated: true,
          next_offset: 50,
          has_more: true,
        };
      }
      return { output: "" };
    });
    const input = await collectContainerReviewInput({ container: "cid123", callTool, changeScope: false });
    assert.ok(input.includes("**Change set truncated (showing 50 of 137 lines).**"));
    assert.ok(!input.includes("showing 137 of 137"), "the response's own shown-count must never be rendered");
    assert.ok(input.includes("`diff_in_container` reports the complete file list"));

    // The label's own numbers must agree with the label: a numerator that is
    // not strictly below the denominator announces a cut and then denies it.
    const counts = /showing (\d+) of (\d+) lines/.exec(input);
    assert.ok(counts, "the paged label must carry counts");
    assert.ok(Number(counts[1]) < Number(counts[2]), `numerator must be below the denominator, got ${counts[0]}`);
  });

  it("labels a change set the container cut with truncated:false and has_more:true", async () => {
    // Measured on the live server: paging can cut the output while
    // `truncated` stays false (that flag is the summary layer).  Reading
    // `truncated` alone would let this one through unlabelled.
    const { callTool } = recordingTool((cmd) => {
      if (cmd === "git rev-parse HEAD") return { output: "deadbeefcafe\n" };
      if (cmd === "git status --porcelain") {
        return {
          status: "ok",
          output: Array.from({ length: 25 }, (_, i) => " M src/f" + i + ".js").join("\n") + "\n",
          shown: 61,
          total_lines: 61,
          truncated: false,
          next_offset: 25,
          has_more: true,
        };
      }
      return { output: "" };
    });
    const input = await collectContainerReviewInput({ container: "cid123", callTool, changeScope: false });
    assert.ok(input.includes("**Change set truncated (showing 25 of 61 lines).**"));
  });

  it("labels nothing when the container reports every capture complete", async () => {
    const { callTool } = recordingTool((cmd) => {
      const complete = (output) => ({ status: "ok", output, shown: 1, total_lines: 1, truncated: false, next_offset: null, has_more: false });
      if (cmd === "git rev-parse HEAD") return complete("deadbeefcafe\n");
      if (cmd === "git status --porcelain") return complete(" M src/foo.js\n");
      if (cmd === "git log --oneline -5") return complete("deadbee latest\n");
      if (cmd === "git ls-files --others --exclude-standard") return complete("src/new.js\n");
      return complete("");
    });
    const input = await collectContainerReviewInput({ container: "cid123", callTool, changeScope: false });
    assert.ok(!input.includes("truncated"), "a complete capture must not be labelled as cut");
  });

  it("throws when --base does not resolve in the container", async () => {
    const { callTool } = recordingTool((cmd) => {
      if (cmd.startsWith("git rev-parse --verify")) return { output: "__KUSABI_BASE_UNRESOLVED__\n" };
      return { output: "" };
    });
    await assert.rejects(
      () => collectContainerReviewInput({ container: "cid123", callTool, base: "nosuchref" }),
      /--base nosuchref is not a valid revision in container cid123/,
    );
  });

  it("throws when the base lookup itself fails, naming the container", async () => {
    const callTool = async () => { throw new Error("sunaba-rpc: tools/call failed (HTTP 500)"); };
    await assert.rejects(
      () => collectContainerReviewInput({ container: "cid123", callTool, base: "c355fa6" }),
      /--base c355fa6 could not be resolved in container cid123/,
    );
  });

  it("rejects a base ref with shell metacharacters before issuing any command", async () => {
    const { commands, callTool } = recordingTool(defaultHandler);
    await assert.rejects(
      () => collectContainerReviewInput({ container: "cid123", callTool, base: "abc'; rm -rf /; echo '" }),
      /is not a usable git revision/,
    );
    assert.deepEqual(commands, []);
  });

  it("degrades to (unavailable) instead of throwing when the container is unreachable", async () => {
    const callTool = async () => { throw new Error("sunaba-rpc: initialize failed (HTTP 502)"); };
    const input = await collectContainerReviewInput({ container: "cid123", callTool });
    assert.ok(input.includes("## Review target"));
    assert.ok(input.includes("- Base commit: (unavailable)"));
    // No base to name: the instruction says so and names the fallback rather
    // than disappearing.
    assert.ok(input.includes("Fetching the diff is YOUR job"));
    assert.ok(input.includes("`worktree: true`"));
  });

  it("produces a well-formed input when the change set is empty", async () => {
    const { callTool } = recordingTool((cmd) => {
      if (cmd === "git rev-parse HEAD") return { output: "deadbeefcafe\n" };
      if (cmd === "git log --oneline -5") return { output: "deadbee latest\n" };
      return { output: "" };
    });
    const input = await collectContainerReviewInput({ container: "cid123", callTool, changeScope: false });
    assert.ok(input.includes("(empty change set)"));
    assert.ok(input.includes("`base` set to `deadbeefcafe`"));
    assert.ok(!input.includes("```diff"));
    // Balanced fences: an empty diff must not leave the prompt half-fenced.
    assert.equal((input.match(/```/g) || []).length % 2, 0);
    assert.ok(input.endsWith("must not be flagged as such."));
  });
});

describe("assertContainerBaseRef", () => {
  it("accepts the ref shapes git actually uses", () => {
    for (const ref of ["c355fa6", "main", "origin/main", "HEAD~3", "v1.2.3", "HEAD^{commit}", "refs/heads/feature-x"]) {
      assert.doesNotThrow(() => assertContainerBaseRef(ref));
    }
  });

  it("rejects anything that could break out of the shell word", () => {
    for (const ref of ["a b", "a'b", 'a"b', "a;b", "a$(b)", "a&&b", "a|b", "`b`"]) {
      assert.throws(() => assertContainerBaseRef(ref), /is not a usable git revision/);
    }
  });
});

// The base ref used to select which `git diff` was captured; that capture is
// gone (kusabi #208), so what these pin is the seam it moved to: the ref
// reaches the reviewer as the base named in the fetch instruction, and no diff
// is ever run in the container on either route.

describe("base ref reaches the reviewer as an instruction, not a capture", () => {
  function recorder() {
    const commands = [];
    return {
      commands,
      callTool: async (tool, params) => {
        const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
        commands.push(cmd);
        if (cmd.includes("change-scope.mjs")) {
          const base = cmd.includes("c355fa61a7fee5402ed7ba999bd2fe2eeb46a842") ? "c355fa61a7fee5402ed7ba999bd2fe2eeb46a842" : "deadbeefcafe";
          return {
            output: JSON.stringify({
              formatVersion: 1,
              repositoryRoot: "/workspace",
              input: { base, head: "HEAD" },
              resolved: { baseSha: base, headSha: "deadbeefcafe", mergeBaseSha: base },
              paths: { committed: [], staged: [], unstaged: [], untracked: [] },
            }),
          };
        }
        if (cmd.startsWith("git rev-parse --verify")) return { output: "c355fa61a7fee5402ed7ba999bd2fe2eeb46a842\n" };
        if (cmd === "git rev-parse HEAD") return { output: "deadbeefcafe\n" };
        return { output: "" };
      },
    };
  }

  it("names HEAD when no base is given, and runs no diff", async () => {
    const { commands, callTool } = recorder();
    const input = await collectContainerReviewInput({ container: "cid123", callTool });
    assert.ok(input.includes("`base` set to `deadbeefcafe`"));
    assert.ok(!commands.some((c) => c.startsWith("git diff")));
  });

  it("names the resolved base when one is given, and runs no diff", async () => {
    const { commands, callTool } = recorder();
    const input = await collectContainerReviewInput({ container: "cid123", callTool, base: "c355fa6" });
    assert.ok(input.includes("`base` set to `c355fa61a7fee5402ed7ba999bd2fe2eeb46a842`"));
    assert.ok(!commands.some((c) => c.startsWith("git diff")));
  });

  it("collectContainerBaseContext takes no base argument to honour", async () => {
    const { commands, callTool } = recorder();
    await collectContainerBaseContext(callTool, "cid123");
    assert.deepEqual(commands, ["git log --oneline -5", "git ls-files --others --exclude-standard"]);
  });
});

// ---------------------------------------------------------------------------
// change-scope wiring into review and probe phases (kusabi #379)
// ---------------------------------------------------------------------------

describe("change-scope wiring into review and probe phases (kusabi #379)", () => {
  const FIXTURE_CHANGE_SCOPE = {
    formatVersion: 1,
    repositoryRoot: "/workspace",
    input: { base: "base-sha-123", head: "HEAD" },
    resolved: {
      baseSha: "base-sha-123",
      headSha: "head-sha-456",
      mergeBaseSha: "base-sha-123",
    },
    paths: {
      committed: ["src/committed.js"],
      staged: ["src/staged.js"],
      unstaged: ["src/unstaged.js"],
      untracked: ["src/untracked.js"],
    },
  };

  it("change-scope invalid JSON fails closed in collectContainerReviewInput (throws, does not substitute porcelain)", async () => {
    const callTool = async (toolName, params) => {
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
      if (cmd.includes("change-scope.mjs")) {
        return { output: "not valid json {{" };
      }
      if (cmd.startsWith("git rev-parse --verify") || cmd === "git rev-parse HEAD") return { output: "base123\n" };
      if (cmd === "git status --porcelain") return { output: " M porcelain-file.js\n" };
      return { output: "" };
    };

    await assert.rejects(
      () => collectContainerReviewInput({ container: "cid-fail-json", callTool, base: "base123" }),
      /change-scope produced invalid JSON/,
    );
  });

  it("change-scope empty stdout fails closed in collectContainerReviewInput (throws, does not substitute porcelain)", async () => {
    const callTool = async (toolName, params) => {
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
      if (cmd.includes("change-scope.mjs")) {
        return { output: "" };
      }
      if (cmd.startsWith("git rev-parse --verify") || cmd === "git rev-parse HEAD") return { output: "base123\n" };
      if (cmd === "git status --porcelain") return { output: " M porcelain-file.js\n" };
      return { output: "" };
    };

    await assert.rejects(
      () => collectContainerReviewInput({ container: "cid-fail-empty-task", callTool, base: "base123" }),
      /change-scope produced empty output/,
    );
  });

  it("change-scope empty stdout fails closed for container cid123 (no production special-case)", async () => {
    const callTool = async (toolName, params) => {
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
      if (cmd.includes("change-scope.mjs")) {
        return { output: "" };
      }
      if (cmd.startsWith("git rev-parse --verify") || cmd === "git rev-parse HEAD") return { output: "base123\n" };
      if (cmd === "git status --porcelain") return { output: " M porcelain-file.js\n" };
      return { output: "" };
    };

    await assert.rejects(
      () => collectContainerReviewInput({ container: "cid123", callTool, base: "base123" }),
      /change-scope produced empty output/,
    );
  });


  it("change-scope formatVersion contract mismatch fails closed in collectContainerReviewInput", async () => {
    const callTool = async (toolName, params) => {
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
      if (cmd.includes("change-scope.mjs")) {
        return { output: JSON.stringify({ formatVersion: 2, resolved: {}, paths: {} }) };
      }
      if (cmd.startsWith("git rev-parse --verify") || cmd === "git rev-parse HEAD") return { output: "base123\n" };
      return { output: "" };
    };

    await assert.rejects(
      () => collectContainerReviewInput({ container: "cid-fail-contract", callTool, base: "base123" }),
      /change-scope JSON contract mismatch/,
    );
  });

  it("collectContainerReviewInput records change-scope invocation, contains JSON, and runs no git diff", async () => {
    const invocations = [];
    const commands = [];
    const callTool = async (toolName, params) => {
      const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
      commands.push(cmd);
      invocations.push({ toolName, params });
      if (cmd.includes("change-scope.mjs")) {
        return { output: JSON.stringify(FIXTURE_CHANGE_SCOPE) };
      }
      if (cmd.startsWith("git rev-parse --verify")) {
        return { output: "base-sha-123\n" };
      }
      return { output: "" };
    };

    const input = await collectContainerReviewInput({ container: "cid-scope-test", callTool, base: "base-sha-123" });

    // Injects change-scope.mjs into the container before exec
    const injectCall = invocations.find((i) => i.toolName === "copy_file");
    assert.ok(injectCall, "must invoke copy_file to inject change-scope.mjs");
    assert.equal(injectCall.params.container_id, "cid-scope-test");
    assert.equal(injectCall.params.dest_path, "/tmp/kusabi-change-scope.mjs");
    assert.ok(injectCall.params.local_src_file.endsWith("change-scope.mjs"));

    // Records change-scope invocation with argv and without commands
    const scopeCall = invocations.find((i) => i.params?.argv?.some((a) => a.includes("change-scope.mjs")));
    assert.ok(scopeCall, "must invoke change-scope.mjs with argv");
    assert.equal(scopeCall.params.commands, undefined, "must not pass commands when argv is used");
    assert.deepEqual(scopeCall.params.argv, ["node", "/tmp/kusabi-change-scope.mjs", "--base", "base-sha-123", "--head", "HEAD"]);
    assert.ok(invocations.indexOf(injectCall) < invocations.indexOf(scopeCall), "inject must precede sandbox_exec");

    // Existing assertion: no git diff may be issued
    assert.ok(!commands.some((c) => c.startsWith("git diff")), "no git diff may be issued");
    // Rendered input contains the JSON
    assert.ok(input.includes("Authoritative change set (`change-scope`):"));
    assert.ok(input.includes('"formatVersion": 1'));
    assert.ok(input.includes('"src/committed.js"'));
    assert.ok(input.includes('"src/staged.js"'));
    assert.ok(input.includes('"src/unstaged.js"'));
    assert.ok(input.includes('"src/untracked.js"'));
    // Diff instruction names base
    assert.ok(input.includes("Fetching the diff is YOUR job"));
    assert.ok(input.includes("`base` set to `base-sha-123`"));
  });

  it("change-scope inject failure in collectChangeScope throws and does not exec fallback", async () => {
    const executed = [];
    const callTool = async (toolName, params) => {
      if (toolName === "copy_file") {
        throw new Error("copy_file failed: disk full");
      }
      executed.push({ toolName, params });
      return { output: "" };
    };

    await assert.rejects(
      () => collectChangeScope({ container: "cid-fail-inject", callTool, base: "base-sha-123" }),
      /change-scope inject failed in container cid-fail-inject: copy_file failed: disk full/,
    );
    assert.equal(executed.length, 0, "sandbox_exec must not be invoked when inject fails");
  });

  it("change-scope inject returning error object fails closed", async () => {
    const executed = [];
    const callTool = async (toolName, params) => {
      if (toolName === "copy_file") {
        return { error: "failed to write to /tmp" };
      }
      executed.push({ toolName, params });
      return { output: "" };
    };

    await assert.rejects(
      () => collectChangeScope({ container: "cid-fail-inject-obj", callTool, base: "base-sha-123" }),
      /change-scope inject failed in container cid-fail-inject-obj: failed to write to \/tmp/,
    );
    assert.equal(executed.length, 0, "sandbox_exec must not be invoked when inject returns error");
  });

  it("collectReviewContext does not invoke change-scope.mjs", async () => {
    const commands = [];
    const callTool = async (toolName, params) => {
      const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
      commands.push(cmd);
      if (cmd === "git status --porcelain") return { output: "" };
      if (cmd === "git log --oneline -5") return { output: "base commit\n" };
      if (cmd.startsWith("git ls-files --others")) return { output: "" };
      return { output: "" };
    };

    const reviewCtx = await collectReviewContext({
      container: "cid-resume",
      brief: "## Deliverables\n\n- `src/foo.js`\n",
      callTool,
      worktreeBaseline: null,
      roundRecord: { changeScope: FIXTURE_CHANGE_SCOPE },
    });

    // Crucial check: change-scope was NOT executed
    assert.ok(!commands.some((c) => c.includes("change-scope.mjs")), "collectReviewContext must not invoke change-scope.mjs");
    // roundRecord is untouched and context is collected
    assert.equal(reviewCtx.chainStatusObserved, true);
  });
});




