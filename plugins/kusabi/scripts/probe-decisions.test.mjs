import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkDeliverablesProbe,
  checkSmokeProbe,
  classifyRefusalAnchor,
  extractBriefHeadings,
  parseRefusalBlock,
  classifyRefusalOutcome,
  verifyRefusalAnchors,
  refusalRepoPaths,
} from "./probe-decisions.mjs";

// checkDeliverablesProbe — P3 probe decision logic
// ---------------------------------------------------------------------------

describe("checkDeliverablesProbe", () => {
  it("passes when no deliverables declared (trivial pass)", () => {
    const result = checkDeliverablesProbe([], ["file.js"]);
    assert.equal(result.passed, true);
    assert.match(result.detail, /no Deliverables declared/);
  });

  it("fails when change set is empty but deliverables are declared", () => {
    const result = checkDeliverablesProbe(["file.js"], []);
    assert.equal(result.passed, false);
    assert.match(result.detail, /work set is empty/);
  });

  it("passes when a declared path exactly matches a changed path", () => {
    const result = checkDeliverablesProbe(
      ["plugins/kusabi/scripts/foo.mjs"],
      ["plugins/kusabi/scripts/foo.mjs", "docs/DESIGN.md"],
    );
    assert.equal(result.passed, true);
    assert.match(result.detail, /touches declared deliverables/);
  });

  it("passes when a declared directory matches changed paths inside it", () => {
    const result = checkDeliverablesProbe(
      ["plugins/kusabi/scripts"],
      ["plugins/kusabi/scripts/kusabi-companion.mjs"],
    );
    assert.equal(result.passed, true);
  });

  it("fails when no declared path is in the change set", () => {
    const result = checkDeliverablesProbe(
      ["plugins/kusabi/scripts/foo.mjs"],
      ["docs/DESIGN.md"],
    );
    assert.equal(result.passed, false);
    assert.match(result.detail, /no declared deliverable touched/);
  });

  it("fails with detail containing both deliverables and changed paths", () => {
    const result = checkDeliverablesProbe(
      ["a.js", "b.js"],
      ["c.js"],
    );
    assert.equal(result.passed, false);
    assert.ok(result.detail.includes("a.js"));
    assert.ok(result.detail.includes("b.js"));
    assert.ok(result.detail.includes("c.js"));
  });

  it("passes when changed path is inside a declared directory (reverse)", () => {
    const result = checkDeliverablesProbe(
      ["plugins/kusabi/scripts/foo.mjs"],
      ["plugins/kusabi"],
    );
    assert.equal(result.passed, true);
  });

  it("probe name is 'P3: deliverables'", () => {
    const result = checkDeliverablesProbe([], []);
    assert.equal(result.probe, "P3: deliverables");
  });

  it("fails when heading is present but no entries parseable", () => {
    const result = checkDeliverablesProbe([], ["file.js"], true);
    assert.equal(result.passed, false);
    assert.match(result.detail, /heading present but no entries parsed/);
  });

  it("still passes when heading is absent and no entries (backward compat)", () => {
    const result = checkDeliverablesProbe([], ["file.js"], false);
    assert.equal(result.passed, true);
    assert.match(result.detail, /no Deliverables declared/);
  });

  it("passes unchanged when heading present and entries parseable (directory match)", () => {
    const result = checkDeliverablesProbe(
      ["src"],
      ["src/foo/bar.py"],
      true,
    );
    assert.equal(result.passed, true);
    assert.match(result.detail, /touches declared deliverables/);
  });

  it("never throws on any input", () => {
    assert.doesNotThrow(() => checkDeliverablesProbe(null, null));
    assert.doesNotThrow(() => checkDeliverablesProbe(undefined, undefined));
    assert.doesNotThrow(() => checkDeliverablesProbe([], null));
    assert.doesNotThrow(() => checkDeliverablesProbe("not-array", "not-array"));
  });
});

// checkSmokeProbe — P4 smoke probe decision logic
// ---------------------------------------------------------------------------

describe("checkSmokeProbe", () => {
  it("passes when no smoke entries declared (trivial pass)", () => {
    const result = checkSmokeProbe([], []);
    assert.equal(result.passed, true);
    assert.match(result.detail, /no Smoke declared/);
  });

  it("passes when all observed exit codes equal expected", () => {
    const entries = [
      { command: "node x.js", expectedExit: 0 },
      { command: "grep -q foo bar", expectedExit: 1 },
    ];
    const observed = [
      { command: "node x.js", observed: 0 },
      { command: "grep -q foo bar", observed: 1 },
    ];
    const result = checkSmokeProbe(entries, observed);
    assert.equal(result.passed, true);
  });

  it("fails when observed exit code differs from expected", () => {
    const entries = [
      { command: "node x.js", expectedExit: 0 },
    ];
    const observed = [
      { command: "node x.js", observed: 1 },
    ];
    const result = checkSmokeProbe(entries, observed);
    assert.equal(result.passed, false);
    assert.ok(result.detail.includes("node x.js"));
    assert.ok(result.detail.includes("expected exit 0"));
    assert.ok(result.detail.includes("observed exit 1"));
  });

  it("fails when entry could not be executed (no observed record)", () => {
    const entries = [
      { command: "node x.js", expectedExit: 0 },
    ];
    const result = checkSmokeProbe(entries, []);
    assert.equal(result.passed, false);
    assert.ok(result.detail.includes("not executed"));
  });

  it("fails when entry timed out", () => {
    const entries = [
      { command: "node x.js", expectedExit: 0 },
    ];
    const observed = [
      { command: "node x.js", observed: "timeout" },
    ];
    const result = checkSmokeProbe(entries, observed);
    assert.equal(result.passed, false);
    assert.ok(result.detail.includes("timeout"));
  });

  it("probe name is 'P4: smoke'", () => {
    const result = checkSmokeProbe([], []);
    assert.equal(result.probe, "P4: smoke");
  });

  it("detail contains all entry results when multiple entries fail", () => {
    const entries = [
      { command: "cmd-a", expectedExit: 0 },
      { command: "cmd-b", expectedExit: 0 },
    ];
    const observed = [
      { command: "cmd-a", observed: 1 },
      { command: "cmd-b", observed: "timeout" },
    ];
    const result = checkSmokeProbe(entries, observed);
    assert.equal(result.passed, false);
    assert.ok(result.detail.includes("cmd-a"));
    assert.ok(result.detail.includes("cmd-b"));
    assert.ok(result.detail.includes("expected exit 0"));
    assert.ok(result.detail.includes("observed exit 1"));
    assert.ok(result.detail.includes("timeout"));
  });

  it("passes with multiple entries all matching", () => {
    const entries = [
      { command: "cmd-a", expectedExit: 0 },
      { command: "cmd-b", expectedExit: 1 },
      { command: "cmd-c", expectedExit: 0 },
    ];
    const observed = [
      { command: "cmd-a", observed: 0 },
      { command: "cmd-b", observed: 1 },
      { command: "cmd-c", observed: 0 },
    ];
    const result = checkSmokeProbe(entries, observed);
    assert.equal(result.passed, true);
    assert.ok(result.detail.includes("3 smoke commands passed"));
  });

  it("fails when heading is present but no entries parseable", () => {
    const result = checkSmokeProbe([], [], true);
    assert.equal(result.passed, false);
    assert.match(result.detail, /heading present but no entries parsed/);
  });

  it("still passes when heading is absent and no entries (backward compat)", () => {
    const result = checkSmokeProbe([], [], false);
    assert.equal(result.passed, true);
    assert.match(result.detail, /no Smoke declared/);
  });

  it("never throws on any input", () => {
    assert.doesNotThrow(() => checkSmokeProbe(null, null));
    assert.doesNotThrow(() => checkSmokeProbe(undefined, undefined));
    assert.doesNotThrow(() => checkSmokeProbe([], null));
    assert.doesNotThrow(() => checkSmokeProbe(null, []));
    assert.doesNotThrow(() => checkSmokeProbe("not-array", "not-array"));
  });
});

// =========================================================================
// Qualifying refusal (kusabi #293)
// -------------------------------------------------------------------------
// An honest refusal must be readable by a machine, and a spurious one must
// not be: the whole value of the mechanism sits in where the line falls.
// =========================================================================

// A report shaped exactly as kusabi-implement.md teaches it.
function refusalReport(body) {
  return [
    "I stopped without editing.",
    "",
    "```kusabi-refusal",
    body,
    "```",
    "",
    "No files were changed.",
  ].join("\n");
}

const QUALIFYING_BODY = [
  "anchor: ## Frozen tests",
  "anchor: plugins/kusabi/scripts/chain-phases.test.mjs",
  "why: the frozen section requires every existing test to pass unchanged, while the spec requires the opposite output for the input that test pins.",
].join("\n");

describe("classifyRefusalAnchor", () => {
  it("reads a markdown brief heading as a brief-section anchor", () => {
    const a = classifyRefusalAnchor("## Frozen tests");
    assert.equal(a.kind, "brief-section");
    assert.equal(a.name, "## Frozen tests");
  });

  it("reads a repo path as a repo-path anchor", () => {
    const a = classifyRefusalAnchor("plugins/kusabi/scripts/chain-phases.test.mjs");
    assert.equal(a.kind, "repo-path");
    assert.equal(a.name, "plugins/kusabi/scripts/chain-phases.test.mjs");
  });

  it("reads a bare filename with an extension, and keeps a :line suffix", () => {
    assert.equal(classifyRefusalAnchor("chain-phases.test.mjs").kind, "repo-path");
    assert.equal(classifyRefusalAnchor("src/foo.mjs:42").name, "src/foo.mjs:42");
  });

  it("keeps a gloss after the path in `text` while `name` stays the path", () => {
    const a = classifyRefusalAnchor("docs/DESIGN.md §7, the publish invariant");
    assert.equal(a.name, "docs/DESIGN.md");
    assert.equal(a.text, "docs/DESIGN.md §7, the publish invariant");
  });

  it("tolerates backticks and bullet decoration around the item", () => {
    assert.equal(classifyRefusalAnchor("`## Frozen tests`").kind, "brief-section");
    assert.equal(classifyRefusalAnchor("`src/foo.mjs`").name, "src/foo.mjs");
  });

  it("rejects free prose — an unfalsifiable claim is not an anchor", () => {
    assert.equal(classifyRefusalAnchor("the brief says the tests must pass"), null);
    assert.equal(classifyRefusalAnchor("acceptance criteria"), null);
    assert.equal(classifyRefusalAnchor("e.g. the frozen section"), null);
    assert.equal(classifyRefusalAnchor(""), null);
    assert.equal(classifyRefusalAnchor(null), null);
  });
});

describe("parseRefusalBlock", () => {
  it("returns null when the report has no block at all", () => {
    assert.equal(parseRefusalBlock("Implemented the feature. All tests pass."), null);
    assert.equal(parseRefusalBlock(""), null);
    assert.equal(parseRefusalBlock(null), null);
    assert.equal(parseRefusalBlock(undefined), null);
  });

  it("returns null for prose that merely talks about a contradiction", () => {
    const text = [
      "I cannot do this: the frozen tests section contradicts the spec.",
      "The brief says existing tests pass unchanged but demands different output.",
    ].join("\n");
    assert.equal(parseRefusalBlock(text), null);
  });

  it("qualifies on two named anchors plus a why", () => {
    const r = parseRefusalBlock(refusalReport(QUALIFYING_BODY));
    assert.equal(r.qualifies, true);
    assert.equal(r.disqualification, null);
    assert.equal(r.anchors.length, 2);
    assert.deepEqual(r.anchors.map((a) => a.kind), ["brief-section", "repo-path"]);
    assert.match(r.why, /no implementation|opposite output/);
  });

  it("does not qualify with only one named anchor", () => {
    const r = parseRefusalBlock(refusalReport([
      "anchor: ## Frozen tests",
      "why: it cannot hold with the spec.",
    ].join("\n")));
    assert.equal(r.qualifies, false);
    assert.equal(r.anchors.length, 1);
    assert.match(r.disqualification, /only 1 named anchor/);
  });

  it("does not qualify when both anchors are free prose", () => {
    const r = parseRefusalBlock(refusalReport([
      "anchor: the brief wants the tests to pass",
      "anchor: but it also wants different output",
      "why: they conflict.",
    ].join("\n")));
    assert.equal(r.qualifies, false);
    assert.equal(r.anchors.length, 0);
    assert.match(r.disqualification, /no named anchors/);
    assert.match(r.disqualification, /unnamed anchor/);
  });

  it("does not qualify when the same item is named twice", () => {
    const r = parseRefusalBlock(refusalReport([
      "anchor: src/foo.mjs",
      "anchor: src/foo.mjs",
      "why: it contradicts itself.",
    ].join("\n")));
    assert.equal(r.qualifies, false);
    assert.equal(r.anchors.length, 1);
  });

  it("does not qualify with two named anchors and nothing said about why", () => {
    const r = parseRefusalBlock(refusalReport([
      "anchor: ## Frozen tests",
      "anchor: src/foo.test.mjs",
    ].join("\n")));
    assert.equal(r.qualifies, false);
    assert.match(r.disqualification, /why/);
  });

  it("accepts an unlabelled explanation line as the why", () => {
    const r = parseRefusalBlock(refusalReport([
      "anchor: ## Frozen tests",
      "anchor: src/foo.test.mjs",
      "These cannot both hold: the test pins the old output.",
    ].join("\n")));
    assert.equal(r.qualifies, true);
    assert.match(r.why, /cannot both hold/);
  });

  it("joins a wrapped why into one line", () => {
    const r = parseRefusalBlock(refusalReport([
      "anchor: ## Frozen tests",
      "anchor: src/foo.test.mjs",
      "why: the frozen section pins the old output",
      "while the spec demands the new one.",
    ].join("\n")));
    assert.equal(r.qualifies, true);
    assert.equal(r.why, "the frozen section pins the old output while the spec demands the new one.");
  });

  it("tolerates bullet-prefixed keys, a tilde fence and a mixed-case info string", () => {
    const text = [
      "report",
      "~~~KUSABI-REFUSAL",
      "- anchor: ## Frozen tests",
      "- anchor: src/foo.test.mjs",
      "- why: they contradict.",
      "~~~",
    ].join("\n");
    const r = parseRefusalBlock(text);
    assert.equal(r.qualifies, true);
    assert.equal(r.anchors.length, 2);
  });

  it("reads an unterminated block to the end of the report", () => {
    // A report cut short mid-block still named its contradiction; dropping it
    // would turn a truncation into a discard.
    const text = [
      "stopped.",
      "```kusabi-refusal",
      "anchor: ## Frozen tests",
      "anchor: src/foo.test.mjs",
      "why: they contradict.",
    ].join("\n");
    assert.equal(parseRefusalBlock(text).qualifies, true);
  });

  it("ignores anchors written outside the block", () => {
    const text = [
      "anchor: ## Frozen tests",
      "anchor: src/foo.test.mjs",
      "why: they contradict.",
    ].join("\n");
    assert.equal(parseRefusalBlock(text), null);
  });
});

describe("refusalRepoPaths", () => {
  it("returns usable repo paths in anchor order, excluding invalid/brief-section anchors and deduplicating", () => {
    const block = parseRefusalBlock(refusalReport([
      "anchor: ## Spec",
      "anchor: tests/a.py",
      "anchor: ../outside.py",
      "anchor: tests/b.py:10-20",
      "anchor: tests/a.py",
    ].join("\n")));
    const paths = refusalRepoPaths(block);
    assert.deepEqual(paths, ["tests/a.py", "tests/b.py"]);
  });

  it("returns [] for null or shape-less input", () => {
    assert.deepEqual(refusalRepoPaths(null), []);
    assert.deepEqual(refusalRepoPaths(undefined), []);
    assert.deepEqual(refusalRepoPaths({}), []);
    assert.deepEqual(refusalRepoPaths("not a block"), []);
  });
});

describe("classifyRefusalOutcome", () => {
  const qualifying = parseRefusalBlock(refusalReport(QUALIFYING_BODY));
  const nonQualifying = parseRefusalBlock(refusalReport("anchor: ## Frozen tests\nwhy: nope."));

  it("empty change set + qualifying block → refusal, naming both items", () => {
    const out = classifyRefusalOutcome({ changeSetEmpty: true, refusal: qualifying });
    assert.equal(out.outcome, "refusal");
    assert.equal(out.refusal, qualifying);
    assert.equal(out.strayRefusal, null);
    assert.match(out.detail, /## Frozen tests vs plugins\/kusabi\/scripts\/chain-phases\.test\.mjs/);
  });

  it("empty change set + no block → discard, exactly as before", () => {
    const out = classifyRefusalOutcome({ changeSetEmpty: true, refusal: null });
    assert.equal(out.outcome, "discard");
    assert.equal(out.refusal, null);
    assert.equal(out.strayRefusal, null);
    assert.equal(out.detail, null);
  });

  it("empty change set + non-qualifying block → discard, with the shortfall named", () => {
    const out = classifyRefusalOutcome({ changeSetEmpty: true, refusal: nonQualifying });
    assert.equal(out.outcome, "discard");
    assert.equal(out.refusal, null);
    assert.match(out.detail, /did not qualify/);
    assert.match(out.detail, /only 1 named anchor/);
  });

  it("non-empty change set + qualifying block → NOT a refusal; the block is surfaced", () => {
    const out = classifyRefusalOutcome({ changeSetEmpty: false, refusal: qualifying });
    assert.equal(out.outcome, "changed");
    assert.equal(out.refusal, null);
    assert.equal(out.strayRefusal, qualifying);
    assert.match(out.detail, /accompanied by edits is not a refusal/);
  });

  it("non-empty change set + no block → changed, nothing surfaced", () => {
    const out = classifyRefusalOutcome({ changeSetEmpty: false, refusal: null });
    assert.equal(out.outcome, "changed");
    assert.equal(out.strayRefusal, null);
    assert.equal(out.detail, null);
  });
});

// =========================================================================
// extractBriefHeadings + verifyRefusalAnchors — the existence gate
// -------------------------------------------------------------------------
// `parseRefusalBlock` is shape-only by design: `src/nonexistent.mjs` and
// `## No Such Section` parse as named anchors.  The named item must EXIST
// before the block may qualify, and that is verified at classification time
// against the brief text and the worktree — these tests pin the gate.
// =========================================================================

describe("extractBriefHeadings", () => {
  it("collects heading texts, marker depth dropped", () => {
    const brief = [
      "# Task",
      "",
      "## Deliverables",
      "",
      "- `src/foo.js`",
      "",
      "### 3.5 Dispositions",
      "",
      "## Frozen tests ##",
    ].join("\n");
    assert.deepEqual(
      extractBriefHeadings(brief),
      ["Task", "Deliverables", "3.5 Dispositions", "Frozen tests"],
    );
  });

  it("returns [] for empty or missing briefs", () => {
    assert.deepEqual(extractBriefHeadings(""), []);
    assert.deepEqual(extractBriefHeadings(null), []);
    assert.deepEqual(extractBriefHeadings(undefined), []);
  });

  it("ignores non-heading lines and heading-shaped lines inside fences", () => {
    const brief = [
      "prose line",
      "```",
      "## not a heading",
      "```",
      "## Real",
    ].join("\n");
    assert.deepEqual(extractBriefHeadings(brief), ["Real"]);
  });
});

describe("verifyRefusalAnchors", () => {
  const BRIEF = [
    "Implement X.",
    "",
    "## Frozen tests",
    "",
    "All existing tests pass unchanged.",
    "",
    "### 3.5 Dispositions",
    "",
    "Rules.",
  ].join("\n");

  // The worktree contains exactly the two real paths the fixtures anchor on.
  const realPath = (p) => p === "plugins/kusabi/scripts/chain-phases.test.mjs" || p === "src/foo.js";

  const blockFor = (lines) => parseRefusalBlock(refusalReport(lines.join("\n")));
  const qualifiedBlock = () => blockFor([
    "anchor: ## Frozen tests",
    "anchor: plugins/kusabi/scripts/chain-phases.test.mjs",
    "why: the frozen section requires every existing test to pass unchanged, while the spec requires the opposite output for the input that test pins.",
  ]);

  it("leaves a block unchanged when both anchors exist", () => {
    const block = qualifiedBlock();
    const v = verifyRefusalAnchors(block, { brief: BRIEF, pathExists: realPath });
    assert.equal(v, block);
    assert.equal(v.qualifies, true);
    assert.equal(v.disqualification, null);
  });

  it("downgrades a repo-path anchor that does not exist, recording the miss", () => {
    const v = verifyRefusalAnchors(blockFor([
      "anchor: ## Frozen tests",
      "anchor: src/nonexistent.mjs",
      "why: they cannot both hold.",
    ]), { brief: BRIEF, pathExists: realPath });
    assert.equal(v.qualifies, false);
    // The anchors array stays as parsed — the record shows what was written.
    assert.equal(v.anchors.length, 2);
    assert.match(v.disqualification, /only 1 named anchor \(## Frozen tests\)/);
    assert.match(v.disqualification, /anchor\(s\) not found: src\/nonexistent\.mjs \(no such file or directory in the repo\)/);
    assert.ok(v.unnamedAnchors.some((u) => u.startsWith("src/nonexistent.mjs")));
  });

  it("downgrades a brief-section anchor that matches no real heading", () => {
    const v = verifyRefusalAnchors(blockFor([
      "anchor: ## No Such Section",
      "anchor: plugins/kusabi/scripts/chain-phases.test.mjs",
      "why: they cannot both hold.",
    ]), { brief: BRIEF, pathExists: realPath });
    assert.equal(v.qualifies, false);
    assert.match(v.disqualification, /only 1 named anchor \(plugins\/kusabi\/scripts\/chain-phases\.test\.mjs\)/);
    assert.match(v.disqualification, /## No Such Section \(no such heading in the brief\)/);
  });

  it("disqualifies a block whose only anchors do not exist", () => {
    const v = verifyRefusalAnchors(blockFor([
      "anchor: ## No Such Section",
      "anchor: src/nonexistent.mjs",
      "why: they cannot both hold.",
    ]), { brief: BRIEF, pathExists: realPath });
    assert.equal(v.qualifies, false);
    assert.match(v.disqualification, /no named anchors/);
    assert.match(v.disqualification, /anchor\(s\) not found: ## No Such Section \(no such heading in the brief\) \| src\/nonexistent\.mjs \(no such file or directory in the repo\)/);
  });

  it("still qualifies when two of three anchors exist; the miss is recorded", () => {
    const v = verifyRefusalAnchors(blockFor([
      "anchor: ## Frozen tests",
      "anchor: plugins/kusabi/scripts/chain-phases.test.mjs",
      "anchor: src/nonexistent.mjs",
      "why: they cannot both hold.",
    ]), { brief: BRIEF, pathExists: realPath });
    assert.equal(v.qualifies, true);
    assert.equal(v.disqualification, null);
    assert.equal(v.anchors.length, 3);
    assert.ok(v.unnamedAnchors.some((u) => u.startsWith("src/nonexistent.mjs")));
  });

  it("checks the file, not the :line suffix", () => {
    const v = verifyRefusalAnchors(blockFor([
      "anchor: ## Frozen tests",
      "anchor: plugins/kusabi/scripts/chain-phases.test.mjs:42-44",
      "why: they cannot both hold.",
    ]), { brief: BRIEF, pathExists: realPath });
    assert.equal(v.qualifies, true);
  });

  it("rejects .. and .git paths without asking the predicate", () => {
    const seen = [];
    const v = verifyRefusalAnchors(blockFor([
      "anchor: ## Frozen tests",
      "anchor: ../outside.mjs",
      "anchor: .git/config",
      "why: they cannot both hold.",
    ]), { brief: BRIEF, pathExists: (p) => { seen.push(p); return true; } });
    assert.equal(v.qualifies, false);
    assert.match(v.disqualification, /only 1 named anchor \(## Frozen tests\)/);
    assert.match(v.disqualification, /\.\.\/outside\.mjs/);
    assert.match(v.disqualification, /\.git\/config/);
    assert.deepEqual(seen, []);
  });

  it("matches §-style abbreviations against longer headings, not unrelated ones", () => {
    const ok = verifyRefusalAnchors(blockFor([
      "anchor: §3.5",
      "anchor: plugins/kusabi/scripts/chain-phases.test.mjs",
      "why: they cannot both hold.",
    ]), { brief: BRIEF, pathExists: realPath });
    assert.equal(ok.qualifies, true);

    const abbreviated = verifyRefusalAnchors(blockFor([
      "anchor: ## Frozen",
      "anchor: plugins/kusabi/scripts/chain-phases.test.mjs",
      "why: they cannot both hold.",
    ]), { brief: BRIEF, pathExists: realPath });
    assert.equal(abbreviated.qualifies, true);

    const noMatch = verifyRefusalAnchors(blockFor([
      "anchor: §3.5",
      "anchor: plugins/kusabi/scripts/chain-phases.test.mjs",
      "why: they cannot both hold.",
    ]), {
      brief: "## 3.5.4a Qualifying refusal\n",
      pathExists: realPath,
    });
    assert.equal(noMatch.qualifies, false);
    assert.match(noMatch.disqualification, /§3\.5 \(no such heading in the brief\)/);
  });

  // kusabi #301: a worker that copies a heading verbatim may keep its ATX
  // closing hashes (`## Frozen tests ##`).  `headingTextOf` strips them the
  // same way `extractBriefHeadings` strips them from the brief side, so the
  // copied spelling anchors the same section as the plain one.
  it("verifies an anchor with ATX closing hashes copied verbatim from a heading", () => {
    const withClosing = verifyRefusalAnchors(blockFor([
      "anchor: ## Frozen tests ##",
      "anchor: plugins/kusabi/scripts/chain-phases.test.mjs",
      "why: they cannot both hold.",
    ]), { brief: BRIEF, pathExists: realPath });
    assert.equal(withClosing.qualifies, true);
    assert.equal(withClosing.disqualification, null);

    // The same anchor without closing hashes still verifies.
    const plain = verifyRefusalAnchors(blockFor([
      "anchor: ## Frozen tests",
      "anchor: plugins/kusabi/scripts/chain-phases.test.mjs",
      "why: they cannot both hold.",
    ]), { brief: BRIEF, pathExists: realPath });
    assert.equal(plain.qualifies, true);
    assert.equal(plain.disqualification, null);
  });

  it("still fails an anchor with closing hashes that names a nonexistent section", () => {
    const v = verifyRefusalAnchors(blockFor([
      "anchor: ## No Such Section ##",
      "anchor: plugins/kusabi/scripts/chain-phases.test.mjs",
      "why: they cannot both hold.",
    ]), { brief: BRIEF, pathExists: realPath });
    assert.equal(v.qualifies, false);
    // The miss records what was written, closing hashes included.
    assert.match(v.disqualification, /## No Such Section ## \(no such heading in the brief\)/);
  });

  it("treats brief-section anchors as unnamed when no brief is available", () => {
    const v = verifyRefusalAnchors(qualifiedBlock(), { pathExists: realPath });
    assert.equal(v.qualifies, false);
    assert.match(v.disqualification, /## Frozen tests \(no such heading in the brief\)/);
  });

  it("treats repo-path anchors as unnamed when no predicate is given", () => {
    const v = verifyRefusalAnchors(qualifiedBlock(), { brief: BRIEF });
    assert.equal(v.qualifies, false);
    assert.match(v.disqualification, /chain-phases\.test\.mjs \(no such file or directory in the repo\)/);
  });

  it("preserves shape-level failures untouched when nothing is missing", () => {
    // Free-prose anchors: nothing to verify, the parse-level verdict stands.
    const prose = parseRefusalBlock(refusalReport([
      "anchor: the brief wants the tests untouched",
      "anchor: and it also wants different output",
      "why: they conflict.",
    ].join("\n")));
    assert.equal(verifyRefusalAnchors(prose, { brief: BRIEF, pathExists: realPath }), prose);

    // One real anchor only: still one named anchor, parse-level message kept.
    const one = parseRefusalBlock(refusalReport([
      "anchor: ## Frozen tests",
      "why: nope.",
    ].join("\n")));
    assert.equal(verifyRefusalAnchors(one, { brief: BRIEF, pathExists: realPath }), one);
    assert.match(one.disqualification, /only 1 named anchor/);

    // Two real anchors but no why: the why shortfall is the only problem.
    const noWhy = parseRefusalBlock(refusalReport([
      "anchor: ## Frozen tests",
      "anchor: plugins/kusabi/scripts/chain-phases.test.mjs",
    ].join("\n")));
    assert.equal(verifyRefusalAnchors(noWhy, { brief: BRIEF, pathExists: realPath }), noWhy);
    assert.match(noWhy.disqualification, /no `why:` line/);
  });

  it("passes null and non-block values through", () => {
    assert.equal(verifyRefusalAnchors(null, {}), null);
    assert.equal(verifyRefusalAnchors(undefined, {}), undefined);
    const plain = { foo: 1 };
    assert.equal(verifyRefusalAnchors(plain, {}), plain);
  });
});
