// metrics-db.mjs — schema definition, DB open/migrate, and row upsert helpers.
//
// Owns all SQL for the metrics store.  Nothing else in this feature opens a
// database handle or writes SQL: transcript-ingest.mjs and chain-ingest.mjs
// receive an already-open `db` and only ever call the upsert* functions
// exported here.  That split is what makes the ingest modules testable
// against an in-memory database (openMetricsDb(":memory:")) with no real
// files or state directory involved.
//
// Correctness (idempotency) comes from the PRIMARY KEY + `INSERT OR REPLACE`
// on every table below, not from the `source_file` skip-cache.  Re-running
// ingest twice over the same input must produce identical row counts even if
// the skip-cache were disabled entirely — the skip-cache exists purely to
// avoid re-reading unchanged files, and must never be load-bearing for
// correctness (see chain-ingest.test.mjs / transcript-ingest.test.mjs).
//
// A missing value is stored as SQL NULL, never coerced to 0 — a downstream
// AVG() cannot distinguish "0" from "absent", and the follow-up PR (query /
// report surface) computes rates over these columns.
//
// This module intentionally contains no correlation, regression,
// significance, or normalisation logic, and never will: ingest + store
// only.  Interpretation belongs to the follow-up query/report PR (and, per
// the project's stated position, the human reader — the recorded history
// confounds orchestrator model with calendar date with kusabi's own
// maturity, so this store is a reference dataset, not an inference engine).

import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS source_file (
  path TEXT PRIMARY KEY,
  size INTEGER,
  mtime_ms REAL,
  ingested_at TEXT
);

CREATE TABLE IF NOT EXISTS session (
  session_id TEXT PRIMARY KEY,
  project_slug TEXT,
  first_ts TEXT,
  first_ts_ms INTEGER,
  last_ts TEXT,
  last_ts_ms INTEGER,
  cwd TEXT,
  git_branch TEXT
);

CREATE TABLE IF NOT EXISTS turn (
  request_id TEXT PRIMARY KEY,
  session_id TEXT,
  ts TEXT,
  ts_ms INTEGER,
  model TEXT,
  input INTEGER,
  output INTEGER,
  cache_read INTEGER,
  cache_write INTEGER,
  is_sidechain INTEGER,
  is_synthetic INTEGER,
  text_bytes INTEGER,
  thinking_bytes INTEGER,
  tool_use_bytes INTEGER
);
CREATE INDEX IF NOT EXISTS idx_turn_session_id ON turn(session_id);

CREATE TABLE IF NOT EXISTS chain (
  chain_id TEXT PRIMARY KEY,
  workspace_slug TEXT,
  orch_model TEXT,
  orch_session TEXT,
  orch_date TEXT,
  backend TEXT,
  base_sha TEXT,
  model TEXT,
  model_chain_json TEXT,
  max_rounds INTEGER,
  strategized INTEGER,
  totals_input INTEGER,
  totals_output INTEGER,
  totals_reasoning INTEGER,
  totals_cache_read INTEGER,
  totals_cache_write INTEGER,
  totals_cost REAL,
  brief_text TEXT,
  brief_chars INTEGER,
  brief_lines INTEGER,
  brief_bullets INTEGER,
  brief_has_deliverables INTEGER,
  brief_deliverable_count INTEGER,
  brief_has_smoke INTEGER,
  brief_smoke_count INTEGER
);
-- orch_model / orch_date are stratification keys, not incidental metadata
-- (see DESIGN.md 3.5.8 — orchestrator model is perfectly confounded with
-- date in the recorded history so far).  Indexed so the follow-up PR can
-- group/filter by either without a full scan.
CREATE INDEX IF NOT EXISTS idx_chain_orch_model ON chain(orch_model);
CREATE INDEX IF NOT EXISTS idx_chain_orch_date ON chain(orch_date);

CREATE TABLE IF NOT EXISTS round (
  chain_id TEXT,
  round INTEGER,
  started_at TEXT,
  started_ms INTEGER,
  -- backend is the backend the round's IMPLEMENT job actually used;
  -- review_backend the backend its REVIEW job used (kusabi #192 made the
  -- two independent, kusabi #195 stores the second one).  Both verbatim,
  -- NULL when the record predates the field.
  backend TEXT,
  review_backend TEXT,
  model_entry TEXT,
  tier_before INTEGER,
  tier_after INTEGER,
  verdict TEXT,
  probes_green INTEGER,
  worktree_changed INTEGER,
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
);

CREATE TABLE IF NOT EXISTS finding (
  chain_id TEXT,
  round INTEGER,
  idx INTEGER,
  severity TEXT,
  title TEXT,
  file TEXT,
  source TEXT,
  PRIMARY KEY (chain_id, round, idx)
);

-- Delegated single-shot jobs (#154).  A job is NOT a chain: no rounds, no
-- findings, no disposition.  It gets its own table rather than a degenerate
-- chain row so chain statistics are never diluted by chain-less records.
--
-- usage_available is deliberately three-valued:
--   NULL = no usage.json existed on disk (the job died/was cancelled before
--          usage was persisted) -- "absent" is a fact worth seeing;
--   0    = usage.json exists but says available: false;
--   1    = usage.json exists with measured numbers.
-- usage_cost 0 is a REAL measurement (every free-tier job costs 0) and is
-- stored as 0, never coerced to NULL; conversely an absent cost stays NULL.
-- status is stored verbatim (completed / provider-error / error / cancelled /
-- anything future) -- never validated against an enum, so an unknown status
-- survives to the report instead of being silently dropped.
CREATE TABLE IF NOT EXISTS job (
  job_id TEXT PRIMARY KEY,
  workspace_slug TEXT,
  kind TEXT,
  title TEXT,
  status TEXT,
  phase TEXT,
  backend TEXT,
  model_entry TEXT,
  started_at TEXT,
  started_ms INTEGER,
  finished_at TEXT,
  finished_ms INTEGER,
  duration_seconds REAL,
  steps INTEGER,
  error TEXT,
  usage_available INTEGER,
  usage_model TEXT,
  usage_input INTEGER,
  usage_output INTEGER,
  usage_reasoning INTEGER,
  usage_cache_read INTEGER,
  usage_cache_write INTEGER,
  usage_cost REAL
);
CREATE INDEX IF NOT EXISTS idx_job_started_ms ON job(started_ms);
`;

/**
 * Add a column to an existing table if it is not already present.  Plain
 * `CREATE TABLE IF NOT EXISTS` does not retrofit new columns onto a
 * database file created by an earlier version of this schema, so a real
 * on-disk `metrics.db` from before `finding.source` existed needs this to
 * pick it up on the next open.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} table
 * @param {string} column
 * @param {string} type  SQLite column type, e.g. "TEXT".
 */
function ensureColumn(db, table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = cols.some((c) => c.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/**
 * Open (creating if necessary) the metrics database at `dbPath`, apply the
 * schema, and migrate any pre-existing database file to the current column
 * set.  Pass ":memory:" for an ephemeral database (used by tests and by
 * `metrics-ingest --dry-run`).
 *
 * @param {string} dbPath
 * @returns {import("node:sqlite").DatabaseSync}
 */
export function openMetricsDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  // Migration for databases created before `finding.source` existed.
  ensureColumn(db, "finding", "source", "TEXT");
  // Migration for databases created before `round.worktree_changed` existed
  // (kusabi #165 — the escalate substantive/no-work split).  Old rows keep
  // NULL, which the report surfaces render as "unknown", never as no-work.
  ensureColumn(db, "round", "worktree_changed", "INTEGER");
  // Migrations for databases created before the chain/round/job `backend`
  // columns existed (kusabi #184 Job C — the claude dispatch backend split).
  // Old rows keep NULL, which report readers treat as "opencode" (records
  // without the field predate the split), never as unknown.
  ensureColumn(db, "chain", "backend", "TEXT");
  ensureColumn(db, "round", "backend", "TEXT");
  ensureColumn(db, "job", "backend", "TEXT");
  // Migration for databases created before `round.review_backend` existed
  // (kusabi #195 — per-phase backend attribution, after #192 made review's
  // backend independent of implement's).  Old rows keep NULL: those records
  // predate `reviewBackend`, so their review backend is genuinely unknown
  // and is never backfilled from the round's implement backend.
  ensureColumn(db, "round", "review_backend", "TEXT");
  return db;
}

/**
 * Open the metrics database at `dbPath` READ-ONLY, for the `metrics-report`
 * query surface only. Never creates the file, never runs `PRAGMA
 * journal_mode`, never applies the schema or the `finding.source` migration,
 * and never writes. Deliberately NOT `openMetricsDb`: that function's
 * `CREATE TABLE` / `ALTER TABLE` calls are writes, and this module remains
 * the only place that constructs a `DatabaseSync` — the report's SELECTs
 * live in metrics-report.mjs, which receives this already-open handle.
 *
 * A read-only open of a path that does not exist throws — callers must
 * check `fs.existsSync(dbPath)` first (see `metrics-report` in
 * kusabi-companion.mjs) rather than relying on this to report "not found".
 *
 * @param {string} dbPath
 * @returns {import("node:sqlite").DatabaseSync}
 */
export function openMetricsDbReadOnly(dbPath) {
  return new DatabaseSync(dbPath, { readOnly: true });
}

// ---------------------------------------------------------------------------
// source_file — skip-unchanged bookkeeping (speed only, never correctness)
// ---------------------------------------------------------------------------

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} filePath
 * @returns {{ size: number, mtime_ms: number } | undefined}
 */
export function getSourceFile(db, filePath) {
  return db.prepare("SELECT size, mtime_ms FROM source_file WHERE path = $path").get({ path: filePath });
}

/**
 * Whether `filePath` is already recorded in source_file with the same size
 * and mtime — i.e. safe to skip re-reading.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} filePath
 * @param {number} size
 * @param {number} mtimeMs
 * @returns {boolean}
 */
export function isSourceFileUnchanged(db, filePath, size, mtimeMs) {
  const row = getSourceFile(db, filePath);
  if (!row) return false;
  return row.size === size && row.mtime_ms === mtimeMs;
}

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{ path: string, size: number, mtimeMs: number, ingestedAt: string }} row
 */
export function upsertSourceFile(db, row) {
  db.prepare(`
    INSERT OR REPLACE INTO source_file (path, size, mtime_ms, ingested_at)
    VALUES ($path, $size, $mtimeMs, $ingestedAt)
  `).run({
    path: row.path,
    size: row.size ?? null,
    mtimeMs: row.mtimeMs ?? null,
    ingestedAt: row.ingestedAt ?? null,
  });
}

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

/**
 * Read the current stored row for a session, if any.  Used by the
 * transcript walker to widen (never narrow) a session's first/last
 * timestamp range across multiple files that share one sessionId, rather
 * than letting whichever file is upserted last silently win.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} sessionId
 * @returns {{ project_slug: string|null, first_ts: string|null, first_ts_ms: number|null,
 *             last_ts: string|null, last_ts_ms: number|null, cwd: string|null,
 *             git_branch: string|null } | undefined}
 */
export function getSession(db, sessionId) {
  return db.prepare(`
    SELECT project_slug, first_ts, first_ts_ms, last_ts, last_ts_ms, cwd, git_branch
    FROM session WHERE session_id = $sessionId
  `).get({ sessionId });
}

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {object} row
 */
export function upsertSession(db, row) {
  db.prepare(`
    INSERT OR REPLACE INTO session
      (session_id, project_slug, first_ts, first_ts_ms, last_ts, last_ts_ms, cwd, git_branch)
    VALUES
      ($sessionId, $projectSlug, $firstTs, $firstTsMs, $lastTs, $lastTsMs, $cwd, $gitBranch)
  `).run({
    sessionId: row.sessionId,
    projectSlug: row.projectSlug ?? null,
    firstTs: row.firstTs ?? null,
    firstTsMs: row.firstTsMs ?? null,
    lastTs: row.lastTs ?? null,
    lastTsMs: row.lastTsMs ?? null,
    cwd: row.cwd ?? null,
    gitBranch: row.gitBranch ?? null,
  });
}

// ---------------------------------------------------------------------------
// turn
// ---------------------------------------------------------------------------

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {object} row
 */
export function upsertTurn(db, row) {
  db.prepare(`
    INSERT OR REPLACE INTO turn
      (request_id, session_id, ts, ts_ms, model, input, output, cache_read, cache_write,
       is_sidechain, is_synthetic, text_bytes, thinking_bytes, tool_use_bytes)
    VALUES
      ($requestId, $sessionId, $ts, $tsMs, $model, $input, $output, $cacheRead, $cacheWrite,
       $isSidechain, $isSynthetic, $textBytes, $thinkingBytes, $toolUseBytes)
  `).run({
    requestId: row.requestId,
    sessionId: row.sessionId ?? null,
    ts: row.ts ?? null,
    tsMs: row.tsMs ?? null,
    model: row.model ?? null,
    input: row.input ?? null,
    output: row.output ?? null,
    cacheRead: row.cacheRead ?? null,
    cacheWrite: row.cacheWrite ?? null,
    isSidechain: row.isSidechain ?? null,
    isSynthetic: row.isSynthetic ?? null,
    textBytes: row.textBytes ?? null,
    thinkingBytes: row.thinkingBytes ?? null,
    toolUseBytes: row.toolUseBytes ?? null,
  });
}

// ---------------------------------------------------------------------------
// chain
// ---------------------------------------------------------------------------

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {object} row
 */
export function upsertChain(db, row) {
  db.prepare(`
    INSERT OR REPLACE INTO chain
      (chain_id, workspace_slug, orch_model, orch_session, orch_date, backend, base_sha, model,
       model_chain_json, max_rounds, strategized,
       totals_input, totals_output, totals_reasoning, totals_cache_read, totals_cache_write, totals_cost,
       brief_text, brief_chars, brief_lines, brief_bullets,
       brief_has_deliverables, brief_deliverable_count, brief_has_smoke, brief_smoke_count)
    VALUES
      ($chainId, $workspaceSlug, $orchModel, $orchSession, $orchDate, $backend, $baseSha, $model,
       $modelChainJson, $maxRounds, $strategized,
       $totalsInput, $totalsOutput, $totalsReasoning, $totalsCacheRead, $totalsCacheWrite, $totalsCost,
       $briefText, $briefChars, $briefLines, $briefBullets,
       $briefHasDeliverables, $briefDeliverableCount, $briefHasSmoke, $briefSmokeCount)
  `).run({
    chainId: row.chainId,
    workspaceSlug: row.workspaceSlug ?? null,
    orchModel: row.orchModel ?? null,
    orchSession: row.orchSession ?? null,
    orchDate: row.orchDate ?? null,
    // Dispatch backend (kusabi #184), stored verbatim — a row without the
    // field stores NULL, never a default; readers apply the "NULL means
    // opencode" contract at read time.
    backend: row.backend ?? null,
    baseSha: row.baseSha ?? null,
    model: row.model ?? null,
    modelChainJson: row.modelChainJson ?? null,
    maxRounds: row.maxRounds ?? null,
    strategized: row.strategized ?? null,
    totalsInput: row.totalsInput ?? null,
    totalsOutput: row.totalsOutput ?? null,
    totalsReasoning: row.totalsReasoning ?? null,
    totalsCacheRead: row.totalsCacheRead ?? null,
    totalsCacheWrite: row.totalsCacheWrite ?? null,
    totalsCost: row.totalsCost ?? null,
    briefText: row.briefText ?? null,
    briefChars: row.briefChars ?? null,
    briefLines: row.briefLines ?? null,
    briefBullets: row.briefBullets ?? null,
    briefHasDeliverables: row.briefHasDeliverables ?? null,
    briefDeliverableCount: row.briefDeliverableCount ?? null,
    briefHasSmoke: row.briefHasSmoke ?? null,
    briefSmokeCount: row.briefSmokeCount ?? null,
  });
}

// ---------------------------------------------------------------------------
// round
// ---------------------------------------------------------------------------

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {object} row
 */
export function upsertRound(db, row) {
  db.prepare(`
    INSERT OR REPLACE INTO round
      (chain_id, round, started_at, started_ms, backend, review_backend, model_entry, tier_before, tier_after,
       verdict, probes_green, worktree_changed, disposition, rework_count, findings_text,
       implement_in, implement_out, implement_cost, review_in, review_out, review_cost)
    VALUES
      ($chainId, $round, $startedAt, $startedMs, $backend, $reviewBackend, $modelEntry, $tierBefore, $tierAfter,
       $verdict, $probesGreen, $worktreeChanged, $disposition, $reworkCount, $findingsText,
       $implementIn, $implementOut, $implementCost, $reviewIn, $reviewOut, $reviewCost)
  `).run({
    chainId: row.chainId,
    round: row.round,
    startedAt: row.startedAt ?? null,
    startedMs: row.startedMs ?? null,
    // Dispatch backend (kusabi #184), stored verbatim per record — NULL when
    // the record predates the split; readers treat NULL as "opencode".
    // `backend` is the IMPLEMENT phase's backend (round 1 the implement
    // backend, a rework round the rework backend — each round's own field is
    // already truthful).  `reviewBackend` (kusabi #192, ingested by #195) is
    // the REVIEW phase's, stored verbatim and NULL for records written
    // before the field existed — never backfilled from `backend`, because
    // "unknown" and "same as implement" are different facts.
    backend: row.backend ?? null,
    reviewBackend: row.reviewBackend ?? null,
    modelEntry: row.modelEntry ?? null,
    tierBefore: row.tierBefore ?? null,
    tierAfter: row.tierAfter ?? null,
    verdict: row.verdict ?? null,
    probesGreen: row.probesGreen ?? null,
    // Three-valued (kusabi #165): 1 = changed, 0 = measured no change,
    // NULL = never measured (old record / pre-probe death).  Absent is a
    // fact worth preserving — the report renders NULL as "unknown", never
    // as no-work.
    worktreeChanged: row.worktreeChanged ?? null,
    disposition: row.disposition ?? null,
    reworkCount: row.reworkCount ?? null,
    findingsText: row.findingsText ?? null,
    implementIn: row.implementIn ?? null,
    implementOut: row.implementOut ?? null,
    implementCost: row.implementCost ?? null,
    reviewIn: row.reviewIn ?? null,
    reviewOut: row.reviewOut ?? null,
    reviewCost: row.reviewCost ?? null,
  });
}

// ---------------------------------------------------------------------------
// finding
// ---------------------------------------------------------------------------

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {object} row
 */
export function upsertFinding(db, row) {
  db.prepare(`
    INSERT OR REPLACE INTO finding (chain_id, round, idx, severity, title, file, source)
    VALUES ($chainId, $round, $idx, $severity, $title, $file, $source)
  `).run({
    chainId: row.chainId,
    round: row.round,
    idx: row.idx,
    severity: row.severity ?? null,
    title: row.title ?? null,
    file: row.file ?? null,
    // 'findings' | 'finding_files' — which generation's field this row was
    // derived from.  A row synthesised from `findingFiles` has no
    // severity/title (NULL), same as an incomplete real `findings` entry
    // would; `source` is the only column that tells the two apart.
    source: row.source ?? null,
  });
}

// ---------------------------------------------------------------------------
// job — delegated single-shot jobs (#154)
// ---------------------------------------------------------------------------

/**
 * Upsert one delegated-job row.  `usageCost` uses an explicit
 * `=== undefined ? null :` guard rather than `?? null` purely for symmetry
 * with the schema comment above — `?? null` would also preserve 0, but the
 * point that 0 must survive is worth being unmissable here.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {object} row
 */
export function upsertJob(db, row) {
  db.prepare(`
    INSERT OR REPLACE INTO job
      (job_id, workspace_slug, kind, title, status, phase, backend, model_entry,
       started_at, started_ms, finished_at, finished_ms, duration_seconds,
       steps, error, usage_available, usage_model,
       usage_input, usage_output, usage_reasoning,
       usage_cache_read, usage_cache_write, usage_cost)
    VALUES
      ($jobId, $workspaceSlug, $kind, $title, $status, $phase, $backend, $modelEntry,
       $startedAt, $startedMs, $finishedAt, $finishedMs, $durationSeconds,
       $steps, $error, $usageAvailable, $usageModel,
       $usageInput, $usageOutput, $usageReasoning,
       $usageCacheRead, $usageCacheWrite, $usageCost)
  `).run({
    jobId: row.jobId,
    workspaceSlug: row.workspaceSlug ?? null,
    kind: row.kind ?? null,
    title: row.title ?? null,
    status: row.status ?? null,
    phase: row.phase ?? null,
    // Dispatch backend (kusabi #184), stored verbatim — NULL when the job
    // record predates the split; readers treat NULL as "opencode".
    backend: row.backend ?? null,
    modelEntry: row.modelEntry ?? null,
    startedAt: row.startedAt ?? null,
    startedMs: row.startedMs ?? null,
    finishedAt: row.finishedAt ?? null,
    finishedMs: row.finishedMs ?? null,
    durationSeconds: row.durationSeconds ?? null,
    steps: row.steps ?? null,
    error: row.error ?? null,
    usageAvailable: row.usageAvailable ?? null,
    usageModel: row.usageModel ?? null,
    usageInput: row.usageInput ?? null,
    usageOutput: row.usageOutput ?? null,
    usageReasoning: row.usageReasoning ?? null,
    usageCacheRead: row.usageCacheRead ?? null,
    usageCacheWrite: row.usageCacheWrite ?? null,
    usageCost: row.usageCost === undefined ? null : row.usageCost,
  });
}

export function countRows(db, table) {
  return db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get().c;
}
