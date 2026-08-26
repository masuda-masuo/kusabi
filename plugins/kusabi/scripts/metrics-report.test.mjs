// metrics-report.test.mjs — Unit tests for metrics-report.mjs
//
// Fixtures are built with :memory: databases via openMetricsDb (phase-1
// writable open) plus the phase-1 upsert* helpers, then handed to the
// report functions as an already-open handle -- exactly the shape
// metrics-report.mjs receives in production (openMetricsDbReadOnly there,
// openMetricsDb here so the fixtures can actually be written).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  openMetricsDb,
  upsertSourceFile,
  upsertSession,
  upsertTurn,
  upsertChain,
  upsertRound,
  upsertJob,
  upsertCursorSessionCounter,
  replaceToolStatsForJob,
} from "./metrics-db.mjs";

import {
  parseTimeBound,
  computeReport,
  renderReportText,
  renderReportJson,
  missingStoreReport,
  renderMissingText,
} from "./metrics-report.mjs";

describe("parseTimeBound", () => {
  it("returns undefined for an absent bound", () => {
    assert.equal(parseTimeBound(undefined, "--since"), undefined);
  });

  it("parses a valid ISO timestamp to epoch ms", () => {
    assert.equal(parseTimeBound("2026-07-26T00:00:00.000Z", "--since"), Date.parse("2026-07-26T00:00:00.000Z"));
  });

  it("throws a fatal error for an unparseable bound, naming the flag", () => {
    assert.throws(
      () => parseTimeBound("not-a-date", "--since"),
      /--since: not a parseable timestamp: not-a-date/,
    );
  });
});

describe("missing store", () => {
  it("missingStoreReport has status 'missing' with empty arrays and dbPath preserved", () => {
    const report = missingStoreReport("/tmp/kusabi-nope/absent.db");
    assert.equal(report.status, "missing");
    assert.equal(report.freshness.dbPath, "/tmp/kusabi-nope/absent.db");
    assert.deepEqual(report.sessionCostByModel, []);
    assert.deepEqual(report.chainJoin, []);
    assert.deepEqual(report.briefOutcome, []);
  });

  it("renderMissingText matches the required wording", () => {
    assert.equal(
      renderMissingText("/tmp/x/metrics.db"),
      "Metrics store not found at /tmp/x/metrics.db. Run metrics-ingest first.",
    );
  });

  it("renderReportText on a missing-store report defers to renderMissingText", () => {
    const report = missingStoreReport("/tmp/x/metrics.db");
    assert.equal(renderReportText(report), renderMissingText("/tmp/x/metrics.db"));
  });
});

describe("empty store", () => {
  it("computeReport on a totally empty db returns status 'empty' and does not throw", () => {
    const db = openMetricsDb(":memory:");
    const report = computeReport(db, { dbPath: ":memory:" });
    assert.equal(report.status, "empty");
    assert.equal(report.window, null);
  });

  it("freshness on an empty store renders all maxima as (none)", () => {
    const db = openMetricsDb(":memory:");
    const report = computeReport(db, { dbPath: ":memory:" });
    assert.equal(report.freshness.lastIngestRun, null);
    assert.equal(report.freshness.newestTranscriptTurn, null);
    assert.equal(report.freshness.newestChainRound, null);
    assert.equal(report.freshness.newestChainDate, null);
    assert.equal(report.freshness.sourceFilesRecorded, 0);
    const text = renderReportText(report);
    assert.match(text, /\(none\)/);
    assert.match(text, /Store is empty \(0 sessions, 0 turns, 0 chains, 0 jobs\)\./);
  });

  it("does not throw and produces output for --json on an empty store", () => {
    const db = openMetricsDb(":memory:");
    const report = computeReport(db, { dbPath: ":memory:" });
    const json = JSON.parse(renderReportJson(report));
    assert.equal(json.status, "empty");
  });
});

// ---------------------------------------------------------------------------
// A populated fixture shared by several describe blocks below.
// ---------------------------------------------------------------------------

function buildFixture() {
  const db = openMetricsDb(":memory:");

  upsertSourceFile(db, { path: "/a.jsonl", size: 1, mtimeMs: 1, ingestedAt: "2026-07-27T00:00:00.000Z" });

  // Session A: 12-char prefix, matched exactly once by a chain.
  const sessA = "sessalpha0-12-full-session-a";
  upsertSession(db, {
    sessionId: sessA,
    firstTs: "2026-07-26T09:00:00.000Z",
    firstTsMs: Date.parse("2026-07-26T09:00:00.000Z"),
    lastTs: "2026-07-26T10:00:00.000Z",
    lastTsMs: Date.parse("2026-07-26T10:00:00.000Z"),
  });
  // Normal turn with usage.
  upsertTurn(db, {
    requestId: "r1",
    sessionId: sessA,
    ts: "2026-07-26T09:30:00.000Z",
    tsMs: Date.parse("2026-07-26T09:30:00.000Z"),
    model: "claude-opus-5",
    input: 100,
    output: 200,
    cacheRead: 50000,
    cacheWrite: 1000,
    isSidechain: 0,
    isSynthetic: 0,
  });
  // Sidechain turn (real billed spend -- included in totals, broken out).
  upsertTurn(db, {
    requestId: "r2",
    sessionId: sessA,
    ts: "2026-07-26T09:31:00.000Z",
    tsMs: Date.parse("2026-07-26T09:31:00.000Z"),
    model: "claude-opus-5",
    input: 10,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    isSidechain: 1,
    isSynthetic: 0,
  });
  // Synthetic turn -- excluded from sums, counted separately.
  upsertTurn(db, {
    requestId: "r3",
    sessionId: sessA,
    ts: "2026-07-26T09:32:00.000Z",
    tsMs: Date.parse("2026-07-26T09:32:00.000Z"),
    model: "claude-opus-5",
    isSynthetic: 1,
    isSidechain: 0,
  });
  // No-usage-recorded turn (input IS NULL, not synthetic).
  upsertTurn(db, {
    requestId: "r4",
    sessionId: sessA,
    ts: "2026-07-26T09:33:00.000Z",
    tsMs: Date.parse("2026-07-26T09:33:00.000Z"),
    model: "claude-opus-5",
    isSynthetic: 0,
    isSidechain: 0,
  });
  // A turn with no timestamp at all.
  upsertTurn(db, {
    requestId: "r5",
    sessionId: sessA,
    model: "claude-opus-5",
    input: 5,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    isSynthetic: 0,
    isSidechain: 0,
  });

  // Session B: an entirely different session -- used for the ambiguous /
  // orphan prefix tests (session id starts with "zz").
  upsertSession(db, {
    sessionId: "zzzzzzzzzzzz-session-b",
    firstTs: "2026-07-25T00:00:00.000Z",
    firstTsMs: Date.parse("2026-07-25T00:00:00.000Z"),
  });
  // Session C shares an 8-char prefix with session D (for the ambiguous case).
  upsertSession(db, {
    sessionId: "12345678-session-c",
    firstTs: "2026-07-24T00:00:00.000Z",
    firstTsMs: Date.parse("2026-07-24T00:00:00.000Z"),
  });
  upsertSession(db, {
    sessionId: "12345678-session-d",
    firstTs: "2026-07-23T00:00:00.000Z",
    firstTsMs: Date.parse("2026-07-23T00:00:00.000Z"),
  });

  // Chain 1: matches session A via its 12-char prefix (exact equality would
  // miss this -- sessA's id is longer than the stored prefix).
  upsertChain(db, {
    chainId: "chain-1",
    orchModel: "claude-opus-5",
    orchSession: "sessalpha0-12",
    orchDate: "2026-07-26",
    totalsInput: 10,
    totalsOutput: 20,
    totalsCost: 0.5,
    briefHasSmoke: 1,
    briefChars: 500,
    briefHasDeliverables: 1,
  });
  upsertRound(db, {
    chainId: "chain-1",
    round: 1,
    startedAt: "2026-07-26T09:00:00.000Z",
    startedMs: Date.parse("2026-07-26T09:00:00.000Z"),
    disposition: "rework",
  });
  // Final round (round=2) determines final disposition -- must be "accept",
  // not the round=1 "rework".
  upsertRound(db, {
    chainId: "chain-1",
    round: 2,
    startedAt: "2026-07-26T09:15:00.000Z",
    startedMs: Date.parse("2026-07-26T09:15:00.000Z"),
    disposition: "accept",
  });

  // Chain 2: shares session A's prefix too (two chains sharing one
  // orchestrator session -- annotation + non-additivity check).
  upsertChain(db, {
    chainId: "chain-2",
    orchModel: "claude-opus-5",
    orchSession: "sessalpha0-12",
    orchDate: "2026-07-26",
    totalsInput: 30,
    totalsOutput: 40,
    totalsCost: 1.5,
    briefHasSmoke: 0,
    briefChars: 300,
    briefHasDeliverables: 1,
  });
  upsertRound(db, {
    chainId: "chain-2",
    round: 1,
    startedAt: "2026-07-26T11:00:00.000Z",
    startedMs: Date.parse("2026-07-26T11:00:00.000Z"),
    disposition: "accept",
  });

  // Chain 3: ambiguous prefix -- "12345678" matches both session C and D.
  upsertChain(db, {
    chainId: "chain-3",
    orchModel: "claude-sonnet-5",
    orchSession: "12345678",
    orchDate: "2026-07-24",
    totalsInput: 5,
    totalsOutput: 5,
    totalsCost: 0.1,
    briefHasSmoke: 1,
    briefChars: 200,
    briefHasDeliverables: 1,
  });
  upsertRound(db, {
    chainId: "chain-3",
    round: 1,
    startedAt: "2026-07-24T00:00:00.000Z",
    startedMs: Date.parse("2026-07-24T00:00:00.000Z"),
    disposition: "escalate",
  });

  // Chain 4: orphan -- prefix matches no ingested session.
  upsertChain(db, {
    chainId: "chain-4",
    orchModel: "claude-sonnet-5",
    orchSession: "ffffffff",
    orchDate: "2026-07-24",
    totalsInput: 1,
    totalsOutput: 1,
    totalsCost: 0.01,
    briefHasSmoke: 0,
    briefChars: 100,
    briefHasDeliverables: 1,
  });
  upsertRound(db, {
    chainId: "chain-4",
    round: 1,
    startedAt: "2026-07-24T01:00:00.000Z",
    startedMs: Date.parse("2026-07-24T01:00:00.000Z"),
    disposition: "accept",
  });

  // Chain 5: no rounds at all -- must be counted in "chains with no
  // rounds", not silently dropped from the brief/outcome table.
  upsertChain(db, {
    chainId: "chain-5",
    orchModel: "claude-sonnet-5",
    orchSession: null,
    orchDate: "2026-07-24",
    totalsInput: null,
    totalsOutput: null,
    totalsCost: null,
    briefHasSmoke: 1,
    briefChars: 150,
    briefHasDeliverables: 1,
  });

  return db;
}

describe("window filtering is by instant, not string", () => {
  it("a +09:00 bound lands on the correct side of a UTC-stored instant", () => {
    const db = buildFixture();
    // 2026-07-26T09:30:00Z turn (r1). A since bound of
    // "2026-07-26T18:29:00+09:00" is 2026-07-26T09:29:00Z -- one minute
    // BEFORE the turn, so the turn must be included. A naive string compare
    // ("2026-07-26T18:29:00+09:00" vs "2026-07-26T09:30:00.000Z") would put
    // it on the wrong side.
    const report = computeReport(db, { since: "2026-07-26T18:29:00+09:00", dbPath: ":memory:" });
    assert.ok(report.window.turnsInWindow >= 1, "expected the turn to be included by instant comparison");
  });

  it("an unparseable --since throws instead of degrading to string comparison", () => {
    const db = buildFixture();
    assert.throws(() => computeReport(db, { since: "not-a-timestamp" }));
  });
});

describe("synthetic turns", () => {
  it("contribute nothing to sums and are counted separately from the total", () => {
    const db = buildFixture();
    const report = computeReport(db, { dbPath: ":memory:" });
    const row = report.sessionCostByModel.find((r) => r.model === "claude-opus-5");
    assert.ok(row, "expected a claude-opus-5 row");
    assert.equal(row.syntheticCount, 1);
    // input sum = 100 (r1) + 10 (r2, sidechain) + 5 (r5, no timestamp) = 115
    assert.equal(row.input, 115);
  });
});

describe("NULL usage handling", () => {
  it("a turn with no usage recorded (input IS NULL, not synthetic) is counted separately, not as 0", () => {
    const db = buildFixture();
    const report = computeReport(db, { dbPath: ":memory:" });
    const row = report.sessionCostByModel.find((r) => r.model === "claude-opus-5");
    assert.equal(row.noUsageRecorded, 1);
  });

  it("SUM over an all-NULL usage column renders 'n/a', never '0'", () => {
    const db = openMetricsDb(":memory:");
    upsertSession(db, { sessionId: "s1", firstTs: "2026-07-26T00:00:00.000Z", firstTsMs: 1 });
    upsertTurn(db, {
      requestId: "r1",
      sessionId: "s1",
      ts: "2026-07-26T00:00:00.000Z",
      tsMs: 1,
      model: "no-usage-model",
      isSynthetic: 0,
    });
    const report = computeReport(db, { dbPath: ":memory:" });
    const row = report.sessionCostByModel.find((r) => r.model === "no-usage-model");
    assert.equal(row.input, null);
    assert.equal(row.costUnits, null);
    const text = renderReportText(report);
    assert.match(text, /no-usage-model.*input n\/a/);
    assert.doesNotMatch(text, /no-usage-model.*input 0\b/);
  });
});

describe("sidechain turns", () => {
  it("are included in the session total and reported in the breakout", () => {
    const db = buildFixture();
    const report = computeReport(db, { dbPath: ":memory:" });
    const row = report.sessionCostByModel.find((r) => r.model === "claude-opus-5");
    assert.equal(row.sidechainCount, 1);
    // Sidechain turn's input (10) is part of the summed input (115), i.e.
    // not excluded -- see the "synthetic turns" test above for the sum.
    assert.equal(row.input, 115);
  });
});

describe("prefix join", () => {
  it("matches a 12-char prefix that exact equality would miss", () => {
    const db = buildFixture();
    const report = computeReport(db, { dbPath: ":memory:" });
    const row = report.chainJoin.find((r) => r.chainId === "chain-1");
    assert.equal(row.orchestrator.state, "matched");
  });

  it("a prefix matching 2 sessions renders 'ambiguous'", () => {
    const db = buildFixture();
    const report = computeReport(db, { dbPath: ":memory:" });
    const row = report.chainJoin.find((r) => r.chainId === "chain-3");
    assert.equal(row.orchestrator.state, "ambiguous");
    assert.equal(row.orchestrator.matchCount, 2);
    const text = renderReportText(report);
    assert.match(text, /ambiguous \(2 sessions\)/);
  });

  it("a prefix matching 0 sessions renders 'orphan'", () => {
    const db = buildFixture();
    const report = computeReport(db, { dbPath: ":memory:" });
    const row = report.chainJoin.find((r) => r.chainId === "chain-4");
    assert.equal(row.orchestrator.state, "orphan");
    const text = renderReportText(report);
    assert.match(text, /orphan \(session not ingested\)/);
  });

  it("a session shared by 2 chains is annotated with the shared count and never totalled", () => {
    const db = buildFixture();
    const report = computeReport(db, { dbPath: ":memory:" });
    const row1 = report.chainJoin.find((r) => r.chainId === "chain-1");
    const row2 = report.chainJoin.find((r) => r.chainId === "chain-2");
    assert.equal(row1.orchestrator.state, "matched");
    assert.equal(row2.orchestrator.state, "matched");
    assert.equal(row1.orchestrator.sharedChainCount, 2);
    assert.equal(row2.orchestrator.sharedChainCount, 2);
    // No total/subtotal field anywhere on the report's chainJoin section.
    assert.equal(report.chainJoin.total, undefined);
  });
});

describe("final disposition", () => {
  it("comes from the last round (round=2 'accept'), not the first (round=1 'rework')", () => {
    const db = buildFixture();
    const report = computeReport(db, { dbPath: ":memory:" });
    const block = report.briefOutcome.find((b) => b.orchModel === "claude-opus-5");
    // chain-1 has round count 2, final disposition "accept", smoke present.
    assert.equal(block.table["Smoke present"].accept["rounds=2"], 1);
    assert.equal(block.table["Smoke present"].rework, undefined);
  });

  it("chains with no rounds are counted, not silently dropped", () => {
    const db = buildFixture();
    const report = computeReport(db, { dbPath: ":memory:" });
    const block = report.briefOutcome.find((b) => b.orchModel === "claude-sonnet-5");
    assert.equal(block.chainsWithNoRounds, 1);
  });
});

// ---------------------------------------------------------------------------
// escalate substantive/no-work split (kusabi #165)
// ---------------------------------------------------------------------------

/** Build a store with escalated chains in each class, plus a non-escalated
 * chain that must not touch the split. */
function buildEscalateSplitFixture() {
  const db = openMetricsDb(":memory:");

  upsertChain(db, {
    chainId: "esc-substantive",
    orchModel: "claude-opus-5",
    orchSession: null,
    orchDate: "2026-07-26",
    briefHasSmoke: 1,
    briefChars: 300,
    briefHasDeliverables: 1,
  });
  // Changed the worktree, then escalated anyway.
  upsertRound(db, {
    chainId: "esc-substantive",
    round: 1,
    startedAt: "2026-07-26T09:00:00.000Z",
    startedMs: Date.parse("2026-07-26T09:00:00.000Z"),
    disposition: "escalate",
    worktreeChanged: 1,
  });

  upsertChain(db, {
    chainId: "esc-nowork",
    orchModel: "claude-opus-5",
    orchSession: null,
    orchDate: "2026-07-26",
    briefHasSmoke: 1,
    briefChars: 200,
    briefHasDeliverables: 1,
  });
  // The 722-token zero-change shape: implement produced tokens, measured no
  // change — still no-work.
  upsertRound(db, {
    chainId: "esc-nowork",
    round: 1,
    startedAt: "2026-07-26T09:30:00.000Z",
    startedMs: Date.parse("2026-07-26T09:30:00.000Z"),
    disposition: "escalate",
    worktreeChanged: 0,
    implementOut: 722,
  });

  upsertChain(db, {
    chainId: "esc-unknown",
    orchModel: "claude-opus-5",
    orchSession: null,
    orchDate: "2026-07-26",
    briefHasSmoke: 1,
    briefChars: 150,
    briefHasDeliverables: 1,
  });
  // Old record — worktree_changed was never written (NULL).
  upsertRound(db, {
    chainId: "esc-unknown",
    round: 1,
    startedAt: "2026-07-26T10:00:00.000Z",
    startedMs: Date.parse("2026-07-26T10:00:00.000Z"),
    disposition: "escalate",
  });

  // Non-escalated chains: accepted and discarded — must never enter the split.
  upsertChain(db, {
    chainId: "chain-accept",
    orchModel: "claude-opus-5",
    orchSession: null,
    orchDate: "2026-07-26",
    briefHasSmoke: 1,
    briefChars: 100,
    briefHasDeliverables: 1,
  });
  upsertRound(db, {
    chainId: "chain-accept",
    round: 1,
    startedAt: "2026-07-26T11:00:00.000Z",
    startedMs: Date.parse("2026-07-26T11:00:00.000Z"),
    disposition: "accept",
    worktreeChanged: 1,
  });

  return db;
}

describe("escalate split (kusabi #165)", () => {
  it("splits escalated chains into substantive / no-work / unknown, preserving the escalate total", () => {
    const db = buildEscalateSplitFixture();
    const report = computeReport(db, { dbPath: ":memory:" });
    const block = report.briefOutcome.find((b) => b.orchModel === "claude-opus-5");
    assert.ok(block, "expected a claude-opus-5 block");
    assert.deepEqual(block.escalateSplit, {
      escalated: 3,
      substantive: 1,
      noWork: 1,
      unknown: 1,
    });
    // The escalate cell in the disposition table is unchanged by the split.
    assert.equal(block.table["Smoke present"].escalate["rounds=1"], 3);
    // A non-escalated chain never enters the split.
    assert.equal(block.escalateSplit.substantive + block.escalateSplit.noWork
      + block.escalateSplit.unknown, block.escalateSplit.escalated);
  });

  it("renders the split line in the text report", () => {
    const db = buildEscalateSplitFixture();
    const text = renderReportText(computeReport(db, { dbPath: ":memory:" }));
    assert.match(text, /escalated chains: 3 \(substantive 1, no-work 1, unknown 1\)/);
  });

  it("escalated chains whose rounds predate the field render as uncomputable, never no-work 0", () => {
    // buildFixture's chain-3 escalated with no worktree_changed written —
    // the store has the column but the round predates it (NULL).
    const db = buildFixture();
    const report = computeReport(db, { dbPath: ":memory:" });
    const block = report.briefOutcome.find((b) => b.orchModel === "claude-sonnet-5");
    assert.deepEqual(block.escalateSplit, {
      escalated: 1,
      substantive: 0,
      noWork: 0,
      unknown: 1,
    });
    const text = renderReportText(report);
    assert.match(text, /escalated chains: 1 \(no-work: \?\)/);
  });

  it("a block with no escalated chains carries an all-zero split and no text line", () => {
    const db = openMetricsDb(":memory:");
    upsertChain(db, {
      chainId: "chain-accept-only",
      orchModel: "claude-opus-5",
      orchSession: null,
      orchDate: "2026-07-26",
      briefHasSmoke: 1,
      briefChars: 100,
      briefHasDeliverables: 1,
    });
    upsertRound(db, {
      chainId: "chain-accept-only",
      round: 1,
      startedAt: "2026-07-26T11:00:00.000Z",
      startedMs: Date.parse("2026-07-26T11:00:00.000Z"),
      disposition: "accept",
      worktreeChanged: 1,
    });
    const report = computeReport(db, { dbPath: ":memory:" });
    const block = report.briefOutcome.find((b) => b.orchModel === "claude-opus-5");
    assert.deepEqual(block.escalateSplit, {
      escalated: 0,
      substantive: 0,
      noWork: 0,
      unknown: 0,
    });
    const text = renderReportText(report);
    assert.doesNotMatch(text, /escalated chains:/);
  });

  it("--json carries the split in the briefOutcome blocks", () => {
    const db = buildEscalateSplitFixture();
    const parsed = JSON.parse(renderReportJson(computeReport(db, { dbPath: ":memory:" })));
    const block = parsed.briefOutcome.find((b) => b.orchModel === "claude-opus-5");
    assert.deepEqual(block.escalateSplit, {
      escalated: 3,
      substantive: 1,
      noWork: 1,
      unknown: 1,
    });
  });
});

describe("escalate split — legacy store degradation (kusabi #165)", () => {
  it("a store written before round.worktree_changed existed renders escalates as unknown, never no-work", () => {
    const db = openMetricsDb(":memory:");
    // Simulate a pre-#165 store file: the writable schema already added the
    // column, so drop it the way the read-only surface will encounter it.
    db.exec("ALTER TABLE round DROP COLUMN worktree_changed");

    // Old stores were written by pre-#165 code, so insert with raw SQL that
    // predates the column (upsertRound would reference the dropped column).
    db.prepare(`
      INSERT INTO chain (chain_id, orch_model, orch_session, orch_date,
        totals_input, totals_output, totals_cost, brief_has_smoke, brief_chars,
        brief_has_deliverables)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("chain-legacy-esc", "claude-opus-5", null, "2026-07-22",
      10, 20, 0.5, 1, 300, 1);
    db.prepare(`
      INSERT INTO round (chain_id, round, started_at, started_ms, disposition)
      VALUES (?, ?, ?, ?, ?)
    `).run("chain-legacy-esc", 1, "2026-07-22T09:00:00.000Z",
      Date.parse("2026-07-22T09:00:00.000Z"), "escalate");

    const report = computeReport(db, { dbPath: ":memory:" });
    const block = report.briefOutcome.find((b) => b.orchModel === "claude-opus-5");
    assert.deepEqual(block.escalateSplit, {
      escalated: 1,
      substantive: 0,
      noWork: 0,
      unknown: 1,
    });
    // The text surface shows the absence explicitly — never a silent 0.
    const text = renderReportText(report);
    assert.match(text, /escalated chains: 1 \(no-work: \?\)/);
  });
});

describe("--json output", () => {
  it("parses as valid JSON and preserves null for absent sums", () => {
    const db = openMetricsDb(":memory:");
    upsertSession(db, { sessionId: "s1", firstTs: "2026-07-26T00:00:00.000Z", firstTsMs: 1 });
    upsertTurn(db, {
      requestId: "r1", sessionId: "s1", ts: "2026-07-26T00:00:00.000Z", tsMs: 1,
      model: "no-usage-model", isSynthetic: 0,
    });
    const report = computeReport(db, { dbPath: ":memory:" });
    const parsed = JSON.parse(renderReportJson(report));
    assert.equal(parsed.status, "ok");
    const row = parsed.sessionCostByModel.find((r) => r.model === "no-usage-model");
    assert.equal(row.input, null);
    assert.equal(row.costUnits, null);
  });

  it("emits a valid document with empty arrays for the empty-store case", () => {
    const db = openMetricsDb(":memory:");
    const report = computeReport(db, { dbPath: ":memory:" });
    const parsed = JSON.parse(renderReportJson(report));
    assert.equal(parsed.status, "empty");
    assert.deepEqual(parsed.sessionCostByModel, []);
  });
});

describe("empty window", () => {
  it("a window that selects nothing still returns freshness + window and does not throw", () => {
    const db = buildFixture();
    const report = computeReport(db, { since: "2099-01-01T00:00:00.000Z", dbPath: ":memory:" });
    assert.equal(report.status, "empty_window");
    assert.ok(report.freshness);
    assert.ok(report.window);
    const text = renderReportText(report);
    assert.match(text, /no data in window/);
    // Freshness block still present and non-empty even though the window
    // excludes all the real data.
    assert.match(text, /Metrics store:/);
  });
});

describe("chain join warning banner", () => {
  it("says WHOLE session when unbounded and IN-WINDOW portion when bounded", () => {
    const db = buildFixture();
    const allTime = renderReportText(computeReport(db, { dbPath: ":memory:" }));
    assert.match(allTime, /WHOLE orchestrator session/);
    assert.doesNotMatch(allTime, /IN-WINDOW portion/);
    const bounded = renderReportText(computeReport(db, {
      since: "2026-07-01T00:00:00Z",
      until: "2026-08-01T00:00:00Z",
      dbPath: ":memory:",
    }));
    assert.match(bounded, /IN-WINDOW portion of the orchestrator session/);
    assert.doesNotMatch(bounded, /WHOLE orchestrator session/);
  });
});

// ---------------------------------------------------------------------------
// Delegated jobs (#154)
// ---------------------------------------------------------------------------

/** Add a spread of delegated jobs to an existing fixture db. */
function addJobsFixture(db) {
  // Free-tier completed job — cost 0 is a REAL measurement.
  upsertJob(db, {
    jobId: "job-measured",
    workspaceSlug: "ws1",
    kind: "task",
    status: "completed",
    startedAt: "2026-07-26T12:00:00.000Z",
    startedMs: Date.parse("2026-07-26T12:00:00.000Z"),
    finishedAt: "2026-07-26T12:26:15.000Z",
    finishedMs: Date.parse("2026-07-26T12:26:15.000Z"),
    durationSeconds: 1575,
    steps: 152,
    usageAvailable: 1,
    usageInput: 5000,
    usageOutput: 82419,
    usageReasoning: 102005,
    usageCost: 0,
  });
  // Job that died before writing usage.json (usageAvailable null).
  upsertJob(db, {
    jobId: "job-nousage",
    workspaceSlug: "ws1",
    kind: "task",
    status: "error",
    startedAt: "2026-07-26T13:00:00.000Z",
    startedMs: Date.parse("2026-07-26T13:00:00.000Z"),
    steps: 3,
    usageAvailable: null,
  });
  // usage.json present but available: false.
  upsertJob(db, {
    jobId: "job-unavailable",
    workspaceSlug: "ws2",
    kind: "review",
    status: "provider-error",
    startedAt: "2026-07-24T02:00:00.000Z",
    startedMs: Date.parse("2026-07-24T02:00:00.000Z"),
    durationSeconds: 564,
    steps: 21,
    usageAvailable: 0,
  });
  // A status this code has never heard of — must survive verbatim.
  upsertJob(db, {
    jobId: "job-unknown-status",
    workspaceSlug: "ws2",
    kind: "task",
    status: "some-future-status",
    startedAt: "2026-07-24T03:00:00.000Z",
    startedMs: Date.parse("2026-07-24T03:00:00.000Z"),
    usageAvailable: 1,
    usageOutput: 79,
    usageReasoning: 0,
    usageCost: 0,
  });
  // A job with no timestamps at all — excluded (and counted) when a bound
  // is active.
  upsertJob(db, {
    jobId: "job-undated",
    workspaceSlug: "ws1",
    kind: "task",
    status: "cancelled",
    usageAvailable: null,
  });
  return db;
}

describe("delegated jobs section (#154)", () => {
  it("counts statuses verbatim, including values not in any known vocabulary", () => {
    const db = addJobsFixture(buildFixture());
    const report = computeReport(db, { dbPath: ":memory:" });
    assert.equal(report.delegatedJobs.jobCount, 5);
    assert.equal(report.delegatedJobs.statusCounts.completed, 1);
    assert.equal(report.delegatedJobs.statusCounts.error, 1);
    assert.equal(report.delegatedJobs.statusCounts["provider-error"], 1);
    assert.equal(report.delegatedJobs.statusCounts.cancelled, 1);
    assert.equal(report.delegatedJobs.statusCounts["some-future-status"], 1);
    const text = renderReportText(report);
    assert.match(text, /some-future-status/);
  });

  it("keeps absent usage, unavailable usage, and measured usage as three distinct states", () => {
    const db = addJobsFixture(buildFixture());
    const report = computeReport(db, { dbPath: ":memory:" });
    assert.equal(report.delegatedJobs.jobsWithoutUsage, 2); // job-nousage + job-undated
    assert.equal(report.delegatedJobs.jobsUsageUnavailable, 1); // job-unavailable
    const rows = report.delegatedJobs.jobs;
    assert.equal(rows.find((j) => j.jobId === "job-nousage").usageState, "never_written");
    assert.equal(rows.find((j) => j.jobId === "job-unavailable").usageState, "unavailable");
    assert.equal(rows.find((j) => j.jobId === "job-measured").usageState, "measured");
    const text = renderReportText(report);
    assert.match(text, /usage\.json never written/);
    assert.match(text, /usage recorded but unavailable/);
  });

  it("renders cost 0 (free tier) as 0.00, never n/a — a measured zero is not a missing value", () => {
    const db = addJobsFixture(buildFixture());
    const report = computeReport(db, { dbPath: ":memory:" });
    // Both measured jobs have cost 0 -> total is 0, not null.
    assert.equal(report.delegatedJobs.totals.cost, 0);
    assert.equal(report.delegatedJobs.totals.output, 82419 + 79);
    const text = renderReportText(report);
    assert.match(text, /cost 0\.00/);
    const measuredRow = renderReportText(report)
      .split("\n")
      .find((l) => l.includes("job-measured"));
    assert.doesNotMatch(measuredRow, /cost n\/a/);
  });

  it("honours --since/--until by job start instant and counts undated jobs as excluded", () => {
    const db = addJobsFixture(buildFixture());
    const report = computeReport(db, {
      since: "2026-07-26T00:00:00.000Z",
      until: "2026-07-27T00:00:00.000Z",
      dbPath: ":memory:",
    });
    // Only job-measured and job-nousage started on 2026-07-26.
    assert.equal(report.window.jobsInWindow, 2);
    assert.equal(report.window.jobsExcludedNoTimestamp, 1); // job-undated
    const ids = report.delegatedJobs.jobs.map((j) => j.jobId).sort();
    assert.deepEqual(ids, ["job-measured", "job-nousage"]);
  });

  it("does not appear in, or change, any chain section (a job is not a chain)", () => {
    const before = computeReport(buildFixture(), { dbPath: ":memory:" });
    const after = computeReport(addJobsFixture(buildFixture()), { dbPath: ":memory:" });
    // Chain sections byte-identical with and without the jobs present.
    assert.deepEqual(after.chainJoin, before.chainJoin);
    assert.deepEqual(after.briefOutcome, before.briefOutcome);
    assert.deepEqual(after.sessionCostByModel, before.sessionCostByModel);
    assert.equal(after.window.chainsInWindow, before.window.chainsInWindow);
    // And no job id ever leaks into the chain join rows.
    for (const row of after.chainJoin) {
      assert.doesNotMatch(String(row.chainId), /^job-/);
    }
  });

  it("a store written before the job table existed reports zero jobs instead of crashing", () => {
    const db = buildFixture();
    db.exec("DROP TABLE job"); // simulate a pre-#154 metrics.db opened read-only
    const report = computeReport(db, { dbPath: ":memory:" });
    assert.equal(report.delegatedJobs.jobCount, 0);
    assert.equal(report.freshness.newestJobStart, null);
    const text = renderReportText(report);
    assert.match(text, /Delegated jobs/);
    assert.match(text, /no data in window/);
  });

  it("an all-jobs store is not 'empty', and a job-only window is not 'empty_window'", () => {
    const db = openMetricsDb(":memory:");
    upsertJob(db, {
      jobId: "job-only",
      status: "completed",
      startedAt: "2026-07-26T12:00:00.000Z",
      startedMs: Date.parse("2026-07-26T12:00:00.000Z"),
      usageAvailable: 1,
      usageOutput: 10,
      usageCost: 0,
    });
    const report = computeReport(db, { dbPath: ":memory:" });
    assert.equal(report.status, "ok");
    assert.equal(report.delegatedJobs.jobCount, 1);
  });

  it("freshness reports the newest job start independently of the window", () => {
    const db = addJobsFixture(buildFixture());
    const report = computeReport(db, { since: "2099-01-01T00:00:00.000Z", dbPath: ":memory:" });
    assert.equal(report.freshness.newestJobStart, "2026-07-26T13:00:00.000Z");
  });

  it("--json carries the delegatedJobs section with nulls preserved", () => {
    const db = addJobsFixture(buildFixture());
    const parsed = JSON.parse(renderReportJson(computeReport(db, { dbPath: ":memory:" })));
    const row = parsed.delegatedJobs.jobs.find((j) => j.jobId === "job-nousage");
    assert.equal(row.output, null);
    assert.equal(row.cost, null);
    const measured = parsed.delegatedJobs.jobs.find((j) => j.jobId === "job-measured");
    assert.equal(measured.cost, 0);
  });
});

// ---------------------------------------------------------------------------
// By-backend split (kusabi #184 Job C)
// ---------------------------------------------------------------------------

/** A fixture whose window contains BOTH backends: claude chains/jobs and
 * legacy (NULL backend) chains/jobs that must read as "opencode". */
function buildBackendSplitFixture() {
  const db = openMetricsDb(":memory:");
  // Claude chain: 2 rounds, final disposition accept, cost 1.0.
  upsertChain(db, {
    chainId: "chain-claude",
    orchModel: "claude-opus-5",
    orchDate: "2026-07-26",
    backend: "claude",
    totalsCost: 1.0,
    briefHasSmoke: 1,
    briefChars: 300,
    briefHasDeliverables: 1,
  });
  upsertRound(db, {
    chainId: "chain-claude", round: 1,
    startedAt: "2026-07-26T09:00:00.000Z",
    startedMs: Date.parse("2026-07-26T09:00:00.000Z"),
    backend: "claude",
    disposition: "rework",
  });
  upsertRound(db, {
    chainId: "chain-claude", round: 2,
    startedAt: "2026-07-26T09:30:00.000Z",
    startedMs: Date.parse("2026-07-26T09:30:00.000Z"),
    backend: "claude",
    disposition: "accept",
  });
  // Legacy chain: NULL backend (predates the split) — reads as "opencode".
  upsertChain(db, {
    chainId: "chain-legacy",
    orchModel: "claude-sonnet-5",
    orchDate: "2026-07-22",
    backend: null,
    totalsCost: 0.5,
    briefHasSmoke: 0,
    briefChars: 200,
    briefHasDeliverables: 1,
  });
  upsertRound(db, {
    chainId: "chain-legacy", round: 1,
    startedAt: "2026-07-22T09:00:00.000Z",
    startedMs: Date.parse("2026-07-22T09:00:00.000Z"),
    backend: null,
    disposition: "escalate",
  });
  // A claude job with measured usage.
  upsertJob(db, {
    jobId: "job-claude",
    kind: "task",
    status: "completed",
    backend: "claude",
    startedAt: "2026-07-26T10:00:00.000Z",
    startedMs: Date.parse("2026-07-26T10:00:00.000Z"),
    usageAvailable: 1,
    usageOutput: 100,
    usageCost: 0.25,
  });
  // A legacy job (NULL backend) with measured usage.
  upsertJob(db, {
    jobId: "job-legacy",
    kind: "task",
    status: "completed",
    backend: null,
    startedAt: "2026-07-22T10:00:00.000Z",
    startedMs: Date.parse("2026-07-22T10:00:00.000Z"),
    usageAvailable: 1,
    usageOutput: 50,
    usageCost: 0.75,
  });
  return db;
}

describe("by-backend split (kusabi #184 Job C)", () => {
  it("groups chains and jobs by backend, counting NULL-backend rows under 'opencode'", () => {
    const report = computeReport(buildBackendSplitFixture(), { dbPath: ":memory:" });
    const chains = Object.fromEntries(report.byBackend.chains.map((c) => [c.backend, c]));
    assert.deepEqual(Object.keys(chains).sort(), ["claude", "opencode"]);
    assert.equal(chains.claude.chainCount, 1);
    assert.deepEqual(chains.claude.dispositions, { accept: 1 });
    assert.equal(chains.claude.roundsPerChain, 2);
    assert.equal(chains.claude.costUnits, 1.0);
    assert.equal(chains.opencode.chainCount, 1); // the NULL-backend chain
    assert.deepEqual(chains.opencode.dispositions, { escalate: 1 });
    assert.equal(chains.opencode.roundsPerChain, 1);
    assert.equal(chains.opencode.costUnits, 0.5);

    const jobs = Object.fromEntries(report.byBackend.jobs.map((j) => [j.backend, j]));
    assert.deepEqual(Object.keys(jobs).sort(), ["claude", "opencode"]);
    assert.equal(jobs.claude.jobCount, 1);
    assert.equal(jobs.claude.costUnits, 0.25);
    assert.equal(jobs.opencode.jobCount, 1);
    assert.equal(jobs.opencode.costUnits, 0.75);
  });

  it("appears in the text when both backends are in the window, and is window-scoped", () => {
    const allTime = renderReportText(computeReport(buildBackendSplitFixture(), { dbPath: ":memory:" }));
    assert.match(allTime, /by dispatch backend/);
    assert.match(allTime, /opencode/);
    assert.match(allTime, /claude/);
    assert.match(allTime, /dispositions accept 1/);

    // A bound that keeps only the claude rows: single-backend window — the
    // section must not be printed at all, and the split holds only claude.
    const opts = { since: "2026-07-25T00:00:00.000Z", dbPath: ":memory:" };
    const report = computeReport(buildBackendSplitFixture(), opts);
    assert.deepEqual(report.byBackend.chains.map((c) => c.backend), ["claude"]);
    assert.deepEqual(report.byBackend.jobs.map((j) => j.backend), ["claude"]);
    const claudeOnly = renderReportText(report);
    assert.doesNotMatch(claudeOnly, /by dispatch backend/);
  });

  it("--json always carries the backend fields, even when the text omits the section", () => {
    const report = computeReport(buildBackendSplitFixture(), { dbPath: ":memory:" });
    const parsed = JSON.parse(renderReportJson(report));
    assert.deepEqual(parsed.byBackend.chains.map((c) => c.backend).sort(), ["claude", "opencode"]);
    assert.deepEqual(parsed.byBackend.jobs.map((j) => j.backend).sort(), ["claude", "opencode"]);
  });

  it("a single-backend window renders byte-identically to a report without the split", () => {
    const db = buildFixture(); // every row predates the split -> all "opencode"
    const report = computeReport(db, { dbPath: ":memory:" });
    const withSplit = renderReportText(report);
    const withoutSplit = renderReportText({ ...report, byBackend: undefined });
    assert.equal(withSplit, withoutSplit);
    assert.doesNotMatch(withSplit, /by dispatch backend/);
    // JSON still carries it, NULL-backend rows under "opencode".
    const parsed = JSON.parse(renderReportJson(report));
    assert.deepEqual(parsed.byBackend.chains.map((c) => c.backend), ["opencode"]);
    assert.deepEqual(parsed.byBackend.jobs, []);

    // kusabi #195: the same guarantee for a store that DOES carry per-phase
    // backends, as long as they all agree.  A pure-claude history (implement
    // AND review on claude, every round) is one bucket, so it too renders
    // byte-identically to a report with no split at all.
    const pure = openMetricsDb(":memory:");
    upsertChain(pure, {
      chainId: "chain-pure", orchModel: "claude-opus-5", orchDate: "2026-07-26",
      backend: "claude", totalsCost: 1.0, briefHasSmoke: 1, briefChars: 300, briefHasDeliverables: 1,
    });
    upsertRound(pure, {
      chainId: "chain-pure", round: 1,
      startedAt: "2026-07-26T09:00:00.000Z", startedMs: Date.parse("2026-07-26T09:00:00.000Z"),
      backend: "claude", reviewBackend: "claude", disposition: "accept",
    });
    const pureReport = computeReport(pure, { dbPath: ":memory:" });
    assert.deepEqual(pureReport.byBackend.chains.map((c) => c.backend), ["claude"]);
    const pureText = renderReportText(pureReport);
    assert.equal(pureText, renderReportText({ ...pureReport, byBackend: undefined }));
    assert.doesNotMatch(pureText, /by dispatch backend/);
  });

  it("a store written before the backend columns existed degrades: all rows read as 'opencode'", () => {
    const db = buildBackendSplitFixture();
    // Simulate a pre-split store file (the read-only surface can never
    // migrate): drop the backend columns the way the reader will encounter
    // them.
    db.exec("ALTER TABLE chain DROP COLUMN backend");
    db.exec("ALTER TABLE round DROP COLUMN backend");
    db.exec("ALTER TABLE round DROP COLUMN review_backend");
    db.exec("ALTER TABLE job DROP COLUMN backend");

    const report = computeReport(db, { dbPath: ":memory:" });
    assert.deepEqual(report.byBackend.chains.map((c) => c.backend), ["opencode"]);
    assert.deepEqual(report.byBackend.jobs.map((j) => j.backend), ["opencode"]);
    assert.equal(report.byBackend.chains[0].chainCount, 2);
    assert.equal(report.byBackend.jobs[0].jobCount, 2);
    const text = renderReportText(report);
    assert.doesNotMatch(text, /by dispatch backend/); // single backend -> no section
  });
});

// ---------------------------------------------------------------------------
// per-phase backend attribution (kusabi #195)
// ---------------------------------------------------------------------------

/** A window holding a phase-mixed chain (implement claude / review opencode,
 * ingested as chain.backend "mixed") alongside a pure-opencode one. */
function buildMixedBackendFixture({ chainBackend = "mixed", reviewBackend = "opencode" } = {}) {
  const db = openMetricsDb(":memory:");
  upsertChain(db, {
    chainId: "chain-mixed",
    orchModel: "claude-opus-5",
    orchDate: "2026-07-26",
    backend: chainBackend,
    totalsCost: 2.0,
    briefHasSmoke: 1,
    briefChars: 300,
    briefHasDeliverables: 1,
  });
  upsertRound(db, {
    chainId: "chain-mixed", round: 1,
    startedAt: "2026-07-26T09:00:00.000Z",
    startedMs: Date.parse("2026-07-26T09:00:00.000Z"),
    backend: "claude",
    reviewBackend,
    disposition: "accept",
  });
  upsertChain(db, {
    chainId: "chain-pure-opencode",
    orchModel: "claude-opus-5",
    orchDate: "2026-07-26",
    backend: "opencode",
    totalsCost: 0.5,
    briefHasSmoke: 1,
    briefChars: 200,
    briefHasDeliverables: 1,
  });
  upsertRound(db, {
    chainId: "chain-pure-opencode", round: 1,
    startedAt: "2026-07-26T09:10:00.000Z",
    startedMs: Date.parse("2026-07-26T09:10:00.000Z"),
    backend: "opencode",
    reviewBackend: "opencode",
    disposition: "escalate",
  });
  return db;
}

describe("per-phase backend attribution (kusabi #195)", () => {
  it("a phase-mixed chain gets its own 'mixed' bucket instead of polluting a real backend", () => {
    const report = computeReport(buildMixedBackendFixture(), { dbPath: ":memory:" });
    const chains = Object.fromEntries(report.byBackend.chains.map((c) => [c.backend, c]));
    assert.deepEqual(Object.keys(chains).sort(), ["mixed", "opencode"]);
    assert.equal(chains.mixed.chainCount, 1);
    assert.equal(chains.mixed.costUnits, 2.0);
    assert.deepEqual(chains.mixed.dispositions, { accept: 1 });
    // The mixed chain's spend and outcome are NOT counted under opencode.
    assert.equal(chains.opencode.chainCount, 1);
    assert.equal(chains.opencode.costUnits, 0.5);
    assert.deepEqual(chains.opencode.dispositions, { escalate: 1 });

    const text = renderReportText(report);
    assert.match(text, /by dispatch backend/);
    assert.match(text, /chains {2}mixed/);
  });

  it("a store ingested before #195 keeps the stored chain.backend: this read-only surface reads it verbatim", () => {
    // chain.backend says "claude" — what the pre-#195 ingest wrote (the last
    // record's implement backend) — while the round rows record review on
    // opencode.  The report deliberately does NOT re-derive mixedness from
    // round rows (mixedness is decided at ingest, where the records are in
    // hand); an old store's stale label survives until the chain directory
    // is re-ingested.  This test pins that honest degrade.
    const report = computeReport(
      buildMixedBackendFixture({ chainBackend: "claude" }),
      { dbPath: ":memory:" },
    );
    assert.deepEqual(report.byBackend.chains.map((c) => c.backend).sort(), ["claude", "opencode"]);
    const claude = report.byBackend.chains.find((c) => c.backend === "claude");
    assert.equal(claude.chainCount, 1);
    assert.equal(claude.costUnits, 2.0);
  });

  it("a chain that switched backends BETWEEN rounds is ingested as 'mixed' and bucketed there", () => {
    // The union rule at ingest (kusabi #195) labels a cross-round switch
    // "mixed"; the fixture stores exactly what ingest writes, and the
    // report reads it verbatim, so a chain that spent round 1 on opencode
    // is not counted wholly as claude.
    const db = openMetricsDb(":memory:");
    upsertChain(db, {
      chainId: "chain-switched", orchModel: "claude-opus-5", orchDate: "2026-07-26",
      backend: "mixed", totalsCost: 3.0, briefHasSmoke: 1, briefChars: 300, briefHasDeliverables: 1,
    });
    upsertRound(db, {
      chainId: "chain-switched", round: 1,
      startedAt: "2026-07-26T09:00:00.000Z", startedMs: Date.parse("2026-07-26T09:00:00.000Z"),
      backend: "opencode", reviewBackend: "opencode", disposition: "rework",
    });
    upsertRound(db, {
      chainId: "chain-switched", round: 2,
      startedAt: "2026-07-26T09:30:00.000Z", startedMs: Date.parse("2026-07-26T09:30:00.000Z"),
      backend: "claude", reviewBackend: "claude", disposition: "accept",
    });
    const report = computeReport(db, { dbPath: ":memory:" });
    assert.deepEqual(report.byBackend.chains.map((c) => c.backend), ["mixed"]);
    assert.equal(report.byBackend.chains[0].costUnits, 3.0);
  });

  it("a chain whose phases agree stays in its own backend's bucket, never 'mixed'", () => {
    const report = computeReport(
      buildMixedBackendFixture({ chainBackend: "claude", reviewBackend: "claude" }),
      { dbPath: ":memory:" },
    );
    assert.deepEqual(report.byBackend.chains.map((c) => c.backend).sort(), ["claude", "opencode"]);
  });

  it("a legacy chain with no backend facts at all is still counted under 'opencode'", () => {
    const db = openMetricsDb(":memory:");
    upsertChain(db, {
      chainId: "chain-legacy", orchModel: "claude-fable-5", orchDate: "2026-07-22",
      backend: null, totalsCost: 0.5, briefHasSmoke: 0, briefChars: 200, briefHasDeliverables: 1,
    });
    upsertRound(db, {
      chainId: "chain-legacy", round: 1,
      startedAt: "2026-07-22T09:00:00.000Z", startedMs: Date.parse("2026-07-22T09:00:00.000Z"),
      backend: null, reviewBackend: null, disposition: "accept",
    });
    const report = computeReport(db, { dbPath: ":memory:" });
    assert.deepEqual(report.byBackend.chains.map((c) => c.backend), ["opencode"]);
    assert.equal(report.byBackend.chains[0].chainCount, 1);
    assert.deepEqual(report.byBackend.chains[0].dispositions, { accept: 1 });
  });

  it("a store whose round table lacks review_backend does not throw \u2014 the report never reads that column", () => {
    const db = buildMixedBackendFixture();
    // A real pre-#195 store file: `review_backend` simply is not there, and
    // the read-only report surface can never migrate it.  Mixedness lives
    // in chain.backend (written by ingest), so the round column's absence
    // changes nothing about bucketing.
    db.exec("ALTER TABLE round DROP COLUMN review_backend");

    let report;
    assert.doesNotThrow(() => { report = computeReport(db, { dbPath: ":memory:" }); });
    // chain.backend "mixed" still buckets correctly without the round column.
    assert.deepEqual(report.byBackend.chains.map((c) => c.backend).sort(), ["mixed", "opencode"]);
    assert.doesNotThrow(() => renderReportText(report));
    assert.doesNotThrow(() => renderReportJson(report));
  });
});

describe("freshness label", () => {
  it("renders 'newest ingested turn' (MAX(turn.ts) includes cursor samples)", () => {
    const db = openMetricsDb(":memory:");
    const text = renderReportText(computeReport(db, { dbPath: ":memory:" }));
    assert.match(text, /newest ingested turn:/);
    assert.doesNotMatch(text, /newest transcript turn:/);
  });
});

// The section this replaces printed `sampled / total_output_tokens` as a
// "coverage" percentage with a `!` outlier flag.  kusabi #253 retired the
// ratio (the denominator is window occupancy, not a cumulative counter), so
// these tests assert the two values are reported side by side and that no
// ratio or flag comes back.
describe("Cursor sampled output and window output occupancy", () => {
  it("omits the section (and the JSON key) when the counter table is empty", () => {
    const db = buildFixture();
    const report = computeReport(db, { dbPath: ":memory:" });
    assert.equal(report.cursorSampledOutput, undefined);
    const text = renderReportText(report);
    assert.doesNotMatch(text, /Cursor sampled output/);
    const parsed = JSON.parse(renderReportJson(report));
    assert.equal("cursorSampledOutput" in parsed, false);
  });

  it("omits the section on a store whose counter table does not exist", () => {
    const db = buildFixture();
    db.exec("DROP TABLE cursor_session_counter");
    const report = computeReport(db, { dbPath: ":memory:" });
    assert.equal(report.cursorSampledOutput, undefined);
    assert.doesNotMatch(renderReportText(report), /Cursor sampled output/);
  });

  it("reports sampled output and window occupancy as plain values, with no ratio and no flag", () => {
    const db = openMetricsDb(":memory:");
    const sessionId = "d73008ab-1111-2222-3333-444444444444";
    upsertSession(db, {
      sessionId,
      firstTs: "2026-08-14T10:00:10.000Z",
      firstTsMs: Date.parse("2026-08-14T10:00:10.000Z"),
    });
    upsertTurn(db, {
      requestId: `cursor:${sessionId}#1`,
      sessionId,
      ts: "2026-08-14T10:00:10.000Z",
      tsMs: Date.parse("2026-08-14T10:00:10.000Z"),
      output: 20,
      isSidechain: 0,
      isSynthetic: 0,
    });
    upsertTurn(db, {
      requestId: `cursor:${sessionId}#2`,
      sessionId,
      ts: "2026-08-14T10:00:20.000Z",
      tsMs: Date.parse("2026-08-14T10:00:20.000Z"),
      output: 30,
      isSidechain: 0,
      isSynthetic: 0,
    });
    upsertCursorSessionCounter(db, {
      sessionId,
      totalOutputTokens: 80,
      ts: "2026-08-14T10:00:20.000Z",
    });

    const report = computeReport(db, { dbPath: ":memory:" });
    assert.ok(report.cursorSampledOutput);
    assert.equal(report.cursorSampledOutput.sampledOutput, 50);
    assert.equal(report.cursorSampledOutput.windowOutput, 80);
    // The retired ratio and flag must not come back in any shape.
    assert.equal("coveragePct" in report.cursorSampledOutput, false);
    assert.equal("anomaly" in report.cursorSampledOutput, false);
    assert.equal(report.cursorSampledOutput.sessions.length, 1);
    assert.equal(report.cursorSampledOutput.sessions[0].sessionIdShort, "d73008ab...");
    assert.equal(report.cursorSampledOutput.sessions[0].sampledOutput, 50);
    assert.equal(report.cursorSampledOutput.sessions[0].windowOutput, 80);
    assert.equal("coveragePct" in report.cursorSampledOutput.sessions[0], false);
    assert.equal("anomaly" in report.cursorSampledOutput.sessions[0], false);

    const text = renderReportText(report);
    assert.match(text, /Cursor sampled output and window output occupancy:/);
    assert.match(text, /sampled output 50 {2}latest window output occupancy 80/);
    assert.match(text, /d73008ab\.\.\. {2}sampled 50 {2}window occupancy 80/);
    const cursorSection = text.slice(text.indexOf("Cursor sampled output"));
    assert.doesNotMatch(cursorSection, /%/);
    assert.doesNotMatch(cursorSection, /!/);
    assert.doesNotMatch(cursorSection, /coverage/i);
    assert.doesNotMatch(cursorSection, /reported cumulative/i);
    // The non-cumulative caveat is the whole reason both numbers are shown.
    assert.match(cursorSection, /NOT a cumulative session total/);
    assert.match(cursorSection, /compaction/);
  });

  it("prints both numbers unflagged when window occupancy is below the sampled sum", () => {
    // Not an anomaly any more: occupancy drops on compaction while the
    // sampled sum only grows, so sampled > occupancy is the expected shape
    // of a long session, not a defect to flag.
    const db = openMetricsDb(":memory:");
    const sessionId = "sess-below-1";
    upsertSession(db, {
      sessionId,
      firstTs: "2026-08-14T10:00:00.000Z",
      firstTsMs: Date.parse("2026-08-14T10:00:00.000Z"),
    });
    upsertTurn(db, {
      requestId: `cursor:${sessionId}#1`,
      sessionId,
      ts: "2026-08-14T10:00:00.000Z",
      tsMs: Date.parse("2026-08-14T10:00:00.000Z"),
      output: 90,
      isSidechain: 0,
      isSynthetic: 0,
    });
    upsertCursorSessionCounter(db, {
      sessionId,
      totalOutputTokens: 80,
      ts: "2026-08-14T10:00:00.000Z",
    });

    const report = computeReport(db, { dbPath: ":memory:" });
    assert.equal(report.cursorSampledOutput.sampledOutput, 90);
    assert.equal(report.cursorSampledOutput.windowOutput, 80);
    const text = renderReportText(report);
    const cursorSection = text.slice(text.indexOf("Cursor sampled output"));
    assert.match(cursorSection, /sess-bel\.\.\. {2}sampled 90 {2}window occupancy 80/);
    assert.doesNotMatch(cursorSection, /!/);
    assert.doesNotMatch(cursorSection, /%/);
  });

  it("renders n/a for a session whose window occupancy reading is absent", () => {
    const db = openMetricsDb(":memory:");
    const sessionId = "sess-null-window";
    upsertTurn(db, {
      requestId: `cursor:${sessionId}#1`,
      sessionId,
      ts: "2026-08-14T10:00:00.000Z",
      tsMs: Date.parse("2026-08-14T10:00:00.000Z"),
      output: 25,
      isSidechain: 0,
      isSynthetic: 0,
    });
    upsertCursorSessionCounter(db, {
      sessionId,
      totalOutputTokens: null,
      ts: "2026-08-14T10:00:00.000Z",
    });
    const report = computeReport(db, { dbPath: ":memory:" });
    assert.equal(report.cursorSampledOutput.sessions[0].windowOutput, null);
    assert.match(renderReportText(report), /sess-nul\.\.\. {2}sampled 25 {2}window occupancy n\/a/);
  });

  it("does not count non-cursor turns in sampled output", () => {
    const db = openMetricsDb(":memory:");
    const sessionId = "cursor-sess";
    upsertTurn(db, {
      requestId: "claude-req-1",
      sessionId: "claude-sess",
      ts: "2026-08-14T10:00:00.000Z",
      tsMs: Date.parse("2026-08-14T10:00:00.000Z"),
      output: 1000,
      isSidechain: 0,
      isSynthetic: 0,
    });
    upsertTurn(db, {
      requestId: `cursor:${sessionId}#1`,
      sessionId,
      ts: "2026-08-14T10:00:00.000Z",
      tsMs: Date.parse("2026-08-14T10:00:00.000Z"),
      output: 10,
      isSidechain: 0,
      isSynthetic: 0,
    });
    upsertCursorSessionCounter(db, {
      sessionId,
      totalOutputTokens: 40,
      ts: "2026-08-14T10:00:00.000Z",
    });
    const report = computeReport(db, { dbPath: ":memory:" });
    assert.equal(report.cursorSampledOutput.sampledOutput, 10);
    assert.equal(report.cursorSampledOutput.windowOutput, 40);
  });
});

describe("Brief-metrics strata — orch_model key normalisation (kusabi #252)", () => {
  function chainSignedAs(db, chainId, orchModel) {
    upsertChain(db, {
      chainId,
      orchModel,
      orchSession: null,
      orchDate: "2026-08-14",
      briefHasSmoke: 1,
      briefChars: 400,
      briefHasDeliverables: 1,
    });
    upsertRound(db, {
      chainId,
      round: 1,
      startedAt: "2026-08-14T10:00:00.000Z",
      startedMs: Date.parse("2026-08-14T10:00:00.000Z"),
      disposition: "accept",
    });
  }

  it("merges display-name and model-id signatures of one orchestrator into a single stratum", () => {
    const db = openMetricsDb(":memory:");
    chainSignedAs(db, "chain-grok-a", "cursor-grok-4.6");
    chainSignedAs(db, "chain-grok-b", "cursor-grok-4.6");
    chainSignedAs(db, "chain-grok-c", "Cursor Grok 4.6");
    chainSignedAs(db, "chain-fable", "claude-fable-5");

    const report = computeReport(db, { dbPath: ":memory:" });
    assert.deepEqual(
      report.briefOutcome.map((b) => b.orchModel).sort(),
      ["claude-fable-5", "cursor-grok-4.6"],
    );
    const grok = report.briefOutcome.find((b) => b.orchModel === "cursor-grok-4.6");
    assert.equal(grok.chainCount, 3);
    const fable = report.briefOutcome.find((b) => b.orchModel === "claude-fable-5");
    assert.equal(fable.chainCount, 1);

    // Stored values stay verbatim -- only the stratification key is folded.
    assert.deepEqual(
      db.prepare("SELECT orch_model FROM chain ORDER BY chain_id").all().map((r) => r.orch_model),
      ["claude-fable-5", "cursor-grok-4.6", "cursor-grok-4.6", "Cursor Grok 4.6"],
    );
  });

  it("keeps a chain with no orch_model in the (unknown) bucket", () => {
    const db = openMetricsDb(":memory:");
    chainSignedAs(db, "chain-null-model", null);
    const report = computeReport(db, { dbPath: ":memory:" });
    assert.deepEqual(report.briefOutcome.map((b) => b.orchModel), ["(unknown)"]);
  });
});
// ---------------------------------------------------------------------------
// Round-level review sections (kusabi #235) — the escalate review axis, the
// disposition x severity table, and the review-output pathology rate.
// ---------------------------------------------------------------------------

/**
 * A store exercising all three round-level review sections.  One chain of 8
 * escalated rounds carries the verdict spread; three single-round chains
 * carry the other dispositions.  All rounds share one chain-date so the
 * window key never interferes with the assertions:
 *
 *  - rv-esc rounds 1-2: discard, probes red, verdict_source "probe" (P3
 *    empty-change-set discards — review never dispatched)
 *  - rv-esc round 3:    discard, probes red, no verdict_source (unknown)
 *  - rv-esc round 4:    unparseable, probes green, "recovered-from-token"
 *  - rv-esc round 5:    partial, probes green, no verdict_source (unknown)
 *  - rv-esc round 6:    needs-attention, probes red, "recovered-from-token",
 *                       findings low x1 / medium x2
 *  - rv-esc round 7:    needs-attention, probes green, no verdict_source
 *  - rv-esc round 8:    mystery-verdict, probes NULL, no verdict_source
 *  - rv-followup:       accept-with-followup / approve, findings low x2 /
 *                       medium x1 / urgent x1
 *  - rv-rework:         rework / needs-attention, "recovered-from-token",
 *                       findings low x1 / high x1 / critical x1 / NULL severity x1
 *  - rv-noverdict:      accept, verdict NULL — not review output
 *  - rv-old (optional): escalate / unparseable / probes red, dated 2026-07-20
 *                       — for window-scoping tests
 *  - rv-esc round 9 (optional, withOtherSource): escalate /
 *                       needs-attention / probes green, verdict_source
 *                       "some-future-source" — an unrecognized non-NULL
 *                       source: NOT review output, its own "other" bucket
 */
function buildRoundReviewFixture({ withOldChain = false, withOtherSource = false } = {}) {
  const db = openMetricsDb(":memory:");
  const chain = (id) => upsertChain(db, {
    chainId: id,
    orchModel: "claude-opus-5",
    orchSession: null,
    orchDate: "2026-07-26",
    briefHasSmoke: 1,
    briefChars: 300,
    briefHasDeliverables: 1,
  });
  const round = (id, n, f, findings = []) => {
    upsertRound(db, {
      chainId: id,
      round: n,
      startedAt: "2026-07-26T09:00:00.000Z",
      startedMs: Date.parse("2026-07-26T09:00:00.000Z"),
      ...f,
    });
    findings.forEach((sev, idx) => db.prepare(
      "INSERT INTO finding (chain_id, round, idx, severity, title, file) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, n, idx, sev, `finding ${idx}`, "src/a.mjs"));
  };

  chain("rv-esc");
  round("rv-esc", 1, { disposition: "escalate", verdict: "discard", probesGreen: 0, verdictSource: "probe" });
  round("rv-esc", 2, { disposition: "escalate", verdict: "discard", probesGreen: 0, verdictSource: "probe" });
  round("rv-esc", 3, { disposition: "escalate", verdict: "discard", probesGreen: 0, verdictSource: null });
  round("rv-esc", 4, { disposition: "escalate", verdict: "unparseable", probesGreen: 1, verdictSource: "recovered-from-token" });
  round("rv-esc", 5, { disposition: "escalate", verdict: "partial", probesGreen: 1, verdictSource: null });
  round("rv-esc", 6, { disposition: "escalate", verdict: "needs-attention", probesGreen: 0, verdictSource: "recovered-from-token" }, ["low", "medium", "medium"]);
  round("rv-esc", 7, { disposition: "escalate", verdict: "needs-attention", probesGreen: 1, verdictSource: null });
  round("rv-esc", 8, { disposition: "escalate", verdict: "mystery-verdict", probesGreen: null, verdictSource: null });

  chain("rv-followup");
  round("rv-followup", 1, { disposition: "accept-with-followup", verdict: "approve", probesGreen: 1, verdictSource: null }, ["low", "low", "medium", "urgent"]);

  chain("rv-rework");
  round("rv-rework", 1, { disposition: "rework", verdict: "needs-attention", probesGreen: 0, verdictSource: "recovered-from-token" }, ["low", "high", "critical", null]);

  chain("rv-noverdict");
  round("rv-noverdict", 1, { disposition: "accept", verdict: null, probesGreen: null, verdictSource: null });

  if (withOldChain) {
    chain("rv-old");
    round("rv-old", 1, {
      startedAt: "2026-07-20T09:00:00.000Z",
      startedMs: Date.parse("2026-07-20T09:00:00.000Z"),
      disposition: "escalate",
      verdict: "unparseable",
      probesGreen: 0,
      verdictSource: null,
    });
  }

  if (withOtherSource) {
    // An unrecognized NON-NULL verdict_source — a future value that passes
    // through ingest verbatim.  At the report surface it is NOT known to be
    // review output: the axis must bucket it as "other" (raw value kept)
    // and section C must exclude it from both sides, never silently count
    // it as review-issued.
    round("rv-esc", 9, { disposition: "escalate", verdict: "needs-attention", probesGreen: 1, verdictSource: "some-future-source" });
  }

  return db;
}

describe("escalate review axis (kusabi #235)", () => {
  it("counts escalated rounds only, splitting per-verdict probes and source", () => {
    const db = buildRoundReviewFixture();
    const axis = computeReport(db, { dbPath: ":memory:" }).escalateReviewAxis;
    assert.equal(axis.escalateRounds, 8);
    // Probes all green: rounds 4, 5, 7 — round 8's NULL probes is NOT green.
    assert.equal(axis.allGreenEscalate, 3);
    assert.equal(axis.verdictSourceAvailable, true);
    const byVerdict = Object.fromEntries(axis.byVerdict.map((r) => [r.verdict, r]));
    assert.deepEqual(Object.keys(byVerdict).sort(), ["discard", "mystery-verdict", "needs-attention", "partial", "unparseable"]);
    // discard: 3 rounds, 2 probe-issued + 1 unknown source, all red probes.
    assert.deepEqual(byVerdict.discard.probesGreen, { green: 0, red: 3, unknown: 0 });
    assert.deepEqual(byVerdict.discard.source, { review: 0, probe: 2, unknown: 1, other: 0 });
    // recovered-from-token is review-issued — never folded into unknown.
    assert.deepEqual(byVerdict.unparseable.source, { review: 1, probe: 0, unknown: 0, other: 0 });
    assert.deepEqual(byVerdict["needs-attention"].source, { review: 1, probe: 0, unknown: 1, other: 0 });
    // NULL probes is its own bucket, never red.
    assert.deepEqual(byVerdict["mystery-verdict"].probesGreen, { green: 0, red: 0, unknown: 1 });
    assert.deepEqual(byVerdict["mystery-verdict"].source, { review: 0, probe: 0, unknown: 1, other: 0 });
  });

  it("renders the axis with the ROUND-level label and the aligned columns", () => {
    const db = buildRoundReviewFixture();
    const text = renderReportText(computeReport(db, { dbPath: ":memory:" }));
    assert.match(text, /Escalate review axis \(ROUND-level/);
    assert.match(text, /escalated rounds: 8  \|  all-green escalate \(probes all green\): 3/);
    assert.match(text, /verdict_source recorded: review-issued \/ probe-issued \/ unknown-source split/);
  });
});

describe("disposition x severity (kusabi #235)", () => {
  it("counts rounds and findings per disposition; known-severity zeros are real counts", () => {
    const db = buildRoundReviewFixture();
    const rows = computeReport(db, { dbPath: ":memory:" }).dispositionSeverity;
    const byDisp = Object.fromEntries(rows.map((r) => [r.disposition, r]));
    assert.deepEqual(Object.keys(byDisp).sort(), ["accept", "accept-with-followup", "escalate", "rework"]);
    // A round with no findings still gets the zero columns — the complement
    // (no high/critical on accept-with-followup) is the signal.
    assert.deepEqual(byDisp.accept.severities, { low: 0, medium: 0, high: 0, critical: 0 });
    assert.equal(byDisp.accept.findings, 0);
    assert.deepEqual(byDisp["accept-with-followup"].severities, { low: 2, medium: 1, high: 0, critical: 0, urgent: 1 });
    // NULL severity is its own "(no severity)" bucket, never folded away.
    assert.deepEqual(byDisp.rework.severities, { low: 1, medium: 0, high: 1, critical: 1, "(no severity)": 1 });
    assert.equal(byDisp.rework.findings, 4);
    assert.equal(byDisp.escalate.rounds, 8);
    assert.equal(byDisp.escalate.findings, 3); // only round 6 carries findings
  });

  it("renders the table with every severity column separated", () => {
    const db = buildRoundReviewFixture();
    const text = renderReportText(computeReport(db, { dbPath: ":memory:" }));
    assert.match(text, /Disposition × severity \(ROUND-level/);
    // Unknown severities sort between the knowns and the "(no severity)"
    // bucket, and the 12-char column name must not abut its neighbours.
    assert.match(text, /critical\s+urgent\s+\(no severity\)/);
    // "(no severity)" is the last column — nothing may follow it on the line
    // (literal space: \s would match the line's trailing newline).
    assert.doesNotMatch(text, /\(no severity\) \S/);
  });
});

describe("review-output pathology rate (kusabi #235)", () => {
  it("counts unparseable/partial among review-issued-or-unknown-source verdict rounds only", () => {
    const db = buildRoundReviewFixture();
    const path = computeReport(db, { dbPath: ":memory:" }).reviewPathology;
    assert.equal(path.pathologyCount, 2); // unparseable (r4) + partial (r5)
    // Denominator: 6 escalate non-probe rounds + approve + needs-attention =
    // 8.  The two probe-issued discards are excluded from BOTH sides; the
    // NULL-verdict accept round is not review output at all.
    assert.equal(path.denominator, 8);
    assert.equal(path.pct, 25);
    assert.equal(path.probeIssued, 2);
    assert.equal(path.verdictSourceAvailable, true);
  });

  it("renders the ratio, the probe exclusion, and the caveat", () => {
    const db = buildRoundReviewFixture();
    const text = renderReportText(computeReport(db, { dbPath: ":memory:" }));
    assert.match(text, /Review-output pathology rate \(ROUND-level/);
    assert.match(text, /2 of 8 review-issued-or-unknown-source verdict rounds \(25%\)/);
    assert.match(text, /probe-issued verdicts excluded: 2 \(discard written by the P3 empty-change-set path/);
    assert.match(text, /probe-issued verdicts \(P3 empty-change-set discards, review never dispatched\) are excluded from both sides/);
    assert.match(text, /no better\/worse-over-time claim/);
  });

  it("a store without the verdict_source column treats every source as unknown", () => {
    const db = buildRoundReviewFixture();
    db.exec("ALTER TABLE round DROP COLUMN verdict_source");
    const report = computeReport(db, { dbPath: ":memory:" });
    const path = report.reviewPathology;
    assert.equal(path.verdictSourceAvailable, false);
    assert.equal(path.probeIssued, 0); // indistinguishable — never guessed
    assert.equal(path.denominator, 10); // all 11 rounds minus the NULL-verdict accept
    assert.equal(path.pathologyCount, 2);
    assert.equal(path.pct, 20);
    // Same store, the axis: every source bucket is unknown, no crash.
    const axis = report.escalateReviewAxis;
    assert.equal(axis.verdictSourceAvailable, false);
    assert.equal(axis.byVerdict.find((r) => r.verdict === "discard").source.unknown, 3);
  });
});

describe("round-level section scoping (kusabi #235)", () => {
  it("sections are window-scoped by CHAIN: an out-of-window chain contributes nothing", () => {
    const db = buildRoundReviewFixture({ withOldChain: true });
    // rv-old (2026-07-20) falls outside the window; everything else is in.
    const report = computeReport(db, { since: "2026-07-25T00:00:00.000Z", dbPath: ":memory:" });
    assert.equal(report.status, "ok");
    assert.equal(report.escalateReviewAxis.escalateRounds, 8);
    assert.equal(report.reviewPathology.denominator, 8);
    assert.equal(report.reviewPathology.pathologyCount, 2);

    // Unbounded: the old chain joins in.
    const all = computeReport(db, { dbPath: ":memory:" });
    assert.equal(all.escalateReviewAxis.escalateRounds, 9);
    assert.equal(all.reviewPathology.denominator, 9);
    assert.equal(all.reviewPathology.pathologyCount, 3);
    assert.ok(Math.abs(all.reviewPathology.pct - (100 / 3)) < 0.001);
  });

  it("a window that excludes every chain yields empty sections, not errors", () => {
    const db = buildRoundReviewFixture();
    const report = computeReport(db, { since: "2099-01-01T00:00:00.000Z", dbPath: ":memory:" });
    assert.equal(report.status, "empty_window");
    assert.equal(report.escalateReviewAxis.escalateRounds, 0);
    assert.deepEqual(report.escalateReviewAxis.byVerdict, []);
    assert.deepEqual(report.dispositionSeverity, []);
    assert.equal(report.reviewPathology.denominator, 0);
    assert.equal(report.reviewPathology.pct, null);
    const text = renderReportText(report);
    assert.match(text, /\(no escalated rounds in window\)/);
    assert.match(text, /\(no rounds in window\)/);
    assert.match(text, /\(no review-issued or unknown-source verdict rounds in window\)/);
  });

  it("the sections render between the brief-outcome block and the delegated-jobs section", () => {
    const db = buildRoundReviewFixture();
    const text = renderReportText(computeReport(db, { dbPath: ":memory:" }));
    const brief = text.indexOf("Brief metrics vs outcome");
    const axis = text.indexOf("Escalate review axis");
    const pathology = text.indexOf("Review-output pathology rate");
    const jobs = text.indexOf("Delegated jobs");
    assert.ok(brief !== -1 && axis !== -1 && pathology !== -1 && jobs !== -1);
    assert.ok(brief < axis && axis < pathology && pathology < jobs);
  });

  it("the JSON document carries the three sections", () => {
    const db = buildRoundReviewFixture();
    const parsed = JSON.parse(renderReportJson(computeReport(db, { dbPath: ":memory:" })));
    assert.equal(parsed.escalateReviewAxis.escalateRounds, 8);
    assert.equal(parsed.reviewPathology.pct, 25);
    assert.equal(parsed.dispositionSeverity.length, 4);
  });
});

// ---------------------------------------------------------------------------
// Unrecognized non-NULL verdict_source values (kusabi #235 follow-up) — the
// ingest pass-through discipline ("an unknown future value survives
// verbatim") must not be defeated at the report surface: such a round is
// NOT known to be review output, so it gets its own "other" bucket in the
// axis (raw value rendered) and is excluded from BOTH sides of the
// pathology ratio (counted for disclosure), exactly like probe-issued.
// ---------------------------------------------------------------------------

describe("unrecognized verdict_source values (kusabi #235 follow-up)", () => {
  it("the axis buckets an unrecognized source as 'other', never as review, keeping the raw value", () => {
    const db = buildRoundReviewFixture({ withOtherSource: true });
    const axis = computeReport(db, { dbPath: ":memory:" }).escalateReviewAxis;
    assert.equal(axis.escalateRounds, 9);
    assert.equal(axis.allGreenEscalate, 4); // rounds 4, 5, 7 + round 9 (probes green)
    const na = axis.byVerdict.find((r) => r.verdict === "needs-attention");
    // review: round 6 (recovered-from-token); unknown: round 7 (NULL
    // source); other: round 9 ("some-future-source") — NOT folded into
    // review, NOT folded into unknown.
    assert.deepEqual(na.source, { review: 1, probe: 0, unknown: 1, other: 1 });
    assert.deepEqual(na.otherValues, ["some-future-source"]);
    // Rows that never see an unrecognized source keep an empty list.
    assert.deepEqual(axis.byVerdict.find((r) => r.verdict === "discard").otherValues, []);
  });

  it("section C excludes unrecognized-source rounds from both sides and reports the count verbatim", () => {
    const db = buildRoundReviewFixture({ withOtherSource: true });
    const path = computeReport(db, { dbPath: ":memory:" }).reviewPathology;
    // Round 9 is not review output: denominator unchanged from the base
    // fixture (8), pathology count unchanged (2), pct unchanged (25) — but
    // the exclusion is disclosed, never silent.
    assert.equal(path.otherIssued, 1);
    assert.deepEqual(path.otherValues, ["some-future-source"]);
    assert.equal(path.denominator, 8);
    assert.equal(path.pathologyCount, 2);
    assert.equal(path.pct, 25);
    assert.equal(path.probeIssued, 2);
    assert.equal(path.verdictSourceAvailable, true);
  });

  it("renders the other-source footnote and the exclusion line; the base fixture shows neither", () => {
    const db = buildRoundReviewFixture({ withOtherSource: true });
    const text = renderReportText(computeReport(db, { dbPath: ":memory:" }));
    assert.match(text, /needs-attention: other-source values verbatim: "some-future-source"/);
    assert.match(text, /unrecognized verdict_source values excluded: 1 \("some-future-source" — not known to be review output\)/);
    const baseText = renderReportText(computeReport(buildRoundReviewFixture(), { dbPath: ":memory:" }));
    assert.doesNotMatch(baseText, /other-source values verbatim/);
    assert.doesNotMatch(baseText, /unrecognized verdict_source values excluded/);
  });

  it("a legacy store (no column) never produces an 'other' bucket — every source reads unknown", () => {
    const db = buildRoundReviewFixture({ withOtherSource: true });
    db.exec("ALTER TABLE round DROP COLUMN verdict_source");
    const report = computeReport(db, { dbPath: ":memory:" });
    const na = report.escalateReviewAxis.byVerdict.find((r) => r.verdict === "needs-attention");
    // 3 needs-attention rounds: round 6 (recovered-from-token) and round 9
    // (some-future-source) are indistinguishable from round 7 (NULL) once
    // the column is gone — all unknown, nothing "other".
    assert.deepEqual(na.source, { review: 0, probe: 0, unknown: 3, other: 0 });
    assert.deepEqual(na.otherValues, []);
    const path = report.reviewPathology;
    assert.equal(path.otherIssued, 0);
    assert.deepEqual(path.otherValues, []);
    assert.equal(path.denominator, 11); // 12 rounds - 1 NULL-verdict accept
    assert.equal(path.pathologyCount, 2);
    assert.equal(path.verdictSourceAvailable, false);
  });
});

// ---------------------------------------------------------------------------
// Tool-stats coverage: opencode SSE only (kusabi #384)
// ---------------------------------------------------------------------------

const TOOL_JOB_TS = "2026-08-01T10:00:00.000Z";
const TOOL_JOB_MS = Date.parse(TOOL_JOB_TS);

function seedTimedJob(db, row) {
  upsertJob(db, {
    startedAt: TOOL_JOB_TS,
    startedMs: TOOL_JOB_MS,
    ...row,
  });
}

describe("tool-stats coverage — opencode SSE only (kusabi #384)", () => {
  it("a mixed window reports the opencode job's tools only and excludes the cursor failed job", () => {
    const db = openMetricsDb(":memory:");
    seedTimedJob(db, {
      jobId: "job-opencode",
      backend: "opencode",
      status: "completed",
      stopReason: "completed",
    });
    replaceToolStatsForJob(db, "job-opencode", {
      bash: { count: 4, success: 4, failure: 0 },
    });
    seedTimedJob(db, {
      jobId: "job-cursor",
      backend: "cursor",
      status: "error",
      stopReason: "error",
      startedAt: "2026-08-01T11:00:00.000Z",
      startedMs: Date.parse("2026-08-01T11:00:00.000Z"),
    });
    // Coverage is job.backend, never inferred from tool_stat: leftover rows
    // on a cursor job must not enter either total.
    replaceToolStatsForJob(db, "job-cursor", {
      bash: { count: 9, success: 0, failure: 9 },
      edit: { count: 1, success: 0, failure: 1 },
    });

    const report = computeReport(db, { dbPath: ":memory:" });
    assert.equal(report.toolStats.coverage.backend, "opencode");
    assert.equal(report.toolStats.coverage.excludedJobCount, 1);
    assert.equal(report.toolStats.coverage.coveredJobCount, 1);
    assert.equal(report.toolStats.all.bash.count, 4);
    assert.equal(report.toolStats.all.edit.count, 0);
    // Cursor failed job is absent from failed-jobs totals (its 9 bash / 1 edit
    // do not appear; the opencode job did not fail).
    assert.equal(report.toolStats.failedJobs.bash.count, 0);
    assert.equal(report.toolStats.failedJobs.edit.count, 0);

    const text = renderReportText(report);
    assert.match(text, /Tool usage \(all jobs in window\): opencode \(SSE events\) only/);
    assert.match(text, /Tool usage \(failed jobs only\): opencode \(SSE events\) only/);
    assert.match(text, /coverage: opencode jobs only; 1 job on other backends excluded/);
    assert.match(text, /bash  count 4  success 4  failure 0/);
    assert.doesNotMatch(text, /no covered jobs in this window/);
  });

  it("an all-cursor window prints the coverage line and no covered jobs, not a zero-filled table", () => {
    const db = openMetricsDb(":memory:");
    seedTimedJob(db, {
      jobId: "job-cursor",
      backend: "cursor",
      status: "error",
      stopReason: "error",
    });
    const report = computeReport(db, { dbPath: ":memory:" });
    assert.equal(report.toolStats.coverage.backend, "opencode");
    assert.equal(report.toolStats.coverage.excludedJobCount, 1);
    assert.equal(report.toolStats.coverage.coveredJobCount, 0);
    assert.equal(report.toolStats.all.bash.count, 0);

    const text = renderReportText(report);
    assert.match(text, /coverage: opencode jobs only; 1 job on other backends excluded/);
    assert.match(text, /no covered jobs in this window/);
    assert.doesNotMatch(text, /  count 0  success 0  failure 0/);
  });

  it("NULL-backend rows are excluded and counted as excluded, never shown as no tools used", () => {
    const db = openMetricsDb(":memory:");
    seedTimedJob(db, {
      jobId: "job-opencode",
      backend: "opencode",
      status: "completed",
      stopReason: "completed",
    });
    replaceToolStatsForJob(db, "job-opencode", {
      bash: { count: 2, success: 2, failure: 0 },
    });
    seedTimedJob(db, {
      jobId: "job-null",
      backend: null,
      status: "error",
      stopReason: "error",
      startedAt: "2026-08-01T11:00:00.000Z",
      startedMs: Date.parse("2026-08-01T11:00:00.000Z"),
    });
    replaceToolStatsForJob(db, "job-null", {
      bash: { count: 7, success: 0, failure: 7 },
    });

    const report = computeReport(db, { dbPath: ":memory:" });
    assert.equal(report.toolStats.coverage.excludedJobCount, 1);
    assert.equal(report.toolStats.coverage.coveredJobCount, 1);
    assert.equal(report.toolStats.all.bash.count, 2);
    assert.equal(report.toolStats.failedJobs.bash.count, 0);

    const text = renderReportText(report);
    assert.match(text, /coverage: opencode jobs only; 1 job on other backends excluded/);
    assert.match(text, /bash  count 2  success 2  failure 0/);
    assert.doesNotMatch(text, /bash  count 7/);
  });

  it("an omitted backend (upsert default NULL) is excluded the same as an explicit NULL", () => {
    const db = openMetricsDb(":memory:");
    seedTimedJob(db, {
      jobId: "job-omitted",
      status: "error",
      stopReason: "error",
    });
    replaceToolStatsForJob(db, "job-omitted", {
      bash: { count: 3, success: 0, failure: 3 },
    });
    const report = computeReport(db, { dbPath: ":memory:" });
    assert.equal(report.toolStats.coverage.excludedJobCount, 1);
    assert.equal(report.toolStats.coverage.coveredJobCount, 0);
    assert.equal(report.toolStats.all.bash.count, 0);
    assert.equal(report.toolStats.failedJobs.bash.count, 0);
    const text = renderReportText(report);
    assert.match(text, /no covered jobs in this window/);
    assert.doesNotMatch(text, /  count 0  success 0  failure 0/);
  });

  it("--json carries the same coverage facts", () => {
    const db = openMetricsDb(":memory:");
    seedTimedJob(db, {
      jobId: "job-opencode",
      backend: "opencode",
      status: "completed",
      stopReason: "completed",
    });
    replaceToolStatsForJob(db, "job-opencode", {
      bash: { count: 1, success: 1, failure: 0 },
    });
    seedTimedJob(db, {
      jobId: "job-agy",
      backend: "agy",
      status: "error",
      stopReason: "error",
      startedAt: "2026-08-01T11:00:00.000Z",
      startedMs: Date.parse("2026-08-01T11:00:00.000Z"),
    });
    const parsed = JSON.parse(renderReportJson(computeReport(db, { dbPath: ":memory:" })));
    assert.equal(parsed.toolStats.coverage.backend, "opencode");
    assert.equal(parsed.toolStats.coverage.excludedJobCount, 1);
    assert.equal(parsed.toolStats.coverage.coveredJobCount, 1);
    assert.equal(parsed.toolStats.all.bash.count, 1);
  });
});
