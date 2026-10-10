import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { briefLintReport } from "./brief-lint.mjs";

const SIGNATURE = "Orchestrator: claude-opus-5-5 | session brief-lint-test | 2026-10-07";
const WORKPLACE = "## Workplace\ncid-test";

describe("briefLintReport — basic dispatch checks (kusabi #289)", () => {
  const SIGNATURE = "Orchestrator: claude-fable-5 | session wsl-test-1 | 2026-08-16";
  const DELIVERABLES = "## Deliverables\n\n- `plugins/kusabi/scripts/kusabi-companion.mjs`\n";
  const SMOKE = "## Smoke\n\n- `node --check plugins/kusabi/scripts/kusabi-companion.mjs`\n";
  const taskBrief = (body) => `# Task\n\n${body}`;
  const signedBrief = (body = "") => taskBrief(`${SIGNATURE}\n${body ? `\n${body}` : ""}`);
  const NO_WORKPLACE = signedBrief(`${DELIVERABLES}\n${SMOKE}`);

  it("passes an implement brief whose container comes from --container", () => {
    assert.equal(
      briefLintReport({ brief: NO_WORKPLACE, phase: "implement", container: "cid-1" }),
      null,
    );
  });

  it("passes an implement brief whose container comes from ## Workplace", () => {
    const brief = `${NO_WORKPLACE}\n## Workplace\n\nContainer \`cid-1\` (kusabi main).\n`;
    assert.equal(briefLintReport({ brief, phase: "implement", container: null }), null);
  });

  it("refuses an implement dispatch with neither source, naming both remedies", () => {
    const report = briefLintReport({ brief: NO_WORKPLACE, phase: "implement", container: null });
    assert.ok(report, "the incident brief must be refused");
    assert.match(report, /brief rejected before dispatch/);
    assert.match(report, /no container source/);
    assert.match(report, /--container <cid>/);
    assert.match(report, /## Workplace/);
  });

  it("refuses an implement dispatch whose ## Deliverables is absent, naming the section", () => {
    const report = briefLintReport({
      brief: signedBrief(),
      phase: "implement",
      container: "cid-1",
    });
    assert.ok(report);
    assert.match(report, /## Deliverables/);
  });

  it("refuses a ## Deliverables heading that parses to zero entries", () => {
    const report = briefLintReport({
      brief: signedBrief("## Deliverables\n\nTo be decided by the worker.\n"),
      phase: "implement",
      container: "cid-1",
    });
    assert.ok(report, "a heading with no parseable entry is the same failure as no heading");
    assert.match(report, /## Deliverables/);
  });

  it("refuses a brief with no signature line, for every phase", () => {
    const brief = taskBrief(`${DELIVERABLES}\n## Workplace\n\nContainer \`cid-1\`.\n`);
    for (const phase of ["implement", "review", "respond", "gofer"]) {
      const report = briefLintReport({ brief, phase, container: "cid-1" });
      assert.ok(report, `${phase} must be refused`);
      assert.ok(
        report.includes("Orchestrator: <model-id> | session <id> | <date>"),
        `${phase}: the refusal must show the line to add, got: ${report}`,
      );
    }
  });

  it("adds nothing but the signature line to the non-implement phases", () => {
    // Non-goal of #289: investigate/review/... keep the brief requirements
    // they already had.  No Deliverables, no Workplace, no container.
    for (const phase of ["review", "respond", "gofer"]) {
      assert.equal(
        briefLintReport({ brief: signedBrief("Look into it.\n"), phase, container: null }),
        null,
        phase,
      );
    }
  });

  it("leaves an ad-hoc task with no --phase alone", () => {
    // `/kusabi:task <free text>` is not an orchestrator's brief; the lint
    // covers phase dispatches and chains.
    assert.equal(briefLintReport({ brief: "look at the flaky test in x.mjs" }), null);
  });

  it("requires deliverables and a signature when a chain starts, listing every miss at once", () => {
    const report = briefLintReport({
      brief: taskBrief(`Implement it.\n\n${SMOKE}`),
      container: "cid-1",
      chain: true,
    });
    assert.ok(report);
    assert.match(report, /2 problems found/);
    assert.match(report, /## Deliverables/);
    assert.ok(report.includes("Orchestrator: <model-id>"));
    // `chain` refuses a missing --container on its own, before this call:
    // the container-source line must not double up on that message.
    assert.doesNotMatch(report, /no container source/);
  });
});

describe("briefLintReport — Rule A: Smoke section required for implement (kusabi #662)", () => {
  const briefWithoutSmoke = [
    SIGNATURE,
    WORKPLACE,
    "## Deliverables",
    "- plugins/kusabi/scripts/a.mjs",
  ].join("\n");

  it("refuses an implement chain brief when ## Smoke is absent", () => {
    const report = briefLintReport({ brief: briefWithoutSmoke, chain: true, container: "cid-test" });
    assert.ok(report, "missing Smoke in chain must be refused");
    assert.match(report, /## Smoke/);
    assert.match(report, /baseline-red/);
  });

  it("refuses an implement task brief when ## Smoke is absent", () => {
    const report = briefLintReport({ brief: briefWithoutSmoke, phase: "implement", container: "cid-test" });
    assert.ok(report, "missing Smoke in implement task must be refused");
    assert.match(report, /## Smoke/);
    assert.match(report, /baseline-red/);
  });

  it("accepts a brief without ## Smoke for non-implement phases", () => {
    const nonImplementPhases = [
      "plan",
      "review",
      "test-author",
      "respond",
      "gofer",
    ];
    for (const phase of nonImplementPhases) {
      const report = briefLintReport({ brief: briefWithoutSmoke, phase, container: "cid-test" });
      assert.equal(report, null, `phase ${phase} must not require ## Smoke`);
    }
  });

  it("accepts an ad-hoc task brief without --phase and without ## Smoke", () => {
    const report = briefLintReport({ brief: briefWithoutSmoke, phase: null, chain: false, container: "cid-test" });
    assert.equal(report, null, "ad-hoc task with no phase must not require ## Smoke");
  });

  it("accepts an implement brief when ## Smoke is present and well-formed", () => {
    const briefWithSmoke = [
      briefWithoutSmoke,
      "## Smoke",
      "- `node --test plugins/kusabi/scripts/a.test.mjs` exit 0",
    ].join("\n");
    const report = briefLintReport({ brief: briefWithSmoke, chain: true, container: "cid-test" });
    assert.equal(report, null, "well-formed implement brief must pass");
  });

  it("refuses a ## Smoke heading that parses to zero entries (kusabi #302)", () => {
    const briefEmptySmoke = [
      briefWithoutSmoke,
      "## Smoke",
      "No smoke commands to run.",
    ].join("\n");
    const report = briefLintReport({ brief: briefEmptySmoke, chain: true, container: "cid-test" });
    assert.ok(report, "empty Smoke section must be refused");
    assert.match(report, /## Smoke/);
  });
});

describe("briefLintReport — Rule B: bare-word Deliverables rejected (kusabi #662)", () => {
  function makeBrief(deliverableBullet) {
    return [
      SIGNATURE,
      WORKPLACE,
      "## Deliverables",
      deliverableBullet,
      "## Smoke",
      "- `true` exit 0",
    ].join("\n");
  }

  it("refuses Deliverables whose first token is a bare English word (Update, Ensure, Keep, Fix)", () => {
    const bareWords = [
      "- Update plugins/kusabi/scripts/a.mjs with shared logic",
      "- Ensure package-lock.json is unchanged",
      "- Keep existing tests green",
      "- Fix bug in brief parser",
      "- Refactor auth module",
    ];
    for (const bullet of bareWords) {
      const report = briefLintReport({ brief: makeBrief(bullet), chain: true, container: "cid-test" });
      assert.ok(report, `bare word bullet "${bullet}" must be refused`);
      assert.match(report, /bare word/);
      assert.match(report, /- path\/to\/file\.ext — what changes/);
    }
  });

  it("quotes the offending line in the refusal message", () => {
    const bullet = "- Update plugins/kusabi/scripts/chain-metrics-core.mjs with shared logic";
    const report = briefLintReport({ brief: makeBrief(bullet), chain: true, container: "cid-test" });
    assert.ok(report);
    assert.ok(report.includes(bullet), `report must quote "${bullet}"`);
  });

  it("accepts unquoted directory deliverables with trailing slashes", () => {
    for (const bullet of ["- src/", "- docs/ — x"]) {
      const report = briefLintReport({ brief: makeBrief(bullet), chain: true, container: "cid-test" });
      assert.equal(report, null, `directory path bullet "${bullet}" must be accepted`);
    }
  });

  it("still refuses bare words even when followed by a path or explanation", () => {
    for (const bullet of ["- Update a/b.mjs", "- Ensure x", "- Keep"]) {
      const report = briefLintReport({ brief: makeBrief(bullet), chain: true, container: "cid-test" });
      assert.ok(report, `bare word bullet "${bullet}" must be refused`);
      assert.match(report, /bare word/);
    }
  });

  it("accepts valid repository paths with slashes or file extensions", () => {
    const validBullets = [
      "- plugins/kusabi/scripts/a.mjs",
      "- `plugins/kusabi/scripts/a.mjs`",
      "- ./local/script.sh",
      "- README.md",
      "- .gitignore",
      "- src/index.ts — main entry point",
      "1. plugins/kusabi/scripts/b.mjs — numbered list item",
    ];
    for (const bullet of validBullets) {
      const report = briefLintReport({ brief: makeBrief(bullet), chain: true, container: "cid-test" });
      assert.equal(report, null, `valid path bullet "${bullet}" must be accepted`);
    }
  });

  it("accepts quoted bare filenames without slashes or dots like `Dockerfile` or `Makefile`", () => {
    const validQuoted = [
      "- `Dockerfile`",
      "- `Makefile` — build targets",
      "- `LICENSE`",
    ];
    for (const bullet of validQuoted) {
      const report = briefLintReport({ brief: makeBrief(bullet), chain: true, container: "cid-test" });
      assert.equal(report, null, `quoted bare file "${bullet}" must be accepted`);
    }
  });

  it("accepts code block deliverables containing repository paths", () => {
    const codeBlockBrief = [
      SIGNATURE,
      WORKPLACE,
      "## Deliverables",
      "```",
      "plugins/kusabi/scripts/a.mjs",
      "plugins/kusabi/scripts/b.mjs",
      "```",
      "## Smoke",
      "- `true` exit 0",
    ].join("\n");
    const report = briefLintReport({ brief: codeBlockBrief, chain: true, container: "cid-test" });
    assert.equal(report, null, "code block deliverables must be accepted");
  });
});

describe("briefLintReport — positive control & aggregation", () => {
  it("accepts a well-formed brief with all required sections", () => {
    const wellFormedBrief = [
      SIGNATURE,
      WORKPLACE,
      "## Deliverables",
      "- plugins/kusabi/scripts/a.mjs",
      "- `plugins/kusabi/scripts/b.mjs`",
      "## Smoke",
      "- `node --test plugins/kusabi/scripts/a.test.mjs` exit 0",
      "## Frozen Tests",
      "- plugins/kusabi/scripts/c.test.mjs",
    ].join("\n");
    const report = briefLintReport({ brief: wellFormedBrief, chain: true, container: "cid-test" });
    assert.equal(report, null);
  });

  it("aggregates multiple defects into a single report", () => {
    const briefWithMultipleFlaws = [
      WORKPLACE,
      "## Deliverables",
      "- Update plugins/kusabi/scripts/a.mjs",
      // missing signature, bare word deliverables, missing smoke
    ].join("\n");
    const report = briefLintReport({ brief: briefWithMultipleFlaws, chain: true, container: "cid-test" });
    assert.ok(report);
    assert.match(report, /problems found/);
    assert.match(report, /signature/);
    assert.match(report, /bare word/);
    assert.match(report, /## Smoke/);
  });
});
