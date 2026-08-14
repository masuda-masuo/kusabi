// cursor-usage-ingest.test.mjs — Unit tests for cursor-usage-ingest.mjs
//
// Fixtures are inline JSONL; tests never touch the real HOME or
// ~/.kusabi/cursor-usage.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  parseCursorUsageContent,
  ingestCursorUsageDirectory,
  projectSlugFromCwd,
} from "./cursor-usage-ingest.mjs";
import {
  openMetricsDb,
  countRows,
  getCursorSessionCounter,
  upsertTurn,
  upsertSourceFile,
} from "./metrics-db.mjs";

const SESSION_ID = "d73008ab-1111-2222-3333-444444444444";
const CWD = "/home/user/proj";

function usageRecord({
  sessionId = SESSION_ID,
  ts,
  cwd = CWD,
  modelId = "default",
  currentUsage,
  contextWindow,
  totalOutputTokens,
} = {}) {
  const rec = {
    ts,
    session_id: sessionId,
    model: modelId === null ? null : { id: modelId, display_name: modelId === "default" ? "Auto" : modelId },
    cwd,
  };
  if (contextWindow === undefined) {
    rec.context_window = {
      total_input_tokens: currentUsage ? 100 : null,
      total_output_tokens: totalOutputTokens !== undefined
        ? totalOutputTokens
        : (currentUsage ? 10 : null),
      context_window_size: 256000,
      current_usage: currentUsage ?? null,
    };
  } else {
    rec.context_window = contextWindow;
  }
  return rec;
}

function tokens({ input, output, cacheRead, cacheWrite }) {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  };
}

/** null-period 2 lines + usage 2 lines (the smoke fixture shape). */
function buildSamplerLines() {
  return [
    JSON.stringify(usageRecord({ ts: "2026-08-14T10:00:00.000Z", currentUsage: null })),
    JSON.stringify(usageRecord({ ts: "2026-08-14T10:00:05.000Z", currentUsage: null })),
    JSON.stringify(usageRecord({
      ts: "2026-08-14T10:00:10.000Z",
      currentUsage: tokens({ input: 14999, output: 29, cacheRead: 512, cacheWrite: 0 }),
    })),
    JSON.stringify(usageRecord({
      ts: "2026-08-14T10:00:20.000Z",
      currentUsage: tokens({ input: 16000, output: 80, cacheRead: 1024, cacheWrite: 200 }),
    })),
  ].join("\n") + "\n";
}

describe("projectSlugFromCwd", () => {
  it("encodes cwd the way Claude Code names ~/.claude/projects folders", () => {
    assert.equal(projectSlugFromCwd("/home/user/proj"), "-home-user-proj");
    assert.equal(projectSlugFromCwd("/workspace"), "-workspace");
    assert.equal(projectSlugFromCwd(null), null);
    assert.equal(projectSlugFromCwd(""), null);
  });
});

describe("parseCursorUsageContent — null-period skip and usage mapping", () => {
  it("skips current_usage=null rows as turns but maps the four usage fields on usage rows", () => {
    const result = parseCursorUsageContent(buildSamplerLines());
    assert.equal(result.parseFailures, 0);
    assert.equal(result.recordCount, 4);
    assert.equal(result.nullUsageCount, 2);
    assert.equal(result.usageRecordCount, 2);
    assert.equal(result.turns.length, 2);

    assert.equal(result.turns[0].requestId, `cursor:${SESSION_ID}#3`);
    assert.equal(result.turns[0].input, 14999);
    assert.equal(result.turns[0].output, 29);
    assert.equal(result.turns[0].cacheRead, 512);
    assert.equal(result.turns[0].cacheWrite, 0);
    assert.equal(result.turns[0].model, "default");
    assert.equal(result.turns[0].ts, "2026-08-14T10:00:10.000Z");
    assert.equal(result.turns[0].isSidechain, 0);
    assert.equal(result.turns[0].isSynthetic, 0);
    assert.equal(result.turns[0].textBytes, null);
    assert.equal(result.turns[0].thinkingBytes, null);
    assert.equal(result.turns[0].toolUseBytes, null);

    assert.equal(result.turns[1].requestId, `cursor:${SESSION_ID}#4`);
    assert.equal(result.turns[1].input, 16000);
    assert.equal(result.turns[1].output, 80);
    assert.equal(result.turns[1].cacheRead, 1024);
    assert.equal(result.turns[1].cacheWrite, 200);
  });

  it("skips a row whose whole context_window is null, same as current_usage null", () => {
    const line = JSON.stringify(usageRecord({
      ts: "2026-08-14T10:00:00.000Z",
      contextWindow: null,
    }));
    const result = parseCursorUsageContent(line);
    assert.equal(result.turns.length, 0);
    assert.equal(result.nullUsageCount, 1);
    assert.equal(result.sessions.length, 1);
  });

  it("stores model=null when model.id is absent", () => {
    const rec = usageRecord({
      ts: "2026-08-14T10:00:10.000Z",
      currentUsage: tokens({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }),
    });
    rec.model = { display_name: "Auto" };
    const result = parseCursorUsageContent(JSON.stringify(rec));
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].model, null);
  });

  it("uses 1-based physical line numbers so request_id is stable across re-parse", () => {
    const content = buildSamplerLines();
    const a = parseCursorUsageContent(content);
    const b = parseCursorUsageContent(content);
    assert.deepEqual(
      a.turns.map((t) => t.requestId),
      b.turns.map((t) => t.requestId),
    );
    assert.deepEqual(
      a.turns.map((t) => t.requestId),
      [`cursor:${SESSION_ID}#3`, `cursor:${SESSION_ID}#4`],
    );
  });

  it("keeps line numbers stable when a blank line occupies a physical slot", () => {
    const lines = [
      JSON.stringify(usageRecord({ ts: "2026-08-14T10:00:00.000Z", currentUsage: null })),
      "",
      JSON.stringify(usageRecord({
        ts: "2026-08-14T10:00:10.000Z",
        currentUsage: tokens({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }),
      })),
    ];
    const result = parseCursorUsageContent(lines.join("\n"));
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].requestId, `cursor:${SESSION_ID}#3`);
  });
});

describe("parseCursorUsageContent — session range includes null-usage rows", () => {
  it("widens first/last ts across null-period rows that produce no turns", () => {
    const result = parseCursorUsageContent(buildSamplerLines());
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].sessionId, SESSION_ID);
    assert.equal(result.sessions[0].cwd, CWD);
    assert.equal(result.sessions[0].gitBranch, null);
    assert.equal(result.sessions[0].projectSlug, "-home-user-proj");
    assert.equal(result.sessions[0].firstTsMs, Date.parse("2026-08-14T10:00:00.000Z"));
    assert.equal(result.sessions[0].lastTsMs, Date.parse("2026-08-14T10:00:20.000Z"));
    assert.equal(result.turns.length, 2);
  });

  it("still records a session when every row is null-usage", () => {
    const content = [
      JSON.stringify(usageRecord({ ts: "2026-08-14T10:00:00.000Z", currentUsage: null })),
      JSON.stringify(usageRecord({ ts: "2026-08-14T10:00:05.000Z", currentUsage: null })),
    ].join("\n");
    const result = parseCursorUsageContent(content);
    assert.equal(result.turns.length, 0);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].firstTsMs, Date.parse("2026-08-14T10:00:00.000Z"));
    assert.equal(result.sessions[0].lastTsMs, Date.parse("2026-08-14T10:00:05.000Z"));
  });

  it("skips an unparseable JSON line and counts it, without throwing", () => {
    const lines = [
      "{not valid json",
      JSON.stringify(usageRecord({
        ts: "2026-08-14T10:00:10.000Z",
        currentUsage: tokens({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }),
      })),
    ];
    const result = parseCursorUsageContent(lines.join("\n"));
    assert.equal(result.parseFailures, 1);
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].requestId, `cursor:${SESSION_ID}#2`);
  });
});

function makeTempUsageDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-cursor-usage-test-"));
}

describe("ingestCursorUsageDirectory", () => {
  it("ingests turns and sessions, skips unchanged files on re-run, and does not grow rows", () => {
    const dir = makeTempUsageDir();
    fs.writeFileSync(path.join(dir, `${SESSION_ID}.jsonl`), buildSamplerLines(), "utf8");

    const db = openMetricsDb(":memory:");
    const first = ingestCursorUsageDirectory(db, dir);
    assert.equal(first.filesScanned, 1);
    assert.equal(first.filesSkippedUnchanged, 0);
    assert.equal(first.sessions, 1);
    assert.equal(first.turns, 2);
    assert.equal(countRows(db, "turn"), 2);
    assert.equal(countRows(db, "session"), 1);

    const row = db.prepare("SELECT * FROM turn WHERE request_id = ?").get(`cursor:${SESSION_ID}#3`);
    assert.equal(row.input, 14999);
    assert.equal(row.output, 29);
    assert.equal(row.cache_read, 512);
    assert.equal(row.cache_write, 0);
    assert.equal(row.model, "default");
    assert.equal(row.is_sidechain, 0);
    assert.equal(row.is_synthetic, 0);
    assert.equal(row.text_bytes, null);
    assert.equal(row.thinking_bytes, null);
    assert.equal(row.tool_use_bytes, null);

    const sess = db.prepare("SELECT * FROM session WHERE session_id = ?").get(SESSION_ID);
    assert.equal(sess.project_slug, "-home-user-proj");
    assert.equal(sess.git_branch, null);
    assert.equal(sess.cwd, CWD);
    assert.equal(sess.first_ts_ms, Date.parse("2026-08-14T10:00:00.000Z"));
    assert.equal(sess.last_ts_ms, Date.parse("2026-08-14T10:00:20.000Z"));

    const second = ingestCursorUsageDirectory(db, dir);
    assert.equal(second.filesScanned, 1);
    assert.equal(second.filesSkippedUnchanged, 1);
    assert.equal(second.turns, 0);
    assert.equal(countRows(db, "turn"), 2);
    assert.equal(countRows(db, "session"), 1);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is idempotent even after the source_file skip-cache is cleared (correctness is PK)", () => {
    const dir = makeTempUsageDir();
    fs.writeFileSync(path.join(dir, `${SESSION_ID}.jsonl`), buildSamplerLines(), "utf8");
    const db = openMetricsDb(":memory:");
    ingestCursorUsageDirectory(db, dir);
    db.exec("DELETE FROM source_file");
    const again = ingestCursorUsageDirectory(db, dir);
    assert.equal(again.filesSkippedUnchanged, 0);
    assert.equal(again.turns, 2);
    assert.equal(countRows(db, "turn"), 2);
    assert.equal(countRows(db, "session"), 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("aggregates session first/last timestamps across files sharing a sessionId, including null-usage-only files", () => {
    const dir = makeTempUsageDir();
    const early = JSON.stringify(usageRecord({
      ts: "2026-08-14T09:00:00.000Z",
      currentUsage: null,
    })) + "\n";
    const later = JSON.stringify(usageRecord({
      ts: "2026-08-14T11:00:00.000Z",
      currentUsage: tokens({ input: 5, output: 5, cacheRead: 0, cacheWrite: 0 }),
    })) + "\n";
    fs.writeFileSync(path.join(dir, "part-a.jsonl"), early, "utf8");
    fs.writeFileSync(path.join(dir, "part-b.jsonl"), later, "utf8");

    const db = openMetricsDb(":memory:");
    const result = ingestCursorUsageDirectory(db, dir);
    assert.equal(result.sessions, 1);
    assert.equal(result.turns, 1);
    const sess = db.prepare("SELECT first_ts_ms, last_ts_ms FROM session WHERE session_id = ?").get(SESSION_ID);
    assert.equal(sess.first_ts_ms, Date.parse("2026-08-14T09:00:00.000Z"));
    assert.equal(sess.last_ts_ms, Date.parse("2026-08-14T11:00:00.000Z"));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("widens a stored session range across incremental appends to the same file", () => {
    const dir = makeTempUsageDir();
    const file = path.join(dir, `${SESSION_ID}.jsonl`);
    fs.writeFileSync(
      file,
      JSON.stringify(usageRecord({
        ts: "2026-08-14T08:00:00.000Z",
        currentUsage: tokens({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }),
      })) + "\n",
      "utf8",
    );
    const db = openMetricsDb(":memory:");
    ingestCursorUsageDirectory(db, dir);

    fs.appendFileSync(
      file,
      JSON.stringify(usageRecord({
        ts: "2026-08-14T12:00:00.000Z",
        currentUsage: tokens({ input: 2, output: 2, cacheRead: 0, cacheWrite: 0 }),
      })) + "\n",
    );
    ingestCursorUsageDirectory(db, dir);

    const sess = db.prepare("SELECT first_ts_ms, last_ts_ms FROM session WHERE session_id = ?").get(SESSION_ID);
    assert.equal(sess.first_ts_ms, Date.parse("2026-08-14T08:00:00.000Z"));
    assert.equal(sess.last_ts_ms, Date.parse("2026-08-14T12:00:00.000Z"));
    assert.equal(countRows(db, "turn"), 2);
    const ids = db.prepare("SELECT request_id FROM turn ORDER BY request_id").all().map((r) => r.request_id);
    assert.deepEqual(ids, [`cursor:${SESSION_ID}#1`, `cursor:${SESSION_ID}#2`]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns a zeroed summary for a cursor-usage dir that does not exist", () => {
    const db = openMetricsDb(":memory:");
    const result = ingestCursorUsageDirectory(db, path.join(os.tmpdir(), "does-not-exist-cu-" + Date.now()));
    assert.equal(result.filesScanned, 0);
    assert.equal(result.turns, 0);
    assert.equal(result.sessions, 0);
  });

  it("returns zeros for an existing empty directory (not a missing-dir case)", () => {
    const dir = makeTempUsageDir();
    const db = openMetricsDb(":memory:");
    const result = ingestCursorUsageDirectory(db, dir);
    assert.equal(result.filesScanned, 0);
    assert.equal(result.turns, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

function buildUndercountLines() {
  return [
    JSON.stringify(usageRecord({
      ts: "2026-08-14T10:00:10.000Z",
      currentUsage: tokens({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0 }),
      totalOutputTokens: 30,
    })),
    JSON.stringify(usageRecord({
      ts: "2026-08-14T10:00:20.000Z",
      currentUsage: tokens({ input: 200, output: 30, cacheRead: 0, cacheWrite: 0 }),
      totalOutputTokens: 80,
    })),
  ].join("\n") + "\n";
}

describe("parseCursorUsageContent — cursor_session_counter tracking", () => {
  it("keeps the latest-ts numeric total_output_tokens per session", () => {
    const result = parseCursorUsageContent(buildUndercountLines());
    assert.equal(result.counters.length, 1);
    assert.equal(result.counters[0].sessionId, SESSION_ID);
    assert.equal(result.counters[0].totalOutputTokens, 80);
    assert.equal(result.counters[0].ts, "2026-08-14T10:00:20.000Z");
    assert.equal(result.turns.reduce((s, t) => s + t.output, 0), 50);
  });

  it("ignores non-numeric total_output_tokens and still emits the turn", () => {
    const rec = usageRecord({
      ts: "2026-08-14T10:00:10.000Z",
      currentUsage: tokens({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }),
    });
    rec.context_window.total_output_tokens = "80";
    const result = parseCursorUsageContent(JSON.stringify(rec));
    assert.equal(result.turns.length, 1);
    assert.equal(result.counters.length, 0);
  });

  it("tracks a numeric total on a null-usage row (no turn)", () => {
    const rec = usageRecord({
      ts: "2026-08-14T10:00:00.000Z",
      currentUsage: null,
      totalOutputTokens: 12,
    });
    const result = parseCursorUsageContent(JSON.stringify(rec));
    assert.equal(result.turns.length, 0);
    assert.equal(result.counters.length, 1);
    assert.equal(result.counters[0].totalOutputTokens, 12);
  });

  it("prefers a later ts even when the token value is smaller (no monotonicity)", () => {
    const content = [
      JSON.stringify(usageRecord({
        ts: "2026-08-14T10:00:10.000Z",
        currentUsage: tokens({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }),
        totalOutputTokens: 80,
      })),
      JSON.stringify(usageRecord({
        ts: "2026-08-14T10:00:20.000Z",
        currentUsage: tokens({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }),
        totalOutputTokens: 40,
      })),
    ].join("\n");
    const result = parseCursorUsageContent(content);
    assert.equal(result.counters[0].totalOutputTokens, 40);
    assert.equal(result.counters[0].ts, "2026-08-14T10:00:20.000Z");
  });
});

describe("ingestCursorUsageDirectory — cursor_session_counter", () => {
  it("upserts the latest-ts counter and stays idempotent after skip-cache is cleared", () => {
    const dir = makeTempUsageDir();
    fs.writeFileSync(path.join(dir, `${SESSION_ID}.jsonl`), buildUndercountLines(), "utf8");
    const db = openMetricsDb(":memory:");
    ingestCursorUsageDirectory(db, dir);
    assert.equal(countRows(db, "cursor_session_counter"), 1);
    assert.equal(getCursorSessionCounter(db, SESSION_ID).total_output_tokens, 80);
    assert.equal(getCursorSessionCounter(db, SESSION_ID).ts, "2026-08-14T10:00:20.000Z");
    const turnSum = db.prepare("SELECT SUM(output) AS s FROM turn").get().s;
    assert.equal(turnSum, 50);

    const skipped = ingestCursorUsageDirectory(db, dir);
    assert.equal(skipped.filesSkippedUnchanged, 1);
    assert.equal(getCursorSessionCounter(db, SESSION_ID).total_output_tokens, 80);

    db.exec("DELETE FROM source_file");
    ingestCursorUsageDirectory(db, dir);
    assert.equal(countRows(db, "cursor_session_counter"), 1);
    assert.equal(getCursorSessionCounter(db, SESSION_ID).total_output_tokens, 80);
    assert.equal(countRows(db, "turn"), 2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("across files, keeps the newest-ts reading even if that file is seen second", () => {
    const dir = makeTempUsageDir();
    const older = JSON.stringify(usageRecord({
      ts: "2026-08-14T10:00:10.000Z",
      currentUsage: tokens({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }),
      totalOutputTokens: 999,
    })) + "\n";
    const newer = JSON.stringify(usageRecord({
      ts: "2026-08-14T10:00:20.000Z",
      currentUsage: tokens({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }),
      totalOutputTokens: 80,
    })) + "\n";
    fs.writeFileSync(path.join(dir, "a.jsonl"), newer, "utf8");
    fs.writeFileSync(path.join(dir, "b.jsonl"), older, "utf8");
    const db = openMetricsDb(":memory:");
    ingestCursorUsageDirectory(db, dir);
    assert.equal(getCursorSessionCounter(db, SESSION_ID).total_output_tokens, 80);
    assert.equal(getCursorSessionCounter(db, SESSION_ID).ts, "2026-08-14T10:00:20.000Z");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// kusabi #252 — run-length collapse of repeated current_usage snapshots
// ---------------------------------------------------------------------------

/**
 * One line as the sink really writes it mid-stream: `current_usage` is the
 * snapshot of the most recent turn (often unchanged), while the surrounding
 * `context_window` fields move — which is exactly why the sink's
 * whole-object duplicate suppression lets the line through.
 */
function streamingLine({
  ts,
  usage,
  usedPercentage,
  totalInputTokens,
  totalOutputTokens,
  sessionId = SESSION_ID,
}) {
  return JSON.stringify(usageRecord({
    ts,
    sessionId,
    contextWindow: {
      used_percentage: usedPercentage,
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
      context_window_size: 256000,
      current_usage: usage,
    },
  }));
}

const SNAPSHOT_A = tokens({ input: 14999, output: 29, cacheRead: 512, cacheWrite: 0 });
const SNAPSHOT_B = tokens({ input: 16000, output: 80, cacheRead: 1024, cacheWrite: 200 });

/**
 * The measured real-file shape: snapshot A repeated over three appends while
 * used_percentage / total_input_tokens / total_output_tokens all move, then a
 * new snapshot B repeated twice.  5 usage lines, 2 turns.
 */
function buildRepeatedSnapshotLines() {
  return [
    streamingLine({
      ts: "2026-08-14T10:00:00.000Z",
      usage: SNAPSHOT_A,
      usedPercentage: 4.1,
      totalInputTokens: 10000,
      totalOutputTokens: 100,
    }),
    streamingLine({
      ts: "2026-08-14T10:00:10.000Z",
      usage: SNAPSHOT_A,
      usedPercentage: 4.3,
      totalInputTokens: 10500,
      totalOutputTokens: 120,
    }),
    streamingLine({
      ts: "2026-08-14T10:00:20.000Z",
      usage: SNAPSHOT_A,
      usedPercentage: 4.9,
      totalInputTokens: 11000,
      totalOutputTokens: 140,
    }),
    streamingLine({
      ts: "2026-08-14T10:00:30.000Z",
      usage: SNAPSHOT_B,
      usedPercentage: 5.0,
      totalInputTokens: 12000,
      totalOutputTokens: 200,
    }),
    streamingLine({
      ts: "2026-08-14T10:00:40.000Z",
      usage: SNAPSHOT_B,
      usedPercentage: 5.4,
      totalInputTokens: 12500,
      totalOutputTokens: 220,
    }),
  ].join("\n") + "\n";
}

describe("parseCursorUsageContent — repeated current_usage snapshots collapse", () => {
  it("emits one turn per distinct consecutive snapshot, id from the run's first line", () => {
    const result = parseCursorUsageContent(buildRepeatedSnapshotLines());

    assert.equal(result.recordCount, 5);
    // Every usage-bearing LINE is still counted; the collapse is reported
    // separately rather than hidden inside a smaller usageRecordCount.
    assert.equal(result.usageRecordCount, 5);
    assert.equal(result.collapsedRepeatCount, 3);

    assert.equal(result.turns.length, 2);
    assert.deepEqual(
      result.turns.map((t) => t.requestId),
      [`cursor:${SESSION_ID}#1`, `cursor:${SESSION_ID}#4`],
    );
    assert.equal(result.turns[0].input, 14999);
    assert.equal(result.turns[0].output, 29);
    assert.equal(result.turns[0].ts, "2026-08-14T10:00:00.000Z");
    assert.equal(result.turns[1].input, 16000);
    assert.equal(result.turns[1].output, 80);
    assert.equal(result.turns[1].ts, "2026-08-14T10:00:30.000Z");
    // The whole point: sums are per distinct snapshot, not per line.
    assert.equal(result.turns.reduce((s, t) => s + t.output, 0), 109);
    assert.equal(result.turns.reduce((s, t) => s + t.input, 0), 30999);
  });

  it("keeps the session ts range and the counter over ALL lines, including collapsed ones", () => {
    const result = parseCursorUsageContent(buildRepeatedSnapshotLines());
    assert.equal(result.sessions.length, 1);
    // 10:00:10 and 10:00:20 produced no turn, but 10:00:40 (also collapsed)
    // still ends the range.
    assert.equal(result.sessions[0].firstTsMs, Date.parse("2026-08-14T10:00:00.000Z"));
    assert.equal(result.sessions[0].lastTsMs, Date.parse("2026-08-14T10:00:40.000Z"));
    assert.equal(result.counters.length, 1);
    assert.equal(result.counters[0].totalOutputTokens, 220);
    assert.equal(result.counters[0].ts, "2026-08-14T10:00:40.000Z");
  });

  it("treats an A,B,A alternation as three turns (compares the previous EMITTED value, not a seen-set)", () => {
    const content = [
      streamingLine({ ts: "2026-08-14T10:00:00.000Z", usage: SNAPSHOT_A, usedPercentage: 4.1, totalInputTokens: 1, totalOutputTokens: 1 }),
      streamingLine({ ts: "2026-08-14T10:00:10.000Z", usage: SNAPSHOT_B, usedPercentage: 4.2, totalInputTokens: 2, totalOutputTokens: 2 }),
      streamingLine({ ts: "2026-08-14T10:00:20.000Z", usage: SNAPSHOT_A, usedPercentage: 4.3, totalInputTokens: 3, totalOutputTokens: 3 }),
    ].join("\n");
    const result = parseCursorUsageContent(content);
    assert.equal(result.turns.length, 3);
    assert.equal(result.collapsedRepeatCount, 0);
    assert.deepEqual(
      result.turns.map((t) => t.requestId),
      [`cursor:${SESSION_ID}#1`, `cursor:${SESSION_ID}#2`, `cursor:${SESSION_ID}#3`],
    );
  });

  it("collapses on the four token fields only — an identical snapshot with a different model still collapses", () => {
    const first = usageRecord({
      ts: "2026-08-14T10:00:00.000Z",
      currentUsage: SNAPSHOT_A,
    });
    const second = usageRecord({
      ts: "2026-08-14T10:00:10.000Z",
      currentUsage: SNAPSHOT_A,
      modelId: "grok-4.6",
    });
    const result = parseCursorUsageContent([JSON.stringify(first), JSON.stringify(second)].join("\n"));
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].model, "default");
  });

  it("does not reset the run across a null-usage line (nothing was emitted in between)", () => {
    const content = [
      streamingLine({ ts: "2026-08-14T10:00:00.000Z", usage: SNAPSHOT_A, usedPercentage: 4.1, totalInputTokens: 1, totalOutputTokens: 1 }),
      JSON.stringify(usageRecord({ ts: "2026-08-14T10:00:05.000Z", currentUsage: null })),
      streamingLine({ ts: "2026-08-14T10:00:10.000Z", usage: SNAPSHOT_A, usedPercentage: 4.4, totalInputTokens: 2, totalOutputTokens: 2 }),
    ].join("\n");
    const result = parseCursorUsageContent(content);
    assert.equal(result.turns.length, 1);
    assert.equal(result.nullUsageCount, 1);
    assert.equal(result.collapsedRepeatCount, 1);
  });

  it("compares per session, so two sessions in one file cannot collapse into each other", () => {
    const other = "aaaaaaaa-9999-8888-7777-666666666666";
    const content = [
      streamingLine({ ts: "2026-08-14T10:00:00.000Z", usage: SNAPSHOT_A, usedPercentage: 4.1, totalInputTokens: 1, totalOutputTokens: 1 }),
      streamingLine({ ts: "2026-08-14T10:00:10.000Z", usage: SNAPSHOT_A, usedPercentage: 4.2, totalInputTokens: 2, totalOutputTokens: 2, sessionId: other }),
      streamingLine({ ts: "2026-08-14T10:00:20.000Z", usage: SNAPSHOT_A, usedPercentage: 4.3, totalInputTokens: 3, totalOutputTokens: 3 }),
    ].join("\n");
    const result = parseCursorUsageContent(content);
    // Line 2 is a different session's first snapshot (a turn); line 3 repeats
    // line 1's snapshot for the original session (collapsed).
    assert.equal(result.turns.length, 2);
    assert.deepEqual(
      result.turns.map((t) => t.requestId),
      [`cursor:${SESSION_ID}#1`, `cursor:${other}#2`],
    );
  });

  it("keeps a run's request_id stable when more repeats are appended", () => {
    const head = [
      streamingLine({ ts: "2026-08-14T10:00:00.000Z", usage: SNAPSHOT_A, usedPercentage: 4.1, totalInputTokens: 1, totalOutputTokens: 1 }),
      streamingLine({ ts: "2026-08-14T10:00:10.000Z", usage: SNAPSHOT_A, usedPercentage: 4.2, totalInputTokens: 2, totalOutputTokens: 2 }),
    ].join("\n") + "\n";
    const grown = head + [
      streamingLine({ ts: "2026-08-14T10:00:20.000Z", usage: SNAPSHOT_A, usedPercentage: 4.3, totalInputTokens: 3, totalOutputTokens: 3 }),
      streamingLine({ ts: "2026-08-14T10:00:30.000Z", usage: SNAPSHOT_B, usedPercentage: 5.0, totalInputTokens: 4, totalOutputTokens: 4 }),
    ].join("\n") + "\n";

    assert.deepEqual(
      parseCursorUsageContent(head).turns.map((t) => t.requestId),
      [`cursor:${SESSION_ID}#1`],
    );
    assert.deepEqual(
      parseCursorUsageContent(grown).turns.map((t) => t.requestId),
      [`cursor:${SESSION_ID}#1`, `cursor:${SESSION_ID}#4`],
    );
  });
});

describe("ingestCursorUsageDirectory — repairing rows written by the pre-collapse parser", () => {
  it("re-reads a cached file once and leaves only the collapsed rows, then converges", () => {
    const dir = makeTempUsageDir();
    const file = path.join(dir, `${SESSION_ID}.jsonl`);
    fs.writeFileSync(file, buildRepeatedSnapshotLines(), "utf8");
    const stat = fs.statSync(file);

    // The store as the OLD parser left it: one turn per usage line, and a
    // source_file cache row under the old (unversioned) key carrying the
    // file's real size+mtime.  A finished session's jsonl never changes
    // again, so without the key bump this state would pin the inflated rows
    // forever.
    const db = openMetricsDb(":memory:");
    for (let lineNo = 1; lineNo <= 5; lineNo++) {
      upsertTurn(db, {
        requestId: `cursor:${SESSION_ID}#${lineNo}`,
        sessionId: SESSION_ID,
        ts: "2026-08-14T10:00:00.000Z",
        tsMs: Date.parse("2026-08-14T10:00:00.000Z"),
        model: "default",
        input: 14999,
        output: 29,
        isSidechain: 0,
        isSynthetic: 0,
      });
    }
    upsertSourceFile(db, {
      path: file,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ingestedAt: "2026-08-14T23:00:00.000Z",
    });
    assert.equal(countRows(db, "turn"), 5);

    const first = ingestCursorUsageDirectory(db, dir);
    assert.equal(first.filesSkippedUnchanged, 0);
    assert.equal(first.staleTurnsRemoved, 5);
    assert.equal(first.turns, 2);
    assert.equal(first.collapsedRepeats, 3);
    assert.equal(countRows(db, "turn"), 2);
    assert.deepEqual(
      db.prepare("SELECT request_id FROM turn ORDER BY request_id").all().map((r) => r.request_id),
      [`cursor:${SESSION_ID}#1`, `cursor:${SESSION_ID}#4`],
    );
    assert.equal(db.prepare("SELECT SUM(output) AS s FROM turn").get().s, 109);

    // Two further runs change nothing: the file is now cached under the
    // current parser version, so it is not even re-read.
    for (let run = 0; run < 2; run++) {
      const again = ingestCursorUsageDirectory(db, dir);
      assert.equal(again.filesSkippedUnchanged, 1);
      assert.equal(again.staleTurnsRemoved, 0);
      assert.equal(countRows(db, "turn"), 2);
      assert.equal(countRows(db, "session"), 1);
    }

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not touch another session's cursor rows, or Claude turns of the same session", () => {
    const dir = makeTempUsageDir();
    fs.writeFileSync(path.join(dir, `${SESSION_ID}.jsonl`), buildRepeatedSnapshotLines(), "utf8");
    const db = openMetricsDb(":memory:");
    upsertTurn(db, {
      requestId: "cursor:other-session#1",
      sessionId: "other-session",
      ts: "2026-08-14T09:00:00.000Z",
      tsMs: Date.parse("2026-08-14T09:00:00.000Z"),
      output: 7,
      isSidechain: 0,
      isSynthetic: 0,
    });
    upsertTurn(db, {
      requestId: "req-from-a-claude-transcript",
      sessionId: SESSION_ID,
      ts: "2026-08-14T09:30:00.000Z",
      tsMs: Date.parse("2026-08-14T09:30:00.000Z"),
      output: 11,
      isSidechain: 0,
      isSynthetic: 0,
    });

    ingestCursorUsageDirectory(db, dir);

    assert.ok(db.prepare("SELECT 1 FROM turn WHERE request_id = ?").get("cursor:other-session#1"));
    assert.ok(db.prepare("SELECT 1 FROM turn WHERE request_id = ?").get("req-from-a-claude-transcript"));
    assert.equal(countRows(db, "turn"), 4);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("re-ingests a grown file without stranding the rows written before the append", () => {
    const dir = makeTempUsageDir();
    const file = path.join(dir, `${SESSION_ID}.jsonl`);
    fs.writeFileSync(
      file,
      streamingLine({ ts: "2026-08-14T10:00:00.000Z", usage: SNAPSHOT_A, usedPercentage: 4.1, totalInputTokens: 1, totalOutputTokens: 1 }) + "\n",
      "utf8",
    );
    const db = openMetricsDb(":memory:");
    ingestCursorUsageDirectory(db, dir);
    assert.equal(countRows(db, "turn"), 1);

    fs.appendFileSync(
      file,
      [
        streamingLine({ ts: "2026-08-14T10:00:10.000Z", usage: SNAPSHOT_A, usedPercentage: 4.2, totalInputTokens: 2, totalOutputTokens: 2 }),
        streamingLine({ ts: "2026-08-14T10:00:20.000Z", usage: SNAPSHOT_B, usedPercentage: 5.0, totalInputTokens: 3, totalOutputTokens: 3 }),
      ].join("\n") + "\n",
    );
    const second = ingestCursorUsageDirectory(db, dir);
    assert.equal(second.filesSkippedUnchanged, 0);
    assert.equal(second.turns, 2);
    assert.deepEqual(
      db.prepare("SELECT request_id FROM turn ORDER BY request_id").all().map((r) => r.request_id),
      [`cursor:${SESSION_ID}#1`, `cursor:${SESSION_ID}#3`],
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
