// transcript-ingest.test.mjs — Unit tests for transcript-ingest.mjs
//
// The real fixture referenced by the original brief
// (.fixtures-real/03b6b1c4-e326-41be-b29c-dabba9988e3b.jsonl) was not
// present in this container when this PR was written (the directory
// existed but was empty).  The ground-truth numbers below come from the
// brief itself ("computed on the host"); this file reconstructs a
// synthetic transcript engineered to reproduce those exact numbers, so the
// dedup-by-requestId regression guard is still testable byte-for-byte.
//
// Construction: a single API request/turn is represented by several
// top-level `type:"assistant"` JSONL records sharing one `requestId`, each
// carrying an identical `message.usage` (this is hazard 1 from the brief).
// 31 total assistant records / 16 turns forces exactly 15 turns with 2
// records and 1 turn with a single record (2*15 + 1 = 31) — verified by
// the arithmetic below.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseTranscriptContent, ingestTranscriptDirectory } from "./transcript-ingest.mjs";
import { openMetricsDb, upsertTurn, countRows } from "./metrics-db.mjs";

const SESSION_ID = "03b6b1c4-e326-41be-b29c-dabba9988e3b";

function assistantRecord({ requestId, content, usage, model = "claude-sonnet-5", ts, isSidechain = false }) {
  return {
    type: "assistant",
    sessionId: SESSION_ID,
    cwd: "/workspace",
    gitBranch: "main",
    isSidechain,
    timestamp: ts,
    requestId,
    message: {
      role: "assistant",
      model,
      content,
      usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        cache_read_input_tokens: usage.cacheRead,
        cache_creation_input_tokens: usage.cacheWrite,
      },
    },
  };
}

/**
 * Build the ground-truth transcript: 15 turns with 2 assistant records each
 * (thinking block then text block, both carrying the same usage) plus 1
 * turn with a single record — 31 records / 16 turns total.
 *
 * Dedup (per-turn) totals: input=12622, output=4843, cacheRead=892530,
 * cacheWrite=34545 — all model claude-sonnet-5.
 * Non-dedup (summed over all 31 records) totals: output=9618, cacheRead=1731698.
 */
function buildGroundTruthLines() {
  const dupOutputs = [300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 575];
  const dupCacheReads = [55000, 55000, 55000, 55000, 55000, 55000, 55000, 55000, 55000, 55000, 55000, 55000, 55000, 55000, 69168];
  const dupInputs = new Array(15).fill(750);
  const dupCacheWrites = new Array(15).fill(2000);

  const lines = [];
  let ts = Date.parse("2026-07-26T10:00:00.000Z");

  for (let i = 0; i < 15; i++) {
    const requestId = `req-${String(i + 1).padStart(2, "0")}`;
    const usage = { input: dupInputs[i], output: dupOutputs[i], cacheRead: dupCacheReads[i], cacheWrite: dupCacheWrites[i] };
    lines.push(JSON.stringify(assistantRecord({
      requestId,
      content: [{ type: "thinking", thinking: "reasoning about the change" }],
      usage,
      ts: new Date(ts).toISOString(),
    })));
    ts += 1000;
    lines.push(JSON.stringify(assistantRecord({
      requestId,
      content: [{ type: "text", text: "here is the result" }],
      usage,
      ts: new Date(ts).toISOString(),
    })));
    ts += 2000;
  }

  // 16th turn: single record.
  lines.push(JSON.stringify(assistantRecord({
    requestId: "req-16",
    content: [{ type: "text", text: "final short turn" }],
    usage: { input: 1372, output: 68, cacheRead: 53362, cacheWrite: 4545 },
    ts: new Date(ts).toISOString(),
  })));

  return lines.join("\n") + "\n";
}

describe("parseTranscriptContent — dedup ground truth (regression guard)", () => {
  it("matches the exact numbers computed on the host for the reference transcript", () => {
    const content = buildGroundTruthLines();
    const result = parseTranscriptContent(content);

    assert.equal(result.assistantRecordCount, 31);
    assert.equal(result.syntheticRecordCount, 0);
    assert.equal(result.turns.length, 16);
    assert.equal(result.parseFailures, 0);

    const dedupInput = result.turns.reduce((s, t) => s + (t.input || 0), 0);
    const dedupOutput = result.turns.reduce((s, t) => s + (t.output || 0), 0);
    const dedupCacheRead = result.turns.reduce((s, t) => s + (t.cacheRead || 0), 0);
    const dedupCacheWrite = result.turns.reduce((s, t) => s + (t.cacheWrite || 0), 0);

    assert.equal(dedupInput, 12622);
    assert.equal(dedupOutput, 4843);
    assert.equal(dedupCacheRead, 892530);
    assert.equal(dedupCacheWrite, 34545);

    const byModel = {};
    for (const t of result.turns) byModel[t.model] = (byModel[t.model] || 0) + 1;
    assert.deepEqual(byModel, { "claude-sonnet-5": 16 });
  });

  it("the WRONG (no-dedup) sums are what this fixture is designed to diverge from", () => {
    // This test documents the trap this module exists to avoid: summing
    // usage across every assistant RECORD (rather than deduping by
    // requestId) overcounts output and cacheRead by roughly 2x here.
    const content = buildGroundTruthLines();
    let wrongOutput = 0;
    let wrongCacheRead = 0;
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line);
      if (rec.type !== "assistant") continue;
      wrongOutput += rec.message.usage.output_tokens;
      wrongCacheRead += rec.message.usage.cache_read_input_tokens;
    }
    assert.equal(wrongOutput, 9618);
    assert.equal(wrongCacheRead, 1731698);
  });
});

describe("parseTranscriptContent — synthetic records", () => {
  it("excludes <synthetic> model records from usage totals but still counts them", () => {
    const lines = [
      JSON.stringify(assistantRecord({
        requestId: "req-real",
        content: [{ type: "text", text: "ok" }],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        ts: "2026-07-26T10:00:00.000Z",
      })),
      JSON.stringify(assistantRecord({
        requestId: "req-synth",
        content: [{ type: "text", text: "" }],
        usage: { input: 999, output: 999, cacheRead: 999, cacheWrite: 999 },
        model: "<synthetic>",
        ts: "2026-07-26T10:01:00.000Z",
      })),
    ];
    const result = parseTranscriptContent(lines.join("\n"));

    assert.equal(result.assistantRecordCount, 2);
    assert.equal(result.syntheticRecordCount, 1);
    assert.equal(result.turns.length, 2);

    const synthTurn = result.turns.find((t) => t.requestId === "req-synth");
    assert.equal(synthTurn.isSynthetic, true);
    // Never coerced to 0 — a synthetic record's usage is meaningless.
    assert.equal(synthTurn.input, null);
    assert.equal(synthTurn.output, null);
    assert.equal(synthTurn.cacheRead, null);
    assert.equal(synthTurn.cacheWrite, null);

    const realTurn = result.turns.find((t) => t.requestId === "req-real");
    assert.equal(realTurn.isSynthetic, false);
    assert.equal(realTurn.input, 10);
  });
});

describe("parseTranscriptContent — malformed input", () => {
  it("skips an unparseable JSON line and counts it, without throwing", () => {
    const lines = [
      "{not valid json",
      JSON.stringify(assistantRecord({
        requestId: "req-1",
        content: [{ type: "text", text: "fine" }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        ts: "2026-07-26T10:00:00.000Z",
      })),
    ];
    const result = parseTranscriptContent(lines.join("\n"));
    assert.equal(result.parseFailures, 1);
    assert.equal(result.turns.length, 1);
  });

  it("skips an assistant record with no requestId — counted as noRequestIdCount, NOT parseFailures", () => {
    // The JSON itself is perfectly valid; the record is simply unusable for
    // dedup.  Real-corpus review found this was previously conflated with
    // genuine corruption (parseFailures), which made "0 bytes lost" and
    // "N records skipped for a structural reason" look identical.
    const rec = assistantRecord({
      requestId: "whatever",
      content: [{ type: "text", text: "x" }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      ts: "2026-07-26T10:00:00.000Z",
    });
    delete rec.requestId;
    const result = parseTranscriptContent(JSON.stringify(rec));
    assert.equal(result.parseFailures, 0);
    assert.equal(result.noRequestIdCount, 1);
    assert.equal(result.turns.length, 0);
    // Still counted as an assistant record seen, just unusable for dedup.
    assert.equal(result.assistantRecordCount, 1);
  });

  it("keeps parseFailures and noRequestIdCount as fully independent counters", () => {
    const noIdRec = assistantRecord({
      requestId: "x",
      content: [{ type: "text", text: "x" }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      ts: "2026-07-26T10:00:00.000Z",
    });
    delete noIdRec.requestId;
    const lines = ["{also not valid json", JSON.stringify(noIdRec)];
    const result = parseTranscriptContent(lines.join("\n"));
    assert.equal(result.parseFailures, 1);
    assert.equal(result.noRequestIdCount, 1);
  });

  it("counts a <synthetic> record with no requestId in BOTH syntheticRecordCount and noRequestIdCount (documented overlap, not double-counted as a failure)", () => {
    const rec = {
      type: "assistant",
      sessionId: SESSION_ID,
      timestamp: "2026-07-26T10:00:00.000Z",
      message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "" }], usage: {} },
    };
    // No requestId at all, matching what the real corpus review found.
    const result = parseTranscriptContent(JSON.stringify(rec));
    assert.equal(result.syntheticRecordCount, 1);
    assert.equal(result.noRequestIdCount, 1);
    assert.equal(result.parseFailures, 0);
    assert.equal(result.turns.length, 0);
  });

  it("handles an empty records file with no assistant lines", () => {
    const result = parseTranscriptContent("");
    assert.equal(result.assistantRecordCount, 0);
    assert.equal(result.turns.length, 0);
    assert.equal(result.parseFailures, 0);
    assert.equal(result.noRequestIdCount, 0);
  });
});

describe("parseTranscriptContent — session metadata", () => {
  it("derives first/last timestamps and cwd/gitBranch from any record", () => {
    const lines = [
      JSON.stringify({ type: "user", sessionId: SESSION_ID, cwd: "/workspace", gitBranch: "main", timestamp: "2026-07-26T09:00:00.000Z" }),
      JSON.stringify(assistantRecord({
        requestId: "req-1",
        content: [{ type: "text", text: "hi" }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        ts: "2026-07-26T09:05:00.000Z",
      })),
    ];
    const result = parseTranscriptContent(lines.join("\n"));
    assert.equal(result.sessionMeta.sessionId, SESSION_ID);
    assert.equal(result.sessionMeta.cwd, "/workspace");
    assert.equal(result.sessionMeta.gitBranch, "main");
    assert.equal(result.sessionMeta.firstTsMs, Date.parse("2026-07-26T09:00:00.000Z"));
    assert.equal(result.sessionMeta.lastTsMs, Date.parse("2026-07-26T09:05:00.000Z"));
  });
});

// ---------------------------------------------------------------------------
// ingestTranscriptDirectory — filesystem + database integration
// ---------------------------------------------------------------------------

function makeTempTranscriptDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-transcript-test-"));
}

describe("ingestTranscriptDirectory", () => {
  it("walks project-slug subdirectories, ingests turns, and skips unchanged files on re-run", () => {
    const dir = makeTempTranscriptDir();
    const projectDir = path.join(dir, "-home-user-project");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "session-a.jsonl"), buildGroundTruthLines(), "utf8");

    const db = openMetricsDb(":memory:");

    const first = ingestTranscriptDirectory(db, dir);
    assert.equal(first.filesScanned, 1);
    assert.equal(first.filesSkippedUnchanged, 0);
    assert.equal(first.sessions, 1);
    assert.equal(first.turns, 16);
    assert.equal(first.assistantRecords, 31);
    assert.equal(countRows(db, "turn"), 16);
    assert.equal(countRows(db, "session"), 1);

    const second = ingestTranscriptDirectory(db, dir);
    assert.equal(second.filesScanned, 1);
    assert.equal(second.filesSkippedUnchanged, 1);
    // Re-running must not duplicate or drop rows.
    assert.equal(countRows(db, "turn"), 16);
    assert.equal(countRows(db, "session"), 1);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns a zeroed summary for a transcript dir that does not exist", () => {
    const db = openMetricsDb(":memory:");
    const result = ingestTranscriptDirectory(db, path.join(os.tmpdir(), "does-not-exist-" + Date.now()));
    assert.equal(result.filesScanned, 0);
    assert.equal(result.turns, 0);
  });

  // -------------------------------------------------------------------------
  // Regression fixture for defects 1 and 3, found only by ingesting the real
  // corpus: a session spanning two files (Claude Code copies earlier
  // records forward on resume/fork), sharing one requestId between them.
  // A single-file synthetic fixture cannot exercise this — it structurally
  // has nothing to dedup or aggregate ACROSS files.
  // -------------------------------------------------------------------------
  it("dedups turns and aggregates session first/last timestamps ACROSS files sharing a sessionId (defects 1 & 3)", () => {
    const dir = makeTempTranscriptDir();
    const projectDir = path.join(dir, "-home-user-project");
    fs.mkdirSync(projectDir, { recursive: true });

    const sessionId = "shared-session-abc";
    const sharedUsage = { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 };

    // File A: the "original" — req-shared plus req-a-only. Range 09:00–09:05.
    const fileA = [
      JSON.stringify({
        type: "assistant", sessionId, cwd: "/workspace", gitBranch: "main", isSidechain: false,
        timestamp: "2026-07-26T09:00:00.000Z", requestId: "req-shared",
        message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "first" }], usage: {
          input_tokens: sharedUsage.input, output_tokens: sharedUsage.output,
          cache_read_input_tokens: sharedUsage.cacheRead, cache_creation_input_tokens: sharedUsage.cacheWrite,
        } },
      }),
      JSON.stringify({
        type: "assistant", sessionId, cwd: "/workspace", gitBranch: "main", isSidechain: false,
        timestamp: "2026-07-26T09:05:00.000Z", requestId: "req-a-only",
        message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "a-only" }], usage: {
          input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
        } },
      }),
    ].join("\n") + "\n";

    // File B: the resumed/forked session — copies req-shared forward
    // (same requestId, same usage, verbatim per the brief's description of
    // how Claude Code forks sessions) plus a genuinely new turn at 09:20,
    // extending the true session range past what file A alone shows.
    const fileB = [
      JSON.stringify({
        type: "assistant", sessionId, cwd: "/workspace", gitBranch: "main", isSidechain: false,
        timestamp: "2026-07-26T09:00:00.000Z", requestId: "req-shared",
        message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "first" }], usage: {
          input_tokens: sharedUsage.input, output_tokens: sharedUsage.output,
          cache_read_input_tokens: sharedUsage.cacheRead, cache_creation_input_tokens: sharedUsage.cacheWrite,
        } },
      }),
      JSON.stringify({
        type: "assistant", sessionId, cwd: "/workspace", gitBranch: "main", isSidechain: false,
        timestamp: "2026-07-26T09:20:00.000Z", requestId: "req-b-only",
        message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "b-only" }], usage: {
          input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
        } },
      }),
    ].join("\n") + "\n";

    fs.writeFileSync(path.join(projectDir, "session-file-a.jsonl"), fileA, "utf8");
    fs.writeFileSync(path.join(projectDir, "session-file-b.jsonl"), fileB, "utf8");

    const db = openMetricsDb(":memory:");
    const result = ingestTranscriptDirectory(db, dir);

    // Defect 1: 3 distinct requestIds across both files (req-shared,
    // req-a-only, req-b-only), NOT 2+2=4 (the per-file-summed bug).
    assert.equal(result.turns, 3);
    assert.equal(countRows(db, "turn"), result.turns, "printed turns must equal the actual table row count");

    // Defect 3: one session, not two (one per file).
    assert.equal(result.sessions, 1);
    assert.equal(countRows(db, "session"), 1);

    // Defect 3, the sharper half: first_ts/last_ts must be the TRUE range
    // across both files (09:00–09:20), not whichever file wrote last.
    const row = db.prepare("SELECT first_ts_ms, last_ts_ms FROM session WHERE session_id = ?").get(sessionId);
    assert.equal(row.first_ts_ms, Date.parse("2026-07-26T09:00:00.000Z"));
    assert.equal(row.last_ts_ms, Date.parse("2026-07-26T09:20:00.000Z"));

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("widens (never narrows) a session's stored range across incremental runs, even when only one of its files is re-scanned", () => {
    const dir = makeTempTranscriptDir();
    const projectDir = path.join(dir, "-home-user-project");
    fs.mkdirSync(projectDir, { recursive: true });
    const sessionId = "incremental-session";

    const makeRecord = (requestId, ts) => JSON.stringify({
      type: "assistant", sessionId, cwd: "/workspace", gitBranch: "main", isSidechain: false,
      timestamp: ts, requestId,
      message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "x" }], usage: {
        input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      } },
    });

    fs.writeFileSync(path.join(projectDir, "early.jsonl"), makeRecord("req-early", "2026-07-26T08:00:00.000Z") + "\n", "utf8");

    const db = openMetricsDb(":memory:");
    ingestTranscriptDirectory(db, dir); // ingests "early" only, range 08:00–08:00

    // A second file for the SAME session appears later, extending later.
    fs.writeFileSync(path.join(projectDir, "later.jsonl"), makeRecord("req-later", "2026-07-26T10:00:00.000Z") + "\n", "utf8");
    ingestTranscriptDirectory(db, dir); // "early.jsonl" is now unchanged and skipped; only "later.jsonl" is scanned

    const row = db.prepare("SELECT first_ts_ms, last_ts_ms FROM session WHERE session_id = ?").get(sessionId);
    // The true range must still be 08:00–10:00, even though "early.jsonl"
    // was not re-read on the second run.
    assert.equal(row.first_ts_ms, Date.parse("2026-07-26T08:00:00.000Z"));
    assert.equal(row.last_ts_ms, Date.parse("2026-07-26T10:00:00.000Z"));

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("counts an unreadable file under ioFailures, distinct from parseFailures", () => {
    const dir = makeTempTranscriptDir();
    const projectDir = path.join(dir, "-home-user-project");
    fs.mkdirSync(projectDir, { recursive: true });
    const brokenPath = path.join(projectDir, "broken.jsonl");
    fs.writeFileSync(brokenPath, "irrelevant — permissions make it unreadable", "utf8");
    fs.chmodSync(brokenPath, 0o000); // readFileSync throws EACCES: a whole-file I/O failure, not a line-level one.
    fs.writeFileSync(path.join(projectDir, "good.jsonl"), buildGroundTruthLines(), "utf8");

    const db = openMetricsDb(":memory:");
    const result = ingestTranscriptDirectory(db, dir);
    assert.equal(result.filesScanned, 2);
    assert.equal(result.ioFailures, 1);
    assert.equal(result.parseFailures, 0);
    // The readable file's data must still land normally.
    assert.equal(result.turns, 16);

    fs.chmodSync(brokenPath, 0o644);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("idempotency is a PRIMARY KEY property, not a skip-cache property", () => {
  it("upserting the same turn row twice directly (bypassing the skip cache) yields one row", () => {
    const db = openMetricsDb(":memory:");
    const row = {
      requestId: "req-fixed",
      sessionId: SESSION_ID,
      ts: "2026-07-26T10:00:00.000Z",
      tsMs: Date.parse("2026-07-26T10:00:00.000Z"),
      model: "claude-sonnet-5",
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      isSidechain: 0,
      isSynthetic: 0,
      textBytes: 4,
      thinkingBytes: 0,
      toolUseBytes: 0,
    };
    upsertTurn(db, row);
    upsertTurn(db, row);
    upsertTurn(db, row);
    assert.equal(countRows(db, "turn"), 1);
  });
});
