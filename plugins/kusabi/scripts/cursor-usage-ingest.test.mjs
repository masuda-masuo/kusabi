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
import { openMetricsDb, countRows } from "./metrics-db.mjs";

const SESSION_ID = "d73008ab-1111-2222-3333-444444444444";
const CWD = "/home/user/proj";

function usageRecord({
  sessionId = SESSION_ID,
  ts,
  cwd = CWD,
  modelId = "default",
  currentUsage,
  contextWindow,
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
      total_output_tokens: currentUsage ? 10 : null,
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
