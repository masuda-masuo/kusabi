#!/usr/bin/env node
// kusabi-companion: bridge between Claude Code slash commands and an
// on-demand `opencode serve` instance.
//
// Context firewall: every opencode event is persisted under the state dir;
// stdout only ever carries the rendered final result, so the calling Claude
// session never sees intermediate narration, tool logs, or raw events.


import { parseArgs, parseModel, resolveModel, reviewDenyTools, WRITE_TOOL_NAMES, validateChainEntries } from "./cli.mjs";
import { renderReview, renderChainShow, renderJobLine, renderHeader, extractJson, renderFollowupDraft } from "./render.mjs";
import { hasSectionHeading, parseDeliverables, parseSmoke, parseOrchestratorSignature, briefRequestsPublish } from "./brief-parsing.mjs";
import { deriveDisposition } from "./disposition.mjs";
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
import { opencodeBin, serverHealthy, ensureServer, reapIdleServes, reapOrphanedServes, runningRecordIsStale, api } from "./serve-lifecycle.mjs";
import { runPrompt, dispatchWithFallback, resetFailedRoutes } from "./prompt-execution.mjs";
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
  resolveRoundResume,

  buildImplementText,
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
  const resolved = resolveModel({ flag: flags.model, phase, config });
  const modelChain = resolved.chain;

  let session = flags.session;
  if (!session && flags.resumeLast) {
    const prev = latestJob(stateDir, (j) => j.kind === "task" && (!phase || j.phase === phase));
    session = prev?.sessionID;
    if (!session) {
      throw new Error(phase
        ? `--resume-last: no previous ${phase} session found for this directory`
        : "--resume-last: no previous task session found for this directory");
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

  const guardrails = fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", "task-guardrails.md"), "utf8").trim();
  const { job, resultText } = await dispatchWithFallback({
    cwd,
    kind: "task",
    title: text.slice(0, 80),
    promptText: `${guardrails}\n\n<task>\n${text}\n</task>`,
    agent,
    phase,
    session,
    tools,
    timeoutS: Number(flags.timeout ?? DEFAULT_TASK_TIMEOUT_S),
    watchdogS: Number(flags.watchdog ?? DEFAULT_WATCHDOG_S),
    tiers: modelChain,
    round: 1,
    explicitModel: flags.model || null,
  });

  // Store the resolved model chain and orchestrator on the job record
  job.modelChain = modelChain;
  job.orchestrator = orchestrator;

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
  const rendered = renderReview(extractJson(stripped), resultText);
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

async function cmdCancel(cwd, { text }) {
  const stateDir = stateDirFor(cwd);
  const jobId = text.split(/\s+/).filter(Boolean)[0];
  const job = jobId ? loadJob(stateDir, jobId) : latestJob(stateDir, (j) => j.status === "running");
  if (!job) return jobId ? `no such job: ${jobId}` : "no running jobs to cancel.";
  if (job.status !== "running") return `${job.id} is not running (status: ${job.status}).`;
  const server = readJson(path.join(stateDir, "server.json"));
  if (await serverHealthy(server)) {
    await api(server, "POST", `/session/${job.sessionID}/abort`).catch(() => {});
  }
  job.status = "cancelled";
  job.finishedAt = new Date().toISOString();
  saveJob(stateDir, job);

  // A job that belongs to a chain does not stop the chain: cancelling it only
  // ends one phase, and the chain starts the next round.  Say so — but say what
  // was actually observed, not an assumption about the chain's state.
  const chainId = chainIdForJob(job);
  if (chainId) {
    const control = readChainControl(path.join(stateDir, "chains", chainId));
    const { status } = effectiveStatus(control);
    const lines = [`cancelled ${job.id} (session ${job.sessionID}).`];
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
    return lines.join("\n");
  }

  return `cancelled ${job.id} (session ${job.sessionID}).`;
}

function cmdServeStop(cwd, { flags } = {}) {
  const stateDir = stateDirFor(cwd);

  // Check for running jobs. If any exist, decline unless --force is passed.
  // A `running` record whose last activity is older than 6 hours is a fossil
  // (the driver died without rewriting it) and does not count — it must not
  // block stopping the serve (kusabi #162 follow-up).
  const jobs = listJobs(stateDir);
  const runningJobs = jobs.filter(function (j) { return j.status === "running" && !runningRecordIsStale(j); });
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

function cmdInstallAgents() {
  const src = path.join(PLUGIN_ROOT, "opencode-agents");
  const dest = process.env.OPENCODE_AGENT_DIR || path.join(os.homedir(), ".config", "opencode", "agent");
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
  return `installed ${files.length} phase agents to ${dest} (removed ${removed} stale legacy names)`;
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
  const { model, chain: modelChain } = resolveModel({ flag: flags.model, phase: "implement", config });
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

  // ---- chain-start output: state tiers, maxRounds, and ladder info (B7) ----
  const tierCount = modelChain ? modelChain.length : 0;
  if (tierCount > 0) {
    // The ladder can climb to tier (tierCount - 1). With the default ladder,
    // the 1st rework uses tier 0 (same), 2nd uses tier 1 (+1), 3rd uses tier 2 (+1).
    // The top tier is reached at round: 1 (initial) + (tierCount) reworks.
    const roundsToTopTier = 1 + tierCount; // initial + one rework per tier beyond 0
    const canReachTop = maxRounds >= roundsToTopTier;
    process.stdout.write(
      "Chain " + chainId + ": tiers=" + tierCount + ", maxRounds=" + maxRounds +
      (canReachTop ? " (can reach top tier)" : " (maxRounds insufficient to reach top tier)") +
      "\n"
    );
  }

  try {
    return await runChainDriver({
      cwd, stateDir, chainDir, chainId, container, model, modelChain, maxRounds,
      brief, orchestrator, baseSha, worktreeBaseline, callTool,
      initialSession: flags.session,
      flagsModel: flags.model,
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
 * @param {Function} opts.callTool
 * @param {Function} [opts.dispatchWithFallback] — injection seam (defaults to
 *        the real dispatchWithFallback; phase functions receive it as their
 *        own _dispatchWithFallback seam).
 * @param {string} [opts.initialSession]
 * @param {string|null} [opts.flagsModel]
 * @param {Function} [opts.signalReceived]  — getter: has SIGTERM/SIGINT fired?
 * @param {boolean} [opts.keepServe]
 * @param {object|null} [opts.resume]       — resolveChainResume position or null.
 * @returns {Promise<string>} Outcome text for the operator.
 */
export async function runChainDriver({
  cwd, stateDir, chainDir, chainId, container, model, modelChain, maxRounds,
  brief, orchestrator, baseSha, worktreeBaseline, callTool,
  dispatchWithFallback: injectedDispatch = dispatchWithFallback,
  initialSession, flagsModel = null, signalReceived = () => false,
  keepServe = false, resume = null,
}) {
  // baseSha: a resume keeps the ORIGINAL chain base — the resumed round's diff
  // is measured against it (P1 auto-resets HEAD to it); a fresh chain captures
  // it from the container.
  const effectiveBaseSha = baseSha ?? await captureBaseSha(callTool, container);
  // worktreeBaseline: captured once per run.  A resumed chain re-captures at
  // resume time — the pre-cancel baseline is not persisted, and the resumed
  // run measures what IT changes from here on.  The interrupted round's
  // review-resume path deliberately bypasses it (see collectReviewContext).
  const effectiveBaseline = worktreeBaseline ?? await captureWorktreeState(callTool, container);

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
      chainStatusOutput, chainBaseLog, chainDeliverables, chainDiff, chainUntracked,
    } = probeCtx;

    // ---- phase 5: review (or skip when change set empty) ----
    const {
      chainVerdict, chainFindingsText, chainParsedReview, chainRepeatedAreas, skipReview,
      reviewJobStatus, reviewJobError,
    } = await runReviewPhase({
      container, brief, modelChain, chainId, cwd, previousRecord, baseSha: effectiveBaseSha,
      chainStatusOutput, chainBaseLog, chainDiff, chainUntracked, roundRecord,
      chainChangedPaths, chainNewlyChanged, chainStatusObserved, chainDeliverables,
      flagsModel, _dispatchWithFallback: injectedDispatch,
    });

    // ---- stop on review provider exhaustion ----
    if (reviewJobStatus === "provider-error") {
      const { chainState, outcome } = handleProviderExhaustion({
        records, roundRecord,
        currentTierIndex, phase: "review", jobError: reviewJobError,
        chainId, round, container, model, modelChain,
        maxRounds, brief, orchestrator, baseSha: effectiveBaseSha,
        strategized, chainFollowupDraft: null,
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

    const disposition = deriveDisposition({
      verdict: chainVerdict || "needs-attention",
      probesGreen,
      round,
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
      const escalation = recordReworkEscalation({
        roundRecord,
        currentTierIndex,
        reworkCount,
        strategized,
        tierCount: modelChain ? modelChain.length : 0,
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
      maxRounds, brief, orchestrator, records, baseSha: effectiveBaseSha,
      chainTotals, strategized, chainFollowupDraft,
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
          maxRounds, brief, orchestrator, baseSha: effectiveBaseSha,
          strategized, chainFollowupDraft,
        });
        writeJson(path.join(chainDir, "round-" + round + ".json"), roundRecord);
        writeJson(path.join(chainDir, "chain.json"), chainState);
        finalizeChainControl({ chainDir, status: "failed", round });
        return { done: true, text: outcome };
      }

      strategized = true;

      // The next round must use a fresh session to break anchoring (§3.4).
      // Set a pendingReworkStrategy so the loop picks it up at phase 1.
      roundRecord.pendingReworkStrategy = {
        tierDelta: 0,
        newSession: true,
        reason: "strategized: new session (anchoring break per §3.4)",
      };

      // Re-persist after strategize updates roundRecord and strategized flag
      const updatedTotals = computeChainTotals(records);
      persistChainState({
        chainDir, round, roundRecord, chainId, container, model, modelChain,
        maxRounds, brief, orchestrator, records, baseSha: effectiveBaseSha,
        chainTotals: updatedTotals, strategized: true, chainFollowupDraft,
      });
    }
    return { done: false };
  }

  try {
    for (let round = startRound; round <= maxRounds; round++) {
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
          chainDiff: reviewCtx.chainDiff,
          chainUntracked: reviewCtx.chainUntracked,
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

      // ---- phase 3: implement text + dispatch ----
      const implementText = buildImplementText({ round, brief, previousRecord, container });
      const {
        roundRecord,
        session: resolvedSession,
        implementJobStatus,
        implementJobError,
      } = await runImplementPhase({
        cwd, chainId, round, isFirstRound, implementText, modelChain,
        tierIndex: currentTierIndex,
        useNewSession, session, previousRecord, resumeMethod, flagsModel,
        _dispatchWithFallback: injectedDispatch,
      });
      session = resolvedSession;

      // Record lever info on the round record (B8)
      roundRecord.tierBefore = currentTierIndex;
      roundRecord.reworkStrategyReason = reworkStrategyReason;
      roundRecord.reworkCount = reworkCount;

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
          maxRounds, brief, orchestrator, baseSha: effectiveBaseSha,
          strategized, chainFollowupDraft: null,
        });
        writeJson(path.join(chainDir, "round-" + round + ".json"), roundRecord);
        writeJson(path.join(chainDir, "chain.json"), chainState);
        finalizeChainControl({ chainDir, status: "failed", round });
        return outcome;
      }

      // ---- phase 4: deterministic probes (P1–P4) ----
      const probeResult = await runProbePhase({
        baseSha: effectiveBaseSha, container, brief, callTool, worktreeBaseline: effectiveBaseline,
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
          maxRounds, brief, orchestrator, records, baseSha: effectiveBaseSha,
          chainTotals: partialTotals, strategized, chainFollowupDraft: null,
          interrupted: true,
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
    finalizeChainControl({ chainDir, status: "completed", round: maxRounds });
    return finaliseChain(
      renderMaxRoundsOutcome({ chainId, maxRounds, records, orchestrator }),
      { disposition: "max-rounds", round: maxRounds },
      maxRounds,
    );
  } catch (err) {
    // Exception thrown mid-round — record failure and rethrow
    finalizeChainControl({ chainDir, status: "failed", round: records.length });
    throw err;
  } finally {
    // Stop the serve for this cwd unless --keep-serve or another job is running
    if (!keepServe) {
      try {
        const jobs = listJobs(stateDir);
        const hasRunning = jobs.some(function (j) { return j.status === "running"; });
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

  try {
    return await runChainDriver({
      cwd, stateDir, chainDir, chainId, container,
      model: chainJson.model ?? null,
      modelChain: chainJson.modelChain,
      maxRounds: chainJson.maxRounds ?? 4,
      brief: chainJson.brief ?? "",
      orchestrator: chainJson.orchestrator ?? null,
      baseSha: chainJson.baseSha ?? null,
      worktreeBaseline: null,
      callTool,
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
 * DESIGN.md 3.5.9.
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
    "  install-agents  Copy phase agent definitions to OPENCODE_AGENT_DIR",
    "  salvage    Salvage a dead job (inspect progress and produce structured report)",
    "  help       Show this help message",
    "",
    "Flags:",
    "  --read-only, --resume-last, --wait, --background",
    "  --base <ref>, --model <provider/model>, --agent <id>, --phase <name> (draft|investigate|implement|review|respond|salvage|gofer)",
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
    reapIdleServes(root, ttl);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then((output) => {
      if (output) process.stdout.write(`${output}\n`);
      process.exit(0);
    })
    .catch((err) => {
      process.stdout.write(`kusabi-companion error: ${err.message}\n`);
      process.exit(1);
    });
}
