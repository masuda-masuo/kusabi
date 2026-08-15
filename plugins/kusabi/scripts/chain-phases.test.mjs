import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildImplementText,
  runImplementPhase,
  resolveReworkScope,
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
  captureVerifyBaseline,
  countVerifyViolations,
  countVerifyCollected,
  buildVerifyBaseline,
  runFrozenProbe,
  runCollectedProbe,
  summariseOracleViolations,
  runDeliverablesProbe,
  runProbePhase,
  runReviewPhase,
  renderProbeReport,
  runStrategizePhase,
  parseReviewResult,
  normalizeFilePath,
  hasRepeatedAreas,
  applyTierEscalation,
  recordReworkEscalation,
  persistChainState,
  writeReviewRecord,
  collectContainerBaseContext,
  readExecCapture,
  collectContainerReviewInput,
  assertContainerBaseRef,
  collectReviewContext,
  resolveChainResume,
  classifyReviewSeatReplacement,
  archiveFailedReviewSeat,
} from "./chain-phases.mjs";
import {
  createFakeCallTool,
  fakeCallToolForP1,
  fakeCallToolForP2,
  fakeCallToolForP3,
  fakeCallToolForP3WithBaseline,
} from "./fixtures.mjs";
import { renderPriorFindings } from "./render.mjs";
import { readJson } from "./state-paths.mjs";

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

  // ---- kusabi #173: verify-baseline tolerance for pre-existing lint/type debt ----

  // A lint-precondition failure whose counts mirror the real verify JSON
  // shape: gate_passed false, tests.status "skipped" (tests never ran), a
  // complete lint array, and the gate's summary in gate_fail_reasons.
  function preconditionStub({ lintCount, typesCount = 0 }) {
    const lint = [];
    for (let i = 0; i < lintCount; i++) {
      lint.push({ file: `/workspace/src/f${i}.py`, line: 1, rule: "no-unused-vars", message: "violation", severity: "error" });
    }
    const types = [];
    for (let i = 0; i < typesCount; i++) {
      types.push({ file: `/workspace/src/t${i}.py`, line: 1, message: "type error" });
    }
    const result = {
      gate_passed: false,
      lint,
      types,
      tests: { status: "skipped", message: "precondition gate failed; tests not run" },
      gate_fail_reasons: [],
    };
    if (lintCount > 0) result.gate_fail_reasons.push(`lint (eslint): ${lintCount} violation(s)`);
    if (typesCount > 0) result.gate_fail_reasons.push(`type_check (pyright): ${typesCount} error(s)`);
    return result;
  }

  // callTool stub: the first verify_in_container returns `first`; a second
  // call (the tolerated re-run) returns `retry`.  The params of each call are
  // recorded so tests can assert the skip flags actually sent.
  function stagedVerifyStub({ first, retry }) {
    const calls = [];
    const callTool = async (toolName, params) => {
      if (toolName !== "verify_in_container") return { output: "" };
      calls.push(params);
      return calls.length === 1 ? first : retry;
    };
    callTool.calls = calls;
    return callTool;
  }

  const baseline = { captured: true, gate_passed: false, lint: 190, types: 0, raw: {} };

  it("tolerates lint count at baseline and passes when the re-run's tests are green", async () => {
    const fakeTool = stagedVerifyStub({
      first: preconditionStub({ lintCount: 190 }),
      retry: { gate_passed: true, lint: [], types: [], tests: { full: { status: "ok", passed: 100, total: 100 } } },
    });
    const result = await runVerifyProbe({ callTool: fakeTool, container: "fake-cid", baseline });
    assert.equal(result.passed, true);
    assert.match(result.detail, /lint 190 \(baseline 190, tolerated\)/);
    assert.match(result.detail, /tests ok/);
    // The re-run carried the skip flag for the tolerated gate.
    assert.equal(fakeTool.calls.length, 2);
    assert.equal(fakeTool.calls[1].skip_lint_gate, true);
    assert.equal(fakeTool.calls[1].skip_type_gate, undefined);
  });

  it("tolerates counts below baseline (worker removed debt) and passes", async () => {
    const fakeTool = stagedVerifyStub({
      first: preconditionStub({ lintCount: 100 }),
      retry: { gate_passed: true, lint: [], types: [], tests: { full: { status: "ok", passed: 100, total: 100 } } },
    });
    const result = await runVerifyProbe({ callTool: fakeTool, container: "fake-cid", baseline });
    assert.equal(result.passed, true);
    assert.match(result.detail, /lint 100 \(baseline 190, tolerated\)/);
  });

  it("fails when lint count exceeds the baseline, naming the increment", async () => {
    const fakeTool = stagedVerifyStub({ first: preconditionStub({ lintCount: 193 }), retry: null });
    const result = await runVerifyProbe({ callTool: fakeTool, container: "fake-cid", baseline });
    assert.equal(result.passed, false);
    assert.match(result.detail, /lint 193 > baseline 190/);
    // No re-run was attempted.
    assert.equal(fakeTool.calls.length, 1);
  });

  it("tolerates types at baseline and passes", async () => {
    const typesBaseline = { captured: true, gate_passed: false, lint: 0, types: 7, raw: {} };
    const fakeTool = stagedVerifyStub({
      first: preconditionStub({ typesCount: 7 }),
      retry: { gate_passed: true, lint: [], types: [], tests: { full: { status: "ok", passed: 100, total: 100 } } },
    });
    const result = await runVerifyProbe({ callTool: fakeTool, container: "fake-cid", baseline: typesBaseline });
    assert.equal(result.passed, true);
    assert.match(result.detail, /types 7 \(baseline 7, tolerated\)/);
    assert.equal(fakeTool.calls[1].skip_type_gate, true);
  });

  it("fails when types exceed the baseline, naming the increment", async () => {
    const typesBaseline = { captured: true, gate_passed: false, lint: 0, types: 7, raw: {} };
    const fakeTool = stagedVerifyStub({ first: preconditionStub({ typesCount: 9 }), retry: null });
    const result = await runVerifyProbe({ callTool: fakeTool, container: "fake-cid", baseline: typesBaseline });
    assert.equal(result.passed, false);
    assert.match(result.detail, /types 9 > baseline 7/);
  });

  it("fails when the tolerated re-run's tests are not green (baseline never skips the test verdict)", async () => {
    const fakeTool = stagedVerifyStub({
      first: preconditionStub({ lintCount: 190 }),
      retry: {
        gate_passed: false,
        lint: [],
        types: [],
        tests: { full: { status: "failed", passed: 99, total: 100, failed: 1, failures: [{ test: "x", error: "boom" }] } },
        gate_fail_reasons: ["tests: 1 failure(s)"],
      },
    });
    const result = await runVerifyProbe({ callTool: fakeTool, container: "fake-cid", baseline });
    assert.equal(result.passed, false);
    assert.match(result.detail, /tests not ok/);
    assert.match(result.detail, /lint 190 \(baseline 190, tolerated\)/);
  });

  it("reports the real blocker when the tolerated re-run is still blocked before tests", async () => {
    // The re-run skipped the tolerated lint gate but a different,
    // untolerated precondition (patch_targets) still fails: tests never ran,
    // so the detail must NOT claim "tests not ok" — it names the blocker.
    const fakeTool = stagedVerifyStub({
      first: preconditionStub({ lintCount: 190 }),
      retry: {
        gate_passed: false,
        lint: [],
        types: [],
        tests: { status: "skipped", message: "precondition gate failed; tests not run" },
        gate_fail_reasons: ["patch_targets: 2 orphan test(s)"],
      },
    });
    const result = await runVerifyProbe({ callTool: fakeTool, container: "fake-cid", baseline });
    assert.equal(result.passed, false);
    assert.doesNotMatch(result.detail, /tests not ok/);
    assert.match(result.detail, /still blocked before tests \(patch_targets: 2 orphan test\(s\)\)/);
    assert.match(result.detail, /lint 190 \(baseline 190, tolerated\)/);
  });

  it("fails when tests ran and failed, even with a baseline (test verdict is authoritative)", async () => {
    // Real test-failure shape: tests.full present with a failed verdict.
    const fakeTool = async () => ({
      gate_passed: false,
      lint: [],
      types: [],
      tests: { full: { status: "failed", passed: 1, total: 2, failed: 1, failures: [{ test: "y", error: "boom" }] } },
      gate_fail_reasons: ["tests: 1 failure(s)"],
    });
    const result = await runVerifyProbe({ callTool: fakeTool, container: "fake-cid", baseline });
    assert.equal(result.passed, false);
  });

  it("fails strictly when no baseline is recorded, recording the limitation", async () => {
    const fakeTool = stagedVerifyStub({ first: preconditionStub({ lintCount: 190 }), retry: null });
    const result = await runVerifyProbe({ callTool: fakeTool, container: "fake-cid" });
    assert.equal(result.passed, false);
    assert.match(result.limitation, /no chain-start baseline/);
    // Strict: no re-run was attempted.
    assert.equal(fakeTool.calls.length, 1);
  });

  it("fails strictly when the baseline gate count is not a number (no reliable baseline count)", async () => {
    const badBaseline = { captured: true, gate_passed: false, lint: null, types: 0, raw: {} };
    const fakeTool = stagedVerifyStub({ first: preconditionStub({ lintCount: 5 }), retry: null });
    const result = await runVerifyProbe({ callTool: fakeTool, container: "fake-cid", baseline: badBaseline });
    assert.equal(result.passed, false);
    assert.match(result.limitation, /baseline has no reliable lint count/);
  });

  it("fails strictly when no violation counts are reportable in the response", async () => {
    // A precondition failure whose lint/types arrays and gate_fail_reasons are
    // all absent — no reliable count exists, so P2 must not pass blind.
    const fakeTool = async () => ({
      gate_passed: false,
      tests: { status: "skipped", message: "precondition gate failed; tests not run" },
    });
    const result = await runVerifyProbe({ callTool: fakeTool, container: "fake-cid", baseline });
    assert.equal(result.passed, false);
    assert.match(result.limitation, /no violation counts are reportable/);
  });

  it("counts from the gate_fail_reasons summary when the lint array is absent", async () => {
    const fakeTool = stagedVerifyStub({
      first: {
        gate_passed: false,
        tests: { status: "skipped", message: "precondition gate failed; tests not run" },
        gate_fail_reasons: ["lint (eslint): 190 violation(s)"],
      },
      retry: { gate_passed: true, lint: [], types: [], tests: { full: { status: "ok", passed: 1, total: 1 } } },
    });
    const result = await runVerifyProbe({ callTool: fakeTool, container: "fake-cid", baseline });
    assert.equal(result.passed, true);
    assert.match(result.detail, /lint 190 \(baseline 190, tolerated\)/);
  });
});

describe("countVerifyViolations", () => {
  it("counts array length for a gate", () => {
    assert.equal(
      countVerifyViolations({ lint: [{ rule: "no-unused-vars" }, { rule: "no-undef" }], types: [] }, "lint"),
      2,
    );
    assert.equal(
      countVerifyViolations({ lint: [], types: [{ message: "x" }] }, "types"),
      1,
    );
  });

  it("falls back to the gate_fail_reasons summary when the array is absent", () => {
    assert.equal(
      countVerifyViolations({ gate_fail_reasons: ["lint (eslint): 3 violation(s)"] }, "lint"),
      3,
    );
    assert.equal(
      countVerifyViolations({ gate_fail_reasons: ["type_check (pyright): 5 error(s)"] }, "types"),
      5,
    );
  });

  it("returns null when no count is derivable", () => {
    assert.equal(countVerifyViolations({}, "lint"), null);
    assert.equal(countVerifyViolations(null, "lint"), null);
  });
});

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

  it("quota-classified exhaustion shows the classification and NOT the generic retry advice (kusabi #215)", () => {
    const jobError = "claude dispatch failed: You've hit your session limit · resets 1:20am (Asia/Tokyo) — " +
      "session limit exhausted (resets 1:20am (Asia/Tokyo)): the whole claude backend is blocked, " +
      "including your own Claude Code session (same account window). Switch the phase to the opencode " +
      "backend (--model <provider>/<model>); do not retry claude.";
    const result = renderProviderExhaustedOutcome({
      chainId,
      round: 2,
      phase: "implement",
      jobError,
      records: [],
      jobFailure: {
        kind: "quota-exhaustion",
        quota: "session",
        backendBlocked: true,
        reset: "1:20am (Asia/Tokyo)",
      },
    });

    // The classified job error is the surface body.
    assert.ok(result.includes("implement provider exhausted"));
    assert.ok(result.includes("whole claude backend is blocked"));
    assert.ok(result.includes("do not retry claude"));
    // The generic capacity footer would CONTRADICT the classification
    // ("Retry when provider is available" is exactly wrong for a
    // session-limit block) — it must be gone.
    assert.ok(!result.includes("Retry when provider is available"));
    assert.ok(!result.includes("Capacity problem"));
    // The machine-readable classification is pointed at.
    assert.ok(result.includes("Quota exhaustion"));
  });

  it("unclassified exhaustion keeps the generic capacity footer byte-identical", () => {
    const result = renderProviderExhaustedOutcome({
      chainId,
      round: 2,
      phase: "implement",
      jobError: "All routes exhausted: route/a — rate_limit at attempt 3",
      records: [],
    });
    assert.ok(result.includes("Capacity problem — not a quality failure. Retry when provider is available."));
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

  it("chainState carries reviewModel / reviewModelChain verbatim (mixed-chain resume context)", () => {
    // persistChainState persists both; handleProviderExhaustion must too, or
    // an implement provider-exhaustion on a mixed chain loses the review
    // dispatch context and a later chain-resume falls back
    // reviewModelChain ?? modelChain — re-dispatching the review with the
    // implement's claude chain.
    const records = makeRecords([1]);
    const roundRecord = { round: 2, modelEntry: "provider/model-2" };

    const result = handleProviderExhaustion({
      records, roundRecord,
      currentTierIndex: 0,
      phase: "implement",
      jobError: "error detail",
      chainFollowupDraft: null,
      reviewModel: "deepseek/x",
      reviewModelChain: [["deepseek/x"]],
      ...baseState, round: 2,
    });

    assert.equal(result.chainState.reviewModel, "deepseek/x", "reviewModel persisted verbatim");
    assert.deepEqual(result.chainState.reviewModelChain, [["deepseek/x"]], "reviewModelChain persisted verbatim");
  });

  it("chainState without review context defaults both fields to null (never missing)", () => {
    // Key presence (even null) is what chain-resume reads to distinguish a
    // NEW chain from a legacy one — a missing key would silently re-enable
    // the legacy fallback on a chain that legitimately has no review context.
    const records = makeRecords([1]);
    const roundRecord = { round: 2, modelEntry: "provider/model-2" };

    const result = handleProviderExhaustion({
      records, roundRecord,
      currentTierIndex: 0,
      phase: "review",
      jobError: "error detail",
      chainFollowupDraft: null,
      ...baseState, round: 2,
    });

    assert.equal("reviewModel" in result.chainState, true, "reviewModel key always present");
    assert.equal(result.chainState.reviewModel, null);
    assert.equal("reviewModelChain" in result.chainState, true, "reviewModelChain key always present");
    assert.equal(result.chainState.reviewModelChain, null);
  });

  it("chainState carries reworkModel / reworkModelChain / reworkBackend verbatim (rework-round resume context)", () => {
    // persistChainState persists all three; handleProviderExhaustion must
    // too, or a rework implement provider-exhaustion loses the rework
    // dispatch context and a later chain-resume re-dispatches the rework
    // round on the implement resolution (wrong backend / wrong chain).
    const records = makeRecords([1]);
    const roundRecord = { round: 2, modelEntry: "provider/model-2" };

    const result = handleProviderExhaustion({
      records, roundRecord,
      currentTierIndex: 0,
      phase: "implement",
      jobError: "error detail",
      chainFollowupDraft: null,
      reworkModel: "deepseek-v4-flash",
      reworkModelChain: [["opencode-go/deepseek-v4-flash"]],
      reworkBackend: "opencode",
      ...baseState, round: 2,
    });

    assert.equal(result.chainState.reworkModel, "deepseek-v4-flash", "reworkModel persisted verbatim");
    assert.deepEqual(result.chainState.reworkModelChain, [["opencode-go/deepseek-v4-flash"]],
      "reworkModelChain persisted verbatim");
    assert.equal(result.chainState.reworkBackend, "opencode", "reworkBackend persisted verbatim");
  });

  it("chainState without rework context defaults all three rework fields to null (never missing)", () => {
    // Key presence (even null) is what chain-resume reads to distinguish a
    // NEW chain from a legacy one — a missing key would silently re-enable
    // the legacy fallback on a chain that legitimately has no rework context.
    const records = makeRecords([1]);
    const roundRecord = { round: 2, modelEntry: "provider/model-2" };

    const result = handleProviderExhaustion({
      records, roundRecord,
      currentTierIndex: 0,
      phase: "review",
      jobError: "error detail",
      chainFollowupDraft: null,
      ...baseState, round: 2,
    });

    assert.equal("reworkModel" in result.chainState, true, "reworkModel key always present");
    assert.equal(result.chainState.reworkModel, null);
    assert.equal("reworkModelChain" in result.chainState, true, "reworkModelChain key always present");
    assert.equal(result.chainState.reworkModelChain, null);
    assert.equal("reworkBackend" in result.chainState, true, "reworkBackend key always present");
    assert.equal(result.chainState.reworkBackend, null);
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

  // ---- structured failure classification (kusabi #215) ----

  it("threads a classified jobFailure into the outcome (classification shown, generic retry advice dropped)", () => {
    const records = makeRecords([1]);
    const roundRecord = { round: 2, modelEntry: "provider/model-2", verdict: null };

    const result = handleProviderExhaustion({
      records,
      roundRecord,
      currentTierIndex: 0,
      phase: "implement",
      jobError: "claude dispatch failed: You've hit your session limit · resets 1:20am (Asia/Tokyo) — " +
        "session limit exhausted: the whole claude backend is blocked; do not retry claude.",
      jobFailure: {
        kind: "quota-exhaustion",
        quota: "session",
        backendBlocked: true,
        reset: "1:20am (Asia/Tokyo)",
      },
      chainFollowupDraft: null,
      ...baseState,
    });

    assert.ok(result.outcome.includes("whole claude backend is blocked"));
    assert.ok(result.outcome.includes("do not retry claude"));
    assert.ok(!result.outcome.includes("Retry when provider is available"),
      "the generic capacity footer must not contradict the classification");
  });

  it("a null jobFailure keeps the generic outcome byte-identical", () => {
    const records = makeRecords([1]);
    const roundRecord = { round: 2, modelEntry: "provider/model-2", verdict: null };

    const result = handleProviderExhaustion({
      records,
      roundRecord,
      currentTierIndex: 0,
      phase: "implement",
      jobError: "All routes exhausted",
      jobFailure: null,
      chainFollowupDraft: null,
      ...baseState,
    });

    assert.ok(result.outcome.includes("All routes exhausted"));
    assert.ok(result.outcome.includes("Capacity problem — not a quality failure. Retry when provider is available."));
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

  // kusabi #153: a parseable review whose `findings` is a non-array (string /
  // object — e.g. a model responding to a broken review input) must not crash
  // with ".map is not a function"; it degrades to "(no structured findings)".
  it("tolerates a string findings field without crashing", () => {
    const payload = "```json\n{\n  \"verdict\": \"needs-attention\",\n  \"summary\": \"s\",\n  \"findings\": \"not an array\"\n}\n```";
    const result = parseReviewResult(payload);

    assert.equal(result.reviewParseable, true);
    assert.equal(result.chainVerdict, "needs-attention");
    assert.equal(result.chainFindingsText, "(no structured findings)");
    assert.deepEqual(result.chainParsedReview.findings, "not an array");
  });

  it("tolerates an object findings field without crashing", () => {
    const payload = "```json\n{\n  \"verdict\": \"approve\",\n  \"summary\": \"s\",\n  \"findings\": { \"file\": \"x.js\" }\n}\n```";
    const result = parseReviewResult(payload);

    assert.equal(result.reviewParseable, true);
    assert.equal(result.chainVerdict, "approve");
    assert.equal(result.chainFindingsText, "(no structured findings)");
  });

  // ---- kusabi #60 step 1: `kind` tagging ----
  // The `kind` tag flows through to the stored findings untouched; the
  // one-line findingsText is grouped (design first, mechanical after) with a
  // missing/invalid kind defaulting to design at the consumption point.

  it("carries kind through to the parsed findings and groups the findingsText", () => {
    const payload = "```json\n{\n  \"verdict\": \"needs-attention\",\n  \"summary\": \"s\",\n  \"findings\": [\n    { \"severity\": \"high\", \"title\": \"Design call\", \"file\": \"src/a.js\", \"line_start\": 1, \"kind\": \"design\" },\n    { \"severity\": \"low\", \"title\": \"Rename var\", \"file\": \"src/b.js\", \"line_start\": 2, \"kind\": \"mechanical\" }\n  ]\n}\n```";
    const result = parseReviewResult(payload);

    assert.equal(result.reviewParseable, true);
    // Raw kind tags survive on the parsed findings (stored untouched).
    assert.equal(result.chainParsedReview.findings[0].kind, "design");
    assert.equal(result.chainParsedReview.findings[1].kind, "mechanical");
    // Grouped one-line text: design section first, mechanical after.
    const text = result.chainFindingsText;
    const designIdx = text.indexOf("Design findings (require deliberate individual treatment)");
    const mechIdx = text.indexOf("Mechanical findings (checklist)");
    assert.ok(designIdx >= 0, text);
    assert.ok(mechIdx >= 0, text);
    assert.ok(designIdx < mechIdx, "design section must precede mechanical");
    assert.ok(text.indexOf("Design call") < text.indexOf("Rename var"));
    assert.ok(text.includes("[high] Design call (src/a.js:1)"));
    assert.ok(text.includes("[low] Rename var (src/b.js:2)"));
  });

  it("treats a missing kind as design (safe side) in the grouped findingsText", () => {
    const payload = "```json\n{\n  \"verdict\": \"needs-attention\",\n  \"summary\": \"s\",\n  \"findings\": [\n    { \"severity\": \"medium\", \"title\": \"No kind tag\", \"file\": \"src/c.js\", \"line_start\": 3 }\n  ]\n}\n```";
    const result = parseReviewResult(payload);

    assert.equal(result.reviewParseable, true);
    // Missing kind → design section, single section (no mechanical heading).
    const text = result.chainFindingsText;
    assert.ok(text.includes("Design findings (require deliberate individual treatment)"), text);
    assert.ok(!text.includes("Mechanical findings (checklist)"), text);
    assert.ok(text.includes("[medium] No kind tag (src/c.js:3)"));
  });

  it("treats an invalid kind as design (safe side) in the grouped findingsText", () => {
    const payload = "```json\n{\n  \"verdict\": \"needs-attention\",\n  \"summary\": \"s\",\n  \"findings\": [\n    { \"severity\": \"low\", \"title\": \"Weird kind\", \"file\": \"src/d.js\", \"line_start\": 4, \"kind\": \"cosmetic\" }\n  ]\n}\n```";
    const result = parseReviewResult(payload);

    assert.equal(result.reviewParseable, true);
    const text = result.chainFindingsText;
    assert.ok(text.includes("Design findings (require deliberate individual treatment)"), text);
    assert.ok(!text.includes("Mechanical findings (checklist)"), text);
    // The raw invalid value is not rewritten on the stored finding.
    assert.equal(result.chainParsedReview.findings[0].kind, "cosmetic");
  });

  it("keeps kind through the VERDICT-token recovery (extractJson) path", () => {
    // Real-world shape from the extractJson recovery path (#170): the token
    // sits inside the JSON fence and must be stripped before parsing.
    const payload = [
      "```json",
      "{",
      "  \"verdict\": \"needs-attention\",",
      "  \"summary\": \"s\",",
      "  \"findings\": [",
      "    { \"severity\": \"high\", \"title\": \"Recovered\", \"file\": \"src/e.js\", \"line_start\": 5, \"kind\": \"mechanical\" }",
      "  ]",
      "}",
      "```",
      "",
      "VERDICT: needs-attention",
    ].join("\n");
    const result = parseReviewResult(payload);

    assert.equal(result.reviewParseable, true);
    assert.equal(result.chainVerdict, "needs-attention");
    assert.equal(result.chainParsedReview.findings[0].kind, "mechanical");
    assert.ok(result.chainFindingsText.includes("Mechanical findings (checklist)"));
    assert.ok(result.chainFindingsText.includes("[high] Recovered (src/e.js:5)"));
  });
});

// =========================================================================
// parseReviewResult — JSONL input (kusabi #202)
//
// JSONL is a WIRE format: the records assemble into the same in-memory shape
// the single-object path produces.  The single-object path itself is
// unchanged, which the byte-identical findingsText assertion below pins down.
// =========================================================================

describe("parseReviewResult — JSONL review stream (kusabi #202)", () => {
  // One review, expressed both ways.  Shared so the equivalence assertion
  // cannot drift into comparing two different reviews.
  const DESIGN_FINDING = {
    severity: "high",
    kind: "design",
    title: "Retry spends the budget that just failed",
    body: "The retry re-dispatches with identical options.",
    file: "plugins/kusabi/scripts/chain-phases.mjs",
    line_start: 12,
    line_end: 18,
    confidence: 0.8,
    recommendation: "Gate the retry on the failure being transient.",
  };
  const MECHANICAL_FINDING = {
    severity: "low",
    kind: "mechanical",
    title: "Stale comment names the removed helper",
    body: "The comment refers to stripVerdict, deleted in #170.",
    file: "plugins/kusabi/scripts/render.mjs",
    line_start: 3,
    line_end: 3,
    confidence: 0.9,
    recommendation: "Delete the comment.",
  };
  const SUMMARY = "One real defect and one nit; do not ship as is.";
  const REVIEW_OBJECT = {
    verdict: "needs-attention",
    summary: SUMMARY,
    findings: [DESIGN_FINDING, MECHANICAL_FINDING],
    next_steps: ["add a truncation test"],
    unverified: ["could not exercise the timeout path"],
  };

  // The historical wire shape: fenced pretty-printed object + VERDICT token.
  const LEGACY_PAYLOAD = [
    "```json",
    JSON.stringify(REVIEW_OBJECT, null, 2),
    "```",
    "",
    "VERDICT: needs-attention",
  ].join("\n");

  // The same review as JSONL, emitted piece by piece.
  const JSONL_PAYLOAD = [
    JSON.stringify({ type: "finding", ...DESIGN_FINDING }),
    JSON.stringify({ type: "finding", ...MECHANICAL_FINDING }),
    JSON.stringify({ type: "unverified", text: "could not exercise the timeout path" }),
    JSON.stringify({ type: "next_step", text: "add a truncation test" }),
    JSON.stringify({ type: "verdict", verdict: "needs-attention", summary: SUMMARY }),
  ].join("\n");

  // The exact findingsText the single-object path produces today, spelled out
  // so a change to either path shows up as a diff on this literal.
  const EXPECTED_FINDINGS_TEXT = [
    "## Design findings (require deliberate individual treatment)",
    "",
    "[high] Retry spends the budget that just failed (plugins/kusabi/scripts/chain-phases.mjs:12)",
    "",
    "## Mechanical findings (checklist)",
    "",
    "[low] Stale comment names the removed helper (plugins/kusabi/scripts/render.mjs:3)",
  ].join("\n");

  it("assembles a JSONL stream into the shape the single-object path produces", () => {
    const jsonl = parseReviewResult(JSONL_PAYLOAD);
    const legacy = parseReviewResult(LEGACY_PAYLOAD);

    assert.deepEqual(jsonl.chainParsedReview, legacy.chainParsedReview);
    assert.equal(jsonl.chainFindingsText, legacy.chainFindingsText);
    assert.equal(jsonl.chainVerdict, legacy.chainVerdict);
    assert.equal(jsonl.reviewParseable, legacy.reviewParseable);
    // Spelled out, not just "equal to the other path":
    assert.deepEqual(jsonl.chainParsedReview, REVIEW_OBJECT);
    assert.equal(jsonl.chainVerdict, "needs-attention");
    assert.equal(jsonl.reviewParseable, true);
    assert.equal(jsonl.reviewPartial, false);
    assert.equal(jsonl.reviewFindingCount, 2);
  });

  it("keeps a single JSON object byte-identical (findingsText) to today", () => {
    const legacy = parseReviewResult(LEGACY_PAYLOAD);

    assert.equal(legacy.chainFindingsText, EXPECTED_FINDINGS_TEXT);
    assert.equal(legacy.chainVerdict, "needs-attention");
    assert.equal(legacy.reviewParseable, true);
    assert.equal(legacy.reviewPartial, false);
    // The JSONL path must reach exactly the same bytes.
    assert.equal(parseReviewResult(JSONL_PAYLOAD).chainFindingsText, EXPECTED_FINDINGS_TEXT);
  });

  it("keeps findings in emission order, not schema or severity order", () => {
    const reversed = [
      JSON.stringify({ type: "finding", ...MECHANICAL_FINDING }),
      JSON.stringify({ type: "finding", ...DESIGN_FINDING }),
      JSON.stringify({ type: "verdict", verdict: "needs-attention", summary: SUMMARY }),
    ].join("\n");

    const result = parseReviewResult(reversed);

    assert.deepEqual(
      result.chainParsedReview.findings.map(function (f) { return f.title; }),
      [MECHANICAL_FINDING.title, DESIGN_FINDING.title],
    );
  });

  it("ignores prose interleaved between records", () => {
    const narrated = [
      "Checklist point 1 — retry semantics. Reading chain-phases.mjs now.",
      JSON.stringify({ type: "finding", ...DESIGN_FINDING }),
      "Point 2 — comments. One is stale:",
      JSON.stringify({ type: "finding", ...MECHANICAL_FINDING }),
      JSON.stringify({ type: "unverified", text: "could not exercise the timeout path" }),
      "Nothing else I can defend from the diff.",
      JSON.stringify({ type: "next_step", text: "add a truncation test" }),
      JSON.stringify({ type: "verdict", verdict: "needs-attention", summary: SUMMARY }),
    ].join("\n");

    const result = parseReviewResult(narrated);

    assert.deepEqual(result.chainParsedReview, REVIEW_OBJECT);
    assert.equal(result.chainFindingsText, EXPECTED_FINDINGS_TEXT);
  });

  it("a stream truncated after the findings is a partial review carrying them", () => {
    const truncated = [
      JSON.stringify({ type: "finding", ...DESIGN_FINDING }),
      JSON.stringify({ type: "finding", ...MECHANICAL_FINDING }),
      "Point 3 — I still need to check the empty-strea",
    ].join("\n");

    const result = parseReviewResult(truncated);

    assert.equal(result.chainVerdict, "partial");
    assert.equal(result.reviewPartial, true);
    assert.equal(result.reviewFindingCount, 2);
    // Partial is NOT unparseable: we read the output fine, so the review is
    // parseable and the docs/design/phase-chain.md §3.5 retry (gated on
    // "unparseable") cannot fire.
    assert.equal(result.reviewParseable, true);
    assert.notEqual(result.chainVerdict, "unparseable");
    // The findings it did carry are rendered like any other findings.
    assert.equal(result.chainFindingsText, EXPECTED_FINDINGS_TEXT);
    assert.deepEqual(result.chainParsedReview.findings, [DESIGN_FINDING, MECHANICAL_FINDING]);
    assert.equal(result.chainParsedReview.verdict, "partial");
    assert.match(result.chainParsedReview.summary, /partial review/);
    assert.match(result.chainParsedReview.summary, /2 findings/);
  });

  it("a stream with a verdict line yields that verdict and is not partial", () => {
    for (const verdict of ["approve", "approve-partial", "needs-attention", "discard"]) {
      const stream = [
        JSON.stringify({ type: "finding", ...MECHANICAL_FINDING }),
        JSON.stringify({ type: "verdict", verdict, summary: "s" }),
      ].join("\n");

      const result = parseReviewResult(stream);

      assert.equal(result.chainVerdict, verdict);
      assert.equal(result.reviewPartial, false);
      assert.equal(result.reviewParseable, true);
    }
  });

  it("a malformed line among valid ones costs only that line", () => {
    const stream = [
      JSON.stringify({ type: "finding", ...DESIGN_FINDING }),
      '{"type":"finding","severity":"high",,,"title":"broken record"}',
      JSON.stringify({ type: "finding", ...MECHANICAL_FINDING }),
      JSON.stringify({ type: "unverified", text: "could not exercise the timeout path" }),
      JSON.stringify({ type: "next_step", text: "add a truncation test" }),
      JSON.stringify({ type: "verdict", verdict: "needs-attention", summary: SUMMARY }),
    ].join("\n");

    const result = parseReviewResult(stream);

    // Identical to the clean stream: the broken line took nothing with it.
    assert.deepEqual(result.chainParsedReview, REVIEW_OBJECT);
    assert.equal(result.chainFindingsText, EXPECTED_FINDINGS_TEXT);
    assert.equal(result.reviewFindingCount, 2);
  });

  it("an empty or whitespace-only stream is the existing unparseable state, not a crash", () => {
    for (const payload of ["", "   ", "\n\n \n"]) {
      const result = parseReviewResult(payload);

      assert.equal(result.chainVerdict, "unparseable");
      assert.equal(result.reviewParseable, false);
      assert.equal(result.reviewPartial, false);
      assert.equal(result.chainParsedReview, null);
      assert.equal(result.chainFindingsText, "(review output could not be parsed)");
    }
  });

  it("a JSONL stream with no findings and a verdict is an ordinary review", () => {
    const stream = JSON.stringify({ type: "verdict", verdict: "approve", summary: "Nothing to block on." });

    const result = parseReviewResult(stream);

    assert.equal(result.chainVerdict, "approve");
    assert.equal(result.reviewPartial, false);
    assert.equal(result.chainFindingsText, "(no structured findings)");
    assert.deepEqual(result.chainParsedReview, {
      verdict: "approve", summary: "Nothing to block on.", findings: [], next_steps: [],
    });
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
        const cmd = params.commands[0];
        commands.push(cmd);
        if (throwOn && cmd.startsWith(throwOn)) throw new Error("container is gone");
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
      const cmd = params.commands[0];
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
      const cmd = params.commands[0];
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
// runReviewPhase \u2014 single result conduit (kusabi #100)
//
// runReviewPhase writes every value that belongs on the persisted round
// record onto `roundRecord` and returns ONLY what is genuinely not record
// state.  This pins the chosen direction (b): the record fields are the
// contract, and the return key set must stay exactly the non-record set \u2014
// so a future refactor cannot silently reintroduce the double write.
// ---------------------------------------------------------------------------

describe("runReviewPhase \u2014 single result conduit (kusabi #100)", () => {
  function stubbedDispatch() {
    return {
      job: {
        id: "job-1",
        status: "completed",
        modelEntry: "test-org/test-review-model:variant",
        modelVariant: "variant",
        fallbacks: null,
        usage: { available: true, input: 3, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
        error: null,
      },
      resultText: JSON.stringify({
        verdict: "needs-attention",
        summary: "s",
        findings: [
          { severity: "high", title: "Design call", file: "src/a.js", line_start: 1, kind: "design" },
          { severity: "low", title: "Rename", file: "src/b.js", line_start: 2, kind: "mechanical" },
        ],
      }),
    };
  }

  async function runPhase(roundRecord, extra = {}) {
    return runReviewPhase({
      container: "test",
      brief: "test brief",
      modelChain: ["test-org/test-flash", "test-org/test-pro"],
      chainId: "test-chain",
      cwd: process.cwd(),
      previousRecord: null,
      baseSha: "abc123",
      chainStatusOutput: "",
      chainBaseLog: "",
      chainUntracked: "",
      roundRecord,
      chainChangedPaths: [],
      chainStatusObserved: false,
      chainDeliverables: [],
      flagsModel: null,
      _dispatchWithFallback: stubbedDispatch,
      ...extra,
    });
  }

  it("persists every record field onto roundRecord after a simulated review phase", async () => {
    const roundRecord = { round: 1 };
    await runPhase(roundRecord);

    // --- record fields (the persisted contract) ---
    assert.equal(roundRecord.verdict, "needs-attention");
    assert.equal(roundRecord.reviewParseable, true);
    assert.equal(roundRecord.reviewJobId, "job-1");
    assert.equal(roundRecord.reviewModelEntry, "test-org/test-review-model:variant");
    assert.equal(roundRecord.reviewModelVariant, "variant");
    assert.equal(roundRecord.reviewFallbacks, null);
    assert.equal(roundRecord.reviewUsage.available, true);
    // Raw findings (with kind tags) land on the record untouched.
    assert.equal(roundRecord.findings.length, 2);
    assert.equal(roundRecord.findings[0].kind, "design");
    assert.equal(roundRecord.findings[1].kind, "mechanical");
    assert.deepEqual(roundRecord.findingFiles, ["src/a.js", "src/b.js"]);
    // Grouped findingsText (design section first).
    assert.ok(roundRecord.findingsText.includes("Design findings (require deliberate individual treatment)"));
    assert.ok(roundRecord.findingsText.includes("Mechanical findings (checklist)"));
  });

  it("returns exactly the non-record keys (single conduit)", async () => {
    const roundRecord = { round: 1 };
    const result = await runPhase(roundRecord);
    assert.deepEqual(
      Object.keys(result).sort(),
      ["chainParsedReview", "chainRepeatedAreas", "reviewJobError", "reviewJobStatus", "skipReview"],
    );
    assert.equal(result.chainParsedReview.findings[0].kind, "design");
    assert.equal(result.chainRepeatedAreas, false);
    assert.equal(result.skipReview, false);
    assert.equal(result.reviewJobStatus, "completed");
  });

  it("record-derived values reach the disposition inputs from roundRecord, not the return", async () => {
    const roundRecord = { round: 1 };
    const result = await runPhase(roundRecord);
    // The disposition phase reads verdict / findingsText from the record
    // (caller does `const chainVerdict = roundRecord.verdict`), and the
    // return must not shadow them with a second conduit.
    assert.equal(Object.hasOwn(result, "chainVerdict"), false);
    assert.equal(Object.hasOwn(result, "chainFindingsText"), false);
    assert.equal(Object.hasOwn(result, "reviewParseable"), false);
    assert.equal(roundRecord.verdict, "needs-attention");
    assert.ok(roundRecord.findingsText.includes("[high] Design call (src/a.js:1)"));
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
    const { roundRecord, calls } = await runWith([
      fakeJob("job-ok", VALID),
    ]);

    assert.equal(calls.length, 1);
    assert.equal(roundRecord.reviewUnparseableRetried, undefined);
    assert.equal(roundRecord.reviewFirstJobId, undefined);
    assert.equal(roundRecord.reviewFirstUsage, undefined);
    assert.equal(roundRecord.reviewFirstFallbacks, undefined);
    assert.equal(roundRecord.reviewJobId, "job-ok");
    assert.equal(roundRecord.verdict, "needs-attention");
    assert.ok(roundRecord.findingsText.includes("Off-by-one"));
    assert.equal(roundRecord.reviewParseable, true);
  });

  it("garbage then valid: 2 dispatch calls, final-attempt fields win, retry recorded", async () => {
    const { roundRecord, calls } = await runWith([
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
    assert.equal(roundRecord.verdict, "needs-attention");
    assert.ok(roundRecord.findingsText.includes("Off-by-one"));
    assert.equal(roundRecord.reviewParseable, true);
    // Both dispatches carried identical options.
    assert.deepEqual(calls[0], calls[1]);
    assert.ok(calls[0].promptText.includes("test brief"));
    assert.equal(calls[0].agent, "kusabi-review");
    assert.equal(calls[0].round, 1);
  });

  it("both dispatches garbage: 2 dispatch calls, verdict stays unparseable", async () => {
    const { roundRecord, calls } = await runWith([
      fakeJob("job-g1", GARBAGE),
      fakeJob("job-g2", GARBAGE),
    ]);

    assert.equal(calls.length, 2);
    assert.equal(roundRecord.reviewUnparseableRetried, true);
    assert.equal(roundRecord.reviewFirstJobId, "job-g1");
    assert.equal(roundRecord.reviewJobId, "job-g2");
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
      const { roundRecord, calls } = await runWith([
        fakeJob("job-" + status, "", { status, usage: { available: true, input: 7, output: 3, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.001 }, fallbacks: ["test-org/test-flash"] }),
      ]);

      assert.equal(calls.length, 1);
      assert.equal(roundRecord.reviewUnparseableRetried, undefined);
      assert.equal(roundRecord.reviewFirstJobId, undefined);
      assert.equal(roundRecord.reviewFirstUsage, undefined);
      assert.equal(roundRecord.reviewFirstFallbacks, undefined);
      assert.equal(roundRecord.reviewJobId, "job-" + status);
      assert.equal(roundRecord.verdict, "unparseable");
      assert.equal(roundRecord.reviewParseable, false);
      assert.equal(roundRecord.findingsText, "(review output could not be parsed)");
    });
  }

  it("unparseable JSON with recoverable VERDICT token: exactly 1 dispatch call, no retry", async () => {
    const { roundRecord, calls } = await runWith([
      fakeJob("job-token", GARBAGE_WITH_TOKEN),
    ]);

    assert.equal(calls.length, 1);
    assert.equal(roundRecord.reviewUnparseableRetried, undefined);
    assert.equal(roundRecord.reviewFirstJobId, undefined);
    assert.equal(roundRecord.reviewFirstUsage, undefined);
    assert.equal(roundRecord.reviewFirstFallbacks, undefined);
    assert.equal(roundRecord.reviewJobId, "job-token");
    assert.equal(roundRecord.verdict, "needs-attention");
    assert.equal(roundRecord.reviewParseable, false);
    assert.equal(roundRecord.verdictSource, "recovered-from-token");
    assert.equal(roundRecord.findingsText, "(review output could not be parsed)");
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

// =========================================================================
// runReviewPhase — partial JSONL review (kusabi #202)
//
// A JSONL stream with findings but no verdict line is a partial review.  It
// must NOT trigger the unparseable retry (#145): the output was read fine,
// the model ran out of room, and re-dispatching spends the budget that just
// proved insufficient.  The round record has to show that it was partial and
// how many findings it carried.
// =========================================================================

describe("runReviewPhase — partial JSONL review (kusabi #202)", () => {
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
        id, status: "completed", modelEntry: "test-org/test-review-model",
        modelVariant: null, fallbacks: null, usage: null, error: null, ...extra,
      },
      resultText,
    };
  }

  const FINDING_1 = {
    type: "finding", severity: "high", kind: "design", title: "Unbounded retry",
    body: "b", file: "src/a.mjs", line_start: 12, line_end: 18,
    confidence: 0.8, recommendation: "r",
  };
  const FINDING_2 = {
    type: "finding", severity: "low", kind: "mechanical", title: "Stale comment",
    body: "b", file: "src/b.mjs", line_start: 3, line_end: 3,
    confidence: 0.9, recommendation: "r",
  };

  // Two findings emitted, then the stream stops mid-thought.
  const TRUNCATED = [
    "Checklist point 1 — retry semantics:",
    JSON.stringify(FINDING_1),
    "Point 2 — comments:",
    JSON.stringify(FINDING_2),
    "Point 3 — I still need to check the empty-st",
  ].join("\n");

  const COMPLETE = [
    JSON.stringify(FINDING_1),
    JSON.stringify({ type: "verdict", verdict: "needs-attention", summary: "One defect." }),
  ].join("\n");

  async function runWith(results, extra = {}) {
    const { stubbedDispatch, calls } = makeDispatch(results);
    const roundRecord = { round: 1 };
    const result = await runReviewPhase({
      container: "test", brief: "test brief",
      modelChain: ["test-org/test-flash", "test-org/test-pro"],
      chainId: "test-chain", cwd: process.cwd(), previousRecord: null,
      baseSha: "abc123", chainStatusOutput: "", chainBaseLog: "",
      chainUntracked: "", roundRecord, chainChangedPaths: [],
      chainStatusObserved: false, chainDeliverables: [], flagsModel: null,
      _dispatchWithFallback: stubbedDispatch, ...extra,
    });
    return { result, roundRecord, calls };
  }

  it("records partial with its finding count and does NOT retry", async () => {
    const { result, roundRecord, calls } = await runWith([
      fakeJob("job-truncated", TRUNCATED),
    ]);

    // The retry (#145) is for output we could not read.  Not this.
    assert.equal(calls.length, 1);
    assert.equal(roundRecord.reviewUnparseableRetried, undefined);
    assert.equal(roundRecord.reviewFirstJobId, undefined);

    assert.equal(roundRecord.verdict, "partial");
    assert.equal(roundRecord.reviewParseable, true);
    assert.equal(roundRecord.reviewPartial, true);
    assert.equal(roundRecord.reviewFindingCount, 2);
    // Not a token recovery — the stream was genuinely parsed.
    assert.equal(roundRecord.verdictSource, undefined);

    // The findings survive and are recorded/rendered like any others.
    assert.equal(roundRecord.findings.length, 2);
    assert.deepEqual(
      roundRecord.findings.map(function (f) { return f.title; }),
      ["Unbounded retry", "Stale comment"],
    );
    assert.deepEqual(roundRecord.findingFiles, ["src/a.mjs", "src/b.mjs"]);
    assert.ok(roundRecord.findingsText.includes("[high] Unbounded retry (src/a.mjs:12)"));
    assert.ok(roundRecord.findingsText.includes("[low] Stale comment (src/b.mjs:3)"));
    assert.equal(result.chainParsedReview.verdict, "partial");
    assert.equal(result.skipReview, false);
  });

  // What the chain then DOES with verdict "partial" (escalate, never accept)
  // is deriveDisposition's decision and is asserted in disposition.test.mjs.

  it("a complete JSONL stream records its verdict and is not marked partial", async () => {
    const { roundRecord, calls } = await runWith([
      fakeJob("job-complete", COMPLETE),
    ]);

    assert.equal(calls.length, 1);
    assert.equal(roundRecord.verdict, "needs-attention");
    assert.equal(roundRecord.reviewParseable, true);
    assert.equal(roundRecord.reviewPartial, undefined);
    assert.equal(roundRecord.reviewFindingCount, undefined);
    assert.equal(roundRecord.findings.length, 1);
  });

  it("a garbage first attempt that retries into a partial stream stays partial", async () => {
    const { roundRecord, calls } = await runWith([
      fakeJob("job-garbage", "definitely not JSON and no VERDICT token here"),
      fakeJob("job-truncated", TRUNCATED),
    ]);

    // The first attempt was unreadable, so the retry fires as before; the
    // second attempt is readable but incomplete, so the round is partial.
    assert.equal(calls.length, 2);
    assert.equal(roundRecord.reviewUnparseableRetried, true);
    assert.equal(roundRecord.reviewFirstJobId, "job-garbage");
    assert.equal(roundRecord.reviewJobId, "job-truncated");
    assert.equal(roundRecord.verdict, "partial");
    assert.equal(roundRecord.reviewPartial, true);
    assert.equal(roundRecord.reviewFindingCount, 2);
  });
});

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
// resolveChainResume — resume-position decision (kusabi #153①)
// =========================================================================

describe("resolveChainResume", () => {
  function baseChainJson(overrides = {}) {
    return {
      chainId: "chain-test",
      container: "cid-1",
      model: "fake/model",
      modelChain: [["fake/model"], ["fake/pro"]],
      maxRounds: 4,
      brief: "Implement X.",
      orchestrator: null,
      records: [],
      baseSha: "abc123",
      chainTotals: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      strategized: false,
      followupIssueDraft: null,
      ...overrides,
    };
  }

  function partialRound(overrides = {}) {
    return {
      round: 3,
      resumeMethod: { type: "continue_session" },
      startedAt: "2026-08-01T00:00:00.000Z",
      verdict: null,
      probesGreen: true,
      modelEntry: "fake/model",
      implementJobId: "job-imp-3",
      sessionID: "sess-3",
      implementUsage: null,
      tierBefore: 1,
      reworkStrategyReason: null,
      reworkCount: 2,
      probeResults: [],
      worktreeChanged: true,
      interrupted: true,
      interruptedAfter: "probes",
      ...overrides,
    };
  }

  it("errors when the control record is missing", () => {
    const result = resolveChainResume({ control: null, chainJson: baseChainJson() });
    assert.equal(result.ok, false);
    assert.match(result.error, /no control record/);
  });

  it("errors when chain.json is missing", () => {
    const result = resolveChainResume({ control: { status: "cancelled" }, chainJson: null });
    assert.equal(result.ok, false);
    assert.match(result.error, /no chain\.json/);
  });

  it("errors for a running chain (live pid)", () => {
    const control = {
      chainId: "chain-test", container: "cid-1", pid: process.pid,
      status: "running", round: 2, startedAt: new Date().toISOString(),
    };
    const result = resolveChainResume({ control, chainJson: baseChainJson() });
    assert.equal(result.ok, false);
    assert.match(result.error, /still running/);
  });

  it("errors for a stopping chain (stop requested, live pid)", () => {
    const control = {
      chainId: "chain-test", container: "cid-1", pid: process.pid,
      status: "running", round: 2, startedAt: new Date().toISOString(),
      stopRequestedAt: new Date().toISOString(), stopRequestedBy: "cli",
    };
    const result = resolveChainResume({ control, chainJson: baseChainJson() });
    assert.equal(result.ok, false);
    assert.match(result.error, /still running/);
  });

  it("errors for a completed chain", () => {
    const control = {
      chainId: "chain-test", container: "cid-1", pid: 0,
      status: "completed", round: 2, finishedAt: new Date().toISOString(),
    };
    const result = resolveChainResume({ control, chainJson: baseChainJson() });
    assert.equal(result.ok, false);
    assert.match(result.error, /already finished/);
  });

  it("errors for a failed chain", () => {
    const control = {
      chainId: "chain-test", container: "cid-1", pid: 0,
      status: "failed", round: 2, finishedAt: new Date().toISOString(),
    };
    const result = resolveChainResume({ control, chainJson: baseChainJson() });
    assert.equal(result.ok, false);
    assert.match(result.error, /already finished/);
  });

  it("treats a running record with a dead pid as resumable (abnormal stop)", () => {
    const control = {
      chainId: "chain-test", container: "cid-1", pid: 0, // dead
      status: "running", round: 2,
    };
    const chainJson = baseChainJson({ records: [partialRound()] });
    const result = resolveChainResume({ control, chainJson });
    assert.equal(result.ok, true);
    assert.equal(result.position.phase, "review");
  });

  it("resumes at the review phase of the interrupted round, carrying its context", () => {
    const control = {
      chainId: "chain-test", container: "cid-1", pid: 0,
      status: "cancelled", round: 3, finishedAt: new Date().toISOString(),
    };
    const partial = partialRound();
    const chainJson = baseChainJson({ records: [partial], strategized: true });
    const result = resolveChainResume({ control, chainJson });

    assert.equal(result.ok, true);
    const p = result.position;
    assert.equal(p.phase, "review");
    assert.equal(p.round, 3);
    assert.equal(p.roundRecord, partial);
    assert.equal(p.reworkCount, 2);           // carried, not incremented
    assert.equal(p.currentTierIndex, 1);      // from tierBefore
    assert.equal(p.strategized, true);
    assert.equal(p.session, "sess-3");
    assert.equal(p.baseSha, "abc123");
  });

  it("resumes at the next round's implement after a rework disposition, with escalated tier and rework count", () => {
    const control = {
      chainId: "chain-test", container: "cid-1", pid: 0,
      status: "cancelled", round: 2, finishedAt: new Date().toISOString(),
    };
    const complete = {
      round: 2,
      implementJobId: "job-imp-2",
      reviewJobId: "job-rev-2",
      verdict: "needs-attention",
      findingsText: "fix it",
      sessionID: "sess-2",
      tierBefore: 0,
      tierAfter: 1,
      reworkCount: 1,
      pendingReworkStrategy: { tierDelta: 1, newSession: true, reason: "2nd rework: escalate tier" },
      disposition: { disposition: "rework", reason: "needs-attention" },
    };
    const chainJson = baseChainJson({ records: [complete] });
    const result = resolveChainResume({ control, chainJson });

    assert.equal(result.ok, true);
    const p = result.position;
    assert.equal(p.phase, "implement");
    assert.equal(p.round, 3);
    assert.equal(p.roundRecord, null);
    assert.equal(p.reworkCount, 2);        // 1 + the consumed rework
    assert.equal(p.currentTierIndex, 1);   // tierAfter carried
    assert.equal(p.session, "sess-2");
  });

  it("does not consume a rework after a strategize disposition", () => {
    const control = {
      chainId: "chain-test", container: "cid-1", pid: 0,
      status: "cancelled", round: 2, finishedAt: new Date().toISOString(),
    };
    const complete = {
      round: 2,
      implementJobId: "job-imp-2",
      reviewJobId: "job-rev-2",
      verdict: "needs-attention",
      sessionID: "sess-2",
      tierBefore: 1,
      tierAfter: 1,
      reworkCount: 1,
      pendingReworkStrategy: { tierDelta: 0, newSession: true, reason: "strategized: new session" },
      disposition: { disposition: "strategize", reason: "same file area flagged twice" },
    };
    const chainJson = baseChainJson({ records: [complete], strategized: true });
    const result = resolveChainResume({ control, chainJson });

    assert.equal(result.ok, true);
    assert.equal(result.position.phase, "implement");
    assert.equal(result.position.round, 3);
    assert.equal(result.position.reworkCount, 1); // strategize consumed none
    assert.equal(result.position.currentTierIndex, 1);
  });

  it("errors for a cancelled chain whose last round was accepted", () => {
    const control = { chainId: "chain-test", container: "cid-1", pid: 0, status: "cancelled", round: 2 };
    const complete = {
      round: 2,
      implementJobId: "job-imp-2",
      reviewJobId: "job-rev-2",
      verdict: "approve",
      disposition: { disposition: "accept" },
    };
    const result = resolveChainResume({ control, chainJson: baseChainJson({ records: [complete] }) });
    assert.equal(result.ok, false);
    assert.match(result.error, /already finished/);
  });

  it("errors for a cancelled chain whose last round escalated", () => {
    const control = { chainId: "chain-test", container: "cid-1", pid: 0, status: "cancelled", round: 2 };
    const complete = {
      round: 2,
      implementJobId: "job-imp-2",
      reviewJobId: "job-rev-2",
      verdict: "discard",
      disposition: { disposition: "escalate" },
    };
    const result = resolveChainResume({ control, chainJson: baseChainJson({ records: [complete] }) });
    assert.equal(result.ok, false);
    assert.match(result.error, /already finished/);
  });

  it("errors when there are no round records at all", () => {
    const control = { chainId: "chain-test", container: "cid-1", pid: 0, status: "cancelled", round: 0 };
    const result = resolveChainResume({ control, chainJson: baseChainJson() });
    assert.equal(result.ok, false);
    assert.match(result.error, /no round records to resume from/);
  });

  it("errors for a record with no implement job (no phase boundary)", () => {
    const control = { chainId: "chain-test", container: "cid-1", pid: 0, status: "cancelled", round: 3 };
    const broken = { round: 3, verdict: null, interrupted: true };
    const result = resolveChainResume({ control, chainJson: baseChainJson({ records: [broken] }) });
    assert.equal(result.ok, false);
    assert.match(result.error, /no implement job/);
  });

  it("errors for an inconsistent record (review present, no disposition)", () => {
    const control = { chainId: "chain-test", container: "cid-1", pid: 0, status: "cancelled", round: 3 };
    const broken = { round: 3, implementJobId: "job-3", reviewJobId: "job-rev-3", verdict: "approve" };
    const result = resolveChainResume({ control, chainJson: baseChainJson({ records: [broken] }) });
    assert.equal(result.ok, false);
    assert.match(result.error, /inconsistent/);
  });

  it("errors when rework would exceed maxRounds", () => {
    const control = { chainId: "chain-test", container: "cid-1", pid: 0, status: "cancelled", round: 4 };
    const complete = {
      round: 4,
      implementJobId: "job-imp-4",
      reviewJobId: "job-rev-4",
      verdict: "needs-attention",
      tierBefore: 1,
      tierAfter: 1,
      reworkCount: 2,
      disposition: { disposition: "rework", reason: "needs-attention" },
    };
    const result = resolveChainResume({ control, chainJson: baseChainJson({ records: [complete], maxRounds: 4 }) });
    assert.equal(result.ok, false);
    assert.match(result.error, /max rounds \(4\) already reached/);
  });

  // kusabi #60 step 2: the resume gate mirrors the driver's budget semantics.
  // The raw round number may exceed maxRounds when mechanical rounds ran for
  // free; resume is refused only when the derived budget is spent or the
  // 2 × maxRounds hard cap would be exceeded.
  it("allows resume when mechanical rounds pushed the round number past maxRounds but budget remains", () => {
    const control = { chainId: "chain-test", container: "cid-1", pid: 0, status: "cancelled", round: 2 };
    const reworkRecord = (round, reworkScope) => ({
      round,
      reworkScope,
      implementJobId: "job-imp-" + round,
      reviewJobId: "job-rev-" + round,
      verdict: "needs-attention",
      disposition: { disposition: "rework", reason: "needs-attention" },
    });
    const result = resolveChainResume({
      control,
      chainJson: baseChainJson({
        records: [reworkRecord(1, "full"), reworkRecord(2, "mechanical")],
        maxRounds: 2,
      }),
    });
    // Round 2 is the last completed round (nextRound 3 > maxRounds 2), but
    // only round 1 consumed budget (1 < 2) and 3 ≤ 2 × 2 — resume is valid.
    assert.equal(result.ok, true);
    assert.equal(result.position.phase, "implement");
    assert.equal(result.position.round, 3);
    assert.equal(result.position.records.length, 2);
  });

  it("refuses resume when the derived budget is spent even while rounds remain under the hard cap", () => {
    const control = { chainId: "chain-test", container: "cid-1", pid: 0, status: "cancelled", round: 3 };
    const reworkRecord = (round) => ({
      round,
      reworkScope: "full",
      implementJobId: "job-imp-" + round,
      reviewJobId: "job-rev-" + round,
      verdict: "needs-attention",
      disposition: { disposition: "rework", reason: "needs-attention" },
    });
    const result = resolveChainResume({
      control,
      chainJson: baseChainJson({ records: [1, 2, 3].map(reworkRecord), maxRounds: 3 }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /max rounds \(3\) already reached/);
  });

  it("refuses resume when the 2 × maxRounds hard cap would be exceeded even with budget remaining", () => {
    const control = { chainId: "chain-test", container: "cid-1", pid: 0, status: "cancelled", round: 4 };
    const reworkRecord = (round, reworkScope) => ({
      round,
      reworkScope,
      implementJobId: "job-imp-" + round,
      reviewJobId: "job-rev-" + round,
      verdict: "needs-attention",
      disposition: { disposition: "rework", reason: "needs-attention" },
    });
    const result = resolveChainResume({
      control,
      chainJson: baseChainJson({
        records: [
          reworkRecord(1, "full"),
          reworkRecord(2, "mechanical"),
          reworkRecord(3, "mechanical"),
          reworkRecord(4, "mechanical"),
        ],
        maxRounds: 2,
      }),
    });
    // Budget 1 < 2 remains, but round 5 > 2 × 2 would break the hard cap.
    assert.equal(result.ok, false);
    assert.match(result.error, /max rounds \(2\) already reached/);
  });

  it("errors when chain.json has no modelChain", () => {
    const control = { chainId: "chain-test", container: "cid-1", pid: 0, status: "cancelled", round: 3 };
    const chainJson = baseChainJson({ modelChain: undefined, records: [partialRound()] });
    const result = resolveChainResume({ control, chainJson });
    assert.equal(result.ok, false);
    assert.match(result.error, /no modelChain/);
  });

  it("errors when chain.json has no brief", () => {
    const control = { chainId: "chain-test", container: "cid-1", pid: 0, status: "cancelled", round: 3 };
    const chainJson = baseChainJson({ brief: "", records: [partialRound()] });
    const result = resolveChainResume({ control, chainJson });
    assert.equal(result.ok, false);
    assert.match(result.error, /no brief/);
  });

  // =======================================================================
  // Replacement review seat (kusabi #248)
  //
  // Fixtures reproduce chain-mssxxuu3cc16: round 1 implement complete, probes
  // all green, the review seat died mid-stream (`partial`), the chain
  // escalated on that seat failure and finalised as status "completed".  The
  // implementation was intact; only the seat was consumed.
  // =======================================================================

  // The chain finished NORMALLY on the escalate, so control status is
  // "completed" with a dead pid -- not "cancelled".
  const seatControl = {
    chainId: "chain-test", container: "cid-1", pid: 0,
    status: "completed", round: 1, finishedAt: "2026-08-01T01:00:00.000Z",
  };

  const greenProbes = () => ([
    { probe: "P1: HEAD clean", passed: true, detail: "HEAD matches base abc123" },
    { probe: "P2: verify gate", passed: true, detail: JSON.stringify({ gate_passed: true }) },
    { probe: "P3: deliverables", passed: true, detail: "touches declared deliverables" },
    { probe: "P4: smoke", passed: true, detail: "all smoke entries exited 0" },
  ]);

  function deadSeatRound(overrides = {}) {
    return {
      round: 1,
      reworkScope: "full",
      implementJobId: "job-imp-1",
      reviewJobId: "job-rev-1",
      sessionID: "sess-1",
      tierBefore: 0,
      tierAfter: 0,
      reworkCount: 0,
      probesGreen: true,
      probeResults: greenProbes(),
      worktreeChanged: true,
      verdict: "partial",
      reviewParseable: true,
      reviewPartial: true,
      reviewFindingCount: 3,
      disposition: {
        disposition: "escalate",
        reason: "partial review: stream ended before the verdict line",
      },
      ...overrides,
    };
  }

  it("allows a review-position resume for an escalate caused by a dead review seat", () => {
    const record = deadSeatRound();
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({ records: [record], maxRounds: 4 }),
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.position.reviewSeatReplacement, true);
    // The resumed record is the SAME object -- the round is continued in
    // place, never duplicated.
    assert.equal(result.position.roundRecord, record);
    assert.equal(result.position.records.length, 1);
    assert.equal(result.position.reworkCount, 0);
    assert.equal(result.position.currentTierIndex, 0);
    assert.equal(result.position.session, "sess-1");
  });

  // The invariant: for every allowed resume under this feature the NEXT
  // dispatched phase is review, at the SAME round -- never implement.
  it("resolves the allowed case to the same round's review phase, never implement", () => {
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({ records: [deadSeatRound({ round: 3 })], maxRounds: 4 }),
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.position.phase, "review");
    assert.notEqual(result.position.phase, "implement");
    assert.equal(result.position.round, 3);
  });

  it("allows the unparseable seat failure on the same terms as partial", () => {
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({
        records: [deadSeatRound({
          verdict: "unparseable",
          reviewParseable: false,
          verdictSource: "recovered-from-token",
          reviewPartial: undefined,
          reviewFindingCount: undefined,
          disposition: { disposition: "escalate", reason: "unexpected verdict: unparseable" },
        })],
      }),
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.position.phase, "review");
  });

  it("refuses a needs-attention escalate -- a completed review judging the work", () => {
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({
        records: [deadSeatRound({
          verdict: "needs-attention",
          reviewPartial: undefined,
          reviewFindingCount: undefined,
          disposition: {
            disposition: "escalate",
            reason: "same file area flagged for two consecutive rounds",
          },
        })],
      }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /already finished/);
    // Today's refusal, verbatim -- no field-naming detail appended.
    assert.doesNotMatch(result.error, /—/);
  });

  it("refuses a discard-based escalate", () => {
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({
        records: [deadSeatRound({
          verdict: "discard",
          reviewPartial: undefined,
          reviewFindingCount: undefined,
          disposition: { disposition: "escalate", reason: "reviewer discarded the work" },
        })],
      }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /already finished/);
    assert.doesNotMatch(result.error, /—/);
  });

  it("refuses a max-rounds escalate even when the verdict is a seat failure", () => {
    // Budget exhausted: deriveDisposition's max-rounds terminal fires before
    // the partial branch, so the recorded reason is the max-rounds one.  The
    // seat did fail, but the escalate did not come FROM the seat failure.
    const result = resolveChainResume({
      control: { ...seatControl, round: 2 },
      chainJson: baseChainJson({
        records: [
          deadSeatRound({
            round: 1,
            verdict: "needs-attention",
            reviewPartial: undefined,
            disposition: { disposition: "rework", reason: "needs-attention" },
          }),
          deadSeatRound({
            round: 2,
            disposition: {
              disposition: "escalate",
              reason: "max rounds (2) reached without acceptance",
            },
          }),
        ],
        maxRounds: 2,
      }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /already finished/);
    assert.doesNotMatch(result.error, /—/);
  });

  it("refuses an accepted chain", () => {
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({
        records: [deadSeatRound({
          verdict: "approve",
          reviewPartial: undefined,
          reviewFindingCount: undefined,
          disposition: { disposition: "accept" },
        })],
      }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /already finished/);
    assert.doesNotMatch(result.error, /—/);
  });

  it("refuses a seat-shaped escalate whose probe results are missing, naming the field", () => {
    const record = deadSeatRound();
    delete record.probeResults;
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({ records: [record] }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /already finished/);
    assert.match(result.error, /probeResults/);
    assert.match(result.error, /P1–P4 cannot be confirmed green/);
  });

  it("refuses a seat-shaped escalate whose probe results do not cover P1–P4", () => {
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({
        records: [deadSeatRound({ probeResults: greenProbes().slice(0, 2) })],
      }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /does not cover P3, P4/);
  });

  it("refuses a seat-shaped escalate whose probes were red", () => {
    const probes = greenProbes();
    probes[1] = { probe: "P2: verify gate", passed: false, detail: "{}" };
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({
        records: [deadSeatRound({ probeResults: probes, probesGreen: false })],
      }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /not all green \(P2: verify gate\)/);
  });

  it("refuses when probesGreen disagrees with the probe entries", () => {
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({ records: [deadSeatRound({ probesGreen: undefined })] }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /probesGreen/);
  });

  it("refuses a seat-shaped escalate with no recorded disposition reason, naming the field", () => {
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({
        records: [deadSeatRound({ disposition: { disposition: "escalate" } })],
      }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /disposition\.reason/);
  });

  it("refuses a seat-failure escalate with no implement job, naming the field", () => {
    const record = deadSeatRound();
    delete record.implementJobId;
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({ records: [record] }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /implementJobId/);
  });

  it("refuses an escalate whose record carries no verdict at all, naming the field", () => {
    const record = deadSeatRound();
    delete record.verdict;
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({ records: [record] }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /`verdict`/);
  });

  it("refuses a seat verdict paired with the other seat state's reason (inconsistent)", () => {
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({
        records: [deadSeatRound({
          disposition: { disposition: "escalate", reason: "unexpected verdict: unparseable" },
        })],
      }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /inconsistent/);
  });

  it("still refuses a live chain that would otherwise be seat-eligible", () => {
    const result = resolveChainResume({
      control: { ...seatControl, pid: process.pid, status: "running" },
      chainJson: baseChainJson({ records: [deadSeatRound()] }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /still running/);
  });

  it("refuses a seat-eligible chain whose chain.json has no brief", () => {
    // The general preconditions still apply: eligibility widens WHICH chains
    // reach the position decision, not what the driver needs to run.
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({ brief: "", records: [deadSeatRound()] }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /no brief/);
  });

  it("allows a second replacement seat after an earlier one already failed", () => {
    // Each resume is an explicit operator action; a round that burned two
    // seats carries the first in reviewSeatFailures and stays eligible.
    const record = deadSeatRound({
      reviewSeatFailures: [{ seat: 1, verdict: "unparseable" }],
    });
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({ records: [record] }),
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.position.phase, "review");
  });
});

// =========================================================================
// classifyReviewSeatReplacement / archiveFailedReviewSeat (kusabi #248)
// =========================================================================

describe("classifyReviewSeatReplacement", () => {
  it("is not a seat failure when there are no records", () => {
    const result = classifyReviewSeatReplacement({ records: [] });
    assert.equal(result.eligible, false);
    assert.equal(result.detail, null);
  });

  it("is not a seat failure for a non-terminal disposition", () => {
    const result = classifyReviewSeatReplacement({
      records: [{ round: 1, verdict: "needs-attention", disposition: { disposition: "rework" } }],
    });
    assert.equal(result.eligible, false);
    assert.equal(result.detail, null);
  });

  it("names the round field when the record cannot say which round it is", () => {
    const result = classifyReviewSeatReplacement({
      records: [{
        verdict: "partial",
        disposition: { disposition: "escalate", reason: "partial review: stream ended before the verdict line" },
      }],
    });
    assert.equal(result.eligible, false);
    assert.match(result.detail, /`round`/);
  });
});

describe("archiveFailedReviewSeat", () => {
  function liveRecord() {
    return {
      round: 2,
      implementJobId: "job-imp-2",
      probesGreen: true,
      verdict: "partial",
      verdictSource: "recovered-from-token",
      reviewParseable: false,
      reviewPartial: true,
      reviewFindingCount: 4,
      reviewJobId: "job-rev-2",
      reviewUsage: { available: true, input: 10, output: 5, cost: 0.5 },
      reviewModelEntry: "fake/model",
      reviewModelVariant: null,
      reviewFallbacks: [],
      reviewJobFailure: null,
      reviewUnparseableRetried: true,
      reviewFirstJobId: "job-rev-2a",
      reviewFirstUsage: { available: true, input: 3, output: 1, cost: 0.1 },
      reviewFirstFallbacks: [],
      findingsText: "one finding",
      findings: [{ severity: "high", title: "t", file: "a.mjs" }],
      findingFiles: ["a.mjs"],
      disposition: { disposition: "escalate", reason: "partial review: stream ended before the verdict line" },
    };
  }

  it("moves every review field onto the archived seat and clears the live ones", () => {
    const record = archiveFailedReviewSeat(liveRecord());
    assert.equal(record.reviewSeatFailures.length, 1);
    const seat = record.reviewSeatFailures[0];
    assert.equal(seat.seat, 1);
    assert.equal(seat.verdict, "partial");
    assert.equal(seat.reviewJobId, "job-rev-2");
    assert.equal(seat.disposition.disposition, "escalate");
    assert.deepEqual(seat.findingFiles, ["a.mjs"]);
    // Conditionally-written fields must NOT survive on the live record: a
    // clean replacement verdict must not inherit "partial" or
    // "recovered-from-token" from the seat that died.
    for (const field of [
      "verdict", "verdictSource", "reviewParseable", "reviewPartial", "reviewFindingCount",
      "reviewJobId", "reviewUsage", "reviewModelEntry", "reviewModelVariant", "reviewFallbacks",
      "reviewJobFailure", "reviewUnparseableRetried", "reviewFirstJobId", "reviewFirstUsage",
      "reviewFirstFallbacks", "findingsText", "findings", "findingFiles", "disposition",
    ]) {
      assert.equal(Object.prototype.hasOwnProperty.call(record, field), false, `${field} survived archiving`);
    }
    // Non-review round state is untouched.
    assert.equal(record.round, 2);
    assert.equal(record.implementJobId, "job-imp-2");
    assert.equal(record.probesGreen, true);
  });

  it("appends a second seat rather than replacing the first", () => {
    const record = archiveFailedReviewSeat(liveRecord());
    record.verdict = "unparseable";
    record.reviewJobId = "job-rev-2b";
    archiveFailedReviewSeat(record);
    assert.equal(record.reviewSeatFailures.length, 2);
    assert.deepEqual(record.reviewSeatFailures.map((s) => s.seat), [1, 2]);
    assert.equal(record.reviewSeatFailures[0].verdict, "partial");
    assert.equal(record.reviewSeatFailures[1].verdict, "unparseable");
  });

  it("keeps the dead seat's spend in the chain totals", () => {
    const record = archiveFailedReviewSeat(liveRecord());
    // The replacement seat writes its own usage onto the live field.
    record.reviewUsage = { available: true, input: 100, output: 50, cost: 2 };
    const totals = computeChainTotals([record]);
    // 10 + 3 (dead seat + its retry) + 100 (replacement).
    assert.equal(totals.input, 113);
    assert.equal(totals.output, 56);
    assert.ok(Math.abs(totals.cost - 2.6) < 1e-9, `cost was ${totals.cost}`);
  });
});

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

describe("readExecCapture", () => {
  it("reads text and the complete-capture case", () => {
    // The live envelope shape: { status, output, shown, total_lines,
    // truncated, next_offset, has_more }.
    const capture = readExecCapture({
      status: "ok", output: "a\nb\n", shown: 2, total_lines: 2,
      truncated: false, next_offset: null, has_more: false,
    });
    assert.equal(capture.text, "a\nb\n");
    assert.deepEqual(capture.truncation, { truncated: false, total: 2 });
  });

  it("treats truncated:true as cut", () => {
    // Cut response as the live server sends it: 10 lines returned out of 101,
    // reported as shown=101 (== total_lines), next_offset=10.
    const capture = readExecCapture({
      output: Array.from({ length: 10 }, (_, i) => String(i + 1)).join("\n") + "\n",
      shown: 101, total_lines: 101, truncated: true, next_offset: 10, has_more: true,
    });
    assert.deepEqual(capture.truncation, { truncated: true, total: 101 });
  });

  it("treats has_more:true as cut even when truncated is false", () => {
    // Paging and summary truncation are independent layers; either one means
    // the text is not the whole output.  Measured on the live server:
    // `seq 1 60` at limit=25 comes back cut with truncated=false.
    const capture = readExecCapture({
      output: Array.from({ length: 25 }, (_, i) => String(i + 1)).join("\n") + "\n",
      shown: 61, total_lines: 61, truncated: false, next_offset: 25, has_more: true,
    });
    assert.equal(capture.truncation.truncated, true);
  });

  it("never carries the response's own shown-count", () => {
    // `shown` equals `total_lines` even on a cut response, so it cannot be
    // the numerator of "showing N of M".  It must not be carried at all: a
    // field named `shown` on the truncation object would be read as the
    // number of lines shown by anyone who found it there.
    const capture = readExecCapture({
      output: "1\n2\n", shown: 137, total_lines: 137, truncated: true, next_offset: 2, has_more: true,
    });
    assert.equal("shown" in capture.truncation, false);
    assert.deepEqual(Object.keys(capture.truncation).sort(), ["total", "truncated"]);
  });

  it("does not invent counts that are absent", () => {
    const capture = readExecCapture({ output: "a\n", truncated: true });
    assert.deepEqual(capture.truncation, { truncated: true, total: null });
  });

  it("degrades on a missing or shapeless result", () => {
    assert.deepEqual(readExecCapture(undefined), { text: "", truncation: { truncated: false, total: null } });
    assert.deepEqual(readExecCapture({}), { text: "", truncation: { truncated: false, total: null } });
  });
});

// ---------------------------------------------------------------------------
// chain review prompt — byte-identity guard (kusabi #204, re-recorded for #208)
// ---------------------------------------------------------------------------
// The container review input moved out of runReviewPhase into
// renderContainerReviewInput so `task --phase review --container` can send the
// same block.  The chain is the REFERENCE path: whatever else changes, what it
// sends must not drift unnoticed.  GOLDEN_CHAIN_REVIEW_INPUT below is a
// recording of the whole block, not a description of it.
//
// It was re-recorded for kusabi #208, which removed the inlined diff body: the
// `Diff content:` fenced block is gone and the instruction naming the base and
// the tool stands in its place.  Everything else is unchanged from the #204
// recording, so the two can be read against each other as a diff.

const GOLDEN_CHAIN_REVIEW_INPUT = [
  "## Review target",
  "",
  "The artifact under review lives inside container `cafe1234beef`.",
  "You may use the following Sunaba read/verify tools to inspect it:",
  "- `read_file_range` - read file contents from the container",
  "- `search_in_container` - grep/search within the container",
  "- `diff_in_container` - fetch the diff itself; it is NOT inlined below",
  "- `verify_in_container` / `lint_in_container` / `type_check_in_container` - re-run the project's gates in the container",
  "",
  "Do NOT rely on host cwd git state; the actual changes are in the container.",
  "",
  "### Base change-set context (machine-recorded)",
  "",
  "- Base commit: `0123456789abcdef`",
  "",
  "Recent base history (top 5):",
  "```",
  "abc1234 first",
  "def5678 second",
  "",
  "```",
  "",
  "Actual change set (`git status --porcelain`):",
  "```",
  " M src/foo.js",
  "?? src/new.js",
  "",
  "```",
  "",
  "**The diff itself is NOT included in this input.** The change set above names WHICH files changed, not WHAT changed inside them -- do not review the file list as if it were the change.",
  "",
  "Fetching the diff is YOUR job: call `diff_in_container` with `base` set to `0123456789abcdef` (that covers committed AND uncommitted work since that commit), and page through it with `offset` / `limit` until `has_more` is false.",
  "",
  "New (untracked) files:",
  "- `src/new.js`",
  "",
  "Use `read_file_range` to inspect these new files.",
  "",
  "Review ONLY this change set. Code that is already part of the base (see the log above) is NOT scope creep and must not be flagged as such.",
].join("\n");

describe("chain review prompt byte-identity", () => {
  const PLUGIN_DIR = path.resolve(import.meta.dirname, "..");

  async function capturePrompt() {
    let captured = null;
    function stubbedDispatch(opts) {
      captured = opts.promptText;
      return {
        job: { id: "review-golden", status: "completed", modelEntry: "m", modelVariant: null, fallbacks: null, usage: null, error: null },
        resultText: JSON.stringify({ verdict: "approve", findings: [] }),
      };
    }
    await runReviewPhase({
      container: "cafe1234beef",
      brief: "GOLDEN BRIEF TEXT",
      modelChain: ["test-org/test-flash"],
      chainId: "chain-golden",
      cwd: process.cwd(),
      previousRecord: null,
      baseSha: "0123456789abcdef",
      chainStatusOutput: " M src/foo.js\n?? src/new.js\n",
      chainBaseLog: "abc1234 first\ndef5678 second\n",
      chainUntracked: "src/new.js\n",
      roundRecord: { round: 2 },
      chainChangedPaths: ["src/foo.js"],
      chainStatusObserved: true,
      chainDeliverables: ["src/foo.js"],
      flagsModel: null,
      _dispatchWithFallback: stubbedDispatch,
    });
    return captured;
  }

  it("sends the exact recorded review-input block", async () => {
    const prompt = await capturePrompt();
    assert.ok(prompt.includes(GOLDEN_CHAIN_REVIEW_INPUT), "chain review input drifted from the captured golden");
  });

  it("sends no diff body, and names the base and the tool instead", async () => {
    // Stated separately from the golden so the reason the recording changed is
    // pinned by its own assertion rather than by a wall of text.
    const prompt = await capturePrompt();
    const input = prompt.slice(prompt.indexOf("## Review target"));
    assert.ok(!input.includes("diff --git"), "the diff body must not be inlined");
    assert.ok(!input.includes("```diff"));
    assert.ok(input.includes("Fetching the diff is YOUR job"));
    assert.ok(input.includes("`base` set to `0123456789abcdef`"));
  });

  it("renders the same block as the task route for the same container facts", async () => {
    // Both container routes must render from the one implementation; the
    // proof is that the same facts produce the same bytes on both.
    const prompt = await capturePrompt();
    const taskInput = await collectContainerReviewInput({
      container: "cafe1234beef",
      callTool: async (tool, params) => {
        const cmd = params.commands?.[0] ?? "";
        if (cmd === "git rev-parse HEAD") return { output: "0123456789abcdef\n" };
        if (cmd === "git status --porcelain") return { output: " M src/foo.js\n?? src/new.js\n" };
        if (cmd === "git log --oneline -5") return { output: "abc1234 first\ndef5678 second\n" };
        if (cmd === "git ls-files --others --exclude-standard") return { output: "src/new.js\n" };
        return { output: "" };
      },
    });
    assert.equal(taskInput, GOLDEN_CHAIN_REVIEW_INPUT);
    assert.ok(prompt.includes(taskInput));
  });

  it("sends a prompt that is byte-identical end to end for fixed inputs", async () => {
    const prompt = await capturePrompt();
    const template = fs.readFileSync(path.join(PLUGIN_DIR, "prompts", "adversarial-review.md"), "utf8");
    const schemaJson = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "schemas", "review-output.schema.json"), "utf8"));
    const expected = template
      .replaceAll("{{TARGET_LABEL}}", "container cafe1234beef changes")
      .replaceAll("{{USER_FOCUS}}", "GOLDEN BRIEF TEXT")
      .replaceAll("{{OUTPUT_SCHEMA}}", JSON.stringify(schemaJson))
      .replaceAll("{{REVIEW_INPUT}}", GOLDEN_CHAIN_REVIEW_INPUT)
      .replaceAll("{{PRIOR_FINDINGS}}", "(none -- first review round)")
      // kusabi #236: the golden round records no probes, so the slot renders
      // the explicit absence marker \u2014 the same bytes the chain produces for
      // a round without recorded probe results.
      .replaceAll("{{PROBE_REPORT}}", "(no probe results recorded)");
    assert.equal(prompt, expected);
  });
});

// ---------------------------------------------------------------------------
// runReviewPhase \u2014 {{PROBE_REPORT}} slot (kusabi #236)
//
// The round's deterministic probe results (P1\u2013P4) render into the review
// prompt so the reviewer does not re-litigate what the probes already
// measured.  Fixture-pinned both ways: a round with recorded probes carries
// all four probe lines, a round without carries the explicit absence marker.
// ---------------------------------------------------------------------------

describe("runReviewPhase \u2014 {{PROBE_REPORT}} slot (kusabi #236)", () => {
  const PLUGIN_DIR = path.resolve(import.meta.dirname, "..");

  // The same four-probe fixture the seat-replacement tests use (kusabi #248).
  const GREEN_PROBES = [
    { probe: "P1: HEAD clean", passed: true, detail: "HEAD matches base abc123" },
    { probe: "P2: verify gate", passed: true, detail: JSON.stringify({ gate_passed: true }) },
    { probe: "P3: deliverables", passed: true, detail: "touches declared deliverables" },
    { probe: "P4: smoke", passed: true, detail: "all smoke entries exited 0" },
  ];

  async function capturePrompt(roundRecord) {
    let captured = null;
    function stubbedDispatch(opts) {
      captured = opts.promptText;
      return {
        job: { id: "job-probes", status: "completed", modelEntry: "m", modelVariant: null, fallbacks: null, usage: null, error: null },
        resultText: JSON.stringify({ verdict: "approve", findings: [] }),
      };
    }
    await runReviewPhase({
      container: "cafe1234beef",
      brief: "GOLDEN BRIEF TEXT",
      modelChain: ["test-org/test-flash"],
      chainId: "chain-probes",
      cwd: process.cwd(),
      previousRecord: null,
      baseSha: "0123456789abcdef",
      chainStatusOutput: " M src/foo.js\n",
      chainBaseLog: "abc1234 first\n",
      chainUntracked: "",
      roundRecord,
      chainChangedPaths: ["src/foo.js"],
      chainStatusObserved: true,
      chainDeliverables: ["src/foo.js"],
      flagsModel: null,
      _dispatchWithFallback: stubbedDispatch,
    });
    return captured;
  }

  it("carries all four probe lines when the round recorded probe results", async () => {
    const prompt = await capturePrompt({ round: 1, probeResults: GREEN_PROBES });
    const probeBlock = prompt.slice(prompt.indexOf("<probe_results>"), prompt.indexOf("</probe_results>"));
    for (const line of [
      "- P1: HEAD clean \u2014 passed \u2014 HEAD matches base abc123",
      "- P2: verify gate \u2014 passed \u2014 {\"gate_passed\":true}",
      "- P3: deliverables \u2014 passed \u2014 touches declared deliverables",
      "- P4: smoke \u2014 passed \u2014 all smoke entries exited 0",
    ]) {
      assert.ok(probeBlock.includes(line), "missing probe line: " + line);
    }
  });

  it("carries the explicit absence marker when no probes were recorded", async () => {
    const prompt = await capturePrompt({ round: 2 });
    assert.ok(prompt.includes("(no probe results recorded)"));
  });

  it("carries the explicit absence marker for an empty probe array", async () => {
    const prompt = await capturePrompt({ round: 3, probeResults: [] });
    assert.ok(prompt.includes("(no probe results recorded)"));
  });

  it("renders a red probe as failed context rather than hiding it", async () => {
    const prompt = await capturePrompt({
      round: 4,
      probeResults: [
        { probe: "P1: HEAD clean", passed: true, detail: "HEAD matches base abc123" },
        { probe: "P2: verify gate", passed: false, detail: "lint: 2 violations" },
        { probe: "P3: deliverables", passed: true, detail: "touches declared deliverables" },
        { probe: "P4: smoke", passed: true, detail: "all smoke entries exited 0" },
      ],
    });
    const probeBlock = prompt.slice(prompt.indexOf("<probe_results>"), prompt.indexOf("</probe_results>"));
    assert.ok(probeBlock.includes("- P2: verify gate \u2014 failed \u2014 lint: 2 violations"));
  });

  it("renderProbeReport renders the explicit absence marker for a missing or empty set", () => {
    assert.equal(renderProbeReport(undefined), "(no probe results recorded)");
    assert.equal(renderProbeReport(null), "(no probe results recorded)");
    assert.equal(renderProbeReport([]), "(no probe results recorded)");
  });

  it("template carries the probe interpretation text and the authoritative-source mandate", () => {
    const template = fs.readFileSync(path.join(PLUGIN_DIR, "prompts", "adversarial-review.md"), "utf8");
    assert.ok(template.includes("{{PROBE_REPORT}}"));
    assert.ok(template.includes("Do not spend findings re-litigating what the probes already"));
    assert.ok(template.includes("missing probe is context for your verdict"));
    assert.ok(template.includes("<authoritative_sources>"));
    assert.ok(template.includes("name the source in the finding body"));
    // The discard/verdict contract (#235's metrics reading) must be unchanged.
    assert.ok(template.includes("Use `discard` when the change premise itself is wrong"));
  });
});

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
        const cmd = params.commands?.[0] ?? "";
        commands.push(cmd);
        return handler(cmd);
      },
    };
  }

  function defaultHandler(cmd) {
    if (cmd === "git rev-parse HEAD") return { output: "deadbeefcafe\n" };
    if (cmd === "git status --porcelain") return { output: " M src/foo.js\n" };
    if (cmd === "git log --oneline -5") return { output: "deadbee latest\n" };
    if (cmd === "git ls-files --others --exclude-standard") return { output: "src/new.js\n" };
    return { output: "" };
  }

  it("without --base, renders the container block against HEAD and captures no diff", async () => {
    const { commands, callTool } = recordingTool(defaultHandler);
    const input = await collectContainerReviewInput({ container: "cid123", callTool });

    assert.ok(input.startsWith("## Review target"));
    assert.ok(input.includes("container `cid123`"));
    assert.ok(input.includes("`diff_in_container`"));
    assert.ok(input.includes("- Base commit: `deadbeefcafe`"));
    assert.ok(input.includes(" M src/foo.js"));
    assert.ok(input.includes("- `src/new.js`"));
    // The base is what the reviewer cannot derive, so it is named as the ref
    // to fetch against; the diff body is not captured at all (kusabi #208).
    assert.ok(input.includes("Fetching the diff is YOUR job"));
    assert.ok(input.includes("`base` set to `deadbeefcafe`"));
    assert.ok(!input.includes("diff --git"));
    // Same default the chain uses: HEAD.
    assert.ok(commands.includes("git rev-parse HEAD"));
    assert.ok(
      !commands.some((c) => c.startsWith("git diff")),
      `no git diff may be issued, got: ${JSON.stringify(commands)}`,
    );
  });

  it("with --base, resolves that ref and names it as the ref to diff against", async () => {
    const { commands, callTool } = recordingTool((cmd) => {
      if (cmd.startsWith("git rev-parse --verify")) return { output: "c355fa61a7fee5402ed7ba999bd2fe2eeb46a842\n" };
      if (cmd === "git status --porcelain") return { output: " M src/foo.js\n" };
      if (cmd === "git log --oneline -5") return { output: "c355fa6 base\n" };
      return { output: "" };
    });
    const input = await collectContainerReviewInput({ container: "cid123", callTool, base: "c355fa6" });

    assert.ok(commands.some((c) => c.startsWith("git rev-parse --verify --quiet 'c355fa6^{commit}'")));
    assert.ok(
      !commands.some((c) => c.startsWith("git diff")),
      `--base must reach the reviewer as an instruction, not a capture, got: ${JSON.stringify(commands)}`,
    );
    assert.ok(input.includes("- Base commit: `c355fa61a7fee5402ed7ba999bd2fe2eeb46a842`"));
    assert.ok(input.includes("`base` set to `c355fa61a7fee5402ed7ba999bd2fe2eeb46a842`"));
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
    const input = await collectContainerReviewInput({ container: "cid123", callTool });
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
    const input = await collectContainerReviewInput({ container: "cid123", callTool });
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
    const input = await collectContainerReviewInput({ container: "cid123", callTool });
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
    const input = await collectContainerReviewInput({ container: "cid123", callTool });
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
        const cmd = params.commands?.[0] ?? "";
        commands.push(cmd);
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

describe("runFrozenProbe (P5)", () => {
  it("passes trivially when no `## Frozen Tests` section is declared", () => {
    const result = runFrozenProbe({ frozen: [], headingPresent: false, changedPaths: ["src/a.js"] });
    assert.equal(result.probe, "P5: frozen");
    assert.equal(result.passed, true);
    assert.equal(result.detail, "no Frozen Tests declared; check skipped");
    assert.equal(result.oracleViolation, undefined);
  });

  it("fails when the heading is present but no entries parsed", () => {
    // Same author-facing rule as P3/P4: fix the brief syntax rather than
    // believe the check ran.
    const result = runFrozenProbe({ frozen: [], headingPresent: true, changedPaths: [] });
    assert.equal(result.passed, false);
    assert.match(result.detail, /heading present but no entries parsed/);
    // No oracle marker: nothing was violated — the declaration is unreadable,
    // which the normal disposition table already routes (as it does a
    // zero-entry P3/P4).
    assert.equal(result.oracleViolation, undefined);
  });

  it("passes when the change set misses every frozen path", () => {
    const result = runFrozenProbe({
      frozen: ["tests/frozen.test.mjs"],
      headingPresent: true,
      changedPaths: ["src/a.js", "tests/scaffold.test.mjs"],
    });
    assert.equal(result.passed, true);
    assert.match(result.detail, /no frozen path changed/);
  });

  it("fails and names every intersecting path when the change set touches one", () => {
    const result = runFrozenProbe({
      frozen: ["tests/frozen.test.mjs", "tests/other.test.mjs"],
      headingPresent: true,
      changedPaths: ["src/a.js", "tests/frozen.test.mjs", "tests/other.test.mjs"],
    });
    assert.equal(result.passed, false);
    assert.equal(result.oracleViolation, true);
    assert.match(result.detail, /tests\/frozen\.test\.mjs/);
    assert.match(result.detail, /tests\/other\.test\.mjs/);
    assert.ok(!result.detail.includes("src/a.js"), "only intersecting paths are named as violations");
  });

  it("matches a frozen entry naming a directory by path prefix", () => {
    const result = runFrozenProbe({
      frozen: ["tests/acceptance"],
      headingPresent: true,
      changedPaths: ["tests/acceptance/deep/nested.test.mjs"],
    });
    assert.equal(result.passed, false);
    assert.equal(result.oracleViolation, true);
    assert.match(result.detail, /tests\/acceptance\/deep\/nested\.test\.mjs/);
  });

  it("does not match a directory that merely shares a name prefix", () => {
    const result = runFrozenProbe({
      frozen: ["tests/acceptance"],
      headingPresent: true,
      changedPaths: ["tests/acceptance-scaffold/a.test.mjs"],
    });
    assert.equal(result.passed, true);
  });

  it("matches in the other direction too: a changed directory containing a frozen file", () => {
    // `git status --porcelain` reports an untracked directory as one entry.
    // Under-reporting here would let a frozen file hide inside it; the probe
    // over-reports instead, and a human adjudicates.
    const result = runFrozenProbe({
      frozen: ["tests/acceptance/frozen.test.mjs"],
      headingPresent: true,
      changedPaths: ["tests/acceptance"],
    });
    assert.equal(result.passed, false);
    assert.equal(result.oracleViolation, true);
  });

  it("never throws on missing/garbage inputs", () => {
    assert.equal(runFrozenProbe({}).passed, true);
    assert.equal(runFrozenProbe({ frozen: null, headingPresent: false, changedPaths: null }).passed, true);
    assert.equal(runFrozenProbe({ frozen: ["a"], headingPresent: true, changedPaths: null }).passed, true);
  });
});

describe("countVerifyCollected", () => {
  it("reads tests.full.total from a real verify result", () => {
    // Live sunaba output on this repo, 2026-08-15.
    const verifyResult = {
      gate_passed: true,
      tests: { full: { status: "ok", duration: 25.126720453, passed: 2033, total: 2033 } },
      lint: [], types: [],
    };
    assert.equal(countVerifyCollected(verifyResult), 2033);
  });

  it("reads the total of a failing run too (the count is collection, not success)", () => {
    assert.equal(countVerifyCollected({ tests: { full: { status: "fail", passed: 0, total: 1 } } }), 1);
  });

  it("sums passed + failed when total is absent", () => {
    assert.equal(countVerifyCollected({ tests: { full: { status: "fail", passed: 600, failed: 7 } } }), 607);
    assert.equal(countVerifyCollected({ tests: { full: { status: "ok", passed: 12 } } }), 12);
  });

  it("returns null when the tests never ran (lint/type precondition failed)", () => {
    assert.equal(
      countVerifyCollected({ gate_passed: false, tests: { status: "skipped", message: "precondition gate failed; tests not run" } }),
      null,
    );
  });

  it("returns null rather than guessing on missing or uncountable shapes", () => {
    assert.equal(countVerifyCollected(null), null);
    assert.equal(countVerifyCollected(undefined), null);
    assert.equal(countVerifyCollected({}), null);
    assert.equal(countVerifyCollected({ tests: { full: {} } }), null);
    assert.equal(countVerifyCollected({ tests: { full: { total: "2033" } } }), null);
    assert.equal(countVerifyCollected({ output: "" }), null);
  });
});

describe("buildVerifyBaseline collected count", () => {
  it("records the collected count beside the lint/type counts", () => {
    const baseline = buildVerifyBaseline({
      gate_passed: true, lint: [], types: [],
      tests: { full: { status: "ok", passed: 2033, total: 2033 } },
    });
    assert.equal(baseline.captured, true);
    assert.equal(baseline.collected, 2033);
    assert.equal(baseline.lint, 0);
    assert.equal(baseline.types, 0);
  });

  it("records collected: null when no count is derivable — never a guess", () => {
    const baseline = buildVerifyBaseline({
      gate_passed: false, lint: [{ rule: "x" }], types: [],
      tests: { status: "skipped" },
      gate_fail_reasons: ["lint (eslint): 1 violation(s)"],
    });
    assert.equal(baseline.collected, null);
    assert.equal(baseline.lint, 1);
  });
});

describe("runCollectedProbe (P6)", () => {
  it("passes when the round ran at least as many tests as the baseline", () => {
    const same = runCollectedProbe({ collected: 607, baselineCollected: 607 });
    assert.equal(same.probe, "P6: collected");
    assert.equal(same.passed, true);
    assert.equal(same.detail, "collected 607 >= baseline 607");

    const more = runCollectedProbe({ collected: 620, baselineCollected: 607 });
    assert.equal(more.passed, true);
    assert.equal(more.detail, "collected 620 >= baseline 607");
  });

  it("fails and names both numbers when the round ran fewer tests", () => {
    // The kusabi #197 incident: a dependency drift made 273 of 607 tests
    // uncollectable while verify stayed green.
    const result = runCollectedProbe({ collected: 334, baselineCollected: 607 });
    assert.equal(result.passed, false);
    assert.equal(result.detail, "collected 334 < baseline 607");
    assert.equal(result.oracleViolation, true);
  });

  it("passes with the limitation stated when the BASELINE count is unavailable", () => {
    const result = runCollectedProbe({ collected: 607, baselineCollected: null });
    assert.equal(result.passed, true);
    assert.equal(
      result.detail,
      "collected count unavailable (baseline unavailable, round 607); P6 could not compare, so this round's test count is UNCHECKED",
    );
    assert.equal(result.limitation, result.detail);
    assert.equal(result.oracleViolation, undefined);
  });

  it("passes with the limitation stated when the ROUND count is unavailable", () => {
    const result = runCollectedProbe({ collected: null, baselineCollected: 607 });
    assert.equal(result.passed, true);
    assert.equal(
      result.detail,
      "collected count unavailable (baseline 607, round unavailable); P6 could not compare, so this round's test count is UNCHECKED",
    );
  });

  it("passes with the limitation stated when neither side has a count", () => {
    const result = runCollectedProbe({ collected: null, baselineCollected: undefined });
    assert.equal(result.passed, true);
    assert.equal(
      result.detail,
      "collected count unavailable (baseline unavailable, round unavailable); P6 could not compare, so this round's test count is UNCHECKED",
    );
  });
});

describe("summariseOracleViolations", () => {
  it("returns false when no probe carries the marker", () => {
    assert.equal(summariseOracleViolations([
      { probe: "P5: frozen", passed: true, detail: "no frozen path changed; frozen: [a]" },
      { probe: "P6: collected", passed: true, detail: "collected 10 >= baseline 10" },
    ]), false);
    assert.equal(summariseOracleViolations([]), false);
    assert.equal(summariseOracleViolations(null), false);
  });

  it("names every violation so the escalate reason can carry it", () => {
    const summary = summariseOracleViolations([
      { probe: "P3: deliverables", passed: false, detail: "no declared deliverable touched" },
      { probe: "P5: frozen", passed: false, detail: "frozen path(s) changed: [tests/a.test.mjs]", oracleViolation: true },
      { probe: "P6: collected", passed: false, detail: "collected 3 < baseline 9", oracleViolation: true },
    ]);
    assert.match(summary, /P5: frozen: frozen path\(s\) changed: \[tests\/a\.test\.mjs\]/);
    assert.match(summary, /P6: collected: collected 3 < baseline 9/);
    // A non-oracle probe failure is NOT an oracle violation: it reworks.
    assert.ok(!summary.includes("P3: deliverables"));
  });
});

describe("runVerifyProbe collected count (P6 input)", () => {
  function verifyCallTool(results) {
    const calls = [];
    const fn = async (toolName, params) => {
      if (toolName !== "verify_in_container") return { output: "" };
      calls.push(params);
      return results[Math.min(calls.length - 1, results.length - 1)];
    };
    fn.calls = calls;
    return fn;
  }

  it("carries the count of the green fast-path run", async () => {
    const callTool = verifyCallTool([
      { gate_passed: true, tests: { full: { status: "ok", passed: 2033, total: 2033 } } },
    ]);
    const result = await runVerifyProbe({ callTool, container: "cid" });
    assert.equal(result.passed, true);
    assert.equal(result.collected, 2033);
    assert.equal(callTool.calls.length, 1);
  });

  it("carries the count of the run whose tests actually executed (tolerated re-run)", async () => {
    // The first call's tests were SKIPPED by the lint precondition, so it
    // measured nothing; the tolerated re-run is the one that ran tests.
    const callTool = verifyCallTool([
      {
        gate_passed: false,
        lint: [{ rule: "no-unused-vars" }], types: [],
        tests: { status: "skipped", message: "precondition gate failed; tests not run" },
        gate_fail_reasons: ["lint (eslint): 1 violation(s)"],
      },
      { gate_passed: true, lint: [], types: [], tests: { full: { status: "ok", passed: 42, total: 42 } } },
    ]);
    const result = await runVerifyProbe({
      callTool, container: "cid",
      baseline: { captured: true, gate_passed: false, lint: 1, types: 0, collected: 42, raw: {} },
    });
    assert.equal(result.passed, true);
    assert.equal(result.collected, 42);
    assert.equal(callTool.calls.length, 2, "P2's own tolerated re-run — P6 adds none");
  });

  it("carries the failing run's count (tests ran and failed)", async () => {
    const callTool = verifyCallTool([
      { gate_passed: false, lint: [], types: [], tests: { full: { status: "fail", passed: 40, failed: 2 } } },
    ]);
    const result = await runVerifyProbe({ callTool, container: "cid" });
    assert.equal(result.passed, false);
    assert.equal(result.collected, 42);
  });

  it("carries null when no run got as far as executing tests", async () => {
    const callTool = verifyCallTool([
      {
        gate_passed: false,
        lint: [{ rule: "x" }], types: [],
        tests: { status: "skipped" },
        gate_fail_reasons: ["lint (eslint): 1 violation(s)"],
      },
    ]);
    const result = await runVerifyProbe({ callTool, container: "cid" });
    assert.equal(result.passed, false, "strict without a baseline (unchanged)");
    assert.equal(result.collected, null);
  });
});

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
      const cmd = params.commands[0];
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
