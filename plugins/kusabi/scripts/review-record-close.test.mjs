import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { closeReviewRecords, cmdReviewRecordClose, HISTORICAL_MARK_PREFIX } from "./review-record-close.mjs";
import { countUnfilledReviewRecords } from "./review-record-scan.mjs";
import { scanReviewRecords } from "./review-record-close.mjs";
import { adjudicateReviewRecord } from "./review-record-adjudicate.mjs";

const BEFORE = "2022-01-01T00:00:00.000Z";
const COMPANION = fileURLToPath(new URL("./kusabi-companion.mjs", import.meta.url));

function createStateRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-record-close-"));
}

function writeRecord(root, chain, finished = "2021-01-01T00:00:00.000Z") {
  const recordPath = path.join(root, "workspace-hash", "chains", chain, "review-record.md");
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  const finishedHeader = finished === null ? "" : `Orchestrator: test | finished: ${finished}\n`;
  const content = `# [review-record] repo ${chain}
${finishedHeader}## Findings adjudication (fill at inspection)
| # | severity | finding | 採否 | 理由 |
|---|---|---|---|---|
| 1 | low | old finding | _fill_ | _fill_ |
## 判例として (fill at inspection)
_fill: reusable precedent, if any_
`;
  fs.writeFileSync(recordPath, content);
  return recordPath;
}

describe("review-record-close", () => {
  it("does not target a record whose finished time is after --before", () => {
    const root = createStateRoot();
    try {
      const recordPath = writeRecord(root, "future", "2023-01-01T00:00:00.000Z");
      const result = closeReviewRecords({ before: BEFORE, stateRootDir: root });
      assert.deepEqual(result.targets, []);
      assert.deepEqual(result.skipped, []);
      assert.equal(fs.readFileSync(recordPath, "utf8").includes(HISTORICAL_MARK_PREFIX), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("dry-run lists the target and leaves its file byte-identical", () => {
    const root = createStateRoot();
    try {
      const recordPath = writeRecord(root, "dry-run");
      const before = fs.readFileSync(recordPath);
      const output = cmdReviewRecordClose(["--historical", "--before", BEFORE, "--state-root", root]);
      assert.equal(output, `Targets: 1\ntarget: ${recordPath}\nSkipped: 0`);
      assert.deepEqual(fs.readFileSync(recordPath), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips an unadjudicated record without the exact adjudication heading before apply", () => {
    const root = createStateRoot();
    try {
      const recordPath = writeRecord(root, "alternate-heading");
      const original = fs.readFileSync(recordPath, "utf8").replace(
        "## Findings adjudication (fill at inspection)",
        "## Findings adjudication",
      );
      fs.writeFileSync(recordPath, original);
      const before = fs.readFileSync(recordPath);
      const result = scanReviewRecords({ before: BEFORE, stateRootDir: root });
      assert.deepEqual(result.targets, []);
      assert.deepEqual(result.skipped, [{ path: recordPath, reason: "no adjudication heading" }]);
      const output = cmdReviewRecordClose(["--historical", "--before", BEFORE, "--apply", "--state-root", root]);
      assert.ok(output.includes("skipped: no adjudication heading:"));
      assert.deepEqual(fs.readFileSync(recordPath), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("apply inserts exactly one mark under the heading and preserves the fill rows", () => {
    const root = createStateRoot();
    try {
      const recordPath = writeRecord(root, "apply");
      const before = fs.readFileSync(recordPath, "utf8");
      const result = closeReviewRecords({ before: BEFORE, stateRootDir: root, apply: true });
      const after = fs.readFileSync(recordPath, "utf8");
      const expected = before.replace(
        "## Findings adjudication (fill at inspection)\n",
        `## Findings adjudication (fill at inspection)\n${HISTORICAL_MARK_PREFIX}${BEFORE} -->\n`,
      );
      assert.deepEqual(result.targets, [recordPath]);
      assert.equal(result.written, 1);
      assert.equal(after, expected);
      assert.equal(after.split("| 1 | low | old finding | _fill_ | _fill_ |").length - 1, 1);
      assert.match(after, /## Findings adjudication \(fill at inspection\)\n<!-- historical: not adjudicated; closed by review-record-close before 2022-01-01T00:00:00\.000Z -->\n/);
      assert.equal(countUnfilledReviewRecords(root), 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("second apply writes nothing and leaves the record identical", () => {
    const root = createStateRoot();
    try {
      const recordPath = writeRecord(root, "idempotent");
      closeReviewRecords({ before: BEFORE, stateRootDir: root, apply: true });
      const firstApply = fs.readFileSync(recordPath);
      const result = closeReviewRecords({ before: BEFORE, stateRootDir: root, apply: true });
      assert.deepEqual(result.targets, []);
      assert.equal(result.written, 0);
      assert.deepEqual(fs.readFileSync(recordPath), firstApply);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists records without a parseable finished time as skipped and does not write them", () => {
    const root = createStateRoot();
    try {
      const recordPath = writeRecord(root, "missing-finished", null);
      const before = fs.readFileSync(recordPath);
      const result = closeReviewRecords({ before: BEFORE, stateRootDir: root, apply: true });
      assert.deepEqual(result.targets, []);
      assert.deepEqual(result.skipped, [{ path: recordPath, reason: "no finished time" }]);
      assert.equal(result.written, 0);
      assert.deepEqual(fs.readFileSync(recordPath), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an unparseable --before value with non-zero exit and no writes", () => {
    const root = createStateRoot();
    try {
      const recordPath = writeRecord(root, "invalid-before");
      const before = fs.readFileSync(recordPath);
      const result = spawnSync(process.execPath, [
        COMPANION,
        "review-record-close",
        "--historical",
        "--before",
        "not-a-date",
        "--apply",
        "--state-root",
        root,
      ], {
        encoding: "utf8",
        env: { ...process.env, KUSABI_STATE_DIR: root },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /--before must be a parseable date: not-a-date/);
      assert.deepEqual(fs.readFileSync(recordPath), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires --historical and prints usage with non-zero exit", () => {
    const root = createStateRoot();
    try {
      const result = spawnSync(process.execPath, [
        COMPANION,
        "review-record-close",
        "--before",
        BEFORE,
        "--state-root",
        root,
      ], {
        encoding: "utf8",
        env: { ...process.env, KUSABI_STATE_DIR: root },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /Usage: kusabi-companion review-record-close/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("mid-failure on second of three targets leaves none of the targets modified", () => {
    const root = createStateRoot();
    try {
      const record1 = writeRecord(root, "chain-1");
      const record2 = writeRecord(root, "chain-2");
      const record3 = writeRecord(root, "chain-3");

      const before1 = fs.readFileSync(record1, "utf8");
      const before2 = fs.readFileSync(record2, "utf8");
      const before3 = fs.readFileSync(record3, "utf8");

      let tempWriteCount = 0;
      const originalWriteFileSync = fs.writeFileSync;
      const writeSpy = mock.method(fs, "writeFileSync", (file, data, options) => {
        if (typeof file === "string" && file.includes(".tmp")) {
          tempWriteCount += 1;
          if (tempWriteCount === 2) {
            throw new Error("simulated failure on second target");
          }
        }
        return originalWriteFileSync(file, data, options);
      });

      try {
        assert.throws(
          () => closeReviewRecords({ before: BEFORE, stateRootDir: root, apply: true }),
          /simulated failure on second target/,
        );
      } finally {
        writeSpy.mock.restore();
      }

      assert.equal(fs.readFileSync(record1, "utf8"), before1);
      assert.equal(fs.readFileSync(record2, "utf8"), before2);
      assert.equal(fs.readFileSync(record3, "utf8"), before3);

      for (const chain of ["chain-1", "chain-2", "chain-3"]) {
        const chainDir = path.join(root, "workspace-hash", "chains", chain);
        const files = fs.readdirSync(chainDir);
        assert.deepEqual(files.filter((f) => f.includes(".tmp")), []);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves symlinks and file mode after close apply", () => {
    const root = createStateRoot();
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-real-record-"));
    try {
      const realRecordPath = path.join(realDir, "real-review-record.md");
      const content = `# [review-record] repo chain-symlink\nOrchestrator: test | finished: 2021-01-01T00:00:00.000Z\n## Findings adjudication (fill at inspection)\n| # | severity | finding | 採否 | 理由 |\n|---|---|---|---|---|\n| 1 | low | old finding | _fill_ | _fill_ |\n## 判例として (fill at inspection)\n_fill: reusable precedent, if any_\n`;
      fs.writeFileSync(realRecordPath, content);
      fs.chmodSync(realRecordPath, 0o640);

      const chainDir = path.join(root, "workspace-hash", "chains", "chain-symlink");
      fs.mkdirSync(chainDir, { recursive: true });
      const recordLink = path.join(chainDir, "review-record.md");
      fs.symlinkSync(realRecordPath, recordLink);

      assert.ok(fs.lstatSync(recordLink).isSymbolicLink());

      const result = closeReviewRecords({ before: BEFORE, stateRootDir: root, apply: true });
      assert.deepEqual(result.targets, [recordLink]);
      assert.equal(result.written, 1);

      assert.ok(fs.lstatSync(recordLink).isSymbolicLink(), "recordPath must remain a symlink");
      assert.equal(fs.realpathSync(recordLink), fs.realpathSync(realRecordPath));

      const mode = fs.statSync(recordLink).mode & 0o777;
      assert.equal(mode.toString(8), (0o640).toString(8));

      const updated = fs.readFileSync(recordLink, "utf8");
      assert.ok(updated.includes(HISTORICAL_MARK_PREFIX));
    } finally {
      fs.rmSync(realDir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unsafe --before values containing HTML comment markers or newlines", () => {
    const root = createStateRoot();
    try {
      writeRecord(root, "unsafe-test");
      for (const bad of ["2022-01-01 --> injection", "2022-01-01 -- comment", "2022-01-01\n<script>", "2022-01-01>"]) {
        assert.throws(
          () => closeReviewRecords({ before: bad, stateRootDir: root, apply: true }),
          /invalid characters|--before must be a parseable date/,
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("adjudicate writes a verdict to record X after close scan of X and before close write: verdict is still in file after close", async () => {
    const root = createStateRoot();
    const cwd = path.join(os.tmpdir(), "kusabi-close-race-cwd");
    const workspaceHash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12);
    const chain = "chain-race";
    const chainDir = path.join(root, workspaceHash, "chains", chain);
    const recordPath = path.join(chainDir, "review-record.md");
    fs.mkdirSync(chainDir, { recursive: true });

    const content = `# [review-record] repo ${chain}\nOrchestrator: test | finished: 2021-01-01T00:00:00.000Z\n## Findings adjudication (fill at inspection)\n| # | severity | finding | 採否 | 理由 |\n|---|---|---|---|---|\n| 1 | low | old finding | _fill_ | _fill_ |\n## 判例として (fill at inspection)\n_fill: reusable precedent, if any_\n`;
    fs.writeFileSync(recordPath, content);

    const sab = new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT);
    const barrier = new Int32Array(sab);

    const closeUrl = new URL("./review-record-close.mjs", import.meta.url).href;
    const workerCode = `
      const { parentPort, workerData } = await import("node:worker_threads");
      const fs = (await import("node:fs")).default;
      const barrier = new Int32Array(workerData.sab);
      const originalReadFileSync = fs.readFileSync;
      let scanned = false;
      fs.readFileSync = function(filePath, ...args) {
        const res = originalReadFileSync.call(this, filePath, ...args);
        if (!scanned && String(filePath).endsWith("review-record.md")) {
          scanned = true;
          Atomics.store(barrier, 0, 1);
          Atomics.notify(barrier, 0);
          Atomics.wait(barrier, 1, 0, 10_000);
        }
        return res;
      };
      const { closeReviewRecords } = await import(workerData.closeUrl);
      try {
        const result = closeReviewRecords({
          before: workerData.before,
          stateRootDir: workerData.root,
          apply: true,
        });
        parentPort.postMessage({ type: "done", result });
      } catch (error) {
        parentPort.postMessage({ type: "error", error: String(error?.stack || error) });
      }
    `;

    const worker = new Worker(workerCode, {
      eval: true,
      workerData: { closeUrl, before: BEFORE, root, sab },
    });

    try {
      let workerDone = null;
      worker.on("message", (msg) => {
        if (msg.type === "done") workerDone = msg.result;
        if (msg.type === "error") throw new Error(msg.error);
      });

      const scanWait = Atomics.wait(barrier, 0, 0, 10_000);
      assert.notEqual(scanWait, "timed-out");

      const originalMainReadFileSync = fs.readFileSync;
      let lockSignalled = false;
      fs.readFileSync = function(filePath, ...args) {
        const res = originalMainReadFileSync.call(this, filePath, ...args);
        if (!lockSignalled && String(filePath).endsWith("review-record.md")) {
          lockSignalled = true;
          Atomics.store(barrier, 1, 1);
          Atomics.notify(barrier, 1);
          Atomics.wait(barrier, 2, 0, 50);
        }
        return res;
      };

      try {
        adjudicateReviewRecord({
          chainId: chain,
          argv: ["--row", "1", "--verdict", "accept", "--reason", "adjudicated in race"],
          stateRootDir: root,
          cwd,
        });
      } finally {
        fs.readFileSync = originalMainReadFileSync;
      }

      if (!workerDone) {
        await new Promise((resolve, reject) => {
          const onDone = (msg) => {
            if (msg.type === "done") {
              worker.off("message", onDone);
              resolve();
            }
            if (msg.type === "error") reject(new Error(msg.error));
          };
          worker.on("message", onDone);
          worker.on("error", reject);
        });
      }

      const updatedContent = fs.readFileSync(recordPath, "utf8");
      assert.equal(workerDone.written, 0);
      assert.deepEqual(workerDone.skipped, [{ path: recordPath, reason: "changed since scan" }]);
      assert.ok(updatedContent.includes("採用"));
      assert.ok(!updatedContent.includes(HISTORICAL_MARK_PREFIX));
    } finally {
      await worker.terminate();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a record already marked or adjudicated between scan and lock is not written by close and appears in skipped", () => {
    const root = createStateRoot();
    try {
      const record1 = writeRecord(root, "chain-1");
      const record2 = writeRecord(root, "chain-2");
      const record3 = writeRecord(root, "chain-3");

      let record2Scanned = false;
      let record3Scanned = false;
      const originalReadFileSync = fs.readFileSync;
      const readSpy = mock.method(fs, "readFileSync", function(filePath, ...args) {
        const result = originalReadFileSync.call(this, filePath, ...args);
        if (typeof filePath === "string") {
          if (filePath === record2 && !record2Scanned) {
            record2Scanned = true;
            const adjudicated = result.replace("| 1 | low | old finding | _fill_ | _fill_ |", "| 1 | low | old finding | 採択 | adjudicated |");
            fs.writeFileSync(record2, adjudicated);
          } else if (filePath === record3 && !record3Scanned) {
            record3Scanned = true;
            const marked = result.replace(
              "## Findings adjudication (fill at inspection)\n",
              `## Findings adjudication (fill at inspection)\n${HISTORICAL_MARK_PREFIX}${BEFORE} -->\n`,
            );
            fs.writeFileSync(record3, marked);
          }
        }
        return result;
      });

      try {
        const result = closeReviewRecords({ before: BEFORE, stateRootDir: root, apply: true });
        assert.deepEqual(result.targets, [record1]);
        assert.equal(result.written, 1);
        assert.deepEqual(result.skipped, [
          { path: record2, reason: "changed since scan" },
          { path: record3, reason: "changed since scan" },
        ]);
        assert.ok(fs.readFileSync(record1, "utf8").includes(HISTORICAL_MARK_PREFIX));
        assert.ok(fs.readFileSync(record2, "utf8").includes("採択 | adjudicated |"));
        assert.ok(!fs.readFileSync(record2, "utf8").includes(HISTORICAL_MARK_PREFIX));
        assert.ok(fs.readFileSync(record3, "utf8").includes(HISTORICAL_MARK_PREFIX));
      } finally {
        readSpy.mock.restore();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("acquires locks in ascending alphabetical order of directory list across multiple targets", () => {
    const root = createStateRoot();
    try {
      writeRecord(root, "chain-z");
      writeRecord(root, "chain-a");
      writeRecord(root, "chain-m");

      const lockOrder = [];
      const originalMkdirSync = fs.mkdirSync;
      const mkdirSpy = mock.method(fs, "mkdirSync", function(dirPath, options) {
        if (typeof dirPath === "string" && dirPath.endsWith(".control-write.lock")) {
          lockOrder.push(path.basename(path.dirname(dirPath)));
        }
        return originalMkdirSync.call(this, dirPath, options);
      });

      try {
        const result = closeReviewRecords({ before: BEFORE, stateRootDir: root, apply: true });
        assert.equal(result.written, 3);
        assert.deepEqual(lockOrder, ["chain-a", "chain-m", "chain-z"]);
      } finally {
        mkdirSpy.mock.restore();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
