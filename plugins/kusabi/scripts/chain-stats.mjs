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
import { hasRepeatedAreas } from "./chain-phases.mjs";

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
    return { chains: [], skipped: 0 };
  }

  const entries = fs.readdirSync(chainsDir);
  let skipped = 0;
  const chains = [];

  for (const name of entries) {
    if (!name.startsWith("chain-")) continue;
    const dir = path.join(chainsDir, name);
    let stat;
    try { stat = fs.statSync(dir); } catch { skipped += 1; continue; }
    if (!stat.isDirectory()) { skipped += 1; continue; }

    const chainJson = readJson(path.join(dir, "chain.json"));
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

  return { chains, skipped };
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
      if (since !== undefined && r.startedAt && r.startedAt < since) continue;
      if (until !== undefined && r.startedAt && r.startedAt >= until) continue;
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
  const dispositionCounts = {
    accept: 0,
    "accept-with-followup": 0,
    rework: 0,
    strategize: 0,
    escalate: 0,
    discard: 0,
    other: 0,
  };

  for (let ci = 0; ci < chains.length; ci++) {
    // Find the last round of this chain that passes time filters
    const chainRounds = allRounds
      .filter((ar) => ar.chainIndex === ci)
      .map((ar) => ar.round);
    if (chainRounds.length === 0) continue;
    const lastRound = chainRounds[chainRounds.length - 1];
    const disp = lastRound.disposition?.disposition;
    if (disp && disp in dispositionCounts) {
      dispositionCounts[disp] += 1;
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

    const result = hasRepeatedAreas(previousRound.findingFiles, round.findings);
    if (result) {
      repeatedTrue += 1;
    }
  }

  // ---- prior-unresolved heuristic ----
  // Search for textual markers in findingsText (fallback) or finding titles.
  const unresolvedPatterns = [
    /prior\s+finding[,\s]*not\s+addressed/i,
    /prior\s+finding\s*#\d+\s+unresolved/i,
    /prior\s+finding.*unresolved/i,
    /not\s+addressed\s*\(prior/i,
    /previous\s+finding.*not\s+(?:addressed|resolved)/i,
    /still\s+unresolved/i,
  ];

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
    let textToSearch = round.findingsText || "";
    if (!textToSearch && Array.isArray(round.findings)) {
      textToSearch = round.findings
        .map((f) => f.title || "")
        .join(" ");
    }

    if (!textToSearch) {
      priorUnresolvedNA += 1;
      continue;
    }

    const found = unresolvedPatterns.some((re) => re.test(textToSearch));
    if (found) {
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
  // Per-chain from chainTotals, and per-round from implementUsage/reviewUsage/strategistUsage
  const overallTotals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const perChainTotals = []; // { chainId, input, output, reasoning, cacheRead, cacheWrite, cost }

  for (const chain of chains) {
    const ct = chain.meta.chainTotals;
    if (ct && typeof ct === "object") {
      overallTotals.input += ct.input || 0;
      overallTotals.output += ct.output || 0;
      overallTotals.reasoning += ct.reasoning || 0;
      overallTotals.cacheRead += ct.cacheRead || 0;
      overallTotals.cacheWrite += ct.cacheWrite || 0;
      overallTotals.cost += ct.cost || 0;

      perChainTotals.push({
        chainId: chain.chainId,
        input: ct.input || 0,
        output: ct.output || 0,
        reasoning: ct.reasoning || 0,
        cacheRead: ct.cacheRead || 0,
        cacheWrite: ct.cacheWrite || 0,
        cost: ct.cost || 0,
      });
    } else {
      // Chain has no totals — add a zero entry so per-chain counts match chainCount
      perChainTotals.push({
        chainId: chain.chainId,
        input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
      });
    }
  }

  // Also sum per-round usage for the time-filtered subset
  const filteredTotals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const { round } of allRounds) {
    for (const usage of [round.implementUsage, round.reviewUsage, round.strategistUsage]) {
      if (usage && usage.available) {
        filteredTotals.input += usage.input || 0;
        filteredTotals.output += usage.output || 0;
        filteredTotals.reasoning += usage.reasoning || 0;
        filteredTotals.cacheRead += usage.cacheRead || 0;
        filteredTotals.cacheWrite += usage.cacheWrite || 0;
        filteredTotals.cost += usage.cost || 0;
      }
    }
  }

  return {
    // Overview
    chainCount,
    roundCount,
    roundsPerChainCounts: rpcValues,

    // Dispositions (final per chain)
    dispositionCounts,

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
  for (const [key, count] of Object.entries(dc)) {
    if (key === "other") continue;
    if (count > 0 || dc.other > 0) {
      // Only show dispositions that have counts
    }
  }
  // Show all disposition buckets (including zero if any other bucket is non-zero)
  const totalDisps = Object.values(dc).reduce((a, b) => a + b, 0);
  const dispOrder = ["accept", "accept-with-followup", "escalate", "rework", "strategize", "discard"];
  for (const key of dispOrder) {
    if (dc[key] > 0 || totalDisps > 0) {
      lines.push(line(key, dc[key], totalDisps));
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

  // Token and cost totals
  lines.push("Token and cost totals:");
  const t = stats.filteredTotals;
  const tokensLine = [
    `  input=${t.input}`,
    `output=${t.output}`,
  ];
  if (t.reasoning) tokensLine.push(`reasoning=${t.reasoning}`);
  if (t.cacheRead || t.cacheWrite) tokensLine.push(`cacheRead=${t.cacheRead} cacheWrite=${t.cacheWrite}`);
  tokensLine.push(`cost=$${(t.cost || 0).toFixed(4)}`);
  lines.push(tokensLine.join(", "));

  // Per-chain totals
  if (stats.perChainTotals.length > 1) {
    const costs = stats.perChainTotals.map((c) => c.cost || 0);
    const minCost = Math.min(...costs);
    const maxCost = Math.max(...costs);
    const medianCost = [...costs].sort((a, b) => a - b)[Math.floor(costs.length / 2)];
    lines.push(`  per-chain cost: min=$${minCost.toFixed(4)}, median=$${medianCost.toFixed(4)}, max=$${maxCost.toFixed(4)}`);
  }

  // Chain-level totals from chainTotals (for completeness)
  const ot = stats.overallTotals;
  lines.push(`  (chainTotals: input=${ot.input}, output=${ot.output}, cost=$${(ot.cost || 0).toFixed(4)})`);
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
  const dispOrder = ["accept", "accept-with-followup", "escalate", "rework", "strategize", "discard"];
  const totalB = Object.values(statsBefore.dispositionCounts).reduce((a, b) => a + b, 0);
  const totalA = Object.values(statsAfter.dispositionCounts).reduce((a, b) => a + b, 0);
  for (const key of dispOrder) {
    const cb = statsBefore.dispositionCounts[key] || 0;
    const ca = statsAfter.dispositionCounts[key] || 0;
    if (cb > 0 || ca > 0) {
      lines.push(col(`  ${key}`, `${cb}/${totalB}`, `${ca}/${totalA}`));
    }
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
    const rB = statsBefore.repeatedNA > 0
      ? `${statsBefore.repeatedTrue}/${statsBefore.eligiblePairs}`
      : statsBefore.repeatedTrue;
    const rA = statsAfter.repeatedNA > 0
      ? `${statsAfter.repeatedTrue}/${statsAfter.eligiblePairs}`
      : statsAfter.repeatedTrue;
    lines.push(col("  repeatedAreas true", rB, rA));
  }

  // Prior unresolved
  lines.push("  ── Prior unresolved (heuristic) ──");
  lines.push(col("  Flagged", statsBefore.priorUnresolvedCount, statsAfter.priorUnresolvedCount));
  lines.push(col("  Eligible pairs", statsBefore.priorUnresolvedEligible, statsAfter.priorUnresolvedEligible));

  // Cost
  lines.push("  ── Costs ──");
  const costB = statsBefore.filteredTotals.cost || 0;
  const costA = statsAfter.filteredTotals.cost || 0;
  lines.push(col("  Total cost", `$${costB.toFixed(4)}`, `$${costA.toFixed(4)}`));

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
