// process-identity.test.mjs — tests for process identity token recording and verification (kusabi #601).
//
// Pins Acceptance Criteria 1–3:
//   1. A job record written by the agy dispatch path carries a non-null
//      process.startTime equal to processStartToken(pid);
//      stopRecordedProcess on such a record for a live fake process does not
//      return unverifiable, and the process is stopped.
//   2. codex still records a token (same shape), now from the runner.
//   3. A record whose token does not match the live pid is still refused as
//      identity-mismatch.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { runBackendProcess } from "./backend-process-runner.mjs";
import { agyDispatch } from "./agy-dispatch.mjs";
import { codexDispatch } from "./codex-dispatch.mjs";
import { processStartToken, stopRecordedProcess, readProcessStat } from "./process-identity.mjs";
import { listJobs } from "./job-store.mjs";
import { stateDirFor } from "./state-paths.mjs";
import { patchEnv } from "./fixtures.mjs";

async function waitForRunningJob(stateDir, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = listJobs(stateDir).find((j) => j.status === "running" && j.process?.pid);
    if (job) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for running job with process.pid");
}

function createFakeAgyEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fake-agy-identity-"));
  const binPath = path.join(tmp, "fake-agy");
  const stateRoot = path.join(tmp, "state");
  const cwd = path.join(tmp, "cwd");
  fs.mkdirSync(cwd, { recursive: true });

  const script = `#!/usr/bin/env node
import fs from "node:fs";
const NL = String.fromCharCode(10);
fs.writeSync(1, JSON.stringify({
  event: "init",
  conversation_id: "conv-agy-identity-test",
  init: { model: "gemini-3.6-flash-high", cwd: process.cwd() }
}) + NL);
setTimeout(() => { process.exit(0); }, 30000);
`;
  fs.writeFileSync(binPath, script, { encoding: "utf8", mode: 0o755 });

  const restoreEnv = patchEnv({
    AGY_BIN: binPath,
    KUSABI_STATE_DIR: stateRoot,
  });

  const stateDir = stateDirFor(cwd);

  return {
    tmp,
    cwd,
    stateDir,
    options: {
      cwd,
      kind: "task",
      title: "agy identity test",
      promptText: "Do the thing.",
      agent: null,
      phase: null,
      tools: null,
      timeoutS: null,
      watchdogS: null,
      tiers: [["gemini-3.6-flash-high"]],
      round: 1,
      explicitModel: null,
    },
    cleanup() {
      restoreEnv();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function createFakeCodexEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fake-codex-identity-"));
  const binPath = path.join(tmp, "fake-codex");
  const stateRoot = path.join(tmp, "state");
  const cwd = path.join(tmp, "cwd");
  const fakeHome = path.join(tmp, "home");
  const operatorCodexHome = path.join(tmp, "operator-codex-home");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(operatorCodexHome, { recursive: true });

  const workerConfigDir = path.join(stateRoot, "opencode-config", "opencode");
  fs.mkdirSync(workerConfigDir, { recursive: true });
  fs.writeFileSync(
    path.join(workerConfigDir, "opencode.jsonc"),
    JSON.stringify({
      mcp: {
        sunaba: { type: "remote", url: "http://127.0.0.1:8750/mcp" },
        kaiba: { type: "local", command: ["/usr/bin/kaiba"], environment: { KAIBA_AGENT: "worker" } },
      },
    }),
    "utf8",
  );

  const thread = "thread-codex-identity-test";
  const model = "gpt-5.6-sol";
  const script = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const NL = String.fromCharCode(10);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

const dir = path.join(process.env.CODEX_HOME || "/tmp", "sessions", "${thread}");
fs.mkdirSync(dir, { recursive: true });
const recs = [
  { timestamp: new Date().toISOString(), type: "session_meta", payload: { id: "${thread}", cwd: process.cwd(), model: "${model}", model_reasoning_effort: "high", approval_policy: "never", sandbox_policy: "read-only", network_policy: "restricted" } },
  { timestamp: new Date().toISOString(), type: "turn_context", payload: { turn_id: "turn-1", model: "${model}" } },
];
fs.writeFileSync(path.join(dir, "rollout-1.jsonl"), recs.map(r => JSON.stringify(r)).join(NL) + NL);

fs.writeSync(1, JSON.stringify({ type: "thread.started", thread_id: "${thread}" }) + NL);
setTimeout(() => { process.exit(0); }, 30000);
`;
  fs.writeFileSync(binPath, script, { encoding: "utf8", mode: 0o755 });

  const restoreEnv = patchEnv({
    CODEX_BIN: binPath,
    KUSABI_STATE_DIR: stateRoot,
    HOME: fakeHome,
    CODEX_HOME: operatorCodexHome,
  });

  const stateDir = stateDirFor(cwd);

  return {
    tmp,
    cwd,
    stateDir,
    options: {
      cwd,
      kind: "task",
      title: "codex identity test",
      promptText: "Say the token.",
      agent: null,
      phase: null,
      tools: null,
      timeoutS: null,
      watchdogS: null,
      tiers: [["gpt-5.6-luna", "gpt-5.6-sol"]],
      round: 1,
      explicitModel: model,
    },
    cleanup() {
      restoreEnv();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

describe("process identity token reader", () => {
  it("processStartToken returns non-null string for current process", () => {
    const token = processStartToken(process.pid);
    assert.ok(typeof token === "string");
    assert.ok(token.length > 0);
    assert.equal(token, readProcessStat(process.pid).startTime);
  });

  it("processStartToken returns null for dead or nonexistent pid", () => {
    assert.equal(processStartToken(-1), null);
    assert.equal(processStartToken(99999999), null);
  });
});

describe("runBackendProcess identity token delivery", () => {
  it("computes identity token at spawn and passes { pid, startTime } to onStart", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runner-identity-"));
    const binPath = path.join(tmp, "sleep-cli");
    fs.writeFileSync(binPath, "#!/usr/bin/env node\nsetTimeout(() => {}, 30000);\n", { mode: 0o755 });

    let captured = null;
    const pending = runBackendProcess({
      bin: binPath,
      args: [],
      cwd: tmp,
      onStart: (info) => { captured = info; },
      parseLine: () => null,
    });

    try {
      assert.ok(captured, "onStart must be called");
      assert.ok(typeof captured.pid === "number" && captured.pid > 0);
      assert.ok(typeof captured.startTime === "string" && captured.startTime.length > 0);
      assert.equal(captured.startTime, processStartToken(captured.pid));

      const stop = await stopRecordedProcess(captured);
      assert.equal(stop.outcome, "stopped");
      assert.equal(stop.signalled, true);
    } finally {
      if (captured?.pid) {
        try { process.kill(-captured.pid, "SIGKILL"); } catch { /* ignore */ }
      }
      await pending;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("dispatch backend process identity (kusabi #601)", () => {
  it("criterion 1: agy dispatch records non-null process.startTime equal to processStartToken(pid) and stopRecordedProcess stops it", async () => {
    const env = createFakeAgyEnv();
    try {
      const pending = agyDispatch(env.options);
      const running = await waitForRunningJob(env.stateDir);

      assert.ok(typeof running.process.pid === "number" && running.process.pid > 0);
      assert.ok(typeof running.process.startTime === "string" && running.process.startTime.length > 0);
      assert.equal(running.process.startTime, processStartToken(running.process.pid));
      assert.equal(running.process.startTime, readProcessStat(running.process.pid).startTime);

      const stop = await stopRecordedProcess(running.process);
      assert.notEqual(stop.outcome, "unverifiable");
      assert.equal(stop.outcome, "stopped");
      assert.equal(stop.signalled, true);

      await pending;
    } finally {
      env.cleanup();
    }
  });

  it("criterion 2: codex dispatch records token from the runner and stopRecordedProcess stops it", async () => {
    const env = createFakeCodexEnv();
    try {
      const pending = codexDispatch(env.options);
      const running = await waitForRunningJob(env.stateDir);

      assert.ok(typeof running.process.pid === "number" && running.process.pid > 0);
      assert.ok(typeof running.process.startTime === "string" && running.process.startTime.length > 0);
      assert.equal(running.process.startTime, processStartToken(running.process.pid));
      assert.equal(running.process.startTime, readProcessStat(running.process.pid).startTime);

      const stop = await stopRecordedProcess(running.process);
      assert.equal(stop.outcome, "stopped");
      assert.equal(stop.signalled, true);

      await pending;
    } finally {
      env.cleanup();
    }
  });

  it("criterion 3: a record whose token does not match the live pid is refused as identity-mismatch", async () => {
    const env = createFakeAgyEnv();
    try {
      const pending = agyDispatch(env.options);
      const running = await waitForRunningJob(env.stateDir);

      const livePid = running.process.pid;
      const realToken = running.process.startTime;
      assert.ok(typeof realToken === "string");

      // Mismatched token: refused as identity-mismatch, live process is not signalled
      const mismatchRecord = { pid: livePid, startTime: "999999999" };
      const stopMismatch = await stopRecordedProcess(mismatchRecord);
      assert.equal(stopMismatch.outcome, "identity-mismatch");
      assert.equal(stopMismatch.signalled, false);

      // Null token: refused as unverifiable, live process is not signalled
      const nullRecord = { pid: livePid, startTime: null };
      const stopNull = await stopRecordedProcess(nullRecord);
      assert.equal(stopNull.outcome, "unverifiable");
      assert.equal(stopNull.signalled, false);

      // Valid token stops the process
      const stopReal = await stopRecordedProcess(running.process);
      assert.equal(stopReal.outcome, "stopped");
      assert.equal(stopReal.signalled, true);

      await pending;
    } finally {
      env.cleanup();
    }
  });

  it("stopRecordedProcess timeout deadline is unaffected when wall clock jumps backward (kusabi #723)", async (t) => {
    const env = createFakeAgyEnv();
    try {
      const pending = agyDispatch(env.options);
      const running = await waitForRunningJob(env.stateDir);

      const realKill = process.kill;

      t.mock.method(process, "kill", (targetPid, sig) => {
        if (sig === "SIGKILL") return true;
        return realKill.call(process, targetPid, sig);
      });

      let wall = 2_000_000_000;
      t.mock.method(Date, "now", () => {
        wall -= 100_000;
        return wall;
      });

      const stop = await stopRecordedProcess(running.process, { waitMs: 40, pollMs: 10 });
      assert.equal(stop.outcome, "alive");
      assert.equal(stop.signalled, true);

      try { realKill.call(process, -running.process.pid, "SIGKILL"); } catch { /* ignore */ }
      await pending;
    } finally {
      env.cleanup();
    }
  });
});
