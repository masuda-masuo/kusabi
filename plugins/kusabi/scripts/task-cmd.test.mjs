import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  __testProbeBindings,
  buildTaskReviewInput,
  cmdReview,
  cmdTask,
  cmdTaskDetach,
  resolveTaskPreflight,
} from "./task-cmd.mjs";
import { stateDirFor } from "./state-paths.mjs";
import { smokeBaselineReport } from "./chain-brief-guards.mjs";
import { createFakeCallTool } from "./fixtures.mjs";

// cmdTask probe binding regression test
// ---------------------------------------------------------------------------
// Verifies that the probe functions are locally bound in task-cmd.mjs
// so cmdTask can call them without ReferenceError.

describe("probe function local bindings", () => {
  it("returns 'function' for all four probe bindings (regression: would have been 'undefined' before fix)", () => {
    const bindings = __testProbeBindings();
    assert.equal(bindings.runSmokeProbe, "function");
    assert.equal(bindings.runHeadCleanProbe, "function");
    assert.equal(bindings.runVerifyProbe, "function");
    assert.equal(bindings.runDeliverablesProbe, "function");
  });
});

// buildTaskReviewInput — `task --phase review --container` gets an input (#204)
// ---------------------------------------------------------------------------
// Single-shot `task` shares the container review renderer with the chain.  It
// sits in task-cmd.mjs (kusabi #437) where both cmdTask and tests can reach
// it directly.  It is where the container-review behaviour is pinned — including
// the dispatches that must be untouched (another phase, and review without a
// container) and the --base decision.
//
// The input no longer inlines the diff body (kusabi #208): what --base selects
// is the base commit the input names as the ref to fetch against, so that is
// what these assert instead of a captured `git diff <ref>`.

describe("buildTaskReviewInput", () => {
  function containerTool(overrides = {}) {
    const commands = [];
    const toolCalls = [];
    const callTool = async (tool, params = {}) => {
      toolCalls.push({ tool, params });
      if (tool === "verify_in_container") {
        return overrides[tool] ?? {
          gate_passed: true,
          status: "ok",
          tests: { full: { status: "ok", passed: 1, total: 1 } },
          lint: [],
          types: [],
        };
      }
      const cmd = params?.commands?.[0] ?? params?.argv?.join(" ") ?? "";
      commands.push(cmd);
      if (cmd.includes("change-scope.mjs")) {
        const base = cmd.includes("c355fa61a7fee5402ed7ba999bd2fe2eeb46a842")
          ? "c355fa61a7fee5402ed7ba999bd2fe2eeb46a842"
          : "deadbeefcafe";
        return {
          output: JSON.stringify({
            formatVersion: 1,
            repositoryRoot: "/workspace",
            input: { base, head: "HEAD" },
            resolved: { baseSha: base, headSha: "deadbeefcafe", mergeBaseSha: base },
            paths: { committed: [], staged: [], unstaged: ["src/foo.js"], untracked: [] },
          }),
        };
      }
      if (Object.prototype.hasOwnProperty.call(overrides, cmd)) return { output: overrides[cmd] };
      if (cmd === "git rev-parse HEAD") return { output: "deadbeefcafe\n" };
      if (cmd === "git status --porcelain") return { output: " M src/foo.js\n" };
      if (cmd === "git log --oneline -5") return { output: "deadbee latest\n" };
      if (cmd.startsWith("git rev-parse --verify")) return { output: "c355fa61a7fee5402ed7ba999bd2fe2eeb46a842\n" };
      if (cmd.includes("SMOKE_EXIT=")) return { output: "SMOKE_EXIT=0\n" };
      return { output: "" };
    };
    return { commands, toolCalls, callTool };
  }

  it("builds the container review input for --phase review --container", async () => {
    const { commands, callTool } = containerTool();
    const input = await buildTaskReviewInput({
      phase: "review",
      flags: { container: "cid123" },
      callTool,
    });
    assert.ok(input, "a container review must carry a review input");
    assert.ok(input.includes("## Review target"));
    assert.ok(input.includes("container `cid123`"));
    assert.ok(input.includes("`diff_in_container`"));
    assert.ok(input.includes("### Base change-set context (machine-recorded)"));
    // Content, not length: the base and the fetch instruction must be there,
    // and the diff body must not.
    assert.ok(input.includes("- Base commit: `deadbeefcafe`"));
    assert.ok(input.includes("Fetching the diff is YOUR job"));
    assert.ok(!input.includes("diff --git"));
    assert.ok(
      !commands.some((c) => c.startsWith("git diff")),
      `no git diff may be captured, got: ${JSON.stringify(commands)}`,
    );
  });

  it("reflects --base in the input it builds", async () => {
    const { commands, callTool } = containerTool();
    const input = await buildTaskReviewInput({
      phase: "review",
      flags: { container: "cid123", base: "c355fa6" },
      callTool,
    });
    assert.ok(commands.some((c) => c.startsWith("git rev-parse --verify --quiet 'c355fa6^{commit}'")));
    assert.ok(input.includes("- Base commit: `c355fa61a7fee5402ed7ba999bd2fe2eeb46a842`"));
    assert.ok(input.includes("`base` set to `c355fa61a7fee5402ed7ba999bd2fe2eeb46a842`"));
    assert.ok(!commands.some((c) => c.startsWith("git diff")));
  });

  it("rejects --base loudly when it cannot take effect (implement phase)", async () => {
    const { commands, callTool } = containerTool();
    await assert.rejects(
      () => buildTaskReviewInput({ phase: "implement", flags: { container: "cid123", base: "c355fa6" }, callTool }),
      /task --base applies only to a container review/,
    );
    // Nothing was read from the container: the flag is refused, not half-honoured.
    assert.deepEqual(commands, []);
  });

  it("rejects --base loudly for a review without a container", async () => {
    const { callTool } = containerTool();
    await assert.rejects(
      () => buildTaskReviewInput({ phase: "review", flags: { base: "c355fa6" }, callTool }),
      /task --base applies only to a container review/,
    );
  });

  it("rejects a --base that does not resolve in the container", async () => {
    const { callTool } = containerTool({ "git rev-parse --verify --quiet 'nosuchref^{commit}' || echo __KUSABI_BASE_UNRESOLVED__": "__KUSABI_BASE_UNRESOLVED__\n" });
    await assert.rejects(
      () => buildTaskReviewInput({ phase: "review", flags: { container: "cid123", base: "nosuchref" }, callTool }),
      /--base nosuchref is not a valid revision in container cid123/,
    );
  });

  it("leaves --phase implement --container exactly as it was (no review input)", async () => {
    const { commands, callTool } = containerTool();
    const input = await buildTaskReviewInput({
      phase: "implement",
      flags: { container: "cid123" },
      callTool,
    });
    assert.equal(input, null);
    assert.deepEqual(commands, [], "a non-review phase must not read the container here");
  });

  it("leaves review without --container exactly as it was (no review input)", async () => {
    const { commands, callTool } = containerTool();
    const input = await buildTaskReviewInput({ phase: "review", flags: {}, callTool });
    assert.equal(input, null);
    assert.deepEqual(commands, []);
  });

  it("returns null for a task with no phase at all", async () => {
    const { callTool } = containerTool();
    assert.equal(await buildTaskReviewInput({ phase: null, flags: { container: "cid123" }, callTool }), null);
  });

  it("appends container review input with resolved base to cmdTask prompt", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-cmdtask-review-"));
    const cwd = path.join(tmp, "ws");
    fs.mkdirSync(cwd, { recursive: true });
    const stateRoot = path.join(tmp, "state");
    fs.mkdirSync(stateRoot, { recursive: true });
    const prevStateEnv = process.env.KUSABI_STATE_DIR;
    process.env.KUSABI_STATE_DIR = stateRoot;
    try {
      const { commands, toolCalls, callTool } = containerTool();
      const dispatches = [];
      const fakeJob = {
        id: "job-review-test-1",
        status: "completed",
        startedAt: "2026-10-10T00:00:00.000Z",
        finishedAt: "2026-10-10T00:01:00.000Z",
      };
      const fakeDispatch = async (dispatchArgs) => {
        dispatches.push(dispatchArgs);
        return {
          job: fakeJob,
          resultText: "review complete",
        };
      };

      const taskText = "Orchestrator: test-model | session test-session | 2026-09-12\n\nreview the change";

      const res = await cmdTask(
        cwd,
        {
          flags: { phase: "review", container: "cid123", base: "c355fa6" },
          text: taskText,
          _dispatch: fakeDispatch,
        },
        {
          stateRoot,
          callTool,
        },
      );

      assert.equal(res.exitCode, 0, res.text);
      assert.equal(fakeJob.probesGreen, true, "job.probesGreen must be true for green container review");
      const p1 = fakeJob.probeResults?.find((p) => p.probe === "P1: HEAD clean");
      assert.ok(p1, "P1: HEAD clean probe must exist");
      assert.equal(p1.passed, true);
      assert.equal(p1.detail, "HEAD matches base deadbeefcafe");
      const p2 = fakeJob.probeResults?.find((p) => p.probe === "P2: verify gate");
      assert.ok(p2, "P2: verify gate probe must exist");
      assert.equal(p2.passed, true);

      assert.equal(dispatches.length, 1, "exactly one dispatch should occur");
      const sent = dispatches[0];

      // Dispatched prompt includes original task, container, resolved base, and review input marker/path
      assert.ok(sent.promptText.includes("<task>\n" + taskText + "\n</task>"), "prompt includes original task");
      assert.ok(sent.promptText.includes("cid123"), "prompt includes container");
      assert.ok(
        sent.promptText.includes("c355fa61a7fee5402ed7ba999bd2fe2eeb46a842"),
        "prompt includes resolved base commit",
      );
      assert.ok(sent.promptText.includes("## Review target"), "prompt includes review target heading");
      assert.ok(sent.promptText.includes("src/foo.js"), "prompt includes marker/path from collected review input");
      assert.ok(sent.promptText.includes("`diff_in_container`"), "prompt includes diff instruction");

      // Confirm no git diff capture
      assert.ok(!sent.promptText.includes("diff --git"), "prompt must not inline git diff");
      assert.ok(
        !commands.some((c) => c.startsWith("git diff")),
        `no git diff may be captured, got: ${JSON.stringify(commands)}`,
      );

      // Verify toolCalls requested expected container and resolved base
      assert.ok(toolCalls.length > 0, "toolCalls must not be empty");
      assert.ok(
        toolCalls.every((c) => c.params?.container_id === "cid123"),
        "all container tool calls must target container cid123",
      );
      assert.ok(
        toolCalls.some((c) => c.tool === "verify_in_container"),
        "verify_in_container must be called",
      );
      assert.ok(
        commands.some((c) => c.includes("c355fa61a7fee5402ed7ba999bd2fe2eeb46a842")),
        "commands must reference the resolved base commit",
      );

      // Negative control inside this registration: injected verify gate false must be observable as exitCode 1 and probesGreen false
      const failTool = containerTool({
        verify_in_container: {
          gate_passed: false,
          status: "failed",
          tests: { full: { status: "failed", passed: 0, total: 1 } },
          lint: [],
          types: [],
        },
      });
      const failJob = {
        id: "job-review-fail-1",
        status: "completed",
        startedAt: "2026-10-10T00:00:00.000Z",
        finishedAt: "2026-10-10T00:01:00.000Z",
      };
      const failDispatch = async () => ({ job: failJob, resultText: "review complete" });

      const failRes = await cmdTask(
        cwd,
        {
          flags: { phase: "review", container: "cid123", base: "c355fa6" },
          text: taskText,
          _dispatch: failDispatch,
        },
        {
          stateRoot,
          callTool: failTool.callTool,
        },
      );

      assert.equal(failRes.exitCode, 1, "injected verify failure must result in exitCode 1");
      assert.equal(failJob.probesGreen, false, "injected verify failure must mark probesGreen false");
      const failP2 = failJob.probeResults?.find((p) => p.probe === "P2: verify gate");
      assert.ok(failP2, "P2 probe must exist in failing run");
      assert.equal(failP2.passed, false, "P2 probe must be marked not passed");
    } finally {
      if (prevStateEnv === undefined) delete process.env.KUSABI_STATE_DIR;
      else process.env.KUSABI_STATE_DIR = prevStateEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("leaves cmdTask prompt free of review input for non-review or containerless flows", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-cmdtask-noreview-"));
    const cwd = path.join(tmp, "ws");
    fs.mkdirSync(cwd, { recursive: true });
    const stateRoot = path.join(tmp, "state");
    fs.mkdirSync(stateRoot, { recursive: true });
    const prevStateEnv = process.env.KUSABI_STATE_DIR;
    process.env.KUSABI_STATE_DIR = stateRoot;
    try {
      const { callTool, toolCalls } = containerTool();

      // Case 1: containerless review flow
      const dispatches1 = [];
      const fakeJob1 = {
        id: "job-containerless",
        status: "completed",
        startedAt: "2026-10-10T00:00:00.000Z",
        finishedAt: "2026-10-10T00:01:00.000Z",
      };
      const fakeDispatch1 = async (args) => {
        dispatches1.push(args);
        return {
          job: fakeJob1,
          resultText: "done",
        };
      };
      const reviewBrief = "Orchestrator: test-model | session test-session | 2026-09-12\n\nreview the change";
      const res1 = await cmdTask(
        cwd,
        {
          flags: { phase: "review" },
          text: reviewBrief,
          _dispatch: fakeDispatch1,
        },
        { stateRoot, callTool },
      );
      assert.equal(res1.exitCode, 0, res1.text);
      assert.equal(dispatches1.length, 1);
      assert.ok(
        !dispatches1[0].promptText.includes("## Review target"),
        "containerless review must not have review input in prompt",
      );
      assert.ok(
        !dispatches1[0].promptText.includes("`diff_in_container`"),
        "containerless review must not have diff_in_container in prompt",
      );
      assert.equal(toolCalls.length, 0, "containerless review must make zero container tool calls");

      // Case 2: non-review phase with container (implement)
      const dispatches2 = [];
      const fakeJob2 = {
        id: "job-implement",
        status: "completed",
        startedAt: "2026-10-10T00:00:00.000Z",
        finishedAt: "2026-10-10T00:01:00.000Z",
      };
      const fakeDispatch2 = async (args) => {
        dispatches2.push(args);
        return {
          job: fakeJob2,
          resultText: "done",
        };
      };
      const implementBrief = [
        "Orchestrator: test-model | session test-session | 2026-09-12",
        "",
        "implement the change",
        "",
        "## Deliverables",
        "- `src/foo.js`",
        "",
        "## Smoke",
        "- `npm test`",
        "",
      ].join("\n");
      const res2 = await cmdTask(
        cwd,
        {
          flags: { phase: "implement", container: "cid123" },
          text: implementBrief,
          _dispatch: fakeDispatch2,
        },
        { stateRoot, callTool },
      );
      assert.equal(res2.exitCode, 0, res2.text);
      assert.equal(fakeJob2.probesGreen, true, "implement container probes must pass");
      const p1_2 = fakeJob2.probeResults?.find((p) => p.probe === "P1: HEAD clean");
      assert.ok(p1_2, "P1 probe must exist in implement run");
      assert.equal(p1_2.passed, true);
      assert.equal(p1_2.detail, "HEAD matches base deadbeefcafe");
      const p2_2 = fakeJob2.probeResults?.find((p) => p.probe === "P2: verify gate");
      assert.ok(p2_2, "P2 probe must exist in implement run");
      assert.equal(p2_2.passed, true);

      assert.equal(dispatches2.length, 1);
      assert.ok(
        !dispatches2[0].promptText.includes("## Review target"),
        "implement phase must not have review input in prompt",
      );
      assert.ok(
        !dispatches2[0].promptText.includes("- Base commit:"),
        "implement phase must not have base commit review input in prompt",
      );
      assert.ok(toolCalls.length > 0, "implement with container must invoke container tools");
      assert.ok(
        toolCalls.every((c) => c.params?.container_id === "cid123"),
        "all container tool calls must target container cid123",
      );
    } finally {
      if (prevStateEnv === undefined) delete process.env.KUSABI_STATE_DIR;
      else process.env.KUSABI_STATE_DIR = prevStateEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("cmdReview — schema-invalid repair loop (kusabi #395)", () => {
  const SCHEMA_INVALID_MISSING_VERSION = JSON.stringify({
    verdict: "needs-attention",
    summary: "One defect found.",
    findings: [
      { severity: "medium", title: "Off-by-one", body: "b", file: "src/calc.js", line_start: 7, line_end: 7, confidence: 0.8, recommendation: "r" },
    ],
    next_steps: [],
  });

  const VALID_REVIEW = JSON.stringify({
    schema_version: 1,
    verdict: "needs-attention",
    summary: "One real finding.",
    findings: [
      { severity: "medium", title: "Off-by-one", body: "b", file: "src/calc.js", line_start: 7, line_end: 7, confidence: 0.8, recommendation: "r" },
    ],
    next_steps: [],
  });

  const GARBAGE = "definitely not JSON and no VERDICT token here at all";

  it("repairs schema-invalid review output in the same session", async () => {
    const calls = [];
    const jobs = [
      {
        job: { id: "job-r1", status: "completed", sessionID: "sess-rev-1" },
        resultText: SCHEMA_INVALID_MISSING_VERSION,
      },
      {
        job: { id: "job-r2", status: "completed", sessionID: "sess-rev-1" },
        resultText: VALID_REVIEW,
      },
    ];

    async function stubPrompt(opts) {
      calls.push(opts);
      const next = jobs.shift();
      if (next?.job?.id) {
        fs.mkdirSync(path.join(stateDirFor(process.cwd()), "jobs", next.job.id), { recursive: true });
      }
      return next;
    }

    const output = await cmdReview(process.cwd(), {
      flags: { model: "test/model" },
      text: "test focus",
      _runPrompt: stubPrompt,
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[1].session, "sess-rev-1");
    assert.ok(calls[1].promptText.includes("Schema validation errors:"));
    assert.ok(output.includes("needs-attention"));
    assert.ok(output.includes("Off-by-one"));
  });

  it("retries garbage output with identical prompt in cmdReview", async () => {
    const calls = [];
    const jobs = [
      {
        job: { id: "job-g1", status: "completed" },
        resultText: GARBAGE,
      },
      {
        job: { id: "job-g2", status: "completed" },
        resultText: VALID_REVIEW,
      },
    ];

    async function stubPrompt(opts) {
      calls.push(opts);
      const next = jobs.shift();
      if (next?.job?.id) {
        fs.mkdirSync(path.join(stateDirFor(process.cwd()), "jobs", next.job.id), { recursive: true });
      }
      return next;
    }

    const output = await cmdReview(process.cwd(), {
      flags: { model: "test/model" },
      text: "test focus",
      _runPrompt: stubPrompt,
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].promptText, calls[1].promptText);
    assert.ok(output.includes("needs-attention"));
  });
});

// ---------------------------------------------------------------------------
// resolveTaskPreflight lossy-smoke option (kusabi #491 followup)
// Foreground task must not call smokeViolationReport; task-detach must.
// ---------------------------------------------------------------------------

describe("resolveTaskPreflight lossy-smoke refusal option", () => {
  const NESTED = "- `! grep -F 'Check `/kusabi:status`' plugins/kusabi/commands/task.md …`";
  const SIG = "Orchestrator: test-model | session test-session | 2026-09-12";
  const LOSSY_BRIEF = [SIG, "", "review the change", "", "## Smoke", "", NESTED, ""].join("\n");
  const CLEAN_BRIEF = [SIG, "", "review the change", "", "## Smoke", "", "- `npm test`", ""].join("\n");

  function withStateRoot(fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-task-preflight-"));
    const stateRoot = path.join(tmp, "state");
    fs.mkdirSync(stateRoot, { recursive: true });
    try {
      return fn({ tmp, stateRoot });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  async function withStateRootAsync(fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-task-preflight-"));
    const stateRoot = path.join(tmp, "state");
    fs.mkdirSync(stateRoot, { recursive: true });
    const prevStateEnv = process.env.KUSABI_STATE_DIR;
    process.env.KUSABI_STATE_DIR = stateRoot;
    try {
      return await fn({ tmp, stateRoot });
    } finally {
      if (prevStateEnv === undefined) delete process.env.KUSABI_STATE_DIR;
      else process.env.KUSABI_STATE_DIR = prevStateEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it("skips smokeViolationReport when refuseOnLossySmoke is false (foreground task)", () => {
    withStateRoot(({ tmp, stateRoot }) => {
      const pre = resolveTaskPreflight(
        tmp,
        { flags: { phase: "review" }, text: LOSSY_BRIEF },
        { refuseOnLossySmoke: false, stateRoot },
      );
      assert.equal(pre.phase, "review");
      assert.match(pre.text, /## Smoke/);
    });
  });

  it("refuses a lossy ## Smoke when refuseOnLossySmoke is true (task-detach)", () => {
    withStateRoot(({ tmp, stateRoot }) => {
      assert.throws(
        () =>
          resolveTaskPreflight(
            tmp,
            { flags: { phase: "review" }, text: LOSSY_BRIEF },
            { refuseOnLossySmoke: true, stateRoot },
          ),
        /brief rejected before dispatch|## Smoke/,
      );
    });
  });

  it("still accepts a clean ## Smoke when refuseOnLossySmoke is true", () => {
    withStateRoot(({ tmp, stateRoot }) => {
      const pre = resolveTaskPreflight(
        tmp,
        { flags: { phase: "review" }, text: CLEAN_BRIEF },
        { refuseOnLossySmoke: true, stateRoot },
      );
      assert.equal(pre.phase, "review");
    });
  });

  it("cmdTask dispatches with lossy brief while cmdTaskDetach rejects before spawn", async () => {
    await withStateRootAsync(async ({ tmp, stateRoot }) => {
      // 1. Foreground cmdTask with LOSSY_BRIEF reaches fake dispatch
      const dispatches = [];
      const fakeDispatch = async (opts) => {
        dispatches.push(opts);
        return {
          job: {
            id: "job-fg-lossy",
            status: "completed",
            startedAt: "2026-10-10T00:00:00.000Z",
            finishedAt: "2026-10-10T00:01:00.000Z",
          },
          resultText: "fg completed",
        };
      };

      const fgRes = await cmdTask(
        tmp,
        { flags: { phase: "review" }, text: LOSSY_BRIEF, _dispatch: fakeDispatch },
        { stateRoot },
      );
      assert.equal(fgRes.exitCode, 0, fgRes.text);
      assert.equal(dispatches.length, 1, "foreground cmdTask must reach dispatch with lossy brief");
      assert.ok(dispatches[0].promptText.includes("review the change"));

      // 2. cmdTaskDetach rejects LOSSY_BRIEF before fake spawn
      let spawnCalls = 0;
      const fakeSpawn = () => {
        spawnCalls++;
        return { pid: 424243, unref() {} };
      };

      await assert.rejects(
        () =>
          cmdTaskDetach(
            tmp,
            { flags: { phase: "review" }, text: LOSSY_BRIEF },
            { stateRoot, spawn: fakeSpawn },
          ),
        /brief rejected before dispatch: the ## Smoke section/,
      );
      assert.equal(spawnCalls, 0, "cmdTaskDetach must reject lossy brief with zero spawn calls");

      // 3. Clean detach control proves fake spawn seam is reachable
      const banner = await cmdTaskDetach(
        tmp,
        { flags: { phase: "review" }, text: CLEAN_BRIEF },
        { stateRoot, spawn: fakeSpawn },
      );
      assert.equal(spawnCalls, 1, "cmdTaskDetach spawns exactly once when brief is clean");
      assert.match(banner, /^Detached task launched \(pid 424243\)\./m);
    });
  });
});
// cmdTaskDetach — smoke baseline refusal before spawn (kusabi #513)
// ---------------------------------------------------------------------------
// Same class as the chain-detach fix: the ## Smoke baseline refusal fired
// only inside the spawned `task`, after the launcher had already printed the
// "Detached task launched" banner.  task-detach now measures the declared
// ## Smoke in the parent when --container is given (never without), before
// the log fd is opened, with the same guard and refusal text the foreground
// path prints.  The fakes drive the REAL smokeBaselineReport through
// createFakeCallTool's exit codes.

const DETACH_TASK_BRIEF =
  "# Task\n\nOrchestrator: test-model | session s-1 | 2026-08-23\n\n" +
  "## Smoke\n\n- `npm test`\n";

describe("cmdTaskDetach smoke baseline refusal (kusabi #513)", () => {
  function detachFixture() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-taskdetach-"));
    const cwd = path.join(tmp, "ws");
    fs.mkdirSync(cwd, { recursive: true });
    const prevStateEnv = process.env.KUSABI_STATE_DIR;
    process.env.KUSABI_STATE_DIR = path.join(tmp, "state");
    const stateDir = stateDirFor(cwd);
    const spawnCalls = [];
    const fakeSpawn = (cmd, args, options) => {
      spawnCalls.push({ cmd, args, options });
      return { pid: 424243, unref() {} };
    };
    return {
      tmp,
      cwd,
      stateDir,
      spawnCalls,
      opts(callTool) {
        return {
          stateRoot: path.join(tmp, "state"),
          now: "2026-09-20T00:00:00.000Z",
          spawn: fakeSpawn,
          callTool,
        };
      },
      cleanup() {
        if (prevStateEnv === undefined) delete process.env.KUSABI_STATE_DIR;
        else process.env.KUSABI_STATE_DIR = prevStateEnv;
        fs.rmSync(tmp, { recursive: true, force: true });
      },
    };
  }

  it("with --container: throws the exact smokeBaselineReport refusal and never spawns", async () => {
    const fx = detachFixture();
    try {
      const callTool = createFakeCallTool({ exitCode: 1 });
      const expected = await smokeBaselineReport({ brief: DETACH_TASK_BRIEF, callTool, container: "cid-1" });
      assert.ok(expected, "a red smoke must produce a refusal from the real guard");
      await assert.rejects(
        () =>
          cmdTaskDetach(
            fx.cwd,
            { flags: { container: "cid-1", phase: "review" }, text: DETACH_TASK_BRIEF },
            fx.opts(callTool),
          ),
        (err) => {
          assert.equal(
            err.message,
            expected,
            "the refusal text must be exactly what smokeBaselineReport returned",
          );
          return true;
        },
      );
      assert.equal(fx.spawnCalls.length, 0, "the injected spawn must never be called for a refused dispatch");
    } finally {
      fx.cleanup();
    }
  });

  it("with --container: green ## Smoke spawns exactly once and returns the unchanged banner", async () => {
    const fx = detachFixture();
    try {
      const callTool = createFakeCallTool({ exitCode: 0 });
      const banner = await cmdTaskDetach(
        fx.cwd,
        { flags: { container: "cid-1", phase: "review" }, text: DETACH_TASK_BRIEF },
        fx.opts(callTool),
      );
      assert.equal(fx.spawnCalls.length, 1, "a green baseline must spawn exactly once");
      assert.match(banner, /^Detached task launched \(pid 424243\)\.$/m);
      assert.match(banner, /Log: .*task-detach-\d+\.log/);
      assert.match(
        banner,
        /kusabi-companion task-wait --next --since 2026-09-20T00:00:00\.000Z/,
      );
    } finally {
      fx.cleanup();
    }
  });

  it("without --container: never calls callTool and spawns exactly once", async () => {
    const fx = detachFixture();
    try {
      const calls = [];
      const spyCallTool = async (tool, params) => {
        calls.push([tool, params]);
        return { output: "" };
      };
      const banner = await cmdTaskDetach(
        fx.cwd,
        { flags: { phase: "review" }, text: DETACH_TASK_BRIEF },
        fx.opts(spyCallTool),
      );
      assert.deepEqual(calls, [], "no --container must mean no container call at all");
      assert.equal(fx.spawnCalls.length, 1, "without a probe the detach spawns exactly once");
      assert.match(banner, /Detached task launched/);
    } finally {
      fx.cleanup();
    }
  });
});
// ---------------------------------------------------------------------------
// codex backend capability honesty (kusabi #527)
// --read-only is accepted because every codex invocation runs in the fixed
// read-only sandbox; a user-supplied --deny cannot be enforced and must be
// rejected, never recorded as applied.
// ---------------------------------------------------------------------------

describe("resolveTaskPreflight codex capability honesty", () => {
  const SIG = "Orchestrator: test-model | session test-session | 2026-09-12";
  const BRIEF = [SIG, "", "implement the change", "## Smoke", "", "- `npm test`", ""].join("\n");

  function withStateRoot(fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-task-codex-"));
    const stateRoot = path.join(tmp, "state");
    fs.mkdirSync(stateRoot, { recursive: true });
    try {
      return fn({ tmp, stateRoot });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it("--backend codex with --read-only passes preflight (the sandbox is always read-only)", () => {
    withStateRoot(({ tmp, stateRoot }) => {
      const pre = resolveTaskPreflight(
        tmp,
        { flags: { backend: "codex", readOnly: true }, text: BRIEF },
        { stateRoot },
      );
      assert.equal(pre.backend, "codex");
      assert.ok(pre.tools);
      // Bare no-MCP task retains raw opencode tool names
      assert.equal(pre.tools.write, false);
      assert.equal(pre.tools.bash, false);
    });
  });

  it("--backend codex with --read-only and MCP agent translates tools to MCP names", () => {
    withStateRoot(({ tmp, stateRoot }) => {
      const pre = resolveTaskPreflight(
        tmp,
        { flags: { backend: "codex", readOnly: true, agent: "kusabi-implement" }, text: BRIEF },
        { stateRoot },
      );
      assert.equal(pre.backend, "codex");
      assert.equal(pre.agent, "kusabi-implement");
      assert.equal(pre.tools.mcp__sunaba__write_file, false);
      assert.equal(pre.tools.mcp__sunaba__sandbox_exec, false);
    });
  });

  it("--backend codex with --deny is rejected before dispatch", () => {
    withStateRoot(({ tmp, stateRoot }) => {
      assert.throws(
        () => resolveTaskPreflight(
          tmp,
          { flags: { backend: "codex", deny: "bash,write" }, text: BRIEF },
          { stateRoot },
        ),
        /--deny is not supported on the codex backend/,
      );
    });
  });

  it("--backend codex with --read-only AND --deny is rejected for the --deny half", () => {
    withStateRoot(({ tmp, stateRoot }) => {
      assert.throws(
        () => resolveTaskPreflight(
          tmp,
          { flags: { backend: "codex", readOnly: true, deny: "task" }, text: BRIEF },
          { stateRoot },
        ),
        /--deny is not supported on the codex backend/,
      );
    });
  });
});

// resolveTaskPreflight phase guard — coordinate stays a seat contract, not a
// task phase (independent review finding F1, job-muavz7j8ef8c)
// ---------------------------------------------------------------------------
// PHASE_AGENTS.coordinate (kusabi #529) is registered NON-enumerably: it
// exists for the Luna seat prompt contract but must remain unreachable from
// the `task` surface until the #530 mission driver deliberately wires it.  A
// property-access guard (`if (!PHASE_AGENTS[phase])`) would accept it — the
// regressions here pin the enumerable-keys guard: `task --phase coordinate`
// stays an unknown phase while every ordinary worker phase keeps its preflight
// behavior.

describe("resolveTaskPreflight phase guard (coordinate stays unknown until #530)", () => {
  const SIG = "Orchestrator: test-model | session test-session | 2026-09-12";
  const BRIEF = [
    SIG,
    "",
    "implement the change",
    "## Deliverables",
    "",
    "- `plugins/kusabi/scripts/x.mjs`",
    "",
    "## Smoke",
    "",
    "- `npm test`",
    "",
  ].join("\n");

  function withStateRoot(fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-task-phase-"));
    const stateRoot = path.join(tmp, "state");
    fs.mkdirSync(stateRoot, { recursive: true });
    try {
      return fn({ tmp, stateRoot });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it("rejects --phase coordinate as unknown (the non-enumerable seat contract is not a task phase)", () => {
    withStateRoot(({ tmp, stateRoot }) => {
      assert.throws(
        () =>
          resolveTaskPreflight(
            tmp,
            { flags: { phase: "coordinate", container: "cid-1" }, text: BRIEF },
            { stateRoot },
          ),
        /unknown phase: coordinate\. Use implement\|review\|respond\|gofer\|test-author\|plan/,
      );
    });
  });

  it("keeps accepting every ordinary worker phase", () => {
    withStateRoot(({ tmp, stateRoot }) => {
      for (const phase of ["implement", "review", "respond", "gofer", "test-author", "plan"]) {
        const pre = resolveTaskPreflight(
          tmp,
          { flags: { phase, container: "cid-1" }, text: BRIEF },
          { stateRoot },
        );
        assert.equal(pre.phase, phase);
        assert.ok(pre.agent, `phase ${phase} must resolve an agent`);
      }
    });
  });
});
