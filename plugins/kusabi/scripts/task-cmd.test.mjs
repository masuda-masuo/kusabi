import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  __testProbeBindings,
  buildTaskReviewInput,
  cmdReview,
} from "./task-cmd.mjs";
import { stateDirFor } from "./state-paths.mjs";

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
    const callTool = async (tool, params) => {
      const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
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
      return { output: "" };
    };
    return { commands, callTool };
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

  it("is what cmdTask appends to the task prompt (source guard)", async () => {
    // cmdTask lives in task-cmd.mjs (kusabi #437); this pins the wiring —
    // the review input is built before dispatch and concatenated onto the prompt that is sent.
    const source = fs.readFileSync(path.join(import.meta.dirname, "task-cmd.mjs"), "utf8");
    const cmdTaskSource = source.slice(source.indexOf("async function cmdTask("), source.indexOf("async function cmdReview("));
    assert.ok(cmdTaskSource.includes("await buildTaskReviewInput({ phase, flags })"));
    assert.ok(cmdTaskSource.includes("promptText: taskPromptText"));
    assert.ok(cmdTaskSource.includes("${taskReviewInput}"));
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
