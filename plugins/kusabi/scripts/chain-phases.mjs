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
  implementDenyTools,
  reviewDenyTools,
} from "./cli.mjs";
import {
  renderBaseFacts,
  renderPriorFindings,
  renderStrategistPrompt,
  renderReview,
  renderFollowupDraft,
  extractJson,
  recoverVerdictFromText,
} from "./render.mjs";
import {
  hasSectionHeading,
  parseDeliverables,
  parseSmoke,
  parseChangedPaths,
} from "./brief-parsing.mjs";
import {
  checkSmokeProbe,
} from "./probe-decisions.mjs";
// resolveRoundResume is defined below and is the only resume-resolution
// mechanism.  checkpoint_restore was removed in issue #114 — the chain
// never rolls the worktree back.
import { writeJson } from "./state-paths.mjs";
import { dispatchWithFallback } from "./prompt-execution.mjs";
import {
  captureWorktreeState,
  computeNewlyChanged,
  resolveWorktreeChanged,
  checkDeliverablesSinceBaseline,
} from "./worktree-baseline.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");

/**
 * Normalise a file path for cross-round file-path comparison.
 *
 * Strips leading/trailing whitespace so that minor formatting differences
 * do not affect suffix matching.  Path-form equivalence (absolute vs
 * relative) is handled by suffix-based matching in hasRepeatedAreas.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function normalizeFilePath(filePath) {
  if (!filePath) return "";
  if (typeof filePath !== "string") return String(filePath);
  return filePath.trim();
}

/**
 * Check whether any finding file from the current round matches a file
 * that appeared in a previous round.
 *
 * Two paths match when one is a suffix of the other on path-segment
 * boundaries (split by "/").  This handles the common case where one
 * reviewer uses an absolute in-container path like
 * "/workspace/src/a/b.py" and another uses the repository-relative
 * "src/a/b.py" — the shorter path's segments are a suffix of the longer.
 *
 * Old records without the findingFiles field are handled gracefully
 * (previousFindingFiles is undefined/null → no match).
 *
 * @param {string[]|undefined|null} previousFindingFiles
 * @param {Array|undefined|null} currentFindings  — findings array from
 *        the parsed review (each element has a .file property).
 * @returns {boolean}
 */
export function hasRepeatedAreas(previousFindingFiles, currentFindings) {
  if (!previousFindingFiles?.length) return false;
  if (!currentFindings?.length) return false;

  // Path-segment suffix match: split on "/" and check if one array
  // of segments is a suffix of the other.
  function suffixMatch(a, b) {
    const segA = a.split("/");
    const segB = b.split("/");
    const shorter = segA.length <= segB.length ? segA : segB;
    const longer = segA.length > segB.length ? segA : segB;
    if (shorter.length === 0) return false;
    const offset = longer.length - shorter.length;
    for (let i = 0; i < shorter.length; i++) {
      if (longer[offset + i] !== shorter[i]) return false;
    }
    return true;
  }

  for (let fi = 0; fi < currentFindings.length; fi++) {
    const currentPath = normalizeFilePath(currentFindings[fi]?.file);
    if (!currentPath) continue;
    for (let pi = 0; pi < previousFindingFiles.length; pi++) {
      const prevPath = normalizeFilePath(previousFindingFiles[pi]);
      if (!prevPath) continue;
      if (suffixMatch(currentPath, prevPath)) {
        return true;
      }
    }
  }
  return false;
}

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
 * Resolve the resume method for a round.
 *
 * This is now a pure synchronous function.  The chain never rolls the
 * worktree back (checkpoint_restore was removed in issue #114).
 * A new session starts fresh on the existing worktree.
 *
 * @param {object}  opts
 * @param {boolean} opts.useNewSession  — whether to start a new session
 * @returns {{ resumeMethod: { type: "continue_session"|"fresh_session" }, useNewSession: boolean }}
 */
export function resolveRoundResume({ useNewSession }) {
  return {
    resumeMethod: {
      type: useNewSession ? "fresh_session" : "continue_session",
    },
    useNewSession,
  };
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
    const priorFindingsText = renderPriorFindings(previousRecord);
    return "## Prior findings\n" + priorFindingsText + "\n\n## Instruction\nResolve each prior finding in this round. If a finding cannot be fully resolved, you must explain why and report what remains." + strategistSection + "\n\n## Acceptance criteria\n" + brief;
  }
  return brief;
}

/**
 * Run the implement phase: dispatch the implement job via dispatchWithFallback
 * and return the initial round record with implement-related fields.
 *
 * The returned roundRecord is a partial record; subsequent phases add more
 * fields (probes, review, disposition).
 */
export async function runImplementPhase({
  cwd, chainId, round, isFirstRound, implementText, modelChain, tierIndex,
  useNewSession, session, previousRecord, resumeMethod, flagsModel,
}) {
  let resolvedSession = session;
  if (!resolvedSession && !isFirstRound && previousRecord?.sessionID) {
    if (!useNewSession) {
      resolvedSession = previousRecord.sessionID;
    }
  }

  const { job, resultText } = await dispatchWithFallback({
    cwd,
    kind: "task",
    title: "chain: " + chainId + " round " + round + " implement",
    promptText: implementText,
    agent: "kusabi-implement",
    phase: "implement",
    session: useNewSession ? undefined : resolvedSession,
    tools: implementDenyTools(),
    timeoutS: 3600,
    watchdogS: 900,
    tiers: modelChain,
    tierIndex, // decoupled from round counter (B1)
    round,
    explicitModel: isFirstRound ? flagsModel : null,
  });

  // Ignore resultText from non-completed jobs; the chain reads the result
  // from the job store.
  void resultText;

  return {
    roundRecord: {
      round,
      resumeMethod,
      startedAt: new Date().toISOString(),
      verdict: null,
      probesGreen: false,
      modelEntry: job.modelEntry || null,
      modelVariant: job.modelVariant || null,
      fallbacks: job.fallbacks || null,
      implementJobId: job.id,
      sessionID: job.sessionID,
      implementUsage: job.usage || null,
    },
    implementJobStatus: job.status,
    implementJobError: job.error || null,
    session: resolvedSession,
  };
}

/**
 * Run deterministic probes P1–P4 via sunaba-rpc.
 *
 * Returns probe results and side data needed by the review phase.
 */
export async function runProbePhase({ baseSha, container, brief, callTool, worktreeBaseline }) {
  const chainDeliverables = parseDeliverables(brief);
  let probesGreen = false;
  const probeResults = [];
  let chainChangedPaths = [];
  let chainNewlyChanged = [];
  let worktreeChanged = null;
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
      baseline: worktreeBaseline,
    });
    chainChangedPaths = p3Result.changedPaths;
    // `newlyChangedPaths` is null when the comparison could not be made — the
    // chain-start baseline is missing, or this round's capture failed.  Either
    // way the answer is "unknown", and unknown must not be read as "nothing
    // changed": that would discard a round because the measurement broke.  Fall
    // back to the full changed set, which is what the probe used before
    // baselines existed.
    chainNewlyChanged = p3Result.newlyChangedPaths ?? chainChangedPaths;
    worktreeChanged = p3Result.worktreeChanged;
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

  // Diff content and untracked files for review context (own try/catch)
  let chainDiff = "";
  let chainUntracked = "";
  try {
    const diffResult = await callTool("sandbox_exec", {
      container_id: container,
      commands: ["git diff"],
    });
    chainDiff = diffResult?.output ?? "";

    const untrackedResult = await callTool("sandbox_exec", {
      container_id: container,
      commands: ["git ls-files --others --exclude-standard"],
    });
    chainUntracked = untrackedResult?.output ?? "";
  } catch { /* chainDiff and chainUntracked stay "" */ }

  return { probesGreen, probeResults, chainChangedPaths, chainNewlyChanged, chainStatusObserved, chainStatusOutput, chainBaseLog, chainDeliverables, chainDiff, chainUntracked, worktreeChanged };
}


export function parseReviewResult(reviewResultText) {
  // ---- parse review result ----
  // Part A: handle VERDICT token inside the JSON fence.
  // First try stripping a trailing VERDICT token, then try extractJson.
  // If that fails, try recovering the verdict from anywhere in the text
  // and re-extract JSON after stripping the token from anywhere.
  const trailingStripped = reviewResultText.replace(/\s*VERDICT:\s*(approve-partial|approve|needs-attention|discard)\s*$/i, "");
  let parsed = extractJson(trailingStripped);

  if (!parsed) {
    // The trailing-strip didn't work (token may be inside the fence).
    // Try recovering the verdict from anywhere in the text.
    const recovered = recoverVerdictFromText(reviewResultText);
    if (recovered) {
      // Strip the token from everywhere and re-parse.
      // Safety: if the global strip joins lines in a way that breaks JSON,
      // extractJson returns null and we fall through to unparseable —
      // no malformed JSON is ever accepted.
      const anywhereStripped = reviewResultText.replace(/\s*VERDICT:\s*(approve-partial|approve|needs-attention|discard)\s*/gi, "");
      parsed = extractJson(anywhereStripped);
    }
  }

  const reviewParseable = parsed !== null;

  if (reviewParseable) {
    const chainVerdict = parsed.verdict || "needs-attention";
    const chainFindingsText = parsed.findings && parsed.findings.length > 0
      ? parsed.findings.map(function (f) { return "[" + f.severity + "] " + f.title + " (" + f.file + ":" + f.line_start + ")"; }).join("\n")
      : "(no structured findings)";
    return { chainParsedReview: parsed, chainVerdict, chainFindingsText, reviewParseable };
  }

  // A2: unparseable review is recorded as a distinct state
  const recoveredV = recoverVerdictFromText(reviewResultText);
  const chainVerdict = recoveredV ? recoveredV.verdict : "unparseable";
  const chainFindingsText = "(review output could not be parsed)";
  return { chainParsedReview: null, chainVerdict, chainFindingsText, reviewParseable };
}

/**
 * Determine whether the review should be skipped (probe-driven discard).
 */
export function shouldSkipReview({ chainStatusObserved, chainChangedPaths, chainNewlyChanged, chainDeliverables }) {
  // Null means the since-baseline comparison could not be made.  Fall back to
  // the full changed set rather than treating "unknown" as "nothing changed" —
  // skipping review here turns a failed measurement into a discarded round.
  const effectivePaths = chainNewlyChanged ?? chainChangedPaths;
  return chainStatusObserved && effectivePaths.length === 0 && chainDeliverables.length > 0;
}

/**
 * Run the review phase (or mark skip when the change set is empty).
 *
 * Mutates roundRecord in place with review-job fields, verdict, and findings.
 * Returns review results needed by the disposition phase.
 */
export async function runReviewPhase({
  container, brief, modelChain, chainId, cwd, previousRecord, baseSha,
  chainStatusOutput, chainBaseLog, chainDiff, chainUntracked, roundRecord,
  chainChangedPaths, chainNewlyChanged, chainStatusObserved, chainDeliverables, flagsModel,
  _dispatchWithFallback: _dispatch = dispatchWithFallback,
} = {}) {
  const skipReview = shouldSkipReview({ chainStatusObserved, chainChangedPaths, chainNewlyChanged, chainDeliverables });

  // ---- P3 empty-change: set probe-sourced discard verdict before review ----
  if (skipReview) {
    roundRecord.verdict = "discard";
    roundRecord.verdictSource = "probe";
    roundRecord.reviewParseable = false;
  }

  let chainVerdict = roundRecord.verdict; // may already be set by probe skip above
  let chainFindingsText = null;
  let chainParsedReview = null;
  let chainRepeatedAreas = false;
  let reviewJobStatus = undefined;
  let reviewJobError = null;
  let reviewParseable = false;

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
      "- `diff_in_container` - inspect the actual diff in the container",
      "- `verify_in_container` / `lint_in_container` / `type_check_in_container` - re-run the project's gates in the container",
      "",
      "Do NOT rely on host cwd git state; the actual changes are in the container.",
    ];
    const baseFactsBlock = renderBaseFacts({ baseSha, baseLog: chainBaseLog, statusOutput: chainStatusOutput, diffContent: chainDiff, untrackedFiles: chainUntracked });
    reviewInputParts.push("", baseFactsBlock);
    const reviewInput = reviewInputParts.join("\n");
    const priorFindings = previousRecord?.findingsText || "(none -- first review round)";

    const reviewPromptText = promptTemplate
      .replaceAll("{{TARGET_LABEL}}", "container " + container + " changes")
      .replaceAll("{{USER_FOCUS}}", brief)
      .replaceAll("{{OUTPUT_SCHEMA}}", JSON.stringify(schemaJson))
      .replaceAll("{{REVIEW_INPUT}}", reviewInput)
      .replaceAll("{{PRIOR_FINDINGS}}", priorFindings);

    // The reviewer's route does not follow the round ladder: it stays on the
    // same route for every round, which is what the pre-fallback code did
    // (`--model` when given, otherwise the chain's first entry).  Round 1 is
    // passed so selectRoutes offers tier 1 onwards, and `explicitModel` keeps
    // `--model` in force for reviews of every round.
    // dispatchWithFallback handles capacity fallback transparently.
    // These options are reused verbatim for the unparseable-output retry
    // below — same prompt, tiers, agent, tools, and timeouts.
    const reviewDispatchOptions = {
      cwd,
      kind: "review",
      title: "chain: " + chainId + " round " + roundRecord.round + " review",
      promptText: reviewPromptText,
      agent: "kusabi-review",
      tools: reviewDenyTools(),
      timeoutS: 1800,
      watchdogS: 900,
      tiers: modelChain,
      round: 1,
      explicitModel: flagsModel || null,
    };

    let reviewJob;
    let reviewResultText;
    ({ job: reviewJob, resultText: reviewResultText } = await _dispatch(reviewDispatchOptions));

    // ---- parse review result ----
    let {
      chainParsedReview: _parsed, chainVerdict: _verdict,
      chainFindingsText: _findings, reviewParseable: _parseable,
    } = parseReviewResult(reviewResultText);

    // ---- retry once on unparseable output ----
    // A job that completes with garbage — no JSON and no recoverable
    // VERDICT token — is usually a transient provider hiccup rather than a
    // genuine verdict (real incident: a 132-token broken review response
    // that re-dispatched cleanly).  Re-dispatch exactly once within this
    // round with identical options and treat the second attempt as final;
    // two consecutive unparseable results escalate exactly as before.  The
    // retry lives entirely inside this phase and never consumes a round.
    if (!_parseable && _verdict === "unparseable") {
      roundRecord.reviewUnparseableRetried = true;
      roundRecord.reviewFirstJobId = reviewJob.id;
      ({ job: reviewJob, resultText: reviewResultText } = await _dispatch(reviewDispatchOptions));
      ({ chainParsedReview: _parsed, chainVerdict: _verdict,
         chainFindingsText: _findings, reviewParseable: _parseable } = parseReviewResult(reviewResultText));
    }

    roundRecord.reviewJobId = reviewJob.id;
    roundRecord.reviewUsage = reviewJob.usage || null;
    roundRecord.reviewModelEntry = reviewJob.modelEntry || null;
    roundRecord.reviewModelVariant = reviewJob.modelVariant || null;
    roundRecord.reviewFallbacks = reviewJob.fallbacks || null;
    reviewJobStatus = reviewJob.status;
    reviewJobError = reviewJob.error || null;

    chainParsedReview = _parsed;
    chainVerdict = _verdict;
    chainFindingsText = _findings;
    reviewParseable = _parseable;
    roundRecord.reviewParseable = reviewParseable;
    roundRecord.verdict = chainVerdict;
    if (!reviewParseable) {
      roundRecord.verdictSource = "recovered-from-token";
    }
    roundRecord.findingsText = chainFindingsText;

    // ---- store file paths for cross-round comparison ----
    // Stores the raw finding file paths from the parsed review.
    // Comparison uses path-segment suffix matching in hasRepeatedAreas,
    // so absolute vs relative path differences are handled transparently.
    roundRecord.findingFiles = chainParsedReview?.findings
      ? chainParsedReview.findings.map(function (f) { return normalizeFilePath(f.file); })
      : [];
    roundRecord.findings = chainParsedReview?.findings || [];

    // ---- determine repeated areas using hasRepeatedAreas ----
    // Uses the stored findingFiles array instead of re-parsing the
    // human-readable findingsText, which was fragile: it broke on
    // finding titles containing parentheses and on path-form mismatches.
    chainRepeatedAreas = hasRepeatedAreas(previousRecord?.findingFiles, chainParsedReview?.findings);
  }

  return { chainVerdict, chainFindingsText, chainParsedReview, chainRepeatedAreas, skipReview, reviewJobStatus, reviewJobError, reviewParseable };
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
 *
 * Uses dispatchWithFallback so capacity fallback applies to the strategist
 * dispatch as well.
 */
export async function runStrategizePhase({ cwd, chainId, round, brief, previousRecord, roundRecord, modelChain, _dispatchWithFallback: _dispatch = dispatchWithFallback } = {}) {
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

  const { job: strategistJob, resultText: strategistResultText } = await _dispatch({
    cwd,
    kind: "strategist",
    title: "chain: " + chainId + " round " + round + " strategist",
    promptText: strategistPromptText,
    agent: "kusabi-investigate",
    tools: reviewDenyTools(),
    timeoutS: 1800,
    watchdogS: 900,
    tiers: modelChain,
    // Tier 1, not the round's tier: the strategist runs once per chain and is
    // not part of the quality ladder.  (Before fallback existed this dispatch
    // passed no model at all and took opencode's default.)
    round: 1,
  });

  roundRecord.strategistJobId = strategistJob.id;
  roundRecord.strategistUsage = strategistJob.usage || null;
  roundRecord.strategistModelEntry = strategistJob.modelEntry || null;
  roundRecord.strategistModelVariant = strategistJob.modelVariant || null;
  roundRecord.strategistFallbacks = strategistJob.fallbacks || null;
  roundRecord.strategistRecommendation = (strategistResultText || "").trim() || "(no recommendation)";

  return {
    strategistJobStatus: strategistJob.status,
    strategistJobError: strategistJob.error || null,
  };
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
    const changed = (r.worktreeChanged === undefined || r.worktreeChanged === null) ? "unknown" : r.worktreeChanged ? "yes" : "NO";
    lines.push("Round " + (ri + 1) + ": model=" + (r.modelEntry || "?") + ", verdict=" + r.verdict + ", probesGreen=" + r.probesGreen + ", changed=" + changed + ", resume=" + r.resumeMethod.type + detail);
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
    const changed2 = (r2.worktreeChanged === undefined || r2.worktreeChanged === null) ? "unknown" : r2.worktreeChanged ? "yes" : "NO";
    lines.push("Round " + (ri2 + 1) + ": model=" + (r2.modelEntry || "?") + ", verdict=" + r2.verdict + ", probesGreen=" + r2.probesGreen + ", changed=" + changed2 + ", resume=" + r2.resumeMethod.type + detail2);
  }
  lines.push("", "Hand over to orchestrator for final judgement.");
  return lines.join("\n");
}

/**
 * Render the outcome string when a dispatch has exhausted every route
 * (provider/capacity failure, distinct from escalate or quality failure).
 *
 * @param {object}   opts
 * @param {string}   opts.chainId       — Chain identifier.
 * @param {number}   opts.round         — Round number where exhaustion occurred.
 * @param {string}   opts.phase         — Phase name: "implement", "review", "strategize".
 * @param {string}   opts.jobError      — Error message from the exhausted job
 *                                        (already contains the "All routes
 *                                        exhausted:" text from the wrapper).
 * @param {object[]} opts.records       — Round records so far (includes the
 *                                        aborted partial round).
 * @returns {string}
 */
export function renderProviderExhaustedOutcome({ chainId, round, phase, jobError, records }) {
  const lines = [
    "Chain " + chainId + " stopped at round " + round + ": " + phase + " provider exhausted.",
    "",
    jobError || "(no error detail)",
    "",
  ];

  // Include prior round summaries so the operator sees what was attempted.
  if (records.length > 0) {
    lines.push("Prior rounds:");
    for (let ri = 0; ri < records.length; ri++) {
      const r = records[ri];
      const detail = r.resumeMethod?.detail ? ": " + r.resumeMethod.detail : "";
      const changed = (r.worktreeChanged === undefined || r.worktreeChanged === null) ? "unknown" : r.worktreeChanged ? "yes" : "NO";
      lines.push(
        "  Round " + (ri + 1) + ": model=" + (r.modelEntry || "?") +
        ", verdict=" + (r.verdict || "n/a") +
        ", probesGreen=" + (r.probesGreen ?? "n/a") +
        ", changed=" + changed + ", resume=" + (r.resumeMethod?.type || "?") + detail,
      );
    }
    lines.push("");
  }

  lines.push("Capacity problem — not a quality failure. Retry when provider is available.");
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
export async function runDeliverablesProbe({ deliverables, headingPresent, callTool, container, baseline }) {
  const statusResult = await callTool("sandbox_exec", {
    container_id: container,
    commands: ["git status --porcelain"],
  });
  const statusOutput = statusResult?.output ?? "";
  const changedPaths = parseChangedPaths(statusOutput);

  // When a baseline is provided, restrict the probe to paths newly changed
  // since that baseline.  Captures current worktree state via GIT_INDEX_FILE
  // temp index — does not modify the real index.
  let effectiveChangedPaths = changedPaths;
  let worktreeChanged = null;
  // null = the since-baseline comparison could not be made.  It must NOT start
  // as [], because [] asserts "nothing changed since the baseline" and callers
  // discard a round on that: an unmeasurable round would be thrown away.  It
  // becomes an array only when the comparison actually ran.
  let newlyChangedPaths = null;

  if (baseline) {
    const currentState = await captureWorktreeState(callTool, container);
    if (currentState) {
      newlyChangedPaths = computeNewlyChanged(baseline, currentState);
      worktreeChanged = resolveWorktreeChanged(baseline, currentState);
      // computeNewlyChanged itself returns null when it cannot compare; only
      // narrow the probe to the newly-changed set when it produced one.
      if (newlyChangedPaths) effectiveChangedPaths = newlyChangedPaths;
    }
    // When currentState is null (per-round capture failed), effectiveChangedPaths
    // stays as changedPaths — a graceful fallback that avoids falsely reporting
    // an empty change set when we simply couldn't measure.
  }

  const probeResult = checkDeliverablesSinceBaseline(deliverables, effectiveChangedPaths, headingPresent);
  probeResult.changedPaths = changedPaths;
  probeResult.newlyChangedPaths = newlyChangedPaths;
  probeResult.statusOutput = statusOutput;
  probeResult.worktreeChanged = worktreeChanged;
  return probeResult;
}

// =========================================================================
// Provider-exhaustion handler — extracted for testability
// =========================================================================

/**
 * Handle provider exhaustion for a chain phase.
 *
 * Pure function that decides what goes into `records`, what gets persisted,
 * and what outcome is rendered when a phase job returns
 * `status === "provider-error"`.
 *
 * Whether the round still needs pushing depends on where the failing phase
 * sits relative to phase 7's unconditional push: implement and review return
 * before it, strategize (phase 9) runs after it.  **That is detected here, not
 * passed in.**  A caller that got such a flag wrong would silently duplicate or
 * drop the round — the exact defect PR #119 fixed — and no test of this
 * function could catch a mistake made at the call site.
 *
 * @param {Object} opts
 * @param {Array}  opts.records             - Chain records so far (mutated in place).
 * @param {Object} opts.roundRecord          - Current round record (mutated: tierAfter set).
 * @param {number} opts.currentTierIndex     - Tier index to record as `tierAfter`.
 * @param {string} opts.phase               - Phase name ("implement", "review", "strategize").
 * @param {string|null} [opts.jobError=null] - Provider error detail.
 * @param {string} opts.chainId
 * @param {number} opts.round
 * @param {string} opts.container
 * @param {string} opts.model
 * @param {Array}  opts.modelChain
 * @param {number} opts.maxRounds
 * @param {string} opts.brief
 * @param {string} opts.orchestrator
 * @param {string} opts.baseSha
 * @param {boolean} opts.strategized
 * @param {string|null} [opts.chainFollowupDraft=null]
 * @returns {{ records: Array, chainState: Object, outcome: string }}
 *   - `records`   — the (mutated) records array with roundRecord present exactly once.
 *   - `chainState` — the object that should be written to chain.json.
 *   - `outcome`    — the rendered outcome string for the operator.
 */
export function handleProviderExhaustion({
  records,
  roundRecord,
  currentTierIndex,
  phase,
  jobError = null,
  chainId,
  round,
  container,
  model,
  modelChain,
  maxRounds,
  brief,
  orchestrator,
  baseSha,
  strategized,
  chainFollowupDraft = null,
}) {
  // Record the tier after this round
  roundRecord.tierAfter = currentTierIndex;

  // Whether the round was already pushed depends on where the failing phase sits
  // relative to phase 7's unconditional push: implement and review return before
  // it, strategize runs after it.  That is derived here rather than passed in by
  // the caller — a caller that got the flag wrong would silently duplicate or
  // drop the round, which is the exact bug PR #119 fixed.
  if (!records.includes(roundRecord)) {
    records.push(roundRecord);
  }

  // Compute totals across all rounds
  const chainTotals = computeChainTotals(records);

  // Build the chain state object (what would be persisted to chain.json)
  const chainState = {
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
  };

  // Render outcome
  const outcome = renderProviderExhaustedOutcome({
    chainId,
    round,
    phase,
    jobError,
    records,
  });

  return { records, chainState, outcome };
}
