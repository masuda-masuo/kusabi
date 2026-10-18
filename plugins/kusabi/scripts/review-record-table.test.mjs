import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatAdjudicationRow, parseAdjudicationRow } from "./review-record-table.mjs";

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
