// metrics-db.test.mjs — Unit tests for metrics-db.mjs
//
// Covers schema creation, every upsert helper, the source_file
// skip-cache predicate, and the core idempotency guarantee: re-running
// INSERT OR REPLACE on the same primary key never changes the row count.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  openMetricsDb,
  upsertSourceFile,
  getSourceFile,
  isSourceFileUnchanged,
  upsertSession,
  getSession,
  upsertTurn,
  upsertChain,
  upsertRound,
  upsertFinding,
  upsertJob,
  countRows,
} from "./metrics-db.mjs";

describe("openMetricsDb", () => {
  it("creates all tables on an in-memory database", () => {
    const db = openMetricsDb(":memory:");
    for (const table of ["source_file", "session", "turn", "chain", "round", "finding", "job"]) {
      assert.equal(countRows(db, table), 0, `expected empty ${table}`);
    }
  });

  it("is safe to call twice against the same path (CREATE TABLE IF NOT EXISTS)", () => {
    const db = openMetricsDb(":memory:");
    assert.doesNotThrow(() => {
      db.exec("CREATE TABLE IF NOT EXISTS source_file (path TEXT PRIMARY KEY, size INTEGER, mtime_ms REAL, ingested_at TEXT)");
    });
  });
});

describe("source_file — skip-unchanged bookkeeping", () => {
  it("reports unchanged only when both size and mtime match", () => {
    const db = openMetricsDb(":memory:");
    upsertSourceFile(db, { path: "/a.jsonl", size: 100, mtimeMs: 12345.6, ingestedAt: "2026-07-26T00:00:00.000Z" });

    assert.equal(isSourceFileUnchanged(db, "/a.jsonl", 100, 12345.6), true);
    assert.equal(isSourceFileUnchanged(db, "/a.jsonl", 101, 12345.6), false);
    assert.equal(isSourceFileUnchanged(db, "/a.jsonl", 100, 99999), false);
    assert.equal(isSourceFileUnchanged(db, "/never-seen.jsonl", 100, 12345.6), false);
  });

  it("getSourceFile returns undefined for an unknown path", () => {
    const db = openMetricsDb(":memory:");
    assert.equal(getSourceFile(db, "/nope"), undefined);
  });

  it("upserting the same path twice replaces rather than duplicates", () => {
    const db = openMetricsDb(":memory:");
    upsertSourceFile(db, { path: "/a.jsonl", size: 100, mtimeMs: 1, ingestedAt: "t1" });
    upsertSourceFile(db, { path: "/a.jsonl", size: 200, mtimeMs: 2, ingestedAt: "t2" });
    assert.equal(countRows(db, "source_file"), 1);
    const row = getSourceFile(db, "/a.jsonl");
    assert.equal(row.size, 200);
    assert.equal(row.mtime_ms, 2);
  });
});

describe("upsertSession / upsertTurn", () => {
  it("stores a session row and a turn row with NULL usage fields preserved as NULL", () => {
    const db = openMetricsDb(":memory:");
    upsertSession(db, {
      sessionId: "sess-1",
      projectSlug: "-home-user-project",
      firstTs: "2026-07-26T09:00:00.000Z",
      firstTsMs: Date.parse("2026-07-26T09:00:00.000Z"),
      lastTs: "2026-07-26T09:10:00.000Z",
      lastTsMs: Date.parse("2026-07-26T09:10:00.000Z"),
      cwd: "/workspace",
      gitBranch: "main",
    });
    upsertTurn(db, {
      requestId: "req-1",
      sessionId: "sess-1",
      ts: "2026-07-26T09:05:00.000Z",
      tsMs: Date.parse("2026-07-26T09:05:00.000Z"),
      model: "claude-sonnet-5",
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      isSidechain: 0,
      isSynthetic: 1,
      textBytes: 0,
      thinkingBytes: 0,
      toolUseBytes: 0,
    });

    assert.equal(countRows(db, "session"), 1);
    assert.equal(countRows(db, "turn"), 1);
  });

  it("getSession returns the stored row, and undefined for an unknown sessionId", () => {
    const db = openMetricsDb(":memory:");
    assert.equal(getSession(db, "nope"), undefined);
    upsertSession(db, {
      sessionId: "sess-1", projectSlug: "p",
      firstTs: "2026-07-26T09:00:00.000Z", firstTsMs: Date.parse("2026-07-26T09:00:00.000Z"),
      lastTs: "2026-07-26T09:10:00.000Z", lastTsMs: Date.parse("2026-07-26T09:10:00.000Z"),
      cwd: "/workspace", gitBranch: "main",
    });
    const row = getSession(db, "sess-1");
    assert.equal(row.project_slug, "p");
    assert.equal(row.first_ts_ms, Date.parse("2026-07-26T09:00:00.000Z"));
    assert.equal(row.last_ts_ms, Date.parse("2026-07-26T09:10:00.000Z"));
    assert.equal(row.cwd, "/workspace");
    assert.equal(row.git_branch, "main");
  });

  it("re-upserting the same session_id / request_id replaces, does not duplicate", () => {
    const db = openMetricsDb(":memory:");
    const sessionRow = { sessionId: "sess-1", projectSlug: "p", firstTs: null, firstTsMs: null, lastTs: null, lastTsMs: null, cwd: null, gitBranch: null };
    upsertSession(db, sessionRow);
    upsertSession(db, sessionRow);
    assert.equal(countRows(db, "session"), 1);

    const turnRow = {
      requestId: "req-1", sessionId: "sess-1", ts: null, tsMs: null, model: null,
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
      isSidechain: 0, isSynthetic: 0, textBytes: 0, thinkingBytes: 0, toolUseBytes: 0,
    };
    upsertTurn(db, turnRow);
    upsertTurn(db, turnRow);
    assert.equal(countRows(db, "turn"), 1);
  });
});

describe("upsertChain / upsertRound / upsertFinding", () => {
  it("stores a chain row with stratification keys and NULL totals when absent", () => {
    const db = openMetricsDb(":memory:");
    upsertChain(db, {
      chainId: "chain-x",
      workspaceSlug: "ws1",
      orchModel: "claude-opus-5",
      orchSession: "652c5ef7",
      orchDate: "2026-07-26",
      baseSha: null,
      model: null,
      modelChainJson: null,
      maxRounds: null,
      strategized: null,
      totalsInput: null,
      totalsOutput: null,
      totalsReasoning: null,
      totalsCacheRead: null,
      totalsCacheWrite: null,
      totalsCost: null,
      briefText: null,
      briefChars: null,
      briefLines: null,
      briefBullets: null,
      briefHasDeliverables: null,
      briefDeliverableCount: null,
      briefHasSmoke: null,
      briefSmokeCount: null,
    });
    assert.equal(countRows(db, "chain"), 1);
  });

  it("supports composite primary keys for round (chain_id, round) and finding (chain_id, round, idx)", () => {
    const db = openMetricsDb(":memory:");
    upsertRound(db, {
      chainId: "chain-x", round: 1, startedAt: null, startedMs: null, modelEntry: null,
      tierBefore: null, tierAfter: null, verdict: null, probesGreen: null, disposition: null,
      reworkCount: null, findingsText: null,
      implementIn: null, implementOut: null, implementCost: null,
      reviewIn: null, reviewOut: null, reviewCost: null,
    });
    upsertRound(db, {
      chainId: "chain-x", round: 2, startedAt: null, startedMs: null, modelEntry: null,
      tierBefore: null, tierAfter: null, verdict: null, probesGreen: null, disposition: null,
      reworkCount: null, findingsText: null,
      implementIn: null, implementOut: null, implementCost: null,
      reviewIn: null, reviewOut: null, reviewCost: null,
    });
    assert.equal(countRows(db, "round"), 2);

    upsertFinding(db, { chainId: "chain-x", round: 1, idx: 0, severity: "low", title: "t1", file: "f1" });
    upsertFinding(db, { chainId: "chain-x", round: 1, idx: 1, severity: "high", title: "t2", file: "f2" });
    // Same (chain_id, round) but different chain -- must not collide with round 1 above.
    upsertFinding(db, { chainId: "chain-y", round: 1, idx: 0, severity: "low", title: "t3", file: "f3" });
    assert.equal(countRows(db, "finding"), 3);

    // Re-upserting an identical (chain_id, round, idx) replaces, not duplicates.
    upsertFinding(db, { chainId: "chain-x", round: 1, idx: 0, severity: "critical", title: "t1-updated", file: "f1" });
    assert.equal(countRows(db, "finding"), 3);
  });

  it("stores finding.source distinguishing a real structured finding from one synthesised from findingFiles", () => {
    const db = openMetricsDb(":memory:");
    upsertFinding(db, { chainId: "chain-x", round: 1, idx: 0, severity: "high", title: "real", file: "f1", source: "findings" });
    upsertFinding(db, { chainId: "chain-x", round: 1, idx: 1, severity: null, title: null, file: "f2", source: "finding_files" });
    const rows = db.prepare("SELECT idx, severity, title, source FROM finding WHERE chain_id = ? ORDER BY idx").all("chain-x");
    assert.equal(rows[0].source, "findings");
    assert.equal(rows[1].source, "finding_files");
    // A finding row with no `source` given (e.g. written by pre-migration
    // code) stores NULL, not a guessed value.
    upsertFinding(db, { chainId: "chain-x", round: 2, idx: 0, severity: "low", title: "t", file: "f3" });
    const row2 = db.prepare("SELECT source FROM finding WHERE chain_id = ? AND round = 2").get("chain-x");
    assert.equal(row2.source, null);
  });
});

describe("finding.source migration on a pre-existing database file", () => {
  it("adds the source column to a database created before it existed, preserving old rows (NULL source)", () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-migrate-test-")), "metrics.db");

    // Simulate a database written by a version of this schema that predates
    // `finding.source` — the exact situation the real on-disk metrics.db the
    // coordinator ingested with was in.
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      CREATE TABLE finding (
        chain_id TEXT, round INTEGER, idx INTEGER, severity TEXT, title TEXT, file TEXT,
        PRIMARY KEY (chain_id, round, idx)
      )
    `);
    legacyDb.prepare("INSERT INTO finding (chain_id, round, idx, severity, title, file) VALUES (?, ?, ?, ?, ?, ?)")
      .run("chain-legacy", 1, 0, "medium", "old finding", "src/old.mjs");
    if (typeof legacyDb.close === "function") legacyDb.close();

    // Re-opening through openMetricsDb must migrate in place, not throw,
    // and must not touch the pre-existing row's other columns.
    const db = openMetricsDb(dbPath);
    const legacyRow = db.prepare("SELECT * FROM finding WHERE chain_id = ?").get("chain-legacy");
    assert.equal(legacyRow.severity, "medium");
    assert.equal(legacyRow.title, "old finding");
    assert.equal(legacyRow.source, null);

    // New rows written after migration behave normally.
    upsertFinding(db, { chainId: "chain-new", round: 1, idx: 0, severity: "high", title: "new", file: "f", source: "findings" });
    const newRow = db.prepare("SELECT source FROM finding WHERE chain_id = ?").get("chain-new");
    assert.equal(newRow.source, "findings");

    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("openMetricsDb is idempotent on a database that already has the source column", () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-migrate-test-")), "metrics.db");
    openMetricsDb(dbPath); // creates fresh, already has source
    assert.doesNotThrow(() => openMetricsDb(dbPath)); // re-open must not fail trying to re-add the column
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });
});

describe("round.worktree_changed migration (kusabi #165)", () => {
  it("adds the column to a database created before it existed, preserving old rows as NULL", () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-migrate-test-")), "metrics.db");

    // Simulate a database written before round.worktree_changed existed —
    // the full pre-#165 column set, with no worktree_changed.
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      CREATE TABLE round (
        chain_id TEXT,
        round INTEGER,
        started_at TEXT,
        started_ms INTEGER,
        model_entry TEXT,
        tier_before INTEGER,
        tier_after INTEGER,
        verdict TEXT,
        probes_green INTEGER,
        disposition TEXT,
        rework_count INTEGER,
        findings_text TEXT,
        implement_in INTEGER,
        implement_out INTEGER,
        implement_cost REAL,
        review_in INTEGER,
        review_out INTEGER,
        review_cost REAL,
        PRIMARY KEY (chain_id, round)
      )
    `);
    legacyDb.prepare("INSERT INTO round (chain_id, round, started_at, started_ms, disposition) VALUES (?, ?, ?, ?, ?)")
      .run("chain-legacy", 1, "2026-07-22T09:00:00.000Z", Date.parse("2026-07-22T09:00:00.000Z"), "escalate");
    if (typeof legacyDb.close === "function") legacyDb.close();

    // Re-opening through openMetricsDb must migrate in place and must NOT
    // rewrite the old row's NULL worktree_changed — NULL is "unknown",
    // never "no-work".
    const db = openMetricsDb(dbPath);
    const legacyRow = db.prepare("SELECT * FROM round WHERE chain_id = ?").get("chain-legacy");
    assert.equal(legacyRow.disposition, "escalate");
    assert.equal(legacyRow.worktree_changed, null);

    // New rows written after migration store the three-valued flag.
    upsertRound(db, {
      chainId: "chain-new", round: 1, startedAt: null, startedMs: null, modelEntry: null,
      tierBefore: null, tierAfter: null, verdict: null, probesGreen: null, disposition: "escalate",
      reworkCount: null, findingsText: null, worktreeChanged: 0,
      implementIn: null, implementOut: null, implementCost: null,
      reviewIn: null, reviewOut: null, reviewCost: null,
    });
    const newRow = db.prepare("SELECT worktree_changed FROM round WHERE chain_id = ?").get("chain-new");
    assert.equal(newRow.worktree_changed, 0);

    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("openMetricsDb is idempotent on a database that already has the column", () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-migrate-test-")), "metrics.db");
    openMetricsDb(dbPath);
    assert.doesNotThrow(() => openMetricsDb(dbPath));
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });
});

describe("transactions", () => {
  it("a rolled-back transaction leaves no partial rows (crash-mid-ingest safety)", () => {
    const db = openMetricsDb(":memory:");
    db.exec("BEGIN");
    upsertChain(db, {
      chainId: "chain-partial", workspaceSlug: null, orchModel: null, orchSession: null, orchDate: null,
      baseSha: null, model: null, modelChainJson: null, maxRounds: null, strategized: null,
      totalsInput: null, totalsOutput: null, totalsReasoning: null, totalsCacheRead: null,
      totalsCacheWrite: null, totalsCost: null, briefText: null, briefChars: null, briefLines: null,
      briefBullets: null, briefHasDeliverables: null, briefDeliverableCount: null, briefHasSmoke: null,
      briefSmokeCount: null,
    });
    db.exec("ROLLBACK");
    assert.equal(countRows(db, "chain"), 0);
  });

  it("a committed transaction persists all rows written inside it", () => {
    const db = openMetricsDb(":memory:");
    db.exec("BEGIN");
    upsertChain(db, {
      chainId: "chain-committed", workspaceSlug: null, orchModel: null, orchSession: null, orchDate: null,
      baseSha: null, model: null, modelChainJson: null, maxRounds: null, strategized: null,
      totalsInput: null, totalsOutput: null, totalsReasoning: null, totalsCacheRead: null,
      totalsCacheWrite: null, totalsCost: null, briefText: null, briefChars: null, briefLines: null,
      briefBullets: null, briefHasDeliverables: null, briefDeliverableCount: null, briefHasSmoke: null,
      briefSmokeCount: null,
    });
    db.exec("COMMIT");
    assert.equal(countRows(db, "chain"), 1);
  });
});

// ---------------------------------------------------------------------------
// job (#154)
// ---------------------------------------------------------------------------

describe("upsertJob", () => {
  it("is idempotent on job_id (INSERT OR REPLACE, one row after two upserts)", () => {
    const db = openMetricsDb(":memory:");
    const row = { jobId: "job-a", status: "completed", usageAvailable: 1, usageCost: 0 };
    upsertJob(db, row);
    upsertJob(db, row);
    assert.equal(countRows(db, "job"), 1);
  });

  it("stores cost 0 as 0 (a free-tier measurement), never coerced to NULL", () => {
    const db = openMetricsDb(":memory:");
    upsertJob(db, { jobId: "job-free", status: "completed", usageAvailable: 1, usageCost: 0 });
    const got = db.prepare("SELECT usage_cost FROM job WHERE job_id = 'job-free'").get();
    assert.equal(got.usage_cost, 0);
  });

  it("stores absent fields as NULL, and keeps usage_available three-valued (NULL vs 0 vs 1)", () => {
    const db = openMetricsDb(":memory:");
    upsertJob(db, { jobId: "job-nousage", status: "error" }); // no usage.json at all
    upsertJob(db, { jobId: "job-unavail", status: "completed", usageAvailable: 0 });
    upsertJob(db, { jobId: "job-measured", status: "completed", usageAvailable: 1, usageOutput: 79 });
    const rows = db.prepare("SELECT job_id, usage_available, usage_output, usage_cost FROM job ORDER BY job_id").all();
    const byId = Object.fromEntries(rows.map((r) => [r.job_id, r]));
    assert.equal(byId["job-nousage"].usage_available, null);
    assert.equal(byId["job-nousage"].usage_cost, null);
    assert.equal(byId["job-unavail"].usage_available, 0);
    assert.equal(byId["job-measured"].usage_available, 1);
    assert.equal(byId["job-measured"].usage_output, 79);
  });

  it("stores an unknown status string verbatim", () => {
    const db = openMetricsDb(":memory:");
    upsertJob(db, { jobId: "job-x", status: "totally-new-status" });
    const got = db.prepare("SELECT status FROM job WHERE job_id = 'job-x'").get();
    assert.equal(got.status, "totally-new-status");
  });
});
