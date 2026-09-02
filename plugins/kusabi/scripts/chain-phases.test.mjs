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
  buildImplementText,
  runImplementPhase,
  resolveReworkScope,
  computeChainTotals,
  resolveRoundResume,
  captureVerifyBaseline,
  runProbePhase,
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

// buildImplementText  —  pure, extracted from cmdChain (chain-phases.mjs)
// =========================================================================

describe("buildImplementText", () => {
  const brief = "# Fix the bug\n\nMake foo return bar.";

  it("round 1 returns the brief as-is", () => {
    const result = buildImplementText({ round: 1, brief, previousRecord: null });
    assert.equal(result, brief);
  });

  it("round 1 without container is the brief verbatim (no header)", () => {
    const result = buildImplementText({ round: 1, brief, previousRecord: null });
    assert.equal(result, brief);
    assert.ok(!result.includes("The workspace lives inside container"));
  });

  it("round 1 with container starts with the exact-ID header, then the brief verbatim", () => {
    const result = buildImplementText({ round: 1, brief, previousRecord: null, container: "abc123def456" });
    assert.ok(result.startsWith(
      "The workspace lives inside container `abc123def456`. Pass this exact ID as `container_id` to every sunaba tool call. Do not guess container names or call sandbox_attach.\n\n"
    ));
    assert.ok(result.endsWith(brief));
  });

  it("round 2+ with container keeps the header first, then the prior-findings structure intact", () => {
    const prev = { findingsText: "file: src/foo.js:42 \u2014 missing null check" };
    const result = buildImplementText({ round: 2, brief, previousRecord: prev, container: "abc123def456" });
    assert.ok(result.startsWith(
      "The workspace lives inside container `abc123def456`. Pass this exact ID as `container_id` to every sunaba tool call. Do not guess container names or call sandbox_attach.\n\n"
    ));
    assert.ok(result.includes("## Prior findings"));
    assert.ok(result.includes("file: src/foo.js:42"));
    assert.ok(result.includes("## Acceptance criteria"));
    assert.ok(result.includes(brief));
    // The header must appear only once, before any other content.
    assert.equal(result.indexOf("The workspace lives inside container"), 0);
  });

  it("round 2+ includes prior findings and acceptance criteria", () => {
    const prev = { findingsText: "file: src/foo.js:42 — missing null check" };
    const result = buildImplementText({ round: 2, brief, previousRecord: prev });
    assert.ok(result.includes("## Prior findings"));
    assert.ok(result.includes("file: src/foo.js:42"));
    assert.ok(result.includes("## Acceptance criteria"));
    assert.ok(result.includes(brief));
  });

  it("round 2+ shows (none) when no prior findings", () => {
    const prev = {};
    const result = buildImplementText({ round: 3, brief, previousRecord: prev });
    assert.ok(result.includes("(none)"));
    assert.ok(result.includes("## Acceptance criteria"));
  });

  it("round 2+ includes strategist recommendation when present", () => {
    const prev = {
      findingsText: "findings...",
      strategistRecommendation: "Use a Map instead of indexing a list",
    };
    const result = buildImplementText({ round: 2, brief, previousRecord: prev });
    assert.ok(result.includes("Strategist recommendation"));
    assert.ok(result.includes("Use a Map instead of indexing a list"));
  });

  it("round 2+ with no previousRecord returns brief", () => {
    const result = buildImplementText({ round: 2, brief, previousRecord: null });
    assert.equal(result, brief);
  });

  it("round 2+ without strategistRecommendation omits the section", () => {
    const prev = { findingsText: "some findings" };
    const result = buildImplementText({ round: 2, brief, previousRecord: prev });
    assert.ok(!result.includes("Strategist recommendation"));
  });

  it("includes body and recommendation of a prior finding when structured findings exist", () => {
    const prev = {
      findings: [
        {
          severity: "high",
          title: "Missing null check",
          file: "src/foo.js",
          line_start: 42,
          line_end: 45,
          confidence: 0.9,
          body: "The function bar() does not validate its input.",
          recommendation: "Add a null guard at the top of bar().",
        },
      ],
    };
    const result = buildImplementText({ round: 2, brief, previousRecord: prev });
    assert.ok(result.includes("Missing null check"));
    assert.ok(result.includes("src/foo.js:42"));
    assert.ok(result.includes("The function bar() does not validate its input."));
    assert.ok(result.includes("Add a null guard at the top of bar()."));
  });

  it("includes the instruction that findings must be resolved or reported", () => {
    const prev = {
      findingsText: "some findings",
      findings: [
        { severity: "low", title: "Naming", file: "a.js", line_start: 1, line_end: 1, confidence: 0.5, body: "x", recommendation: "rename" },
      ],
    };
    const result = buildImplementText({ round: 2, brief, previousRecord: prev });
    assert.ok(result.includes("## Instruction"));
    assert.ok(result.includes("Resolve each prior finding"));
    assert.ok(result.includes("cannot be fully resolved"));
    assert.ok(result.includes("explain why"));
  });

  it("marks truncation when the prior findings block exceeds the budget", () => {
    // Build a finding with a long body to exceed the 8000-char PRIOR_FINDINGS_BUDGET
    const longBody = "A".repeat(8100);
    const prev = {
      findings: [
        {
          severity: "medium",
          title: "Long finding",
          file: "big.js",
          line_start: 1,
          line_end: 10,
          confidence: 0.8,
          body: longBody,
          recommendation: "short fix",
        },
      ],
    };
    const result = buildImplementText({ round: 2, brief, previousRecord: prev });
    assert.ok(result.includes("Prior findings truncated to"));
    assert.ok(result.includes("8000"));
  });

  it("does not mark truncation when the prior findings block is under the budget", () => {
    const prev = {
      findings: [
        {
          severity: "low",
          title: "Tiny issue",
          file: "small.js",
          line_start: 1,
          line_end: 2,
          confidence: 0.9,
          body: "Short body.",
          recommendation: "Fix it.",
        },
      ],
    };
    const result = buildImplementText({ round: 2, brief, previousRecord: prev });
    assert.ok(!result.includes("Prior findings truncated to"));
    assert.ok(!result.includes("truncated"));
  });

  it("produces a usable prompt without throwing when previous record has no structured findings", () => {
    const prev = { findingsText: "[high] Old issue (old.js:5)" };
    const result = buildImplementText({ round: 2, brief, previousRecord: prev });
    assert.ok(result.includes("## Prior findings"));
    assert.ok(result.includes("[high] Old issue (old.js:5)"));
    assert.ok(result.includes("## Acceptance criteria"));
  });

  it("produces a usable prompt without throwing when previous record is empty", () => {
    const prev = {};
    const result = buildImplementText({ round: 2, brief, previousRecord: prev });
    assert.ok(result.includes("## Prior findings"));
    assert.ok(result.includes("(none)"));
    assert.ok(result.includes("## Acceptance criteria"));
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

// buildImplementText — scoped rework brief (kusabi #60 step 2)
// =========================================================================
// A scoped round renders ONLY its subset with the FULL per-finding renderer
// (bodies + recommendations, same budget bound as the full path — followup),
// prefixed by one sentence naming the scope.  The full-scope path must stay
// byte-identical to the pre-scheduling output.

describe("buildImplementText scoped rework brief", () => {
  const brief = "# Fix the bug\n\nMake foo return bar.";
  const mechFinding = {
    severity: "medium", title: "Rename variable", file: "src/b.js", line_start: 10,
    kind: "mechanical", body: "bad name", recommendation: "rename it",
  };
  const designFinding = {
    severity: "high", title: "API shape decision", file: "src/a.js", line_start: 1,
    kind: "design", body: "needs a decision", recommendation: "decide",
  };

  it("mechanical scope renders the mechanical subset with the scope sentence", () => {
    const prev = { findings: [designFinding, mechFinding] };
    const result = buildImplementText({ round: 2, brief, previousRecord: prev, reworkScope: resolveReworkScope(prev) });
    assert.ok(result.includes("This round resolves ONLY the following mechanical checklist; other known findings are deliberately out of scope this round."));
    assert.ok(result.includes("## Mechanical findings (checklist)"));
    assert.ok(result.includes("Rename variable"));
    assert.ok(!result.includes("API shape decision"));
    // Followup: the scoped block is the FULL per-finding rendering — heading
    // with severity/location, body and recommendation, exactly like the
    // full-scope path — not a one-line summary.
    assert.ok(result.includes("### [medium] Rename variable (src/b.js:10)"));
    assert.ok(result.includes("bad name"));
    assert.ok(result.includes("**Recommendation:** rename it"));
    // The held-back design finding must not leak, including its body.
    assert.ok(!result.includes("needs a decision"));
    // Prompt structure stays intact around the scoped block.
    assert.ok(result.includes("## Instruction"));
    assert.ok(result.includes("Resolve each prior finding"));
    assert.ok(result.includes("## Acceptance criteria"));
    assert.ok(result.includes(brief));
  });

  it("design scope renders the single design finding with the scope sentence", () => {
    const second = { ...designFinding, title: "Second design", body: "second body" };
    const prev = { findings: [designFinding, second] };
    const result = buildImplementText({ round: 2, brief, previousRecord: prev, reworkScope: resolveReworkScope(prev) });
    assert.ok(result.includes("This round resolves ONLY the following design finding; other known findings are deliberately out of scope this round."));
    assert.ok(result.includes("## Design findings (require deliberate individual treatment)"));
    assert.ok(result.includes("API shape decision"));
    assert.ok(!result.includes("Second design"));
    // Followup: full per-finding rendering of the scoped subset (heading,
    // body, recommendation); the held-back second finding's body stays out.
    assert.ok(result.includes("### [high] API shape decision (src/a.js:1)"));
    assert.ok(result.includes("needs a decision"));
    assert.ok(result.includes("**Recommendation:** decide"));
    assert.ok(!result.includes("second body"));
  });

  it("scoped brief keeps the container header first and the scope block after it", () => {
    const prev = { findings: [mechFinding] };
    const result = buildImplementText({ round: 2, brief, previousRecord: prev, container: "abc123def456", reworkScope: resolveReworkScope(prev) });
    assert.equal(result.indexOf("The workspace lives inside container"), 0);
    assert.ok(result.includes("ONLY the following mechanical checklist"));
  });

  it("full scope is byte-identical with and without reworkScope", () => {
    const prev = { findings: [designFinding, mechFinding] };
    const plain = buildImplementText({ round: 2, brief, previousRecord: prev, container: "abc123def456" });
    const withScope = buildImplementText({ round: 2, brief, previousRecord: prev, container: "abc123def456", reworkScope: { scope: "full", findings: [] } });
    assert.equal(withScope, plain);
  });

  it("full scope is byte-identical even when reworkScope carries a findings subset", () => {
    // The full path ignores the subset — only the scope label decides.
    const prev = { findings: [mechFinding] };
    const plain = buildImplementText({ round: 2, brief, previousRecord: prev });
    const withScope = buildImplementText({ round: 2, brief, previousRecord: prev, reworkScope: { scope: "full", findings: [mechFinding] } });
    assert.equal(withScope, plain);
  });

  it("reworkScope absent falls back to the pre-scheduling full text", () => {
    const prev = { findings: [designFinding, mechFinding] };
    const result = buildImplementText({ round: 2, brief, previousRecord: prev });
    // No scope sentence, both findings present via renderPriorFindings.
    assert.ok(!result.includes("ONLY the following"));
    assert.ok(result.includes("API shape decision"));
    assert.ok(result.includes("Rename variable"));
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

  it("runImplementPhase returns implementJobFailure from the failed job's record", async () => {
    const result = await runImplementPhase({
      cwd: "/tmp", chainId: "chain-test", round: 1, isFirstRound: true,
      implementText: "brief", modelChain: [["opus"]], tierIndex: 0,
      useNewSession: false, session: undefined, resumeMethod: { type: "fresh_session" },
      flagsModel: null, backend: "claude",
      _dispatchWithFallback: failingDispatch("provider-error", QUOTA_FAILURE),
    });
    assert.deepEqual(result.implementJobFailure, QUOTA_FAILURE);
    assert.equal(result.implementJobStatus, "provider-error");
  });

  it("runImplementPhase returns null implementJobFailure for a generic failure", async () => {
    const result = await runImplementPhase({
      cwd: "/tmp", chainId: "chain-test", round: 1, isFirstRound: true,
      implementText: "brief", modelChain: [["opus"]], tierIndex: 0,
      useNewSession: false, session: undefined, resumeMethod: { type: "fresh_session" },
      flagsModel: null, backend: "claude",
      _dispatchWithFallback: failingDispatch("error", null),
    });
    assert.equal(result.implementJobFailure, null);
    assert.equal(result.implementJobStatus, "error");
  });

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

  it("runImplementPhase classifies an agy quota error as implementJobFailure", async () => {
    const agyError = "agy dispatch failed: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h1m21s.";
    const result = await runImplementPhase({
      cwd: "/tmp", chainId: "chain-test", round: 1, isFirstRound: true,
      implementText: "brief", modelChain: [["gemini-3.6-flash-high"]], tierIndex: 0,
      useNewSession: false, session: undefined, resumeMethod: { type: "fresh_session" },
      flagsModel: null, backend: "agy",
      _dispatchWithFallback: async () => ({
        job: {
          id: "job-fail", status: "error", modelEntry: "gemini-3.6-flash-high",
          modelVariant: null, fallbacks: null, sessionID: null,
          usage: null, error: agyError, failure: null,
        },
        resultText: "",
      }),
    });
    assert.equal(result.implementJobStatus, "error");
    assert.equal(result.implementJobFailure.kind, "quota-exhaustion");
    assert.equal(result.implementJobFailure.backend, "agy");
    assert.equal(result.roundRecord.implementJobError, agyError);
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

// runProbePhase diff capture — new diff and untracked fields
// ---------------------------------------------------------------------------

describe("runProbePhase return value", () => {
  // runProbePhase takes callTool as a parameter, so the capture is driven with
  // a stub that answers the two git commands with known output.
  function captureCallTool({ untracked = "", status = "", statusEnvelope = null, throwOn = null } = {}) {
    const commands = [];
    return {
      commands,
      callTool: async (toolName, params) => {
        if (toolName !== "sandbox_exec") return { output: "" };
        const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
        commands.push(cmd);
        if (throwOn && cmd.startsWith(throwOn)) throw new Error("container is gone");
        if (cmd.includes("change-scope.mjs")) {
          return {
            output: JSON.stringify({
              formatVersion: 1,
              repositoryRoot: "/workspace",
              input: { base: "abc1234", head: "HEAD" },
              resolved: { baseSha: "abc1234", headSha: "abc1234", mergeBaseSha: "abc1234" },
              paths: { committed: [], staged: [], unstaged: [], untracked: [] },
            }),
          };
        }
        if (cmd === "git status --porcelain") return statusEnvelope ?? { output: status };
        if (cmd.startsWith("git ls-files --others")) return { output: untracked };
        return { output: "" };
      },
    };
  }

  it("returns the untracked file list and never captures a diff", async () => {
    const { commands, callTool } = captureCallTool({ untracked: "src/brand-new.js\n" });

    const result = await runProbePhase({
      baseSha: "abc1234",
      container: "fake-cid",
      brief: "## Deliverables\n\n- `src/a.js`\n",
      callTool,
    });

    assert.equal(result.chainUntracked.trim(), "src/brand-new.js");
    assert.ok(
      commands.some((c) => c.startsWith("git ls-files --others")),
      "capture must list untracked files",
    );
    // The diff capture is gone, not widened (kusabi #208): it was one
    // default-paged sandbox_exec call, so it could only ever return page one,
    // and the reviewer fetches the diff itself with `diff_in_container`.
    assert.ok(
      !commands.some((c) => c.startsWith("git diff")),
      `no git diff may be captured, got: ${JSON.stringify(commands)}`,
    );
    assert.equal(result.chainDiff, undefined);
  });

  it("leaves the untracked field empty when the capture call throws", async () => {
    const { callTool } = captureCallTool({ throwOn: "git ls-files --others" });

    const result = await runProbePhase({
      baseSha: "abc1234",
      container: "fake-cid",
      brief: "",
      callTool,
    });

    // Degrades rather than throwing: renderBaseFacts then says "(unavailable)".
    assert.equal(result.chainUntracked, "");
  });

  it("carries what sandbox_exec said about each capture's own paging", async () => {
    // The status list is the one that can genuinely exceed a page, and the
    // rendered input must be able to say so.  The flags come from the server,
    // never from counting lines.
    //
    // The envelope mimics the live server: on a CUT response `shown` equals
    // `total_lines` (it is not the number of lines returned) and `next_offset`
    // is the count of lines returned.  A stub that set `shown` to 50 here
    // could not reproduce the defect that `shown` is unusable.
    const { callTool } = captureCallTool({
      statusEnvelope: {
        output: Array.from({ length: 50 }, (_, i) => " M src/f" + i + ".js").join("\n") + "\n",
        shown: 137,
        total_lines: 137,
        truncated: true,
        has_more: true,
        next_offset: 50,
      },
      untracked: "src/brand-new.js\n",
    });

    const result = await runProbePhase({
      baseSha: "abc1234",
      container: "fake-cid",
      brief: "## Deliverables\n\n- `src/f0.js`\n",
      callTool,
    });

    // No shown-count is carried: the numerator is derived from the rendered
    // block, and `shown` from the response is never read.
    assert.deepEqual(result.chainTruncation.status, { truncated: true, total: 137 });
    assert.equal(result.chainTruncation.untracked.truncated, false);
    assert.equal(result.chainTruncation.baseLog.truncated, false);
  });

  it("forwards the verify baseline into P2 so tolerated lint debt passes the round", async () => {
    // The base has 190 pre-existing lint violations; the round's worktree has
    // the same 190 (no added debt) and green tests after the tolerated re-run.
    // With the baseline forwarded, P2 must PASS and the round must be green;
    // without it, P2 would fail on the lint precondition.
    const verifyCalls = [];
    const callTool = async (toolName, params) => {
      if (toolName === "verify_in_container") {
        verifyCalls.push(params);
        if (verifyCalls.length === 1) {
          return {
            gate_passed: false,
            lint: [{ rule: "no-unused-vars", file: "/workspace/src/a.py", line: 1, message: "x", severity: "error" }],
            types: [],
            tests: { status: "skipped", message: "precondition gate failed; tests not run" },
            gate_fail_reasons: ["lint (eslint): 1 violation(s)"],
          };
        }
        return { gate_passed: true, lint: [], types: [], tests: { full: { status: "ok", passed: 1, total: 1 } } };
      }
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
      if (cmd.includes("change-scope.mjs")) {
        return {
          output: JSON.stringify({
            formatVersion: 1,
            repositoryRoot: "/workspace",
            input: { base: "abc1234", head: "HEAD" },
            resolved: { baseSha: "abc1234", headSha: "abc1234", mergeBaseSha: "abc1234" },
            paths: { committed: [], staged: [], unstaged: ["src/a.js"], untracked: [] },
          }),
        };
      }
      if (cmd === "git status --porcelain") return { output: " M src/a.js\n" };
      if (cmd === "git diff") return { output: "" };
      if (cmd.startsWith("git ls-files --others")) return { output: "" };
      return { output: "" };
    };

    const baseline = { captured: true, gate_passed: false, lint: 1, types: 0, raw: {} };
    const result = await runProbePhase({
      baseSha: "abc1234",
      container: "fake-cid",
      brief: "## Deliverables\n\n- `src/a.js`\n",
      callTool,
      verifyBaseline: baseline,
    });

    assert.equal(result.probesGreen, true);
    const p2 = result.probeResults.find((p) => p.probe === "P2: verify gate");
    assert.equal(p2.passed, true);
    assert.match(p2.detail, /lint 1 \(baseline 1, tolerated\)/);
    assert.equal(verifyCalls.length, 2, "P2 + tolerated re-run");
    assert.equal(verifyCalls[1].skip_lint_gate, true);
  });

  it("keeps P2 strict when no verify baseline is provided", async () => {
    // Without a baseline, a lint-precondition failure stays a hard FAIL and no
    // re-run is attempted (byte-identical to the pre-#173 probe).
    const verifyCalls = [];
    const callTool = async (toolName, params) => {
      if (toolName === "verify_in_container") {
        verifyCalls.push(params);
        return {
          gate_passed: false,
          lint: [{ rule: "no-unused-vars", file: "/workspace/src/a.py", line: 1, message: "x", severity: "error" }],
          types: [],
          tests: { status: "skipped", message: "precondition gate failed; tests not run" },
          gate_fail_reasons: ["lint (eslint): 1 violation(s)"],
        };
      }
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
      if (cmd.includes("change-scope.mjs")) {
        return {
          output: JSON.stringify({
            formatVersion: 1,
            repositoryRoot: "/workspace",
            input: { base: "abc1234", head: "HEAD" },
            resolved: { baseSha: "abc1234", headSha: "abc1234", mergeBaseSha: "abc1234" },
            paths: { committed: [], staged: [], unstaged: ["src/a.js"], untracked: [] },
          }),
        };
      }
      if (cmd === "git diff") return { output: "" };
      if (cmd.startsWith("git ls-files --others")) return { output: "" };
      return { output: "" };
    };

    const result = await runProbePhase({
      baseSha: "abc1234",
      container: "fake-cid",
      brief: "## Deliverables\n\n- `src/a.js`\n",
      callTool,
    });

    assert.equal(result.probesGreen, false);
    assert.equal(verifyCalls.length, 1, "no tolerated re-run without a baseline");
  });
});

// Review input tool list — deliberately no source guard here (kusabi #204)
// ---------------------------------------------------------------------------
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
// runImplementPhase — session lineage guard (kusabi #192 invariant 5)
// -------------------------------------------------------------------------
// A rework implement round may only continue a session created by the
// implement backend; a session attributable to a record of the OTHER backend
// is dropped and the round starts fresh.  Records without a `backend` field
// predate the backend split and count as "opencode".
// =========================================================================

describe("runImplementPhase session lineage guard (kusabi #192)", () => {
  function makeStubDispatch() {
    const calls = [];
    const dispatch = async (opts) => {
      calls.push(opts);
      return {
        job: {
          id: "job-imp", status: "completed", modelEntry: "opus",
          modelVariant: null, fallbacks: null, sessionID: "claude-uuid-new",
          usage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
          error: null,
        },
        resultText: "implemented",
      };
    };
    return { dispatch, calls };
  }

  const base = {
    cwd: "/tmp", chainId: "chain-test", round: 2, isFirstRound: false,
    implementText: "brief", modelChain: [["opus"]], tierIndex: 0,
    useNewSession: false, session: undefined, resumeMethod: { type: "continue_session", detail: "" },
    flagsModel: null, backend: "claude",
  };

  it("continues the previous session when the previous record ran on the implement backend", async () => {
    const { dispatch, calls } = makeStubDispatch();
    await runImplementPhase({
      ...base,
      previousRecord: { sessionID: "claude-uuid-1", backend: "claude" },
      _dispatchWithFallback: dispatch,
    });
    assert.equal(calls[0].session, "claude-uuid-1");
  });

  it("drops a previous session created by the other backend (starts fresh)", async () => {
    const { dispatch, calls } = makeStubDispatch();
    await runImplementPhase({
      ...base,
      previousRecord: { sessionID: "ses_opencode_1", backend: "opencode" },
      _dispatchWithFallback: dispatch,
    });
    assert.ok(calls[0].session == null, "foreign opencode session must not be continued on claude");
  });

  it("a record without a backend field counts as opencode (both directions)", async () => {
    // opencode implement may continue the legacy (backend-less) session.
    const opencode = makeStubDispatch();
    await runImplementPhase({
      ...base, backend: "opencode",
      previousRecord: { sessionID: "ses_legacy_1" },
      _dispatchWithFallback: opencode.dispatch,
    });
    assert.equal(opencode.calls[0].session, "ses_legacy_1");

    // claude implement may NOT continue the legacy (opencode-attributed) session.
    const claude = makeStubDispatch();
    await runImplementPhase({
      ...base, backend: "claude",
      previousRecord: { sessionID: "ses_legacy_1" },
      _dispatchWithFallback: claude.dispatch,
    });
    assert.ok(claude.calls[0].session == null, "legacy opencode-attributed session must not run on claude");
  });

  it("useNewSession still starts fresh regardless of backend attribution", async () => {
    const { dispatch, calls } = makeStubDispatch();
    await runImplementPhase({
      ...base,
      useNewSession: true,
      previousRecord: { sessionID: "claude-uuid-1", backend: "claude" },
      _dispatchWithFallback: dispatch,
    });
    assert.equal(calls[0].session, undefined);
  });
});

// =========================================================================
// runImplementPhase — the round-to-round session hand-off (kusabi #320/#323)
// -------------------------------------------------------------------------
// The session runImplementPhase returns is the next round's carry, and the
// invariant is that it is a conversation round N's dispatch used or created.
// The phase reports the session its dispatch ACTUALLY used or created — the
// candidate it resumed for a resuming round, or the id the dispatch CREATED
// for a fresh round (`useNewSession`, or a dropped cross-backend candidate)
// — never the candidate it was told to walk away from.  The two coincide
// for a resuming round and differ exactly when the dispatch ran fresh;
// reporting the abandoned candidate in the fresh case was the kusabi #320
// defect, and the driver's clearing of the carry after useNewSession rounds
// (kusabi #320, chain-driver.mjs) was the compensation this change removes
// (kusabi #323): the seam now reports the truth, so there is nothing to
// clear.  These tests drive the phase directly, exactly as the driver calls
// it — round N's returned session/provenance ARE the next round's carry.
// =========================================================================

describe("runImplementPhase round-to-round session hand-off (kusabi #320/#323)", () => {
  // A realistic stub: a dispatch that RESUMES echoes the session it was
  // given (job.sessionID === opts.session), a dispatch that starts fresh
  // creates a new id (`idPrefix` + round).  Every backend stamps the job
  // with the session it actually used or created.
  function makeStubDispatch({ idPrefix = "claude-uuid-", jobOverrides = {} } = {}) {
    const calls = [];
    const dispatch = async (opts) => {
      calls.push(opts);
      return {
        job: {
          id: "job-imp-" + (opts.round ?? 1), status: "completed", modelEntry: "opus",
          modelVariant: null, fallbacks: null,
          sessionID: opts.session ?? (idPrefix + (opts.round ?? 1)),
          usage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
          error: null,
          ...jobOverrides,
        },
        resultText: "implemented",
      };
    };
    return { dispatch, calls };
  }

  const base = {
    cwd: "/tmp", chainId: "chain-test", round: 2, isFirstRound: false,
    implementText: "brief", modelChain: [["opus"]], tierIndex: 0,
    useNewSession: false, session: undefined, sessionProvenance: null,
    previousRecord: null, resumeMethod: { type: "continue_session", detail: "" },
    flagsModel: null, backend: "claude",
  };

  it("after a useNewSession round the phase reports the session the fresh round CREATED — never the abandoned one — and that carry IS the next round's session", async () => {
    // Round N: the strategist set newSession.  The dispatch runs fresh and
    // creates "claude-uuid-2".  The phase reports THAT session (kusabi #323
    // seam) — not the candidate ("claude-uuid-1") it was told to walk away
    // from — so the driver no longer needs to clear the carry.
    const first = makeStubDispatch();
    const roundN = await runImplementPhase({
      ...base,
      useNewSession: true,
      session: "claude-uuid-1",
      sessionProvenance: "claude",
      previousRecord: { sessionID: "claude-uuid-1", backend: "claude" },
      _dispatchWithFallback: first.dispatch,
    });
    assert.equal(first.calls[0].session, undefined, "round N dispatches fresh as asked");
    assert.equal(roundN.session, "claude-uuid-2", "the report is the session the dispatch CREATED");
    assert.equal(roundN.sessionProvenance, "claude", "the created session is owned by the backend that created it");
    assert.equal(roundN.roundRecord.sessionID, "claude-uuid-2", "the record agrees with the report");

    // Round N+1, exactly as the driver feeds it today (no clearing — the
    // carry is round N's reported session): previousRecord = round N's record.
    const second = makeStubDispatch();
    await runImplementPhase({
      ...base,
      round: 3,
      useNewSession: false,
      session: roundN.session,
      sessionProvenance: roundN.sessionProvenance,
      previousRecord: { ...roundN.roundRecord, backend: "claude" },
      _dispatchWithFallback: second.dispatch,
    });
    assert.equal(second.calls[0].session, "claude-uuid-2",
      "round N+1 continues the conversation round N CREATED — the carry, not a re-derivation");
    assert.notEqual(second.calls[0].session, "claude-uuid-1",
      "the abandoned conversation is never resumed");
    assert.equal(second.calls[0].sessionProvenance, "claude");
  });

  it("the seam reports the session the dispatch created for a fresh round — never the candidate it was told to abandon (kusabi #323)", async () => {
    // The minimal form of the kusabi #323 contract: when the dispatch runs
    // fresh, the returned session is the id the dispatch CREATED, not the
    // candidate it was told to walk away from.  This assertion is the one
    // that fails when the seam's new reporting behaviour is removed (the
    // old seam reported `resolvedSession` — the candidate — instead).
    const { dispatch, calls } = makeStubDispatch();
    const result = await runImplementPhase({
      ...base,
      useNewSession: true,
      session: "claude-uuid-1",
      sessionProvenance: "claude",
      previousRecord: { sessionID: "claude-uuid-1", backend: "claude" },
      _dispatchWithFallback: dispatch,
    });
    assert.equal(calls[0].session, undefined, "the dispatch runs fresh");
    assert.equal(result.session, "claude-uuid-2", "the report is the session the dispatch CREATED");
    assert.notEqual(result.session, "claude-uuid-1", "never the abandoned candidate");
    assert.equal(result.sessionProvenance, "claude", "the created session's owner is the backend that created it");
  });

  it("a normally resuming round is unaffected: same session in, same session out, same dispatch arguments", async () => {
    const { dispatch, calls } = makeStubDispatch();
    const result = await runImplementPhase({
      ...base,
      useNewSession: false,
      session: "claude-uuid-1",
      sessionProvenance: "claude",
      previousRecord: { sessionID: "claude-uuid-1", backend: "claude" },
      _dispatchWithFallback: dispatch,
    });
    assert.equal(calls[0].session, "claude-uuid-1", "dispatch arguments unchanged");
    assert.equal(calls[0].sessionProvenance, "claude");
    assert.equal(result.session, "claude-uuid-1", "same session in, same session out");
    assert.equal(result.sessionProvenance, "claude");
    // For a resuming round the reported session IS the session it used —
    // nothing to clear (kusabi #323 removed the driver's clearing), nothing
    // to re-derive.
    assert.equal(result.roundRecord.sessionID, "claude-uuid-1");
  });

  it("a dropped cross-backend candidate never reaches a dispatch, and the phase reports the session THIS backend created", async () => {
    // The driver drops a foreign session before the phase (session: null);
    // the phase resolves nothing (the record fallback refuses the foreign
    // backend) and dispatches fresh — creating "claude-uuid-2".  The phase
    // reports THAT — never the foreign id, and never a null.
    const first = makeStubDispatch();
    const roundN = await runImplementPhase({
      ...base,
      useNewSession: false,
      session: null,
      sessionProvenance: null,
      previousRecord: { sessionID: "ses_opencode_1", backend: "opencode" },
      _dispatchWithFallback: first.dispatch,
    });
    assert.ok(first.calls[0].session == null, "the foreign session never reaches the dispatch");
    assert.equal(roundN.session, "claude-uuid-2", "the report is the session this round's dispatch CREATED");
    assert.equal(roundN.sessionProvenance, "claude");
    assert.equal(roundN.roundRecord.sessionID, "claude-uuid-2", "the record agrees with the report");

    // Round N+1 on the same backend: the carry (and the record fallback —
    // they agree) is the session THIS round created — never the foreign one.
    const second = makeStubDispatch();
    await runImplementPhase({
      ...base, round: 3,
      useNewSession: false,
      session: roundN.session,
      sessionProvenance: roundN.sessionProvenance,
      previousRecord: { ...roundN.roundRecord, backend: "claude" },
      _dispatchWithFallback: second.dispatch,
    });
    assert.equal(second.calls[0].session, "claude-uuid-2");
    assert.equal(second.calls[0].sessionProvenance, "claude");
  });

  it("a fresh dispatch whose job died before any session id was observed resumes nothing", async () => {
    // The claude/agy failure shape: sessionID null by construction until the
    // CLI reports one.  Round N dispatches fresh (useNewSession) and the job
    // dies before any id was observed: there is no session to report, the
    // record carries no sessionID, and round N+1 starts fresh — a dead fresh
    // round resumes nothing, by construction.
    const first = makeStubDispatch({
      jobOverrides: { status: "provider-error", sessionID: null },
    });
    const roundN = await runImplementPhase({
      ...base,
      useNewSession: true,
      session: "claude-uuid-1",
      sessionProvenance: "claude",
      previousRecord: { sessionID: "claude-uuid-1", backend: "claude" },
      _dispatchWithFallback: first.dispatch,
    });
    assert.equal(first.calls[0].session, undefined, "round N dispatched fresh as asked");
    assert.equal(roundN.session, null, "no session was created, so none is reported");
    assert.equal(roundN.sessionProvenance, null);
    assert.equal(roundN.roundRecord.sessionID, null, "no session id was ever observed");

    // Round N+1 with the null carry: the record has no sessionID to fall
    // back to, so the dispatch runs fresh — the abandoned candidate never
    // surfaces.
    const second = makeStubDispatch();
    await runImplementPhase({
      ...base, round: 3,
      useNewSession: false,
      session: roundN.session,
      sessionProvenance: roundN.sessionProvenance,
      previousRecord: { ...roundN.roundRecord, backend: "claude" },
      _dispatchWithFallback: second.dispatch,
    });
    assert.equal(second.calls[0].session, null, "round N+1 starts fresh");
  });

  it("agy: the reported pair keeps the fail-closed gate satisfiable across a fresh round's hand-off", async () => {
    // Resume: same pair in and out, so the next agy dispatch sees a proven
    // session (assertNoAgySession).
    const resume = makeStubDispatch({ idPrefix: "agy-conv-" });
    const resumed = await runImplementPhase({
      ...base, backend: "agy",
      useNewSession: false,
      session: "agy-conv-1",
      sessionProvenance: "agy",
      previousRecord: { sessionID: "agy-conv-1", backend: "agy" },
      _dispatchWithFallback: resume.dispatch,
    });
    assert.equal(resume.calls[0].session, "agy-conv-1");
    assert.equal(resume.calls[0].sessionProvenance, "agy", "the proof assertNoAgySession demands");
    assert.equal(resumed.session, "agy-conv-1");
    assert.equal(resumed.sessionProvenance, "agy");

    // Fresh round (useNewSession): the dispatch creates "agy-conv-2", and the
    // phase reports it with agy provenance — the carry the next round hands
    // to the agy dispatch is proven without any re-derivation.
    const fresh = makeStubDispatch({ idPrefix: "agy-conv-" });
    const roundN = await runImplementPhase({
      ...base, backend: "agy",
      useNewSession: true,
      session: "agy-conv-1",
      sessionProvenance: "agy",
      previousRecord: { sessionID: "agy-conv-1", backend: "agy" },
      _dispatchWithFallback: fresh.dispatch,
    });
    assert.equal(fresh.calls[0].session, undefined);
    assert.equal(roundN.session, "agy-conv-2", "the report is the conversation the fresh dispatch created");
    assert.equal(roundN.sessionProvenance, "agy");
    assert.equal(roundN.roundRecord.sessionID, "agy-conv-2");

    const next = makeStubDispatch({ idPrefix: "agy-conv-" });
    await runImplementPhase({
      ...base, backend: "agy", round: 3,
      useNewSession: false,
      session: roundN.session,
      sessionProvenance: roundN.sessionProvenance,
      previousRecord: { ...roundN.roundRecord, backend: "agy" },
      _dispatchWithFallback: next.dispatch,
    });
    assert.equal(next.calls[0].session, "agy-conv-2");
    assert.equal(next.calls[0].sessionProvenance, "agy",
      "provenance carried from the fresh round (and re-derivable from the record) — assertNoAgySession would pass");
  });
});

// =========================================================================
// runImplementPhase carry prefers the OBSERVED session id on BOTH branches
// (kusabi #324).  Measured 2026-08-21: a real agy record (chain-msxhipgq1cef
// round 2, continue_session) was told to resume `a784b853-…` but the job
// stamped `2a177486-…`, so the candidate and the observed id CAN diverge.
// The phase must hand round N+1 the id round N's dispatch actually used or
// created -- never the told candidate when an observed id exists -- and keep
// the candidate only as the dead-round fallback for a resuming round whose
// job died id-less.  These re-use the same stub contract as the block above.
// =========================================================================

describe("runImplementPhase carry prefers the observed session id (kusabi #324)", () => {
  // Same realistic stub as the #320/#323 block: a resuming dispatch echoes
  // the session it was given (job.sessionID === opts.session) unless a
  // jobOverrides.sessionID forces the job to record a DIFFERENT id -- the
  // divergence agy exhibits in the wild.
  function makeStubDispatch({ idPrefix = "claude-uuid-", jobOverrides = {} } = {}) {
    const calls = [];
    const dispatch = async (opts) => {
      calls.push(opts);
      return {
        job: {
          id: "job-imp-" + (opts.round ?? 1), status: "completed", modelEntry: "opus",
          modelVariant: null, fallbacks: null,
          sessionID: opts.session ?? (idPrefix + (opts.round ?? 1)),
          usage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
          error: null,
          ...jobOverrides,
        },
        resultText: "implemented",
      };
    };
    return { dispatch, calls };
  }

  const base = {
    cwd: "/tmp", chainId: "chain-test", round: 2, isFirstRound: false,
    implementText: "brief", modelChain: [["opus"]], tierIndex: 0,
    useNewSession: false, session: undefined, sessionProvenance: null,
    previousRecord: null, resumeMethod: { type: "continue_session", detail: "" },
    flagsModel: null, backend: "agy",
  };

  it("a resuming round whose job observed a DIFFERENT id reports the observed id, not the candidate (kusabi #324)", async () => {
    // Round N was told to resume `agy-candidate-a784b853`, but agy mints a
    // new conversation id on resume and the job stamps `agy-observed-2a177486`.
    // The dispatch GOT the candidate; the job RECORDED the observed id.  The
    // carry handed to round N+1 must be the observed id, byte for byte.
    const { dispatch, calls } = makeStubDispatch({
      jobOverrides: { sessionID: "agy-observed-2a177486" },
    });
    const roundN = await runImplementPhase({
      ...base,
      useNewSession: false,
      session: "agy-candidate-a784b853",
      sessionProvenance: "agy",
      previousRecord: { sessionID: "agy-candidate-a784b853", backend: "agy" },
      _dispatchWithFallback: dispatch,
    });
    assert.equal(calls[0].session, "agy-candidate-a784b853",
      "round N's dispatch resumed the candidate it was told to");
    assert.equal(calls[0].sessionProvenance, "agy");
    assert.equal(roundN.session, "agy-observed-2a177486",
      "the carry is the OBSERVED id, not the candidate (kusabi #324)");
    assert.notEqual(roundN.session, "agy-candidate-a784b853",
      "the candidate is never the carry when an observed id exists");
    assert.equal(roundN.sessionProvenance, "agy",
      "the observed id's owner is the backend this round dispatched on");
    assert.equal(roundN.roundRecord.sessionID, "agy-observed-2a177486",
      "the record agrees with the report");
  });

  it("a resuming round whose job died id-less falls back to the candidate carry with its resolved provenance (kusabi #324)", async () => {
    // Round N was told to resume `agy-candidate-a784b853` but the job died
    // before any id was observed (`job.sessionID` null).  The carry is the
    // candidate -- the next round still has a conversation worth trying --
    // and its provenance is the resolved one.  The record's sessionID is
    // null: this is the one remaining divergence between record and carry.
    const { dispatch, calls } = makeStubDispatch({
      jobOverrides: { status: "provider-error", sessionID: null },
    });
    const roundN = await runImplementPhase({
      ...base,
      useNewSession: false,
      session: "agy-candidate-a784b853",
      sessionProvenance: "agy",
      previousRecord: { sessionID: "agy-candidate-a784b853", backend: "agy" },
      _dispatchWithFallback: dispatch,
    });
    assert.equal(calls[0].session, "agy-candidate-a784b853",
      "round N's dispatch resumed the candidate it was told to");
    assert.equal(roundN.session, "agy-candidate-a784b853",
      "the dead job's carry is the candidate fallback");
    assert.equal(roundN.sessionProvenance, "agy",
      "the fallback's owner is the resolved provenance");
    assert.equal(roundN.roundRecord.sessionID, null,
      "the record's sessionID is null -- the only divergence from the report");
  });

  it("a fresh round still reports the created id (kusabi #320/#323 semantics intact under #324)", async () => {
    // Regression guard: the #324 change must NOT alter the fresh-round
    // contract.  Round N runs fresh and creates `agy-conv-2`; the phase
    // reports THAT, never the abandoned candidate, and round N+1 continues it.
    const first = makeStubDispatch({ idPrefix: "agy-conv-" });
    const roundN = await runImplementPhase({
      ...base,
      useNewSession: true,
      session: "agy-conv-1",
      sessionProvenance: "agy",
      previousRecord: { sessionID: "agy-conv-1", backend: "agy" },
      _dispatchWithFallback: first.dispatch,
    });
    assert.equal(first.calls[0].session, undefined, "round N dispatches fresh as asked");
    assert.equal(roundN.session, "agy-conv-2", "the report is the session the dispatch CREATED");
    assert.equal(roundN.sessionProvenance, "agy");
    assert.equal(roundN.roundRecord.sessionID, "agy-conv-2");

    const second = makeStubDispatch({ idPrefix: "agy-conv-" });
    await runImplementPhase({
      ...base, round: 3,
      useNewSession: false,
      session: roundN.session,
      sessionProvenance: roundN.sessionProvenance,
      previousRecord: { ...roundN.roundRecord, backend: "agy" },
      _dispatchWithFallback: second.dispatch,
    });
    assert.equal(second.calls[0].session, "agy-conv-2",
      "round N+1 continues the conversation round N CREATED");
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


// P5 / P6 — the deterministic oracle probes (kusabi #197)
// ---------------------------------------------------------------------------

describe("runProbePhase — P5/P6 wiring (kusabi #197)", () => {
  // No worktree baseline is passed, so P3's newlyChangedPaths is null and the
  // fallback rule applies: P5 sees the full `git status --porcelain` set.
  function oracleCallTool({ status = "", verifyResults } = {}) {
    const results = verifyResults ?? [
      { gate_passed: true, lint: [], types: [], tests: { full: { status: "ok", passed: 10, total: 10 } } },
    ];
    const verifyCalls = [];
    const fn = async (toolName, params) => {
      if (toolName === "verify_in_container") {
        verifyCalls.push(params);
        return results[Math.min(verifyCalls.length - 1, results.length - 1)];
      }
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
      if (cmd.includes("change-scope.mjs")) {
        return {
          output: JSON.stringify({
            formatVersion: 1,
            repositoryRoot: "/workspace",
            input: { base: "abc1234", head: "HEAD" },
            resolved: { baseSha: "abc1234", headSha: "abc1234", mergeBaseSha: "abc1234" },
            paths: { committed: [], staged: [], unstaged: [], untracked: [] },
          }),
        };
      }
      if (cmd === "git status --porcelain") return { output: status };
      return { output: "" };
    };
    fn.verifyCalls = verifyCalls;
    return fn;
  }

  const GREEN_BASELINE = { captured: true, gate_passed: true, lint: 0, types: 0, collected: 10, raw: {} };

  it("appends P5 and P6 after P4, in order", async () => {
    const callTool = oracleCallTool({ status: " M src/a.js\n" });
    const result = await runProbePhase({
      baseSha: "abc1234", container: "cid",
      brief: "## Deliverables\n\n- `src/a.js`\n",
      callTool, verifyBaseline: GREEN_BASELINE,
    });
    assert.deepEqual(
      result.probeResults.map((p) => p.probe),
      ["P1: HEAD clean", "P2: verify gate", "P3: deliverables", "P4: smoke", "P5: frozen", "P6: collected"],
    );
  });

  it("a brief with no `## Frozen Tests` section keeps the round green and the marker false", async () => {
    const callTool = oracleCallTool({ status: " M src/a.js\n" });
    const result = await runProbePhase({
      baseSha: "abc1234", container: "cid",
      brief: "## Deliverables\n\n- `src/a.js`\n",
      callTool, verifyBaseline: GREEN_BASELINE,
    });
    const p5 = result.probeResults.find((p) => p.probe === "P5: frozen");
    assert.equal(p5.passed, true);
    assert.equal(p5.detail, "no Frozen Tests declared; check skipped");
    assert.equal(result.probesGreen, true);
    assert.equal(result.oracleViolation, false);
  });

  it("a change set touching a frozen path fails P5 and raises the oracle marker naming it", async () => {
    const callTool = oracleCallTool({ status: " M src/a.js\n M tests/frozen.test.mjs\n" });
    const result = await runProbePhase({
      baseSha: "abc1234", container: "cid",
      brief: [
        "## Deliverables",
        "",
        "- `src/a.js`",
        "",
        "## Frozen Tests (do not touch)",
        "",
        "- `tests/frozen.test.mjs`",
        "",
      ].join("\n"),
      callTool, verifyBaseline: GREEN_BASELINE,
    });
    const p5 = result.probeResults.find((p) => p.probe === "P5: frozen");
    assert.equal(p5.passed, false);
    assert.match(p5.detail, /tests\/frozen\.test\.mjs/);
    assert.equal(result.probesGreen, false);
    assert.match(result.oracleViolation, /P5: frozen/);
    assert.match(result.oracleViolation, /tests\/frozen\.test\.mjs/);
  });

  it("a round that runs fewer tests than the baseline fails P6 and raises the marker", async () => {
    const callTool = oracleCallTool({
      status: " M src/a.js\n",
      verifyResults: [
        { gate_passed: true, lint: [], types: [], tests: { full: { status: "ok", passed: 334, total: 334 } } },
      ],
    });
    const result = await runProbePhase({
      baseSha: "abc1234", container: "cid",
      brief: "## Deliverables\n\n- `src/a.js`\n",
      callTool,
      verifyBaseline: { captured: true, gate_passed: true, lint: 0, types: 0, collected: 607, raw: {} },
    });
    const p6 = result.probeResults.find((p) => p.probe === "P6: collected");
    assert.equal(p6.passed, false);
    assert.equal(p6.detail, "collected 334 < baseline 607");
    assert.equal(result.probesGreen, false);
    assert.match(result.oracleViolation, /P6: collected: collected 334 < baseline 607/);
  });

  it("issues no second verify_in_container call for P6", async () => {
    // P2 already ran verify this round; P6 reuses that run's result.  The call
    // log is the assertion — a re-run would double the round's most expensive
    // container call.
    const callTool = oracleCallTool({ status: " M src/a.js\n" });
    await runProbePhase({
      baseSha: "abc1234", container: "cid",
      brief: "## Deliverables\n\n- `src/a.js`\n",
      callTool, verifyBaseline: GREEN_BASELINE,
    });
    assert.equal(callTool.verifyCalls.length, 1, "exactly one verify per round: P2's");
  });

  it("P6 passes and states the limitation when the baseline carries no count", async () => {
    const callTool = oracleCallTool({ status: " M src/a.js\n" });
    const result = await runProbePhase({
      baseSha: "abc1234", container: "cid",
      brief: "## Deliverables\n\n- `src/a.js`\n",
      callTool,
      // An old chain.json, recorded before the collected count existed.
      verifyBaseline: { captured: true, gate_passed: true, lint: 0, types: 0, raw: {} },
    });
    const p6 = result.probeResults.find((p) => p.probe === "P6: collected");
    assert.equal(p6.passed, true);
    assert.match(p6.detail, /collected count unavailable \(baseline unavailable, round 10\)/);
    assert.equal(result.probesGreen, true);
    assert.equal(result.oracleViolation, false);
  });

  it("a `## Frozen Tests` heading with zero parsable entries fails P5 without raising the marker", async () => {
    const callTool = oracleCallTool({ status: " M src/a.js\n" });
    const result = await runProbePhase({
      baseSha: "abc1234", container: "cid",
      brief: "## Deliverables\n\n- `src/a.js`\n\n## Frozen Tests\n\nnothing parseable here\n",
      callTool, verifyBaseline: GREEN_BASELINE,
    });
    const p5 = result.probeResults.find((p) => p.probe === "P5: frozen");
    assert.equal(p5.passed, false);
    assert.match(p5.detail, /heading present but no entries parsed/);
    assert.equal(result.probesGreen, false);
    assert.equal(result.oracleViolation, false, "a brief-syntax defect is not a violation of the oracle");
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

  it("runProbePhase issues change-scope before git reset --mixed and resets when HEAD != base", async () => {
    const executed = [];
    const callTool = async (toolName, params) => {
      if (toolName === "verify_in_container") {
        return { gate_passed: true, lint: [], types: [], tests: { full: { status: "ok", passed: 10, total: 10 } } };
      }
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
      executed.push({ cmd, argv: params.argv, commands: params.commands });
      if (cmd.includes("change-scope.mjs")) {
        return { output: JSON.stringify(FIXTURE_CHANGE_SCOPE) };
      }
      if (cmd === "git rev-parse HEAD") {
        return { output: "head-sha-456\n" }; // HEAD != baseSha ("base-sha-123")
      }
      if (cmd.startsWith("git reset --mixed")) {
        return { output: "Unstaged changes after reset:\n" };
      }
      if (cmd === "git status --porcelain") {
        return { output: " M src/unstaged.js\n" };
      }
      return { output: "" };
    };

    const result = await runProbePhase({
      baseSha: "base-sha-123",
      container: "cid-probe-order",
      brief: "## Deliverables\n\n- `src/unstaged.js`\n",
      callTool,
      verifyBaseline: { captured: true, gate_passed: true, lint: 0, types: 0, collected: 10, raw: {} },
    });

    // 1. Assert change-scope was executed with argv and BEFORE git reset --mixed
    const changeScopeIdx = executed.findIndex((e) => e.cmd.includes("change-scope.mjs"));
    const resetIdx = executed.findIndex((e) => e.cmd.startsWith("git reset --mixed"));
    assert.ok(changeScopeIdx >= 0, "change-scope must be invoked");
    assert.ok(executed[changeScopeIdx].argv, "change-scope must be invoked with argv");
    assert.equal(executed[changeScopeIdx].commands, undefined, "change-scope must not pass commands when argv is provided");
    assert.deepEqual(executed[changeScopeIdx].argv, ["node", "/tmp/kusabi-change-scope.mjs", "--base", "base-sha-123", "--head", "HEAD"]);
    assert.ok(resetIdx >= 0, "git reset --mixed must be invoked when HEAD != base");
    assert.ok(changeScopeIdx < resetIdx, "change-scope must run before git reset --mixed");

    // 2. Assert changeScope is returned on probeResult
    assert.deepEqual(result.changeScope, FIXTURE_CHANGE_SCOPE);

    // 3. Assert P1 still ran and passed with auto-reset detail
    const p1 = result.probeResults.find((p) => p.probe === "P1: HEAD clean");
    assert.ok(p1 && p1.passed);
    assert.match(p1.detail, /auto reset - reset OK/);
  });

  it("change-scope non-zero exit fails closed in runProbePhase (probes fail, no review range)", async () => {
    const callTool = async (toolName, params) => {
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
      if (cmd.includes("change-scope.mjs")) {
        return { exit_code: 1, stderr: "change-scope: base ref not found\n", output: "change-scope: base ref not found\n" };
      }
      return { output: "" };
    };

    const result = await runProbePhase({
      baseSha: "bad-base",
      container: "cid-fail-closed",
      brief: "## Deliverables\n\n- `src/foo.js`\n",
      callTool,
    });

    // Fails closed: probesGreen is false, failed probe recorded
    assert.equal(result.probesGreen, false);
    assert.equal(result.changeScope, null);
    const rpcProbe = result.probeResults.find((p) => p.passed === false);
    assert.ok(rpcProbe, "must record failed probe");
    assert.match(rpcProbe.detail, /change-scope failed with exit code 1/);
  });

  it("change-scope empty stdout fails closed in runProbePhase (probes fail, no review range)", async () => {
    const callTool = async (toolName, params) => {
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
      if (cmd.includes("change-scope.mjs")) {
        return { output: "" };
      }
      return { output: "" };
    };

    const result = await runProbePhase({
      baseSha: "empty-base",
      container: "cid-fail-empty",
      brief: "## Deliverables\n\n- `src/foo.js`\n",
      callTool,
    });

    assert.equal(result.probesGreen, false);
    assert.equal(result.changeScope, null);
    const rpcProbe = result.probeResults.find((p) => p.passed === false);
    assert.ok(rpcProbe, "must record failed probe");
    assert.match(rpcProbe.detail, /change-scope produced empty output/);
  });

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

  it("change-scope inject failure in runProbePhase fails closed without fallback exec", async () => {
    const executed = [];
    const callTool = async (toolName, params) => {
      if (toolName === "copy_file") {
        throw new Error("copy_file failed: connection refused");
      }
      const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
      executed.push({ toolName, cmd, params });
      return { output: "" };
    };

    const result = await runProbePhase({
      baseSha: "base-sha-123",
      container: "cid-fail-inject-probe",
      brief: "## Deliverables\n\n- `src/foo.js`\n",
      callTool,
    });

    assert.equal(result.probesGreen, false);
    assert.equal(result.changeScope, null);
    const rpcProbe = result.probeResults.find((p) => p.passed === false);
    assert.ok(rpcProbe, "must record failed probe");
    assert.match(rpcProbe.detail, /change-scope inject failed in container cid-fail-inject-probe/);
    assert.ok(
      !executed.some((e) => e.cmd.includes("plugins/kusabi/scripts/change-scope.mjs")),
      "must not exec old relative path as a fallback",
    );
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




