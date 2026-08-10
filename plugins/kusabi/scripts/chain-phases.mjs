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
  renderReviewRecord,
  renderGroupedFindingsText,
  groupFindingsByKind,
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
// The JSONL review wire format (kusabi #202).  Tried before extractJson;
// a reviewer that still emits one JSON object takes the path below unchanged.
import { parseReviewJsonl } from "./review-jsonl.mjs";
import { deriveReworkStrategy } from "./disposition.mjs";
// resolveRoundResume is defined below and is the only resume-resolution
// mechanism.  checkpoint_restore was removed in issue #114 — the chain
// never rolls the worktree back.
import { writeJson } from "./state-paths.mjs";
// effectiveStatus powers resolveChainResume (kusabi #153①): a chain whose
// pid is gone is an abnormal stop that may be resumed; a live process or a
// finished status is not.  chain-control has no imports from this module, so
// there is no cycle.
import { effectiveStatus } from "./chain-control.mjs";
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

/**
 * Capture the chain-start verify baseline (kusabi #173).
 *
 * Runs `verify_in_container` ONCE on the pristine base worktree (before the
 * round-1 implement dispatch) and records the base's lint/type violation
 * counts plus the raw verify result.  This is the only moment the base is
 * guaranteed unmodified — chain-resume REUSES the recorded baseline from
 * chain.json and never re-captures on a modified worktree.
 *
 * The returned object is stored on chain.json as `verifyBaseline`:
 *   { captured: true, gate_passed, lint, types, raw }
 * When the RPC call itself fails the capture degrades to
 *   { captured: false, error }
 * — the chain still runs, but P2 falls back to today's strict behaviour
 * (a missing baseline is never invented).
 *
 * Counting authority: the `lint` / `types` arrays of the verify result are
 * complete (one element per violation; verified against live sunaba output),
 * so array length is the authoritative count.  When an array is absent the
 * gate's summary line in `gate_fail_reasons` (e.g. "lint (eslint): 3
 * violation(s)") is the fallback; when neither yields a number the count is
 * null and the probe records the limitation instead of passing blind.
 *
 * @param {Function} callTool
 * @param {string}   container
 * @returns {Promise<object>} Baseline record (see above).
 */
export async function captureVerifyBaseline(callTool, container) {
  try {
    const verifyResult = await callTool("verify_in_container", {
      container_id: container,
      path: ".",
    });
    return buildVerifyBaseline(verifyResult);
  } catch (err) {
    return { captured: false, error: err?.message ?? String(err) };
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
 * Decide the scope of a rework round from the previous round's findings
 * (kusabi #60 step 2: scheduling by finding kind).
 *
 * Single decision point for scoped reworks.  The budget invariant: maxRounds
 * buys design/full rounds only; mechanical rounds are free (a mechanical
 * checklist needs no design judgement, so it must not eat the design budget).
 * Missing/invalid `kind` on a finding counts as design (same consumption-point
 * default as groupFindingsByKind).
 *
 * Branch table:
 *   - no findings (probe-failure rework, old records)            -> full, []
 *   - previous round mechanical + any design finding present     -> design, [first]
 *   - findings contain BOTH kinds                                -> mechanical, mechanicalOnly
 *   - findings all design, length > 1                            -> design, [first]
 *   - findings all design, length == 1                           -> design, all
 *   - findings all mechanical                                    -> mechanical, all
 *
 * Array order is preserved: the scoped subset keeps the findings' original
 * order, and the one-per-round design case takes the FIRST design finding in
 * array order.
 *
 * @param {object|null|undefined} previousRecord
 * @returns {{ scope: "full"|"mechanical"|"design", findings: Array }}
 *   `findings` is the subset the round should resolve; for scope "full" it is
 *   empty because the full path renders the entire prior-findings block.
 */
export function resolveReworkScope(previousRecord) {
  if (!previousRecord) {
    return { scope: "full", findings: [] };
  }
  const findings = previousRecord.findings;
  if (!Array.isArray(findings) || findings.length === 0) {
    // Probe-failure rework (or old records without structured findings):
    // current behavior — whole prior findingsText.
    return { scope: "full", findings: [] };
  }
  const { design, mechanical } = groupFindingsByKind(findings);
  if (previousRecord.reworkScope === "mechanical" && design.length > 0) {
    // Followup: no two consecutive mechanical rounds while a design finding
    // is pending.  After a mechanical round, a pending design finding gets
    // the next round even in a mixed set; the mechanical items wait for the
    // following mechanical batch.  Unchanged for any other previous scope
    // (including old records without a reworkScope field).
    return { scope: "design", findings: [design[0]] };
  }
  if (design.length > 0 && mechanical.length > 0) {
    // Mixed: the mechanical checklist first; design findings are held back.
    return { scope: "mechanical", findings: mechanical };
  }
  if (design.length > 1) {
    // All design, several: one per round, in array order.
    return { scope: "design", findings: [design[0]] };
  }
  if (design.length === 1) {
    return { scope: "design", findings: design };
  }
  if (mechanical.length === 0) {
    // Findings array held nothing groupable (non-object entries): treat like
    // no findings rather than claiming a scoped subset.
    return { scope: "full", findings: [] };
  }
  return { scope: "mechanical", findings: mechanical };
}

/**
 * Build the implement prompt text for a chain round.
 *
 * When `container` is given, a header naming the exact container ID is
 * prepended to the returned text for every round (mirroring the review-prompt
 * injection). Without `container` the output is byte-for-byte what this
 * function produced before.
 *
 * `reworkScope` (kusabi #60 step 2) is the resolved scope for this round — the
 * result of `resolveReworkScope(previousRecord)` — decided by the caller so
 * the round loop's budget accounting and the prompt text can never disagree.
 * When absent, or when its `scope` is "full", the output is byte-identical to
 * the pre-scheduling text.  For a scoped round the prior-findings block is
 * replaced by the scope sentence + the FULL per-finding rendering of the
 * scoped subset (`renderPriorFindings` over a record-shaped subset — bodies,
 * recommendations and the same budget bound as the full-scope path), keeping
 * the rest of the prompt structure (instruction / strategist / acceptance
 * criteria) unchanged.
 */
export function buildImplementText({ round, brief, previousRecord, container, reworkScope }) {
  let text;
  if (round === 1) {
    text = brief;
  } else if (previousRecord) {
    let strategistSection = "";
    if (previousRecord.strategistRecommendation) {
      strategistSection = "\n\n## Strategist recommendation (structural change for this rework)\n" + previousRecord.strategistRecommendation + "\n";
    }
    const scope = reworkScope || { scope: "full", findings: [] };
    let priorFindingsText;
    if (scope.scope === "full") {
      // Byte-identical to the pre-scheduling text (kusabi #60 step 2).
      priorFindingsText = renderPriorFindings(previousRecord);
    } else {
      const scopeSentence = scope.scope === "mechanical"
        ? "This round resolves ONLY the following mechanical checklist; other known findings are deliberately out of scope this round."
        : "This round resolves ONLY the following design finding; other known findings are deliberately out of scope this round.";
      // Followup: a scoped round renders its subset with the FULL per-finding
      // renderer (bodies + recommendations, same budget bound as the full
      // path) - a scoped round must give its finding the same deliberate
      // treatment the full path gives the whole set, not a one-line summary.
      priorFindingsText = scopeSentence + "\n\n" + renderPriorFindings({ findings: scope.findings });
    }
    text = "## Prior findings\n" + priorFindingsText + "\n\n## Instruction\nResolve each prior finding in this round. If a finding cannot be fully resolved, you must explain why and report what remains." + strategistSection + "\n\n## Acceptance criteria\n" + brief;
  } else {
    text = brief;
  }
  if (container) {
    return "The workspace lives inside container `" + container + "`. Pass this exact ID as `container_id` to every sunaba tool call. Do not guess container names or call sandbox_attach.\n\n" + text;
  }
  return text;
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
  backend = "opencode",
  _dispatchWithFallback: _dispatch = dispatchWithFallback,
}) {
  let resolvedSession = session;
  if (!resolvedSession && !isFirstRound && previousRecord?.sessionID) {
    // Session lineage guard (kusabi #192 invariant 5): a rework implement
    // round may only continue a session created by the implement backend; a
    // session attributable to a record of the OTHER backend is dropped and
    // the round starts fresh.  Records without a `backend` field predate the
    // backend split and count as "opencode" (readers' convention).
    if (!useNewSession && (previousRecord.backend ?? "opencode") === backend) {
      resolvedSession = previousRecord.sessionID;
    }
  }

  const { job, resultText } = await _dispatch({
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
export async function runProbePhase({ baseSha, container, brief, callTool, worktreeBaseline, verifyBaseline }) {
  const chainDeliverables = parseDeliverables(brief);
  let probesGreen = false;
  const probeResults = [];
  let chainChangedPaths = [];
  let chainNewlyChanged = [];
  let worktreeChanged = null;
  let chainStatusObserved = false;
  let chainStatusOutput = "";

  try {
    const p1Result = await runHeadCleanProbe({ baseSha, callTool, container, sourceLabel: "chain" });
    probeResults.push(p1Result);

    const p2Result = await runVerifyProbe({ callTool, container, baseline: verifyBaseline });
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

  // Base log + diff + untracked for review context (read-only; failures yield
  // empty strings, never errors).
  const diffCtx = await collectContainerDiffContext(callTool, container);

  return {
    probesGreen, probeResults, chainChangedPaths, chainNewlyChanged,
    chainStatusObserved, chainStatusOutput,
    chainBaseLog: diffCtx.chainBaseLog, chainDeliverables,
    chainDiff: diffCtx.chainDiff, chainUntracked: diffCtx.chainUntracked,
    worktreeChanged,
  };
}

/**
 * Collect the container-side context the review prompt renders: the base log,
 * the working diff, and untracked files.  Read-only sandbox_exec calls; every
 * failure yields an empty string rather than an error.
 *
 * @param {Function} callTool   The RPC callTool function (injectable).
 * @param {string}   container  Container ID.
 * @returns {Promise<{ chainBaseLog: string, chainDiff: string, chainUntracked: string }>}
 */
export async function collectContainerDiffContext(callTool, container) {
  // Base log for review context (own try/catch so failure does not affect probesGreen)
  let chainBaseLog = "";
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

  return { chainBaseLog, chainDiff, chainUntracked };
}

/**
 * Collect the review-phase context for a round WITHOUT running the probes.
 *
 * Used by chain-resume (kusabi #153①) when a cancelled chain resumes at the
 * review phase of an interrupted round: the probes already ran and their
 * results are on the persisted round record; only the context the review
 * prompt renders (status, base log, diff, untracked) is re-collected from
 * the container.
 *
 * `worktreeBaseline` should be null here: the interrupted round's changes ARE
 * the review target, and comparing them against a baseline captured at resume
 * time would read as "nothing changed since baseline" and skip the review
 * entirely (shouldSkipReview discards an empty change set).
 *
 * @param {object}  opts
 * @param {string}  opts.container
 * @param {string}  opts.brief
 * @param {Function} opts.callTool
 * @param {object|null} [opts.worktreeBaseline=null]
 * @returns {Promise<object>} The same context fields runProbePhase returns
 *   minus the probe results (probesGreen / probeResults).
 */
export async function collectReviewContext({ container, brief, callTool, worktreeBaseline = null }) {
  const chainDeliverables = parseDeliverables(brief);
  // Degraded-container guard (#153① review): this runs on the RECOVERY path,
  // so a transient container/RPC failure here must degrade, not throw the
  // resumed chain into the terminal "failed" state.  Mirror runProbePhase:
  // on failure the status was NOT observed (chainStatusObserved=false), which
  // shouldSkipReview never reads as "nothing changed" — the review still runs.
  let chainChangedPaths = [];
  let chainNewlyChanged = [];
  let worktreeChanged = false;
  let chainStatusOutput = "";
  let chainStatusObserved = false;
  try {
    const p3Result = await runDeliverablesProbe({
      deliverables: chainDeliverables,
      headingPresent: hasSectionHeading(brief, "Deliverables"),
      callTool,
      container,
      baseline: worktreeBaseline,
    });
    chainChangedPaths = p3Result.changedPaths;
    // `newlyChangedPaths` is null when the comparison could not be made — fall
    // back to the full changed set (same rule as runProbePhase).
    chainNewlyChanged = p3Result.newlyChangedPaths ?? chainChangedPaths;
    worktreeChanged = p3Result.worktreeChanged;
    chainStatusOutput = p3Result.statusOutput;
    chainStatusObserved = true;
  } catch {
    // Degraded: fields keep their "unknown" defaults.
  }
  const diffCtx = await collectContainerDiffContext(callTool, container);

  return {
    chainChangedPaths,
    chainNewlyChanged,
    chainStatusObserved,
    chainStatusOutput,
    chainBaseLog: diffCtx.chainBaseLog,
    chainDeliverables,
    chainDiff: diffCtx.chainDiff,
    chainUntracked: diffCtx.chainUntracked,
    worktreeChanged,
  };
}


/**
 * Parse the reviewer's raw output into the chain's in-memory review shape.
 *
 * Two input formats, in this order (kusabi #202):
 *
 *  1. JSONL — one self-delimiting record per line, written as each piece is
 *     decided (`review-jsonl.mjs`).  Non-JSON lines between records are
 *     ignored, so the reviewer may narrate.  A stream that carried findings
 *     but no `verdict` line is a PARTIAL review: `chainVerdict` is
 *     `"partial"`, a state of its own.  It is not an approval and does not
 *     buy a rework round — it escalates (see deriveDisposition) with the
 *     findings recorded and rendered like any other findings.  It is
 *     `reviewParseable: true`, which is what keeps it out of the §3.5
 *     unparseable retry: we READ this output fine, the model ran out of
 *     room, and re-dispatching spends the budget that just proved
 *     insufficient.
 *
 *  2. A single JSON object, via `extractJson` + VERDICT-token recovery —
 *     unchanged, byte for byte, for every historical record and every
 *     reviewer not yet emitting JSONL.
 *
 * @param {string} reviewResultText
 * @returns {{ chainParsedReview: object|null, chainVerdict: string,
 *             chainFindingsText: string, reviewParseable: boolean,
 *             reviewPartial: boolean, reviewFindingCount: number }}
 */
export function parseReviewResult(reviewResultText) {
  // ---- JSONL first (kusabi #202) ----
  // Returns null for anything that is not JSONL (including an empty stream),
  // which falls through to the single-object path below untouched.
  const jsonl = parseReviewJsonl(reviewResultText);
  if (jsonl) {
    return {
      chainParsedReview: jsonl.review,
      chainVerdict: jsonl.review.verdict,
      chainFindingsText: renderGroupedFindingsText(jsonl.review.findings),
      reviewParseable: true,
      reviewPartial: jsonl.partial,
      reviewFindingCount: jsonl.findingCount,
    };
  }

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
    // Malformed-review guard (kusabi #153): `findings` may arrive as a
    // string/object instead of an array; never call .map on a non-array.
    const findingsArray = Array.isArray(parsed.findings) ? parsed.findings : [];
    // Grouped one-line rendering (kusabi #60 step 1): design findings first,
    // mechanical after, single section when all findings share one kind.
    // The raw findings (including any `kind` tags) still flow through to
    // roundRecord.findings untouched — this is consumption-point rendering.
    const chainFindingsText = renderGroupedFindingsText(findingsArray);
    // The single-object path is never partial: the object either carries a
    // verdict or it is not this path at all.
    return { chainParsedReview: parsed, chainVerdict, chainFindingsText, reviewParseable, reviewPartial: false, reviewFindingCount: findingsArray.length };
  }

  // A2: unparseable review is recorded as a distinct state
  const recoveredV = recoverVerdictFromText(reviewResultText);
  const chainVerdict = recoveredV ? recoveredV.verdict : "unparseable";
  const chainFindingsText = "(review output could not be parsed)";
  return { chainParsedReview: null, chainVerdict, chainFindingsText, reviewParseable, reviewPartial: false, reviewFindingCount: 0 };
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
 * Single result conduit (kusabi #100): everything that belongs on the
 * persisted round record — review-job fields (reviewJobId / reviewUsage /
 * reviewModelEntry / reviewModelVariant / reviewFallbacks), verdict,
 * verdictSource, reviewParseable, findingsText, findings, findingFiles and
 * the unparseable-retry trace fields — is written onto `roundRecord` and is
 * NOT returned.  The return value carries only what is genuinely not record
 * state: the parsed review object, the cross-round repeated-areas signal,
 * whether review was skipped, and the job status/error needed by the
 * caller's provider-exhaustion branch.
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
      reviewPartial: _partial, reviewFindingCount: _findingCount,
    } = parseReviewResult(reviewResultText);

    // ---- retry once on unparseable output ----
    // A job that completes with garbage — no JSON and no recoverable
    // VERDICT token — is usually a transient provider hiccup rather than a
    // genuine verdict (real incident: a 132-token broken review response
    // that re-dispatched cleanly).  Re-dispatch exactly once within this
    // round with identical options and treat the second attempt as final;
    // two consecutive unparseable results escalate exactly as before.  The
    // retry lives entirely inside this phase and never consumes a round.
    //
    // The retry is gated on the first job having COMPLETED: a job that
    // failed outright (serve-dead / stalled / timeout / error) returns
    // empty or garbage resultText, and re-dispatching would double
    // worst-case latency (2 × watchdog 900s / timeout 1800s) in exactly the
    // degraded environments where it is known-futile.  Only a completed job
    // whose output was garbage gets a second attempt; a hard failure
    // escalates after a single attempt, exactly as before the retry existed.
    //
    // A PARTIAL review (kusabi #202) is deliberately NOT a retry case: the
    // JSONL stream was read fine (`_parseable` is true and `_verdict` is
    // "partial", so both guards below already exclude it), the model simply
    // ran out of room.  Re-dispatching spends the budget that just proved
    // insufficient; the partial review escalates with its findings instead.
    if (!_parseable && _verdict === "unparseable" && reviewJob.status === "completed") {
      roundRecord.reviewUnparseableRetried = true;
      roundRecord.reviewFirstJobId = reviewJob.id;
      // First-attempt spend and fallback trail, so retried rounds report
      // their true cost in chain totals (same shapes as the final-attempt
      // reviewUsage / reviewFallbacks fields recorded below).
      roundRecord.reviewFirstUsage = reviewJob.usage || null;
      roundRecord.reviewFirstFallbacks = reviewJob.fallbacks || null;
      ({ job: reviewJob, resultText: reviewResultText } = await _dispatch(reviewDispatchOptions));
      ({ chainParsedReview: _parsed, chainVerdict: _verdict,
         chainFindingsText: _findings, reviewParseable: _parseable,
         reviewPartial: _partial, reviewFindingCount: _findingCount } = parseReviewResult(reviewResultText));
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
    // Partial review (kusabi #202): the record must make it visible that the
    // review was incomplete, and how many findings it did carry.  Written
    // only when partial, so records for complete reviews are unchanged.
    if (_partial) {
      roundRecord.reviewPartial = true;
      roundRecord.reviewFindingCount = _findingCount;
    }
    roundRecord.findingsText = chainFindingsText;

    // ---- store file paths for cross-round comparison ----
    // Stores the raw finding file paths from the parsed review.
    // Comparison uses path-segment suffix matching in hasRepeatedAreas,
    // so absolute vs relative path differences are handled transparently.
    // Malformed-review guard (kusabi #153): normalise a non-array `findings`
    // to [] so nothing downstream calls .map / .forEach on a string.
    const reviewFindingsArray = Array.isArray(chainParsedReview?.findings) ? chainParsedReview.findings : [];
    roundRecord.findingFiles = reviewFindingsArray.map(function (f) { return normalizeFilePath(f.file); });
    roundRecord.findings = reviewFindingsArray;

    // ---- determine repeated areas using hasRepeatedAreas ----
    // Uses the stored findingFiles array instead of re-parsing the
    // human-readable findingsText, which was fragile: it broke on
    // finding titles containing parentheses and on path-form mismatches.
    chainRepeatedAreas = hasRepeatedAreas(previousRecord?.findingFiles, chainParsedReview?.findings);
  }

  // Single conduit: record state stays on roundRecord; the return carries
  // only what is not record state (see the docstring above).
  return { chainParsedReview, chainRepeatedAreas, skipReview, reviewJobStatus, reviewJobError };
}

/**
 * Compute chain-wide usage totals from all round records.
 */
export function computeChainTotals(records) {
  const chainTotals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const rec of records) {
    for (const usage of [rec.implementUsage, rec.reviewUsage, rec.reviewFirstUsage]) {
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
 *
 * `interrupted` (kusabi #153①): the chain stopped at a phase boundary inside
 * this round (implement + probes done, review not run).  The record is marked
 * `interrupted` so chain-show renders it as a partial round and chain-resume
 * can pick up at the next phase.  control.json is finalised by the caller.
 *
 * The round is pushed into `records` idempotently: a chain-resumed round was
 * already pushed when its partial state was persisted at stop time.
 */
export function persistChainState({
  chainDir, round, roundRecord, chainId, container, model, modelChain,
  reviewModel = null, reviewModelChain = null,
  reworkModel = null, reworkModelChain = null, reworkBackend = null,
  maxRounds, brief, orchestrator, records, baseSha, chainTotals,
  strategized, chainFollowupDraft, interrupted = false, verifyBaseline = null,
}) {
  if (interrupted) {
    roundRecord.interrupted = true;
    roundRecord.interruptedAfter = "probes";
  } else if (roundRecord.interrupted) {
    // The round completed after a resume: `interrupted` means "still
    // partial", so a completed round must not keep claiming it (#153①
    // review — chain-show would render a finished, dispositioned round as
    // "interrupted" forever).  The history moves to a separate trace field;
    // `resumed: true` stays for the recovery narrative.
    delete roundRecord.interrupted;
    delete roundRecord.interruptedAfter;
    roundRecord.wasInterrupted = true;
  }
  if (!records.includes(roundRecord)) {
    records.push(roundRecord);
  }
  writeJson(path.join(chainDir, "round-" + round + ".json"), roundRecord);
  writeJson(path.join(chainDir, "chain.json"), {
    chainId,
    container,
    model,
    modelChain,
    // Per-phase review dispatch context (kusabi #192): the review phase's
    // own model + route chain, so chain-resume re-dispatches review on the
    // same backend/model it originally ran on.  Old chain.json files lack
    // these; chain-resume falls back to modelChain / the record's backend.
    reviewModel,
    reviewModelChain,
    // Per-round rework dispatch context (kusabi #192 axis 2): the rework
    // phase's own model, route chain and backend, so chain-resume
    // re-dispatches rework rounds on the same backend/model they originally
    // ran on.  Null on chains without models.phases.rework (rework rounds
    // then continue on the implement resolution); chain.json files written
    // before the key existed lack these keys and chain-resume treats key
    // absence as legacy.
    reworkModel,
    reworkModelChain,
    reworkBackend,
    maxRounds,
    brief,
    orchestrator,
    records,
    baseSha,
    chainTotals,
    strategized,
    followupIssueDraft: chainFollowupDraft,
    // Chain-start verify baseline (kusabi #173): captured on the pristine
    // base before round-1 implement, reused verbatim by chain-resume.
    verifyBaseline,
  });
}

/**
 * Write the chain's postable review record (kusabi #52).
 *
 * Rendered by the pure `renderReviewRecord` (render.mjs) and written to the
 * chain's state directory as `review-record.md`.  Called only when the chain
 * reaches a terminal disposition (accept / accept-with-followup / escalate /
 * max-rounds); cancelled and failed chains never get one.  Regeneration
 * overwrites the previous record.  The companion only writes the local file
 * and returns its path — posting it to the archive repository is
 * orchestrator-exclusive.
 *
 * @param {object} opts
 * @param {string} opts.chainDir
 * @param {string} opts.chainId
 * @param {string} opts.container
 * @param {Array}  [opts.modelChain]
 * @param {number} [opts.maxRounds]
 * @param {string} [opts.brief]
 * @param {object|null} [opts.orchestrator]
 * @param {Array}  [opts.records]       — round records (used as-is).
 * @param {object} [opts.chainTotals]   — existing chainTotals; recomputed
 *                                       from records only when not given.
 * @param {{disposition: string, round: number, reason?: string|null}} opts.disposition
 *                                       — the FINAL disposition.
 * @param {string} [opts.label]         — repo/cwd label for the header.
 * @param {string} [opts.finishedAt]    — ISO timestamp; defaults to now.
 * @returns {string} The absolute path of the written record file.
 */
export function writeReviewRecord({
  chainDir, chainId, container, modelChain, maxRounds, brief, orchestrator,
  records, chainTotals, disposition, round, label, finishedAt,
}) {
  const safeRecords = Array.isArray(records) ? records : [];
  const markdown = renderReviewRecord({
    chainId,
    container,
    label,
    brief,
    orchestrator,
    modelChain,
    maxRounds,
    records: safeRecords,
    chainTotals: chainTotals ?? computeChainTotals(safeRecords),
    disposition: {
      disposition: disposition?.disposition ?? "unknown",
      round,
      reason: disposition?.reason ?? null,
    },
    finishedAt,
  });
  const recordPath = path.join(chainDir, "review-record.md");
  fs.mkdirSync(chainDir, { recursive: true });
  // Atomic write: readers must never observe a truncated record — the file is
  // posted as authoritative by the orchestrator.
  const tmpPath = recordPath + ".tmp";
  fs.writeFileSync(tmpPath, markdown, "utf8");
  fs.renameSync(tmpPath, recordPath);
  return recordPath;
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
 * Count the violations reported for one gate in a verify result.
 *
 * Counting authority (kusabi #173): the `lint` / `types` arrays in the
 * verify result are complete — one element per violation (verified against
 * live sunaba output 2026-08-08).  Array length is therefore the
 * authoritative count.  When the array is absent (older responses, or the
 * gate never ran) the gate's own summary line in `gate_fail_reasons` is the
 * fallback, matching sunaba gate.py's real formats: "lint (<tool>): <N>
 * violation(s)" and "type_check (<tool>): <N> error(s)".  When neither
 * yields a number the count is null, and callers must treat null as "no reliable
 * count" (the probe records the limitation and keeps today's strict
 * behaviour instead of passing blind).
 *
 * @param {object|null} verifyResult  — the verify_in_container result.
 * @param {"lint"|"types"} gate       — which gate to count.
 * @returns {number|null} Violation count, or null when not countable.
 */
export function countVerifyViolations(verifyResult, gate) {
  if (!verifyResult || typeof verifyResult !== "object") return null;
  const arr = verifyResult[gate];
  if (Array.isArray(arr)) return arr.length;
  const reasons = Array.isArray(verifyResult.gate_fail_reasons)
    ? verifyResult.gate_fail_reasons
    : [];
  // Real sunaba gate.py summary formats (verified against gate.py source and
  // live output 2026-08-08): lint → "lint (<tool>): <N> violation(s)",
  // types → "type_check (<tool>): <N> error(s)".
  const re = gate === "types"
    ? /^type_check\b[^:]*:\s*(\d+)\s+error/i
    : /^lint\b[^:]*:\s*(\d+)\s+violation/i;
  for (const reason of reasons) {
    const m = String(reason).match(re);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Build the chain-start verify baseline record from a verify result.
 *
 * @param {object|null} verifyResult
 * @returns {{ captured: true, gate_passed: boolean, lint: number|null, types: number|null, raw: object }}
 */
export function buildVerifyBaseline(verifyResult) {
  return {
    captured: true,
    gate_passed: verifyResult?.gate_passed === true,
    lint: countVerifyViolations(verifyResult, "lint"),
    types: countVerifyViolations(verifyResult, "types"),
    raw: verifyResult ?? null,
  };
}

/**
 * P2: Run the verify gate (verify_in_container) with no skip flags.
 *
 * Gate passed → PASS, byte-identical to the pre-#173 behaviour.  Gate failed
 * with test failures → FAIL, unchanged.  Gate failed on the lint/type
 * precondition (tests never ran) → the chain-start verify baseline decides:
 * current violation counts ≤ baseline for every gate that failed → re-run
 * verify with the tolerated gates skipped (so tests actually execute) and
 * pass iff that run's tests are green; any count above baseline → FAIL naming
 * the increment.  Without a baseline (or without a reliable count) the probe
 * records the limitation and keeps today's strict FAIL rather than guessing.
 *
 * @param {object}   opts
 * @param {Function} opts.callTool
 * @param {string}   opts.container
 * @param {object|null} [opts.baseline] — chain-start verify baseline
 *        (`captureVerifyBaseline` output), or null for strict behaviour.
 * @returns {Promise<object>} { probe, passed, detail }
 */
export async function runVerifyProbe({ callTool, container, baseline }) {
  const verifyResult = await callTool("verify_in_container", {
    container_id: container,
    path: ".",
  });

  // Fast path: gate green → PASS (byte-identical to today).
  if (verifyResult?.gate_passed === true) {
    return { probe: "P2: verify gate", passed: true, detail: JSON.stringify(verifyResult) };
  }

  // Gate failed.  Distinguish "tests ran and failed" from "lint/type
  // precondition failed (tests never ran)".  sunaba runs the lint/type gates
  // as a precondition: when they fail, `tests` reports `status: "skipped"`
  // and the test phase never ran.  When tests did run (`tests.full` exists),
  // their verdict is authoritative — the baseline must never skip it.
  const tests = verifyResult?.tests;
  const testsRan = !!(tests && typeof tests === "object" && tests.full);
  if (testsRan) {
    return { probe: "P2: verify gate", passed: false, detail: JSON.stringify(verifyResult) };
  }

  // Precondition failure: only the baseline path can make this a PASS.
  if (!baseline || baseline.captured !== true) {
    return {
      probe: "P2: verify gate",
      passed: false,
      detail: JSON.stringify(verifyResult),
      limitation: "verify failed on the lint/type precondition but no chain-start baseline is recorded; P2 stayed strict",
    };
  }

  const lintCount = countVerifyViolations(verifyResult, "lint");
  const typesCount = countVerifyViolations(verifyResult, "types");
  const tolerances = [];
  const skips = {};

  // A gate "failed" when it reports violations (count > 0).  For each failed
  // gate, current ≤ baseline → tolerated (skip it on the re-run); current >
  // baseline → FAIL naming the increment.
  if (lintCount !== null && lintCount > 0) {
    if (typeof baseline.lint !== "number") {
      return {
        probe: "P2: verify gate",
        passed: false,
        detail: JSON.stringify(verifyResult),
        limitation: "lint gate failed but the baseline has no reliable lint count; P2 stayed strict",
      };
    }
    if (lintCount > baseline.lint) {
      return {
        probe: "P2: verify gate",
        passed: false,
        detail: `lint ${lintCount} > baseline ${baseline.lint}`,
      };
    }
    tolerances.push(`lint ${lintCount} (baseline ${baseline.lint}, tolerated)`);
    skips.skip_lint_gate = true;
  }
  if (typesCount !== null && typesCount > 0) {
    if (typeof baseline.types !== "number") {
      return {
        probe: "P2: verify gate",
        passed: false,
        detail: JSON.stringify(verifyResult),
        limitation: "types gate failed but the baseline has no reliable types count; P2 stayed strict",
      };
    }
    if (typesCount > baseline.types) {
      return {
        probe: "P2: verify gate",
        passed: false,
        detail: `types ${typesCount} > baseline ${baseline.types}`,
      };
    }
    tolerances.push(`types ${typesCount} (baseline ${baseline.types}, tolerated)`);
    skips.skip_type_gate = true;
  }

  // A gate failed (tests were skipped) but neither gate reports violations we
  // can count → the failure is not a tolerable lint/type delta.  Record the
  // limitation and keep strict behaviour rather than passing blind.
  if (Object.keys(skips).length === 0) {
    return {
      probe: "P2: verify gate",
      passed: false,
      detail: JSON.stringify(verifyResult),
      limitation: "verify failed on the lint/type precondition but no violation counts are reportable; P2 stayed strict",
    };
  }

  // All failed gates are at or under their baseline → re-run with the
  // tolerated gates skipped so the tests actually execute.
  const retryResult = await callTool("verify_in_container", {
    container_id: container,
    path: ".",
    ...skips,
  });
  const testsGreen = retryResult?.gate_passed === true;
  // On a failed retry, distinguish "tests ran and failed" from "still blocked
  // before tests" (an untolerated precondition gate — e.g. patch_targets — or
  // an error envelope): claiming "tests not ok" when tests never ran is the
  // exact mislabel this baseline path exists to fix.
  let outcome;
  if (testsGreen) {
    outcome = "tests ok";
  } else if (retryResult?.tests && typeof retryResult.tests === "object" && retryResult.tests.full) {
    outcome = "tests not ok";
  } else {
    const reasons = Array.isArray(retryResult?.gate_fail_reasons) && retryResult.gate_fail_reasons.length > 0
      ? retryResult.gate_fail_reasons.join("; ")
      : "no gate_fail_reasons reported";
    outcome = `still blocked before tests (${reasons})`;
  }
  return {
    probe: "P2: verify gate",
    passed: testsGreen,
    detail: `${tolerances.join(", ")}; ${outcome}`,
  };
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
// Tier escalation clamping
// =========================================================================

/**
 * Clamp a rework tier escalation to the modelChain's tier range.
 *
 * Pure function.  The model ladder is 0..tierCount-1; `selectRoutes` already
 * clamps dispatch, so an escalation past the top tier never changes the
 * model actually used — but the *recorded* tier must match it too (kusabi
 * #153: a 1-tier chain recorded "0 → 1" while the job stayed on flash, and
 * the orchestrator misread it as a stronger-model re-run).
 *
 * @param {object} opts
 * @param {number} opts.currentTierIndex  - Tier index before this escalation.
 * @param {number} opts.tierDelta         - Escalation step (normally +1).
 * @param {number} opts.tierCount         - Number of tiers in modelChain.
 * @returns {{ tierIndex: number, clamped: boolean, reason: string|null }}
 *   - `tierIndex` — min(current + delta, tierCount - 1).
 *   - `clamped`   — true when the raw escalation exceeded the top tier.
 *   - `reason`    — human-readable why (null when not clamped).
 */
export function applyTierEscalation({ currentTierIndex, tierDelta, tierCount }) {
  const nextTier = currentTierIndex + tierDelta;
  if (!Number.isFinite(tierCount) || tierCount <= 0) {
    // No usable ladder: nothing to clamp against.
    return { tierIndex: nextTier, clamped: false, reason: null };
  }
  const maxTier = tierCount - 1;
  if (nextTier <= maxTier) {
    return { tierIndex: nextTier, clamped: false, reason: null };
  }
  const reason = tierCount === 1
    ? "single-tier chain"
    : "escalation beyond top tier (modelChain has " + tierCount + " tiers)";
  return { tierIndex: maxTier, clamped: true, reason };
}

/**
 * Apply the rework levers for the NEXT round and record them on the current
 * round record, with the tier escalation clamped to the modelChain range.
 *
 * This is the driver's rework branch, extracted so the round-record contract
 * (tierAfter / tierClamped / tierClampReason) is testable without running a
 * chain.  Mutates roundRecord with the clamp fields only; the caller still
 * records `tierAfter` and `pendingReworkStrategy` on the round record and
 * persists cross-round state as before.
 *
 * @param {object} opts
 * @param {object} opts.roundRecord       - Current round record (mutated: tierClamped/tierClampReason).
 * @param {number} opts.currentTierIndex  - Tier index before this escalation.
 * @param {number} opts.reworkCount       - Reworks done so far (pre-increment).
 * @param {boolean} opts.strategized      - Whether a strategize already ran.
 * @param {number} opts.tierCount         - Number of tiers in modelChain.
 * @param {string} [opts.chainVerdict]    - Finished round's review verdict (anchoring-override evidence, #62).
 * @param {boolean} [opts.chainRepeatedAreas] - Same file area flagged across rounds.
 * @param {boolean} [opts.probesGreen]    - Finished round's deterministic probes passed.
 * @returns {{ currentTierIndex: number, strategy: { tierDelta: number, newSession: boolean, reason: string } }}
 */
export function recordReworkEscalation({ roundRecord, currentTierIndex, reworkCount, strategized, tierCount, chainVerdict, chainRepeatedAreas, probesGreen }) {
  const strategy = deriveReworkStrategy({
    reworkCount, strategized,
    verdict: chainVerdict, probesGreen, repeatedAreas: chainRepeatedAreas,
  });
  const { tierIndex, clamped, reason } = applyTierEscalation({
    currentTierIndex,
    tierDelta: strategy.tierDelta,
    tierCount,
  });
  roundRecord.tierClamped = clamped;
  roundRecord.tierClampReason = clamped ? reason : null;
  if (clamped && strategy.tierDelta > 0) {
    // The stored/rendered strategy reason must never claim an escalation
    // that dispatch did not perform (#153④): chain-show prints this string
    // right next to the clamped tier line, and "escalate tier" there reads
    // as a stronger-model re-run.
    strategy.reason = strategy.reason.replace(
      /escalate tier/g,
      `tier unchanged (escalation clamped: ${reason})`,
    );
  }
  return { currentTierIndex: tierIndex, strategy };
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
 * @param {string|object|null} [opts.reviewModel=null]       \u2014 review dispatch
 *        model, persisted verbatim so chain-resume keeps the review context.
 * @param {Array|null} [opts.reviewModelChain=null]          \u2014 review dispatch
 *        route chain, persisted verbatim (same contract as persistChainState).
 * @param {string|object|null} [opts.reworkModel=null]       \u2014 rework dispatch
 *        model, persisted verbatim so chain-resume keeps the rework context
 *        (kusabi #192 axis 2).
 * @param {Array|null} [opts.reworkModelChain=null]          \u2014 rework dispatch
 *        route chain, persisted verbatim (same contract as persistChainState).
 * @param {\"opencode\"|\"claude\"|null} [opts.reworkBackend=null] \u2014 rework
 *        dispatch backend, persisted verbatim so chain-resume re-dispatches
 *        rework rounds on the backend they originally ran on.
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
  reviewModel = null,
  reviewModelChain = null,
  reworkModel = null,
  reworkModelChain = null,
  reworkBackend = null,
  maxRounds,
  brief,
  orchestrator,
  baseSha,
  strategized,
  chainFollowupDraft = null,
  verifyBaseline = null,
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
    // Per-phase review dispatch context (kusabi #192): carried verbatim so
    // provider-exhaustion chain.json writes keep the review context that
    // persistChainState would have persisted \u2014 a later chain-resume must not
    // fall back reviewModelChain ?? modelChain and re-dispatch the review on
    // the implement's claude chain.
    reviewModel,
    reviewModelChain,
    // Per-round rework dispatch context (kusabi #192 axis 2): carried
    // verbatim for the same reason \u2014 provider-exhaustion chain.json writes
    // must keep the rework context persistChainState would have persisted,
    // or a later chain-resume re-dispatches rework rounds on the implement
    // resolution (wrong backend / wrong chain).
    reworkModel,
    reworkModelChain,
    reworkBackend,
    maxRounds,
    brief,
    orchestrator,
    records,
    baseSha,
    chainTotals,
    strategized,
    followupIssueDraft: chainFollowupDraft,
    // Chain-start verify baseline (kusabi #173) — carried on every chain.json
    // write so chain-resume reuses the recorded baseline.
    verifyBaseline,
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

// =========================================================================
// Chain resume (kusabi #153①) — resume-position resolution
// =========================================================================

/**
 * Decide where a stopped chain resumes, from its persisted state alone.
 *
 * Pure function: reads nothing, writes nothing.  The caller still validates
 * container reachability before re-running (a resumed chain's work lives in
 * the recorded container; the state root is machine-local).
 *
 * Preconditions (explicit errors for everything else):
 *   - The chain must be stopped: status "cancelled", or "running" with a dead
 *     pid (stale — abnormal stop).  A live process (running / stopping) and
 *     any finished status (completed / failed) are errors.
 *
 * Resume position, from the LAST round record in chain.json:
 *   - Last record has implement done but no review/disposition (an
 *     interrupted round persisted at stop time) → resume at that round's
 *     REVIEW phase, continuing the persisted partial record.
 *   - Last record is complete with disposition rework/strategize → resume at
 *     the NEXT round's IMPLEMENT phase (rework: with the escalated
 *     tier/reworkCount; strategize: with the fresh-session lever from the
 *     record's pendingReworkStrategy).
 *   - Terminal dispositions (accept / accept-with-followup / escalate) mean
 *     the chain already finished — error.
 *
 * Cross-round state (reworkCount, currentTierIndex, strategized, session,
 * baseSha) is derived from the record fields so the resumed run continues the
 * ladder exactly where the original left off.
 *
 * `currentTierIndex` addresses the chain the NEXT round dispatches on
 * (kusabi #192 axis 2): the implement chain for a round-1 resume, the REWORK
 * chain from round 2 on when a models.phases.rework chain was configured
 * (rework rounds run the tier ladder over the rework chain; the persisted
 * tierAfter/tierBefore were recorded against it).  The driver re-dispatches
 * rework rounds on the rework resolution restored from chain.json, so the
 * index is applied to the same chain it was recorded against.
 *
 * @param {object}  opts
 * @param {object|null} opts.control    — control.json record.
 * @param {object|null} opts.chainJson  — chain.json record.
 * @returns {{ ok: true, position: object } | { ok: false, error: string }}
 *   `position`:
 *   - `phase`        — "review" | "implement"
 *   - `round`        — round to continue at
 *   - `roundRecord`  — the persisted partial record (review-resume only)
 *   - `records`      — chain.json records array (continued in place)
 *   - `reworkCount`, `currentTierIndex`, `strategized`, `session`, `baseSha`
 */
export function resolveChainResume({ control, chainJson }) {
  if (!control) {
    return { ok: false, error: "no control record (control.json missing)" };
  }
  if (!chainJson) {
    return { ok: false, error: "no chain.json (nothing was persisted)" };
  }

  const { status, stale } = effectiveStatus(control);
  if (status === "running" || status === "stopping") {
    return {
      ok: false,
      error: `chain is still running (pid ${control.pid}) — stop it first (chain-cancel)`,
    };
  }
  if (status !== "cancelled" && !stale) {
    return {
      ok: false,
      error: `chain already finished (status: ${status})`,
    };
  }

  if (!Array.isArray(chainJson.modelChain) || chainJson.modelChain.length === 0) {
    return { ok: false, error: "chain.json has no modelChain to dispatch with" };
  }
  if (typeof chainJson.brief !== "string" || !chainJson.brief.trim()) {
    return { ok: false, error: "chain.json has no brief to continue with" };
  }

  const maxRounds = Number.isInteger(chainJson.maxRounds) && chainJson.maxRounds > 0
    ? chainJson.maxRounds
    : 4;
  const records = Array.isArray(chainJson.records) ? chainJson.records : [];
  const last = records.length > 0 ? records[records.length - 1] : null;
  const strategized = !!chainJson.strategized;
  const baseSha = chainJson.baseSha ?? null;

  if (!last) {
    return {
      ok: false,
      error: "no round records to resume from (the chain stopped before completing a round)",
    };
  }

  const lastDisposition = last.disposition?.disposition;
  if (lastDisposition) {
    if (lastDisposition === "accept" || lastDisposition === "accept-with-followup" || lastDisposition === "escalate") {
      return {
        ok: false,
        error: `chain already finished (last round ${last.round} disposition: ${lastDisposition})`,
      };
    }
    const nextRound = (last.round ?? records.length) + 1;
    // ---- budget-derived guard (kusabi #60 step 2) ----
    // Mirrors the driver's budget semantics: maxRounds buys design/full
    // rounds only, mechanical rounds are free, so the raw round number may
    // legitimately exceed maxRounds (hard cap 2 × maxRounds).  Resume is
    // refused only when the derived budget is spent or the hard cap would be
    // exceeded — never on the raw round count alone.
    //
    // Records without a `reworkScope` field predate the scheduling change;
    // for such chains the round number IS the budget (every round was full),
    // so the legacy guard applies: nextRound > maxRounds means the budget is
    // spent.  Once any record carries `reworkScope`, the budget is derived
    // by counting non-mechanical records exactly as the driver does.
    const anyScoped = records.some((r) => r.reworkScope !== undefined);
    const budgetExhausted = anyScoped
      ? records.filter((r) => r.reworkScope !== "mechanical").length >= maxRounds
        || nextRound > 2 * maxRounds
      : nextRound > maxRounds;
    if (budgetExhausted) {
      return {
        ok: false,
        error: `max rounds (${maxRounds}) already reached at round ${last.round}`,
      };
    }
    return {
      ok: true,
      position: {
        phase: "implement",
        round: nextRound,
        roundRecord: null,
        records,
        // A rework consumed one rework; a strategize did not.
        reworkCount: (last.reworkCount ?? 0) + (lastDisposition === "rework" ? 1 : 0),
        currentTierIndex: last.tierAfter ?? last.tierBefore ?? 0,
        strategized,
        session: last.sessionID ?? undefined,
        baseSha,
      },
    };
  }

  // No disposition → partial (interrupted) round.
  if (!last.implementJobId) {
    return {
      ok: false,
      error: `round ${last.round ?? "?"} record has no implement job — no phase boundary to resume at`,
    };
  }
  if (last.reviewJobId || last.verdict) {
    return {
      ok: false,
      error: `round ${last.round} record is inconsistent (review present but no disposition) — manual inspection required`,
    };
  }
  return {
    ok: true,
    position: {
      phase: "review",
      round: last.round,
      roundRecord: last,
      records,
      reworkCount: last.reworkCount ?? 0,
      currentTierIndex: last.tierBefore ?? 0,
      strategized,
      session: last.sessionID ?? undefined,
      baseSha,
    },
  };
}
