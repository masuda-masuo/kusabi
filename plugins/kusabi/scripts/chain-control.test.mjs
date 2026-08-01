import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
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

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
