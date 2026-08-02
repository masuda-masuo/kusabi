import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import process from "node:process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  shouldReapServer,
  buildServeEnv,
  ensureServer,
  serverReadyTimeoutMs,
  runningRecordIsStale,
  RUNNING_STALE_MS,
  reapOrphanedServes,
} from "./serve-lifecycle.mjs";
import { readJson, stateDirFor } from "./state-paths.mjs";

// buildServeEnv — env-building seam for ensureServer's spawn (kusabi #136 fix 3)
// ---------------------------------------------------------------------------
// Unit-tested at this seam rather than through ensureServer itself, per the
// brief: asserting the marker without spawning a real opencode serve.

describe("buildServeEnv", () => {
  it("stamps KUSABI_WORKER_CONTEXT=1 into the returned env", () => {
    const env = buildServeEnv({ PATH: "/usr/bin" }, "secret-pw");
    assert.equal(env.KUSABI_WORKER_CONTEXT, "1");
  });

  it("also sets OPENCODE_SERVER_PASSWORD from the given password", () => {
    const env = buildServeEnv({}, "secret-pw");
    assert.equal(env.OPENCODE_SERVER_PASSWORD, "secret-pw");
  });

  it("preserves the rest of the base env untouched", () => {
    const env = buildServeEnv({ PATH: "/usr/bin", HOME: "/home/x" }, "pw");
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.HOME, "/home/x");
  });

  it("does not mutate the base env object passed in", () => {
    const base = { PATH: "/usr/bin" };
    buildServeEnv(base, "pw");
    assert.equal(base.KUSABI_WORKER_CONTEXT, undefined);
    assert.equal(base.OPENCODE_SERVER_PASSWORD, undefined);
  });

  it("stamps KUSABI_SERVE_STATE_DIR when a state dir is given", () => {
    const env = buildServeEnv({}, "pw", "/tmp/state/abc");
    assert.equal(env.KUSABI_SERVE_STATE_DIR, "/tmp/state/abc");
  });

  it("leaves KUSABI_SERVE_STATE_DIR unstamped when no state dir is given", () => {
    const env = buildServeEnv({}, "pw");
    assert.equal(env.KUSABI_SERVE_STATE_DIR, undefined);
  });
});

// runningRecordIsStale — fossil judgement for `running` job records
// ---------------------------------------------------------------------------
// A `running` record whose last activity is older than RUNNING_STALE_MS is a
// fossil: the driver died without rewriting it, so it must not count as proof
// that work is in flight (kusabi #162 follow-up).  Activity is
// stats.lastActivity, falling back to startedAt; records with no usable
// timestamp cannot be proven stale and still count as running.

describe("runningRecordIsStale", () => {
  const HOUR = 3600 * 1000;

  it("false for a non-running record", () => {
    const job = { status: "completed", startedAt: new Date(Date.now() - 30 * 24 * HOUR).toISOString() };
    assert.equal(runningRecordIsStale(job), false);
  });

  it("false for a running record with recent lastActivity (1 hour ago)", () => {
    const job = { status: "running", stats: { lastActivity: new Date(Date.now() - HOUR).toISOString() } };
    assert.equal(runningRecordIsStale(job), false);
  });

  it("true for a running record whose lastActivity is a fossil (7 days ago)", () => {
    const job = { status: "running", stats: { lastActivity: new Date(Date.now() - 7 * 24 * HOUR).toISOString() } };
    assert.equal(runningRecordIsStale(job), true);
  });

  it("falls back to startedAt when stats.lastActivity is absent", () => {
    const job = { status: "running", startedAt: new Date(Date.now() - 7 * 24 * HOUR).toISOString() };
    assert.equal(runningRecordIsStale(job), true);
  });

  it("boundary: just under 6 hours is still running, just over is stale", () => {
    const now = Date.now();
    const justUnder = { status: "running", startedAt: new Date(now - RUNNING_STALE_MS + 1000).toISOString() };
    const justOver = { status: "running", startedAt: new Date(now - RUNNING_STALE_MS - 1000).toISOString() };
    assert.equal(runningRecordIsStale(justUnder, now), false);
    assert.equal(runningRecordIsStale(justOver, now), true);
  });

  it("false when the record has no usable activity timestamp", () => {
    assert.equal(runningRecordIsStale({ status: "running" }), false);
    assert.equal(runningRecordIsStale({ status: "running", stats: {} }), false);
  });

  it("false when lastActivity is present but unparseable (precedence, no fallback)", () => {
    // lastActivity is the timestamp to judge by; garbage there cannot prove
    // staleness, and startedAt is not consulted (conservative: keep running).
    const job = {
      status: "running",
      stats: { lastActivity: "not-a-date" },
      startedAt: new Date(Date.now() - 7 * 24 * HOUR).toISOString(),
    };
    assert.equal(runningRecordIsStale(job), false);
  });
});

// shouldReapServer — pure function: reap decision logic
// ---------------------------------------------------------------------------

describe("shouldReapServer", () => {
  const TTL = 30 * 60 * 1000; // 30 minutes

  it("reap: no running jobs, last activity older than TTL", () => {
    const now = Date.now();
    const serverMtime = now - TTL - 1000; // 1s past TTL
    const jobRecords = [
      { status: "completed", mtime: now - TTL - 2000 },
      { status: "error", mtime: now - TTL - 5000 },
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, true);
    assert.match(result.reason, /idle.*exceeds TTL/);
  });

  it("keep: running job exists — never reap regardless of age", () => {
    const now = Date.now();
    const serverMtime = now - TTL * 10; // way past TTL
    const jobRecords = [
      { status: "completed", mtime: now - TTL * 10 },
      { status: "running", mtime: now - 1000 }, // still running
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, false);
    assert.equal(result.reason, "a running job exists");
  });

  it("keep: no running jobs but last activity is still within TTL", () => {
    const now = Date.now();
    const serverMtime = now - TTL + 1000; // 1s before TTL expiry
    const jobRecords = [
      { status: "completed", mtime: now - 1000 },
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, false);
    assert.match(result.reason, /not yet stale/);
  });

  it("keep: job mtime is more recent than server mtime and within TTL", () => {
    const now = Date.now();
    const serverMtime = now - TTL - 5000; // past TTL
    const jobRecords = [
      { status: "completed", mtime: now - 1000 }, // recent job → last activity is recent
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, false);
    assert.match(result.reason, /not yet stale/);
  });

  it("reap: empty job records, server mtime alone is past TTL", () => {
    const now = Date.now();
    const serverMtime = now - TTL - 1;
    const jobRecords = [];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, true);
    assert.match(result.reason, /idle.*exceeds TTL/);
  });

  it("keep: empty job records, server mtime alone is within TTL", () => {
    const now = Date.now();
    const serverMtime = now;
    const jobRecords = [];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, false);
    assert.match(result.reason, /not yet stale/);
  });

  it("reap: serverMtime is 0 (missing) but job mtime is past TTL", () => {
    const now = Date.now();
    const serverMtime = 0;
    const jobRecords = [
      { status: "completed", mtime: now - TTL - 1000 },
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, true);
  });

  it("keep: serverMtime is 0 but job mtime is within TTL", () => {
    const now = Date.now();
    const serverMtime = 0;
    const jobRecords = [
      { status: "completed", mtime: now },
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, false);
  });

  it("reap: all mtimes are 0 (missing timestamps) — epoch-based, very old", () => {
    const now = Date.now();
    const serverMtime = 0;
    const jobRecords = [
      { status: "completed", mtime: 0 },
      { status: "error", mtime: 0 },
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    // lastActivity is 0 (epoch), idle is now-epoch = very large → reap
    assert.equal(result.reap, true);
  });

  it("keep: multiple running jobs, even very old, never reap", () => {
    const now = Date.now();
    const serverMtime = 0;
    const jobRecords = [
      { status: "running", mtime: 0 },
      { status: "running", mtime: 0 },
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, false);
  });

  it("keep: mixed running and completed jobs — running exists so never reap", () => {
    const now = Date.now();
    const serverMtime = now - TTL * 2;
    const jobRecords = [
      { status: "completed", mtime: now - TTL * 2 },
      { status: "running", mtime: now },
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, false);
    assert.equal(result.reason, "a running job exists");
  });

  it("reap: job with status 'stalled' is not 'running', so idle serve is reaped", () => {
    const now = Date.now();
    const serverMtime = now - TTL - 5000;
    const jobRecords = [
      { status: "stalled", mtime: now - TTL - 4000 },
      { status: "timeout", mtime: now - TTL - 3000 },
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, true);
  });

  // kusabi #162 follow-up: a `running` record whose last activity is older
  // than 6 hours is a fossil and must not pin the serve.
  it("reap: a fossil running record (activity 7 days ago) no longer pins the serve", () => {
    const now = Date.now();
    const serverMtime = now - TTL - 5000;
    const jobRecords = [
      {
        status: "running",
        mtime: now - TTL - 4000,
        stats: { lastActivity: new Date(now - 7 * 24 * 3600 * 1000).toISOString() },
      },
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, true);
  });

  it("keep: a recent running record still pins the serve even when server mtime is past TTL", () => {
    const now = Date.now();
    const serverMtime = now - TTL - 5000;
    const jobRecords = [
      {
        status: "running",
        mtime: now - TTL - 4000,
        stats: { lastActivity: new Date(now - 3600 * 1000).toISOString() },
      },
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, false);
    assert.equal(result.reason, "a running job exists");
  });

  it("keep: a running record without any activity timestamp still pins the serve", () => {
    const now = Date.now();
    const serverMtime = now - TTL - 5000;
    const jobRecords = [
      { status: "running", mtime: now - TTL - 4000, stats: {}, startedAt: undefined },
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, false);
    assert.equal(result.reason, "a running job exists");
  });
});

// judgeServeDeath — liveness decision for serve process
// ---------------------------------------------------------------------------

import { judgeServeDeath } from "./serve-lifecycle.mjs";

describe("judgeServeDeath", () => {
  it("null pid is not dead (no pid to check)", () => {
    const result = judgeServeDeath(null);
    assert.equal(result.dead, false);
    assert.equal(result.reason, null);
  });

  it("undefined pid is not dead", () => {
    const result = judgeServeDeath(undefined);
    assert.equal(result.dead, false);
    assert.equal(result.reason, null);
  });

  it("our own process is alive → not dead", () => {
    const result = judgeServeDeath(process.pid);
    assert.equal(result.dead, false);
    assert.equal(result.reason, null);
  });

  it("non-existent pid is dead", () => {
    // 2**31-1 is the maximum pid_t value on Linux — any number in this
    // range that is > pid_max is guaranteed to throw ESRCH.
    const result = judgeServeDeath(2_147_483_647);
    assert.equal(result.dead, true);
    assert.ok(result.reason.includes("2147483647"));
    assert.ok(result.reason.includes("not found"));
  });

  it("a real child process flips from alive to dead when it exits", async () => {
    // The constant-pid tests above never exercise the transition this function
    // exists to observe.  Spawn a real process, confirm it reads as alive,
    // kill it, and confirm the same pid then reads as dead.  No opencode and
    // no container involved.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      stdio: "ignore",
    });
    try {
      const exited = new Promise((resolve) => child.once("exit", resolve));

      const whileAlive = judgeServeDeath(child.pid);
      assert.equal(whileAlive.dead, false, "a running child must not read as dead");

      child.kill("SIGKILL");
      await exited;

      const afterExit = judgeServeDeath(child.pid);
      assert.equal(afterExit.dead, true, "an exited child must read as dead");
      assert.ok(afterExit.reason.includes(String(child.pid)));
      assert.ok(afterExit.reason.includes("ESRCH"));
    } finally {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("EPERM is treated as alive — only ESRCH means dead", () => {
    // EPERM (process exists, we may not signal it) cannot be forced portably
    // in-process, so drive the branch directly with a stubbed thrower rather
    // than asserting it by reading the source.
    const realKill = process.kill;
    process.kill = () => {
      const err = new Error("operation not permitted");
      err.code = "EPERM";
      throw err;
    };
    try {
      const result = judgeServeDeath(4242);
      assert.equal(result.dead, false, "EPERM means the process exists");
      assert.equal(result.reason, null);
    } finally {
      process.kill = realKill;
    }
  });
});

// ensureServer — spawn-based tests against a fake `opencode serve` (kusabi #162)
// ---------------------------------------------------------------------------
// ensureServer resolves the binary through OPENCODE_BIN, so these tests point
// it at a fake serve script written into a temp dir: the "ready" fake starts
// an HTTP server on the --port it is given and answers any request with 200;
// the "never" fake stays alive without listening (drives the timeout path).
// KUSABI_STATE_DIR points at a temp dir so nothing touches the real state
// root.  Every process these tests spawn is killed by the test itself, and
// liveness is asserted by pid (process.kill(pid, 0)), never by reading a
// log line.

const FAKE_SERVE_SOURCE = `#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";

const argv = process.argv.slice(2);
const portIdx = argv.indexOf("--port");
const port = Number(argv[portIdx + 1]);
if (!port || Number.isNaN(port)) {
  process.stderr.write("fake serve: no --port argument\\n");
  process.exit(2);
}
fs.appendFileSync(process.env.FAKE_SPAWN_PIDS, process.pid + "\\n");
if (process.env.FAKE_MODE !== "never") {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  server.listen(port, "127.0.0.1");
}
setInterval(() => {}, 1000);
`;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDeath(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
}

function spawnedPids(spawnLog) {
  const text = fs.readFileSync(spawnLog, "utf8");
  return text.trim() ? text.trim().split("\n").map(Number) : [];
}

function fakeServeContext(mode) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-serve-test-"));
  const binPath = path.join(tmp, "fake-serve.mjs");
  const spawnLog = path.join(tmp, "spawned.pids");
  fs.writeFileSync(binPath, FAKE_SERVE_SOURCE, "utf8");
  fs.chmodSync(binPath, 0o755);
  fs.writeFileSync(spawnLog, "", "utf8");
  const stateRoot = path.join(tmp, "state");
  const cwd = path.join(tmp, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const saved = {
    OPENCODE_BIN: process.env.OPENCODE_BIN,
    KUSABI_STATE_DIR: process.env.KUSABI_STATE_DIR,
    KUSABI_SERVE_READY_TIMEOUT_MS: process.env.KUSABI_SERVE_READY_TIMEOUT_MS,
    FAKE_MODE: process.env.FAKE_MODE,
    FAKE_SPAWN_PIDS: process.env.FAKE_SPAWN_PIDS,
  };
  // Set the env first: stateDirFor hashes cwd under KUSABI_STATE_DIR, so it
  // must see the temp root or the returned paths point at the real state dir.
  process.env.OPENCODE_BIN = binPath;
  process.env.KUSABI_STATE_DIR = stateRoot;
  process.env.FAKE_MODE = mode;
  process.env.FAKE_SPAWN_PIDS = spawnLog;
  const stateDir = stateDirFor(cwd); // hashes cwd under KUSABI_STATE_DIR
  return {
    tmp,
    cwd,
    stateDir,
    serverFile: path.join(stateDir, "server.json"),
    lockFile: path.join(stateDir, "serve.lock"),
    spawnLog,
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
    killAll() {
      for (const pid of spawnedPids(spawnLog)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
    },
    rm() {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

describe("ensureServer (fake serve, spawn-based)", () => {
  it("honours KUSABI_SERVE_READY_TIMEOUT_MS with the 20s constant as default", () => {
    const prev = process.env.KUSABI_SERVE_READY_TIMEOUT_MS;
    try {
      delete process.env.KUSABI_SERVE_READY_TIMEOUT_MS;
      assert.equal(serverReadyTimeoutMs(), 20_000);
      process.env.KUSABI_SERVE_READY_TIMEOUT_MS = "800";
      assert.equal(serverReadyTimeoutMs(), 800);
    } finally {
      if (prev === undefined) delete process.env.KUSABI_SERVE_READY_TIMEOUT_MS;
      else process.env.KUSABI_SERVE_READY_TIMEOUT_MS = prev;
    }
  });

  it("concurrent ensureServer calls leave exactly one live serve, the one recorded in server.json", async () => {
    const ctx = fakeServeContext("ready");
    process.env.KUSABI_SERVE_READY_TIMEOUT_MS = "5000";
    try {
      const results = await Promise.allSettled([
        ensureServer(ctx.cwd),
        ensureServer(ctx.cwd),
        ensureServer(ctx.cwd),
      ]);
      for (const r of results) {
        assert.equal(r.status, "fulfilled", r.reason ? String(r.reason) : "call rejected");
      }
      const servers = results.map((r) => r.value);
      assert.equal(new Set(servers.map((s) => s.port)).size, 1, "all callers must share one port");
      assert.equal(new Set(servers.map((s) => s.pid)).size, 1, "all callers must share one pid");
      assert.equal(new Set(servers.map((s) => s.stateDir)).size, 1);

      const recorded = readJson(ctx.serverFile);
      assert.ok(recorded, "server.json must be written by the winner");
      assert.equal(recorded.pid, servers[0].pid, "server.json must record the shared pid");
      assert.equal(recorded.port, servers[0].port, "server.json must record the shared port");

      const spawned = spawnedPids(ctx.spawnLog);
      assert.equal(spawned.length, 1, "exactly one serve process may be spawned");
      const alive = spawned.filter(isAlive);
      assert.deepEqual(alive, [recorded.pid], "the only live serve must be the recorded one");
    } finally {
      ctx.killAll();
      ctx.restore();
      ctx.rm();
    }
  });

  it("rejects when the serve never becomes ready and kills the spawned process", async () => {
    const ctx = fakeServeContext("never");
    process.env.KUSABI_SERVE_READY_TIMEOUT_MS = "800";
    try {
      await assert.rejects(ensureServer(ctx.cwd), /did not become ready/);
      const spawned = spawnedPids(ctx.spawnLog);
      assert.equal(spawned.length, 1, "exactly one serve process may be spawned");
      await waitForDeath(spawned[0]);
      assert.ok(!isAlive(spawned[0]), "the spawned serve must be dead after the rejection");
      assert.equal(readJson(ctx.serverFile), null, "no record may be written for an unready serve");
      assert.ok(!fs.existsSync(ctx.lockFile), "the start-up lock must be released after failure");
    } finally {
      ctx.killAll();
      ctx.restore();
      ctx.rm();
    }
  });

  it("reuses a healthy recorded serve without spawning anything new", async () => {
    const ctx = fakeServeContext("ready");
    process.env.KUSABI_SERVE_READY_TIMEOUT_MS = "5000";
    try {
      const first = await ensureServer(ctx.cwd);
      const second = await ensureServer(ctx.cwd);
      assert.equal(second.pid, first.pid);
      assert.equal(second.port, first.port);
      assert.equal(second.stateDir, first.stateDir);

      const recorded = readJson(ctx.serverFile);
      assert.equal(recorded.pid, first.pid, "server.json must still name the same serve");
      assert.equal(recorded.port, first.port);

      const spawned = spawnedPids(ctx.spawnLog);
      assert.equal(spawned.length, 1, "a healthy recorded serve must not trigger a new spawn");
      assert.ok(isAlive(first.pid), "the recorded serve must still be alive");
    } finally {
      ctx.killAll();
      ctx.restore();
      ctx.rm();
    }
  });

  it("stamps KUSABI_SERVE_STATE_DIR into the spawned serve's own env", async () => {
    // The orphan sweep (kusabi #162 follow-up) attributes a live process back
    // to the state dir that should name it via this marker — it must be the
    // real spawned process's env, not just the buildServeEnv() return value.
    const ctx = fakeServeContext("ready");
    process.env.KUSABI_SERVE_READY_TIMEOUT_MS = "5000";
    try {
      const server = await ensureServer(ctx.cwd);
      const deadline = Date.now() + 5000;
      let envText = "";
      while (Date.now() < deadline) {
        try {
          envText = fs.readFileSync(`/proc/${server.pid}/environ`, "utf8");
          if (envText.includes("KUSABI_SERVE_STATE_DIR=")) break;
        } catch { /* not readable yet */ }
        await new Promise((r) => setTimeout(r, 25));
      }
      const map = {};
      for (const entry of envText.split("\0").filter(Boolean)) {
        const eq = entry.indexOf("=");
        if (eq > 0) map[entry.slice(0, eq)] = entry.slice(eq + 1);
      }
      assert.equal(map.KUSABI_SERVE_STATE_DIR, ctx.stateDir);
    } finally {
      ctx.killAll();
      ctx.restore();
      ctx.rm();
    }
  });
});

// reapOrphanedServes — orphan-serve sweep (kusabi #162 follow-up)
// ---------------------------------------------------------------------------
// Fixtures are fake long-lived processes the test spawns itself; the only
// processes carrying kusabi's marker env are these fixtures, and their state
// dirs live under a temp state root — so the sweep can never touch anything
// outside the fixtures.  Liveness is asserted by pid, never by a log line.

const ORPHAN_SLEEPER_SOURCE = "setInterval(() => {}, 1000);\n";

function orphanFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-orphan-test-"));
  const sleeper = path.join(tmp, "sleeper.mjs");
  fs.writeFileSync(sleeper, ORPHAN_SLEEPER_SOURCE, "utf8");
  const root = path.join(tmp, "state");
  const stateDir = path.join(root, "abcd1234ef01");
  fs.mkdirSync(stateDir, { recursive: true });
  return { tmp, sleeper, root, stateDir, serverFile: path.join(stateDir, "server.json") };
}

// Spawn a fake long-lived serve-like process.  With marker=true it carries
// the same env buildServeEnv() stamps into a real serve; serveArgv controls
// whether the argv looks like a serve (a bare "serve" token).
function spawnOrphanSleeper(sleeper, stateDir, { marker = true, stateDirOverride = null, serveArgv = true } = {}) {
  const env = { ...process.env };
  if (marker) {
    env.KUSABI_WORKER_CONTEXT = "1";
    env.KUSABI_SERVE_STATE_DIR = stateDirOverride ?? stateDir;
  } else {
    delete env.KUSABI_WORKER_CONTEXT;
    delete env.KUSABI_SERVE_STATE_DIR;
  }
  const args = serveArgv ? [sleeper, "serve", "--port", "0"] : [sleeper];
  return spawn(process.execPath, args, { env, stdio: "ignore" });
}

// Between spawn() and exec the child's /proc/<pid>/environ still shows the
// parent's env; wait until the fixture actually carries the marker so the
// sweep is exercised, not skipped by timing.
async function waitForMarkerEnv(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.readFileSync(`/proc/${pid}/environ`, "utf8").includes("KUSABI_WORKER_CONTEXT=1")) return;
    } catch { /* not readable yet */ }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`pid ${pid} never showed the marker env`);
}

function killPid(pid) {
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

describe("reapOrphanedServes (spawn-based, temp state root)", () => {
  it("kills a marked serve whose state dir's server.json names a different pid", async () => {
    const fx = orphanFixture();
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir);
    fs.writeFileSync(fx.serverFile, JSON.stringify({ pid: 424242, port: 1 }), "utf8");
    try {
      await waitForMarkerEnv(child.pid);
      assert.ok(isAlive(child.pid), "fixture must be alive before the sweep");
      reapOrphanedServes(fx.root);
      await waitForDeath(child.pid);
    } finally {
      killPid(child.pid);
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("spares a marked serve whose server.json names the same pid", async () => {
    const fx = orphanFixture();
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir);
    fs.writeFileSync(fx.serverFile, JSON.stringify({ pid: child.pid, port: 1 }), "utf8");
    try {
      await waitForMarkerEnv(child.pid);
      reapOrphanedServes(fx.root);
      assert.ok(isAlive(child.pid), "a recorded serve must survive the sweep");
    } finally {
      killPid(child.pid);
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("spares a marked process whose argv is not a serve (descendant simulation)", async () => {
    const fx = orphanFixture();
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir, { serveArgv: false });
    try {
      await waitForMarkerEnv(child.pid);
      reapOrphanedServes(fx.root);
      assert.ok(isAlive(child.pid), "a marker-carrying non-serve must survive");
    } finally {
      killPid(child.pid);
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("spares a live process without kusabi's marker", async () => {
    const fx = orphanFixture();
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir, { marker: false });
    try {
      reapOrphanedServes(fx.root);
      assert.ok(isAlive(child.pid), "an unmarked process must survive");
    } finally {
      killPid(child.pid);
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("spares a marked serve whose marker names a state dir outside the swept root", async () => {
    const fx = orphanFixture();
    const outside = path.join(fx.tmp, "other-state", "h1");
    fs.mkdirSync(outside, { recursive: true });
    const child = spawnOrphanSleeper(fx.sleeper, outside, { stateDirOverride: outside });
    try {
      await waitForMarkerEnv(child.pid);
      reapOrphanedServes(fx.root);
      assert.ok(isAlive(child.pid), "a serve outside the swept root must survive");
    } finally {
      killPid(child.pid);
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("spares a marked serve whose state dir holds a fresh serve.lock and no server.json", async () => {
    const fx = orphanFixture();
    fs.mkdirSync(path.join(fx.stateDir, "serve.lock"));
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir);
    try {
      await waitForMarkerEnv(child.pid);
      reapOrphanedServes(fx.root);
      assert.ok(isAlive(child.pid), "a serve mid-start-up must survive");
    } finally {
      killPid(child.pid);
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("kills a marked serve whose state dir has a stale serve.lock and no server.json", async () => {
    const fx = orphanFixture();
    const lockDir = path.join(fx.stateDir, "serve.lock");
    fs.mkdirSync(lockDir);
    const old = new Date(Date.now() - 3600_000); // 1h old — far past the ready timeout
    fs.utimesSync(lockDir, old, old);
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir);
    try {
      await waitForMarkerEnv(child.pid);
      reapOrphanedServes(fx.root);
      await waitForDeath(child.pid);
    } finally {
      killPid(child.pid);
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("is a no-op when /proc cannot be listed (macOS-style degradation)", () => {
    const fx = orphanFixture();
    const realReaddirSync = fs.readdirSync;
    fs.readdirSync = (p, ...rest) => {
      if (p === "/proc") throw new Error("no /proc here");
      return realReaddirSync(p, ...rest);
    };
    try {
      reapOrphanedServes(fx.root); // must not throw
    } finally {
      fs.readdirSync = realReaddirSync;
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("skips an unreadable pid's environ without failing the rest of the sweep", async () => {
    const fx = orphanFixture();
    const victim = spawnOrphanSleeper(fx.sleeper, fx.stateDir);
    const survivor = spawnOrphanSleeper(fx.sleeper, fx.stateDir);
    try {
      await waitForMarkerEnv(victim.pid);
      await waitForMarkerEnv(survivor.pid);
      const realReadFileSync = fs.readFileSync;
      fs.readFileSync = (p, ...rest) => {
        if (p === `/proc/${victim.pid}/environ`) throw new Error("operation not permitted");
        return realReadFileSync(p, ...rest);
      };
      try {
        reapOrphanedServes(fx.root);
      } finally {
        fs.readFileSync = realReadFileSync;
      }
      assert.ok(isAlive(victim.pid), "an unreadable pid must be skipped, not killed");
      await waitForDeath(survivor.pid);
    } finally {
      killPid(victim.pid);
      killPid(survivor.pid);
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });
});
