import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { quoteCandidates, classifyQuote } from "./quote-check.mjs";

describe("quoteCandidates", () => {
  it("extracts slice between first backtick and each later backtick, longest first", () => {
    const line = "Quote: `foo()` (a.js:3). When x, `bar` fails";
    const candidates = quoteCandidates(line);
    assert.deepEqual(candidates, [
      "foo()` (a.js:3). When x, `bar",
      "foo()` (a.js:3). When x,",
      "foo()",
    ]);
  });

  it("extracts a single code span", () => {
    const line = "Quote: `const answer = 42;`";
    assert.deepEqual(quoteCandidates(line), ["const answer = 42;"]);
  });

  it("trims candidate slices and drops empty ones", () => {
    const line = "Quote: `  abc  `  `def`";
    const candidates = quoteCandidates(line);
    assert.equal(candidates.includes("abc"), true);
  });

  it("yields no candidates for empty backticks", () => {
    assert.deepEqual(quoteCandidates("Quote: ``"), []);
    assert.deepEqual(quoteCandidates("Quote: `   `"), []);
  });

  it("yields no candidates when fewer than two backticks are present", () => {
    assert.deepEqual(quoteCandidates("Quote: `no closing tick"), []);
    assert.deepEqual(quoteCandidates("Quote: no ticks at all"), []);
    assert.deepEqual(quoteCandidates(""), []);
    assert.deepEqual(quoteCandidates(null), []);
  });
});

describe("classifyQuote", () => {
  it("criterion 1: matches over-captured quote when candidate equals line at line_start", () => {
    const line = "Quote: `foo()` (a.js:3). When x, `bar` fails";
    const candidates = quoteCandidates(line);
    const fileLines = [
      "import something;",
      "",
      "foo()",
      "return false;",
    ];
    const result = classifyQuote(candidates, fileLines, 3);
    assert.deepEqual(result, { status: "matched" });
  });

  it("criterion 2: finds quote displaced 21 lines from line_start", () => {
    const candidates = ["const answer = 42;"];
    const fileLines = [];
    for (let i = 1; i <= 30; i++) {
      if (i === 22) {
        fileLines.push("const answer = 42;");
      } else {
        fileLines.push(`// line ${i}`);
      }
    }
    // lineStart = 1, found at line 22 -> distance is 21
    const result = classifyQuote(candidates, fileLines, 1);
    assert.deepEqual(result, { status: "displaced", foundAt: 22, distance: 21 });
  });

  it("criterion 2: closest line wins when quote occurs twice", () => {
    const candidates = ["targetFunction();"];
    const fileLines = [
      "// line 1",
      "targetFunction();", // line 2, dist to 5 is 3
      "// line 3",
      "// line 4",
      "// line 5 (line_start)",
      "// line 6",
      "// line 7",
      "targetFunction();", // line 8, dist to 5 is 3 -> tie! lower line wins -> line 2
      "// line 9",
      "targetFunction();", // line 10, dist to 5 is 5
    ];
    // Tie at distance 3 between line 2 and line 8: lower line (line 2) wins
    const resultTie = classifyQuote(candidates, fileLines, 5);
    assert.deepEqual(resultTie, { status: "displaced", foundAt: 2, distance: 3 });

    // When lineStart is 7, distance to line 8 is 1, distance to line 2 is 5 -> line 8 wins
    const resultClosest = classifyQuote(candidates, fileLines, 7);
    assert.deepEqual(resultClosest, { status: "displaced", foundAt: 8, distance: 1 });
  });

  it("criterion 3: quote absent from file classifies as mismatched", () => {
    const candidates = ["missingCode();"];
    const fileLines = [
      "const a = 1;",
      "const b = 2;",
    ];
    const result = classifyQuote(candidates, fileLines, 1);
    assert.deepEqual(result, { status: "mismatched" });
  });

  it("criterion 3: line_start past EOF with quote present classifies as displaced", () => {
    const candidates = ["presentCode();"];
    const fileLines = [
      "presentCode();", // line 1
      "return;",         // line 2
    ];
    // line_start = 10 is past EOF (file has 2 lines)
    const result = classifyQuote(candidates, fileLines, 10);
    assert.deepEqual(result, { status: "displaced", foundAt: 1, distance: 9 });
  });

  it("criterion 4: a blank file line never matches", () => {
    const candidates = [""];
    const fileLines = [
      "",
      "   ",
      "\t",
    ];
    const result = classifyQuote(candidates, fileLines, 1);
    assert.deepEqual(result, { status: "mismatched" });
  });

  it("criterion 4: Quote containing only empty backticks yields no candidate and classifies as mismatched", () => {
    const candidates = quoteCandidates("Quote: ``");
    assert.deepEqual(candidates, []);
    const fileLines = [
      "const x = 1;",
      "",
      "const y = 2;",
    ];
    const result = classifyQuote(candidates, fileLines, 1);
    assert.deepEqual(result, { status: "mismatched" });
  });

  it("handles out of range line_start gracefully when candidate is absent", () => {
    const candidates = ["foo()"];
    const fileLines = ["bar()"];
    assert.deepEqual(classifyQuote(candidates, fileLines, 0), { status: "mismatched" });
    assert.deepEqual(classifyQuote(candidates, fileLines, -5), { status: "mismatched" });
    assert.deepEqual(classifyQuote(candidates, fileLines, 100), { status: "mismatched" });
  });

  it("trims whitespace from file line when comparing against candidate", () => {
    const candidates = ["foo()"];
    const fileLines = ["   foo()   "];
    assert.deepEqual(classifyQuote(candidates, fileLines, 1), { status: "matched" });
  });

  it("criterion 1: a low-information quote elsewhere is never displaced", () => {
    assert.deepEqual(classifyQuote(["}"], ["a", "}", "b"], 1), { status: "mismatched" });
    assert.deepEqual(classifyQuote(["});"], ["a", "b", "});"], 1), { status: "mismatched" });
    assert.deepEqual(classifyQuote([");"], ["a", "b", ");"], 1), { status: "mismatched" });
    assert.deepEqual(classifyQuote(["end"], ["a", "b", "end"], 1), { status: "mismatched" });
  });

  it("criterion 1: the scan continues past a nearby generic line to a farther informative match", () => {
    const candidates = ["}", "return value;"];
    const fileLines = [
      "const a = 1;", // line 1 (line_start)
      "}",            // line 2: low-information, close but proves nothing
      "const b = 2;",
      "const c = 3;",
      "return value;", // line 5: informative displacement
    ];
    assert.deepEqual(classifyQuote(candidates, fileLines, 1), {
      status: "displaced",
      foundAt: 5,
      distance: 4,
    });
  });

  it("criterion 2: a displaced result carries its distance", () => {
    const result = classifyQuote(["const value = 1;"], ["a", "b", "const value = 1;"], 1);
    assert.deepEqual(result, { status: "displaced", foundAt: 3, distance: 2 });
  });

  it("criterion 3: a low-information quote at lineStart remains matched", () => {
    const fileLines = ["const a = 1;", "}", "const b = 2;"];
    assert.deepEqual(classifyQuote(["}"], fileLines, 2), { status: "matched" });
  });

  it("criterion 3: a partial-line quote remains mismatched", () => {
    const fileLines = ["if (value) {", "  return value;", "}"];
    assert.deepEqual(classifyQuote(["return value"], fileLines, 1), { status: "mismatched" });
  });
});
