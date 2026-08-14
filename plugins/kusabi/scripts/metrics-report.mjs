// metrics-report.mjs — query/report surface over the metrics store built by
// metrics-db.mjs / transcript-ingest.mjs / cursor-usage-ingest.mjs / chain-ingest.mjs.
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

import { classifyEscalate } from "./chain-substance.mjs";

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

// (fmtCoveragePct lived here until kusabi #253 retired the Cursor coverage
// ratio — the only caller.  Nothing else in this file prints a one-decimal
// percentage.)

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

/**
 * Whether `column` exists on `table` — the column-level analogue of
 * tableExists.  `round.worktree_changed` (#165) was added after real
 * on-disk stores already existed; a store written before it must render its
 * escalated chains as "unknown", not crash on `no such column`.
 */
function tableHasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all()
    .some((c) => c.name === column);
}

function isStoreEmpty(db) {
  const tables = ["source_file", "session", "turn", "chain", "round", "finding"];
  if (tableExists(db, "job")) tables.push("job");
  return tables.every((t) => countTable(db, t) === 0);
}

function computeFreshness(db, dbPath) {
  const lastIngestRun = db.prepare("SELECT MAX(ingested_at) AS m FROM source_file").get().m ?? null;
  // MAX(turn.ts) covers every ingested turn row, including cursor-usage
  // samples — the label is "newest ingested turn", not "transcript".
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
  // `backend` (kusabi #184) may be absent from stores written before the
  // split — this surface opens READ-ONLY and can never migrate, so the
  // select degrades to omitting the column and rows read as "opencode".
  const hasBackend = tableHasColumn(db, "chain", "backend");
  const cols = [
    "chain_id", "orch_model", "orch_session", "orch_date",
    "totals_input", "totals_output", "totals_cost",
    "brief_has_smoke", "brief_chars", "brief_has_deliverables",
  ];
  if (hasBackend) cols.push("backend");
  return db.prepare(`SELECT ${cols.join(", ")} FROM chain`).all();
}

function fetchRounds(db) {
  // `worktree_changed` (#165) may be absent from stores written before the
  // column existed — this surface opens READ-ONLY and can never migrate, so
  // the select degrades to omitting the column and rows read as "unknown".
  // Same for `backend` (kusabi #184): absent column -> rows read as
  // "opencode" via the reader contract.  `review_backend` (kusabi #195) is
  // deliberately NOT selected: mixedness is decided at ingest and stored in
  // `chain.backend`, and this read-only surface reads that verbatim — a
  // store written before #195 simply has no "mixed" labels yet (re-ingest
  // is the fix, not re-derivation).
  const hasWorktreeChanged = tableHasColumn(db, "round", "worktree_changed");
  const hasBackend = tableHasColumn(db, "round", "backend");
  const cols = ["chain_id", "round", "started_at", "started_ms", "disposition"];
  if (hasBackend) cols.push("backend");
  if (hasWorktreeChanged) cols.push("worktree_changed");
  return db.prepare(`SELECT ${cols.join(", ")} FROM round`).all();
}

/** Callers must check `tableExists(db, "job")` first (pre-#154 store files
 * have no `job` table and this surface cannot migrate them). */
function fetchJobs(db) {
  // `backend` (kusabi #184) may be absent from stores written before the
  // split — degrade to omitting the column; rows then read as "opencode".
  const hasBackend = tableHasColumn(db, "job", "backend");
  const cols = [
    "job_id", "workspace_slug", "kind", "status", "phase", "model_entry",
    "started_at", "started_ms", "finished_at", "finished_ms",
    "duration_seconds", "steps",
    "usage_available", "usage_input", "usage_output", "usage_reasoning", "usage_cost",
  ];
  if (hasBackend) cols.push("backend");
  return db.prepare(`SELECT ${cols.join(", ")} FROM job`).all();
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

/**
 * Stratification key for one chain's `orch_model` (kusabi #252).
 *
 * The stored value is whatever the orchestrator signed itself as, and the
 * same orchestrator signs two ways: `cursor-grok-4.6` from the model id and
 * `Cursor Grok 4.6` from the display name.  Grouping verbatim split one
 * orchestrator into two strata of 3 and 1 chains, which is a worse lie than
 * the normalisation costs: lowercase, whitespace runs to `-`.
 *
 * Key only — the stored value stays verbatim, and every other section that
 * prints `orch_model` per chain keeps printing it verbatim (same principle
 * as Hazard B in cursor-usage-ingest.mjs).  A null/undefined model keeps its
 * long-standing `(unknown)` bucket rather than being normalised into one.
 */
function orchModelStratumKey(orchModel) {
  if (orchModel === null || orchModel === undefined) return "(unknown)";
  return String(orchModel).trim().toLowerCase().replace(/\s+/g, "-");
}

function computeBriefOutcome(inWindowChains, roundsByChain) {
  const byModel = groupBy(inWindowChains, (c) => orchModelStratumKey(c.orch_model));
  const blocks = [];
  for (const [model, chains] of byModel) {
    let chainsWithNoRounds = 0;
    /** @type {Record<string, Record<string, Record<string, number>>>} */
    const table = {};
    // Escalate split (kusabi #165), same definition as chain-stats.mjs:
    // of the chains whose FINAL disposition is escalate, how many had a
    // worker that produced a change set (substantive) vs never produced one
    // (no-work) vs never recorded whether it did (unknown — old records /
    // pre-probe death).  substantive + noWork + unknown === escalated.
    const escalateSplit = { escalated: 0, substantive: 0, noWork: 0, unknown: 0 };
    for (const c of chains) {
      const rounds = roundsByChain.get(c.chain_id) || [];
      if (rounds.length === 0) {
        chainsWithNoRounds += 1;
        continue;
      }
      const smokeLabel = c.brief_has_smoke ? "Smoke present" : "Smoke absent";
      const disp = finalDisposition(c.chain_id, roundsByChain) ?? "(no disposition)";
      if (disp === "escalate") {
        escalateSplit.escalated += 1;
        const label = classifyEscalate(rounds);
        if (label === "substantive") escalateSplit.substantive += 1;
        else if (label === "no-work") escalateSplit.noWork += 1;
        else escalateSplit.unknown += 1;
      }
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
      escalateSplit,
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
// by-backend split (kusabi #184 Job C, per-phase attribution kusabi #195)
// ---------------------------------------------------------------------------

/**
 * Split the in-window chains and jobs by dispatch backend.  `backend` is
 * stored verbatim — NULL when the record predates the split, and `"mixed"`
 * (kusabi #195) when ingest judged the chain's known phase backends to
 * disagree — and the reader contract (the same one `chain-resume` and
 * `--resume-last` use) is applied HERE: NULL means "opencode", never
 * unknown.  Chains and jobs use the identical plain-field read; there is no
 * report-side re-derivation, because mixedness was decided where the
 * records were in hand (ingest).  Same grouping idiom as the by-model
 * sections: groupBy + one block per key, sorted by key.
 */
function computeBackendSplit(inWindowChains, inWindowJobs, roundsByChain) {
  const chainsByBackend = groupBy(inWindowChains, (c) => c.backend ?? "opencode");
  const jobsByBackend = groupBy(inWindowJobs, (j) => j.backend ?? "opencode");

  const chains = [];
  for (const [backend, chainsOfBackend] of chainsByBackend) {
    // Final-disposition counts use the same definition as section 7 (the
    // disposition of the LAST round); chains with zero rounds are counted
    // separately rather than silently dropped, matching briefOutcome.
    const dispositions = {};
    let chainsWithRounds = 0;
    let totalRounds = 0;
    for (const c of chainsOfBackend) {
      const rounds = roundsByChain.get(c.chain_id) || [];
      if (rounds.length === 0) continue;
      chainsWithRounds += 1;
      totalRounds += rounds.length;
      const disp = finalDisposition(c.chain_id, roundsByChain) ?? "(no disposition)";
      dispositions[disp] = (dispositions[disp] || 0) + 1;
    }
    chains.push({
      backend,
      chainCount: chainsOfBackend.length,
      chainsWithNoRounds: chainsOfBackend.length - chainsWithRounds,
      dispositions,
      roundsPerChain: chainsWithRounds > 0 ? totalRounds / chainsWithRounds : null,
      costUnits: sumNumericField(chainsOfBackend, "totals_cost"),
    });
  }
  chains.sort((a, b) => String(a.backend).localeCompare(String(b.backend)));

  const jobs = [];
  for (const [backend, jobsOfBackend] of jobsByBackend) {
    jobs.push({
      backend,
      jobCount: jobsOfBackend.length,
      // Cost over jobs with a measured numeric cost — same semantics as the
      // delegated-jobs totals (absent cost stays null, measured 0 stays 0).
      costUnits: sumNumericField(jobsOfBackend, "usage_cost"),
    });
  }
  jobs.sort((a, b) => String(a.backend).localeCompare(String(b.backend)));

  return { chains, jobs };
}

// ---------------------------------------------------------------------------
// Cursor sampled output vs window output occupancy — display only, never
// rewrites turn.output
//
// This used to divide the sampled sum by
// cursor_session_counter.total_output_tokens and print the quotient as
// "coverage" against a "reported cumulative".  That premise was wrong
// (kusabi #253): the field is the output currently OCCUPYING the context
// window, and it DECREASES when compaction evicts earlier output (measured
// 45,976 → 36,842 inside one session), so the quotient was a ratio of
// nothing and read as 222% even on correctly collapsed data.  The sink
// payload carries no honest cumulative denominator, so the two numbers are
// printed side by side and never divided.
// ---------------------------------------------------------------------------

/**
 * Whole-store (not window-scoped): `sampledOutput` sums turn.output over
 * request_id LIKE 'cursor:%'; `windowOutput` sums the latest-ts
 * `context_window.total_output_tokens` reading per session (window
 * occupancy — non-cumulative, may decrease).  Returns null when the table is
 * missing or empty so Claude-only stores keep their previous JSON/text shape
 * (aside from the freshness label).
 */
function computeCursorSampledOutput(db) {
  if (!tableExists(db, "cursor_session_counter")) return null;
  const counters = db.prepare(
    "SELECT session_id, total_output_tokens, ts FROM cursor_session_counter",
  ).all();
  if (counters.length === 0) return null;

  const turnRows = db.prepare(
    "SELECT session_id, output FROM turn WHERE request_id LIKE 'cursor:%'",
  ).all();

  const sampledBySession = new Map();
  let sampledTotal = 0;
  for (const t of turnRows) {
    const out = typeof t.output === "number" ? t.output : 0;
    sampledTotal += out;
    if (!t.session_id) continue;
    sampledBySession.set(t.session_id, (sampledBySession.get(t.session_id) ?? 0) + out);
  }

  let windowTotal = 0;
  const sessions = [];
  for (const c of counters) {
    const sampled = sampledBySession.get(c.session_id) ?? 0;
    const windowOutput = typeof c.total_output_tokens === "number" ? c.total_output_tokens : null;
    if (typeof windowOutput === "number") windowTotal += windowOutput;
    sessions.push({
      sessionId: c.session_id,
      sessionIdShort: `${(c.session_id || "").slice(0, 8)}...`,
      sampledOutput: sampled,
      windowOutput,
      windowOutputTs: c.ts ?? null,
    });
  }
  sessions.sort((a, b) => String(a.sessionId).localeCompare(String(b.sessionId)));

  return {
    sampledOutput: sampledTotal,
    // A sum of per-session occupancy snapshots taken at different instants:
    // a rough scale indicator, not a total anything was measured at.
    windowOutput: windowTotal,
    sessions,
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
    byBackend: { chains: [], jobs: [] },
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
      byBackend: { chains: [], jobs: [] },
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
  const byBackend = computeBackendSplit(inWindowChains, inWindowJobs, roundsByChain);
  const cursorSampledOutput = computeCursorSampledOutput(db);

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
    byBackend,
    ...(cursorSampledOutput ? { cursorSampledOutput } : {}),
  };
}

// ---------------------------------------------------------------------------
// text rendering
// ---------------------------------------------------------------------------

function renderFreshness(f) {
  return [
    `Metrics store: ${f.dbPath ?? "(unknown)"} (opened read-only)`,
    `  last ingest run:        ${fmtTs(f.lastIngestRun)}`,
    `  newest ingested turn:   ${fmtTs(f.newestTranscriptTurn)}`,
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
    if (b.escalateSplit && b.escalateSplit.escalated > 0) {
      const es = b.escalateSplit;
      const classifiable = es.substantive + es.noWork;
      if (classifiable === 0) {
        // Every escalated chain predates the worktree_changed field (or died
        // before probes) — the split cannot be computed at all.  Show the
        // absence explicitly, never a silent "no-work 0".
        lines.push(`    escalated chains: ${fmtCount(es.escalated)} (no-work: ?)`);
      } else {
        const parts = [];
        if (es.substantive > 0) parts.push(`substantive ${fmtCount(es.substantive)}`);
        if (es.noWork > 0) parts.push(`no-work ${fmtCount(es.noWork)}`);
        if (es.unknown > 0) parts.push(`unknown ${fmtCount(es.unknown)}`);
        lines.push(`    escalated chains: ${fmtCount(es.escalated)} (${parts.join(", ")})`);
      }
    }
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
 * Render the Cursor sampled-output sum beside the latest window-occupancy
 * reading.  Returns [] when the store has no cursor_session_counter rows, so
 * Claude-only text stays byte-identical aside from the freshness label.
 *
 * The two numbers are printed side by side and never divided — see
 * `computeCursorSampledOutput` (kusabi #253).  Do not reintroduce a ratio or
 * an outlier flag here: there is no denominator in the payload that would
 * make either one mean something.
 */
function renderCursorSampledOutput(section) {
  if (!section) return [];
  const lines = [
    "Cursor sampled output and window output occupancy:",
    `  sampled output ${fmtInt(section.sampledOutput)}  latest window output occupancy ${fmtInt(section.windowOutput)}`,
    "  Sampled output is the sum of the statusline samples ingested as turns, and undercounts (calls between two refreshes are never seen).",
    "  Window output occupancy is what Cursor last reported the context window holding, NOT a cumulative session total: it drops when compaction evicts earlier output, so the two are shown side by side and are not a ratio.",
  ];
  for (const s of section.sessions) {
    lines.push(
      `  ${s.sessionIdShort}  sampled ${fmtInt(s.sampledOutput)}  window occupancy ${fmtInt(s.windowOutput)}`,
    );
  }
  return lines;
}

/**
 * Render the by-backend split (kusabi #184).  Returns [] — no section at
 * all — when the window contains at most one distinct backend, so a
 * single-backend history renders byte-identically to before the split.
 * `"mixed"` (kusabi #195) is just another bucket key here: the ≤1 rule is
 * unchanged, so a window holding only mixed chains and nothing else still
 * prints no section.
 */
function renderBackendSplit(split) {
  if (!split) return [];
  const backends = new Set();
  for (const c of split.chains) backends.add(c.backend);
  for (const j of split.jobs) backends.add(j.backend);
  if (backends.size <= 1) return [];

  const lines = [
    "Chains and jobs by dispatch backend (a record without the field predates the split — counted as \"opencode\"; "
    + "\"mixed\" = a chain whose known phase backends disagree):",
  ];
  for (const c of split.chains) {
    const dispKeys = Object.keys(c.dispositions).sort();
    const dispStr = dispKeys.length === 0
      ? "(none)"
      : dispKeys.map((d) => `${d} ${fmtCount(c.dispositions[d])}`).join(", ");
    const noRounds = c.chainsWithNoRounds > 0 ? `  (${fmtCount(c.chainsWithNoRounds)} without rounds)` : "";
    lines.push(
      `  chains  ${c.backend.padEnd(8)} ${fmtCount(c.chainCount)}  dispositions ${dispStr}  `
      + `rounds/chain ${fmtNum(c.roundsPerChain)}  cost ${fmtCost(c.costUnits)} units${noRounds}`,
    );
  }
  for (const j of split.jobs) {
    lines.push(
      `  jobs    ${j.backend.padEnd(8)} ${fmtCount(j.jobCount)}  cost ${fmtCost(j.costUnits)} units`,
    );
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
  const cursorLines = renderCursorSampledOutput(report.cursorSampledOutput);
  if (cursorLines.length > 0) {
    lines.push("");
    lines.push(...cursorLines);
  }
  const backendSplitLines = renderBackendSplit(report.byBackend);
  if (backendSplitLines.length > 0) {
    lines.push("");
    lines.push(...backendSplitLines);
  }
  return lines.join("\n");
}

/** Render a computed report as a single JSON document. NULL sums stay `null`. */
export function renderReportJson(report) {
  return JSON.stringify(report, null, 2);
}
