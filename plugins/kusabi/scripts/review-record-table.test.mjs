import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatAdjudicationRow, parseAdjudicationRow, unfilledAdjudicationLines } from "./review-record-table.mjs";

describe("review-record-table", () => {
  it("parses the five cells of a regular adjudication row", () => {
    assert.deepEqual(
      parseAdjudicationRow("| 1 | low | finding title | _fill_ | _fill_ |"),
      { cells: ["1", "low", "finding title", "_fill_", "_fill_"] },
    );
  });

  it("folds unescaped middle separators into the finding and decodes escaped pipes", () => {
    assert.deepEqual(
      parseAdjudicationRow("| 2 | medium | a | b \\| c | _fill_ | _fill_ |"),
      { cells: ["2", "medium", "a | b | c", "_fill_", "_fill_"] },
    );
  });

  it("leaves short numbered rows available for malformed-row refusal", () => {
    assert.deepEqual(
      parseAdjudicationRow("| 3 | high | finding | _fill_ |"),
      { cells: ["3", "high", "finding", "_fill_"] },
    );
  });

  it("escapes reason pipes and round-trips the logical cell", () => {
    const row = formatAdjudicationRow(["5", "medium", "finding", "採用", "left | right"]);
    assert.equal(row, "| 5 | medium | finding | 採用 | left \\| right |");
    assert.deepEqual(parseAdjudicationRow(row), {
      cells: ["5", "medium", "finding", "採用", "left | right"],
    });
  });

  it("checks _fill_ only in verdict and reason for complete table rows", () => {
    const result = (row) => unfilledAdjudicationLines([
      "## Findings adjudication",
      row,
    ].join("\n")).unfilled;

    assert.deepEqual(result("| 1 | medium | archive does not refuse rows still marked _fill_ | 採用 | 修正済み |"), []);
    assert.deepEqual(result("| 2 | medium | finding | _fill_ | complete |"), [{ line: 2, row: "2" }]);
    assert.deepEqual(result("| 2 | medium | finding | _fill_ (todo) | complete |"), [{ line: 2, row: "2" }]);
    assert.deepEqual(result("| 3 | medium | finding | complete | _fill_ |"), [{ line: 2, row: "3" }]);
    assert.deepEqual(result("| 3 | medium | finding | complete | note _fill_ |"), [{ line: 2, row: "3" }]);
    assert.deepEqual(result("3 | medium | finding _fill_ | complete | reason"), [{ line: 2, row: "3" }]);
  });

  it("round-trips a trailing backslash and a literal backslash-pipe in findings", () => {
    for (const finding of ["ends\\", "literal \\| pipe"]) {
      const row = formatAdjudicationRow(["8", "medium", finding, "採用", "reason"]);
      assert.equal(parseAdjudicationRow(row).cells[2], finding);
    }
  });

  it("returns null for lines that are not table rows", () => {
    assert.equal(parseAdjudicationRow("plain text"), null);
    assert.equal(parseAdjudicationRow(null), null);
  });

  it("formats escaped findings and round-trips them", () => {
    const row = formatAdjudicationRow(["4", "low", "a | b", "_fill_", "_fill_"]);
    assert.equal(row, "| 4 | low | a \\| b | _fill_ | _fill_ |");
    assert.deepEqual(parseAdjudicationRow(row), { cells: ["4", "low", "a | b", "_fill_", "_fill_"] });
  });
});
