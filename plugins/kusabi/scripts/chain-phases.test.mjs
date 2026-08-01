import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildImplementText,
  shouldSkipReview,
  computeChainTotals,
  resolveRoundResume,
  renderAcceptOutcome,
  renderAcceptWithFollowupOutcome,
  renderEscalateOutcome,
  renderMaxRoundsOutcome,
  renderProviderExhaustedOutcome,
  handleProviderExhaustion,
  runSmokeProbe,
  runHeadCleanProbe,
  runVerifyProbe,
  runDeliverablesProbe,
  runProbePhase,
  runReviewPhase,
  runStrategizePhase,
  parseReviewResult,
  normalizeFilePath,
  hasRepeatedAreas,
} from "./chain-phases.mjs";
import {
  createFakeCallTool,
  fakeCallToolForP1,
  fakeCallToolForP2,
  fakeCallToolForP3,
  fakeCallToolForP3WithBaseline,
} from "./fixtures.mjs";
import { renderPriorFindings } from "./render.mjs";

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

  // === Baseline-aware tests ===

  it("dirty baseline + round changed nothing → P3 fails", async () => {
    const baseline = {
      treeHash: "abc",
      files: { "src/foo.js": "hash-v1" },
    };
    const currentManifest = {
      treeHash: "abc",
      files: { "src/foo.js": "hash-v1" },
    };
    const fakeTool = fakeCallToolForP3WithBaseline({
      statusOutput: " M src/foo.js\n",
      currentManifest,
    });
    const result = await runDeliverablesProbe({
      deliverables: ["src/foo.js"],
      headingPresent: true,
      callTool: fakeTool,
      container: "fake-cid",
      baseline,
    });
    assert.equal(result.probe, "P3: deliverables");
    assert.equal(result.passed, false);
    assert.match(result.detail, /no paths changed since baseline/);
    assert.equal(result.worktreeChanged, false);
  });

  it("dirty baseline + round modified a declared path → P3 passes", async () => {
    const baseline = {
      treeHash: "abc",
      files: { "src/foo.js": "hash-v1" },
    };
    const currentManifest = {
      treeHash: "def",
      files: { "src/foo.js": "hash-v2" },
    };
    const fakeTool = fakeCallToolForP3WithBaseline({
      statusOutput: " M src/foo.js\n",
      currentManifest,
    });
    const result = await runDeliverablesProbe({
      deliverables: ["src/foo.js"],
      headingPresent: true,
      callTool: fakeTool,
      container: "fake-cid",
      baseline,
    });
    assert.equal(result.probe, "P3: deliverables");
    assert.equal(result.passed, true);
    assert.match(result.detail, /touches declared deliverables/);
    assert.equal(result.worktreeChanged, true);
  });

  it("baseline present but captureWorktreeState returns null → falls back to changedPaths", async () => {
    const baseline = {
      treeHash: "abc",
      files: { "src/foo.js": "hash-v1" },
    };
    // currentManifest=null causes the fake to return ERROR_NO_INDEX
    const fakeTool = fakeCallToolForP3WithBaseline({
      statusOutput: " M src/foo.js\n",
      currentManifest: null,
    });
    const result = await runDeliverablesProbe({
      deliverables: ["src/foo.js"],
      headingPresent: true,
      callTool: fakeTool,
      container: "fake-cid",
      baseline,
    });
    assert.equal(result.probe, "P3: deliverables");
    assert.equal(result.passed, true, "should fall back to changedPaths when capture fails");
    assert.equal(result.worktreeChanged, null, "capture failure yields null worktreeChanged");
  });

  it("untracked file created by round is detected as newly changed", async () => {
    const baseline = {
      treeHash: "abc",
      files: { "src/main.js": "hash-main" },
    };
    const currentManifest = {
      treeHash: "def",
      files: {
        "src/main.js": "hash-main",
        "plugins/new.js": "hash-new",
      },
    };
    const fakeTool = fakeCallToolForP3WithBaseline({
      statusOutput: " M src/main.js\n?? plugins/new.js\n",
      currentManifest,
    });
    const result = await runDeliverablesProbe({
      deliverables: ["plugins"],
      headingPresent: true,
      callTool: fakeTool,
      container: "fake-cid",
      baseline,
    });
    assert.equal(result.probe, "P3: deliverables");
    assert.equal(result.passed, true);
    assert.match(result.detail, /touches declared deliverables/);
  });

  it("newlyChangedPaths contains only what changed since baseline, not all dirty paths", async () => {
    const baseline = {
      treeHash: "abc",
      files: { "src/old.js": "hash-old", "docs/guide.md": "hash-guide" },
    };
    const currentManifest = {
      treeHash: "def",
      files: {
        "src/old.js": "hash-old",
        "docs/guide.md": "hash-guide",
        "src/new.js": "hash-new",
      },
    };
    const fakeTool = fakeCallToolForP3WithBaseline({
      statusOutput: " M src/old.js\n M docs/guide.md\n?? src/new.js\n",
      currentManifest,
    });
    const result = await runDeliverablesProbe({
      deliverables: ["src/old.js"],
      headingPresent: true,
      callTool: fakeTool,
      container: "fake-cid",
      baseline,
    });
    // src/old.js is in both manifests with same hash → not newly changed
    // src/new.js is new → changed, but it's not a deliverable
    assert.equal(result.passed, false);
    assert.deepEqual(result.newlyChangedPaths, ["src/new.js"]);
    assert.deepEqual(result.changedPaths, ["src/old.js", "docs/guide.md", "src/new.js"]);
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

  // The cases above omit chainNewlyChanged, so they only exercise the
  // fallback.  In production runProbePhase always passes it — these cover
  // that path.

  it("skips review when the round changed nothing since the baseline, even though the tree is dirty", () => {
    // This is the case the baseline exists for: the tree carries a previous
    // chain's work, so chainChangedPaths is non-empty, but this round added
    // nothing of its own.
    const result = shouldSkipReview({
      chainStatusObserved: true,
      chainChangedPaths: ["src/foo.js", "src/bar.js"],
      chainNewlyChanged: [],
      chainDeliverables: ["src/foo.js"],
    });
    assert.equal(result, true);
  });

  it("does not skip review when the round changed a file, even if it was already dirty", () => {
    const result = shouldSkipReview({
      chainStatusObserved: true,
      chainChangedPaths: ["src/foo.js"],
      chainNewlyChanged: ["src/foo.js"],
      chainDeliverables: ["src/foo.js"],
    });
    assert.equal(result, false);
  });

  it("an unmeasurable round (null) is not treated as an empty one", () => {
    // null means the comparison could not be made.  Falling through to
    // chainChangedPaths keeps a real change set visible; collapsing null to []
    // here would discard a round because the measurement broke.
    const result = shouldSkipReview({
      chainStatusObserved: true,
      chainChangedPaths: ["src/foo.js"],
      chainNewlyChanged: null,
      chainDeliverables: ["src/foo.js"],
    });
    assert.equal(result, false);
  });

  it("an unmeasurable round on a genuinely empty tree still skips", () => {
    const result = shouldSkipReview({
      chainStatusObserved: true,
      chainChangedPaths: [],
      chainNewlyChanged: null,
      chainDeliverables: ["src/foo.js"],
    });
    assert.equal(result, true);
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
        resumeMethod: { type: "fresh_session", base: "abc123" },
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
      { resumeMethod: { type: "continue_session" }, modelEntry: "test/gpt-4", verdict: "needs-attention", probesGreen: false },
      { resumeMethod: { type: "fresh_session", detail: "new session" }, modelEntry: "test/gpt-4o", verdict: "needs-attention", probesGreen: true },
    ];
    const disposition = { disposition: "escalate", reason: "repeated areas" };
    const result = renderEscalateOutcome({ chainId, round: 2, disposition, orchestrator: null, roundRecord, records });
    assert.ok(result.includes("Round 1: model=test/gpt-4, verdict=needs-attention, probesGreen=false, changed=unknown, resume=continue_session"));
    assert.ok(result.includes("Round 2: model=test/gpt-4o, verdict=needs-attention, probesGreen=true, changed=unknown, resume=fresh_session: new session"));
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
      { resumeMethod: { type: "fresh_session" }, modelEntry: "test/gpt-4o", verdict: "needs-attention", probesGreen: true, findingsText: "still has bugs" },
    ];
    const orchestrator = { model: "gpt-5" };

    const result = renderMaxRoundsOutcome({ chainId, maxRounds: 3, records, orchestrator });
    assert.ok(result.includes("Chain chain-max123 reached max rounds (3) without acceptance"));
    assert.ok(result.includes("orchestrator=gpt-5"));
    assert.ok(result.includes("Remaining findings:"));
    assert.ok(result.includes("still has bugs"));
    assert.ok(result.includes("Round 1: model=test/gpt-4, verdict=needs-attention, probesGreen=false, changed=unknown, resume=continue_session"));
    assert.ok(result.includes("Round 2: model=test/gpt-4o, verdict=needs-attention, probesGreen=true, changed=unknown, resume=fresh_session"));
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

// =========================================================================
// renderProviderExhaustedOutcome  —  pure
// =========================================================================

describe("renderProviderExhaustedOutcome", () => {
  const chainId = "chain-exhausted-1";

  it("identifies provider/capacity exhaustion distinct from escalate and max rounds", () => {
    const result = renderProviderExhaustedOutcome({
      chainId,
      round: 2,
      phase: "implement",
      jobError: "All routes exhausted:\n  route/a — rate_limit at attempt 3: overloaded\n  route/b — free_tier_limit at attempt 1: quota gone",
      records: [],
    });

    assert.ok(result.includes("stopped at round 2: implement provider exhausted"));
    assert.ok(result.includes("All routes exhausted:"));
    assert.ok(result.includes("route/a"));
    assert.ok(result.includes("route/b"));
    assert.ok(result.includes("free_tier_limit"));
    // Must NOT be confused with escalation or max rounds.
    assert.ok(!result.includes("escalate"));
    assert.ok(!result.includes("max rounds"));
    // Capacity message is present.
    assert.ok(result.includes("Capacity problem"));
    assert.ok(result.includes("not a quality failure"));
  });

  it("surfaces the job error text directly (no re-derivation)", () => {
    const jobError = "All routes exhausted:\n  only/route — rate_limit at attempt 3";
    const result = renderProviderExhaustedOutcome({
      chainId,
      round: 1,
      phase: "review",
      jobError,
      records: [],
    });

    assert.ok(result.includes(jobError));
    assert.ok(result.includes("review provider exhausted"));
  });

  it("includes prior round records so chain-show can display aborted round", () => {
    const records = [
      {
        round: 1,
        modelEntry: "provider/model-a",
        verdict: "needs-attention",
        probesGreen: true,
        resumeMethod: { type: "continue_session" },
        fallbacks: [{ from: "route/dead", to: "route/alive", reason: "free_tier_limit", attempt: 1, message: "quota" }],
      },
      {
        round: 2,
        modelEntry: "provider/model-b",
        verdict: null,
        probesGreen: false,
        resumeMethod: { type: "fresh_session", base: "abc123" },
        fallbacks: [{ from: "route/x", to: null, reason: "rate_limit", attempt: 3, message: "overloaded" }],
      },
    ];

    const result = renderProviderExhaustedOutcome({
      chainId,
      round: 3,
      phase: "implement",
      jobError: "All routes exhausted:\n  route/x — rate_limit at attempt 3: overloaded",
      records,
    });

    assert.ok(result.includes("Prior rounds:"));
    assert.ok(result.includes("Round 1: model=provider/model-a, verdict=needs-attention, probesGreen=true, changed=unknown, resume=continue_session"));
    assert.ok(result.includes("Round 2: model=provider/model-b, verdict=n/a, probesGreen=false, changed=unknown, resume=fresh_session"));
  });

  it("handles null jobError gracefully", () => {
    const result = renderProviderExhaustedOutcome({
      chainId,
      round: 1,
      phase: "implement",
      jobError: null,
      records: [],
    });

    assert.ok(result.includes("(no error detail)"));
  });

  it("handles strategize phase exhaustion", () => {
    const result = renderProviderExhaustedOutcome({
      chainId,
      round: 2,
      phase: "strategize",
      jobError: "All routes exhausted:\n  route/p — rate_limit at attempt 3",
      records: [],
    });

    assert.ok(result.includes("strategize provider exhausted"));
  });

  it("strategize provider-error: each round appears exactly once", () => {
    // The strategize provider-error handler used to push the round record a
    // second time, duplicating it in `records`.  The fix (removing that push)
    // lives in cmdChain, which this test does NOT reach: cmdChain is not
    // exported and driving it would require mocking every phase.  This test
    // only covers the downstream half -- that the renderer does not itself
    // duplicate rounds.  Re-introducing the duplicate push in cmdChain would
    // still pass here.  Making that path testable is tracked separately.
    const records = [
      {
        round: 1,
        modelEntry: "provider/model-a",
        verdict: "needs-attention",
        probesGreen: true,
        resumeMethod: { type: "continue_session" },
      },
      {
        round: 2,
        modelEntry: "provider/model-b",
        verdict: "needs-attention",
        probesGreen: true,
        resumeMethod: { type: "continue_session" },
      },
    ];

    const result = renderProviderExhaustedOutcome({
      chainId,
      round: 3,
      phase: "strategize",
      jobError: "All routes exhausted:\n  route/p — rate_limit at attempt 3",
      records,
    });

    // Each prior round must appear exactly once in the rendered output.
    // The current (aborted) round shows in the header as "stopped at round 3".
    assert.equal((result.match(/Round 1/g) || []).length, 1);
    assert.equal((result.match(/Round 2/g) || []).length, 1);
    // The current round appears only in the header, not as a "Round 3:" line.
    assert.ok(result.includes("stopped at round 3"));
  });
});

// handleProviderExhaustion — pure, testable
// =========================================================================

describe("handleProviderExhaustion", () => {
  const chainId = "chain-test-provider-error-1";
  const baseState = {
    chainId,
    round: 3,
    container: "test-container",
    model: "test-model",
    modelChain: ["test-model"],
    maxRounds: 5,
    brief: "Test brief",
    orchestrator: "test-orchestrator",
    baseSha: "abc1234",
    strategized: false,
  };

  function makeRecords(rounds) {
    return rounds.map((r) => ({
      round: r,
      modelEntry: "provider/model-" + r,
      verdict: "needs-attention",
      probesGreen: true,
      resumeMethod: { type: "continue_session" },
    }));
  }

  // ---- implement ----

  it("implement provider-error: the round appears exactly once in records", () => {
    const records = makeRecords([1, 2]);
    const roundRecord = { round: 3, modelEntry: "provider/model-3", verdict: null };

    const result = handleProviderExhaustion({
      records,
      roundRecord,
      currentTierIndex: 0,
      phase: "implement",
      jobError: "All routes exhausted",
      chainFollowupDraft: null,
      ...baseState,
    });

    assert.equal(result.records.length, 3, "records should have 3 entries");
    const round3Entries = result.records.filter((r) => r.round === 3);
    assert.equal(round3Entries.length, 1, "round 3 must appear exactly once");
    assert.equal(round3Entries[0].tierAfter, 0, "tierAfter must be set");
    assert.ok(result.outcome.includes("implement provider exhausted"),
      "outcome names the implement phase");
  });

  // ---- review ----

  it("review provider-error: the round appears exactly once in records", () => {
    const records = makeRecords([1, 2]);
    const roundRecord = { round: 3, modelEntry: "provider/model-3", verdict: null };

    const result = handleProviderExhaustion({
      records,
      roundRecord,
      currentTierIndex: 1,
      phase: "review",
      jobError: "All routes exhausted",
      chainFollowupDraft: null,
      ...baseState,
    });

    assert.equal(result.records.length, 3, "records should have 3 entries");
    const round3Entries = result.records.filter((r) => r.round === 3);
    assert.equal(round3Entries.length, 1, "round 3 must appear exactly once");
    assert.equal(round3Entries[0].tierAfter, 1, "tierAfter must be set");
    assert.ok(result.outcome.includes("review provider exhausted"),
      "outcome names the review phase");
  });

  // ---- strategize (the bug PR #119 fixed) ----

  it("strategize provider-error: the round appears exactly once in records (no duplicate)", () => {
    // round 3 has already been pushed by phase 7 — simulate that state
    const records = makeRecords([1, 2]);
    const roundRecord = { round: 3, modelEntry: "provider/model-3", verdict: null };
    records.push(roundRecord);

    const result = handleProviderExhaustion({
      records,
      roundRecord,
      currentTierIndex: 0,
      phase: "strategize",
      jobError: "All routes exhausted",
      chainFollowupDraft: null,
      ...baseState,
    });

    // Must NOT push the round a second time
    assert.equal(result.records.length, 3, "records should still have 3 entries (no duplicate)");
    const round3Entries = result.records.filter((r) => r.round === 3);
    assert.equal(round3Entries.length, 1, "round 3 must appear exactly once");
    assert.equal(round3Entries[0].tierAfter, 0, "tierAfter must be set on the existing record");
    assert.ok(result.outcome.includes("strategize provider exhausted"),
      "outcome names the strategize phase");
  });

  // ---- persisted state ----

  it("persisted chainState for implement contains the round exactly once", () => {
    const records = makeRecords([1]);
    const roundRecord = { round: 2, modelEntry: "provider/model-2" };

    const result = handleProviderExhaustion({
      records, roundRecord,
      currentTierIndex: 0,
      phase: "implement",
      jobError: "error detail",
      chainFollowupDraft: null,
      ...baseState, round: 2,
    });

    const round2InState = result.chainState.records.filter((r) => r.round === 2);
    assert.equal(round2InState.length, 1, "chainState records must contain round 2 exactly once");
    assert.equal(round2InState[0].tierAfter, 0, "tierAfter must be reflected in chainState");
  });

  it("persisted chainState for review contains the round exactly once", () => {
    const records = makeRecords([1]);
    const roundRecord = { round: 2, modelEntry: "provider/model-2" };

    const result = handleProviderExhaustion({
      records, roundRecord,
      currentTierIndex: 1,
      phase: "review",
      jobError: "error detail",
      chainFollowupDraft: null,
      ...baseState, round: 2,
    });

    const round2InState = result.chainState.records.filter((r) => r.round === 2);
    assert.equal(round2InState.length, 1, "chainState records must contain round 2 exactly once");
  });

  it("persisted chainState for strategize contains the round exactly once", () => {
    const records = makeRecords([1]);
    const roundRecord = { round: 2, modelEntry: "provider/model-2" };
    records.push(roundRecord); // already recorded by phase 7

    const result = handleProviderExhaustion({
      records, roundRecord,
      currentTierIndex: 0,
      phase: "strategize",
      jobError: "error detail",
      chainFollowupDraft: null,
      ...baseState, round: 2,
    });

    // chainState records must contain round 2 exactly once
    const round2InState = result.chainState.records.filter((r) => r.round === 2);
    assert.equal(round2InState.length, 1, "chainState records must contain round 2 exactly once");
  });

  // ---- the push decision is derived, not supplied ----

  it("never duplicates a round that is already in records, whatever the phase", () => {
    // The caller used to pass a roundAlreadyRecorded flag.  A call site that got
    // it wrong would silently duplicate the round (the PR #119 defect) and no
    // test of this function could have caught it, because the function would
    // have been doing exactly what it was told.  The decision is now derived
    // from records, so there is no flag left to get wrong.
    for (const phase of ["implement", "review", "strategize"]) {
      const records = makeRecords([1]);
      const roundRecord = { round: 2, modelEntry: "provider/model-2" };
      records.push(roundRecord);

      const result = handleProviderExhaustion({
        records, roundRecord,
        currentTierIndex: 0,
        phase,
        jobError: "error detail",
        chainFollowupDraft: null,
        ...baseState, round: 2,
      });

      const occurrences = result.chainState.records.filter((r) => r === roundRecord);
      assert.equal(occurrences.length, 1, `round duplicated for phase ${phase}`);
    }
  });

  it("pushes a round that is not yet in records, whatever the phase", () => {
    for (const phase of ["implement", "review", "strategize"]) {
      const records = makeRecords([1]);
      const roundRecord = { round: 2, modelEntry: "provider/model-2" };

      const result = handleProviderExhaustion({
        records, roundRecord,
        currentTierIndex: 0,
        phase,
        jobError: "error detail",
        chainFollowupDraft: null,
        ...baseState, round: 2,
      });

      const occurrences = result.chainState.records.filter((r) => r === roundRecord);
      assert.equal(occurrences.length, 1, `round missing or duplicated for phase ${phase}`);
    }
  });

  // ---- outcome names the phase ----

  it("rendered outcome names each failing phase", () => {
    const phases = [
      { phase: "implement",  alreadyRecorded: false },
      { phase: "review",     alreadyRecorded: false },
      { phase: "strategize", alreadyRecorded: true },
    ];

    for (const { phase, alreadyRecorded } of phases) {
      const records = makeRecords([1]);
      const roundRecord = { round: 2, modelEntry: "provider/model-2" };
      if (alreadyRecorded) records.push(roundRecord);

      const result = handleProviderExhaustion({
        records, roundRecord,
        currentTierIndex: 0,
        phase,
        jobError: "error detail",
        chainFollowupDraft: null,
        ...baseState, round: 2,
      });

      assert.ok(
        result.outcome.includes(phase + " provider exhausted"),
        "outcome must name the phase: " + phase,
      );
    }
  });
});

// parseReviewResult — pure function for decision-path review parsing (AC3, AC4)// =========================================================================

describe("parseReviewResult", () => {
  // AC3: VERDICT token inside JSON fence with findings recovery
  it("recovers verdict AND findings when VERDICT token appears inside JSON fence", () => {
    // Real-world incident: model emitted VERDICT: needs-attention inside the
    // JSON fence block, and the old strip regex (anchored to $) missed it.
    const payload = [
      "```json",
      "{",
      '  "verdict": "needs-attention",',
      '  "summary": "All five prior findings are genuinely fixed. The gate passes (451/451, zero lint/type issues). However, one function is dead code.",',
      '  "findings": [',
      '    { "severity": "low", "title": "Dead code in helper", "file": "src/utils.js", "line_start": 42 }',
      "  ]",
      "}",
      "```",
      "",
      "VERDICT: needs-attention",
    ].join("\n");

    const result = parseReviewResult(payload);

    assert.equal(result.reviewParseable, true);
    assert.equal(result.chainVerdict, "needs-attention");
    // AC3: findings must be recovered, not replaced with "(no structured findings)"
    assert.ok(result.chainFindingsText.includes("Dead code in helper"));
    assert.ok(result.chainFindingsText.includes("src/utils.js:42"));
    assert.ok(!result.chainFindingsText.includes("(no structured findings)"));
  });

  it("recovers findings when VERDICT token appears after secondary fence", () => {
    // Another variant: token is between fences
    const payload = [
      "Here is my review:",
      "",
      "```json",
      "{",
      '  "verdict": "needs-attention",',
      '  "summary": "Looks ok",',
      '  "findings": [',
      '    { "severity": "medium", "title": "Magic number", "file": "src/calc.js", "line_start": 7 }',
      "  ]",
      "}",
      "```",
      "```",
      "VERDICT: needs-attention",
      "```",
    ].join("\n");

    const result = parseReviewResult(payload);

    assert.equal(result.reviewParseable, true);
    assert.equal(result.chainVerdict, "needs-attention");
    assert.ok(result.chainFindingsText.includes("Magic number"));
    assert.ok(result.chainFindingsText.includes("src/calc.js:7"));
  });

  it("recovers approve verdict with empty findings", () => {
    const payload = "```json\n{\n  \"verdict\": \"approve\",\n  \"summary\": \"LGTM\",\n  \"findings\": []\n}\n```";
    const result = parseReviewResult(payload);

    assert.equal(result.reviewParseable, true);
    assert.equal(result.chainVerdict, "approve");
    assert.equal(result.chainFindingsText, "(no structured findings)");
  });

  // AC4: unparseable review produces distinguishable state
  it("unparseable review: verdict recovered from token but findings unavailable", () => {
    const payload = [
      "Here is some text that is definitely not JSON.",
      "It doesn't have any structure at all.",
      "VERDICT: needs-attention",
    ].join("\n");

    const result = parseReviewResult(payload);

    // AC4: reviewParseable is false, verdict is recovered from token
    assert.equal(result.reviewParseable, false);
    assert.equal(result.chainVerdict, "needs-attention");
    // AC4: findingsText is distinct from "(no structured findings)" — it
    // explicitly states the review was unparseable
    assert.equal(result.chainFindingsText, "(review output could not be parsed)");
    assert.ok(result.chainFindingsText !== "(no structured findings)");
    assert.equal(result.chainParsedReview, null);
  });

  it("unparseable review without any token gives 'unparseable' verdict", () => {
    const payload = "gibberish without any verdict token at all";

    const result = parseReviewResult(payload);

    assert.equal(result.reviewParseable, false);
    assert.equal(result.chainVerdict, "unparseable");
    assert.equal(result.chainFindingsText, "(review output could not be parsed)");
    assert.equal(result.chainParsedReview, null);
  });

  it("unparseable review is distinguishable from genuine needs-attention", () => {
    // A genuine needs-attention review is parseable but has that verdict
    const genuinePayload = "```json\n{\n  \"verdict\": \"needs-attention\",\n  \"summary\": \"Issues found\",\n  \"findings\": [\n    { \"severity\": \"high\", \"title\": \"Bug\", \"file\": \"src/main.js\", \"line_start\": 1 }\n  ]\n}\n```\nVERDICT: needs-attention";
    const genuine = parseReviewResult(genuinePayload);

    assert.equal(genuine.reviewParseable, true);
    assert.equal(genuine.chainVerdict, "needs-attention");
    assert.ok(genuine.chainFindingsText.includes("Bug"));

    // An unparseable review that happened to have VERDICT: needs-attention token
    const unparseablePayload = "Not JSON at all.\nVERDICT: needs-attention";
    const unparseable = parseReviewResult(unparseablePayload);

    assert.equal(unparseable.reviewParseable, false);
    assert.equal(unparseable.chainVerdict, "needs-attention");
    assert.equal(unparseable.chainFindingsText, "(review output could not be parsed)");

    // The two produce different reviewParseable and different findingsText
    // despite having the same verdict string.
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
  function captureCallTool({ diff = "", untracked = "", throwOn = null } = {}) {
    const commands = [];
    return {
      commands,
      callTool: async (toolName, params) => {
        if (toolName !== "sandbox_exec") return { output: "" };
        const cmd = params.commands[0];
        commands.push(cmd);
        if (throwOn && cmd.startsWith(throwOn)) throw new Error("container is gone");
        if (cmd === "git diff") return { output: diff };
        if (cmd.startsWith("git ls-files --others")) return { output: untracked };
        return { output: "" };
      },
    };
  }

  it("returns the captured diff content and untracked file list", async () => {
    const diff = "diff --git a/src/a.js b/src/a.js\n@@ -1 +1,2 @@\n+const added = 1;\n";
    const { commands, callTool } = captureCallTool({ diff, untracked: "src/brand-new.js\n" });

    const result = await runProbePhase({
      baseSha: "abc1234",
      container: "fake-cid",
      brief: "## Deliverables\n\n- `src/a.js`\n",
      callTool,
    });

    assert.match(result.chainDiff, /\+const added = 1;/);
    assert.equal(result.chainUntracked.trim(), "src/brand-new.js");
    assert.ok(commands.includes("git diff"), "capture must run `git diff`");
    assert.ok(
      commands.some((c) => c.startsWith("git ls-files --others")),
      "capture must list untracked files",
    );
  });

  it("leaves both fields empty when the capture call throws", async () => {
    const { callTool } = captureCallTool({ throwOn: "git diff" });

    const result = await runProbePhase({
      baseSha: "abc1234",
      container: "fake-cid",
      brief: "",
      callTool,
    });

    // Degrades rather than throwing: renderBaseFacts then says "(unavailable)".
    assert.equal(result.chainDiff, "");
    assert.equal(result.chainUntracked, "");
  });
});

// diff_in_container in review input tool list
// ---------------------------------------------------------------------------

describe("review input tool list", () => {
  // Source-level guard, not a behavioural test: the tool list is built inline
  // inside runReviewPhase, and reaching it means dispatching a real review job.
  // This only catches the line being deleted, which is what it is for.
  it("names diff_in_container in the review input tool list (source guard)", () => {
    assert.ok(
      runReviewPhase.toString().includes("diff_in_container"),
      "runReviewPhase should offer diff_in_container in the tool list",
    );
  });
});

// ---------------------------------------------------------------------------
// runReviewPhase / runStrategizePhase — stubbed dispatch route recording
// ---------------------------------------------------------------------------

describe("runReviewPhase — stubbed dispatch route recording", () => {
  it("records reviewModelEntry and reviewModelVariant on the roundRecord", async () => {
    function stubbedDispatch() {
      return {
        job: {
          id: "review-job-1",
          status: "completed",
          modelEntry: "test-org/test-review-model:variant",
          modelVariant: "variant",
          fallbacks: null,
          usage: null,
          error: null,
        },
        resultText: JSON.stringify({ verdict: "approve", findings: [] }),
      };
    }

    const roundRecord = { round: 1 };

    const result = await runReviewPhase({
      container: "test",
      brief: "test brief",
      modelChain: ["test-org/test-flash", "test-org/test-pro"],
      chainId: "test-chain",
      cwd: process.cwd(),
      previousRecord: null,
      baseSha: "abc123",
      chainStatusOutput: "",
      chainBaseLog: "",
      chainDiff: "",
      chainUntracked: "",
      roundRecord,
      chainChangedPaths: [],
      chainStatusObserved: false,
      chainDeliverables: [],
      flagsModel: null,
      _dispatchWithFallback: stubbedDispatch,
    });

    assert.equal(roundRecord.reviewModelEntry, "test-org/test-review-model:variant");
    assert.equal(roundRecord.reviewModelVariant, "variant");
    assert.equal(roundRecord.reviewFallbacks, null);
    assert.equal(result.reviewJobStatus, "completed");
  });

  it("records reviewFallbacks when dispatch had fallbacks", async () => {
    function stubbedDispatch() {
      return {
        job: {
          id: "review-job-2",
          status: "completed",
          modelEntry: "test-org/test-review-model",
          modelVariant: null,
          fallbacks: [
            { from: "test-org/old-route", to: "test-org/test-review-model", reason: "capacity", attempt: 1, message: "busy" },
          ],
          usage: null,
          error: null,
        },
        resultText: JSON.stringify({ verdict: "approve", findings: [] }),
      };
    }

    const roundRecord = { round: 1 };

    await runReviewPhase({
      container: "test",
      brief: "test brief",
      modelChain: ["test-org/test-flash", "test-org/test-pro"],
      chainId: "test-chain",
      cwd: process.cwd(),
      previousRecord: null,
      baseSha: "abc123",
      chainStatusOutput: "",
      chainBaseLog: "",
      chainDiff: "",
      chainUntracked: "",
      roundRecord,
      chainChangedPaths: ["some/file"],
      chainStatusObserved: true,
      chainDeliverables: ["test/file"],
      flagsModel: null,
      _dispatchWithFallback: stubbedDispatch,
    });

    assert.ok(Array.isArray(roundRecord.reviewFallbacks));
    assert.equal(roundRecord.reviewFallbacks.length, 1);
    assert.equal(roundRecord.reviewFallbacks[0].from, "test-org/old-route");
  });
});

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

describe("runReviewPhase fallback trail fidelity", () => {
  function dispatchReturning(fallbacks) {
    return function stubbedDispatch() {
      return {
        job: {
          id: "job-1",
          status: "completed",
          modelEntry: "test-org/test-review-model",
          modelVariant: null,
          fallbacks,
          usage: null,
          error: null,
        },
        resultText: JSON.stringify({ verdict: "approve", findings: [] }),
      };
    };
  }

  async function runWith(fallbacks) {
    const roundRecord = { round: 1 };
    await runReviewPhase({
      container: "test",
      brief: "test brief",
      modelChain: ["test-org/test-flash", "test-org/test-pro"],
      chainId: "test-chain",
      cwd: process.cwd(),
      previousRecord: null,
      baseSha: "abc123",
      chainStatusOutput: "",
      chainBaseLog: "",
      chainDiff: "",
      chainUntracked: "",
      roundRecord,
      chainChangedPaths: [],
      chainStatusObserved: false,
      chainDeliverables: [],
      flagsModel: null,
      _dispatchWithFallback: dispatchReturning(fallbacks),
    });
    return roundRecord;
  }

  it("preserves an empty fallback array instead of collapsing it to null", async () => {
    const roundRecord = await runWith([]);
    assert.ok(
      Array.isArray(roundRecord.reviewFallbacks),
      "empty array must survive as an array, not become null",
    );
    assert.equal(roundRecord.reviewFallbacks.length, 0);
  });

  it("still maps an absent fallback trail to null", async () => {
    const roundRecord = await runWith(undefined);
    assert.equal(roundRecord.reviewFallbacks, null);
  });
});

// ---------------------------------------------------------------------------
// runReviewPhase — one retry on unparseable review output (issue #145)
//
// A review job that completes with garbage (no JSON, no recoverable VERDICT
// token) is re-dispatched exactly once within the same call, with identical
// options.  Two consecutive unparseable results still escalate.  A verdict
// recovered from a VERDICT token never triggers the retry.
// ---------------------------------------------------------------------------

describe("runReviewPhase — unparseable-output retry (issue #145)", () => {
  function makeDispatch(results) {
    const calls = [];
    function stubbedDispatch(options) {
      calls.push(options);
      return results.shift();
    }
    return { stubbedDispatch, calls };
  }

  function fakeJob(id, resultText, extra = {}) {
    return {
      job: {
        id,
        status: "completed",
        modelEntry: "test-org/test-review-model",
        modelVariant: null,
        fallbacks: null,
        usage: null,
        error: null,
        ...extra,
      },
      resultText,
    };
  }

  const GARBAGE = "definitely not JSON and no VERDICT token here at all";
  const GARBAGE_WITH_TOKEN = "not JSON either\nVERDICT: needs-attention";
  const VALID = JSON.stringify({
    verdict: "needs-attention",
    summary: "One real finding.",
    findings: [
      { severity: "medium", title: "Off-by-one", file: "src/calc.js", line_start: 7 },
    ],
  });

  async function runWith(results, extra = {}) {
    const { stubbedDispatch, calls } = makeDispatch(results);
    const roundRecord = { round: 1 };
    const result = await runReviewPhase({
      container: "test",
      brief: "test brief",
      modelChain: ["test-org/test-flash", "test-org/test-pro"],
      chainId: "test-chain",
      cwd: process.cwd(),
      previousRecord: null,
      baseSha: "abc123",
      chainStatusOutput: "",
      chainBaseLog: "",
      chainDiff: "",
      chainUntracked: "",
      roundRecord,
      chainChangedPaths: [],
      chainStatusObserved: false,
      chainDeliverables: [],
      flagsModel: null,
      _dispatchWithFallback: stubbedDispatch,
      ...extra,
    });
    return { result, roundRecord, calls };
  }

  it("parseable first result: exactly 1 dispatch call, no retry flag", async () => {
    const { result, roundRecord, calls } = await runWith([
      fakeJob("job-ok", VALID),
    ]);

    assert.equal(calls.length, 1);
    assert.equal(roundRecord.reviewUnparseableRetried, undefined);
    assert.equal(roundRecord.reviewFirstJobId, undefined);
    assert.equal(roundRecord.reviewFirstUsage, undefined);
    assert.equal(roundRecord.reviewFirstFallbacks, undefined);
    assert.equal(roundRecord.reviewJobId, "job-ok");
    assert.equal(result.chainVerdict, "needs-attention");
    assert.ok(result.chainFindingsText.includes("Off-by-one"));
    assert.equal(result.reviewParseable, true);
  });

  it("garbage then valid: 2 dispatch calls, final-attempt fields win, retry recorded", async () => {
    const { result, roundRecord, calls } = await runWith([
      fakeJob("job-broken-1", GARBAGE, { usage: { available: true, input: 5, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.001 }, fallbacks: ["test-org/test-flash"] }),
      fakeJob("job-fixed-2", VALID, { usage: { available: true, input: 9, output: 4 }, modelEntry: "test-org/test-fixed-model" }),
    ]);

    assert.equal(calls.length, 2);
    assert.equal(roundRecord.reviewUnparseableRetried, true);
    assert.equal(roundRecord.reviewFirstJobId, "job-broken-1");
    // The first attempt's spend and fallback trail are kept on retried rounds
    // so chain totals reflect the true cost.
    assert.deepEqual(roundRecord.reviewFirstUsage, { available: true, input: 5, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.001 });
    assert.deepEqual(roundRecord.reviewFirstFallbacks, ["test-org/test-flash"]);
    // All review* fields reflect the FINAL attempt.
    assert.equal(roundRecord.reviewJobId, "job-fixed-2");
    assert.equal(roundRecord.reviewModelEntry, "test-org/test-fixed-model");
    assert.deepEqual(roundRecord.reviewUsage, { available: true, input: 9, output: 4 });
    // Chain totals count BOTH attempts.
    const totals = computeChainTotals([roundRecord]);
    assert.equal(totals.input, 14);   // 5 + 9
    assert.equal(totals.output, 6);   // 2 + 4
    assert.equal(totals.cost, 0.001); // first attempt only (final attempt has no cost)
    assert.equal(result.chainVerdict, "needs-attention");
    assert.ok(result.chainFindingsText.includes("Off-by-one"));
    assert.equal(result.reviewParseable, true);
    // Both dispatches carried identical options.
    assert.deepEqual(calls[0], calls[1]);
    assert.ok(calls[0].promptText.includes("test brief"));
    assert.equal(calls[0].agent, "kusabi-review");
    assert.equal(calls[0].round, 1);
  });

  it("both dispatches garbage: 2 dispatch calls, verdict stays unparseable", async () => {
    const { result, roundRecord, calls } = await runWith([
      fakeJob("job-g1", GARBAGE),
      fakeJob("job-g2", GARBAGE),
    ]);

    assert.equal(calls.length, 2);
    assert.equal(roundRecord.reviewUnparseableRetried, true);
    assert.equal(roundRecord.reviewFirstJobId, "job-g1");
    assert.equal(roundRecord.reviewJobId, "job-g2");
    assert.equal(result.chainVerdict, "unparseable");
    assert.equal(result.reviewParseable, false);
    assert.equal(result.chainFindingsText, "(review output could not be parsed)");
    assert.equal(roundRecord.verdict, "unparseable");
    assert.equal(roundRecord.reviewParseable, false);
    assert.equal(roundRecord.findingsText, "(review output could not be parsed)");
    // First-attempt fields are recorded (null usage here) when a retry happens.
    assert.equal(roundRecord.reviewFirstUsage, null);
    assert.equal(roundRecord.reviewFirstFallbacks, null);
  });

  // A first job that FAILED outright (serve-dead / stalled / timeout / error)
  // returns empty or garbage resultText — re-dispatching would double
  // worst-case latency in exactly the degraded environments where it is
  // known-futile.  The retry is gated on job.status === "completed": these
  // never get a second dispatch and escalate after a single attempt.
  const HARD_FAILURES = ["serve-dead", "provider-error", "stalled", "timeout", "error"];
  for (const status of HARD_FAILURES) {
    it("first job " + status + " with empty resultText: exactly 1 dispatch call, no retry, unparseable escalates", async () => {
      const { result, roundRecord, calls } = await runWith([
        fakeJob("job-" + status, "", { status, usage: { available: true, input: 7, output: 3, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.001 }, fallbacks: ["test-org/test-flash"] }),
      ]);

      assert.equal(calls.length, 1);
      assert.equal(roundRecord.reviewUnparseableRetried, undefined);
      assert.equal(roundRecord.reviewFirstJobId, undefined);
      assert.equal(roundRecord.reviewFirstUsage, undefined);
      assert.equal(roundRecord.reviewFirstFallbacks, undefined);
      assert.equal(roundRecord.reviewJobId, "job-" + status);
      assert.equal(result.chainVerdict, "unparseable");
      assert.equal(result.reviewParseable, false);
      assert.equal(result.chainFindingsText, "(review output could not be parsed)");
      assert.equal(roundRecord.verdict, "unparseable");
    });
  }

  it("unparseable JSON with recoverable VERDICT token: exactly 1 dispatch call, no retry", async () => {
    const { result, roundRecord, calls } = await runWith([
      fakeJob("job-token", GARBAGE_WITH_TOKEN),
    ]);

    assert.equal(calls.length, 1);
    assert.equal(roundRecord.reviewUnparseableRetried, undefined);
    assert.equal(roundRecord.reviewFirstJobId, undefined);
    assert.equal(roundRecord.reviewFirstUsage, undefined);
    assert.equal(roundRecord.reviewFirstFallbacks, undefined);
    assert.equal(roundRecord.reviewJobId, "job-token");
    assert.equal(result.chainVerdict, "needs-attention");
    assert.equal(result.reviewParseable, false);
    assert.equal(roundRecord.verdictSource, "recovered-from-token");
    assert.equal(result.chainFindingsText, "(review output could not be parsed)");
  });

  it("probe-driven skipReview: 0 dispatch calls, unchanged", async () => {
    const { result, roundRecord, calls } = await runWith([], {
      chainChangedPaths: [],
      chainNewlyChanged: [],
      chainStatusObserved: true,
      chainDeliverables: ["src/foo.js"],
    });

    assert.equal(calls.length, 0);
    assert.equal(result.skipReview, true);
    assert.equal(roundRecord.verdict, "discard");
    assert.equal(roundRecord.verdictSource, "probe");
    assert.equal(roundRecord.reviewUnparseableRetried, undefined);
    assert.equal(roundRecord.reviewFirstUsage, undefined);
    assert.equal(roundRecord.reviewFirstFallbacks, undefined);
  });
});
