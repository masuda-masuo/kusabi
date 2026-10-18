import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { cmdReviewRecordAdjudicate } from "./review-record-adjudicate.mjs";
import { countUnfilledReviewRecords } from "./review-record-scan.mjs";
import { formatAdjudicationRow, parseAdjudicationRow } from "./review-record-table.mjs";

const FINDINGS = "## Findings adjudication (fill at inspection)";
const PRECEDENT = "## 判例として (fill at inspection)";
const CWD = path.join(os.tmpdir(), "kusabi-adjudicate-test-workspace");
const WORKSPACE_HASH = crypto.createHash("sha256").update(CWD).digest("hex").slice(0, 12);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-record-adjudicate-"));
  const recordPath = path.join(root, WORKSPACE_HASH, "chains", "chain-test", "review-record.md");
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  const content = [
    "# [review-record] repo chain-test",
    "Orchestrator: test | finished: 2026-10-18T00:00:00.000Z",
    FINDINGS,
    "",
    "| # | severity | finding | 採否 | 理由 |",
    "|---|---|---|---|---|",
    "| 1 | low | finding one | _fill_ | _fill_ |",
    "| 2 | medium | finding two | _fill_ | _fill_ |",
    "| 3 | high | finding three | _fill_ | _fill_ |",
    "",
    PRECEDENT,
    "",
    "_fill: reusable precedent, if any_",
    "",
    "## Usage",
    "input=0",
    "",
  ].join("\n");
  fs.writeFileSync(recordPath, content);
  return { root, recordPath, content };
}

function run(root, ...args) {
  return cmdReviewRecordAdjudicate(["chain-test", ...args, "--state-root", root], { cwd: CWD });
}

function rows(content) {
  const section = content.split(FINDINGS)[1].split(/^## /m)[0];
  return section.split(/\r?\n/).filter((line) => /^\s*\|\s*\d+\s*\|/.test(line));
}

function cells(line) {
  return line.trim().slice(1, -1).split(/(?<!\\)\|/).map((cell) => cell.trim());
}

describe("review-record-adjudicate", () => {
  it("a. maps each verdict to its exact Japanese cell value", () => {
    const values = [["accept", "採用"], ["reject", "棄却"], ["open-unverified", "保留（未検証）"]];
    const { root, recordPath } = fixture();
    try {
      for (const [index, [verdict, expected]] of values.entries()) {
        run(root, "--row", String(index + 1), "--verdict", verdict, "--reason", "理由");
        assert.equal(cells(rows(fs.readFileSync(recordPath, "utf8"))[index])[3], expected);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("b. appends evidence in the exact reason cell format", () => {
    const { root, recordPath } = fixture();
    try {
      run(root, "--row", "1", "--verdict", "accept", "--reason", "妥当", "--evidence", "test passed");
      assert.equal(cells(rows(fs.readFileSync(recordPath, "utf8"))[0])[4], "妥当（根拠: test passed）");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("c. refuses repeat adjudication unchanged, then --force changes only that row", () => {
    const { root, recordPath } = fixture();
    try {
      run(root, "--row", "1", "--verdict", "accept", "--reason", "first");
      const beforeRefusal = fs.readFileSync(recordPath);
      assert.throws(() => run(root, "--row", "1", "--verdict", "reject", "--reason", "second"), /already has a verdict/);
      assert.deepEqual(fs.readFileSync(recordPath), beforeRefusal);
      const beforeForce = beforeRefusal.toString("utf8").split(/\r?\n/);
      run(root, "--row", "1", "--verdict", "reject", "--reason", "second", "--force");
      const afterForce = fs.readFileSync(recordPath, "utf8").split(/\r?\n/);
      assert.equal(afterForce.filter((line, index) => line !== beforeForce[index]).length, 1);
      assert.equal(cells(rows(afterForce.join("\n"))[0])[3], "棄却");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("d. refuses an out-of-range row without changing the file", () => {
    const { root, recordPath } = fixture();
    try {
      const before = fs.readFileSync(recordPath);
      assert.throws(() => run(root, "--row", "4", "--verdict", "accept", "--reason", "理由"), /outside the adjudication table/);
      assert.deepEqual(fs.readFileSync(recordPath), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("e. escapes pipes and refuses newlines while preserving table cell counts", () => {
    const { root, recordPath } = fixture();
    try {
      run(root, "--row", "1", "--verdict", "accept", "--reason", "left|right");
      const content = fs.readFileSync(recordPath, "utf8");
      const firstRow = rows(content)[0];
      assert.equal(cells(firstRow)[4], "left\\|right");
      assert.equal(cells(firstRow).length, 5);
      assert.equal(parseAdjudicationRow(firstRow).cells[4], "left|right");
      const before = fs.readFileSync(recordPath);
      assert.throws(() => run(root, "--row", "2", "--verdict", "accept", "--reason", "two\nlines"), /cannot contain newlines/);
      assert.deepEqual(fs.readFileSync(recordPath), before);
      assert.ok(rows(fs.readFileSync(recordPath, "utf8")).every((line) => cells(line).length === 5));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("l. refuses a trailing backslash in reason without changing the file", () => {
    const { root, recordPath } = fixture();
    try {
      const before = fs.readFileSync(recordPath);
      assert.throws(
        () => run(root, "--row", "1", "--verdict", "accept", "--reason", "ends\\"),
        /cannot contain newlines or backslashes/,
      );
      assert.deepEqual(fs.readFileSync(recordPath), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("m. refuses a middle backslash in reason without changing the file", () => {
    const { root, recordPath } = fixture();
    try {
      const before = fs.readFileSync(recordPath);
      assert.throws(
        () => run(root, "--row", "1", "--verdict", "accept", "--reason", "a\\b"),
        /cannot contain newlines or backslashes/,
      );
      assert.deepEqual(fs.readFileSync(recordPath), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("n. refuses a backslash in evidence without changing the file", () => {
    const { root, recordPath } = fixture();
    try {
      const before = fs.readFileSync(recordPath);
      assert.throws(
        () => run(root, "--row", "1", "--verdict", "accept", "--reason", "valid", "--evidence", "a\\b"),
        /cannot contain newlines or backslashes/,
      );
      assert.deepEqual(fs.readFileSync(recordPath), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("f. writes precedent under its heading, refuses a second write, and preserves verdict cells", () => {
    const { root, recordPath } = fixture();
    try {
      run(root, "--row", "1", "--verdict", "accept", "--reason", "理由");
      const beforeVerdicts = rows(fs.readFileSync(recordPath, "utf8")).map((line) => cells(line)[3]);
      run(root, "--precedent", "Reusable rule");
      let content = fs.readFileSync(recordPath, "utf8");
      assert.ok(content.includes(PRECEDENT + "\nReusable rule"));
      assert.deepEqual(rows(content).map((line) => cells(line)[3]), beforeVerdicts);
      const beforeRefusal = fs.readFileSync(recordPath);
      assert.throws(() => run(root, "--precedent", "another rule"), /already has content/);
      assert.deepEqual(fs.readFileSync(recordPath), beforeRefusal);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("g. the real scanner stops counting after every row is adjudicated", () => {
    const { root } = fixture();
    try {
      assert.equal(countUnfilledReviewRecords(root), 1);
      run(root, "--row", "1", "--verdict", "accept", "--reason", "one");
      run(root, "--row", "2", "--verdict", "reject", "--reason", "two");
      run(root, "--row", "3", "--verdict", "open-unverified", "--reason", "three");
      assert.equal(countUnfilledReviewRecords(root), 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("h. refuses --row together with --precedent and leaves the file unchanged", () => {
    const { root, recordPath } = fixture();
    try {
      const before = fs.readFileSync(recordPath);
      assert.throws(() => run(root, "--row", "1", "--precedent", "mixed", "--verdict", "accept", "--reason", "reason"),
        /--row and --precedent cannot be used together/);
      assert.deepEqual(fs.readFileSync(recordPath), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("i. adjudicates findings with pipes, refuses short rows without writing, and keeps other rows adjudicable", () => {
    const { root, recordPath } = fixture();
    try {
      const withPipe = fs.readFileSync(recordPath, "utf8").replace(
        "| 1 | low | finding one | _fill_ | _fill_ |",
        "| 1 | low | finding | title | _fill_ | _fill_ |",
      );
      fs.writeFileSync(recordPath, withPipe);
      run(root, "--row", "1", "--verdict", "accept", "--reason", "reason");
      let content = fs.readFileSync(recordPath, "utf8");
      let first = parseAdjudicationRow(rows(content)[0]);
      assert.equal(first.cells[2], "finding | title");
      assert.equal(first.cells[3], "採用");
      assert.equal(first.cells[4], "reason");

      content = content.replace("| 3 | high | finding three | _fill_ | _fill_ |", "| 3 | high | short row | _fill_ |");
      fs.writeFileSync(recordPath, content);
      const before = fs.readFileSync(recordPath);
      assert.throws(
        () => run(root, "--row", "3", "--verdict", "accept", "--reason", "reason"),
        /row 3 has fewer than 5 cells/,
      );
      assert.deepEqual(fs.readFileSync(recordPath), before);
      run(root, "--row", "2", "--verdict", "accept", "--reason", "valid row");
      assert.equal(parseAdjudicationRow(rows(fs.readFileSync(recordPath, "utf8"))[1]).cells[3], "採用");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves finding bytes through repeated --force runs on a pipe row", () => {
    const { root, recordPath } = fixture();
    try {
      const original = fs.readFileSync(recordPath, "utf8").replace(
        "| 1 | low | finding one | _fill_ | _fill_ |",
        "| 1 | low | finding | title | _fill_ | _fill_ |",
      );
      fs.writeFileSync(recordPath, original);
      const findingBytes = "| finding | title |";

      for (const [verdict, reason] of [["accept", "first"], ["reject", "second"]]) {
        run(root, "--row", "1", "--verdict", verdict, "--reason", reason, "--force");
        const content = fs.readFileSync(recordPath, "utf8");
        const row = rows(content)[0];
        assert.ok(row.includes(findingBytes));
        assert.equal(parseAdjudicationRow(row).cells[2], "finding | title");
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("adjudicates a finding containing a literal backslash-pipe", () => {
    const { root, recordPath } = fixture();
    try {
      const original = fs.readFileSync(recordPath, "utf8");
      const row = formatAdjudicationRow(["1", "low", "finding \\| title", "_fill_", "_fill_"]);
      fs.writeFileSync(recordPath, original.replace(
        "| 1 | low | finding one | _fill_ | _fill_ |",
        row,
      ));

      run(root, "--row", "1", "--verdict", "accept", "--reason", "handled");
      const parsed = parseAdjudicationRow(rows(fs.readFileSync(recordPath, "utf8"))[0]);
      assert.equal(parsed.cells[2], "finding \\| title");
      assert.equal(parsed.cells[3], "採用");
      assert.equal(parsed.cells[4], "handled");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("j. refuses empty and whitespace-only precedent without changing the file", () => {
    const { root, recordPath } = fixture();
    try {
      for (const precedent of ["", "  \t\n"]) {
        const before = fs.readFileSync(recordPath);
        assert.throws(() => run(root, "--precedent", precedent), /cannot be empty or whitespace-only/);
        assert.deepEqual(fs.readFileSync(recordPath), before);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("k. refuses precedent text containing a heading without changing the file", () => {
    const { root, recordPath } = fixture();
    try {
      const before = fs.readFileSync(recordPath);
      assert.throws(() => run(root, "--precedent", "rule\n# nested heading"), /line starting with #/);
      assert.deepEqual(fs.readFileSync(recordPath), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
