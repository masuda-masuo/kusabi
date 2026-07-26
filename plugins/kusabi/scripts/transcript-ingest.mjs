// transcript-ingest.mjs — parse Claude Code transcript *.jsonl files into
// turn/session rows, and a directory walker that feeds them into the
// metrics store.
//
// Kept split on purpose: `parseTranscriptContent` is a pure function (a
// string in, structured turns out) so it is unit-testable with inline
// fixtures and no files on disk.  `ingestTranscriptDirectory` is the only
// piece that touches the filesystem or the database, and it delegates every
// row write to metrics-db.mjs's upsert* helpers — it never opens a database
// itself (see metrics-db.mjs header).
//
// ---------------------------------------------------------------------------
// Hazard 1 (the big one) — usage is duplicated verbatim across content
// blocks.  A single API request/turn emits several `type:"assistant"`
// records in the transcript — one per content block (thinking, text,
// tool_use, and one per additional tool_use) — and every one of them
// carries an identical copy of `message.usage`.  Summing usage across all
// assistant records overcounts input/output/cache tokens by roughly
// 2-3.5x while looking entirely plausible.
//
// The fix: group assistant records by their top-level `requestId`.  Only
// the FIRST record seen for a given requestId contributes its
// `message.usage` numbers to the turn; every record (first and later)
// contributes its own content-block byte counts (text/thinking/tool_use),
// since those genuinely differ block to block.
//
// Hazard 2 — synthetic records.  `message.model === "<synthetic>"` marks a
// placeholder record (cancellation, error) with no real usage.  These are
// excluded from usage totals (stored as NULL, not 0) but still produce a
// turn row with `isSynthetic: true` so they can be counted separately.
//
// Hazard 7 (found by review against the real corpus) — "one file == one
// session" is false.  Claude Code copies earlier records forward into a new
// file on resume/fork, so a single sessionId can legitimately span more
// than one *.jsonl file.  Two consequences this module has to get right:
//
//   1. The SAME requestId can appear in more than one file.  Turn dedup
//      must therefore happen across the whole directory walk, not
//      per-file — a `turns` count that sums each file's own dedup count
//      overcounts by the number of requestIds that recur across files.
//      (The `turn` table itself is not corrupted by this: its PRIMARY KEY
//      on request_id already collapses re-upserts from a later file onto
//      the same row. Only a per-file-summed *count* was wrong.)
//
//   2. Session metadata (first/last timestamp, cwd, gitBranch) must be
//      AGGREGATED across every file that shares a sessionId — first_ts as
//      the min, last_ts as the max — not upserted once per file. Upserting
//      per file with `INSERT OR REPLACE` means whichever file is processed
//      last silently overwrites the true range with one arbitrary
//      fragment of it, which is corruption in a column a follow-up PR will
//      range-query. The fix also merges with whatever is already stored
//      for that sessionId (via metrics-db.mjs's `getSession`), so the true
//      range keeps widening correctly across incremental runs even when
//      the skip-unchanged cache means not every file for a session is
//      re-read every time.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import {
  upsertSession,
  getSession,
  upsertTurn,
  upsertSourceFile,
  isSourceFileUnchanged,
} from "./metrics-db.mjs";

function byteLen(str) {
  return typeof str === "string" ? Buffer.byteLength(str, "utf8") : 0;
}

/**
 * Parse the full text of one Claude Code transcript `*.jsonl` file into
 * turn rows plus session-level metadata for THIS FILE ONLY.
 *
 * Pure — no filesystem access.  Turn dedup by requestId happens within
 * this one file's lines; cross-file dedup (hazard 7) is the caller's job,
 * since only the caller sees more than one file.
 *
 * Three distinct failure/skip counters are returned, kept separate on
 * purpose (an earlier version of this module conflated them under one
 * `parseFailures`, which made "0 bytes lost to corruption" and "a whole
 * file's worth of records skipped" look identical in the summary):
 *
 *  - `parseFailures` — a line that is not valid JSON, or parses to
 *    something that is not an object.  Genuine corrupt data.
 *  - `noRequestIdCount` — a `type:"assistant"` record with no usable
 *    `requestId`.  Not corruption: these are typically `<synthetic>`
 *    placeholder records (see hazard 2) that were never assigned one, so
 *    they cannot be deduplicated safely and are left out of `turns`.
 *  - `syntheticRecordCount` — records with `message.model === "<synthetic>"`,
 *    counted regardless of whether they had a requestId. This OVERLAPS
 *    with `noRequestIdCount` in practice (most synthetic records lack a
 *    requestId) — it is not an additional, disjoint population.
 *
 * I/O failures (the file itself could not be stat'd or read) are NOT this
 * function's concern — those never reach here, since this function only
 * receives content already read from disk. See `ingestTranscriptDirectory`.
 *
 * @param {string} content  Raw file content (one JSON object per line).
 * @returns {{
 *   turns: Array<object>,
 *   sessionMeta: { sessionId: string|null, cwd: string|null, gitBranch: string|null,
 *                  firstTsMs: number|null, lastTsMs: number|null },
 *   assistantRecordCount: number,
 *   syntheticRecordCount: number,
 *   parseFailures: number,
 *   noRequestIdCount: number,
 * }}
 */
export function parseTranscriptContent(content) {
  const byRequestId = new Map();
  const order = [];

  let assistantRecordCount = 0;
  let syntheticRecordCount = 0;
  let parseFailures = 0;
  let noRequestIdCount = 0;

  let sessionId = null;
  let cwd = null;
  let gitBranch = null;
  let firstTsMs = null;
  let lastTsMs = null;

  const lines = typeof content === "string" ? content.split("\n") : [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      parseFailures += 1;
      continue;
    }
    if (!rec || typeof rec !== "object") {
      parseFailures += 1;
      continue;
    }

    // Session-level metadata is opportunistic: any record in the file may
    // carry it.  This is per-FILE metadata only — a file is not assumed to
    // be a whole session (hazard 7); the caller aggregates across files
    // that share a sessionId.
    if (typeof rec.sessionId === "string" && rec.sessionId) sessionId = rec.sessionId;
    if (typeof rec.cwd === "string" && rec.cwd) cwd = rec.cwd;
    if (typeof rec.gitBranch === "string" && rec.gitBranch) gitBranch = rec.gitBranch;
    if (typeof rec.timestamp === "string") {
      const ms = Date.parse(rec.timestamp);
      if (Number.isFinite(ms)) {
        if (firstTsMs === null || ms < firstTsMs) firstTsMs = ms;
        if (lastTsMs === null || ms > lastTsMs) lastTsMs = ms;
      }
    }

    if (rec.type !== "assistant") continue;
    assistantRecordCount += 1;

    const message = (rec.message && typeof rec.message === "object") ? rec.message : {};
    const isSynthetic = message.model === "<synthetic>";
    if (isSynthetic) syntheticRecordCount += 1;

    const requestId = typeof rec.requestId === "string" && rec.requestId ? rec.requestId : null;
    if (!requestId) {
      // Cannot dedup a record with no requestId — skip it rather than
      // guessing at a key (a guessed key risks silent double-counting of
      // the very usage duplication this module exists to prevent).  Not a
      // parse failure: the JSON was fine, the record is just unusable for
      // per-turn accounting (see the doc comment above).
      noRequestIdCount += 1;
      continue;
    }

    let turn = byRequestId.get(requestId);
    if (!turn) {
      const ts = typeof rec.timestamp === "string" ? rec.timestamp : null;
      turn = {
        requestId,
        sessionId: typeof rec.sessionId === "string" ? rec.sessionId : sessionId,
        ts,
        tsMs: ts ? Date.parse(ts) : null,
        model: typeof message.model === "string" ? message.model : null,
        isSidechain: rec.isSidechain === true,
        isSynthetic,
        // Usage fields default to null (absent), not 0 — a synthetic
        // record's usage is meaningless and must not be coerced to zero.
        input: null,
        output: null,
        cacheRead: null,
        cacheWrite: null,
        textBytes: 0,
        thinkingBytes: 0,
        toolUseBytes: 0,
      };
      if (Number.isNaN(turn.tsMs)) turn.tsMs = null;

      if (!isSynthetic && message.usage && typeof message.usage === "object") {
        const u = message.usage;
        if (typeof u.input_tokens === "number") turn.input = u.input_tokens;
        if (typeof u.output_tokens === "number") turn.output = u.output_tokens;
        if (typeof u.cache_read_input_tokens === "number") turn.cacheRead = u.cache_read_input_tokens;
        if (typeof u.cache_creation_input_tokens === "number") turn.cacheWrite = u.cache_creation_input_tokens;
      }

      byRequestId.set(requestId, turn);
      order.push(requestId);
    }

    // Content-block byte accounting: every record for this requestId
    // (first or duplicate) contributes its own blocks — these are NOT
    // duplicated the way usage is.
    const blocks = Array.isArray(message.content) ? message.content : [];
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") {
        turn.textBytes += byteLen(block.text);
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        turn.thinkingBytes += byteLen(block.thinking);
      } else if (block.type === "tool_use") {
        turn.toolUseBytes += byteLen(JSON.stringify(block.input ?? {}));
      }
    }
  }

  return {
    turns: order.map((id) => byRequestId.get(id)),
    sessionMeta: { sessionId, cwd, gitBranch, firstTsMs, lastTsMs },
    assistantRecordCount,
    syntheticRecordCount,
    parseFailures,
    noRequestIdCount,
  };
}

/**
 * Recursively collect every `*.jsonl` path under `dir`, along with the
 * project slug (first path segment under `dir`) each belongs to.
 *
 * @param {string} dir
 * @returns {Array<{ filePath: string, projectSlug: string }>}
 */
function walkJsonlFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const topEntries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue;
    const projectSlug = entry.name;
    const projectDir = path.join(dir, projectSlug);

    const stack = [projectDir];
    while (stack.length > 0) {
      const current = stack.pop();
      let children;
      try {
        children = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        const childPath = path.join(current, child.name);
        if (child.isDirectory()) {
          stack.push(childPath);
        } else if (child.isFile() && child.name.endsWith(".jsonl")) {
          results.push({ filePath: childPath, projectSlug });
        }
      }
    }
  }
  return results;
}

function minOrNull(a, b) {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return Math.min(a, b);
}

function maxOrNull(a, b) {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return Math.max(a, b);
}

/**
 * Merge one file's session metadata into a running aggregate for the same
 * sessionId — widening the timestamp range (min of firsts, max of lasts)
 * rather than replacing it.  `incoming` wins ties on cwd/gitBranch (prefers
 * the most recently merged non-null value); either side may be null.
 *
 * @param {object|null} existing
 * @param {object} incoming
 * @returns {object}
 */
function mergeSessionMeta(existing, incoming) {
  if (!existing) return { ...incoming };
  return {
    projectSlug: existing.projectSlug ?? incoming.projectSlug ?? null,
    firstTsMs: minOrNull(existing.firstTsMs, incoming.firstTsMs),
    lastTsMs: maxOrNull(existing.lastTsMs, incoming.lastTsMs),
    cwd: incoming.cwd ?? existing.cwd ?? null,
    gitBranch: incoming.gitBranch ?? existing.gitBranch ?? null,
  };
}

/**
 * Walk `transcriptDir` (default `~/.claude/projects`) for `*.jsonl` files,
 * parse each with `parseTranscriptContent`, and upsert session/turn rows
 * into `db`.  Unchanged files (same size + mtime as a prior ingest) are
 * skipped as a speed optimisation only — this never affects correctness,
 * since every row write below goes through a PRIMARY KEY `INSERT OR
 * REPLACE`.
 *
 * Turn dedup and session metadata aggregation both happen ACROSS the whole
 * walk, not per file (hazard 7 above) — `summary.turns` is the count of
 * distinct requestIds seen in this run, and `summary.sessions` is the
 * count of distinct sessionIds touched, matching what actually lands in
 * the `turn` / `session` tables for a full (non-skip-cache) run.
 *
 * Three distinct problem counters, kept separate deliberately:
 *  - `ioFailures` — a whole FILE could not be stat'd or read.  Counted in
 *    files, not lines: one increment means one entire file's worth of
 *    records is absent from this run, which is a much bigger loss than one
 *    bad line and must not look the same in the summary.
 *  - `parseFailures` — malformed JSON lines/records within files that
 *    WERE readable (summed from `parseTranscriptContent`).
 *  - `noRequestIdRecords` — assistant records skipped for lacking a usable
 *    requestId (summed from `parseTranscriptContent`). Not a failure.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} transcriptDir
 * @returns {{
 *   filesScanned: number, filesSkippedUnchanged: number, ioFailures: number,
 *   sessions: number, turns: number,
 *   assistantRecords: number, syntheticRecords: number,
 *   parseFailures: number, noRequestIdRecords: number,
 * }}
 */
export function ingestTranscriptDirectory(db, transcriptDir) {
  const summary = {
    filesScanned: 0,
    filesSkippedUnchanged: 0,
    ioFailures: 0,
    sessions: 0,
    turns: 0,
    assistantRecords: 0,
    syntheticRecords: 0,
    parseFailures: 0,
    noRequestIdRecords: 0,
  };

  const files = walkJsonlFiles(transcriptDir);

  // Cross-file state for this run (hazard 7): a requestId or sessionId
  // recurring across files must be counted once, not once per file.
  const seenRequestIds = new Set();
  const sessionAgg = new Map(); // sessionId -> merged { projectSlug, firstTsMs, lastTsMs, cwd, gitBranch }

  for (const { filePath, projectSlug } of files) {
    summary.filesScanned += 1;

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      summary.ioFailures += 1;
      continue;
    }

    if (isSourceFileUnchanged(db, filePath, stat.size, stat.mtimeMs)) {
      summary.filesSkippedUnchanged += 1;
      continue;
    }

    let content;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      summary.ioFailures += 1;
      continue;
    }

    const parsed = parseTranscriptContent(content);
    summary.assistantRecords += parsed.assistantRecordCount;
    summary.syntheticRecords += parsed.syntheticRecordCount;
    summary.parseFailures += parsed.parseFailures;
    summary.noRequestIdRecords += parsed.noRequestIdCount;

    for (const turn of parsed.turns) {
      seenRequestIds.add(turn.requestId);
      upsertTurn(db, {
        requestId: turn.requestId,
        sessionId: turn.sessionId,
        ts: turn.ts,
        tsMs: turn.tsMs,
        model: turn.model,
        input: turn.input,
        output: turn.output,
        cacheRead: turn.cacheRead,
        cacheWrite: turn.cacheWrite,
        isSidechain: turn.isSidechain ? 1 : 0,
        isSynthetic: turn.isSynthetic ? 1 : 0,
        textBytes: turn.textBytes,
        thinkingBytes: turn.thinkingBytes,
        toolUseBytes: turn.toolUseBytes,
      });
    }

    const { sessionMeta } = parsed;
    if (sessionMeta.sessionId) {
      const incoming = {
        projectSlug,
        firstTsMs: sessionMeta.firstTsMs,
        lastTsMs: sessionMeta.lastTsMs,
        cwd: sessionMeta.cwd,
        gitBranch: sessionMeta.gitBranch,
      };
      sessionAgg.set(sessionMeta.sessionId, mergeSessionMeta(sessionAgg.get(sessionMeta.sessionId) ?? null, incoming));
    }

    upsertSourceFile(db, {
      path: filePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ingestedAt: new Date().toISOString(),
    });
  }

  // Finalise session rows: merge this run's aggregate with whatever is
  // already stored (widening the range further, never narrowing it), so
  // the true first/last bounds keep converging correctly even across
  // incremental runs where the skip-unchanged cache means not every file
  // for a session gets re-read every time.
  for (const [sessionId, agg] of sessionAgg) {
    const existing = getSession(db, sessionId);
    const merged = mergeSessionMeta(
      existing
        ? {
          projectSlug: existing.project_slug,
          firstTsMs: existing.first_ts_ms,
          lastTsMs: existing.last_ts_ms,
          cwd: existing.cwd,
          gitBranch: existing.git_branch,
        }
        : null,
      agg,
    );
    upsertSession(db, {
      sessionId,
      projectSlug: merged.projectSlug,
      firstTs: merged.firstTsMs !== null ? new Date(merged.firstTsMs).toISOString() : null,
      firstTsMs: merged.firstTsMs,
      lastTs: merged.lastTsMs !== null ? new Date(merged.lastTsMs).toISOString() : null,
      lastTsMs: merged.lastTsMs,
      cwd: merged.cwd,
      gitBranch: merged.gitBranch,
    });
  }

  summary.sessions = sessionAgg.size;
  summary.turns = seenRequestIds.size;

  return summary;
}
