import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  chainControlFilePath,
  readChainControl,
  writeChainControl,
  createChainControl,
  requestChainStop,
  isPidAlive,
  effectiveStatus,
  shouldStopNow,
  updateChainControlRound,
  finalizeChainControl,
  rearmChainControl,
  chainIdForJob,
  listChainDirs,
  collectChainStatuses,
  buildNotifyArgs,
} from "./chain-control.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-chain-ctrl-"));
}

// ---------------------------------------------------------------------------
// chainControlFilePath
// ---------------------------------------------------------------------------

describe("chainControlFilePath", () => {
  it("returns control.json inside the chain directory", () => {
    const result = chainControlFilePath("/tmp/chains/chain-abc");
    assert.equal(result, "/tmp/chains/chain-abc/control.json");
  });
});

// ---------------------------------------------------------------------------
// readChainControl / writeChainControl
// ---------------------------------------------------------------------------

describe("readChainControl / writeChainControl", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when control.json does not exist", () => {
    const result = readChainControl(tmpDir);
    assert.equal(result, null);
  });

  it("writes and reads a control record", () => {
    const control = createChainControl({
      chainId: "chain-test",
      container: "abc123",
      pid: 12345,
    });
    writeChainControl(tmpDir, control);
    const result = readChainControl(tmpDir);
    assert.equal(result.chainId, "chain-test");
    assert.equal(result.container, "abc123");
    assert.equal(result.pid, 12345);
    assert.equal(result.status, "running");
    assert.equal(result.round, 0);
  });
});

// ---------------------------------------------------------------------------
// createChainControl
// ---------------------------------------------------------------------------

describe("createChainControl", () => {
  it("creates a fresh control record with running status", () => {
    const control = createChainControl({
      chainId: "chain-xyz",
      container: "cid-1",
      pid: 9999,
    });
    assert.equal(control.chainId, "chain-xyz");
    assert.equal(control.container, "cid-1");
    assert.equal(control.pid, 9999);
    assert.equal(control.status, "running");
    assert.equal(control.round, 0);
    assert.ok(control.startedAt);
  });
});

// ---------------------------------------------------------------------------
// isPidAlive
// ---------------------------------------------------------------------------

describe("isPidAlive", () => {
  it("returns true for the current process pid", () => {
    // Our own PID is always alive
    assert.equal(isPidAlive(process.pid), true);
  });

  it("returns false for pid 0", () => {
    assert.equal(isPidAlive(0), false);
  });

  it("returns false for negative pid", () => {
    assert.equal(isPidAlive(-1), false);
  });

  it("returns false for null/undefined", () => {
    assert.equal(isPidAlive(null), false);
    assert.equal(isPidAlive(undefined), false);
  });

  it("returns false for a non-existent pid (very large number)", () => {
    // We test that it returns false for a pid that almost certainly
    // does not exist. We don't assert the exact reason, just that
    // it's not "alive".
    const result = isPidAlive(99999999);
    assert.equal(result, false);
  });
});

// ---------------------------------------------------------------------------
// effectiveStatus
// ---------------------------------------------------------------------------

describe("effectiveStatus", () => {
  it("returns unknown for null control", () => {
    const result = effectiveStatus(null);
    assert.equal(result.status, "unknown");
    assert.equal(result.stale, false);
  });

  it("returns the stored status for non-running status", () => {
    const result = effectiveStatus({ chainId: "c1", status: "completed", round: 3 });
    assert.equal(result.status, "completed");
    assert.equal(result.stale, false);
  });

  it("returns stale when status is running but pid is dead (not our pid)", () => {
    // Our own pid is alive — use a zero pid which is always dead
    const result = effectiveStatus({ chainId: "c1", status: "running", pid: 0 });
    assert.equal(result.status, "stale");
    assert.equal(result.stale, true);
  });

  it("returns running when pid is alive", () => {
    const result = effectiveStatus({ chainId: "c1", status: "running", pid: process.pid });
    assert.equal(result.status, "running");
    assert.equal(result.stale, false);
  });

  it("returns stopping when stop request exists and pid is alive", () => {
    const result = effectiveStatus({
      chainId: "c1",
      status: "running",
      pid: process.pid,
      stopRequestedAt: new Date().toISOString(),
    });
    assert.equal(result.status, "stopping");
    assert.equal(result.stale, false);
  });

  it("returns stale when status is running, pid missing, no stop request", () => {
    // pid missing (undefined) → isPidAlive returns false via the guard
    const result = effectiveStatus({ chainId: "c1", status: "running" });
    assert.equal(result.status, "stale");
    assert.equal(result.stale, true);
  });
});

// ---------------------------------------------------------------------------
// shouldStopNow
// ---------------------------------------------------------------------------

describe("shouldStopNow", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns false when no control file exists", () => {
    // shouldStopNow gracefully handles missing file
    // (it reads null, then !!null.stopRequestedAt → false)
    const result = shouldStopNow({ chainDir: tmpDir });
    assert.equal(result, false);
  });

  it("returns false when no stop request is in the control file", () => {
    writeChainControl(tmpDir, {
      chainId: "chain-1",
      status: "running",
      pid: 999,
    });
    const result = shouldStopNow({ chainDir: tmpDir });
    assert.equal(result, false);
  });

  it("returns true when a stop request exists in the control file", () => {
    writeChainControl(tmpDir, {
      chainId: "chain-1",
      status: "running",
      pid: 999,
      stopRequestedAt: new Date().toISOString(),
    });
    const result = shouldStopNow({ chainDir: tmpDir });
    assert.equal(result, true);
  });

  it("returns true when signalReceived is true (SIGTERM/SIGINT)", () => {
    // signalReceived takes precedence — doesn't need any file
    const result = shouldStopNow({ chainDir: tmpDir, signalReceived: true });
    assert.equal(result, true);
  });
});

// ---------------------------------------------------------------------------
// updateChainControlRound
// ---------------------------------------------------------------------------

describe("updateChainControlRound", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("updates the round field", () => {
    writeChainControl(tmpDir, {
      chainId: "c1",
      container: "cid",
      pid: 123,
      status: "running",
      round: 0,
    });
    updateChainControlRound({ chainDir: tmpDir, round: 2 });
    const result = readChainControl(tmpDir);
    assert.equal(result.round, 2);
    assert.equal(result.status, "running"); // unchanged
  });

  it("does nothing when no control file exists", () => {
    // Should not throw
    updateChainControlRound({ chainDir: tmpDir, round: 3 });
    // No file was created
    assert.equal(readChainControl(tmpDir), null);
  });
});

// ---------------------------------------------------------------------------
// finalizeChainControl
// ---------------------------------------------------------------------------

describe("finalizeChainControl", () => {
  let tmpDir;
  let prevNotify;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    // Existing tests use a flat tmpDir as chainDir; without a proper
    // stateDir/chains/<id> layout, notify would resolve to a bad root.
    // Opt out for the status-field tests; the notify path has its own test.
    prevNotify = process.env.KUSABI_CHAIN_NOTIFY;
    process.env.KUSABI_CHAIN_NOTIFY = "0";
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevNotify === undefined) delete process.env.KUSABI_CHAIN_NOTIFY;
    else process.env.KUSABI_CHAIN_NOTIFY = prevNotify;
  });

  it("sets status to completed and records finishedAt", () => {
    writeChainControl(tmpDir, {
      chainId: "c1",
      container: "cid",
      pid: 123,
      status: "running",
      round: 0,
    });
    finalizeChainControl({ chainDir: tmpDir, status: "completed", round: 3 });
    const result = readChainControl(tmpDir);
    assert.equal(result.status, "completed");
    assert.equal(result.round, 3);
    assert.ok(result.finishedAt);
  });

  it("preserves stop request fields", () => {
    writeChainControl(tmpDir, {
      chainId: "c1",
      container: "cid",
      pid: 123,
      status: "running",
      round: 0,
      stopRequestedAt: "2026-01-01T00:00:00Z",
      stopRequestedBy: "test",
    });
    finalizeChainControl({ chainDir: tmpDir, status: "cancelled", round: 2 });
    const result = readChainControl(tmpDir);
    assert.equal(result.status, "cancelled");
    assert.equal(result.stopRequestedAt, "2026-01-01T00:00:00Z");
    assert.equal(result.stopRequestedBy, "test");
  });

  it("does nothing when no control file exists", () => {
    finalizeChainControl({ chainDir: tmpDir, status: "completed", round: 1 });
    assert.equal(readChainControl(tmpDir), null);
  });

  it("writes inbox under stateDir when notify is enabled", () => {
    if (prevNotify === undefined) delete process.env.KUSABI_CHAIN_NOTIFY;
    else process.env.KUSABI_CHAIN_NOTIFY = prevNotify;

    const stateDir = tmpDir;
    const chainDir = path.join(stateDir, "chains", "chain-notify-wire");
    fs.mkdirSync(chainDir, { recursive: true });
    writeChainControl(chainDir, {
      chainId: "chain-notify-wire",
      container: "cid-wire",
      pid: 123,
      status: "running",
      round: 0,
    });
    fs.writeFileSync(
      path.join(chainDir, "chain.json"),
      JSON.stringify({
        chainId: "chain-notify-wire",
        container: "cid-wire",
        disposition: { disposition: "accept", round: 1 },
        brief: "/tmp/briefs/demo.md",
      }),
      "utf8",
    );

    const kaibaDb = path.join(stateDir, "kaiba.db");
    const db = new DatabaseSync(kaibaDb, { open: true, write: true });
    db.exec(
      "CREATE TABLE actions (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, position REAL NOT NULL, author TEXT, created_at TEXT NOT NULL, done_at TEXT)"
    );
    db.close();

    const prevDb = process.env.KAIBA_DB;
    process.env.KAIBA_DB = kaibaDb;
    try {
      finalizeChainControl({ chainDir, status: "completed", round: 1 });
    } finally {
      if (prevDb === undefined) delete process.env.KAIBA_DB;
      else process.env.KAIBA_DB = prevDb;
    }

    const inboxPath = path.join(stateDir, "inbox", "chain-notify-wire.md");
    assert.ok(fs.existsSync(inboxPath), "inbox file should exist");
    const body = fs.readFileSync(inboxPath, "utf8");
    assert.ok(body.includes("chain-notify-wire"));
    assert.ok(body.includes("completed"));

    const args = buildNotifyArgs(chainDir, readChainControl(chainDir), "completed");
    assert.equal(args.chainId, "chain-notify-wire");
    assert.equal(args.disposition, "accept");
    assert.equal(args.container, "cid-wire");
    assert.equal(args.cwdLabel, "demo");
  });
});

// ---------------------------------------------------------------------------
// rearmChainControl — chain-resume re-arm (kusabi #153①)
// ---------------------------------------------------------------------------

describe("rearmChainControl", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sets status back to running with the new pid and clears the stop-request fields", () => {
    writeChainControl(tmpDir, {
      chainId: "chain-1",
      container: "cid-1",
      pid: 0,
      status: "cancelled",
      round: 3,
      stopRequestedAt: "2026-08-01T00:00:00.000Z",
      stopRequestedBy: "cli",
      finishedAt: "2026-08-01T00:00:00.000Z",
      startedAt: "2026-08-01T00:00:00.000Z",
    });
    const next = rearmChainControl({ chainDir: tmpDir, round: 3 });

    assert.equal(next.status, "running");
    assert.equal(next.pid, process.pid);
    assert.equal(next.round, 3);
    assert.ok(next.resumedAt);
    // Stop fields cleared so shouldStopNow() no longer fires
    assert.equal(next.stopRequestedAt, undefined);
    assert.equal(next.stopRequestedBy, undefined);
    assert.equal(next.finishedAt, undefined);
    // Identity fields preserved
    assert.equal(next.chainId, "chain-1");
    assert.equal(next.container, "cid-1");
    assert.equal(next.startedAt, "2026-08-01T00:00:00.000Z");

    const persisted = readChainControl(tmpDir);
    assert.equal(persisted.status, "running");
    assert.equal(persisted.stopRequestedAt, undefined);
    assert.equal(persisted.resumedAt, next.resumedAt);
  });

  it("throws when no control record exists", () => {
    assert.throws(
      () => rearmChainControl({ chainDir: tmpDir, round: 1 }),
      /no control record found/,
    );
  });
});

// ---------------------------------------------------------------------------
// requestChainStop
// ---------------------------------------------------------------------------

describe("requestChainStop", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes stop request fields into control.json", () => {
    writeChainControl(tmpDir, {
      chainId: "chain-1",
      container: "cid",
      pid: process.pid, // alive
      status: "running",
      round: 0,
    });
    const result = requestChainStop(tmpDir, "cli-test");
    assert.equal(result.chainId, "chain-1");
    assert.equal(result.wasRunning, true);
    assert.equal(result.wasStale, false);

    const control = readChainControl(tmpDir);
    assert.equal(control.stopRequestedBy, "cli-test");
    assert.ok(control.stopRequestedAt);
    // Non-stop-request fields remain unchanged
    assert.equal(control.status, "running");
    assert.equal(control.pid, process.pid);
  });

  it("finalises status when the chain process is already dead", () => {
    // Use pid 0 which is always invalid/dead
    writeChainControl(tmpDir, {
      chainId: "chain-2",
      container: "cid",
      pid: 0, // dead
      status: "running",
      round: 1,
    });
    const result = requestChainStop(tmpDir, "cli-test");
    assert.equal(result.wasRunning, false);
    assert.equal(result.wasStale, true);

    const control = readChainControl(tmpDir);
    assert.equal(control.status, "cancelled");
    assert.ok(control.finishedAt);
  });

  it("throws when no control record exists", () => {
    assert.throws(
      () => requestChainStop(tmpDir, "cli"),
      /no control record found/,
    );
  });

  it("does not change status when chain was already completed", () => {
    writeChainControl(tmpDir, {
      chainId: "chain-3",
      container: "cid",
      pid: 0,
      status: "completed",
      round: 3,
      finishedAt: new Date().toISOString(),
    });
    const result = requestChainStop(tmpDir, "cli");
    assert.equal(result.wasRunning, false);
    assert.equal(result.wasStale, false);
    const control = readChainControl(tmpDir);
    assert.equal(control.status, "completed");
    assert.equal(control.stopRequestedBy, "cli");
  });
});

// ---------------------------------------------------------------------------
// chainIdForJob
// ---------------------------------------------------------------------------

describe("chainIdForJob", () => {
  it("extracts chain id from a chain job title", () => {
    const job = { title: "chain: chain-ms0mtxw4a5d9 round 3 review" };
    assert.equal(chainIdForJob(job), "chain-ms0mtxw4a5d9");
  });

  it("extracts chain id from an implement job title", () => {
    const job = { title: "chain: chain-abc123 round 1 implement" };
    assert.equal(chainIdForJob(job), "chain-abc123");
  });

  it("returns null for non-chain jobs", () => {
    const job = { title: "Implement the feature" };
    assert.equal(chainIdForJob(job), null);
  });

  it("returns null for null job", () => {
    assert.equal(chainIdForJob(null), null);
  });

  it("returns null for job without title", () => {
    assert.equal(chainIdForJob({}), null);
  });
});

// ---------------------------------------------------------------------------
// listChainDirs / collectChainStatuses
// ---------------------------------------------------------------------------

describe("listChainDirs / collectChainStatuses", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when chains dir does not exist", () => {
    const dirs = listChainDirs(tmpDir);
    assert.deepEqual(dirs, []);
  });

  it("lists chain directories under chains/", () => {
    const chainsDir = path.join(tmpDir, "chains");
    fs.mkdirSync(path.join(chainsDir, "chain-aaa"), { recursive: true });
    fs.mkdirSync(path.join(chainsDir, "chain-bbb"), { recursive: true });
    fs.mkdirSync(path.join(chainsDir, "not-a-chain"), { recursive: true });

    const dirs = listChainDirs(tmpDir);
    assert.equal(dirs.length, 2);
    assert.ok(dirs.some(function (d) { return d.endsWith("chain-aaa"); }));
    assert.ok(dirs.some(function (d) { return d.endsWith("chain-bbb"); }));
  });

  it("collectChainStatuses returns running chain info", () => {
    const chainsDir = path.join(tmpDir, "chains");
    const chainDir = path.join(chainsDir, "chain-run");
    fs.mkdirSync(chainDir, { recursive: true });
    writeChainControl(chainDir, {
      chainId: "chain-run",
      container: "cid-run",
      pid: process.pid, // alive
      status: "running",
      round: 2,
      startedAt: new Date().toISOString(),
    });

    const statuses = collectChainStatuses(tmpDir);
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].chainId, "chain-run");
    assert.equal(statuses[0].status, "running");
    assert.equal(statuses[0].round, 2);
    assert.equal(statuses[0].container, "cid-run");
    assert.equal(statuses[0].stale, false);
  });

  it("collectChainStatuses reports stale for dead process", () => {
    const chainsDir = path.join(tmpDir, "chains");
    const chainDir = path.join(chainsDir, "chain-stale");
    fs.mkdirSync(chainDir, { recursive: true });
    writeChainControl(chainDir, {
      chainId: "chain-stale",
      container: "cid-stale",
      pid: 0, // dead
      status: "running",
      round: 1,
    });

    const statuses = collectChainStatuses(tmpDir);
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].status, "stale");
    assert.equal(statuses[0].stale, true);
  });

  it("collectChainStatuses reports completed chains correctly", () => {
    const chainsDir = path.join(tmpDir, "chains");
    const chainDir = path.join(chainsDir, "chain-done");
    fs.mkdirSync(chainDir, { recursive: true });
    writeChainControl(chainDir, {
      chainId: "chain-done",
      container: "cid-done",
      pid: process.pid,
      status: "completed",
      round: 3,
      finishedAt: new Date().toISOString(),
    });

    const statuses = collectChainStatuses(tmpDir);
    // Completed chains are not running, so they should not claim ownership
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].status, "completed");
  });

  it("collectChainStatuses skips chains without control.json", () => {
    const chainsDir = path.join(tmpDir, "chains");
    fs.mkdirSync(path.join(chainsDir, "chain-nocontrol"), { recursive: true });

    const statuses = collectChainStatuses(tmpDir);
    assert.equal(statuses.length, 0);
  });

  it("collectChainStatuses returns empty array when no chains exist", () => {
    const statuses = collectChainStatuses(tmpDir);
    assert.deepEqual(statuses, []);
  });
});
// ---------------------------------------------------------------------------
// kaiba job retirement at chain terminal paths (kusabi #497 / kaiba#33)
// ---------------------------------------------------------------------------
//
// At chain finalization (finalizeChainControl with a terminal status) and at
// the stale-pid stop terminal path (requestChainStop finalising a dead chain),
// the chain sweeps the unique job ids recorded in chain.json — implement,
// review, and replacement review seats — and retires each through
// kaiba-progress-retire.mjs. The sweep is best-effort and idempotent: failures
// never throw and never change chain/control state, and the chain id itself is
// never retired.

describe("kaiba job retirement at chain terminal paths", () => {
  let tmpDir;
  let fakeBin;
  let logFile;
  let savedEnv = {};

  function makeFakeBin(file) {
    const script = [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'const logFile = process.env.KUSABI_RETIRE_LOG;',
      'if (logFile) fs.appendFileSync(logFile, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'if (process.env.KUSABI_RETIRE_EXIT) process.exit(Number(process.env.KUSABI_RETIRE_EXIT));',
      "process.exit(0);",
      "",
    ].join("\n");
    fs.writeFileSync(file, script, "utf8");
    fs.chmodSync(file, 0o755);
    return file;
  }

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fakeBin = makeFakeBin(path.join(tmpDir, "fake-retire-bin"));
    logFile = path.join(tmpDir, "retire.log");
    for (const key of ["KAIBA_RETIRE_BIN", "KUSABI_KAIBA_RETIRE", "KUSABI_RETIRE_LOG", "KUSABI_RETIRE_EXIT", "KUSABI_CHAIN_NOTIFY"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.KAIBA_RETIRE_BIN = fakeBin;
    delete process.env.KUSABI_KAIBA_RETIRE;
    delete process.env.KUSABI_RETIRE_EXIT;
    process.env.KUSABI_RETIRE_LOG = logFile;
    process.env.KUSABI_CHAIN_NOTIFY = "0";
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  function readLog() {
    if (!fs.existsSync(logFile)) return [];
    return fs
      .readFileSync(logFile, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l));
  }

  function loggedJobIds() {
    return readLog().map((args) => args[1]);
  }

  // A chain.json whose records exercise every seat: an implement job per
  // round, a duplicated implement job id across rounds, a live review job, and
  // archived replacement review seats carrying their own job ids (the dead
  // seat's `reviewJobId` and the unparseable retry's `reviewFirstJobId`).
  function writeChainJson(chainDir, records, chainId = "chain-sweep-1") {
    fs.writeFileSync(
      path.join(chainDir, "chain.json"),
      JSON.stringify({ chainId, container: "cid", records }, null, 2),
      "utf8"
    );
  }

  function writeRunningControl(chainDir, chainId = "chain-sweep-1", pid = 1) {
    writeChainControl(chainDir, { chainId, container: "cid", pid, status: "running", round: 0 });
  }

  const SWEEP_RECORDS = [
    { round: 1, implementJobId: "job-imp-1", reviewJobId: "job-rev-1" },
    {
      round: 2,
      implementJobId: "job-imp-2",
      reviewJobId: "job-rev-2",
      reviewSeatFailures: [
        { seat: 1, reviewJobId: "job-rev-dead-2", reviewFirstJobId: "job-rev-retry-2", verdict: "unparseable" },
      ],
    },
    {
      round: 3,
      implementJobId: "job-imp-1", // duplicate across rounds — retired once
      reviewJobId: "job-rev-3",
      reviewSeatFailures: [{ seat: 1, reviewJobId: "job-rev-dead-3", verdict: "partial" }],
    },
  ];

  const EXPECTED_SWEEP_IDS = new Set([
    "job-imp-1", "job-rev-1",
    "job-imp-2", "job-rev-2", "job-rev-dead-2", "job-rev-retry-2",
    "job-rev-3", "job-rev-dead-3",
  ]);

  it("finalizeChainControl retires every unique chain job id, never the chain id", () => {
    writeRunningControl(tmpDir);
    writeChainJson(tmpDir, SWEEP_RECORDS);
    finalizeChainControl({ chainDir: tmpDir, status: "completed", round: 3 });

    const ids = loggedJobIds();
    assert.equal(ids.length, EXPECTED_SWEEP_IDS.size, "each unique job id must be retired exactly once");
    for (const id of EXPECTED_SWEEP_IDS) {
      assert.ok(ids.includes(id), `chain sweep must retire ${id}`);
    }
    assert.ok(!ids.includes("chain-sweep-1"), "the chain id must never be retired");
    const control = readChainControl(tmpDir);
    assert.equal(control.status, "completed");
    assert.ok(control.finishedAt);
  });

  it("retires a top-level reviewFirstJobId like any other job id, deduplicated and never as the chain id", () => {
    // chain-review.mjs writes `roundRecord.reviewFirstJobId` at the TOP level
    // of the round record on the schema-repair (kusabi #395) and unparseable
    // retry (#145) paths. The sweep must collect that top-level reviewFirstJobId
    // exactly like every other recorded job id: deduplicated against the same
    // id recorded in another seat (Set semantics, retired once), and retired
    // as a JOB id — never as the chain id. (The seat-level `reviewFirstJobId`
    // inside reviewSeatFailures[] is exercised by SWEEP_RECORDS above; this
    // fixture pins the top-level variant the sweep currently misses.)
    writeRunningControl(tmpDir);
    writeChainJson(tmpDir, [
      {
        round: 1,
        implementJobId: "job-imp-1",
        reviewJobId: "job-rev-1",
        reviewSchemaRepaired: true,
        reviewFirstJobId: "job-rev-1", // top-level, duplicates reviewJobId — retired once
        reviewSeatFailures: [
          { seat: 1, reviewJobId: "job-rev-dead-1", reviewFirstJobId: "job-rev-retry-1", verdict: "unparseable" },
        ],
      },
      {
        round: 2,
        implementJobId: "job-imp-2",
        reviewJobId: "job-rev-2",
        reviewUnparseableRetried: true,
        reviewFirstJobId: "job-rev-first-2", // top-level, recorded only here
      },
    ]);
    finalizeChainControl({ chainDir: tmpDir, status: "completed", round: 2 });

    const ids = loggedJobIds();
    const expected = new Set([
      "job-imp-1", "job-rev-1",
      "job-rev-dead-1", "job-rev-retry-1",
      "job-imp-2", "job-rev-2", "job-rev-first-2",
    ]);
    for (const id of expected) {
      assert.ok(ids.includes(id), `chain sweep must retire ${id}`);
    }
    assert.equal(ids.length, expected.size, "each unique job id must be retired exactly once");
    assert.ok(!ids.includes("chain-sweep-1"), "the chain id must never be retired");
  });

  it("finalizeChainControl with cancelled status also sweeps", () => {
    writeRunningControl(tmpDir);
    writeChainJson(tmpDir, [{ round: 1, implementJobId: "job-imp-9", reviewJobId: "job-rev-9" }]);
    finalizeChainControl({ chainDir: tmpDir, status: "cancelled", round: 1 });
    assert.deepEqual(new Set(loggedJobIds()), new Set(["job-imp-9", "job-rev-9"]));
    assert.equal(readChainControl(tmpDir).status, "cancelled");
  });

  it("finalizeChainControl with no chain.json does not spawn, with one it sweeps", () => {
    writeRunningControl(tmpDir);
    finalizeChainControl({ chainDir: tmpDir, status: "completed", round: 1 });
    assert.deepEqual(readLog(), [], "no chain.json means no job ids to sweep");
    writeChainJson(tmpDir, SWEEP_RECORDS);
    finalizeChainControl({ chainDir: tmpDir, status: "completed", round: 3 });
    assert.equal(loggedJobIds().length, EXPECTED_SWEEP_IDS.size);
  });

  it("the stale-pid stop terminal path sweeps chain job ids and finalises to cancelled", () => {
    writeRunningControl(tmpDir, "chain-stale-1", 0 /* dead pid */);
    writeChainJson(tmpDir, SWEEP_RECORDS, "chain-stale-1");
    const result = requestChainStop(tmpDir, "cli-test");
    assert.equal(result.wasStale, true);

    const ids = loggedJobIds();
    assert.equal(ids.length, EXPECTED_SWEEP_IDS.size);
    assert.ok(!ids.includes("chain-stale-1"), "the chain id must never be retired");
    const control = readChainControl(tmpDir);
    assert.equal(control.status, "cancelled", "stale finalisation must stay cancelled");
    assert.ok(control.finishedAt);
  });

  it("the stale-pid path with no chain.json is a silent no-op, with one it sweeps", () => {
    writeRunningControl(tmpDir, "chain-stale-2", 0 /* dead pid */);
    const result = requestChainStop(tmpDir, "cli-test");
    assert.equal(result.wasStale, true);
    assert.deepEqual(readLog(), [], "no chain.json means no job ids to sweep");

    const secondDir = path.join(tmpDir, "chain-stale-3");
    fs.mkdirSync(secondDir, { recursive: true });
    writeRunningControl(secondDir, "chain-stale-3", 0 /* dead pid */);
    writeChainJson(secondDir, SWEEP_RECORDS, "chain-stale-3");
    const second = requestChainStop(secondDir, "cli-test");
    assert.equal(second.wasStale, true);
    assert.equal(loggedJobIds().length, EXPECTED_SWEEP_IDS.size);
  });

  it("chain sweep failures are fail-soft, observable, and never change chain state", () => {
    process.env.KUSABI_RETIRE_EXIT = "1";
    writeRunningControl(tmpDir);
    writeChainJson(tmpDir, SWEEP_RECORDS);
    const chainJsonBefore = fs.readFileSync(path.join(tmpDir, "chain.json"), "utf8");
    finalizeChainControl({ chainDir: tmpDir, status: "completed", round: 3 }); // must not throw
    assert.equal(loggedJobIds().length, EXPECTED_SWEEP_IDS.size, "the sweep must still be attempted");
    const control = readChainControl(tmpDir);
    assert.equal(control.status, "completed", "retire failure must not change the disposition");
    assert.equal(
      fs.readFileSync(path.join(tmpDir, "chain.json"), "utf8"),
      chainJsonBefore,
      "retire failure must not rewrite chain.json"
    );
  });

  it("malformed records and invalid ids are skipped without throwing", () => {
    writeRunningControl(tmpDir);
    writeChainJson(tmpDir, [
      { round: 1, implementJobId: "bad id!", reviewJobId: "job-rev-ok-1" },
      { round: 2, implementJobId: null, reviewSeatFailures: "not-an-array" },
      "a record that is not an object",
    ]);
    finalizeChainControl({ chainDir: tmpDir, status: "completed", round: 2 });
    assert.deepEqual(loggedJobIds(), ["job-rev-ok-1"], "only valid ids may be retired");
    assert.equal(readChainControl(tmpDir).status, "completed");
  });

  it("the chain sweep respects KUSABI_KAIBA_RETIRE=0, and resumes when unset", () => {
    process.env.KUSABI_KAIBA_RETIRE = "0";
    writeRunningControl(tmpDir);
    writeChainJson(tmpDir, SWEEP_RECORDS);
    finalizeChainControl({ chainDir: tmpDir, status: "completed", round: 3 });
    assert.deepEqual(readLog(), [], "opt-out must disable the sweep");

    const secondDir = path.join(tmpDir, "chain-enabled");
    fs.mkdirSync(secondDir, { recursive: true });
    delete process.env.KUSABI_KAIBA_RETIRE;
    writeRunningControl(secondDir);
    writeChainJson(secondDir, SWEEP_RECORDS);
    finalizeChainControl({ chainDir: secondDir, status: "completed", round: 3 });
    assert.equal(loggedJobIds().length, EXPECTED_SWEEP_IDS.size);
  });
});
