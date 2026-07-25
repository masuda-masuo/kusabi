#!/usr/bin/env node
// kusabi-companion: bridge between Claude Code slash commands and an
// on-demand `opencode serve` instance.
//
// Context firewall: every opencode event is persisted under the state dir;
// stdout only ever carries the rendered final result, so the calling Claude
// session never sees intermediate narration, tool logs, or raw events.

import crypto from "node:crypto";
import { parseArgs, parseModel, resolveModel, implementDenyTools, reviewDenyTools, WRITE_TOOL_NAMES } from "./cli.mjs";
import { renderBaseFacts, renderStrategistPrompt, renderReview, renderChainShow, renderJobLine, renderFollowupDraft, renderHeader, durationS, extractJson } from "./render.mjs";
import { hasSectionHeading, parseDeliverables, parseSmoke, parseChangedPaths, parseOrchestratorSignature } from "./brief-parsing.mjs";
import { checkDeliverablesProbe, checkSmokeProbe } from "./probe-decisions.mjs";
import { deriveDisposition, resolveResumeMethod } from "./disposition.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { stateRoot, stateDirFor, readJson, writeJson } from "./state-paths.mjs";
import { jobDir, saveJob, loadJob, listJobs, latestJob } from "./job-store.mjs";
import { opencodeBin, serverHealthy, ensureServer, reapIdleServes, api } from "./serve-lifecycle.mjs";
import { runPrompt } from "./prompt-execution.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const DEFAULT_TASK_TIMEOUT_S = 3600;
const DEFAULT_REVIEW_TIMEOUT_S = 1800;
const DEFAULT_WATCHDOG_S = 900; // must be > opencode mcp_timeout (600s) so inner timeout trips first
const REVIEW_DIFF_LIMIT = 200_000;


/**
 * Pure function: determine the resume method strategy for a chain round.
 *
 * Round 1 always continues fresh (no prior session).
 * After a strategize intervention, the next rework must use a fresh session
 * (checkpoint_restore) to break anchoring per §3.4.
 * Otherwise: round 2 continues the same session; round 3+ forces fresh.
 *
 * @param {object} opts
 * @param {number}  opts.round       — 1-based round number
 * @param {boolean} opts.strategized — true when a strategize has occurred earlier in the chain
 * @returns {{ type: "continue_session" | "fresh_session" }}
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
      if (!Array.isArray(models.chain) || !models.chain.every((m) => typeof m === "string")) {
        throw new Error(`kusabi config file ${configPath}: "models.chain" must be an array of strings`);
      }
      if (models.chain.length === 0) {
        throw new Error(`kusabi config file ${configPath}: "models.chain" must not be empty (omit it to use the built-in default chain)`);
      }
    }
    if (models.phases !== undefined) {
      if (typeof models.phases !== "object" || Array.isArray(models.phases) || models.phases === null) {
        throw new Error(`kusabi config file ${configPath}: "models.phases" must be a JSON object`);
      }
      for (const [phaseName, chain] of Object.entries(models.phases)) {
        if (!Array.isArray(chain) || !chain.every((m) => typeof m === "string")) {
          throw new Error(`kusabi config file ${configPath}: "models.phases.${phaseName}" must be an array of strings`);
        }
        if (chain.length === 0) {
          throw new Error(`kusabi config file ${configPath}: "models.phases.${phaseName}" must not be empty (omit it to fall back to the global chain)`);
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
// runSmokeEntry / runSmokeProbe  —  executes smoke commands via output
// redirection so the exit-code marker is never subject to sandbox_exec's
// pagination truncation.  callTool is injectable for testing.
// ---------------------------------------------------------------------------

/**
 * Read a bounded tail of a smoke command's captured output for diagnostics.
 *
 * @param {Function} callTool   The RPC callTool function.
 * @param {string}   container  Container ID.
 * @param {string}   outfile    Path to the captured-output file.
 * @returns {Promise<string>}  At most ~2000 bytes of tail text.
 */
async function readSmokeOutputTail(callTool, container, outfile) {
  try {
    const result = await callTool("sandbox_exec", {
      container_id: container,
      commands: [
        // Bounded by lines *and* bytes: this diagnostic read goes through the
        // same paginated sandbox_exec, so a file of very short lines could
        // otherwise be re-truncated by the very mechanism this probe avoids.
        `if [ -f "${outfile}" ]; then tail -n 40 "${outfile}" | tail -c 2000; else echo '(no output)'; fi`,
      ],
    });
    const output = ((result?.output ?? "") + (result?.stderr ?? "")).trim();
    return output || "(empty)";
  } catch {
    return "(diagnostics unavailable)";
  }
}

/**
 * Run a single smoke command entry and observe its exit code.
 *
 * The command's stdout/stderr is redirected to a file inside the container so
 * that the **only** text returned by sandbox_exec is the `SMOKE_EXIT=N` marker
 * line — never subject to pagination truncation regardless of how much output
 * the command produces.
 *
 * @param {object}   opts
 * @param {{command: string, expectedExit: number}} opts.entry
 * @param {Function} opts.callTool    The RPC callTool function (injectable).
 * @param {string}   opts.container   Container ID.
 * @param {number}   opts.entryIndex  Index within the entries array (for unique filename).
 * @returns {Promise<{command: string, observed: number|string, diagnostic?: string}>}
 */
export async function runSmokeEntry({ entry, callTool, container, entryIndex }) {
  const outfile = `/tmp/kusabi-smoke-${Date.now()}-${entryIndex}.log`;
  // Wrap in a subshell so redirection applies to the entire declared command,
  // including pipelines, &&/|| chains, semicolons, and quoted shell invocations.
  const wrappedCommand = `( ${entry.command} ) >${outfile} 2>&1; echo SMOKE_EXIT=$?`;

  try {
    const smokeResult = await callTool("sandbox_exec", {
      container_id: container,
      commands: [wrappedCommand],
      timeout: 300,
    });

    // A command timeout comes back as *data*, not as a thrown error:
    // sandbox_exec returns {status:"timeout", exit_code:124} and the shell is
    // killed before it can echo the marker.  Without this check a timeout
    // would be misreported as "could not be observed" — the same category
    // error (probe outcome vs command outcome) this probe exists to avoid.
    if (smokeResult?.status === "timeout") {
      const diagnostic = await readSmokeOutputTail(callTool, container, outfile);
      return { command: entry.command, observed: "timeout", diagnostic };
    }

    const smokeOutput = (smokeResult?.output ?? "") + (smokeResult?.stderr ?? "");
    const exitMatches = [...smokeOutput.matchAll(/SMOKE_EXIT=(\d+)/g)];
    const lastMatch = exitMatches.length > 0 ? exitMatches[exitMatches.length - 1] : null;

    if (!lastMatch) {
      // Marker not found in sandbox_exec output — observation failed.
      const diagnostic = await readSmokeOutputTail(callTool, container, outfile);
      return { command: entry.command, observed: "unobservable", diagnostic };
    }

    const exitCode = parseInt(lastMatch[1], 10);

    // Only fetch diagnostic on failure (mismatch)
    if (exitCode !== entry.expectedExit) {
      const diagnostic = await readSmokeOutputTail(callTool, container, outfile);
      return { command: entry.command, observed: exitCode, diagnostic };
    }

    return { command: entry.command, observed: exitCode };
  } catch (smokeErr) {
    const isTimeout = String(smokeErr).includes("timeout");
    const diagnostic = isTimeout
      ? await readSmokeOutputTail(callTool, container, outfile).catch(() => "")
      : undefined;
    return {
      command: entry.command,
      observed: isTimeout ? "timeout" : String(smokeErr),
      diagnostic,
    };
  }
}

/**
 * Run all smoke entries and return the P4 probe result.
 *
 * @param {object}   opts
 * @param {Array<{command: string, expectedExit: number}>} opts.entries
 * @param {Function} opts.callTool       The RPC callTool function (injectable).
 * @param {string}   opts.container      Container ID.
 * @param {boolean}  opts.headingPresent Whether the ## Smoke heading was found.
 * @returns {Promise<{probe: string, passed: boolean, detail: string}>}
 */
export async function runSmokeProbe({ entries, callTool, container, headingPresent }) {
  const entriesArr = Array.isArray(entries) ? entries : [];
  const hdgPresent = !!headingPresent;

  if (entriesArr.length === 0) {
    return checkSmokeProbe([], [], hdgPresent);
  }

  const observed = [];
  for (let i = 0; i < entriesArr.length; i++) {
    const result = await runSmokeEntry({ entry: entriesArr[i], callTool, container, entryIndex: i });
    observed.push(result);
  }

  return checkSmokeProbe(entriesArr, observed, true);
}

// ---------------------------------------------------------------------------
// runHeadCleanProbe / runVerifyProbe / runDeliverablesProbe  —  P1, P2, P3
// deterministic probes extracted from cmdTask/cmdChain duplication.
// callTool is injectable for testing.
// ---------------------------------------------------------------------------

/**
 * P1: Check that HEAD matches the recorded base SHA.
 * When HEAD differs, auto-reset via git reset --mixed.
 *
 * @param {object}   opts
 * @param {string}   opts.baseSha       The base SHA recorded at start.
 * @param {Function} opts.callTool      The RPC callTool function (injectable).
 * @param {string}   opts.container     Container ID.
 * @param {string}   [opts.sourceLabel] Label for "baseSha not recorded" message
 *                                       (e.g. "task" or "chain").
 * @returns {Promise<{probe: string, passed: boolean, detail: string}>}
 */
export async function runHeadCleanProbe({ baseSha, callTool, container, sourceLabel = "task" }) {
  let passed = false;
  let detail = "";
  if (baseSha) {
    // A failing rev-parse is deliberately left to propagate: it means the
    // container is not answering, which is an incident for the whole probe
    // sequence to report, not a P1 opinion to record and carry on from.
    const gitRev = await callTool("sandbox_exec", {
      container_id: container,
      commands: ["git rev-parse HEAD"],
    });
    const headSha = (gitRev?.output ?? "").trim();
    if (headSha !== baseSha) {
      detail = "HEAD " + headSha + " != base " + baseSha + "; auto reset";
      try {
        await callTool("sandbox_exec", {
          container_id: container,
          commands: ["git reset --mixed " + baseSha],
        });
        passed = true;
        detail += " - reset OK";
      } catch (resetErr) {
        detail += " - reset FAILED: " + String(resetErr);
      }
    } else {
      passed = true;
      detail = "HEAD matches base " + baseSha;
    }
  } else {
    detail = "baseSha not recorded at " + sourceLabel + " start; cannot check HEAD";
  }
  return { probe: "P1: HEAD clean", passed, detail };
}

/**
 * P2: Run the verify gate (verify_in_container) with no skip flags.
 *
 * @param {object}   opts
 * @param {Function} opts.callTool      The RPC callTool function (injectable).
 * @param {string}   opts.container     Container ID.
 * @returns {Promise<{probe: string, passed: boolean, detail: string}>}
 */
export async function runVerifyProbe({ callTool, container }) {
  const verifyResult = await callTool("verify_in_container", {
    container_id: container,
    path: ".",
  });
  const passed = verifyResult?.gate_passed === true;
  return { probe: "P2: verify gate", passed, detail: JSON.stringify(verifyResult) };
}

/**
 * P3: Check that changed files touch declared deliverables.
 *
 * Returns the probe result with extra properties `changedPaths` and
 * `statusOutput` attached for the chain call site which needs the raw
 * change set data for the reviewer.
 *
 * @param {object}   opts
 * @param {string[]} opts.deliverables      Parsed deliverable paths.
 * @param {boolean}  opts.headingPresent    Whether ## Deliverables heading found.
 * @param {Function} opts.callTool          The RPC callTool function (injectable).
 * @param {string}   opts.container         Container ID.
 * @returns {Promise<{probe: string, passed: boolean, detail: string, changedPaths: string[], statusOutput: string}>}
 */
export async function runDeliverablesProbe({ deliverables, headingPresent, callTool, container }) {
  const statusResult = await callTool("sandbox_exec", {
    container_id: container,
    commands: ["git status --porcelain"],
  });
  const statusOutput = statusResult?.output ?? "";
  const changedPaths = parseChangedPaths(statusOutput);
  const probeResult = checkDeliverablesProbe(deliverables, changedPaths, headingPresent);
  // Attach side data for chain's use (the reviewer needs change set info)
  probeResult.changedPaths = changedPaths;
  probeResult.statusOutput = statusOutput;
  return probeResult;
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
  const model = resolved.model;
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
  const { job, resultText } = await runPrompt({
    cwd,
    kind: "task",
    title: text.slice(0, 80),
    promptText: `${guardrails}\n\n<task>\n${text}\n</task>`,
    agent,
    phase,
    model,
    session,
    tools,
    timeoutS: Number(flags.timeout ?? DEFAULT_TASK_TIMEOUT_S),
    watchdogS: Number(flags.watchdog ?? DEFAULT_WATCHDOG_S),
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
  try {
    const stateDir = stateDirFor(cwd);
    const config = loadConfig(stateRoot());
  const resolved = resolveModel({ flag: flags.model, phase: "implement", config });
  const model = resolved.model;
  const modelChain = resolved.chain;

  const chainId = `chain-${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
  const chainDir = path.join(stateDir, "chains", chainId);
  fs.mkdirSync(chainDir, { recursive: true });

  const container = flags.container;
  if (!container) throw new Error("chain requires --container <cid>");
  const maxRounds = Number(flags["max-rounds"] ?? 3);
  const brief = text;

  // ---- chain initialisation: record base + checkpoint ----
  let baseSha = null;
  try {
    const { callTool } = await import("./sunaba-rpc.mjs");
    const gitRev = await callTool("sandbox_exec", {
      container_id: container,
      commands: ["git rev-parse HEAD"],
    });
    baseSha = (gitRev?.output ?? "").trim() || null;
  } catch (initErr) {
    // Record initialisation failure; probes will catch it per-round
    baseSha = null;
  }

  const records = [];
  let strategized = false;

  for (let round = 1; round <= maxRounds; round += 1) {
    const isFirstRound = round === 1;
    const hasPreviousRound = round > 1 && records.length > 0;
    const previousRecord = hasPreviousRound ? records[records.length - 1] : null;

    // Resume strategy: pure function decides continue vs fresh session
    const resumeStrategy = resolveResumeMethod({ round, strategized });
    const useNewSession = resumeStrategy.type === "fresh_session";
    let resumeMethod;
    if (useNewSession) {
      // Actually attempt checkpoint_restore; record outcome honestly
      let restoreOk = false;
      let restoreDetail = null;
      if (baseSha) {
        try {
          const { callTool } = await import("./sunaba-rpc.mjs");
          await callTool("checkpoint_restore", {
            container_id: container,
            sha: baseSha,
          });
          restoreOk = true;
        } catch (restoreErr) {
          restoreDetail = String(restoreErr);
        }
      } else {
        restoreDetail = "baseSha was never recorded at chain start";
      }
      resumeMethod = {
        type: restoreOk ? "checkpoint_restore" : "checkpoint_restore_failed",
        base: baseSha,
        detail: restoreDetail,
      };
    } else {
      resumeMethod = { type: "continue_session" };
    }
    // ---- resolve round-specific model ----
    // Round 1: use --model if provided, else chain entry 0 (already in `model`).
    // Round 2+: use chain entry (round-1), clamped to last entry.
    let roundModel;
    if (isFirstRound && flags.model) {
      roundModel = model;  // --model overrides round 1
    } else {
      const chainIdx = Math.min(round - 1, modelChain.length - 1);
      const entry = modelChain[chainIdx];
      roundModel = parseModel(entry);
    }
    const roundModelEntry = (roundModel && roundModel.variant)
      ? roundModel.providerID + "/" + roundModel.modelID + ":" + roundModel.variant
      : (roundModel ? roundModel.providerID + "/" + roundModel.modelID : null);

    const roundRecord = { round, resumeMethod, startedAt: new Date().toISOString(), verdict: null, probesGreen: false, modelEntry: roundModelEntry, modelVariant: roundModel?.variant || null };

    let implementText;
    if (isFirstRound) {
      implementText = brief;
    } else if (previousRecord) {
      var strategistSection = "";
      if (previousRecord.strategistRecommendation) {
        strategistSection = "\n\n## Strategist recommendation (structural change for this rework)\n" + previousRecord.strategistRecommendation + "\n";
      }
      implementText = "## Prior findings\n" + (previousRecord.findingsText || "(none)") + strategistSection + "\n\n## Acceptance criteria\n" + brief;
    } else {
      implementText = brief;
    }

    // ---- implement phase ----
    let session = flags.session;
    if (!session && !isFirstRound && previousRecord?.sessionID) {
      if (!useNewSession) {
        session = previousRecord.sessionID;
      }
    }

    const implementJob = await runPrompt({
      cwd,
      kind: "task",
      title: "chain: " + chainId + " round " + round + " implement",
      promptText: implementText,
      agent: "kusabi-implement",
      phase: "implement",
      model: roundModel,
      session: useNewSession ? undefined : session,
      tools: implementDenyTools(),
      timeoutS: 3600,
      watchdogS: 900,
    });
    roundRecord.implementJobId = implementJob.job.id;
    roundRecord.sessionID = implementJob.job.sessionID;
    roundRecord.implementUsage = implementJob.job.usage || null;

    // ---- deterministic probes (via sunaba-rpc) ----
    let probesGreen = false;
    const probeResults = [];
    let chainChangedPaths = [];
    let chainStatusObserved = false;
    let chainStatusOutput = "";
    let chainBaseLog = "";
    const chainDeliverables = parseDeliverables(brief);

    try {
      const { callTool } = await import("./sunaba-rpc.mjs");

      const p1Result = await runHeadCleanProbe({ baseSha, callTool, container, sourceLabel: "chain" });
      probeResults.push(p1Result);

      const p2Result = await runVerifyProbe({ callTool, container });
      probeResults.push(p2Result);

      const p3Result = await runDeliverablesProbe({
        deliverables: chainDeliverables,
        headingPresent: hasSectionHeading(brief, "Deliverables"),
        callTool,
        container,
      });
      chainChangedPaths = p3Result.changedPaths;
      chainStatusOutput = p3Result.statusOutput;
      chainStatusObserved = true;
      probeResults.push(p3Result);

      // P4: smoke probe
      const chainSmokeEntries = parseSmoke(brief);
      const chainSmokeHeadingPresent = hasSectionHeading(brief, "Smoke");
      const p4Result = await runSmokeProbe({
        entries: chainSmokeEntries,
        callTool,
        container,
        headingPresent: chainSmokeHeadingPresent,
      });
      probeResults.push(p4Result);

      probesGreen = probeResults.every(function(p) { return p.passed; });
    } catch (probeErr) {
      probeResults.push({ probe: "sunaba-rpc", passed: false, detail: String(probeErr) });
      probesGreen = false;
    }

    // Base log for review context (own try/catch so a collection failure does not
    // affect probe results or probesGreen; chainBaseLog stays "" on failure).
    try {
      const { callTool } = await import("./sunaba-rpc.mjs");
      const baseLogResult = await callTool("sandbox_exec", {
        container_id: container,
        commands: ["git log --oneline -5"],
      });
      chainBaseLog = baseLogResult?.output ?? "";
    } catch { /* chainBaseLog stays "" */ }

    roundRecord.probesGreen = probesGreen;
    roundRecord.probeResults = probeResults;

    // ---- P3 empty-change: skip review, set probe-sourced discard verdict ----
    let chainSkipReview = false;
    if (chainStatusObserved && chainChangedPaths.length === 0 && chainDeliverables.length > 0) {
      roundRecord.verdict = "discard";
      roundRecord.verdictSource = "probe";
      chainSkipReview = true;
    }

    // ---- review phase (skipped when change set empty) ----
    let chainVerdict = roundRecord.verdict; // may already be set by probe skip above
    let chainFindingsText = null;
    let chainParsedReview = null;
    let chainRepeatedAreas = false;

    if (!chainSkipReview) {
      const promptTemplate = fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", "adversarial-review.md"), "utf8");
      const schemaJson = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json"), "utf8"));
      const reviewInputParts = [
        "## Review target",
        "",
        "The artifact under review lives inside container `" + container + "`.",
        "You may use the following Sunaba read/verify tools to inspect it:",
        "- `read_file_range` - read file contents from the container",
        "- `search_in_container` - grep/search within the container",
        "- `verify_in_container` / `lint_in_container` / `type_check_in_container` - re-run the project's gates in the container",
        "",
        "Do NOT rely on host cwd git state; the actual changes are in the container.",
      ];
      const baseFactsBlock = renderBaseFacts({ baseSha, baseLog: chainBaseLog, statusOutput: chainStatusOutput });
      reviewInputParts.push("", baseFactsBlock);
      const reviewInput = reviewInputParts.join("\n");
      const priorFindings = previousRecord?.findingsText || "(none -- first review round)";

      const reviewPromptText = promptTemplate
        .replaceAll("{{TARGET_LABEL}}", "container " + container + " changes")
        .replaceAll("{{USER_FOCUS}}", brief)
        .replaceAll("{{OUTPUT_SCHEMA}}", JSON.stringify(schemaJson))
        .replaceAll("{{REVIEW_INPUT}}", reviewInput)
        .replaceAll("{{PRIOR_FINDINGS}}", priorFindings);

      const reviewJob = await runPrompt({
        cwd,
        kind: "review",
        title: "chain: " + chainId + " round " + round + " review",
        promptText: reviewPromptText,
        model,
        agent: "kusabi-review",
        tools: reviewDenyTools(),
        timeoutS: 1800,
        watchdogS: 900,
      });
      roundRecord.reviewJobId = reviewJob.job.id;
      roundRecord.reviewUsage = reviewJob.job.usage || null;

      // ---- parse review result ----
      const reviewResultText = reviewJob.resultText || "";
      const stripped = reviewResultText.replace(/\s*VERDICT:\s*(approve-partial|approve|needs-attention|discard)\s*$/i, "");
      chainParsedReview = extractJson(stripped);
      chainVerdict = (chainParsedReview && chainParsedReview.verdict) || "needs-attention";
      roundRecord.verdict = chainVerdict;
      chainFindingsText = (chainParsedReview && chainParsedReview.findings)
        ? chainParsedReview.findings.map(function(f) { return "[" + f.severity + "] " + f.title + " (" + f.file + ":" + f.line_start + ")"; }).join("\n")
        : "(no structured findings)";
      roundRecord.findingsText = chainFindingsText;

      // ---- determine repeated areas ----
      if (previousRecord?.findingsText && chainParsedReview?.findings) {
        var prevFiles = new Set(
          (previousRecord.findingsText.match(/\([^:]+/g) || []).map(function(s) { return s.slice(1); }),
        );
        for (var fi = 0; fi < chainParsedReview.findings.length; fi++) {
          if (prevFiles.has(chainParsedReview.findings[fi].file)) {
            chainRepeatedAreas = true;
            break;
          }
        }
      }
    }

    // ---- derive disposition ----
    // Collect finding severities for the accept-with-followup check
    var chainFindingSeverities = chainParsedReview?.findings
      ? chainParsedReview.findings.map(function (f) { return f.severity; })
      : undefined;

    const disposition = deriveDisposition({
      verdict: chainVerdict || "needs-attention",
      probesGreen: probesGreen,
      round: round,
      maxRounds: maxRounds,
      repeatedAreas: chainRepeatedAreas,
      findingSeverities: chainFindingSeverities,
      strategizeEligible: !strategized,
    });
    roundRecord.disposition = disposition;

    // ---- persist record ----
    records.push(roundRecord);
    writeJson(path.join(chainDir, "round-" + round + ".json"), roundRecord);

    // Compute chain-wide usage totals from all round records.
    const chainTotals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    for (const rec of records) {
      for (const usage of [rec.implementUsage, rec.reviewUsage]) {
        if (usage && usage.available) {
          chainTotals.input += usage.input || 0;
          chainTotals.output += usage.output || 0;
          chainTotals.reasoning += usage.reasoning || 0;
          chainTotals.cacheRead += usage.cacheRead || 0;
          chainTotals.cacheWrite += usage.cacheWrite || 0;
          chainTotals.cost += usage.cost || 0;
        }
      }
    }

    // When review was skipped, ensure findingsText is set
    if (chainSkipReview && !roundRecord.findingsText) {
      roundRecord.findingsText = "(no review — change set was empty)";
    }

    var chainFollowupDraft = null;
    if (disposition.disposition === "accept-with-followup" && chainParsedReview?.findings) {
      var briefTitle = brief ? brief.split("\n")[0].trim() : "";
      chainFollowupDraft = renderFollowupDraft({
        chainId: chainId,
        briefTitle: briefTitle,
        findings: chainParsedReview.findings,
      });
      roundRecord.followupIssueDraft = chainFollowupDraft;
    }

    writeJson(path.join(chainDir, "chain.json"), {
      chainId: chainId,
      container: container,
      model: model,
      modelChain: modelChain,
      maxRounds: maxRounds,
      brief: brief,
      orchestrator: orchestrator,
      records: records,
      baseSha: baseSha,
      chainTotals: chainTotals,
      strategized: strategized,
      followupIssueDraft: chainFollowupDraft,
    });

    if (disposition.disposition === "accept") {
      const acceptReviewText = chainParsedReview
        ? renderReview(chainParsedReview, chainFindingsText || "")
        : "(no review text available)";
      return "Chain " + chainId + " accepted at round " + round + ".\n\n" + acceptReviewText;
    }

    if (disposition.disposition === "accept-with-followup") {
      var awfBriefTitle = brief ? brief.split("\n")[0].trim() : "";
      var awfDraft = chainFollowupDraft || renderFollowupDraft({
        chainId: chainId,
        briefTitle: awfBriefTitle,
        findings: chainParsedReview?.findings || [],
      });
      var awfReviewText = chainParsedReview
        ? renderReview(chainParsedReview, chainFindingsText || "")
        : "(no review text available)";
      return "Chain " + chainId + " accepted-with-followup at round " + round + ".\n\n" + awfReviewText + "\n\n" + awfDraft;
    }

    if (disposition.disposition === "escalate") {
      var reason = disposition.reason || "unknown";
      var orchLine = orchestrator?.model ? "orchestrator=" + orchestrator.model : "";
      var lines = [
        "Chain " + chainId + " escalated at round " + round + ": " + reason,
        orchLine,
        "",
        "Remaining findings:",
        roundRecord.findingsText,
        "",
      ];
      for (var ri = 0; ri < records.length; ri++) {
        var r = records[ri];
        var detail = r.resumeMethod.detail ? ": " + r.resumeMethod.detail : "";
        lines.push("Round " + (ri + 1) + ": model=" + (r.modelEntry || "?") + ", verdict=" + r.verdict + ", probesGreen=" + r.probesGreen + ", resume=" + r.resumeMethod.type + detail);
      }
      lines.push("", "Hand over to orchestrator for final judgement.");
      return lines.join("\n");
    }

    // ---- strategize: structural re-diagnosis before next rework ----
    if (disposition.disposition === "strategize") {
      strategized = true;

      // Build the strategist prompt from the brief's acceptance criteria and
      // the last two rounds' findings.
      const strategistRounds = [];
      if (previousRecord) {
        strategistRounds.push({ round: previousRecord.round, findingsText: previousRecord.findingsText || "" });
      }
      strategistRounds.push({ round: round, findingsText: roundRecord.findingsText || "" });

      const strategistPromptText = renderStrategistPrompt({
        brief: brief,
        rounds: strategistRounds,
      });

      const strategistJob = await runPrompt({
        cwd,
        kind: "strategist",
        title: "chain: " + chainId + " round " + round + " strategist",
        promptText: strategistPromptText,
        agent: "kusabi-investigate",
        tools: reviewDenyTools(),
        timeoutS: 1800,
        watchdogS: 900,
      });
      roundRecord.strategistJobId = strategistJob.job.id;
      roundRecord.strategistUsage = strategistJob.job.usage || null;
      roundRecord.strategistRecommendation = strategistJob.resultText || "(no recommendation)";

      // Re-persist the updated round record and chain.json with strategized flag
      writeJson(path.join(chainDir, "round-" + round + ".json"), roundRecord);
      writeJson(path.join(chainDir, "chain.json"), {
        chainId: chainId,
        container: container,
        model: model,
        modelChain: modelChain,
        maxRounds: maxRounds,
        brief: brief,
        orchestrator: orchestrator,
        records: records,
        baseSha: baseSha,
        chainTotals: chainTotals,
        strategized: strategized,
        followupIssueDraft: chainFollowupDraft,
      });

      // Continue to next round (does not consume the strategist's own round number;
      // normal round accounting applies to the rework).  The max-rounds hard limit
      // still applies unchanged — if the next rework would exceed maxRounds, escalate.
      continue;
    }
  }

  var lastRecord = records.length > 0 ? records[records.length - 1] : {};
  var finalFindings = lastRecord.findingsText || "(none)";
  var orchLine = orchestrator?.model ? "orchestrator=" + orchestrator.model : "";
  var lines = [
    "Chain " + chainId + " reached max rounds (" + maxRounds + ") without acceptance.",
    orchLine,
    "",
    "Remaining findings:",
    finalFindings,
    "",
  ];
  for (var ri2 = 0; ri2 < records.length; ri2++) {
    var r2 = records[ri2];
    var detail2 = r2.resumeMethod.detail ? ": " + r2.resumeMethod.detail : "";
    lines.push("Round " + (ri2 + 1) + ": model=" + (r2.modelEntry || "?") + ", verdict=" + r2.verdict + ", probesGreen=" + r2.probesGreen + ", resume=" + r2.resumeMethod.type + detail2);
  }
  lines.push("", "Hand over to orchestrator for final judgement.");
  return lines.join("\n");
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
    "  --max-rounds <N> (chain: max rounds, default 3)",
    "  --last <N> (explain: include last N assistant/user exchanges, default 1)",
    "  --tools (explain: also include tool results in context)",
    "  --quote <text> (explain: use explicit passage instead of transcript extraction)",
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
    case "explain":
      return cmdExplain(cwd, parsed);
    default:
      throw new Error(`unknown subcommand: ${subcommand ?? "(none)"}. Use setup|task|review|chain|chain-show|status|result|cancel|serve-stop|install-agents|salvage|explain`);
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
