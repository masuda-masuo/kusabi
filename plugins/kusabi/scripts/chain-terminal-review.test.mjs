import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  finalizeChainControl,
  readChainControl,
  rearmChainControl,
  requestChainStop,
  writeChainControl
} from "./chain-control.mjs";

const tempDirs = new Set();
const savedEnv = new Map();
for (const key of ["HOME", "KUSABI_STATE_DIR", "KUSABI_CHAIN_NOTIFY", "KAIBA_DB"]) {
  savedEnv.set(key, process.env[key]);
}

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-terminal-review-"));
  tempDirs.add(dir);
  const stateDir = path.join(dir, "state");
  const chainDir = path.join(stateDir, "chains", "chain-resume-stale-review");
  fs.mkdirSync(chainDir, { recursive: true });
  fs.writeFileSync(path.join(chainDir, "chain.json"), JSON.stringify({
    chainId: "chain-resume-stale-review",
    container: "fixture-container",
    brief: "# Resume stale review\\n\\nOrchestrator: test",
    records: [{ disposition: { disposition: "escalate", reason: "prior run judgment" } }]
  }, null, 2));
  fs.writeFileSync(path.join(chainDir, "control.json"), JSON.stringify({
    chainId: "chain-resume-stale-review",
    container: "fixture-container",
    pid: process.pid,
    status: "running",
    round: 4,
    startedAt: "2026-10-12T00:00:00.000Z"
  }, null, 2));
  return { dir, stateDir, chainDir, chainJsonPath: path.join(chainDir, "chain.json") };
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("resumed stale terminal cancellation disposition", () => {
  it("persists null for a stale resumed run without borrowing the prior occurrence judgment", () => {
    const fixture = makeFixture();
    process.env.HOME = path.join(fixture.dir, "home");
    process.env.KUSABI_STATE_DIR = fixture.stateDir;
    process.env.KUSABI_CHAIN_NOTIFY = "0";
    process.env.KAIBA_DB = path.join(fixture.dir, "kaiba.db");

    finalizeChainControl({ chainDir: fixture.chainDir, status: "completed", round: 4 });
    const oldControl = readChainControl(fixture.chainDir);
    const oldSnapshot = structuredClone(oldControl.terminalNotifyArgs);
    assert.equal(oldSnapshot.disposition, "escalate");
    const oldOccurrenceId = oldControl.terminalOccurrenceId;
    const chainJsonBefore = fs.readFileSync(fixture.chainJsonPath, "utf8");

    rearmChainControl({ chainDir: fixture.chainDir, round: 4 });
    writeChainControl(fixture.chainDir, {
      ...readChainControl(fixture.chainDir),
      pid: 0
    });
    const stop = requestChainStop(fixture.chainDir, "review-test");

    const current = readChainControl(fixture.chainDir);
    assert.equal(stop.wasStale, true);
    assert.equal(current.status, "cancelled");
    assert.equal(current.terminalNotifyArgs.status, "cancelled");
    assert.equal(current.terminalNotifyArgs.disposition, null);
    assert.notEqual(current.terminalOccurrenceId, oldOccurrenceId);
    assert.equal(current.terminalNotifyArgs.occurrenceId, current.terminalOccurrenceId);
    assert.deepEqual(oldControl.terminalNotifyArgs, oldSnapshot);
    assert.equal(fs.readFileSync(fixture.chainJsonPath, "utf8"), chainJsonBefore);
  });
});
