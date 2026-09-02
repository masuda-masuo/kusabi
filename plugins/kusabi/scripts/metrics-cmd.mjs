// metrics-cmd: the look-at-recorded-work command surfaces (kusabi #443).
//
// Extracted from kusabi-companion.mjs: the inspection / reporting / dashboard
// commands (cmdChainStats, cmdMetricsIngest, cmdMetricsReport, cmdDashboard)
// and their helper (dashboardPortFlag).
//
// IMPORT DIRECTION: Unlike chain-cmd.mjs, chain-ops.mjs, and task-cmd.mjs,
// this module does NOT import kusabi-companion.mjs. It has no cycle with
// companion: it calls only leaf modules (chain-stats.mjs, metrics-db.mjs,
// transcript-ingest.mjs, cursor-usage-ingest.mjs, chain-ingest.mjs,
// metrics-report.mjs, dashboard.mjs, state-paths.mjs, cursor-statusline-sink.mjs).
//
// This module does NOT import chain-driver.mjs, chain-cmd.mjs, chain-ops.mjs,
// task-cmd.mjs, chain-phases.mjs, or chain-review.mjs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { stateRoot, stateDirFor } from "./state-paths.mjs";
import {
  collectChainRecords,
  computeStats,
  renderChainStats,
  renderComparison,
} from "./chain-stats.mjs";
import { openMetricsDb, openMetricsDbReadOnly } from "./metrics-db.mjs";
import { ingestTranscriptDirectory } from "./transcript-ingest.mjs";
import { ingestCursorUsageDirectory } from "./cursor-usage-ingest.mjs";
import { ingestChainDirectory, ingestJobDirectory } from "./chain-ingest.mjs";
import {
  computeReport,
  renderReportText,
  renderReportJson,
  missingStoreReport,
  renderMissingText,
} from "./metrics-report.mjs";
import { startDashboard } from "./dashboard.mjs";
import { cursorUsageDir } from "./cursor-statusline-sink.mjs";

// ---------------------------------------------------------------------------
// chain-stats
// ---------------------------------------------------------------------------

export function cmdChainStats(cwd, { flags }) {
  const stateDir = stateDirFor(cwd);
  const { chains, skipped, noRecord } = collectChainRecords(stateDir);

  // Notes appended to either view.  A chain directory with no chain.json is
  // a run that died before persisting -- reported separately from corruption.
  const notes = [];
  if (skipped > 0) notes.push(`(unreadable chain.json files skipped: ${skipped})`);
  if (noRecord > 0) notes.push(`(chains that never persisted a chain.json: ${noRecord})`);

  if (chains.length === 0 && skipped === 0 && noRecord === 0) {
    throw new Error("no chain records found for this workspace");
  }

  // Resolve time ranges
  const since = flags.since || undefined;
  const until = flags.until || undefined;
  const compare = flags.compare || undefined;

  if (compare && (since || until)) {
    // --compare derives both ranges from the cutoff alone.  Accepting
    // --since/--until here and ignoring them would silently answer a
    // different question than the one asked.
    throw new Error("--compare is incompatible with --since/--until: it derives both ranges from the cutoff");
  }

  if (compare) {
    // Side-by-side comparison: before and after the cutoff
    const beforeStats = computeStats(chains, { since: undefined, until: compare });
    const afterStats = computeStats(chains, { since: compare, until: undefined });
    const lines = [renderComparison(beforeStats, afterStats, compare)];

    if (notes.length) lines.push("", ...notes);

    return lines.join("\n");
  }

  const stats = computeStats(chains, { since, until });
  const lines = [renderChainStats(stats, { since, until })];

  if (notes.length) lines.push(...notes);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// metrics-ingest
// ---------------------------------------------------------------------------

/**
 * Ingest Claude Code transcripts, Cursor usage jsonl (#237), kusabi chain
 * records, and delegated-job records (#154) into a durable SQLite metrics
 * store.  This is the ingest + store step only (issues #83 / #81) -- no
 * reporting/rendering here; that is a follow-up PR.
 *
 * `--dry-run` parses everything but writes to a throwaway in-memory
 * database instead of the real one, so the target db path (and any file at
 * it) is never touched -- not "parse and roll back", but "never opened".
 */
export function cmdMetricsIngest(cwd, { flags }) {
  const home = os.homedir();
  const transcriptDir = flags["transcript-dir"] || path.join(home, ".claude", "projects");
  const cursorDir = flags["cursor-usage-dir"] || cursorUsageDir();
  const metricsStateRoot = flags["state-root"] || stateRoot();
  const dryRun = !!flags.dryRun;
  const dbPath = dryRun ? ":memory:" : (flags.db || path.join(metricsStateRoot, "metrics.db"));

  const db = openMetricsDb(dbPath);

  let transcriptSummary;
  let cursorSummary;
  let chainSummary;
  let jobSummary;
  db.exec("BEGIN");
  try {
    transcriptSummary = ingestTranscriptDirectory(db, transcriptDir);
    cursorSummary = ingestCursorUsageDirectory(db, cursorDir);
    chainSummary = ingestChainDirectory(db, metricsStateRoot);
    jobSummary = ingestJobDirectory(db, metricsStateRoot);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const lines = [];
  lines.push(`Metrics ingest${dryRun ? " (dry run — nothing written)" : ""}`);
  lines.push(`  db: ${dryRun ? "(discarded, in-memory)" : dbPath}`);
  lines.push("");
  lines.push("Transcripts:");
  lines.push(`  transcript dir:            ${transcriptDir}`);
  if (!fs.existsSync(transcriptDir)) {
    lines.push(`warning: transcript dir not found: ${transcriptDir}`);
  }
  lines.push(`  files scanned:             ${transcriptSummary.filesScanned}`);
  lines.push(`  files skipped (unchanged): ${transcriptSummary.filesSkippedUnchanged}`);
  lines.push(`  sessions:                  ${transcriptSummary.sessions}`);
  lines.push(`  turns (deduped by requestId, across all files): ${transcriptSummary.turns}`);
  lines.push(`  assistant records seen:    ${transcriptSummary.assistantRecords}`);
  lines.push(`  <synthetic> records:       ${transcriptSummary.syntheticRecords}`);
  // Three distinct, non-overlapping-except-as-noted counters -- deliberately
  // not folded into one "failures" number (see transcript-ingest.mjs):
  //  - ioFailures: a whole FILE unreadable (one increment == one file's
  //    worth of records entirely absent from this run).
  //  - parseFailures: a malformed JSON line/record within a file that WAS
  //    read successfully.
  //  - records skipped (no requestId): not a failure at all -- typically
  //    <synthetic> placeholders that were never assigned one, so they
  //    overlap with the <synthetic> count above rather than adding to it.
  lines.push(`  I/O failures (whole file unreadable): ${transcriptSummary.ioFailures}`);
  lines.push(`  parse failures (malformed JSON):       ${transcriptSummary.parseFailures}`);
  lines.push(`  records skipped (no requestId):        ${transcriptSummary.noRequestIdRecords} (overlaps with <synthetic> above, not additional data loss)`);
  lines.push("");
  lines.push("Cursor usage:");
  lines.push(`  cursor-usage dir:          ${cursorDir}`);
  if (!fs.existsSync(cursorDir)) {
    lines.push(`warning: cursor-usage dir not found: ${cursorDir}`);
  }
  lines.push(`  files scanned:             ${cursorSummary.filesScanned}`);
  lines.push(`  files skipped (unchanged): ${cursorSummary.filesSkippedUnchanged}`);
  lines.push(`  sessions:                  ${cursorSummary.sessions}`);
  lines.push(`  turns:                     ${cursorSummary.turns}`);
  lines.push(`  usage lines collapsed as repeated snapshots: ${cursorSummary.collapsedRepeats}`);
  lines.push(`  stale turn rows deleted before re-insert:    ${cursorSummary.staleTurnsRemoved}`);
  lines.push(`  I/O failures (whole file unreadable): ${cursorSummary.ioFailures}`);
  lines.push(`  parse failures (malformed JSON):       ${cursorSummary.parseFailures}`);
  lines.push("");
  lines.push("Chains:");
  lines.push(`  state root:                ${metricsStateRoot}`);
  lines.push(`  files scanned:             ${chainSummary.filesScanned}`);
  lines.push(`  files skipped (unchanged): ${chainSummary.filesSkippedUnchanged}`);
  lines.push(`  I/O failures (whole file unreadable): ${chainSummary.ioFailures}`);
  lines.push(`  parse failures (malformed JSON / no chainId): ${chainSummary.parseFailures}`);
  lines.push(`  chains:                    ${chainSummary.chainsIngested}`);
  lines.push(`  rounds:                    ${chainSummary.roundsIngested}`);
  lines.push(`  findings:                  ${chainSummary.findingsIngested}`);
  // Raw count, not a rate: generational gaps mean this is a coverage figure,
  // not something to divide into a percentage here -- the follow-up
  // query/report PR decides how (or whether) to qualify a rate over it.
  lines.push(`  chains with structured findings (non-empty findings/findingFiles): ${chainSummary.chainsWithStructuredFindings} of ${chainSummary.chainsIngested}`);
  lines.push("");
  // Delegated jobs (#154). Counters are per JOB, not per file — a job is up
  // to two files (job.json + usage.json) sharing one composite skip key
  // (see ingestJobDirectory). Reported even when every number is 0, so
  // "no jobs on disk" is visible rather than a silent absence.
  lines.push("Jobs (delegated single-shot task/review jobs):");
  lines.push(`  state root:                ${metricsStateRoot}`);
  lines.push(`  jobs scanned:              ${jobSummary.jobsScanned}`);
  lines.push(`  jobs skipped (unchanged):  ${jobSummary.jobsSkippedUnchanged}`);
  lines.push(`  I/O failures (job.json/usage.json unreadable): ${jobSummary.ioFailures}`);
  lines.push(`  parse failures (malformed JSON / no job id):   ${jobSummary.parseFailures}`);
  lines.push(`  jobs ingested:             ${jobSummary.jobsIngested}`);
  lines.push(`  jobs without usage.json (ended before usage was written): ${jobSummary.jobsMissingUsage}`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// metrics-report
// ---------------------------------------------------------------------------

/**
 * Pure-reader query/report surface over the SQLite metrics store built by
 * `metrics-ingest` (issues #83 / #81). Never ingests, never opens the
 * writable handle (`openMetricsDb`) -- only `openMetricsDbReadOnly`. See
 * docs/design/phase-chain.md 3.5.9.
 */
export function cmdMetricsReport(cwd, { flags }) {
  if (flags.compare) {
    // Silently ignoring an accepted flag would answer a different question
    // than the one asked -- chain-stats supports --compare, this surface
    // does not, and pretending otherwise produces a plausible-looking but
    // wrong report.
    throw new Error("--compare is not supported by metrics-report; run it twice with --since/--until instead");
  }

  const metricsStateRoot = flags["state-root"] || stateRoot();
  const dbPath = flags.db || path.join(metricsStateRoot, "metrics.db");
  const since = flags.since || undefined;
  const until = flags.until || undefined;
  const wantJson = !!flags.json;

  if (!fs.existsSync(dbPath)) {
    // Never open a read-only handle against a missing path (it throws) and
    // never create the file here -- an absent store is a state, not an
    // error: this returns normally (exit 0).
    const report = missingStoreReport(dbPath);
    return wantJson ? renderReportJson(report) : renderMissingText(dbPath);
  }

  const db = openMetricsDbReadOnly(dbPath);
  try {
    const report = computeReport(db, { since, until, dbPath });
    return wantJson ? renderReportJson(report) : renderReportText(report);
  } finally {
    db.close();
  }
}

export function dashboardPortFlag(flags, fallback = 8752) {
  const raw = flags.port;
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`--port expects a TCP port number, got: ${raw}`);
  }
  return n;
}

export async function cmdDashboard(_cwd, { flags }) {
  const root = flags["state-root"] || stateRoot();
  const dbPath = flags.db || path.join(root, "metrics.db");
  const port = dashboardPortFlag(flags);
  const { server, port: bound } = await startDashboard({
    stateRoot: root,
    dbPath,
    port,
  });
  const dbLabel = fs.existsSync(dbPath) ? dbPath : "missing";
  process.stdout.write(
    `dashboard: listening on http://127.0.0.1:${bound} (state root ${root}, db ${dbLabel})\n`,
  );
  await new Promise((resolve) => {
    server.on("close", resolve);
  });
  return "";
}
