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
import { hasRepeatedAreas, inScopeFindingFiles, resolveReworkScope } from "./chain-phases.mjs";
import { classifyEscalate } from "./chain-substance.mjs";

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
// Tier resolution
// =========================================================================

/**
 * Strip the `:variant` suffix from a route string.
 *
 * A route string has the form `provider/model[:variant]` where the variant
 * follows the first `:` after the `/`.  If no variant is present the string
 * is returned unchanged.
 *
 * @param {*} route
 * @returns {string}
 */
function dropVariant(route) {
  if (typeof route !== "string") return "";
  const slashIdx = route.indexOf("/");
  if (slashIdx === -1) return route;
  const colonIdx = route.indexOf(":", slashIdx + 1);
  if (colonIdx === -1) return route;
  return route.substring(0, colonIdx);
}

/**
 * Normalise a modelChain entry to always be an array of route strings.
 *
 * Flat entries (a single string) become a one-element array.  Tiered entries
 * (already an array) are returned as-is.  Non-strings are dropped.
 *
 * @param {string|string[]} entry
 * @returns {string[]}
 */
function normaliseTierEntry(entry) {
  if (typeof entry === "string") return [entry];
  if (Array.isArray(entry)) {
    return entry.filter((e) => typeof e === "string");
  }
  return [];
}

/**
 * Resolve the tier index for a round from its modelEntry and the chain's
 * modelChain.
 *
 * Resolution tries, in order:
 *
 * 1. `"recorded"` — `round.tierBefore` is a number.  Use it and stop.
 * 2. `"derived"` — the normalised modelChain contains `modelEntry` as an
 *    exact string match.  The tier index is the index of the entry
 *    containing it.
 * 3. `"derived-variant-insensitive"` — same match after dropping the
 *    `:variant` suffix from both sides.
 * 4. `"unknown"` — nothing matched, or there is no usable modelChain.
 *
 * The function **never throws**, whatever garbage is in the input.
 *
 * @param {object}   round      — round record (may carry `tierBefore`, `modelEntry`)
 * @param {*}        modelChain — chain config (array | undefined | null | anything)
 * @returns {{ tierIndex: number, tierCount: number, source: string }}
 *   `tierIndex` is the 0-based index or -1 for unknown.
 *   `tierCount` is the number of tiers in the modelChain (0 if unusable).
 *   `source` is one of `"recorded"`, `"derived"`, `"derived-variant-insensitive"`,
 *   `"unknown"`.
 */
export function resolveRoundTier(round, modelChain) {
  // Step 1: recorded — round.tierBefore is a finite number.
  // `typeof NaN === "number"`, so the finiteness check is load-bearing: a NaN
  // tierBefore would be reported as `source: "recorded"` while vanishing from
  // tierCounts and the peak-tier scan (every NaN comparison is false), i.e. an
  // authoritative-looking count over a round that appears nowhere.
  if (typeof round?.tierBefore === "number" && Number.isFinite(round.tierBefore)) {
    const tierCount = getTierCount(modelChain);
    return { tierIndex: round.tierBefore, tierCount, source: "recorded" };
  }

  // Must have a string modelEntry to attempt derivation
  if (!round?.modelEntry || typeof round.modelEntry !== "string") {
    const tierCount = getTierCount(modelChain);
    return { tierIndex: -1, tierCount, source: "unknown" };
  }

  // ModelChain must be an array
  if (!Array.isArray(modelChain)) {
    return { tierIndex: -1, tierCount: 0, source: "unknown" };
  }

  // Normalise: each tier entry becomes an array of strings
  const normalised = modelChain.map(normaliseTierEntry);
  const tierCount = normalised.length;

  // Step 2: exact match
  for (let i = 0; i < normalised.length; i++) {
    for (const entry of normalised[i]) {
      if (entry === round.modelEntry) {
        return { tierIndex: i, tierCount, source: "derived" };
      }
    }
  }

  // Step 3: variant-insensitive match
  const modelBase = dropVariant(round.modelEntry);
  for (let i = 0; i < normalised.length; i++) {
    for (const entry of normalised[i]) {
      if (dropVariant(entry) === modelBase) {
        return { tierIndex: i, tierCount, source: "derived-variant-insensitive" };
      }
    }
  }

  // Step 4: unknown
  return { tierIndex: -1, tierCount, source: "unknown" };
}

/**
 * Get the number of tiers from a modelChain.
 *
 * @param {*} modelChain
 * @returns {number}
 */
function getTierCount(modelChain) {
  if (!Array.isArray(modelChain)) return 0;
  return modelChain.length;
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
  const parseBound = (v) => {
    if (v === undefined) return null;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
  };
  const sinceMs = parseBound(since);
  const untilMs = parseBound(until);

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
      // Compare as instants, not as strings.  `startedAt` is always written as
      // UTC (`...Z`), but a human writing `--since` / `--compare` naturally
      // reaches for local time (`2026-07-26T10:53:49+09:00`).  Lexicographic
      // comparison puts that same instant on the wrong side of the cutoff --
      // silently, with a plausible-looking table.  Unparseable bounds fall back
      // to string comparison so a malformed flag degrades no worse than before.
      const at = Date.parse(r.startedAt);
      if (sinceMs !== null && Number.isFinite(at)) {
        if (at < sinceMs) continue;
      } else if (since !== undefined && r.startedAt && r.startedAt < since) continue;
      if (untilMs !== null && Number.isFinite(at)) {
        if (at >= untilMs) continue;
      } else if (until !== undefined && r.startedAt && r.startedAt >= until) continue;
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
  const dispositionCounts = {
    accept: 0,
    "accept-with-followup": 0,
    rework: 0,
    strategize: 0,
    escalate: 0,
    discard: 0,
    other: 0,
  };
  const escalateSplit = { substantive: 0, noWork: 0, unknown: 0 };

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
      if (disp === "escalate") {
        // Classify over the SAME in-range rounds that produced the
        // disposition, so the split never disagrees with the count.
        const label = classifyEscalate(chainRounds);
        if (label === "substantive") escalateSplit.substantive += 1;
        else if (label === "no-work") escalateSplit.noWork += 1;
        else escalateSplit.unknown += 1;
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
    for (const usage of [round.implementUsage, round.reviewUsage, round.strategistUsage, round.reviewFirstUsage]) {
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

  // ---- tier distribution ----
  const tierCounts = {};        // { [tierIndex]: count } — only resolved tiers (index >= 0)
  const tierSourceBreakdown = {
    recorded: 0,
    derived: 0,
    "derived-variant-insensitive": 0,
    unknown: 0,
  };

  for (const { chainIndex, round } of allRounds) {
    const chain = chains[chainIndex];
    const chainMeta = chain?.meta;
    const modelChain = chainMeta?.modelChain;
    const resolved = resolveRoundTier(round, modelChain);
    tierSourceBreakdown[resolved.source] = (tierSourceBreakdown[resolved.source] || 0) + 1;
    if (resolved.tierIndex >= 0) {
      const key = String(resolved.tierIndex);
      tierCounts[key] = (tierCounts[key] || 0) + 1;
    }
  }

  // ---- per-chain peak tier (only active chains) ----
  const chainTiers = {}; // { chainIndex: { chainId, tierCount, maxTier } }
  const chainShapeDistribution = {}; // { [tierCount]: number of chains }

  for (const ci of activeChainIndices) {
    const chain = chains[ci];
    const chainMeta = chain?.meta;
    const modelChain = chainMeta?.modelChain;
    const tierCount = Array.isArray(modelChain) ? modelChain.length : 0;

    // Track chain shape (only chains that have a resolvable modelChain)
    if (tierCount > 0) {
      const shapeKey = String(tierCount);
      chainShapeDistribution[shapeKey] = (chainShapeDistribution[shapeKey] || 0) + 1;
    }

    // Find the peak tier among this chain's rounds in range
    let maxTier = -1;
    for (const { chainIndex: ci2, round } of allRounds) {
      if (ci2 !== ci) continue;
      const resolved = resolveRoundTier(round, modelChain);
      if (resolved.tierIndex >= 0 && resolved.tierIndex > maxTier) {
        maxTier = resolved.tierIndex;
      }
    }

    chainTiers[ci] = {
      chainId: chain.chainId,
      tierCount,
      peakTier: maxTier >= 0 ? maxTier : -1,
    };
  }

  // How many chains reached their top tier
  let chainsReachedTopTier = 0;
  for (const ct of Object.values(chainTiers)) {
    if (ct.tierCount > 0 && ct.peakTier >= 0 && ct.peakTier === ct.tierCount - 1) {
      chainsReachedTopTier += 1;
    }
  }

  const chainPeakTiers = Object.values(chainTiers);

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

    // Model and tier
    modelCounts,
    modelEntryNA,
    tierCounts,
    tierSourceBreakdown,

    // Chain-level
    chainPeakTiers,
    chainsReachedTopTier,
    chainShapeDistribution,

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
  const dispOrder = ["accept", "accept-with-followup", "escalate", "rework", "strategize", "discard"];
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

  // Tier distribution
  lines.push("Tier distribution:");
  const tierEntries = Object.entries(stats.tierCounts).sort((a, b) => Number(a[0]) - Number(b[0]));
  const tierTotal = stats.roundCount;
  const unknownTierCount = stats.tierSourceBreakdown.unknown;
  if (tierTotal > 0 && (tierEntries.length > 0 || unknownTierCount < tierTotal)) {
    for (const [tierIdx, count] of tierEntries) {
      lines.push(line(`tier ${tierIdx}`, count, tierTotal));
    }
    if (unknownTierCount > 0) {
      lines.push(line("unknown", unknownTierCount, tierTotal));
    }
    lines.push(`  Source breakdown: recorded=${stats.tierSourceBreakdown.recorded}, derived=${stats.tierSourceBreakdown.derived}, variant-insensitive=${stats.tierSourceBreakdown["derived-variant-insensitive"]}, unknown=${stats.tierSourceBreakdown.unknown}`);
  } else if (tierTotal > 0 && unknownTierCount >= tierTotal) {
    lines.push("  (no round has a resolvable tier — all are \"unknown\")");
    lines.push(`  Source breakdown: recorded=${stats.tierSourceBreakdown.recorded}, derived=${stats.tierSourceBreakdown.derived}, variant-insensitive=${stats.tierSourceBreakdown["derived-variant-insensitive"]}, unknown=${stats.tierSourceBreakdown.unknown}`);
  } else {
    lines.push("  (no tier data)");
  }
  lines.push("");

  // Per-chain peak tier
  lines.push("Peak tier per chain:");
  if (stats.chainPeakTiers.length > 0) {
    for (const ct of stats.chainPeakTiers) {
      const peakStr = ct.peakTier >= 0 ? `${ct.peakTier} of ${ct.tierCount}` : "unknown";
      lines.push(`  ${ct.chainId}: peak ${peakStr}`);
    }
    lines.push(line("Reached top tier", stats.chainsReachedTopTier, stats.chainPeakTiers.length));
  } else {
    lines.push("  (no active chains with rounds)");
  }
  lines.push("");

  // Chain shapes
  lines.push("Chain shape distribution:");
  const shapeEntries = Object.entries(stats.chainShapeDistribution)
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  if (shapeEntries.length > 0) {
    const totalShapes = Object.values(stats.chainShapeDistribution).reduce((s, c) => s + c, 0);
    for (const [tierCount, count] of shapeEntries) {
      lines.push(line(`${tierCount}-tier`, count, totalShapes));
    }
  } else {
    lines.push("  (no chain shape data)");
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

  // Tiers
  lines.push("  ── Tiers ──");
  const allTiers = new Set([...Object.keys(statsBefore.tierCounts), ...Object.keys(statsAfter.tierCounts)]);
  const tierTotalB2 = statsBefore.roundCount;
  const tierTotalA2 = statsAfter.roundCount;
  // A bare tier index is only comparable when both ranges ran on chains of the
  // same shape: tier 1 of a 2-tier chain is the top tier, tier 1 of a 3-tier
  // chain is the middle one.  Label the position with the tier count when the
  // shape is unambiguous, and say so plainly when it is not -- this view exists
  // to answer "did the expensive tier get used less", which a mixed-shape
  // aggregate cannot answer.
  const shapesB = Object.keys(statsBefore.chainShapeDistribution || {});
  const shapesA = Object.keys(statsAfter.chainShapeDistribution || {});
  const allShapes = new Set([...shapesB, ...shapesA]);
  const sharedTierCount = allShapes.size === 1 ? [...allShapes][0] : null;

  for (const tierIdx of [...allTiers].sort((a, b) => Number(a) - Number(b))) {
    const cb = statsBefore.tierCounts[tierIdx] || 0;
    const ca = statsAfter.tierCounts[tierIdx] || 0;
    if (cb > 0 || ca > 0) {
      const label = sharedTierCount !== null
        ? `  tier ${tierIdx} of ${sharedTierCount}`
        : `  tier ${tierIdx}`;
      lines.push(col(label, `${cb}/${tierTotalB2}`, `${ca}/${tierTotalA2}`));
    }
  }
  if (sharedTierCount === null && allShapes.size > 1) {
    lines.push(`  (tier index is not comparable here: chain shapes differ (${[...allShapes].sort().join("-tier, ")}-tier) —`);
    lines.push("   see 'peak tier per chain' in the single-range view)");
  }
  const unknownB = statsBefore.tierSourceBreakdown.unknown;
  const unknownA = statsAfter.tierSourceBreakdown.unknown;
  if (unknownB > 0 || unknownA > 0) {
    lines.push(col(`  unknown`, `${unknownB}/${tierTotalB2}`, `${unknownA}/${tierTotalA2}`));
  }

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
