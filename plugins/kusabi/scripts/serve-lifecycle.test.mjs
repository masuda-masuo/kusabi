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
  reapIdleServes,
  isOurServe,
} from "./serve-lifecycle.mjs";
import { readJson, stateDirFor } from "./state-paths.mjs";
// The identity gate is shared by every kill site (kusabi #181); these two
// call sites are tested here, against real spawned processes, together with
// reapIdleServes.  (kusabi-companion.mjs and prompt-execution.mjs guard
// their CLI/interval entry points behind argv checks, so importing them is
// side-effect free.)
import { cmdServeStop } from "./kusabi-companion.mjs";
import { watchdogKillOrDecline } from "./prompt-execution.mjs";

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
// whether the argv looks like a serve (a bare "serve" token).  omitStateDir
// leaves KUSABI_SERVE_STATE_DIR unstamped (the marker set buildServeEnv used
// before 2026-08-03) so the identity gate reports 'unverifiable'.
function spawnOrphanSleeper(sleeper, stateDir, { marker = true, stateDirOverride = null, serveArgv = true, omitStateDir = false } = {}) {
  const env = { ...process.env };
  if (marker) {
    env.KUSABI_WORKER_CONTEXT = "1";
    if (!omitStateDir) env.KUSABI_SERVE_STATE_DIR = stateDirOverride ?? stateDir;
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

// Same race for the markerless fixtures: before exec the child's cmdline is
// still the parent's (no "serve" token), so waiting for the bare token
// synchronises on the fixture's own argv being in place.
async function waitForServeArgv(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes("serve")) return;
    } catch { /* not readable yet */ }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`pid ${pid} never showed a bare serve argv token`);
}

function killPid(pid) {
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

// A long-lived process with a real extra OS thread (worker_threads), for the
// TID case (kusabi #181): the incident record held a non-main thread's TID of
// an unrelated process.  /proc/<tid>/environ and /proc/<tid>/cmdline return
// the owning process's own, so the marker/cmdline gate catches a stranger's
// TID; kill(2) aimed at a TID would have SIGTERMed the whole thread group.
// The fixture writes { mainPid, mainTid, workerTids } to KUSABI_TEST_TID_FILE
// once the worker's task entry is visible, so the test can record a
// non-main TID in server.json exactly like the incident.
const TID_SLEEPER_SOURCE = `import { Worker } from "node:worker_threads";
import fs from "node:fs";

const tidFile = process.env.KUSABI_TEST_TID_FILE;
const mainTid = Number(process.pid);

const worker = new Worker(
  "const { parentPort } = require('node:worker_threads'); setInterval(() => {}, 1000);",
  { eval: true }
);

worker.on("online", () => {
  const deadline = Date.now() + 5000;
  const poll = () => {
    let tids = [];
    try { tids = fs.readdirSync("/proc/self/task").map(Number); } catch { /* not ready yet */ }
    const workerTids = tids.filter((t) => t !== mainTid);
    if (workerTids.length > 0) {
      fs.writeFileSync(tidFile, JSON.stringify({ mainPid: process.pid, mainTid, workerTids }));
      return;
    }
    if (Date.now() < deadline) setTimeout(poll, 25);
    else fs.writeFileSync(tidFile, JSON.stringify({ mainPid: process.pid, mainTid, workerTids: [] }));
  };
  poll();
});

setInterval(() => {}, 1000);
`;

// Spawn the threaded fixture.  marker=true gives it the kusabi serve env
// (serve-shaped), marker=false leaves it a stranger; serveArgv adds a bare
// "serve" argv token (node runs the script regardless).  Resolves once the
// fixture has written its TID file.
async function spawnThreadedSleeper(tmp, { marker = false, stateDir = null, serveArgv = false } = {}) {
  const tidFile = path.join(tmp, "tids.json");
  const script = path.join(tmp, "tid-sleeper.mjs");
  fs.writeFileSync(script, TID_SLEEPER_SOURCE, "utf8");
  const env = { ...process.env, KUSABI_TEST_TID_FILE: tidFile };
  if (marker) {
    env.KUSABI_WORKER_CONTEXT = "1";
    env.KUSABI_SERVE_STATE_DIR = stateDir;
  } else {
    delete env.KUSABI_WORKER_CONTEXT;
    delete env.KUSABI_SERVE_STATE_DIR;
  }
  const args = serveArgv ? [script, "serve"] : [script];
  const proc = spawn(process.execPath, args, { env, stdio: "ignore" });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const data = JSON.parse(fs.readFileSync(tidFile, "utf8"));
      if (data.workerTids.length > 0) {
        return { proc, mainPid: data.mainPid, workerTid: data.workerTids[0] };
      }
    } catch { /* not written yet */ }
    await new Promise((r) => setTimeout(r, 25));
  }
  try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  throw new Error("threaded sleeper never reported a worker TID");
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

// isOurServe — the identity gate every kill site uses (kusabi #181)
// ---------------------------------------------------------------------------
// Real spawned processes only.  Mocks cannot reproduce this defect: the
// broken code never inspected the pid's contents, so a mocked kill would
// only ever report "it was called".  The fixture processes carry exactly the
// env/argv shapes buildServeEnv() produces (or deliberately do not).

describe("isOurServe (spawn-based)", () => {
  it("true for a serve-shaped process (marker env + bare serve argv)", async () => {
    const fx = orphanFixture();
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir); // marker + serve argv by default
    try {
      await waitForMarkerEnv(child.pid);
      const result = isOurServe(child.pid, { root: fx.root, stateDir: fx.stateDir });
      assert.equal(result.ours, true);
      assert.equal(result.class, "ours");
      assert.equal(result.reason, null);
      assert.equal(result.markerStateDir, fx.stateDir);
    } finally {
      killPid(child.pid);
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("false for a live process without the marker env", async () => {
    const fx = orphanFixture();
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir, { marker: false, serveArgv: false });
    try {
      assert.ok(isAlive(child.pid), "fixture must be alive");
      const result = isOurServe(child.pid, { root: fx.root, stateDir: fx.stateDir });
      assert.equal(result.ours, false);
      assert.equal(result.class, "refuted");
      assert.match(result.reason, /KUSABI_WORKER_CONTEXT/);
    } finally {
      killPid(child.pid);
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("unverifiable (not refuted) for a markerless pid whose argv carries a bare serve token", async () => {
    // A serve spawned before KUSABI_WORKER_CONTEXT=1 was stamped
    // (2026-07-27) carries no marker at all — only its argv says "serve".
    // It may well BE our serve, so it must be unverifiable, never refuted:
    // a refuted record is deleted by record-driven callers, stranding the
    // genuine serve (unreachable by serve-stop, invisible to the orphan
    // sweep).  Nothing here may ever be signalled either way.
    const fx = orphanFixture();
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir, { marker: false }); // serveArgv defaults true
    try {
      await waitForServeArgv(child.pid);
      assert.ok(isAlive(child.pid), "fixture must be alive");
      const result = isOurServe(child.pid, { root: fx.root, stateDir: fx.stateDir });
      assert.equal(result.ours, false);
      assert.equal(result.class, "unverifiable");
      assert.match(result.reason, /KUSABI_WORKER_CONTEXT/);
      assert.match(result.reason, /"serve"/);
      assert.equal(result.markerStateDir, null);
    } finally {
      killPid(child.pid);
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("unverifiable (not refuted) when a markerless pid's cmdline is unreadable (hidepid-style EACCES)", async () => {
    // The markerless judgement leans on the argv: when that cannot be read
    // either, the same gone-vs-unreadable rule as the environ read applies
    // — ENOENT with /proc present is refuted, anything else unverifiable.
    const fx = orphanFixture();
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir, { marker: false });
    try {
      assert.ok(isAlive(child.pid), "fixture must be alive");
      const realReadFileSync = fs.readFileSync;
      fs.readFileSync = (p, ...rest) => {
        if (p === `/proc/${child.pid}/cmdline`) {
          const err = new Error("operation not permitted");
          err.code = "EACCES";
          throw err;
        }
        return realReadFileSync(p, ...rest);
      };
      let result;
      try {
        result = isOurServe(child.pid, { root: fx.root, stateDir: fx.stateDir });
      } finally {
        fs.readFileSync = realReadFileSync;
      }
      assert.equal(result.ours, false);
      assert.equal(result.class, "unverifiable");
      assert.match(result.reason, /cannot read/);
      assert.match(result.reason, /cmdline/);
    } finally {
      killPid(child.pid);
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("refuted (not unverifiable) when a markerless pid's cmdline is gone (ENOENT with /proc present)", async () => {
    // The environ read succeeds (no marker) but the cmdline read hits
    // ENOENT — the process vanished between the two reads, so nothing alive
    // is stranded: refuted, exactly like the environ ENOENT rule.
    const fx = orphanFixture();
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir, { marker: false });
    try {
      assert.ok(isAlive(child.pid), "fixture must be alive");
      const realReadFileSync = fs.readFileSync;
      fs.readFileSync = (p, ...rest) => {
        if (p === `/proc/${child.pid}/cmdline`) {
          const err = new Error("no such file or directory");
          err.code = "ENOENT";
          throw err;
        }
        return realReadFileSync(p, ...rest);
      };
      let result;
      try {
        result = isOurServe(child.pid, { root: fx.root, stateDir: fx.stateDir });
      } finally {
        fs.readFileSync = realReadFileSync;
      }
      assert.equal(result.ours, false);
      assert.equal(result.class, "refuted");
      assert.match(result.reason, /cannot read/);
      assert.match(result.reason, /cmdline/);
    } finally {
      killPid(child.pid);
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("false when the marker names a different state dir than the caller's", async () => {
    const fx = orphanFixture();
    const other = path.join(fx.root, "ffffffffffff");
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir, { stateDirOverride: other });
    try {
      await waitForMarkerEnv(child.pid);
      const result = isOurServe(child.pid, { root: fx.root, stateDir: fx.stateDir });
      assert.equal(result.ours, false);
      assert.equal(result.class, "refuted");
      assert.match(result.reason, /names state dir/);
    } finally {
      killPid(child.pid);
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("false when the marker names a state dir outside the swept root", async () => {
    const fx = orphanFixture();
    const outside = path.join(fx.tmp, "other-state", "h1");
    fs.mkdirSync(outside, { recursive: true });
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir, { stateDirOverride: outside });
    try {
      await waitForMarkerEnv(child.pid);
      const result = isOurServe(child.pid, { root: fx.root });
      assert.equal(result.ours, false);
      assert.equal(result.class, "refuted");
      assert.match(result.reason, /not under/);
    } finally {
      killPid(child.pid);
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("false when the argv carries no serve token (descendant simulation)", async () => {
    const fx = orphanFixture();
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir, { serveArgv: false });
    try {
      await waitForMarkerEnv(child.pid);
      const result = isOurServe(child.pid, { root: fx.root, stateDir: fx.stateDir });
      assert.equal(result.ours, false);
      assert.equal(result.class, "refuted");
      assert.match(result.reason, /argv/);
    } finally {
      killPid(child.pid);
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("refuted for a dead pid (ENOENT with /proc present — the process is gone, nothing to strand)", async () => {
    const fx = orphanFixture();
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir);
    try {
      await waitForMarkerEnv(child.pid);
      killPid(child.pid);
      await waitForDeath(child.pid);
      const result = isOurServe(child.pid, { root: fx.root, stateDir: fx.stateDir });
      assert.equal(result.ours, false);
      assert.equal(result.class, "refuted");
      assert.match(result.reason, /cannot read/);
    } finally {
      killPid(child.pid);
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("false for a stranger's thread id (TID) — the incident shape", async () => {
    // 2026-08-09: server.json held 59244, a TID of an unrelated process
    // (sunaba's main pid was 46988).  /proc/<tid>/environ and cmdline return
    // the owning process's own, so a marker check catches the TID case.
    const fx = orphanFixture();
    const stranger = await spawnThreadedSleeper(fx.tmp, { marker: false });
    try {
      assert.ok(isAlive(stranger.mainPid), "stranger must be alive");
      const result = isOurServe(stranger.workerTid, { root: fx.root, stateDir: fx.stateDir });
      assert.equal(result.ours, false);
      assert.equal(result.class, "refuted");
      assert.match(result.reason, /KUSABI_WORKER_CONTEXT/);
      assert.ok(isAlive(stranger.mainPid), "the whole process must survive — nothing was signalled");
    } finally {
      killPid(stranger.mainPid);
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("true for a TID of our own serve-shaped process (/proc returns the owning process's contents)", async () => {
    const fx = orphanFixture();
    const serve = await spawnThreadedSleeper(fx.tmp, { marker: true, stateDir: fx.stateDir, serveArgv: true });
    try {
      const result = isOurServe(serve.workerTid, { root: fx.root, stateDir: fx.stateDir });
      assert.equal(result.ours, true, "a TID of our own serve passes identity — killing it kills our own serve");
      assert.equal(result.class, "ours");
      assert.equal(result.reason, null);
    } finally {
      killPid(serve.mainPid);
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("unverifiable (not refuted) for the older marker set — KUSABI_WORKER_CONTEXT without KUSABI_SERVE_STATE_DIR", async () => {
    // KUSABI_SERVE_STATE_DIR is only stamped since 2026-08-03; a serve
    // carrying the older marker set is genuine but unattributable.  It must
    // not be treated as refuted: deleting its record would strand it.
    const fx = orphanFixture();
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir, { omitStateDir: true });
    try {
      await waitForMarkerEnv(child.pid);
      const result = isOurServe(child.pid, { root: fx.root, stateDir: fx.stateDir });
      assert.equal(result.ours, false);
      assert.equal(result.class, "unverifiable");
      assert.match(result.reason, /KUSABI_SERVE_STATE_DIR/);
    } finally {
      killPid(child.pid);
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("unverifiable (not refuted) when environ is unreadable (hidepid-style EACCES)", async () => {
    // A live process we cannot inspect may well be our serve; refuting it
    // (and letting callers delete the record) would strand it.  The stub
    // only simulates the platform condition (hidepid) — the identity
    // judgement itself runs against a real spawned process.
    const fx = orphanFixture();
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir);
    try {
      await waitForMarkerEnv(child.pid);
      const realReadFileSync = fs.readFileSync;
      fs.readFileSync = (p, ...rest) => {
        if (p === `/proc/${child.pid}/environ`) {
          const err = new Error("operation not permitted");
          err.code = "EACCES";
          throw err;
        }
        return realReadFileSync(p, ...rest);
      };
      let result;
      try {
        result = isOurServe(child.pid, { root: fx.root, stateDir: fx.stateDir });
      } finally {
        fs.readFileSync = realReadFileSync;
      }
      assert.equal(result.ours, false);
      assert.equal(result.class, "unverifiable");
      assert.match(result.reason, /cannot read/);
    } finally {
      killPid(child.pid);
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });
});

// reapIdleServes — the identity gate (kusabi #181)
// ---------------------------------------------------------------------------
// The record-driven sweep: a recorded pid that is not one of our serves must
// never be signalled.  A *refuted* record (a positive conflict — no serve
// token in the argv, wrong marker, gone process) is deleted instead so the
// next call does not look at that pid again; an *unverifiable* record (older
// marker set — including a wholly markerless pid whose argv still says
// "serve" — hidepid, /proc-less platform) is kept — the pid may well be a
// genuine serve and the record is the only handle to it; deleting it would
// strand the process and spawn a duplicate on the next dispatch.  Records
// are aged past the TTL in every test so the only thing sparing the fixture
// is the identity gate, not the reap decision.  Liveness is asserted by
// pid, never by a log line.

function writeStaleServerRecord(serverFile, pid, extra = {}) {
  fs.writeFileSync(serverFile, JSON.stringify({ pid, port: 1, password: "x", cwd: "/tmp", ...extra }), "utf8");
  const old = new Date(Date.now() - 3600_000); // 1h old — far past a 30min TTL
  fs.utimesSync(serverFile, old, old);
}

describe("reapIdleServes (spawn-based, temp state root)", () => {
  const TTL = 30 * 60 * 1000;

  it("deletes the record and spares a live process without the marker env", async () => {
    const fx = orphanFixture();
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir, { marker: false, serveArgv: false });
    writeStaleServerRecord(fx.serverFile, child.pid);
    try {
      assert.ok(isAlive(child.pid), "fixture must be alive before the sweep");
      reapIdleServes(fx.root, TTL);
      assert.ok(isAlive(child.pid), "a marker-less recorded pid must never be signalled");
      assert.ok(!fs.existsSync(fx.serverFile), "the invalid record must be deleted");
    } finally {
      killPid(child.pid);
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("keeps the record and spares a markerless process whose argv carries a bare serve token (pre-marker serve)", async () => {
    // A serve spawned before KUSABI_WORKER_CONTEXT=1 was stamped
    // (2026-07-27) is wholly markerless — only its argv says "serve".
    // Refuting it would delete the record, stranding the genuine serve:
    // serve-stop could never stop it again, the orphan sweep cannot
    // identify it (it needs the marker), and the next dispatch would spawn
    // a duplicate.  The sweep must keep both the process and the record
    // (unverifiable) and say so in server.log.
    const fx = orphanFixture();
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir, { marker: false }); // serveArgv defaults true
    writeStaleServerRecord(fx.serverFile, child.pid);
    try {
      await waitForServeArgv(child.pid);
      assert.ok(isAlive(child.pid), "fixture must be alive before the sweep");
      reapIdleServes(fx.root, TTL);
      assert.ok(isAlive(child.pid), "a markerless serve-shaped pid must never be signalled");
      assert.ok(fs.existsSync(fx.serverFile), "an unverifiable serve's record must be kept, not deleted");
      const log = fs.readFileSync(path.join(fx.stateDir, "server.log"), "utf8");
      assert.match(log, /reap-idle: pid \d+ refused \(unverifiable/);
      assert.match(log, /server\.json kept/);
    } finally {
      killPid(child.pid);
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("deletes the record and spares the whole process when the record holds a stranger's thread TID", async () => {
    // The incident shape: the record held a TID, not a pid.  kill(2) aimed
    // at a TID delivers a group signal, so a liveness-only guard passes and
    // the whole unrelated process dies.  The identity gate must decline.
    const fx = orphanFixture();
    const stranger = await spawnThreadedSleeper(fx.tmp, { marker: false });
    writeStaleServerRecord(fx.serverFile, stranger.workerTid);
    try {
      assert.ok(isAlive(stranger.workerTid), "the TID must read as alive (kill(pid, 0) passes for TIDs)");
      reapIdleServes(fx.root, TTL);
      assert.ok(isAlive(stranger.mainPid), "the whole process must survive the sweep");
      assert.ok(!fs.existsSync(fx.serverFile), "the invalid record must be deleted");
    } finally {
      killPid(stranger.mainPid);
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("still reaps a serve-shaped process carrying the marker env", async () => {
    const fx = orphanFixture();
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir); // marker + serve argv
    writeStaleServerRecord(fx.serverFile, child.pid);
    try {
      await waitForMarkerEnv(child.pid);
      reapIdleServes(fx.root, TTL);
      await waitForDeath(child.pid);
      assert.ok(!fs.existsSync(fx.serverFile), "the reaped serve's record must be deleted");
    } finally {
      killPid(child.pid);
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("is a no-op when /proc cannot be listed (macOS-style degradation)", () => {
    const fx = orphanFixture();
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir, { marker: false });
    writeStaleServerRecord(fx.serverFile, child.pid);
    const realReaddirSync = fs.readdirSync;
    fs.readdirSync = (p, ...rest) => {
      if (p === "/proc") throw new Error("no /proc here");
      return realReaddirSync(p, ...rest);
    };
    try {
      reapIdleServes(fx.root, TTL); // must not throw
      assert.ok(isAlive(child.pid), "nothing may be signalled without /proc");
      assert.ok(fs.existsSync(fx.serverFile), "the sweep is a no-op — records are left alone");
    } finally {
      fs.readdirSync = realReaddirSync;
      killPid(child.pid);
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("keeps the record and spares a genuine serve with the older marker set (unverifiable, not refuted)", async () => {
    // A pre-2026-08-03 serve carries KUSABI_WORKER_CONTEXT=1 without
    // KUSABI_SERVE_STATE_DIR: genuine but unattributable.  Deleting its
    // record would strand it (unreachable by serve-stop, invisible to the
    // orphan sweep) and spawn a duplicate on the next dispatch.
    const fx = orphanFixture();
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir, { omitStateDir: true });
    writeStaleServerRecord(fx.serverFile, child.pid);
    try {
      await waitForMarkerEnv(child.pid);
      reapIdleServes(fx.root, TTL);
      assert.ok(isAlive(child.pid), "an unverifiable serve must never be signalled");
      assert.ok(fs.existsSync(fx.serverFile), "an unverifiable serve's record must be kept");
      const log = fs.readFileSync(path.join(fx.stateDir, "server.log"), "utf8");
      assert.match(log, /reap-idle: pid \d+ refused \(unverifiable/);
      assert.match(log, /server\.json kept/);
    } finally {
      killPid(child.pid);
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("keeps the record and spares a live process whose environ is unreadable (hidepid-style EACCES)", async () => {
    const fx = orphanFixture();
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir);
    writeStaleServerRecord(fx.serverFile, child.pid);
    try {
      await waitForMarkerEnv(child.pid);
      const realReadFileSync = fs.readFileSync;
      fs.readFileSync = (p, ...rest) => {
        if (p === `/proc/${child.pid}/environ`) {
          const err = new Error("operation not permitted");
          err.code = "EACCES";
          throw err;
        }
        return realReadFileSync(p, ...rest);
      };
      try {
        reapIdleServes(fx.root, TTL); // must not throw
      } finally {
        fs.readFileSync = realReadFileSync;
      }
      assert.ok(isAlive(child.pid), "an uninspectable pid must never be signalled");
      assert.ok(fs.existsSync(fx.serverFile), "an unverifiable record must be kept, not deleted");
    } finally {
      killPid(child.pid);
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("keeps refuted records when keepIdentityFailed is set (serve-stop invocations)", async () => {
    // main() passes keepIdentityFailed for serve-stop so cmdServeStop can
    // adjudicate the record itself and say why it declined — the sweep must
    // not delete the record (and the reason) first (kusabi #181 follow-up).
    const fx = orphanFixture();
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir, { marker: false, serveArgv: false });
    writeStaleServerRecord(fx.serverFile, child.pid);
    try {
      reapIdleServes(fx.root, TTL, { keepIdentityFailed: true });
      assert.ok(isAlive(child.pid), "a marker-less recorded pid must never be signalled");
      assert.ok(fs.existsSync(fx.serverFile), "the record must be left for the invoking command");
      const log = fs.readFileSync(path.join(fx.stateDir, "server.log"), "utf8");
      assert.match(log, /left for the invoking command/);
    } finally {
      killPid(child.pid);
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });
});

// cmdServeStop — the identity gate (kusabi #181)
// ---------------------------------------------------------------------------
// Called directly (the module guards its CLI entry behind an argv check).
// On serve-stop invocations the startup reaper now leaves identity-failed
// records in place (keepIdentityFailed) so cmdServeStop adjudicates them
// itself — the decline path below is therefore the one the real CLI flow
// takes; a subprocess-level test in kusabi-companion.test.mjs covers the
// end-to-end path.  'refuted' records are removed with the decline;
// 'unverifiable' records are kept so a genuine serve is never stranded.

function serveStopFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-servestop-id-"));
  const root = path.join(tmp, "state");
  const cwd = path.join(tmp, "ws");
  fs.mkdirSync(cwd, { recursive: true });
  const sleeper = path.join(tmp, "sleeper.mjs");
  fs.writeFileSync(sleeper, ORPHAN_SLEEPER_SOURCE, "utf8");
  const saved = process.env.KUSABI_STATE_DIR;
  process.env.KUSABI_STATE_DIR = root;
  const stateDir = stateDirFor(cwd);
  return {
    tmp,
    root,
    cwd,
    sleeper,
    stateDir,
    serverFile: path.join(stateDir, "server.json"),
    restore() {
      if (saved === undefined) delete process.env.KUSABI_STATE_DIR;
      else process.env.KUSABI_STATE_DIR = saved;
    },
  };
}

describe("cmdServeStop identity gate (spawn-based)", () => {
  it("declines with a reason and deletes the record for a live process without the marker env", async () => {
    const fx = serveStopFixture();
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir, { marker: false, serveArgv: false });
    fs.writeFileSync(fx.serverFile, JSON.stringify({ pid: child.pid, port: 1, password: "x", cwd: fx.cwd }), "utf8");
    try {
      const message = cmdServeStop(fx.cwd);
      assert.match(message, /declined to stop pid/);
      assert.match(message, /KUSABI_WORKER_CONTEXT/);
      assert.ok(isAlive(child.pid), "a marker-less recorded pid must never be signalled");
      assert.ok(!fs.existsSync(fx.serverFile), "the invalid record must be deleted");
    } finally {
      killPid(child.pid);
      fx.restore();
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("declines but keeps the record for a markerless process whose argv carries a bare serve token (pre-marker serve)", async () => {
    // The pid may well be our serve (spawned before KUSABI_WORKER_CONTEXT=1
    // was stamped): deleting the record would strand it — it could never be
    // stopped again and the next dispatch would spawn a duplicate.  The
    // decline must say the record was kept.
    const fx = serveStopFixture();
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir, { marker: false }); // serveArgv defaults true
    fs.writeFileSync(fx.serverFile, JSON.stringify({ pid: child.pid, port: 1, password: "x", cwd: fx.cwd }), "utf8");
    try {
      await waitForServeArgv(child.pid);
      const message = cmdServeStop(fx.cwd);
      assert.match(message, /declined to stop pid/);
      assert.match(message, /KUSABI_WORKER_CONTEXT/);
      assert.match(message, /server\.json kept/);
      assert.ok(isAlive(child.pid), "a markerless serve-shaped pid must never be signalled");
      assert.ok(fs.existsSync(fx.serverFile), "the record must be kept — it is the only handle to the serve");
    } finally {
      killPid(child.pid);
      fx.restore();
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("declines and spares the whole process when the record holds a stranger's thread TID", async () => {
    const fx = serveStopFixture();
    const stranger = await spawnThreadedSleeper(fx.tmp, { marker: false });
    fs.writeFileSync(fx.serverFile, JSON.stringify({ pid: stranger.workerTid, port: 1, password: "x", cwd: fx.cwd }), "utf8");
    try {
      const message = cmdServeStop(fx.cwd);
      assert.match(message, /declined to stop pid/);
      assert.ok(isAlive(stranger.mainPid), "the whole process must survive serve-stop");
      assert.ok(!fs.existsSync(fx.serverFile), "the invalid record must be deleted");
    } finally {
      killPid(stranger.mainPid);
      fx.restore();
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("still stops a serve-shaped process carrying the marker env", async () => {
    const fx = serveStopFixture();
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir); // marker + serve argv
    fs.writeFileSync(fx.serverFile, JSON.stringify({ pid: child.pid, port: 1, password: "x", cwd: fx.cwd }), "utf8");
    try {
      await waitForMarkerEnv(child.pid);
      const message = cmdServeStop(fx.cwd);
      assert.match(message, /stopped opencode server \(pid \d+\)/);
      await waitForDeath(child.pid);
      assert.ok(!fs.existsSync(fx.serverFile), "server.json must be removed by serve-stop");
    } finally {
      killPid(child.pid);
      fx.restore();
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("declines but keeps the record when identity is unverifiable (hidepid-style EACCES)", async () => {
    // A live process we cannot inspect may well be our serve: deleting the
    // record would strand it (never stoppable again) and spawn a duplicate
    // on the next dispatch.  The decline must say the record was kept.
    const fx = serveStopFixture();
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir);
    fs.writeFileSync(fx.serverFile, JSON.stringify({ pid: child.pid, port: 1, password: "x", cwd: fx.cwd }), "utf8");
    try {
      await waitForMarkerEnv(child.pid);
      const realReadFileSync = fs.readFileSync;
      fs.readFileSync = (p, ...rest) => {
        if (p === `/proc/${child.pid}/environ`) {
          const err = new Error("operation not permitted");
          err.code = "EACCES";
          throw err;
        }
        return realReadFileSync(p, ...rest);
      };
      let message;
      try {
        message = cmdServeStop(fx.cwd);
      } finally {
        fs.readFileSync = realReadFileSync;
      }
      assert.match(message, /declined to stop pid/);
      assert.match(message, /server\.json kept/);
      assert.ok(isAlive(child.pid), "an uninspectable pid must never be signalled");
      assert.ok(fs.existsSync(fx.serverFile), "an unverifiable serve's record must be kept");
    } finally {
      killPid(child.pid);
      fx.restore();
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });
});

// watchdog kill decision — the identity gate (kusabi #181)
// ---------------------------------------------------------------------------
// watchdogKillOrDecline() is the exact code the watchdog interval runs when
// the recorded port stops answering (the SIGKILL site — the most dangerous
// one: its trigger is more likely precisely when the record is stale, and
// SIGKILL leaves the victim no chance to log anything).  Driven directly
// with real spawned processes; the interval's abort.abort() is outside this
// function and stays unconditional, so the stall handling is never lost.

function watchdogFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-watchdog-id-"));
  const root = path.join(tmp, "state");
  const cwd = path.join(tmp, "ws");
  fs.mkdirSync(cwd, { recursive: true });
  const sleeper = path.join(tmp, "sleeper.mjs");
  fs.writeFileSync(sleeper, ORPHAN_SLEEPER_SOURCE, "utf8");
  const saved = process.env.KUSABI_STATE_DIR;
  process.env.KUSABI_STATE_DIR = root;
  const stateDir = stateDirFor(cwd);
  const jobId = "job-wd";
  fs.mkdirSync(path.join(stateDir, "jobs", jobId), { recursive: true });
  return {
    tmp,
    root,
    cwd,
    sleeper,
    stateDir,
    jobId,
    serverFile: path.join(stateDir, "server.json"),
    eventsFile: path.join(stateDir, "jobs", jobId, "events.ndjson"),
    restore() {
      if (saved === undefined) delete process.env.KUSABI_STATE_DIR;
      else process.env.KUSABI_STATE_DIR = saved;
    },
  };
}

function readEvents(eventsFile) {
  try {
    return fs.readFileSync(eventsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

describe("watchdog kill decision (identity gate, spawn-based)", () => {
  function callWatchdog(fx, pid, { abortOk = false, healthOk = false, serveDead = null } = {}) {
    return watchdogKillOrDecline({
      server: { pid, port: 1, password: "x" },
      stateDir: fx.stateDir,
      job: { id: fx.jobId },
      abortOk,
      healthOk,
      serveDead,
    });
  }

  it("SIGKILLs the serve and records watchdog.kill when the recorded pid is one of our serves", async () => {
    const fx = watchdogFixture();
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir); // marker + serve argv
    fs.writeFileSync(fx.serverFile, JSON.stringify({ pid: child.pid, port: 1, password: "x", cwd: fx.cwd }), "utf8");
    try {
      await waitForMarkerEnv(child.pid);
      const killed = callWatchdog(fx, child.pid);
      assert.equal(killed, true);
      await waitForDeath(child.pid);
      assert.ok(!fs.existsSync(fx.serverFile), "server.json must be removed after the kill");
      const types = readEvents(fx.eventsFile).map((e) => e.type);
      assert.ok(types.includes("companion.watchdog.kill"));
    } finally {
      killPid(child.pid);
      fx.restore();
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("declines to kill, records an event with the reason, and removes the record for a marker-less pid", async () => {
    const fx = watchdogFixture();
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir, { marker: false, serveArgv: false });
    fs.writeFileSync(fx.serverFile, JSON.stringify({ pid: child.pid, port: 1, password: "x", cwd: fx.cwd }), "utf8");
    try {
      const killed = callWatchdog(fx, child.pid);
      assert.equal(killed, false);
      assert.ok(isAlive(child.pid), "a marker-less recorded pid must never be SIGKILLed");
      assert.ok(!fs.existsSync(fx.serverFile), "the invalid record must be removed");
      const declined = readEvents(fx.eventsFile).filter((e) => e.type === "companion.watchdog.declined-kill");
      assert.equal(declined.length, 1, "the decline must be recorded, not silent");
      assert.equal(declined[0].pid, child.pid);
      assert.match(declined[0].reason, /KUSABI_WORKER_CONTEXT/);
    } finally {
      killPid(child.pid);
      fx.restore();
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("declines with class unverifiable and keeps the record for a markerless pid whose argv carries a bare serve token", async () => {
    // A pre-marker serve is wholly markerless; only its argv says "serve".
    // The kill must be declined (never SIGKILL a pid we cannot attribute to
    // our own serve) but the record kept — it is the only handle to the
    // serve, and deleting it would strand the process and force a duplicate
    // spawn on the next dispatch.  The decline event must carry the class
    // so the audit trail distinguishes this from 'refuted'.
    const fx = watchdogFixture();
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir, { marker: false }); // serveArgv defaults true
    fs.writeFileSync(fx.serverFile, JSON.stringify({ pid: child.pid, port: 1, password: "x", cwd: fx.cwd }), "utf8");
    try {
      await waitForServeArgv(child.pid);
      const killed = callWatchdog(fx, child.pid);
      assert.equal(killed, false);
      assert.ok(isAlive(child.pid), "a markerless serve-shaped pid must never be SIGKILLed");
      assert.ok(fs.existsSync(fx.serverFile), "an unverifiable serve's record must be kept");
      const declined = readEvents(fx.eventsFile).filter((e) => e.type === "companion.watchdog.declined-kill");
      assert.equal(declined.length, 1, "the decline must be recorded, not silent");
      assert.equal(declined[0].class, "unverifiable");
      assert.match(declined[0].reason, /KUSABI_WORKER_CONTEXT/);
    } finally {
      killPid(child.pid);
      fx.restore();
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("declines and spares the whole process when the record holds a stranger's thread TID", async () => {
    const fx = watchdogFixture();
    const stranger = await spawnThreadedSleeper(fx.tmp, { marker: false });
    fs.writeFileSync(fx.serverFile, JSON.stringify({ pid: stranger.workerTid, port: 1, password: "x", cwd: fx.cwd }), "utf8");
    try {
      const killed = callWatchdog(fx, stranger.workerTid);
      assert.equal(killed, false);
      assert.ok(isAlive(stranger.mainPid), "the whole process must survive the watchdog");
      assert.ok(!fs.existsSync(fx.serverFile), "the invalid record must be removed");
      const declined = readEvents(fx.eventsFile).filter((e) => e.type === "companion.watchdog.declined-kill");
      assert.equal(declined.length, 1, "the decline must be recorded, not silent");
    } finally {
      killPid(stranger.mainPid);
      fx.restore();
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("leaves everything alone when both probes succeed (no stall, no kill, no event)", async () => {
    const fx = watchdogFixture();
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir);
    fs.writeFileSync(fx.serverFile, JSON.stringify({ pid: child.pid, port: 1, password: "x", cwd: fx.cwd }), "utf8");
    try {
      const killed = callWatchdog(fx, child.pid, { abortOk: true, healthOk: true });
      assert.equal(killed, false);
      assert.ok(isAlive(child.pid));
      assert.ok(fs.existsSync(fx.serverFile), "a healthy serve's record must be left alone");
      assert.deepEqual(readEvents(fx.eventsFile), [], "no event may be recorded when nothing was done");
    } finally {
      killPid(child.pid);
      fx.restore();
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("declines but keeps the record when identity is unverifiable (hidepid-style EACCES)", async () => {
    // The pid may well be our serve — deleting the record would strand it
    // and force a duplicate spawn.  The decline event must carry the class
    // so the audit trail distinguishes 'refuted' from 'unverifiable'.
    const fx = watchdogFixture();
    const child = spawnOrphanSleeper(fx.sleeper, fx.stateDir);
    fs.writeFileSync(fx.serverFile, JSON.stringify({ pid: child.pid, port: 1, password: "x", cwd: fx.cwd }), "utf8");
    try {
      await waitForMarkerEnv(child.pid);
      const realReadFileSync = fs.readFileSync;
      fs.readFileSync = (p, ...rest) => {
        if (p === `/proc/${child.pid}/environ`) {
          const err = new Error("operation not permitted");
          err.code = "EACCES";
          throw err;
        }
        return realReadFileSync(p, ...rest);
      };
      let killed;
      try {
        killed = callWatchdog(fx, child.pid);
      } finally {
        fs.readFileSync = realReadFileSync;
      }
      assert.equal(killed, false);
      assert.ok(isAlive(child.pid), "an uninspectable pid must never be SIGKILLed");
      assert.ok(fs.existsSync(fx.serverFile), "an unverifiable serve's record must be kept");
      const declined = readEvents(fx.eventsFile).filter((e) => e.type === "companion.watchdog.declined-kill");
      assert.equal(declined.length, 1, "the decline must be recorded, not silent");
      assert.equal(declined[0].class, "unverifiable");
      assert.match(declined[0].reason, /cannot read/);
    } finally {
      killPid(child.pid);
      fx.restore();
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });
});
