// chain-ops: command surfaces for chain operation and observation (show, wait, cancel, detach, baseline).
//
// Extracted from kusabi-companion.mjs (kusabi #427): the CLI subcommands that
// observe or steer an already-dispatched chain, plus baseline measurement.
// This module is NOT a leaf: it imports helpers from kusabi-companion.mjs,
// forming a companion cycle.
//
// IMPORT DIRECTION. This module imports from kusabi-companion.mjs (readBriefFile,
// loadConfig, resolveDispatchBackend, briefLintReport), and companion imports
// the moved subcommand functions back. The cycle is safe because every name
// crossing it is a hoisted function declaration and nothing here runs at
// module-evaluation time: companion is evaluated after this module's definitions exist.
//
// This module also imports sessionProvenanceRefusal from chain-cmd.mjs.
// This module does NOT import chain-driver.mjs.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { stateRoot, stateDirFor, readJson } from "./state-paths.mjs";
import { latestJob, listJobs } from "./job-store.mjs";
import {
  readChainControl,
  writeChainControl,
  requestChainStop,
  effectiveStatus,
} from "./chain-control.mjs";
import {
  waitForChain,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_APPEAR_TIMEOUT_MS,
  DEFAULT_PROGRESS_TIMEOUT_MS,
} from "./chain-wait.mjs";
import { renderChainShow } from "./render.mjs";
import { serverHealthy, api } from "./serve-lifecycle.mjs";
import { parseSmoke } from "./brief-parsing.mjs";
import { countUnfilledReviewRecords } from "./review-record-scan.mjs";
import { captureVerifyBaseline } from "./chain-phases.mjs";
import { sessionProvenanceRefusal } from "./chain-cmd.mjs";
import {
  smokeBaselineReport,
  publishWarningForBrief,
  smokeViolationReport,
} from "./chain-brief-guards.mjs";

import {
  readBriefFile,
  loadConfig,
  resolveDispatchBackend,
  briefLintReport,
} from "./kusabi-companion.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPANION_SCRIPT = path.join(HERE, "kusabi-companion.mjs");

export async function cmdChainCancel(cwd, { text }) {
  const stateDir = stateDirFor(cwd);
  const chainId = text.split(/\s+/).filter(Boolean)[0];
  if (!chainId) throw new Error("chain-cancel requires a chain id. Usage: chain-cancel <chainId>");

  const chainsDir = path.join(stateDir, "chains");
  const chainDir = path.join(chainsDir, chainId);
  if (!fs.existsSync(chainDir)) {
    throw new Error(`chain not found: ${chainId}`);
  }

  // A chain directory with no control record is a dispatch that died before
  // it ever wrote anything (kusabi #298) — a WSL shutdown leaves exactly this
  // behind.  Nothing will ever finalise it, so it would stay a permanent trap
  // for later bare `chain-wait --next`; healing is explicit: persist a
  // terminal record and be done.
  if (!readChainControl(chainDir)) {
    writeChainControl(chainDir, {
      chainId,
      status: "cancelled",
      round: 0,
      stopRequestedAt: new Date().toISOString(),
      stopRequestedBy: "cli",
      finishedAt: new Date().toISOString(),
    });
    return `chain ${chainId} had no control record (never started) — status finalised to cancelled.`;
  }

  // Request the stop via the file-based protocol.
  // requestChainStop handles the stale-pid exception internally.
  const result = requestChainStop(chainDir, "cli");

  if (result.wasStale) {
    return `chain ${chainId} was stale (process gone) — status finalised to cancelled.`;
  }

  if (result.wasRunning) {
    // Locate the chain's currently-running phase job and abort it via the opencode server API.
    // This prevents the phase from burning down its timeout while the chain waits
    // at the next round boundary to notice the stop request.
    const jobPattern = new RegExp("^chain:\\s+" + chainId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s+round\\s+\\d+");
    const jobs = listJobs(stateDir);
    const runningJob = jobs.find(function (j) {
      return j.status === "running" && jobPattern.test(j.title || "");
    });

    let abortInfo = "";
    if (runningJob && runningJob.sessionID) {
      const server = readJson(path.join(stateDir, "server.json"));
      if (await serverHealthy(server)) {
        try {
          await api(server, "POST", `/session/${runningJob.sessionID}/abort`);
          abortInfo = ` Aborted job ${runningJob.id} (session ${runningJob.sessionID}).`;
        } catch {
          abortInfo = ` (failed to abort job ${runningJob.id} — server may be unavailable).`;
        }
      } else {
        abortInfo = ` (server not available — job ${runningJob.id} will burn down its timeout).`;
      }
    }

    return `stop requested for chain ${chainId}. It will not start a new round.${abortInfo}`;
  }

  // Chain was not running — still tried to honour the request.
  const control = readChainControl(chainDir);
  const status = control ? (effectiveStatus(control).status) : "unknown";
  return `chain ${chainId} is not running (status: ${status}). Stop request recorded anyway.`;
}

/**
 * Read-only baseline subcommand.
 * Reports collected test count, gate pass status, lint/type violation counts,
 * and optionally runs declared ## Smoke entries against pristine checkout.
 *
 * @param {string} cwd
 * @param {object} opts
 * @param {object} opts.flags
 * @param {string} opts.text
 * @returns {Promise<string|{text: string, exitCode: number}>}
 */
export async function cmdBaseline(cwd, { flags, text }) {
  const tokens = text ? text.split(/\s+/).filter(Boolean) : [];
  let consumedIndex = 0;

  let container = null;
  if (flags.container) {
    container = flags.container;
  } else if (tokens.length > 0) {
    container = tokens[0];
    consumedIndex++;
  } else {
    throw new Error("baseline requires a container id");
  }

  let briefText = null;
  if (flags["brief-file"]) {
    briefText = readBriefFile(flags, "");
  } else if (consumedIndex < tokens.length) {
    const briefArg = tokens[consumedIndex];
    consumedIndex++;
    try {
      if (fs.existsSync(briefArg)) {
        briefText = fs.readFileSync(briefArg, "utf8").trim();
      } else {
        briefText = briefArg;
      }
    } catch {
      briefText = briefArg;
    }
  }

  const unusedTokens = tokens.slice(consumedIndex);
  if (unusedTokens.length > 0) {
    throw new Error(`unexpected positional argument: ${unusedTokens.join(" ")}`);
  }

  const { callTool } = await import("./sunaba-rpc.mjs");

  const verifyRes = await captureVerifyBaseline(callTool, container);
  if (!verifyRes || verifyRes.captured !== true) {
    return {
      text: `baseline error: ${verifyRes?.error ?? "unknown error"}`,
      exitCode: 1,
    };
  }

  const lines = [
    `Baseline for container ${container}:`,
    `  Collected tests: ${verifyRes.collected ?? "unavailable"}`,
    `  Verify gate: ${verifyRes.gate_passed ? "passed" : "failed"}`,
    `  Lint violations: ${verifyRes.lint ?? "unavailable"}`,
    `  Type violations: ${verifyRes.types ?? "unavailable"}`,
  ];

  if (briefText) {
    const smokeEntries = parseSmoke(briefText);
    if (smokeEntries.length > 0) {
      const smokeReport = await smokeBaselineReport({ brief: briefText, callTool, container });
      if (smokeReport) {
        lines.push("", "Smoke baseline:", smokeReport);
      } else {
        lines.push("", `Smoke baseline: all ${smokeEntries.length} declared entries matched expected exit codes`);
      }
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// chain-show
// ---------------------------------------------------------------------------

/**
 * Find the newest chain directory (by mtime) under a chains directory.
 * Exported for testing.
 *
 * @param {string} chainsDir - Absolute path to the chains directory.
 * @returns {string|null} The name of the newest chain dir, or null if none found.
 */
export function newestChainDir(chainsDir) {
  if (!fs.existsSync(chainsDir)) return null;
  const entries = fs.readdirSync(chainsDir)
    .map((name) => {
      try {
        const fullPath = path.join(chainsDir, name);
        const stat = fs.statSync(fullPath);
        return { name, mtime: stat.mtimeMs, isDir: stat.isDirectory() };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((e) => e.isDir && e.name.startsWith("chain-"))
    .sort((a, b) => {
      const mtimeDiff = b.mtime - a.mtime;
      if (mtimeDiff !== 0) return mtimeDiff;
      // Tiebreaker: lexicographic by name for deterministic selection
      return a.name.localeCompare(b.name);
    });
  return entries.length > 0 ? entries[0].name : null;
}

export function cmdChainShow(cwd, { text }) {
  const stateDir = stateDirFor(cwd);
  const chainsDir = path.join(stateDir, "chains");

  if (!fs.existsSync(chainsDir)) {
    throw new Error("no chains directory found for this workspace");
  }

  let chainId = text.trim() || null;
  if (!chainId) {
    chainId = newestChainDir(chainsDir);
    if (!chainId) {
      throw new Error("no chains found for this workspace");
    }
  }

  const chainDir = path.join(chainsDir, chainId);
  if (!fs.existsSync(chainDir)) {
    throw new Error(`chain not found: ${chainId}`);
  }

  // chain.json is written at the end of a round, so a chain stopped during its
  // first round never has one — and stopping early is the common case for the
  // stop lever.  The control record carries enough (id, container, status) to
  // render a digest, so fall back to it rather than refusing to report.
  const chainControlEarly = readChainControl(chainDir);
  const chainJson = readJson(path.join(chainDir, "chain.json"))
    || (chainControlEarly
      ? { chainId, container: chainControlEarly.container, brief: null, orchestrator: null }
      : null);
  if (!chainJson) {
    throw new Error(`chain.json not found or invalid for ${chainId}`);
  }

  // Read all round-*.json files sorted by round number (numeric sort)
  const roundFiles = fs.readdirSync(chainDir)
    .filter((f) => f.startsWith("round-") && f.endsWith(".json"))
    .sort((a, b) => {
      const na = Number(a.match(/round-(\d+)\.json$/)?.[1]) ?? 0;
      const nb = Number(b.match(/round-(\d+)\.json$/)?.[1]) ?? 0;
      return na - nb;
    });

  const rounds = [];
  const unreadable = [];
  for (const f of roundFiles) {
    const data = readJson(path.join(chainDir, f));
    if (data) rounds.push(data);
    else unreadable.push(f);
  }

  // The control record carries the status (absent for old chains — treated as unknown)
  let unfilled = 0;
  try {
    unfilled = countUnfilledReviewRecords(stateRoot());
  } catch {
    unfilled = 0;
  }
  return renderChainShow(chainJson, rounds, unreadable, chainControlEarly, { unfilledCount: unfilled });
}

// ---------------------------------------------------------------------------
// chain-wait
// ---------------------------------------------------------------------------

/**
 * Read a flag holding a duration in seconds and return it in milliseconds.
 * A malformed value is refused rather than silently falling back to the
 * default: a wait that silently used a 2h bound because "--appear-timeout 1O"
 * had a letter in it is the same unread-error failure chain-wait exists to end.
 */
function waitDurationFlag(flags, name, fallbackMs) {
  const raw = flags[name];
  if (raw === undefined) return fallbackMs;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`--${name} expects a positive number of seconds, got: ${raw}`);
  }
  return seconds * 1000;
}

/**
 * chain-wait — block until a chain reaches a terminal state, print a one-line
 * digest, exit 0.  Every way the WAIT failed (unknown id, nothing appeared,
 * stall) throws, and main()'s catch turns that into a non-zero exit: the
 * caller scripts on the exit code, so the two must never be confused.
 *
 * Runs no LLM, spawns no serve, holds nothing that needs cleanup — safe to
 * SIGTERM at any moment, which is what makes it trackable by the caller's
 * harness where the detached chain itself is not.
 */
export function cmdChainWait(cwd, { flags, text }) {
  const stateDir = stateDirFor(cwd);
  const chainsDir = path.join(stateDir, "chains");
  const chainId = text.trim() || null;
  const next = !!flags.next;

  if (next && chainId) {
    throw new Error(`chain-wait --next waits for the NEXT chain to appear and takes no chain id (got ${chainId})`);
  }
  if (!next && !chainId) {
    throw new Error("chain-wait requires a chain id. Usage: chain-wait <chainId> | chain-wait --next [--since <ISO>]");
  }
  if (flags.since && !next) {
    throw new Error("--since is only meaningful with chain-wait --next (it bounds which chain counts as new)");
  }

  let since = null;
  if (next && flags.since) {
    since = Date.parse(flags.since);
    if (Number.isNaN(since)) throw new Error(`--since expects an ISO timestamp, got: ${flags.since}`);
  }

  return waitForChain({
    chainsDir,
    chainId,
    next,
    since,
    pollIntervalMs: waitDurationFlag(flags, "poll-interval", DEFAULT_POLL_INTERVAL_MS),
    appearTimeoutMs: waitDurationFlag(flags, "appear-timeout", DEFAULT_APPEAR_TIMEOUT_MS),
    progressTimeoutMs: waitDurationFlag(flags, "progress-timeout", DEFAULT_PROGRESS_TIMEOUT_MS),
  }).then((result) => result.digest);
}

// ---------------------------------------------------------------------------
// chain-detach
// ---------------------------------------------------------------------------

export function extractChainAndWaitArgs(flags, text) {
  const chainArgs = [];
  const waitFlags = {};

  const waitFlagNames = new Set([
    "next",
    "since",
    "poll-interval",
    "pollInterval",
    "appear-timeout",
    "appearTimeout",
    "progress-timeout",
    "progressTimeout",
  ]);

  for (const [key, value] of Object.entries(flags)) {
    const kebab = key.replace(/([A-Z])/g, "-$1").toLowerCase();
    if (waitFlagNames.has(key) || waitFlagNames.has(kebab)) {
      waitFlags[kebab] = value;
      continue;
    }
    if (value === true) {
      chainArgs.push(`--${kebab}`);
    } else if (typeof value === "string" || typeof value === "number") {
      chainArgs.push(`--${kebab}`, String(value));
    }
  }

  if (!flags["brief-file"] && typeof text === "string" && text.trim()) {
    chainArgs.push(text.trim());
  }

  return { chainArgs, waitFlags };
}

/**
 * chain-detach — launch a chain in a detached background process and print
 * the exact chain-wait command line to run for tracking.
 *
 * Performs pre-flight checks up front so invalid dispatches exit non-zero
 * without launching a child process or printing a wait command line.
 */
export async function cmdChainDetach(cwd, { flags, text }, opts = {}) {
  const startedAtIso = (opts.now ? new Date(opts.now) : new Date()).toISOString();

  // ---- brief-file resolution ----
  const briefText = readBriefFile(flags, text);
  if (!briefText) {
    throw new Error("chain-detach requires a brief description (inline or via --brief-file)");
  }

  // ---- runtime publish guard ----
  const publishWarning = publishWarningForBrief(briefText);
  if (publishWarning) {
    process.stdout.write(publishWarning + "\n");
  }

  // ---- lossy-smoke refusal ----
  const smokeRejection = smokeViolationReport(briefText);
  if (smokeRejection) throw new Error(smokeRejection);

  // ---- setup ----
  const stateRootDir = opts.stateRoot || stateRoot();
  const stateDir = stateDirFor(cwd);
  const config = loadConfig(stateRootDir);

  const initialSessionOwner = flags.session
    ? latestJob(stateDir, (j) => j.sessionID === flags.session)
    : null;
  const sessionProvenance = initialSessionOwner
    ? (initialSessionOwner.backend ?? "opencode")
    : null;

  const implementDispatch = resolveDispatchBackend({ flags, phase: "implement", config });
  if (config?.models?.phases?.rework) {
    resolveDispatchBackend({ flags, phase: "rework", config });
  }
  resolveDispatchBackend({ flags, phase: "review", config });

  // ---- session-provenance refusal ----
  const sessionRejection = sessionProvenanceRefusal({
    session: flags.session,
    provenance: sessionProvenance,
    implementBackend: implementDispatch.backend,
  });
  if (sessionRejection) throw new Error(sessionRejection);

  // ---- container check ----
  const container = flags.container;
  if (!container) throw new Error("chain requires --container <cid>");

  // ---- dispatch-time brief lint ----
  const lintRejection = briefLintReport({ brief: briefText, container, chain: true });
  if (lintRejection) throw new Error(lintRejection);

  // Pre-flight checks passed! Create log file in stateDir
  fs.mkdirSync(stateDir, { recursive: true });
  const logFile = path.join(stateDir, `chain-detach-${Date.now()}.log`);
  const logFd = fs.openSync(logFile, "a");

  const { chainArgs, waitFlags } = extractChainAndWaitArgs(flags, text);

  const standin = opts.standin || process.env.KUSABI_TEST_CHAIN_STANDIN;
  const spawnCmd = process.execPath;
  const spawnArgs = standin
    ? [standin, ...chainArgs]
    : [COMPANION_SCRIPT, "chain", ...chainArgs];

  const child = (opts.spawn || spawn)(spawnCmd, spawnArgs, {
    cwd,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
  });

  if (child.unref) child.unref();
  fs.closeSync(logFd);

  const since = flags.since || startedAtIso;
  let waitCmd = `kusabi-companion chain-wait --next --since ${since}`;
  if (waitFlags["appear-timeout"]) {
    waitCmd += ` --appear-timeout ${waitFlags["appear-timeout"]}`;
  }
  if (waitFlags["poll-interval"]) {
    waitCmd += ` --poll-interval ${waitFlags["poll-interval"]}`;
  }
  if (waitFlags["progress-timeout"]) {
    waitCmd += ` --progress-timeout ${waitFlags["progress-timeout"]}`;
  }

  const lines = [
    `Detached chain launched (pid ${child.pid ?? "unknown"}).`,
    `Log: ${logFile}`,
    "",
    "To wait for completion, run:",
    `  ${waitCmd}`,
  ];

  return lines.join("\n");
}
