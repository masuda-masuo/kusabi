// chain-stats.mjs — Aggregate chain records for human-readable summary.
//
// Pure functions (no I/O) that compute summary statistics from chain records,
// plus a reader that collects records from the filesystem.
//
// Every count of a missing field is accompanied by an "n/a" count so that
// rates are never silently computed over a smaller denominator than assumed.

import fs from "node:fs";
import path from "node:path";
import { readJson } from "./state-paths.mjs";
import { usageFieldSum } from "./chain-persist.mjs";
import { hasRepeatedAreas, inScopeFindingFiles, resolveReworkScope } from "./chain-rework.mjs";
import {
  DISPOSITION_ORDER,
  createDispositionCounts,
  createEscalateSplit,
  recordEscalate,
  finalDisposition,
  parseLenientTimeBound,
  roundPassesTimeFilter,
  extractRoundFindingsText,
  hasPriorUnresolvedFinding,
  parseTimeBound,
  SEVERITY_ORDER,
} from "./chain-metrics-core.mjs";

export { parseTimeBound, SEVERITY_ORDER };

// =========================================================================
// I/O — collecting records from the state directory
// =========================================================================

/**
 * Read every chain record from the state directory.
 *
 * Malformed chain.json files are skipped and counted.  Returns a summary
 * object with the collected records and the count of skipped chains.
 *
 * @param {string} stateDir  — e.g. ~/.kusabi/<cwd-hash>
 * @returns {{ chains: Array<{ chainId: string, meta: object, rounds: object[] }>,
 *             skipped: number }}
 */
export function collectChainRecords(stateDir) {
  const chainsDir = path.join(stateDir, "chains");
  if (!fs.existsSync(chainsDir)) {
    return { chains: [], skipped: 0, noRecord: 0 };
  }

  const entries = fs.readdirSync(chainsDir);
  let skipped = 0;
  // A chain directory with no chain.json at all is not a corrupt record: the
  // chain died before it ever persisted one.  Those are worth knowing about
  // separately -- they are the runs that crashed or were cancelled.
  let noRecord = 0;
  const chains = [];

  for (const name of entries) {
    if (!name.startsWith("chain-")) continue;
    const dir = path.join(chainsDir, name);
    let stat;
    try { stat = fs.statSync(dir); } catch { skipped += 1; continue; }
    if (!stat.isDirectory()) { skipped += 1; continue; }

    const chainJsonPath = path.join(dir, "chain.json");
    if (!fs.existsSync(chainJsonPath)) { noRecord += 1; continue; }

    const chainJson = readJson(chainJsonPath);
    if (!chainJson) { skipped += 1; continue; }

    // chain.json has a `records` array — the most authoritative source of
    // round data.  If absent or non-array, treat rounds as empty.
    const rounds = Array.isArray(chainJson.records) ? chainJson.records : [];

    chains.push({
      chainId: chainJson.chainId || name,
      meta: chainJson,
      rounds,
    });
  }

  return { chains, skipped, noRecord };
}


// =========================================================================
// Pure statistics computation
// =========================================================================

/**
 * @typedef {object} RoundStats
 * @property {number} round           — round number (1-based)
 * @property {number|undefined} chainIndex — which chain this round belongs to
 * @property {string|undefined} verdict
 * @property {boolean|undefined} probesGreen
 * @property {object|undefined} disposition
 * @property {object|undefined} implementUsage
 * @property {object|undefined} reviewUsage
 * @property {object|undefined} strategistUsage
 * @property {string|undefined} findingsText
 * @property {string[]|undefined} findingFiles
 * @property {Array|undefined} findings
 * @property {string|undefined} startedAt
 */

/**
 * Compute aggregated statistics from a set of chain records.
 *
 * @param {Array<{ chainId: string, meta: object, rounds: object[] }>} chains
 * @param {object} [opts]
 * @param {string} [opts.since]  — ISO timestamp; include rounds with startedAt >= since
 * @param {string} [opts.until]  — ISO timestamp; include rounds with startedAt < until
 * @returns {object} stats object
 */
export function computeStats(chains, opts = {}) {
  const { since, until } = opts;
  const hasTimeFilter = since !== undefined || until !== undefined;

  // Parse the bounds once. `null` means "not given, or not parseable as an
  // instant" -- the per-round comparison falls back to string ordering then.
  const sinceMs = parseLenientTimeBound(since);
  const untilMs = parseLenientTimeBound(until);

  // Collect all rounds with their chain index for provenance.
  // Rounds without startedAt are excluded when time filtering is active,
  // and counted separately so the user is informed.
  /** @type {Array<{ chainIndex: number, round: object }>} */
  const allRounds = [];
  let noTimestampCount = 0;
  for (let ci = 0; ci < chains.length; ci++) {
    for (const r of chains[ci].rounds) {
      // When time filtering is active, rounds without a startedAt timestamp
      // are excluded (they cannot be placed in any range) and counted.
      if (hasTimeFilter && !r.startedAt) {
        noTimestampCount += 1;
        continue;
      }
      if (!roundPassesTimeFilter(r.startedAt, since, until, sinceMs, untilMs)) {
        continue;
      }
      allRounds.push({ chainIndex: ci, round: r });
    }
  }

  // ---- chain-level stats: count only chains that have rounds in range ----
  const activeChainIndices = new Set(allRounds.map((r) => r.chainIndex));
  const chainCount = activeChainIndices.size;

  // ---- round-level stats ----
  const roundCount = allRounds.length;

  // Rounds per chain (only chains that have rounds in this range)
  const roundsPerChain = {};
  for (const { chainIndex } of allRounds) {
    const key = String(chainIndex);
    roundsPerChain[key] = (roundsPerChain[key] || 0) + 1;
  }
  const rpcValues = Object.values(roundsPerChain);

  // ---- final dispositions (disposition of the last round of each chain) ----
  // Escalated chains are additionally split by whether the worker ever
  // produced a change set (kusabi #165): an infra death (no round changed
  // anything) is not the same failure as substantive work that was rejected.
  // `escalateSplit` always sums to dispositionCounts.escalate, so the totals
  // below stay comparable with earlier reports.
  const dispositionCounts = createDispositionCounts();
  const escalateSplit = createEscalateSplit();

  for (let ci = 0; ci < chains.length; ci++) {
    // Find the last round of this chain that passes time filters
    const chainRounds = allRounds
      .filter((ar) => ar.chainIndex === ci)
      .map((ar) => ar.round);
    if (chainRounds.length === 0) continue;
    const disp = finalDisposition(chainRounds);
    if (disp && disp in dispositionCounts) {
      dispositionCounts[disp] += 1;
      if (disp === "escalate") {
        recordEscalate(escalateSplit, chainRounds);
      }
    } else {
      dispositionCounts.other += 1;
    }
  }

  // ---- review verdicts ----
  const verdictCounts = {};
  let verdictNA = 0;

  for (const { round } of allRounds) {
    if (round.verdict !== undefined && round.verdict !== null) {
      const v = round.verdict;
      verdictCounts[v] = (verdictCounts[v] || 0) + 1;
    } else {
      verdictNA += 1;
    }
  }

  // ---- deterministic probes ----
  let probesAllGreen = 0;
  let probesAnyFailed = 0;
  let probesNA = 0;

  for (const { round } of allRounds) {
    if (round.probesGreen === true) {
      probesAllGreen += 1;
    } else if (round.probesGreen === false) {
      probesAnyFailed += 1;
    } else {
      probesNA += 1;
    }
  }

  // ---- repeatedAreas (computed from stored fields, not from a stored flag) ----
  // Only rounds that have a previous round in the same chain are eligible.
  // For each pair (previous, current) where both have the required fields,
  // compute hasRepeatedAreas.
  let eligiblePairs = 0;
  let repeatedTrue = 0;
  let repeatedNA = 0; // eligible pair where previous lacks findingFiles
                     // or current lacks findings

  for (const { chainIndex, round } of allRounds) {
    const roundNum = round.round;
    if (roundNum <= 1) continue; // no previous round

    // Find the previous round in the same chain
    const prev = allRounds
      .filter((ar) => ar.chainIndex === chainIndex && ar.round.round === roundNum - 1)
      .map((ar) => ar.round);
    if (prev.length === 0) continue;

    const previousRound = prev[0];

    // Check if the required fields exist
    const prevHasFindingFiles = Array.isArray(previousRound.findingFiles) && previousRound.findingFiles.length > 0;
    const currHasFindings = Array.isArray(round.findings) && round.findings.length > 0;

    eligiblePairs += 1;

    if (!prevHasFindingFiles || !currHasFindings) {
      repeatedNA += 1;
      continue;
    }

    // Kusabi #334: the live chain narrows the previous round's files to the
    // ones THIS round was asked to resolve before calling hasRepeatedAreas,
    // so the aggregate must measure the same input the chain decided on.
    // The scoped subset is not persisted (records store only the scope name),
    // so it is re-derived from the same deterministic resolveReworkScope the
    // chain used -- given the stored previous record it returns exactly the
    // scope the driver resolved for this round.  The derivation is a no-op
    // for every record that predates scoping: those rounds carry no
    // reworkScope field, the chain resolved a full scope for the round that
    // followed them, and passing no scope keeps the raw files -- historical
    // figures over such records stay exactly what they were before #334.
    let previousFindingFiles = previousRound.findingFiles;
    if (typeof round.reworkScope === "string") {
      // The record stores the scope name the round was RUN with, so the
      // re-derived scope is only trusted when its name agrees with the
      // record.  A disagreement means the branch table changed after the
      // round ran: the derivation describes a round the chain never
      // executed, and narrowing with it would silently rewrite the
      // historical figure.  Such a round is unmeasurable -- not false --
      // and goes to the same n/a bucket as a pair with missing fields.
      const derivedScope = resolveReworkScope(previousRound);
      if (derivedScope.scope !== round.reworkScope) {
        repeatedNA += 1;
        continue;
      }
      previousFindingFiles = inScopeFindingFiles(previousRound, derivedScope);
    }

    const result = hasRepeatedAreas(previousFindingFiles, round.findings);
    if (result) {
      repeatedTrue += 1;
    }
  }

  // ---- prior-unresolved heuristic ----
  let priorUnresolvedCount = 0;
  let priorUnresolvedEligible = 0;
  let priorUnresolvedNA = 0;

  for (const { chainIndex, round } of allRounds) {
    const roundNum = round.round;
    if (roundNum <= 1) continue;

    const prev = allRounds
      .filter((ar) => ar.chainIndex === chainIndex && ar.round.round === roundNum - 1)
      .map((ar) => ar.round);
    if (prev.length === 0) continue;

    priorUnresolvedEligible += 1;

    // Source text: findingsText first, then fall back to finding titles
    const textToSearch = extractRoundFindingsText(round);
    if (!textToSearch) {
      priorUnresolvedNA += 1;
      continue;
    }

    if (hasPriorUnresolvedFinding(textToSearch)) {
      priorUnresolvedCount += 1;
    }
  }

  // ---- missing field tracking ----
  let findingsNA = 0;
  let findingFilesNA = 0;

  for (const { round } of allRounds) {
    if (!Array.isArray(round.findings)) {
      findingsNA += 1;
    }
    if (!Array.isArray(round.findingFiles)) {
      findingFilesNA += 1;
    }
  }

  // ---- token and cost totals ----
  // Usage records are the only reliable cost-coverage evidence. In particular,
  // chain-persist's aggregate starts at zero and adds only available phase
  // costs, so a numeric chainTotals.cost can mean measured zero, partial data,
  // or no measured cost at all.
  // Keep the pre-#485 token aggregation independent from cost evidence.
  // Archived failed review seats belong to the producer's chain cost, but they
  // are not part of the historical in-range token totals. Strategist usage is
  // retained for those token totals for backwards compatibility; it is not in
  // computeChainTotals and therefore cannot validate a whole-chain cost.
  const tokenUsageRecordsForRound = (round) => {
    const usages = [];
    for (const field of ["implementUsage", "reviewUsage", "reviewFirstUsage", "strategistUsage"]) {
      const usage = round?.[field];
      if (usage && typeof usage === "object" && !Array.isArray(usage)) {
        usages.push(usage);
      }
    }
    return usages;
  };

  // This set must stay in lockstep with computeChainTotals in chain-persist:
  // live implementation/review attempts plus archived failed review seats,
  // but deliberately no strategistUsage.
  const costEvidenceUsageRecordsForRound = (round) => {
    const usages = [];
    for (const field of ["implementUsage", "reviewUsage", "reviewFirstUsage"]) {
      const usage = round?.[field];
      if (usage && typeof usage === "object" && !Array.isArray(usage)) {
        usages.push(usage);
      }
    }
    if (Array.isArray(round?.reviewSeatFailures)) {
      for (const seat of round.reviewSeatFailures) {
        if (!seat || typeof seat !== "object") continue;
        for (const field of ["reviewUsage", "reviewFirstUsage"]) {
          const usage = seat[field];
          if (usage && typeof usage === "object" && !Array.isArray(usage)) {
            usages.push(usage);
          }
        }
      }
    }
    return usages;
  };

  const costEvidenceForRounds = (rounds) => {
    let measured = 0;
    let measuredCost = 0;
    let total = 0;
    for (const round of rounds) {
      for (const usage of costEvidenceUsageRecordsForRound(round)) {
        total += 1;
        if (usage.available === true && typeof usage.cost === "number" && Number.isFinite(usage.cost)) {
          measured += 1;
          measuredCost += usage.cost;
        }
      }
    }
    return { measured, total, measuredCost };
  };

  const overallTotals = {
    input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null,
    cost: null,
    costCoverage: { measured: 0, total: 0 },
  };
  const overallTokenUsages = [];
  const perChainTotals = []; // active chains only; cost is number | null

  const aggregateCostCoverage = (evidence, aggregateCost) => {
    // A finite nonzero legacy aggregate remains authoritative even when phase
    // observations exist but none has a usable finite cost. There is no honest
    // phase denominator for that aggregate, so mark completeness explicitly
    // instead of calling it measured (or silently treating it as free).
    if (aggregateCost !== null && aggregateCost !== 0 && evidence.measured === 0) {
      return { measured: 0, total: 0, unknown: true };
    }
    // Whenever usable phase evidence exists, every phase observation is one
    // unit.
    if (evidence.total > 0) {
      return { measured: evidence.measured, total: evidence.total };
    }
    if (aggregateCost !== null && aggregateCost !== 0) {
      return { measured: 0, total: 0, unknown: true };
    }
    // A chain with no producer-matching usage has no phase denominator.
    // Keep its cost coverage unknown so aggregate coverage never invents a
    // synthetic chain unit alongside measured phase units.
    return { measured: 0, total: 0, unknown: true };
  };

  for (const ci of activeChainIndices) {
    const chain = chains[ci];
    const ct = chain.meta.chainTotals;
    const hasTotals = ct && typeof ct === "object";
    const aggregateCost = hasTotals && typeof ct.cost === "number" && Number.isFinite(ct.cost)
      ? ct.cost
      : null;
    const evidence = costEvidenceForRounds(chain.rounds);
    // A producer aggregate is authoritative only when matching phase evidence
    // exists. The one legacy exception is a finite nonzero aggregate with no
    // phase records at all: preserve its value, but keep completeness unknown.
    const chainCost = evidence.measured > 0
      ? (aggregateCost ?? evidence.measuredCost)
      : (aggregateCost !== null && aggregateCost !== 0
        ? aggregateCost
        : null);
    const costCoverage = aggregateCostCoverage(evidence, aggregateCost);

    if (hasTotals) {
      overallTokenUsages.push(ct);
    }
    if (chainCost !== null) {
      overallTotals.cost = (overallTotals.cost ?? 0) + chainCost;
    }
    overallTotals.costCoverage.measured += costCoverage.measured;
    overallTotals.costCoverage.total += costCoverage.total;
    if (costCoverage.unknown) overallTotals.costCoverage.unknown = true;

    perChainTotals.push({
      chainId: chain.chainId,
      input: hasTotals ? usageFieldSum("input", [ct]) : null,
      output: hasTotals ? usageFieldSum("output", [ct]) : null,
      reasoning: hasTotals ? usageFieldSum("reasoning", [ct]) : null,
      cacheRead: hasTotals ? usageFieldSum("cacheRead", [ct]) : null,
      cacheWrite: hasTotals ? usageFieldSum("cacheWrite", [ct]) : null,
      cost: chainCost,
      costMeasured: chainCost !== null &&
        !costCoverage.unknown &&
        costCoverage.total > 0 &&
        costCoverage.measured === costCoverage.total,
      costCoverage,
    });
  }

  // Token fields retain the pre-#485 aggregation. In-range cost and coverage
  // use the same round usage records as those tokens, excluding archived
  // failed-seat records so the displayed scope stays internally consistent.
  const filteredTotals = {
    input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null,
    cost: null,
    costCoverage: { measured: 0, total: 0 },
  };
  const filteredTokenUsages = [];
  for (const { round } of allRounds) {
    for (const usage of tokenUsageRecordsForRound(round)) {
      if (usage.available === true) {
        filteredTokenUsages.push(usage);
      }
    }
    for (const usage of tokenUsageRecordsForRound(round)) {
      filteredTotals.costCoverage.total += 1;
      if (usage.available === true && typeof usage.cost === "number" && Number.isFinite(usage.cost)) {
        filteredTotals.cost = (filteredTotals.cost ?? 0) + usage.cost;
        filteredTotals.costCoverage.measured += 1;
      }
    }
  }
  overallTotals.input = usageFieldSum("input", overallTokenUsages);
  overallTotals.output = usageFieldSum("output", overallTokenUsages);
  overallTotals.reasoning = usageFieldSum("reasoning", overallTokenUsages);
  overallTotals.cacheRead = usageFieldSum("cacheRead", overallTokenUsages);
  overallTotals.cacheWrite = usageFieldSum("cacheWrite", overallTokenUsages);
  filteredTotals.input = usageFieldSum("input", filteredTokenUsages);
  filteredTotals.output = usageFieldSum("output", filteredTokenUsages);
  filteredTotals.reasoning = usageFieldSum("reasoning", filteredTokenUsages);
  filteredTotals.cacheRead = usageFieldSum("cacheRead", filteredTokenUsages);
  filteredTotals.cacheWrite = usageFieldSum("cacheWrite", filteredTokenUsages);

  // ---- model distribution ----
  const modelCounts = {};
  let modelEntryNA = 0;

  for (const { round } of allRounds) {
    if (round.modelEntry !== undefined && round.modelEntry !== null && round.modelEntry !== "") {
      const m = round.modelEntry;
      modelCounts[m] = (modelCounts[m] || 0) + 1;
    } else {
      modelEntryNA += 1;
    }
  }


  // ---- capacity fallbacks ----
  const fallbackCounts = {}; // { "from → to": count }
  let fallbacksAbsent = 0;  // key absent from round record
  let fallbacksNone = 0;    // key present but null

  for (const { round } of allRounds) {
    const hasFallbacksKey = Object.hasOwn(round, "fallbacks");
    if (!hasFallbacksKey) {
      fallbacksAbsent += 1;
    } else if (round.fallbacks === null) {
      fallbacksNone += 1;
    } else if (Array.isArray(round.fallbacks) && round.fallbacks.length > 0) {
      for (const fb of round.fallbacks) {
        const key = `${fb.from || "?"} → ${fb.to || "(none)"}`;
        fallbackCounts[key] = (fallbackCounts[key] || 0) + 1;
      }
    } else {
      // Key present but empty array or non-array non-null — count as no fallback
      fallbacksNone += 1;
    }
  }

  return {
    // Overview
    chainCount,
    roundCount,
    roundsPerChainCounts: rpcValues,

    // Dispositions (final per chain)
    dispositionCounts,
    // Escalate split (kusabi #165): sums to dispositionCounts.escalate.
    // `unknown` = escalated chains whose rounds never recorded whether the
    // worktree changed (old records / pre-probe death) — never counted as
    // no-work.
    escalateSplit,

    // Verdicts
    verdictCounts,
    verdictNA,

    // Probes
    probesAllGreen,
    probesAnyFailed,
    probesNA,

    // Repeated areas (computed from stored fields)
    eligiblePairs,
    repeatedTrue,
    repeatedNA,

    // Prior-unresolved heuristic
    priorUnresolvedCount,
    priorUnresolvedEligible,
    priorUnresolvedNA,

    // Missing field tracking
    findingsNA,
    findingFilesNA,
    noTimestampCount,

    // Totals
    overallTotals,
    perChainTotals,
    filteredTotals,

    // Model
    modelCounts,
    modelEntryNA,

    // Fallbacks
    fallbackCounts,
    fallbacksAbsent,
    fallbacksNone,
  };
}

// =========================================================================
// Rendering
// =========================================================================

/**
 * Format a number with one decimal place as a percentage string.
 * @param {number} part
 * @param {number} total
 * @returns {string}
 */
function pct(part, total) {
  if (!total) return "(0.0%)";
  return `(${(part / total * 100).toFixed(1)}%)`;
}

/**
 * Render a labelled count line with optional percentage.
 * @param {string} label
 * @param {number} count
 * @param {number} [total]
 * @returns {string}
 */
function line(label, count, total) {
  const pctStr = total !== undefined ? ` ${pct(count, total)}` : "";
  return `  ${label.padEnd(28)} ${count}${pctStr}`;
}

/**
 * Render aggregated stats as a human-readable terminal string.
 *
 * @param {object} stats  — return value of computeStats
 * @param {object} [opts]
 * @param {string} [opts.since]  — displayed range start label
 * @param {string} [opts.until]  — displayed range end label
 * @returns {string}
 */
export function renderChainStats(stats, opts = {}) {
  const lines = [];

  // Header / range
  const rangeParts = [];
  if (opts.since) rangeParts.push(`since ${opts.since}`);
  if (opts.until) rangeParts.push(`until ${opts.until}`);
  const rangeLabel = rangeParts.length > 0 ? ` (${rangeParts.join(" ")})` : "";
  lines.push(`Chain stats${rangeLabel}`);
  lines.push("");

  // Overview
  lines.push("Overview:");
  lines.push(line("Chains", stats.chainCount));
  lines.push(line("Rounds", stats.roundCount));

  const rpc = stats.roundsPerChainCounts;
  if (rpc.length > 0) {
    const mean = (stats.roundCount / Math.max(1, stats.chainCount)).toFixed(1);
    lines.push(`  Rounds per chain:           mean ${mean}, range ${Math.min(...rpc)}–${Math.max(...rpc)}`);
  }

  const rpcDist = {};
  for (const v of rpc) { rpcDist[v] = (rpcDist[v] || 0) + 1; }
  const rpcDistStr = Object.entries(rpcDist)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  lines.push(`  Distribution:               ${rpcDistStr}`);
  lines.push("");

  // Final dispositions
  lines.push("Final dispositions:");
  const { dispositionCounts: dc } = stats;
  // Show all disposition buckets (including zero if any other bucket is non-zero)
  const totalDisps = Object.values(dc).reduce((a, b) => a + b, 0);
  const dispOrder = DISPOSITION_ORDER;
  for (const key of dispOrder) {
    if (dc[key] > 0 || totalDisps > 0) {
      // Escalates carry the substantive/no-work split (kusabi #165): an
      // escalated chain whose worker never produced a change set is a
      // different failure from substantive work that was rejected.  The
      // count and percentage stay exactly as before — the split only
      // annotates the label.  `n/a` = rounds never recorded whether the
      // worktree changed (old records) — never folded into no-work.
      let label = key;
      if (key === "escalate" && dc.escalate > 0 && stats.escalateSplit) {
        const es = stats.escalateSplit;
        const parts = [];
        if (es.substantive > 0) parts.push(`substantive ${es.substantive}`);
        if (es.noWork > 0) parts.push(`no-work ${es.noWork}`);
        if (es.unknown > 0) parts.push(`n/a ${es.unknown}`);
        if (parts.length > 0) label = `${key} (${parts.join(", ")})`;
      }
      lines.push(line(label, dc[key], totalDisps));
    }
  }
  if (dc.other > 0) {
    lines.push(line("other", dc.other, totalDisps));
  }
  lines.push("");

  // Review verdicts (across all rounds)
  lines.push("Review verdicts:");
  const totalVerdicts = Object.values(stats.verdictCounts).reduce((a, b) => a + b, 0) + stats.verdictNA;
  const verdictOrder = ["approve", "needs-attention", "approve-partial", "discard", "unparseable"];
  for (const key of verdictOrder) {
    const count = stats.verdictCounts[key] || 0;
    if (count > 0 || totalVerdicts > 0) {
      lines.push(line(key, count, totalVerdicts));
    }
  }
  // Any other verdicts
  for (const [key, count] of Object.entries(stats.verdictCounts)) {
    if (!verdictOrder.includes(key)) {
      lines.push(line(key, count, totalVerdicts));
    }
  }
  if (stats.verdictNA > 0) {
    lines.push(line("n/a (not available)", stats.verdictNA, totalVerdicts));
  }
  lines.push("");

  // Deterministic probes
  lines.push("Deterministic probes:");
  const totalProbes = stats.probesAllGreen + stats.probesAnyFailed + stats.probesNA;
  if (totalProbes > 0) {
    lines.push(line("All green", stats.probesAllGreen, totalProbes));
    lines.push(line("Any failed", stats.probesAnyFailed, totalProbes));
    if (stats.probesNA > 0) {
      lines.push(line("n/a (not available)", stats.probesNA, totalProbes));
    }
  } else {
    lines.push("  (no probe data)");
  }
  lines.push("");

  // Repeated areas
  lines.push("Repeated areas:");
  if (stats.eligiblePairs > 0) {
    lines.push(`  Eligible round pairs         ${stats.eligiblePairs}`);
    // The rate must be taken over the pairs that could actually be judged.
    // Dividing by eligiblePairs reports "0.0%" when every pair was n/a, which
    // reads as "the detector never fired" instead of "nothing was measurable".
    const decidable = stats.eligiblePairs - stats.repeatedNA;
    if (decidable > 0) {
      const truePct = (stats.repeatedTrue / decidable * 100).toFixed(1);
      lines.push(`  repeatedAreas true           ${stats.repeatedTrue} / ${decidable} decidable (${truePct}%)`);
    } else {
      lines.push("  repeatedAreas true           (no data — every pair lacks `findingFiles`)");
    }
    if (stats.repeatedNA > 0) {
      const naPct = (stats.repeatedNA / stats.eligiblePairs * 100).toFixed(1);
      lines.push(`  n/a (missing fields)        ${stats.repeatedNA} (${naPct}%)`);
    }
  } else {
    lines.push("  (no consecutive round pairs)");
  }
  lines.push("");

  // Prior-unresolved heuristic
  lines.push("Prior finding unresolved:");
  lines.push("  (heuristic: textual match in findings text — approximate)");
  if (stats.priorUnresolvedEligible > 0) {
    const pctStr = (stats.priorUnresolvedCount / stats.priorUnresolvedEligible * 100).toFixed(1);
    lines.push(`  Flagged as unresolved        ${stats.priorUnresolvedCount} / ${stats.priorUnresolvedEligible} eligible (${pctStr}%)`);
    if (stats.priorUnresolvedNA > 0) {
      lines.push(`  n/a (no findings text)       ${stats.priorUnresolvedNA}`);
    }
  } else {
    lines.push("  (no eligible round pairs)");
  }
  lines.push("");

  // Model distribution
  lines.push("Model distribution:");
  const modelEntries = Object.entries(stats.modelCounts).sort((a, b) => b[1] - a[1]);
  const modelTotal = modelEntries.reduce((s, [, c]) => s + c, 0) + stats.modelEntryNA;
  if (modelTotal > 0) {
    for (const [model, count] of modelEntries) {
      lines.push(line(model, count, modelTotal));
    }
    if (stats.modelEntryNA > 0) {
      lines.push(line("n/a (not available)", stats.modelEntryNA, modelTotal));
    }
  } else {
    lines.push("  (no model data)");
  }
  lines.push("");

  // Capacity fallbacks
  lines.push("Capacity fallbacks:");
  const fbEntries = Object.entries(stats.fallbackCounts).sort((a, b) => b[1] - a[1]);
  if (fbEntries.length > 0 || stats.fallbacksAbsent > 0 || stats.fallbacksNone > 0) {
    const fbTotalRounds = stats.roundCount;
    for (const [routePair, count] of fbEntries) {
      lines.push(line(routePair, count, fbTotalRounds));
    }
    if (stats.fallbacksAbsent > 0) {
      lines.push(line("n/a (key absent, older records)", stats.fallbacksAbsent, fbTotalRounds));
    }
    if (stats.fallbacksNone > 0) {
      lines.push(line("No fallback (key present, null)", stats.fallbacksNone, fbTotalRounds));
    }
  } else {
    lines.push("  (no fallback data)");
  }
  lines.push("");

  // Missing field report
  if (stats.findingsNA > 0 || stats.findingFilesNA > 0 || stats.noTimestampCount > 0) {
    lines.push("Missing fields:");
    if (stats.findingsNA > 0) {
      lines.push(line("rounds missing `findings`", stats.findingsNA, stats.roundCount));
    }
    if (stats.findingFilesNA > 0) {
      lines.push(line("rounds missing `findingFiles`", stats.findingFilesNA, stats.roundCount));
    }
    if (stats.noTimestampCount > 0) {
      // Deliberately no percentage.  These rounds were dropped BEFORE the
      // filtered set was built, so roundCount is a disjoint denominator; and
      // rounds dropped for being out of range are not counted anywhere, so
      // roundCount + noTimestampCount is not the scanned total either.  There
      // is no honest denominator available here — the raw count is the point.
      lines.push(line("rounds missing `startedAt` (excluded)", stats.noTimestampCount));
    }
    lines.push("  (older records lack these fields; rates above exclude them)");
    lines.push("");
  }

  // Token and cost totals. Keep the two scopes visibly separate: filtered
  // usage is in-range, while chainTotals necessarily cover each active chain
  // in full (including rounds outside a date boundary).
  lines.push("Token and cost totals:");
  const formatToken = (value) =>
    typeof value === "number" && Number.isFinite(value) ? value : "n/a";
  const formatCost = (cost, coverage) => {
    const value = typeof cost === "number" && Number.isFinite(cost)
      ? `$${cost.toFixed(4)}`
      : "n/a";
    if (coverage?.unknown) return `${value} (completeness unknown)`;
    return `${value} (${coverage.measured}/${coverage.total} measured)`;
  };

  const t = stats.filteredTotals;
  const tokensLine = [
    `  in-range round totals: input=${formatToken(t.input)}`,
    `output=${formatToken(t.output)}`,
  ];
  if (t.reasoning) tokensLine.push(`reasoning=${t.reasoning}`);
  if (t.cacheRead || t.cacheWrite) tokensLine.push(`cacheRead=${formatToken(t.cacheRead)} cacheWrite=${formatToken(t.cacheWrite)}`);
  tokensLine.push(`cost=${formatCost(t.cost, t.costCoverage)}`);
  lines.push(tokensLine.join(", "));

  // Per-chain cost distribution uses only measured costs and reports how many
  // active chains supplied one. Missing values are never imputed as free.
  if (stats.perChainTotals.length > 1) {
    const costs = stats.perChainTotals
      .filter((c) => c.costMeasured)
      .map((c) => c.cost);
    const coverage = `${costs.length}/${stats.perChainTotals.length} fully measured`;
    if (costs.length > 0) {
      const minCost = Math.min(...costs);
      const maxCost = Math.max(...costs);
      const medianCost = [...costs].sort((a, b) => a - b)[Math.floor(costs.length / 2)];
      lines.push(`  per-chain cost: min=$${minCost.toFixed(4)}, median=$${medianCost.toFixed(4)}, max=$${maxCost.toFixed(4)} (${coverage})`);
    } else {
      lines.push(`  per-chain cost: n/a (${coverage})`);
    }
  }

  const ot = stats.overallTotals;
  lines.push(`  whole active-chain totals: input=${formatToken(ot.input)}, output=${formatToken(ot.output)}, cost=${formatCost(ot.cost, ot.costCoverage)}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Render a side-by-side comparison of two time ranges.
 *
 * @param {object} statsBefore  — computeStats result for the earlier range
 * @param {object} statsAfter   — computeStats result for the later range
 * @param {string} cutoff       — ISO cutoff timestamp (displayed)
 * @returns {string}
 */
export function renderComparison(statsBefore, statsAfter, cutoff) {
  const lines = [];
  const sep = " │ ";

  function col(label, before, after) {
    const b = String(before != null ? before : "—");
    const a = String(after != null ? after : "—");
    return `  ${label.padEnd(26)} ${b.padStart(12)}${sep}${a.padStart(12)}`;
  }

  lines.push("Chain stats comparison");
  lines.push(`  Cutoff: ${cutoff}`);
  lines.push(`  ${"".padEnd(26)} ${"Before".padStart(12)}${sep}${"After".padStart(12)}`);
  lines.push(`  ${"".padEnd(26)} ${"".padStart(12, "─")}${sep}${"".padStart(12, "─")}`);

  // Overview
  lines.push(col("Chains", statsBefore.chainCount, statsAfter.chainCount));
  lines.push(col("Rounds", statsBefore.roundCount, statsAfter.roundCount));

  // Final dispositions
  lines.push("  ── Dispositions ──");
  const dispOrder = DISPOSITION_ORDER;
  const totalB = Object.values(statsBefore.dispositionCounts).reduce((a, b) => a + b, 0);
  const totalA = Object.values(statsAfter.dispositionCounts).reduce((a, b) => a + b, 0);
  for (const key of dispOrder) {
    const cb = statsBefore.dispositionCounts[key] || 0;
    const ca = statsAfter.dispositionCounts[key] || 0;
    if (cb > 0 || ca > 0) {
      lines.push(col(`  ${key}`, `${cb}/${totalB}`, `${ca}/${totalA}`));
    }
  }
  // Escalate split (kusabi #165): substantive / no-work / n/a per side,
  // shown only when at least one side has escalates.  The disposition
  // totals above are untouched.
  if ((statsBefore.dispositionCounts.escalate || 0) > 0 || (statsAfter.dispositionCounts.escalate || 0) > 0) {
    const splitStr = (s) => {
      const es = s.escalateSplit || { substantive: 0, noWork: 0, unknown: 0 };
      const parts = [];
      if (es.substantive > 0) parts.push(`subst ${es.substantive}`);
      if (es.noWork > 0) parts.push(`no-work ${es.noWork}`);
      if (es.unknown > 0) parts.push(`n/a ${es.unknown}`);
      return parts.length > 0 ? parts.join(", ") : "—";
    };
    lines.push(col("  escalate split", splitStr(statsBefore), splitStr(statsAfter)));
  }

  // Review verdicts
  lines.push("  ── Verdicts ──");
  const verdictOrder = ["approve", "needs-attention", "approve-partial", "discard", "unparseable"];
  const totalVerdictsB = Object.values(statsBefore.verdictCounts).reduce((a, b) => a + b, 0) + statsBefore.verdictNA;
  const totalVerdictsA = Object.values(statsAfter.verdictCounts).reduce((a, b) => a + b, 0) + statsAfter.verdictNA;
  for (const key of verdictOrder) {
    const cb = statsBefore.verdictCounts[key] || 0;
    const ca = statsAfter.verdictCounts[key] || 0;
    if (cb > 0 || ca > 0) {
      lines.push(col(`  ${key}`, `${cb}/${totalVerdictsB}`, `${ca}/${totalVerdictsA}`));
    }
  }
  if (statsBefore.verdictNA > 0 || statsAfter.verdictNA > 0) {
    lines.push(col(`  n/a`, `${statsBefore.verdictNA}/${totalVerdictsB}`, `${statsAfter.verdictNA}/${totalVerdictsA}`));
  }

  // Probes
  lines.push("  ── Probes ──");
  const tb = statsBefore.probesAllGreen + statsBefore.probesAnyFailed + statsBefore.probesNA;
  const ta = statsAfter.probesAllGreen + statsAfter.probesAnyFailed + statsAfter.probesNA;
  lines.push(col("  All green", `${statsBefore.probesAllGreen}/${tb}`, `${statsAfter.probesAllGreen}/${ta}`));
  lines.push(col("  Any failed", `${statsBefore.probesAnyFailed}/${tb}`, `${statsAfter.probesAnyFailed}/${ta}`));

  // Repeated areas
  lines.push("  ── Repeated areas ──");
  lines.push(col("  Eligible pairs", statsBefore.eligiblePairs, statsAfter.eligiblePairs));
  if (statsBefore.eligiblePairs > 0 || statsAfter.eligiblePairs > 0) {
    // Same rule as the single-range view: report over the pairs that could be
    // judged.  Showing "0/11" when all 11 lack `findingFiles` reads as "the
    // detector never fired" rather than "nothing was measurable".
    const repeated = (s) => {
      const decidable = s.eligiblePairs - s.repeatedNA;
      if (decidable <= 0) return "no data";
      return s.repeatedNA > 0 ? `${s.repeatedTrue}/${decidable}` : String(s.repeatedTrue);
    };
    lines.push(col("  repeatedAreas true", repeated(statsBefore), repeated(statsAfter)));
  }

  // Prior unresolved
  lines.push("  ── Prior unresolved (heuristic) ──");
  lines.push(col("  Flagged", statsBefore.priorUnresolvedCount, statsAfter.priorUnresolvedCount));
  lines.push(col("  Eligible pairs", statsBefore.priorUnresolvedEligible, statsAfter.priorUnresolvedEligible));

  // Models
  lines.push("  ── Models ──");
  const modelTotalB = Object.values(statsBefore.modelCounts).reduce((s, c) => s + c, 0) + statsBefore.modelEntryNA;
  const modelTotalA = Object.values(statsAfter.modelCounts).reduce((s, c) => s + c, 0) + statsAfter.modelEntryNA;
  const allModels = new Set([...Object.keys(statsBefore.modelCounts), ...Object.keys(statsAfter.modelCounts)]);
  for (const model of [...allModels].sort()) {
    const cb = statsBefore.modelCounts[model] || 0;
    const ca = statsAfter.modelCounts[model] || 0;
    if (cb > 0 || ca > 0) {
      lines.push(col(`  ${model}`, `${cb}/${modelTotalB}`, `${ca}/${modelTotalA}`));
    }
  }
  if (statsBefore.modelEntryNA > 0 || statsAfter.modelEntryNA > 0) {
    lines.push(col(`  n/a (no modelEntry)`, `${statsBefore.modelEntryNA}/${modelTotalB}`, `${statsAfter.modelEntryNA}/${modelTotalA}`));
  }
  // intentionally omitted from this before/after table.
  lines.push("  ── Costs (in-range rounds) ──");
  const costCell = (totals) => {
    const value = typeof totals.cost === "number" && Number.isFinite(totals.cost)
      ? `$${totals.cost.toFixed(4)}`
      : "n/a";
    return `${value} (${totals.costCoverage.measured}/${totals.costCoverage.total})`;
  };
  lines.push(col("  In-range round cost", costCell(statsBefore.filteredTotals), costCell(statsAfter.filteredTotals)));

  // Missing fields
  const hasNA = (statsBefore.findingsNA > 0 || statsAfter.findingsNA > 0 ||
    statsBefore.findingFilesNA > 0 || statsAfter.findingFilesNA > 0 ||
    statsBefore.noTimestampCount > 0 || statsAfter.noTimestampCount > 0);
  if (hasNA) {
    lines.push("  ── Missing fields ──");
    if (statsBefore.findingsNA > 0 || statsAfter.findingsNA > 0) {
      lines.push(col("  `findings` n/a", statsBefore.findingsNA, statsAfter.findingsNA));
    }
    if (statsBefore.findingFilesNA > 0 || statsAfter.findingFilesNA > 0) {
      lines.push(col("  `findingFiles` n/a", statsBefore.findingFilesNA, statsAfter.findingFilesNA));
    }
    if (statsBefore.noTimestampCount > 0 || statsAfter.noTimestampCount > 0) {
      lines.push(col("  `startedAt` n/a", statsBefore.noTimestampCount, statsAfter.noTimestampCount));
    }
    // Same annotation the single-range view carries: without it, "n/a 2 │ 0"
    // reads as a finding about the data rather than about the record format.
    lines.push("  (older records lack these fields; rates above exclude them)");
  }

  return lines.join("\n");
}
