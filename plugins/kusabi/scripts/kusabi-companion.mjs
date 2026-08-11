#!/usr/bin/env node
// kusabi-companion: bridge between Claude Code slash commands and an
// on-demand `opencode serve` instance.
//
// Context firewall: every opencode event is persisted under the state dir;
// stdout only ever carries the rendered final result, so the calling Claude
// session never sees intermediate narration, tool logs, or raw events.


import { parseArgs, parseModel, resolveModel, reviewDenyTools, WRITE_TOOL_NAMES, validateChainEntries, splitRouteBackend, resolveChainBackend, stripClaudePrefixChain, resolveModelBackend, chainNamesBackend } from "./cli.mjs";
import { renderReview, renderChainShow, renderJobLine, renderHeader, extractJson, renderFollowupDraft } from "./render.mjs";
import { hasSectionHeading, parseDeliverables, parseSmoke, parseOrchestratorSignature, briefRequestsPublish } from "./brief-parsing.mjs";
import { deriveDisposition } from "./disposition.mjs";
import { parseReviewJsonl } from "./review-jsonl.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { stateRoot, stateDirFor, readJson, writeJson } from "./state-paths.mjs";
import { collectChainRecords, computeStats, renderChainStats, renderComparison } from "./chain-stats.mjs";
import {
  readChainControl,
  writeChainControl,
  createChainControl,
  requestChainStop,
  effectiveStatus,
  shouldStopNow,
  updateChainControlRound,
  finalizeChainControl,
  rearmChainControl,
  chainIdForJob,
  collectChainStatuses,
} from "./chain-control.mjs";
import { jobDir, saveJob, loadJob, listJobs, latestJob } from "./job-store.mjs";
import { opencodeBin, serverHealthy, ensureServer, reapIdleServes, reapOrphanedServes, runningRecordIsStale, isOurServe, api } from "./serve-lifecycle.mjs";
import { runPrompt, dispatchWithFallback, resetFailedRoutes } from "./prompt-execution.mjs";
import { claudeDispatch, resolveClaudeModel, validateClaudeModel, validateClaudeChain, translateDenyTools, clampModelDispatch, stopRecordedProcess, CLAUDE_BACKEND } from "./claude-dispatch.mjs";
import { openMetricsDb, openMetricsDbReadOnly } from "./metrics-db.mjs";
import { ingestTranscriptDirectory } from "./transcript-ingest.mjs";
import { ingestChainDirectory, ingestJobDirectory } from "./chain-ingest.mjs";
import { computeReport, renderReportText, renderReportJson, missingStoreReport, renderMissingText } from "./metrics-report.mjs";

// Chain round-phases module — imported here for cmdChain.
// Probe functions are imported separately below with local bindings so
// cmdTask can call them directly, and re-exported for test compatibility.
import {
  createChainDir,
  captureBaseSha,
  captureVerifyBaseline,
  resolveRoundResume,

  buildImplementText,
  resolveReworkScope,
  runImplementPhase,
  runProbePhase,
  runReviewPhase,
  computeChainTotals,
  persistChainState,
  writeReviewRecord,
  runStrategizePhase,
  renderAcceptOutcome,
  renderAcceptWithFollowupOutcome,
  renderEscalateOutcome,
  renderMaxRoundsOutcome,
  handleProviderExhaustion,
  recordReworkEscalation,
  resolveChainResume,
  collectReviewContext,
  collectContainerReviewInput,
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
} from "./chain-phases.mjs";

// Worktree baseline module — content-sensitive measurement of what a round
// actually changed, independent of pre-existing worktree dirt.
import { captureWorktreeState } from "./worktree-baseline.mjs";

// Re-export so external consumers (tests) that import these functions
// from kusabi-companion.mjs continue to resolve correctly.
export {
  runSmokeProbe,
  runHeadCleanProbe,
  runVerifyProbe,
  runDeliverablesProbe,
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
  };
}

// The one-line orchestrator warning emitted at chain start when the brief
// appears to demand publish (kusabi #153).  Exported so the exact chain
// output text is fixed by tests; cmdChain prints it verbatim (plus a
// newline) before any job is dispatched.  publish is orchestrator-exclusive:
// the worker's toolset has no publish, so a brief demanding it must be
// surfaced to the orchestrator, never silently dropped.
export function publishWarningForBrief(brief) {
  if (!briefRequestsPublish(brief)) return null;
  return (
    "brief が publish を要求しているが、ワーカーは publish できない(オーケストレーター専権)。" +
    "受理後にオーケストレーターが publish を行う。"
  );
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
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
// dispatch backend selection (kusabi #184)
// ---------------------------------------------------------------------------

export const BACKENDS = ["opencode", "claude"];

/**
 * Resolve the dispatch backend from the `--backend` flag.  Resolved ONCE at
 * command start (`task` / `chain`); every job and chain record written by
 * the command carries the result as its `backend` field.  Old records
 * without the field are treated as `"opencode"` by readers.
 *
 * @param {object} flags — parsed flags (may carry `backend`).
 * @returns {"opencode"|"claude"}
 * @throws {Error} For any unknown backend value.
 */
export function resolveBackend(flags) {
  const backend = flags.backend || "opencode";
  if (!BACKENDS.includes(backend)) {
    throw new Error(`unknown backend: ${backend}. Use --backend opencode|claude`);
  }
  return backend;
}

/**
 * Resolve `{ dispatch, backend, model, explicitModel, chain }` for ONE phase
 * of a job-creating command.  The backend decides BOTH the dispatch function
 * (claudeDispatch vs dispatchWithFallback — the chain phases stay
 * backend-blind) and the model resolution syntax (claude models are bare
 * aliases / full ids, opencode models are provider/model).
 *
 * ---------------------------------------------------------------------
 * Resolution order (kusabi #210).  ONE decision picks the backend, and the
 * model is validated against THAT backend.  The defect class removed here
 * is a backend chosen by one input and a model validated against another:
 *
 *   0. a `--model` that NAMES a backend (`claude/opus`,
 *      `opencode-go/deepseek-v4-pro:max`) decides it — for the phases the
 *      flag pins, which is every phase it applies to and no wider;
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
 * array mixing `claude/` and opencode entries fails LOUDLY here, at command
 * start, before createChainDir / before any job is dispatched.  The check is
 * skipped only when the chain is never consulted (the backend is already
 * decided AND `--model` pins every phase — kusabi #186's carve-out).
 *
 * @param {object} opts
 * @param {object} opts.flags
 * @param {string} [opts.phase]
 * @param {object|null} opts.config
 * @returns {{ dispatch: Function, backend: "opencode"|"claude",
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

  return backend === "claude"
    ? resolveClaudePhaseDispatch({ flags, phase, config, modelSpec })
    : resolveOpencodePhaseDispatch({ phase, config, modelSpec, namedBackend, flagBackend });
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
  const chain = stripClaudePrefixChain(resolved.chain);

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
  // opencode, so a claude-native phase chain CONTRADICTS it — throw at
  // command start, naming the flag, the phase and the offending config key;
  // never silently switch backends, never dispatch claude/... routes as
  // opencode.  It fires only when there is no backend-naming `--model` to
  // settle the question: when the identifier names a backend the operator
  // has stated their intent unambiguously (and a disagreeing --backend
  // already threw above), so firing anyway would reproduce the incident
  // kusabi #210 was filed for.
  if (flagBackend === "opencode" && namedBackend === null && configuredBackend === "claude") {
    const chainKey = (phase && config?.models?.phases?.[phase])
      ? `models.phases.${phase}`
      : (config?.models?.chain ? "models.chain" : "the built-in default chain");
    throw new Error(
      `--backend opencode conflicts with the claude-native chain of the ${phase ?? "task"} phase ` +
      `(${chainKey}: ${JSON.stringify(configuredChain)}) — an explicit --backend forces every phase ` +
      `onto that backend; remove --backend opencode or point ${chainKey} at opencode entries`
    );
  }

  const resolved = resolveModel({ flag: modelSpec?.model, phase, config });
  let chain = resolved.chain;
  if (namedBackend === "opencode" && chainNamesBackend(chain, "claude")) {
    // Only reachable when the identifier chose opencode over a claude-native
    // chain: those entries are claude models and must never be walked as
    // opencode routes by the fallback ladder.  `--model` pins this phase
    // anyway, so its ladder is exactly the pinned route.
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
 * task job of the SAME backend as the current dispatch.  Both backends share
 * ONE job store, and a session id is backend-specific \u2014 a claude UUID cannot
 * be resumed on opencode, and an opencode `ses_*` id is rejected by the
 * claude backend's cross-backend guard.  Without this filter,
 * `--resume-last` on a claude dispatch could silently pick an opencode
 * session (and vice versa).  Records without a `backend` field predate the
 * backend split and count as "opencode".  This is SELECTION only \u2014 whether a
 * given session may be resumed on the chosen backend is decided inside the
 * dispatch (claudeDispatch's ses_* guard).
 *
 * @param {string} stateDir
 * @param {object} opts
 * @param {string|null|undefined} [opts.phase]
 * @param {"opencode"|"claude"} opts.backend
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
  let version;
  try {
    version = execFileSync(opencodeBin(), ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return `opencode CLI not found. Install it first: https://opencode.ai (or set OPENCODE_BIN).`;
  }
  const server = await ensureServer(cwd);
  return [
    `opencode ${version} — OK`,
    `server: http://127.0.0.1:${server.port} (pid ${server.pid}, password-protected)`,
    `state dir: ${server.stateDir}`,
    cmdInstallAgents(),
  ].join("\n");
}

async function cmdTask(cwd, { flags, text }) {
  // ---- brief-file resolution ----
  text = readBriefFile(flags, text);
  if (!text) throw new Error("task requires a task description (inline or via --brief-file)");
  const orchestrator = parseOrchestratorSignature(text);
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

  let session = flags.session;
  if (!session && flags.resumeLast) {
    // --resume-last selects the previous job of the SAME backend as this
    // dispatch: both backends share one job store, and a session id is
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

  // ---- review input (container review only) ----
  // Runs before dispatch: a container review must carry the diff into the
  // prompt, and a --base that cannot be honoured must abort before a job is
  // created rather than after (kusabi #204).
  const taskReviewInput = await buildTaskReviewInput({ phase, flags });

  const guardrails = fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", "task-guardrails.md"), "utf8").trim();
  const taskPromptText = taskReviewInput
    ? `${guardrails}\n\n<task>\n${text}\n</task>\n\n${taskReviewInput}`
    : `${guardrails}\n\n<task>\n${text}\n</task>`;
  const { job, resultText } = await dispatch({
    cwd,
    kind: "task",
    title: text.slice(0, 80),
    promptText: taskPromptText,
    agent,
    phase,
    session,
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
    taskOutput = `${renderHeader(job)}${job.error ?? ""}\nCheck /kusabi:status ${job.id} for details.`;
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
    .replaceAll("{{PRIOR_FINDINGS}}", flags.prior || "(none — first review round)");
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
    return `${renderHeader(job)}${job.error ?? ""}\nCheck /kusabi:status ${job.id} for details.`;
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
    const lines = [
      renderHeader(job).trimEnd(),
      `events: ${s.events ?? 0}, steps: ${s.steps ?? 0}, last tool: ${s.lastTool ?? "-"}`,
      `permissions: ${s.permissionsAllowed ?? 0} allowed, ${s.permissionsRejected ?? 0} rejected`,
      `last activity: ${s.lastActivity ?? "-"}`,
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
  if ((job.backend ?? "opencode") === CLAUDE_BACKEND) {
    return stopClaudeJob(job);
  }
  return stopOpencodeJob(stateDir, job);
}

// claude backend: there is no session to abort — the record's sessionID is
// null by construction until the CLI returns one — so the recorded process
// is the only lever, and it is verified before it is signalled.
async function stopClaudeJob(job) {
  const stop = await stopRecordedProcess(job.process);
  const tail = "The record is left `running`; nothing here proves the job stopped.";
  switch (stop.outcome) {
    case "stopped":
      return { note: `Stopped process group ${stop.pid} (SIGKILL): the claude process and its children are gone.`, failure: null };
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
// (kusabi #175).
function liveRunningJobs(stateDir) {
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

// ---------------------------------------------------------------------------
// chain
// ---------------------------------------------------------------------------

// Ladder accounting is backend-aware (kusabi #192 follow-up): a claude-native
// chain never walks its tiers — claudeDispatch pins every phase to the
// command-start model — so everywhere a tier count feeds ACCOUNTING (the
// chain-start banner, the recordReworkEscalation clamp) a claude chain has an
// effective tier count of min(1, length).  Dispatch behaviour is untouched;
// this only makes printed/recorded numbers match the ladder the backend
// actually climbs.  opencode chains keep their full length.
export function effectiveTierCount(chain, backend) {
  if (!chain) return 0;
  if (backend === "claude") return Math.min(1, chain.length);
  return chain.length;
}

// The chain-start banner line (B7).  Returns null when there is no ladder to
// describe (no implement chain); the caller skips the write.  The
// can-reach-top claim is computed against the chain the ladder ACTUALLY
// climbs: the REWORK chain's effective tier count when a models.phases.rework
// key is configured, the implement chain's otherwise (kusabi #192 axis 2).
export function renderChainBanner({ chainId, tierCount, reworkTierCount, reworkKeyConfigured, maxRounds }) {
  if (tierCount <= 0) return null;
  const ladderTierCount = reworkKeyConfigured ? reworkTierCount : tierCount;
  // The ladder can climb to tier (ladderTierCount - 1). With the default
  // ladder, the 1st rework uses tier 0 (same), 2nd uses tier 1 (+1), 3rd
  // uses tier 2 (+1).  The top tier is reached at round:
  // 1 (initial) + (ladderTierCount) reworks.
  const roundsToTopTier = 1 + ladderTierCount; // initial + one rework per tier beyond 0
  const canReachTop = maxRounds >= roundsToTopTier;
  return "Chain " + chainId + ": tiers=" + tierCount +
    (reworkKeyConfigured ? ", reworkTiers=" + reworkTierCount : "") +
    ", maxRounds=" + maxRounds +
    (canReachTop ? " (can reach top tier)" : " (maxRounds insufficient to reach top tier)") +
    "\n";
}

async function cmdChain(cwd, { flags, text }) {
  // ---- brief-file resolution ----
  text = readBriefFile(flags, text);
  if (!text) throw new Error("chain requires a brief description (inline or via --brief-file)");
  const orchestrator = parseOrchestratorSignature(text);

  // ---- runtime publish guard (kusabi #153) ----
  // publish is structurally absent from the worker toolset (orchestrator-
  // exclusive network exit).  A brief that demands PUBLISH cannot be
  // executed by the worker — warn the orchestrator in the chain output
  // instead of letting it read "the worker skipped publish" after the fact.
  // One line only; behaviour is unchanged.  Over-detection is acceptable.
  const publishWarning = publishWarningForBrief(text);
  if (publishWarning) {
    process.stdout.write(publishWarning + "\n");
  }

  // ---- setup ----
  const stateDir = stateDirFor(cwd);
  const config = loadConfig(stateRoot());
  // Backend resolves PER PHASE at command start (kusabi #192): the
  // implement route-chain and the review route-chain resolve independently,
  // each from models.phases.<phase> with fallback to models.chain, then the
  // built-in default.  A `claude/<model>` entry prefix selects the claude
  // backend for that phase; `--backend` forces every phase onto one backend
  // (flag wins).  The strategist follows the implement resolution.  The
  // :variant rejection for the claude backend and the single-backend-per-
  // phase invariant also happen here, so a bad config fails with a clear
  // error and a nonzero exit before createChainDir / before any job is
  // dispatched.
  //
  // Rework rounds (implement rounds after round 1) resolve from
  // models.phases.rework with the exact same machinery (kusabi #192 axis 2):
  // entry prefixes, single-backend invariant, :variant rejection, and the
  // explicit --backend flag forcing it like every other phase.  Key absence
  // must mean "byte-identical to today": rework rounds keep the implement
  // resolution (its chain AND its ladder) \u2014 never models.chain directly.
  const implementDispatch = resolveDispatchBackend({ flags, phase: "implement", config });
  const reworkKeyConfigured = !!config?.models?.phases?.rework;
  const reworkDispatch = reworkKeyConfigured
    ? resolveDispatchBackend({ flags, phase: "rework", config })
    : implementDispatch;
  const reviewDispatch = resolveDispatchBackend({ flags, phase: "review", config });
  const { chainId, chainDir } = createChainDir(stateDir);
  const container = flags.container;
  if (!container) throw new Error("chain requires --container <cid>");
  const maxRounds = Number(flags["max-rounds"] ?? 4); // B6: default maxRounds is 4
  const brief = text;

  // ---- initialise chain control record (file-based stop lever) ----
  writeChainControl(chainDir, createChainControl({
    chainId,
    container,
    pid: process.pid,
  }));

  // ---- SIGTERM/SIGINT handler feeds the same predicate as the file-based stop ----
  let signalReceived = false;
  const onSignal = () => { signalReceived = true; };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  // ---- import callTool once for all phases that need it ----
  const { callTool } = await import("./sunaba-rpc.mjs");

  // ---- reset failed-route memo for a fresh chain run ----
  resetFailedRoutes();

  // ---- chain initialisation: record base SHA + worktree baseline ----
  const baseSha = await captureBaseSha(callTool, container);
  const worktreeBaseline = await captureWorktreeState(callTool, container);

  // ---- verify baseline (kusabi #173) ----
  // The only moment the container worktree is guaranteed to be the pristine
  // base is right here, BEFORE the round-1 implement dispatch.  Run the
  // verify gate once and record the base's lint/type violation counts (and
  // the raw verify JSON) on chain.json, so P2 can distinguish "the worker
  // added lint/type debt" from "the repo already had it".  chain-resume
  // reuses this recorded baseline and never re-captures on a modified
  // worktree.
  const verifyBaseline = await captureVerifyBaseline(callTool, container);

  // ---- chain-start output: state tiers, maxRounds, and ladder info (B7) ----
  // The ladder claim must not lie when a rework chain is configured (kusabi
  // #192 axis 2): the implement chain serves round 1 only — the ladder that
  // climbs across rework rounds is the REWORK chain's.  Print both tier
  // counts so the claim is explicit; the can-reach-top claim is computed
  // against the chain the ladder actually climbs (rework when configured,
  // implement otherwise).
  // The counts are backend-aware (kusabi #192 follow-up): a claude-native
  // chain has an effective tier count of min(1, length) — claudeDispatch
  // pins every phase to the command-start model, so its ladder never climbs
  // and the banner must not claim a multi-tier ladder that cannot be walked.
  const tierCount = effectiveTierCount(implementDispatch.chain, implementDispatch.backend);
  const reworkTierCount = reworkKeyConfigured
    ? effectiveTierCount(reworkDispatch.chain, reworkDispatch.backend)
    : 0;
  const bannerLine = renderChainBanner({
    chainId, tierCount, reworkTierCount, reworkKeyConfigured, maxRounds,
  });
  if (bannerLine != null) process.stdout.write(bannerLine);

  try {
    return await runChainDriver({
      cwd, stateDir, chainDir, chainId, container, model: implementDispatch.model,
      modelChain: implementDispatch.chain, reviewModel: reviewDispatch.model,
      reviewModelChain: reviewDispatch.chain, maxRounds,
      brief, orchestrator, baseSha, worktreeBaseline, verifyBaseline, callTool,
      backend: implementDispatch.backend,
      reviewBackend: reviewDispatch.backend,
      // Rework rounds (implement rounds after round 1) dispatch from the
      // rework resolution when models.phases.rework is configured; absent
      // key → reworkDispatch IS the implement dispatch and the driver's
      // effective values collapse to the implement resolution (byte-identical
      // to today).  Round records stamp each round's own backend, so a
      // mixed chain (round 1 claude, rework opencode) stays truthful.
      reworkModel: reworkDispatch.model,
      reworkModelChain: reworkDispatch.chain,
      reworkBackend: reworkDispatch.backend,
      // claude: clamp later phases (rework implement, review, strategist)
      // to the phase's command-start model — the claude backend has no tier
      // ladder, so the model never changes mid-chain (kusabi #184 finding 1).
      // Each phase clamps to ITS OWN resolved model, so implement and review
      // can run on different backends with different models (kusabi #192).
      dispatchWithFallback: implementDispatch.backend === "claude"
        ? clampModelDispatch(implementDispatch.dispatch, implementDispatch.model)
        : implementDispatch.dispatch,
      reviewDispatchWithFallback: reviewDispatch.backend === "claude"
        ? clampModelDispatch(reviewDispatch.dispatch, reviewDispatch.model)
        : reviewDispatch.dispatch,
      reworkDispatchWithFallback: reworkDispatch.backend === "claude"
        ? clampModelDispatch(reworkDispatch.dispatch, reworkDispatch.model)
        : reworkDispatch.dispatch,
      initialSession: flags.session,
      // The --model value in the SPELLING of the backend the resolution
      // chose, never the raw flag string (kusabi #210): a backend-naming
      // --model pins every phase onto ITS backend, so all three phase
      // resolutions carry the same spelling, and a claude dispatch must
      // receive `opus`, not `claude/opus`.
      flagsModel: implementDispatch.explicitModel,
      signalReceived: () => signalReceived,
      keepServe: !!flags.keepServe,
      resume: null,
    });
  } finally {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  }
}

// ---------------------------------------------------------------------------
// chain driver — shared by `chain` and `chain-resume` (kusabi #153①)
// ---------------------------------------------------------------------------

/**
 * Resolve the review phase's dispatch for runChainDriver.
 *
 * An explicit `injectedReviewDispatch` wins.  Otherwise the implement
 * dispatch is reused ONLY when the review backend equals the implement
 * backend — the pre-#192 single-dispatch contract (one dispatch threaded
 * through every phase).  Under per-phase mixing the implement dispatch
 * belongs to the OTHER backend, so reusing it for review would silently run
 * the review job on the wrong backend while the round record claims
 * `reviewBackend` — the chain-resume bug this resolves (kusabi #192):
 * cmdChainResume used to pass an undefined review seam for an opencode
 * review, and the driver fell back to the claude implement dispatch.  The
 * fallback for a differing backend is the CANONICAL dispatch of the review
 * backend (claudeDispatch for claude, dispatchWithFallback for opencode).
 *
 * @param {object} opts
 * @param {Function|null|undefined} [opts.injectedReviewDispatch] — explicit
 *        review seam (always given by cmdChain; cmdChainResume passes one
 *        too, so this fallback mainly serves legacy single-dispatch callers).
 * @param {Function} [opts.injectedDispatch] — the implement dispatch.
 * @param {"opencode"|"claude"} opts.backend — implement backend.
 * @param {"opencode"|"claude"} opts.reviewBackend — review backend.
 * @returns {Function} The dispatch the review phase will use.
 */
export function resolveReviewDispatch({ injectedReviewDispatch, injectedDispatch, backend, reviewBackend }) {
  if (injectedReviewDispatch) return injectedReviewDispatch;
  if (reviewBackend === backend) return injectedDispatch ?? dispatchWithFallback;
  return reviewBackend === "claude" ? claudeDispatch : dispatchWithFallback;
}

/**
 * Resolve the implement and review dispatch seams for chain-resume.
 *
 * The implement seam mirrors the pre-#192 shape (clamped claude dispatch for
 * a claude chain, undefined \u2192 the driver's real dispatchWithFallback for
 * opencode).  The review seam is ALWAYS explicit: an undefined seam would
 * make runChainDriver fall back to the implement dispatch, which belongs to
 * the OTHER backend on a mixed chain \u2014 the review job would silently run on
 * the wrong backend (claude CLI with the implement's model) while the round
 * record claims the recorded reviewBackend (kusabi #192 finding).  An
 * opencode review gets the plain opencode dispatch; a claude review gets the
 * clamped claude dispatch pinned to the recorded review model.
 *
 * @param {object} opts
 * @param {"opencode"|"claude"} opts.resumeBackend       \u2014 implement backend
 *        (last record's `backend`).
 * @param {"opencode"|"claude"} opts.resumeReviewBackend \u2014 review backend
 *        (last record's `reviewBackend`, falling back to its `backend`).
 * @param {string|null} [opts.model]        \u2014 recorded implement model.
 * @param {string|null} [opts.reviewModel]  \u2014 recorded review model.
 * @returns {{ dispatchWithFallback: Function|undefined,
 *             reviewDispatchWithFallback: Function }}
 */
/**
 * Resolve the per-phase review dispatch context for chain-resume from the
 * persisted chain.json (kusabi #192).  Exported for testing.
 *
 * A #192-era chain.json carries `reviewModel` / `reviewModelChain` \u2014 possibly
 * null on a mixed chain whose review runs on opencode.  That persisted null
 * must stay null: the opencode review dispatch ignores it, and substituting
 * the implement chain would re-dispatch the review with the OTHER backend's
 * chain (a later chain-resume would fall back `reviewModelChain ?? modelChain`
 * and re-run the review on the implement's claude chain).  A pre-#192
 * chain.json has NO such keys: key ABSENCE is the legacy marker \u2014 fall back
 * to the implement model/chain (pre-#192 clamped the whole chain to
 * `chainJson.model`).
 *
 * @param {object} chainJson \u2014 the persisted chain record.
 * @returns {{ reviewModel: string|object|null, reviewModelChain: Array|null }}
 */
export function resolveResumeReviewContext(chainJson) {
  return {
    reviewModel: ("reviewModel" in chainJson) ? chainJson.reviewModel : (chainJson.model ?? null),
    reviewModelChain: ("reviewModelChain" in chainJson) ? chainJson.reviewModelChain : (chainJson.modelChain ?? null),
  };
}

/**
 * Resolve the per-round REWORK dispatch context for chain-resume from the
 * persisted chain.json (kusabi #192 axis 2) \u2014 the rework mirror of
 * resolveResumeReviewContext, with the same key-absence-is-legacy rule.
 *
 * An axis-2 chain.json carries `reworkModel` / `reworkModelChain` /
 * `reworkBackend` \u2014 null when no models.phases.rework key was configured
 * at chain start (rework rounds then continue on the implement resolution,
 * which the driver derives from the nulls).  A pre-axis-2 chain.json has NO
 * such keys: key ABSENCE is the legacy marker \u2014 fall back to the implement
 * model/chain exactly like the review context does, so legacy chains resume
 * byte-identically.  `reworkBackend` has no implement-side value to fall
 * back to here; the caller resolves null \u2192 the implement backend (the
 * same `?? backend` rule the driver uses for a fresh chain).
 *
 * @param {object} chainJson \u2014 the persisted chain record.
 * @returns {{ reworkModel: string|object|null, reworkModelChain: Array|null,
 *             reworkBackend: "opencode"|"claude"|null }}
 */
export function resolveResumeReworkContext(chainJson) {
  return {
    reworkModel: ("reworkModel" in chainJson) ? chainJson.reworkModel : (chainJson.model ?? null),
    reworkModelChain: ("reworkModelChain" in chainJson) ? chainJson.reworkModelChain : (chainJson.modelChain ?? null),
    reworkBackend: ("reworkBackend" in chainJson) ? chainJson.reworkBackend : null,
  };
}

export function resolveResumeDispatches({ resumeBackend, resumeReviewBackend, model, reviewModel }) {
  return {
    dispatchWithFallback: resumeBackend === "claude"
      ? clampModelDispatch(claudeDispatch, model ?? null)
      : undefined,
    reviewDispatchWithFallback: resumeReviewBackend === "claude"
      ? clampModelDispatch(claudeDispatch, reviewModel ?? null)
      : dispatchWithFallback,
  };
}

/**
 * Run the chain round loop.  Shared by cmdChain (fresh chain) and
 * cmdChainResume (resumed chain); `resume` carries the position resolved by
 * resolveChainResume, or null for a fresh chain.
 *
 * Exported so tests can drive the loop with fake callTool / dispatch; the
 * CLI wrappers install signal handlers and (for resume) validate the
 * container before calling this.
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} opts.stateDir
 * @param {string} opts.chainDir
 * @param {string} opts.chainId
 * @param {string} opts.container
 * @param {string|null} opts.model
 * @param {Array} opts.modelChain
 * @param {number} opts.maxRounds
 * @param {string} opts.brief
 * @param {object|null} opts.orchestrator
 * @param {string|null} opts.baseSha        — null → captured from the container.
 * @param {object|null} opts.worktreeBaseline — null → captured from the container.
 * @param {object|null} opts.verifyBaseline — chain-start verify baseline
 *        (kusabi #173).  Fresh chains: captured by cmdChain on the pristine
 *        base.  Resumed chains: read from chain.json by cmdChainResume.  Never
 *        re-captured here — a resumed worktree is modified, so a fresh capture
 *        would measure the round's changes, not the base.
 * @param {Function} opts.callTool
 * @param {Function} [opts.dispatchWithFallback] — injection seam for the
 *        IMPLEMENT phase and the strategist (defaults to the real
 *        dispatchWithFallback; phase functions receive it as their own
 *        _dispatchWithFallback seam).  claudeDispatch when the chain's
 *        implement phase runs on the claude backend (kusabi #184).
 * @param {Function} [opts.reviewDispatchWithFallback] — injection seam for
 *        the REVIEW phase; when not given, resolveReviewDispatch picks it
 *        from the backends: the implement dispatch for a same-backend review
 *        (single-backend chains behave exactly as before), else the canonical
 *        dispatch of the review backend — never the other backend's dispatch
 *        (kusabi #192).  Resolved per phase from models.phases.review.
 * @param {"opencode"|"claude"} [opts.backend] — implement dispatch backend,
 *        recorded on every round record; readers treat a missing field as
 *        "opencode".  Default "opencode".
 * @param {"opencode"|"claude"} [opts.reviewBackend] — review dispatch
 *        backend, recorded as `reviewBackend` on every round record (always
 *        set; readers treat a missing field as the record's implement
 *        backend).  Defaults to the implement backend (legacy
 *        single-dispatch callers run the whole chain on one backend).
 * @param {Array} [opts.reviewModelChain] — the review phase's route chain
 *        (defaults to modelChain for single-chain chains).  Persisted to
 *        chain.json so chain-resume re-dispatches review on the same route.
 * @param {string|object|null} [opts.reviewModel] — the review phase's
 *        command-start resolved model (claude string, or opencode parseModel
 *        object); persisted for chain-resume.
 * @param {Array} [opts.reworkModelChain] — the rework phase's route chain
 *        (kusabi #192 axis 2).  Implement rounds AFTER round 1 (rework
 *        rounds) dispatch from it, and the tier ladder climbs over it; null
 *        (no models.phases.rework key) keeps rework rounds on the implement
 *        chain and ladder — byte-identical to today.  Persisted to
 *        chain.json so chain-resume re-dispatches rework rounds on the same
 *        route.
 * @param {string|object|null} [opts.reworkModel] — the rework phase's
 *        command-start resolved model; persisted for chain-resume.
 * @param {"opencode"|"claude"|null} [opts.reworkBackend] — the rework
 *        phase's dispatch backend; null/absent means rework rounds keep the
 *        implement backend.  Recorded on every rework round record's
 *        `backend` field; persisted to chain.json for chain-resume.
 * @param {Function} [opts.reworkDispatchWithFallback] — injection seam for
 *        REWORK implement rounds (rounds after round 1); when not given the
 *        implement dispatch is used (no rework key configured).  claude
 *        rework rounds get the clamped claude dispatch pinned to the rework
 *        model (kusabi #184 finding 1 applies per phase).
 * @param {string} [opts.initialSession]
 * @param {string|null} [opts.flagsModel]
 * @param {Function} [opts.signalReceived]  — getter: has SIGTERM/SIGINT fired?
 * @param {boolean} [opts.keepServe]
 * @param {object|null} [opts.resume]       — resolveChainResume position or null.
 * @returns {Promise<string>} Outcome text for the operator.
 */
export async function runChainDriver({
  cwd, stateDir, chainDir, chainId, container, model, modelChain, maxRounds,
  brief, orchestrator, baseSha, worktreeBaseline, verifyBaseline, callTool,
  dispatchWithFallback: injectedDispatch = dispatchWithFallback,
  backend = "opencode",
  reviewDispatchWithFallback: injectedReviewDispatch = null,
  // Default reviewBackend to the implement backend: a caller that threads a
  // single dispatch (every pre-#192 caller) runs the whole chain on one
  // backend, so its records should claim that backend for review too.
  reviewBackend = backend,
  reviewModelChain = null,
  reviewModel = null,
  // Rework context (kusabi #192 axis 2): defaults collapse to the implement
  // resolution, so callers without a models.phases.rework key (and every
  // pre-axis-2 caller) get byte-identical behaviour.
  reworkModelChain = null,
  reworkModel = null,
  reworkBackend = null,
  reworkDispatchWithFallback = null,
  initialSession, flagsModel = null, signalReceived = () => false,
  keepServe = false, resume = null,
}) {
  // Per-phase dispatch (kusabi #192): the review phase dispatches through its
  // own backend-specific dispatch unless the caller threads a single one
  // (single-backend chains — and every pre-#192 caller — stay identical).
  // The fallback is backend-aware: the implement dispatch is reused only for
  // a same-backend review; under mixing the review phase gets the canonical
  // dispatch of ITS backend, never the other backend's dispatch (kusabi #192
  // finding — chain-resume used to route review through the claude implement
  // dispatch while recording reviewBackend=opencode).
  const reviewDispatch = resolveReviewDispatch({
    injectedReviewDispatch,
    injectedDispatch,
    backend,
    reviewBackend,
  });
  // The review phase's route chain: its own when per-phase config resolved
  // one, else the implement chain (pre-#192 behaviour).
  const effectiveReviewChain = reviewModelChain ?? modelChain;
  // The REWORK phase's effective resolution (kusabi #192 axis 2): its own
  // chain / backend / dispatch when a models.phases.rework key resolved one,
  // else the implement resolution — the `??` collapses exactly to it, so
  // chains without the key (and every pre-axis-2 caller) are byte-identical.
  const effectiveReworkChain = reworkModelChain ?? modelChain;
  const effectiveReworkBackend = reworkBackend ?? backend;
  const effectiveReworkDispatch = reworkDispatchWithFallback ?? injectedDispatch;
  // baseSha: a resume keeps the ORIGINAL chain base — the resumed round's diff
  // is measured against it (P1 auto-resets HEAD to it); a fresh chain captures
  // it from the container.
  const effectiveBaseSha = baseSha ?? await captureBaseSha(callTool, container);
  // worktreeBaseline: captured once per run.  A resumed chain re-captures at
  // resume time — the pre-cancel baseline is not persisted, and the resumed
  // run measures what IT changes from here on.  The interrupted round's
  // review-resume path deliberately bypasses it (see collectReviewContext).
  const effectiveBaseline = worktreeBaseline ?? await captureWorktreeState(callTool, container);
  // verifyBaseline (kusabi #173): NEVER re-captured here.  Fresh chains get it
  // from cmdChain (pristine base); resumed chains reuse the value recorded in
  // chain.json — the worktree is modified by resume time, so a re-capture
  // would measure the round's changes and silently ratchet the baseline.
  const effectiveVerifyBaseline = verifyBaseline ?? null;

  // ---- round loop state (cross-round) ----
  const records = resume ? resume.records : [];
  let strategized = resume ? resume.strategized : false;
  let session = resume ? resume.session : initialSession;
  let reworkCount = resume ? resume.reworkCount : 0;
  let currentTierIndex = resume ? resume.currentTierIndex : 0;
  const startRound = resume ? resume.round : 1;

  // ---- terminal finalisation: write the postable review record and append
  // its path to the outcome text.  Every terminal disposition funnels
  // through here (accept / accept-with-followup / escalate / max-rounds), so
  // `chain` and `chain-resume` cannot diverge.  Cancelled and failed chains
  // never reach it (kusabi #52).  The record is a convenience artifact: a
  // write failure must not take the already-decided chain outcome down with
  // it, so it degrades to a visible note instead of throwing.
  function finaliseChain(text, disposition, round) {
    let recordPath = null;
    let writeError = null;
    try {
      recordPath = writeReviewRecord({
        chainDir, chainId, container, modelChain, maxRounds, brief, orchestrator,
        records, chainTotals: computeChainTotals(records),
        disposition, round,
        label: path.basename(cwd) || null,
      });
    } catch (err) {
      // Best-effort — the outcome text stays intact, but the failure must be
      // observable or renderer defects hide behind a silently absent record.
      writeError = err;
    }
    return recordPath
      ? text + "\n\n" + "review record: " + recordPath
      : text + "\n\n" + "review record: (write failed: " + (writeError?.message || "unknown error") + " — chain state dir " + chainDir + ")";
  }

  // Phases 5–13 (review → disposition → persistence → strategize), shared by
  // fresh rounds and review-resumes.  Mutates the cross-round state above in
  // place; returns { done: true, text } when the chain ended.
  async function finishRound({ round, roundRecord, previousRecord, probeCtx }) {
    const {
      probesGreen, chainChangedPaths, chainNewlyChanged, chainStatusObserved,
      chainStatusOutput, chainBaseLog, chainDeliverables, chainUntracked, chainTruncation,
    } = probeCtx;

    // ---- phase 5: review (or skip when change set empty) ----
    // Single conduit (kusabi #100): runReviewPhase writes everything that
    // belongs on the record onto roundRecord and returns only what is not
    // record state; the values the disposition phase needs that ARE record
    // state (verdict, findingsText) are read back from roundRecord here.
    const {
      chainParsedReview, chainRepeatedAreas, skipReview,
      reviewJobStatus, reviewJobError,
    } = await runReviewPhase({
      container, brief, modelChain: effectiveReviewChain, chainId, cwd, previousRecord, baseSha: effectiveBaseSha,
      chainStatusOutput, chainBaseLog, chainUntracked, chainTruncation, roundRecord,
      chainChangedPaths, chainNewlyChanged, chainStatusObserved, chainDeliverables,
      flagsModel, _dispatchWithFallback: reviewDispatch,
    });
    const chainVerdict = roundRecord.verdict;
    const chainFindingsText = roundRecord.findingsText;
    // ---- stop on review provider exhaustion ----
    if (reviewJobStatus === "provider-error") {
      const { chainState, outcome } = handleProviderExhaustion({
        records, roundRecord,
        currentTierIndex, phase: "review", jobError: reviewJobError,
        chainId, round, container, model, modelChain,
        reviewModel, reviewModelChain,
        reworkModel, reworkModelChain, reworkBackend,
        maxRounds, brief, orchestrator, baseSha: effectiveBaseSha,
        strategized, chainFollowupDraft: null,
        verifyBaseline: effectiveVerifyBaseline,
      });
      writeJson(path.join(chainDir, "round-" + round + ".json"), roundRecord);
      writeJson(path.join(chainDir, "chain.json"), chainState);
      finalizeChainControl({ chainDir, status: "failed", round });
      return { done: true, text: outcome };
    }

    // ---- phase 6: derive disposition ----
    // Malformed-review guard (kusabi #153): `findings` may be a non-array.
    const findingSeverities = Array.isArray(chainParsedReview?.findings)
      ? chainParsedReview.findings.map(function (f) { return f.severity; })
      : undefined;

    // Budget-adjusted round (kusabi #60 step 2): maxRounds buys design/full
    // rounds only; mechanical rounds are free.  The `round` handed to
    // deriveDisposition is the current round's ordinal WITHIN the budget (a
    // mechanical round does not advance it), so the `round >= maxRounds`
    // terminal fires on budget, not raw round count.  The count comes from
    // the records alone (budget is never persisted); a review-resumed round
    // is already in `records`, so it is excluded before counting.
    const budgetUsedBefore = records.filter(function (r) {
      return r !== roundRecord && r.reworkScope !== "mechanical";
    }).length;
    const budgetRound = budgetUsedBefore + (roundRecord.reworkScope !== "mechanical" ? 1 : 0);

    const disposition = deriveDisposition({
      verdict: chainVerdict || "needs-attention",
      probesGreen,
      round: budgetRound,
      maxRounds,
      repeatedAreas: chainRepeatedAreas,
      findingSeverities,
      strategizeEligible: !strategized,
    });
    roundRecord.disposition = disposition;

    // ---- phase 7: record keeping + persistence ----
    // Idempotent push: a review-resumed round is already in `records` (its
    // partial state was persisted at stop time).
    if (!records.includes(roundRecord)) records.push(roundRecord);

    // Compute totals across all rounds so far
    const chainTotals = computeChainTotals(records);

    // When review was skipped, ensure findingsText is set
    if (skipReview && !roundRecord.findingsText) {
      roundRecord.findingsText = "(no review — change set was empty)";
    }

    // Followup draft for accept-with-followup
    let chainFollowupDraft = null;
    if (disposition.disposition === "accept-with-followup" && chainParsedReview?.findings) {
      const briefTitle = brief ? brief.split("\n")[0].trim() : "";
      chainFollowupDraft = renderFollowupDraft({
        chainId,
        briefTitle,
        findings: chainParsedReview.findings,
      });
      roundRecord.followupIssueDraft = chainFollowupDraft;
    }

    // ---- Compute rework strategy for the NEXT round (if rework needed) ----
    let pendingReworkStrategy = null;
    if (disposition.disposition === "rework") {
      // Tier escalation is clamped to the modelChain range (kusabi #153):
      // selectRoutes already keeps dispatch at the top tier, so the
      // recorded tier must match the model actually used — never "0 → 1"
      // on a single-tier chain.  The clamp fields (tierClamped /
      // tierClampReason) land on the round record here.
      // The tier ladder climbs over the chain the NEXT round dispatches on
      // (kusabi #192 axis 2): a rework round addresses the REWORK chain, so
      // the escalation clamps against its tier count — the implement chain's
      // count when no rework chain is configured (unchanged behaviour).
      // The count is backend-aware (kusabi #192 follow-up): a claude-native
      // ladder has an effective tier count of min(1, length), so tierAfter
      // can never exceed 0 on a claude ladder — the model never changes
      // there, and a recorded 0 → 1 would contradict the pinned model.
      const escalation = recordReworkEscalation({
        roundRecord,
        currentTierIndex,
        reworkCount,
        strategized,
        tierCount: effectiveTierCount(effectiveReworkChain, effectiveReworkBackend),
        // Anchoring-override evidence (#62): verdict, probes and the
        // cross-round repeated-areas signal from the finished round.
        chainVerdict,
        chainRepeatedAreas,
        probesGreen,
      });

      // Update cross-round state for the next iteration
      pendingReworkStrategy = escalation.strategy;
      reworkCount += 1;
      currentTierIndex = escalation.currentTierIndex;
    } else if (disposition.disposition === "strategize") {
      // Strategize doesn't consume a rework count, but it sets strategized=true
      // which affects the next rework strategy.
    }

    // Record the pending rework strategy on the round record so the next
    // round can read it, and so chain-show can display what levers were pulled.
    roundRecord.pendingReworkStrategy = pendingReworkStrategy;
    roundRecord.tierAfter = currentTierIndex;

    persistChainState({
      chainDir, round, roundRecord, chainId, container, model, modelChain,
      reviewModel, reviewModelChain,
      reworkModel, reworkModelChain, reworkBackend,
      maxRounds, brief, orchestrator, records, baseSha: effectiveBaseSha,
      chainTotals, strategized, chainFollowupDraft,
      verifyBaseline: effectiveVerifyBaseline,
    });

    // Update the chain control round counter
    updateChainControlRound({ chainDir, round });

    // ---- phase 8: disposition handling ----
    if (disposition.disposition === "accept") {
      finalizeChainControl({ chainDir, status: "completed", round });
      return { done: true, text: finaliseChain(
        renderAcceptOutcome({ chainId, round, chainParsedReview, chainFindingsText }),
        { disposition: "accepted", round },
        round,
      ) };
    }

    if (disposition.disposition === "accept-with-followup") {
      finalizeChainControl({ chainDir, status: "completed", round });
      return { done: true, text: finaliseChain(
        renderAcceptWithFollowupOutcome({ chainId, round, chainParsedReview, chainFindingsText, chainFollowupDraft, brief }),
        { disposition: "accepted-with-followup", round },
        round,
      ) };
    }

    if (disposition.disposition === "escalate") {
      finalizeChainControl({ chainDir, status: "completed", round });
      return { done: true, text: finaliseChain(
        renderEscalateOutcome({ chainId, round, disposition, orchestrator, roundRecord, records }),
        { disposition: "escalated", round, reason: disposition.reason || null },
        round,
      ) };
    }

    // ---- phase 9: strategize (structural re-diagnosis before next rework) ----
    if (disposition.disposition === "strategize") {
      const { strategistJobStatus, strategistJobError } = await runStrategizePhase({
        cwd, chainId, round, brief, previousRecord, roundRecord, modelChain,
        _dispatchWithFallback: injectedDispatch,
      });

      // ---- stop on strategize provider exhaustion ----
      if (strategistJobStatus === "provider-error") {
        // roundRecord was already pushed onto records during phase 7;
        // handleProviderExhaustion detects that and does not push again.
        const { chainState, outcome } = handleProviderExhaustion({
          records, roundRecord,
          currentTierIndex, phase: "strategize", jobError: strategistJobError,
          chainId, round, container, model, modelChain,
          reviewModel, reviewModelChain,
          reworkModel, reworkModelChain, reworkBackend,
          maxRounds, brief, orchestrator, baseSha: effectiveBaseSha,
          strategized, chainFollowupDraft,
          verifyBaseline: effectiveVerifyBaseline,
        });
        writeJson(path.join(chainDir, "round-" + round + ".json"), roundRecord);
        writeJson(path.join(chainDir, "chain.json"), chainState);
        finalizeChainControl({ chainDir, status: "failed", round });
        return { done: true, text: outcome };
      }

      strategized = true;

      // The next round must use a fresh session to break anchoring
      // (docs/design/phase-chain.md §3.4).
      // Set a pendingReworkStrategy so the loop picks it up at phase 1.
      roundRecord.pendingReworkStrategy = {
        tierDelta: 0,
        newSession: true,
        reason: "strategized: new session (anchoring break per docs/design/phase-chain.md §3.4)",
      };

      // Re-persist after strategize updates roundRecord and strategized flag
      const updatedTotals = computeChainTotals(records);
      persistChainState({
        chainDir, round, roundRecord, chainId, container, model, modelChain,
        reviewModel, reviewModelChain,
        reworkModel, reworkModelChain, reworkBackend,
        maxRounds, brief, orchestrator, records, baseSha: effectiveBaseSha,
        chainTotals: updatedTotals, strategized: true, chainFollowupDraft,
        verifyBaseline: effectiveVerifyBaseline,
      });
    }
    return { done: false };
  }

  try {
    // Round loop (kusabi #60 step 2).  The for-condition is the HARD CAP:
    // total rounds never exceed 2 × maxRounds (every mechanical round is
    // bought by the design/full round that preceded it), so a chain can never
    // run unbounded.  The budget check inside the body stops the loop when
    // maxRounds design/full rounds are spent.
    for (let round = startRound; round <= 2 * maxRounds; round++) {
      // ---- stop check: honour file-based stop request or signal ----
      if (shouldStopNow({ chainDir, signalReceived: signalReceived() })) {
        finalizeChainControl({ chainDir, status: "cancelled", round: round - 1 });
        return `Chain ${chainId} cancelled at round ${round} (stop requested).`;
      }

      const isFirstRound = !resume && round === 1;
      const hasPreviousRound = round > 1 && records.length > 0;
      const previousRecord = hasPreviousRound ? records[records.length - 1] : null;

      // ---- review-resume: continue the interrupted round from its review ----
      if (resume && resume.phase === "review" && round === resume.round) {
        const roundRecord = resume.roundRecord;
        roundRecord.resumed = true;
        const reviewCtx = await collectReviewContext({
          container, brief, callTool,
          // The interrupted round's changes ARE the review target.  A baseline
          // captured now would read as "nothing changed since baseline" and
          // skip the review (shouldSkipReview discards an empty change set);
          // use the full changed set instead.
          worktreeBaseline: null,
        });
        const probeCtx = {
          probesGreen: roundRecord.probesGreen ?? false,
          chainChangedPaths: reviewCtx.chainChangedPaths,
          chainNewlyChanged: reviewCtx.chainNewlyChanged,
          chainStatusObserved: reviewCtx.chainStatusObserved,
          chainStatusOutput: reviewCtx.chainStatusOutput,
          chainBaseLog: reviewCtx.chainBaseLog,
          chainDeliverables: reviewCtx.chainDeliverables,
          chainUntracked: reviewCtx.chainUntracked,
          chainTruncation: reviewCtx.chainTruncation,
          worktreeChanged: reviewCtx.worktreeChanged,
        };
        const result = await finishRound({
          round,
          roundRecord,
          // The interrupted round is the last record in `records`; the
          // previous COMPLETE round is the one before it.
          previousRecord: records.length >= 2 ? records[records.length - 2] : null,
          probeCtx,
        });
        if (result.done) return result.text;
        continue;
      }

      // ---- budget check (kusaba #60 step 2) ----
      // maxRounds buys design/full rounds only; mechanical rounds are free.
      // Budget is DERIVED from the records (never persisted), so a resumed
      // chain recomputes it from records alone.  Placed after the
      // review-resume branch: a resumed interrupted round already spent its
      // budget slot and must be allowed to finish its review.
      const budgetUsed = records.filter(function (r) {
        return r.reworkScope !== "mechanical";
      }).length;
      if (budgetUsed >= maxRounds) break;

      // ---- rework scope for this round (kusabi #60 step 2) ----
      // Single decision point: resolveReworkScope maps the previous round's
      // findings to "full" | "mechanical" | "design" plus the scoped subset.
      // The result feeds both the implement brief and the budget accounting;
      // the round record stores the scope it was RUN with.
      const scopeResolution = resolveReworkScope(previousRecord);

      // ---- phase 1: resume strategy (B2: derive rework levers when rework) ----
      let useNewSession = false;
      let reworkStrategyReason = null;
      let reworkStrategy = null;

      if (isFirstRound) {
        // First round: no session to continue from.
        useNewSession = false;
      } else if (previousRecord?.pendingReworkStrategy) {
        // Use the rework strategy computed at the end of the previous round.
        reworkStrategy = previousRecord.pendingReworkStrategy;
        useNewSession = reworkStrategy.newSession;
        reworkStrategyReason = reworkStrategy.reason;
      }

      const { resumeMethod } = resolveRoundResume({ useNewSession });

      // ---- phase 2: round model selection ----
      // Use currentTierIndex (never round) so tier is decoupled from the round counter.
      // For review, the reviewer stays on tier 0 (round 1) — that's handled in
      // runReviewPhase which passes round=1 to dispatchWithFallback.

      // ---- per-round implement dispatch context (kusabi #192 axis 2) ----
      // Round 1 dispatches from the implement resolution; every LATER round
      // is a rework round and dispatches from the rework resolution when
      // models.phases.rework is configured (absent key \u2192 the implement
      // resolution \u2014 byte-identical to today).  The tier ladder climbs over
      // the same chain the round dispatches on: currentTierIndex addresses
      // the implement chain during round 1 and the rework chain from
      // round 2 on (the first rework starts at the rework chain's tier 0).
      const isReworkRound = !isFirstRound;
      const roundModelChain = isReworkRound ? effectiveReworkChain : modelChain;
      const roundBackend = isReworkRound ? effectiveReworkBackend : backend;
      const roundDispatch = isReworkRound ? effectiveReworkDispatch : injectedDispatch;

      // ---- session lineage guard (kusabi #192 invariant 5) ----
      // A session never crosses backends: a rework implement round may only
      // continue a session created by the backend THIS round dispatches on
      // (the rework backend on rework rounds); otherwise it starts fresh.
      // The cross-round `session` is the implement job's session, so when it
      // traces to a record of the OTHER backend (only possible across a
      // chain-resume or a round-1/rework backend switch) it is dropped here,
      // and the same guard inside runImplementPhase covers its
      // previousRecord.sessionID fallback.
      if (session && !isFirstRound && previousRecord && (previousRecord.backend ?? "opencode") !== roundBackend) {
        session = null;
      }

      // ---- phase 3: implement text + dispatch ----
      const implementText = buildImplementText({ round, brief, previousRecord, container, reworkScope: scopeResolution });
      const {
        roundRecord,
        session: resolvedSession,
        implementJobStatus,
        implementJobError,
      } = await runImplementPhase({
        cwd, chainId, round, isFirstRound, implementText, modelChain: roundModelChain,
        tierIndex: currentTierIndex,
        useNewSession, session, previousRecord, resumeMethod, flagsModel,
        backend: roundBackend,
        _dispatchWithFallback: roundDispatch,
      });
      session = resolvedSession;

      // The chain record carries the dispatch backends (kusabi #184 / #192);
      // the phase functions stay backend-blind, so they are stamped here.
      // Round records persist them via persistChainState (round-N.json and
      // the records array in chain.json); readers treat a missing `backend`
      // field as "opencode" and a missing `reviewBackend` as the record's
      // implement backend.  `reviewBackend` is always set.  Each round's
      // `backend` is the backend its implement job ACTUALLY used \u2014 round 1
      // the implement backend, rework rounds the rework backend (axis 2).
      roundRecord.backend = roundBackend;
      roundRecord.reviewBackend = reviewBackend;

      // Record lever info on the round record (B8)
      roundRecord.tierBefore = currentTierIndex;
      roundRecord.reworkStrategyReason = reworkStrategyReason;
      roundRecord.reworkCount = reworkCount;

      // The scope this round was RUN with (kusabi #60 step 2): "full" when
      // not a scoped rework.  Stored verbatim like every other record field;
      // budget is never persisted — it is derived by counting records whose
      // reworkScope is not "mechanical".
      roundRecord.reworkScope = scopeResolution.scope;

      // Resume trace: this round was (re)started by chain-resume.
      if (resume && resume.phase === "implement" && round === resume.round) {
        roundRecord.resumed = true;
      }

      // ---- stop on implement provider exhaustion ----
      if (implementJobStatus === "provider-error") {
        const { chainState, outcome } = handleProviderExhaustion({
          records, roundRecord,
          currentTierIndex, phase: "implement", jobError: implementJobError,
          chainId, round, container, model, modelChain,
          reviewModel, reviewModelChain,
          reworkModel, reworkModelChain, reworkBackend,
          maxRounds, brief, orchestrator, baseSha: effectiveBaseSha,
          strategized, chainFollowupDraft: null,
          verifyBaseline: effectiveVerifyBaseline,
        });
        writeJson(path.join(chainDir, "round-" + round + ".json"), roundRecord);
        writeJson(path.join(chainDir, "chain.json"), chainState);
        finalizeChainControl({ chainDir, status: "failed", round });
        return outcome;
      }

      // ---- phase 4: deterministic probes (P1–P4) ----
      const probeResult = await runProbePhase({
        baseSha: effectiveBaseSha, container, brief, callTool,
        worktreeBaseline: effectiveBaseline, verifyBaseline: effectiveVerifyBaseline,
      });
      roundRecord.probesGreen = probeResult.probesGreen;
      roundRecord.probeResults = probeResult.probeResults;
      roundRecord.worktreeChanged = probeResult.worktreeChanged;

      // ---- stop check: a stop requested during implement must not buy a
      // review job, and must not leave the container busy while the
      // orchestrator inspects it.  Placed after the probes rather than
      // before them so the worktree is left in the canonical post-P1 state
      // (HEAD == base, changes unstaged) that the orchestrator publishes from.
      // The partial round (implement + probes done) is PERSISTED so the chain
      // is resumable (kusabi #153①) and control round matches actual progress.
      if (shouldStopNow({ chainDir, signalReceived: signalReceived() })) {
        const partialTotals = computeChainTotals([...records, roundRecord]);
        persistChainState({
          chainDir, round, roundRecord, chainId, container, model, modelChain,
          reviewModel, reviewModelChain,
          reworkModel, reworkModelChain, reworkBackend,
          maxRounds, brief, orchestrator, records, baseSha: effectiveBaseSha,
          chainTotals: partialTotals, strategized, chainFollowupDraft: null,
          interrupted: true,
          verifyBaseline: effectiveVerifyBaseline,
        });
        finalizeChainControl({ chainDir, status: "cancelled", round });
        return `Chain ${chainId} cancelled during round ${round} (stop requested after probes, before review). Progress preserved — resume with chain-resume ${chainId}.`;
      }

      const result = await finishRound({
        round,
        roundRecord,
        previousRecord,
        probeCtx: probeResult,
      });
      if (result.done) return result.text;
    }

    // ---- max rounds reached without acceptance ----
    // The budget/hard-cap terminal can fire after more than maxRounds RAW
    // rounds (mechanical rounds are free), so the recorded round is the
    // actual number of completed rounds — never the nominal maxRounds —
    // keeping control.round and the review record consistent with the
    // persisted round-N.json files (kusabi #60 step 2 review).
    const actualRounds = records.length;
    finalizeChainControl({ chainDir, status: "completed", round: actualRounds });
    return finaliseChain(
      renderMaxRoundsOutcome({ chainId, maxRounds, records, orchestrator }),
      { disposition: "max-rounds", round: actualRounds },
      actualRounds,
    );
  } catch (err) {
    // Exception thrown mid-round — record failure and rethrow
    finalizeChainControl({ chainDir, status: "failed", round: records.length });
    throw err;
  } finally {
    // Stop the serve for this cwd unless --keep-serve or another job is running
    if (!keepServe) {
      try {
        // liveRunningJobs applies the same fossil rule as cmdServeStop: a
        // `running` record whose driver died (no activity for 6+ hours) does
        // not count as a live job and must not pin the serve (kusabi #175).
        const hasRunning = liveRunningJobs(stateDir).length > 0;
        if (!hasRunning) {
          cmdServeStop(cwd);
        }
      } catch { /* best-effort */ }
    }
  }
}

// ---------------------------------------------------------------------------
// chain-resume (kusabi #153①)
// ---------------------------------------------------------------------------

async function cmdChainResume(cwd, { flags, text }) {
  // Resumption context comes entirely from the saved chain state (chain.json
  // brief, records, ladder; control.json container).  Accepting another flag
  // and ignoring it would answer a different question than the one asked.
  const unsupported = Object.keys(flags).filter(function (k) { return k !== "keepServe"; });
  if (unsupported.length > 0) {
    throw new Error(
      `chain-resume does not support --${unsupported[0]}: resumption context comes from the saved chain state (chain.json / control.json)`
    );
  }

  const stateDir = stateDirFor(cwd);
  const chainId = text.split(/\s+/).filter(Boolean)[0];
  if (!chainId) throw new Error("chain-resume requires a chain id. Usage: chain-resume <chainId>");

  const chainDir = path.join(stateDir, "chains", chainId);
  if (!fs.existsSync(chainDir)) {
    throw new Error(`chain not found: ${chainId}`);
  }

  const control = readChainControl(chainDir);
  const chainJson = readJson(path.join(chainDir, "chain.json"));
  if (!chainJson) {
    throw new Error(`chain.json not found for ${chainId} — the chain never persisted state to resume from`);
  }

  // ---- resume-position decision, from the records alone ----
  const resolution = resolveChainResume({ control, chainJson });
  if (!resolution.ok) {
    throw new Error(`cannot resume chain ${chainId}: ${resolution.error}`);
  }
  const position = resolution.position;

  // ---- mid-flight job guard (#153① review) ----
  // A dead driver (stale pid) may have left a phase job dispatched but not
  // finished; the record then has no phase boundary for it, and resuming
  // would re-dispatch the phase — a duplicate job working the same
  // container worktree.  Any job of this chain still recorded as running
  // blocks the resume: wait for it to finish, or cancel it first.
  const inflight = listJobs(stateDir).filter(function (j) {
    return j.status === "running" && chainIdForJob(j) === chainId;
  });
  if (inflight.length > 0) {
    throw new Error(
      `cannot resume chain ${chainId}: job ${inflight[0].id} is still recorded as running ` +
      `("${inflight[0].title}") — it may be mid-flight from the previous driver. ` +
      `Wait for it to finish (kusabi-companion status ${inflight[0].id}), or cancel it ` +
      `(kusabi-companion cancel ${inflight[0].id}), then retry chain-resume`
    );
  }

  const container = control?.container || chainJson.container;
  if (!container) {
    throw new Error(`cannot resume chain ${chainId}: no container recorded in control.json / chain.json`);
  }

  // ---- container must exist: the chain's work lives in it ----
  // `callTool` throws when sunaba itself is unreachable, but it RESOLVES with
  // an error-shaped result ({ status: "error", error: "Container … not
  // found" }) when the container is missing — treat both as unreachable so
  // the driver never starts against a container that does not exist.
  const { callTool } = await import("./sunaba-rpc.mjs");
  let probe;
  try {
    probe = await callTool("sandbox_exec", {
      container_id: container,
      commands: ["echo kusabi-chain-resume-check"],
    });
  } catch (err) {
    probe = { status: "error", error: err?.message ?? String(err) };
  }
  if (probe?.status === "error") {
    throw new Error(
      `cannot resume chain ${chainId}: container ${container} is not reachable (${probe.error}) — ` +
      `the chain's work lives in that container and it must exist before resuming`
    );
  }

  // ---- re-arm the control record: running again, resume trace kept ----
  // The stop-request fields are cleared: shouldStopNow() keys off
  // stopRequestedAt, and a fresh stop must be requested for the resumed run.
  // `round` reflects actual progress: the interrupted round for a
  // review-resume, the last completed round otherwise.
  rearmChainControl({
    chainDir,
    round: position.phase === "review" ? position.round : position.round - 1,
  });

  // ---- SIGTERM/SIGINT handler feeds the same predicate as the file-based stop ----
  let signalReceived = false;
  const onSignal = () => { signalReceived = true; };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  // ---- dispatch backends (kusabi #184 / #192) ----
  // The backends are not flags here: resumption context comes from the saved
  // chain state, and the chain record's backend fields are part of it.  The
  // implement backend is the last record's `backend`; the review backend is
  // the last record's `reviewBackend`, falling back to the record's
  // implement backend on records predating the per-phase split.  A missing
  // `backend` field means the chain predates the backend split → opencode.
  const lastResumeRecord = chainJson.records?.[chainJson.records.length - 1] ?? null;
  const resumeBackend = lastResumeRecord?.backend || "opencode";
  const resumeReviewBackend = lastResumeRecord?.reviewBackend ?? resumeBackend;

  // The dispatch seams for the resumed run.  The REVIEW seam is always
  // explicit (resolveResumeDispatches): an opencode review gets the plain
  // opencode dispatch, so a mixed chain (implement claude / review opencode)
  // resumes review on opencode — never on the claude implement dispatch
  // (kusabi #192 finding).  Each claude phase clamps to ITS OWN recorded
  // model — no tier ladder, no mid-chain model switch (kusabi #184 finding 1).
  // Per-phase review dispatch context (kusabi #192): a #192-era chain.json
  // persists reviewModel/reviewModelChain \u2014 persisted null on a mixed chain
  // (opencode review) must stay null, never silently borrow the implement
  // chain; a pre-#192 chain.json has neither key, and key ABSENCE is the
  // legacy marker \u2014 fall back to the implement model/chain (pre-#192
  // clamped the whole chain to chainJson.model).
  const { reviewModel: resumeReviewModel, reviewModelChain: resumeReviewModelChain } =
    resolveResumeReviewContext(chainJson);
  const resumeDispatches = resolveResumeDispatches({
    resumeBackend,
    resumeReviewBackend,
    model: chainJson.model ?? null,
    reviewModel: resumeReviewModel,
  });

  // Per-round rework dispatch context (kusabi #192 axis 2): an axis-2
  // chain.json persists reworkModel/reworkModelChain/reworkBackend (null on
  // chains without the models.phases.rework key, in which case rework rounds
  // keep the implement resolution — byte-identical); key ABSENCE is the
  // legacy marker, falling back to the implement values exactly like the
  // review context above.  The rework seam follows the same rule as the
  // review seam: a claude rework backend resumes on the clamped claude
  // dispatch pinned to the recorded rework model, an opencode rework backend
  // on the plain opencode dispatch — never on the implement dispatch of the
  // other backend (mirror of the kusabi #192 review finding).
  const {
    reworkModel: resumeReworkModel,
    reworkModelChain: resumeReworkModelChain,
    reworkBackend: resumeReworkBackend,
  } = resolveResumeReworkContext(chainJson);
  // A null rework backend (no rework key: new chain or legacy chain.json)
  // means rework rounds keep the implement backend — the same `?? backend`
  // rule the fresh-chain driver applies.
  const reworkBackendForResume = resumeReworkBackend ?? resumeBackend;

  try {
    return await runChainDriver({
      cwd, stateDir, chainDir, chainId, container,
      model: chainJson.model ?? null,
      modelChain: chainJson.modelChain,
      reviewModel: resumeReviewModel,
      reviewModelChain: resumeReviewModelChain,
      reworkModel: resumeReworkModel,
      reworkModelChain: resumeReworkModelChain,
      reworkBackend: reworkBackendForResume,
      maxRounds: chainJson.maxRounds ?? 4,
      brief: chainJson.brief ?? "",
      orchestrator: chainJson.orchestrator ?? null,
      baseSha: chainJson.baseSha ?? null,
      worktreeBaseline: null,
      // verifyBaseline (kusabi #173): reuse the baseline recorded in
      // chain.json at chain start — NEVER re-capture on a modified worktree.
      verifyBaseline: chainJson.verifyBaseline ?? null,
      callTool,
      backend: resumeBackend,
      reviewBackend: resumeReviewBackend,
      dispatchWithFallback: resumeDispatches.dispatchWithFallback,
      reviewDispatchWithFallback: resumeDispatches.reviewDispatchWithFallback,
      reworkDispatchWithFallback: reworkBackendForResume === "claude"
        ? clampModelDispatch(claudeDispatch, resumeReworkModel ?? null)
        : dispatchWithFallback,
      initialSession: position.session,
      flagsModel: null,
      signalReceived: () => signalReceived,
      keepServe: !!flags.keepServe,
      resume: position,
    });
  } finally {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  }
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
  return renderChainShow(chainJson, rounds, unreadable, chainControlEarly);
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
 * Ingest Claude Code transcripts, kusabi chain records, and delegated-job
 * records (#154) into a durable SQLite metrics store.  This is the ingest + store step only (issues #83 /
 * #81) -- no reporting/rendering here; that is a follow-up PR.
 *
 * `--dry-run` parses everything but writes to a throwaway in-memory
 * database instead of the real one, so the target db path (and any file at
 * it) is never touched -- not "parse and roll back", but "never opened".
 */
function cmdMetricsIngest(cwd, { flags }) {
  const home = os.homedir();
  const transcriptDir = flags["transcript-dir"] || path.join(home, ".claude", "projects");
  const metricsStateRoot = flags["state-root"] || stateRoot();
  const dryRun = !!flags.dryRun;
  const dbPath = dryRun ? ":memory:" : (flags.db || path.join(metricsStateRoot, "metrics.db"));

  const db = openMetricsDb(dbPath);

  let transcriptSummary;
  let chainSummary;
  let jobSummary;
  db.exec("BEGIN");
  try {
    transcriptSummary = ingestTranscriptDirectory(db, transcriptDir);
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
    "  chain-resume  Resume a cancelled chain from its last recorded phase boundary (reads chain.json / control.json; same chain lifecycle as chain)",
    "  chain-show Print a compact plain-text digest of a chain (read-only, no LLM)",
    "  chain-stats Aggregate every chain record and print a summary (read-only, no LLM)",
    "  metrics-ingest  Ingest transcripts + chain records + delegated-job records into a durable SQLite store (read-only source, no LLM)",
    "  metrics-report  Query/report over the SQLite metrics store (read-only, no LLM, never ingests)",
    "  chain-cancel  Request a running chain to stop (file-based, works across processes)",
    "  status     List recent jobs or show one by ID",
    "  result     Show completed job result (latest, or by ID)",
    "  cancel     Cancel a running job",
    "  serve-stop Stop the background opencode server and remove its state file",
    "  install-agents  Copy phase agent definitions to OPENCODE_AGENT_DIR and skills to OPENCODE_SKILL_DIR",
    "  salvage    Salvage a dead job (inspect progress and produce structured report)",
    "  help       Show this help message",
    "",
    "Flags:",
    "  --read-only, --resume-last, --wait, --background",
    "  --base <ref> (review: branch diff base; task: diff base for --phase review --container, rejected elsewhere), --agent <id>, --phase <name> (draft|investigate|implement|review|respond|salvage|gofer)",
    "  --model <identifier> (task/chain: the identifier CARRIES its backend and decides it for the phases it pins — claude/<model> (bare alias opus|sonnet|haiku or a full model id; a :variant suffix is rejected) runs those phases on claude, provider/model[:variant] runs them on opencode, and a bare alias with no / names no backend, so the phase keeps its configured backend. The model is always validated against the backend the same identifier chose)",
    "  --backend opencode|claude (task/chain: force EVERY phase onto that backend; default opencode. Redundant when --model names a backend — a --backend that disagrees with such a --model is a contradiction and is rejected, naming both. With neither, the config chain entries decide: models.phases.<phase> (or models.chain) entries may carry a claude/ prefix for per-phase backend mixing; one phase's chain must be single-backend)",
    "  --session <id>, --timeout <s>, --watchdog <s>, --deny <tools>",
    "  --brief-file <path> (task / chain: read the brief from a file; exclusive with inline text)",
    "  --container <cid> (chain/task: container to run deterministic probes in; NOT supported by review)",
    "  --keep-serve (chain / chain-resume: keep the serve alive after the chain finishes)",
    "  --force (serve-stop: force kill the serve even when jobs are running)",
    "  --prior <text> (review: prior findings for anti-ratchet)",
    "  --max-rounds <N> (chain: max rounds, default 4)",
    "  --since <ISO> (chain-stats: start of time range, inclusive)",
    "  --until <ISO> (chain-stats: end of time range, exclusive)",
    "  --compare <ISO> (chain-stats: show before/after comparison at cutoff)",
    "  --transcript-dir <path> (metrics-ingest: default ~/.claude/projects)",
    "  --state-root <path> (metrics-ingest: default the kusabi state root, ~/.kusabi)",
    "  --db <path> (metrics-ingest: default <state-root>/metrics.db)",
    "  --dry-run (metrics-ingest: parse and report counts, write nothing)",
    "  --db <path> (metrics-report: default <state-root>/metrics.db)",
    "  --state-root <path> (metrics-report: default the kusabi state root)",
    "  --since <ISO> (metrics-report: window start, inclusive)",
    "  --until <ISO> (metrics-report: window end, exclusive)",
    "  --json (metrics-report: emit the report as one JSON document instead of text)",
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
const JOB_CREATING_SUBCOMMANDS = new Set(["task", "review", "salvage", "chain", "chain-resume"]);

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
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  const parsed = parseArgs(flat);

  // --backend is a task/chain dispatch decision (kusabi #184); on any other
  // subcommand it would be silently ignored — reject it out loud instead.
  if (parsed.flags.backend && subcommand !== "task" && subcommand !== "chain") {
    throw new Error(`--backend is only supported by task and chain (got subcommand ${subcommand ?? "(none)"})`);
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
    case "salvage":
      return cmdSalvage(cwd, parsed);
    case "chain":
      return cmdChain(cwd, parsed);
    case "chain-resume":
    case "chainResume":
      return cmdChainResume(cwd, parsed);
    case "chain-show":
    case "chainShow":
      return cmdChainShow(cwd, parsed);
    case "chain-stats":
    case "chainStats":
      return cmdChainStats(cwd, parsed);
    case "metrics-ingest":
    case "metricsIngest":
      return cmdMetricsIngest(cwd, parsed);
    case "metrics-report":
    case "metricsReport":
      return cmdMetricsReport(cwd, parsed);
    default:
      throw new Error(`unknown subcommand: ${subcommand ?? "(none)"}. Use setup|task|review|chain|chain-resume|chain-show|chain-stats|metrics-ingest|metrics-report|chain-cancel|status|result|cancel|serve-stop|install-agents|salvage`);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then((output) => {
      const { text, exitCode } = commandOutcome(output);
      if (text) process.stdout.write(`${text}\n`);
      process.exit(exitCode);
    })
    .catch((err) => {
      process.stdout.write(`kusabi-companion error: ${err.message}\n`);
      process.exit(1);
    });
}
