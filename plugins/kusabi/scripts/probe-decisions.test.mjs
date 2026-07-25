import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkDeliverablesProbe,
  checkSmokeProbe,
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

