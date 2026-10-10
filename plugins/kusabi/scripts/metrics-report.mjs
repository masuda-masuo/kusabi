// metrics-report.mjs — query/compute surface over the metrics store built by
// metrics-db.mjs / transcript-ingest.mjs / codex-usage-ingest.mjs / chain-ingest.mjs.
//
// Pure reader. Every function here takes an already-open database handle
// (opened by the caller with `openMetricsDbReadOnly` from metrics-db.mjs —
// this module never constructs a DatabaseSync itself, so its tests run
// against `:memory:` databases built with the phase-1 `openMetricsDb` +
// upsert* helpers). No CREATE / ALTER / INSERT / UPDATE / DELETE anywhere in
// this file.
//
// Rendering the computed report object to text/JSON is the separate concern
// of metrics-render.mjs; this module only fetches and aggregates. Import
// direction is render -> compute, never the other way.
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

import {
  finalDisposition,
  createEscalateSplit,
  recordEscalate,
  parseTimeBound,
  turnInWindow,
  chainWindowKeyMs,
  chainInWindow,
  jobWindowKeyMs,
  jobInWindow,
  SEVERITY_ORDER,
  REVIEW_SOURCE_VALUES,
  computeDispositionSeverity,
  computeReviewPathology,
  emptyReviewPathology,
} from "./chain-metrics-core.mjs";
import { STOP_REASONS, UNKNOWN_STOP_REASON } from "./stop-reason.mjs";
import { normalizeToolStats } from "./tool-stats.mjs";

export { parseTimeBound, SEVERITY_ORDER };

const WEIGHT_INPUT = 1;
const WEIGHT_OUTPUT = 5;
const WEIGHT_CACHE_WRITE = 1.25;
const WEIGHT_CACHE_READ = 0.1;



// ---------------------------------------------------------------------------
// time bounds — instant comparison only, never lexicographic string compare
// ---------------------------------------------------------------------------



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
  // MAX(turn.ts) covers every ingested turn row — the label is "newest ingested turn", not "transcript".
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
  if (tableHasColumn(db, "chain", "smoke_lines")) cols.push("smoke_lines");
  if (tableHasColumn(db, "chain", "smoke_baseline_red")) cols.push("smoke_baseline_red");
  if (tableHasColumn(db, "chain", "smoke_observes_change")) cols.push("smoke_observes_change");
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
  // is the fix, not re-derivation).  `verdict_source` (kusabi #235) is
  // guarded the same way: a pre-#235 store renders every source as
  // "unknown" rather than crashing on `no such column`.
  const hasWorktreeChanged = tableHasColumn(db, "round", "worktree_changed");
  const hasBackend = tableHasColumn(db, "round", "backend");
  const hasVerdictSource = tableHasColumn(db, "round", "verdict_source");
  // kusabi #380 — closed terminal reason.  Absent from stores written before
  // the column existed; this read-only surface cannot migrate, so it degrades
  // to omitting the column and rows read as "absent" (never as completed).
  const hasStopReason = tableHasColumn(db, "round", "stop_reason");
  // verdict / probes_green have been in the schema since the first metrics
  // store, so they are always selected.
  const cols = ["chain_id", "round", "started_at", "started_ms", "disposition", "verdict", "probes_green"];
  if (hasBackend) cols.push("backend");
  if (hasWorktreeChanged) cols.push("worktree_changed");
  if (hasVerdictSource) cols.push("verdict_source");
  if (hasStopReason) cols.push("stop_reason");
  return db.prepare(`SELECT ${cols.join(", ")} FROM round`).all();
}

function fetchFindings(db) {
  // severity only — the round-level disposition × severity table needs
  // nothing else.  severity has been in the schema since the first store.
  return db.prepare(`SELECT chain_id, round, severity FROM finding`).all();
}

/** Callers must check `tableExists(db, "job")` first (pre-#154 store files
 * have no `job` table and this surface cannot migrate them). */
function fetchJobs(db) {
  // `backend` (kusabi #184) may be absent from stores written before the
  // split — degrade to omitting the column; rows then read as "opencode".
  const hasBackend = tableHasColumn(db, "job", "backend");
  // kusabi #380 — closed terminal reason.  Absent from stores written before
  // the column existed; this read-only surface cannot migrate, so it degrades
  // to omitting the column and rows read as "absent" (never as completed).
  const hasStopReason = tableHasColumn(db, "job", "stop_reason");
  const cols = [
    "job_id", "workspace_slug", "kind", "status", "phase", "model_entry",
    "started_at", "started_ms", "finished_at", "finished_ms",
    "duration_seconds", "steps",
    "usage_available", "usage_input", "usage_output", "usage_reasoning", "usage_cost",
  ];
  if (hasBackend) cols.push("backend");
  if (hasStopReason) cols.push("stop_reason");
  return db.prepare(`SELECT ${cols.join(", ")} FROM job`).all();
}

/** Pre-#381 stores have no `tool_stat` table; treated as zero rows. */
function fetchToolStats(db) {
  if (!tableExists(db, "tool_stat")) return [];
  return db.prepare("SELECT job_id, tool, count, success, failure FROM tool_stat").all();
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
 * same orchestrator signs two ways: `claude-sonnet-4` from the model id and
 * `Claude Sonnet 4` from the display name.  Grouping verbatim split one
 * orchestrator into two strata of 3 and 1 chains, which is a worse lie than
 * the normalisation costs: lowercase, whitespace runs to `-`.
 *
 * Key only — the stored value stays verbatim, and every other section that
 * prints `orch_model` per chain keeps printing it verbatim (same principle
 * as in usage ingest).  A null/undefined model keeps its
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
    const escalateSplit = createEscalateSplit({ includeEscalated: true });
    for (const c of chains) {
      const rounds = roundsByChain.get(c.chain_id) || [];
      if (rounds.length === 0) {
        chainsWithNoRounds += 1;
        continue;
      }
      const smokeLabel = c.brief_has_smoke ? "Smoke present" : "Smoke absent";
      const disp = finalDisposition(c.chain_id, roundsByChain) ?? "(no disposition)";
      if (disp === "escalate") {
        recordEscalate(escalateSplit, rounds);
      }
      const bucket = roundBucket(rounds.length);
      if (!table[smokeLabel]) table[smokeLabel] = {};
      if (!table[smokeLabel][disp]) table[smokeLabel][disp] = emptyBucketRow();
      table[smokeLabel][disp][bucket] += 1;
    }

    let smokeSplit = null;
    const hasAnySmokeObs = chains.some(
      (c) => c.smoke_observes_change !== null && c.smoke_observes_change !== undefined
    );
    if (hasAnySmokeObs) {
      const yes = { total: 0, byDisp: {} };
      const no = { total: 0, byDisp: {} };
      const unknown = { total: 0, byDisp: {} };
      for (const c of chains) {
        const rounds = roundsByChain.get(c.chain_id) || [];
        if (rounds.length === 0) continue;
        const disp = finalDisposition(c.chain_id, roundsByChain) ?? "(no disposition)";
        let target = unknown;
        if (c.smoke_observes_change === 1) target = yes;
        else if (c.smoke_observes_change === 0) target = no;
        target.total += 1;
        target.byDisp[disp] = (target.byDisp[disp] || 0) + 1;
      }
      smokeSplit = { yes, no, unknown };
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
      ...(smokeSplit ? { smokeObservesChange: smokeSplit } : {}),
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
// kusabi #235 — round-level review-side metrics.
//
// THREE sections, all ROUND-level.  They sit next to the #165 escalate split
// (#165 classifies by the IMPLEMENT axis — did the worker produce a change
// set — over the CHAIN's FINAL round; these classify by the REVIEW axis over
// every round).  The unit difference is deliberate and labelled in the
// output: a chain whose round-1 review failed and whose round-2 review
// recovered is one "escalated chain" to #165 but two rounds here, and both
// surfaces must not disagree about what "final" means — so `finalDisposition`
// and the #165 split are untouched, and these sections never mention "final".
//
// Invariants from the issue:
//   - unknown verdict values are reported verbatim, never dropped by an enum;
//   - NULL probes_green is a distinct bucket from 0 (red);
//   - NULL verdict_source is its own "unknown" bucket, never folded into
//     review-issued or probe-issued;
//   - an unrecognized NON-NULL verdict_source is its own "other" bucket
//     (raw value kept and rendered verbatim) — the ingest pass-through
//     discipline (chain-ingest.mjs) must not be defeated one layer up by
//     silently counting it as review output;
//   - distributions only — no better/worse-over-time claims.
// ---------------------------------------------------------------------------

/** Verdicts that mean the review could not produce a usable judgement.
 * Corrected set from the issue's comment (kusabi #235): `discard` is a
 * DESIGNED judgement (P3 empty change set — the probe writes it without
 * dispatching a review; a review-issued discard means "the premise of the
 * change is wrong", phase-chain.md L219) and `approve-partial` is a
 * judgement (approve with a partial stream), so neither is pathology.  The
 * two that are: `unparseable` (no JSON and no recoverable verdict token)
 * and `partial` (the stream ended before the verdict record — the safety
 * net that is not a goal, kusabi #202). */


/**
 * Section A — escalate review-axis split (round-level).
 *
 * Every round whose disposition is "escalate", broken down by `verdict`
 * (verbatim — an unknown value is its own row, never dropped), crossed with
 * probes_green (green / red / unknown — NULL is a distinct bucket from 0)
 * and with verdict_source (review / probe / unknown / other — NULL source
 * is its own "unknown" bucket, never folded into either; an unrecognized
 * non-NULL source is its own "other" bucket with the raw value(s) kept for
 * the renderer, never counted as review output).  "All-green escalate" —
 * escalate rounds whose probes were all green, i.e. the implement side was
 * mechanically fine and the escalate is a review-side signal — is its own
 * number on top.
 *
 * @param {object[]} inWindowRounds
 * @param {boolean} verdictSourceAvailable  whether the store has the
 *   round.verdict_source column (pre-#235 stores render every source as
 *   "unknown").
 */
function computeEscalateReviewAxis(inWindowRounds, verdictSourceAvailable) {
  const escalate = inWindowRounds.filter((r) => r.disposition === "escalate");
  /** @type {Map<string, object>} */
  const byVerdict = new Map();
  let allGreenEscalate = 0;
  for (const r of escalate) {
    // A NULL verdict is its own verbatim-ish bucket, never dropped.
    const verdict = r.verdict === null || r.verdict === undefined ? "(no verdict)" : String(r.verdict);
    let row = byVerdict.get(verdict);
    if (!row) {
      row = {
        verdict,
        rounds: 0,
        probesGreen: { green: 0, red: 0, unknown: 0 },
        source: { review: 0, probe: 0, unknown: 0, other: 0 },
        otherValues: [],
      };
      byVerdict.set(verdict, row);
    }
    row.rounds += 1;
    if (r.probes_green === 1) {
      row.probesGreen.green += 1;
      allGreenEscalate += 1;
    } else if (r.probes_green === 0) {
      row.probesGreen.red += 1;
    } else {
      // NULL — never measured.  A distinct bucket from red (0).
      row.probesGreen.unknown += 1;
    }
    if (r.verdict_source === "probe") {
      row.source.probe += 1;
    } else if (r.verdict_source === null || r.verdict_source === undefined) {
      // Absent source: predates the field, or the record never said.  Its
      // own bucket — never folded into review-issued.
      row.source.unknown += 1;
    } else if (REVIEW_SOURCE_VALUES.has(r.verdict_source)) {
      // "recovered-from-token" — the review ran, its output was unparseable,
      // and the verdict was recovered from the token stream.  Review output.
      row.source.review += 1;
    } else {
      // Unrecognized non-NULL source: the ingest pass-through discipline
      // says an unknown future value survives verbatim — it must NOT be
      // silently counted as review output one layer up.  Its own "other"
      // bucket, with the raw value(s) kept for the renderer.
      row.source.other += 1;
      if (!row.otherValues.includes(r.verdict_source)) row.otherValues.push(r.verdict_source);
    }
  }
  const rows = [...byVerdict.values()].sort((a, b) => a.verdict.localeCompare(b.verdict));
  return {
    escalateRounds: escalate.length,
    allGreenEscalate,
    byVerdict: rows,
    verdictSourceAvailable,
  };
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
// stop-reason breakdown (kusabi #380) — closed terminal-reason union
// ---------------------------------------------------------------------------

/** Empty bucket for one surface (jobs or rounds). */
function emptyStopReasonBucket() {
  const byReason = {};
  for (const r of STOP_REASONS) byReason[r] = 0;
  byReason[UNKNOWN_STOP_REASON] = 0;
  return { total: 0, byReason, absent: 0 };
}

/**
 * Tally a surface's rows by their closed terminal reason.  A NULL reason is
 * "absent" (a record written before #380 — never counted as completed).  A
 * value outside the closed set and not "unknown" is a future/unforeseen
 * status: it FAILS CLOSED into the "unknown" bucket, so it can never be
 * silently read as success.
 *
 * @param {Array<object>} rows
 * @param {string} key  — the column/field name carrying the reason.
 */
function tallyStopReason(rows, key) {
  const out = emptyStopReasonBucket();
  for (const row of rows) {
    out.total += 1;
    const v = (row[key] ?? row.stopReason) ?? null;
    if (v === null || v === undefined) {
      out.absent += 1;
    } else if (v === UNKNOWN_STOP_REASON || STOP_REASONS.includes(v)) {
      out.byReason[v] = (out.byReason[v] || 0) + 1;
    } else {
      // Future / unforeseen status — fail closed (never completed).
      out.byReason[UNKNOWN_STOP_REASON] = (out.byReason[UNKNOWN_STOP_REASON] || 0) + 1;
    }
  }
  return out;
}

/**
 * Count worker terminal reasons over the in-window jobs and rounds.  Legacy
 * rows (no `stop_reason` field) appear as "absent", never folded into
 * "completed".
 *
 * @param {Array<object>} inWindowJobs
 * @param {Array<object>} inWindowRounds
 */
function computeStopReasonBreakdown(inWindowJobs, inWindowRounds) {
  return {
    jobs: tallyStopReason(inWindowJobs, "stop_reason"),
    rounds: tallyStopReason(inWindowRounds, "stop_reason"),
  };
}

// ---------------------------------------------------------------------------
// per-tool usage (kusabi #381) — zero-filled over KNOWN_TOOLS.
// kusabi #384: the counts cover opencode SSE events only.  Coverage is the
// job's `backend` column (`"opencode"` only).  NULL/absent is excluded —
// this section does NOT apply the #184 reader contract that treats NULL as
// opencode — and is never inferred from the presence of tool_stat rows.
// ---------------------------------------------------------------------------

function emptyToolCounts() {
  return { count: 0, success: 0, failure: 0 };
}

const TOOL_STATS_COVERED_BACKEND = "opencode";

function emptyToolStatsCoverage(excludedJobCount, coveredJobCount) {
  return {
    backend: TOOL_STATS_COVERED_BACKEND,
    excludedJobCount,
    coveredJobCount,
  };
}

function emptyToolStatsSection() {
  return {
    all: normalizeToolStats({}),
    failedJobs: normalizeToolStats({}),
    coverage: emptyToolStatsCoverage(0, 0),
  };
}

function isToolStatsCoveredJob(job) {
  return job.backend === TOOL_STATS_COVERED_BACKEND;
}

/**
 * Failed-job filter for the second breakdown.
 *
 * A job is failed when `stop_reason` is present and != 'completed', or when
 * the wrapper status is non-completed.  Jobs with NULL stop_reason (legacy,
 * pre-#380) are excluded, never guessed.  `unknown` is a present failure
 * sentinel and is never counted as success.
 */
function isFailedJob(job) {
  const reason = job.stop_reason;
  if (reason == null) return false;
  if (reason !== "completed") return true;
  const status = job.status;
  if (status != null && status !== "completed") return true;
  return false;
}

function sumToolStatRows(rows) {
  const stats = {};
  for (const r of rows) {
    const tool = r.tool;
    if (typeof tool !== "string" || !tool) continue;
    if (!stats[tool]) stats[tool] = emptyToolCounts();
    stats[tool].count += Number(r.count) || 0;
    stats[tool].success += Number(r.success) || 0;
    stats[tool].failure += Number(r.failure) || 0;
  }
  return stats;
}

function computeToolStatsSection(inWindowJobs, toolStatRows) {
  const coveredJobs = inWindowJobs.filter(isToolStatsCoveredJob);
  const excludedJobCount = inWindowJobs.length - coveredJobs.length;
  const coveredIds = new Set(coveredJobs.map((j) => j.job_id));
  const failedIds = new Set(coveredJobs.filter(isFailedJob).map((j) => j.job_id));
  const allRows = toolStatRows.filter((r) => coveredIds.has(r.job_id));
  const failedRows = toolStatRows.filter((r) => failedIds.has(r.job_id));
  return {
    all: normalizeToolStats(sumToolStatRows(allRows)),
    failedJobs: normalizeToolStats(sumToolStatRows(failedRows)),
    coverage: emptyToolStatsCoverage(excludedJobCount, coveredJobs.length),
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
// top-level report
// ---------------------------------------------------------------------------

/** Empty section A shape (missing/empty stores) — escalateRounds zero, no
 * verdict rows, no verdict_source column to split on. */
function emptyEscalateReviewAxis() {
  return {
    escalateRounds: 0,
    allGreenEscalate: 0,
    byVerdict: [],
    verdictSourceAvailable: false,
  };
}



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
    escalateReviewAxis: emptyEscalateReviewAxis(),
    dispositionSeverity: [],
    reviewPathology: emptyReviewPathology(),
  };
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
      escalateReviewAxis: emptyEscalateReviewAxis(),
      dispositionSeverity: [],
      reviewPathology: emptyReviewPathology(),
      stopReasonBreakdown: { jobs: emptyStopReasonBucket(), rounds: emptyStopReasonBucket() },
      toolStats: emptyToolStatsSection(),
    };
  }

  const allTurns = fetchTurns(db);
  const allSessions = fetchSessions(db);
  const allChains = fetchChains(db);
  const allRounds = fetchRounds(db);
  const allFindings = fetchFindings(db);
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

  // kusabi #235 — round-level sections are window-scoped by CHAIN (the same
  // window key every other section uses): the rounds of in-window chains.
  const inWindowChainIds = new Set(inWindowChains.map((c) => c.chain_id));
  const inWindowRounds = allRounds.filter((r) => inWindowChainIds.has(r.chain_id));
  const verdictSourceAvailable = tableHasColumn(db, "round", "verdict_source");
  const findingsByRound = new Map();
  for (const f of allFindings) {
    const key = `${f.chain_id}\u0000${f.round}`;
    if (!findingsByRound.has(key)) findingsByRound.set(key, []);
    findingsByRound.get(key).push(f);
  }

  const sessionCostByModel = computeSessionCostByModel(inWindowTurns);
  const sessionsInWindow = computeSessionsList(sessionAggMap);
  const chainJoin = computeChainJoin(inWindowChains, sessionAggMap, allSessions);
  const briefOutcome = computeBriefOutcome(inWindowChains, roundsByChain);
  const escalateReviewAxis = computeEscalateReviewAxis(inWindowRounds, verdictSourceAvailable);
  const dispositionSeverity = computeDispositionSeverity(inWindowRounds, findingsByRound);
  const reviewPathology = computeReviewPathology(inWindowRounds, verdictSourceAvailable);
  const delegatedJobs = computeDelegatedJobs(inWindowJobs);
  const byBackend = computeBackendSplit(inWindowChains, inWindowJobs, roundsByChain);
  const stopReasonBreakdown = computeStopReasonBreakdown(inWindowJobs, inWindowRounds);
  const toolStats = computeToolStatsSection(inWindowJobs, fetchToolStats(db));

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
    escalateReviewAxis,
    dispositionSeverity,
    reviewPathology,
    delegatedJobs,
    byBackend,
    stopReasonBreakdown,
    toolStats,
  };
}
