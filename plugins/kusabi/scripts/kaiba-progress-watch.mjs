// kaiba-progress-watch.mjs — watch kaiba progress table in SQLite WAL and mirror to events.ndjson
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { appendEvent, jobDir } from "./job-store.mjs";

export const KAIBA_PROGRESS_EVENT_TYPE = "companion.kaiba.progress";
export const DEFAULT_PROGRESS_STATUS_CAP = 10;

/**
 * Resolve the path to the kaiba database.
 * Honours KAIBA_DB environment variable, falling back to ~/.kaiba/kaiba.db.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string}
 */
export function resolveKaibaDbPath(env = process.env) {
  if (typeof env.KAIBA_DB === "string" && env.KAIBA_DB.trim() !== "") {
    return env.KAIBA_DB.trim();
  }
  return path.join(os.homedir(), ".kaiba", "kaiba.db");
}

/**
 * Format a single progress content string for compact display in status.
 *
 * @param {unknown} content
 * @param {number} [maxLen=200]
 * @returns {string}
 */
export function formatProgressLine(content, maxLen = 200) {
  if (typeof content !== "string") return "";
  const single = content.replace(/\r?\n/g, " ").trim();
  if (single.length <= maxLen) return single;
  return single.slice(0, maxLen - 3) + "...";
}

/**
 * Render progress lines for `cmdStatus`.
 * Returns an array of lines (including "progress:" header and capped items),
 * or an empty array if there are no progress events.
 *
 * @param {Array<{content?: string, agent?: string|null}>} events
 * @param {number} [cap=DEFAULT_PROGRESS_STATUS_CAP]
 * @returns {string[]}
 */
export function renderProgressLines(events, cap = DEFAULT_PROGRESS_STATUS_CAP) {
  if (!Array.isArray(events) || events.length === 0) return [];
  const lines = ["progress:"];
  const count = events.length;
  const shown = count > cap ? events.slice(count - cap) : events;
  if (count > cap) {
    lines.push(`  (... ${count - cap} earlier note(s) omitted)`);
  }
  for (const ev of shown) {
    const text = formatProgressLine(ev?.content);
    if (text) {
      lines.push(`  - ${text}`);
    }
  }
  return lines;
}

/**
 * Read all progress events for a given job from its events.ndjson.
 *
 * @param {string} stateDir
 * @param {string} jobId
 * @returns {Array<{type: string, id: number, created_at: string, agent: string|null, job: string, content: string}>}
 */
export function readJobProgressEvents(stateDir, jobId) {
  if (!stateDir || !jobId) return [];
  const file = path.join(jobDir(stateDir, jobId), "events.ndjson");
  if (!fs.existsSync(file)) return [];
  try {
    const raw = fs.readFileSync(file, "utf8");
    const results = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj && obj.type === KAIBA_PROGRESS_EVENT_TYPE) {
          results.push(obj);
        }
      } catch {
        // tolerate malformed lines
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Load and render progress section for `cmdStatus <jobId>`.
 *
 * @param {string} stateDir
 * @param {string} jobId
 * @param {object} [opts]
 * @param {number} [opts.cap]
 * @returns {string[]}
 */
export function renderJobProgress(stateDir, jobId, opts = {}) {
  const events = readJobProgressEvents(stateDir, jobId);
  return renderProgressLines(events, opts.cap ?? DEFAULT_PROGRESS_STATUS_CAP);
}

/**
 * Watch kaiba.db for progress entries matching `jobId` and mirror them to events.ndjson.
 *
 * @param {object} opts
 * @param {string} opts.stateDir
 * @param {string} opts.jobId
 * @param {string} [opts.dbPath]
 * @returns {{ stop: () => void, drain: () => void }}
 */
export function startKaibaProgressWatch({ stateDir, jobId, dbPath = resolveKaibaDbPath() }) {
  if (!stateDir || !jobId || typeof jobId !== "string" || typeof stateDir !== "string") {
    return { stop: () => {}, drain: () => {} };
  }

  let db = null;
  let lastSeenId = 0;
  let lastDataVersion = null;
  let watchers = [];
  let isStopped = false;
  let isDraining = false;
  let drainPending = false;

  function ensureDb() {
    if (db) return db;
    if (!fs.existsSync(dbPath)) return null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      return db;
    } catch {
      db = null;
      return null;
    }
  }

  function drain() {
    if (isStopped) return;
    if (isDraining) {
      drainPending = true;
      return;
    }
    isDraining = true;
    try {
      const handle = ensureDb();
      if (!handle) return;

      // Schema check: user_version >= 4
      let uv = 0;
      try {
        const uvRow = handle.prepare("PRAGMA user_version").get();
        uv = uvRow?.user_version ?? 0;
      } catch {
        return;
      }
      if (uv < 4) return;

      // Schema check: table progress exists
      try {
        const tbl = handle.prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'progress'"
        ).get();
        if (!tbl) return;
      } catch {
        return;
      }

      // Check data_version
      let dv = null;
      try {
        const dvRow = handle.prepare("PRAGMA data_version").get();
        dv = dvRow?.data_version ?? null;
      } catch {
        return;
      }

      if (dv !== null && lastDataVersion !== null && dv === lastDataVersion) {
        return;
      }

      // Read matching rows
      let rows = [];
      try {
        const stmt = handle.prepare(
          "SELECT id, created_at, agent, job, content FROM progress WHERE id > ? AND job = ? ORDER BY id"
        );
        rows = stmt.all(lastSeenId, jobId);
      } catch {
        return;
      }

      lastDataVersion = dv;

      if (Array.isArray(rows) && rows.length > 0) {
        for (const row of rows) {
          if (typeof row.id === "number" && row.id > lastSeenId) {
            lastSeenId = row.id;
          }
          appendEvent(stateDir, jobId, {
            type: KAIBA_PROGRESS_EVENT_TYPE,
            id: row.id,
            created_at: row.created_at,
            agent: row.agent ?? null,
            job: row.job ?? null,
            content: row.content,
          });
        }
      }
    } catch {
      // Silent on any failure
    } finally {
      isDraining = false;
      if (drainPending && !isStopped) {
        drainPending = false;
        drain();
      }
    }
  }

  function attachWatches() {
    if (isStopped) return;
    // Watch kaiba.db if present
    if (fs.existsSync(dbPath)) {
      try {
        const w = fs.watch(dbPath, () => drain());
        w.on("error", () => {});
        watchers.push(w);
      } catch {
        /* best-effort */
      }
    }
    // Watch kaiba.db-wal if present
    const walPath = `${dbPath}-wal`;
    if (fs.existsSync(walPath)) {
      try {
        const w = fs.watch(walPath, () => drain());
        w.on("error", () => {});
        watchers.push(w);
      } catch {
        /* best-effort */
      }
    }
    // Watch parent directory to capture dynamic creation of db or wal
    const parentDir = path.dirname(dbPath);
    if (fs.existsSync(parentDir)) {
      try {
        const dbBase = path.basename(dbPath);
        const walBase = `${dbBase}-wal`;
        const w = fs.watch(parentDir, (eventType, filename) => {
          if (!filename || filename === dbBase || filename === walBase) {
            drain();
          }
        });
        w.on("error", () => {});
        watchers.push(w);
      } catch {
        /* best-effort */
      }
    }
  }

  function stop() {
    if (isStopped) return;
    isStopped = true;
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* best-effort */
      }
    }
    watchers = [];
    if (db) {
      try {
        db.close();
      } catch {
        /* best-effort */
      }
      db = null;
    }
  }

  attachWatches();
  // Initial drain to catch rows written in the gap between mint and watch
  drain();

  return {
    stop,
    drain,
    get db() {
      return db;
    },
    get lastSeenId() {
      return lastSeenId;
    },
    get lastDataVersion() {
      return lastDataVersion;
    },
  };
}
