import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { countUnfilledReviewRecords } from "./review-record-scan.mjs";

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
});
