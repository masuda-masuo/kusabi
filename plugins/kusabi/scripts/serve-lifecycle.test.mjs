import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import process from "node:process";
import {
  shouldReapServer,
} from "./serve-lifecycle.mjs";

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
