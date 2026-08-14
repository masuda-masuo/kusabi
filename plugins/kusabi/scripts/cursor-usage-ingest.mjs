// cursor-usage-ingest.mjs — parse Cursor CLI statusline-sink *.jsonl files into
// turn/session rows, and a directory walker that feeds them into the
// metrics store.
//
// Kept split on purpose (same split as transcript-ingest.mjs): `parseCursorUsageContent`
// is a pure function (a string in, structured turns out) so it is unit-testable
// with inline fixtures and no files on disk.  `ingestCursorUsageDirectory` is
// the only piece that touches the filesystem or the database, and it delegates
// every row write to metrics-db.mjs's upsert* helpers — it never opens a
// database itself (see metrics-db.mjs header).
//
// The source is `$HOME/.kusabi/cursor-usage/<session_id>.jsonl` written by
// cursor-statusline-sink.mjs. One line = `{ts, session_id, model, cwd,
// context_window}`. Files are append-only; the sink does not append when the
// previous line's context_window is identical.
//
// ---------------------------------------------------------------------------
// Hazard A — this is a sampler, not a ledger.  The statusline sink records
// whatever Cursor last reported when the statusline refreshed.  Multiple API
// calls between refreshes are dropped, so ingested input/output/cache totals
// can undercount.  Do not treat turn sums as a complete token ledger, and do
// not "correct" them against context_window.total_output_tokens (the reported
// cumulative is stored on cursor_session_counter and shown as coverage in
// metrics-report; turn rows stay as sampled).
//
// Hazard B — `model.id` is "default" when Cursor Auto is routing, and the
// real downstream model is unknown.  We store `record.model.id` verbatim
// (including "default") and never guess a concrete model from display_name.
//
// source_file skip-unchanged is a speed cache only.  Correctness is the
// PRIMARY KEY on turn.request_id / session.session_id (see metrics-db.mjs).
// Re-ingesting the same files must not grow row counts even if the cache is
// cleared.  request_id = `cursor:<session_id>#<1-based physical line number>`
// is stable because the sink is append-only with consecutive-duplicate
// suppression, so line numbers do not shift.
//
// Session first/last timestamps follow transcript-ingest.mjs Hazard 7: min of
// firsts / max of lasts, merged with whatever is already stored, so a skip-
// cached file cannot silently narrow a previously recorded range.  Null-usage
// (pre-first-API) rows do not become turns but DO contribute to the session
// timestamp range.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import {
  upsertSession,
  getSession,
  upsertTurn,
  upsertSourceFile,
  isSourceFileUnchanged,
  upsertCursorSessionCounter,
} from "./metrics-db.mjs";

/**
 * Claude Code's `~/.claude/projects` directory names encode cwd by replacing
 * every path separator with `-` (`/home/user/proj` → `-home-user-proj`).
 * Cursor usage files are flat (not nested by project), so we derive the same
 * slug from `record.cwd` to keep `session.project_slug` comparable across
 * the two ingest paths.
 *
 * @param {string|null|undefined} cwd
 * @returns {string|null}
 */
export function projectSlugFromCwd(cwd) {
  if (typeof cwd !== "string" || !cwd) return null;
  return cwd.replace(/[/\\]/g, "-");
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
 * rather than replacing it.  `incoming` wins ties on cwd (prefers the most
 * recently merged non-null value).  gitBranch is always null for cursor
 * usage.  Either side may be null.
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

function currentUsageOf(rec) {
  const cw = rec.context_window;
  if (cw == null || typeof cw !== "object") return null;
  const usage = cw.current_usage;
  if (usage == null || typeof usage !== "object") return null;
  return usage;
}

/** Numeric `context_window.total_output_tokens` only; anything else is absent. */
function numericTotalOutputTokens(rec) {
  const cw = rec.context_window;
  if (cw == null || typeof cw !== "object") return null;
  const v = cw.total_output_tokens;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Keep the latest-ts reading.  Equal ts prefers `incoming` so a later line
 * in the same file (same timestamp) wins.  Token monotonicity is not assumed.
 */
function mergeCounter(existing, incoming) {
  if (!existing) return { ...incoming };
  const existingMs = existing.tsMs;
  const incomingMs = incoming.tsMs;
  if (existingMs == null) return { ...incoming };
  if (incomingMs == null) return existing;
  if (incomingMs >= existingMs) return { ...incoming };
  return existing;
}

/**
 * Parse the full text of one Cursor usage `*.jsonl` file into turn rows plus
 * per-session metadata for THIS FILE ONLY.
 *
 * Pure — no filesystem access.  A turn is emitted only for a line whose
 * `context_window.current_usage` is a non-null object.  Every record with a
 * usable `session_id` and timestamp still contributes to that session's
 * first/last range, including the pre-first-API null-usage rows.  A numeric
 * `context_window.total_output_tokens` on any line (usage or null-period) is
 * tracked per session as the latest-ts reading.
 *
 * `request_id` is `cursor:<session_id>#<lineNo>` where `lineNo` is the
 * 1-based physical line number in the file (empty lines still occupy a
 * number so later appends stay stable).  Cross-file dedup is the caller's
 * job.
 *
 * @param {string} content  Raw file content (one JSON object per line).
 * @returns {{
 *   turns: Array<object>,
 *   sessions: Array<object>,
 *   counters: Array<{ sessionId: string, totalOutputTokens: number, ts: string|null, tsMs: number|null }>,
 *   recordCount: number,
 *   usageRecordCount: number,
 *   nullUsageCount: number,
 *   parseFailures: number,
 * }}
 */
export function parseCursorUsageContent(content) {
  const turns = [];
  const sessionAgg = new Map();
  const counterAgg = new Map();

  let recordCount = 0;
  let usageRecordCount = 0;
  let nullUsageCount = 0;
  let parseFailures = 0;

  const lines = typeof content === "string" ? content.split("\n") : [];

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i].trim();
    if (!line) continue;

    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      parseFailures += 1;
      continue;
    }
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
      parseFailures += 1;
      continue;
    }

    recordCount += 1;

    const sessionId = typeof rec.session_id === "string" && rec.session_id ? rec.session_id : null;
    const ts = typeof rec.ts === "string" && rec.ts ? rec.ts : null;
    let tsMs = ts ? Date.parse(ts) : null;
    if (Number.isNaN(tsMs)) tsMs = null;
    const cwd = typeof rec.cwd === "string" && rec.cwd ? rec.cwd : null;

    if (sessionId) {
      const incoming = {
        projectSlug: projectSlugFromCwd(cwd),
        firstTsMs: tsMs,
        lastTsMs: tsMs,
        cwd,
        gitBranch: null,
      };
      sessionAgg.set(sessionId, mergeSessionMeta(sessionAgg.get(sessionId) ?? null, incoming));
    }

    const totalOutputTokens = numericTotalOutputTokens(rec);
    if (sessionId && totalOutputTokens !== null) {
      counterAgg.set(sessionId, mergeCounter(counterAgg.get(sessionId) ?? null, {
        totalOutputTokens,
        ts,
        tsMs,
      }));
    }

    const usage = currentUsageOf(rec);
    if (!usage) {
      nullUsageCount += 1;
      continue;
    }
    if (!sessionId) continue;

    usageRecordCount += 1;
    const modelObj = rec.model;
    const model = (modelObj && typeof modelObj === "object" && !Array.isArray(modelObj)
      && typeof modelObj.id === "string" && modelObj.id)
      ? modelObj.id
      : null;

    turns.push({
      requestId: `cursor:${sessionId}#${lineNo}`,
      sessionId,
      ts,
      tsMs,
      model,
      input: typeof usage.input_tokens === "number" ? usage.input_tokens : null,
      output: typeof usage.output_tokens === "number" ? usage.output_tokens : null,
      cacheRead: typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : null,
      cacheWrite: typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : null,
      isSidechain: 0,
      isSynthetic: 0,
      textBytes: null,
      thinkingBytes: null,
      toolUseBytes: null,
    });
  }

  return {
    turns,
    sessions: [...sessionAgg.entries()].map(([sessionId, meta]) => ({ sessionId, ...meta })),
    counters: [...counterAgg.entries()].map(([sessionId, meta]) => ({ sessionId, ...meta })),
    recordCount,
    usageRecordCount,
    nullUsageCount,
    parseFailures,
  };
}

/**
 * Collect every `*.jsonl` path directly under `dir` (flat — the sink writes
 * `<session_id>.jsonl` here, not nested project folders).
 *
 * @param {string} dir
 * @returns {string[]}
 */
function walkJsonlFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      results.push(path.join(dir, entry.name));
    }
  }
  return results;
}

/**
 * Walk `cursorUsageDir` (default `~/.kusabi/cursor-usage`) for `*.jsonl`
 * files, parse each with `parseCursorUsageContent`, and upsert session/turn
 * rows into `db`, plus the latest-ts `cursor_session_counter` reading per
 * session.  Unchanged files (same size + mtime as a prior ingest) are
 * skipped as a speed optimisation only — this never affects correctness,
 * since every row write below goes through a PRIMARY KEY `INSERT OR REPLACE`.
 *
 * A missing directory yields a zeroed summary (the CLI warns).  An existing
 * empty directory is also zeros, and is not a warning — 0 files is valid.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} cursorUsageDir
 * @returns {{
 *   filesScanned: number, filesSkippedUnchanged: number, ioFailures: number,
 *   sessions: number, turns: number,
 *   records: number, usageRecords: number, nullUsageRecords: number,
 *   parseFailures: number,
 * }}
 */
export function ingestCursorUsageDirectory(db, cursorUsageDir) {
  const summary = {
    filesScanned: 0,
    filesSkippedUnchanged: 0,
    ioFailures: 0,
    sessions: 0,
    turns: 0,
    records: 0,
    usageRecords: 0,
    nullUsageRecords: 0,
    parseFailures: 0,
  };

  const files = walkJsonlFiles(cursorUsageDir);

  const seenRequestIds = new Set();
  const sessionAgg = new Map();
  const counterAgg = new Map();

  for (const filePath of files) {
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

    const parsed = parseCursorUsageContent(content);
    summary.records += parsed.recordCount;
    summary.usageRecords += parsed.usageRecordCount;
    summary.nullUsageRecords += parsed.nullUsageCount;
    summary.parseFailures += parsed.parseFailures;

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
        isSidechain: turn.isSidechain,
        isSynthetic: turn.isSynthetic,
        textBytes: turn.textBytes,
        thinkingBytes: turn.thinkingBytes,
        toolUseBytes: turn.toolUseBytes,
      });
    }

    for (const sess of parsed.sessions) {
      const incoming = {
        projectSlug: sess.projectSlug,
        firstTsMs: sess.firstTsMs,
        lastTsMs: sess.lastTsMs,
        cwd: sess.cwd,
        gitBranch: null,
      };
      sessionAgg.set(sess.sessionId, mergeSessionMeta(sessionAgg.get(sess.sessionId) ?? null, incoming));
    }

    for (const counter of parsed.counters) {
      counterAgg.set(counter.sessionId, mergeCounter(counterAgg.get(counter.sessionId) ?? null, {
        totalOutputTokens: counter.totalOutputTokens,
        ts: counter.ts,
        tsMs: counter.tsMs,
      }));
    }

    upsertSourceFile(db, {
      path: filePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ingestedAt: new Date().toISOString(),
    });
  }

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

  for (const [sessionId, counter] of counterAgg) {
    upsertCursorSessionCounter(db, {
      sessionId,
      totalOutputTokens: counter.totalOutputTokens,
      ts: counter.ts,
    });
  }

  summary.sessions = sessionAgg.size;
  summary.turns = seenRequestIds.size;

  return summary;
}
