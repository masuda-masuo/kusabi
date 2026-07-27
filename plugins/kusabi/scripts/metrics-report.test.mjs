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
    assert.match(text, /Store is empty \(0 sessions, 0 turns, 0 chains\)\./);
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
