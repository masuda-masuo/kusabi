import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeFilePath,
  hasRepeatedAreas,
  resolveReworkScope,
  applyTierEscalation,
  recordReworkEscalation,
} from "./chain-rework.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");

// =========================================================================
// Source guards for kusabi #457
// =========================================================================

describe("chain-rework source guards (kusabi #457)", () => {
  it("chain-phases.mjs does not export moved rework-tier functions", () => {
    const chainPhasesSrc = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "chain-phases.mjs"), "utf8");
    assert.ok(!chainPhasesSrc.includes("export function normalizeFilePath("));
    assert.ok(!chainPhasesSrc.includes("export function hasRepeatedAreas("));
    assert.ok(!chainPhasesSrc.includes("export function resolveReworkScope("));
    assert.ok(!chainPhasesSrc.includes("export function inScopeFindingFiles("));
    assert.ok(!chainPhasesSrc.includes("export function applyTierEscalation("));
    assert.ok(!chainPhasesSrc.includes("export function recordReworkEscalation("));
  });

  it("chain-phases.mjs does not import chain-rework.mjs", () => {
    const chainPhasesSrc = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "chain-phases.mjs"), "utf8");
    assert.ok(!chainPhasesSrc.includes('from "./chain-rework.mjs"'));
    assert.ok(!chainPhasesSrc.includes("from './chain-rework.mjs'"));
  });

  it("chain-rework.mjs does not import chain-phases.mjs", () => {
    const chainReworkSrc = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "chain-rework.mjs"), "utf8");
    assert.ok(!chainReworkSrc.includes('from "./chain-phases.mjs"'));
    assert.ok(!chainReworkSrc.includes("from './chain-phases.mjs'"));
  });
});

// resolveReworkScope — kusabi #60 step 2: rework scheduling by finding kind
// =========================================================================
// Single decision point mapping the previous round's findings to the scope
// of the next rework round: "full" | "mechanical" | "design" plus the scoped
// subset.  Missing/invalid kind counts as design (same consumption-point
// default as groupFindingsByKind); subset order follows array order.

describe("resolveReworkScope", () => {
  const mech = (n, file) => ({ severity: "medium", title: "Mech " + n, file, line_start: 1, kind: "mechanical" });
  const design = (n, file) => ({ severity: "high", title: "Design " + n, file, line_start: 1, kind: "design" });

  it("returns full scope with no findings when there is no previous record", () => {
    assert.deepEqual(resolveReworkScope(null), { scope: "full", findings: [] });
    assert.deepEqual(resolveReworkScope(undefined), { scope: "full", findings: [] });
  });

  it("returns full scope when the previous round has no findings (probe-failure rework)", () => {
    assert.deepEqual(resolveReworkScope({ findings: [] }), { scope: "full", findings: [] });
    assert.deepEqual(resolveReworkScope({}), { scope: "full", findings: [] });
    // Old records without a structured findings array keep today's behavior.
    assert.deepEqual(resolveReworkScope({ findingsText: "(no structured findings)" }), { scope: "full", findings: [] });
  });

  it("returns full scope when the findings array holds nothing groupable", () => {
    assert.deepEqual(resolveReworkScope({ findings: [42, "x"] }), { scope: "full", findings: [] });
  });

  it("returns mechanical scope with only the mechanical findings when both kinds are present", () => {
    const findings = [design(1, "src/a.js"), mech(1, "src/b.js"), mech(2, "src/c.js")];
    const result = resolveReworkScope({ findings });
    assert.equal(result.scope, "mechanical");
    assert.deepEqual(result.findings, [findings[1], findings[2]]);
  });

  it("after a mechanical round a mixed set schedules the FIRST design finding (no two mechanical rounds in a row)", () => {
    // Followup: the mixed -> mechanical branch must not starve a pending
    // design finding; the mechanical items wait for the next batch.
    const findings = [design(1, "src/a.js"), mech(1, "src/b.js"), mech(2, "src/c.js")];
    const result = resolveReworkScope({ findings, reworkScope: "mechanical" });
    assert.equal(result.scope, "design");
    assert.deepEqual(result.findings, [findings[0]]);
  });

  it("mixed sets stay mechanical-first when the previous round was NOT mechanical-scoped", () => {
    const findings = [design(1, "src/a.js"), mech(1, "src/b.js")];
    // Explicit other scopes and old records without a reworkScope field all
    // keep the pre-followup behavior.
    assert.equal(resolveReworkScope({ findings, reworkScope: "full" }).scope, "mechanical");
    assert.equal(resolveReworkScope({ findings, reworkScope: "design" }).scope, "mechanical");
    assert.equal(resolveReworkScope({ findings }).scope, "mechanical");
    assert.equal(resolveReworkScope({ findings, reworkScope: undefined }).scope, "mechanical");
  });

  it("mechanical-only sets stay mechanical even right after a mechanical round (no design pending)", () => {
    const findings = [mech(1, "src/b.js"), mech(2, "src/c.js")];
    const result = resolveReworkScope({ findings, reworkScope: "mechanical" });
    assert.equal(result.scope, "mechanical");
    assert.deepEqual(result.findings, findings);
  });

  it("all-design sets are unaffected by the previous round's scope", () => {
    const findings = [design(1, "src/a.js"), design(2, "src/b.js")];
    const result = resolveReworkScope({ findings, reworkScope: "mechanical" });
    assert.equal(result.scope, "design");
    assert.deepEqual(result.findings, [findings[0]]);
    const single = resolveReworkScope({ findings: [findings[0]], reworkScope: "mechanical" });
    assert.equal(single.scope, "design");
    assert.deepEqual(single.findings, [findings[0]]);
  });

  it("treats a missing kind as design when grouping mixed findings", () => {
    const findings = [
      { severity: "high", title: "No kind", file: "src/a.js", line_start: 1 },
      mech(1, "src/b.js"),
    ];
    const result = resolveReworkScope({ findings });
    assert.equal(result.scope, "mechanical");
    assert.deepEqual(result.findings, [findings[1]]);
  });

  it("returns design scope with the FIRST design finding in array order when all design and length > 1", () => {
    const findings = [design(1, "src/a.js"), design(2, "src/b.js"), design(3, "src/c.js")];
    const result = resolveReworkScope({ findings });
    assert.equal(result.scope, "design");
    assert.deepEqual(result.findings, [findings[0]]);
    // Array-order stability: the first finding in the array wins, regardless
    // of title/severity.
    const reversed = [design(9, "src/z.js"), design(2, "src/b.js")];
    assert.deepEqual(resolveReworkScope({ findings: reversed }).findings, [reversed[0]]);
  });

  it("returns design scope with the single finding when all design and length == 1", () => {
    const findings = [design(1, "src/a.js")];
    const result = resolveReworkScope({ findings });
    assert.equal(result.scope, "design");
    assert.deepEqual(result.findings, findings);
  });

  it("returns mechanical scope with all findings when every finding is mechanical", () => {
    const findings = [mech(1, "src/b.js"), mech(2, "src/c.js")];
    const result = resolveReworkScope({ findings });
    assert.equal(result.scope, "mechanical");
    assert.deepEqual(result.findings, findings);
  });
});

// applyTierEscalation — tier clamping (kusabi #153)
// =========================================================================

describe("applyTierEscalation", () => {
  it("clamps an escalation past the top of a single-tier chain", () => {
    const result = applyTierEscalation({ currentTierIndex: 0, tierDelta: 1, tierCount: 1 });
    assert.deepEqual(result, { tierIndex: 0, clamped: true, reason: "single-tier chain" });
  });

  it("clamps repeated escalations on a single-tier chain", () => {
    const result = applyTierEscalation({ currentTierIndex: 0, tierDelta: 2, tierCount: 1 });
    assert.equal(result.tierIndex, 0);
    assert.equal(result.clamped, true);
  });

  it("does not clamp an in-range escalation on a multi-tier chain", () => {
    const result = applyTierEscalation({ currentTierIndex: 0, tierDelta: 1, tierCount: 2 });
    assert.deepEqual(result, { tierIndex: 1, clamped: false, reason: null });
  });

  it("clamps an escalation past the top of a multi-tier chain", () => {
    const result = applyTierEscalation({ currentTierIndex: 1, tierDelta: 1, tierCount: 2 });
    assert.equal(result.tierIndex, 1);
    assert.equal(result.clamped, true);
    assert.equal(result.reason, "escalation beyond top tier (modelChain has 2 tiers)");
  });

  it("never clamps when there is no usable ladder", () => {
    const result = applyTierEscalation({ currentTierIndex: 0, tierDelta: 1, tierCount: 0 });
    assert.deepEqual(result, { tierIndex: 1, clamped: false, reason: null });
  });
});

// recordReworkEscalation — driver rework branch (round-record contract)
// =========================================================================

describe("recordReworkEscalation", () => {
  it("records the clamp on the round record for a single-tier chain", () => {
    const roundRecord = { tierBefore: 0 };
    const result = recordReworkEscalation({
      roundRecord,
      currentTierIndex: 0,
      reworkCount: 1, // 2nd rework: tierDelta +1
      strategized: false,
      tierCount: 1,
    });

    assert.equal(result.currentTierIndex, 0); // clamped: stays on tier 0
    assert.equal(result.strategy.tierDelta, 1);
    assert.equal(roundRecord.tierClamped, true);
    assert.equal(roundRecord.tierClampReason, "single-tier chain");
  });

  it("amends the strategy reason on a clamped escalation so it never claims 'escalate tier'", () => {
    // #153④: chain-show renders the strategy reason verbatim next to the
    // clamped tier line — "escalate tier" there reads as a stronger-model
    // re-run that dispatch never performed.
    const roundRecord = { tierBefore: 0 };
    const result = recordReworkEscalation({
      roundRecord,
      currentTierIndex: 0,
      reworkCount: 1, // 2nd rework: tierDelta +1, clamped on a 1-tier chain
      strategized: false,
      tierCount: 1,
    });

    assert.ok(!result.strategy.reason.includes("escalate tier"), result.strategy.reason);
    assert.ok(
      result.strategy.reason.includes("tier unchanged (escalation clamped: single-tier chain)"),
      result.strategy.reason,
    );
  });

  it("keeps the plain 'escalate tier' wording for an in-range escalation", () => {
    const roundRecord = { tierBefore: 0 };
    const result = recordReworkEscalation({
      roundRecord,
      currentTierIndex: 0,
      reworkCount: 1, // 2nd rework: tierDelta +1 -> tier 1 of 2, no clamp
      strategized: false,
      tierCount: 2,
    });

    assert.ok(result.strategy.reason.includes("escalate tier"), result.strategy.reason);
  });

  it("records no clamp when escalation stays within range", () => {
    const roundRecord = { tierBefore: 0 };
    const result = recordReworkEscalation({
      roundRecord,
      currentTierIndex: 0,
      reworkCount: 0, // 1st rework: tierDelta 0
      strategized: false,
      tierCount: 2,
    });

    assert.equal(result.currentTierIndex, 0);
    assert.equal(roundRecord.tierClamped, false);
    assert.equal(roundRecord.tierClampReason, null);
  });

  it("records no clamp for an in-range escalation on a multi-tier chain", () => {
    const roundRecord = { tierBefore: 0 };
    const result = recordReworkEscalation({
      roundRecord,
      currentTierIndex: 0,
      reworkCount: 1, // 2nd rework: tierDelta +1 -> tier 1 of 2
      strategized: false,
      tierCount: 2,
    });

    assert.equal(result.currentTierIndex, 1);
    assert.equal(roundRecord.tierClamped, false);
    assert.equal(roundRecord.tierClampReason, null);
  });

  it("keeps the recorded tierAfter consistent with the model actually used", () => {
    // Driver contract: after recordReworkEscalation the driver stores
    // roundRecord.tierAfter = result.currentTierIndex.  For a single-tier
    // chain that must stay 0 (never "0 → 1").
    const roundRecord = { tierBefore: 0 };
    const escalation = recordReworkEscalation({
      roundRecord,
      currentTierIndex: 0,
      reworkCount: 1,
      strategized: false,
      tierCount: 1,
    });
    roundRecord.tierAfter = escalation.currentTierIndex;
    assert.equal(roundRecord.tierAfter, 0);
    assert.equal(roundRecord.tierClamped, true);
  });

  it("wires the anchoring-override evidence through to deriveReworkStrategy on the 1st rework", () => {
    // Kusabi #62: a round that ended `approve` + probes red must schedule its
    // 1st rework with a NEW session, tier unchanged, and a reason naming the
    // anchoring trigger — the same lever the driver will read back as
    // reworkStrategyReason.
    const roundRecord = { tierBefore: 0 };
    const result = recordReworkEscalation({
      roundRecord,
      currentTierIndex: 0,
      reworkCount: 0,
      strategized: false,
      tierCount: 2,
      chainVerdict: "approve",
      chainRepeatedAreas: false,
      probesGreen: false,
    });
    assert.equal(result.strategy.newSession, true);
    assert.equal(result.strategy.tierDelta, 0);
    assert.match(result.strategy.reason, /worker claimed done, probes red: anchoring break/);
    assert.equal(result.currentTierIndex, 0);
    assert.equal(roundRecord.tierClamped, false);
    assert.equal(roundRecord.tierClampReason, null);
  });

  it("wires the repeatedAreas anchoring-override evidence through on the 1st rework", () => {
    const roundRecord = { tierBefore: 0 };
    const result = recordReworkEscalation({
      roundRecord,
      currentTierIndex: 0,
      reworkCount: 0,
      strategized: false,
      tierCount: 2,
      chainVerdict: "needs-attention",
      chainRepeatedAreas: true,
      probesGreen: false,
    });
    assert.equal(result.strategy.newSession, true);
    assert.equal(result.strategy.tierDelta, 0);
    assert.match(result.strategy.reason, /same file area flagged across rounds: anchoring break/);
  });

  it("does not trigger the override from the default ladder inputs alone", () => {
    // Existing callers that pass no evidence keep the plain 1st-rework row:
    // continue session, same tier.
    const roundRecord = { tierBefore: 0 };
    const result = recordReworkEscalation({
      roundRecord,
      currentTierIndex: 0,
      reworkCount: 0,
      strategized: false,
      tierCount: 2,
    });
    assert.equal(result.strategy.newSession, false);
    assert.equal(result.strategy.tierDelta, 0);
  });
});

// normalizeFilePath — path normalisation for cross-round comparison
// =========================================================================

describe("normalizeFilePath", () => {
  it("trims whitespace from paths", () => {
    assert.equal(normalizeFilePath("  src/a/b.py  "), "src/a/b.py");
  });

  it("returns empty string for null / undefined", () => {
    assert.equal(normalizeFilePath(null), "");
    assert.equal(normalizeFilePath(undefined), "");
  });

  it("returns the path unchanged when there is no leading/trailing whitespace", () => {
    assert.equal(normalizeFilePath("/workspace/src/a/b.py"), "/workspace/src/a/b.py");
    assert.equal(normalizeFilePath("src/a/b.py"), "src/a/b.py");
  });
});

// hasRepeatedAreas — cross-round file-path comparison.
// =========================================================================

describe("hasRepeatedAreas", () => {
  it("detects repeat when absolute and relative paths refer to same file", () => {
    // round 1 findingFiles stored /workspace/src/secret_scan.py;
    // round 2 reports src/secret_scan.py — suffix match catches it.
    const previousFindingFiles = ["/workspace/src/sunaba/tools/secret_scan.py"];
    const currentFindings = [
      { file: "src/sunaba/tools/secret_scan.py", severity: "high", title: "Issue", line_start: 10 },
    ];
    assert.equal(hasRepeatedAreas(previousFindingFiles, currentFindings), true);
  });

  it("does not false-positive on parentheses in finding titles", () => {
    // The old regex-based approach parsed findingsText and would have
    // matched "(src/helper.js)" from the title.  hasRepeatedAreas reads
    // f.file from the structured data, which ignores the title entirely.
    const previousFindingFiles = ["src/helper.js"];
    const currentFindings = [
      { file: "src/other.js", severity: "high", title: "The (src/helper.js) function is unused", line_start: 15 },
    ];
    assert.equal(hasRepeatedAreas(previousFindingFiles, currentFindings), false);
  });

  it("returns false for genuinely different files across rounds", () => {
    const previousFindingFiles = ["src/alpha.js", "src/beta.js"];
    const currentFindings = [
      { file: "src/gamma.js", severity: "low", title: "Different file", line_start: 5 },
    ];
    assert.equal(hasRepeatedAreas(previousFindingFiles, currentFindings), false);
  });

  it("returns false when previousFindingFiles is missing (undefined, old records)", () => {
    const currentFindings = [
      { file: "src/file.js", severity: "high", title: "Something", line_start: 10 },
    ];
    assert.equal(hasRepeatedAreas(undefined, currentFindings), false);
  });

  it("returns false when previousFindingFiles is null (first round)", () => {
    const currentFindings = [
      { file: "src/file.js", severity: "low", title: "First issue", line_start: 1 },
    ];
    assert.equal(hasRepeatedAreas(null, currentFindings), false);
  });

  it("returns false when currentFindings is null (unparseable review)", () => {
    // Critical regression: chainParsedReview is null when the review
    // output could not be parsed — must not throw.
    const previousFindingFiles = ["src/file.js"];
    assert.equal(hasRepeatedAreas(previousFindingFiles, null), false);
  });

  it("returns false when currentFindings is empty array", () => {
    const previousFindingFiles = ["src/file.js"];
    assert.equal(hasRepeatedAreas(previousFindingFiles, []), false);
  });

  it("detects repeat when current round has a finding in a previously-flagged file", () => {
    const previousFindingFiles = ["src/shared.js", "src/other.js"];
    const currentFindings = [
      { file: "/workspace/src/shared.js", severity: "high", title: "Same file", line_start: 42 },
      { file: "src/new.js", severity: "low", title: "New file", line_start: 1 },
    ];
    assert.equal(hasRepeatedAreas(previousFindingFiles, currentFindings), true);
  });

  it("matches when one path is a suffix of the other on path-segment boundaries", () => {
    // Round 1: absolute container path; Round 2: relative repo path
    assert.equal(
      hasRepeatedAreas(
        ["/workspace/src/a/b/c.py"],
        [{ file: "src/a/b/c.py" }],
      ),
      true,
    );
    // Round 1: relative; Round 2: absolute
    assert.equal(
      hasRepeatedAreas(
        ["src/a/b/c.py"],
        [{ file: "/workspace/src/a/b/c.py" }],
      ),
      true,
    );
    // Different segments, same suffix length
    assert.equal(
      hasRepeatedAreas(
        ["/other/root/src/foo.py"],
        [{ file: "src/foo.py" }],
      ),
      true,
    );
  });

  it("does not match partial segment overlap", () => {
    // "src/foo-bar.py" is NOT a suffix of "src/foo.py" on segment boundaries
    assert.equal(
      hasRepeatedAreas(
        ["src/foo.py"],
        [{ file: "src/foo-bar.py" }],
      ),
      false,
    );
  });
});
