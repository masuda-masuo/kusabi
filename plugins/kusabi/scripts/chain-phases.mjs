// chain-phases.mjs — Round lifecycle phases for cmdChain and probe functions.
//
// Every function in this module receives cross-round state (baseSha,
// strategized, records) as explicit arguments and returns results as
// explicit return values — nothing is captured from an enclosing scope.
//
// Probe functions (runHeadCleanProbe, runVerifyProbe, runDeliverablesProbe,
// runSmokeProbe, runSmokeEntry) are also defined here because they power
// the chain's deterministic probe phase.  They are re-exported from
// kusabi-companion.mjs so existing test imports continue to work.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseModel,
  implementDenyTools,
  reviewDenyTools,
} from "./cli.mjs";
import {
  renderBaseFacts,
  renderStrategistPrompt,
  renderReview,
  renderFollowupDraft,
  extractJson,
} from "./render.mjs";
import {
  hasSectionHeading,
  parseDeliverables,
  parseSmoke,
  parseChangedPaths,
} from "./brief-parsing.mjs";
import {
  checkDeliverablesProbe,
  checkSmokeProbe,
} from "./probe-decisions.mjs";
import {
  resolveResumeMethod,
  deriveDisposition,
} from "./disposition.mjs";
import { writeJson } from "./state-paths.mjs";
import { runPrompt } from "./prompt-execution.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");

// =========================================================================
// Setup / initialisation
// =========================================================================

/**
 * Create a new chain directory and return its identity.
 */
export function createChainDir(stateDir) {
  const chainId = `chain-${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
  const chainDir = path.join(stateDir, "chains", chainId);
  fs.mkdirSync(chainDir, { recursive: true });
  return { chainId, chainDir };
}

/**
 * Capture the base SHA from the container at chain start.
 * Returns null on failure (probes will catch it per-round).
 */
export async function captureBaseSha(callTool, container) {
  try {
    const gitRev = await callTool("sandbox_exec", {
      container_id: container,
      commands: ["git rev-parse HEAD"],
    });
    return (gitRev?.output ?? "").trim() || null;
  } catch {
    return null;
  }
}

// =========================================================================
// Per-round phases
// =========================================================================

/**
 * Resolve the resume method for a round, executing checkpoint_restore when
 * a fresh session is required.
 *
 * @param {object}   opts
 * @param {number}   opts.round        — 1-based round number
 * @param {boolean}  opts.strategized  — true if a strategize has occurred
 * @param {string|null} opts.baseSha   — base SHA captured at chain start
 * @param {string}   opts.container    — container ID
 * @param {Function} opts.callTool     — sunaba-rpc callTool function
 * @returns {{ resumeMethod: object, useNewSession: boolean }}
 */
export async function resolveRoundResume({ round, strategized, baseSha, container, callTool }) {
  const resumeStrategy = resolveResumeMethod({ round, strategized });
  const useNewSession = resumeStrategy.type === "fresh_session";
  let resumeMethod;
  if (useNewSession) {
    let restoreOk = false;
    let restoreDetail = null;
    if (baseSha) {
      try {
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
  return { resumeMethod, useNewSession };
}

/**
 * Select the model for a given round based on the model chain index.
 *
 * @param {object}  opts
 * @param {number}  opts.round        — 1-based round number
 * @param {boolean} opts.isFirstRound
 * @param {string|null} opts.flagsModel — explicit --model flag value
 * @param {object}  opts.model        — resolved model from setup
 * @param {string[]} opts.modelChain  — model chain entries
 * @returns {{ roundModel: object|null, roundModelEntry: string|null }}
 */
export function selectRoundModel({ round, isFirstRound, flagsModel, model, modelChain }) {
  let roundModel;
  if (isFirstRound && flagsModel) {
    roundModel = model; // --model overrides round 1
  } else {
    const chainIdx = Math.min(round - 1, modelChain.length - 1);
    const entry = modelChain[chainIdx];
    roundModel = parseModel(entry);
  }
  const roundModelEntry = (roundModel && roundModel.variant)
    ? roundModel.providerID + "/" + roundModel.modelID + ":" + roundModel.variant
    : (roundModel ? roundModel.providerID + "/" + roundModel.modelID : null);
  return { roundModel, roundModelEntry };
}

/**
 * Build the implement prompt text for a chain round.
 */
export function buildImplementText({ round, brief, previousRecord }) {
  if (round === 1) return brief;
  if (previousRecord) {
    let strategistSection = "";
    if (previousRecord.strategistRecommendation) {
      strategistSection = "\n\n## Strategist recommendation (structural change for this rework)\n" + previousRecord.strategistRecommendation + "\n";
    }
    return "## Prior findings\n" + (previousRecord.findingsText || "(none)") + strategistSection + "\n\n## Acceptance criteria\n" + brief;
  }
  return brief;
}

/**
 * Run the implement phase: dispatch the implement job and return the initial
 * round record with implement-related fields.
 *
 * The returned roundRecord is a partial record; subsequent phases add more
 * fields (probes, review, disposition).
 */
export async function runImplementPhase({
  cwd, chainId, round, isFirstRound, implementText, roundModel,
  useNewSession, session, previousRecord, roundModelEntry, resumeMethod,
}) {
  let resolvedSession = session;
  if (!resolvedSession && !isFirstRound && previousRecord?.sessionID) {
    if (!useNewSession) {
      resolvedSession = previousRecord.sessionID;
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
    session: useNewSession ? undefined : resolvedSession,
    tools: implementDenyTools(),
    timeoutS: 3600,
    watchdogS: 900,
  });

  return {
    roundRecord: {
      round,
      resumeMethod,
      startedAt: new Date().toISOString(),
      verdict: null,
      probesGreen: false,
      modelEntry: roundModelEntry,
      modelVariant: roundModel?.variant || null,
      implementJobId: implementJob.job.id,
      sessionID: implementJob.job.sessionID,
      implementUsage: implementJob.job.usage || null,
    },
    session: resolvedSession,
  };
}

/**
 * Run deterministic probes P1–P4 via sunaba-rpc.
 *
 * Returns probe results and side data needed by the review phase.
 */
export async function runProbePhase({ baseSha, container, brief, callTool }) {
  const chainDeliverables = parseDeliverables(brief);
  let probesGreen = false;
  const probeResults = [];
  let chainChangedPaths = [];
  let chainStatusObserved = false;
  let chainStatusOutput = "";
  let chainBaseLog = "";

  try {
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

    const chainSmokeEntries = parseSmoke(brief);
    const chainSmokeHeadingPresent = hasSectionHeading(brief, "Smoke");
    const p4Result = await runSmokeProbe({
      entries: chainSmokeEntries,
      callTool,
      container,
      headingPresent: chainSmokeHeadingPresent,
    });
    probeResults.push(p4Result);

    probesGreen = probeResults.every(function (p) { return p.passed; });
  } catch (probeErr) {
    probeResults.push({ probe: "sunaba-rpc", passed: false, detail: String(probeErr) });
    probesGreen = false;
  }

  // Base log for review context (own try/catch so failure does not affect probesGreen)
  try {
    const baseLogResult = await callTool("sandbox_exec", {
      container_id: container,
      commands: ["git log --oneline -5"],
    });
    chainBaseLog = baseLogResult?.output ?? "";
  } catch { /* chainBaseLog stays "" */ }

  return { probesGreen, probeResults, chainChangedPaths, chainStatusObserved, chainStatusOutput, chainBaseLog, chainDeliverables };
}

/**
 * Determine whether the review should be skipped (probe-driven discard).
 */
export function shouldSkipReview({ chainStatusObserved, chainChangedPaths, chainDeliverables }) {
  return chainStatusObserved && chainChangedPaths.length === 0 && chainDeliverables.length > 0;
}

/**
 * Run the review phase (or mark skip when the change set is empty).
 *
 * Mutates roundRecord in place with review-job fields, verdict, and findings.
 * Returns review results needed by the disposition phase.
 */
export async function runReviewPhase({
  container, brief, model, chainId, cwd, previousRecord, baseSha,
  chainStatusOutput, chainBaseLog, roundRecord,
  chainChangedPaths, chainStatusObserved, chainDeliverables,
}) {
  const skipReview = shouldSkipReview({ chainStatusObserved, chainChangedPaths, chainDeliverables });

  // ---- P3 empty-change: set probe-sourced discard verdict before review ----
  if (skipReview) {
    roundRecord.verdict = "discard";
    roundRecord.verdictSource = "probe";
  }

  let chainVerdict = roundRecord.verdict; // may already be set by probe skip above
  let chainFindingsText = null;
  let chainParsedReview = null;
  let chainRepeatedAreas = false;

  if (!skipReview) {
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
      title: "chain: " + chainId + " round " + roundRecord.round + " review",
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
      ? chainParsedReview.findings.map(function (f) { return "[" + f.severity + "] " + f.title + " (" + f.file + ":" + f.line_start + ")"; }).join("\n")
      : "(no structured findings)";
    roundRecord.findingsText = chainFindingsText;

    // ---- determine repeated areas ----
    if (previousRecord?.findingsText && chainParsedReview?.findings) {
      const prevFiles = new Set(
        (previousRecord.findingsText.match(/\([^:]+/g) || []).map(function (s) { return s.slice(1); }),
      );
      for (let fi = 0; fi < chainParsedReview.findings.length; fi++) {
        if (prevFiles.has(chainParsedReview.findings[fi].file)) {
          chainRepeatedAreas = true;
          break;
        }
      }
    }
  }

  return { chainVerdict, chainFindingsText, chainParsedReview, chainRepeatedAreas, skipReview };
}

/**
 * Compute chain-wide usage totals from all round records.
 */
export function computeChainTotals(records) {
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
  return chainTotals;
}

/**
 * Persist a round record and update chain.json.
 *
 * Writes both `round-N.json` and `chain.json` to the chain directory.
 */
export function persistChainState({
  chainDir, round, roundRecord, chainId, container, model, modelChain,
  maxRounds, brief, orchestrator, records, baseSha, chainTotals,
  strategized, chainFollowupDraft,
}) {
  writeJson(path.join(chainDir, "round-" + round + ".json"), roundRecord);
  writeJson(path.join(chainDir, "chain.json"), {
    chainId,
    container,
    model,
    modelChain,
    maxRounds,
    brief,
    orchestrator,
    records,
    baseSha,
    chainTotals,
    strategized,
    followupIssueDraft: chainFollowupDraft,
  });
}

/**
 * Run the strategize sub-phase: build prompt, dispatch strategist job,
 * and update the roundRecord with strategist findings.
 */
export async function runStrategizePhase({ cwd, chainId, round, brief, previousRecord, roundRecord }) {
  // Build the strategist prompt from the brief's acceptance criteria and
  // the last two rounds' findings.
  const strategistRounds = [];
  if (previousRecord) {
    strategistRounds.push({ round: previousRecord.round, findingsText: previousRecord.findingsText || "" });
  }
  strategistRounds.push({ round, findingsText: roundRecord.findingsText || "" });

  const strategistPromptText = renderStrategistPrompt({
    brief,
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
}

// =========================================================================
// Outcome rendering
// =========================================================================

/**
 * Render the outcome string when the chain is accepted.
 */
export function renderAcceptOutcome({ chainId, round, chainParsedReview, chainFindingsText }) {
  const acceptReviewText = chainParsedReview
    ? renderReview(chainParsedReview, chainFindingsText || "")
    : "(no review text available)";
  return "Chain " + chainId + " accepted at round " + round + ".\n\n" + acceptReviewText;
}

/**
 * Render the outcome string for accept-with-followup.
 */
export function renderAcceptWithFollowupOutcome({ chainId, round, chainParsedReview, chainFindingsText, chainFollowupDraft, brief }) {
  const briefTitle = brief ? brief.split("\n")[0].trim() : "";
  const awfDraft = chainFollowupDraft || renderFollowupDraft({
    chainId,
    briefTitle,
    findings: chainParsedReview?.findings || [],
  });
  const awfReviewText = chainParsedReview
    ? renderReview(chainParsedReview, chainFindingsText || "")
    : "(no review text available)";
  return "Chain " + chainId + " accepted-with-followup at round " + round + ".\n\n" + awfReviewText + "\n\n" + awfDraft;
}

/**
 * Render the outcome string for escalation.
 */
export function renderEscalateOutcome({ chainId, round, disposition, orchestrator, roundRecord, records }) {
  const reason = disposition.reason || "unknown";
  const orchLine = orchestrator?.model ? "orchestrator=" + orchestrator.model : "";
  const lines = [
    "Chain " + chainId + " escalated at round " + round + ": " + reason,
    orchLine,
    "",
    "Remaining findings:",
    roundRecord.findingsText,
    "",
  ];
  for (let ri = 0; ri < records.length; ri++) {
    const r = records[ri];
    const detail = r.resumeMethod.detail ? ": " + r.resumeMethod.detail : "";
    lines.push("Round " + (ri + 1) + ": model=" + (r.modelEntry || "?") + ", verdict=" + r.verdict + ", probesGreen=" + r.probesGreen + ", resume=" + r.resumeMethod.type + detail);
  }
  lines.push("", "Hand over to orchestrator for final judgement.");
  return lines.join("\n");
}

/**
 * Render the outcome string when max rounds are reached without acceptance.
 */
export function renderMaxRoundsOutcome({ chainId, maxRounds, records, orchestrator }) {
  const lastRecord = records.length > 0 ? records[records.length - 1] : {};
  const finalFindings = lastRecord.findingsText || "(none)";
  const orchLine = orchestrator?.model ? "orchestrator=" + orchestrator.model : "";
  const lines = [
    "Chain " + chainId + " reached max rounds (" + maxRounds + ") without acceptance.",
    orchLine,
    "",
    "Remaining findings:",
    finalFindings,
    "",
  ];
  for (let ri2 = 0; ri2 < records.length; ri2++) {
    const r2 = records[ri2];
    const detail2 = r2.resumeMethod.detail ? ": " + r2.resumeMethod.detail : "";
    lines.push("Round " + (ri2 + 1) + ": model=" + (r2.modelEntry || "?") + ", verdict=" + r2.verdict + ", probesGreen=" + r2.probesGreen + ", resume=" + r2.resumeMethod.type + detail2);
  }
  lines.push("", "Hand over to orchestrator for final judgement.");
  return lines.join("\n");
}

// =========================================================================
// Deterministic probes — P1, P2, P3, P4
//
// These are also used by cmdTask so they are exported from this module and
// re-exported from kusabi-companion.mjs for backward-compatible test imports.
// =========================================================================

/**
 * Read a bounded tail of a smoke command's captured output for diagnostics.
 */
async function readSmokeOutputTail(callTool, container, outfile) {
  try {
    const result = await callTool("sandbox_exec", {
      container_id: container,
      commands: [
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
  const wrappedCommand = `( ${entry.command} ) >${outfile} 2>&1; echo SMOKE_EXIT=$?`;

  try {
    const smokeResult = await callTool("sandbox_exec", {
      container_id: container,
      commands: [wrappedCommand],
      timeout: 300,
    });

    if (smokeResult?.status === "timeout") {
      const diagnostic = await readSmokeOutputTail(callTool, container, outfile);
      return { command: entry.command, observed: "timeout", diagnostic };
    }

    const smokeOutput = (smokeResult?.output ?? "") + (smokeResult?.stderr ?? "");
    const exitMatches = [...smokeOutput.matchAll(/SMOKE_EXIT=(\d+)/g)];
    const lastMatch = exitMatches.length > 0 ? exitMatches[exitMatches.length - 1] : null;

    if (!lastMatch) {
      const diagnostic = await readSmokeOutputTail(callTool, container, outfile);
      return { command: entry.command, observed: "unobservable", diagnostic };
    }

    const exitCode = parseInt(lastMatch[1], 10);

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

/**
 * P1: Check that HEAD matches the recorded base SHA.
 * When HEAD differs, auto-reset via git reset --mixed.
 */
export async function runHeadCleanProbe({ baseSha, callTool, container, sourceLabel = "task" }) {
  let passed = false;
  let detail = "";
  if (baseSha) {
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
 * Returns the probe result with `changedPaths` and `statusOutput` attached
 * for the chain call site.
 */
export async function runDeliverablesProbe({ deliverables, headingPresent, callTool, container }) {
  const statusResult = await callTool("sandbox_exec", {
    container_id: container,
    commands: ["git status --porcelain"],
  });
  const statusOutput = statusResult?.output ?? "";
  const changedPaths = parseChangedPaths(statusOutput);
  const probeResult = checkDeliverablesProbe(deliverables, changedPaths, headingPresent);
  probeResult.changedPaths = changedPaths;
  probeResult.statusOutput = statusOutput;
  return probeResult;
}
