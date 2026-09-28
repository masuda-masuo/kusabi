// metrics-render.mjs — the text/JSON rendering half of the metrics report
// surface, split out of metrics-report.mjs.  Takes the report object
// computed by `computeReport` / `missingStoreReport` (metrics-report.mjs)
// and renders it as plain aligned text or a single JSON document.  Pure
// rendering: no database access, no aggregation — the report object is the
// only input.
//
// Import direction: this module imports from metrics-report.mjs
// (SEVERITY_ORDER); metrics-report.mjs never imports from here.  Text is
// local-digit-grouped only, never toLocaleString (locale-dependent output
// would make text non-deterministic across machines and the test
// environment); cost is RELATIVE UNITS, never dollars.

import { SEVERITY_ORDER } from "./metrics-report.mjs";
import { STOP_REASONS, UNKNOWN_STOP_REASON } from "./stop-reason.mjs";
import { listToolStats } from "./tool-stats.mjs";

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
// stop-reason breakdown (kusabi #380) — render
// ---------------------------------------------------------------------------

function renderStopReasonBucket(bucket) {
  const lines = [];
  // Closed set first (in declared order), then the unknown sentinel, then
  // the absent bucket — each on its own line so counts never collapse into
  // a completed-looking total.
  const order = [...STOP_REASONS, UNKNOWN_STOP_REASON];
  for (const reason of order) {
    const n = (bucket.byReason && bucket.byReason[reason]) || 0;
    lines.push(`  ${reason}: ${fmtCount(n)}`);
  }
  lines.push(`  (absent / pre-#380): ${fmtCount(bucket.absent || 0)}`);
  return lines;
}

function renderStopReasonBreakdown(section) {
  const lines = [];
  lines.push("Stop-reason breakdown (kusabi #380)");
  lines.push("  worker terminal reasons, closed set + unknown; legacy rows with no field");
  lines.push("  are shown as (absent) and are NEVER folded into completed.");
  lines.push("  jobs:");
  lines.push(...renderStopReasonBucket(section.jobs));
  lines.push("  rounds:");
  lines.push(...renderStopReasonBucket(section.rounds));
  return lines;
}

function renderOneToolStatsMap(map) {
  const lines = [];
  for (const row of listToolStats(map)) {
    lines.push(
      `  ${row.tool}  count ${fmtCount(row.count)}  success ${fmtCount(row.success)}  failure ${fmtCount(row.failure)}`,
    );
  }
  return lines;
}

function renderToolStatsCoverageLine(coverage) {
  const n = coverage?.excludedJobCount ?? 0;
  const jobWord = n === 1 ? "job" : "jobs";
  return `  coverage: opencode jobs only; ${n} ${jobWord} on other backends excluded`;
}

function renderToolStats(section) {
  if (!section) return [];
  const hideTable = section.coverage?.coveredJobCount === 0;
  const coverageLine = renderToolStatsCoverageLine(section.coverage);
  const emptyBody = "  no covered jobs in this window";
  const lines = [];
  lines.push("Tool usage (all jobs in window): opencode (SSE events) only");
  lines.push("  per-tool counts folded per part.id; zero-filled over the known-tool table;");
  lines.push("  unknown-but-observed tools listed after the known ones.");
  lines.push(coverageLine);
  if (hideTable) {
    lines.push(emptyBody);
  } else {
    lines.push(...renderOneToolStatsMap(section.all));
  }
  lines.push("Tool usage (failed jobs only): opencode (SSE events) only");
  lines.push("  failed = stop_reason present and != completed, or wrapper status non-completed;");
  lines.push("  jobs with NULL stop_reason (legacy) are excluded, never guessed.");
  lines.push("  an unknown stop_reason is never counted as success.");
  lines.push(coverageLine);
  if (hideTable) {
    lines.push(emptyBody);
  } else {
    lines.push(...renderOneToolStatsMap(section.failedJobs));
  }
  return lines;
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

/**
 * Render section A — escalate review axis (round-level).  The label states
 * the unit explicitly: the #165 split above is chain-FINAL, these rows are
 * per-round, and the two must not be confused (a round whose review failed
 * and a chain that ended in escalate are different denominators).
 */
function renderEscalateReviewAxis(section) {
  const lines = [
    "Escalate review axis (ROUND-level — per-round verdicts of escalated rounds, NOT the #165 chain-final split above):",
  ];
  if (section.escalateRounds === 0) {
    lines.push("  (no escalated rounds in window)");
    return lines;
  }
  const sourceNote = section.verdictSourceAvailable
    ? "verdict_source recorded: review-issued / probe-issued / unknown-source split"
    : "store predates round.verdict_source: every source is unknown (records predate the field)";
  lines.push(
    `  escalated rounds: ${fmtCount(section.escalateRounds)}  |  all-green escalate (probes all green): ${fmtCount(section.allGreenEscalate)}  |  ${sourceNote}`,
  );
  // g/r/u = probes green/red/unknown (NULL probes is its own bucket, never
  // folded into red); r/p/u/o = source review/probe/unknown/other (NULL
  // source its own bucket, never folded into either side; "other" = an
  // unrecognized non-NULL source, shown verbatim below, never review
  // output).
  lines.push(
    `  ${"verdict".padEnd(18)}${"rounds".padStart(8)}  ${"probes g/r/u".padStart(13)}  ${"source r/p/u/o".padStart(16)}`,
  );
  lines.push("  r/p/u/o = review-issued / probe-issued / unknown-source (NULL) / other-source (unrecognized value, shown verbatim below)");
  for (const row of section.byVerdict) {
    const g = row.probesGreen;
    const s = row.source;
    lines.push(
      `  ${row.verdict.padEnd(18)}${String(row.rounds).padStart(8)}`
      + `  ${String(g.green).padStart(4)}/${String(g.red).padStart(2)}/${String(g.unknown).padStart(5)}`
      + `  ${String(s.review).padStart(4)}/${String(s.probe).padStart(2)}/${String(s.unknown).padStart(5)}/${String(s.other).padStart(2)}`,
    );
  }
  // Unrecognized non-NULL sources surface verbatim (the ingest pass-through
  // discipline), never as a bare count that could be mistaken for review.
  for (const row of section.byVerdict) {
    if (row.otherValues.length > 0) {
      lines.push(
        `  ${row.verdict}: other-source values verbatim: ${row.otherValues.map((v) => `"${v}"`).join(", ")}`,
      );
    }
  }
  return lines;
}

/** Render section B — disposition × severity (round-level). */
function renderDispositionSeverity(rows) {
  const lines = [
    "Disposition × severity (ROUND-level — rounds and their findings per disposition;",
    "  severity zeros are real counts: the low/medium-only complement on accept-with-followup is the signal):",
  ];
  if (rows.length === 0) {
    lines.push("  (no rounds in window)");
    return lines;
  }
  // Column order: the four known severities, then any verbatim unknown
  // values (sorted), then the "(no severity)" bucket last.  Every cell gets
  // a leading space so a 12-char column name ("(no severity)") never
  // abuts its neighbour.
  const seen = new Set();
  for (const row of rows) for (const sev of Object.keys(row.severities)) seen.add(sev);
  const extra = [...seen]
    .filter((s) => !SEVERITY_ORDER.includes(s))
    .sort((a, b) => (a === "(no severity)" ? 1 : b === "(no severity)" ? -1 : a.localeCompare(b)));
  const columns = [...SEVERITY_ORDER, ...extra];
  const cell = (text) => ` ${String(text).padStart(12)}`;
  const header = `  ${"disposition".padEnd(22)}${"rounds".padStart(8)}${"findings".padStart(10)}`
    + columns.map((c) => cell(c)).join("");
  lines.push(header);
  for (const row of rows) {
    lines.push(
      `  ${row.disposition.padEnd(22)}${String(row.rounds).padStart(8)}${String(row.findings).padStart(10)}`
      + columns.map((c) => cell(row.severities[c] ?? 0)).join(""),
    );
  }
  return lines;
}

/** Render section C — review-output pathology rate (round-level, one number,
 * denominator stated). */
function renderReviewPathology(section) {
  const caveat = section.verdictSourceAvailable
    ? "probe-issued verdicts (P3 empty-change-set discards, review never dispatched) are excluded from both sides"
    : "store predates round.verdict_source: probe-issued and review-issued verdicts are indistinguishable, so every verdict round is the denominator";
  const lines = [
    "Review-output pathology rate (ROUND-level — verdicts that are not usable judgements: unparseable, partial):",
  ];
  if (section.denominator === 0) {
    lines.push("  (no review-issued or unknown-source verdict rounds in window)");
    return lines;
  }
  const probeLine = section.probeIssued > 0
    ? `probe-issued verdicts excluded: ${fmtCount(section.probeIssued)} (discard written by the P3 empty-change-set path — not review output)`
    : `probe-issued verdicts excluded: ${fmtCount(section.probeIssued)}`;
  const otherLine = section.otherIssued > 0
    ? `unrecognized verdict_source values excluded: ${fmtCount(section.otherIssued)} (${section.otherValues.map((v) => `"${v}"`).join(", ")} — not known to be review output)`
    : null;
  lines.push(
    `  ${fmtCount(section.pathologyCount)} of ${fmtCount(section.denominator)} review-issued-or-unknown-source verdict rounds (${fmtPct(section.pct)})`,
  );
  lines.push(`  ${probeLine}`);
  if (otherLine) lines.push(`  ${otherLine}`);
  lines.push(`  ${caveat}`);
  lines.push("  Describes the distribution only — no better/worse-over-time claim.");
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

// ---------------------------------------------------------------------------
// Missions section (kusabi #532) — render
// ---------------------------------------------------------------------------

/**
 * Render the additive Missions section.  Returns [] — no section at all —
 * when no mission rows exist, so a store without missions (including a
 * pre-#532 store whose schema lacks the tables) renders byte-identically to
 * before.
 */
function renderMissionsSection(report) {
  const section = report.missions;
  if (!section || section.count === 0) return [];
  const lines = [`Missions (${fmtCount(section.count)}):`];
  for (const row of section.rows) {
    const coord = [row.coordinatorProvider, row.coordinatorModel]
      .filter((v) => typeof v === "string" && v)
      .join("/") || "?";
    lines.push(
      `  ${row.missionId}  status: ${row.status ?? "unknown"}  coordinator: ${coord}  gates: ${fmtCount(row.gates)}`,
    );
  }
  lines.push(
    `  totals: coordinator errors ${fmtInt(section.coordinatorErrors)}  brief corrections ${fmtInt(section.briefCorrections)}  ` +
      `host interventions ${fmtInt(section.hostInterventions)}  latency ${fmtNum(section.latencySeconds)}s  cost ${fmtCost(section.cost)} units`,
  );
  lines.push(
    `  tokens: in ${fmtInt(section.tokens.input)}  out ${fmtInt(section.tokens.output)}  reasoning ${fmtInt(section.tokens.reasoning)}  ` +
      `cache-read ${fmtInt(section.tokens.cacheRead)}  cache-write ${fmtInt(section.tokens.cacheWrite)}`,
  );
  lines.push(
    `  consultation origins: luna-requested ${fmtCount(section.consultationOrigins.lunaRequested)}  ` +
      `policy-mandated ${fmtCount(section.consultationOrigins.policyMandated)}  sampled ${fmtCount(section.consultationOrigins.sampled)}`,
  );
  return lines;
}

// ---------------------------------------------------------------------------
// top-level render — the exported entry points
// ---------------------------------------------------------------------------

export function renderMissingText(dbPath) {
  return `Metrics store not found at ${dbPath}. Run metrics-ingest first.`;
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
    // kusabi #532: a store that carries mission rows but nothing of the
    // legacy tables appends the Missions section after the empty line — the
    // pre-#532 text stays byte-identical, and the mission facts are never
    // hidden behind an "empty" that only describes the legacy tables.
    const missionLines = renderMissionsSection(report);
    if (missionLines.length > 0) {
      lines.push("");
      lines.push(...missionLines);
    }
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
  // kusabi #235 — the three round-level review sections sit next to the
  // #165 escalate split (above), with the unit labelled in every heading.
  lines.push("");
  lines.push(...renderEscalateReviewAxis(report.escalateReviewAxis));
  lines.push("");
  lines.push(...renderDispositionSeverity(report.dispositionSeverity));
  lines.push("");
  lines.push(...renderReviewPathology(report.reviewPathology));
  lines.push("");
  lines.push(...renderDelegatedJobs(report.delegatedJobs));
  lines.push("");
  lines.push(...renderStopReasonBreakdown(report.stopReasonBreakdown));
  const toolLines = renderToolStats(report.toolStats);
  if (toolLines.length > 0) {
    lines.push("");
    lines.push(...toolLines);
  }
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
  // kusabi #532: the additive Missions section — emitted only when mission
  // rows exist, appended after the legacy sections so nothing reflows.
  const missionLines = renderMissionsSection(report);
  if (missionLines.length > 0) {
    lines.push("");
    lines.push(...missionLines);
  }
  return lines.join("\n");
}

/** Render a computed report as a single JSON document. NULL sums stay `null`. */
export function renderReportJson(report) {
  return JSON.stringify(report, null, 2);
}
