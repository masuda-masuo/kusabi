import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { listReviewRecords, cmdReviewRecordList } from "./review-record-list.mjs";
import { validateBefore, HISTORICAL_MARK_PREFIX } from "./review-record-close.mjs";

const COMPANION = fileURLToPath(new URL("./kusabi-companion.mjs", import.meta.url));

function createStateRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-record-list-"));
}

function writeRecord(root, chain, {
  status = "unadjudicated",
  finished = "2021-01-01T00:00:00.000Z",
  unfilledCount = 1,
} = {}) {
  const recordPath = path.join(root, "workspace-hash", "chains", chain, "review-record.md");
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });

  const finishedHeader = finished === null ? "" : `Orchestrator: test | finished: ${finished}\n`;
  const mark = status === "historical"
    ? `${HISTORICAL_MARK_PREFIX}2022-01-01T00:00:00.000Z -->\n`
    : "";

  let tableRows = "";
  if (status === "adjudicated") {
    tableRows = "| 1 | low | finding 1 | 採用 | reason |\n";
  } else {
    for (let index = 1; index <= unfilledCount; index += 1) {
      tableRows += `| ${index} | low | finding ${index} | _fill_ | _fill_ |\n`;
    }
  }

  const content = `# [review-record] repo ${chain}
${finishedHeader}## Findings adjudication (fill at inspection)
${mark}| # | severity | finding | 採否 | 理由 |
|---|---|---|---|---|
${tableRows}## 判例として (fill at inspection)
_fill: reusable precedent, if any_
`;

  fs.writeFileSync(recordPath, content);
  return recordPath;
}

describe("review-record-list", () => {
  it("criterion (a): mixed records in a temp state root — default output lists only the unadjudicated chain, with exact row", () => {
    const root = createStateRoot();
    try {
      const p1 = writeRecord(root, "chain-1-unadjudicated", {
        status: "unadjudicated",
        finished: "2021-01-01T00:00:00.000Z",
        unfilledCount: 2,
      });
      writeRecord(root, "chain-2-adjudicated", {
        status: "adjudicated",
        finished: "2021-02-01T00:00:00.000Z",
      });
      writeRecord(root, "chain-3-historical", {
        status: "historical",
        finished: "2021-03-01T00:00:00.000Z",
      });

      const expectedRow = `chain-1-unadjudicated\t2021-01-01T00:00:00.000Z\t2\t${p1}`;
      const output = cmdReviewRecordList(["--state-root", root]);
      assert.equal(output, expectedRow);

      const fnOutput = listReviewRecords({ stateRootDir: root });
      assert.equal(fnOutput, expectedRow);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("criterion (b): --all lists all three with exact status values", () => {
    const root = createStateRoot();
    try {
      const p1 = writeRecord(root, "chain-1-unadjudicated", {
        status: "unadjudicated",
        finished: "2021-01-01T00:00:00.000Z",
        unfilledCount: 1,
      });
      const p2 = writeRecord(root, "chain-2-adjudicated", {
        status: "adjudicated",
        finished: "2021-02-01T00:00:00.000Z",
      });
      const p3 = writeRecord(root, "chain-3-historical", {
        status: "historical",
        finished: "2021-03-01T00:00:00.000Z",
      });

      const expected = [
        `unadjudicated\tchain-1-unadjudicated\t2021-01-01T00:00:00.000Z\t1\t${p1}`,
        `adjudicated\tchain-2-adjudicated\t2021-02-01T00:00:00.000Z\t0\t${p2}`,
        `historical\tchain-3-historical\t2021-03-01T00:00:00.000Z\t0\t${p3}`,
      ].join("\n");

      const output = cmdReviewRecordList(["--all", "--state-root", root]);
      assert.equal(output, expected);

      const fnOutput = listReviewRecords({ all: true, stateRootDir: root });
      assert.equal(fnOutput, expected);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("criterion (c): --before with a date between two finished times keeps only earlier record in default and --all", () => {
    const root = createStateRoot();
    try {
      const p1 = writeRecord(root, "chain-1-early", {
        status: "unadjudicated",
        finished: "2021-01-01T00:00:00.000Z",
        unfilledCount: 1,
      });
      writeRecord(root, "chain-2-late", {
        status: "unadjudicated",
        finished: "2021-03-01T00:00:00.000Z",
        unfilledCount: 1,
      });
      writeRecord(root, "chain-3-noheader", {
        status: "unadjudicated",
        finished: null,
      });

      const cutoff = "2021-02-01T00:00:00.000Z";

      // Default mode with --before
      const defaultOutput = cmdReviewRecordList(["--before", cutoff, "--state-root", root]);
      assert.equal(defaultOutput, `chain-1-early\t2021-01-01T00:00:00.000Z\t1\t${p1}`);

      const fnDefault = listReviewRecords({ before: cutoff, stateRootDir: root });
      assert.equal(fnDefault, `chain-1-early\t2021-01-01T00:00:00.000Z\t1\t${p1}`);

      // --all mode with --before
      const allOutput = cmdReviewRecordList(["--all", "--before", cutoff, "--state-root", root]);
      assert.equal(allOutput, `unadjudicated\tchain-1-early\t2021-01-01T00:00:00.000Z\t1\t${p1}`);

      const fnAll = listReviewRecords({ all: true, before: cutoff, stateRootDir: root });
      assert.equal(fnAll, `unadjudicated\tchain-1-early\t2021-01-01T00:00:00.000Z\t1\t${p1}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("criterion (d): --before with an invalid date throws the same message as close's validateBefore", () => {
    const invalidDate = "not-a-valid-date";
    let expectedMessage;
    try {
      validateBefore(invalidDate);
    } catch (error) {
      expectedMessage = error.message;
    }
    assert.ok(expectedMessage);

    // cmdReviewRecordList throws
    assert.throws(
      () => cmdReviewRecordList(["--before", invalidDate]),
      { message: expectedMessage },
    );

    // listReviewRecords throws
    assert.throws(
      () => listReviewRecords({ before: invalidDate }),
      { message: expectedMessage },
    );

    // Invalid characters error also matches validateBefore
    const invalidChars = "2021-01-01-->bad";
    let invalidCharMessage;
    try {
      validateBefore(invalidChars);
    } catch (error) {
      invalidCharMessage = error.message;
    }
    assert.throws(
      () => cmdReviewRecordList(["--before", invalidChars]),
      { message: invalidCharMessage },
    );
  });

  it("criterion (e): an empty state root prints the exact empty-message string for each mode", () => {
    const root = createStateRoot();
    try {
      // Default mode
      const defaultOutput = cmdReviewRecordList(["--state-root", root]);
      assert.equal(defaultOutput, "No unadjudicated review records.");

      const fnDefault = listReviewRecords({ stateRootDir: root });
      assert.equal(fnDefault, "No unadjudicated review records.");

      // --all mode
      const allOutput = cmdReviewRecordList(["--all", "--state-root", root]);
      assert.equal(allOutput, "No review records.");

      const fnAll = listReviewRecords({ all: true, stateRootDir: root });
      assert.equal(fnAll, "No review records.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("criterion (f): listing does not create, modify, or lock anything", () => {
    const root = createStateRoot();
    try {
      const recordPath = writeRecord(root, "chain-clean", {
        status: "unadjudicated",
        finished: "2021-01-01T00:00:00.000Z",
      });
      const chainDir = path.dirname(recordPath);

      const bytesBefore = fs.readFileSync(recordPath);
      const statBefore = fs.statSync(recordPath);
      const dirEntriesBefore = fs.readdirSync(chainDir);

      // Run listing in both modes
      cmdReviewRecordList(["--state-root", root]);
      cmdReviewRecordList(["--all", "--state-root", root]);
      listReviewRecords({ stateRootDir: root });
      listReviewRecords({ all: true, stateRootDir: root });

      const bytesAfter = fs.readFileSync(recordPath);
      const statAfter = fs.statSync(recordPath);
      const dirEntriesAfter = fs.readdirSync(chainDir);

      assert.deepEqual(bytesAfter, bytesBefore);
      assert.equal(statAfter.mtimeMs, statBefore.mtimeMs);
      assert.deepEqual(dirEntriesAfter, dirEntriesBefore);
      assert.equal(dirEntriesAfter.includes(".lock"), false);
      assert.equal(dirEntriesAfter.some((f) => f.endsWith(".lock")), false);
      assert.equal(dirEntriesAfter.some((f) => f.startsWith("control")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows '-' as created when record has no parseable finished header", () => {
    const root = createStateRoot();
    try {
      const p1 = writeRecord(root, "chain-no-header", {
        status: "unadjudicated",
        finished: null,
        unfilledCount: 1,
      });

      const output = cmdReviewRecordList(["--state-root", root]);
      assert.equal(output, `chain-no-header\t-\t1\t${p1}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("companion CLI dispatch review-record-list runs via child process", () => {
    const root = createStateRoot();
    try {
      const p1 = writeRecord(root, "chain-cli", {
        status: "unadjudicated",
        finished: "2021-01-01T00:00:00.000Z",
        unfilledCount: 1,
      });

      const result = spawnSync(
        process.execPath,
        [COMPANION, "review-record-list", "--state-root", root],
        { encoding: "utf8", env: { ...process.env, KUSABI_STATE_DIR: root } },
      );
      assert.equal(result.status, 0);
      assert.equal(result.stdout.trim(), `chain-cli\t2021-01-01T00:00:00.000Z\t1\t${p1}`);

      const resultAll = spawnSync(
        process.execPath,
        [COMPANION, "review-record-list", "--all", "--state-root", root],
        { encoding: "utf8", env: { ...process.env, KUSABI_STATE_DIR: root } },
      );
      assert.equal(resultAll.status, 0);
      assert.equal(resultAll.stdout.trim(), `unadjudicated\tchain-cli\t2021-01-01T00:00:00.000Z\t1\t${p1}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
