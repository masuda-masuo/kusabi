// chain-ingest.test.mjs — Unit tests for chain-ingest.mjs
//
// The real fixtures referenced by the original brief
// (.fixtures-real/chain-modern.json, .fixtures-real/chain-old.json) were
// not present in this container when this PR was written (the directory
// existed but was empty).  These tests reconstruct the two chain shapes
// the brief describes from the actual chain.json writer
// (persistChainState / handleProviderExhaustion in chain-phases.mjs and
// cmdChain in kusabi-companion.mjs), matching the described characteristics:
//
//  - chain-modern (chain-ms1g7lesd89b): 2 rounds, HAS `findings` +
//    `findingFiles`, orchestrator claude-opus-5 / session 652c5ef7 /
//    date 2026-07-26, dispositions rework -> accept-with-followup.
//  - chain-old (chain-mrv4jobge6df): 3 rounds, has NEITHER `findings` NOR
//    `findingFiles` (only free-text `findingsText`), orchestrator
//    claude-fable-5 / session 05d783f6 / date 2026-07-22, dispositions
//    rework -> rework -> escalate.
//
// The brief's exact character counts for the two real briefs (6727 / 5462
// chars) describe text this container does not have; brief_chars is
// asserted against whatever synthetic brief text is actually used here,
// not against those two host-measured numbers.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseChainRecord, ingestChainDirectory, parseJobRecord, ingestJobDirectory } from "./chain-ingest.mjs";
import { openMetricsDb, upsertChain, countRows } from "./metrics-db.mjs";

const MODERN_BRIEF = [
  "Orchestrator: claude-opus-5 | session 652c5ef7 | 2026-07-26",
  "",
  "Fix the thing.",
  "",
  "## Deliverables",
  "- `plugins/kusabi/scripts/foo.mjs`",
  "",
  "## Smoke",
  "- `npm test` exit 0",
  "",
].join("\n");

const OLD_BRIEF = [
  "Orchestrator: claude-fable-5 | session 05d783f6 | 2026-07-22",
  "",
  "Fix the other thing.",
  "",
  "## Deliverables",
  "- `plugins/kusabi/scripts/bar.mjs`",
  "",
].join("\n");

function chainModernFixture() {
  return {
    chainId: "chain-ms1g7lesd89b",
    container: "abc123container",
    model: { providerID: "anthropic", modelID: "claude-sonnet-5" },
    modelChain: [["opencode/deepseek-v4-flash-free:max"], ["opencode-go/deepseek-v4-pro:max"]],
    maxRounds: 4,
    brief: MODERN_BRIEF,
    orchestrator: { model: "claude-opus-5", session: "652c5ef7", date: "2026-07-26" },
    baseSha: "deadbeef01",
    strategized: false,
    followupIssueDraft: null,
    chainTotals: { input: 500, output: 250, reasoning: 0, cacheRead: 1000, cacheWrite: 200, cost: 0.05 },
    records: [
      {
        round: 1,
        startedAt: "2026-07-26T10:00:00.000Z",
        modelEntry: "opencode/deepseek-v4-flash-free:max",
        tierBefore: 0,
        tierAfter: 0,
        verdict: "needs-attention",
        probesGreen: true,
        worktreeChanged: true,
        disposition: { disposition: "rework" },
        reworkCount: 0,
        findingsText: "1. [medium] something off in src/a.mjs",
        findingFiles: ["src/a.mjs"],
        findings: [
          {
            severity: "medium",
            title: "something off",
            body: "explanation",
            file: "src/a.mjs",
            line_start: 1,
            line_end: 2,
            confidence: 0.8,
            recommendation: "fix it",
          },
        ],
        implementUsage: { available: true, input: 300, output: 150, cacheRead: 500, cacheWrite: 100, cost: 0.03 },
        reviewUsage: { available: true, input: 200, output: 100, cacheRead: 500, cacheWrite: 100, cost: 0.02 },
      },
      {
        round: 2,
        startedAt: "2026-07-26T10:20:00.000Z",
        modelEntry: "opencode/deepseek-v4-flash-free:max",
        tierBefore: 0,
        tierAfter: 0,
        verdict: "approve-partial",
        probesGreen: true,
        worktreeChanged: false,
        disposition: { disposition: "accept-with-followup" },
        reworkCount: 1,
        findingsText: "(none)",
        findingFiles: [],
        findings: [],
        implementUsage: { available: true, input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
        reviewUsage: { available: false },
      },
    ],
  };
}

function chainOldFixture() {
  return {
    chainId: "chain-mrv4jobge6df",
    container: "def456container",
    model: { providerID: "opencode", modelID: "deepseek-v4-pro", variant: "max" },
    modelChain: ["opencode-go/deepseek-v4-pro:max"],
    maxRounds: 3,
    brief: OLD_BRIEF,
    orchestrator: { model: "claude-fable-5", session: "05d783f6", date: "2026-07-22" },
    baseSha: "cafebabe02",
    strategized: false,
    chainTotals: { input: 900, output: 400, reasoning: 0, cacheRead: 2000, cacheWrite: 300, cost: 0.09 },
    records: [
      {
        round: 1,
        startedAt: "2026-07-22T09:00:00.000Z",
        modelEntry: "opencode-go/deepseek-v4-pro:max",
        tierBefore: 0,
        tierAfter: 0,
        verdict: "needs-attention",
        probesGreen: true,
        disposition: { disposition: "rework" },
        reworkCount: 0,
        findingsText: "Prose-only findings, no structured array (pre-#119 generation).",
        // NEITHER `findings` NOR `findingFiles` present at all.
        implementUsage: { available: true, input: 300, output: 150, cost: 0.03 },
        reviewUsage: { available: true, input: 200, output: 100, cost: 0.02 },
      },
      {
        round: 2,
        startedAt: "2026-07-22T09:30:00.000Z",
        modelEntry: "opencode-go/deepseek-v4-pro:max",
        tierBefore: 0,
        tierAfter: 0,
        verdict: "needs-attention",
        probesGreen: false,
        disposition: { disposition: "rework" },
        reworkCount: 1,
        findingsText: "Still prose-only.",
        implementUsage: { available: true, input: 300, output: 150, cost: 0.03 },
        reviewUsage: { available: true, input: 200, output: 100, cost: 0.02 },
      },
      {
        round: 3,
        startedAt: "2026-07-22T10:00:00.000Z",
        modelEntry: "opencode-go/deepseek-v4-pro:max",
        tierBefore: 0,
        tierAfter: 0,
        verdict: "needs-attention",
        probesGreen: false,
        disposition: { disposition: "escalate" },
        reworkCount: 2,
        findingsText: "Escalated, still prose-only.",
        implementUsage: { available: true, input: 300, output: 100, cost: 0.03 },
        // No review this round.
        reviewUsage: null,
      },
    ],
  };
}

describe("parseChainRecord — chain-modern shape (has findings + findingFiles)", () => {
  it("parses chain/round/finding rows and sets hasStructuredFindings", () => {
    const parsed = parseChainRecord(chainModernFixture(), { workspaceSlug: "ws-modern" });
    assert.ok(parsed);
    assert.equal(parsed.hasStructuredFindings, true);

    assert.equal(parsed.chainRow.chainId, "chain-ms1g7lesd89b");
    assert.equal(parsed.chainRow.workspaceSlug, "ws-modern");
    assert.equal(parsed.chainRow.model, "anthropic/claude-sonnet-5");
    assert.equal(parsed.chainRow.maxRounds, 4);
    assert.equal(parsed.chainRow.totalsInput, 500);
    assert.equal(parsed.chainRow.totalsCost, 0.05);
    assert.equal(parsed.chainRow.briefHasDeliverables, 1);
    assert.equal(parsed.chainRow.briefDeliverableCount, 1);
    assert.equal(parsed.chainRow.briefHasSmoke, 1);
    assert.equal(parsed.chainRow.briefSmokeCount, 1);
    assert.equal(parsed.chainRow.briefChars, MODERN_BRIEF.length);

    assert.equal(parsed.roundRows.length, 2);
    assert.equal(parsed.roundRows[0].disposition, "rework");
    assert.equal(parsed.roundRows[1].disposition, "accept-with-followup");
    assert.equal(parsed.roundRows[0].implementIn, 300);
    assert.equal(parsed.roundRows[0].reviewIn, 200);
    // Round 2's reviewUsage.available is false -> null fields, not 0.
    assert.equal(parsed.roundRows[1].reviewIn, null);
    assert.equal(parsed.roundRows[1].reviewOut, null);
    // worktreeChanged (kusabi #165) is ingested three-valued.
    assert.equal(parsed.roundRows[0].worktreeChanged, 1);
    assert.equal(parsed.roundRows[1].worktreeChanged, 0);

    assert.equal(parsed.findingRows.length, 1);
    assert.equal(parsed.findingRows[0].severity, "medium");
    assert.equal(parsed.findingRows[0].file, "src/a.mjs");
    assert.equal(parsed.findingRows[0].chainId, "chain-ms1g7lesd89b");
    assert.equal(parsed.findingRows[0].round, 1);
    assert.equal(parsed.findingRows[0].source, "findings");
  });

  it("tags a finding row synthesised from findingFiles with source: 'finding_files', distinguishable from a real structured finding", () => {
    const fixture = chainModernFixture();
    // Round 1 keeps `findings`; strip it so round 1 falls back to
    // findingFiles instead, to isolate the fallback path.
    fixture.records[0].findings = [];
    const parsed = parseChainRecord(fixture);
    const row = parsed.findingRows.find((f) => f.round === 1);
    assert.ok(row);
    assert.equal(row.source, "finding_files");
    assert.equal(row.severity, null);
    assert.equal(row.title, null);
    assert.equal(row.file, "src/a.mjs");
  });

  it("survives orch_model / orch_session / orch_date verbatim (stratification keys, hazard 5/6)", () => {
    const parsed = parseChainRecord(chainModernFixture());
    assert.equal(parsed.chainRow.orchModel, "claude-opus-5");
    assert.equal(parsed.chainRow.orchSession, "652c5ef7");
    assert.equal(parsed.chainRow.orchDate, "2026-07-26");
  });
});

describe("parseChainRecord — chain-old shape (neither findings nor findingFiles)", () => {
  it("parses cleanly with zero finding rows and NULL (not zero) usage where absent", () => {
    const parsed = parseChainRecord(chainOldFixture(), { workspaceSlug: "ws-old" });
    assert.ok(parsed);
    assert.equal(parsed.hasStructuredFindings, false);
    assert.equal(parsed.findingRows.length, 0);

    assert.equal(parsed.roundRows.length, 3);
    assert.equal(parsed.roundRows[0].findingsText, "Prose-only findings, no structured array (pre-#119 generation).");
    assert.equal(parsed.roundRows[2].disposition, "escalate");

    // Round 3 has no reviewUsage at all -> null, never 0.
    assert.equal(parsed.roundRows[2].reviewIn, null);
    assert.equal(parsed.roundRows[2].reviewOut, null);
    assert.equal(parsed.roundRows[2].reviewCost, null);
    // Pre-#165 records carry no worktreeChanged -> NULL (unknown), never 0.
    assert.equal(parsed.roundRows[0].worktreeChanged, null);
    assert.equal(parsed.roundRows[2].worktreeChanged, null);
  });

  it("survives orch_model / orch_session / orch_date verbatim", () => {
    const parsed = parseChainRecord(chainOldFixture());
    assert.equal(parsed.chainRow.orchModel, "claude-fable-5");
    assert.equal(parsed.chainRow.orchSession, "05d783f6");
    assert.equal(parsed.chainRow.orchDate, "2026-07-22");
  });
});

describe("parseChainRecord — malformed / missing input", () => {
  it("returns null for a record with no chainId", () => {
    assert.equal(parseChainRecord({ brief: "x" }), null);
  });

  it("returns null for non-object input", () => {
    assert.equal(parseChainRecord(null), null);
    assert.equal(parseChainRecord("not an object"), null);
  });

  it("handles a chain.json with no orchestrator, no chainTotals, no records at all", () => {
    const parsed = parseChainRecord({ chainId: "chain-bare" });
    assert.ok(parsed);
    assert.equal(parsed.chainRow.orchModel, null);
    assert.equal(parsed.chainRow.orchSession, null);
    assert.equal(parsed.chainRow.orchDate, null);
    assert.equal(parsed.chainRow.totalsInput, null);
    assert.equal(parsed.chainRow.briefText, null);
    assert.equal(parsed.chainRow.briefChars, null);
    assert.equal(parsed.roundRows.length, 0);
    assert.equal(parsed.findingRows.length, 0);
    assert.equal(parsed.hasStructuredFindings, false);
  });

  it("ignores malformed entries inside records (non-object, missing round number)", () => {
    const parsed = parseChainRecord({
      chainId: "chain-messy",
      records: [null, { round: "not-a-number" }, { round: 1, disposition: { disposition: "accept" } }],
    });
    assert.equal(parsed.roundRows.length, 1);
    assert.equal(parsed.roundRows[0].round, 1);
  });

  it("[Finding B] does not report hasStructuredFindings when `findings` contains only non-object entries (flag reflects rows actually produced, not raw array presence)", () => {
    const parsed = parseChainRecord({
      chainId: "chain-all-null-findings",
      records: [{ round: 1, findings: [null, null] }],
    });
    assert.equal(parsed.findingRows.length, 0);
    assert.equal(parsed.hasStructuredFindings, false);
  });

  it("ingests worktreeChanged as NULL when absent or unmeasurable (kusabi #165 — absent is not no-change)", () => {
    // A round that died before probes (provider death) has no worktreeChanged.
    const parsed = parseChainRecord({
      chainId: "chain-infra-death",
      records: [
        {
          round: 1,
          startedAt: "2026-07-26T10:00:00.000Z",
          implementUsage: { available: false },
        },
      ],
    });
    assert.equal(parsed.roundRows.length, 1);
    assert.equal(parsed.roundRows[0].worktreeChanged, null);
    // An explicit null on the record is preserved as null, not coerced to 0.
    const parsedNull = parseChainRecord({
      chainId: "chain-explicit-null",
      records: [{ round: 1, worktreeChanged: null }],
    });
    assert.equal(parsedNull.roundRows[0].worktreeChanged, null);
  });
});

describe("parseChainRecord — retried review rounds (reviewFirstUsage)", () => {
  it("folds the first attempt's usage into reviewIn/reviewOut/reviewCost when both attempts are available", () => {
    const parsed = parseChainRecord({
      chainId: "chain-retried",
      records: [
        {
          round: 1,
          reviewUsage: { available: true, input: 200, output: 100, cost: 0.02 },
          reviewFirstUsage: { available: true, input: 150, output: 75, cost: 0.015 },
        },
      ],
    });
    assert.equal(parsed.roundRows.length, 1);
    assert.equal(parsed.roundRows[0].reviewIn, 350);
    assert.equal(parsed.roundRows[0].reviewOut, 175);
    assert.equal(parsed.roundRows[0].reviewCost, 0.035);
  });

  it("keeps today's single-attempt values when reviewFirstUsage is absent", () => {
    const parsed = parseChainRecord({
      chainId: "chain-single",
      records: [
        {
          round: 1,
          reviewUsage: { available: true, input: 200, output: 100, cost: 0.02 },
        },
      ],
    });
    assert.equal(parsed.roundRows[0].reviewIn, 200);
    assert.equal(parsed.roundRows[0].reviewOut, 100);
    assert.equal(parsed.roundRows[0].reviewCost, 0.02);
  });

  it("a reviewFirstUsage with available: false contributes nothing", () => {
    const parsed = parseChainRecord({
      chainId: "chain-first-unavailable",
      records: [
        {
          round: 1,
          reviewUsage: { available: true, input: 200, output: 100, cost: 0.02 },
          reviewFirstUsage: { available: false, input: 150, output: 75, cost: 0.015 },
        },
      ],
    });
    assert.equal(parsed.roundRows[0].reviewIn, 200);
    assert.equal(parsed.roundRows[0].reviewOut, 100);
    assert.equal(parsed.roundRows[0].reviewCost, 0.02);
  });

  it("keeps null when neither attempt yields a usable numeric field", () => {
    const parsed = parseChainRecord({
      chainId: "chain-no-usable-review",
      records: [
        {
          round: 1,
          reviewUsage: { available: true },
          reviewFirstUsage: { available: true },
        },
      ],
    });
    assert.equal(parsed.roundRows[0].reviewIn, null);
    assert.equal(parsed.roundRows[0].reviewOut, null);
    assert.equal(parsed.roundRows[0].reviewCost, null);
  });
});

describe("parseChainRecord \u2014 archived review seats (kusabi #248 follow-up)", () => {
  it("round rows carry the archived seat count; an absent field stores NULL, an empty array stores 0", () => {
    const parsed = parseChainRecord({
      chainId: "chain-seats",
      records: [
        { round: 1, reviewSeatFailures: [{ seat: 1 }, { seat: 2 }] },
        { round: 2 },
        { round: 3, reviewSeatFailures: [] },
      ],
    });
    assert.equal(parsed.roundRows[0].reviewSeatFailures, 2);
    // Pre-#248 records have no field at all: NULL, never 0 (readers apply
    // the NULL-means-0 contract at read time -- the backend TEXT precedent).
    assert.equal(parsed.roundRows[1].reviewSeatFailures, null);
    // An empty array is a real measurement: zero archived seats.
    assert.equal(parsed.roundRows[2].reviewSeatFailures, 0);
  });
});

// ---------------------------------------------------------------------------
// ingestChainDirectory — filesystem + database integration
// ---------------------------------------------------------------------------

function makeTempStateRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-chain-test-"));
}

function writeChainDir(stateRoot, workspaceSlug, chainId, chainJson) {
  const dir = path.join(stateRoot, workspaceSlug, "chains", chainId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "chain.json"), JSON.stringify(chainJson), "utf8");
  return dir;
}

describe("ingestChainDirectory", () => {
  it("ingests both fixture shapes, reports structured-findings coverage, and skips unchanged on re-run", () => {
    const stateRoot = makeTempStateRoot();
    writeChainDir(stateRoot, "ws1", "chain-ms1g7lesd89b", chainModernFixture());
    writeChainDir(stateRoot, "ws1", "chain-mrv4jobge6df", chainOldFixture());

    const db = openMetricsDb(":memory:");
    const first = ingestChainDirectory(db, stateRoot);

    assert.equal(first.chainsIngested, 2);
    assert.equal(first.chainsWithStructuredFindings, 1); // only chain-modern
    assert.equal(first.roundsIngested, 5); // 2 + 3
    assert.equal(first.findingsIngested, 1);
    assert.equal(first.parseFailures, 0);
    assert.equal(countRows(db, "chain"), 2);
    assert.equal(countRows(db, "round"), 5);
    assert.equal(countRows(db, "finding"), 1);

    const second = ingestChainDirectory(db, stateRoot);
    assert.equal(second.filesSkippedUnchanged, 2);
    // Re-running must not duplicate rows.
    assert.equal(countRows(db, "chain"), 2);
    assert.equal(countRows(db, "round"), 5);
    assert.equal(countRows(db, "finding"), 1);

    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  it("skips a chain directory with no chain.json (died before persisting) without counting a failure", () => {
    const stateRoot = makeTempStateRoot();
    fs.mkdirSync(path.join(stateRoot, "ws1", "chains", "chain-neverwrote"), { recursive: true });

    const db = openMetricsDb(":memory:");
    const result = ingestChainDirectory(db, stateRoot);
    assert.equal(result.chainsIngested, 0);
    assert.equal(result.parseFailures, 0);
    assert.equal(result.filesScanned, 0);

    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  it("skips an unparseable chain.json and counts it under parseFailures, without throwing", () => {
    const stateRoot = makeTempStateRoot();
    const dir = path.join(stateRoot, "ws1", "chains", "chain-broken");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "chain.json"), "{not valid json", "utf8");

    const db = openMetricsDb(":memory:");
    const result = ingestChainDirectory(db, stateRoot);
    assert.equal(result.parseFailures, 1);
    assert.equal(result.ioFailures, 0);
    assert.equal(result.chainsIngested, 0);
    assert.equal(countRows(db, "chain"), 0);

    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  it("counts an unreadable chain.json under ioFailures, distinct from parseFailures (a whole chain's data missing vs. malformed data)", () => {
    const stateRoot = makeTempStateRoot();
    const brokenDir = path.join(stateRoot, "ws1", "chains", "chain-unreadable");
    fs.mkdirSync(brokenDir, { recursive: true });
    const brokenPath = path.join(brokenDir, "chain.json");
    fs.writeFileSync(brokenPath, "irrelevant — permissions make it unreadable", "utf8");
    fs.chmodSync(brokenPath, 0o000); // readFileSync throws EACCES: a whole-file I/O failure.
    writeChainDir(stateRoot, "ws1", "chain-ms1g7lesd89b", chainModernFixture());

    const db = openMetricsDb(":memory:");
    const result = ingestChainDirectory(db, stateRoot);
    assert.equal(result.ioFailures, 1);
    assert.equal(result.parseFailures, 0);
    // The readable chain must still ingest normally.
    assert.equal(result.chainsIngested, 1);

    fs.chmodSync(brokenPath, 0o644);
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  it("returns a zeroed summary for a state root that does not exist", () => {
    const db = openMetricsDb(":memory:");
    const result = ingestChainDirectory(db, path.join(os.tmpdir(), "does-not-exist-" + Date.now()));
    assert.equal(result.workspacesScanned, 0);
    assert.equal(result.chainsIngested, 0);
  });

  // kusabi #248 follow-up: a chain re-ingested after a review seat
  // replacement.  The same chain id and round number come back with the
  // REPLACEMENT review's findings (F2) plus the archived seat -- the finding
  // rows must be exactly F2 (no stale pre-replacement rows), the round row
  // must not be duplicated, and the failed-seat count must be queryable.
  it("re-ingesting a replaced round replaces its finding rows, records the failed-seat count, and never duplicates the round", () => {
    const stateRoot = makeTempStateRoot();
    const chainId = "chain-reingest-seat";
    // First ingest: the PRE-replacement record -- findings F1 (3 findings),
    // no reviewSeatFailures yet (the seat is still alive on the record).
    const pre = {
      chainId,
      modelChain: [["fake/model"]],
      maxRounds: 4,
      brief: MODERN_BRIEF,
      baseSha: "abc123",
      records: [
        {
          round: 1,
          startedAt: "2026-08-01T10:00:00.000Z",
          disposition: { disposition: "escalate" },
          findings: [
            { severity: "medium", title: "pre-finding-1", file: "src/a.mjs" },
            { severity: "high", title: "pre-finding-2", file: "src/b.mjs" },
            { severity: "low", title: "pre-finding-3", file: "src/c.mjs" },
          ],
        },
      ],
    };
    writeChainDir(stateRoot, "ws1", chainId, pre);

    const db = openMetricsDb(":memory:");
    const first = ingestChainDirectory(db, stateRoot);
    assert.equal(first.chainsIngested, 1);
    assert.equal(first.findingsIngested, 3);
    assert.equal(countRows(db, "round"), 1);
    assert.equal(countRows(db, "finding"), 3);
    const preRound = db.prepare("SELECT review_seat_failures FROM round").get();
    assert.equal(preRound.review_seat_failures, null); // absent field, not 0

    // The seat died; chain-resume bought a replacement seat for the SAME
    // round.  The replacement review overrode the record's findings (F2 --
    // two findings, one fewer than F1, so stale idx rows would survive
    // without the delete) and the archived seat is recorded on the record.
    const post = {
      ...pre,
      records: [
        {
          ...pre.records[0],
          reviewSeatFailures: [{ seat: 1, reviewJobId: "job-rev-1", verdict: "partial" }],
          findings: [
            { severity: "low", title: "post-finding-1", file: "src/a.mjs" },
            { severity: "low", title: "post-finding-2", file: "src/d.mjs" },
          ],
        },
      ],
    };
    writeChainDir(stateRoot, "ws1", chainId, post);

    const second = ingestChainDirectory(db, stateRoot);
    assert.equal(second.filesSkippedUnchanged, 0, "the rewritten chain.json must force a re-read");
    assert.equal(second.findingsIngested, 2);

    // Finding rows are EXACTLY F2 -- no stale pre-replacement rows survive.
    assert.equal(countRows(db, "finding"), 2);
    const titles = db.prepare("SELECT title FROM finding ORDER BY idx").all().map((r) => r.title);
    assert.deepEqual(titles, ["post-finding-1", "post-finding-2"]);

    // The round is not duplicated, and the failed-seat count is queryable.
    assert.equal(countRows(db, "round"), 1);
    const roundRow = db.prepare("SELECT chain_id, round, review_seat_failures FROM round").get();
    assert.equal(roundRow.chain_id, chainId);
    assert.equal(roundRow.round, 1);
    assert.equal(roundRow.review_seat_failures, 1);

    fs.rmSync(stateRoot, { recursive: true, force: true });
  });
});

describe("idempotency is a PRIMARY KEY property, not a skip-cache property", () => {
  it("upserting the same chain row twice directly (bypassing the skip cache) yields one row", () => {
    const db = openMetricsDb(":memory:");
    const parsed = parseChainRecord(chainModernFixture(), { workspaceSlug: "ws1" });
    upsertChain(db, parsed.chainRow);
    upsertChain(db, parsed.chainRow);
    assert.equal(countRows(db, "chain"), 1);
  });
});

// ---------------------------------------------------------------------------
// Delegated jobs (#154) — parseJobRecord / ingestJobDirectory
//
// Fixture shapes reconstructed from the actual writers: runPrompt in
// prompt-execution.mjs creates job.json ({id, kind, title, status, phase,
// modelEntry, startedAt, finishedAt, stats:{steps,...}, error, ...}) and
// writes usage.json ({...accumulateUsage(events), phase, durationSeconds})
// when the job ends.  Statuses observed on disk: completed / provider-error
// / error, plus cancelled (cmdCancel).
// ---------------------------------------------------------------------------

function completedJobFixture() {
  return {
    id: "job-msa5ztfv553b",
    kind: "task",
    title: "fix the thing",
    status: "completed",
    sessionID: "ses_x",
    cwd: "/w",
    phase: "implement",
    modelEntry: "opencode/deepseek-v4-flash-free:max",
    startedAt: "2026-08-01T10:00:00.000Z",
    finishedAt: "2026-08-01T10:26:15.000Z",
    stats: { events: 900, steps: 152, lastTool: "bash", permissionsAllowed: 3, permissionsRejected: 0, lastActivity: null, models: ["opencode/deepseek-v4-flash"] },
    error: null,
  };
}

function completedUsageFixture() {
  return {
    available: true,
    input: 5000,
    output: 82419,
    reasoning: 102005,
    cacheRead: 1000,
    cacheWrite: 200,
    cost: 0, // free tier — a real measurement, not a missing one
    model: "opencode/deepseek-v4-flash",
    phase: "implement",
    durationSeconds: 1575,
  };
}

describe("parseJobRecord", () => {
  it("parses a completed job with usage, preserving cost 0 as 0 (not null)", () => {
    const parsed = parseJobRecord(completedJobFixture(), completedUsageFixture(), { workspaceSlug: "ws1" });
    assert.ok(parsed);
    const row = parsed.jobRow;
    assert.equal(row.jobId, "job-msa5ztfv553b");
    assert.equal(row.workspaceSlug, "ws1");
    assert.equal(row.kind, "task");
    assert.equal(row.status, "completed");
    assert.equal(row.steps, 152);
    assert.equal(row.usageAvailable, 1);
    assert.equal(row.usageOutput, 82419);
    assert.equal(row.usageReasoning, 102005);
    assert.equal(row.usageCost, 0);
    assert.equal(row.durationSeconds, 1575);
    assert.equal(row.startedMs, Date.parse("2026-08-01T10:00:00.000Z"));
  });

  it("a job with NO usage.json gets usageAvailable null — absent, not measured-zero", () => {
    const parsed = parseJobRecord(completedJobFixture(), null);
    assert.equal(parsed.jobRow.usageAvailable, null);
    assert.equal(parsed.jobRow.usageOutput, null);
    assert.equal(parsed.jobRow.usageCost, null);
  });

  it("usage.json with available: false yields usageAvailable 0 with null numerics, but keeps durationSeconds", () => {
    const parsed = parseJobRecord(completedJobFixture(), { available: false, phase: "implement", durationSeconds: 42 });
    assert.equal(parsed.jobRow.usageAvailable, 0);
    assert.equal(parsed.jobRow.usageOutput, null);
    assert.equal(parsed.jobRow.usageCost, null);
    assert.equal(parsed.jobRow.durationSeconds, 42);
  });

  it("usage available: true with missing numeric fields stays null field-by-field", () => {
    const parsed = parseJobRecord(completedJobFixture(), { available: true, output: 10 });
    assert.equal(parsed.jobRow.usageAvailable, 1);
    assert.equal(parsed.jobRow.usageOutput, 10);
    assert.equal(parsed.jobRow.usageInput, null);
    assert.equal(parsed.jobRow.usageCost, null);
    // durationSeconds falls back to finishedAt - startedAt.
    assert.equal(parsed.jobRow.durationSeconds, 1575);
  });

  it("keeps an unknown status verbatim instead of dropping it", () => {
    const job = completedJobFixture();
    job.status = "some-status-from-the-future";
    const parsed = parseJobRecord(job, null);
    assert.equal(parsed.jobRow.status, "some-status-from-the-future");
  });

  it("returns null for a record with no usable id, and for non-object input", () => {
    assert.equal(parseJobRecord({ status: "completed" }, null), null);
    assert.equal(parseJobRecord(null, null), null);
    assert.equal(parseJobRecord("nope", null), null);
  });

  it("a still-running job (no finishedAt, no usage) parses with null duration", () => {
    const job = completedJobFixture();
    job.status = "running";
    job.finishedAt = null;
    const parsed = parseJobRecord(job, null);
    assert.equal(parsed.jobRow.finishedAt, null);
    assert.equal(parsed.jobRow.durationSeconds, null);
    assert.equal(parsed.jobRow.usageAvailable, null);
  });
});

function writeJobDir(stateRoot, workspaceSlug, jobId, jobJson, usageJson = undefined) {
  const dir = path.join(stateRoot, workspaceSlug, "jobs", jobId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(jobJson), "utf8");
  if (usageJson !== undefined) {
    fs.writeFileSync(path.join(dir, "usage.json"), JSON.stringify(usageJson), "utf8");
  }
  return dir;
}

describe("ingestJobDirectory", () => {
  it("re-reads a job whose usage.json lands AFTER first ingest, even when job.json is untouched (the two-file source key)", () => {
    const stateRoot = makeTempStateRoot();
    // A running job: job.json only, no usage.json yet.
    const job = completedJobFixture();
    job.status = "running";
    job.finishedAt = null;
    const dir = writeJobDir(stateRoot, "ws1", job.id, job);

    const db = openMetricsDb(":memory:");
    const first = ingestJobDirectory(db, stateRoot);
    assert.equal(first.jobsIngested, 1);
    assert.equal(first.jobsMissingUsage, 1);
    let row = db.prepare("SELECT status, usage_available, usage_output FROM job").get();
    assert.equal(row.status, "running");
    assert.equal(row.usage_available, null); // absent, not zero

    // The job finishes: ONLY usage.json appears; job.json is deliberately
    // left byte-for-byte identical (same size, same mtime) to prove the
    // skip key is the pair, not job.json alone.
    fs.writeFileSync(path.join(dir, "usage.json"), JSON.stringify(completedUsageFixture()), "utf8");

    const second = ingestJobDirectory(db, stateRoot);
    assert.equal(second.jobsSkippedUnchanged, 0, "usage.json landing must force a re-read");
    assert.equal(second.jobsIngested, 1);
    assert.equal(second.jobsMissingUsage, 0);
    assert.equal(countRows(db, "job"), 1); // re-ingest replaced, not duplicated
    row = db.prepare("SELECT usage_available, usage_output, usage_cost FROM job").get();
    assert.equal(row.usage_available, 1);
    assert.equal(row.usage_output, 82419);
    assert.equal(row.usage_cost, 0);

    // Third run: both files unchanged — skipped.
    const third = ingestJobDirectory(db, stateRoot);
    assert.equal(third.jobsSkippedUnchanged, 1);
    assert.equal(third.jobsIngested, 0);
    assert.equal(countRows(db, "job"), 1);

    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  it("ingests a complete job (both files) once and skips it unchanged on re-run", () => {
    const stateRoot = makeTempStateRoot();
    writeJobDir(stateRoot, "ws1", "job-msa5ztfv553b", completedJobFixture(), completedUsageFixture());
    writeJobDir(stateRoot, "ws1", "job-died-early", { ...completedJobFixture(), id: "job-died-early", status: "error", error: "boom" });

    const db = openMetricsDb(":memory:");
    const first = ingestJobDirectory(db, stateRoot);
    assert.equal(first.workspacesScanned, 1);
    assert.equal(first.jobsScanned, 2);
    assert.equal(first.jobsIngested, 2);
    assert.equal(first.jobsMissingUsage, 1);
    assert.equal(countRows(db, "job"), 2);

    const second = ingestJobDirectory(db, stateRoot);
    assert.equal(second.jobsSkippedUnchanged, 2);
    assert.equal(second.jobsIngested, 0);
    assert.equal(countRows(db, "job"), 2);

    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  it("skips a job directory with no job.json silently, mirrors the chain walker", () => {
    const stateRoot = makeTempStateRoot();
    fs.mkdirSync(path.join(stateRoot, "ws1", "jobs", "job-neverwrote"), { recursive: true });

    const db = openMetricsDb(":memory:");
    const result = ingestJobDirectory(db, stateRoot);
    assert.equal(result.jobsScanned, 0);
    assert.equal(result.jobsIngested, 0);
    assert.equal(result.parseFailures, 0);

    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  it("counts a malformed job.json under parseFailures without throwing", () => {
    const stateRoot = makeTempStateRoot();
    const dir = path.join(stateRoot, "ws1", "jobs", "job-broken");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "job.json"), "{not valid json", "utf8");

    const db = openMetricsDb(":memory:");
    const result = ingestJobDirectory(db, stateRoot);
    assert.equal(result.parseFailures, 1);
    assert.equal(result.ioFailures, 0);
    assert.equal(result.jobsIngested, 0);
    assert.equal(countRows(db, "job"), 0);

    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  it("a malformed usage.json skips the whole job (never recorded as 'died before usage') and retries next run", () => {
    const stateRoot = makeTempStateRoot();
    const dir = writeJobDir(stateRoot, "ws1", "job-msa5ztfv553b", completedJobFixture());
    fs.writeFileSync(path.join(dir, "usage.json"), "{broken", "utf8");

    const db = openMetricsDb(":memory:");
    const first = ingestJobDirectory(db, stateRoot);
    assert.equal(first.parseFailures, 1);
    assert.equal(first.jobsIngested, 0);
    assert.equal(countRows(db, "job"), 0);

    // Fix the file: the job must be picked up on the next run (nothing was
    // written to source_file for the failed attempt).
    fs.writeFileSync(path.join(dir, "usage.json"), JSON.stringify(completedUsageFixture()), "utf8");
    const second = ingestJobDirectory(db, stateRoot);
    assert.equal(second.jobsIngested, 1);
    assert.equal(countRows(db, "job"), 1);

    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  it("returns a zeroed summary for a state root that does not exist", () => {
    const db = openMetricsDb(":memory:");
    const result = ingestJobDirectory(db, path.join(os.tmpdir(), "does-not-exist-" + Date.now()));
    assert.equal(result.workspacesScanned, 0);
    assert.equal(result.jobsIngested, 0);
  });

  it("coexists with chain ingest in one store without touching chain rows", () => {
    const stateRoot = makeTempStateRoot();
    writeChainDir(stateRoot, "ws1", "chain-ms1g7lesd89b", chainModernFixture());
    writeJobDir(stateRoot, "ws1", "job-msa5ztfv553b", completedJobFixture(), completedUsageFixture());

    const db = openMetricsDb(":memory:");
    const chainSummary = ingestChainDirectory(db, stateRoot);
    const jobSummary = ingestJobDirectory(db, stateRoot);
    assert.equal(chainSummary.chainsIngested, 1);
    assert.equal(jobSummary.jobsIngested, 1);
    assert.equal(countRows(db, "chain"), 1);
    assert.equal(countRows(db, "job"), 1);
    // A job never creates chain/round/finding rows.
    assert.equal(countRows(db, "round"), 2);
    assert.equal(countRows(db, "finding"), 1);

    fs.rmSync(stateRoot, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// backend field (kusabi #184 Job C) — carried verbatim into the rows; a
// record without the field stores NULL, never "opencode" (readers apply
// the "NULL means opencode" contract at read time).
// ---------------------------------------------------------------------------

describe("backend field (kusabi #184 Job C)", () => {
  it("carries backend from the records into chain and round rows; absent field stores NULL", () => {
    // A post-split chain: every record carries backend: "claude".
    const claudeChain = structuredClone(chainModernFixture());
    for (const rec of claudeChain.records) rec.backend = "claude";
    const parsed = parseChainRecord(claudeChain, { workspaceSlug: "ws1" });
    assert.equal(parsed.chainRow.backend, "claude");
    assert.ok(parsed.roundRows.length >= 1);
    for (const r of parsed.roundRows) assert.equal(r.backend, "claude");

    // A pre-split chain: no backend field anywhere — the rows must store
    // NULL, NOT "opencode" (the report applies that default, not ingest).
    const legacy = parseChainRecord(chainOldFixture(), { workspaceSlug: "ws1" });
    assert.equal(legacy.chainRow.backend, null);
    assert.ok(legacy.roundRows.length >= 1);
    for (const r of legacy.roundRows) assert.equal(r.backend, null);
  });

  it("a chain whose records agree stores that backend; a chain that switched backends between rounds is 'mixed' (kusabi #195)", () => {
    // The chain-resume convention reads the LAST record — which equals the
    // union of known phase backends for every chain that never changed
    // backend.  A chain that DID switch (round 1 opencode, last round
    // claude) has no single truthful value: kusabi #195 labels it "mixed"
    // at ingest instead of the last record's value, so the by-backend split
    // never counts the whole chain as whichever backend ran last.
    const switched = structuredClone(chainModernFixture());
    switched.records[0].backend = "opencode";
    switched.records[switched.records.length - 1].backend = "claude";
    const parsed = parseChainRecord(switched, { workspaceSlug: "ws1" });
    assert.equal(parsed.chainRow.backend, "mixed");
    assert.equal(parsed.roundRows[0].backend, "opencode"); // per-record, verbatim

    const pure = structuredClone(chainModernFixture());
    for (const rec of pure.records) rec.backend = "claude";
    assert.equal(parseChainRecord(pure, { workspaceSlug: "ws1" }).chainRow.backend, "claude");
  });

  it("the chain walker stores what the files say: 'claude' verbatim, absent as NULL", () => {
    const stateRoot = makeTempStateRoot();
    const claudeChain = structuredClone(chainModernFixture());
    for (const rec of claudeChain.records) rec.backend = "claude";
    writeChainDir(stateRoot, "ws1", "chain-ms1g7lesd89b", claudeChain);
    writeChainDir(stateRoot, "ws1", "chain-mrv4jobge6df", chainOldFixture());

    const db = openMetricsDb(":memory:");
    const result = ingestChainDirectory(db, stateRoot);
    assert.equal(result.chainsIngested, 2);

    const chainByBackend = Object.fromEntries(
      db.prepare("SELECT chain_id, backend FROM chain").all().map((r) => [r.chain_id, r.backend]),
    );
    assert.equal(chainByBackend["chain-ms1g7lesd89b"], "claude");
    assert.equal(chainByBackend["chain-mrv4jobge6df"], null);

    const roundRows = db.prepare("SELECT chain_id, backend FROM round").all();
    assert.equal(roundRows.filter((r) => r.chain_id === "chain-ms1g7lesd89b")
      .every((r) => r.backend === "claude"), true);
    assert.equal(roundRows.filter((r) => r.chain_id === "chain-mrv4jobge6df")
      .every((r) => r.backend === null), true);

    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  it("job records: backend carried verbatim into the job row; absent stays NULL", () => {
    const claudeJob = structuredClone(completedJobFixture());
    claudeJob.backend = "claude";
    const parsed = parseJobRecord(claudeJob, completedUsageFixture(), { workspaceSlug: "ws1" });
    assert.equal(parsed.jobRow.backend, "claude");

    const legacy = parseJobRecord(completedJobFixture(), completedUsageFixture(), { workspaceSlug: "ws1" });
    assert.equal(legacy.jobRow.backend, null);
  });

  it("the job walker stores backend verbatim ('claude'), absent as NULL", () => {
    const stateRoot = makeTempStateRoot();
    const claudeJob = { ...completedJobFixture(), id: "job-claude", backend: "claude" };
    writeJobDir(stateRoot, "ws1", "job-claude", claudeJob, completedUsageFixture());
    const legacyJob = { ...completedJobFixture(), id: "job-legacy" };
    writeJobDir(stateRoot, "ws1", "job-legacy", legacyJob, completedUsageFixture());

    const db = openMetricsDb(":memory:");
    const result = ingestJobDirectory(db, stateRoot);
    assert.equal(result.jobsIngested, 2);
    const jobByBackend = Object.fromEntries(
      db.prepare("SELECT job_id, backend FROM job").all().map((r) => [r.job_id, r.backend]),
    );
    assert.equal(jobByBackend["job-claude"], "claude");
    assert.equal(jobByBackend["job-legacy"], null);

    fs.rmSync(stateRoot, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// per-phase backend attribution (kusabi #195) — kusabi #192 made backend a
// per-phase property (implement vs review can differ within one round), so
// the round row carries `reviewBackend` too and a chain whose known phase
// backends disagree is labelled "mixed" instead of the last record's value.
// ---------------------------------------------------------------------------

describe("per-phase backend attribution (kusabi #195)", () => {
  it("carries reviewBackend per round and labels a phase-mixed chain 'mixed'", () => {
    // The #192 shape: implement on claude, review on opencode, in every round.
    const mixedChain = structuredClone(chainModernFixture());
    for (const rec of mixedChain.records) {
      rec.backend = "claude";
      rec.reviewBackend = "opencode";
    }
    const parsed = parseChainRecord(mixedChain, { workspaceSlug: "ws1" });

    assert.ok(parsed.roundRows.length >= 1);
    for (const r of parsed.roundRows) {
      assert.equal(r.backend, "claude");
      assert.equal(r.reviewBackend, "opencode");
    }
    // NOT "claude" (the last record's implement backend): a chain whose
    // phases disagree gets its own bucket rather than polluting one side.
    assert.equal(parsed.chainRow.backend, "mixed");
  });

  it("a chain whose phases all agree keeps the last record's backend verbatim", () => {
    const pureChain = structuredClone(chainModernFixture());
    for (const rec of pureChain.records) {
      rec.backend = "claude";
      rec.reviewBackend = "claude";
    }
    const parsed = parseChainRecord(pureChain, { workspaceSlug: "ws1" });
    assert.equal(parsed.chainRow.backend, "claude");
    for (const r of parsed.roundRows) assert.equal(r.reviewBackend, "claude");
  });

  it("a cross-round backend switch is labelled 'mixed' at ingest; each round stays verbatim", () => {
    // Rework rounds ARE implement rounds, so each round's own `backend` is
    // already truthful (kusabi #194) and the per-round rows carry the switch
    // losslessly.  The CHAIN row, though, cannot honestly be either backend:
    // the union rule (kusabi #195) labels a chain that switched between
    // rounds "mixed", exactly like a within-round phase mix.
    const chain = structuredClone(chainModernFixture());
    assert.ok(chain.records.length >= 2, "fixture needs at least 2 rounds");
    chain.records[0].backend = "opencode";
    chain.records[0].reviewBackend = "opencode";
    chain.records[chain.records.length - 1].backend = "claude";
    chain.records[chain.records.length - 1].reviewBackend = "claude";
    const parsed = parseChainRecord(chain, { workspaceSlug: "ws1" });
    assert.equal(parsed.chainRow.backend, "mixed");
    assert.equal(parsed.roundRows[0].backend, "opencode"); // still verbatim
    assert.equal(parsed.roundRows[0].reviewBackend, "opencode");
    assert.equal(parsed.roundRows[parsed.roundRows.length - 1].backend, "claude");
  });

  it("one phase-mixed round is enough to label the whole chain 'mixed'", () => {
    const chain = structuredClone(chainModernFixture());
    assert.ok(chain.records.length >= 2, "fixture needs at least 2 rounds");
    for (const rec of chain.records) {
      rec.backend = "opencode";
      rec.reviewBackend = "opencode";
    }
    chain.records[0].reviewBackend = "claude"; // one round ran two backends
    const parsed = parseChainRecord(chain, { workspaceSlug: "ws1" });
    assert.equal(parsed.chainRow.backend, "mixed");
  });

  it("a legacy chain with no backend fields anywhere ingests exactly as before: all NULL", () => {
    const legacy = parseChainRecord(chainOldFixture(), { workspaceSlug: "ws1" });
    assert.equal(legacy.chainRow.backend, null);
    assert.ok(legacy.roundRows.length >= 1);
    for (const r of legacy.roundRows) {
      assert.equal(r.backend, null);
      // Never backfilled from `backend`: a pre-#192 record's review backend
      // is genuinely unknown, which is not the same fact as "the same".
      assert.equal(r.reviewBackend, null);
    }
  });

  it("a pre-#192 record (backend but no reviewBackend) leaves review_backend NULL and the chain unmixed", () => {
    const chain = structuredClone(chainModernFixture());
    for (const rec of chain.records) rec.backend = "claude";
    const parsed = parseChainRecord(chain, { workspaceSlug: "ws1" });
    assert.equal(parsed.chainRow.backend, "claude");
    for (const r of parsed.roundRows) assert.equal(r.reviewBackend, null);
  });

  it("the chain walker stores review_backend and the 'mixed' chain label in the database", () => {
    const stateRoot = makeTempStateRoot();
    const mixedChain = structuredClone(chainModernFixture());
    for (const rec of mixedChain.records) {
      rec.backend = "claude";
      rec.reviewBackend = "opencode";
    }
    writeChainDir(stateRoot, "ws1", "chain-ms1g7lesd89b", mixedChain);
    writeChainDir(stateRoot, "ws1", "chain-mrv4jobge6df", chainOldFixture());

    const db = openMetricsDb(":memory:");
    const result = ingestChainDirectory(db, stateRoot);
    assert.equal(result.chainsIngested, 2);

    const chainByBackend = Object.fromEntries(
      db.prepare("SELECT chain_id, backend FROM chain").all().map((r) => [r.chain_id, r.backend]),
    );
    assert.equal(chainByBackend["chain-ms1g7lesd89b"], "mixed");
    assert.equal(chainByBackend["chain-mrv4jobge6df"], null);

    const roundRows = db.prepare("SELECT chain_id, backend, review_backend FROM round").all();
    const mixedRounds = roundRows.filter((r) => r.chain_id === "chain-ms1g7lesd89b");
    assert.ok(mixedRounds.length >= 1);
    assert.equal(mixedRounds.every((r) => r.backend === "claude"), true);
    assert.equal(mixedRounds.every((r) => r.review_backend === "opencode"), true);
    assert.equal(roundRows.filter((r) => r.chain_id === "chain-mrv4jobge6df")
      .every((r) => r.review_backend === null), true);

    fs.rmSync(stateRoot, { recursive: true, force: true });
  });
});
