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
