import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  readChainControl,
  requestChainStop,
  finalizeChainControl,
  rearmChainControl,
  buildNotifyArgs,
} from "./chain-control.mjs";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-terminal-occurrence-"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function makeChainFixture(stateDir, {
  chainId = "chain-occurrence-test",
  container = "container-original",
  cwdLabel = "Original chain label",
  disposition = "accept",
  status = "running",
  round = 4,
  pid = process.pid,
  finishedAt,
  terminalOccurrenceId,
  terminalNotifyArgs,
} = {}) {
  const chainDir = path.join(stateDir, "chains", chainId);
  fs.mkdirSync(chainDir, { recursive: true });
  writeJson(path.join(chainDir, "chain.json"), {
    chainId,
    container,
    records: [{ disposition: { disposition, reason: "accepted" } }],
    brief: `# ${cwdLabel}\n\nOrchestrator: test | session isolated | 2026-10-12\n`,
  });
  const control = {
    chainId,
    container,
    pid,
    status,
    round,
    ...(finishedAt ? { finishedAt } : {}),
    ...(terminalOccurrenceId ? { terminalOccurrenceId } : {}),
    ...(terminalNotifyArgs ? { terminalNotifyArgs } : {}),
  };
  writeJson(path.join(chainDir, "control.json"), control);
  return { chainDir, chainJsonPath: path.join(chainDir, "chain.json") };
}

describe("terminal occurrence identity and replay payload", () => {
  let tmpDir;
  let savedEnv;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    savedEnv = {};
    for (const key of ["HOME", "KUSABI_STATE_DIR", "KUSABI_CHAIN_NOTIFY", "KAIBA_DB"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.HOME = path.join(tmpDir, "home");
    process.env.KUSABI_STATE_DIR = path.join(tmpDir, "state");
    process.env.KUSABI_CHAIN_NOTIFY = "0";
    process.env.KAIBA_DB = path.join(tmpDir, "kaiba.db");
    fs.mkdirSync(process.env.HOME, { recursive: true });
    fs.mkdirSync(process.env.KUSABI_STATE_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("first finalize persists one occurrence and a stable notify snapshot on replay", () => {
    const { chainDir, chainJsonPath } = makeChainFixture(process.env.KUSABI_STATE_DIR);
    finalizeChainControl({ chainDir, status: "completed", round: 4 });

    const firstControl = readChainControl(chainDir);
    assert.equal(typeof firstControl.terminalOccurrenceId, "string");
    assert.notEqual(firstControl.terminalOccurrenceId, "");
    assert.equal(typeof firstControl.finishedAt, "string");
    const occurrenceId = firstControl.terminalOccurrenceId;
    const finishedAt = firstControl.finishedAt;
    const firstArgs = buildNotifyArgs(chainDir, firstControl, "completed");

    assert.equal(firstArgs.occurrenceId, occurrenceId);
    assert.equal(firstControl.terminalNotifyArgs.occurrenceId, occurrenceId);
    assert.deepEqual(firstControl.terminalNotifyArgs, firstArgs);
    assert.equal(firstArgs.stateDir, process.env.KUSABI_STATE_DIR);
    assert.equal(firstArgs.chainId, "chain-occurrence-test");
    assert.equal(firstArgs.status, "completed");
    assert.equal(firstArgs.disposition, "accept");
    assert.equal(firstArgs.container, "container-original");
    assert.equal(firstArgs.cwdLabel, "Original chain label");

    writeJson(chainJsonPath, {
      chainId: "chain-occurrence-test",
      container: "container-changed",
      records: [{ disposition: { disposition: "reject", reason: "changed after terminal" } }],
      brief: "# Changed label\n\nOrchestrator: changed | session changed | 2026-10-12\n",
    });
    finalizeChainControl({ chainDir, status: "completed", round: 4 });

    const replayControl = readChainControl(chainDir);
    assert.equal(replayControl.terminalOccurrenceId, occurrenceId);
    assert.equal(replayControl.finishedAt, finishedAt);
    assert.deepEqual(replayControl.terminalNotifyArgs, firstArgs);
    assert.deepEqual(buildNotifyArgs(chainDir, replayControl, "completed"), firstArgs);
  });

  it("rearm clears the terminal occurrence and a second termination at the same round mints another", () => {
    const { chainDir } = makeChainFixture(process.env.KUSABI_STATE_DIR);
    finalizeChainControl({ chainDir, status: "completed", round: 4 });
    const firstId = readChainControl(chainDir).terminalOccurrenceId;
    assert.equal(typeof firstId, "string");
    assert.notEqual(firstId, "");

    const rearmed = rearmChainControl({ chainDir, round: 4 });
    assert.equal(rearmed.status, "running");
    assert.equal(rearmed.round, 4);
    assert.equal(rearmed.terminalOccurrenceId, undefined);
    assert.equal(rearmed.terminalNotifyArgs, undefined);
    assert.equal(rearmed.finishedAt, undefined);

    finalizeChainControl({ chainDir, status: "completed", round: 4 });
    const secondControl = readChainControl(chainDir);
    assert.equal(typeof secondControl.terminalOccurrenceId, "string");
    assert.notEqual(secondControl.terminalOccurrenceId, "");
    assert.notEqual(secondControl.terminalOccurrenceId, firstId);
    assert.equal(secondControl.terminalNotifyArgs.occurrenceId, secondControl.terminalOccurrenceId);
  });

  it("stale-PID cancellation persists a matching occurrence snapshot", () => {
    const { chainDir } = makeChainFixture(process.env.KUSABI_STATE_DIR, {
      status: "running",
      pid: 0,
      disposition: "accept",
    });

    const result = requestChainStop(chainDir, "test");
    assert.equal(result.wasStale, true);
    const control = readChainControl(chainDir);
    assert.equal(control.status, "cancelled");
    assert.equal(typeof control.terminalOccurrenceId, "string");
    assert.notEqual(control.terminalOccurrenceId, "");
    assert.equal(control.terminalNotifyArgs.occurrenceId, control.terminalOccurrenceId);
    assert.equal(control.terminalNotifyArgs.status, "cancelled");
    assert.deepEqual(
      control.terminalNotifyArgs,
      buildNotifyArgs(chainDir, control, "cancelled"),
    );
  });

  it("legacy terminal control gains one stable occurrence and snapshot additively", () => {
    const originalFinishedAt = "2026-10-01T12:34:56.000Z";
    const { chainDir } = makeChainFixture(process.env.KUSABI_STATE_DIR, {
      status: "completed",
      finishedAt: originalFinishedAt,
    });

    const legacy = readChainControl(chainDir);
    assert.equal(legacy.terminalOccurrenceId, undefined);
    assert.equal(legacy.terminalNotifyArgs, undefined);
    finalizeChainControl({ chainDir, status: "completed", round: 4 });

    const first = readChainControl(chainDir);
    assert.equal(typeof first.terminalOccurrenceId, "string");
    assert.notEqual(first.terminalOccurrenceId, "");
    assert.equal(first.finishedAt, originalFinishedAt);
    assert.equal(first.terminalNotifyArgs.occurrenceId, first.terminalOccurrenceId);
    assert.deepEqual(
      first.terminalNotifyArgs,
      buildNotifyArgs(chainDir, first, "completed"),
    );

    finalizeChainControl({ chainDir, status: "completed", round: 4 });
    const replay = readChainControl(chainDir);
    assert.equal(replay.terminalOccurrenceId, first.terminalOccurrenceId);
    assert.equal(replay.finishedAt, originalFinishedAt);
    assert.deepEqual(replay.terminalNotifyArgs, first.terminalNotifyArgs);
  });
});
