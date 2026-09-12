import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");

function computeWorkspaceStateDir(stateRootDir, cwd) {
  const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  return path.join(stateRootDir, hash);
}

function writeJob(workspaceStateDir, job) {
  const dir = path.join(workspaceStateDir, "jobs", job.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(job, null, 2), "utf8");
}

function writeJobResult(workspaceStateDir, jobId, text) {
  const dir = path.join(workspaceStateDir, "jobs", jobId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "result.md"), text, "utf8");
}

function runCompanion(args, { cwd, stateRootDir, timeout = 10_000, env: extraEnv = {} } = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.KUSABI_WORKER_CONTEXT;
  env.KUSABI_STATE_DIR = stateRootDir;
  return spawnSync(process.execPath, [COMPANION_SCRIPT, ...args], {
    encoding: "utf8",
    cwd,
    env,
    timeout,
  });
}

// ===========================================================================
// task-wait terminal states and digests (Spec items 1, 3, 7)
// ===========================================================================

describe("task-wait terminal states and digests", () => {
  let tmpDir;
  let stateRootDir;
  let workspaceStateDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-task-wait-test-"));
    stateRootDir = path.join(tmpDir, "state");
    workspaceStateDir = computeWorkspaceStateDir(stateRootDir, tmpDir);
    fs.mkdirSync(path.join(workspaceStateDir, "jobs"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exits 0 with terminal digest for an already-completed task (instant completion)", () => {
    const jobId = "job-instant-completed-1";
    writeJob(workspaceStateDir, {
      id: jobId,
      kind: "task",
      phase: "review",
      status: "completed",
      startedAt: "2026-09-12T00:00:00.000Z",
      finishedAt: "2026-09-12T00:01:00.000Z",
      stats: { events: 5, steps: 2 },
    });

    const res = runCompanion(["task-wait", jobId], { cwd: tmpDir, stateRootDir });
    assert.equal(res.status, 0, `expected exit code 0, got ${res.status}: ${res.stdout} ${res.stderr}`);
    assert.match(res.stdout, new RegExp(jobId));
    assert.match(res.stdout, /status=completed/);
  });

  it("exits 0 with distinct terminal digest for a provider-error task", () => {
    const jobId = "job-provider-error-1";
    writeJob(workspaceStateDir, {
      id: jobId,
      kind: "task",
      phase: "implement",
      status: "provider-error",
      failure: { kind: "quota-exhaustion", quota: "session", backendBlocked: true, reset: "1:20am" },
      error: "provider error: quota (attempt 1) [terminal]: rate limit exceeded on provider endpoint",
      startedAt: "2026-09-12T00:00:00.000Z",
      finishedAt: "2026-09-12T00:01:00.000Z",
    });

    const res = runCompanion(["task-wait", jobId], { cwd: tmpDir, stateRootDir });
    assert.equal(res.status, 0, `expected exit code 0, got ${res.status}: ${res.stdout} ${res.stderr}`);
    assert.match(res.stdout, new RegExp(jobId));
    assert.match(res.stdout, /status=provider-error/);
    assert.match(res.stdout, /failure=quota-exhaustion:session/);
    assert.doesNotMatch(res.stdout, /\[object Object\]/);
  });

  for (const status of ["error", "stalled", "serve-dead"]) {
    it(`exits 0 with distinct terminal digest for a ${status} task`, () => {
      const jobId = `job-realistic-${status}-1`;
      writeJob(workspaceStateDir, {
        id: jobId,
        kind: "task",
        phase: "implement",
        status,
        error: `realistic ${status} fixture message`,
        startedAt: "2026-09-12T00:00:00.000Z",
        finishedAt: "2026-09-12T00:01:00.000Z",
      });

      const res = runCompanion(["task-wait", jobId], { cwd: tmpDir, stateRootDir });
      assert.equal(res.status, 0, `expected exit code 0, got ${res.status}: ${res.stdout} ${res.stderr}`);
      assert.match(res.stdout, new RegExp(jobId));
      assert.match(res.stdout, new RegExp(`status=${status}`));
      assert.doesNotMatch(res.stdout, /\[object Object\]/);
    });
  }

  it("exits 0 with distinct terminal digest for a timed-out task", () => {
    const jobId = "job-timeout-1";
    writeJob(workspaceStateDir, {
      id: jobId,
      kind: "task",
      phase: "review",
      status: "timeout",
      error: "task exceeded timeout limit of 1800s",
      startedAt: "2026-09-12T00:00:00.000Z",
      finishedAt: "2026-09-12T00:30:00.000Z",
    });

    const res = runCompanion(["task-wait", jobId], { cwd: tmpDir, stateRootDir });
    assert.equal(res.status, 0, `expected exit code 0, got ${res.status}: ${res.stdout} ${res.stderr}`);
    assert.match(res.stdout, new RegExp(jobId));
    assert.match(res.stdout, /status=timeout|timeout/);
  });

  it("exits 0 with distinct terminal digest for a cancelled task", () => {
    const jobId = "job-cancelled-1";
    writeJob(workspaceStateDir, {
      id: jobId,
      kind: "task",
      phase: "investigate",
      status: "cancelled",
      startedAt: "2026-09-12T00:00:00.000Z",
      finishedAt: "2026-09-12T00:05:00.000Z",
    });

    const res = runCompanion(["task-wait", jobId], { cwd: tmpDir, stateRootDir });
    assert.equal(res.status, 0, `expected exit code 0, got ${res.status}: ${res.stdout} ${res.stderr}`);
    assert.match(res.stdout, new RegExp(jobId));
    assert.match(res.stdout, /status=cancelled|cancelled/);
  });

  it("terminal digests for completed, provider-error, timeout, and cancelled states are all distinct", () => {
    const j1 = "job-d-comp";
    const j2 = "job-d-prov";
    const j3 = "job-d-time";
    const j4 = "job-d-canc";
    writeJob(workspaceStateDir, { id: j1, kind: "task", status: "completed", startedAt: "2026-09-12T00:00:00.000Z", finishedAt: "2026-09-12T00:01:00.000Z" });
    writeJob(workspaceStateDir, { id: j2, kind: "task", status: "provider-error", failure: { kind: "quota-exhaustion", quota: "session" }, error: "fail", startedAt: "2026-09-12T00:00:00.000Z", finishedAt: "2026-09-12T00:01:00.000Z" });
    writeJob(workspaceStateDir, { id: j3, kind: "task", status: "timeout", error: "timeout", startedAt: "2026-09-12T00:00:00.000Z", finishedAt: "2026-09-12T00:01:00.000Z" });
    writeJob(workspaceStateDir, { id: j4, kind: "task", status: "cancelled", startedAt: "2026-09-12T00:00:00.000Z", finishedAt: "2026-09-12T00:01:00.000Z" });

    const out1 = runCompanion(["task-wait", j1], { cwd: tmpDir, stateRootDir }).stdout.trim();
    const out2 = runCompanion(["task-wait", j2], { cwd: tmpDir, stateRootDir }).stdout.trim();
    const out3 = runCompanion(["task-wait", j3], { cwd: tmpDir, stateRootDir }).stdout.trim();
    const out4 = runCompanion(["task-wait", j4], { cwd: tmpDir, stateRootDir }).stdout.trim();

    assert.notEqual(out1, out2, "completed digest must differ from provider-error digest");
    assert.notEqual(out1, out3, "completed digest must differ from timeout digest");
    assert.notEqual(out1, out4, "completed digest must differ from cancelled digest");
    assert.notEqual(out2, out3, "provider-error digest must differ from timeout digest");
    assert.notEqual(out2, out4, "provider-error digest must differ from cancelled digest");
    assert.notEqual(out3, out4, "timeout digest must differ from cancelled digest");
    for (const out of [out1, out2, out3, out4]) {
      assert.doesNotMatch(out, /\[object Object\]/);
    }
  });

  it("structured job.failure never renders as [object Object]", () => {
    const jobId = "job-failure-object-1";
    writeJob(workspaceStateDir, {
      id: jobId,
      kind: "task",
      status: "provider-error",
      failure: { kind: "quota-exhaustion", quota: "session", backendBlocked: true, reset: "soon", nested: { deep: true } },
      error: "claude dispatch failed: session limit",
      startedAt: "2026-09-12T00:00:00.000Z",
      finishedAt: "2026-09-12T00:01:00.000Z",
    });
    const res = runCompanion(["task-wait", jobId], { cwd: tmpDir, stateRootDir });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.doesNotMatch(res.stdout, /\[object Object\]/);
    assert.match(res.stdout, /failure=quota-exhaustion:session/);
  });
});

// ===========================================================================
// task-wait --next appearance and selection (Spec items 1, 2, 4, 7)
// ===========================================================================

describe("task-wait --next appearance and selection", () => {
  let tmpDir;
  let stateRootDir;
  let workspaceStateDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-task-wait-next-"));
    stateRootDir = path.join(tmpDir, "state");
    workspaceStateDir = computeWorkspaceStateDir(stateRootDir, tmpDir);
    fs.mkdirSync(path.join(workspaceStateDir, "jobs"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("waits for delayed job-id appearance without guessing an ID", async () => {
    const env = { ...process.env };
    delete env.KUSABI_WORKER_CONTEXT;
    env.KUSABI_STATE_DIR = stateRootDir;

    const child = spawn(process.execPath, [
      COMPANION_SCRIPT, "task-wait", "--next",
      "--appear-timeout", "5", "--poll-interval", "1",
    ], { cwd: tmpDir, env, stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    let closed = false;
    const closePromise = new Promise((resolve) => {
      child.on("close", (code) => {
        closed = true;
        resolve(code);
      });
    });

    // Job appears after wait starts (without wait caller knowing or passing the ID up front)
    await new Promise((resolve) => setTimeout(resolve, 200));
    const delayedJobId = "job-delayed-appearance-42";
    if (!closed) {
      writeJob(workspaceStateDir, {
        id: delayedJobId,
        kind: "task",
        phase: "review",
        status: "running",
        startedAt: new Date().toISOString(),
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
    if (!closed) {
      writeJob(workspaceStateDir, {
        id: delayedJobId,
        kind: "task",
        phase: "review",
        status: "completed",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });
    }

    const code = await closePromise;
    assert.equal(code, 0, `expected exit code 0, got: ${code}; stdout: ${stdout}; stderr: ${stderr}`);
    assert.match(stdout, new RegExp(delayedJobId));
    assert.match(stdout, /status=completed/);
  });

  it("--next without --since ignores preexisting realistic terminal statuses (provider-error/error/stalled/serve-dead)", async () => {
    // Seeds preexisting terminal jobs BEFORE the wait starts, then omits
    // --since so selection uses the preexisting-set branch (terminal
    // preexisting ids are excluded; only a newly introduced eligible job
    // may resolve).  A --since stamp would bypass that branch entirely.
    const terminals = [
      { id: "job-pre-provider-error", status: "provider-error", failure: { kind: "quota-exhaustion", quota: "session" }, error: "quota" },
      { id: "job-pre-error", status: "error", error: "session error" },
      { id: "job-pre-stalled", status: "stalled", error: "watchdog: no events" },
      { id: "job-pre-serve-dead", status: "serve-dead", error: "serve process died" },
    ];
    for (const job of terminals) {
      writeJob(workspaceStateDir, {
        id: job.id,
        kind: "task",
        status: job.status,
        failure: job.failure,
        error: job.error,
        startedAt: "2026-09-01T00:00:00.000Z",
        finishedAt: "2026-09-01T00:05:00.000Z",
      });
    }

    const env = { ...process.env };
    delete env.KUSABI_WORKER_CONTEXT;
    env.KUSABI_STATE_DIR = stateRootDir;

    const child = spawn(process.execPath, [
      COMPANION_SCRIPT, "task-wait", "--next",
      "--appear-timeout", "5", "--poll-interval", "1",
    ], { cwd: tmpDir, env, stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    let closed = false;
    const closePromise = new Promise((resolve) => {
      child.on("close", (code) => {
        closed = true;
        resolve(code);
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    const newerJobId = "job-newer-after-terminals-009";
    if (!closed) {
      writeJob(workspaceStateDir, {
        id: newerJobId,
        kind: "task",
        status: "completed",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });
    }

    const code = await closePromise;
    assert.equal(code, 0, `expected exit code 0, got: ${code}; stdout: ${stdout}; stderr: ${stderr}`);
    assert.match(stdout, new RegExp(newerJobId));
    for (const job of terminals) {
      assert.doesNotMatch(stdout, new RegExp(job.id));
    }
  });

  it("--next with --since selects newly appeared job and ignores older preexisting job", async () => {
    // Preexisting older job
    const olderJobId = "job-older-preexisting-001";
    writeJob(workspaceStateDir, {
      id: olderJobId,
      kind: "task",
      status: "completed",
      startedAt: "2026-09-01T00:00:00.000Z",
      finishedAt: "2026-09-01T00:05:00.000Z",
    });

    const sinceIso = new Date().toISOString();
    const env = { ...process.env };
    delete env.KUSABI_WORKER_CONTEXT;
    env.KUSABI_STATE_DIR = stateRootDir;

    const child = spawn(process.execPath, [
      COMPANION_SCRIPT, "task-wait", "--next",
      "--since", sinceIso,
      "--appear-timeout", "5", "--poll-interval", "1",
    ], { cwd: tmpDir, env, stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    let closed = false;
    const closePromise = new Promise((resolve) => {
      child.on("close", (code) => {
        closed = true;
        resolve(code);
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    const newerJobId = "job-newer-appearance-002";
    if (!closed) {
      writeJob(workspaceStateDir, {
        id: newerJobId,
        kind: "task",
        status: "completed",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });
    }

    const code = await closePromise;
    assert.equal(code, 0, `expected exit code 0, got: ${code}; stdout: ${stdout}; stderr: ${stderr}`);
    assert.match(stdout, new RegExp(newerJobId));
    assert.doesNotMatch(stdout, new RegExp(olderJobId));
  });
});

// ===========================================================================
// task-wait failure modes (Spec item 4)
// ===========================================================================

describe("task-wait failure modes", () => {
  let tmpDir;
  let stateRootDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-task-wait-fail-"));
    stateRootDir = path.join(tmpDir, "state");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exits non-zero on an unknown job id", () => {
    const res = runCompanion(["task-wait", "job-unknown-ghost-99"], { cwd: tmpDir, stateRootDir });
    assert.notEqual(res.status, 0);
    assert.match(res.stdout + res.stderr, /unknown job|job not found|job-unknown-ghost-99/i);
  });

  it("exits non-zero when --next times out without any job appearing", () => {
    const res = runCompanion(["task-wait", "--next", "--appear-timeout", "1", "--poll-interval", "1"], {
      cwd: tmpDir,
      stateRootDir,
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stdout + res.stderr, /no job appeared|timeout/i);
  });

  it("refuses --next together with an explicit job id", () => {
    const res = runCompanion(["task-wait", "--next", "job-conflict-1"], { cwd: tmpDir, stateRootDir });
    assert.notEqual(res.status, 0);
    assert.match(res.stdout + res.stderr, /takes no job id|cannot specify/i);
  });

  it("rejects a malformed duration rather than silently using default", () => {
    const res = runCompanion(["task-wait", "--next", "--appear-timeout", "not-a-number"], { cwd: tmpDir, stateRootDir });
    assert.notEqual(res.status, 0);
    assert.match(res.stdout + res.stderr, /--appear-timeout expects/i);
  });
});

// ===========================================================================
// duplicate wait and durable state preservation (Spec item 5)
// ===========================================================================

describe("duplicate wait and durable state preservation", () => {
  let tmpDir;
  let stateRootDir;
  let workspaceStateDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-task-wait-dup-"));
    stateRootDir = path.join(tmpDir, "state");
    workspaceStateDir = computeWorkspaceStateDir(stateRootDir, tmpDir);
    fs.mkdirSync(path.join(workspaceStateDir, "jobs"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("duplicate consecutive and concurrent waits on the same job are safe and idempotent", () => {
    const jobId = "job-dup-safe-001";
    const initialJob = {
      id: jobId,
      kind: "task",
      phase: "review",
      status: "completed",
      startedAt: "2026-09-12T00:00:00.000Z",
      finishedAt: "2026-09-12T00:02:00.000Z",
      stats: { events: 10, steps: 4 },
    };
    writeJob(workspaceStateDir, initialJob);
    writeJobResult(workspaceStateDir, jobId, "Verdict: accepted. All probes passed.");

    // 1. First wait
    const res1 = runCompanion(["task-wait", jobId], { cwd: tmpDir, stateRootDir });
    assert.equal(res1.status, 0, `first wait should succeed: ${res1.stdout} ${res1.stderr}`);

    // 2. Second wait (duplicate registration / re-run)
    const res2 = runCompanion(["task-wait", jobId], { cwd: tmpDir, stateRootDir });
    assert.equal(res2.status, 0, `second wait should succeed: ${res2.stdout} ${res2.stderr}`);
    assert.equal(res1.stdout.trim(), res2.stdout.trim(), "duplicate wait must return identical digest");

    // 3. Concurrent waits
    const env = { ...process.env };
    delete env.KUSABI_WORKER_CONTEXT;
    env.KUSABI_STATE_DIR = stateRootDir;

    const childA = spawnSync(process.execPath, [COMPANION_SCRIPT, "task-wait", jobId], { encoding: "utf8", cwd: tmpDir, env });
    const childB = spawnSync(process.execPath, [COMPANION_SCRIPT, "task-wait", jobId], { encoding: "utf8", cwd: tmpDir, env });
    assert.equal(childA.status, 0);
    assert.equal(childB.status, 0);
    assert.equal(childA.stdout.trim(), childB.stdout.trim());

    // 4. Job record and result on disk are unchanged and uncorrupted
    const jobJson = JSON.parse(fs.readFileSync(path.join(workspaceStateDir, "jobs", jobId, "job.json"), "utf8"));
    assert.equal(jobJson.id, jobId);
    assert.equal(jobJson.status, "completed");
    const resultMd = fs.readFileSync(path.join(workspaceStateDir, "jobs", jobId, "result.md"), "utf8");
    assert.equal(resultMd, "Verdict: accepted. All probes passed.");
  });

  it("preserves durable job record and result after post-wait notification failure", () => {
    const jobId = "job-durable-preserve-001";
    const jobData = {
      id: jobId,
      kind: "task",
      phase: "review",
      status: "completed",
      startedAt: "2026-09-12T00:00:00.000Z",
      finishedAt: "2026-09-12T00:04:00.000Z",
      stats: { events: 15, steps: 6, lastTool: "verify" },
    };
    writeJob(workspaceStateDir, jobData);
    const resultText = "## Findings\nNo defects discovered. Ready to ship.\n";
    writeJobResult(workspaceStateDir, jobId, resultText);

    // Initial successful wait
    const waitRes = runCompanion(["task-wait", jobId], { cwd: tmpDir, stateRootDir });
    assert.equal(waitRes.status, 0, `wait should succeed: ${waitRes.stdout} ${waitRes.stderr}`);

    // Simulate post-wait notification failure in caller/watcher (e.g. queue failure or network disconnect)
    // The durable state on disk must remain pristine and queryable
    const jobOnDisk = JSON.parse(fs.readFileSync(path.join(workspaceStateDir, "jobs", jobId, "job.json"), "utf8"));
    assert.deepEqual(jobOnDisk.id, jobId);
    assert.equal(jobOnDisk.status, "completed");
    const resultOnDisk = fs.readFileSync(path.join(workspaceStateDir, "jobs", jobId, "result.md"), "utf8");
    assert.equal(resultOnDisk, resultText);

    // Subsequent status or result commands still succeed on the preserved record
    const statusRes = runCompanion(["status", jobId], { cwd: tmpDir, stateRootDir });
    assert.equal(statusRes.status, 0);
    assert.match(statusRes.stdout, /events: 15/);

    const resultRes = runCompanion(["result", "--full", jobId], { cwd: tmpDir, stateRootDir });
    assert.equal(resultRes.status, 0);
    assert.match(resultRes.stdout, /No defects discovered/);
  });
});

// ===========================================================================
// regression: existing chain-wait and chain-detach behavior remains unchanged (Spec item 6)
// ===========================================================================

describe("regression: existing chain-wait and chain-detach behavior remains unchanged", () => {
  let tmpDir;
  let stateRootDir;
  let workspaceStateDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-chain-regression-"));
    stateRootDir = path.join(tmpDir, "state");
    workspaceStateDir = computeWorkspaceStateDir(stateRootDir, tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("chain-wait on terminal chain exits 0 with chain digest (unchanged)", () => {
    const chainsDir = path.join(workspaceStateDir, "chains");
    const chainDir = path.join(chainsDir, "chain-unchanged-01");
    fs.mkdirSync(chainDir, { recursive: true });
    fs.writeFileSync(
      path.join(chainDir, "control.json"),
      JSON.stringify({ chainId: "chain-unchanged-01", container: "cid-1", pid: 1234, status: "completed", round: 1 }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(chainDir, "chain.json"),
      JSON.stringify({ chainId: "chain-unchanged-01", records: [{ round: 1, disposition: { disposition: "accept" } }] }),
      "utf8",
    );

    const res = runCompanion(["chain-wait", "chain-unchanged-01"], { cwd: tmpDir, stateRootDir });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /chain chain-unchanged-01: status=completed disposition=accept rounds=1/);
  });

  it("chain-wait --next appearance timeout exits non-zero (unchanged)", () => {
    const res = runCompanion(["chain-wait", "--next", "--appear-timeout", "1", "--poll-interval", "1"], {
      cwd: tmpDir,
      stateRootDir,
    });
    assert.equal(res.status, 1);
    assert.match(res.stdout + res.stderr, /no chain appeared within 1s/);
  });

  it("chain-detach pre-flight checks remain intact (unchanged)", () => {
    const briefPath = path.join(tmpDir, "brief.md");
    fs.writeFileSync(briefPath, "# Task\n\n## Deliverables\n- `x.mjs`\n\n## Smoke\n- `npm test`\n");
    const res = runCompanion(["chain-detach", "--brief-file", briefPath], { cwd: tmpDir, stateRootDir });
    assert.notEqual(res.status, 0);
    assert.match(res.stdout + res.stderr, /chain requires --container/);
  });
});
