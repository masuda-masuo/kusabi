import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import {
  collectChainRecords,
  computeStats,
  renderChainStats,
  renderComparison,
} from "./chain-stats.mjs";

// ---------------------------------------------------------------------------
// Helpers: build chain fixture objects
// ---------------------------------------------------------------------------

// Sentinel used by round() to distinguish "caller did not pass findingsText"
// from "caller explicitly passed findingsText: ''".  When the caller does not
// pass findingsText at all, the helper auto-generates it from the findings
// array.  When the caller passes findingsText: '', the empty string is used
// verbatim, allowing tests to verify the computeStats fallback path.
const FINDINGS_TEXT_UNSET = Symbol("findingsText not set");

/**
 * Build a minimal round record fixture.
 *
 * NOTE: passing `undefined` for a property uses its default (ES6 destructuring).
 * To explicitly set a property to `undefined` (e.g. to simulate a missing field),
 * use `null` or just omit it (tests that need a missing field use null).
 *
 * `findingsText` default is a sentinel rather than `""` so the helper can
 * distinguish "caller omitted" from "caller passed empty string".  When the
 * caller omits findingsText and findings are present, the helper auto-generates
 * findingsText from the findings' titles.  When the caller passes
 * findingsText: "", the empty string is stored verbatim — no auto-generation.
 */
function round({
  round = 1,
  verdict = "approve",
  probesGreen = true,
  disposition = "accept",
  dispositionReason = "",
  findingFiles,
  findings,
  findingsText = FINDINGS_TEXT_UNSET,
  startedAt = new Date("2026-01-01").toISOString(),
  implementUsage = null,
  reviewUsage = null,
  reviewFirstUsage = null,
  strategistUsage = null,
  worktreeChanged = null,
} = {}) {
  const safeFindings = Array.isArray(findings) ? findings : (findings === null ? null : undefined);
  const safeFindingFiles = Array.isArray(findingFiles) ? findingFiles : (findingFiles === null ? null : undefined);
  const r = {
    round,
    startedAt,
    verdict,
    probesGreen,
    disposition: { disposition, reason: dispositionReason || undefined },
  };
  // Only set fields that have non-null values so missing-field detection works
  if (safeFindingFiles !== undefined) r.findingFiles = safeFindingFiles;
  if (safeFindings !== undefined) r.findings = safeFindings;

  // findingsText: sentinel → auto-generate from findings; explicit string → use verbatim
  if (findingsText !== FINDINGS_TEXT_UNSET) {
    r.findingsText = findingsText;
  } else if (safeFindings && safeFindings.length > 0) {
    r.findingsText = safeFindings.map((f) => `[${f.severity}] ${f.title}`).join("\n");
  } else {
    r.findingsText = "";
  }

  if (implementUsage) r.implementUsage = implementUsage;
  if (reviewUsage) r.reviewUsage = reviewUsage;
  if (reviewFirstUsage) r.reviewFirstUsage = reviewFirstUsage;
  if (strategistUsage) r.strategistUsage = strategistUsage;
  // worktreeChanged (kusabi #165): null (default) means the field stays
  // ABSENT, exercising the old-record "unknown" path; pass true/false to
  // record a measured change/no-change.
  if (worktreeChanged !== null) r.worktreeChanged = worktreeChanged;
  return r;
}

/**
 * Build a minimal chain fixture.
 */
function chain({
  chainId = "chain-test-001",
  rounds = [],
  chainTotals = null,
  modelChain,
} = {}) {
  // Filter out undefined entries from rounds
  const safeRounds = rounds.filter(Boolean);
  const meta = {
    chainId,
    chainTotals: chainTotals || undefined,
  };
  if (modelChain !== undefined) {
    meta.modelChain = modelChain;
  }
  return {
    chainId,
    meta,
    rounds: safeRounds,
  };
}

// ---------------------------------------------------------------------------
// collectChainRecords
// ---------------------------------------------------------------------------

describe("collectChainRecords", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-ccr-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty when no chains directory exists", () => {
    const result = collectChainRecords(tmpDir);
    assert.deepEqual(result, { chains: [], skipped: 0, noRecord: 0 });
  });

  it("counts a chain dir with no chain.json separately from corruption", () => {
    // A chain that died before persisting is not a corrupt record, and
    // conflating the two hides the runs that crashed.
    const chainsDir = path.join(tmpDir, "chains");
    fs.mkdirSync(path.join(chainsDir, "chain-never-wrote"), { recursive: true });
    fs.mkdirSync(path.join(chainsDir, "chain-corrupt"), { recursive: true });
    fs.mkdirSync(path.join(chainsDir, "chain-ok"), { recursive: true });

    fs.writeFileSync(path.join(chainsDir, "chain-corrupt", "chain.json"), "{ not json", "utf8");
    fs.writeFileSync(
      path.join(chainsDir, "chain-ok", "chain.json"),
      JSON.stringify({ chainId: "chain-ok", records: [] }),
      "utf8",
    );

    const result = collectChainRecords(tmpDir);
    assert.equal(result.chains.length, 1);
    assert.equal(result.skipped, 1, "corrupt json counts as skipped");
    assert.equal(result.noRecord, 1, "missing chain.json counts as noRecord");
  });

  it("reads chain.json records from each chain dir", () => {
    const chainsDir = path.join(tmpDir, "chains");
    fs.mkdirSync(path.join(chainsDir, "chain-one"), { recursive: true });
    fs.mkdirSync(path.join(chainsDir, "chain-two"), { recursive: true });

    fs.writeFileSync(
      path.join(chainsDir, "chain-one", "chain.json"),
      JSON.stringify({ chainId: "chain-one", records: [{ round: 1, verdict: "approve" }] }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(chainsDir, "chain-two", "chain.json"),
      JSON.stringify({ chainId: "chain-two", records: [{ round: 1, verdict: "needs-attention" }] }),
      "utf8",
    );

    const result = collectChainRecords(tmpDir);
    assert.equal(result.skipped, 0);
    assert.equal(result.chains.length, 2);
    assert.equal(result.chains[0].rounds[0].verdict, "approve");
    assert.equal(result.chains[1].rounds[0].verdict, "needs-attention");
  });

  it("skips malformed chain.json and counts them", () => {
    const chainsDir = path.join(tmpDir, "chains");
    fs.mkdirSync(path.join(chainsDir, "chain-good"), { recursive: true });
    fs.mkdirSync(path.join(chainsDir, "chain-bad"), { recursive: true });

    fs.writeFileSync(
      path.join(chainsDir, "chain-good", "chain.json"),
      JSON.stringify({ chainId: "chain-good", records: [] }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(chainsDir, "chain-bad", "chain.json"),
      "not valid json",
      "utf8",
    );

    const result = collectChainRecords(tmpDir);
    assert.equal(result.skipped, 1);
    assert.equal(result.chains.length, 1);
  });

  it("skips non-chain-* directories", () => {
    const chainsDir = path.join(tmpDir, "chains");
    fs.mkdirSync(path.join(chainsDir, "chain-one"), { recursive: true });
    fs.mkdirSync(path.join(chainsDir, "not-a-chain"), { recursive: true });

    fs.writeFileSync(
      path.join(chainsDir, "chain-one", "chain.json"),
      JSON.stringify({ chainId: "chain-one", records: [] }),
      "utf8",
    );

    const result = collectChainRecords(tmpDir);
    assert.equal(result.skipped, 0);
    assert.equal(result.chains.length, 1);
  });
});

// ---------------------------------------------------------------------------
// computeStats — core statistics
// ---------------------------------------------------------------------------

describe("computeStats", () => {
  it("produces the expected disposition and verdict distributions", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [
          round({ round: 1, verdict: "approve", disposition: "accept" }),
        ],
      }),
      chain({
        chainId: "c2",
        rounds: [
          round({ round: 1, verdict: "approve", disposition: "accept" }),
        ],
      }),
      chain({
        chainId: "c3",
        rounds: [
          round({ round: 1, verdict: "needs-attention", disposition: "accept-with-followup", findings: [{ severity: "low", title: "minor", file: "a.js", line_start: 1, line_end: 1 }] }),
        ],
      }),
      chain({
        chainId: "c4",
        rounds: [
          round({ round: 1, verdict: "needs-attention", disposition: "rework" }),
          round({ round: 2, verdict: "approve", disposition: "accept" }),
        ],
      }),
      chain({
        chainId: "c5",
        rounds: [
          round({ round: 1, verdict: "approve", disposition: "escalate" }),
        ],
      }),
    ];

    const stats = computeStats(chains);
    assert.equal(stats.chainCount, 5);
    assert.equal(stats.roundCount, 6);
    assert.equal(stats.dispositionCounts.accept, 3); // c1, c2, c4
    assert.equal(stats.dispositionCounts["accept-with-followup"], 1); // c3
    assert.equal(stats.dispositionCounts.escalate, 1); // c5

    // Verdicts
    assert.equal(stats.verdictCounts.approve, 4); // c1r1, c2r1, c4r2, c5r1
    assert.equal(stats.verdictCounts["needs-attention"], 2); // c3r1, c4r1
  });

  it("rounds without a previous round are excluded from the repeatedAreas denominator", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [
          round({ round: 1, verdict: "approve", disposition: "accept", findingFiles: ["a.js"], findings: [] }),
        ],
      }),
      chain({
        chainId: "c2",
        rounds: [
          round({ round: 1, verdict: "needs-attention", disposition: "rework", findingFiles: ["a.js"], findings: [] }),
          round({ round: 2, verdict: "approve", disposition: "accept", findingFiles: ["a.js"], findings: [{ severity: "low", title: "same area", file: "a.js", line_start: 1, line_end: 1 }] }),
        ],
      }),
    ];

    const stats = computeStats(chains);
    // c1r1 has no previous round -> excluded
    // c2r2 has c2r1 as previous -> eligible
    // c2r1 has no previous round -> excluded
    assert.equal(stats.eligiblePairs, 1);
    // c2r2 findings includes "a.js" which matches c2r1 findingFiles ["a.js"] -> repeatedAreas true
    assert.equal(stats.repeatedTrue, 1);
  });

  it("a record missing findings/findingFiles is counted as unavailable", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [
          // Round 1 has findingFiles but no findings array
          round({ round: 1, verdict: "needs-attention", disposition: "rework", findingFiles: ["a.js"], findings: null }),
          // Round 2 has findings but no findingFiles
          round({ round: 2, verdict: "approve", disposition: "accept", findingFiles: null, findings: [{ severity: "low", title: "thing", file: "a.js", line_start: 1, line_end: 1 }] }),
        ],
      }),
    ];

    const stats = computeStats(chains);
    assert.equal(stats.findingsNA, 1);
    assert.equal(stats.findingFilesNA, 1);
  });

  it("a record missing findings fields is not counted in repeatedAreas denominator when fields absent", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [
          round({ round: 1, verdict: "needs-attention", disposition: "rework", findingFiles: ["a.js"], findings: [] }),
          round({ round: 2, verdict: "needs-attention", disposition: "rework", findingFiles: null, findings: null }),
        ],
      }),
    ];

    const stats = computeStats(chains);
    // One eligible pair (round 1 -> round 2)
    assert.equal(stats.eligiblePairs, 1);
    // But neither previous nor current have the required fields, so repeatedNA++
    assert.equal(stats.repeatedNA, 1);
    assert.equal(stats.repeatedTrue, 0);
  });

  it("restricting to a time range selects the expected subset", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [
          round({ round: 1, startedAt: "2026-01-01T00:00:00.000Z", verdict: "approve", disposition: "accept" }),
        ],
      }),
      chain({
        chainId: "c2",
        rounds: [
          round({ round: 1, startedAt: "2026-06-15T00:00:00.000Z", verdict: "needs-attention", disposition: "rework" }),
          round({ round: 2, startedAt: "2026-06-20T00:00:00.000Z", verdict: "approve", disposition: "accept" }),
        ],
      }),
    ];

    // since=2026-06-01 should only include c2 rounds
    const stats = computeStats(chains, { since: "2026-06-01T00:00:00.000Z" });
    assert.equal(stats.chainCount, 1); // only c2 has rounds in range
    assert.equal(stats.roundCount, 2);
    assert.equal(stats.dispositionCounts.accept, 1); // only c2 final disposition is accept

    // until=2026-06-01 should only include c1 rounds
    const stats2 = computeStats(chains, { until: "2026-06-01T00:00:00.000Z" });
    assert.equal(stats2.roundCount, 1);
    assert.equal(stats2.chainCount, 1); // only c1 has rounds in range
    assert.equal(stats2.dispositionCounts.accept, 1); // c1

    // since + until together
    const stats3 = computeStats(chains, {
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-12-31T00:00:00.000Z",
    });
    assert.equal(stats3.roundCount, 3);
  });

  it("the before/after comparison reports both ranges", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [
          round({ round: 1, startedAt: "2026-01-01T00:00:00.000Z", verdict: "approve", disposition: "accept" }),
        ],
      }),
      chain({
        chainId: "c2",
        rounds: [
          round({ round: 1, startedAt: "2026-07-01T00:00:00.000Z", verdict: "needs-attention", disposition: "rework" }),
          round({ round: 2, startedAt: "2026-07-02T00:00:00.000Z", verdict: "approve", disposition: "accept" }),
        ],
      }),
    ];

    const cutoff = "2026-06-01T00:00:00.000Z";
    const beforeStats = computeStats(chains, { until: cutoff });
    const afterStats = computeStats(chains, { since: cutoff });

    // Before: only c1
    assert.equal(beforeStats.roundCount, 1);
    assert.equal(beforeStats.chainCount, 1); // only c1 has rounds before cutoff
    assert.equal(beforeStats.dispositionCounts.accept, 1);

    // After: c2 rounds
    assert.equal(afterStats.roundCount, 2);
    assert.equal(afterStats.chainCount, 1); // only c2 has rounds after cutoff
    assert.equal(afterStats.dispositionCounts.accept, 1);

    // Render comparison (just verify it doesn't throw and contains both labels)
    const rendered = renderComparison(beforeStats, afterStats, cutoff);
    assert.ok(rendered.includes("Before"));
    assert.ok(rendered.includes("After"));
    assert.ok(rendered.includes("Cutoff"));
  });

  it("comparison reports 'no data' when every eligible pair lacks findingFiles", () => {
    // Regression: the comparison view printed "0/11" in this case, which reads
    // as "the detector never fired" rather than "nothing was measurable".
    const chains = [
      chain({
        chainId: "old",
        rounds: [
          round({ round: 1, startedAt: "2026-01-01T00:00:00.000Z", verdict: "needs-attention", disposition: "rework" }),
          round({ round: 2, startedAt: "2026-01-02T00:00:00.000Z", verdict: "needs-attention", disposition: "rework" }),
        ],
      }),
    ];
    for (const r of chains[0].rounds) {
      delete r.findingFiles;
      delete r.findings;
    }

    const cutoff = "2026-06-01T00:00:00.000Z";
    const beforeStats = computeStats(chains, { until: cutoff });
    const afterStats = computeStats(chains, { since: cutoff });

    assert.ok(beforeStats.eligiblePairs > 0, "the fixture must produce an eligible pair");
    assert.equal(beforeStats.repeatedNA, beforeStats.eligiblePairs, "every pair must be undecidable");

    const rendered = renderComparison(beforeStats, afterStats, cutoff);
    assert.ok(rendered.includes("no data"), "undecidable pairs must render as 'no data'");
    assert.ok(
      !/repeatedAreas true\s+0\/\d/.test(rendered),
      "must not print a 0/N rate over undecidable pairs",
    );
  });

  it("chainCount is zero when no chains have rounds in the time-filtered range", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [
          round({ round: 1, startedAt: "2026-01-01T00:00:00.000Z" }),
        ],
      }),
    ];
    const stats = computeStats(chains, { since: "2026-06-01T00:00:00.000Z" });
    assert.equal(stats.chainCount, 0);
    assert.equal(stats.roundCount, 0);
  });

  it("rounds without startedAt are excluded when time filtering is active and counted in noTimestampCount", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [
          // Round 1 has startedAt, round 2 does not
          round({ round: 1, startedAt: "2026-01-01T00:00:00.000Z", verdict: "approve", disposition: "accept" }),
          { round: 2, verdict: "needs-attention" },
        ],
      }),
    ];

    // Without time filter: both rounds included, no excluded count
    const noFilter = computeStats(chains);
    assert.equal(noFilter.roundCount, 2);
    assert.equal(noFilter.noTimestampCount, 0);

    // With time filter: round 2 is excluded, counted
    const withFilter = computeStats(chains, { since: "2026-01-01T00:00:00.000Z" });
    assert.equal(withFilter.roundCount, 1); // only round 1
    assert.equal(withFilter.noTimestampCount, 1); // round 2 excluded
    assert.equal(withFilter.chainCount, 1); // c1 still has round 1
  });

  it("computes token and cost totals from chainTotals", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [
          round({ round: 1, verdict: "approve", disposition: "accept", implementUsage: { available: true, input: 100, output: 50, cost: 0.01 } }),
        ],
        chainTotals: { input: 100, output: 50, cost: 0.01 },
      }),
      chain({
        chainId: "c2",
        rounds: [
          round({ round: 1, verdict: "needs-attention", disposition: "rework", implementUsage: { available: true, input: 200, output: 100, cost: 0.02 } }),
          round({ round: 2, verdict: "approve", disposition: "accept", implementUsage: { available: true, input: 50, output: 25, cost: 0.005 } }),
        ],
        chainTotals: { input: 250, output: 125, cost: 0.025 },
      }),
    ];

    const stats = computeStats(chains);
    // overallTotals from chainTotals
    assert.equal(stats.overallTotals.input, 350);
    assert.equal(stats.overallTotals.cost, 0.035);
    // filteredTotals from per-round usage
    assert.equal(stats.filteredTotals.input, 350);
  });

  it("filteredTotals sums reviewFirstUsage when a retried round has both attempts' usage", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [
          round({
            round: 1,
            verdict: "approve",
            disposition: "accept",
            implementUsage: { available: true, input: 100, output: 50, cost: 0.01 },
            reviewUsage: { available: true, input: 20, output: 10, cost: 0.002 },
            reviewFirstUsage: { available: true, input: 20, output: 10, cost: 0.002 },
          }),
        ],
        chainTotals: { input: 140, output: 70, cost: 0.014 },
      }),
    ];

    const stats = computeStats(chains);
    // 100 implement + 20 final review + 20 first-attempt review
    assert.equal(stats.filteredTotals.input, 140);
    assert.equal(stats.filteredTotals.output, 70);
    assert.equal(stats.filteredTotals.cost, 0.014);
  });

  it("filteredTotals is unchanged for rounds without reviewFirstUsage", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [
          round({
            round: 1,
            verdict: "approve",
            disposition: "accept",
            implementUsage: { available: true, input: 100, output: 50, cost: 0.01 },
            reviewUsage: { available: true, input: 20, output: 10, cost: 0.002 },
          }),
        ],
        chainTotals: { input: 120, output: 60, cost: 0.012 },
      }),
    ];

    const stats = computeStats(chains);
    assert.equal(stats.filteredTotals.input, 120);
    assert.equal(stats.filteredTotals.output, 60);
    assert.equal(stats.filteredTotals.cost, 0.012);
  });
});

// ---------------------------------------------------------------------------
// computeStats — escalate substantive/no-work split (kusabi #165)
// ---------------------------------------------------------------------------

describe("computeStats — escalate split", () => {
  it("splits escalated chains into substantive / no-work / unknown, preserving the total", () => {
    const chains = [
      // Substantive: round 1 changed the worktree, chain still escalated.
      chain({
        chainId: "esc-substantive",
        rounds: [
          round({ round: 1, verdict: "needs-attention", disposition: "escalate", worktreeChanged: true }),
        ],
      }),
      // No-work: round measured no change (the 722-token zero-change shape).
      chain({
        chainId: "esc-nowork",
        rounds: [
          round({
            round: 1,
            verdict: "needs-attention",
            disposition: "escalate",
            worktreeChanged: false,
            implementUsage: { available: true, input: 4000, output: 722, cost: 0.0004 },
          }),
        ],
      }),
      // Unknown: old record — no worktreeChanged field at all.
      chain({
        chainId: "esc-unknown",
        rounds: [
          round({ round: 1, verdict: "needs-attention", disposition: "escalate" }),
        ],
      }),
      // Non-escalated chains must not touch the split at all.
      chain({
        chainId: "acc",
        rounds: [
          round({ round: 1, verdict: "approve", disposition: "accept", worktreeChanged: true }),
        ],
      }),
      chain({
        chainId: "disc",
        rounds: [
          round({ round: 1, verdict: "discard", disposition: "discard", worktreeChanged: false }),
        ],
      }),
    ];

    const stats = computeStats(chains);
    // Total per disposition stays exactly as before the split existed.
    assert.equal(stats.dispositionCounts.escalate, 3);
    assert.equal(stats.dispositionCounts.accept, 1);
    assert.equal(stats.dispositionCounts.discard, 1);
    assert.deepEqual(stats.escalateSplit, { substantive: 1, noWork: 1, unknown: 1 });
    // The split sums to the escalate total — invariant for longitudinal
    // comparisons.
    const { substantive, noWork, unknown } = stats.escalateSplit;
    assert.equal(substantive + noWork + unknown, stats.dispositionCounts.escalate);
  });

  it("a multi-round escalate is substantive when ANY round changed the worktree", () => {
    const chains = [
      chain({
        chainId: "esc-multi",
        rounds: [
          round({ round: 1, verdict: "needs-attention", disposition: "rework", worktreeChanged: true }),
          round({ round: 2, verdict: "needs-attention", disposition: "escalate", worktreeChanged: false }),
        ],
      }),
    ];
    const stats = computeStats(chains);
    assert.equal(stats.dispositionCounts.escalate, 1);
    assert.deepEqual(stats.escalateSplit, { substantive: 1, noWork: 0, unknown: 0 });
  });

  it("an escalated chain with no measured rounds at all is unknown, never no-work", () => {
    const chains = [
      chain({
        chainId: "esc-old",
        rounds: [
          round({ round: 1, verdict: "needs-attention", disposition: "escalate" }),
        ],
      }),
    ];
    const stats = computeStats(chains);
    assert.deepEqual(stats.escalateSplit, { substantive: 0, noWork: 0, unknown: 1 });
  });

  it("no escalated chains → the split is all zeros", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [round({ round: 1, verdict: "approve", disposition: "accept" })],
      }),
    ];
    const stats = computeStats(chains);
    assert.equal(stats.dispositionCounts.escalate, 0);
    assert.deepEqual(stats.escalateSplit, { substantive: 0, noWork: 0, unknown: 0 });
  });

  it("time-filtered stats classify over the same in-range rounds that set the disposition", () => {
    // Round 1 (changed) is outside the range; the in-range round 2 is the
    // escalate round with measured no-change → the split must agree with
    // the in-range disposition (no-work), not with the full chain history.
    const chains = [
      chain({
        chainId: "esc-window",
        rounds: [
          round({ round: 1, startedAt: "2026-01-01T00:00:00.000Z", verdict: "needs-attention", disposition: "rework", worktreeChanged: true }),
          round({ round: 2, startedAt: "2026-07-01T00:00:00.000Z", verdict: "needs-attention", disposition: "escalate", worktreeChanged: false }),
        ],
      }),
    ];
    const stats = computeStats(chains, { since: "2026-06-01T00:00:00.000Z" });
    assert.equal(stats.dispositionCounts.escalate, 1);
    assert.deepEqual(stats.escalateSplit, { substantive: 0, noWork: 1, unknown: 0 });
  });
});

// ---------------------------------------------------------------------------
// renderChainStats
// ---------------------------------------------------------------------------

describe("renderChainStats", () => {
  it("produces readable output for empty data", () => {
    const stats = computeStats([]);
    const output = renderChainStats(stats);
    assert.ok(output.includes("Chain stats"));
    assert.ok(output.includes("Chains"));
    assert.ok(output.includes("Rounds"));
  });

  it("includes range labels when opts are given", () => {
    const stats = computeStats([]);
    const output = renderChainStats(stats, { since: "2026-01-01", until: "2026-06-30" });
    assert.ok(output.includes("since 2026-01-01"));
    assert.ok(output.includes("until 2026-06-30"));
  });

  it("mentions heuristic label for prior-unresolved figure", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [
          round({ round: 1, verdict: "needs-attention", disposition: "rework", findingFiles: ["a.js"], findings: [] }),
          round({ round: 2, verdict: "approve", disposition: "accept", findingFiles: ["a.js"], findings: [{ severity: "low", title: "(prior finding, not addressed)", file: "a.js", line_start: 1, line_end: 1 }], findingsText: "(prior finding, not addressed)" }),
        ],
      }),
    ];

    const stats = computeStats(chains);
    const output = renderChainStats(stats);
    // The heuristic label must appear near the prior-unresolved number
    assert.ok(output.includes("heuristic"));
    assert.ok(output.includes("Flagged as unresolved"));
  });

  it("annotates the escalate disposition line with the substantive/no-work split", () => {
    const chains = [
      chain({
        chainId: "esc-sub",
        rounds: [round({ round: 1, verdict: "needs-attention", disposition: "escalate", worktreeChanged: true })],
      }),
      chain({
        chainId: "esc-nw",
        rounds: [round({ round: 1, verdict: "needs-attention", disposition: "escalate", worktreeChanged: false })],
      }),
      chain({
        chainId: "esc-unk",
        rounds: [round({ round: 1, verdict: "needs-attention", disposition: "escalate" })],
      }),
    ];
    const output = renderChainStats(computeStats(chains));
    const escLine = output.split("\n").find((l) => l.includes("escalate"));
    assert.ok(escLine, "escalate disposition line must exist");
    assert.match(escLine, /escalate \(substantive 1, no-work 1, n\/a 1\)/);
    // The total and its percentage are unchanged by the annotation.
    assert.match(escLine, /3 \(100\.0%\)/);
  });

  it("keeps the plain escalate line when no escalate has a classifiable split", () => {
    // Unknown-only split still annotates — absent data must be visible, not
    // silently rendered as no-work 0.
    const chains = [
      chain({
        chainId: "esc-unk",
        rounds: [round({ round: 1, verdict: "needs-attention", disposition: "escalate" })],
      }),
    ];
    const output = renderChainStats(computeStats(chains));
    const escLine = output.split("\n").find((l) => l.includes("escalate"));
    assert.match(escLine, /escalate \(n\/a 1\)/);
  });

  it("renders a plain 'escalate' line when there are no escalates at all", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [round({ round: 1, verdict: "approve", disposition: "accept" })],
      }),
    ];
    const output = renderChainStats(computeStats(chains));
    const escLine = output.split("\n").find((l) => l.includes("escalate"));
    assert.ok(escLine);
    assert.doesNotMatch(escLine, /\(substantive|no-work|n\/a/);
  });
});

// ---------------------------------------------------------------------------
// Interaction: malformed chain.json in collectChainRecords
// ---------------------------------------------------------------------------

describe("chain-stats malformed chain.json", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-stats-malformed-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a malformed chain.json is skipped and counted", () => {
    const chainsDir = path.join(tmpDir, "chains");
    fs.mkdirSync(path.join(chainsDir, "chain-bad"), { recursive: true });
    fs.writeFileSync(
      path.join(chainsDir, "chain-bad", "chain.json"),
      "{ not valid json",
      "utf8",
    );

    const result = collectChainRecords(tmpDir);
    assert.equal(result.skipped, 1);
    assert.equal(result.chains.length, 0);
  });

  it("run still completes when some chain.json files are malformed", () => {
    const chainsDir = path.join(tmpDir, "chains");
    fs.mkdirSync(path.join(chainsDir, "chain-good"), { recursive: true });
    fs.mkdirSync(path.join(chainsDir, "chain-bad"), { recursive: true });

    fs.writeFileSync(
      path.join(chainsDir, "chain-good", "chain.json"),
      JSON.stringify({ chainId: "chain-good", records: [{ round: 1, verdict: "approve" }] }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(chainsDir, "chain-bad", "chain.json"),
      "}bad json{",
      "utf8",
    );

    const result = collectChainRecords(tmpDir);
    assert.equal(result.skipped, 1);
    assert.equal(result.chains.length, 1);
    assert.equal(result.chains[0].chainId, "chain-good");

    // Compute stats from the surviving chain
    const stats = computeStats(result.chains);
    assert.equal(stats.roundCount, 1);
    assert.equal(stats.chainCount, 1);
  });
});

// ---------------------------------------------------------------------------
// Prior-unresolved heuristic detection
// ---------------------------------------------------------------------------

describe("prior-unresolved heuristic", () => {
  it("detects '(prior finding, not addressed)' in findingsText", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [
          round({ round: 1, verdict: "needs-attention", disposition: "rework", findingFiles: ["a.js"], findings: [] }),
          round({ round: 2, verdict: "approve", disposition: "accept", findingsText: "(prior finding, not addressed)" }),
        ],
      }),
    ];

    const stats = computeStats(chains);
    assert.equal(stats.priorUnresolvedCount, 1);
    assert.equal(stats.priorUnresolvedEligible, 1);
  });

  it("detects 'Prior finding #2 unresolved:' in findingsText", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [
          round({ round: 1, verdict: "needs-attention", disposition: "rework" }),
          round({ round: 2, verdict: "needs-attention", disposition: "rework", findingsText: "Prior finding #2 unresolved: still broken" }),
        ],
      }),
    ];

    const stats = computeStats(chains);
    assert.equal(stats.priorUnresolvedCount, 1);
  });

  it("does not flag rounds without the pattern", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [
          round({ round: 1, verdict: "needs-attention", disposition: "rework" }),
          round({ round: 2, verdict: "approve", disposition: "accept", findingsText: "All issues resolved" }),
        ],
      }),
    ];

    const stats = computeStats(chains);
    assert.equal(stats.priorUnresolvedCount, 0);
  });

  it("falls back to finding titles when findingsText is empty", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [
          round({ round: 1, verdict: "needs-attention", disposition: "rework", findingsText: "" }),
          round({
            round: 2,
            verdict: "needs-attention",
            disposition: "rework",
            findingsText: "",
            findings: [
              { severity: "high", title: "Prior finding not addressed: security issue", file: "x.js", line_start: 1, line_end: 1 },
            ],
          }),
        ],
      }),
    ];

    const stats = computeStats(chains);
    assert.equal(stats.priorUnresolvedCount, 1);
  });
});

// ---------------------------------------------------------------------------
// resolveRoundTier — tier resolution
// ---------------------------------------------------------------------------

import { resolveRoundTier } from "./chain-stats.mjs";

describe("resolveRoundTier", () => {
  it("resolves on a flat chain to the tier index of the route (derived)", () => {
    const round = { modelEntry: "p/pro" };
    const modelChain = ["p/flash", "p/pro"];
    const result = resolveRoundTier(round, modelChain);
    assert.deepEqual(result, { tierIndex: 1, tierCount: 2, source: "derived" });
  });

  it("resolves on a tiered chain with second route in first tier to tier 0", () => {
    const round = { modelEntry: "p/flash" };
    const modelChain = [["p/free", "p/flash"], ["p/pro"]];
    const result = resolveRoundTier(round, modelChain);
    assert.deepEqual(result, { tierIndex: 0, tierCount: 2, source: "derived" });
  });

  it("uses tierBefore when present (recorded) even when derivation would differ", () => {
    const round = { modelEntry: "p/flash", tierBefore: 1 };
    const modelChain = ["p/flash", "p/pro"];
    const result = resolveRoundTier(round, modelChain);
    // tierBefore=1 wins even though modelEntry would derive tier 0
    assert.deepEqual(result, { tierIndex: 1, tierCount: 2, source: "recorded" });
  });

  it("resolves after stripping :variant (derived-variant-insensitive)", () => {
    const round = { modelEntry: "opencode-go/deepseek-v4-pro" };
    const modelChain = ["opencode-go/deepseek-v4-flash:max", "opencode-go/deepseek-v4-pro:max"];
    const result = resolveRoundTier(round, modelChain);
    assert.deepEqual(result, { tierIndex: 1, tierCount: 2, source: "derived-variant-insensitive" });
  });

  it("returns unknown when route does not appear in the chain", () => {
    const round = { modelEntry: "p/unknown" };
    const modelChain = ["p/flash", "p/pro"];
    const result = resolveRoundTier(round, modelChain);
    assert.equal(result.source, "unknown");
    assert.equal(result.tierIndex, -1);
  });

  it("returns unknown and throws nothing when modelChain is absent", () => {
    const result = resolveRoundTier({ modelEntry: "p/flash" }, undefined);
    assert.equal(result.source, "unknown");
    assert.equal(result.tierIndex, -1);
    assert.equal(result.tierCount, 0);
  });

  it("returns unknown and throws nothing when modelChain is not an array", () => {
    const result = resolveRoundTier({ modelEntry: "p/flash" }, null);
    assert.equal(result.source, "unknown");
    assert.equal(result.tierIndex, -1);
    assert.equal(result.tierCount, 0);

    const result2 = resolveRoundTier({ modelEntry: "p/flash" }, "not-an-array");
    assert.equal(result2.source, "unknown");
  });

  it("returns unknown and throws nothing when modelEntry is absent", () => {
    const result = resolveRoundTier({}, ["p/flash", "p/pro"]);
    assert.equal(result.source, "unknown");
    assert.equal(result.tierIndex, -1);
    assert.equal(result.tierCount, 2);
  });

  it("returns unknown and throws nothing when modelEntry is null", () => {
    const result = resolveRoundTier({ modelEntry: null }, ["p/flash", "p/pro"]);
    assert.equal(result.source, "unknown");
  });

  it("returns unknown and throws nothing when modelEntry is not a string", () => {
    const result = resolveRoundTier({ modelEntry: 42 }, ["p/flash", "p/pro"]);
    assert.equal(result.source, "unknown");
  });

  it("handles modelChain entries that are numbers or null without throwing", () => {
    const round = { modelEntry: "p/flash" };
    const modelChain = [42, null, ["p/flash", "p/pro"]];
    const result = resolveRoundTier(round, modelChain);
    assert.equal(result.source, "derived");
    assert.equal(result.tierIndex, 2);
    assert.equal(result.tierCount, 3);
  });

  it("returns unknown when modelChain array is empty", () => {
    const result = resolveRoundTier({ modelEntry: "p/flash" }, []);
    assert.equal(result.source, "unknown");
    assert.equal(result.tierIndex, -1);
    assert.equal(result.tierCount, 0);
  });

  // `typeof NaN === "number"`, so a bare typeof check would report a NaN
  // tierBefore as authoritative ("recorded") while the round vanished from
  // tierCounts and the peak-tier scan -- a count over a round that appears
  // nowhere.  Falling through to derivation keeps the two views consistent.
  it("does not treat a NaN tierBefore as recorded", () => {
    const result = resolveRoundTier(
      { tierBefore: NaN, modelEntry: "p/pro" },
      ["p/flash", "p/pro"],
    );
    assert.notEqual(result.source, "recorded");
    assert.equal(result.source, "derived");
    assert.equal(result.tierIndex, 1);
    assert.ok(Number.isFinite(result.tierIndex));
  });

  it("does not treat an Infinity tierBefore as recorded", () => {
    const result = resolveRoundTier(
      { tierBefore: Infinity, modelEntry: "nope/unmatched" },
      ["p/flash", "p/pro"],
    );
    assert.equal(result.source, "unknown");
    assert.equal(result.tierIndex, -1);
  });
});

// ---------------------------------------------------------------------------
// computeStats — model and tier aggregates
// ---------------------------------------------------------------------------

describe("computeStats — model and tier", () => {
  it("produces model counts for a mixed set of chains", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [
          Object.assign(round({ round: 1 }), { modelEntry: "p/flash" }),
        ],
        modelChain: ["p/flash"],
      }),
      chain({
        chainId: "c2",
        rounds: [
          Object.assign(round({ round: 1 }), { modelEntry: "p/flash" }),
          Object.assign(round({ round: 2 }), { modelEntry: "p/pro" }),
        ],
        modelChain: ["p/flash", "p/pro"],
      }),
      chain({
        chainId: "c3",
        rounds: [
          Object.assign(round({ round: 1 }), { modelEntry: "p/pro" }),
        ],
        modelChain: ["p/flash", "p/pro"],
      }),
    ];

    const stats = computeStats(chains);
    assert.deepEqual(stats.modelCounts, { "p/flash": 2, "p/pro": 2 });
    assert.equal(stats.modelEntryNA, 0);
  });

  it("counts rounds missing modelEntry separately", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [
          round({ round: 1 }),  // no modelEntry
        ],
        modelChain: ["p/flash"],
      }),
    ];
    // Remove modelEntry to ensure it's missing
    delete chains[0].rounds[0].modelEntry;

    const stats = computeStats(chains);
    assert.equal(stats.modelEntryNA, 1);
    assert.deepEqual(stats.modelCounts, {});
  });

  it("tier counts match hand-computed values", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [
          Object.assign(round({ round: 1 }), { modelEntry: "p/flash" }),
        ],
        modelChain: ["p/flash", "p/pro"],
      }),
      chain({
        chainId: "c2",
        rounds: [
          Object.assign(round({ round: 1 }), { modelEntry: "p/flash" }),
          Object.assign(round({ round: 2 }), { modelEntry: "p/pro" }),
        ],
        modelChain: ["p/flash", "p/pro"],
      }),
      chain({
        chainId: "c3",
        rounds: [
          Object.assign(round({ round: 1 }), { modelEntry: "p/pro" }),
        ],
        modelChain: ["p/flash", "p/pro"],
      }),
    ];

    const stats = computeStats(chains);
    // tier 0: c1r1 (p/flash), c2r1 (p/flash) -> 2
    // tier 1: c2r2 (p/pro), c3r1 (p/pro) -> 2
    assert.deepEqual(stats.tierCounts, { "0": 2, "1": 2 });
    assert.equal(stats.tierSourceBreakdown.derived, 4);
    assert.equal(stats.tierSourceBreakdown.unknown, 0);
  });

  it("source breakdown sums to the number of rounds counted", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [
          Object.assign(round({ round: 1 }), { modelEntry: "p/flash" }),
        ],
        modelChain: ["p/flash", "p/pro"],
      }),
      chain({
        chainId: "c2",
        rounds: [
          Object.assign(round({ round: 1 }), { modelEntry: "p/unknown" }),
        ],
        modelChain: ["p/flash", "p/pro"],
      }),
      chain({
        chainId: "c3",
        rounds: [
          Object.assign(round({ round: 1 }), { modelEntry: "p/pro", tierBefore: 0 }),
        ],
        modelChain: ["p/flash", "p/pro"],
      }),
    ];

    const stats = computeStats(chains);
    const sourceTotal = Object.values(stats.tierSourceBreakdown).reduce((s, c) => s + c, 0);
    assert.equal(sourceTotal, stats.roundCount);
    assert.equal(stats.tierSourceBreakdown.derived, 1);
    assert.equal(stats.tierSourceBreakdown.recorded, 1);
    assert.equal(stats.tierSourceBreakdown.unknown, 1);
  });

  it("honours since/until for model and tier counts", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [
          Object.assign(round({ round: 1, startedAt: "2026-01-01T00:00:00.000Z" }), { modelEntry: "p/flash" }),
        ],
        modelChain: ["p/flash", "p/pro"],
      }),
      chain({
        chainId: "c2",
        rounds: [
          Object.assign(round({ round: 1, startedAt: "2026-06-01T00:00:00.000Z" }), { modelEntry: "p/pro" }),
        ],
        modelChain: ["p/flash", "p/pro"],
      }),
    ];

    const stats = computeStats(chains, { since: "2026-03-01T00:00:00.000Z" });
    // Only c2's round is within range
    assert.equal(stats.roundCount, 1);
    assert.deepEqual(stats.modelCounts, { "p/pro": 1 });
    assert.deepEqual(stats.tierCounts, { "1": 1 });
  });

  it("peak-tier-per-chain counts only chains with rounds in range", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [
          Object.assign(round({ round: 1, startedAt: "2026-01-01T00:00:00.000Z" }), { modelEntry: "p/flash" }),
          Object.assign(round({ round: 2, startedAt: "2026-01-02T00:00:00.000Z" }), { modelEntry: "p/pro" }),
        ],
        modelChain: ["p/flash", "p/pro"],
      }),
      chain({
        chainId: "c2",
        rounds: [
          Object.assign(round({ round: 1, startedAt: "2026-06-01T00:00:00.000Z" }), { modelEntry: "p/flash" }),
        ],
        modelChain: ["p/flash", "p/pro"],
      }),
    ];

    // since=2026-03-01 excludes c1 entirely
    const stats = computeStats(chains, { since: "2026-03-01T00:00:00.000Z" });
    assert.equal(stats.chainCount, 1);
    assert.equal(stats.chainPeakTiers.length, 1);
    assert.equal(stats.chainPeakTiers[0].chainId, "c2");
    assert.equal(stats.chainPeakTiers[0].peakTier, 0);
    assert.equal(stats.chainPeakTiers[0].tierCount, 2);
  });

  it("peak tier report includes chainsReachedTopTier", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [
          Object.assign(round({ round: 1 }), { modelEntry: "p/flash" }),
          Object.assign(round({ round: 2 }), { modelEntry: "p/pro" }),
        ],
        modelChain: ["p/flash", "p/pro"],
      }),
      chain({
        chainId: "c2",
        rounds: [
          Object.assign(round({ round: 1 }), { modelEntry: "p/flash" }),
        ],
        modelChain: ["p/flash", "p/pro"],
      }),
    ];

    const stats = computeStats(chains);
    // c1 reached tier 1 of 2 (top), c2 reached tier 0 of 2 (not top)
    assert.equal(stats.chainsReachedTopTier, 1);
  });

  it("chain shape distribution reports how many chains per tier count", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [Object.assign(round({ round: 1 }), { modelEntry: "p/flash" })],
        modelChain: ["p/flash", "p/pro"],
      }),
      chain({
        chainId: "c2",
        rounds: [Object.assign(round({ round: 1 }), { modelEntry: "p/a" })],
        modelChain: ["p/a", "p/b", "p/c"],
      }),
      chain({
        chainId: "c3",
        rounds: [Object.assign(round({ round: 1 }), { modelEntry: "p/flash" })],
        modelChain: ["p/flash", "p/pro"],
      }),
    ];

    const stats = computeStats(chains);
    assert.deepEqual(stats.chainShapeDistribution, { "2": 2, "3": 1 });
  });

  it("distinguishes fallbacks absent from fallbacks null in the stats", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [
          Object.assign(round({ round: 1 }), {
            modelEntry: "p/flash",
          }),
        ],
        modelChain: ["p/flash"],
      }),
      chain({
        chainId: "c2",
        rounds: [
          Object.assign(round({ round: 1 }), {
            modelEntry: "p/flash",
            fallbacks: null,
          }),
        ],
        modelChain: ["p/flash"],
      }),
      chain({
        chainId: "c3",
        rounds: [
          Object.assign(round({ round: 1 }), {
            modelEntry: "p/flash",
            fallbacks: [{ from: "p/old", to: "p/flash", reason: "capacity", attempt: 1, message: null }],
          }),
        ],
        modelChain: ["p/flash"],
      }),
    ];

    // Remove the fallbacks key entirely from c1 round (simulate old records)
    delete chains[0].rounds[0].fallbacks;

    const stats = computeStats(chains);
    assert.equal(stats.fallbacksAbsent, 1, "key absent must be counted separately");
    assert.equal(stats.fallbacksNone, 1, "key present but null must be counted");
    assert.equal(Object.keys(stats.fallbackCounts).length, 1);
    assert.equal(stats.fallbackCounts["p/old → p/flash"], 1);
  });

  it("tierCount is correctly derived for tiered chains", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [
          Object.assign(round({ round: 1 }), { modelEntry: "p/free" }),
        ],
        modelChain: [["p/free", "p/flash"], ["p/pro"]],
      }),
    ];

    const stats = computeStats(chains);
    // Tier 0, tierCount 2
    assert.deepEqual(stats.tierCounts, { "0": 1 });
    // chainPeakTiers should have tierCount=2
    assert.equal(stats.chainPeakTiers[0].tierCount, 2);
  });

  it("computes chain shape distribution correctly for chains without modelChain", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [Object.assign(round({ round: 1 }), { modelEntry: "p/flash" })],
        modelChain: ["p/flash", "p/pro"],
      }),
      // c2 has no modelChain at all
      chain({
        chainId: "c2",
        rounds: [Object.assign(round({ round: 1 }), { modelEntry: "p/flash" })],
        modelChain: undefined,
      }),
    ];

    const stats = computeStats(chains);
    assert.deepEqual(stats.chainShapeDistribution, { "2": 1 });
    // c2 should NOT appear in chainShapeDistribution since it has no modelChain
    assert.equal(stats.chainPeakTiers.length, 2);
    // c2's peakTier should be -1 and tierCount 0
    const c2 = stats.chainPeakTiers.find((c) => c.chainId === "c2");
    assert.equal(c2.peakTier, -1);
    assert.equal(c2.tierCount, 0);
  });
});

// ---------------------------------------------------------------------------
// renderChainStats — new sections
// ---------------------------------------------------------------------------

describe("renderChainStats — model and tier sections", () => {
  it("contains the model distribution section", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [
          Object.assign(round({ round: 1 }), { modelEntry: "p/flash" }),
          Object.assign(round({ round: 2 }), { modelEntry: "p/pro" }),
        ],
        modelChain: ["p/flash", "p/pro"],
      }),
    ];
    const stats = computeStats(chains);
    const output = renderChainStats(stats);
    assert.ok(output.includes("Model distribution"));
    assert.ok(output.includes("p/flash"));
    assert.ok(output.includes("p/pro"));
  });

  it("contains the tier distribution section with source breakdown", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [
          Object.assign(round({ round: 1 }), { modelEntry: "p/flash" }),
        ],
        modelChain: ["p/flash", "p/pro"],
      }),
    ];
    const stats = computeStats(chains);
    const output = renderChainStats(stats);
    assert.ok(output.includes("Tier distribution"));
    assert.ok(output.includes("Source breakdown"));
    assert.ok(output.includes("derived"));
  });

  it("contains the peak tier per chain section", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [
          Object.assign(round({ round: 1 }), { modelEntry: "p/flash" }),
        ],
        modelChain: ["p/flash", "p/pro"],
      }),
    ];
    const stats = computeStats(chains);
    const output = renderChainStats(stats);
    assert.ok(output.includes("Peak tier per chain"));
    assert.ok(output.includes("of"));
  });

  it("contains the chain shape distribution section", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [
          Object.assign(round({ round: 1 }), { modelEntry: "p/flash" }),
        ],
        modelChain: ["p/flash", "p/pro"],
      }),
    ];
    const stats = computeStats(chains);
    const output = renderChainStats(stats);
    assert.ok(output.includes("Chain shape distribution"));
    assert.ok(output.includes("2-tier"));
  });

  it("contains the capacity fallbacks section", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [
          Object.assign(round({ round: 1 }),
            Object.assign(
              { modelEntry: "p/flash" },
              { fallbacks: [{ from: "p/old", to: "p/flash", reason: "capacity", attempt: 1, message: null }] },
            )),
        ],
        modelChain: ["p/flash"],
      }),
    ];
    const stats = computeStats(chains);
    const output = renderChainStats(stats);
    assert.ok(output.includes("Capacity fallbacks"));
    assert.ok(output.includes("p/old"));
  });

  it("prints a message when all tiers are unknown and does not compute a percentage", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [
          Object.assign(round({ round: 1 }), { modelEntry: "p/unknown" }),
        ],
        modelChain: ["p/flash", "p/pro"],
      }),
    ];
    const stats = computeStats(chains);
    const output = renderChainStats(stats);
    assert.ok(output.includes("no round has a resolvable tier"));
    // Must not contain a percentage computed over zero
    assert.ok(!/tier 0/.test(output));
  });
});

// ---------------------------------------------------------------------------
// renderComparison — model and tier rows
// ---------------------------------------------------------------------------

describe("renderComparison — model and tier rows", () => {
  it("shows model distribution in n/total form for both sides", () => {
    const chainsBefore = [
      chain({
        chainId: "c1",
        rounds: [Object.assign(round({ round: 1, startedAt: "2026-01-01T00:00:00.000Z" }), { modelEntry: "p/flash" })],
        modelChain: ["p/flash", "p/pro"],
      }),
    ];
    const chainsAfter = [
      chain({
        chainId: "c2",
        rounds: [Object.assign(round({ round: 1, startedAt: "2026-07-01T00:00:00.000Z" }), { modelEntry: "p/pro" })],
        modelChain: ["p/flash", "p/pro"],
      }),
    ];

    const before = computeStats(chainsBefore, { until: "2026-06-01T00:00:00.000Z" });
    const after = computeStats(chainsAfter, { since: "2026-06-01T00:00:00.000Z" });
    const output = renderComparison(before, after, "2026-06-01T00:00:00.000Z");
    assert.ok(output.includes("Models"));
    assert.ok(output.includes("p/flash"));
    assert.ok(output.includes("p/pro"));
    assert.ok(output.includes("1/1")); // Before shows 1/1 for p/flash
    assert.ok(output.includes("1/1")); // After shows 1/1 for p/pro
  });

  it("shows tier rows in n/total form for both sides", () => {
    const chainsBefore = [
      chain({
        chainId: "c1",
        rounds: [Object.assign(round({ round: 1, startedAt: "2026-01-01T00:00:00.000Z" }), { modelEntry: "p/flash" })],
        modelChain: ["p/flash", "p/pro"],
      }),
    ];
    const chainsAfter = [
      chain({
        chainId: "c2",
        rounds: [Object.assign(round({ round: 1, startedAt: "2026-07-01T00:00:00.000Z" }), { modelEntry: "p/pro" })],
        modelChain: ["p/flash", "p/pro"],
      }),
    ];

    const before = computeStats(chainsBefore, { until: "2026-06-01T00:00:00.000Z" });
    const after = computeStats(chainsAfter, { since: "2026-06-01T00:00:00.000Z" });
    const output = renderComparison(before, after, "2026-06-01T00:00:00.000Z");
    assert.ok(output.includes("Tiers"));
    assert.ok(output.includes("tier 0"));
    assert.ok(output.includes("tier 1"));
    assert.ok(output.includes("1/1"));
  });
});

// ---------------------------------------------------------------------------
// renderComparison — tier positions carry their chain's tier count
//
// The comparison view is the whole point of the tier axis ("did the expensive
// tier get used less between these two periods"), and a bare index cannot
// answer it across differently-shaped chains: tier 1 of a 2-tier chain is the
// top tier, tier 1 of a 3-tier chain is the middle one.
// ---------------------------------------------------------------------------

describe("renderComparison tier labelling", () => {
  function chainOn(modelChain, modelEntries) {
    return {
      chainId: "c-" + modelEntries.join("-"),
      meta: { modelChain },
      rounds: modelEntries.map((m, i) => ({ round: i + 1, modelEntry: m })),
    };
  }

  it("labels the tier with the tier count when both ranges share one shape", () => {
    const two = ["p/flash", "p/pro"];
    const before = computeStats([chainOn(two, ["p/flash", "p/pro"])]);
    const after = computeStats([chainOn(two, ["p/flash"])]);

    const out = renderComparison(before, after, "2026-07-26T00:00:00Z");

    assert.match(out, /tier 0 of 2/);
    assert.match(out, /tier 1 of 2/);
    assert.doesNotMatch(out, /chain shapes differ/);
  });

  it("drops the count and says so when the two ranges have different shapes", () => {
    const before = computeStats([chainOn(["p/flash", "p/pro"], ["p/pro"])]);
    const after = computeStats([
      chainOn(["p/free", "p/flash", "p/pro"], ["p/flash"]),
    ]);

    const out = renderComparison(before, after, "2026-07-26T00:00:00Z");

    assert.match(out, /chain shapes differ/);
    assert.match(out, /peak tier per chain/);
    // Must not claim a single shared tier count when there isn't one.
    assert.doesNotMatch(out, /tier \d+ of \d+/);
  });
});

// ---------------------------------------------------------------------------
// renderComparison — escalate substantive/no-work split (kusabi #165)
// ---------------------------------------------------------------------------

describe("renderComparison escalate split", () => {
  it("shows the split for both sides when either side has escalates", () => {
    const chainsBefore = [
      chain({
        chainId: "esc-before",
        rounds: [
          round({ round: 1, startedAt: "2026-01-01T00:00:00.000Z", verdict: "needs-attention", disposition: "escalate", worktreeChanged: true }),
        ],
      }),
    ];
    const chainsAfter = [
      chain({
        chainId: "esc-after",
        rounds: [
          round({ round: 1, startedAt: "2026-07-01T00:00:00.000Z", verdict: "needs-attention", disposition: "escalate", worktreeChanged: false }),
        ],
      }),
    ];

    const before = computeStats(chainsBefore, { until: "2026-06-01T00:00:00.000Z" });
    const after = computeStats(chainsAfter, { since: "2026-06-01T00:00:00.000Z" });
    const output = renderComparison(before, after, "2026-06-01T00:00:00.000Z");
    assert.match(output, /escalate split/);
    assert.match(output, /subst 1/);       // before side
    assert.match(output, /no-work 1/);     // after side
    // The disposition totals themselves are untouched by the split line.
    assert.match(output, /escalate\s+1\/1/);
  });

  it("omits the split line when neither side has escalates", () => {
    const chains = [
      chain({
        chainId: "c1",
        rounds: [round({ round: 1, startedAt: "2026-01-01T00:00:00.000Z", verdict: "approve", disposition: "accept" })],
      }),
    ];
    const before = computeStats(chains, { until: "2026-06-01T00:00:00.000Z" });
    const after = computeStats(chains, { since: "2026-06-01T00:00:00.000Z" });
    const output = renderComparison(before, after, "2026-06-01T00:00:00.000Z");
    assert.doesNotMatch(output, /escalate split/);
  });
});

// ---------------------------------------------------------------------------
// Time filtering compares instants, not strings
//
// `startedAt` is always written as UTC (`...Z`), but a cutoff typed by a human
// is naturally local time.  Under lexicographic comparison the same instant
// lands on the wrong side and the table looks plausible while being wrong --
// which matters most for --compare, whose whole job is the split.
// ---------------------------------------------------------------------------

describe("computeStats time-filter timezone handling", () => {
  // 2026-07-26T01:53:49Z === 2026-07-26T10:53:49+09:00
  const UTC_CUT = "2026-07-26T01:53:49Z";
  const OFFSET_CUT = "2026-07-26T10:53:49+09:00";

  const chains = [{
    chainId: "c1",
    meta: { modelChain: ["p/flash", "p/pro"] },
    rounds: [
      { round: 1, modelEntry: "p/flash", startedAt: "2026-07-25T23:00:00.000Z" }, // before
      { round: 2, modelEntry: "p/pro", startedAt: "2026-07-26T07:58:58.825Z" },   // after
    ],
  }];

  it("splits identically for a UTC cutoff and the same instant with an offset", () => {
    const utcAfter = computeStats(chains, { since: UTC_CUT });
    const offsetAfter = computeStats(chains, { since: OFFSET_CUT });
    assert.equal(utcAfter.roundCount, 1, "UTC cutoff should keep the later round");
    assert.equal(
      offsetAfter.roundCount, utcAfter.roundCount,
      "an offset-form cutoff must not change which rounds are in range",
    );

    const utcBefore = computeStats(chains, { until: UTC_CUT });
    const offsetBefore = computeStats(chains, { until: OFFSET_CUT });
    assert.equal(utcBefore.roundCount, 1);
    assert.equal(offsetBefore.roundCount, utcBefore.roundCount);
  });

  it("still partitions every round into exactly one side of the cutoff", () => {
    const before = computeStats(chains, { until: OFFSET_CUT });
    const after = computeStats(chains, { since: OFFSET_CUT });
    assert.equal(before.roundCount + after.roundCount, 2);
  });

  it("falls back to string ordering for an unparseable bound", () => {
    // Degrades no worse than the previous behaviour rather than throwing.
    const stats = computeStats(chains, { since: "not-a-timestamp" });
    assert.ok(Number.isFinite(stats.roundCount));
  });
});
