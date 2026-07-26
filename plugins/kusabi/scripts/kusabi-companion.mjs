#!/usr/bin/env node
// kusabi-companion: bridge between Claude Code slash commands and an
// on-demand `opencode serve` instance.
//
// Context firewall: every opencode event is persisted under the state dir;
// stdout only ever carries the rendered final result, so the calling Claude
// session never sees intermediate narration, tool logs, or raw events.


import { parseArgs, parseModel, resolveModel, reviewDenyTools, WRITE_TOOL_NAMES, validateChainEntries } from "./cli.mjs";
import { renderReview, renderChainShow, renderJobLine, renderHeader, extractJson, renderFollowupDraft } from "./render.mjs";
import { hasSectionHeading, parseDeliverables, parseSmoke, parseOrchestratorSignature } from "./brief-parsing.mjs";
import { deriveDisposition, deriveReworkStrategy } from "./disposition.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { stateRoot, stateDirFor, readJson } from "./state-paths.mjs";
import { collectChainRecords, computeStats, renderChainStats, renderComparison } from "./chain-stats.mjs";
import { jobDir, saveJob, loadJob, listJobs, latestJob } from "./job-store.mjs";
import { opencodeBin, serverHealthy, ensureServer, reapIdleServes, api } from "./serve-lifecycle.mjs";
import { runPrompt, dispatchWithFallback, resetFailedRoutes } from "./prompt-execution.mjs";

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
  runStrategizePhase,
  renderAcceptOutcome,
  renderAcceptWithFollowupOutcome,
  renderEscalateOutcome,
  renderMaxRoundsOutcome,
  renderProviderExhaustedOutcome,
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
  } catch (err) {
    return `(git ${args.join(" ")} failed: ${String(err.message).slice(0, 200)})\n`;
  }
}

function buildReviewInput(cwd, base) {
  let label;
  let diff;
  if (base) {
    label = `branch diff against ${base}`;
    diff = git(cwd, ["diff", `${base}...HEAD`]);
  } else {
    label = "uncommitted working tree changes";
    diff = git(cwd, ["diff", "HEAD"]) + git(cwd, ["diff", "--cached"]);
  }
  const status = git(cwd, ["status", "--short", "--untracked-files=all"]);
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
// explain helpers — pure functions, exported for testing
// ---------------------------------------------------------------------------

/**
 * Convert an absolute path to the Claude Code directory slug format.
 * Replaces `/` and `.` with `-`.
 * @param {string} cwd - Absolute working directory path
 * @returns {string} Slug, e.g. "/home/u/dev/x" -> "-home-u-dev-x"
 */
export function cwdSlug(cwd) {
  return cwd.replace(/[/.]/g, "-");
}

/**
 * Find the newest `*.jsonl` file under `<baseDir>/<cwdSlug>/`.
 * @param {{ baseDir: string, cwdSlug: string }} opts
 * @returns {string|null} Absolute path to the newest JSONL file, or null if none found.
 */
export function findTranscriptFile({ baseDir, cwdSlug: slug }) {
  const dir = path.join(baseDir, slug);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(function (f) { return f.endsWith(".jsonl"); })
    .map(function (f) {
      const fullPath = path.join(dir, f);
      try {
        return { name: f, mtime: fs.statSync(fullPath).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort(function (a, b) {
      const mtimeDiff = b.mtime - a.mtime;
      if (mtimeDiff !== 0) return mtimeDiff;
      // Tiebreak: lexicographic by name for deterministic selection
      return a.name.localeCompare(b.name);
    });
  return files.length > 0 ? path.join(dir, files[0].name) : null;
}

/**
 * Parse JSONL records from a transcript file.
 * @param {string} filePath
 * @returns {Array<object>}
 */
function parseTranscript(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  return content
    .split("\n")
    .filter(function (line) { return line.trim() !== ""; })
    .map(function (line) { return JSON.parse(line); });
}

/**
 * Extract text passages from the last N assistant (and optionally user)
 * messages in transcript records, excluding tool_use / tool_result / thinking
 * blocks by default.
 *
 * @param {Array<object>} records  - Parsed JSONL records from a transcript.
 * @param {object}        [opts]
 * @param {number}        [opts.lastN=1]         - How many assistant messages to include.
 * @param {boolean}       [opts.includeTools=false] - Also include tool_result blocks.
 * @returns {string} Concatenated text, trimmed.
 */
export function extractAssistantText(records, { lastN = 1, includeTools = false } = {}) {
  // Walk backwards to find indices of the last N assistant records that
  // actually carry a text block.  In real transcripts each content block is
  // its own record, so the trailing assistant records of an in-progress turn
  // are tool_use-only and must be skipped, not treated as "no text found".
  const assistantIndices = [];
  for (let i = records.length - 1; i >= 0 && assistantIndices.length < lastN; i--) {
    if (records[i].type !== "assistant") continue;
    const content = records[i].message?.content;
    if (!Array.isArray(content)) continue;
    if (content.some(function (b) { return b.type === "text" && b.text; })) {
      assistantIndices.unshift(i);
    }
  }

  if (assistantIndices.length === 0) return "";

  // Collect records from the first selected assistant message onward so that
  // interleaved user messages are also included.
  const startIdx = assistantIndices[0];
  const relevantRecords = records.slice(startIdx);

  const parts = [];
  for (let ri = 0; ri < relevantRecords.length; ri++) {
    const record = relevantRecords[ri];
    const content = record.message?.content;
    if (!Array.isArray(content)) continue;
    for (let bi = 0; bi < content.length; bi++) {
      const block = content[bi];
      if (block.type === "text" && block.text) {
        parts.push(block.text);
      } else if (includeTools && block.type === "tool_result") {
        // Real transcripts carry the payload in block.content as a string or
        // an array of {type:"text", text} items; block.text is a fallback.
        const payload = block.content;
        if (typeof payload === "string") {
          parts.push(payload);
        } else if (Array.isArray(payload)) {
          for (const item of payload) {
            if (item && item.type === "text" && item.text) parts.push(item.text);
          }
        } else if (block.text != null) {
          parts.push(block.text);
        }
      }
    }
  }

  return parts.join("\n").trim();
}

/**
 * Resolve the passage to explain: either an explicit `--quote`, or the
 * last assistant text block extracted from the Claude Code session
 * transcript under `<baseDir>/<cwdSlug>/`.
 *
 * Throws a clear error when the transcript is missing, unreadable, empty,
 * or contains no assistant text.  The CLI entry point translates these to
 * non-zero exit.
 *
 * @param {object} opts
 * @param {string}        opts.baseDir - Base directory (e.g. ~/.claude/projects)
 * @param {string}        opts.cwd     - Current working directory
 * @param {string|undefined} opts.quote  - Explicit passage (--quote flag)
 * @param {number}        opts.last    - Positive integer (--last N, default 1)
 * @param {boolean}       opts.tools   - Include tool results (--tools flag)
 * @returns {{ passage: string, source: "quote" | "transcript" }}
 */
export function resolveExplainPassage({ baseDir, cwd, quote, last = 1, tools = false }) {
  // Validate --last: must be a positive integer
  if (!Number.isFinite(last) || last < 1 || !Number.isInteger(last)) {
    throw new Error(`--last must be a positive integer, got: ${String(last)}`);
  }

  if (quote !== undefined) {
    if (quote.trim() === "") {
      throw new Error("--quote must not be empty");
    }
    return { passage: quote, source: "quote" };
  }

  const slug = cwdSlug(cwd);
  const transcriptFile = findTranscriptFile({ baseDir, cwdSlug: slug });

  if (!transcriptFile) {
    throw new Error(
      `No Claude Code transcript found for this directory. ` +
      `Expected a *.jsonl file under ${path.join(baseDir, slug)}. ` +
      `Claude Code may not have created a session transcript yet.`
    );
  }

  let records;
  try {
    records = parseTranscript(transcriptFile);
  } catch (err) {
    throw new Error(`Failed to read transcript ${transcriptFile}: ${err.message}`);
  }

  if (records.length === 0) {
    throw new Error(`Transcript ${transcriptFile} is empty.`);
  }

  const passage = extractAssistantText(records, { lastN: last, includeTools: tools });

  if (!passage) {
    throw new Error(
      `No assistant text found in transcript ${transcriptFile}. ` +
      `The session may not contain any assistant responses yet.`
    );
  }

  return { passage, source: "transcript" };
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

async function cmdExplain(cwd, { flags, text }) {
  if (!text) {
    throw new Error("explain requires a question. Usage: explain <question>");
  }

  // Resolve the passage: explicit --quote or transcript extraction.
  const baseDir = path.join(os.homedir(), ".claude", "projects");
  const last = flags.last === undefined ? 1 : Number(flags.last);
  const { passage } = resolveExplainPassage({
    baseDir,
    cwd,
    quote: flags.quote,
    last,
    tools: !!flags.tools,
  });

  // Build the worker prompt: the extracted passage + the user's question.
  const promptText = [
    "## Context from Claude Code transcript",
    "",
    passage,
    "",
    "## Question",
    "",
    text,
  ].join("\n");

  // Launch a cheap worker via the existing runPrompt path.
  const config = loadConfig(stateRoot());
  // No phase — use the first entry from the global chain (= cheap model).
  const resolved = resolveModel({ flag: flags.model, phase: undefined, config });
  const model = resolved.model;

  const { job, resultText } = await runPrompt({
    cwd,
    kind: "explain",
    title: "explain: " + text.slice(0, 80),
    promptText,
    agent: undefined,
    model,
    session: undefined,
    tools: undefined,
    timeoutS: Number(flags.timeout ?? 120),
    watchdogS: 0,
  });

  if (job.status !== "completed") {
    throw new Error("explain failed: " + (job.error || job.status));
  }

  return resultText || "(empty explanation)";
}

async function cmdReview(cwd, { flags, text }) {
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
    const s = job.stats ?? {};
    return [
      renderHeader(job).trimEnd(),
      `events: ${s.events ?? 0}, steps: ${s.steps ?? 0}, last tool: ${s.lastTool ?? "-"}`,
      `permissions: ${s.permissionsAllowed ?? 0} allowed, ${s.permissionsRejected ?? 0} rejected`,
      `last activity: ${s.lastActivity ?? "-"}`,
      ...(job.error ? [`error: ${job.error}`] : []),
    ].join("\n");
  }
  const jobs = listJobs(stateDir).slice(0, 10);
  if (jobs.length === 0) return "no opencode jobs for this directory yet.";
  return jobs
    .map((j) => renderJobLine(j))
    .join("\n");
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
  return `cancelled ${job.id} (session ${job.sessionID}).`;
}

function cmdServeStop(cwd) {
  const stateDir = stateDirFor(cwd);
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

  // ---- setup ----
  const stateDir = stateDirFor(cwd);
  const config = loadConfig(stateRoot());
  const { model, chain: modelChain } = resolveModel({ flag: flags.model, phase: "implement", config });
  const { chainId, chainDir } = createChainDir(stateDir);
  const container = flags.container;
  if (!container) throw new Error("chain requires --container <cid>");
  const maxRounds = Number(flags["max-rounds"] ?? 4); // B6: default maxRounds is 4
  const brief = text;

  // ---- import callTool once for all phases that need it ----
  const { callTool } = await import("./sunaba-rpc.mjs");

  // ---- reset failed-route memo for a fresh chain run ----
  resetFailedRoutes();

  // ---- chain initialisation: record base + checkpoint ----
  const baseSha = await captureBaseSha(callTool, container);

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

  // ---- round loop state (cross-round) ----
  const records = [];
  let strategized = false;
  let session = flags.session;
  let reworkCount = 0; // how many reworks have been done (B2: tier/session/artifacts)
  let currentTierIndex = 0; // cumulative tier index (starts at 0)

  try {
    for (let round = 1; round <= maxRounds; round++) {
      const isFirstRound = round === 1;
      const hasPreviousRound = round > 1 && records.length > 0;
      const previousRecord = hasPreviousRound ? records[records.length - 1] : null;

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
      // For review, the reviewer stays on tier 0 (round 1) \u2014 that's handled in
      // runReviewPhase which passes round=1 to dispatchWithFallback.

      // ---- phase 3: implement text + dispatch ----
      const implementText = buildImplementText({ round, brief, previousRecord });
      const {
        roundRecord,
        session: resolvedSession,
        implementJobStatus,
        implementJobError,
      } = await runImplementPhase({
        cwd, chainId, round, isFirstRound, implementText, modelChain,
        tierIndex: currentTierIndex,
        useNewSession, session, previousRecord, resumeMethod, flagsModel: flags.model,
      });
      session = resolvedSession;

      // Record lever info on the round record (B8)
      roundRecord.tierBefore = currentTierIndex;
      roundRecord.reworkStrategyReason = reworkStrategyReason;
      roundRecord.reworkCount = reworkCount;

      // ---- stop on implement provider exhaustion ----
      if (implementJobStatus === "provider-error") {
        roundRecord.tierAfter = currentTierIndex;
        records.push(roundRecord);
        const chainTotals = computeChainTotals(records);
        persistChainState({
          chainDir, round, roundRecord, chainId, container, model, modelChain,
          maxRounds, brief, orchestrator, records, baseSha, chainTotals,
          strategized, chainFollowupDraft: null,
        });
        return renderProviderExhaustedOutcome({
          chainId, round, phase: "implement",
          jobError: implementJobError,
          records,
        });
      }

      // ---- phase 4: deterministic probes (P1–P4) ----
      const {
        probesGreen, probeResults, chainChangedPaths, chainStatusObserved,
        chainStatusOutput, chainBaseLog, chainDeliverables, chainDiff, chainUntracked,
      } = await runProbePhase({ baseSha, container, brief, callTool });
      roundRecord.probesGreen = probesGreen;
      roundRecord.probeResults = probeResults;

      // ---- phase 5: review (or skip when change set empty) ----
      const {
        chainVerdict, chainFindingsText, chainParsedReview, chainRepeatedAreas, skipReview,
        reviewJobStatus, reviewJobError,
      } = await runReviewPhase({
        container, brief, modelChain, chainId, cwd, previousRecord, baseSha,
        chainStatusOutput, chainBaseLog, chainDiff, chainUntracked, roundRecord,
        chainChangedPaths, chainStatusObserved, chainDeliverables,
        flagsModel: flags.model,
      });

      // ---- stop on review provider exhaustion ----
      if (reviewJobStatus === "provider-error") {
        roundRecord.tierAfter = currentTierIndex;
        records.push(roundRecord);
        const chainTotals = computeChainTotals(records);
        persistChainState({
          chainDir, round, roundRecord, chainId, container, model, modelChain,
          maxRounds, brief, orchestrator, records, baseSha, chainTotals,
          strategized, chainFollowupDraft: null,
        });
        return renderProviderExhaustedOutcome({
          chainId, round, phase: "review",
          jobError: reviewJobError,
          records,
        });
      }

      // ---- phase 6: derive disposition ----
      const findingSeverities = chainParsedReview?.findings
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
      records.push(roundRecord);

      // Compute totals across all rounds so far
      const chainTotals = computeChainTotals(records);

      // When review was skipped, ensure findingsText is set
      if (skipReview && !roundRecord.findingsText) {
        roundRecord.findingsText = "(no review \u2014 change set was empty)";
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
        pendingReworkStrategy = deriveReworkStrategy({
          reworkCount,
          strategized,
        });

        // Update cross-round state for the next iteration
        reworkCount += 1;
        currentTierIndex += pendingReworkStrategy.tierDelta;
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
        maxRounds, brief, orchestrator, records, baseSha, chainTotals,
        strategized, chainFollowupDraft,
      });

      // ---- phase 8: disposition handling ----
      if (disposition.disposition === "accept") {
        return renderAcceptOutcome({ chainId, round, chainParsedReview, chainFindingsText });
      }

      if (disposition.disposition === "accept-with-followup") {
        return renderAcceptWithFollowupOutcome({ chainId, round, chainParsedReview, chainFindingsText, chainFollowupDraft, brief });
      }

      if (disposition.disposition === "escalate") {
        return renderEscalateOutcome({ chainId, round, disposition, orchestrator, roundRecord, records });
      }

      // ---- phase 9: strategize (structural re-diagnosis before next rework) ----
      if (disposition.disposition === "strategize") {
        const { strategistJobStatus, strategistJobError } = await runStrategizePhase({ cwd, chainId, round, brief, previousRecord, roundRecord, modelChain });

        // ---- stop on strategize provider exhaustion ----
        if (strategistJobStatus === "provider-error") {
          // roundRecord was already pushed onto records during phase 7,
          // so we must NOT push it again -- implement and review
          // provider-error handlers push before phase 7 runs, but
          // strategize runs after phase 7 (which already pushed).
          const chainTotals = computeChainTotals(records);
          persistChainState({
            chainDir, round, roundRecord, chainId, container, model, modelChain,
            maxRounds, brief, orchestrator, records, baseSha, chainTotals,
            strategized, chainFollowupDraft,
          });
          return renderProviderExhaustedOutcome({
            chainId, round, phase: "strategize",
            jobError: strategistJobError,
            records,
          });
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
          maxRounds, brief, orchestrator, records, baseSha,
          chainTotals: updatedTotals, strategized: true, chainFollowupDraft,
        });
        continue;
      }
    }

    // ---- max rounds reached without acceptance ----
    return renderMaxRoundsOutcome({ chainId, maxRounds, records, orchestrator });
  } finally {
    // Stop the serve for this cwd unless --keep-serve or another job is running
    if (!flags.keepServe) {
      try {
        const jobs = listJobs(stateDirFor(cwd));
        const hasRunning = jobs.some(function (j) { return j.status === "running"; });
        if (!hasRunning) {
          cmdServeStop(cwd);
        }
      } catch { /* best-effort */ }
    }
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

  const chainJson = readJson(path.join(chainDir, "chain.json"));
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

  return renderChainShow(chainJson, rounds, unreadable);
}

// ---------------------------------------------------------------------------
// chain-stats
// ---------------------------------------------------------------------------

function cmdChainStats(cwd, { flags }) {
  const stateDir = stateDirFor(cwd);
  const { chains, skipped } = collectChainRecords(stateDir);

  if (chains.length === 0 && skipped === 0) {
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

    if (skipped > 0) {
      lines.push("");
      lines.push(`(unreadable chain.json files skipped: ${skipped})`);
    }

    return lines.join("\n");
  }

  const stats = computeStats(chains, { since, until });
  const lines = [renderChainStats(stats, { since, until })];

  if (skipped > 0) {
    lines.push(`(unreadable chain.json files skipped: ${skipped})`);
  }

  return lines.join("\n");
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
    "  review     Run an adversarial review of working-tree changes",
    "  chain      Run implement→review→rework chain until acceptance or escalate",
    "  chain-show Print a compact plain-text digest of a chain (read-only, no LLM)",
    "  chain-stats Aggregate every chain record and print a summary (read-only, no LLM)",
    "  status     List recent jobs or show one by ID",
    "  result     Show completed job result (latest, or by ID)",
    "  cancel     Cancel a running job",
    "  serve-stop Stop the background opencode server and remove its state file",
    "  install-agents  Copy phase agent definitions to OPENCODE_AGENT_DIR",
    "  salvage    Salvage a dead job (inspect progress and produce structured report)",
    "  explain    Answer a question about the last assistant passage using a cheap worker model",
    "  help       Show this help message",
    "",
    "Flags:",
    "  --read-only, --resume-last, --wait, --background",
    "  --base <ref>, --model <provider/model>, --agent <id>, --phase <name> (draft|investigate|implement|review|respond|salvage|gofer)",
    "  --session <id>, --timeout <s>, --watchdog <s>, --deny <tools>",
    "  --brief-file <path> (task / chain: read the brief from a file; exclusive with inline text)",
    "  --container <cid> (chain/task: container to run deterministic probes in)",
    "  --keep-serve (chain: keep the serve alive after chain finishes)",
    "  --prior <text> (review: prior findings for anti-ratchet)",
    "  --max-rounds <N> (chain: max rounds, default 4)",
    "  --last <N> (explain: include last N assistant/user exchanges, default 1)",
    "  --tools (explain: also include tool results in context)",
    "  --quote <text> (explain: use explicit passage instead of transcript extraction)",
    "  --since <ISO> (chain-stats: start of time range, inclusive)",
    "  --until <ISO> (chain-stats: end of time range, exclusive)",
    "  --compare <ISO> (chain-stats: show before/after comparison at cutoff)",
    "  -h, --help",
    "",
    "Unknown flags cause an error. Use -- to treat subsequent tokens as literal text.",
    "",
    "Serve lifecycle:",
    "  - chain stops its serve on completion unless --keep-serve is passed.",
    "  - serve-stop kills the serve and removes its server.json.",
    "  - Idle serves without running jobs are reaped on next invocation after",
    "    KUSABI_SERVE_TTL_MS (default 30 min).",
  ].join("\n");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  const cwd = process.cwd();

  // Startup reaper: reap idle serves whose last activity is older than TTL.
  // Best-effort; a failure here must never crash the invoking command.
  try {
    const raw = process.env.KUSABI_SERVE_TTL_MS;
    const ttlMs = parseFloat(raw);
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 30 * 60 * 1000;
    reapIdleServes(stateRoot(), ttl);
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
      return cmdServeStop(cwd);
    case "install-agents":
      return cmdInstallAgents();
    case "salvage":
      return cmdSalvage(cwd, parsed);
    case "chain":
      return cmdChain(cwd, parsed);
    case "chain-show":
    case "chainShow":
      return cmdChainShow(cwd, parsed);
    case "chain-stats":
    case "chainStats":
      return cmdChainStats(cwd, parsed);
    case "explain":
      return cmdExplain(cwd, parsed);
    default:
      throw new Error(`unknown subcommand: ${subcommand ?? "(none)"}. Use setup|task|review|chain|chain-show|chain-stats|status|result|cancel|serve-stop|install-agents|salvage|explain`);
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
