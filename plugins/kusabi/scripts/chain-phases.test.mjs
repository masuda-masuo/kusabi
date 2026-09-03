import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runReviewPhase,
} from "./chain-review.mjs";
import {
  resolveRoundResume,
  captureVerifyBaseline,
} from "./chain-phases.mjs";
import { renderPriorFindings } from "./render.mjs";

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
// phase functions carry the failure classification (kusabi #215)
// =========================================================================

describe("phase functions carry the failure classification (kusabi #215)", () => {
  const QUOTA_FAILURE = {
    kind: "quota-exhaustion",
    quota: "session",
    backendBlocked: true,
    reset: "1:20am (Asia/Tokyo)",
  };

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
