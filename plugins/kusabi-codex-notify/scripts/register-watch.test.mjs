// register-watch.test.mjs — task watcher notification classification for
// kusabi #496: an incomplete recovered run (finish "unknown" + idle + no
// final payload + failed P3/P4) must never be notified as completed success.
//
// The job writer (plugins/kusabi/scripts/prompt-execution.mjs) closes such a
// job as `error` — the watcher already renders that class "failed" and
// task-wait already treats it as terminal, so the notification side needs no
// classification change: this suite pins that the reclassified job record
// flows through registerTaskWatch / watchTask into a "failed" notification
// while read-only plan/review jobs keep their completed class.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import {
  OUTCOME_DELIVERED,
  TASK_TERMINAL_STATUSES,
  readJson,
  writeRecordAtomic,
  getRecordPath,
  readTaskJob,
  parseTaskWaitDigest,
  classifyTaskStatusClass,
  watchTask,
} from "./watch-chain.mjs";

import {
  registerTaskWatch,
  resumePendingWatches,
} from "./register-watch.mjs";

// The wait command's own terminal set — the other half of "the chosen
// closed status terminates the wait": task-wait must resolve `error` exactly
// like every other closed status, or a reclassified job would stall the
// watcher forever.
import { TERMINAL_TASK_STATUSES } from "../../kusabi/scripts/task-wait.mjs";

describe("kusabi-codex-notify task classification (kusabi #496)", () => {
  let tmpRoot;
  let stateDir;
  let kusabiStateDir;
  let workspaceDir;
  let mockCompanionScript;
  let mockCodexScript;
  let queueLogDir;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kcn-496-"));
    stateDir = path.join(tmpRoot, "notify-state");
    kusabiStateDir = path.join(tmpRoot, "kusabi-state");
    workspaceDir = path.join(tmpRoot, "workspace");
    queueLogDir = path.join(tmpRoot, "queue-logs");

    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(kusabiStateDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(queueLogDir, { recursive: true });

    // Deterministic stand-in companion with a blocking task-wait that polls
    // the durable job record until a TERMINAL status appears.  `error` is in
    // the terminal set: a reclassified incomplete job must resolve the wait.
    mockCompanionScript = path.join(tmpRoot, "mock-companion.mjs");
    fs.writeFileSync(
      mockCompanionScript,
      `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";

const args = process.argv.slice(2);
const subcmd = args[0];
const id = args[1];
const cwd = process.cwd();
const hash = crypto.createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 12);
const kusabiRoot = process.env.KUSABI_STATE_DIR || path.join(process.env.HOME || "/tmp", ".kusabi");
const jobFile = path.join(kusabiRoot, hash, "jobs", id, "job.json");
const TERMINAL = new Set(["completed", "timeout", "cancelled", "provider-error", "error", "stalled", "serve-dead"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.env.TEST_COMPANION_FAIL === "1") {
  fs.writeSync(2, "mock error: companion failed or stalled\\n");
  process.exitCode = 1;
} else if (subcmd === "chain-detach") {
  fs.writeSync(1, "Detached chain launched (pid 999).\\nLog: /tmp/log\\nTo wait for completion, run:\\n  kusabi-companion chain-wait chain-x\\n");
  process.exitCode = 0;
} else if (subcmd === "chain-wait") {
  fs.writeSync(1, "chain " + id + ": status=completed disposition=accept rounds=1 waited=2s container=1d90ea9e70b6\\n");
  process.exitCode = 0;
} else if (subcmd === "task-detach") {
  const since = process.env.TEST_TASK_SINCE || "2026-09-13T12:00:00.000Z";
  fs.writeSync(1, "Detached task launched (pid 999).\\nLog: /tmp/kusabi/state/task-detach-1788698641659.log\\n\\nTo wait for completion, run:\\n  kusabi-companion task-wait --next --since " + since + "\\n");
  process.exitCode = 0;
} else if (subcmd === "task-wait") {
  (async () => {
    const pollMs = Number(process.env.TEST_TASK_WAIT_POLL_MS || 25);
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      let job = null;
      try { job = JSON.parse(fs.readFileSync(jobFile, "utf8")); } catch {}
      if (job && TERMINAL.has(job.status)) {
        const phase = job.phase ? " phase=" + job.phase : "";
        const err = (typeof job.error === "string" && job.error) ? " error=" + job.error.replace(/\\s+/g, " ").slice(0, 120) : "";
        fs.writeSync(1, "task " + id + ": status=" + job.status + phase + err + " waited=2s\\n");
        process.exitCode = 0;
        return;
      }
      await sleep(pollMs);
    }
    fs.writeSync(2, "task " + id + ": timed out waiting for terminal state\\n");
    process.exitCode = 1;
  })();
} else {
  fs.writeSync(2, "unknown subcommand " + subcmd + "\\n");
  process.exitCode = 1;
}
`,
      { mode: 0o755 }
    );

    mockCodexScript = path.join(tmpRoot, "mock-codex.mjs");
    fs.writeFileSync(
      mockCodexScript,
      `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const logDir = process.env.TEST_QUEUE_LOG_DIR;
const args = process.argv.slice(2);

if (logDir) {
  const file = path.join(logDir, Date.now() + "-" + process.pid + "-" + Math.random().toString(36).slice(2) + ".json");
  fs.writeFileSync(file, JSON.stringify({ argv: args, pid: process.pid, time: Date.now() }), "utf8");
}
process.exitCode = 0;
`,
      { mode: 0o755 }
    );
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch { /* best-effort */ }
  });

  function getQueueInvocations() {
    try {
      const files = fs.readdirSync(queueLogDir);
      const invocations = [];
      for (const file of files) {
        if (file.endsWith(".json")) {
          invocations.push(JSON.parse(fs.readFileSync(path.join(queueLogDir, file), "utf8")));
        }
      }
      return invocations;
    } catch {
      return [];
    }
  }

  /**
   * Write a durable job record exactly as a (fixed) companion would after a
   * kusabi #496 reclassification: closed non-success status, the recovered
   * result marker, and the caller-recorded probe truth.
   */
  function setupRecoveredJobFiles(jobId, { status, phase = "test-author", recovered = true, probesGreen = false, probeResults = null } = {}) {
    const ws = path.resolve(workspaceDir);
    const hash = crypto.createHash("sha256").update(ws).digest("hex").slice(0, 12);
    const jobDir = path.join(kusabiStateDir, hash, "jobs", jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    const job = {
      id: jobId,
      kind: "task",
      title: "kusabi 496 fixture",
      status,
      phase,
      backend: "opencode",
      modelEntry: "opencode-go/deepseek-v4-flash:max",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      cwd: ws,
      sessionID: "ses-496",
      error: status === "error"
        ? "incomplete execution: provider reported finish \"unknown\" and no final message was produced — the recovered phase " + phase + " result is not a completed output"
        : null,
      stopReason: status === "error" ? "unknown" : "completed",
      result: recovered
        ? {
            source: "recovered",
            recovered: true,
            fetchFailed: false,
            fetchError: null,
            recovery: { source: "opencode-events", chars: 155517 },
          }
        : { source: "final-message", recovered: false, fetchFailed: false, fetchError: null, recovery: null },
      probesGreen,
      probeResults: probeResults ?? [
        { probe: "P3: deliverables", passed: false, detail: "no declared deliverable paths changed" },
        { probe: "P4: smoke", passed: false, detail: "declared test files absent, pytest exit 4" },
        { probe: "P2: verify", passed: true, detail: "1062 passed" },
      ],
    };
    fs.writeFileSync(path.join(jobDir, "job.json"), JSON.stringify(job), "utf8");
    return jobDir;
  }

  const taskEnv = (extra = {}) => ({
    ...process.env,
    KUSABI_STATE_DIR: kusabiStateDir,
    TEST_QUEUE_LOG_DIR: queueLogDir,
    ...extra,
  });

  it("a reclassified recovered-incomplete job (error, no final, failed P3/P4) is notified as failed, never completed", async () => {
    const jobId = "job-496-incomplete";
    setupRecoveredJobFiles(jobId, { status: "error", phase: "test-author" });

    const res = await registerTaskWatch({
      jobId,
      threadId: "thread-496",
      cwd: workspaceDir,
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      sync: true,
      env: taskEnv(),
    });

    assert.equal(res.outcome, OUTCOME_DELIVERED);
    assert.equal(res.record.status, "delivered");

    const msg = res.record.notification.message;
    assert.match(msg, /\[kusabi\] Task job-496-incomplete error\./);
    assert.match(msg, /- Status: error/);
    assert.match(msg, /- Class: failed/);
    assert.match(msg, /- Phase: test-author/);

    // kusabi #496: the notification names the recovered/no-final state and
    // the failed probes — the exact user-visible evidence of the
    // incompleteness, never a bare status line.
    assert.match(msg, /- Result: recovered \(no final message\)/);
    assert.match(msg, /- Failed probes:/);
    assert.match(msg, /P3: deliverables \u2014 FAIL \(no declared deliverable paths changed\)/);
    assert.match(msg, /P4: smoke \u2014 FAIL \(declared test files absent, pytest exit 4\)/);

    // The recovered result and the failed probes stay visible in the watch
    // record's captured job state (the stored result is not hidden).
    const taskState = res.record.taskState;
    assert.equal(taskState.status, "error");
    assert.equal(taskState.job.result.recovered, true);
    assert.equal(taskState.job.result.source, "recovered");
    assert.equal(taskState.job.probesGreen, false);
    const p3 = taskState.job.probeResults.find((p) => p.probe === "P3: deliverables");
    const p4 = taskState.job.probeResults.find((p) => p.probe === "P4: smoke");
    assert.ok(p3 && p3.passed === false);
    assert.ok(p4 && p4.passed === false);

    // Exactly one queue call carried the failed notification.
    const invocations = getQueueInvocations();
    assert.equal(invocations.length, 1);
    assert.deepEqual(invocations[0].argv.slice(0, 3), ["queue", "--thread", "thread-496"]);
  });

  it("a read-only plan job with a recovered result stays completed success", async () => {
    const jobId = "job-496-plan";
    setupRecoveredJobFiles(jobId, {
      status: "completed",
      phase: "plan",
      probesGreen: true,
      probeResults: [
        { probe: "P3: deliverables", passed: true, detail: "touches declared deliverables" },
        { probe: "P4: smoke", passed: true, detail: "all smoke command(s) passed" },
        { probe: "P2: verify", passed: true, detail: "1062 passed" },
      ],
    });

    const res = await watchTask({
      jobId,
      threadId: "thread-496-plan",
      cwd: workspaceDir,
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      env: taskEnv(),
    });

    assert.equal(res.outcome, OUTCOME_DELIVERED);
    const msg = res.record.notification.message;
    assert.match(msg, /- Status: completed/);
    assert.match(msg, /- Class: completed/);
    assert.match(msg, /- Phase: plan/);
    // The carve-out stays successful; the recovered state is still honest.
    assert.match(msg, /- Result: recovered \(no final message\)/);
    assert.doesNotMatch(msg, /- Failed probes:/);
  });

  it("the chosen closed status (error) is terminal for both task-wait and the watcher", () => {
    // The wait command must resolve the reclassified job ...
    assert.equal(TERMINAL_TASK_STATUSES.has("error"), true, "task-wait must treat error as terminal");
    // ... and the watcher must accept the digest and render class failed.
    assert.equal(TASK_TERMINAL_STATUSES.has("error"), true, "watcher must accept error as terminal");
    assert.equal(classifyTaskStatusClass("error"), "failed");
    assert.equal(classifyTaskStatusClass("completed"), "completed");
  });

  it("task-wait digest reports status=error for a reclassified job", () => {
    // The digest grammar is `key=value` pairs split on whitespace, so a
    // multi-word error value is truncated at the first space (the parser's
    // long-standing contract, shared with the chain digest).  What matters
    // for the wait is that status=error is a terminal observation.
    const parsed = parseTaskWaitDigest(
      "task job-496: status=error phase=test-author error=incomplete execution: provider reported finish waited=2s\n"
    );
    assert.ok(parsed);
    assert.equal(parsed.jobId, "job-496");
    assert.equal(parsed.status, "error");
    assert.equal(parsed.phase, "test-author");
    assert.equal(parsed.error, "incomplete");
  });

  it("a recovered-incomplete job's resume re-delivers as failed exactly once", async () => {
    const jobId = "job-496-resume";
    setupRecoveredJobFiles(jobId, { status: "error", phase: "gofer" });

    const recPath = getRecordPath(stateDir, { kind: "task", id: jobId });
    writeRecordAtomic(recPath, {
      subject: { kind: "task", id: jobId },
      jobId,
      threadId: "thread-496-resume",
      cwd: workspaceDir,
      status: "waiting",
      outcome: null,
      pid: 99999999,
      startTime: "12345",
    });

    const res = await resumePendingWatches({
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      sync: true,
      env: taskEnv(),
    });

    assert.equal(res.resumed, 1);
    assert.deepEqual(res.subjects, [{ kind: "task", id: jobId }]);

    const updated = readJson(recPath);
    assert.equal(updated.status, "delivered");
    assert.match(updated.notification.message, /- Class: failed/);
    assert.match(updated.notification.message, /- Phase: gofer/);

    // The durable job record is untouched by the watcher.
    assert.equal(readTaskJob(jobId, workspaceDir, kusabiStateDir).status, "error");
    assert.equal(getQueueInvocations().length, 1);
  });
});
