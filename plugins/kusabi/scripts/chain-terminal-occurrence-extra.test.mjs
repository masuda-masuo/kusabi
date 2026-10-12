import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readChainControl, requestChainStop, rearmChainControl } from "./chain-control.mjs";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-terminal-claim-race-"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function startPausedStop(chainDir, requestedBy, gate, index) {
  const workerUrl = new URL("./chain-control.mjs", import.meta.url).href;
  const code = `
    const { parentPort, workerData } = await import("node:worker_threads");
    const fs = (await import("node:fs")).default;
    const originalReadFileSync = fs.readFileSync;
    let paused = false;
    fs.readFileSync = function(filePath, ...args) {
      const value = originalReadFileSync.call(this, filePath, ...args);
      if (!paused && String(filePath).endsWith("/control.json")) {
        paused = true;
        parentPort.postMessage({ type: "snapshot-read", snapshot: JSON.parse(value) });
        const result = Atomics.wait(new Int32Array(workerData.gate), workerData.index, 0, 15_000);
        if (result === "timed-out") throw new Error("test did not release control snapshot barrier");
      }
      return value;
    };
    const { requestChainStop } = await import(workerData.moduleUrl);
    try {
      const result = requestChainStop(workerData.chainDir, workerData.requestedBy);
      parentPort.postMessage({ type: "result", result });
    } catch (error) {
      parentPort.postMessage({ type: "error", error: String(error?.stack || error) });
    }
  `;
  const worker = new Worker(code, {
    eval: true,
    workerData: { gate, index, moduleUrl: workerUrl, chainDir, requestedBy },
  });
  const messages = [];
  worker.on("message", (message) => messages.push(message));
  return {
    worker,
    waitFor(type) {
      const existing = messages.find((message) => message.type === type);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`worker did not report ${type}`));
        }, 20_000);
        const onMessage = (message) => {
          messages.push(message);
          if (message.type === type || message.type === "error") {
            cleanup();
            if (message.type === "error") reject(new Error(message.error));
            else resolve(message);
          }
        };
        const onError = (error) => {
          cleanup();
          reject(error);
        };
        const cleanup = () => {
          clearTimeout(timer);
          worker.off("message", onMessage);
          worker.off("error", onError);
        };
        worker.on("message", onMessage);
        worker.once("error", onError);
      });
    },
  };
}

function makeChain(chainDir) {
  fs.mkdirSync(chainDir, { recursive: true });
  writeJson(path.join(chainDir, "chain.json"), {
    chainId: "chain-race",
    container: "container-race",
    records: [{ disposition: { disposition: "accept", reason: "accepted" } }],
    brief: "# Atomic race regression\n\n",
  });
  writeJson(path.join(chainDir, "control.json"), {
    chainId: "chain-race",
    container: "container-race",
    pid: 0,
    status: "running",
    round: 7,
    startedAt: "2026-10-12T00:00:00.000Z",
  });
}

async function stopWorkers(workers) {
  await Promise.all(workers.map(({ worker }) => worker.terminate()));
}

describe("atomic terminal occurrence claim", () => {
  it("does not let an old stop cancel or retire the run rearmed after its snapshot", async () => {
    const tmpDir = makeTmpDir();
    const chainDir = path.join(tmpDir, "state", "chains", "chain-race");
    makeChain(chainDir);
    const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const caller = startPausedStop(chainDir, "old-caller", gate, 0);
    try {
      const observed = await caller.waitFor("snapshot-read");
      assert.equal(observed.snapshot.status, "running");
      assert.equal(observed.snapshot.terminalRunId, undefined);

      const rearmed = rearmChainControl({ chainDir, round: 8 });
      assert.equal(rearmed.status, "running");
      assert.equal(rearmed.round, 8);
      assert.ok(rearmed.terminalRunId);

      Atomics.store(new Int32Array(gate), 0, 1);
      Atomics.notify(new Int32Array(gate), 0);
      const result = (await caller.waitFor("result")).result;
      assert.equal(result.superseded, true);
      assert.equal(result.wasStale, false);

      const persisted = readChainControl(chainDir);
      assert.equal(persisted.status, "running");
      assert.equal(persisted.pid, rearmed.pid);
      assert.equal(persisted.round, 8);
      assert.equal(persisted.terminalRunId, rearmed.terminalRunId);
      assert.equal(persisted.stopRequestedAt, undefined);
      assert.equal(persisted.stopRequestedBy, undefined);
      assert.equal(persisted.terminalOccurrenceId, undefined);
      assert.equal(persisted.finishedAt, undefined);
      assert.equal(fs.existsSync(path.join(chainDir, ".terminal-occurrence-" +
        Buffer.from("2026-10-12T00:00:00.000Z").toString("hex") + ".claim")), false);
    } finally {
      await stopWorkers([caller]);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("gives two stale-stop callers the same persisted occurrence and snapshot", async () => {
    const tmpDir = makeTmpDir();
    const chainDir = path.join(tmpDir, "state", "chains", "chain-race");
    makeChain(chainDir);
    const gate = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
    const callers = [
      startPausedStop(chainDir, "caller-a", gate, 0),
      startPausedStop(chainDir, "caller-b", gate, 1),
    ];
    try {
      const observed = await Promise.all(callers.map((caller) => caller.waitFor("snapshot-read")));
      for (const message of observed) {
        assert.equal(message.snapshot.status, "running");
        assert.equal(message.snapshot.startedAt, "2026-10-12T00:00:00.000Z");
      }

      for (const index of [0, 1]) Atomics.store(new Int32Array(gate), index, 1);
      for (const index of [0, 1]) Atomics.notify(new Int32Array(gate), index);
      const results = (await Promise.all(callers.map((caller) => caller.waitFor("result"))))
        .map((message) => message.result);

      for (const result of results) {
        assert.equal(result.wasStale, true);
        assert.equal(typeof result.terminalOccurrenceId, "string");
        assert.notEqual(result.terminalOccurrenceId, "");
        assert.equal(result.terminalNotifyArgs.occurrenceId, result.terminalOccurrenceId);
      }
      assert.equal(results[0].terminalOccurrenceId, results[1].terminalOccurrenceId);
      assert.deepEqual(results[0].terminalNotifyArgs, results[1].terminalNotifyArgs);

      const persisted = readChainControl(chainDir);
      assert.equal(persisted.status, "cancelled");
      assert.equal(persisted.terminalOccurrenceId, results[0].terminalOccurrenceId);
      assert.deepEqual(persisted.terminalNotifyArgs, results[0].terminalNotifyArgs);
      assert.ok(["caller-a", "caller-b"].includes(persisted.stopRequestedBy));
      assert.equal(fs.existsSync(path.join(chainDir, ".control-write.lock")), false);
    } finally {
      await stopWorkers(callers);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reclaims dead-owner and aged ownerless locks after a crashed writer", () => {
    const tmpDir = makeTmpDir();
    const chainDir = path.join(tmpDir, "state", "chains", "chain-lock");
    makeChain(chainDir);
    const lockDir = path.join(chainDir, ".control-write.lock");
    fs.mkdirSync(lockDir);
    writeJson(path.join(lockDir, "owner.json"), { pid: 2_000_000_000, token: "dead-writer" });

    // A dead process owns no live critical section, so the next stop can
    // atomically move the lock aside, remove it, and finish normally.
    const stopped = requestChainStop(chainDir, "recovery");
    assert.equal(stopped.wasStale, true);
    assert.equal(readChainControl(chainDir).status, "cancelled");
    assert.equal(fs.existsSync(lockDir), false);

    fs.writeFileSync(path.join(chainDir, "control.json"), JSON.stringify({
      chainId: "chain-lock",
      container: "container-race",
      pid: 0,
      status: "running",
      startedAt: "2026-10-12T00:00:00.000Z",
    }));
    fs.mkdirSync(lockDir);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockDir, old, old);
    const second = requestChainStop(chainDir, "orphan-recovery");
    assert.equal(second.wasStale, true);
    assert.equal(readChainControl(chainDir).status, "cancelled");
    assert.equal(fs.existsSync(lockDir), false);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
