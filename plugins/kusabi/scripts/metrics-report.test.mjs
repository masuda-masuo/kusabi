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
  });

  it("a store written before the backend columns existed degrades: all rows read as 'opencode'", () => {
    const db = buildBackendSplitFixture();
    // Simulate a pre-split store file (the read-only surface can never
    // migrate): drop the backend columns the way the reader will encounter
    // them.
    db.exec("ALTER TABLE chain DROP COLUMN backend");
    db.exec("ALTER TABLE round DROP COLUMN backend");
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
