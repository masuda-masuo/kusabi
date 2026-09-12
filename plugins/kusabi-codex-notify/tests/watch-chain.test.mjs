// watch-chain.test.mjs — comprehensive tests for kusabi-codex-notify
//
// Chain regression suite (ported from the kairanban plugin unchanged in
// behaviour) plus the task lifecycle tests (kusabi #491): task launch via
// `--launch-task` (task-detach selector resolution), task-wait ownership,
// the four terminal classes, at-most-once delivery, restart recovery, queue
// failure/retry, malformed/refused launch, missing container metadata, and
// explicit chain/task subject separation.  All stand-ins are deterministic —
// no real LLM or Codex call happens in any test.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  OUTCOME_DELIVERED,
  OUTCOME_CLOSED_OR_UNAVAILABLE,
  OUTCOME_QUEUE_FAILURE,
  OUTCOME_CHAIN_WAIT_FAILURE,
  OUTCOME_TASK_WAIT_FAILURE,
  OUTCOME_MALFORMED_REGISTRATION,
  OUTCOME_ALREADY_DELIVERED,
  OUTCOME_AMBIGUOUS_DELIVERY,
  MAX_DELIVERY_ATTEMPTS,
  TASK_TERMINAL_STATUSES,
  getStateDir,
  getRecordPath,
  getClaimPath,
  getKusabiWorkspaceHash,
  readJson,
  writeRecordAtomic,
  validateRegistration,
  tryAcquireClaim,
  acquireClaimLock,
  updateClaim,
  getProcessStartTime,
  checkWatcherProcess,
  isWatcherProcessAlive,
  readChainState,
  readTaskJob,
  parseTaskWaitDigest,
  classifyTaskStatusClass,
  describeTaskBackendModel,
  getTaskRecoveryCommands,
  formatNotificationMessage,
  formatTaskNotificationMessage,
  evaluateQueueResult,
  runProcess,
  watchChain,
  watchTask,
} from "../scripts/watch-chain.mjs";

import {
  registerWatch,
  registerTaskWatch,
  resumePendingWatches,
  extractDispatchFromHookInput,
  launchAndWatch,
  launchTaskAndWatch,
  resolveJobIdFromSince,
  resolveChainFromSince,
} from "../scripts/register-watch.mjs";
import * as registerWatchApi from "../scripts/register-watch.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTER_SCRIPT = path.join(__dirname, "..", "scripts", "register-watch.mjs");

describe("kusabi-codex-notify unit and integration tests", () => {
  let tmpRoot;
  let stateDir;
  let kusabiStateDir;
  let workspaceDir;
  let mockCompanionScript;
  let mockCodexScript;
  let queueLogDir;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kcn-test-"));
    stateDir = path.join(tmpRoot, "notify-state");
    kusabiStateDir = path.join(tmpRoot, "kusabi-state");
    workspaceDir = path.join(tmpRoot, "workspace");
    queueLogDir = path.join(tmpRoot, "queue-logs");

    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(kusabiStateDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(queueLogDir, { recursive: true });

    // Create fake companion script — deterministic stand-in for
    // kusabi-companion.  chain-detach / chain-wait mirror the original mock;
    // task-detach prints the exact `task-wait --next --since <ISO>` selector
    // line, and task-wait BLOCKS polling the durable job record until it is
    // terminal (that blocking wait is what "task-wait owns waiting" means).
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
  fs.writeSync(2, \`mock error: \${subcmd} failed or stalled\\n\`);
  process.exitCode = 1;
} else if (subcmd === "chain-detach") {
  const customId = process.env.TEST_DETACH_CHAIN_ID || "chain-launch-01";
  fs.writeSync(1, \`Detached chain launched (pid 999).\\nLog: /tmp/log\\nTo wait for completion, run:\\n  kusabi-companion chain-wait \${customId}\\n\`);
  process.exitCode = 0;
} else if (subcmd === "chain-wait") {
  if (process.env.TEST_COMPANION_NO_CONTAINER === "1") {
    fs.writeSync(1, \`chain \${id}: status=completed disposition=accept rounds=1 waited=2s\\n\`);
  } else {
    fs.writeSync(1, \`chain \${id}: status=completed disposition=accept rounds=1 waited=2s container=1d90ea9e70b6\\n\`);
  }
  process.exitCode = 0;
} else if (subcmd === "task-detach") {
  const since = process.env.TEST_TASK_SINCE || "2026-09-06T12:00:00.000Z";
  fs.writeSync(1, \`Detached task launched (pid 999).\\nLog: /tmp/kusabi/state/task-detach-1788698641659.log\\n\\nTo wait for completion, run:\\n  kusabi-companion task-wait --next --since \${since}\\n\`);
  process.exitCode = 0;
} else if (subcmd === "task-wait") {
  (async () => {
    if (process.env.TEST_TASK_WAIT_MISMATCH === "1") {
      fs.writeSync(1, \`task wrong-job-999: status=completed waited=2s\\n\`);
      process.exitCode = 0;
      return;
    }
    const pollMs = Number(process.env.TEST_TASK_WAIT_POLL_MS || 25);
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      let job = null;
      try { job = JSON.parse(fs.readFileSync(jobFile, "utf8")); } catch {}
      if (job && TERMINAL.has(job.status)) {
        const phase = job.phase ? \` phase=\${job.phase}\` : "";
        const failure = job.failure ? \` failure=\${typeof job.failure === "string" ? job.failure : JSON.stringify(job.failure)}\` : "";
        const err = (typeof job.error === "string" && job.error) ? \` error=\${job.error.replace(/\\s+/g, " ").slice(0, 120)}\` : "";
        fs.writeSync(1, \`task \${id}: status=\${job.status}\${phase}\${failure}\${err} waited=2s\\n\`);
        process.exitCode = 0;
        return;
      }
      await sleep(pollMs);
    }
    fs.writeSync(2, \`task \${id}: timed out waiting for terminal state\\n\`);
    process.exitCode = 1;
  })();
} else {
  fs.writeSync(2, \`unknown subcommand \${subcmd}\\n\`);
  process.exitCode = 1;
}
`,
      { mode: 0o755 }
    );

    // Create fake codex script
    mockCodexScript = path.join(tmpRoot, "mock-codex.mjs");
    fs.writeFileSync(
      mockCodexScript,
      `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const logDir = process.env.TEST_QUEUE_LOG_DIR;
const args = process.argv.slice(2);

// Append invocation safely per process
if (logDir) {
  const file = path.join(logDir, \`\${Date.now()}-\${process.pid}-\${Math.random().toString(36).slice(2)}.json\`);
  fs.writeFileSync(file, JSON.stringify({ argv: args, pid: process.pid, time: Date.now() }), "utf8");
}

const subcmd = args[0];
const threadIdx = args.indexOf("--thread");
const thread = threadIdx >= 0 ? args[threadIdx + 1] : null;

if (process.env.TEST_CODEX_FAIL === "closed" || thread === "closed-thread") {
  fs.writeSync(2, \`Error: thread \${thread} is closed or unavailable\\n\`);
  process.exitCode = 1;
} else if (process.env.TEST_CODEX_FAIL === "generic" || thread === "failing-thread") {
  fs.writeSync(2, "Error: codex queue command failed (connection error)\\n");
  process.exitCode = 1;
} else {
  process.exitCode = 0;
}
`,
      { mode: 0o755 }
    );
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
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

  function setupMockChainFiles(chainId, { status = "completed", disposition = "accept", container = "1d90ea9e70b6", customWorkspace = null } = {}) {
    const ws = path.resolve(customWorkspace || workspaceDir);
    const hash = crypto.createHash("sha256").update(ws).digest("hex").slice(0, 12);
    const chainDir = path.join(kusabiStateDir, hash, "chains", chainId);
    fs.mkdirSync(chainDir, { recursive: true });

    const controlData = { status, round: 1 };
    if (container !== null) {
      controlData.container = container;
    }
    fs.writeFileSync(
      path.join(chainDir, "control.json"),
      JSON.stringify(controlData),
      "utf8"
    );

    fs.writeFileSync(
      path.join(chainDir, "chain.json"),
      JSON.stringify({
        chainId,
        records: [
          {
            round: 1,
            disposition: { disposition },
          },
        ],
      }),
      "utf8"
    );

    const inboxDir = path.join(kusabiStateDir, hash, "inbox");
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(
      path.join(inboxDir, `${chainId}.md`),
      `# Chain ${chainId}\n- **status**: ${status}\n- **disposition**: ${disposition}\n- **container**: ${container || "unavailable"}\n`,
      "utf8"
    );
  }

  /**
   * Write a durable kusabi job record the mock companion's task-wait and the
   * watcher's readTaskJob both read.  `startedAt` is retained as ordinary job
   * metadata so selector tests can verify it is not used for --since binding.
   */
  function setupMockJobFiles(jobId, { status = "running", phase = "implement", backend = "opencode", modelEntry = "opencode-go/deepseek-v4-flash:max", fallbacks = null, container = null, startedAt = null, failure = null, customWorkspace = null } = {}) {
    const ws = path.resolve(customWorkspace || workspaceDir);
    const hash = crypto.createHash("sha256").update(ws).digest("hex").slice(0, 12);
    const jobDir = path.join(kusabiStateDir, hash, "jobs", jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    const job = {
      id: jobId,
      kind: "task",
      title: "test task",
      status,
      phase,
      backend,
      modelEntry,
      startedAt: startedAt || new Date().toISOString(),
      finishedAt: status !== "running" ? new Date().toISOString() : null,
      cwd: ws,
      sessionID: "ses-test-123",
    };
    if (fallbacks) job.fallbacks = fallbacks;
    if (container) job.container = container;
    if (failure) job.failure = failure;
    fs.writeFileSync(path.join(jobDir, "job.json"), JSON.stringify(job), "utf8");
    return jobDir;
  }

  it("success: registers, blocking waits, and delivers exactly one notification with required fields", async () => {
    const chainId = "chain-success-01";
    const threadId = "thread-alpha";
    setupMockChainFiles(chainId, { status: "completed", disposition: "accept", container: "container-abc" });

    const testEnv = {
      ...process.env,
      KUSABI_STATE_DIR: kusabiStateDir,
      TEST_QUEUE_LOG_DIR: queueLogDir,
    };

    const res = await registerWatch({
      chainId,
      threadId,
      cwd: workspaceDir,
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      sync: true,
      env: testEnv,
    });

    assert.equal(res.outcome, OUTCOME_DELIVERED);
    assert.equal(res.record.status, "delivered");
    assert.equal(res.record.chainState.status, "completed");
    assert.equal(res.record.chainState.disposition, "accept");
    assert.equal(res.record.chainState.container, "container-abc");

    // Verify notification message contents
    const msg = res.record.notification.message;
    assert.match(msg, /chain-success-01/);
    assert.match(msg, /Status: completed/);
    assert.match(msg, /Disposition: accept/);
    assert.match(msg, /Container: container-abc/);
    assert.match(msg, /Next action: Inspect review record/);

    // Verify codex queue invocation was made exactly once with correct argv
    const invocations = getQueueInvocations();
    assert.equal(invocations.length, 1);
    assert.deepEqual(invocations[0].argv.slice(0, 3), ["queue", "--thread", "thread-alpha"]);
    assert.equal(invocations[0].argv[3], "--message");
    assert.equal(invocations[0].argv[4], msg);

    // Verify durable record and claim on disk
    const onDisk = readJson(getRecordPath(stateDir, chainId));
    assert.equal(onDisk.status, "delivered");
    assert.equal(onDisk.outcome, OUTCOME_DELIVERED);
    assert.deepEqual(onDisk.subject, { kind: "chain", id: chainId });

    const claimOnDisk = readJson(getClaimPath(stateDir, chainId));
    assert.equal(claimOnDisk.phase, "delivered");
    assert.deepEqual(claimOnDisk.subject, { kind: "chain", id: chainId });
  });

  it("duplicate suppression: subsequent registration or race does not queue again", async () => {
    const chainId = "chain-dedup-01";
    const threadId = "thread-beta";
    setupMockChainFiles(chainId);

    const testEnv = {
      ...process.env,
      KUSABI_STATE_DIR: kusabiStateDir,
      TEST_QUEUE_LOG_DIR: queueLogDir,
    };

    // First delivery
    const first = await registerWatch({
      chainId,
      threadId,
      cwd: workspaceDir,
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      sync: true,
      env: testEnv,
    });
    assert.equal(first.outcome, OUTCOME_DELIVERED);
    assert.equal(getQueueInvocations().length, 1);

    // Second registration for the already delivered chain
    const second = await registerWatch({
      chainId,
      threadId,
      cwd: workspaceDir,
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      sync: true,
      env: testEnv,
    });
    assert.equal(second.outcome, OUTCOME_ALREADY_DELIVERED);
    assert.equal(getQueueInvocations().length, 1);

    // Direct claim acquisition test for race condition
    const claimsDir = path.join(stateDir, "claims");
    const claimTry = tryAcquireClaim(claimsDir, chainId);
    assert.equal(claimTry.acquired, false);
    assert.equal(claimTry.outcome, OUTCOME_ALREADY_DELIVERED);
    assert.equal(getQueueInvocations().length, 1);
  });

  it("concurrent chains: independent state and delivery without cross-talk", async () => {
    const chains = [
      { id: "chain-c1", thread: "thread-1", container: "cid-1" },
      { id: "chain-c2", thread: "thread-2", container: "cid-2" },
      { id: "chain-c3", thread: "thread-3", container: "cid-3" },
    ];

    const testEnv = {
      ...process.env,
      KUSABI_STATE_DIR: kusabiStateDir,
      TEST_QUEUE_LOG_DIR: queueLogDir,
    };

    for (const c of chains) {
      setupMockChainFiles(c.id, { container: c.container });
    }

    const results = await Promise.all(
      chains.map((c) =>
        watchChain({
          chainId: c.id,
          threadId: c.thread,
          cwd: workspaceDir,
          stateDir,
          companionBin: mockCompanionScript,
          codexBin: mockCodexScript,
          env: testEnv,
        })
      )
    );

    for (let i = 0; i < chains.length; i++) {
      assert.equal(results[i].outcome, OUTCOME_DELIVERED);
      assert.equal(results[i].record.chainId, chains[i].id);
      assert.equal(results[i].record.chainState.container, chains[i].container);

      // Verify each record file exists independently
      const rec = readJson(getRecordPath(stateDir, chains[i].id));
      assert.equal(rec.chainId, chains[i].id);
      assert.equal(rec.threadId, chains[i].thread);
    }

    const invocations = getQueueInvocations();
    assert.equal(invocations.length, 3);
    const invokedThreads = invocations.map((inv) => inv.argv[2]).sort();
    assert.deepEqual(invokedThreads, ["thread-1", "thread-2", "thread-3"]);
  });

  it("restart recovery: recovers pending records and delivers without duplicates", async () => {
    const chainId = "chain-recover-01";
    const threadId = "thread-recover";
    setupMockChainFiles(chainId);

    const testEnv = {
      ...process.env,
      KUSABI_STATE_DIR: kusabiStateDir,
      TEST_QUEUE_LOG_DIR: queueLogDir,
    };

    const recPath = getRecordPath(stateDir, chainId);
    writeRecordAtomic(recPath, {
      chainId,
      threadId,
      cwd: workspaceDir,
      status: "waiting",
      outcome: null,
      registeredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pid: 99999999, // Dead PID
      startTime: "12345",
    });

    const res = await resumePendingWatches({
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      sync: true,
      env: testEnv,
    });

    assert.equal(res.resumed, 1);
    assert.deepEqual(res.chains, [chainId]);
    assert.equal(getQueueInvocations().length, 1);

    const updated = readJson(recPath);
    assert.equal(updated.status, "delivered");
    assert.equal(updated.outcome, OUTCOME_DELIVERED);

    // Resuming again should do nothing
    const secondResume = await resumePendingWatches({
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      sync: true,
      env: testEnv,
    });
    assert.equal(secondResume.resumed, 0);
    assert.equal(getQueueInvocations().length, 1);
  });

  it("restart recovery: unrelated recycled live PID does not suppress recovery", async () => {
    const chainId = "chain-recycled-pid-01";
    const threadId = "thread-recycled";
    setupMockChainFiles(chainId);

    const testEnv = {
      ...process.env,
      KUSABI_STATE_DIR: kusabiStateDir,
      TEST_QUEUE_LOG_DIR: queueLogDir,
    };

    const livePid = process.pid;
    const staleStartTime = "9999999999";

    assert.equal(
      isWatcherProcessAlive(livePid, staleStartTime, chainId),
      false,
      "Live PID with non-matching start time must NOT be treated as the watcher"
    );

    const recPath = getRecordPath(stateDir, chainId);
    writeRecordAtomic(recPath, {
      chainId,
      threadId,
      cwd: workspaceDir,
      status: "waiting",
      outcome: null,
      registeredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pid: livePid,
      startTime: staleStartTime,
    });

    const res = await resumePendingWatches({
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      sync: true,
      env: testEnv,
    });

    assert.equal(res.resumed, 1, "Resume should NOT be suppressed by unrelated live PID");
    assert.deepEqual(res.chains, [chainId]);
    assert.equal(getQueueInvocations().length, 1);

    const updated = readJson(recPath);
    assert.equal(updated.status, "delivered");
  });

  it("queue failure and bounded retry recovery: recovers definitive queue failure up to bound", async () => {
    const chainId = "chain-retryable-01";
    const threadId = "failing-thread";
    setupMockChainFiles(chainId);

    const testEnv = {
      ...process.env,
      KUSABI_STATE_DIR: kusabiStateDir,
      TEST_QUEUE_LOG_DIR: queueLogDir,
    };

    // First attempt: queue fails definitively with non-zero exit
    const firstRes = await watchChain({
      chainId,
      threadId,
      cwd: workspaceDir,
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      env: testEnv,
    });

    assert.equal(firstRes.outcome, OUTCOME_QUEUE_FAILURE);
    assert.equal(firstRes.record.status, "queue_failed");
    assert.equal(firstRes.record.retryable, true);
    assert.equal(firstRes.record.attempts, 1);

    const claimPath = getClaimPath(stateDir, chainId);
    const claimData = readJson(claimPath);
    assert.equal(claimData.phase, "failed_retryable");
    assert.equal(claimData.attempts, 1);

    // Now resume: the thread is fixed to a working thread in the record
    const recPath = getRecordPath(stateDir, chainId);
    const rec = readJson(recPath);
    rec.threadId = "working-thread";
    rec.pid = 99999999;
    writeRecordAtomic(recPath, rec);

    const resumeRes = await resumePendingWatches({
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      sync: true,
      env: testEnv,
    });

    assert.equal(resumeRes.resumed, 1);
    assert.deepEqual(resumeRes.chains, [chainId]);
    assert.equal(getQueueInvocations().length, 2);

    const updatedRec = readJson(recPath);
    assert.equal(updatedRec.status, "delivered");
    assert.equal(updatedRec.outcome, OUTCOME_DELIVERED);

    const updatedClaim = readJson(claimPath);
    assert.equal(updatedClaim.phase, "delivered");
  });

  it("queue failure bound: transitions to terminal failure after exceeding max attempts", async () => {
    const chainId = "chain-max-retries-01";
    const threadId = "failing-thread";
    setupMockChainFiles(chainId);

    const testEnv = {
      ...process.env,
      KUSABI_STATE_DIR: kusabiStateDir,
      TEST_QUEUE_LOG_DIR: queueLogDir,
    };

    const claimsDir = path.join(stateDir, "claims");
    const claimPath = getClaimPath(stateDir, chainId);
    fs.mkdirSync(claimsDir, { recursive: true });
    writeRecordAtomic(claimPath, {
      chainId,
      phase: "failed_retryable",
      attempts: MAX_DELIVERY_ATTEMPTS,
      maxAttempts: MAX_DELIVERY_ATTEMPTS,
    });

    const res = await watchChain({
      chainId,
      threadId,
      cwd: workspaceDir,
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      env: testEnv,
    });

    assert.equal(res.outcome, OUTCOME_QUEUE_FAILURE);
    assert.equal(res.record.retryable, false);

    const updatedClaim = readJson(claimPath);
    assert.equal(updatedClaim.phase, "failed_terminal");

    const recPath = getRecordPath(stateDir, chainId);
    const rec = readJson(recPath);
    rec.pid = 99999999;
    writeRecordAtomic(recPath, rec);

    const resumeRes = await resumePendingWatches({
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      sync: true,
      env: testEnv,
    });
    assert.equal(resumeRes.resumed, 0);
  });

  it("ambiguous delivery state: interrupted queue execution is never automatically retried", async () => {
    const chainId = "chain-ambiguous-01";
    const threadId = "thread-ambiguous";
    setupMockChainFiles(chainId);

    const testEnv = {
      ...process.env,
      KUSABI_STATE_DIR: kusabiStateDir,
      TEST_QUEUE_LOG_DIR: queueLogDir,
    };

    const claimPath = getClaimPath(stateDir, chainId);
    const recPath = getRecordPath(stateDir, chainId);

    // Simulate owner process dying while actively in 'queue_inflight' phase
    fs.mkdirSync(path.join(stateDir, "claims"), { recursive: true });
    writeRecordAtomic(claimPath, {
      chainId,
      phase: "queue_inflight",
      pid: 99999999, // Dead PID
      startTime: "12345",
      claimedAt: new Date().toISOString(),
    });

    writeRecordAtomic(recPath, {
      chainId,
      threadId,
      cwd: workspaceDir,
      status: "waiting",
      pid: 99999999,
      startTime: "12345",
    });

    const res = await watchChain({
      chainId,
      threadId,
      cwd: workspaceDir,
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      env: testEnv,
    });

    assert.equal(res.outcome, OUTCOME_AMBIGUOUS_DELIVERY);
    assert.equal(res.record.status, "ambiguous");

    const claimData = readJson(claimPath);
    assert.equal(claimData.phase, "ambiguous");

    const resumeRes = await resumePendingWatches({
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      sync: true,
      env: testEnv,
    });
    assert.equal(resumeRes.resumed, 0);
    assert.equal(getQueueInvocations().length, 0);
  });

  it("child lifecycle: terminates spawned child process upon SIGTERM without listener leaks or double resolution", async () => {
    const script = path.join(tmpRoot, "sleepy.mjs");
    fs.writeFileSync(
      script,
      `#!/usr/bin/env node
setTimeout(() => { process.exit(0); }, 30000);
`,
      { mode: 0o755 }
    );

    let spawnedChild = null;
    const initialListenerCount = process.listenerCount("SIGTERM");

    const promise = runProcess(process.execPath, [script], {
      cwd: workspaceDir,
      onSpawn: (c) => { spawnedChild = c; },
    });

    while (!spawnedChild || !spawnedChild.pid) {
      await new Promise((r) => setTimeout(r, 10));
    }

    process.emit("SIGTERM");

    const result = await promise;
    assert.ok(result.error);
    assert.equal(result.signal, "SIGTERM");
    assert.equal(result.exitCode, 143);

    assert.ok(spawnedChild.killed);
    assert.equal(process.listenerCount("SIGTERM"), initialListenerCount);
  });

  it("missing container: missing container metadata formats as unavailable and does NOT fail terminal notification", async () => {
    const chainId = "chain-no-container-01";
    setupMockChainFiles(chainId, { status: "completed", disposition: "accept", container: null });

    const testEnv = {
      ...process.env,
      KUSABI_STATE_DIR: kusabiStateDir,
      TEST_QUEUE_LOG_DIR: queueLogDir,
      TEST_COMPANION_NO_CONTAINER: "1",
    };

    const res = await watchChain({
      chainId,
      threadId: "valid-thread",
      cwd: workspaceDir,
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      env: testEnv,
    });

    assert.equal(res.outcome, OUTCOME_DELIVERED);
    assert.equal(res.record.status, "delivered");
    assert.equal(res.record.chainState.container, "unavailable");

    const msg = res.record.notification.message;
    assert.match(msg, /- Container: unavailable/);
    assert.match(msg, /- Status: completed/);
    assert.match(msg, /- Disposition: accept/);

    const invocations = getQueueInvocations();
    assert.equal(invocations.length, 1);
  });
it("chain resolution: prefer explicit chain-wait line from response over general tokens", () => {
    const env = { CODEX_THREAD_ID: "env-thread-123" };

    const payload = {
      command: "kusabi-companion chain-detach --container cid-123 --brief-file /tmp/b.md",
      response: "Detached chain launched for issue #123.\nRelated to chain-old-001.\nTo wait for completion, run:\n  kusabi-companion chain-wait chain-explicit-999",
      cwd: workspaceDir,
    };

    const dispatch = extractDispatchFromHookInput(payload, env);
    assert.ok(dispatch);
    assert.equal(dispatch.chainId, "chain-explicit-999");
    assert.equal(dispatch.threadId, "env-thread-123");
    assert.equal(dispatch.subjectKind, "chain");
  });

  it("chain resolution: deterministic --since fallback under competing concurrent chains", () => {
    const resolved = path.resolve(workspaceDir);
    const hash = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 12);
    const chainsDir = path.join(kusabiStateDir, hash, "chains");
    fs.mkdirSync(chainsDir, { recursive: true });

    const baseTime = Date.parse("2026-09-06T12:00:00.000Z");

    const chain1 = path.join(chainsDir, "chain-older");
    const chain2 = path.join(chainsDir, "chain-target");
    const chain3 = path.join(chainsDir, "chain-future");
    fs.mkdirSync(chain1, { recursive: true });
    fs.mkdirSync(chain2, { recursive: true });
    fs.mkdirSync(chain3, { recursive: true });

    fs.writeFileSync(path.join(chain1, "control.json"), JSON.stringify({ createdAt: new Date(baseTime - 10000).toISOString() }));
    fs.writeFileSync(path.join(chain2, "control.json"), JSON.stringify({ createdAt: new Date(baseTime + 100).toISOString() }));
    fs.writeFileSync(path.join(chain3, "control.json"), JSON.stringify({ createdAt: new Date(baseTime + 30000).toISOString() }));

    const env = {
      CODEX_THREAD_ID: "env-thread-since",
      KUSABI_STATE_DIR: kusabiStateDir,
    };

    const payload = {
      command: "kusabi-companion chain-detach",
      response: "Detached chain launched. Waiting with --since 2026-09-06T12:00:00.000Z",
      cwd: workspaceDir,
    };

    const dispatch = extractDispatchFromHookInput(payload, env);
    assert.ok(dispatch);
    assert.equal(dispatch.chainId, "chain-future", "Should deterministically select newest eligible chain for --since timestamp");
  });

  it("canonicalization: symlink cwd matches canonical kusabi state directory", async () => {
    const symlinkDir = path.join(tmpRoot, "symlink-workspace");
    fs.symlinkSync(workspaceDir, symlinkDir);

    const chainId = "chain-symlink-01";
    // Write mock chain files under kusabi's raw resolved symlink-path hash
    setupMockChainFiles(chainId, { customWorkspace: symlinkDir });

    const testEnv = {
      ...process.env,
      KUSABI_STATE_DIR: kusabiStateDir,
      TEST_QUEUE_LOG_DIR: queueLogDir,
    };

    const res = await watchChain({
      chainId,
      threadId: "thread-symlink",
      cwd: symlinkDir,
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      env: testEnv,
    });

    assert.equal(res.outcome, OUTCOME_DELIVERED);
    assert.equal(res.record.status, "delivered");
    assert.equal(res.record.cwd, path.resolve(symlinkDir));
  });

  it("malformed identifiers and cwd: rejected and recorded without crashing", async () => {
    const resBadChain = await registerWatch({
      chainId: "bad chain ID with spaces!",
      threadId: "valid-thread",
      cwd: workspaceDir,
      stateDir,
      sync: true,
    });
    assert.equal(resBadChain.outcome, OUTCOME_MALFORMED_REGISTRATION);
    assert.equal(resBadChain.record.status, "malformed_registration");

    const resBadThread = await registerWatch({
      chainId: "chain-valid",
      threadId: "bad thread; rm -rf",
      cwd: workspaceDir,
      stateDir,
      sync: true,
    });
    assert.equal(resBadThread.outcome, OUTCOME_MALFORMED_REGISTRATION);

    const resBadCwd = await registerWatch({
      chainId: "chain-valid2",
      threadId: "valid-thread",
      cwd: "/nonexistent/path/for/cwd",
      stateDir,
      sync: true,
    });
    assert.equal(resBadCwd.outcome, OUTCOME_MALFORMED_REGISTRATION);

    assert.equal(getQueueInvocations().length, 0);
  });

  it("closed/unavailable thread: distinguishes failure and persists diagnostic outcome", async () => {
    const chainId = "chain-closed-01";
    setupMockChainFiles(chainId);

    const testEnv = {
      ...process.env,
      KUSABI_STATE_DIR: kusabiStateDir,
      TEST_QUEUE_LOG_DIR: queueLogDir,
    };

    const res = await watchChain({
      chainId,
      threadId: "closed-thread",
      cwd: workspaceDir,
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      env: testEnv,
    });

    assert.equal(res.outcome, OUTCOME_CLOSED_OR_UNAVAILABLE);
    assert.equal(res.record.status, "closed_or_unavailable");
    assert.equal(res.record.outcome, "source Codex session/thread closed or unavailable");
    assert.ok(res.record.error);
    assert.equal(res.record.error.exitCode, 1);
  });

  it("chain-wait failure: non-zero exit sets failure outcome and never queues", async () => {
    const chainId = "chain-wait-fail-01";
    setupMockChainFiles(chainId);

    const testEnv = {
      ...process.env,
      KUSABI_STATE_DIR: kusabiStateDir,
      TEST_QUEUE_LOG_DIR: queueLogDir,
      TEST_COMPANION_FAIL: "1",
    };

    const res = await watchChain({
      chainId,
      threadId: "valid-thread",
      cwd: workspaceDir,
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      env: testEnv,
    });

    assert.equal(res.outcome, OUTCOME_CHAIN_WAIT_FAILURE);
    assert.equal(res.record.status, "chain_wait_failed");
    assert.equal(res.record.outcome, "chain-wait failure");
    assert.equal(res.record.chainWait.exitCode, 1);

    assert.equal(getQueueInvocations().length, 0);
  });

  it("codex hook payload: parses established Codex payload shapes and extracts dispatch", () => {
    const env = { CODEX_THREAD_ID: "env-thread-123" };

    const codexPayload = {
      thread_id: "thread-codex-xyz",
      tool_name: "bash",
      command: "kusabi-companion chain-detach --container 12345 --brief-file /tmp/b.md",
      output: "Detached chain launched (pid 456).\nLog: ...\nTo wait for completion, run:\n  kusabi-companion chain-wait chain-codex-123",
      cwd: workspaceDir,
    };

    const res = extractDispatchFromHookInput(codexPayload, env);
    assert.ok(res);
    assert.equal(res.chainId, "chain-codex-123");
    assert.equal(res.threadId, "thread-codex-xyz");
    assert.equal(res.cwd, path.resolve(workspaceDir));

    const unrelatedPayload = {
      thread_id: "thread-codex-xyz",
      tool_name: "bash",
      command: "git status",
      output: "On branch main\nnothing to commit",
      cwd: workspaceDir,
    };

    const resUnrelated = extractDispatchFromHookInput(unrelatedPayload, env);
    assert.equal(resUnrelated, null);
  });

  it("codex hook payload: task-detach selector output resolves the job id with explicit task subject kind", () => {
    const jobId = "job-hook-task-001";
    setupMockJobFiles(jobId, { status: "completed" });
    const hash = crypto.createHash("sha256").update(path.resolve(workspaceDir)).digest("hex").slice(0, 12);
    const jobDir = path.join(kusabiStateDir, hash, "jobs", jobId);
    fs.writeFileSync(path.join(jobDir, "job.json"), JSON.stringify({
      id: jobId, kind: "task", status: "completed", phase: "implement",
      startedAt: "2026-09-06T12:30:01.000Z",
    }));

    const env = { CODEX_THREAD_ID: "env-thread-123", KUSABI_STATE_DIR: kusabiStateDir };

    const taskPayload = {
      thread_id: "thread-codex-xyz",
      tool_name: "bash",
      command: "kusabi-companion task-detach --container cid-9 --brief-file /tmp/b.md",
      output: "Detached task launched (pid 456).\nLog: /tmp/kusabi/state/task-detach-1788698641659.log\n\nTo wait for completion, run:\n  kusabi-companion task-wait --next --since 2026-09-06T12:30:00.000Z",
      cwd: workspaceDir,
    };

    const res = extractDispatchFromHookInput(taskPayload, env);
    assert.ok(res);
    assert.equal(res.subjectKind, "task");
    assert.equal(res.jobId, jobId);
    assert.equal(res.chainId, null);
    assert.equal(res.threadId, "thread-codex-xyz");
  });

  it("detached execution and CLI commands: spawns background watcher and updates record", async () => {
    const chainId = "chain-detached-01";
    const threadId = "thread-detached";
    setupMockChainFiles(chainId);

    const testEnv = {
      ...process.env,
      KUSABI_STATE_DIR: kusabiStateDir,
      TEST_QUEUE_LOG_DIR: queueLogDir,
    };

    const proc = spawnSync(process.execPath, [
      REGISTER_SCRIPT,
      "--chain", chainId,
      "--thread", threadId,
      "--cwd", workspaceDir,
      "--state-dir", stateDir,
      "--companion-bin", mockCompanionScript,
      "--codex-bin", mockCodexScript,
    ], {
      env: testEnv,
      encoding: "utf8",
    });

    assert.equal(proc.status, 0, proc.stderr);

    const recPath = getRecordPath(stateDir, chainId);
    let record = null;
    const start = Date.now();
    while (Date.now() - start < 5000) {
      if (fs.existsSync(recPath)) {
        const candidate = readJson(recPath);
        if (candidate?.status === "delivered") {
          record = candidate;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.ok(record, "Detached watcher should deliver within 5s");
    assert.equal(record.status, "delivered");
    assert.equal(record.outcome, OUTCOME_DELIVERED);
    assert.equal(getQueueInvocations().length, 1);
  });

  // --- CHAIN SPEC TESTS (ported) ---

  it("concurrent retryable reclaim: competing callers for failed_retryable result in exactly one owner and one queue call", async () => {
    const chainId = "chain-concurrent-reclaim";
    setupMockChainFiles(chainId);

    const claimsDir = path.join(stateDir, "claims");
    fs.mkdirSync(claimsDir, { recursive: true });
    const claimPath = getClaimPath(stateDir, chainId);

    // Initial state: failed_retryable
    writeRecordAtomic(claimPath, {
      chainId,
      phase: "failed_retryable",
      attempts: 1,
      maxAttempts: 3,
    });

    const testEnv = {
      ...process.env,
      KUSABI_STATE_DIR: kusabiStateDir,
      TEST_QUEUE_LOG_DIR: queueLogDir,
    };

    // Run 3 concurrent watchChain calls competing for the retry claim
    const results = await Promise.all([
      watchChain({ chainId, threadId: "thread-c1", cwd: workspaceDir, stateDir, companionBin: mockCompanionScript, codexBin: mockCodexScript, env: testEnv }),
      watchChain({ chainId, threadId: "thread-c2", cwd: workspaceDir, stateDir, companionBin: mockCompanionScript, codexBin: mockCodexScript, env: testEnv }),
      watchChain({ chainId, threadId: "thread-c3", cwd: workspaceDir, stateDir, companionBin: mockCompanionScript, codexBin: mockCodexScript, env: testEnv }),
    ]);

    // Exactly one caller should successfully deliver
    const delivered = results.filter((r) => r.outcome === OUTCOME_DELIVERED);
    assert.equal(delivered.length, 1, "Exactly one competitor must deliver the notification");

    // Exactly one queue call made
    const invocations = getQueueInvocations();
    assert.equal(invocations.length, 1, "Exactly one codex queue invocation across concurrent reclaims");
  });

  it("recoverable dead preparing: dead owner during preparing state is recovered and delivered", async () => {
    const chainId = "chain-dead-preparing";
    setupMockChainFiles(chainId);

    const claimsDir = path.join(stateDir, "claims");
    fs.mkdirSync(claimsDir, { recursive: true });
    const claimPath = getClaimPath(stateDir, chainId);

    // Claim exists in 'preparing' state, but owner process is dead (no external process was ever spawned)
    writeRecordAtomic(claimPath, {
      chainId,
      phase: "preparing",
      pid: 99999999, // Dead PID
      startTime: "12345",
      claimedAt: new Date().toISOString(),
      attempts: 1,
      maxAttempts: 3,
    });

    const testEnv = {
      ...process.env,
      KUSABI_STATE_DIR: kusabiStateDir,
      TEST_QUEUE_LOG_DIR: queueLogDir,
    };

    // Watcher recovers the preparing claim
    const res = await watchChain({
      chainId,
      threadId: "thread-prep-rec",
      cwd: workspaceDir,
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      env: testEnv,
    });

    assert.equal(res.outcome, OUTCOME_DELIVERED);
    assert.equal(res.record.status, "delivered");
    assert.equal(getQueueInvocations().length, 1);
  });

  it("non-retryable dead queue_inflight: dead owner in queue_inflight state is marked ambiguous and never retried", async () => {
    const chainId = "chain-dead-inflight";
    setupMockChainFiles(chainId);

    const claimsDir = path.join(stateDir, "claims");
    fs.mkdirSync(claimsDir, { recursive: true });
    const claimPath = getClaimPath(stateDir, chainId);

    // Claim was in queue_inflight when owner process died
    writeRecordAtomic(claimPath, {
      chainId,
      phase: "queue_inflight",
      pid: 99999999,
      startTime: "12345",
      inflightAt: new Date().toISOString(),
      attempts: 1,
      maxAttempts: 3,
    });

    const testEnv = {
      ...process.env,
      KUSABI_STATE_DIR: kusabiStateDir,
      TEST_QUEUE_LOG_DIR: queueLogDir,
    };

    const res = await watchChain({
      chainId,
      threadId: "thread-inflight",
      cwd: workspaceDir,
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      env: testEnv,
    });

    assert.equal(res.outcome, OUTCOME_AMBIGUOUS_DELIVERY);
    assert.equal(res.record.status, "ambiguous");

    // Re-checking must not execute queue
    assert.equal(getQueueInvocations().length, 0);

    const claim = readJson(claimPath);
    assert.equal(claim.phase, "ambiguous");
  });

  it("kusabi stateDirFor hash compatibility: cwd hash matches kusabi raw resolved symlink-path hash", () => {
    const symlinkDir = path.join(tmpRoot, "symlink-hash-test");
    fs.symlinkSync(workspaceDir, symlinkDir);

    const kusabiHash = getKusabiWorkspaceHash(symlinkDir);
    const expectedHash = crypto.createHash("sha256").update(path.resolve(symlinkDir)).digest("hex").slice(0, 12);

    assert.equal(kusabiHash, expectedHash, "Primary hash must match kusabi stateDirFor (path.resolve without realpath)");
  });

  it("closed thread classification: generic errors remain retryable queue failures", () => {
    // Thread diagnostics -> closed/unavailable
    const r1 = evaluateQueueResult({ exitCode: 1, stderr: "Error: thread thread-01 is closed" });
    assert.equal(r1.outcome, OUTCOME_CLOSED_OR_UNAVAILABLE);

    const r2 = evaluateQueueResult({ exitCode: 1, stderr: "Error: unknown thread thread-02" });
    assert.equal(r2.outcome, OUTCOME_CLOSED_OR_UNAVAILABLE);

    const r3 = evaluateQueueResult({ exitCode: 1, stderr: "thread session-xyz was not found or inactive" });
    assert.equal(r3.outcome, OUTCOME_CLOSED_OR_UNAVAILABLE);

    // Generic failures -> queue command failure (retryable)
    const r4 = evaluateQueueResult({ exitCode: 127, stderr: "bash: codex: command not found" });
    assert.equal(r4.outcome, OUTCOME_QUEUE_FAILURE);

    const r5 = evaluateQueueResult({ exitCode: 1, stderr: "cat: file not found: /etc/codex/key" });
    assert.equal(r5.outcome, OUTCOME_QUEUE_FAILURE);

    const r6 = evaluateQueueResult({ exitCode: 1, stderr: "Error: connect ECONNREFUSED 127.0.0.1:4096" });
    assert.equal(r6.outcome, OUTCOME_QUEUE_FAILURE);
  });

  it("process lifecycle: terminates process group ensuring child and grandchild actual OS process exit on Linux", async () => {
    if (process.platform === "win32") return;

    const pidsFile = path.join(tmpRoot, "tree_pids.json");
    const grandchildScript = path.join(tmpRoot, "grandchild.mjs");
    fs.writeFileSync(
      grandchildScript,
      `#!/usr/bin/env node
setTimeout(() => {}, 60000);
`,
      { mode: 0o755 }
    );

    const childScript = path.join(tmpRoot, "child.mjs");
    fs.writeFileSync(
      childScript,
      `#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";

const grandchild = spawn(process.execPath, [${JSON.stringify(grandchildScript)}], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid }));
setTimeout(() => {}, 60000);
`,
      { mode: 0o755 }
    );

    let childProc = null;
    const promise = runProcess(process.execPath, [childScript], {
      cwd: workspaceDir,
      isolateProcessGroup: true,
      onSpawn: (c) => { childProc = c; },
    });

    // Wait until child and grandchild write PIDs and are running
    let pids = null;
    const start = Date.now();
    while (Date.now() - start < 5000) {
      if (fs.existsSync(pidsFile)) {
        try { pids = JSON.parse(fs.readFileSync(pidsFile, "utf8")); break; } catch {}
      }
      await new Promise((r) => setTimeout(r, 20));
    }

    assert.ok(pids, "PIDs file should be written");
    assert.ok(pids.childPid);
    assert.ok(pids.grandchildPid);

    // Verify both are running in the OS
    assert.doesNotThrow(() => process.kill(pids.childPid, 0));
    assert.doesNotThrow(() => process.kill(pids.grandchildPid, 0));

    // Signal SIGTERM
    process.emit("SIGTERM");
    await promise;

    // Verify both child AND grandchild OS processes actually terminate
    const isProcessAlive = (pid) => {
      try {
        process.kill(pid, 0);
      } catch {
        return false;
      }
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const lastParen = stat.lastIndexOf(")");
        if (lastParen !== -1) {
          const state = stat.slice(lastParen + 2).trim().split(/\s+/)[0];
          if (state === "Z" || state === "X") return false;
        }
      } catch {}
      return true;
    };

    let childAlive = true;
    let grandchildAlive = true;
    const killCheckStart = Date.now();
    while (Date.now() - killCheckStart < 3000) {
      if (!isProcessAlive(pids.childPid)) childAlive = false;
      if (!isProcessAlive(pids.grandchildPid)) grandchildAlive = false;
      if (!childAlive && !grandchildAlive) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.equal(childAlive, false, "Child process must have terminated in OS");
    assert.equal(grandchildAlive, false, "Grandchild process must have terminated in OS (process group kill)");
  });

  it("missing procfs: restricted/missing procfs with live owner treats identity as unknown-but-live and suppresses duplicates", async () => {
    const fakeProcRoot = path.join(tmpRoot, "fake-proc-empty");
    fs.mkdirSync(fakeProcRoot, { recursive: true });

    // 1. checkWatcherProcess against fake procfs returns alive: true, verified: false, identity: "unknown"
    const idResult = checkWatcherProcess(process.pid, null, null, fakeProcRoot);
    assert.equal(idResult.alive, true);
    assert.equal(idResult.verified, false);
    assert.equal(idResult.identity, "unknown");

    // 2. isWatcherProcessAlive returns true (treats kill(0)-live unknown as active)
    assert.equal(isWatcherProcessAlive(process.pid, null, null, fakeProcRoot), true);

    const chainId = "chain-proc-live-owner";
    setupMockChainFiles(chainId);

    const recPath = getRecordPath(stateDir, chainId);
    writeRecordAtomic(recPath, {
      chainId,
      threadId: "thread-live-owner",
      cwd: workspaceDir,
      status: "waiting",
      pid: process.pid,
      startTime: "12345",
    });

    const claimsDir = path.join(stateDir, "claims");
    fs.mkdirSync(claimsDir, { recursive: true });
    const claimPath = getClaimPath(stateDir, chainId);
    writeRecordAtomic(claimPath, {
      chainId,
      phase: "preparing",
      pid: process.pid,
      startTime: "12345",
      claimedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attempts: 1,
    });

    // 3. Competing tryAcquireClaim: does NOT reclaim preparing claim
    const compClaimResult = tryAcquireClaim(claimsDir, chainId, { procRoot: fakeProcRoot });
    assert.equal(compClaimResult.acquired, false);
    assert.equal(compClaimResult.reason, "active_owner");

    // Claim on disk must remain untouched (owned by original pid in preparing phase)
    const onDiskClaim = readJson(claimPath);
    assert.equal(onDiskClaim.phase, "preparing");
    assert.equal(onDiskClaim.pid, process.pid);

    // 4. Stale lock protection: acquireClaimLock does NOT steal lock held by a live process
    const lockDir = path.join(claimsDir, `chain-${chainId}.lock`);
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, time: Date.now() - 30000 }));
    const pastTime = new Date(Date.now() - 30000);
    fs.utimesSync(lockDir, pastTime, pastTime);

    assert.throws(
      () => acquireClaimLock(claimsDir, chainId, { lockTimeoutMs: 100, procRoot: fakeProcRoot }),
      /Timeout acquiring claim lock/
    );
    assert.ok(fs.existsSync(lockDir));
    fs.rmSync(lockDir, { recursive: true, force: true });

    // 5. resumePendingWatches: does NOT resume an active live process
    const testEnv = {
      ...process.env,
      KUSABI_STATE_DIR: kusabiStateDir,
      TEST_QUEUE_LOG_DIR: queueLogDir,
    };

    const resumeRes = await resumePendingWatches({
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      sync: true,
      procRoot: fakeProcRoot,
      env: testEnv,
    });
    assert.equal(resumeRes.resumed, 0, "Live unknown process must not be resumed");

    // 6. registerWatch duplicate suppression: detects active watcher
    const regRes = await registerWatch({
      chainId,
      threadId: "thread-live-owner",
      cwd: workspaceDir,
      stateDir,
      procRoot: fakeProcRoot,
      env: testEnv,
    });
    assert.equal(regRes.outcome, "already running");

    // 7. No queue call was invoked
    assert.equal(getQueueInvocations().length, 0);
  });

  it("missing procfs: restricted/missing procfs with dead PID safely recovers preparing state", async () => {
    const fakeProcRoot = path.join(tmpRoot, "fake-proc-empty");
    fs.mkdirSync(fakeProcRoot, { recursive: true });

    const deadPid = 99999999;
    // 1. checkWatcherProcess against fake procfs with dead PID returns alive: false, identity: "dead"
    const idResult = checkWatcherProcess(deadPid, null, null, fakeProcRoot);
    assert.equal(idResult.alive, false);
    assert.equal(idResult.identity, "dead");
    assert.equal(isWatcherProcessAlive(deadPid, null, null, fakeProcRoot), false);

    const chainId = "chain-proc-dead-safe";
    setupMockChainFiles(chainId);

    const recPath = getRecordPath(stateDir, chainId);
    writeRecordAtomic(recPath, {
      chainId,
      threadId: "thread-dead-safe",
      cwd: workspaceDir,
      status: "waiting",
      pid: deadPid,
      startTime: "12345",
    });

    const claimsDir = path.join(stateDir, "claims");
    fs.mkdirSync(claimsDir, { recursive: true });
    const claimPath = getClaimPath(stateDir, chainId);
    writeRecordAtomic(claimPath, {
      chainId,
      phase: "preparing",
      pid: deadPid,
      startTime: "12345",
      claimedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attempts: 1,
    });

    // 2. Stale lock owned by dead PID is automatically cleared by acquireClaimLock
    const lockDir = path.join(claimsDir, `chain-${chainId}.lock`);
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: deadPid, time: Date.now() }));
    const acquiredLock = acquireClaimLock(claimsDir, chainId, { procRoot: fakeProcRoot });
    assert.ok(acquiredLock);
    acquiredLock.release();

    // 3. resumePendingWatches: safely recovers and delivers exactly once
    const testEnv = {
      ...process.env,
      KUSABI_STATE_DIR: kusabiStateDir,
      TEST_QUEUE_LOG_DIR: queueLogDir,
    };

    const res = await resumePendingWatches({
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      sync: true,
      procRoot: fakeProcRoot,
      env: testEnv,
    });

    assert.equal(res.resumed, 1, "Preparing claim with dead PID is safely recovered");
    assert.equal(getQueueInvocations().length, 1);

    const finalRecord = readJson(recPath);
    assert.equal(finalRecord.status, "delivered");
  });

  it("missing procfs: restricted/missing procfs with queue_inflight fails closed as ambiguous", async () => {
    const fakeProcRoot = path.join(tmpRoot, "fake-proc-empty");
    fs.mkdirSync(fakeProcRoot, { recursive: true });

    const chainId = "chain-proc-inflight-ambiguous";
    setupMockChainFiles(chainId);

    const claimsDir = path.join(stateDir, "claims");
    fs.mkdirSync(claimsDir, { recursive: true });
    const claimPath = getClaimPath(stateDir, chainId);
    writeRecordAtomic(claimPath, {
      chainId,
      phase: "queue_inflight",
      pid: process.pid,
      startTime: "12345",
      claimedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attempts: 1,
    });

    // In-flight queue with unknown process identity must fail closed as ambiguous
    const res = tryAcquireClaim(claimsDir, chainId, { procRoot: fakeProcRoot });
    assert.equal(res.acquired, false);
    assert.equal(res.outcome, OUTCOME_AMBIGUOUS_DELIVERY);

    const claimOnDisk = readJson(claimPath);
    assert.equal(claimOnDisk.phase, "ambiguous");
    assert.match(claimOnDisk.reason, /Unknown process identity/);
  });
it("model-free launch wrapper: launchAndWatch dispatches companion, captures wait line, registers watcher, and returns output", async () => {
    const testEnv = {
      ...process.env,
      KUSABI_STATE_DIR: kusabiStateDir,
      TEST_QUEUE_LOG_DIR: queueLogDir,
      TEST_DETACH_CHAIN_ID: "chain-launched-999",
    };

    setupMockChainFiles("chain-launched-999");

    const res = await launchAndWatch({
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      args: ["--container", "cid-123", "--brief-file", "/tmp/brief.md"],
      threadId: "thread-launch-wrapper",
      cwd: workspaceDir,
      stateDir,
      sync: true,
      env: testEnv,
    });

    assert.equal(res.success, true);
    assert.equal(res.chainId, "chain-launched-999");
    assert.match(res.stdout, /Detached chain launched/);
    assert.match(res.stdout, /chain-launched-999/);

    // Watcher should have been registered and delivered
    assert.ok(res.registration);
    assert.equal(res.registration.outcome, OUTCOME_DELIVERED);

    const onDisk = readJson(getRecordPath(stateDir, "chain-launched-999"));
    assert.equal(onDisk.status, "delivered");
    assert.equal(getQueueInvocations().length, 1);
  });

  it("current selector output: launchAndWatch safely resolves actual chain from --since selector without matching chain-detach-* log basename", async () => {
    const selectorCompanion = path.join(tmpRoot, "mock-selector-companion.mjs");
    fs.writeFileSync(
      selectorCompanion,
      `#!/usr/bin/env node
import fs from "node:fs";
fs.writeSync(1, "Detached chain launched (pid 12345).\\nLog: /tmp/kusabi/state/chain-detach-1788698641659.log\\n\\nTo wait for completion, run:\\n  kusabi-companion chain-wait --next --since 2026-09-06T12:44:01.657Z\\n");
process.exitCode = 0;
`,
      { mode: 0o755 }
    );

    const chainId = "chain-actual-selector-999";
    const resolved = path.resolve(workspaceDir);
    const hash = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 12);
    const chainsDir = path.join(kusabiStateDir, hash, "chains");
    fs.mkdirSync(chainsDir, { recursive: true });

    setupMockChainFiles(chainId, { status: "completed", disposition: "accept", container: "cid-selector-999" });
    // Explicitly update control.json createdAt to match after since stamp
    const controlPath = path.join(chainsDir, chainId, "control.json");
    const controlData = readJson(controlPath);
    controlData.createdAt = "2026-09-06T12:44:02.000Z";
    fs.writeFileSync(controlPath, JSON.stringify(controlData), "utf8");

    const testEnv = {
      ...process.env,
      KUSABI_STATE_DIR: kusabiStateDir,
      TEST_QUEUE_LOG_DIR: queueLogDir,
    };

    const res = await launchAndWatch({
      companionBin: selectorCompanion,
      codexBin: mockCodexScript,
      args: ["--container", "cid-selector-999", "--brief-file", "/tmp/brief.md"],
      threadId: "thread-selector-test",
      cwd: workspaceDir,
      stateDir,
      sync: true,
      env: testEnv,
    });

    assert.equal(res.success, true);
    assert.equal(res.chainId, "chain-actual-selector-999", "Must resolve actual chain ID from --since selector");
    assert.notEqual(res.chainId, "chain-detach-1788698641659", "Must never treat chain-detach-* log name as chain ID");

    assert.ok(res.registration);
    assert.equal(res.registration.outcome, OUTCOME_DELIVERED);

    // Verify record on disk matches the actual chain ID and NOT the log basename
    const onDiskActual = readJson(getRecordPath(stateDir, "chain-actual-selector-999"));
    assert.equal(onDiskActual.status, "delivered");
    assert.equal(onDiskActual.chainId, "chain-actual-selector-999");

    const onDiskBogus = getRecordPath(stateDir, "chain-detach-1788698641659");
    assert.equal(fs.existsSync(onDiskBogus), false, "Bogus chain-detach-* record must NOT exist");
    assert.equal(getQueueInvocations().length, 1);
  });

  it("dispatch-refused output: launchAndWatch refuses registration on dispatch failure and creates no bogus watch record", async () => {
    const refusedCompanion = path.join(tmpRoot, "mock-refused-companion.mjs");
    fs.writeFileSync(
      refusedCompanion,
      `#!/usr/bin/env node
import fs from "node:fs";
fs.writeSync(1, "Log: /tmp/kusabi/state/chain-detach-1788698641659.log\\n");
fs.writeSync(2, "dispatch refused: the declared ## Smoke is already red on the checkout as handed to the worker\\n");
process.exitCode = 1;
`,
      { mode: 0o755 }
    );

    const testEnv = {
      ...process.env,
      KUSABI_STATE_DIR: kusabiStateDir,
      TEST_QUEUE_LOG_DIR: queueLogDir,
    };

    const res = await launchAndWatch({
      companionBin: refusedCompanion,
      codexBin: mockCodexScript,
      args: ["--container", "cid-123", "--brief-file", "/tmp/brief.md"],
      threadId: "thread-refused-test",
      cwd: workspaceDir,
      stateDir,
      sync: true,
      env: testEnv,
    });

    assert.equal(res.success, false);
    assert.equal(res.chainId, null);
    assert.equal(res.registration, null);

    const recordsDir = path.join(stateDir, "records");
    if (fs.existsSync(recordsDir)) {
      const records = fs.readdirSync(recordsDir).filter((r) => r.endsWith(".json"));
      assert.equal(records.length, 0, "No records should be created on dispatch refusal");
    }

    assert.equal(getQueueInvocations().length, 0);
  });

  it("dispatch-refused output: extractDispatchFromHookInput detects dispatch refusal and never extracts log basename as chainId", () => {
    const payload = {
      command: "kusabi-companion chain-detach --container cid-123 --brief-file /tmp/b.md",
      response: "Log: /tmp/kusabi/state/chain-detach-1788698641659.log\ndispatch refused: brief has unverified claim",
      cwd: workspaceDir,
    };
    const dispatch = extractDispatchFromHookInput(payload, { CODEX_THREAD_ID: "thread-hook-refuse" });
    assert.ok(dispatch);
    assert.equal(dispatch.chainId, null, "Refused dispatch must have null chainId");
    assert.equal(dispatch.refused, true);
  });

  it("selector output without chain directory: bounded resolution times out safely without creating bogus watch record", async () => {
    const noChainCompanion = path.join(tmpRoot, "mock-nochain-companion.mjs");
    fs.writeFileSync(
      noChainCompanion,
      `#!/usr/bin/env node
import fs from "node:fs";
fs.writeSync(1, "Detached chain launched (pid 999).\\nLog: /tmp/kusabi/state/chain-detach-1788698641659.log\\n\\nTo wait for completion, run:\\n  kusabi-companion chain-wait --next --since 2026-09-06T12:00:00.000Z\\n");
process.exitCode = 0;
`,
      { mode: 0o755 }
    );

    const testEnv = {
      ...process.env,
      KUSABI_STATE_DIR: kusabiStateDir,
      TEST_QUEUE_LOG_DIR: queueLogDir,
    };

    const res = await launchAndWatch({
      companionBin: noChainCompanion,
      codexBin: mockCodexScript,
      args: ["--container", "cid-123", "--brief-file", "/tmp/brief.md"],
      threadId: "thread-nochain-test",
      cwd: workspaceDir,
      stateDir,
      sync: true,
      timeoutMs: 10,
      env: testEnv,
    });

    assert.equal(res.success, false);
    assert.equal(res.chainId, null);
    assert.equal(res.registration, null);

    const bogusPath = getRecordPath(stateDir, "chain-detach-1788698641659");
    assert.equal(fs.existsSync(bogusPath), false, "No bogus watch record should be created");
  });

  it("realistic delayed chain creation: polling selects new eligible chain and ignores older pre-existing chain", async () => {
    // 1. Pre-create an older pre-existing chain in the kusabi workspace
    const staleChainId = "chain-stale-older-111";
    setupMockChainFiles(staleChainId, { status: "completed", disposition: "accept", container: "cid-stale" });
    const resolved = path.resolve(workspaceDir);
    const hash = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 12);
    const chainsDir = path.join(kusabiStateDir, hash, "chains");
    const staleControlPath = path.join(chainsDir, staleChainId, "control.json");
    const staleControl = readJson(staleControlPath);
    staleControl.createdAt = "2026-09-06T12:00:00.000Z";
    fs.writeFileSync(staleControlPath, JSON.stringify(staleControl), "utf8");

    // 2. Companion emits --since timestamp that is AFTER the stale chain
    const delayedCompanion = path.join(tmpRoot, "mock-delayed-companion.mjs");
    fs.writeFileSync(
      delayedCompanion,
      `#!/usr/bin/env node
import fs from "node:fs";
fs.writeSync(1, "Detached chain launched (pid 22222).\\nLog: /tmp/kusabi/state/chain-detach-1788698641659.log\\n\\nTo wait for completion, run:\\n  kusabi-companion chain-wait --next --since 2026-09-06T12:30:00.000Z\\n");
process.exitCode = 0;
`,
      { mode: 0o755 }
    );

    const newChainId = "chain-new-delayed-222";

    // 3. Delay creation of the new chain by 100ms
    const timer = setTimeout(() => {
      setupMockChainFiles(newChainId, { status: "completed", disposition: "accept", container: "cid-new" });
      const newControlPath = path.join(chainsDir, newChainId, "control.json");
      const newControl = readJson(newControlPath);
      newControl.createdAt = "2026-09-06T12:30:01.000Z";
      fs.writeFileSync(newControlPath, JSON.stringify(newControl), "utf8");
    }, 100);

    const testEnv = {
      ...process.env,
      KUSABI_STATE_DIR: kusabiStateDir,
      TEST_QUEUE_LOG_DIR: queueLogDir,
    };

    try {
      const res = await launchAndWatch({
        companionBin: delayedCompanion,
        codexBin: mockCodexScript,
        args: ["--container", "cid-new", "--brief-file", "/tmp/brief.md"],
        threadId: "thread-delayed-test",
        cwd: workspaceDir,
        stateDir,
        sync: true,
        timeoutMs: 1500,
        env: testEnv,
      });

      assert.equal(res.success, true);
      assert.equal(res.chainId, newChainId, "Must bind to the newly created eligible chain");
      assert.notEqual(res.chainId, staleChainId, "Must never bind to pre-existing stale chain");
      assert.ok(res.registration);
      assert.equal(res.registration.outcome, OUTCOME_DELIVERED);

      // Verify watch record created only for new chain, never for stale chain
      const newRecord = readJson(getRecordPath(stateDir, newChainId));
      assert.equal(newRecord.status, "delivered");
      assert.equal(newRecord.chainId, newChainId);

      const staleRecordPath = getRecordPath(stateDir, staleChainId);
      assert.equal(fs.existsSync(staleRecordPath), false, "No watch record should be created for stale chain");

      assert.equal(getQueueInvocations().length, 1);
    } finally {
      clearTimeout(timer);
    }
  });

  it("timeout with older existing chain: fails cleanly without binding to stale chain or registering watch", async () => {
    // 1. Pre-create an older pre-existing chain
    const staleChainId = "chain-stale-prior-333";
    setupMockChainFiles(staleChainId, { status: "completed", disposition: "accept", container: "cid-prior" });
    const resolved = path.resolve(workspaceDir);
    const hash = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 12);
    const chainsDir = path.join(kusabiStateDir, hash, "chains");
    const staleControlPath = path.join(chainsDir, staleChainId, "control.json");
    const staleControl = readJson(staleControlPath);
    staleControl.createdAt = "2026-09-06T12:00:00.000Z";
    fs.writeFileSync(staleControlPath, JSON.stringify(staleControl), "utf8");

    // 2. Companion emits --since timestamp that is AFTER the stale chain; no new chain appears
    const timeoutCompanion = path.join(tmpRoot, "mock-timeout-companion.mjs");
    fs.writeFileSync(
      timeoutCompanion,
      `#!/usr/bin/env node
import fs from "node:fs";
fs.writeSync(1, "Detached chain launched (pid 33333).\\nLog: /tmp/kusabi/state/chain-detach-1788698641659.log\\n\\nTo wait for completion, run:\\n  kusabi-companion chain-wait --next --since 2026-09-06T12:30:00.000Z\\n");
process.exitCode = 0;
`,
      { mode: 0o755 }
    );

    const testEnv = {
      ...process.env,
      KUSABI_STATE_DIR: kusabiStateDir,
      TEST_QUEUE_LOG_DIR: queueLogDir,
    };

    const res = await launchAndWatch({
      companionBin: timeoutCompanion,
      codexBin: mockCodexScript,
      args: ["--container", "cid-prior", "--brief-file", "/tmp/brief.md"],
      threadId: "thread-timeout-test",
      cwd: workspaceDir,
      stateDir,
      sync: true,
      timeoutMs: 100,
      env: testEnv,
    });

    assert.equal(res.success, false);
    assert.equal(res.chainId, null, "Must not resolve stale chain on timeout");
    assert.equal(res.registration, null);

    // Verify no records created in stateDir for the stale chain or any bogus chain
    const staleRecordPath = getRecordPath(stateDir, staleChainId);
    assert.equal(fs.existsSync(staleRecordPath), false, "Stale chain must NOT be watched or registered");

    const bogusPath = getRecordPath(stateDir, "chain-detach-1788698641659");
    assert.equal(fs.existsSync(bogusPath), false, "No bogus watch record should be created");

    assert.equal(getQueueInvocations().length, 0);
  });

  // --- Acceptance: appear-timeout default + remote endpoint propagation ---

  it("appearance window default: DEFAULT_APPEAR_TIMEOUT_MS is 120000 and is launchAndWatch's default timeoutMs", () => {
    assert.equal(
      registerWatchApi.DEFAULT_APPEAR_TIMEOUT_MS,
      120000,
      "default appearance window must match chain-wait --appear-timeout (120s)"
    );
    assert.match(
      launchAndWatch.toString(),
      /timeoutMs\s*=\s*DEFAULT_APPEAR_TIMEOUT_MS/,
      "launchAndWatch must default timeoutMs from DEFAULT_APPEAR_TIMEOUT_MS"
    );
  });

  it("explicit remote endpoint: launchAndWatch propagates remote into exactly one codex queue argv", async () => {
    const chainId = "chain-remote-launch-01";
    const threadId = "thread-remote-launch";
    const remoteEndpoint = "https://codex.example.test/remote-endpoint";
    setupMockChainFiles(chainId);

    const testEnv = {
      ...process.env,
      KUSABI_STATE_DIR: kusabiStateDir,
      TEST_QUEUE_LOG_DIR: queueLogDir,
      TEST_DETACH_CHAIN_ID: chainId,
    };

    const res = await launchAndWatch({
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      args: ["--container", "cid-remote", "--brief-file", "/tmp/brief-remote.md"],
      threadId,
      cwd: workspaceDir,
      stateDir,
      sync: true,
      remote: remoteEndpoint,
      env: testEnv,
    });

    assert.equal(res.success, true);
    assert.equal(res.chainId, chainId);
    assert.ok(res.registration);
    assert.equal(res.registration.outcome, OUTCOME_DELIVERED);

    const invocations = getQueueInvocations();
    assert.equal(invocations.length, 1, "exactly one codex queue invocation");
    const argv = invocations[0].argv;
    const msg = res.registration.record.notification.message;
    assert.deepEqual(
      argv,
      ["queue", "--remote", remoteEndpoint, "--thread", threadId, "--message", msg],
      "expected semantic argv: queue --remote <endpoint> --thread <threadId> --message <summary>"
    );
  });

  it("compatibility: absence of remote endpoint preserves queue argv without --remote", async () => {
    const chainId = "chain-remote-absent-01";
    const threadId = "thread-remote-absent";
    setupMockChainFiles(chainId);

    const testEnv = {
      ...process.env,
      KUSABI_STATE_DIR: kusabiStateDir,
      TEST_QUEUE_LOG_DIR: queueLogDir,
      TEST_DETACH_CHAIN_ID: chainId,
    };

    const res = await launchAndWatch({
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      args: ["--container", "cid-no-remote", "--brief-file", "/tmp/brief-no-remote.md"],
      threadId,
      cwd: workspaceDir,
      stateDir,
      sync: true,
      env: testEnv,
    });

    assert.equal(res.success, true);
    assert.equal(res.registration.outcome, OUTCOME_DELIVERED);

    const invocations = getQueueInvocations();
    assert.equal(invocations.length, 1);
    const argv = invocations[0].argv;
    const msg = res.registration.record.notification.message;
    assert.equal(argv.includes("--remote"), false, "no --remote element when endpoint omitted");
    assert.deepEqual(argv, ["queue", "--thread", threadId, "--message", msg]);
  });

  it("CLI --remote: register-watch.mjs passes remote through to watcher queue argv", async () => {
    const chainId = "chain-remote-cli-01";
    const threadId = "thread-remote-cli";
    const remoteEndpoint = "https://codex.example.test/cli-remote";
    setupMockChainFiles(chainId);

    const testEnv = {
      ...process.env,
      KUSABI_STATE_DIR: kusabiStateDir,
      TEST_QUEUE_LOG_DIR: queueLogDir,
    };

    const proc = spawnSync(process.execPath, [
      REGISTER_SCRIPT,
      "--chain", chainId,
      "--thread", threadId,
      "--remote", remoteEndpoint,
      "--cwd", workspaceDir,
      "--state-dir", stateDir,
      "--companion-bin", mockCompanionScript,
      "--codex-bin", mockCodexScript,
      "--sync",
    ], {
      env: testEnv,
      encoding: "utf8",
    });

    assert.equal(proc.status, 0, proc.stderr || proc.stdout);

    const onDisk = readJson(getRecordPath(stateDir, chainId));
    assert.equal(onDisk.status, "delivered");

    const invocations = getQueueInvocations();
    assert.equal(invocations.length, 1);
    const argv = invocations[0].argv;
    assert.equal(argv[0], "queue");
    assert.equal(argv[1], "--remote");
    assert.equal(argv[2], remoteEndpoint);
    assert.equal(argv[3], "--thread");
    assert.equal(argv[4], threadId);
    assert.equal(argv[5], "--message");
    assert.equal(argv[6], onDisk.notification.message);
  });

  it("CLI --launch --remote: register-watch.mjs forwards remote to watcher queue argv", async () => {
    const chainId = "chain-remote-cli-launch-01";
    const threadId = "thread-remote-cli-launch";
    const remoteEndpoint = "https://codex.example.test/cli-launch-remote";
    setupMockChainFiles(chainId);

    const testEnv = {
      ...process.env,
      KUSABI_STATE_DIR: kusabiStateDir,
      TEST_QUEUE_LOG_DIR: queueLogDir,
      TEST_DETACH_CHAIN_ID: chainId,
    };

    const proc = spawnSync(process.execPath, [
      REGISTER_SCRIPT,
      "--launch",
      "--remote", remoteEndpoint,
      "--thread", threadId,
      "--cwd", workspaceDir,
      "--state-dir", stateDir,
      "--companion-bin", mockCompanionScript,
      "--codex-bin", mockCodexScript,
      "--sync",
      "--",
      "--container", "cid-cli-launch-remote",
      "--brief-file", "/tmp/brief-cli-launch-remote.md",
    ], {
      env: testEnv,
      encoding: "utf8",
    });

    assert.equal(proc.status, 0, proc.stderr || proc.stdout);

    const onDisk = readJson(getRecordPath(stateDir, chainId));
    assert.equal(onDisk.status, "delivered");

    const invocations = getQueueInvocations();
    assert.equal(invocations.length, 1);
    const argv = invocations[0].argv;
    assert.deepEqual(argv, [
      "queue",
      "--remote", remoteEndpoint,
      "--thread", threadId,
      "--message", onDisk.notification.message,
    ]);
  });

  it("legacy kairanban-era chain record: already-delivered unprefixed record is not re-delivered after upgrade", async () => {
    const chainId = "chain-legacy-migrate-01";
    const threadId = "thread-legacy";
    setupMockChainFiles(chainId);

    const testEnv = {
      ...process.env,
      KUSABI_STATE_DIR: kusabiStateDir,
      TEST_QUEUE_LOG_DIR: queueLogDir,
    };

    // Simulate a kairanban-era install: unprefixed record + claim, both delivered
    const legacyRecordPath = path.join(stateDir, "records", `${chainId}.json`);
    const legacyClaimPath = path.join(stateDir, "claims", `${chainId}.claim`);
    fs.mkdirSync(path.dirname(legacyRecordPath), { recursive: true });
    fs.mkdirSync(path.dirname(legacyClaimPath), { recursive: true });
    writeRecordAtomic(legacyRecordPath, {
      chainId,
      threadId,
      cwd: workspaceDir,
      status: "delivered",
      outcome: OUTCOME_DELIVERED,
    });
    writeRecordAtomic(legacyClaimPath, {
      chainId,
      phase: "delivered",
      claimedAt: new Date().toISOString(),
    });

    // Re-registering after the upgrade must NOT queue again
    const res = await registerWatch({
      chainId,
      threadId,
      cwd: workspaceDir,
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      sync: true,
      env: testEnv,
    });
    assert.equal(res.outcome, OUTCOME_ALREADY_DELIVERED);
    assert.equal(getQueueInvocations().length, 0);

    // The canonical (kind-prefixed) record must not have been created
    assert.equal(fs.existsSync(getRecordPath(stateDir, chainId)), false, "no new record file for a legacy-delivered chain");
  });

  it("legacy kairanban-era chain record: pending unprefixed record resumes through the legacy path exactly once", async () => {
    const chainId = "chain-legacy-pending-01";
    const threadId = "thread-legacy-pending";
    setupMockChainFiles(chainId);

    const testEnv = {
      ...process.env,
      KUSABI_STATE_DIR: kusabiStateDir,
      TEST_QUEUE_LOG_DIR: queueLogDir,
    };

    const legacyRecordPath = path.join(stateDir, "records", `${chainId}.json`);
    fs.mkdirSync(path.dirname(legacyRecordPath), { recursive: true });
    writeRecordAtomic(legacyRecordPath, {
      chainId,
      threadId,
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
      env: testEnv,
    });
    assert.equal(res.resumed, 1);
    assert.deepEqual(res.chains, [chainId]);
    assert.equal(getQueueInvocations().length, 1);

    // The same (legacy) file was updated in place — no canonical twin
    const updated = readJson(legacyRecordPath);
    assert.equal(updated.status, "delivered");
    assert.equal(fs.existsSync(getRecordPath(stateDir, chainId)), false, "no canonical twin record");

    const second = await resumePendingWatches({
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      sync: true,
      env: testEnv,
    });
    assert.equal(second.resumed, 0);
    assert.equal(getQueueInvocations().length, 1);
  });
});
describe("kusabi-codex-notify task lifecycle (kusabi #491)", () => {
  let tmpRoot;
  let stateDir;
  let kusabiStateDir;
  let workspaceDir;
  let mockCompanionScript;
  let mockCodexScript;
  let queueLogDir;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kcn-task-"));
    stateDir = path.join(tmpRoot, "notify-state");
    kusabiStateDir = path.join(tmpRoot, "kusabi-state");
    workspaceDir = path.join(tmpRoot, "workspace");
    queueLogDir = path.join(tmpRoot, "queue-logs");

    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(kusabiStateDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(queueLogDir, { recursive: true });

    // Deterministic stand-in companion with task branches (same as the chain
    // suite's mock; kept here so the task suite is self-contained).
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
  const since = process.env.TEST_TASK_SINCE || "2026-09-06T12:00:00.000Z";
  fs.writeSync(1, "Detached task launched (pid 999).\\nLog: /tmp/kusabi/state/task-detach-1788698641659.log\\n\\nTo wait for completion, run:\\n  kusabi-companion task-wait --next --since " + since + "\\n");
  process.exitCode = 0;
} else if (subcmd === "task-wait") {
  (async () => {
    if (process.env.TEST_TASK_WAIT_MISMATCH === "1") {
      fs.writeSync(1, "task wrong-job-999: status=completed waited=2s\\n");
      process.exitCode = 0;
      return;
    }
    const pollMs = Number(process.env.TEST_TASK_WAIT_POLL_MS || 25);
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      let job = null;
      try { job = JSON.parse(fs.readFileSync(jobFile, "utf8")); } catch {}
      if (job && TERMINAL.has(job.status)) {
        const phase = job.phase ? " phase=" + job.phase : "";
        const failure = job.failure ? " failure=" + (typeof job.failure === "string" ? job.failure : JSON.stringify(job.failure)) : "";
        const err = (typeof job.error === "string" && job.error) ? " error=" + job.error.replace(/\\s+/g, " ").slice(0, 120) : "";
        fs.writeSync(1, "task " + id + ": status=" + job.status + phase + failure + err + " waited=2s\\n");
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

const subcmd = args[0];
const threadIdx = args.indexOf("--thread");
const thread = threadIdx >= 0 ? args[threadIdx + 1] : null;

if (process.env.TEST_CODEX_FAIL === "closed" || thread === "closed-thread") {
  fs.writeSync(2, "Error: thread " + thread + " is closed or unavailable\\n");
  process.exitCode = 1;
} else if (process.env.TEST_CODEX_FAIL === "generic" || thread === "failing-thread") {
  fs.writeSync(2, "Error: codex queue command failed (connection error)\\n");
  process.exitCode = 1;
} else {
  process.exitCode = 0;
}
`,
      { mode: 0o755 }
    );
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
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

  function setupMockJobFiles(jobId, { status = "running", phase = "implement", backend = "opencode", modelEntry = "opencode-go/deepseek-v4-flash:max", fallbacks = null, container = null, startedAt = null, failure = null, customWorkspace = null } = {}) {
    const ws = path.resolve(customWorkspace || workspaceDir);
    const hash = crypto.createHash("sha256").update(ws).digest("hex").slice(0, 12);
    const jobDir = path.join(kusabiStateDir, hash, "jobs", jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    const job = {
      id: jobId,
      kind: "task",
      title: "test task",
      status,
      phase,
      backend,
      modelEntry,
      startedAt: startedAt || new Date().toISOString(),
      finishedAt: status !== "running" ? new Date().toISOString() : null,
      cwd: ws,
      sessionID: "ses-test-123",
    };
    if (fallbacks) job.fallbacks = fallbacks;
    if (container) job.container = container;
    if (failure) job.failure = failure;
    fs.writeFileSync(path.join(jobDir, "job.json"), JSON.stringify(job), "utf8");
    return jobDir;
  }

  /** Chain fixture helper for cross-kind tests (mirrors the chain suite). */
  function setupMockChainFiles(chainId, { status = "completed", disposition = "accept", container = "1d90ea9e70b6", customWorkspace = null } = {}) {
    const ws = path.resolve(customWorkspace || workspaceDir);
    const hash = crypto.createHash("sha256").update(ws).digest("hex").slice(0, 12);
    const chainDir = path.join(kusabiStateDir, hash, "chains", chainId);
    fs.mkdirSync(chainDir, { recursive: true });

    const controlData = { status, round: 1 };
    if (container !== null) {
      controlData.container = container;
    }
    fs.writeFileSync(path.join(chainDir, "control.json"), JSON.stringify(controlData), "utf8");
    fs.writeFileSync(
      path.join(chainDir, "chain.json"),
      JSON.stringify({ chainId, records: [{ round: 1, disposition: { disposition } }] }),
      "utf8"
    );
    const inboxDir = path.join(kusabiStateDir, hash, "inbox");
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(
      path.join(inboxDir, `${chainId}.md`),
      `# Chain ${chainId}\n- **status**: ${status}\n- **disposition**: ${disposition}\n- **container**: ${container || "unavailable"}\n`,
      "utf8"
    );
  }

  const taskEnv = (extra = {}) => ({
    ...process.env,
    KUSABI_STATE_DIR: kusabiStateDir,
    TEST_QUEUE_LOG_DIR: queueLogDir,
    ...extra,
  });

  it("task instant completion: registerTaskWatch waits, delivers exactly one notification with required fields", async () => {
    const jobId = "job-instant-001";
    const threadId = "thread-task-1";
    setupMockJobFiles(jobId, {
      status: "completed",
      phase: "implement",
      backend: "opencode",
      modelEntry: "opencode-go/deepseek-v4-flash:max",
    });

    const res = await registerTaskWatch({
      jobId,
      threadId,
      cwd: workspaceDir,
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      sync: true,
      env: taskEnv(),
    });

    assert.equal(res.outcome, OUTCOME_DELIVERED);
    assert.equal(res.record.status, "delivered");
    assert.deepEqual(res.record.subject, { kind: "task", id: jobId });

    const msg = res.record.notification.message;
    assert.match(msg, new RegExp(`\\[kusabi\\] Task ${jobId} completed\\.`));
    assert.match(msg, /- Status: completed/);
    assert.match(msg, /- Class: completed/);
    assert.match(msg, /- Phase: implement/);
    assert.match(msg, /- Backend\/Model: opencode \(opencode-go\/deepseek-v4-flash:max\)/);
    assert.match(msg, /- Container: unavailable/);
    assert.match(msg, new RegExp(`- Recover: kusabi-companion result ${jobId} \\| kusabi-companion status ${jobId}`));

    // Exactly one queue call with the captured thread
    const invocations = getQueueInvocations();
    assert.equal(invocations.length, 1);
    assert.deepEqual(invocations[0].argv.slice(0, 3), ["queue", "--thread", threadId]);

    // Durable record + claim on disk, kind-explicit
    const onDisk = readJson(getRecordPath(stateDir, { kind: "task", id: jobId }));
    assert.equal(onDisk.status, "delivered");
    assert.equal(onDisk.outcome, OUTCOME_DELIVERED);
    const claimOnDisk = readJson(getClaimPath(stateDir, { kind: "task", id: jobId }));
    assert.equal(claimOnDisk.phase, "delivered");
    assert.deepEqual(claimOnDisk.subject, { kind: "task", id: jobId });
  });

  it("task notification distinguishes every terminal class", async () => {
    const cases = [
      { status: "completed", cls: "completed" },
      { status: "provider-error", cls: "failed" },
      { status: "error", cls: "failed" },
      { status: "timeout", cls: "stalled" },
      { status: "stalled", cls: "stalled" },
      { status: "serve-dead", cls: "stalled" },
      { status: "cancelled", cls: "cancelled" },
    ];

    for (const c of cases) {
      const jobId = `job-class-${c.status}`;
      setupMockJobFiles(jobId, { status: c.status, phase: "investigate" });
      const res = await watchTask({
        jobId,
        threadId: "thread-classes",
        cwd: workspaceDir,
        stateDir,
        companionBin: mockCompanionScript,
        codexBin: mockCodexScript,
        env: taskEnv(),
      });
      assert.equal(res.outcome, OUTCOME_DELIVERED, c.status);
      const msg = res.record.notification.message;
      assert.match(msg, new RegExp(`- Status: ${c.status}`), c.status);
      assert.match(msg, new RegExp(`- Class: ${c.cls}`), c.status);
      assert.match(msg, new RegExp(`\\[kusabi\\] Task ${jobId} ${c.status}\\.`), c.status);
    }

    assert.equal(getQueueInvocations().length, cases.length, "one queue call per terminal job");
  });

  it("task digest parsing: parses status/phase/failure and tolerates surrounding output", () => {
    const parsed = parseTaskWaitDigest("task job-xyz: status=provider-error phase=implement failure=quota:rate_limit waited=2s\n");
    assert.ok(parsed);
    assert.equal(parsed.jobId, "job-xyz");
    assert.equal(parsed.status, "provider-error");
    assert.equal(parsed.phase, "implement");
    assert.equal(parsed.failure, "quota:rate_limit");

    const parsed2 = parseTaskWaitDigest("task job-abc: status=completed waited=1s\n");
    assert.equal(parsed2.status, "completed");
    assert.equal(parsed2.jobId, "job-abc");

    assert.equal(parseTaskWaitDigest(""), null);
    assert.equal(parseTaskWaitDigest("chain chain-x: status=completed\n"), null);
  });

  it("task backend/model fallback trail: fallbacks recorded on the job appear in the notification", async () => {
    const jobId = "job-fallback-001";
    setupMockJobFiles(jobId, {
      status: "provider-error",
      phase: "implement",
      backend: "opencode",
      modelEntry: "opencode-go/deepseek-v4-flash:max",
      fallbacks: [
        { from: "opencode-go/deepseek-v4-flash:max", to: "agy/gemini-3.8-flash-high", reason: "quota", attempt: 1 },
      ],
    });

    const res = await watchTask({
      jobId,
      threadId: "thread-fallback",
      cwd: workspaceDir,
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      env: taskEnv(),
    });

    assert.equal(res.outcome, OUTCOME_DELIVERED);
    const msg = res.record.notification.message;
    assert.match(msg, /- Class: failed/);
    assert.match(
      msg,
      /- Backend\/Model: opencode \(opencode-go\/deepseek-v4-flash:max -> agy\/gemini-3.8-flash-high\)/
    );
  });

  it("task launch surface: launchTaskAndWatch resolves the real job id from the task-wait --since selector, captures inputs, returns promptly", async () => {
    const jobId = "job-launch-001";
    setupMockJobFiles(jobId, {
      status: "completed",
      phase: "review",
      backend: "claude",
      modelEntry: "opus",
      startedAt: "2026-09-06T12:30:02.000Z",
    });

    const res = await launchTaskAndWatch({
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      args: ["--container", "cid-launch-1", "--phase", "review", "--backend", "claude", "--model", "opus", "--brief-file", "/tmp/b.md"],
      threadId: "thread-launch-task",
      cwd: workspaceDir,
      stateDir,
      sync: true,
      env: taskEnv({ TEST_TASK_SINCE: "2026-09-06T12:30:00.000Z" }),
    });

    assert.equal(res.success, true);
    assert.equal(res.jobId, jobId, "Must resolve the actual job id from the --since selector");
    assert.deepEqual(res.captured, {
      container: "cid-launch-1",
      phase: "review",
      backend: "claude",
      model: "opus",
    });
    assert.match(res.stdout, /Detached task launched/);
    assert.ok(res.registration);
    assert.equal(res.registration.outcome, OUTCOME_DELIVERED);

    // Record persists the captured launch inputs and the explicit task subject
    const onDisk = readJson(getRecordPath(stateDir, { kind: "task", id: jobId }));
    assert.equal(onDisk.jobId, jobId);
    assert.deepEqual(onDisk.launch, {
      container: "cid-launch-1",
      phase: "review",
      backend: "claude",
      model: "opus",
    });
    assert.equal(getQueueInvocations().length, 1);

    // The notification names the container captured at launch
    const msg = onDisk.notification.message;
    assert.match(msg, /- Container: cid-launch-1/);
  });

  it("delayed job-id appearance: bounded polling binds the newly eligible job and never the task-detach-* log basename", async () => {
    // Stale pre-existing job, whose directory was created BEFORE the --since stamp.
    const staleJobId = "job-stale-older";
    const staleDir = setupMockJobFiles(staleJobId, {
      status: "completed",
      startedAt: "2026-09-06T12:00:00.000Z",
    });
    const staleCreatedAt = fs.statSync(staleDir).birthtimeMs || fs.statSync(staleDir).ctimeMs;
    const sinceStamp = new Date(staleCreatedAt + 1).toISOString();

    const newJobId = "job-new-delayed";
    const timer = setTimeout(() => {
      setupMockJobFiles(newJobId, {
        status: "completed",
        phase: "implement",
        startedAt: "2026-09-06T12:30:01.000Z",
      });
    }, 100);

    try {
      const res = await launchTaskAndWatch({
        companionBin: mockCompanionScript,
        codexBin: mockCodexScript,
        args: ["--container", "cid-delayed", "--brief-file", "/tmp/b.md"],
        threadId: "thread-delayed-task",
        cwd: workspaceDir,
        stateDir,
        sync: true,
        timeoutMs: 1500,
        env: taskEnv({ TEST_TASK_SINCE: sinceStamp }),
      });

      assert.equal(res.success, true);
      assert.equal(res.jobId, newJobId, "Must bind to the newly eligible job");
      assert.notEqual(res.jobId, staleJobId, "Must never bind to the stale job");

      // Never a record for the task-detach-* log basename
      const bogusPath = getRecordPath(stateDir, { kind: "task", id: "task-detach-1788698641659" });
      assert.equal(fs.existsSync(bogusPath), false, "No record for the task-detach-* log basename");

      const stalePath = getRecordPath(stateDir, { kind: "task", id: staleJobId });
      assert.equal(fs.existsSync(stalePath), false, "No record for the stale job");

      assert.equal(getQueueInvocations().length, 1);
    } finally {
      clearTimeout(timer);
    }
  });

  it("resolveJobIdFromSince: uses directory creation order despite conflicting startedAt and ignores recordless directories", () => {
    const resolved = path.resolve(workspaceDir);
    const hash = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 12);
    const jobsDir = path.join(kusabiStateDir, hash, "jobs");
    fs.mkdirSync(jobsDir, { recursive: true });

    const since = Date.now();
    // Create the older directory first, but give it the newer startedAt.
    const firstDir = setupMockJobFiles("job-directory-first", {
      status: "completed",
      startedAt: "2099-01-01T00:00:00.000Z",
    });
    // Keep birthtimeMs distinct so the adversarial ordering is deterministic.
    spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 25)"], { stdio: "ignore" });
    const secondDir = setupMockJobFiles("job-directory-second", {
      status: "completed",
      startedAt: "2000-01-01T00:00:00.000Z",
    });
    const firstCreatedAt = fs.statSync(firstDir).birthtimeMs;
    const secondCreatedAt = fs.statSync(secondDir).birthtimeMs;
    assert.ok(secondCreatedAt > firstCreatedAt, "fixture must create the second job directory later");

    // A dispatch that died before writing job.json: never a candidate.
    fs.mkdirSync(path.join(jobsDir, "job-recordless"), { recursive: true });

    const env = { KUSABI_STATE_DIR: kusabiStateDir };
    assert.equal(
      resolveJobIdFromSince(since, workspaceDir, env),
      "job-directory-second",
      "directory creation timestamp wins over job.json.startedAt"
    );
    assert.equal(resolveJobIdFromSince(Date.now() + 1000, workspaceDir, env), null);
  });

  it("task duplicate registration: second registration never queues again", async () => {
    const jobId = "job-dedup-001";
    const threadId = "thread-task-dedup";
    setupMockJobFiles(jobId, { status: "completed" });

    const first = await registerTaskWatch({
      jobId,
      threadId,
      cwd: workspaceDir,
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      sync: true,
      env: taskEnv(),
    });
    assert.equal(first.outcome, OUTCOME_DELIVERED);
    assert.equal(getQueueInvocations().length, 1);

    const second = await registerTaskWatch({
      jobId,
      threadId,
      cwd: workspaceDir,
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      sync: true,
      env: taskEnv(),
    });
    assert.equal(second.outcome, OUTCOME_ALREADY_DELIVERED);
    assert.equal(getQueueInvocations().length, 1);
  });

  it("task watcher restart: pending task record with dead pid resumes and delivers exactly once", async () => {
    const jobId = "job-restart-001";
    setupMockJobFiles(jobId, { status: "completed" });

    const recPath = getRecordPath(stateDir, { kind: "task", id: jobId });
    writeRecordAtomic(recPath, {
      subject: { kind: "task", id: jobId },
      jobId,
      threadId: "thread-task-restart",
      cwd: workspaceDir,
      status: "waiting",
      outcome: null,
      pid: 99999999,
      startTime: "12345",
      launch: { container: "cid-restart", phase: "implement", backend: null, model: null },
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
    assert.equal(getQueueInvocations().length, 1);

    const updated = readJson(recPath);
    assert.equal(updated.status, "delivered");

    // The launch-captured container survives the restart into the message
    assert.match(updated.notification.message, /- Container: cid-restart/);

    const second = await resumePendingWatches({
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      sync: true,
      env: taskEnv(),
    });
    assert.equal(second.resumed, 0);
    assert.equal(getQueueInvocations().length, 1);
  });

  it("task queue failure: retryable under the bounded claim protocol and the job record survives", async () => {
    const jobId = "job-queuefail-001";
    setupMockJobFiles(jobId, { status: "completed" });

    const first = await watchTask({
      jobId,
      threadId: "failing-thread",
      cwd: workspaceDir,
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      env: taskEnv(),
    });

    assert.equal(first.outcome, OUTCOME_QUEUE_FAILURE);
    assert.equal(first.record.status, "queue_failed");
    assert.equal(first.record.retryable, true);
    assert.equal(first.record.attempts, 1);

    const claimPath = getClaimPath(stateDir, { kind: "task", id: jobId });
    assert.equal(readJson(claimPath).phase, "failed_retryable");

    // The durable job record is untouched by the queue failure
    const job = readTaskJob(jobId, workspaceDir, kusabiStateDir);
    assert.equal(job.status, "completed");
    assert.equal(job.id, jobId);

    // Resume with a working thread: exactly one more queue call, delivered
    const recPath = getRecordPath(stateDir, { kind: "task", id: jobId });
    const rec = readJson(recPath);
    rec.threadId = "working-thread";
    rec.pid = 99999999;
    writeRecordAtomic(recPath, rec);

    const resumeRes = await resumePendingWatches({
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      sync: true,
      env: taskEnv(),
    });
    assert.equal(resumeRes.resumed, 1);
    assert.equal(getQueueInvocations().length, 2);
    assert.equal(readJson(recPath).status, "delivered");
    assert.equal(readJson(claimPath).phase, "delivered");
  });

  it("task queue failure bound: max attempts becomes terminal and is never resumed", async () => {
    const jobId = "job-maxretry-001";
    setupMockJobFiles(jobId, { status: "completed" });

    const claimPath = getClaimPath(stateDir, { kind: "task", id: jobId });
    fs.mkdirSync(path.join(stateDir, "claims"), { recursive: true });
    writeRecordAtomic(claimPath, {
      subject: { kind: "task", id: jobId },
      chainId: jobId,
      phase: "failed_retryable",
      attempts: MAX_DELIVERY_ATTEMPTS,
      maxAttempts: MAX_DELIVERY_ATTEMPTS,
    });

    const res = await watchTask({
      jobId,
      threadId: "failing-thread",
      cwd: workspaceDir,
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      env: taskEnv(),
    });

    assert.equal(res.outcome, OUTCOME_QUEUE_FAILURE);
    assert.equal(res.record.retryable, false);
    assert.equal(readJson(claimPath).phase, "failed_terminal");

    const recPath = getRecordPath(stateDir, { kind: "task", id: jobId });
    const rec = readJson(recPath);
    rec.pid = 99999999;
    writeRecordAtomic(recPath, rec);

    const resumeRes = await resumePendingWatches({
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      sync: true,
      env: taskEnv(),
    });
    assert.equal(resumeRes.resumed, 0);
  });

  it("task-wait infrastructure failure: non-zero exit is a separate watcher failure and never queues", async () => {
    const jobId = "job-waitfail-001";
    setupMockJobFiles(jobId, { status: "running" });

    const res = await watchTask({
      jobId,
      threadId: "thread-waitfail",
      cwd: workspaceDir,
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      env: taskEnv({ TEST_COMPANION_FAIL: "1" }),
    });

    assert.equal(res.outcome, OUTCOME_TASK_WAIT_FAILURE);
    assert.equal(res.record.status, "task_wait_failed");
    assert.equal(res.record.outcome, "task-wait failure");
    assert.equal(res.record.taskWait.exitCode, 1);
    assert.equal(getQueueInvocations().length, 0);

    // The job record is untouched — result recovery stays available
    assert.equal(readTaskJob(jobId, workspaceDir, kusabiStateDir).status, "running");
  });

  it("task-wait digest job-id mismatch: never guesses or re-binds", async () => {
    const jobId = "job-mismatch-001";
    setupMockJobFiles(jobId, { status: "completed" });

    const res = await watchTask({
      jobId,
      threadId: "thread-mismatch",
      cwd: workspaceDir,
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      env: taskEnv({ TEST_TASK_WAIT_MISMATCH: "1" }),
    });

    assert.equal(res.outcome, OUTCOME_TASK_WAIT_FAILURE);
    assert.equal(res.record.status, "task_wait_failed");
    assert.match(res.record.error.message, /refusing to guess/);
    assert.equal(getQueueInvocations().length, 0);
  });

  it("task malformed registration: invalid job id is rejected and recorded without crashing", async () => {
    const res = await registerTaskWatch({
      jobId: "bad job id; rm -rf",
      threadId: "valid-thread",
      cwd: workspaceDir,
      stateDir,
      sync: true,
    });
    assert.equal(res.outcome, OUTCOME_MALFORMED_REGISTRATION);
    assert.equal(res.record.status, "malformed_registration");
    assert.equal(getQueueInvocations().length, 0);
  });

  it("task launch refusal: task-detach failure creates no watch record and never queues", async () => {
    const refusedCompanion = path.join(tmpRoot, "mock-refused-task-companion.mjs");
    fs.writeFileSync(
      refusedCompanion,
      `#!/usr/bin/env node
import fs from "node:fs";
fs.writeSync(1, "Log: /tmp/kusabi/state/task-detach-1788698641659.log\\n");
fs.writeSync(2, "dispatch refused: brief has unverified claim\\n");
process.exitCode = 1;
`,
      { mode: 0o755 }
    );

    const res = await launchTaskAndWatch({
      companionBin: refusedCompanion,
      codexBin: mockCodexScript,
      args: ["--container", "cid-1", "--brief-file", "/tmp/b.md"],
      threadId: "thread-refused-task",
      cwd: workspaceDir,
      stateDir,
      sync: true,
      env: taskEnv(),
    });

    assert.equal(res.success, false);
    assert.equal(res.jobId, null);
    assert.equal(res.registration, null);
    assert.equal(getQueueInvocations().length, 0);

    const recordsDir = path.join(stateDir, "records");
    if (fs.existsSync(recordsDir)) {
      assert.equal(fs.readdirSync(recordsDir).filter((r) => r.endsWith(".json")).length, 0);
    }
  });

  it("task launch selector timeout: no job within the bounded window fails cleanly without records", async () => {
    const res = await launchTaskAndWatch({
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      args: ["--container", "cid-1", "--brief-file", "/tmp/b.md"],
      threadId: "thread-timeout-task",
      cwd: workspaceDir,
      stateDir,
      sync: true,
      timeoutMs: 10,
      env: taskEnv({ TEST_TASK_SINCE: "2999-01-01T00:00:00.000Z" }),
    });

    assert.equal(res.success, false);
    assert.equal(res.jobId, null);
    assert.equal(res.registration, null);
    assert.equal(getQueueInvocations().length, 0);
  });

  it("missing container metadata: task notification renders Container: unavailable", async () => {
    const jobId = "job-nocontainer-001";
    setupMockJobFiles(jobId, { status: "completed", phase: "gofer" });

    const res = await watchTask({
      jobId,
      threadId: "thread-nocontainer",
      cwd: workspaceDir,
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      env: taskEnv(),
    });

    assert.equal(res.outcome, OUTCOME_DELIVERED);
    assert.match(res.record.notification.message, /- Container: unavailable/);
    assert.match(res.record.notification.message, /- Phase: gofer/);
  });

  it("chain and task registrations never collide even for an equal id string", async () => {
    const sharedId = "item-1"; // deliberately NOT chain-*/job-* shaped
    const threadChain = "thread-chain-item";
    const threadTask = "thread-task-item";

    setupMockChainFiles(sharedId, { container: "cid-chain" });
    setupMockJobFiles(sharedId, { status: "completed", phase: "implement", container: "cid-task" });

    const env = taskEnv();

    const chainRes = await registerWatch({
      chainId: sharedId,
      threadId: threadChain,
      cwd: workspaceDir,
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      sync: true,
      env,
    });
    assert.equal(chainRes.outcome, OUTCOME_DELIVERED);

    const taskRes = await registerTaskWatch({
      jobId: sharedId,
      threadId: threadTask,
      cwd: workspaceDir,
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      sync: true,
      env,
    });
    assert.equal(taskRes.outcome, OUTCOME_DELIVERED);

    // Two independent records and claims, keyed by kind
    const chainRecord = readJson(getRecordPath(stateDir, { kind: "chain", id: sharedId }));
    const taskRecord = readJson(getRecordPath(stateDir, { kind: "task", id: sharedId }));
    assert.equal(chainRecord.subject.kind, "chain");
    assert.equal(taskRecord.subject.kind, "task");
    assert.equal(chainRecord.threadId, threadChain);
    assert.equal(taskRecord.threadId, threadTask);

    assert.equal(readJson(getClaimPath(stateDir, { kind: "chain", id: sharedId })).phase, "delivered");
    assert.equal(readJson(getClaimPath(stateDir, { kind: "task", id: sharedId })).phase, "delivered");

    // Exactly one notification per subject
    const invocations = getQueueInvocations();
    assert.equal(invocations.length, 2);
    const threads = invocations.map((i) => i.argv[2]).sort();
    assert.deepEqual(threads, [threadChain, threadTask].sort());

    // Chain record does not carry task launch metadata and vice versa
    assert.equal(chainRecord.jobId, undefined);
    assert.equal(taskRecord.chainId, undefined);
  });

  it("task CLI --task: spawnSync registers an existing job watcher and delivers", async () => {
    const jobId = "job-cli-001";
    const threadId = "thread-task-cli";
    setupMockJobFiles(jobId, { status: "completed" });

    const proc = spawnSync(process.execPath, [
      REGISTER_SCRIPT,
      "--task", jobId,
      "--thread", threadId,
      "--cwd", workspaceDir,
      "--state-dir", stateDir,
      "--companion-bin", mockCompanionScript,
      "--codex-bin", mockCodexScript,
      "--sync",
    ], {
      env: taskEnv(),
      encoding: "utf8",
    });

    assert.equal(proc.status, 0, proc.stderr || proc.stdout);

    const onDisk = readJson(getRecordPath(stateDir, { kind: "task", id: jobId }));
    assert.equal(onDisk.status, "delivered");
    assert.equal(onDisk.outcome, OUTCOME_DELIVERED);
    assert.equal(getQueueInvocations().length, 1);
  });

  it("real-process smoke: launch-task returns before its child, task-wait owns waiting, exactly one queue stand-in call", async () => {
    const jobId = "job-smoke-001";
    const threadId = "thread-smoke";
    setupMockJobFiles(jobId, { status: "running", phase: "implement" });

    // Launch via the real CLI entrypoint WITHOUT --sync: the launcher must
    // return promptly while a detached watcher owns the wait.
    const launchedAt = Date.now();
    const proc = spawnSync(process.execPath, [
      REGISTER_SCRIPT,
      "--launch-task",
      "--thread", threadId,
      "--cwd", workspaceDir,
      "--state-dir", stateDir,
      "--companion-bin", mockCompanionScript,
      "--codex-bin", mockCodexScript,
      "--",
      "--container", "cid-smoke",
      "--phase", "implement",
      "--model", "opencode-go/deepseek-v4-flash:max",
      "--brief-file", "/tmp/brief-smoke.md",
    ], {
      env: taskEnv({ TEST_TASK_SINCE: "2026-09-06T12:00:00.000Z" }),
      encoding: "utf8",
      timeout: 15000,
    });

    const launchMs = Date.now() - launchedAt;
    assert.equal(proc.status, 0, proc.stderr || proc.stdout);
    assert.match(proc.stdout, /Detached task launched/);

    const recPath = getRecordPath(stateDir, { kind: "task", id: jobId });

    // The launcher already wrote a waiting record (child not yet done) and
    // NO queue call has happened — the detached task-wait owns the wait.
    const waiting = readJson(recPath);
    assert.ok(waiting, "record must exist after launch");
    assert.equal(waiting.status, "waiting");
    assert.equal(getQueueInvocations().length, 0);

    // Flip the durable job to terminal: the detached watcher's task-wait
    // observes it and queues exactly one notification.
    const jobDir = setupMockJobFiles(jobId, { status: "completed", phase: "implement" });
    assert.ok(jobDir);

    let record = null;
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const candidate = readJson(recPath);
      if (candidate?.status === "delivered") {
        record = candidate;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.ok(record, "Detached task watcher should deliver after terminal flip");
    assert.equal(record.status, "delivered");
    assert.equal(record.outcome, OUTCOME_DELIVERED);

    const invocations = getQueueInvocations();
    assert.equal(invocations.length, 1, "exactly one queue stand-in call");
    assert.deepEqual(invocations[0].argv.slice(0, 3), ["queue", "--thread", threadId]);

    // The launcher returned promptly (well before the 15s bound), while the
    // terminal flip happened after launch — the return precedes the child.
    assert.ok(launchMs < 10000, `launcher took ${launchMs}ms`);
    assert.match(record.notification.message, /- Container: cid-smoke/);
    assert.match(record.notification.message, /- Phase: implement/);
  });

  it("task remote endpoint: launchTaskAndWatch propagates --remote into the queue argv", async () => {
    const jobId = "job-remote-001";
    const remoteEndpoint = "https://codex.example.test/task-remote";
    setupMockJobFiles(jobId, { status: "completed", startedAt: "2026-09-06T12:30:02.000Z" });

    const res = await launchTaskAndWatch({
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      args: ["--container", "cid-remote-task", "--brief-file", "/tmp/b.md"],
      threadId: "thread-remote-task",
      cwd: workspaceDir,
      stateDir,
      sync: true,
      remote: remoteEndpoint,
      env: taskEnv({ TEST_TASK_SINCE: "2026-09-06T12:30:00.000Z" }),
    });

    assert.equal(res.success, true);
    assert.equal(res.registration.outcome, OUTCOME_DELIVERED);

    const invocations = getQueueInvocations();
    assert.equal(invocations.length, 1);
    const argv = invocations[0].argv;
    const msg = res.registration.record.notification.message;
    assert.deepEqual(argv, ["queue", "--remote", remoteEndpoint, "--thread", "thread-remote-task", "--message", msg]);
  });

  it("task subject isolation: the chain watcher never sees task records and vice versa", async () => {
    // A task record with status waiting and a dead pid must only be resumed by
    // the task path; the chain resolver must not treat it as a chain.
    const jobId = "job-isolated-001";
    setupMockJobFiles(jobId, { status: "completed" });

    const recPath = getRecordPath(stateDir, { kind: "task", id: jobId });
    writeRecordAtomic(recPath, {
      subject: { kind: "task", id: jobId },
      jobId,
      threadId: "thread-isolated",
      cwd: workspaceDir,
      status: "waiting",
      outcome: null,
      pid: 99999999,
      startTime: "12345",
    });

    // registerWatch with the same id must treat it as a NEW chain subject
    // (explicit kinds, no token-shape inference) and not collide.
    const chainId = jobId;
    setupMockChainFiles(chainId, { container: "cid-isolated" });
    const res = await registerWatch({
      chainId,
      threadId: "thread-isolated-chain",
      cwd: workspaceDir,
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      sync: true,
      env: taskEnv(),
    });
    assert.equal(res.outcome, OUTCOME_DELIVERED);

    // The task record is untouched and still resumable as a task
    const taskRecord = readJson(recPath);
    assert.equal(taskRecord.status, "waiting");
    assert.deepEqual(taskRecord.subject, { kind: "task", id: jobId });

    const resumeRes = await resumePendingWatches({
      stateDir,
      companionBin: mockCompanionScript,
      codexBin: mockCodexScript,
      sync: true,
      env: taskEnv(),
    });
    assert.equal(resumeRes.resumed, 1);
    assert.deepEqual(resumeRes.subjects, [{ kind: "task", id: jobId }]);
    assert.equal(getQueueInvocations().length, 2, "one chain delivery + one resumed task delivery");
  });
});