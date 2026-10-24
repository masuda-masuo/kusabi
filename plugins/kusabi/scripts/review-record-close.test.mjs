import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { closeReviewRecords, cmdReviewRecordClose, HISTORICAL_MARK_PREFIX } from "./review-record-close.mjs";
import { countUnfilledReviewRecords } from "./review-record-scan.mjs";
import { scanReviewRecords } from "./review-record-close.mjs";

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
});
