import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { countUnfilledReviewRecords, isUnadjudicatedRecord } from "./review-record-scan.mjs";

describe("countUnfilledReviewRecords", () => {
  it("counts only unadjudicated records with findings across the state root", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-scan-test-"));
    try {
      const wsDir = path.join(tmpDir, "hash123", "chains");

      // 1. Unadjudicated with findings
      const chain1 = path.join(wsDir, "chain-1");
      fs.mkdirSync(chain1, { recursive: true });
      fs.writeFileSync(
        path.join(chain1, "review-record.md"),
        `# [review-record] repo chain-1
## Findings adjudication (fill at inspection)
| # | severity | finding | 採否 | 理由 |
|---|---|---|---|---|
| 1 | low | test finding | _fill_ | _fill_ |
## 判例として (fill at inspection)
_fill: reusable precedent, if any_
`
      );

      // 2. Adjudicated with findings
      const chain2 = path.join(wsDir, "chain-2");
      fs.mkdirSync(chain2, { recursive: true });
      fs.writeFileSync(
        path.join(chain2, "review-record.md"),
        `# [review-record] repo chain-2
## Findings adjudication (fill at inspection)
| # | severity | finding | 採否 | 理由 |
|---|---|---|---|---|
| 1 | low | test finding | accept | fixed in PR |
## 判例として (fill at inspection)
_fill: reusable precedent, if any_
`
      );

      // 3. No findings
      const chain3 = path.join(wsDir, "chain-3");
      fs.mkdirSync(chain3, { recursive: true });
      fs.writeFileSync(
        path.join(chain3, "review-record.md"),
        `# [review-record] repo chain-3
## Findings adjudication (fill at inspection)
_No findings were produced by this chain — nothing to adjudicate._
## 判例として (fill at inspection)
_fill: reusable precedent, if any_
`
      );

      // 4. Unreadable record (directory instead of file)
      const chain4 = path.join(wsDir, "chain-4");
      fs.mkdirSync(path.join(chain4, "review-record.md"), { recursive: true });

      const count = countUnfilledReviewRecords(tmpDir);
      assert.equal(count, 1, "Must count only unadjudicated records with findings (chain-1)");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns 0 for state root with zero unfilled records", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-scan-zero-"));
    try {
      const wsDir = path.join(tmpDir, "hash123", "chains", "chain-1");
      fs.mkdirSync(wsDir, { recursive: true });
      fs.writeFileSync(
        path.join(wsDir, "review-record.md"),
        `# [review-record] repo chain-1
## Findings adjudication (fill at inspection)
_No findings were produced by this chain — nothing to adjudicate._
`
      );

      assert.equal(countUnfilledReviewRecords(tmpDir), 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles missing or unreadable state root without throwing", () => {
    const missingDir = path.join(os.tmpdir(), "nonexistent-kusabi-state-root-12345");
    assert.equal(countUnfilledReviewRecords(missingDir), 0);
    assert.equal(countUnfilledReviewRecords(null), 0);
    assert.equal(countUnfilledReviewRecords(undefined), 0);
  });

  // --- New tests for Issue #364 acceptance criteria ---

  it("does not count a fully adjudicated record quoting placeholder row in precedent section (criterion 1)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-scan-quoted-"));
    try {
      const chainDir = path.join(tmpDir, "hash123", "chains", "chain-1");
      fs.mkdirSync(chainDir, { recursive: true });
      const recordText = `# [review-record] repo chain-1
## Findings adjudication (fill at inspection)
| # | severity | finding | 採否 | 理由 |
|---|---|---|---|---|
| 1 | low | test finding | accept | fixed in PR |

## 判例として (fill at inspection)
The precedent notes: we discussed the placeholder row | 1 | low | test finding | _fill_ | _fill_ | in our analysis.
`;
      fs.writeFileSync(path.join(chainDir, "review-record.md"), recordText);

      assert.equal(isUnadjudicatedRecord(recordText), false);
      const count = countUnfilledReviewRecords(tmpDir);
      assert.equal(count, 0, "Record with fully adjudicated findings table must not count despite precedent quoting placeholder");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("counts Shape 1: real findings rows still unadjudicated (criterion 2)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-scan-shape1-"));
    try {
      const chainDir = path.join(tmpDir, "hash123", "chains", "chain-1");
      fs.mkdirSync(chainDir, { recursive: true });
      const recordText = `# [review-record] repo chain-1
## Findings adjudication (fill at inspection)
| # | severity | finding | 採否 | 理由 |
|---|---|---|---|---|
| 1 | high | memory leak in worker | _fill_ | _fill_ |

## 判例として (fill at inspection)
_fill: reusable precedent, if any_
`;
      fs.writeFileSync(path.join(chainDir, "review-record.md"), recordText);

      assert.equal(isUnadjudicatedRecord(recordText), true);
      assert.equal(countUnfilledReviewRecords(tmpDir), 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("counts Shape 2: partially filled table with at least one row unadjudicated (criterion 2)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-scan-shape2-"));
    try {
      const chainDir = path.join(tmpDir, "hash123", "chains", "chain-1");
      fs.mkdirSync(chainDir, { recursive: true });
      const recordText = `# [review-record] repo chain-1
## Findings adjudication (fill at inspection)
| # | severity | finding | 採否 | 理由 |
|---|---|---|---|---|
| 1 | low | minor typo | accept | fixed |
| 2 | medium | missing check | _fill_ | _fill_ |

## 判例として (fill at inspection)
_fill: reusable precedent, if any_
`;
      fs.writeFileSync(path.join(chainDir, "review-record.md"), recordText);

      assert.equal(isUnadjudicatedRecord(recordText), true);
      assert.equal(countUnfilledReviewRecords(tmpDir), 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("counts Shape 3: undelivered review verdict marker carrying placeholder row (criterion 2 / #367)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-scan-shape3-"));
    try {
      const chainDir = path.join(tmpDir, "hash123", "chains", "chain-1");
      fs.mkdirSync(chainDir, { recursive: true });
      const recordText = `# [review-record] repo chain-1
## Findings adjudication (fill at inspection)
_No review verdict was delivered for this chain — implementation remains unadjudicated._

| # | severity | finding | 採否 | 理由 |
|---|---|---|---|---|
| 1 | unknown | _No review verdict delivered — unadjudicated implementation_ | _fill_ | _fill_ |

## 判例として (fill at inspection)
_fill: reusable precedent, if any_
`;
      fs.writeFileSync(path.join(chainDir, "review-record.md"), recordText);

      assert.equal(isUnadjudicatedRecord(recordText), true);
      assert.equal(countUnfilledReviewRecords(tmpDir), 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not count Shape 4: genuinely empty shape with no findings produced (criterion 3)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-scan-shape4-"));
    try {
      const chainDir = path.join(tmpDir, "hash123", "chains", "chain-1");
      fs.mkdirSync(chainDir, { recursive: true });
      const recordText = `# [review-record] repo chain-1
## Findings adjudication (fill at inspection)
_No findings were produced by this chain — nothing to adjudicate._

## 判例として (fill at inspection)
_fill: reusable precedent, if any_
`;
      fs.writeFileSync(path.join(chainDir, "review-record.md"), recordText);

      assert.equal(isUnadjudicatedRecord(recordText), false);
      assert.equal(countUnfilledReviewRecords(tmpDir), 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("counts exactly 88 on a live-mix fixture directory with 88 unadjudicated records + 1 quoted precedent record (criterion 5)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-scan-live-mix-"));
    try {
      const chainsDir = path.join(tmpDir, "hash123", "chains");
      fs.mkdirSync(chainsDir, { recursive: true });

      // Create 88 unadjudicated records (mix of Shape 1, Shape 2, Shape 3)
      for (let i = 1; i <= 88; i++) {
        const cDir = path.join(chainsDir, `chain-${i}`);
        fs.mkdirSync(cDir, { recursive: true });
        let text;
        if (i % 3 === 1) {
          text = `## Findings adjudication (fill at inspection)\n| # | severity | finding | 採否 | 理由 |\n|---|---|---|---|---|\n| 1 | low | finding ${i} | _fill_ | _fill_ |\n`;
        } else if (i % 3 === 2) {
          text = `## Findings adjudication (fill at inspection)\n| # | severity | finding | 採否 | 理由 |\n|---|---|---|---|---|\n| 1 | low | f1 | accept | ok |\n| 2 | high | f2 | _fill_ | _fill_ |\n`;
        } else {
          text = `## Findings adjudication (fill at inspection)\n_No review verdict was delivered for this chain — implementation remains unadjudicated._\n| # | severity | finding | 採否 | 理由 |\n|---|---|---|---|---|\n| 1 | unknown | _No review verdict delivered — unadjudicated implementation_ | _fill_ | _fill_ |\n`;
        }
        fs.writeFileSync(path.join(cDir, "review-record.md"), text);
      }

      // Add 1 fully adjudicated record quoting the placeholder row in its precedent section
      const cAdjudicatedQuoted = path.join(chainsDir, "chain-89-adjudicated-quoted");
      fs.mkdirSync(cAdjudicatedQuoted, { recursive: true });
      fs.writeFileSync(
        path.join(cAdjudicatedQuoted, "review-record.md"),
        `## Findings adjudication (fill at inspection)\n| # | severity | finding | 採否 | 理由 |\n|---|---|---|---|---|\n| 1 | low | finding 89 | accept | resolved |\n## 判例として (fill at inspection)\nQuoted placeholder: | 1 | low | finding 89 | _fill_ | _fill_ |\n`
      );

      // Add 1 genuinely empty record ("nothing to adjudicate")
      const cEmpty = path.join(chainsDir, "chain-90-empty");
      fs.mkdirSync(cEmpty, { recursive: true });
      fs.writeFileSync(
        path.join(cEmpty, "review-record.md"),
        `## Findings adjudication (fill at inspection)\n_No findings were produced by this chain — nothing to adjudicate._\n`
      );

      const count = countUnfilledReviewRecords(tmpDir);
      assert.equal(count, 88, "Live-mix fixture directory must count exactly 88 unadjudicated records");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
