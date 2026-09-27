import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { briefTitle } from "./chain-control.mjs";

describe("briefTitle", () => {
  it("uses the first markdown heading in a heading-first brief", () => {
    assert.equal(
      briefTitle("# Fix the widget parser\n\nOrchestrator: m | session s | 2026-09-28"),
      "Fix the widget parser",
    );
  });

  it("finds a heading after the orchestrator metadata", () => {
    assert.equal(
      briefTitle("Orchestrator: m | session s | 2026-09-28\n# Fix the widget parser"),
      "Fix the widget parser",
    );
  });

  it("uses the first non-empty non-orchestrator line without a heading", () => {
    assert.equal(
      briefTitle("Orchestrator: m | session s | 2026-09-28\n\nFix the thing without a heading"),
      "Fix the thing without a heading",
    );
  });

  it("stops the title region at the first level-two-or-deeper heading", () => {
    assert.equal(briefTitle("  ######   A precise title   "), "");
    assert.equal(
      briefTitle("Orchestrator: m | session s | 2026-09-28\n## Deliverables\n- a.mjs"),
      "",
    );
    assert.equal(
      briefTitle("Orchestrator: m | session s | 2026-09-28\n\n## Deliverables\n# Not a title"),
      "",
    );
    assert.equal(briefTitle("## Deliverables\n- a.mjs"), "");
  });

  it("does not treat an overlong heading marker as a heading", () => {
    assert.equal(briefTitle("####### not a heading\nFix the thing"), "####### not a heading");
  });

  it("prefers a level-one heading anywhere before the section boundary", () => {
    assert.equal(
      briefTitle("Preamble\n# Title\n\n## Constraints\n- body"),
      "Title",
    );
  });

  it("skips orchestrator and container metadata when there is no heading", () => {
    assert.equal(
      briefTitle("Orchestrator: m | session s | 2026-09-28\nContainer: abc\n\nFix the thing"),
      "Fix the thing",
    );
  });

  it("returns an empty label for missing, non-string, or empty briefs", () => {
    assert.equal(briefTitle(undefined), "");
    assert.equal(briefTitle(null), "");
    assert.equal(briefTitle(42), "");
    assert.equal(briefTitle(""), "");
    assert.equal(briefTitle("Orchestrator: m | session s | 2026-09-28\n\n"), "");
  });

  it("truncates titles to 120 characters including the ellipsis", () => {
    const title = "a".repeat(121);
    const result = briefTitle("# " + title);
    assert.equal(result.length, 120);
    assert.equal(result, "a".repeat(119) + "…");
    assert.equal(result.includes("\n"), false);
  });

  it("does not include brief body text in the extracted label", () => {
    assert.equal(
      briefTitle("# Fix the widget parser\n\n## Constraints\n\n- Do not include this"),
      "Fix the widget parser",
    );
  });
});
