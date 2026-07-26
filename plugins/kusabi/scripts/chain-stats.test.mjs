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
  strategistUsage = null,
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
  if (strategistUsage) r.strategistUsage = strategistUsage;
  return r;
}

/**
 * Build a minimal chain fixture.
 */
function chain({
  chainId = "chain-test-001",
  rounds = [],
  chainTotals = null,
} = {}) {
  // Filter out undefined entries from rounds
  const safeRounds = rounds.filter(Boolean);
  return {
    chainId,
    meta: {
      chainId,
      chainTotals: chainTotals || undefined,
    },
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
