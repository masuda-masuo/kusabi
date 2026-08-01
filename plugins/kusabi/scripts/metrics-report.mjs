// metrics-report.mjs — query/report surface over the metrics store built by
// metrics-db.mjs / transcript-ingest.mjs / chain-ingest.mjs.
//
// Pure reader. Every function here takes an already-open database handle
// (opened by the caller with `openMetricsDbReadOnly` from metrics-db.mjs —
// this module never constructs a DatabaseSync itself, so its tests run
// against `:memory:` databases built with the phase-1 `openMetricsDb` +
// upsert* helpers). No CREATE / ALTER / INSERT / UPDATE / DELETE anywhere in
// this file.
//
// No statistics machinery: no correlation, regression, significance,
// normalisation, or averaging across orchestrator models. Section 7 (brief
// vs outcome) is raw counts only, always stratified by `orch_model` —
// orchestrator model is perfectly confounded with calendar date in the
// recorded history, so a rate computed across mixed strata is a wrong
// number that looks right.
//
// Cost is RELATIVE UNITS, never dollars: input x1 + output x5 +
// cache_write x1.25 + cache_read x0.1 (Anthropic's published cross-model
// ratios — output is 5x input price, a 5-minute cache write is 1.25x input,
// a cache read is 0.1x input). This keeps the weighting model-agnostic with
// no per-model price table to rot, but it must never be presented as
// currency.

const WEIGHT_INPUT = 1;
const WEIGHT_OUTPUT = 5;
const WEIGHT_CACHE_WRITE = 1.25;
const WEIGHT_CACHE_READ = 0.1;

const DISPOSITIONS = new Set([
  "accept",
  "accept-with-followup",
  "rework",
  "strategize",
  "escalate",
  "discard",
]);

const NONE = "(none)";

// ---------------------------------------------------------------------------
// number formatting — local digit grouping only, never toLocaleString
// (locale-dependent output would make text non-deterministic across
// machines and the test environment).
// ---------------------------------------------------------------------------

function groupThousands(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Integer count that is always defined (COUNT(*) etc.) — never null. */
function fmtCount(n) {
  return groupThousands(String(Math.trunc(n)));
}

/** Nullable integer sum. Renders `null` as "n/a", never "0". */
function fmtInt(n) {
  if (n === null || n === undefined) return "n/a";
  const sign = n < 0 ? "-" : "";
  return sign + groupThousands(String(Math.trunc(Math.abs(n))));
}

/** Nullable numeric value with up to one decimal (e.g. median round counts). */
function fmtNum(n) {
  if (n === null || n === undefined) return "n/a";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const text = Number.isInteger(abs) ? String(abs) : abs.toFixed(1);
  const [intPart, fracPart] = text.split(".");
  return sign + groupThousands(intPart) + (fracPart ? `.${fracPart}` : "");
}

/** Nullable cost in relative units, two decimals. */
function fmtCost(n) {
  if (n === null || n === undefined) return "n/a";
  const sign = n < 0 ? "-" : "";
  const [intPart, fracPart] = Math.abs(n).toFixed(2).split(".");
  return `${sign}${groupThousands(intPart)}.${fracPart}`;
}

/** Nullable percentage (already computed as 0-100). */
function fmtPct(pct) {
  if (pct === null || pct === undefined) return "n/a";
  return `${Math.round(pct)}%`;
}

function fmtTs(v) {
  return v === null || v === undefined ? NONE : v;
}

// ---------------------------------------------------------------------------
// time bounds — instant comparison only, never lexicographic string compare
// ---------------------------------------------------------------------------

/**
 * Parse a `--since`/`--until` bound to epoch ms. Returns undefined for an
 * absent bound. An unparseable bound is a fatal error — this surface never
 * degrades to string comparison the way chain-stats does.
 *
 * @param {string|undefined} value
 * @param {string} flagLabel  e.g. "--since"
 * @returns {number|undefined}
 */
export function parseTimeBound(value, flagLabel) {
  if (value === undefined || value === null || value === "") return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`${flagLabel}: not a parseable timestamp: ${value}`);
  }
  return ms;
}

function turnInWindow(t, sinceMs, untilMs, hasBound) {
  if (!hasBound) return true;
  if (t.ts_ms === null || t.ts_ms === undefined) return false;
  if (sinceMs !== undefined && t.ts_ms < sinceMs) return false;
  if (untilMs !== undefined && t.ts_ms >= untilMs) return false;
  return true;
}

/**
 * A chain's window key: MIN(round.started_ms) over its rounds; if that is
 * unavailable, Date.parse(orch_date + "T00:00:00Z"); if that is also
 * unusable, null (undated).
 */
function chainWindowKeyMs(chain, roundsByChain) {
  const rounds = roundsByChain.get(chain.chain_id) || [];
  let min;
  for (const r of rounds) {
    if (r.started_ms === null || r.started_ms === undefined) continue;
    if (min === undefined || r.started_ms < min) min = r.started_ms;
  }
  if (min !== undefined) return min;
  if (chain.orch_date) {
    const ms = Date.parse(`${chain.orch_date}T00:00:00Z`);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

function chainInWindow(keyMs, sinceMs, untilMs, hasBound) {
  if (!hasBound) return true;
  if (keyMs === null || keyMs === undefined) return false;
  if (sinceMs !== undefined && keyMs < sinceMs) return false;
  if (untilMs !== undefined && keyMs >= untilMs) return false;
  return true;
}

// ---------------------------------------------------------------------------
// fetch — plain SELECTs, no filtering (filtering happens in JS below so the
// chain-side fallback ladder, which needs Date.parse, is one code path)
// ---------------------------------------------------------------------------

function countTable(db, table) {
  return db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
}

/**
 * Whether `table` exists in this database file.  The `job` table (#154) was
 * added after real on-disk stores already existed, and this surface opens
 * READ-ONLY — it can never run the schema/migration the writable open does.
 * A store written before the table existed must render as "no jobs
 * recorded", not crash on `no such table`.
 */
function tableExists(db, table) {
  return db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = $name",
  ).get({ name: table }) !== undefined;
}

function isStoreEmpty(db) {
  const tables = ["source_file", "session", "turn", "chain", "round", "finding"];
  if (tableExists(db, "job")) tables.push("job");
  return tables.every((t) => countTable(db, t) === 0);
}

function computeFreshness(db, dbPath) {
  const lastIngestRun = db.prepare("SELECT MAX(ingested_at) AS m FROM source_file").get().m ?? null;
  const newestTranscriptTurn = db.prepare("SELECT MAX(ts) AS m FROM turn").get().m ?? null;
  const newestChainRound = db.prepare("SELECT MAX(started_at) AS m FROM round").get().m ?? null;
  const newestChainDate = db.prepare("SELECT MAX(orch_date) AS m FROM chain").get().m ?? null;
  const newestJobStart = tableExists(db, "job")
    ? (db.prepare("SELECT MAX(started_at) AS m FROM job").get().m ?? null)
    : null;
  const sourceFilesRecorded = countTable(db, "source_file");
  return {
    dbPath: dbPath ?? null,
    lastIngestRun,
    newestTranscriptTurn,
    newestChainRound,
    newestChainDate,
    newestJobStart,
    sourceFilesRecorded,
  };
}

function fetchTurns(db) {
  return db.prepare(`
    SELECT request_id, session_id, ts, ts_ms, model, input, output, cache_read, cache_write,
           is_sidechain, is_synthetic
    FROM turn
  `).all();
}

function fetchSessions(db) {
  return db.prepare(`SELECT session_id, first_ts, first_ts_ms FROM session`).all();
}

function fetchChains(db) {
  return db.prepare(`
    SELECT chain_id, orch_model, orch_session, orch_date,
           totals_input, totals_output, totals_cost,
           brief_has_smoke, brief_chars, brief_has_deliverables
    FROM chain
  `).all();
}

function fetchRounds(db) {
  return db.prepare(`SELECT chain_id, round, started_at, started_ms, disposition FROM round`).all();
}

/** Callers must check `tableExists(db, "job")` first (pre-#154 store files
 * have no `job` table and this surface cannot migrate them). */
function fetchJobs(db) {
  return db.prepare(`
    SELECT job_id, workspace_slug, kind, status, phase, model_entry,
           started_at, started_ms, finished_at, finished_ms,
           duration_seconds, steps,
           usage_available, usage_input, usage_output, usage_reasoning, usage_cost
    FROM job
  `).all();
}

/** A job's window key: started_ms, else finished_ms, else null (undated). */
function jobWindowKeyMs(job) {
  if (job.started_ms !== null && job.started_ms !== undefined) return job.started_ms;
  if (job.finished_ms !== null && job.finished_ms !== undefined) return job.finished_ms;
  return null;
}

function jobInWindow(job, sinceMs, untilMs, hasBound) {
  if (!hasBound) return true;
  const keyMs = jobWindowKeyMs(job);
  if (keyMs === null) return false;
  if (sinceMs !== undefined && keyMs < sinceMs) return false;
  if (untilMs !== undefined && keyMs >= untilMs) return false;
  return true;
}

function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

// ---------------------------------------------------------------------------
// cost / usage aggregation
// ---------------------------------------------------------------------------

/**
 * Sum usage columns over `turns`. Turns with no usage recorded (input IS
 * NULL) are skipped entirely. If NO turn in the set has usage, every field
 * (including cost) is null — a SUM over an all-NULL column must render as
 * "n/a", never silently become 0.
 */
function sumUsage(turns) {
  const withUsage = turns.filter((t) => t.input !== null && t.input !== undefined);
  if (withUsage.length === 0) {
    return { input: null, output: null, cacheWrite: null, cacheRead: null, cost: null };
  }
  let input = 0;
  let output = 0;
  let cacheWrite = 0;
  let cacheRead = 0;
  for (const t of withUsage) {
    input += t.input ?? 0;
    output += t.output ?? 0;
    cacheWrite += t.cache_write ?? 0;
    cacheRead += t.cache_read ?? 0;
  }
  const cost = input * WEIGHT_INPUT + output * WEIGHT_OUTPUT
    + cacheWrite * WEIGHT_CACHE_WRITE + cacheRead * WEIGHT_CACHE_READ;
  return { input, output, cacheWrite, cacheRead, cost };
}

// ---------------------------------------------------------------------------
// section 4 — session cost by orchestrator model
// ---------------------------------------------------------------------------

function computeSessionCostByModel(inWindowTurns) {
  const byModel = groupBy(inWindowTurns, (t) => t.model ?? "(unknown)");
  const rows = [];
  for (const [model, turns] of byModel) {
    // Sidechain turns ARE included in totals (real billed spend — Task
    // subagent turns); synthetic turns are excluded entirely from sums.
    const nonSynthetic = turns.filter((t) => !t.is_synthetic);
    const usage = sumUsage(nonSynthetic);
    const totalTokens = usage.input === null
      ? null
      : usage.input + usage.output + usage.cacheWrite + usage.cacheRead;
    const cacheReadPctTokens = usage.cacheRead === null || !totalTokens
      ? null
      : (usage.cacheRead / totalTokens) * 100;
    const cacheReadPctCost = usage.cost === null || !usage.cost
      ? null
      : ((usage.cacheRead * WEIGHT_CACHE_READ) / usage.cost) * 100;

    rows.push({
      model,
      turnCount: turns.length,
      input: usage.input,
      output: usage.output,
      cacheWrite: usage.cacheWrite,
      cacheRead: usage.cacheRead,
      costUnits: usage.cost,
      cacheReadPctTokens,
      cacheReadPctCost,
      sidechainCount: turns.filter((t) => t.is_sidechain).length,
      syntheticCount: turns.filter((t) => t.is_synthetic).length,
      noUsageRecorded: turns.filter((t) => (t.input === null || t.input === undefined) && !t.is_synthetic).length,
    });
  }
  rows.sort((a, b) => a.model.localeCompare(b.model));
  return rows;
}

// ---------------------------------------------------------------------------
// section 5 — sessions in window
// ---------------------------------------------------------------------------

/** Per-session in-window aggregates, keyed by session_id — for ALL sessions
 * (not just ones that end up listed), so section 6's join can look up any
 * matched session's numbers even if it has zero in-window turns. */
function computeSessionAggregates(sessions, inWindowTurns) {
  const bySession = groupBy(inWindowTurns, (t) => t.session_id);
  const map = new Map();
  for (const s of sessions) {
    const turns = bySession.get(s.session_id) || [];
    const nonSynthetic = turns.filter((t) => !t.is_synthetic);
    const usage = sumUsage(nonSynthetic);
    map.set(s.session_id, {
      session: s,
      turnCount: turns.length,
      costUnits: usage.cost,
      cacheRead: usage.cacheRead,
      syntheticCount: turns.filter((t) => t.is_synthetic).length,
    });
  }
  return map;
}

function computeSessionsList(sessionAggMap) {
  const rows = [];
  for (const agg of sessionAggMap.values()) {
    if (agg.turnCount === 0) continue;
    const cacheReadShareOfCost = !agg.costUnits
      ? null
      : ((agg.cacheRead ?? 0) * WEIGHT_CACHE_READ / agg.costUnits) * 100;
    rows.push({
      firstTs: agg.session.first_ts,
      firstTsMs: agg.session.first_ts_ms,
      sessionId: agg.session.session_id,
      sessionIdShort: `${(agg.session.session_id || "").slice(0, 8)}...`,
      turnCount: agg.turnCount,
      costUnits: agg.costUnits,
      cacheReadShareOfCost,
      syntheticCount: agg.syntheticCount,
    });
  }
  rows.sort((a, b) => (b.firstTsMs ?? -Infinity) - (a.firstTsMs ?? -Infinity));
  return rows;
}

// ---------------------------------------------------------------------------
// section 6 — orchestrator vs worker, per chain (the prefix join)
// ---------------------------------------------------------------------------

function matchSessionsForChain(chain, allSessions) {
  const prefix = chain.orch_session;
  // Guard: an empty (or too-short-to-be-real) prefix must not match every
  // session in the store.
  if (!prefix || prefix.length < 8) return [];
  return allSessions.filter((s) => (s.session_id || "").slice(0, prefix.length) === prefix);
}

function computeChainJoin(inWindowChains, sessionAggMap, allSessions) {
  const matchesByChain = new Map();
  for (const c of inWindowChains) {
    matchesByChain.set(c.chain_id, matchSessionsForChain(c, allSessions));
  }

  // How many in-window chains resolve (unambiguously) to the same session —
  // needed for the "(x4)" annotation, since one orchestrator session can
  // launch several chains.
  const sharedCount = new Map();
  for (const c of inWindowChains) {
    const matches = matchesByChain.get(c.chain_id);
    if (matches.length === 1) {
      const sid = matches[0].session_id;
      sharedCount.set(sid, (sharedCount.get(sid) || 0) + 1);
    }
  }

  const rows = [];
  for (const c of inWindowChains) {
    const matches = matchesByChain.get(c.chain_id);
    let orchestrator;
    if (matches.length === 1) {
      const sid = matches[0].session_id;
      const agg = sessionAggMap.get(sid);
      orchestrator = {
        state: "matched",
        sessionId: sid,
        sessionIdShort: `${sid.slice(0, 8)}...`,
        sharedChainCount: sharedCount.get(sid) || 1,
        turnCount: agg ? agg.turnCount : 0,
        costUnits: agg ? agg.costUnits : null,
      };
    } else if (matches.length >= 2) {
      orchestrator = { state: "ambiguous", matchCount: matches.length };
    } else {
      orchestrator = { state: "orphan" };
    }
    rows.push({
      chainId: c.chain_id,
      orchModel: c.orch_model,
      orchSessionPrefix: c.orch_session,
      orchestrator,
      totalsInput: c.totals_input,
      totalsOutput: c.totals_output,
      totalsCost: c.totals_cost,
    });
  }
  rows.sort((a, b) => String(a.chainId).localeCompare(String(b.chainId)));
  return rows;
}

// ---------------------------------------------------------------------------
// section 7 — brief metrics vs outcome, stratified by orch_model
// ---------------------------------------------------------------------------

function roundBucket(n) {
  return n >= 4 ? "rounds=4+" : `rounds=${n}`;
}

/** Final disposition = disposition of the chain's LAST round (round = MAX(round)).
 * Same definition chain-stats.mjs already uses; the two surfaces must not
 * disagree about what "final" means. */
function finalDisposition(chainId, roundsByChain) {
  const rounds = roundsByChain.get(chainId) || [];
  if (rounds.length === 0) return null;
  let last = rounds[0];
  for (const r of rounds) {
    if (r.round > last.round) last = r;
  }
  const disp = last.disposition;
  if (!disp) return null;
  return DISPOSITIONS.has(disp) ? disp : "other";
}

function median(nums) {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function emptyBucketRow() {
  return { "rounds=1": 0, "rounds=2": 0, "rounds=3": 0, "rounds=4+": 0 };
}

function computeBriefOutcome(inWindowChains, roundsByChain) {
  const byModel = groupBy(inWindowChains, (c) => c.orch_model ?? "(unknown)");
  const blocks = [];
  for (const [model, chains] of byModel) {
    let chainsWithNoRounds = 0;
    /** @type {Record<string, Record<string, Record<string, number>>>} */
    const table = {};
    for (const c of chains) {
      const rounds = roundsByChain.get(c.chain_id) || [];
      if (rounds.length === 0) {
        chainsWithNoRounds += 1;
        continue;
      }
      const smokeLabel = c.brief_has_smoke ? "Smoke present" : "Smoke absent";
      const disp = finalDisposition(c.chain_id, roundsByChain) ?? "(no disposition)";
      const bucket = roundBucket(rounds.length);
      if (!table[smokeLabel]) table[smokeLabel] = {};
      if (!table[smokeLabel][disp]) table[smokeLabel][disp] = emptyBucketRow();
      table[smokeLabel][disp][bucket] += 1;
    }

    const briefChars = chains
      .map((c) => c.brief_chars)
      .filter((v) => v !== null && v !== undefined);
    const withDeliverables = chains.filter((c) => c.brief_has_deliverables).length;

    blocks.push({
      orchModel: model,
      chainCount: chains.length,
      chainsWithNoRounds,
      table,
      briefChars: {
        min: briefChars.length ? Math.min(...briefChars) : null,
        median: median(briefChars),
        max: briefChars.length ? Math.max(...briefChars) : null,
      },
      withDeliverables,
      totalChains: chains.length,
    });
  }
  blocks.sort((a, b) => String(a.orchModel).localeCompare(String(b.orchModel)));
  return blocks;
}

// ---------------------------------------------------------------------------
// section 8 — delegated jobs (#154)
//
// Deliberately a SEPARATE section, not rows grafted onto `Orchestrator vs
// worker, per chain`: that view is per-chain by construction (rounds,
// dispositions, the prefix join), and a job has none of those — folding
// chain-less records in would distort both halves.  Nothing here touches
// the chain sections' inputs.
// ---------------------------------------------------------------------------

function emptyDelegatedJobs() {
  return {
    jobCount: 0,
    statusCounts: {},
    jobsWithoutUsage: 0,
    jobsUsageUnavailable: 0,
    totals: { output: null, reasoning: null, cost: null, durationSeconds: null },
    jobs: [],
  };
}

/** Sum `field` over rows where it is an actual number; null when none is —
 * a sum of measured zeros is 0, a sum over nothing is null. */
function sumNumericField(rows, field) {
  const vals = rows.map((r) => r[field]).filter((v) => typeof v === "number");
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0);
}

function computeDelegatedJobs(inWindowJobs) {
  // Status counts are verbatim — the vocabulary observed on disk is
  // completed / provider-error / error / cancelled, but an unknown value
  // must survive to the report, never be dropped by an enum.
  const statusCounts = {};
  for (const j of inWindowJobs) {
    const s = j.status ?? "(no status)";
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  }

  // usage_available: null = usage.json never written (died early — the
  // job-side analogue of "chains that died without writing chain.json");
  // 0 = written but available:false; 1 = measured.
  const jobsWithoutUsage = inWindowJobs
    .filter((j) => j.usage_available === null || j.usage_available === undefined).length;
  const jobsUsageUnavailable = inWindowJobs.filter((j) => j.usage_available === 0).length;
  const withMeasuredUsage = inWindowJobs.filter((j) => j.usage_available === 1);

  const totals = {
    output: sumNumericField(withMeasuredUsage, "usage_output"),
    reasoning: sumNumericField(withMeasuredUsage, "usage_reasoning"),
    // cost 0 (free tier) is a real measurement: it participates in the sum,
    // and an all-zero sum renders 0.00, never "n/a".
    cost: sumNumericField(withMeasuredUsage, "usage_cost"),
    durationSeconds: sumNumericField(inWindowJobs, "duration_seconds"),
  };

  const jobs = inWindowJobs.map((j) => ({
    jobId: j.job_id,
    workspaceSlug: j.workspace_slug,
    kind: j.kind,
    status: j.status,
    startedAt: j.started_at,
    startedMs: j.started_ms,
    steps: j.steps,
    durationSeconds: j.duration_seconds,
    modelEntry: j.model_entry,
    usageState: (j.usage_available === null || j.usage_available === undefined)
      ? "never_written"
      : (j.usage_available === 1 ? "measured" : "unavailable"),
    output: j.usage_output,
    reasoning: j.usage_reasoning,
    cost: j.usage_cost,
  }));
  jobs.sort((a, b) => (b.startedMs ?? -Infinity) - (a.startedMs ?? -Infinity));

  return {
    jobCount: inWindowJobs.length,
    statusCounts,
    jobsWithoutUsage,
    jobsUsageUnavailable,
    totals,
    jobs,
  };
}

// ---------------------------------------------------------------------------
// top-level report
// ---------------------------------------------------------------------------

/**
 * Report for a missing database file — the caller must check
 * `fs.existsSync(dbPath)` BEFORE calling `openMetricsDbReadOnly` (a
 * read-only open of a missing path throws) and use this instead of
 * `computeReport` when the file does not exist.
 *
 * @param {string} dbPath
 */
export function missingStoreReport(dbPath) {
  return {
    status: "missing",
    freshness: {
      dbPath,
      lastIngestRun: null,
      newestTranscriptTurn: null,
      newestChainRound: null,
      newestChainDate: null,
      newestJobStart: null,
      sourceFilesRecorded: 0,
    },
    window: null,
    sessionCostByModel: [],
    sessionsInWindow: [],
    chainJoin: [],
    briefOutcome: [],
    delegatedJobs: emptyDelegatedJobs(),
  };
}

export function renderMissingText(dbPath) {
  return `Metrics store not found at ${dbPath}. Run metrics-ingest first.`;
}

/**
 * Compute the full report over an already-open, read-only database handle.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{ since?: string, until?: string, dbPath?: string }} [opts]
 */
export function computeReport(db, opts = {}) {
  const { since, until, dbPath } = opts;
  const sinceMs = parseTimeBound(since, "--since");
  const untilMs = parseTimeBound(until, "--until");
  const hasBound = sinceMs !== undefined || untilMs !== undefined;

  // Whole-store maxima, computed BEFORE and INDEPENDENTLY of any window
  // filter — a window that excludes the newest data must not change how
  // fresh/stale the store looks.
  const freshness = computeFreshness(db, dbPath);

  if (isStoreEmpty(db)) {
    return {
      status: "empty",
      freshness,
      window: null,
      sessionCostByModel: [],
      sessionsInWindow: [],
      chainJoin: [],
      briefOutcome: [],
      delegatedJobs: emptyDelegatedJobs(),
    };
  }

  const allTurns = fetchTurns(db);
  const allSessions = fetchSessions(db);
  const allChains = fetchChains(db);
  const allRounds = fetchRounds(db);
  // A store file written before #154 has no `job` table and cannot be
  // migrated by a read-only open — treated as zero jobs, not an error.
  const allJobs = tableExists(db, "job") ? fetchJobs(db) : [];
  const roundsByChain = groupBy(allRounds, (r) => r.chain_id);

  const inWindowTurns = allTurns.filter((t) => turnInWindow(t, sinceMs, untilMs, hasBound));
  const turnsExcludedNoTimestamp = hasBound
    ? allTurns.filter((t) => t.ts_ms === null || t.ts_ms === undefined).length
    : 0;

  const chainKeyMs = new Map(allChains.map((c) => [c.chain_id, chainWindowKeyMs(c, roundsByChain)]));
  const inWindowChains = allChains.filter((c) => chainInWindow(chainKeyMs.get(c.chain_id), sinceMs, untilMs, hasBound));
  const chainsExcludedNoTimestamp = hasBound
    ? allChains.filter((c) => chainKeyMs.get(c.chain_id) === null).length
    : 0;

  const inWindowJobs = allJobs.filter((j) => jobInWindow(j, sinceMs, untilMs, hasBound));
  const jobsExcludedNoTimestamp = hasBound
    ? allJobs.filter((j) => jobWindowKeyMs(j) === null).length
    : 0;

  const sessionAggMap = computeSessionAggregates(allSessions, inWindowTurns);
  const sessionsInWindowCount = [...sessionAggMap.values()].filter((a) => a.turnCount > 0).length;

  const sessionCostByModel = computeSessionCostByModel(inWindowTurns);
  const sessionsInWindow = computeSessionsList(sessionAggMap);
  const chainJoin = computeChainJoin(inWindowChains, sessionAggMap, allSessions);
  const briefOutcome = computeBriefOutcome(inWindowChains, roundsByChain);
  const delegatedJobs = computeDelegatedJobs(inWindowJobs);

  const status = (inWindowTurns.length === 0 && inWindowChains.length === 0 && inWindowJobs.length === 0)
    ? "empty_window"
    : "ok";

  return {
    status,
    freshness,
    window: {
      since: since ?? null,
      until: until ?? null,
      hasBound,
      turnsInWindow: inWindowTurns.length,
      sessionsInWindow: sessionsInWindowCount,
      chainsInWindow: inWindowChains.length,
      jobsInWindow: inWindowJobs.length,
      turnsExcludedNoTimestamp,
      chainsExcludedNoTimestamp,
      jobsExcludedNoTimestamp,
    },
    sessionCostByModel,
    sessionsInWindow,
    chainJoin,
    briefOutcome,
    delegatedJobs,
  };
}

// ---------------------------------------------------------------------------
// text rendering
// ---------------------------------------------------------------------------

function renderFreshness(f) {
  return [
    `Metrics store: ${f.dbPath ?? "(unknown)"} (opened read-only)`,
    `  last ingest run:        ${fmtTs(f.lastIngestRun)}`,
    `  newest transcript turn: ${fmtTs(f.newestTranscriptTurn)}`,
    `  newest chain round:     ${fmtTs(f.newestChainRound)}`,
    `  newest chain date:      ${fmtTs(f.newestChainDate)}`,
    `  newest job start:       ${fmtTs(f.newestJobStart)}`,
    `  source files recorded:  ${fmtCount(f.sourceFilesRecorded)}`,
    "  This command only reads the store; it never ingests. Stale timestamps above mean the ingest timer has not run.",
  ];
}

function renderWindowLine(w) {
  const rangeLabel = w.hasBound
    ? `since ${w.since ?? "(none)"} until ${w.until ?? "(none)"}`
    : "all time";
  const lines = [`Window: ${rangeLabel}`];
  lines.push(`  turns: ${fmtCount(w.turnsInWindow)}  sessions: ${fmtCount(w.sessionsInWindow)}  chains: ${fmtCount(w.chainsInWindow)}  jobs: ${fmtCount(w.jobsInWindow)}`);
  if (w.hasBound) {
    lines.push(`  excluded (no timestamp): turns ${fmtCount(w.turnsExcludedNoTimestamp)}, chains ${fmtCount(w.chainsExcludedNoTimestamp)}, jobs ${fmtCount(w.jobsExcludedNoTimestamp)}`);
  }
  return lines;
}

function renderSessionCostByModel(rows) {
  const lines = [
    "Session cost by orchestrator model:",
    "  Cost is in RELATIVE UNITS, not dollars:",
    "  input x1 + output x5 + cache_write x1.25 + cache_read x0.1",
  ];
  if (rows.length === 0) {
    lines.push("  (no data in window)");
    return lines;
  }
  for (const r of rows) {
    lines.push(
      `  ${r.model}: turns ${fmtCount(r.turnCount)}  input ${fmtInt(r.input)}  output ${fmtInt(r.output)}  `
      + `cache_write ${fmtInt(r.cacheWrite)}  cache_read ${fmtInt(r.cacheRead)}  cost ${fmtCost(r.costUnits)} units  `
      + `cache read: ${fmtPct(r.cacheReadPctTokens)} of tokens, ${fmtPct(r.cacheReadPctCost)} of cost`,
    );
    lines.push(
      `    sidechain ${fmtCount(r.sidechainCount)} turns | synthetic ${fmtCount(r.syntheticCount)} | no usage recorded ${fmtCount(r.noUsageRecorded)}`,
    );
  }
  return lines;
}

function renderSessionsList(rows) {
  const lines = ["Sessions in window, newest first:"];
  if (rows.length === 0) {
    lines.push("  (no data in window)");
    return lines;
  }
  for (const r of rows) {
    lines.push(
      `  ${fmtTs(r.firstTs)}  ${r.sessionIdShort}  turns ${fmtCount(r.turnCount)}  `
      + `cost ${fmtCost(r.costUnits)} units  cache-read share of cost ${fmtPct(r.cacheReadShareOfCost)}  `
      + `synthetic ${fmtCount(r.syntheticCount)}`,
    );
  }
  return lines;
}

function renderChainJoin(rows, windowBounded) {
  const scope = windowBounded
    ? "the IN-WINDOW portion of the orchestrator session (bounded by --since/--until)"
    : "the WHOLE orchestrator session";
  const lines = [
    "Orchestrator vs worker, per chain:",
    `  WARNING: the orchestrator columns describe ${scope}, not the chain.`,
    "  They are NOT per-chain and MUST NOT be summed across rows (one orchestrator session can",
    "  launch several chains — see the (xN) annotation).",
  ];
  if (rows.length === 0) {
    lines.push("  (no data in window)");
    return lines;
  }
  for (const r of rows) {
    let orchStr;
    if (r.orchestrator.state === "matched") {
      orchStr = `${r.orchestrator.sessionIdShort} (x${r.orchestrator.sharedChainCount})  `
        + `orch turns ${fmtCount(r.orchestrator.turnCount)}  orch cost ${fmtCost(r.orchestrator.costUnits)} units`;
    } else if (r.orchestrator.state === "ambiguous") {
      orchStr = `ambiguous (${r.orchestrator.matchCount} sessions)`;
    } else {
      orchStr = "orphan (session not ingested)";
    }
    lines.push(
      `  ${r.chainId}  orch_model ${r.orchModel ?? "(unknown)"}  session ${r.orchSessionPrefix ?? "(none)"}  ${orchStr}  |  `
      + `chain totals: input ${fmtInt(r.totalsInput)}  output ${fmtInt(r.totalsOutput)}  cost ${fmtCost(r.totalsCost)} units`,
    );
  }
  return lines;
}

function renderBriefOutcomeTable(table) {
  const lines = [];
  const smokeLabels = Object.keys(table).sort();
  if (smokeLabels.length === 0) {
    lines.push("    (no chains with rounds)");
    return lines;
  }
  lines.push(`    ${"".padEnd(36)}rounds=1  rounds=2  rounds=3  rounds=4+`);
  for (const smokeLabel of smokeLabels) {
    const dispositions = Object.keys(table[smokeLabel]).sort();
    for (const disp of dispositions) {
      const cell = table[smokeLabel][disp];
      const label = `${smokeLabel} / ${disp}`;
      lines.push(
        `    ${label.padEnd(36)}`
        + `${String(cell["rounds=1"]).padStart(8)}  ${String(cell["rounds=2"]).padStart(8)}  `
        + `${String(cell["rounds=3"]).padStart(8)}  ${String(cell["rounds=4+"]).padStart(9)}`,
      );
    }
  }
  return lines;
}

function renderBriefOutcome(blocks) {
  const lines = [
    "Brief metrics vs outcome (raw chain counts, always stratified by orch_model — never comparable across models):",
  ];
  if (blocks.length === 0) {
    lines.push("  (no data in window)");
    return lines;
  }
  for (const b of blocks) {
    lines.push(`  orch_model: ${b.orchModel} (${fmtCount(b.chainCount)} chains)`);
    lines.push(`    chains with no rounds: ${fmtCount(b.chainsWithNoRounds)}`);
    lines.push(...renderBriefOutcomeTable(b.table));
    lines.push(`    brief_chars: min ${fmtNum(b.briefChars.min)}  median ${fmtNum(b.briefChars.median)}  max ${fmtNum(b.briefChars.max)}`);
    lines.push(
      `    with ## Deliverables: ${fmtCount(b.withDeliverables)}/${fmtCount(b.totalChains)} `
      + "(present in every brief in the corpus measured so far — no discriminating power, shown for completeness only)",
    );
  }
  return lines;
}

function renderDelegatedJobRow(j) {
  let usageStr;
  if (j.usageState === "measured") {
    // cost is the provider-reported figure — 0.00 (free tier) is a real
    // measurement and renders as 0.00; only a truly absent field is n/a.
    usageStr = `out ${fmtInt(j.output)}  reasoning ${fmtInt(j.reasoning)}  cost ${fmtCost(j.cost)}`;
  } else if (j.usageState === "unavailable") {
    usageStr = "usage recorded but unavailable";
  } else {
    usageStr = "usage.json never written";
  }
  const durationStr = (j.durationSeconds === null || j.durationSeconds === undefined)
    ? "duration n/a"
    : `${fmtNum(j.durationSeconds)}s`;
  return `  ${fmtTs(j.startedAt)}  ${j.jobId}  ${j.status ?? "(no status)"}  `
    + `steps ${fmtInt(j.steps)}  ${usageStr}  ${durationStr}  `
    + `${j.modelEntry ?? "(no model)"}  ws ${j.workspaceSlug ?? "(none)"}`;
}

function renderDelegatedJobs(section) {
  const lines = [
    "Delegated jobs (single-shot task/review jobs — not chains: no rounds, no disposition):",
  ];
  if (section.jobCount === 0) {
    lines.push("  (no data in window)");
    return lines;
  }
  const statusStr = Object.keys(section.statusCounts)
    .sort()
    .map((s) => `${s} ${fmtCount(section.statusCounts[s])}`)
    .join(" | ");
  lines.push(`  status counts: ${statusStr}`);
  lines.push(
    `  usage.json never written (job ended before usage persisted): ${fmtCount(section.jobsWithoutUsage)}`
    + `  |  usage recorded but unavailable: ${fmtCount(section.jobsUsageUnavailable)}`,
  );
  lines.push(
    `  totals over jobs with measured usage: output ${fmtInt(section.totals.output)}  `
    + `reasoning ${fmtInt(section.totals.reasoning)}  cost ${fmtCost(section.totals.cost)}  `
    + `|  recorded duration (all jobs): ${fmtNum(section.totals.durationSeconds)}s`,
  );
  lines.push("  Cost is the provider-reported figure, NOT the relative units above — 0.00 on a free-tier route is a real measurement, not missing data.");
  lines.push("  A 'completed' status can still be a failure (quota deaths appear as completed with tiny output) — judge by the measured output/steps/duration, not the status string.");
  for (const j of section.jobs) {
    lines.push(renderDelegatedJobRow(j));
  }
  return lines;
}

/**
 * Render a computed report (from `computeReport` or `missingStoreReport`) as
 * plain aligned text.
 */
export function renderReportText(report) {
  if (report.status === "missing") {
    return renderMissingText(report.freshness.dbPath);
  }

  const lines = [...renderFreshness(report.freshness)];

  if (report.status === "empty") {
    lines.push("");
    lines.push("Store is empty (0 sessions, 0 turns, 0 chains, 0 jobs).");
    return lines.join("\n");
  }

  lines.push("");
  lines.push(...renderWindowLine(report.window));
  lines.push("");
  lines.push(...renderSessionCostByModel(report.sessionCostByModel));
  lines.push("");
  lines.push(...renderSessionsList(report.sessionsInWindow));
  lines.push("");
  lines.push(...renderChainJoin(report.chainJoin, report.window.hasBound));
  lines.push("");
  lines.push(...renderBriefOutcome(report.briefOutcome));
  lines.push("");
  lines.push(...renderDelegatedJobs(report.delegatedJobs));
  return lines.join("\n");
}

/** Render a computed report as a single JSON document. NULL sums stay `null`. */
export function renderReportJson(report) {
  return JSON.stringify(report, null, 2);
}
