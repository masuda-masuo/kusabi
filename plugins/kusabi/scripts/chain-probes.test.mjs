import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFakeCallTool, fakeCallToolForP1, fakeCallToolForP2, fakeCallToolForP3, fakeCallToolForP3WithBaseline } from "./fixtures.mjs";
import {
  readExecCapture,
  runSmokeProbe,
  runHeadCleanProbe,
  runVerifyProbe,
  countVerifyViolations,
  countVerifyCollected,
  buildVerifyBaseline,
  runDeliverablesProbe,
  runFrozenProbe,
  runCollectedProbe,
  summariseOracleViolations,
} from "./chain-probes.mjs";

// Source guard: these names must NOT be defined in chain-phases.mjs
// after the move to chain-probes.mjs (kusabi #425).
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const chainPhasesSrc = fs.readFileSync(
  path.join(HERE, "chain-phases.mjs"), "utf8"
);

const movedNames = [
  "export async function runHeadCleanProbe",
  "export async function runSmokeProbe",
  "export async function runVerifyProbe",
  "export async function runDeliverablesProbe",
  "export function runFrozenProbe",
  "export function runCollectedProbe",
];

describe("chain-phases.mjs has no definitions of moved probe names", () => {
  for (const name of movedNames) {
    it(name + " must not appear in chain-phases.mjs", () => {
      assert.ok(
        !chainPhasesSrc.includes(name),
        chainPhasesSrc.includes(name)
          ? "chain-phases.mjs still contains: " + name
          : "OK"
      );
    });
  }
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
