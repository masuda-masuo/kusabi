// cancel-stop.test.mjs — `cancel` actually stops a job, or says it did not
// (kusabi #209).
//
// The defect these tests exist for is a FALSE CONFIRMATION: `cancel` printed
// `cancelled job-...` for a claude-backend job while the process kept writing
// files into the container for another 17 minutes.  A test that mocks the
// kill would have passed against that bug, so the group-kill tests here drive
// REAL detached process groups (a parent plus a real grandchild) through the
// real code path and assert on /proc, not on messages.
//
// What is exercised with a stand-in and what is not:
//   - the recording path is the real one (claudeDispatch → runClaudeProcess →
//     job.process), driven by a fake `claude` binary via CLAUDE_BIN, exactly
//     as the existing claude-dispatch tests do.  A real `claude` CLI dispatch
//     is not exercised here (it needs credentials and a network).
//   - the kill, the identity check, the liveness polling and the process
//     group semantics are all real.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { cmdCancel, commandOutcome } from "./kusabi-companion.mjs";
import { claudeDispatch, processStartToken, readProcessStat } from "./claude-dispatch.mjs";
import { saveJob, loadJob, latestJob } from "./job-store.mjs";
import { stateDirFor, writeJson } from "./state-paths.mjs";

// ---------------------------------------------------------------------------
// helpers — liveness is judged from /proc directly, NOT through the module
// under test, so a bug in its own liveness check cannot mask a leaked process.
// ---------------------------------------------------------------------------

function alive(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    // A zombie/dead entry still has a /proc directory but runs no code.
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeoutMs = 5000, stepMs = 20, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(stepMs);
  }
}

function sandbox() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-cancel-"));
  const saved = {
    KUSABI_STATE_DIR: process.env.KUSABI_STATE_DIR,
    KUSABI_CANCEL_KILL_WAIT_MS: process.env.KUSABI_CANCEL_KILL_WAIT_MS,
    CLAUDE_BIN: process.env.CLAUDE_BIN,
    KUSABI_CLAUDE_MCP_SOURCE: process.env.KUSABI_CLAUDE_MCP_SOURCE,
    FAKE_CLAUDE_CHILD_PID: process.env.FAKE_CLAUDE_CHILD_PID,
  };
  process.env.KUSABI_STATE_DIR = path.join(tmp, "state");
  const cwd = path.join(tmp, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const stateDir = stateDirFor(cwd);
  return {
    tmp,
    cwd,
    stateDir,
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

let jobSeq = 0;
function runningJob(overrides = {}) {
  jobSeq += 1;
  return {
    id: `job-cancel-test-${jobSeq}`,
    kind: "task",
    title: "cancel test",
    status: "running",
    backend: "claude",
    sessionID: null,
    process: null,
    cwd: "/tmp",
    phase: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    stats: { events: 0, steps: 0, lastTool: null, lastActivity: new Date().toISOString(), models: [] },
    error: null,
    ...overrides,
  };
}

// A real detached process group with a real grandchild: `sh` backgrounds a
// long sleep (which stays in sh's process group) and then sleeps itself.
// Killing only the direct child would leave the grandchild running — that
// leak is the whole reason the stop targets the GROUP, so every test that
// kills for real asserts on both pids.
async function spawnGroupWithGrandchild(tmp) {
  const pidFile = path.join(tmp, `grandchild-${Math.random().toString(36).slice(2)}.pid`);
  const child = spawn("/bin/sh", ["-c", `sleep 300 & echo $! > "${pidFile}"; sleep 300`], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const grandchild = Number(
    await waitFor(
      () => {
        try {
          const text = fs.readFileSync(pidFile, "utf8").trim();
          return text === "" ? null : text;
        } catch {
          return null;
        }
      },
      { what: "the grandchild pid file" },
    ),
  );
  await waitFor(() => alive(grandchild), { what: "the grandchild to be running" });
  return {
    pid: child.pid,
    grandchild,
    startTime: processStartToken(child.pid),
    kill() {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      try { process.kill(grandchild, "SIGKILL"); } catch { /* already gone */ }
    },
  };
}

// A pid that is genuinely finished and reaped, with the identity token that
// was captured while it was still running (what a job record holds after its
// process exits on its own).
async function exitedProcess() {
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const pid = child.pid;
  const startTime = processStartToken(pid);
  process.kill(-pid, "SIGKILL");
  await once(child, "exit");
  await waitFor(() => !alive(pid), { what: "the stand-in process to disappear" });
  return { pid, startTime, recordedAt: new Date().toISOString() };
}

// A stand-in opencode serve: answers the health probe (GET /session) and
// records every request it receives, so a test can prove a request was NOT
// made.
async function fakeServe(stateDir, { abortStatus = 200 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === "GET" && req.url === "/session") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
      return;
    }
    if (req.url.endsWith("/abort")) {
      res.writeHead(abortStatus, { "content-type": "application/json" });
      res.end(abortStatus === 200 ? "{}" : "session abort exploded");
      return;
    }
    res.writeHead(404);
    res.end("");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  writeJson(path.join(stateDir, "server.json"), {
    port: server.address().port,
    password: "test-password",
    pid: process.pid,
  });
  return {
    requests,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// ---------------------------------------------------------------------------
// the real thing: a claude dispatch, cancelled, both processes gone
// ---------------------------------------------------------------------------

// A fake `claude` that behaves like the real one in the way that matters
// here: it spawns a child of its own (the real CLI has its sunaba MCP server
// and tool commands) and never exits on its own.
const FAKE_CLAUDE_SOURCE = `#!/usr/bin/env node
import fs from "node:fs";
import { spawn } from "node:child_process";

const child = spawn("sleep", ["300"], { stdio: "ignore" });
fs.writeFileSync(process.env.FAKE_CLAUDE_CHILD_PID, String(child.pid), "utf8");
setInterval(() => {}, 1000); // never writes, never exits — only a kill stops us
`;

describe("cancel stops a claude-backend dispatch for real (kusabi #209)", () => {
  let sb;

  beforeEach(() => {
    sb = sandbox();
  });

  afterEach(() => {
    sb.restore();
  });

  it("kills the dispatched process AND its child, then reports the stop", async () => {
    const binPath = path.join(sb.tmp, "fake-claude.mjs");
    fs.writeFileSync(binPath, FAKE_CLAUDE_SOURCE, "utf8");
    fs.chmodSync(binPath, 0o755);
    const mcpSource = path.join(sb.tmp, "claude.json");
    fs.writeFileSync(mcpSource, JSON.stringify({ mcpServers: { sunaba: { command: "echo" } } }), "utf8");
    const childPidFile = path.join(sb.tmp, "fake-claude-child.pid");

    process.env.CLAUDE_BIN = binPath;
    process.env.KUSABI_CLAUDE_MCP_SOURCE = mcpSource;
    process.env.FAKE_CLAUDE_CHILD_PID = childPidFile;

    const pending = claudeDispatch({
      cwd: sb.cwd,
      kind: "task",
      title: "a job that must be stoppable",
      promptText: "Do the thing.",
      agent: "kusabi-implement",
      phase: null,
      tools: null,
      timeoutS: 120,
      watchdogS: 900,
      tiers: [["sonnet"]],
      round: 1,
      explicitModel: null,
    });

    // The dispatch persists the pid the moment the child exists — that record
    // is the ONLY thing `cancel` (a different process) can aim at.
    const job = await waitFor(() => latestJob(sb.stateDir, (j) => j.process?.pid), {
      what: "the job record to carry a process id",
    });
    const dispatched = job.process.pid;
    const grandchild = Number(
      await waitFor(
        () => {
          try {
            const text = fs.readFileSync(childPidFile, "utf8").trim();
            return text === "" ? null : text;
          } catch {
            return null;
          }
        },
        { what: "the fake CLI's own child" },
      ),
    );

    // The recorded identity token is the live process's real one.
    assert.equal(job.process.startTime, readProcessStat(dispatched).startTime);
    await waitFor(() => alive(grandchild), { what: "the fake CLI's child to be running" });
    assert.ok(alive(dispatched), "the dispatched process must be running before the cancel");

    const output = await cmdCancel(sb.cwd, { text: job.id });
    const { text, exitCode } = commandOutcome(output);

    assert.equal(exitCode, 0, text);
    assert.match(text, new RegExp(`^cancelled ${job.id}`));
    assert.match(text, /Stopped process group/);
    assert.match(text, new RegExp(`process group ${dispatched}`));

    // The point of the whole change: both are gone by the time cancel says so.
    assert.equal(alive(dispatched), false, "the dispatched process must be gone");
    assert.equal(alive(grandchild), false, "the CLI's child must die with the group, not leak");

    await pending; // the dispatch itself settles once its child is gone
  });
});

// ---------------------------------------------------------------------------
// identity gate — a recorded pid is not a kill licence
// ---------------------------------------------------------------------------

describe("cancel refuses to signal a pid whose identity no longer matches", () => {
  let sb;
  let victim;

  beforeEach(() => {
    sb = sandbox();
  });

  afterEach(() => {
    victim?.kill();
    victim = null;
    sb.restore();
  });

  it("leaves the live process untouched and reports the job's process as gone", async () => {
    victim = await spawnGroupWithGrandchild(sb.tmp);
    // Same pid, different process: exactly what a recycled pid looks like.
    const job = runningJob({
      process: { pid: victim.pid, startTime: String(Number(victim.startTime) + 1), recordedAt: new Date().toISOString() },
    });
    saveJob(sb.stateDir, job);

    const output = await cmdCancel(sb.cwd, { text: job.id });
    const { text, exitCode } = commandOutcome(output);

    // The refusal itself — asserted on the processes, so this test fails if
    // the code signals anyway, message or no message.
    await sleep(150);
    assert.ok(alive(victim.pid), "a pid whose identity does not match must never be signalled");
    assert.ok(alive(victim.grandchild), "its children must not be signalled either");

    assert.equal(exitCode, 0, text);
    assert.match(text, /Not signalled/);
    assert.match(text, new RegExp(`pid ${victim.pid} now belongs to a different process`));
    assert.equal(loadJob(sb.stateDir, job.id).status, "cancelled");
  });
});

// ---------------------------------------------------------------------------
// the honest outcomes: already gone, could not stop, never abort a null session
// ---------------------------------------------------------------------------

describe("cmdCancel outcomes", () => {
  let sb;
  let victim;
  let serve;

  beforeEach(() => {
    sb = sandbox();
  });

  afterEach(async () => {
    victim?.kill();
    victim = null;
    await serve?.close();
    serve = null;
    sb.restore();
  });

  it("finalises a job whose process already exited (no #175/#176 regression)", async () => {
    const job = runningJob({ process: await exitedProcess() });
    saveJob(sb.stateDir, job);

    const { text, exitCode } = commandOutcome(await cmdCancel(sb.cwd, { text: job.id }));

    assert.equal(exitCode, 0);
    assert.match(text, new RegExp(`^cancelled ${job.id}`));
    assert.match(text, /no longer running/);
    assert.equal(loadJob(sb.stateDir, job.id).status, "cancelled");
  });

  it("finalises a fossil `running` record that names no process at all", async () => {
    const old = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
    const job = runningJob({ startedAt: old, stats: { lastActivity: old } });
    saveJob(sb.stateDir, job);

    const { text, exitCode } = commandOutcome(await cmdCancel(sb.cwd, { text: job.id }));

    assert.equal(exitCode, 0);
    assert.match(text, /^cancelled /);
    assert.equal(loadJob(sb.stateDir, job.id).status, "cancelled");
  });

  it("refuses to claim a cancel for a fresh record that names no process", async () => {
    const job = runningJob();
    saveJob(sb.stateDir, job);

    const { text, exitCode } = commandOutcome(await cmdCancel(sb.cwd, { text: job.id }));

    assert.equal(exitCode, 1);
    assert.doesNotMatch(text, /cancelled/);
    assert.match(text, /names no process id/);
    assert.equal(loadJob(sb.stateDir, job.id).status, "running");
  });

  it("never issues /session/null/abort for a claude-backend job", async () => {
    serve = await fakeServe(sb.stateDir);
    const job = runningJob({ backend: "claude", sessionID: null, process: await exitedProcess() });
    saveJob(sb.stateDir, job);

    const { exitCode } = commandOutcome(await cmdCancel(sb.cwd, { text: job.id }));

    assert.equal(exitCode, 0);
    assert.deepEqual(
      serve.requests.filter((r) => r.includes("abort")),
      [],
      "the claude backend has no opencode session to abort",
    );
    assert.deepEqual(serve.requests, [], "a claude-backend cancel must not talk to the serve at all");
  });

  it("surfaces a failed opencode abort instead of swallowing it", async () => {
    serve = await fakeServe(sb.stateDir, { abortStatus: 500 });
    const job = runningJob({ backend: "opencode", sessionID: "ses_abc123", process: null });
    saveJob(sb.stateDir, job);

    const { text, exitCode } = commandOutcome(await cmdCancel(sb.cwd, { text: job.id }));

    assert.equal(exitCode, 1);
    assert.doesNotMatch(text, /cancelled/);
    assert.match(text, /abort request for session ses_abc123 failed/);
    assert.match(text, /HTTP 500/);
    assert.equal(loadJob(sb.stateDir, job.id).status, "running", "a failed abort must not finalise the record");
    assert.ok(serve.requests.includes("POST /session/ses_abc123/abort"));
  });

  it("cancels an opencode job whose session aborts cleanly", async () => {
    serve = await fakeServe(sb.stateDir);
    const job = runningJob({ backend: "opencode", sessionID: "ses_ok", process: null });
    saveJob(sb.stateDir, job);

    const { text, exitCode } = commandOutcome(await cmdCancel(sb.cwd, { text: job.id }));

    assert.equal(exitCode, 0);
    assert.match(text, /^cancelled .* \(session ses_ok\)\./);
    assert.equal(loadJob(sb.stateDir, job.id).status, "cancelled");
  });

  it("names the pid and exits nonzero when the process survives the kill", async () => {
    victim = await spawnGroupWithGrandchild(sb.tmp);
    const job = runningJob({
      process: { pid: victim.pid, startTime: victim.startTime, recordedAt: new Date().toISOString() },
    });
    saveJob(sb.stateDir, job);

    // The could-not-stop path needs a signal that does not land.  An
    // unkillable process cannot be created on demand, so the SIGNAL is
    // neutered here — everything else (the live process, the identity check,
    // the /proc liveness polling) stays real, and the assertion is that the
    // still-running process is reported as still running.
    const realKill = process.kill.bind(process);
    process.env.KUSABI_CANCEL_KILL_WAIT_MS = "300";
    process.kill = (pid, signal) => (signal === "SIGKILL" ? true : realKill(pid, signal));
    let output;
    try {
      output = await cmdCancel(sb.cwd, { text: job.id });
    } finally {
      process.kill = realKill;
    }
    const { text, exitCode } = commandOutcome(output);

    assert.equal(exitCode, 1);
    assert.doesNotMatch(text, /cancelled/);
    assert.match(text, new RegExp(`pid ${victim.pid} is STILL RUNNING`));
    assert.match(text, new RegExp(`still has live members after SIGKILL`));
    assert.ok(alive(victim.pid), "the process really did survive — that is what is being reported");
    assert.equal(loadJob(sb.stateDir, job.id).status, "running", "an unstopped job must stay `running`");
  });

  it("declines a job that is not running, and an unknown job id", async () => {
    const done = runningJob({ status: "completed" });
    saveJob(sb.stateDir, done);

    assert.match(commandOutcome(await cmdCancel(sb.cwd, { text: done.id })).text, /is not running/);
    assert.match(commandOutcome(await cmdCancel(sb.cwd, { text: "job-nope" })).text, /no such job/);
  });
});

// ---------------------------------------------------------------------------
// the exit code plumbing itself
// ---------------------------------------------------------------------------

describe("commandOutcome", () => {
  it("passes a plain string through as a success", () => {
    assert.deepEqual(commandOutcome("done"), { text: "done", exitCode: 0 });
  });

  it("carries a subcommand's own exit code to the shell", () => {
    assert.deepEqual(commandOutcome({ text: "could not stop", exitCode: 1 }), { text: "could not stop", exitCode: 1 });
  });

  it("treats a missing or empty return as a silent success", () => {
    assert.deepEqual(commandOutcome(undefined), { text: "", exitCode: 0 });
    assert.deepEqual(commandOutcome(null), { text: "", exitCode: 0 });
  });
});
