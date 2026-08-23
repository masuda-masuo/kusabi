#!/usr/bin/env node
// kusabi-companion: bridge between Claude Code slash commands and an
// on-demand `opencode serve` instance.
//
// Context firewall: every opencode event is persisted under the state dir;
// stdout only ever carries the rendered final result, so the calling Claude
// session never sees intermediate narration, tool logs, or raw events.


import { parseArgs, parseModel, resolveModel, reviewDenyTools, WRITE_TOOL_NAMES, validateChainEntries, splitRouteBackend, resolveChainBackend, stripBackendPrefixChain, resolveModelBackend, chainNamesBackend, backendSupportsResume } from "./cli.mjs";
import { renderReview, renderChainShow, renderJobLine, renderHeader, extractJson } from "./render.mjs";
import { hasSectionHeading, parseDeliverables, parseFrozenTests, parseSmoke, parseOrchestratorSignature, zeroEntrySections } from "./brief-parsing.mjs";
import { cmdInstallCli, diagnoseCompanionShim, formatShimSetupLine } from "./install-cli.mjs";
// Exit path only (kusabi #243); its own module since kusabi #277 so that the
// test children exercising it do not import everything above.
import { flushAndExit } from "./flush-and-exit.mjs";
// The chain driver (kusabi #264 PR 2/2).  chain-driver.mjs imports helpers
// back from this module; see its header for why that cycle is safe and why
// nothing moved is re-exported from here.
import { cmdChain, cmdChainResume, smokeBaselineReport, publishWarningForBrief, smokeViolationReport, sessionProvenanceRefusal } from "./chain-driver.mjs";
import { cursorUsageDir, resolveLatestCursorSession } from "./cursor-statusline-sink.mjs";
import { parseReviewJsonl } from "./review-jsonl.mjs";
import { countUnfilledReviewRecords } from "./review-record-scan.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { stateRoot, stateDirFor, readJson } from "./state-paths.mjs";
import { collectChainRecords, computeStats, renderChainStats, renderComparison } from "./chain-stats.mjs";
import { startDashboard } from "./dashboard.mjs";
import {
  readChainControl,
  requestChainStop,
  writeChainControl,
  effectiveStatus,
  chainIdForJob,
  collectChainStatuses,
} from "./chain-control.mjs";
import {
  waitForChain,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_APPEAR_TIMEOUT_MS,
  DEFAULT_PROGRESS_TIMEOUT_MS,
} from "./chain-wait.mjs";
import { jobDir, saveJob, loadJob, listJobs, latestJob } from "./job-store.mjs";
import { opencodeBin, serverHealthy, ensureServer, reapIdleServes, reapOrphanedServes, runningRecordIsStale, isOurServe, api } from "./serve-lifecycle.mjs";
import { runPrompt, dispatchWithFallback } from "./prompt-execution.mjs";
import { claudeDispatch, resolveClaudeModel, validateClaudeModel, validateClaudeChain, translateDenyTools, clampModelDispatch, stopRecordedProcess, CLAUDE_BACKEND } from "./claude-dispatch.mjs";
import { agyDispatch, resolveAgyModel, validateAgyModel, validateAgyChain, AGY_BACKEND } from "./agy-dispatch.mjs";
import { cursorDispatch, resolveCursorModel, validateCursorModel, validateCursorChain, CURSOR_BACKEND } from "./cursor-dispatch.mjs";
import { openMetricsDb, openMetricsDbReadOnly } from "./metrics-db.mjs";
import { ingestTranscriptDirectory } from "./transcript-ingest.mjs";
import { ingestCursorUsageDirectory } from "./cursor-usage-ingest.mjs";
import { ingestChainDirectory, ingestJobDirectory } from "./chain-ingest.mjs";
import { computeReport, renderReportText, renderReportJson, missingStoreReport, renderMissingText } from "./metrics-report.mjs";

// Chain round-phases module — the round loop itself moved to chain-driver.mjs
// (kusabi #264 PR 2/2), so all that is left here is the container review input
// builder `task --phase review` uses.
// Probe functions are imported separately below with local bindings so
// cmdTask can call them directly, and re-exported for test compatibility.
import {
  collectContainerReviewInput,
  // The chain's container header, shared with `task --container` (kusabi #289).
  withContainerWorkspace,
  captureVerifyBaseline,
} from "./chain-phases.mjs";

// Import the probe functions locally so cmdTask can call them directly.
// `export { X } from "..."` creates no local binding, so without a local
// import the names are not in the module scope — cmdTask's calls to
// runHeadCleanProbe / runVerifyProbe / runDeliverablesProbe / runSmokeProbe
// would throw ReferenceError.
import {
  runSmokeProbe,
  runHeadCleanProbe,
  runVerifyProbe,
  runDeliverablesProbe,
  runFrozenProbe,
  runCollectedProbe,
} from "./chain-phases.mjs";

// Re-export so external consumers (tests) that import these functions
// from kusabi-companion.mjs continue to resolve correctly.
export {
  runSmokeProbe,
  runHeadCleanProbe,
  runVerifyProbe,
  runDeliverablesProbe,
  runFrozenProbe,
  runCollectedProbe,
};

/**
 * INTERNAL — exported for regression testing only.
 * Verifies that the probe functions are locally bound in this module,
 * so cmdTask (which is not exported) can call them without ReferenceError.
 * Would have thrown before the fix that added local imports above.
 */
export function __testProbeBindings() {
  return {
    runSmokeProbe: typeof runSmokeProbe,
    runHeadCleanProbe: typeof runHeadCleanProbe,
    runVerifyProbe: typeof runVerifyProbe,
    runDeliverablesProbe: typeof runDeliverablesProbe,
    runFrozenProbe: typeof runFrozenProbe,
    runCollectedProbe: typeof runCollectedProbe,
  };
}

// The environment variable Claude Code exports into every subprocess it
// spawns (harness 2.1.226).  When the companion is dispatched from an
// orchestrator session, this IS that session's identity — authoritative in a
// way a hand-typed signature field can never be.
export const ORCH_SESSION_ENV = "CLAUDE_CODE_SESSION_ID";

/**
 * The orchestrator record to persist on a job / chain: the signature line
 * parsed out of the brief, with `session` taken from the environment
 * whenever the environment has one (kusabi #227), then from a Cursor
 * statusline usage file whose last line matches the current cwd (kusabi
 * #237), and only then from the hand-typed signature session.
 *
 * Why the env wins: metrics-report joins `chain.orch_session` as a PREFIX of
 * transcript session ids (kusabi #135).  A hand-typed label ("wsl-claude",
 * "cc-20260811-215", "(current)") can never join, which is what left 27 of
 * 122 chains orphaned.  Cursor CLI does not set CLAUDE_CODE_SESSION_ID; the
 * statusline sink writes `$HOME/.kusabi/cursor-usage/<session_id>.jsonl`
 * instead, and that is the next-best join key.  The signature line stays the
 * source of model/date, and the last fallback for session.
 *
 * Resolution happens HERE, at record-write time, not inside
 * parseOrchestratorSignature — that stays a pure text parser.  Same shape as
 * the #195 backend resolution: the writer decides, the readers stay verbatim.
 * chain-ingest.mjs / metrics-report.mjs keep reading `model` / `session` /
 * `date` exactly as before.
 *
 * `sessionSource: "env"` marks a session that came from the environment, so
 * a reader can tell the provenances apart.  `sessionSource: "cursor-statusline"`
 * marks the Cursor usage-dir branch.  Neither marker is written on the
 * signature path: its absence means signature (or no session at all), which
 * is exactly what every record written before #227 means.  Env set, or env
 * unset with no eligible cursor session, stays byte-identical to today.
 *
 * Cursor lookup is cwd-exact and freshness-bounded (see
 * CURSOR_SESSION_MAX_AGE_MS).  dir / cwd / now / home / maxAgeMs are
 * injectable so tests never touch the real HOME; when a fake `env` object is
 * passed without KUSABI_CURSOR_USAGE_DIR and without opts.dir/home, the
 * cursor branch is skipped (existing two-arg tests stay hermetic).
 *
 * @param {string|null|undefined} briefText
 * @param {Record<string, string|undefined>} [env]  Defaults to process.env.
 * @param {{dir?: string, cwd?: string, now?: number|Date|string,
 *          home?: string, maxAgeMs?: number}} [opts]
 * @returns {{model: string|null, session: string|null, date: string|null,
 *            sessionSource?: "env"|"cursor-statusline"} | null}
 */
export function resolveOrchestratorRecord(briefText, env = process.env, opts = {}) {
  const signature = parseOrchestratorSignature(briefText);
  const raw = env ? env[ORCH_SESSION_ENV] : undefined;
  const envSession = typeof raw === "string" ? raw.trim() : "";
  if (envSession !== "") {
    return {
      model: signature?.model ?? null,
      session: envSession,
      date: signature?.date ?? null,
      sessionSource: "env",
    };
  }

  const cursorSession = resolveCursorSessionForRecord(env, opts);
  if (cursorSession) {
    return {
      model: signature?.model ?? null,
      session: cursorSession,
      date: signature?.date ?? null,
      sessionSource: "cursor-statusline",
    };
  }

  // No usable env session and no eligible cursor session: today's behaviour,
  // byte for byte — the signature record, or null when the brief carries no
  // signature line at all.
  return signature;
}

function resolveCursorUsageDirForRecord(env, opts) {
  if (typeof opts.dir === "string" && opts.dir.length > 0) return opts.dir;
  if (env && typeof env.KUSABI_CURSOR_USAGE_DIR === "string" && env.KUSABI_CURSOR_USAGE_DIR.trim()) {
    return env.KUSABI_CURSOR_USAGE_DIR.trim();
  }
  if (typeof opts.home === "string" && opts.home.length > 0) {
    return cursorUsageDir(env, opts.home);
  }
  if (env === process.env) return cursorUsageDir(env);
  return null;
}

function resolveCursorSessionForRecord(env, opts) {
  const dir = resolveCursorUsageDirForRecord(env, opts);
  if (!dir) return null;
  const cwd = typeof opts.cwd === "string" && opts.cwd.length > 0 ? opts.cwd : process.cwd();
  try {
    return resolveLatestCursorSession({
      dir,
      cwd,
      now: opts.now,
      maxAgeMs: opts.maxAgeMs,
    });
  } catch {
    return null;
  }
}


const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPANION_SCRIPT = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(HERE, "..");
const DEFAULT_TASK_TIMEOUT_S = 3600;
const DEFAULT_REVIEW_TIMEOUT_S = 1800;
const DEFAULT_WATCHDOG_S = 900; // must be > opencode mcp_timeout (600s) so inner timeout trips first
const REVIEW_DIFF_LIMIT = 200_000;


/**
 * Resume strategy for a chain round: now handled by
 * resolveRoundResume in chain-phases.mjs which is a pure synchronous
 * function.  checkpoint_restore was removed in issue #114 — the chain
 * never rolls the worktree back.  A new session starts fresh on the
 * existing worktree.
 */

export const PHASE_AGENTS = {
  draft: "kusabi-draft",
  investigate: "kusabi-investigate",
  implement: "kusabi-implement",
  review: "kusabi-review",
  respond: "kusabi-respond",
  salvage: "kusabi-salvage",
  gofer: "kusabi-gofer",
};

// ---------------------------------------------------------------------------

function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;
  }
}

// Standalone `review` reads the HOST worktree via git.  A git failure used to
// be swallowed into an error string that then went into the review prompt —
// the model answered garbage, and the crash the user actually saw was
// "findings.forEach is not a function" downstream (kusabi #153).  Fail loud
// and early instead: a review of a diff that could not be produced is not a
// review, and the error must name the real cause, not an internal TypeError.
const HOST_REVIEW_GIT_HINT =
  "review reads the host worktree; for a container review use: task --phase review --container <cid> --brief-file <path>";

function buildReviewInput(cwd, base) {
  let label;
  let diff;
  if (base) {
    label = `branch diff against ${base}`;
    diff = git(cwd, ["diff", `${base}...HEAD`]);
    if (diff === null) {
      throw new Error(`git diff ${base}...HEAD failed: ${base} is not a valid revision in this worktree (${HOST_REVIEW_GIT_HINT})`);
    }
  } else {
    label = "uncommitted working tree changes";
    const headDiff = git(cwd, ["diff", "HEAD"]);
    const cachedDiff = git(cwd, ["diff", "--cached"]);
    if (headDiff === null || cachedDiff === null) {
      throw new Error(`git diff failed in this worktree (${headDiff === null ? "git diff HEAD" : "git diff --cached"}) (${HOST_REVIEW_GIT_HINT})`);
    }
    diff = headDiff + cachedDiff;
  }
  const status = git(cwd, ["status", "--short", "--untracked-files=all"]);
  if (status === null) {
    throw new Error(`git status failed in this worktree (${HOST_REVIEW_GIT_HINT})`);
  }
  let truncated = "";
  if (diff.length > REVIEW_DIFF_LIMIT) {
    diff = diff.slice(0, REVIEW_DIFF_LIMIT);
    truncated = "\n(diff truncated; use the read tools to inspect files directly)";
  }
  const input = `## git status\n${status}\n## diff (${label})\n${diff}${truncated}`;
  return { label, input };
}

/**
 * The review input `task` inlines into its prompt, and the home of the
 * `--base` decision for that command (kusabi #204).
 *
 * `task --phase review --container <cid>` dispatches the same reviewer the
 * chain does -- but the task path built no review input at all, so the
 * reviewer rebuilt the change by hand (147 tool calls / 876s in one measured
 * job, twice running out of budget before it could review anything).  It now
 * sends the container-flavoured review input the chain sends, from the same
 * renderer.  That input names the base and tells the reviewer to fetch the
 * diff itself; it does not inline the diff body (kusabi #208).
 *
 * `--base` was accepted and silently dropped on this path.  It is now:
 *   - honoured on the container review, where it is the base commit the input
 *     names as the ref to diff against, and
 *   - rejected loudly anywhere else on `task`, following the precedent
 *     `review --container` set in kusabi #153: a flag that cannot take effect
 *     must say so rather than pretend.
 *
 * Everything else about `task` is untouched: another phase, or `review`
 * without `--container`, returns null and the prompt is what it was.
 *
 * @param {object}  opts
 * @param {string|null} opts.phase          The resolved --phase, or null.
 * @param {object}  opts.flags              Parsed CLI flags.
 * @param {Function} [opts.callTool=null]   RPC callTool (injectable; loaded
 *        from sunaba-rpc.mjs on demand so non-container tasks never touch it).
 * @returns {Promise<string|null>} The review input, or null when this dispatch
 *          is not a container review.
 * @throws {Error} on --base outside the container review, an unusable --base,
 *          or a --base that does not resolve inside the container.
 */
export async function buildTaskReviewInput({ phase, flags, callTool = null }) {
  const base = flags.base || null;
  const isContainerReview = phase === "review" && !!flags.container;
  if (base && !isContainerReview) {
    throw new Error(
      "task --base applies only to a container review; it has no effect here. " +
      "Use: task --phase review --container <cid> --base " + base,
    );
  }
  if (!isContainerReview) return null;
  const call = callTool ?? (await import("./sunaba-rpc.mjs")).callTool;
  return collectContainerReviewInput({ container: flags.container, callTool: call, base });
}

// ---------------------------------------------------------------------------
// config loading & model resolution
// ---------------------------------------------------------------------------


/**
 * Load the kusabi config file from the state root.
 * @param {string} stateRootDir - The state root directory (e.g. ~/.kusabi)
 * @returns {object|null} Config object or null if the file does not exist.
 * @throws {Error} If the file exists but is unparseable or has wrong shape.
 */
export function loadConfig(stateRootDir) {
  const configPath = path.join(stateRootDir, "config.json");
  if (!fs.existsSync(configPath)) return null;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new Error(`kusabi config file ${configPath} is not valid JSON: ${err.message}`);
  }

  // Validate shape: must be an object with an optional "models" key
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`kusabi config file ${configPath} must contain a JSON object`);
  }

  const models = parsed.models;
  if (models !== undefined) {
    if (typeof models !== "object" || Array.isArray(models) || models === null) {
      throw new Error(`kusabi config file ${configPath}: "models" must be a JSON object`);
    }
    if (models.chain !== undefined) {
      try {
        validateChainEntries(models.chain, "models.chain");
      } catch (err) {
        // Prefix the config path for user-facing error messages.
        throw new Error(`kusabi config file ${configPath}: ${err.message}`);
      }
    }
    if (models.phases !== undefined) {
      if (typeof models.phases !== "object" || Array.isArray(models.phases) || models.phases === null) {
        throw new Error(`kusabi config file ${configPath}: "models.phases" must be a JSON object`);
      }
      for (const [phaseName, chain] of Object.entries(models.phases)) {
        try {
          validateChainEntries(chain, `models.phases.${phaseName}`);
        } catch (err) {
          throw new Error(`kusabi config file ${configPath}: ${err.message}`);
        }
      }
    }
  }

  return parsed;
}


/**
 * Read the brief text from a file or return the inline text.
 * Throws a clear error when `--brief-file` and inline text are both provided,
 * or when the file cannot be read.
 *
 * @param {object} flags  - Parsed flags from parseArgs (may contain "brief-file")
 * @param {string} text   - Inline text (may be empty)
 * @returns {string} The resolved brief text.
 */
export function readBriefFile(flags, text) {
  if (flags["brief-file"]) {
    if (text) throw new Error("--brief-file and inline text are mutually exclusive");
    try {
      return fs.readFileSync(flags["brief-file"], "utf8").trim();
    } catch (err) {
      throw new Error(`--brief-file: cannot read ${flags["brief-file"]}: ${err.message}`);
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// dispatch-time brief lint (kusabi #289)
// ---------------------------------------------------------------------------

/**
 * The dispatch-time refusal text for a brief that is missing something the
 * companion MACHINE-READS, or null when nothing required is missing.
 *
 * This is a REFUSAL in the shape of the lossy-smoke check (kusabi #250,
 * `smokeViolationReport`): same stage (before any job directory or chain
 * state exists), same self-explaining tone, and every line names both the
 * offending part and the remedy — a denial without the remedy just pushes the
 * author onto a worse path.
 *
 * The gap it closes is that absence was SILENT.  The companion parses the
 * signature line, `## Deliverables` and `## Smoke`, but a brief missing one of
 * them dispatched anyway: the deliverables probe then discards a round whose
 * section never existed, an unsigned brief cannot be attributed back to who
 * wrote it, and an implement worker with neither `--container` nor a
 * `## Workplace` section has nowhere to read its container id from (the
 * kusabi #289 incident).  All three are decidable from the brief text and the
 * flags, with no I/O, so the cheap moment to stop is before dispatch.
 *
 * Scope, deliberately narrow (kusabi #289 non-goals): nothing here changes
 * what a section MEANS or how it parses — only whether absence refuses.  The
 * deliverables and container-source rules apply to the implement phase and to
 * a chain being started (an implement chain); other phases keep exactly the
 * brief requirements they had, plus the signature line.  An ad-hoc `task`
 * with no `--phase` at all is not a phase dispatch and is left alone: it is
 * the `/kusabi:task <free text>` surface, not an orchestrator's brief.
 *
 * The container-source rule never fires for a chain: `chain` refuses without
 * `--container` on its own, ahead of this call, with a message that already
 * names the flag.
 *
 * kusabi #302 extends the SAME zero-entries rule to the other two sections a
 * probe machine-reads, `## Smoke` and `## Frozen Tests`: a heading that parses
 * to nothing declares a check that cannot run, and its probe (P4/P5) reads the
 * BRIEF, so the failure repeats every round and no worker edit can fix it.
 * Absence still refuses nothing there — both sections stay optional — and the
 * membership test comes from `zeroEntrySections`, i.e. the probes' own
 * parsers, so a brief this lint accepts cannot fail P3/P4/P5 on that rule.
 *
 * @param {object} opts
 * @param {string|null|undefined} opts.brief      The brief text.
 * @param {string|null} [opts.phase]              The resolved --phase, or null.
 * @param {string|null} [opts.container]          The --container value, or null.
 * @param {boolean} [opts.chain=false]            True when a chain is starting.
 * @returns {string|null}
 */
export function briefLintReport({ brief, phase = null, container = null, chain = false }) {
  const isImplement = chain || phase === "implement";
  const problems = [];

  if (isImplement && parseDeliverables(brief).length === 0) {
    problems.push(
      "  - `## Deliverables` is absent or parses to zero entries: the deliverables probe reads that " +
      "section, and a round that changes none of the files it names is discarded. Add the section " +
      "and list the files that must change, one per bullet, each path backtick-quoted."
    );
  }

  if (isImplement && !container && !hasSectionHeading(brief, "Workplace")) {
    problems.push(
      "  - no container source for the implement phase: neither `--container <cid>` on the command " +
      "line nor a `## Workplace` section in the brief. The worker cannot guess a container name " +
      "(kusabi #289: ten failed sandbox_attach guesses, 171s, zero edits). Pass `--container <cid>`, " +
      "or name the container in a `## Workplace` section of the brief."
    );
  }

  // ---- zero-entry `## Smoke` / `## Frozen Tests` (kusabi #302) ----
  // The same rule the `## Deliverables` line above applies to its own
  // section, applied to the other two sections a probe machine-reads.  A
  // heading followed by prose (`(none frozen by name — …)`) declares a check
  // that CANNOT run: P4/P5 fail on "heading present but no entries parsed"
  // every round, and the input they read is the brief, which no worker can
  // edit — the incident (chain-msvwhslx6e60, 2026-08-17) spent a whole
  // 4-round budget on reworks that were unwinnable by construction.  The
  // decision needs nothing but the brief text, so the cheap moment to stop is
  // before dispatch.
  //
  // Absence is NOT emptiness: both sections stay optional, and a brief with
  // no such heading is untouched here.  The entries come from
  // `zeroEntrySections`, which calls the probes' own parsers — so a brief this
  // lint accepts cannot fail P3/P4/P5 on the zero-entries rule.  Deliverables
  // is skipped: its own line above already refuses that case, and doubling it
  // would report one defect twice.
  if (chain || phase) {
    for (const section of zeroEntrySections(brief)) {
      if (section.heading === "Deliverables") continue;
      problems.push(
        "  - `" + section.label + "` is present but parses to zero entries: the " + section.probe +
        " probe reads that section from the BRIEF, so it would fail on syntax every round and no " +
        "worker edit could turn it green (kusabi #302). Add entries, or delete the heading entirely " +
        "— an empty section must omit its heading."
      );
    }
  }

  if ((chain || phase) && !parseOrchestratorSignature(brief)) {
    problems.push(
      "  - the orchestrator signature line is absent: add " +
      "`Orchestrator: <model-id> | session <id> | <date>` among the FIRST 5 lines of the brief. " +
      "Without it the job/chain record carries no orchestrator, and discard/rework rates cannot be " +
      "attributed back to who wrote the brief."
    );
  }

  if (problems.length === 0) return null;
  return [
    `brief rejected before dispatch: ${problems.length} required brief item` +
    `${problems.length === 1 ? " is" : "s are"} missing (kusabi #289). ` +
    "Nothing was started; fix the brief and re-run.",
    ...problems,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// dispatch backend selection (kusabi #184)
// ---------------------------------------------------------------------------

export const BACKENDS = ["opencode", "claude", "agy", "cursor"];

/**
 * Resolve the dispatch backend from the `--backend` flag.  Resolved ONCE at
 * command start (`task` / `chain`); every job and chain record written by
 * the command carries the result as its `backend` field.  Old records
 * without the field are treated as `"opencode"` by readers.
 *
 * @param {object} flags — parsed flags (may carry `backend`).
 * @returns {"opencode"|"claude"|"agy"|"cursor"}
 * @throws {Error} For any unknown backend value.
 */
export function resolveBackend(flags) {
  const backend = flags.backend || "opencode";
  if (!BACKENDS.includes(backend)) {
    throw new Error(`unknown backend: ${backend}. Use --backend ${BACKENDS.join("|")}`);
  }
  return backend;
}

/**
 * The canonical dispatch function of a backend — the one a phase gets when
 * nothing more specific was injected.
 *
 * A TABLE, not a chain of `=== "claude"` comparisons: adding the agy backend
 * (kusabi #199) is one row, and every seam that needs "the dispatch of THIS
 * backend" reads the same row.  opencode is the fallback because a record
 * without a `backend` field predates the split and IS opencode (the reader
 * contract every other surface applies).
 *
 * @param {string|null|undefined} backend
 * @returns {Function}
 */
export function backendDispatch(backend) {
  if (backend === CLAUDE_BACKEND) return claudeDispatch;
  if (backend === AGY_BACKEND) return agyDispatch;
  if (backend === CURSOR_BACKEND) return cursorDispatch;
  return dispatchWithFallback;
}

/**
 * True when the backend pins ONE model per phase instead of walking a tier
 * ladder — the v1 shape of both non-opencode backends.
 *
 * Two things follow from it, and both read this rather than naming a
 * backend: the chain commands wrap such a dispatch in `clampModelDispatch`
 * so later rounds reuse the command-start model, and `effectiveTierCount`
 * reports a ladder of at most one tier so printed/recorded numbers describe
 * the ladder that is actually climbed.
 *
 * @param {string|null|undefined} backend
 * @returns {boolean}
 */
export function backendPinsModel(backend) {
  return backend === CLAUDE_BACKEND || backend === AGY_BACKEND || backend === CURSOR_BACKEND;
}

/**
 * The dispatch a phase runs on, clamped to its command-start model when the
 * backend pins one.  The two facts above, applied together — every chain
 * seam that used to spell out `backend === "claude" ? clampModelDispatch(…)`
 * calls this instead.
 *
 * @param {string} backend
 * @param {Function} dispatch — the backend's dispatch (canonical or injected).
 * @param {string|object|null} model
 * @returns {Function}
 */
export function phaseDispatchFor(backend, dispatch, model) {
  return backendPinsModel(backend) ? clampModelDispatch(dispatch, model ?? null) : dispatch;
}

/**
 * Reject an explicitly named session that belongs to a DIFFERENT backend
 * than the one it would run on — the SYMMETRIC cross-backend guard
 * (kusabi #199).
 *
 * Session ids are backend-specific, and the failure mode is quiet: a CLI
 * handed a session id it does not know does not error, it starts a
 * fresh-looking run the operator believes continues their work.  Two
 * independent signals decide, in this order:
 *
 *   1. SHAPE — `ses_*` is unmistakably an opencode id, and needs no record
 *      to prove it.  This is the guard `claudeDispatch` has carried since
 *      kusabi #184; stating it here makes it symmetric across every
 *      non-opencode backend rather than claude's alone.
 *   2. PROVENANCE — a claude session id and an agy conversation id are BOTH
 *      bare UUIDs, so shape can never separate them.  The job store can: the
 *      record that reported this session names the backend that made it.
 *      This check is now LOAD-BEARING for the agy backend (kusabi #316):
 *      agyDispatch resumes a session only when the caller proves the store
 *      attributes it to agy, and the proof is this record.
 *
 * A session with no owning record and no telling shape is left alone here:
 * the operator may legitimately be resuming something kusabi never
 * dispatched.  (The agy DISPATCH draws a stricter line — see
 * assertNoAgySession in agy-dispatch.mjs, which fails closed on exactly
 * that unknown-provenance shape rather than pass it to `--conversation`.)
 *
 * @param {object} opts
 * @param {string} opts.session
 * @param {string} opts.backend — the backend this dispatch would run on.
 * @param {object|null|undefined} [opts.owner] — the job record that reported
 *        this session, if any.
 * @throws {Error} Naming BOTH backends.
 */
export function assertSessionBackendCompatible({ session, backend, owner }) {
  const shapeBackend = session.startsWith("ses_") ? "opencode" : null;
  if (shapeBackend && shapeBackend !== backend) {
    // Deliberately the SAME wording claudeDispatch's own ses_* guard uses
    // (kusabi #184), generalised over the target backend: this check runs
    // earlier than that one, so an operator who has seen the message once
    // must not meet a second, differently-phrased version of it.
    throw new Error(
      `opencode session ${session} cannot be resumed on the ${backend} backend — ` +
      `ses_* session ids belong to opencode; run the command without --backend ${backend} ` +
      `(or pass a ${backend} session id)`
    );
  }
  // Records without a `backend` field predate the split and are opencode.
  const ownerBackend = owner ? (owner.backend ?? "opencode") : null;
  if (!ownerBackend || ownerBackend === backend) return;
  throw new Error(
    `session ${session} belongs to the ${ownerBackend} backend and cannot be resumed on the ${backend} backend — ` +
    `session ids are backend-specific, and the ${backend} CLI would silently start a fresh run instead of ` +
    `continuing it. Run this on the ${ownerBackend} backend, or drop the session to start fresh.`
  );
}

/**
 * Resolve `{ dispatch, backend, model, explicitModel, chain }` for ONE phase
 * of a job-creating command.  The backend decides BOTH the dispatch function
 * (claudeDispatch / agyDispatch / dispatchWithFallback — the chain phases
 * stay backend-blind) and the model resolution syntax (claude models are
 * bare aliases / full ids, agy models are plain ids, opencode models are
 * provider/model).
 *
 * ---------------------------------------------------------------------
 * Resolution order (kusabi #210).  ONE decision picks the backend, and the
 * model is validated against THAT backend.  The defect class removed here
 * is a backend chosen by one input and a model validated against another:
 *
 *   0. a `--model` that NAMES a backend (`claude/opus`,
 *      `agy/gemini-3.6-flash-high`, `opencode-go/deepseek-v4-pro:max`)
 *      decides it — for the phases the flag pins, which is every phase it
 *      applies to and no wider;
 *   1. otherwise `--backend`, which forces EVERY phase onto that backend;
 *   2. otherwise the phase's chain entries (`models.phases.<phase>` →
 *      `models.chain` → the built-in default), via resolveChainBackend.
 *
 * A bare `--model <alias>` (no `/`) names no backend and therefore moves
 * nothing: the phase keeps its configured backend, exactly as before step 0
 * existed.  `--backend X` together with a `--model` naming backend Y is a
 * contradiction and throws, naming both — one is never silently dropped.
 *
 * Config file semantics are untouched: step 0 accepts the identifier syntax
 * the CONFIG already defines (splitRouteBackend), so the string that routes
 * a phase in `models.phases.<phase>` routes it on the CLI too.
 * ---------------------------------------------------------------------
 *
 * Invariant (kusabi #192): one phase's chain array is single-backend — an
 * array mixing two backends' entries fails LOUDLY here, at command start,
 * before createChainDir / before any job is dispatched.  The check is
 * skipped only when the chain is never consulted (the backend is already
 * decided AND `--model` pins every phase — kusabi #186's carve-out).
 *
 * @param {object} opts
 * @param {object} opts.flags
 * @param {string} [opts.phase]
 * @param {object|null} opts.config
 * @returns {{ dispatch: Function, backend: "opencode"|"claude"|"agy",
 *             model: object|string|undefined, explicitModel: string|null,
 *             chain: (string|string[])[] }}
 */
export function resolveDispatchBackend({ flags, phase, config }) {
  // Unknown-backend errors are about the flag, not the phase's config key:
  // resolve it before the per-phase resolution so it never gets key context
  // appended below.
  const backendFlag = resolveBackend(flags);
  try {
    return resolveDispatchBackendForPhase({ flags, phase, config, backendFlag });
  } catch (err) {
    // Per-phase resolution errors must name the config key that produced
    // them (kusabi #192 axis 2): a bad models.phases.rework array fails with
    // "… (models.phases.rework)" so the operator knows WHICH phase key to
    // fix — the same fail-loud principle as the mixed-backend / :variant
    // rejections.  Appended only when the phase actually has its own config
    // key (an error from models.chain must not be misattributed to a phase
    // that has no key), and only once.  Errors about the FLAGS carry
    // `flagError` and are never re-attributed to a config key: blaming
    // models.phases.<phase> for a value the operator typed on the command
    // line is the confusion kusabi #210 removes.
    const key = phase && config?.models?.phases?.[phase] ? `models.phases.${phase}` : null;
    if (key && err instanceof Error && !err.flagError && !err.message.includes(key)) {
      throw new Error(`${err.message} (${key})`);
    }
    throw err;
  }
}

/**
 * Build an error about the FLAGS rather than about a config key, tagged so
 * the wrapper above never appends "(models.phases.<phase>)" to it.
 *
 * @param {string} message
 * @returns {Error}
 */
function flagError(message) {
  const err = new Error(message);
  err.flagError = true;
  return err;
}

function resolveDispatchBackendForPhase({ flags, phase, config, backendFlag }) {
  // ---- step 0: the identifier ----
  // `--model` is resolved into { backend, model } BEFORE anything else is
  // consulted, with the config's own prefix grammar.
  const modelSpec = resolveModelBackend(flags.model);
  const namedBackend = modelSpec?.backend ?? null;
  const flagBackend = flags.backend ? backendFlag : null;
  if (flagBackend && namedBackend && namedBackend !== flagBackend) {
    throw flagError(
      `--backend ${flagBackend} conflicts with --model ${flags.model}, which names the ${namedBackend} backend — ` +
      `a --model that names a backend decides it for the phases it pins; drop --backend ${flagBackend}, ` +
      `or pass a --model that names ${flagBackend}`
    );
  }

  // ---- THE single decision point ----
  // Everything below — the dispatch function, the model spelling, and the
  // backend that model is validated against — derives from this one value.
  // The chain is consulted ONLY when neither the identifier nor the flag
  // decided (`??` short-circuits), which is what keeps kusabi #186's
  // carve-out intact: with the backend already decided and `--model` given,
  // an opencode-shaped models.chain must not block startup.
  const backend = namedBackend
    ?? flagBackend
    ?? resolveChainBackend(resolveModel({ flag: undefined, phase, config }).chain);

  if (backend === "claude") return resolveClaudePhaseDispatch({ flags, phase, config, modelSpec });
  if (backend === "agy") return resolveAgyPhaseDispatch({ flags, phase, config, modelSpec });
  if (backend === "cursor") return resolveCursorPhaseDispatch({ flags, phase, config, modelSpec });
  return resolveOpencodePhaseDispatch({ phase, config, modelSpec, namedBackend, flagBackend });
}

/**
 * The claude branch of the decision.  Reached identically whether the
 * identifier named claude, `--backend claude` forced it, or the phase's
 * chain entries are claude-native — the branch does not care which, which
 * is the point: one decision, one model syntax, one validation.
 */
function resolveClaudePhaseDispatch({ flags, phase, config, modelSpec }) {
  // The chain this phase reads: models.phases.<phase> → models.chain → the
  // claude-native default.  Entries written for the per-phase syntax may
  // carry the claude/ prefix; the backend is already decided, so the prefix
  // is redundant but must not leak into models — strip it before
  // validating / deriving.
  const resolved = resolveClaudeModel({ flag: undefined, phase, config });
  const chain = stripBackendPrefixChain(resolved.chain);

  if (!modelSpec) {
    // No --model: the model comes from the chain, so the WHOLE chain can be
    // consulted by a dispatch (a rework/strategize/resume round derives its
    // model from it) and must be valid here — before createChainDir /
    // before any job is dispatched — never mid-flight after round 1 (kusabi
    // #184 finding 1).  The single-backend invariant (kusabi #192) is
    // checked on the RAW chain: an opencode entry with no :variant would
    // otherwise pass validateClaudeChain and silently run as a claude model.
    resolveChainBackend(resolved.chain);
    validateClaudeChain(chain);
    const model = resolved.model == null ? undefined : splitRouteBackend(String(resolved.model)).route;
    if (model != null) validateClaudeModel(model);
    return { dispatch: claudeDispatch, backend: "claude", model, explicitModel: null, chain };
  }

  // With an explicit --model, clampModelDispatch pins EVERY phase (chain
  // start and chain-resume alike) to that model, so the config chain is
  // never consulted for a model and must not block startup (kusabi #186).
  // A :variant suffix cannot be expressed on the claude backend — reject it
  // up front (clear error, nonzero exit) instead of silently ignoring it at
  // dispatch time, and attribute the rejection to the identifier's own
  // backend rather than to a config key three levels away (kusabi #210).
  const model = modelSpec.model;
  try {
    validateClaudeModel(model);
  } catch (err) {
    throw flagError(
      `--model "${flags.model}" ${modelSpec.backend ? "names" : "resolves on"} the claude backend: ${err.message}`
    );
  }
  return { dispatch: claudeDispatch, backend: "claude", model, explicitModel: model, chain };
}

/**
 * The agy branch of the decision (kusabi #199) — the exact mirror of the
 * claude branch, one backend over: reached identically whether the
 * identifier named agy, `--backend agy` forced it, or the phase's chain
 * entries carry the `agy/` prefix, and the branch does not care which.
 *
 * The only differences from the claude branch are which validator runs and
 * which dispatch comes out, because that is the only thing that actually
 * differs: the precedence, the prefix stripping, the single-backend check,
 * the #186 carve-out and the identifier-owns-its-rejection rule (#210) are
 * all the same rules, applied to a third backend rather than restated for
 * it.
 */
function resolveAgyPhaseDispatch({ flags, phase, config, modelSpec }) {
  const resolved = resolveAgyModel({ flag: undefined, phase, config });
  const chain = stripBackendPrefixChain(resolved.chain);

  if (!modelSpec) {
    // No --model: the model comes from the chain, so the WHOLE chain can be
    // consulted by a dispatch and must be valid HERE — before createChainDir
    // / before any job is dispatched, never mid-flight after round 1.  The
    // single-backend invariant is checked on the RAW chain: an opencode
    // entry with no :variant would otherwise pass validateAgyChain and
    // silently run as an agy model id.
    resolveChainBackend(resolved.chain);
    validateAgyChain(chain);
    const model = resolved.model == null ? undefined : splitRouteBackend(String(resolved.model)).route;
    if (model != null) validateAgyModel(model);
    return { dispatch: agyDispatch, backend: "agy", model, explicitModel: null, chain };
  }

  // With an explicit --model the config chain is never consulted for a model
  // and must not block startup (kusabi #186).  A :variant suffix cannot be
  // expressed on the agy backend — reject it up front, attributed to the
  // identifier's own backend rather than to a config key three levels away.
  const model = modelSpec.model;
  try {
    validateAgyModel(model);
  } catch (err) {
    throw flagError(
      `--model "${flags.model}" ${modelSpec.backend ? "names" : "resolves on"} the agy backend: ${err.message}`
    );
  }
  return { dispatch: agyDispatch, backend: "agy", model, explicitModel: model, chain };
}

/**
 * The cursor branch of the decision (kusabi #374) — the same shape as the
 * agy branch, one backend over.  Reached whether the identifier named
 * cursor, `--backend cursor` forced it, or the phase's chain entries carry
 * the `cursor/` prefix.
 */
function resolveCursorPhaseDispatch({ flags, phase, config, modelSpec }) {
  const resolved = resolveCursorModel({ flag: undefined, phase, config });
  const chain = stripBackendPrefixChain(resolved.chain);

  if (!modelSpec) {
    resolveChainBackend(resolved.chain);
    validateCursorChain(chain);
    const model = resolved.model == null ? undefined : splitRouteBackend(String(resolved.model)).route;
    if (model != null) validateCursorModel(model);
    return { dispatch: cursorDispatch, backend: "cursor", model, explicitModel: null, chain };
  }

  const model = modelSpec.model;
  try {
    validateCursorModel(model);
  } catch (err) {
    throw flagError(
      `--model "${flags.model}" ${modelSpec.backend ? "names" : "resolves on"} the cursor backend: ${err.message}`
    );
  }
  return { dispatch: cursorDispatch, backend: "cursor", model, explicitModel: model, chain };
}

/**
 * The opencode branch of the decision: `--model` is provider/model syntax
 * (parseModel), chain entries pass through byte-identical.
 */
function resolveOpencodePhaseDispatch({ phase, config, modelSpec, namedBackend, flagBackend }) {
  // The phase's CONFIGURED chain, independent of --model: the single-backend
  // invariant (kusabi #192) runs on it on every opencode resolution, as it
  // always has, and the conflict below is stated over it.
  const configuredChain = resolveModel({ flag: undefined, phase, config }).chain;
  const configuredBackend = resolveChainBackend(configuredChain);
  // kusabi #192: an explicit `--backend opencode` forces EVERY phase onto
  // opencode, so a phase chain native to ANOTHER backend CONTRADICTS it —
  // throw at command start, naming the flag, the phase and the offending
  // config key; never silently switch backends, never dispatch claude/… or
  // agy/… routes as opencode.  Stated over `!== "opencode"` rather than over
  // one backend's name, so a third backend (kusabi #199) is covered by the
  // rule instead of slipping past it.  It fires only when there is no
  // backend-naming `--model` to settle the question: when the identifier
  // names a backend the operator has stated their intent unambiguously (and
  // a disagreeing --backend already threw above), so firing anyway would
  // reproduce the incident kusabi #210 was filed for.
  if (flagBackend === "opencode" && namedBackend === null && configuredBackend !== "opencode") {
    const chainKey = (phase && config?.models?.phases?.[phase])
      ? `models.phases.${phase}`
      : (config?.models?.chain ? "models.chain" : "the built-in default chain");
    throw new Error(
      `--backend opencode conflicts with the ${configuredBackend}-native chain of the ${phase ?? "task"} phase ` +
      `(${chainKey}: ${JSON.stringify(configuredChain)}) — an explicit --backend forces every phase ` +
      `onto that backend; remove --backend opencode or point ${chainKey} at opencode entries`
    );
  }

  const resolved = resolveModel({ flag: modelSpec?.model, phase, config });
  let chain = resolved.chain;
  if (namedBackend === "opencode"
    && (chainNamesBackend(chain, "claude") || chainNamesBackend(chain, "agy") || chainNamesBackend(chain, "cursor"))) {
    // Only reachable when the identifier chose opencode over a chain native
    // to another backend: those entries are that backend's model ids and
    // must never be walked as opencode routes by the fallback ladder.
    // `--model` pins this phase anyway, so its ladder is exactly the pinned
    // route.
    chain = [modelSpec.model];
  }
  return {
    dispatch: dispatchWithFallback,
    backend: "opencode",
    model: resolved.model,
    explicitModel: modelSpec ? modelSpec.model : null,
    chain,
  };
}

/**
 * Resolve the session for `--resume-last`: the sessionID of the most recent
 * task job of the SAME backend as the current dispatch.  Every backend
 * shares ONE job store, and a session id is backend-specific — a claude
 * UUID cannot be resumed on opencode, and an opencode `ses_*` id is
 * rejected by both other backends' cross-backend guards.  Without this
 * filter, `--resume-last` on a claude dispatch could silently pick an
 * opencode session (and vice versa).  Records without a `backend` field
 * predate the backend split and count as "opencode".  This is SELECTION
 * only — whether a given session may be resumed on the chosen backend is
 * decided inside the dispatch (claudeDispatch's ses_* guard,
 * agyDispatch's assertNoAgySession).  The selection doubles as the agy
 * dispatch's provenance proof: the selected record's backend IS the
 * dispatch backend, so the session id the caller passes down with
 * `sessionProvenance: "agy"` is exactly what assertNoAgySession requires.
 *
 * @param {string} stateDir
 * @param {object} opts
 * @param {string|null|undefined} [opts.phase]
 * @param {"opencode"|"claude"|"agy"} opts.backend
 * @returns {string|null} The session id, or null when no same-backend job.
 */
export function resolveResumeLastSession(stateDir, { phase, backend }) {
  const prev = latestJob(stateDir, (j) =>
    j.kind === "task"
    && (!phase || j.phase === phase)
    && (j.backend ?? "opencode") === backend
  );
  return prev?.sessionID ?? null;
}

// ---------------------------------------------------------------------------
// subcommands
// ---------------------------------------------------------------------------

async function cmdSetup(cwd) {
  const shimLine = formatShimSetupLine(diagnoseCompanionShim({ selfPath: COMPANION_SCRIPT }));
  let version;
  try {
    version = execFileSync(opencodeBin(), ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return `opencode CLI not found. Install it first: https://opencode.ai (or set OPENCODE_BIN).\n${shimLine}`;
  }
  const server = await ensureServer(cwd);
  return [
    `opencode ${version} — OK`,
    `server: http://127.0.0.1:${server.port} (pid ${server.pid}, password-protected)`,
    `state dir: ${server.stateDir}`,
    cmdInstallAgents(),
    shimLine,
  ].join("\n");
}

async function cmdTask(cwd, { flags, text }) {
  // ---- brief-file resolution ----
  text = readBriefFile(flags, text);
  if (!text) throw new Error("task requires a task description (inline or via --brief-file)");
  // Signature line for model/date; CLAUDE_CODE_SESSION_ID for the session
  // when this companion runs inside an orchestrator session (kusabi #227).
  const orchestrator = resolveOrchestratorRecord(text);
  let agent = flags.agent;
  let phase = null;
  if (flags.phase) {
    phase = flags.phase;
    if (!PHASE_AGENTS[phase]) {
      throw new Error(`unknown phase: ${phase}. Use draft|investigate|implement|review|respond|salvage|gofer`);
    }
    if (flags.agent) {
      throw new Error("--phase and --agent are mutually exclusive");
    }
    agent = PHASE_AGENTS[phase];
  }
  const stateDir = stateDirFor(cwd);
  const config = loadConfig(stateRoot());
  // Backend resolved ONCE at command start: it picks the dispatch function
  // AND the model syntax (claude: bare alias / full id; opencode:
  // provider/model).
  // `explicitModel` is the --model value in the SPELLING of the backend the
  // same resolution chose (kusabi #210): `claude/opus` reaches a claude
  // dispatch as `opus`, an opencode route reaches the ladder verbatim.  The
  // raw flag string must never be handed to a dispatch — a claude CLI given
  // `--model claude/opus` would take the prefix for part of the model id.
  const { dispatch, backend, chain: modelChain, explicitModel } = resolveDispatchBackend({ flags, phase, config });

  // An explicitly named `--session` is checked against the backend it would
  // run on BEFORE anything else, so the error the operator gets names both
  // backends rather than the weaker "this backend does not resume".
  if (flags.session) {
    assertSessionBackendCompatible({
      session: flags.session,
      backend,
      owner: latestJob(stateDir, (j) => j.sessionID === flags.session),
    });
  }

  // A backend that cannot continue a session must SAY so when one is asked
  // for; every current backend CAN (kusabi #316 lifted agy's v1
  // fresh-dispatch-only limit), so this guard has no firing row today.  It
  // stays as the table-driven backstop for a backend added later without a
  // resume row: quietly starting a blank run for an operator who typed
  // `--session` / `--resume-last` would hand them a job that looks like a
  // continuation and is not.  agy's extra gate is PROVENANCE, applied here
  // where the job store is in hand (assertSessionBackendCompatible above,
  // and the sessionProvenance signal passed to the dispatch below): a bare
  // UUID is ambiguous between agy and claude, so the agy dispatch resumes
  // only what the store proves an agy job recorded.
  if ((flags.session || flags.resumeLast) && !backendSupportsResume(backend)) {
    const asked = flags.session ? `--session ${flags.session}` : "--resume-last";
    throw new Error(
      `${asked} is not supported on the ${backend} backend — it cannot continue a session: ` +
      `drop ${flags.session ? "--session" : "--resume-last"}, or run the phase on a backend that resumes.`
    );
  }

  let session = flags.session;
  if (!session && flags.resumeLast) {
    // --resume-last selects the previous job of the SAME backend as this
    // dispatch: every backend shares one job store, and a session id is
    // backend-specific (a claude UUID cannot be resumed on opencode; an
    // opencode ses_* id is rejected by the claude backend's guard).  Records
    // without the backend field predate the backend split -> opencode.
    session = resolveResumeLastSession(stateDir, { phase, backend });
    if (!session) {
      throw new Error(phase
        ? `--resume-last: no previous ${phase} ${backend} session found for this directory`
        : `--resume-last: no previous ${backend} task session found for this directory`);
    }
  }
  // The dispatch-level agy backstop resumes a session only on POSITIVE
  // provenance (assertNoAgySession in agy-dispatch.mjs): an agy
  // conversation_id and a claude session id are both bare UUIDs, so the
  // distinguishing evidence is the job store, which is in hand HERE, not in
  // the dispatch.  The owner record of the session names its backend
  // (records without the backend field predate the split -> opencode); no
  // owner means the id's provenance is unknown, and the agy dispatch fails
  // closed rather than passing an unproven id to `--conversation`.  claude
  // and opencode dispatches ignore the signal.
  let sessionProvenance = null;
  if (session) {
    const owner = latestJob(stateDir, (j) => j.sessionID === session);
    sessionProvenance = owner ? (owner.backend ?? "opencode") : null;
  }
  if (session && phase) {
    const owner = latestJob(stateDir, (j) => j.sessionID === session);
    if (owner && owner.phase && owner.phase !== phase) {
      throw new Error(`cross-phase session reuse is forbidden: session belongs to phase '${owner.phase}', requested '${phase}'`);
    }
  }
  let tools = flags.readOnly ? Object.fromEntries(WRITE_TOOL_NAMES.map((t) => [t, false])) : undefined;
  if (flags.deny) {
    tools = { ...(tools ?? {}) };
    for (const name of flags.deny.split(",").filter(Boolean)) tools[name] = false;
  }
  // The user-facing deny map speaks the opencode vocabulary (bash, edit,
  // write, ...); on the claude backend the tools that exist are the sunaba_*
  // ones, so --read-only / --deny must be translated or they would silently
  // no-op while the write tools stay granted (kusabi #184 finding 2).
  // Phase-level deny maps (implementDenyTools / reviewDenyTools) are passed
  // inside the chain phases and are intentionally NOT translated.
  if (tools && backend === "claude") tools = translateDenyTools(tools);
  // The agy CLI takes no allow/deny flags at all (kusabi #199), so there is
  // nothing to translate the map INTO: a restriction the operator typed
  // cannot be applied.  Reject it rather than run unrestricted while the
  // command line says otherwise — the same "never silently no-op a deny"
  // rule as the claude translation above, with the only honest answer this
  // backend can give.  Phase-level maps from the chain are a different case
  // (nobody typed them, and refusing them would break every chain that
  // routes a phase here): agyDispatch records those on the job as
  // `toolDeniesUnenforced` so the record cannot be mistaken for one where
  // they applied.
  if (tools && backend === AGY_BACKEND) {
    throw new Error(
      `${flags.readOnly ? "--read-only" : "--deny"} is not supported on the agy backend — ` +
      "the agy CLI has no per-job tool permission flags, so the restriction cannot be applied. " +
      "Run the task on the opencode or claude backend, which enforce it."
    );
  }
  if (tools && backend === CURSOR_BACKEND) {
    throw new Error(
      `${flags.readOnly ? "--read-only" : "--deny"} is not supported on the cursor backend — ` +
      "the Cursor CLI has no per-job tool permission flags, so the restriction cannot be applied. " +
      "Run the task on the opencode or claude backend, which enforce it."
    );
  }
  // ---- dispatch-time brief lint (kusabi #289) ----
  // A brief missing a machine-read section used to dispatch anyway and the
  // gap surfaced a round later.  Refuse here: the last point before anything
  // outside this process happens — no job record, no container read, no
  // dispatch.  It sits AFTER the command-start config/session guards above on
  // purpose: those describe a broken invocation rather than a broken brief,
  // and their messages are the more specific answer when both are wrong.
  const lintRejection = briefLintReport({ brief: text, phase, container: flags.container ?? null });
  if (lintRejection) throw new Error(lintRejection);

  // ---- record baseSha before dispatching the job if --container (for probe comparison) ----
  let taskBaseSha = null;
  if (flags.container) {
    try {
      const { callTool } = await import("./sunaba-rpc.mjs");
      const gitRev = await callTool("sandbox_exec", {
        container_id: flags.container,
        commands: ["git rev-parse HEAD"],
      });
      taskBaseSha = (gitRev?.output ?? "").trim() || null;
    } catch { /* probe will handle missing baseSha */ }
  }

  // ---- smoke baseline refusal (kusabi #292) ----
  // Same guard as the chain's first round, for the single-shot dispatch: the
  // P4 below runs AFTER the worker has changed things, so a `## Smoke` line
  // that could not pass on the checkout as handed over would be reported as
  // the worker's failure.  Measured here with the probe's own executor, and
  // refused before any job record exists.  A task with no declared smoke (or
  // no --container to run it in) executes nothing extra and dispatches
  // exactly as before.
  if (flags.container) {
    const { callTool } = await import("./sunaba-rpc.mjs");
    const baselineRejection = await smokeBaselineReport({
      brief: text,
      callTool,
      container: flags.container,
    });
    if (baselineRejection) throw new Error(baselineRejection);
  }

  // ---- review input (container review only) ----
  // Runs before dispatch: a container review must carry the diff into the
  // prompt, and a --base that cannot be honoured must abort before a job is
  // created rather than after (kusabi #204).
  const taskReviewInput = await buildTaskReviewInput({ phase, flags });

  const guardrails = fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", "task-guardrails.md"), "utf8").trim();
  let taskPromptText = taskReviewInput
    ? `${guardrails}\n\n<task>\n${text}\n</task>\n\n${taskReviewInput}`
    : `${guardrails}\n\n<task>\n${text}\n</task>`;
  // kusabi #289: `--container` was recorded on the job and used for the
  // probes, but never DELIVERED to the worker — the chain injects it into the
  // implement prompt, the task path did not.  Same helper, so the wording
  // cannot drift and a brief that also names its workplace is a harmless
  // duplicate; a no-op when `--container` was not given.
  taskPromptText = withContainerWorkspace(taskPromptText, flags.container);
  const { job, resultText } = await dispatch({
    cwd,
    kind: "task",
    title: text.slice(0, 80),
    promptText: taskPromptText,
    agent,
    phase,
    session,
    sessionProvenance,
    tools,
    timeoutS: Number(flags.timeout ?? DEFAULT_TASK_TIMEOUT_S),
    watchdogS: Number(flags.watchdog ?? DEFAULT_WATCHDOG_S),
    tiers: modelChain,
    round: 1,
    explicitModel,
  });

  // Store the resolved model chain, orchestrator, and backend on the job
  // record (claudeDispatch already stamps backend:"claude"; this makes the
  // opencode path record it too).
  job.modelChain = modelChain;
  job.orchestrator = orchestrator;
  job.backend = backend;

  // ---- deterministic probes (when --container given) ----
  if (flags.container) {
    try {
      const { callTool } = await import("./sunaba-rpc.mjs");
      const container = flags.container;
      const probeResults = [];

      const p1Result = await runHeadCleanProbe({ baseSha: taskBaseSha, callTool, container, sourceLabel: "task" });
      probeResults.push(p1Result);

      const p2Result = await runVerifyProbe({ callTool, container });
      probeResults.push(p2Result);

      const p3Result = await runDeliverablesProbe({
        deliverables: parseDeliverables(text),
        headingPresent: hasSectionHeading(text, "Deliverables"),
        callTool,
        container,
      });
      probeResults.push(p3Result);

      // P4: smoke probe
      const smokeEntries = parseSmoke(text);
      const smokeHeadingPresent = hasSectionHeading(text, "Smoke");
      const p4Result = await runSmokeProbe({
        entries: smokeEntries,
        callTool,
        container,
        headingPresent: smokeHeadingPresent,
      });
      probeResults.push(p4Result);

      // P5: frozen (kusabi #197).  The probes are shared with the chain, so a
      // single `task --container` gets the oracle for free — on this path the
      // change set is the full `git status --porcelain` one (no worktree
      // baseline is captured for a standalone task).
      const p5Result = runFrozenProbe({
        frozen: parseFrozenTests(text),
        headingPresent: hasSectionHeading(text, "Frozen Tests"),
        changedPaths: p3Result.newlyChangedPaths ?? p3Result.changedPaths,
      });
      probeResults.push(p5Result);

      // P6: collected (kusabi #197).  A standalone task has no chain-start
      // verify baseline, so there is nothing to compare against; the probe
      // passes and says so rather than staying silent.
      const p6Result = runCollectedProbe({
        collected: p2Result.collected ?? null,
        baselineCollected: null,
      });
      probeResults.push(p6Result);

      job.probeResults = probeResults;
      job.probesGreen = probeResults.every(function (p) { return p.passed; });
    } catch (probeErr) {
      job.probeResults = [{ probe: "task probes", passed: false, detail: String(probeErr) }];
      job.probesGreen = false;
    }
  }
  saveJob(stateDir, job);

  let taskOutput;
  if (job.status !== "completed") {
    taskOutput = `${renderHeader(job)}${job.error ?? ""}\nRun kusabi-companion status ${job.id} for details.`;
  } else {
    taskOutput = `${renderHeader(job)}${resultText || "(empty result)"}`;
  }

  // Append probe summary when --container
  if (job.probeResults && job.probeResults.length > 0) {
    taskOutput += "\n\nProbes:";
    for (const p of job.probeResults) {
      let detail = p.detail || "";
      if (detail.length > 300) detail = detail.slice(0, 300) + "...";
      taskOutput += "\n  " + p.probe + " — " + (p.passed ? "PASS" : "FAIL");
      if (detail) taskOutput += " (" + detail + ")";
    }
  }

  return taskOutput;
}

async function cmdReview(cwd, { flags, text }) {
  // kusabi #153: `review --container <cid>` was silently ignored — the review
  // read the HOST worktree's git state, failed on the container-only --base,
  // and then crashed with "findings.forEach is not a function".  The
  // standalone review has no container path; the sanctioned container review
  // route is `task --phase review --container <cid>`.  Reject early and
  // loudly instead of pretending the flag works (silent ignore is forbidden).
  if (flags.container) {
    throw new Error(
      "review does not support --container (it inspects the host worktree via git). " +
      "For a container review use: task --phase review --container " + flags.container + " --brief-file <path>"
    );
  }
  const promptTemplate = fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", "adversarial-review.md"), "utf8");
  const schema = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json"), "utf8"));
  const { label, input } = buildReviewInput(cwd, flags.base);
  const promptText = promptTemplate
    .replaceAll("{{TARGET_LABEL}}", label)
    .replaceAll("{{USER_FOCUS}}", text || "(none — general adversarial review)")
    .replaceAll("{{OUTPUT_SCHEMA}}", JSON.stringify(schema))
    .replaceAll("{{REVIEW_INPUT}}", input)
    .replaceAll("{{PRIOR_FINDINGS}}", flags.prior || "(none — first review round)")
    // kusabi #236: the standalone review route never runs the chain probes,
    // so {{PROBE_REPORT}} renders the explicit absence marker rather than
    // leaking the raw placeholder into the prompt.
    .replaceAll("{{PROBE_REPORT}}", "(no probe results recorded)");
  const { job, resultText } = await runPrompt({
    cwd,
    kind: "review",
    title: `review: ${label}`,
    promptText,
    model: parseModel(flags.model),
    agent: flags.agent,
    tools: reviewDenyTools(),
    // NOTE: opencode's `format: json_schema` is not used — some providers 400
    // on it, and sessions created with it break GET /session/:id/message in
    // opencode 1.17.x. The schema is embedded in the prompt instead.
    timeoutS: Number(flags.timeout ?? DEFAULT_REVIEW_TIMEOUT_S),
    watchdogS: Number(flags.watchdog ?? DEFAULT_WATCHDOG_S),
  });
  if (job.status !== "completed") {
    return `${renderHeader(job)}${job.error ?? ""}\nRun kusabi-companion status ${job.id} for details.`;
  }
  // Strip trailing VERDICT token line before JSON parsing so the token
  // does not make extractJson fail on well-formed JSON.
  const stripped = resultText.replace(/\s*VERDICT:\s*(approve-partial|approve|needs-attention|discard)\s*$/i, "");
  // Same two input formats as the chain (kusabi #202): JSONL first, the
  // single JSON object when the output is not JSONL.  This surface shares the
  // reviewer prompt with the chain, so it has to read what that prompt now
  // asks for; a reviewer still emitting one object renders as it did before.
  const jsonl = parseReviewJsonl(resultText);
  const rendered = renderReview(jsonl ? jsonl.review : extractJson(stripped), resultText);
  fs.writeFileSync(path.join(jobDir(stateDirFor(cwd), job.id), "result.md"), rendered, "utf8");
  return `${renderHeader(job)}${rendered}`;
}

function cmdStatus(cwd, { text }) {
  const stateDir = stateDirFor(cwd);
  const jobId = text.split(/\s+/).filter(Boolean)[0];
  if (jobId) {
    const job = loadJob(stateDir, jobId);
    if (!job) return `no such job: ${jobId}`;
    // Check chain ownership for this job
    const s = job.stats ?? {};
    // A stats object marked `instrumented: false` carries STRUCTURAL
    // counters, never measured ones — presenting them as `events: 0,
    // steps: 0, …` would report structural zeros as measured (kusabi
    // #215).  The marker is the signal; `backend` is never consulted.
    // Since kusabi #215 Job B the claude backend streams real events and
    // marks every new dispatch `instrumented: true`; this marker now
    // identifies only legacy/pre-#215 records already on disk.  Records
    // without the marker (opencode and instrumented claude) render the
    // counters as before.
    const statsLines = s.instrumented === false
      ? ["stats: not instrumented (legacy record, no event stream)"]
      : [
          `events: ${s.events ?? 0}, steps: ${s.steps ?? 0}, last tool: ${s.lastTool ?? "-"}`,
          `permissions: ${s.permissionsAllowed ?? 0} allowed, ${s.permissionsRejected ?? 0} rejected`,
          `last activity: ${s.lastActivity ?? "-"}`,
        ];
    const lines = [
      renderHeader(job).trimEnd(),
      ...statsLines,
      ...(job.error ? [`error: ${job.error}`] : []),
    ];
    const jobChain = chainIdForJob(job);
    if (jobChain) {
      lines.push(`chain: ${jobChain} (stop with: kusabi-companion chain-cancel ${jobChain})`);
    }
    return lines.join("\n");
  }
  const jobs = listJobs(stateDir).slice(0, 10);
  const lines = [];

  // Job listing
  if (jobs.length === 0) {
    lines.push("no opencode jobs for this directory yet.");
  } else {
    lines.push(...jobs.map((j) => renderJobLine(j)));
  }

  // Chain ownership — show running chains
  const chainStatuses = collectChainStatuses(stateDir);
  const runningOrStale = chainStatuses.filter(function (s) {
    return s.status === "running" || s.status === "stale" || s.status === "stopping";
  });
  if (runningOrStale.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("chains:");
    for (const cs of runningOrStale) {
      const containerField = cs.container ? ` container=${cs.container}` : "";
      let line = `  ${cs.chainId} round=${cs.round} status=${cs.status}${containerField}`;
      if (cs.stale) {
        line += " (process gone — record is stale)";
      }
      if (cs.status === "stopping") {
        line += ` (stop requested, stopping…)`;
      }
      lines.push(line);
    }
  }

  return lines.join("\n");
}

function cmdResult(cwd, { text }) {
  const stateDir = stateDirFor(cwd);
  const jobId = text.split(/\s+/).filter(Boolean)[0];
  const job = jobId ? loadJob(stateDir, jobId) : latestJob(stateDir, (j) => j.status === "completed");
  if (!job) return jobId ? `no such job: ${jobId}` : "no completed jobs for this directory yet.";
  const resultFile = path.join(jobDir(stateDir, job.id), "result.md");
  const body = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, "utf8") : "(no stored result)";
  return `${renderHeader(job)}${body}`;
}

/**
 * Stop the process behind a running job, per backend, and report what was
 * OBSERVED (kusabi #209).
 *
 * The incident this exists for: a claude-backend job was "cancelled", the
 * record was rewritten and `cancelled <id>` printed, and the process kept
 * writing files into the container for another 17 minutes.  The damage came
 * from the false confirmation, not from the failure to kill — an operator
 * told the job stopped goes on to reuse the container.
 *
 * `note` describes a stop that actually happened (or a process proven
 * already gone).  `failure` is non-null whenever the job may still be
 * running: the caller must then leave the record `running` and exit nonzero.
 * Exactly one of the two is set.
 *
 * @param {string} stateDir
 * @param {object} job
 * @returns {Promise<{note: string|null, failure: string|null}>}
 */
async function stopRunningJob(stateDir, job) {
  // Records written before the backend split carry no `backend` field and
  // are opencode by definition (same rule every other reader uses).
  const backend = job.backend ?? "opencode";
  // Spawned-CLI backends (claude, agy, cursor) are stopped the same way and for
  // the same reason: their job records have no session to abort, so the
  // recorded process is the only lever.  Keyed on the recorded-process shape
  // rather than on one backend's name — routing an agy job to the opencode
  // path would try to abort a session that does not exist and then report
  // success, which is precisely the false confirmation kusabi #209 exists to
  // prevent.
  if (backend === CLAUDE_BACKEND || backend === AGY_BACKEND || backend === CURSOR_BACKEND) {
    return stopSpawnedCliJob(job, backend);
  }
  return stopOpencodeJob(stateDir, job);
}

// claude / agy backends: there is no session to abort — the record's
// sessionID is null by construction until the CLI returns one — so the
// recorded process is the only lever, and it is verified before it is
// signalled.
async function stopSpawnedCliJob(job, backend) {
  const stop = await stopRecordedProcess(job.process);
  const tail = "The record is left `running`; nothing here proves the job stopped.";
  switch (stop.outcome) {
    case "stopped":
      return { note: `Stopped process group ${stop.pid} (SIGKILL): the ${backend} process and its children are gone.`, failure: null };
    case "already-gone":
      return { note: `Nothing to signal — ${stop.reason}. The record is finalised.`, failure: null };
    case "identity-mismatch":
      // Refusing to signal here is the point: a recorded pid outlives its
      // process, and one recycled pid already cost an unrelated live server
      // 22 minutes of downtime.  The job's own process is gone.
      return { note: `Not signalled: ${stop.reason}. This job's own process is gone; the record is finalised.`, failure: null };
    case "no-record":
      // #175/#176: a `running` record whose driver died without rewriting it
      // is a fossil.  With no pid recorded there is no process to observe, so
      // the staleness rule is the only evidence available — and it can only
      // ever conclude "gone", never "stopped".
      if (runningRecordIsStale(job)) {
        return { note: `${job.id} names no process and has had no activity for over 6 hours — a fossil record (its driver died without rewriting it). Nothing to signal; the record is finalised.`, failure: null };
      }
      return {
        note: null,
        failure: [
          `could not stop ${job.id}: the job record names no process id, so there is nothing to signal.`,
          "This record predates process recording (kusabi #209). The job may still be running — find it (ps) and kill it by hand.",
          tail,
        ].join("\n"),
      };
    case "unverifiable":
      return {
        note: null,
        failure: [
          `could not stop ${job.id}: pid ${stop.pid} could not be verified as this job's process — ${stop.reason}.`,
          "Refusing to signal a pid that may belong to something else. The job may still be running; check pid " +
            `${stop.pid} and kill it by hand if it is this job's.`,
          tail,
        ].join("\n"),
      };
    default: // "alive" — signalled, and something survived
      return {
        note: null,
        failure: [
          `could not stop ${job.id}: ${stop.reason}.`,
          `pid ${stop.pid} is STILL RUNNING and still writing into its container — do not reuse that container.`,
          `Kill it by hand (kill -9 -${stop.pid}) and re-run cancel.`,
          tail,
        ].join("\n"),
      };
  }
}

// opencode backend: the executor is the serve, and the lever is the session
// abort.  The request's outcome is now surfaced — a failed abort used to be
// swallowed by a bare `.catch(() => {})` and still print `cancelled`.
async function stopOpencodeJob(stateDir, job) {
  const server = readJson(path.join(stateDir, "server.json"));
  if (!(await serverHealthy(server))) {
    // No live serve answers for this workspace, so nothing is executing the
    // session: the record is a fossil to finalise, not a running job
    // (#175/#176).  Said out loud rather than implied by silence.
    return { note: "No healthy opencode serve answers for this workspace, so nothing can still be executing this job. Nothing was aborted; the record is finalised.", failure: null };
  }
  if (typeof job.sessionID !== "string" || job.sessionID === "") {
    // Never build `/session/null/abort`: it aborts nothing and its failure
    // is exactly what used to be swallowed.
    return {
      note: null,
      failure: [
        `could not stop ${job.id}: the record names no session, so there is nothing to abort on the serve.`,
        "The serve is healthy, so the job may still be running. Stop it by hand (kusabi-companion serve-stop --force stops the whole serve).",
        "The record is left `running`; nothing here proves the job stopped.",
      ].join("\n"),
    };
  }
  try {
    await api(server, "POST", `/session/${job.sessionID}/abort`);
  } catch (err) {
    return {
      note: null,
      failure: [
        `could not stop ${job.id}: the abort request for session ${job.sessionID} failed — ${err.message}`,
        "The job may still be running. The record is left `running`; nothing here proves the job stopped.",
      ].join("\n"),
    };
  }
  return { note: `Aborted opencode session ${job.sessionID} on the serve.`, failure: null };
}

export async function cmdCancel(cwd, { text }) {
  const stateDir = stateDirFor(cwd);
  const jobId = text.split(/\s+/).filter(Boolean)[0];
  const job = jobId ? loadJob(stateDir, jobId) : latestJob(stateDir, (j) => j.status === "running");
  if (!job) return jobId ? `no such job: ${jobId}` : "no running jobs to cancel.";
  if (job.status !== "running") return `${job.id} is not running (status: ${job.status}).`;

  const { note, failure } = await stopRunningJob(stateDir, job);
  if (failure) {
    // The record stays `running` because, as far as anything here can prove,
    // it IS running.  The nonzero exit is the other half: a caller that only
    // reads the status code must not be able to mistake this for a cancel.
    return { text: failure, exitCode: 1 };
  }

  job.status = "cancelled";
  job.finishedAt = new Date().toISOString();
  saveJob(stateDir, job);

  const lines = [`cancelled ${job.id}${job.sessionID ? ` (session ${job.sessionID})` : ""}.`];
  if (note) lines.push(note);

  // A job that belongs to a chain does not stop the chain: cancelling it only
  // ends one phase, and the chain starts the next round.  Say so — but say what
  // was actually observed, not an assumption about the chain's state.
  const chainId = chainIdForJob(job);
  if (chainId) {
    const control = readChainControl(path.join(stateDir, "chains", chainId));
    const { status } = effectiveStatus(control);
    if (status === "running" || status === "stopping") {
      lines.push(`This job belongs to chain ${chainId}, which is still running — cancelling a job does not stop the chain.`);
      lines.push(`To stop the chain itself: kusabi-companion chain-cancel ${chainId}`);
    } else if (status === "stale") {
      lines.push(`This job belongs to chain ${chainId}, whose process is gone (record is stale).`);
      lines.push(`To finalise that record: kusabi-companion chain-cancel ${chainId}`);
    } else if (status === "unknown") {
      lines.push(`This job belongs to chain ${chainId}, whose state is unknown (no control record — chain predates the stop lever).`);
      lines.push(`Cancelling a job does not stop a chain. To stop it: kusabi-companion chain-cancel ${chainId}`);
    } else {
      lines.push(`This job belongs to chain ${chainId}, which is already ${status}.`);
    }
  }

  return lines.join("\n");
}

// A `running` job record whose last activity is older than RUNNING_STALE_MS
// is a fossil (the driver died without rewriting it) and does not count as a
// live job — it must not block stopping the serve.  Shared by cmdServeStop
// and the chain driver's finally guard so both use the same staleness rule
// (kusabi #175).  Exported because that guard now lives in chain-driver.mjs
// (kusabi #264 PR 2/2) — the rule must stay one function, not two copies.
export function liveRunningJobs(stateDir) {
  return listJobs(stateDir).filter(function (j) {
    return j.status === "running" && !runningRecordIsStale(j);
  });
}

export function cmdServeStop(cwd, { flags } = {}) {
  const stateDir = stateDirFor(cwd);

  // Check for running jobs. If any exist, decline unless --force is passed.
  // A `running` record whose last activity is older than 6 hours is a fossil
  // (the driver died without rewriting it) and does not count — it must not
  // block stopping the serve (kusabi #162 follow-up).
  const runningJobs = liveRunningJobs(stateDir);
  if (runningJobs.length > 0) {
    if (!flags?.force) {
      const jobList = runningJobs.map(function (j) { return j.id; }).join(", ");
      const messages = [
        `${runningJobs.length} job(s) still running: ${jobList}`,
        "serve-stop does not stop a running chain — the chain spawns a new serve on its next dispatch.",
        "To stop a chain: kusabi-companion chain-cancel <chainId>",
        "To force-stop the serve regardless: kusabi-companion serve-stop --force",
      ];
      return messages.join("\n");
    }
  }

  const serverFile = path.join(stateDir, "server.json");
  const server = readJson(serverFile);
  if (!server?.pid) return "no server recorded for this directory.";

  // Never signal a pid we cannot attribute to one of our own serves: the
  // record can outlive the serve by days, and the pid may by then belong to
  // something else entirely (a recycled pid, or a TID of an unrelated
  // process).  The decline is said out loud: this is an explicit user-facing
  // command, and going quiet would read as "stopped" when nothing was
  // stopped (kusabi #181).
  const identity = isOurServe(server.pid, { root: stateRoot(), stateDir });
  if (!identity.ours) {
    if (identity.class === "refuted") {
      // The record positively names a process that is not our serve (or is
      // gone): the record is what is invalid — delete it, kill nothing.
      try { fs.unlinkSync(serverFile); } catch { /* best-effort */ }
      return `declined to stop pid ${server.pid}: ${identity.reason} (server.json removed; no signal sent).`;
    }
    // 'unverifiable' (hidepid, older marker set, /proc-less platform): the
    // pid may well be our serve — we just cannot prove it.  Deleting the
    // record would strand a live serve (it could never be stopped again and
    // the next dispatch would spawn a duplicate), so the record is kept and
    // the next ensureServer() health probe can still reuse the serve.
    return `declined to stop pid ${server.pid}: ${identity.reason} (server.json kept; no signal sent).`;
  }

  try {
    process.kill(server.pid);
    try { fs.unlinkSync(serverFile); } catch { /* best-effort */ }
    return `stopped opencode server (pid ${server.pid}).`;
  } catch {
    try { fs.unlinkSync(serverFile); } catch { /* best-effort */ }
    return `server pid ${server.pid} was not running.`;
  }
}

async function cmdChainCancel(cwd, { text }) {
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

// Copy a directory tree recursively. Used for skills, which are shipped as a
// whole directory (SKILL.md plus any assets) and must keep their directory name.
function copyDirTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirTree(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// opencode's real config dir, which is where it discovers agents and skills.
// It is relocatable via XDG_CONFIG_HOME, so the install defaults below must
// track it -- otherwise "the default destination is a discovery path" stops
// being true on exactly the hosts that relocated it. Single place to extend
// if opencode grows another relocation knob.
function opencodeConfigDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? path.join(xdg, "opencode") : path.join(os.homedir(), ".config", "opencode");
}

// Classify an install destination. Two views of the same path are needed: the
// link itself (lstat) and whatever it resolves to (stat). A dangling symlink
// exists as a path but has no target, so stat throws while lstat succeeds --
// reading that as "absent" is exactly what lets a later mkdirSync die
// mid-install, after the agents were already written.
function destDirState(p) {
  try {
    fs.lstatSync(p);
  } catch {
    return "absent";
  }
  let real = null;
  try {
    real = fs.statSync(p);
  } catch {
    return "broken-symlink";
  }
  return real.isDirectory() ? "directory" : "not-a-directory";
}

function cmdInstallAgents() {
  const src = path.join(PLUGIN_ROOT, "opencode-agents");
  const dest = process.env.OPENCODE_AGENT_DIR || path.join(opencodeConfigDir(), "agent");

  // Skills destination preflight — runs BEFORE any mutation, so a broken
  // skills destination fails the whole command cleanly instead of leaving
  // the agent half installed and then dying on a raw mkdirSync EEXIST.
  // (OPENCODE_SKILL_DIR / OPENCODE_AGENT_DIR are placement overrides that
  // opencode 1.18.15 does not read; see the skills comment below.)
  const skillSrc = path.join(PLUGIN_ROOT, "opencode-skills");
  const skillDest = process.env.OPENCODE_SKILL_DIR || path.join(opencodeConfigDir(), "skills");
  const skillDestState = destDirState(skillDest);
  if (skillDestState !== "absent" && skillDestState !== "directory") {
    throw new Error(
      `skills destination ${skillDest} is not a usable directory (${skillDestState}); refusing to install skills`,
    );
  }

  fs.mkdirSync(dest, { recursive: true });
  // Remove stale legacy agent definitions from install target
  const stale = ["oc-draft.md", "oc-investigate.md", "oc-implement.md", "oc-review.md", "oc-respond.md", "oc-salvage.md"];
  let removed = 0;
  for (const f of stale) {
    const target = path.join(dest, f);
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
      removed += 1;
    }
  }
  // Install current agent definitions under new kusabi-* names
  const files = fs.existsSync(src) ? fs.readdirSync(src).filter((f) => f.endsWith(".md")) : [];
  for (const f of files) fs.copyFileSync(path.join(src, f), path.join(dest, f));

  // Skills distribution: copy-and-overwrite ONLY — never delete anything at
  // the destination. The skills dir (OPENCODE_SKILL_DIR, default
  // ~/.config/opencode/skills) is shared with skills the user installed
  // themselves, and there is no kusabi-owned name registry that would make
  // deletion safe. (Contrast the agent path above, which deletes a fixed,
  // explicit list of legacy oc-* names — no such list exists for skills.)
  // Do not "clean this up" into a prune step.
  //
  // Note on OPENCODE_SKILL_DIR (and OPENCODE_AGENT_DIR, same status): these
  // are PLACEMENT overrides honoured by install-agents; opencode 1.18.15 does
  // not read either env var — it discovers skills/agents under its own config
  // dir. The default destination therefore has to be that dir, which is why it
  // is derived from opencodeConfigDir() (XDG_CONFIG_HOME aware) rather than
  // hardcoding ~/.config. Setting OPENCODE_SKILL_DIR to anything else lands
  // outside opencode's scan and must not be reported as discovered.
  fs.mkdirSync(skillDest, { recursive: true });

  const skillDirs = fs.existsSync(skillSrc)
    ? fs.readdirSync(skillSrc, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : [];
  // Per-skill preflight: the destination is user-controlled and never pruned,
  // so a name collision with a non-directory (a file, or a symlink that does
  // not resolve to a directory) must not crash the install — skip that skill
  // with a warning, leave the colliding path untouched (no-delete), and
  // continue with the rest.
  const skipped = [];
  for (const dir of skillDirs) {
    const destDir = path.join(skillDest, dir);
    const state = destDirState(destDir);
    if (state !== "absent" && state !== "directory") {
      skipped.push(`${dir} (${state})`);
      continue;
    }
    copyDirTree(path.join(skillSrc, dir), destDir);
  }
  let message = `installed ${files.length} phase agents to ${dest} (removed ${removed} stale legacy names); ` +
    `installed ${skillDirs.length - skipped.length} skills to ${skillDest}`;
  if (skipped.length > 0) {
    message += `; skipped ${skipped.length} skill(s): ${skipped.join(", ")} (destination exists and is not a directory — left untouched)`;
  }
  return message;
}

async function cmdSalvage(cwd, { flags, text }) {
  const deadJobId = text.split(/\s+/).filter(Boolean)[0];
  if (!deadJobId) throw new Error("salvage requires a dead job ID");
  const stateDir = stateDirFor(cwd);
  const deadJob = loadJob(stateDir, deadJobId);
  if (!deadJob) throw new Error(`no such job: ${deadJobId}`);

  // read dead job artifacts
  const deadDir = jobDir(stateDir, deadJobId);
  const originalBrief = fs.readFileSync(path.join(deadDir, "prompt.md"), "utf8");
  const eventsRaw = fs.readFileSync(path.join(deadDir, "events.ndjson"), "utf8")
    .split("\n").filter(Boolean).slice(-50)
    .map((l) => JSON.parse(l));

  // build salvage prompt
  const promptText = [
    `## Dead job info`,
    `- job ID: ${deadJob.id}`,
    `- kind: ${deadJob.kind}`,
    `- phase: ${deadJob.phase ?? "(none)"}`,
    `- status: ${deadJob.status}`,
    `- error: ${deadJob.error ?? "(none)"}`,
    `- models used: ${(deadJob.stats?.models ?? []).join(", ") || "(none)"}`,
    `- container ID: ${flags.container ?? "(not provided)"}`,
    `- Original brief:`,
    originalBrief,
    `## Recent events (${eventsRaw.length} items)`,
    eventsRaw.map((e) => JSON.stringify(e)).join("\n"),
  ].join("\n\n");

  const { job, resultText } = await runPrompt({
    cwd,
    kind: "salvage",
    title: `salvage: ${deadJobId}`,
    promptText,
    agent: "kusabi-salvage",
    phase: "salvage",
    model: parseModel(flags.model),
    tools: Object.fromEntries(
      ["bash", "edit", "write", "patch", "task", "skill"].map((t) => [t, false])
    ),
    timeoutS: Number(flags.timeout ?? 600),
    watchdogS: 0,
  });

  // record salvagedFrom
  job.salvagedFrom = deadJobId;
  saveJob(stateDir, job);

  if (job.status !== "completed") {
    return `${renderHeader(job)}${job.error ?? ""}`;
  }
  return `${renderHeader(job)}${resultText || "(empty report)"}`;
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

function cmdChainShow(cwd, { text }) {
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
function cmdChainWait(cwd, { flags, text }) {
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

// ---------------------------------------------------------------------------
// chain-stats
// ---------------------------------------------------------------------------

function cmdChainStats(cwd, { flags }) {
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
function cmdMetricsIngest(cwd, { flags }) {
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
function cmdMetricsReport(cwd, { flags }) {
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

function dashboardPortFlag(flags, fallback = 8752) {
  const raw = flags.port;
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`--port expects a TCP port number, got: ${raw}`);
  }
  return n;
}

async function cmdDashboard(_cwd, { flags }) {
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

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function usage() {
  return [
    "Usage: kusabi-companion <subcommand> [flags] [text]",
    "",
    "Subcommands:",
    "  setup      Start or verify the opencode server for this directory",
    "  task       Run an opencode task",
    "  review     Run an adversarial review of working-tree changes (host worktree only; --container is rejected \u2014 use task --phase review for container reviews)",
    "  chain      Run implement→review→rework chain until acceptance or escalate",
    "  chain-detach Launch a chain in a detached background process and print a runnable chain-wait command line (no LLM in launcher)",
    "  chain-resume  Resume a cancelled chain from its last recorded phase boundary, or buy a replacement review seat for a chain that escalated on a dead review seat over green probes (reads chain.json / control.json; same chain lifecycle as chain)",
    "  chain-show Print a compact plain-text digest of a chain (read-only, no LLM)",
    "  chain-wait Block until a chain reaches a terminal state, print a one-line digest, exit 0 (read-only, no LLM, no serve; safe to SIGTERM at any moment). Non-zero means the WAIT itself failed — unknown chain id, nothing appeared under --next, or the chain stalled — never a disposition you dislike",
    "  chain-stats Aggregate every chain record and print a summary (read-only, no LLM)",
    "  metrics-ingest  Ingest transcripts + chain records + delegated-job records into a durable SQLite store (read-only source, no LLM)",
    "  metrics-report  Query/report over the SQLite metrics store (read-only, no LLM, never ingests)",
    "  dashboard  Serve a read-only local JSON API over the state root and metrics.db (no LLM, no writes)",
    "  chain-cancel  Request a running chain to stop (file-based, works across processes)",
    "  status     List recent jobs or show one by ID",
    "  result     Show completed job result (latest, or by ID)",
    "  cancel     Cancel a running job",
    "  serve-stop Stop the background opencode server and remove its state file",
    "  install-agents  Copy phase agent definitions to OPENCODE_AGENT_DIR and skills to OPENCODE_SKILL_DIR",
    "  install-cli  Write a kusabi-companion shim to $KUSABI_BIN_DIR (default ~/.local/bin), and symlink the delegate / kusabi-result-handling skills into $KUSABI_CURSOR_DIR/skills (default ~/.cursor/skills) when that directory exists",
    "  salvage    Salvage a dead job (inspect progress and produce structured report)",
    "  baseline   Report collected test count, gate states, and optional smoke baseline for a container (read-only, no LLM)",
    "  help       Show this help message",
    "",
    "Flags:",
    "  --read-only, --resume-last",
    "  --base <ref> (review: branch diff base; task: diff base for --phase review --container, rejected elsewhere), --agent <id>, --phase <name> (draft|investigate|implement|review|respond|salvage|gofer)",
    "  --model <identifier> (task/chain: the identifier CARRIES its backend and decides it for the phases it pins — claude/<model> (bare alias opus|sonnet|haiku or a full model id; a :variant suffix is rejected) runs those phases on claude, provider/model[:variant] runs them on opencode, and a bare alias with no / names no backend, so the phase keeps its configured backend. The model is always validated against the backend the same identifier chose. A pinned model is the ONLY candidate: no fallback to the configured chain is attempted, so a pinned route that fails terminally ends the dispatch instead of silently running a different model)",
    "  --backend opencode|claude|agy|cursor (task/chain: force EVERY phase onto that backend; default opencode. Redundant when --model names a backend — a --backend that disagrees with such a --model is a contradiction and is rejected, naming both. With neither, the config chain entries decide: models.phases.<phase> (or models.chain) entries may carry a claude/, agy/, or cursor/ prefix for per-phase backend mixing; one phase's chain must be single-backend. agy resumes via --conversation: --session/--resume-last are accepted when the job store proves the id an agy conversation, and --read-only/--deny are rejected on it. chain-resume accepts --backend/--model only to route a quota-exhausted review seat onto a different backend or model)",
    "  --session <id>, --timeout <s>, --watchdog <s>, --deny <tools>",
    "  --brief-file <path> (task / chain: read the brief from a file; exclusive with inline text)",
    "  --container <cid> (chain/task: container to run deterministic probes in; NOT supported by review)",
    "  --keep-serve (chain / chain-resume: keep the serve alive after the chain finishes)",
    "  --force (serve-stop: force kill the serve even when jobs are running)",
    "  --cursor-rule (install-cli: also symlink the alwaysApply kusabi-delegate rule into <cursor dir>/rules; opt-in, since it taxes every conversation on the machine)",
    "  --prior <text> (review: prior findings for anti-ratchet)",
    "  --max-rounds <N> (chain: max rounds, default 4)",
    "  --next (chain-wait: wait for a chain to APPEAR and then wait on it, instead of naming one; selects the newest chain that is new since the wait started OR was already there and has not reached a terminal state, so a chain the dispatch created in the moment before the wait started still counts and a chain that finished earlier never does; a preexisting empty directory with no control record and older than --appear-timeout is debris from a dispatch that died before it wrote anything, and is skipped with a stderr note; while the selected chain is still recordless, a newer or same-stamped chain that appears wins instead of the wait stalling on the empty dir (a dir once traded away is never revisited); a dispatch that dies before creating a chain directory exits non-zero here instead of looking finished)",
    "  --since <ISO> (chain-wait --next: only a chain created at or after this stamp counts as the one to wait for, terminal or not — the precise tool, with an explicit chain id, when several chains run in one workspace at once and the default newest-unfinished selection would be ambiguous; while the selected chain has no control record yet, a newer or same-stamped in-window chain that appears wins, same as the default selection)",
    "  --poll-interval <s> (chain-wait: state poll interval, default 2)",
    "  --appear-timeout <s> (chain-wait: bound on --next, and on a chain directory that never gets a control record, default 120)",
    "  --progress-timeout <s> (chain-wait: give up on a chain whose state has not moved for this long even though its process is alive, default 7200)",
    "  --since <ISO> (chain-stats: start of time range, inclusive)",
    "  --until <ISO> (chain-stats: end of time range, exclusive)",
    "  --compare <ISO> (chain-stats: show before/after comparison at cutoff)",
    "  --transcript-dir <path> (metrics-ingest: default ~/.claude/projects)",
    "  --cursor-usage-dir <path> (metrics-ingest: default ~/.kusabi/cursor-usage)",
    "  --state-root <path> (metrics-ingest: default the kusabi state root, ~/.kusabi)",
    "  --db <path> (metrics-ingest: default <state-root>/metrics.db)",
    "  --dry-run (metrics-ingest: parse and report counts, write nothing)",
    "  --db <path> (metrics-report: default <state-root>/metrics.db)",
    "  --state-root <path> (metrics-report: default the kusabi state root)",
    "  --since <ISO> (metrics-report: window start, inclusive)",
    "  --until <ISO> (metrics-report: window end, exclusive)",
    "  --json (metrics-report: emit the report as one JSON document instead of text)",
    "  --port <N> (dashboard: listen port, default 8752; 0 binds an ephemeral port)",
    "  --state-root <path> (dashboard: default the kusabi state root, ~/.kusabi)",
    "  --db <path> (dashboard: default <state-root>/metrics.db)",
    "  -h, --help",
    "",
    "Unknown flags cause an error. Use -- to treat subsequent tokens as literal text.",
    "",
    "Serve lifecycle:",
    "  - chain stops its serve on completion unless --keep-serve is passed.",
    "  - serve-stop kills the serve and removes its server.json.",
    "  - serve-stop with running jobs declines and points at chain-cancel unless --force is passed.",
    "  - Idle serves without running jobs are reaped on next invocation after",
    "    KUSABI_SERVE_TTL_MS (default 30 min).",
  ].join("\n");
}

// Subcommands that create a job — they reach runPrompt() or dispatchWithFallback()
// (which itself calls runPrompt()) directly, or start a chain (which dispatches
// rounds through the same path). Enumerated from the switch in main() below;
// every other subcommand only reads or stops existing state.
//   task         -> dispatchWithFallback (cmdTask)
//   review       -> runPrompt            (cmdReview)
//   salvage      -> runPrompt            (cmdSalvage)
//   chain        -> dispatchWithFallback via runImplementPhase, per round (cmdChain)
//   chain-resume -> same as chain, from a saved position (cmdChainResume)
const JOB_CREATING_SUBCOMMANDS = new Set(["task", "review", "salvage", "chain", "chain-resume", "chain-detach", "chainDetach"]);

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  const cwd = process.cwd();

  // Fix 3 (kusabi #136): refuse to spawn a job when running inside a kusabi
  // worker's own tool process. ensureServer() stamps KUSABI_WORKER_CONTEXT=1
  // into the opencode serve's env; every tool process a worker session runs
  // (bash included) is a descendant of that serve and inherits the marker.
  // Without this, a worker that regains dispatch access (a quoted command,
  // a bug in a deny list, a future tool) can re-invoke the companion and
  // start a chain reaction — this is exactly how the #136 fork bomb spread.
  // Read-only / stop subcommands stay allowed: the guard is against
  // *spawning*, not against reading or stopping. The orchestrator's own
  // (host) invocations are unaffected because nothing sets the marker there.
  if (process.env.KUSABI_WORKER_CONTEXT && JOB_CREATING_SUBCOMMANDS.has(subcommand)) {
    throw new Error(
      "refusing to dispatch from inside a kusabi worker context (KUSABI_WORKER_CONTEXT is set). " +
      "Workers must not spawn jobs — put your findings in your final answer and let the orchestrator decide."
    );
  }

  // Startup reaper: reap idle serves whose last activity is older than TTL,
  // and reap orphaned serve processes that no server.json names (the marker
  // env buildServeEnv() stamps makes them recognisable). Best-effort; a
  // failure here must never crash the invoking command.
  try {
    const raw = process.env.KUSABI_SERVE_TTL_MS;
    const ttlMs = parseFloat(raw);
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 30 * 60 * 1000;
    const root = stateRoot();
    // On a serve-stop invocation the sweep leaves identity-failed records in
    // place: cmdServeStop adjudicates them itself and must say why it
    // declined — if the reaper deleted the record first, the user would only
    // ever see "no server recorded" (kusabi #181 follow-up).
    reapIdleServes(root, ttl, { keepIdentityFailed: subcommand === "serve-stop" });
    reapOrphanedServes(root);
  } catch { /* best-effort */ }

  // Claude Code passes "$ARGUMENTS" as a single string; re-split it.
  const flat = argv.length === 1 && argv[0]?.includes(" ") ? argv[0].split(/\s+/).filter(Boolean) : argv;

  // --help / -h before any literal "--", or the help subcommand -> usage, exit 0
  const sepIdx = flat.indexOf("--");
  const preLiteral = flat.slice(0, sepIdx >= 0 ? sepIdx : flat.length);
  if (
    subcommand === "help" || subcommand === "--help" || subcommand === "-h" ||
    preLiteral.includes("--help") || preLiteral.includes("-h")
  ) {
    return usage();
  }

  const parsed = parseArgs(flat);

  // --backend is a task/chain dispatch decision (kusabi #184); on any other
  // subcommand it would be silently ignored — reject it out loud instead.
  if (parsed.flags.backend && subcommand !== "task" && subcommand !== "chain" && subcommand !== "chain-detach" && subcommand !== "chainDetach" && subcommand !== "chain-resume" && subcommand !== "chainResume") {
    throw new Error(`--backend is only supported by task and chain (got subcommand ${subcommand ?? "(none)"})`);
  }

  // --cursor-rule is an install-cli placement decision; anywhere else it would
  // be silently ignored, so reject it the same way --backend is.
  if (parsed.flags.cursorRule && subcommand !== "install-cli") {
    throw new Error(`--cursor-rule is only supported by install-cli (got subcommand ${subcommand ?? "(none)"})`);
  }

  // The chain-wait bounds are wait decisions; on any other subcommand they
  // would be silently ignored, and a wait flag that did nothing is exactly
  // the silent-failure class chain-wait exists to remove.  (--since is shared
  // with chain-stats / metrics, so it is checked inside cmdChainWait instead.)
  if (subcommand !== "chain-wait" && subcommand !== "chainWait" && subcommand !== "chain-detach" && subcommand !== "chainDetach") {
    for (const flag of ["next", "poll-interval", "appear-timeout", "progress-timeout"]) {
      if (parsed.flags[flag] !== undefined) {
        throw new Error(`--${flag} is only supported by chain-wait and chain-detach (got subcommand ${subcommand ?? "(none)"})`);
      }
    }
  }

  if (parsed.flags.port !== undefined && subcommand !== "dashboard") {
    throw new Error(`--port is only supported by dashboard (got subcommand ${subcommand ?? "(none)"})`);
  }

  if (parsed.flags["state-root"] !== undefined) {
    const stateRootOk = new Set([
      "metrics-ingest", "metricsIngest", "metrics-report", "metricsReport", "dashboard",
    ]);
    if (!stateRootOk.has(subcommand)) {
      throw new Error(`--state-root is only supported by metrics-ingest, metrics-report and dashboard (got subcommand ${subcommand ?? "(none)"})`);
    }
  }

  switch (subcommand) {
    case "setup":
      return cmdSetup(cwd);
    case "task":
      return cmdTask(cwd, parsed);
    case "review":
      return cmdReview(cwd, parsed);
    case "status":
      return cmdStatus(cwd, parsed);
    case "result":
      return cmdResult(cwd, parsed);
    case "cancel":
      return cmdCancel(cwd, parsed);
    case "serve-stop":
      return cmdServeStop(cwd, parsed);
    case "chain-cancel":
    case "chainCancel":
      return cmdChainCancel(cwd, parsed);
    case "install-agents":
      return cmdInstallAgents();
    case "install-cli":
      return cmdInstallCli({ ...parsed, selfPath: COMPANION_SCRIPT });
    case "salvage":
      return cmdSalvage(cwd, parsed);
    case "baseline":
      return cmdBaseline(cwd, parsed);
    case "chain":
      return cmdChain(cwd, parsed);
    case "chain-detach":
    case "chainDetach":
      return cmdChainDetach(cwd, parsed);
    case "chain-resume":
    case "chainResume":
      return cmdChainResume(cwd, parsed);
    case "chain-show":
    case "chainShow":
      return cmdChainShow(cwd, parsed);
    case "chain-wait":
    case "chainWait":
      return cmdChainWait(cwd, parsed);
    case "chain-stats":
    case "chainStats":
      return cmdChainStats(cwd, parsed);
    case "metrics-ingest":
    case "metricsIngest":
      return cmdMetricsIngest(cwd, parsed);
    case "metrics-report":
    case "metricsReport":
      return cmdMetricsReport(cwd, parsed);
    case "dashboard":
      return cmdDashboard(cwd, parsed);
    default:
      throw new Error(`unknown subcommand: ${subcommand ?? "(none)"}. Use setup|task|review|chain|baseline|chain-detach|chain-resume|chain-show|chain-wait|chain-stats|metrics-ingest|metrics-report|dashboard|chain-cancel|status|result|cancel|serve-stop|install-agents|install-cli|salvage`);
  }
}

/**
 * Normalise what a subcommand returned into the two things the shell sees.
 *
 * A subcommand returns either the text to print, or `{ text, exitCode }`
 * when its OUTCOME must reach the exit code too.  Printing a failure and
 * still exiting 0 is exactly the false confirmation `cancel` now guards
 * against (kusabi #209): a caller that checks `$?` would read the
 * could-not-stop path as a successful cancel.
 *
 * @param {string|{text?: string, exitCode?: number}|null|undefined} output
 * @returns {{text: string, exitCode: number}}
 */
export function commandOutcome(output) {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    return {
      text: typeof output.text === "string" ? output.text : "",
      exitCode: Number.isInteger(output.exitCode) ? output.exitCode : 0,
    };
  }
  return { text: typeof output === "string" ? output : "", exitCode: 0 };
}

// flushAndExit (kusabi #243) lives in ./flush-and-exit.mjs since kusabi #277.
// Its behaviour is unchanged and this file is still one of its callers — the
// move is about what a *child process* pays to import it.  The #243 tests
// spawn a node child that imports flushAndExit, writes 150KiB and exits, all
// inside one wall-clock budget; when the import was of this module, a large
// share of that budget was this module's import graph rather than the drain
// under test.  See the header of flush-and-exit.mjs.

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then((output) => {
      const { text, exitCode } = commandOutcome(output);
      if (text) process.stdout.write(`${text}\n`);
      flushAndExit(exitCode);
    })
    .catch((err) => {
      process.stdout.write(`kusabi-companion error: ${err.message}\n`);
      flushAndExit(1);
    });
}
