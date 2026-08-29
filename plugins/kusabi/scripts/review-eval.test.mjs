import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  isFindingHit,
  gradeReview,
  passK,
  passAtK,
} from "./review-eval.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const tasksDir = resolve(here, "../../../evals/review/tasks");

const GOLD = {
  file: "bug.js",
  line_start: 10,
  line_end: 20,
  kind: "null-deref",
};

describe("isFindingHit — range overlap", () => {
  it("hits when finding range overlaps gold range", () => {
    const f = { file: "bug.js", line_start: 15, line_end: 18 };
    assert.equal(isFindingHit(f, GOLD), true);
  });

  it("misses when finding range is entirely above gold range", () => {
    const f = { file: "bug.js", line_start: 21, line_end: 25 };
    assert.equal(isFindingHit(f, GOLD), false);
  });

  it("adjacent range (end+1) does not hit", () => {
    const f = { file: "bug.js", line_start: 21, line_end: 21 };
    assert.equal(isFindingHit(f, GOLD), false);
  });

  it("adjacent range on the low side (gold start - 1) does not hit", () => {
    const f = { file: "bug.js", line_start: 8, line_end: 9 };
    assert.equal(isFindingHit(f, GOLD), false);
  });

  it("hits at the boundary (shares one line)", () => {
    const f = { file: "bug.js", line_start: 10, line_end: 10 };
    assert.equal(isFindingHit(f, GOLD), true);
  });
});

describe("isFindingHit — inverted finding range", () => {
  it("hits after swapping a reversed finding range to [min, max]", () => {
    const f = { file: "bug.js", line_start: 18, line_end: 12 };
    assert.equal(isFindingHit(f, GOLD), true);
  });

  it("hits when the gold range itself is reversed", () => {
    const gold = { file: "bug.js", line_start: 20, line_end: 10 };
    const f = { file: "bug.js", line_start: 14, line_end: 16 };
    assert.equal(isFindingHit(f, gold), true);
  });
});

describe("isFindingHit — path normalization", () => {
  it("strips a leading /workspace/ prefix and still hits", () => {
    const f = { file: "/workspace/bug.js", line_start: 15, line_end: 18 };
    assert.equal(isFindingHit(f, GOLD), true);
  });

  it("does NOT hit an unrelated absolute prefix", () => {
    const f = { file: "/home/x/bug.js", line_start: 15, line_end: 18 };
    assert.equal(isFindingHit(f, GOLD), false);
  });
});

describe("isFindingHit — missing data is a non-hit", () => {
  it("misses when file is missing", () => {
    const f = { line_start: 15, line_end: 18 };
    assert.equal(isFindingHit(f, GOLD), false);
  });

  it("misses when file is an empty string", () => {
    const f = { file: "", line_start: 15, line_end: 18 };
    assert.equal(isFindingHit(f, GOLD), false);
  });

  it("misses when line numbers are missing", () => {
    const f = { file: "bug.js" };
    assert.equal(isFindingHit(f, GOLD), false);
  });

  it("misses when line_start is non-numeric", () => {
    const f = { file: "bug.js", line_start: "10", line_end: 20 };
    assert.equal(isFindingHit(f, GOLD), false);
  });
});

describe("isFindingHit — kind is documentation, not a gate", () => {
  it("hits when finding.kind is omitted and gold.kind is present", () => {
    const f = { file: "bug.js", line_start: 15, line_end: 18 };
    assert.equal(isFindingHit(f, GOLD), true);
  });

  it("hits when finding.kind differs from gold.kind", () => {
    const f = {
      file: "bug.js",
      line_start: 15,
      line_end: 18,
      kind: "something-else",
    };
    assert.equal(isFindingHit(f, GOLD), true);
  });
});

describe("passK / passAtK", () => {
  it("passK is false when any trial misses", () => {
    assert.equal(passK([true, true, false]), false);
  });

  it("passK is true when all trials hit", () => {
    assert.equal(passK([true, true, true]), true);
  });

  it("passK is false for an empty trial set", () => {
    assert.equal(passK([]), false);
  });

  it("passAtK is true when any trial hits", () => {
    assert.equal(passAtK([true, true, false]), true);
  });

  it("passAtK is false when no trial hits", () => {
    assert.equal(passAtK([false, false]), false);
  });

  it("accepts gradeReview results carrying hit", () => {
    const graded = [{ hit: true }, { hit: true }, { hit: false }];
    assert.equal(passK(graded), false);
    assert.equal(passAtK(graded), true);
  });

  it("throws on a non-boolean object without a hit key", () => {
    assert.throws(() => passK([{ file: "bug.js" }]), TypeError);
    assert.throws(() => passAtK([{ file: "bug.js" }]), TypeError);
  });

  it("throws on an object whose hit is not a boolean", () => {
    assert.throws(() => passK([{ hit: "yes" }]), TypeError);
  });

  it("still passes when given {hit:boolean} entries", () => {
    assert.equal(passK([{ hit: true }, { hit: true }]), true);
    assert.equal(passAtK([{ hit: true }, { hit: false }]), true);
  });
});


describe("gradeReview", () => {
  it("reports hit true when at least one finding hits", () => {
    const findings = [
      { file: "bug.js", line_start: 1, line_end: 2 },
      { file: "bug.js", line_start: 15, line_end: 18 },
    ];
    const r = gradeReview(findings, GOLD);
    assert.equal(r.hit, true);
    assert.equal(r.total, 2);
    assert.equal(r.noise, 1);
  });

  it("reports hit false and noise equal to total when nothing hits", () => {
    const findings = [
      { file: "bug.js", line_start: 21, line_end: 22 },
      { file: "other.js", line_start: 10, line_end: 12 },
    ];
    const r = gradeReview(findings, GOLD);
    assert.equal(r.hit, false);
    assert.equal(r.total, 2);
    assert.equal(r.noise, 2);
  });

  it("tolerates a non-array findings argument", () => {
    const r = gradeReview(undefined, GOLD);
    assert.equal(r.hit, false);
    assert.equal(r.total, 0);
    assert.equal(r.noise, 0);
  });
});

describe("disk fixtures — real gold.json graded against canned findings", () => {
  const ids = ["null-deref", "off-by-one", "missing-await", "resource-leak"];

  for (const id of ids) {
    it(`grades a hit for ${id} from its gold.json`, () => {
      const gold = JSON.parse(
        readFileSync(resolve(tasksDir, id, "gold.json"), "utf8")
      );
      assert.equal(gold.file, "bug.js");
      const findings = [
        { file: gold.file, line_start: gold.line_start, line_end: gold.line_end },
        { file: "bug.js", line_start: 1, line_end: 1 },
      ];
      const r = gradeReview(findings, gold);
      assert.equal(r.hit, true);
      assert.equal(r.noise, 1);
      // Also confirm the module's decision function agrees.
      assert.equal(isFindingHit(findings[0], gold), true);
    });
  }

  it("misses when graded against a different task's gold", () => {
    const gold = JSON.parse(
      readFileSync(resolve(tasksDir, "null-deref", "gold.json"), "utf8")
    );
    const other = JSON.parse(
      readFileSync(resolve(tasksDir, "off-by-one", "gold.json"), "utf8")
    );
    const r = gradeReview(
      [{ file: other.file, line_start: other.line_start, line_end: other.line_end }],
      gold
    );
    assert.equal(r.hit, false);
  });
});

describe("disk fixture — missing-await gold retargeted to code (lines 7-8)", () => {
  const gold = JSON.parse(
    readFileSync(resolve(tasksDir, "missing-await", "gold.json"), "utf8")
  );

  it("gold now covers the code (line 7-8), not the comment (line 6)", () => {
    assert.equal(gold.file, "bug.js");
    assert.equal(gold.line_start, 7);
    assert.equal(gold.line_end, 8);
  });

  it("a canned finding on line 7 (the fetch) hits", () => {
    const findings = [
      { file: gold.file, line_start: 7, line_end: 7 },
    ];
    const r = gradeReview(findings, gold);
    assert.equal(r.hit, true);
    assert.equal(isFindingHit(findings[0], gold), true);
  });

  it("a finding only on line 6 (the comment) misses after the fix", () => {
    const findings = [
      { file: gold.file, line_start: 6, line_end: 6 },
    ];
    const r = gradeReview(findings, gold);
    assert.equal(r.hit, false);
    assert.equal(isFindingHit(findings[0], gold), false);
  });
});
