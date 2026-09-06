// codex-usage-ingest.test.mjs — Unit tests for codex-usage-ingest.mjs
//
// Fixtures are inline JSONL; tests never touch the real HOME or ~/.codex/sessions.
//
// Codex JSONL shape (four record types):
//   session_meta     — {timestamp, type:"session_meta",    payload:{id, cwd}}
//   turn_context     — {timestamp, type:"turn_context",    payload:{turn_id, model}}
//   token_usage_record — {timestamp, type:"token_usage_record", payload:{...usage...}}
//   event_msg        — {timestamp, type:"event_msg",       payload:{type:"token_count", ...}}

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  parseCodexUsageContent,
  ingestCodexUsageDirectory,
} from "./codex-usage-ingest.mjs";
import {
  openMetricsDb,
  countRows,
} from "./metrics-db.mjs";

// ---------------------------------------------------------------------------
// Fixture helpers — mirrors the real Codex JSONL shapes observed in the wild
// ---------------------------------------------------------------------------

const SESSION_ID = "session-alpha";
const CWD = "/work/example";

/** A session_meta line. */
function sessionMeta({ ts = "2026-09-05T10:00:00.000Z", id = SESSION_ID, cwd = CWD } = {}) {
  return { timestamp: ts, type: "session_meta", payload: { id, cwd } };
}

/** A turn_context line. */
function turnContext({ ts = "2026-09-05T10:00:01.000Z", turnId = "turn-a", model = "gpt-6-astra" } = {}) {
  return { timestamp: ts, type: "turn_context", payload: { turn_id: turnId, model } };
}

/**
 * A token_usage_record line.
 * The `usage` object carries the actual measured tokens.
 * `turn_token_usage` and `thread_token_usage` are cumulative and MUST be ignored.
 */
function tokenUsageRecord({
  ts = "2026-09-05T10:00:02.000Z",
  threadId = SESSION_ID,
  sessionId = SESSION_ID,
  turnId = "turn-a",
  responseId = "resp-a",
  usage = { input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 },
  turnTokenUsage,
  threadTokenUsage,
} = {}) {
  const payload = {
    thread_id: threadId,
    session_id: sessionId,
    turn_id: turnId,
    response_id: responseId,
    usage,
  };
  if (turnTokenUsage !== undefined) payload.turn_token_usage = turnTokenUsage;
  if (threadTokenUsage !== undefined) payload.thread_token_usage = threadTokenUsage;
  return { timestamp: ts, type: "token_usage_record", payload };
}

/** An event_msg line (e.g. legacy token_count). */
function eventMsgTokenCount({
  ts = "2026-09-05T10:00:02.001Z",
  inputTokens = 100,
  outputTokens = 20,
} = {}) {
  return {
    timestamp: ts,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        last_token_usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      },
    },
  };
}

/** Build a minimal valid file: session_meta + turn_context + token_usage_record. */
function buildBasicLines() {
  return [
    JSON.stringify(sessionMeta({})),
    JSON.stringify(turnContext({})),
    JSON.stringify(tokenUsageRecord({})),
  ].join("\n") + "\n";
}

/** Build a file that also includes an event_msg.token_count (legacy). */
function buildBasicWithLegacyLines() {
  return [
    JSON.stringify(sessionMeta({})),
    JSON.stringify(turnContext({})),
    JSON.stringify(tokenUsageRecord({})),
    JSON.stringify(eventMsgTokenCount({})),
  ].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// parseCodexUsageContent — basic parsing
// ---------------------------------------------------------------------------

describe("parseCodexUsageContent — basic parsing", () => {
  it("parses a token_usage_record and produces a turn with the codex: prefixed request_id", () => {
    const content = buildBasicLines();
    const result = parseCodexUsageContent(content);
    assert.equal(result.parseFailures, 0);
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].requestId, "codex:resp-a");
    assert.equal(result.turns[0].sessionId, SESSION_ID);
  });

  it("uses payload.session_id as the session ID when present", () => {
    const content = [
      JSON.stringify(sessionMeta({ id: "meta-session" })),
      JSON.stringify(turnContext({})),
      JSON.stringify(tokenUsageRecord({ sessionId: "payload-session", threadId: "thread-session" })),
    ].join("\n") + "\n";
    const result = parseCodexUsageContent(content);
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].sessionId, "payload-session");
  });

  it("falls back to payload.thread_id when session_id is absent", () => {
    const content = [
      JSON.stringify(sessionMeta({ id: "meta-session" })),
      JSON.stringify(turnContext({})),
      JSON.stringify(tokenUsageRecord({ sessionId: null, threadId: "fallback-thread" })),
    ].join("\n") + "\n";
    const result = parseCodexUsageContent(content);
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].sessionId, "fallback-thread");
  });

  it("falls back to session_meta.id when neither session_id nor thread_id present", () => {
    const content = [
      JSON.stringify(sessionMeta({ id: "meta-fallback" })),
      JSON.stringify(turnContext({})),
      JSON.stringify(tokenUsageRecord({ sessionId: null, threadId: null })),
    ].join("\n") + "\n";
    const result = parseCodexUsageContent(content);
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].sessionId, "meta-fallback");
  });
});

// ---------------------------------------------------------------------------
// parseCodexUsageContent — input normalization
// ---------------------------------------------------------------------------

describe("parseCodexUsageContent — input normalization", () => {
  it("normalizes input = input_tokens − cached_input_tokens − cache_write_input_tokens", () => {
    const content = buildBasicLines();
    const result = parseCodexUsageContent(content);
    // input_tokens=100, cached=60, cache_write=10 => normalized input = 30
    assert.equal(result.turns[0].input, 30);
    assert.equal(result.turns[0].cacheRead, 60);
    assert.equal(result.turns[0].cacheWrite, 10);
    assert.equal(result.turns[0].output, 20);
  });

  it("reasoning_output_tokens are already included in output, not added separately", () => {
    const content = buildBasicLines();
    const result = parseCodexUsageContent(content);
    // output_tokens=20, reasoning_output_tokens=5 — output stays 20
    assert.equal(result.turns[0].output, 20);
    assert.equal(result.turns.length, 1);
    // reasoning should not appear as a field on the turn at all
    assert.equal(result.turns[0].reasoning, undefined);
  });

  it("stores null input when cache breakdown is absent (not zero, not double-counted)", () => {
    const content = [
      JSON.stringify(sessionMeta({})),
      JSON.stringify(turnContext({})),
      JSON.stringify(tokenUsageRecord({
        usage: {
          input_tokens: 100,
          cached_input_tokens: undefined,
          cache_write_input_tokens: undefined,
          output_tokens: 20,
          total_tokens: 120,
        },
      })),
    ].join("\n") + "\n";
    const result = parseCodexUsageContent(content);
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].input, null);
    assert.equal(result.turns[0].cacheRead, null);
    assert.equal(result.turns[0].cacheWrite, null);
    assert.equal(result.turns[0].output, 20);
  });

  it("preserves explicit zeros — input_tokens=0 is stored as 0, not null", () => {
    const content = [
      JSON.stringify(sessionMeta({})),
      JSON.stringify(turnContext({})),
      JSON.stringify(tokenUsageRecord({
        usage: {
          input_tokens: 0,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
        },
      })),
    ].join("\n") + "\n";
    const result = parseCodexUsageContent(content);
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].input, 0);
    assert.equal(result.turns[0].cacheRead, 0);
    assert.equal(result.turns[0].cacheWrite, 0);
    assert.equal(result.turns[0].output, 0);
  });
});

// ---------------------------------------------------------------------------
// parseCodexUsageContent — invalid usage rejection
// ---------------------------------------------------------------------------

describe("parseCodexUsageContent — invalid usage rejection", () => {
  it("skips and counts a record with negative usage values", () => {
    const content = [
      JSON.stringify(sessionMeta({})),
      JSON.stringify(turnContext({})),
      JSON.stringify(tokenUsageRecord({
        responseId: "resp-neg",
        usage: { input_tokens: -1, output_tokens: 20, total_tokens: 19 },
      })),
    ].join("\n") + "\n";
    const result = parseCodexUsageContent(content);
    assert.equal(result.invalidUsageRecords, 1);
    assert.equal(result.turns.length, 0);
  });

  it("skips and counts a record with explicit null input (JSON-serialized NaN)", () => {
    const content = [
      JSON.stringify(sessionMeta({})),
      JSON.stringify(turnContext({})),
      JSON.stringify(tokenUsageRecord({
        responseId: "resp-nan",
        usage: { input_tokens: NaN, output_tokens: 20, total_tokens: 20 },
      })),
    ].join("\n") + "\n";
    const result = parseCodexUsageContent(content);
    assert.equal(result.invalidUsageRecords, 1);
    assert.equal(result.turns.length, 0);
  });

  it("skips and counts a record with non-integer usage (float)", () => {
    const content = [
      JSON.stringify(sessionMeta({})),
      JSON.stringify(turnContext({})),
      JSON.stringify(tokenUsageRecord({
        responseId: "resp-float",
        usage: { input_tokens: 1.5, output_tokens: 20, total_tokens: 21 },
      })),
    ].join("\n") + "\n";
    const result = parseCodexUsageContent(content);
    assert.equal(result.invalidUsageRecords, 1);
    assert.equal(result.turns.length, 0);
  });

  it("skips and counts when cache_read + cache_write > input_tokens", () => {
    const content = [
      JSON.stringify(sessionMeta({})),
      JSON.stringify(turnContext({})),
      JSON.stringify(tokenUsageRecord({
        responseId: "resp-overlap",
        usage: { input_tokens: 50, cached_input_tokens: 40, cache_write_input_tokens: 20, output_tokens: 10, total_tokens: 60 },
      })),
    ].join("\n") + "\n";
    const result = parseCodexUsageContent(content);
    assert.equal(result.invalidUsageRecords, 1);
    assert.equal(result.turns.length, 0);
  });

  it("allows cache_read + cache_write === input_tokens (fully cached is valid)", () => {
    const content = [
      JSON.stringify(sessionMeta({})),
      JSON.stringify(turnContext({})),
      JSON.stringify(tokenUsageRecord({
        responseId: "resp-full-cache",
        usage: { input_tokens: 100, cached_input_tokens: 70, cache_write_input_tokens: 30, output_tokens: 10, total_tokens: 110 },
      })),
    ].join("\n") + "\n";
    const result = parseCodexUsageContent(content);
    assert.equal(result.invalidUsageRecords, 0);
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].input, 0);
  });
});

// ---------------------------------------------------------------------------
// parseCodexUsageContent — event_msg legacy counting
// ---------------------------------------------------------------------------

describe("parseCodexUsageContent — event_msg legacy counting", () => {
  it("counts event_msg.token_count records as legacyTokenCountRecords, does not measure them", () => {
    const content = buildBasicWithLegacyLines();
    const result = parseCodexUsageContent(content);
    assert.equal(result.legacyTokenCountRecords, 1);
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].input, 30);
  });

  it("counts each event_msg.token_count even when repeated", () => {
    const content = [
      JSON.stringify(sessionMeta({})),
      JSON.stringify(turnContext({})),
      JSON.stringify(tokenUsageRecord({})),
      JSON.stringify(eventMsgTokenCount({ ts: "2026-09-05T10:00:03.000Z" })),
      JSON.stringify(eventMsgTokenCount({ ts: "2026-09-05T10:00:04.000Z" })),
    ].join("\n") + "\n";
    const result = parseCodexUsageContent(content);
    assert.equal(result.legacyTokenCountRecords, 2);
  });

  it("turns with different response_ids but identical usage each count as distinct turns", () => {
    const content = [
      JSON.stringify(sessionMeta({})),
      JSON.stringify(turnContext({ turnId: "turn-1" })),
      JSON.stringify(tokenUsageRecord({ responseId: "resp-1", turnId: "turn-1" })),
      JSON.stringify(turnContext({ ts: "2026-09-05T10:00:05.000Z", turnId: "turn-2" })),
      JSON.stringify(tokenUsageRecord({
        ts: "2026-09-05T10:00:06.000Z",
        responseId: "resp-2",
        turnId: "turn-2",
        usage: { input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 10, output_tokens: 20, total_tokens: 120 },
      })),
    ].join("\n") + "\n";
    const result = parseCodexUsageContent(content);
    assert.equal(result.turns.length, 2);
    assert.equal(result.turns[0].requestId, "codex:resp-1");
    assert.equal(result.turns[1].requestId, "codex:resp-2");
  });

  it("missing response_id skips with diagnostic count, no fake ID generated", () => {
    const content = [
      JSON.stringify(sessionMeta({})),
      JSON.stringify(turnContext({})),
      JSON.stringify(tokenUsageRecord({ responseId: null, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } })),
    ].join("\n") + "\n";
    const result = parseCodexUsageContent(content);
    assert.equal(result.turns.length, 0);
    // missing response_id should be counted as an invalid record (no usable request ID)
    assert.ok(result.invalidUsageRecords >= 1);
  });
});

// ---------------------------------------------------------------------------
// parseCodexUsageContent — dedup within a single file
// ---------------------------------------------------------------------------

describe("parseCodexUsageContent — dedup within a file", () => {
  it("deduplicates the same response_id within a single file", () => {
    const content = [
      JSON.stringify(sessionMeta({})),
      JSON.stringify(turnContext({})),
      JSON.stringify(tokenUsageRecord({ responseId: "resp-dup", ts: "2026-09-05T10:00:02.000Z" })),
      JSON.stringify(tokenUsageRecord({ responseId: "resp-dup", ts: "2026-09-05T10:00:03.000Z" })),
    ].join("\n") + "\n";
    const result = parseCodexUsageContent(content);
    assert.equal(result.duplicateRecords, 1);
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].requestId, "codex:resp-dup");
  });
});

// ---------------------------------------------------------------------------
// parseCodexUsageContent — model attribution
// ---------------------------------------------------------------------------

describe("parseCodexUsageContent — model attribution", () => {
  it("attributes the model from the matching turn_context.turn_id", () => {
    const content = [
      JSON.stringify(sessionMeta({})),
      JSON.stringify(turnContext({ turnId: "turn-a", model: "gpt-6-astra" })),
      JSON.stringify(tokenUsageRecord({ turnId: "turn-a", responseId: "resp-1" })),
    ].join("\n") + "\n";
    const result = parseCodexUsageContent(content);
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].model, "gpt-6-astra");
  });

  it("changes model attribution when turn_context switches model mid-session", () => {
    const content = [
      JSON.stringify(sessionMeta({})),
      JSON.stringify(turnContext({ ts: "2026-09-05T10:00:01.000Z", turnId: "turn-a", model: "gpt-6-astra" })),
      JSON.stringify(tokenUsageRecord({ ts: "2026-09-05T10:00:02.000Z", responseId: "resp-1", turnId: "turn-a" })),
      JSON.stringify(turnContext({ ts: "2026-09-05T10:00:03.000Z", turnId: "turn-b", model: "gpt-6-turbo" })),
      JSON.stringify(tokenUsageRecord({ ts: "2026-09-05T10:00:04.000Z", responseId: "resp-2", turnId: "turn-b" })),
    ].join("\n") + "\n";
    const result = parseCodexUsageContent(content);
    assert.equal(result.turns.length, 2);
    assert.equal(result.turns[0].model, "gpt-6-astra");
    assert.equal(result.turns[1].model, "gpt-6-turbo");
  });

  it("stores null model when no matching turn_context exists", () => {
    const content = [
      JSON.stringify(sessionMeta({})),
      JSON.stringify(tokenUsageRecord({ responseId: "resp-no-ctx", turnId: "turn-orphan" })),
    ].join("\n") + "\n";
    const result = parseCodexUsageContent(content);
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].model, null);
  });

  it("does not invent a default model", () => {
    const content = [
      JSON.stringify(sessionMeta({})),
      JSON.stringify(tokenUsageRecord({ responseId: "resp-no-ctx-2", turnId: "turn-orphan-2" })),
    ].join("\n") + "\n";
    const result = parseCodexUsageContent(content);
    assert.notEqual(result.turns[0].model, "default");
    assert.notEqual(result.turns[0].model, "unknown");
    assert.equal(result.turns[0].model, null);
  });
});

// ---------------------------------------------------------------------------
// parseCodexUsageContent — malformed input
// ---------------------------------------------------------------------------

describe("parseCodexUsageContent — malformed input", () => {
  it("counts malformed JSON lines as parseFailures and still parses subsequent valid records", () => {
    const content = [
      "{not valid json",
      JSON.stringify(sessionMeta({})),
      JSON.stringify(turnContext({})),
      JSON.stringify(tokenUsageRecord({ responseId: "resp-after-bad" })),
    ].join("\n") + "\n";
    const result = parseCodexUsageContent(content);
    assert.equal(result.parseFailures, 1);
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].requestId, "codex:resp-after-bad");
  });

  it("counts a token_usage_record with missing usage as invalid", () => {
    const content = [
      JSON.stringify(sessionMeta({})),
      JSON.stringify(turnContext({})),
      JSON.stringify({
        timestamp: "2026-09-05T10:00:02.000Z",
        type: "token_usage_record",
        payload: {
          session_id: SESSION_ID,
          turn_id: "turn-a",
          response_id: "resp-no-usage",
          // usage field absent
        },
      }),
    ].join("\n") + "\n";
    const result = parseCodexUsageContent(content);
    assert.equal(result.invalidUsageRecords, 1);
    assert.equal(result.turns.length, 0);
  });

  it("does not persist content or tool arguments on turn objects", () => {
    const content = buildBasicLines();
    const result = parseCodexUsageContent(content);
    const turn = result.turns[0];
    assert.equal(turn.content, undefined);
    assert.equal(turn.toolArguments, undefined);
    assert.equal(turn.textBytes, null);
    assert.equal(turn.thinkingBytes, null);
    assert.equal(turn.toolUseBytes, null);
  });

  it("older copied request_id not reassigned to a new session when the same response_id appears with a different session", () => {
    // The first occurrence wins; the second is a duplicate.
    const content = [
      JSON.stringify(sessionMeta({ id: "session-1" })),
      JSON.stringify(turnContext({})),
      JSON.stringify(tokenUsageRecord({ sessionId: "session-1", responseId: "resp-shared" })),
      JSON.stringify(tokenUsageRecord({ sessionId: "session-2", responseId: "resp-shared", ts: "2026-09-05T10:01:00.000Z" })),
    ].join("\n") + "\n";
    const result = parseCodexUsageContent(content);
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].sessionId, "session-1");
    assert.equal(result.duplicateRecords, 1);
  });
});

// ---------------------------------------------------------------------------
// parseCodexUsageContent — session timestamps
// ---------------------------------------------------------------------------

describe("parseCodexUsageContent — session timestamps", () => {
  it("records session timestamp range from session_meta and token_usage_record timestamps", () => {
    const content = [
      JSON.stringify(sessionMeta({ ts: "2026-09-05T09:00:00.000Z" })),
      JSON.stringify(turnContext({ ts: "2026-09-05T09:00:01.000Z" })),
      JSON.stringify(tokenUsageRecord({ ts: "2026-09-05T09:00:02.000Z", responseId: "resp-1" })),
      JSON.stringify(tokenUsageRecord({ ts: "2026-09-05T09:05:00.000Z", responseId: "resp-2", turnId: "turn-b" })),
    ].join("\n") + "\n";
    const result = parseCodexUsageContent(content);
    assert.equal(result.sessionMeta.length, 1);
    assert.equal(result.sessionMeta[0].sessionId, SESSION_ID);
    assert.equal(result.sessionMeta[0].firstTsMs, Date.parse("2026-09-05T09:00:00.000Z"));
    assert.equal(result.sessionMeta[0].lastTsMs, Date.parse("2026-09-05T09:05:00.000Z"));
  });
});

// ---------------------------------------------------------------------------
// ingestCodexUsageDirectory — basic walker behavior
// ---------------------------------------------------------------------------

function makeTempCodexDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-codex-usage-test-"));
}

describe("ingestCodexUsageDirectory", () => {
  it("ingests a codex usage file and writes turn and session rows to the DB", () => {
    const dir = makeTempCodexDir();
    fs.writeFileSync(path.join(dir, "session.jsonl"), buildBasicLines(), "utf8");

    const db = openMetricsDb(":memory:");
    const result = ingestCodexUsageDirectory(db, dir);
    assert.equal(result.filesScanned, 1);
    assert.equal(countRows(db, "turn"), 1);
    assert.equal(countRows(db, "session"), 1);

    const turn = db.prepare("SELECT * FROM turn WHERE request_id = ?").get("codex:resp-a");
    assert.equal(turn.session_id, SESSION_ID);
    assert.equal(turn.input, 30);
    assert.equal(turn.cache_read, 60);
    assert.equal(turn.cache_write, 10);
    assert.equal(turn.output, 20);
    assert.equal(turn.model, "gpt-6-astra");

    const sess = db.prepare("SELECT * FROM session WHERE session_id = ?").get(SESSION_ID);
    assert.ok(sess);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns a zeroed summary for a codex dir that does not exist", () => {
    const db = openMetricsDb(":memory:");
    const result = ingestCodexUsageDirectory(db, path.join(os.tmpdir(), "does-not-exist-codex-" + Date.now()));
    assert.equal(result.filesScanned, 0);
    assert.equal(result.turns, 0);
  });

  it("returns zeros for an existing empty directory", () => {
    const dir = makeTempCodexDir();
    const db = openMetricsDb(":memory:");
    const result = ingestCodexUsageDirectory(db, dir);
    assert.equal(result.filesScanned, 0);
    assert.equal(result.turns, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is idempotent — repeated ingest does not grow row counts", () => {
    const dir = makeTempCodexDir();
    fs.writeFileSync(path.join(dir, "session.jsonl"), buildBasicLines(), "utf8");

    const db = openMetricsDb(":memory:");
    ingestCodexUsageDirectory(db, dir);
    assert.equal(countRows(db, "turn"), 1);

    const second = ingestCodexUsageDirectory(db, dir);
    assert.equal(second.filesSkippedUnchanged, 1);
    assert.equal(countRows(db, "turn"), 1);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is idempotent even after the source_file skip-cache is cleared (correctness is PK)", () => {
    const dir = makeTempCodexDir();
    fs.writeFileSync(path.join(dir, "session.jsonl"), buildBasicLines(), "utf8");

    const db = openMetricsDb(":memory:");
    ingestCodexUsageDirectory(db, dir);
    assert.equal(countRows(db, "turn"), 1);

    db.exec("DELETE FROM source_file");
    const again = ingestCodexUsageDirectory(db, dir);
    assert.equal(again.filesSkippedUnchanged, 0);
    assert.equal(countRows(db, "turn"), 1);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("deduplicates the same response_id across two files sharing a session", () => {
    const dir = makeTempCodexDir();
    const fileA = [
      JSON.stringify(sessionMeta({ id: "s-cross" })),
      JSON.stringify(turnContext({ turnId: "t1", model: "gpt-6-astra" })),
      JSON.stringify(tokenUsageRecord({ sessionId: "s-cross", responseId: "resp-shared", turnId: "t1" })),
    ].join("\n") + "\n";
    const fileB = [
      JSON.stringify(tokenUsageRecord({ sessionId: "s-cross", responseId: "resp-shared", turnId: "t1", ts: "2026-09-05T10:01:00.000Z" })),
    ].join("\n") + "\n";
    fs.writeFileSync(path.join(dir, "part-a.jsonl"), fileA, "utf8");
    fs.writeFileSync(path.join(dir, "part-b.jsonl"), fileB, "utf8");

    const db = openMetricsDb(":memory:");
    ingestCodexUsageDirectory(db, dir);
    assert.equal(countRows(db, "turn"), 1);
    assert.equal(countRows(db, "session"), 1);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("changed/appended file adds only new requests on incremental ingest", () => {
    const dir = makeTempCodexDir();
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(file, buildBasicLines(), "utf8");

    const db = openMetricsDb(":memory:");
    ingestCodexUsageDirectory(db, dir);
    assert.equal(countRows(db, "turn"), 1);

    // Append a new record with a different response_id
    const appended = [
      JSON.stringify(turnContext({ ts: "2026-09-05T10:00:05.000Z", turnId: "turn-b", model: "gpt-6-turbo" })),
      JSON.stringify(tokenUsageRecord({
        ts: "2026-09-05T10:00:06.000Z",
        responseId: "resp-new",
        turnId: "turn-b",
        usage: { input_tokens: 50, cached_input_tokens: 20, cache_write_input_tokens: 5, output_tokens: 10, total_tokens: 60 },
      })),
    ].join("\n") + "\n";
    fs.appendFileSync(file, appended);

    const second = ingestCodexUsageDirectory(db, dir);
    assert.equal(second.filesSkippedUnchanged, 0);
    // The first turn from the original parse plus the new one from append
    assert.equal(countRows(db, "turn"), 2);

    const newTurn = db.prepare("SELECT * FROM turn WHERE request_id = ?").get("codex:resp-new");
    assert.ok(newTurn);
    assert.equal(newTurn.model, "gpt-6-turbo");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("scans *.jsonl files recursively in subdirectories", () => {
    const dir = makeTempCodexDir();
    const subdir = path.join(dir, "nested");
    fs.mkdirSync(subdir, { recursive: true });
    fs.writeFileSync(path.join(subdir, "deep.jsonl"), buildBasicLines(), "utf8");

    const db = openMetricsDb(":memory:");
    const result = ingestCodexUsageDirectory(db, dir);
    assert.equal(result.filesScanned, 1);
    assert.equal(countRows(db, "turn"), 1);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("scans *.jsonl files at the root directory level too", () => {
    const dir = makeTempCodexDir();
    fs.writeFileSync(path.join(dir, "root-file.jsonl"), buildBasicLines(), "utf8");

    const db = openMetricsDb(":memory:");
    const result = ingestCodexUsageDirectory(db, dir);
    assert.equal(result.filesScanned, 1);
    assert.equal(countRows(db, "turn"), 1);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("aggregates session timestamp range across files sharing a session_id", () => {
    const dir = makeTempCodexDir();
    const early = [
      JSON.stringify(sessionMeta({ ts: "2026-09-05T08:00:00.000Z", id: "s-range" })),
      JSON.stringify(turnContext({ ts: "2026-09-05T08:00:01.000Z", turnId: "t1" })),
      JSON.stringify(tokenUsageRecord({ ts: "2026-09-05T08:00:02.000Z", sessionId: "s-range", responseId: "resp-early", turnId: "t1" })),
    ].join("\n") + "\n";
    const late = [
      JSON.stringify(tokenUsageRecord({
        ts: "2026-09-05T12:00:00.000Z",
        sessionId: "s-range",
        responseId: "resp-late",
        turnId: "t2",
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      })),
    ].join("\n") + "\n";
    fs.writeFileSync(path.join(dir, "early.jsonl"), early, "utf8");
    fs.writeFileSync(path.join(dir, "late.jsonl"), late, "utf8");

    const db = openMetricsDb(":memory:");
    ingestCodexUsageDirectory(db, dir);

    const sess = db.prepare("SELECT first_ts_ms, last_ts_ms FROM session WHERE session_id = ?").get("s-range");
    assert.equal(sess.first_ts_ms, Date.parse("2026-09-05T08:00:00.000Z"));
    assert.equal(sess.last_ts_ms, Date.parse("2026-09-05T12:00:00.000Z"));
    assert.equal(countRows(db, "turn"), 2);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("preserves session timestamp range on incremental ingest (widens, never narrows)", () => {
    const dir = makeTempCodexDir();
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(
      file,
      JSON.stringify(sessionMeta({ ts: "2026-09-05T08:00:00.000Z", id: "s-incr" })) + "\n" +
      JSON.stringify(turnContext({ ts: "2026-09-05T08:00:01.000Z" })) + "\n" +
      JSON.stringify(tokenUsageRecord({ ts: "2026-09-05T08:00:02.000Z", sessionId: "s-incr", responseId: "resp-1" })) + "\n",
      "utf8",
    );

    const db = openMetricsDb(":memory:");
    ingestCodexUsageDirectory(db, dir);

    // Append a wider-range record
    fs.appendFileSync(
      file,
      JSON.stringify(tokenUsageRecord({
        ts: "2026-09-05T14:00:00.000Z",
        sessionId: "s-incr",
        responseId: "resp-2",
        turnId: "turn-b",
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      })) + "\n",
    );
    ingestCodexUsageDirectory(db, dir);

    const sess = db.prepare("SELECT first_ts_ms, last_ts_ms FROM session WHERE session_id = ?").get("s-incr");
    assert.equal(sess.first_ts_ms, Date.parse("2026-09-05T08:00:00.000Z"));
    assert.equal(sess.last_ts_ms, Date.parse("2026-09-05T14:00:00.000Z"));
    assert.equal(countRows(db, "turn"), 2);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("source_file cache key is distinct from Claude and Cursor keys", () => {
    const dir = makeTempCodexDir();
    fs.writeFileSync(path.join(dir, "session.jsonl"), buildBasicLines(), "utf8");

    const db = openMetricsDb(":memory:");
    ingestCodexUsageDirectory(db, dir);

    // Source file should be recorded with a codex-specific key suffix
    const sf = db.prepare("SELECT path FROM source_file").get();
    assert.ok(sf, "source_file row must exist");
    assert.ok(sf.path.includes("codex"), "source_file path must contain 'codex' suffix to be distinct from Claude/Cursor");
    // Must NOT match cursor-usage key pattern
    assert.ok(!sf.path.includes("#cu-v"), "must not use cursor-usage key suffix");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("preserves legacyTokenCountRecords in walker summary", () => {
    const dir = makeTempCodexDir();
    fs.writeFileSync(path.join(dir, "session.jsonl"), buildBasicWithLegacyLines(), "utf8");

    const db = openMetricsDb(":memory:");
    const result = ingestCodexUsageDirectory(db, dir);
    assert.equal(result.legacyTokenCountRecords, 1);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
