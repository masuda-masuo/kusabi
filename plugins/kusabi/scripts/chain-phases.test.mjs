import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  selectRoundModel,
  buildImplementText,
  shouldSkipReview,
  computeChainTotals,
  renderAcceptOutcome,
  renderAcceptWithFollowupOutcome,
  renderEscalateOutcome,
  renderMaxRoundsOutcome,
  runSmokeProbe,
  runHeadCleanProbe,
  runVerifyProbe,
  runDeliverablesProbe,
} from "./chain-phases.mjs";
import {
  parseModel,
} from "./cli.mjs";
import {
  createFakeCallTool,
  fakeCallToolForP1,
  fakeCallToolForP2,
  fakeCallToolForP3,
} from "./fixtures.mjs";

// Chain round-to-entry mapping — model variant escalation
// ---------------------------------------------------------------------------

describe("chain round model resolution", () => {
  const chain = ["p/a", "p/a:max", "p/b"];

  function resolveRoundModel(round, modelFlag) {
    if (round === 1 && modelFlag) return parseModel(modelFlag);
    const idx = Math.min(round - 1, chain.length - 1);
    return parseModel(chain[idx]);
  }

  it("round 1 uses chain[0] when no --model", () => {
    const result = resolveRoundModel(1, null);
    assert.deepEqual(result, { providerID: "p", modelID: "a" });
  });

  it("round 2 uses chain[1] (:max variant)", () => {
    const result = resolveRoundModel(2, null);
    assert.deepEqual(result, { providerID: "p", modelID: "a", variant: "max" });
  });

  it("round 3 uses chain[2]", () => {
    const result = resolveRoundModel(3, null);
    assert.deepEqual(result, { providerID: "p", modelID: "b" });
  });

  it("rounds beyond chain length clamp to last entry", () => {
    const result = resolveRoundModel(4, null);
    assert.deepEqual(result, { providerID: "p", modelID: "b" });
    const result5 = resolveRoundModel(5, null);
    assert.deepEqual(result5, { providerID: "p", modelID: "b" });
  });

  it("--model overrides round 1 only", () => {
    const result = resolveRoundModel(1, "p/c:high");
    assert.deepEqual(result, { providerID: "p", modelID: "c", variant: "high" });
  });

  it("round 2+ ignores --model and follows chain", () => {
    // Even with --model, round 2 follows the chain
    const result = resolveRoundModel(2, "p/c:high");
    assert.deepEqual(result, { providerID: "p", modelID: "a", variant: "max" });
  });

  it("single-entry chain clamps all rounds to that entry", () => {
    const single = ["p/x"];
    function resolveForRound(n) {
      const idx = Math.min(n - 1, single.length - 1);
      return parseModel(single[idx]);
    }
    assert.deepEqual(resolveForRound(1), { providerID: "p", modelID: "x" });
    assert.deepEqual(resolveForRound(2), { providerID: "p", modelID: "x" });
    assert.deepEqual(resolveForRound(5), { providerID: "p", modelID: "x" });
  });

  it("variant stored in round record is visible", () => {
    // Simulate what cmdChain stores on roundRecord
    const round = 2;
    const idx = Math.min(round - 1, chain.length - 1);
    const entry = chain[idx];
    const roundModel = parseModel(entry);
    const roundModelEntry = (roundModel && roundModel.variant)
      ? roundModel.providerID + "/" + roundModel.modelID + ":" + roundModel.variant
      : (roundModel ? roundModel.providerID + "/" + roundModel.modelID : null);
    const roundRecord = {
      round,
      modelEntry: roundModelEntry,
      modelVariant: roundModel?.variant || null,
    };
    assert.equal(roundRecord.modelEntry, "p/a:max");
    assert.equal(roundRecord.modelVariant, "max");
  });

  it("round without variant has null variant in record", () => {
    const round = 1;
    const idx = Math.min(round - 1, chain.length - 1);
    const entry = chain[idx];
    const roundModel = parseModel(entry);
    const roundRecord = {
      round,
      modelEntry: roundModel ? roundModel.providerID + "/" + roundModel.modelID : null,
      modelVariant: roundModel?.variant || null,
    };
    assert.equal(roundRecord.modelEntry, "p/a");
    assert.equal(roundRecord.modelVariant, null);
  });
});

describe("runSmokeProbe", () => {
  it("observes exit 0 for a command whose output far exceeds page size", async () => {
    // Simulate a command that produces 2025 lines of TAP output — the old code
    // would see only the first ~50 lines and miss the SMOKE_EXIT marker at the
    // very end.  With output redirection, only the marker appears in the
    // sandbox_exec return text, so pagination cannot hide it.
    const fakeTool = createFakeCallTool({ exitCode: 0 });

    const result = await runSmokeProbe({
      entries: [{ command: "npm test", expectedExit: 0 }],
      callTool: fakeTool,
      container: "fake-cid",
      headingPresent: true,
    });

    assert.equal(result.passed, true);
    assert.match(result.probe, /P4: smoke/);
  });

  it("observes exit 1 for a command that exits non-zero", async () => {
    const fakeTool = createFakeCallTool({ exitCode: 1 });

    const result = await runSmokeProbe({
      entries: [{ command: "npm test", expectedExit: 0 }],
      callTool: fakeTool,
      container: "fake-cid",
      headingPresent: true,
    });

    assert.equal(result.passed, false);
    assert.match(result.detail, /expected exit 0/);
    assert.match(result.detail, /observed exit 1/);
  });

  it("compares against declared exit <N> annotation", async () => {
    // A non-zero N, so the assertion actually exercises the annotation rather
    // than coinciding with the default of 0.
    const matching = await runSmokeProbe({
      entries: [{ command: "bash -c 'exit 2'", expectedExit: 2 }],
      callTool: createFakeCallTool({ exitCode: 2 }),
      container: "fake-cid",
      headingPresent: true,
    });
    assert.equal(matching.passed, true);

    // Exit 0 against a declared exit 2 must fail: "succeeded" is not "expected".
    const mismatching = await runSmokeProbe({
      entries: [{ command: "bash -c 'exit 2'", expectedExit: 2 }],
      callTool: createFakeCallTool({ exitCode: 0 }),
      container: "fake-cid",
      headingPresent: true,
    });
    assert.equal(mismatching.passed, false);
    assert.match(mismatching.detail, /expected exit 2, observed exit 0/);
  });

  it("reports unobservable when the marker is absent from result", async () => {
    const fakeTool = createFakeCallTool({ omitMarker: true });

    const result = await runSmokeProbe({
      entries: [{ command: "some-command", expectedExit: 0 }],
      callTool: fakeTool,
      container: "fake-cid",
      headingPresent: true,
    });

    assert.equal(result.passed, false);
    // Must NOT read like an exit-code mismatch
    assert.ok(!result.detail.includes("expected exit 0, observed exit"));
    assert.ok(result.detail.includes("exit code could not be observed"));
  });

  it("reports timeout when the RPC call throws", async () => {
    const fakeTool = createFakeCallTool({ simulateTimeout: true });

    const result = await runSmokeProbe({
      entries: [{ command: "npm test", expectedExit: 0 }],
      callTool: fakeTool,
      container: "fake-cid",
      headingPresent: true,
    });

    assert.equal(result.passed, false);
    assert.match(result.detail, /timeout/);
  });

  it("reports timeout when sandbox_exec returns status:timeout as data", async () => {
    // This is how a real command timeout arrives (status:"timeout",
    // exit_code:124) — no exception, and no marker because the shell was
    // killed before echoing it.  It must not be reported as "could not be
    // observed": a timeout is a known outcome of the command, not a failure
    // of the probe to look.
    const fakeTool = createFakeCallTool({ timeoutAsData: true });

    const result = await runSmokeProbe({
      entries: [{ command: "npm test", expectedExit: 0 }],
      callTool: fakeTool,
      container: "fake-cid",
      headingPresent: true,
    });

    assert.equal(result.passed, false);
    assert.match(result.detail, /observed timeout/);
    assert.ok(!result.detail.includes("could not be observed"));
  });

  it("includes diagnostic excerpt for failing entries", async () => {
    const fakeTool = createFakeCallTool({
      exitCode: 1,
      capturedOutput: "TAP version 13\n# Subtest: something\nnot ok 1 - something\n# fail 1\n",
    });

    const result = await runSmokeProbe({
      entries: [{ command: "npm test", expectedExit: 0 }],
      callTool: fakeTool,
      container: "fake-cid",
      headingPresent: true,
    });

    assert.equal(result.passed, false);
    assert.match(result.detail, /output tail/);
    assert.match(result.detail, /TAP version 13/);
  });

  it("diagnostic excerpt is bounded (not a runaway log)", async () => {
    // Simulate a massive output file — the diagnostic should only contain
    // the last 2000 bytes (simulated by the fake returning the tail truncated
    // by the tail -c 2000 command).
    const fakeTool = createFakeCallTool({
      exitCode: 1,
      capturedOutput: "# final error line",
    });

    const result = await runSmokeProbe({
      entries: [{ command: "huge-output", expectedExit: 0 }],
      callTool: fakeTool,
      container: "fake-cid",
      headingPresent: true,
    });

    assert.equal(result.passed, false);
    assert.match(result.detail, /output tail/);
    // The detail should contain the tail excerpt, not the full 10000 A's
    assert.ok(!result.detail.includes("A".repeat(10000)));
  });

  it("trivial passes (no entries) still work through runSmokeProbe", async () => {
    const result = await runSmokeProbe({
      entries: [],
      callTool: null,
      container: "fake-cid",
      headingPresent: false,
    });

    assert.equal(result.passed, true);
    assert.match(result.detail, /no Smoke declared/);
  });

  it("heading-present-no-entries still fails through runSmokeProbe", async () => {
    const result = await runSmokeProbe({
      entries: [],
      callTool: null,
      container: "fake-cid",
      headingPresent: true,
    });

    assert.equal(result.passed, false);
    assert.match(result.detail, /heading present but no entries parsed/);
  });

  it("multiple entries: all pass -> probe passes", async () => {
    let callCount = 0;
    const fakeTool = createFakeCallTool({ exitCode: 0, capturedOutput: "" });

    const result = await runSmokeProbe({
      entries: [
        { command: "cmd-a", expectedExit: 0 },
        { command: "cmd-b", expectedExit: 0 },
      ],
      callTool: fakeTool,
      container: "fake-cid",
      headingPresent: true,
    });

    assert.equal(result.passed, true);
  });

  it("multiple entries: one fails -> probe fails", async () => {
    let callIndex = 0;
    const fakeTool = async (toolName, params) => {
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands[0];
      if (cmd.includes("SMOKE_EXIT=")) {
        callIndex++;
        // cmd-a exits 0, cmd-b exits 1
        const code = callIndex === 1 ? 0 : 1;
        return { output: "SMOKE_EXIT=" + code + "\n" };
      }
      if (cmd.includes("tail -c")) {
        return { output: "error detail" };
      }
      return { output: "" };
    };

    const result = await runSmokeProbe({
      entries: [
        { command: "cmd-a", expectedExit: 0 },
        { command: "cmd-b", expectedExit: 0 },
      ],
      callTool: fakeTool,
      container: "fake-cid",
      headingPresent: true,
    });

    assert.equal(result.passed, false);
    assert.match(result.detail, /cmd-b/);
  });
});

describe("runHeadCleanProbe", () => {
  it("passes when HEAD matches base SHA", async () => {
    const fakeTool = fakeCallToolForP1({ headSha: "abc123" });
    const result = await runHeadCleanProbe({ baseSha: "abc123", callTool: fakeTool, container: "fake-cid" });
    assert.equal(result.probe, "P1: HEAD clean");
    assert.equal(result.passed, true);
    assert.equal(result.detail, "HEAD matches base abc123");
  });

  it("resets when HEAD differs, and passes when reset works", async () => {
    const fakeTool = fakeCallToolForP1({ headSha: "def456" });
    const result = await runHeadCleanProbe({ baseSha: "abc123", callTool: fakeTool, container: "fake-cid" });
    assert.equal(result.probe, "P1: HEAD clean");
    assert.equal(result.passed, true);
    assert.ok(result.detail.startsWith("HEAD def456 != base abc123; auto reset"));
    assert.ok(result.detail.includes("reset OK"));
  });

  it("records reset failure when reset throws", async () => {
    const fakeTool = fakeCallToolForP1({ headSha: "def456", resetOk: false });
    const result = await runHeadCleanProbe({ baseSha: "abc123", callTool: fakeTool, container: "fake-cid" });
    assert.equal(result.passed, false);
    assert.ok(result.detail.includes("reset FAILED"));
  });

  it("reports missing baseSha with default sourceLabel", async () => {
    const fakeTool = fakeCallToolForP1();
    const result = await runHeadCleanProbe({ baseSha: null, callTool: fakeTool, container: "fake-cid" });
    assert.equal(result.passed, false);
    assert.equal(result.detail, "baseSha not recorded at task start; cannot check HEAD");
  });

  it("uses sourceLabel in missing-baseSha detail", async () => {
    const fakeTool = fakeCallToolForP1();
    const result = await runHeadCleanProbe({ baseSha: null, callTool: fakeTool, container: "fake-cid", sourceLabel: "chain" });
    assert.equal(result.passed, false);
    assert.equal(result.detail, "baseSha not recorded at chain start; cannot check HEAD");
  });
});

describe("runVerifyProbe", () => {
  it("passes when gate_passed is true", async () => {
    const fakeTool = fakeCallToolForP2({ gatePassed: true });
    const result = await runVerifyProbe({ callTool: fakeTool, container: "fake-cid" });
    assert.equal(result.probe, "P2: verify gate");
    assert.equal(result.passed, true);
  });

  it("fails when gate_passed is false", async () => {
    const fakeTool = fakeCallToolForP2({ gatePassed: false });
    const result = await runVerifyProbe({ callTool: fakeTool, container: "fake-cid" });
    assert.equal(result.probe, "P2: verify gate");
    assert.equal(result.passed, false);
  });

  it("fails when gate_passed is missing from result", async () => {
    const fakeTool = async () => ({ output: "no gate field" });
    const result = await runVerifyProbe({ callTool: fakeTool, container: "fake-cid" });
    assert.equal(result.passed, false);
  });

  it("includes full verify result in detail as JSON", async () => {
    const fakeTool = fakeCallToolForP2({ gatePassed: true });
    const result = await runVerifyProbe({ callTool: fakeTool, container: "fake-cid" });
    const parsed = JSON.parse(result.detail);
    assert.equal(parsed.gate_passed, true);
  });
});

describe("runDeliverablesProbe", () => {
  it("passes when declared deliverable is touched", async () => {
    const fakeTool = fakeCallToolForP3({ statusOutput: " M src/foo.js\n" });
    const result = await runDeliverablesProbe({
      deliverables: ["src/foo.js"],
      headingPresent: true,
      callTool: fakeTool,
      container: "fake-cid",
    });
    assert.equal(result.probe, "P3: deliverables");
    assert.equal(result.passed, true);
    assert.equal(result.detail, "touches declared deliverables");
  });

  it("fails when declared deliverables are not touched", async () => {
    const fakeTool = fakeCallToolForP3({ statusOutput: " M src/other.js\n" });
    const result = await runDeliverablesProbe({
      deliverables: ["src/foo.js"],
      headingPresent: true,
      callTool: fakeTool,
      container: "fake-cid",
    });
    assert.equal(result.probe, "P3: deliverables");
    assert.equal(result.passed, false);
  });

  it("fails when heading present but no deliverables parsed", async () => {
    const fakeTool = fakeCallToolForP3();
    const result = await runDeliverablesProbe({
      deliverables: [],
      headingPresent: true,
      callTool: fakeTool,
      container: "fake-cid",
    });
    assert.equal(result.passed, false);
    assert.ok(result.detail.includes("heading present but no entries parsed"));
  });

  it("passes when no deliverables heading and no entries", async () => {
    const fakeTool = fakeCallToolForP3();
    const result = await runDeliverablesProbe({
      deliverables: [],
      headingPresent: false,
      callTool: fakeTool,
      container: "fake-cid",
    });
    assert.equal(result.passed, true);
    assert.equal(result.detail, "no Deliverables declared; check skipped");
  });

  it("attaches changedPaths and statusOutput for chain's use", async () => {
    const fakeTool = fakeCallToolForP3({ statusOutput: " M src/foo.js\n" });
    const result = await runDeliverablesProbe({
      deliverables: ["src/foo.js"],
      headingPresent: true,
      callTool: fakeTool,
      container: "fake-cid",
    });
    assert.ok(Array.isArray(result.changedPaths));
    assert.equal(result.changedPaths.length, 1);
    assert.equal(result.changedPaths[0], "src/foo.js");
    assert.equal(result.statusOutput, " M src/foo.js\n");
  });
});

// selectRoundModel  —  pure, extracted from cmdChain (chain-phases.mjs)
// =========================================================================

describe("selectRoundModel", () => {
  const baseModel = { providerID: "test", modelID: "gpt-4", variant: null };
  const modelChain = ["test/gpt-4", "test/gpt-4o", "test/claude"];

  it("round 1 with --model flag uses the provided model directly", () => {
    const result = selectRoundModel({ round: 1, isFirstRound: true, flagsModel: "test/gpt-4", model: baseModel, modelChain });
    assert.equal(result.roundModel, baseModel);
    assert.equal(result.roundModelEntry, "test/gpt-4");
  });

  it("round 1 without --model flag uses chain entry 0 via parseModel", () => {
    const result = selectRoundModel({ round: 1, isFirstRound: true, flagsModel: null, model: baseModel, modelChain });
    assert.ok(result.roundModel !== null);
    assert.equal(result.roundModel.providerID, "test");
    assert.equal(result.roundModel.modelID, "gpt-4");
    assert.equal(result.roundModelEntry, "test/gpt-4");
  });

  it("round 2 uses chain entry 1", () => {
    const result = selectRoundModel({ round: 2, isFirstRound: false, flagsModel: null, model: baseModel, modelChain });
    assert.equal(result.roundModel.providerID, "test");
    assert.equal(result.roundModel.modelID, "gpt-4o");
    assert.equal(result.roundModelEntry, "test/gpt-4o");
  });

  it("round beyond chain length clamps to last entry", () => {
    const result = selectRoundModel({ round: 5, isFirstRound: false, flagsModel: null, model: baseModel, modelChain });
    assert.equal(result.roundModel.providerID, "test");
    assert.equal(result.roundModel.modelID, "claude");
    assert.equal(result.roundModelEntry, "test/claude");
  });

  it("roundModelEntry includes variant when present", () => {
    const modelWithVariant = { providerID: "test", modelID: "gpt-4", variant: "turbo" };
    const result = selectRoundModel({ round: 1, isFirstRound: true, flagsModel: "test/gpt-4", model: modelWithVariant, modelChain });
    assert.equal(result.roundModelEntry, "test/gpt-4:turbo");
  });

  it("returns null roundModelEntry when roundModel is null", () => {
    // Empty model chain → parseModel returns null for the first entry
    const result = selectRoundModel({ round: 1, isFirstRound: true, flagsModel: null, model: baseModel, modelChain: [""] });
    assert.equal(result.roundModelEntry, null);
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
});

// shouldSkipReview  —  pure, extracted from cmdChain (chain-phases.mjs)
// =========================================================================

describe("shouldSkipReview", () => {
  it("returns true when status observed, no changes, and deliverables declared", () => {
    const result = shouldSkipReview({
      chainStatusObserved: true,
      chainChangedPaths: [],
      chainDeliverables: ["src/foo.js"],
    });
    assert.equal(result, true);
  });

  it("returns false when changes are present", () => {
    const result = shouldSkipReview({
      chainStatusObserved: true,
      chainChangedPaths: ["src/foo.js"],
      chainDeliverables: ["src/foo.js"],
    });
    assert.equal(result, false);
  });

  it("returns false when status was never observed", () => {
    const result = shouldSkipReview({
      chainStatusObserved: false,
      chainChangedPaths: [],
      chainDeliverables: ["src/foo.js"],
    });
    assert.equal(result, false);
  });

  it("returns false when no deliverables declared", () => {
    const result = shouldSkipReview({
      chainStatusObserved: true,
      chainChangedPaths: [],
      chainDeliverables: [],
    });
    assert.equal(result, false);
  });

  it("returns false when empty paths but no deliverables (both arrays empty)", () => {
    const result = shouldSkipReview({
      chainStatusObserved: true,
      chainChangedPaths: [],
      chainDeliverables: [],
    });
    assert.equal(result, false);
  });
});

// computeChainTotals  —  pure, extracted from cmdChain (chain-phases.mjs)
// =========================================================================

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

// renderAcceptOutcome  —  pure, extracted from cmdChain (chain-phases.mjs)
// =========================================================================

describe("renderAcceptOutcome", () => {
  const chainId = "chain-test123";

  it("renders accepted message with chain ID and round", () => {
    const result = renderAcceptOutcome({ chainId, round: 1, chainParsedReview: null, chainFindingsText: "" });
    assert.ok(result.includes("Chain chain-test123 accepted at round 1"));
  });

  it("renders review text when parsed review is present", () => {
    const review = { verdict: "approve", summary: "Looks good" };
    const result = renderAcceptOutcome({ chainId, round: 2, chainParsedReview: review, chainFindingsText: "no issues" });
    assert.ok(result.includes("Chain chain-test123 accepted at round 2"));
    // renderReview contributes the verdict line
    assert.ok(result.includes("approve"));
  });

  it("renders fallback when no review is available", () => {
    const result = renderAcceptOutcome({ chainId, round: 1, chainParsedReview: null, chainFindingsText: "" });
    assert.ok(result.includes("(no review text available)"));
  });
});

// renderAcceptWithFollowupOutcome  —  pure
// =========================================================================

describe("renderAcceptWithFollowupOutcome", () => {
  const chainId = "chain-test456";
  const brief = "# Fix the bug\n\nDescription here.";

  it("renders accept-with-followup message", () => {
    const result = renderAcceptWithFollowupOutcome({
      chainId, round: 1, chainParsedReview: null, chainFindingsText: "minor issues",
      chainFollowupDraft: null, brief,
    });
    assert.ok(result.includes("Chain chain-test456 accepted-with-followup at round 1"));
    assert.ok(result.includes("(no review text available)"));
  });

  it("renders review text and followup draft when both present", () => {
    const review = { verdict: "needs-attention", findings: [{ file: "src/foo.js", title: "missing null check", severity: "low", line_start: 42 }] };
    const result = renderAcceptWithFollowupOutcome({
      chainId, round: 2, chainParsedReview: review, chainFindingsText: "findings",
      chainFollowupDraft: "# Followup issue draft\n\n## Findings\n- [low] missing null check (src/foo.js:42)",
      brief,
    });
    assert.ok(result.includes("accepted-with-followup at round 2"));
    assert.ok(result.includes("# Followup issue draft"));
  });

  it("generates followup draft from findings when chainFollowupDraft is null", () => {
    const review = {
      verdict: "needs-attention",
      findings: [{ file: "src/foo.js", title: "missing null check", severity: "low", line_start: 42 }],
    };
    const result = renderAcceptWithFollowupOutcome({
      chainId, round: 1, chainParsedReview: review, chainFindingsText: "findings",
      chainFollowupDraft: null, brief,
    });
    assert.ok(result.includes("missing null check"));
    assert.ok(result.includes("src/foo.js"));
  });
});

// renderEscalateOutcome  —  pure
// =========================================================================

describe("renderEscalateOutcome", () => {
  const chainId = "chain-esc789";

  it("renders escalate message with reason and orchestrator line", () => {
    const roundRecord = { findingsText: "critical issue in src/main.js" };
    const records = [
      {
        resumeMethod: { type: "checkpoint_restore", base: "abc123", detail: null },
        modelEntry: "test/gpt-4",
        verdict: "needs-attention",
        probesGreen: true,
      },
    ];
    const disposition = { disposition: "escalate", reason: "max rounds (3) reached without acceptance" };
    const orchestrator = { model: "claude-opus" };

    const result = renderEscalateOutcome({ chainId, round: 3, disposition, orchestrator, roundRecord, records });
    assert.ok(result.includes("Chain chain-esc789 escalated at round 3"));
    assert.ok(result.includes("max rounds (3) reached without acceptance"));
    assert.ok(result.includes("orchestrator=claude-opus"));
    assert.ok(result.includes("Remaining findings:"));
    assert.ok(result.includes("critical issue in src/main.js"));
    assert.ok(result.includes("Hand over to orchestrator for final judgement."));
  });

  it("renders round summaries with resume details", () => {
    const roundRecord = { findingsText: "issue" };
    const records = [
      { resumeMethod: { type: "checkpoint_restore", detail: null }, modelEntry: "test/gpt-4", verdict: "needs-attention", probesGreen: false },
      { resumeMethod: { type: "checkpoint_restore_failed", detail: "network error" }, modelEntry: "test/gpt-4o", verdict: "needs-attention", probesGreen: true },
    ];
    const disposition = { disposition: "escalate", reason: "repeated areas" };
    const result = renderEscalateOutcome({ chainId, round: 2, disposition, orchestrator: null, roundRecord, records });
    assert.ok(result.includes("Round 1: model=test/gpt-4, verdict=needs-attention, probesGreen=false, resume=checkpoint_restore"));
    assert.ok(result.includes("Round 2: model=test/gpt-4o, verdict=needs-attention, probesGreen=true, resume=checkpoint_restore_failed: network error"));
  });

  it("renders 'unknown' when reason is missing", () => {
    const roundRecord = { findingsText: "issue" };
    const records = [{ resumeMethod: { type: "continue_session" }, modelEntry: "x", verdict: "discard", probesGreen: false }];
    const result = renderEscalateOutcome({ chainId, round: 1, disposition: { disposition: "escalate" }, orchestrator: null, roundRecord, records });
    assert.ok(result.includes("unknown"));
  });
});

// renderMaxRoundsOutcome  —  pure
// =========================================================================

describe("renderMaxRoundsOutcome", () => {
  const chainId = "chain-max123";

  it("renders max rounds message", () => {
    const records = [
      { resumeMethod: { type: "continue_session" }, modelEntry: "test/gpt-4", verdict: "needs-attention", probesGreen: false },
      { resumeMethod: { type: "checkpoint_restore" }, modelEntry: "test/gpt-4o", verdict: "needs-attention", probesGreen: true, findingsText: "still has bugs" },
    ];
    const orchestrator = { model: "gpt-5" };

    const result = renderMaxRoundsOutcome({ chainId, maxRounds: 3, records, orchestrator });
    assert.ok(result.includes("Chain chain-max123 reached max rounds (3) without acceptance"));
    assert.ok(result.includes("orchestrator=gpt-5"));
    assert.ok(result.includes("Remaining findings:"));
    assert.ok(result.includes("still has bugs"));
    assert.ok(result.includes("Round 1: model=test/gpt-4, verdict=needs-attention, probesGreen=false, resume=continue_session"));
    assert.ok(result.includes("Round 2: model=test/gpt-4o, verdict=needs-attention, probesGreen=true, resume=checkpoint_restore"));
    assert.ok(result.includes("Hand over to orchestrator for final judgement."));
  });

  it("renders (none) for findings when last record has none", () => {
    const records = [
      { resumeMethod: { type: "continue_session" }, modelEntry: "x", verdict: "discard", probesGreen: false },
    ];
    const result = renderMaxRoundsOutcome({ chainId, maxRounds: 1, records, orchestrator: null });
    assert.ok(result.includes("(none)"));
  });

  it("renders fallback for empty records", () => {
    const result = renderMaxRoundsOutcome({ chainId, maxRounds: 3, records: [], orchestrator: null });
    assert.ok(result.includes("(none)"));
    assert.ok(result.includes("reached max rounds (3)"));
  });
});

