import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runReviewPhase,
} from "./chain-review.mjs";
import {
  resolveReworkScope,
  resolveRoundResume,
  captureVerifyBaseline,
  normalizeFilePath,
  hasRepeatedAreas,
  applyTierEscalation,
  recordReworkEscalation,
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
