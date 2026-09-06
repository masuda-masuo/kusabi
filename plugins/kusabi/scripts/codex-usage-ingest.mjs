// codex-usage-ingest.mjs — parse Codex JSONL usage files into turn/session
// rows, and a directory walker that feeds them into the metrics store.
//
// Split by design (same as transcript-ingest.mjs and cursor-usage-ingest.mjs):
// `parseCodexUsageContent` is a pure function (string in, structured turns out)
// so it is unit-testable with inline fixtures and no files on disk.
// `ingestCodexUsageDirectory` is the only piece that touches the filesystem or
// the database, and it delegates every row write to metrics-db.mjs's upsert*
// helpers — it never opens a database itself.
//
// Source format (observed in real Codex rollout logs):
//   session_meta        — {timestamp, type:"session_meta",    payload:{id, cwd}}
//   turn_context        — {timestamp, type:"turn_context",    payload:{turn_id, model}}
//   token_usage_record  — {timestamp, type:"token_usage_record", payload:{...usage...}}
//   event_msg           — {timestamp, type:"event_msg",       payload:{type:"token_count", ...}}
//
// Only token_usage_record.payload.usage is measured.  turn_token_usage and
// thread_token_usage are cumulative counters and MUST be ignored.
// event_msg.token_count records are counted as legacy and not measured.

import fs from "node:fs";
import path from "node:path";
import {
  upsertSession,
  getSession,
  getTurn,
  upsertTurn,
  upsertSourceFile,
  isSourceFileUnchanged,
} from "./metrics-db.mjs";

/**
 * Parser-version suffix on the `source_file` skip-cache key.  Bump this
 * whenever a change to `parseCodexUsageContent` makes the SAME file yield
 * different turn rows, so already-cached files are read once more.
 *
 * `codex-usage:v1` = initial implementation.
 */
const SOURCE_FILE_KEY_SUFFIX = "#codex-usage:v1";

/** Skip-cache key for one codex usage file: the path plus the parser version. */
function sourceFileKey(filePath) {
  return `${filePath}${SOURCE_FILE_KEY_SUFFIX}`;
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
 * Check whether a value is a finite non-negative integer.
 */
function isFiniteNonNegativeInteger(v) {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
}

/**
 * Merge one file's session metadata into a running aggregate for the same
 * sessionId — widening the timestamp range (min of firsts, max of lasts)
 * rather than replacing it.
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
    cwd: existing.cwd ?? incoming.cwd ?? null,
    gitBranch: existing.gitBranch ?? incoming.gitBranch ?? null,
  };
}

/**
 * Parse the full text of one Codex JSONL usage file into turn rows plus
 * per-session metadata for THIS FILE ONLY.
 *
 * Pure — no filesystem access.
 *
 * @param {string} content  Raw file content (one JSON object per line).
 * @returns {{
 *   turns: Array<object>,
 *   sessionMeta: Array<object>,
 *   parseFailures: number,
 *   invalidUsageRecords: number,
 *   duplicateRecords: number,
 *   legacyTokenCountRecords: number,
 * }}
 */
export function parseCodexUsageContent(content) {
  const turns = [];
  const sessionMeta = new Map(); // sessionId -> {firstTsMs, lastTsMs, cwd, gitBranch}
  const seenResponseIds = new Set(); // dedup within a file
  // turn_context tracking: turnId -> {model, tsMs}
  const turnContextMap = new Map();
  // Current session context (most recent session_meta)
  let currentSessionId = null;
  let currentSessionCwd = null;

  let parseFailures = 0;
  let invalidUsageRecords = 0;
  let duplicateRecords = 0;
  let legacyTokenCountRecords = 0;

  const lines = typeof content === "string" ? content.split("\n") : [];

  for (let i = 0; i < lines.length; i += 1) {
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

    const type = rec.type;
    const payload = rec.payload;
    const ts = typeof rec.timestamp === "string" && rec.timestamp ? rec.timestamp : null;
    let tsMs = ts ? Date.parse(ts) : null;
    if (Number.isNaN(tsMs)) tsMs = null;

    if (type === "session_meta") {
      // Track current session context
      if (payload && typeof payload.id === "string" && payload.id) {
        currentSessionId = payload.id;
        currentSessionCwd = typeof payload.cwd === "string" ? payload.cwd : null;

        const incoming = {
          projectSlug: null,
          firstTsMs: tsMs,
          lastTsMs: tsMs,
          cwd: currentSessionCwd,
          gitBranch: typeof payload.git_branch === "string" ? payload.git_branch : null,
        };
        sessionMeta.set(
          currentSessionId,
          mergeSessionMeta(sessionMeta.get(currentSessionId) ?? null, incoming),
        );
      }
      continue;
    }

    if (type === "turn_context") {
      // Track turn context for model attribution
      if (payload && typeof payload.turn_id === "string" && payload.turn_id) {
        turnContextMap.set(payload.turn_id, {
          model: typeof payload.model === "string" ? payload.model : null,
          tsMs,
        });
      }
      continue;
    }

    if (type === "event_msg") {
      // Legacy token_count records — counted but not measured
      if (
        payload &&
        typeof payload === "object" &&
        payload.type === "token_count"
      ) {
        legacyTokenCountRecords += 1;
      }
      continue;
    }

    if (type === "token_usage_record") {
      // This is the actual usage record we measure from
      if (!payload || typeof payload !== "object") {
        invalidUsageRecords += 1;
        continue;
      }

      // Response ID — required for a usable turn
      const responseId =
        typeof payload.response_id === "string" && payload.response_id
          ? payload.response_id
          : null;
      if (!responseId) {
        invalidUsageRecords += 1;
        continue;
      }

      // Session ID: prefer payload.session_id, fallback payload.thread_id,
      // fallback currentSessionId (from session_meta)
      const sessionId =
        (typeof payload.session_id === "string" && payload.session_id) ||
        (typeof payload.thread_id === "string" && payload.thread_id) ||
        currentSessionId ||
        null;

      // Turn context for model attribution
      const turnId =
        typeof payload.turn_id === "string" ? payload.turn_id : null;
      const ctx = turnId ? turnContextMap.get(turnId) : undefined;
      const model = ctx ? ctx.model : null;

      // Usage validation
      const usage = payload.usage;
      if (!usage || typeof usage !== "object" || Array.isArray(usage) || Object.keys(usage).length === 0) {
        invalidUsageRecords += 1;
        continue;
      }

      const inputTokens = usage.input_tokens;
      const cachedInputTokens = usage.cached_input_tokens;
      const cacheWriteInputTokens = usage.cache_write_input_tokens;
      const outputTokens = usage.output_tokens;

      // All present numeric fields must be finite non-negative integers.
      // Explicit null (e.g. JSON-serialized NaN) is invalid, not absent.
      // Absent/undefined is absent (not checked here).
      const numericFields = [
        inputTokens,
        cachedInputTokens,
        cacheWriteInputTokens,
        outputTokens,
      ];
      let anyInvalid = false;
      for (const v of numericFields) {
        // null is present (serialized NaN), undefined is absent
        if (v !== undefined) {
          if (!isFiniteNonNegativeInteger(v)) {
            anyInvalid = true;
            break;
          }
        }
      }
      if (anyInvalid) {
        invalidUsageRecords += 1;
        continue;
      }

      // Cache breakdown validation: reject when individual cache count > input_tokens
      // (when both are present), or when read+write > input (when all three are present).
      // Also reject contradictory partial cache: a present individual cache count > input
      // even when other cache component is absent.
      if (
        isFiniteNonNegativeInteger(cachedInputTokens) &&
        isFiniteNonNegativeInteger(inputTokens) &&
        cachedInputTokens > inputTokens
      ) {
        invalidUsageRecords += 1;
        continue;
      }
      if (
        isFiniteNonNegativeInteger(cacheWriteInputTokens) &&
        isFiniteNonNegativeInteger(inputTokens) &&
        cacheWriteInputTokens > inputTokens
      ) {
        invalidUsageRecords += 1;
        continue;
      }
      if (
        isFiniteNonNegativeInteger(cachedInputTokens) &&
        isFiniteNonNegativeInteger(cacheWriteInputTokens) &&
        isFiniteNonNegativeInteger(inputTokens) &&
        cachedInputTokens + cacheWriteInputTokens > inputTokens
      ) {
        invalidUsageRecords += 1;
        continue;
      }

      // Normalize: preserve each known cache field independently.
      // input = input_tokens - cached_input_tokens - cache_write_input_tokens
      // (only when all three are present; otherwise input=null as we cannot normalize).
      let input = null;
      let cacheRead = null;
      let cacheWrite = null;
      if (
        isFiniteNonNegativeInteger(cachedInputTokens) &&
        isFiniteNonNegativeInteger(cacheWriteInputTokens) &&
        isFiniteNonNegativeInteger(inputTokens)
      ) {
        input = inputTokens - cachedInputTokens - cacheWriteInputTokens;
      }
      // Preserve each known cache field independently, even when others are absent.
      if (isFiniteNonNegativeInteger(cachedInputTokens)) {
        cacheRead = cachedInputTokens;
      }
      if (isFiniteNonNegativeInteger(cacheWriteInputTokens)) {
        cacheWrite = cacheWriteInputTokens;
      }

      const output = isFiniteNonNegativeInteger(outputTokens)
        ? outputTokens
        : null;

      // Dedup by response_id
      const namespacedId = `codex:${responseId}`;
      if (seenResponseIds.has(namespacedId)) {
        duplicateRecords += 1;
        continue;
      }
      seenResponseIds.add(namespacedId);

      turns.push({
        requestId: namespacedId,
        sessionId,
        ts,
        tsMs,
        model,
        input,
        cacheRead,
        cacheWrite,
        output,
        isSidechain: 0,
        isSynthetic: 0,
        textBytes: null,
        thinkingBytes: null,
        toolUseBytes: null,
      });

      // Also track session timestamps from token_usage_record payload,
      // even when no session_meta preceded this record in the file
      if (sessionId) {
        const incoming = {
          projectSlug: null,
          firstTsMs: tsMs,
          lastTsMs: tsMs,
          cwd: null,
          gitBranch: null,
        };
        sessionMeta.set(
          sessionId,
          mergeSessionMeta(sessionMeta.get(sessionId) ?? null, incoming),
        );
      }
    }
  }

  return {
    turns,
    sessionMeta: [...sessionMeta.entries()].map(([sessionId, meta]) => ({
      sessionId,
      ...meta,
    })),
    parseFailures,
    invalidUsageRecords,
    duplicateRecords,
    legacyTokenCountRecords,
  };
}

/**
 * Recursively collect every `*.jsonl` path under `dir`, including files
 * directly at the root level.
 *
 * @param {string} dir
 * @returns {{ files: string[], ioFailures: number }}
 */
function walkJsonlFiles(dir) {
  const results = [];
  let ioFailures = 0;
  if (!fs.existsSync(dir)) return { files: results, ioFailures };
  // If dir is a file rather than a directory, expose as I/O failure
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) {
      ioFailures += 1;
      return { files: results, ioFailures };
    }
  } catch {
    ioFailures += 1;
    return { files: results, ioFailures };
  }

  /** @type {string[]} */
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      ioFailures += 1;
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        results.push(fullPath);
      }
    }
  }

  return { files: results.sort(), ioFailures };
}

/**
 * Walk a Codex sessions directory for `*.jsonl` files, parse each with
 * `parseCodexUsageContent`, and upsert session/turn rows into `db`.
 *
 * Source file skip-cache uses a versioned key (`codex-usage:v1:<path>`) that
 * is distinct from the cursor-usage key (`#cu-v2`) and the Claude transcript
 * key.  A missing directory yields a zeroed summary (the CLI warns).  An
 * existing empty directory is also zeros.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} codexUsageDir
 * @returns {{
 *   filesScanned: number, filesSkippedUnchanged: number,
 *   turns: number, legacyTokenCountRecords: number,
 *   parseFailures: number, invalidUsageRecords: number,
 *   duplicateRecords: number, ioFailures: number,
 * }}
 */
export function ingestCodexUsageDirectory(db, codexUsageDir) {
  const summary = {
    filesScanned: 0,
    filesSkippedUnchanged: 0,
    turns: 0,
    legacyTokenCountRecords: 0,
    parseFailures: 0,
    invalidUsageRecords: 0,
    duplicateRecords: 0,
    ioFailures: 0,
  };

  const { files, ioFailures: walkFailures } = walkJsonlFiles(codexUsageDir);
  summary.ioFailures += walkFailures;

  const seenRequestIds = new Set();
  const sessionAgg = new Map();

  for (const filePath of files) {
    summary.filesScanned += 1;

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      summary.ioFailures += 1;
      continue;
    }

    const cacheKey = sourceFileKey(filePath);
    if (isSourceFileUnchanged(db, cacheKey, stat.size, stat.mtimeMs)) {
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

    const parsed = parseCodexUsageContent(content);
    summary.parseFailures += parsed.parseFailures;
    summary.invalidUsageRecords += parsed.invalidUsageRecords;
    summary.duplicateRecords += parsed.duplicateRecords;
    summary.legacyTokenCountRecords += parsed.legacyTokenCountRecords;

    for (const turn of parsed.turns) {
      // Check if this request ID already exists in the DB (cross-file dedup)
      if (seenRequestIds.has(turn.requestId) || getTurn(db, turn.requestId)) {
        summary.duplicateRecords += 1;
        continue;
      }
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

    for (const sess of parsed.sessionMeta) {
      const incoming = {
        projectSlug: null,
        firstTsMs: sess.firstTsMs,
        lastTsMs: sess.lastTsMs,
        cwd: sess.cwd,
        gitBranch: sess.gitBranch,
      };
      sessionAgg.set(
        sess.sessionId,
        mergeSessionMeta(sessionAgg.get(sess.sessionId) ?? null, incoming),
      );
    }

    upsertSourceFile(db, {
      path: cacheKey,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ingestedAt: new Date().toISOString(),
    });
  }

  // Merge session aggregates with existing DB rows (widen, never narrow)
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

  summary.turns = seenRequestIds.size;

  return summary;
}
