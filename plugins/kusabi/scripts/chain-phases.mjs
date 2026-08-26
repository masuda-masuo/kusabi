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
  backendSupportsResume,
  resolveModelBackend,
} from "./cli.mjs";
import {
  renderContainerReviewInput,
  renderPriorFindings,
  renderEscalationDecisions,
  renderStrategistPrompt,
  renderReview,
  renderFollowupDraft,
  renderReviewRecord,
  renderGroupedFindingsText,
  groupFindingsByKind,
  extractJson,
  recoverVerdictFromText,
  roundDiscardReason,
  roundChangedColumn,
} from "./render.mjs";
import {
  hasSectionHeading,
  parseDeliverables,
  parseFrozenTests,
  parseSmoke,
  parseChangedPaths,
} from "./brief-parsing.mjs";
import {
  checkSmokeProbe,
  parseRefusalBlock,
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
import { deriveStopReason } from "./stop-reason.mjs";
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
 * Render the {{PRIOR_FINDINGS}} slot of the review prompt for a round
 * (kusabi #334).
 *
 * The review seam receives the round's resolved scope the same way
 * buildImplementText does, and this renderer partitions the previous round's
 * findings from that ONE value.  A full-scope round (or no reworkScope at
 * all) renders byte-for-byte what the pre-scoping review prompt rendered:
 * previousRecord.findingsText verbatim, or the first-review marker when
 * there is no previous record.  A scoped round renders a partition instead:
 * the in-scope findings in full (the same per-finding renderer the implement
 * prompt uses for its scoped subset) followed by the deliberately-held
 * findings as one-line rows, marked still open and NOT a failure of this
 * round.
 *
 * Held findings are identified by identity: reworkScope.findings is a subset
 * of previousRecord.findings produced by resolveReworkScope, so an element
 * of the previous list that is not in the subset is held.  Held findings
 * KEEP being re-reported — they are open, they just were not in this round's
 * scope — because the re-reporting is the only thing that keeps a mechanical
 * round from approving and ending the chain with its design findings
 * unfixed.  The prompt never tells the reviewer to drop them.
 *
 * @param {object|null|undefined} previousRecord
 * @param {{scope: string, findings: Array}|undefined|null} reworkScope
 * @returns {string}
 */
export function renderReviewPriorFindings(previousRecord, reworkScope) {
  if (!reworkScope || reworkScope.scope === "full") {
    // Byte-identical to the pre-scoping text (kusabi #334): the reviewer
    // sees the whole prior list, exactly as today.
    return previousRecord?.findingsText || "(none -- first review round)";
  }
  const previousFindings = Array.isArray(previousRecord?.findings) ? previousRecord.findings : [];
  const inScope = Array.isArray(reworkScope.findings) ? reworkScope.findings : [];
  const held = previousFindings.filter((f) => !inScope.includes(f));
  const scopeWord = reworkScope.scope === "mechanical" ? "mechanical" : "design";
  const lines = [];
  lines.push(
    "This round was scoped to " + scopeWord + " findings.  The prior findings the round was asked to resolve are:"
  );
  lines.push("");
  lines.push(renderPriorFindings({ findings: inScope }));
  lines.push("");
  if (held.length > 0) {
    lines.push(
      "The following prior findings were known and DELIBERATELY HELD OUT of this round's scope. " +
      "They are still open — this round was not asked to resolve them. " +
      "Re-report each one you can confirm is still unfixed, described as still open and outside " +
      "this round's scope — never as work this round failed to do:"
    );
    lines.push("");
    lines.push(held.map(reviewFindingRow).join("\n"));
  } else {
    lines.push(
      "No prior findings were held out of this round's scope: every known finding was in scope."
    );
  }
  return lines.join("\n");
}

/**
 * One-line row for a held finding in the scoped review prompt — the same
 * "[severity] title (file:line)" shape renderGroupedFindingsText uses, so
 * the reviewer recognises the held items from the previous round's report.
 * Kept local: render.mjs is shared with the task route and this shape is
 * only used by the chain review seam.
 *
 * @param {object|undefined} f
 * @returns {string}
 */
function reviewFindingRow(f) {
  const severity = f && f.severity ? f.severity : "unknown";
  const title = f && f.title ? f.title : "(untitled)";
  const file = f && f.file ? f.file : "?";
  const lineStart = f && f.line_start !== undefined ? f.line_start : "?";
  return "[" + severity + "] " + title + " (" + file + ":" + lineStart + ")";
}

/**
 * Narrow the previous round's finding files to the ones the reviewed round
 * was actually asked to resolve (kusabi #334).
 *
 * hasRepeatedAreas is shared surface with chain-stats (docs/design/
 * phase-chain.md), so its name, signature and semantics are frozen — this
 * function narrows what is PASSED to it, it does not fork the detector.  A
 * full-scope round passes previousRecord.findingFiles exactly as the
 * pre-scoping code did: every prior finding was in scope, so the computed
 * signal is identical to today's.  A scoped round passes only the in-scope
 * findings' files — a finding the round was told to leave alone is not
 * evidence of a stall.
 *
 * @param {object|null|undefined} previousRecord
 * @param {{scope: string, findings: Array}|undefined|null} reworkScope
 * @returns {string[]|undefined}
 */
export function inScopeFindingFiles(previousRecord, reworkScope) {
  if (!reworkScope || reworkScope.scope === "full") {
    return previousRecord?.findingFiles;
  }
  const inScope = Array.isArray(reworkScope.findings) ? reworkScope.findings : [];
  return inScope.map((f) => normalizeFilePath(f.file));
}

/**
 * Prepend the workspace header naming the exact container ID, or return the
 * text unchanged when there is no container.
 *
 * Extracted from buildImplementText (kusabi #289) because the single-shot
 * `task --container <cid>` path needs the SAME sentence: the chain injected
 * the id into its implement prompt while `task` only recorded it on the job,
 * so a worker dispatched by `task --phase implement --container <cid>` with a
 * brief that carried no `## Workplace` section had nothing to read the id out
 * of — one such job guessed ten `sandbox_attach` names, all failed, and
 * finished 171s with zero edits.  One function, one wording: a brief that
 * also names its workplace is then a harmless duplicate, and a stale id in a
 * brief loses to the fresh `--container` value stated first.
 *
 * @param {string} text                     The prompt text to prefix.
 * @param {string|null|undefined} container  The container ID, if any.
 * @returns {string}
 */
export function withContainerWorkspace(text, container) {
  if (!container) return text;
  return "The workspace lives inside container `" + container + "`. Pass this exact ID as `container_id` to every sunaba tool call. Do not guess container names or call sandbox_attach.\n\n" + text;
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
  return withContainerWorkspace(text, container);
}

// =========================================================================
// Dispatch-failure quota classification (kusabi #373)
//
// A review (or implement) job that produced NO payload is not an unreadable
// verdict: `verdict: unparseable` means a payload arrived and could not be
// read.  When the backend named a quota-exhausted pool in the failure text,
// the round record must carry that as its own field so chain-show and
// chain-resume can tell the two failures apart without opening job.json.
//
// Classify ONLY phrases that have been observed.  A false positive here
// hard-stops a chain that could have continued (agy-dispatch.mjs documents
// the same principle for its own quota handling).
// Observed:
//   agy:      "Individual quota reached. Please upgrade your subscription
//              to increase your limits. Resets in 1h1m21s."
//   opencode: "Free usage exceeded, subscribe to Go"
// Claude already classifies from the structured payload (kusabi #215) and
// writes job.failure; this layer fills in when the adapter left failure null.
// =========================================================================

const AGY_QUOTA_MARKER = "Individual quota reached";
const OPENCODE_QUOTA_MARKER = "Free usage exceeded";

/**
 * Classify a dispatch-failure text as quota exhaustion of a named backend.
 * Returns null when the text does not contain an observed phrase.
 *
 * @param {string|null|undefined} errorText
 * @returns {null | {
 *   kind: "quota-exhaustion",
 *   backend: "agy" | "opencode",
 *   quota: "individual" | "free-tier",
 *   backendBlocked: boolean,
 *   reset: string | null,
 * }}
 */
export function classifyDispatchQuotaExhaustion(errorText) {
  if (typeof errorText !== "string" || errorText.length === 0) return null;
  if (errorText.includes(AGY_QUOTA_MARKER)) {
    const resetMatch = errorText.match(/Resets in ([^\s.]+)/);
    return {
      kind: "quota-exhaustion",
      backend: "agy",
      quota: "individual",
      backendBlocked: true,
      reset: resetMatch ? resetMatch[1] : null,
    };
  }
  if (errorText.includes(OPENCODE_QUOTA_MARKER)) {
    return {
      kind: "quota-exhaustion",
      backend: "opencode",
      quota: "free-tier",
      backendBlocked: true,
      reset: null,
    };
  }
  return null;
}

/**
 * The escalate reason chain-show prints for a quota-exhausted review seat.
 * Named so the digest never reads as `unexpected verdict: unparseable`.
 *
 * @param {object} failure — `{ kind: "quota-exhaustion", ... }`
 * @returns {string}
 */
export function quotaExhaustionReason(failure) {
  const backend = failure?.backend || "provider";
  const pool = failure?.quota === "free-tier"
    ? "free-tier pool"
    : failure?.quota === "individual"
      ? "individual pool"
      : failure?.quota
        ? failure.quota + " pool"
        : "pool";
  const reset = failure?.reset
    ? (/^\d/.test(String(failure.reset)) ? "; resets in " + failure.reset : "; resets " + failure.reset)
    : "";
  return "quota exhausted (" + backend + " " + pool + ")" + reset;
}

/**
 * chain-resume refusal when the recorded failure was quota exhaustion and
 * the operator did not name a different route.
 *
 * @param {object} failure
 * @returns {string}
 */
export function quotaReplacementRefusal(failure) {
  const backend = failure?.backend || "the current backend";
  const quota = failure?.quota ? " (" + failure.quota + ")" : "";
  return (
    "review seat died of quota exhaustion on " + backend + quota +
    ". Buying the same seat cannot work. Route the replacement with " +
    "--backend opencode|claude|agy|cursor or --model <id> (a different backend or model)."
  );
}

/**
 * The structured quota-exhaustion fact on a round record, or null.
 *
 * @param {object|null|undefined} record
 * @returns {object|null}
 */
export function recordQuotaExhaustion(record) {
  const failure = record?.reviewJobFailure;
  if (failure && failure.kind === "quota-exhaustion") return failure;
  return null;
}

/**
 * True when the operator named a model or backend that is not the recorded
 * review seat's route — the one case where buying a replacement after quota
 * exhaustion can work.
 *
 * @param {object} record
 * @param {{ backend?: string|null, model?: string|null }|null|undefined} explicitRoute
 * @returns {boolean}
 */
export function explicitRouteDiffersFromRecord(record, explicitRoute) {
  if (!explicitRoute || typeof explicitRoute !== "object") return false;
  const recordedBackend = record.reviewBackend ?? record.backend ?? "opencode";
  if (explicitRoute.backend && explicitRoute.backend !== recordedBackend) return true;
  if (explicitRoute.model) {
    let spec;
    try {
      spec = resolveModelBackend(explicitRoute.model);
    } catch {
      spec = null;
    }
    if (spec?.backend && spec.backend !== recordedBackend) return true;
    const recordedModel = record.reviewModelEntry ?? "";
    const wanted = spec?.model ?? explicitRoute.model;
    if (wanted && wanted !== recordedModel && explicitRoute.model !== recordedModel) return true;
  }
  return false;
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
  useNewSession, session, sessionProvenance, previousRecord, resumeMethod, flagsModel,
  backend = "opencode",
  _dispatchWithFallback: _dispatch = dispatchWithFallback,
}) {
  // Session lineage guard (kusabi #199 shape, #316 resume): a session is
  // carried into a backend only when the backend can resume one AND the
  // session's provenance is established.  For agy both halves matter: the
  // dispatch itself refuses a bare UUID without the caller's provenance
  // signal (assertNoAgySession), so a chain that forwarded an unproven
  // session would throw at dispatch instead of running — this seam must
  // either prove the session (from the previous round's record, below) or
  // pass through the caller's proof (chain-resume's initialSession
  // provenance, established at command start where the job store is in
  // hand).  claude and opencode ignore the signal; the forwarding is
  // byte-identical for them.
  let resolvedSession = backendSupportsResume(backend) ? session : undefined;
  let resolvedSessionProvenance = null;
  if (resolvedSession) {
    // The injected session (chain-resume's `initialSession` / the driver's
    // cross-round carry) is proven when the caller says so; when it IS the
    // previous round's session, the record itself is the proof.
    resolvedSessionProvenance =
      previousRecord && previousRecord.sessionID === resolvedSession
        ? (previousRecord.backend ?? "opencode")
        : (sessionProvenance ?? null);
  }
  if (!resolvedSession && !isFirstRound && previousRecord?.sessionID && backendSupportsResume(backend)) {
    // Session lineage guard, part 2 (kusabi #192 invariant 5): a rework
    // implement round may only continue a session created by the implement
    // backend; a session attributable to a record of the OTHER backend is
    // dropped and the round starts fresh.  Records without a `backend` field
    // predate the backend split and count as "opencode" (readers' convention).
    if (!useNewSession && (previousRecord.backend ?? "opencode") === backend) {
      resolvedSession = previousRecord.sessionID;
      resolvedSessionProvenance = previousRecord.backend ?? "opencode";
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
    sessionProvenance: useNewSession ? undefined : resolvedSessionProvenance,
    tools: implementDenyTools(),
    timeoutS: 3600,
    watchdogS: 900,
    tiers: modelChain,
    tierIndex, // decoupled from round counter (B1)
    round,
    explicitModel: isFirstRound ? flagsModel : null,
  });

  // The report text is read for exactly one thing (kusabi #293): the
  // structured refusal block a worker writes when it stops without editing
  // because the brief contradicts itself.  Only the PARSED descriptor leaves
  // this function -- the report itself can carry a whole git diff, and the
  // round record must not grow one.  Gated on `completed` for the same reason
  // the review retry is: a failed job's text is empty or garbage, and a
  // refusal must never be inferred from a job that died.
  //
  // The descriptor is stamped onto the round record AT PARSE TIME because the
  // driver has a designed interruption point between this phase and
  // finishRound (the stop-check after the probes, kusabi #153①): the
  // partial round is persisted as-is at that stop, and the review-resume path
  // must route the refusal that round carried -- without the stamp, a resumed
  // refusal round would classify as a worker discard.  Stamped here, the
  // record is the single source of truth for both the fresh path (which
  // passes the same descriptor to finishRound) and the resume path (which
  // reads it back); no second measurement exists.
  const implementRefusal = job.status === "completed" ? parseRefusalBlock(resultText) : null;

  // ---- report the session this round's dispatch used or created ----
  // The returned session is the next round's carry, and the invariant is
  // that it is one round N's dispatch USED or CREATED -- observed beats
  // told.  The job records the id the dispatch actually got back
  // (`job.sessionID`); whenever that exists we report it, whether the round
  // resumed or ran fresh.  The candidate this round was TOLD to resume
  // (`resolvedSession`, from the carry or the previous-record fallback) is
  // reported ONLY as a dead-round fallback: a resuming round whose job died
  // before any id was observed -- the next round then still has a
  // conversation worth trying.  A fresh round with a null `job.sessionID`
  // reports null exactly as before.
  //
  // Why observed beats told (kusabi #324): measured 2026-08-21, a real agy
  // record (chain-msxhipgq1cef round 2, continue_session) was passed the
  // candidate `a784b853-…` yet the job stamped `2a177486-…` -- agy can mint
  // a NEW conversation id on resume (its `job.sessionID` is stamped from the
  // stream init event's `conversation_id`, agy-dispatch.mjs), so the
  // candidate and the observed id CAN diverge.  opencode held 16/16 same-
  // backend `continue_session` rounds and a claude n=1 probe held the id, so
  // this is real divergence, not a constant rewrite.  Reporting the candidate
  // there would be the old kusabi #320 defect's mirror: round N+1 would
  // resume a conversation round N's dispatch never used.  Fresh-round
  // behaviour is unchanged (kusabi #320/#323 semantics intact).
  //
  // Provenance follows the session: the owner of an observed id is the
  // backend this round dispatched on (it created or re-bound the
  // conversation); the owner of the fallback candidate is
  // `resolvedSessionProvenance` (the previous record or the caller's proof);
  // null when nothing is reported.
  //
  // Failure path: the dead-round fallback above is the resuming case.  A
  // fresh round whose job died before any session id was observed
  // (dispatchWithFallback's no-route error job, a backend job that never
  // returned an id) leaves `job.sessionID` null with no candidate to fall
  // back to: the carry is null and the next round starts fresh -- a dead
  // fresh round resumes nothing, by construction.
  const isResumingRound = !useNewSession && !!resolvedSession;
  const reportedSession = job.sessionID ?? (isResumingRound ? resolvedSession : null);
  const reportedProvenance = job.sessionID ? backend : (isResumingRound ? resolvedSessionProvenance : null);

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
      // Failure TEXT on the round record (kusabi #373): a job that ended in
      // status error must be distinguishable without opening job.json.  Written
      // only when present so a healthy round's record is unchanged.
      ...(job.error ? { implementJobError: job.error } : {}),
      // The parsed refusal descriptor, stamped at parse time (see above);
      // null when the report carried no block -- the ordinary case.  The
      // caller still decides what it means: whether a refusal is genuine
      // depends on the change set, which this phase has not measured yet.
      implementRefusal,
      // Closed terminal reason (kusabi #380): at this point the implement job
      // is folded into the round record but the chain layer has not yet
      // measured substance (worktreeChanged is unmeasured here, so a
      // completed job records "completed").  finishRound re-derives this with
      // the measured substance signal so empty rounds land as infra-death /
      // empty-completion.
      stopReason: deriveStopReason({
        status: job.status,
        stats: job.stats,
        worktreeChanged: null,
      }),
    },
    implementJobStatus: job.status,
    implementJobSteps: (job.stats && typeof job.stats.steps === "number") ? job.stats.steps : 0,
    implementJobError: job.error || null,
    // Structured terminal-failure classification (kusabi #215): null for
    // generic failures; { kind: "quota-exhaustion", ... } when the dispatch
    // classified the terminal payload.  The chain's provider-exhaustion
    // renderer uses it to show the classification instead of the generic
    // capacity advice.
    implementJobFailure: job.failure || classifyDispatchQuotaExhaustion(job.error) || null,
    // The parsed refusal block (kusabi #293), or null when the report carried
    // none -- the ordinary case.  The caller decides what it means; whether a
    // refusal is genuine depends on the change set, which this phase has not
    // measured yet.
    implementRefusal,
    session: reportedSession,
    sessionProvenance: reportedProvenance,
  };
}

/**
 * Run deterministic probes P1–P6 via sunaba-rpc.
 *
 * Returns probe results and side data needed by the review phase, plus
 * `oracleViolation` — the P5/P6 marker that routes the round to `escalate`
 * (kusabi #197).  It is `false` when no oracle probe was violated, and a
 * string naming every violation when one was.
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
  let chainStatusTruncation = null;
  let changeScope = null;

  try {
    if (baseSha) {
      changeScope = await collectChangeScope({
        callTool,
        container,
        base: baseSha,
        head: "HEAD",
      });
    }

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
    chainStatusTruncation = p3Result.statusTruncation ?? null;
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

    // ---- P5: frozen (kusabi #197) ----
    // Reuses the round's newly-changed set exactly as computed above,
    // fallback rule included: there is one change-collection mechanism in the
    // chain and this is not a second one.
    const p5Result = runFrozenProbe({
      frozen: parseFrozenTests(brief),
      headingPresent: hasSectionHeading(brief, "Frozen Tests"),
      changedPaths: chainNewlyChanged,
    });
    probeResults.push(p5Result);

    // ---- P6: collected (kusabi #197) ----
    // Reads P2's count.  No second verify_in_container call is issued: the
    // round already paid for that run.
    const p6Result = runCollectedProbe({
      collected: p2Result.collected ?? null,
      baselineCollected: verifyBaseline?.captured === true
        ? (verifyBaseline.collected ?? null)
        : null,
    });
    probeResults.push(p6Result);

    probesGreen = probeResults.every(function (p) { return p.passed; });
  } catch (probeErr) {
    probeResults.push({ probe: "sunaba-rpc", passed: false, detail: String(probeErr) });
    probesGreen = false;
  }

  // Base log + untracked for review context (read-only; failures yield
  // empty strings, never errors).
  const baseCtx = await collectContainerBaseContext(callTool, container);

  return {
    probesGreen, probeResults, chainChangedPaths, chainNewlyChanged,
    chainStatusObserved, chainStatusOutput,
    chainBaseLog: baseCtx.chainBaseLog, chainDeliverables,
    chainUntracked: baseCtx.chainUntracked,
    chainTruncation: { ...baseCtx.chainTruncation, status: chainStatusTruncation },
    worktreeChanged,
    // A probe-phase exception is not an oracle violation: it means the round
    // could not be measured, which probesGreen=false already routes.  Only a
    // P5/P6 result that actually fired sets this.
    oracleViolation: summariseOracleViolations(probeResults),
    changeScope,
  };
}

/**
 * Read one `sandbox_exec` result into its text plus what the server said about
 * its own paging.
 *
 * sandbox_exec pages at `limit` (default 50) and reports the cut in
 * `truncated` / `has_more`.  Call sites that read only `.output` cannot tell a
 * complete capture from page one of many -- which is exactly how a 50-line
 * slice of a diff reached the reviewer looking whole (kusabi #208).  A line
 * count cannot substitute for the flags: "exactly 50 lines" is
 * indistinguishable from a genuinely 50-line output.
 *
 * Only ONE count is taken from the response: `total_lines`, the denominator.
 * `shown` is deliberately not read -- measured against the live server it
 * equals `total_lines` even on a response that WAS cut (`seq 1 100` at
 * limit=10 returns 10 lines and reports shown=101, total_lines=101), so
 * rendering it produced "truncated (showing 101 of 101 lines)": a label that
 * announces a cut and then prints numbers saying nothing was withheld.  The
 * numerator is derived where the block is rendered, from the lines that block
 * actually holds (`captureCutNote`, render.mjs).
 *
 * @param {object|null|undefined} result  A sandbox_exec result envelope.
 * @returns {{ text: string, truncation: { truncated: boolean, total: number|null } }}
 */
export function readExecCapture(result) {
  return {
    text: result?.output ?? "",
    truncation: {
      // The OR is load-bearing, not redundant: summary truncation and paging
      // are independent layers, and the server can report a cut capture with
      // `truncated: false, has_more: true` (measured: `seq 1 60` at limit=25
      // returns 25 lines with truncated=false, has_more=true).  Either flag
      // means this text is not the whole output; do not simplify this to
      // `truncated` alone.
      truncated: result?.truncated === true || result?.has_more === true,
      total: Number.isInteger(result?.total_lines) ? result.total_lines : null,
    },
  };
}

/**
 * Collect the container-side context the review prompt renders: the base log
 * and the untracked files, each with what sandbox_exec reported about its own
 * paging.  Read-only sandbox_exec calls; every failure yields an empty string
 * rather than an error.
 *
 * The working diff used to be captured here too and inlined into the review
 * input.  It was one default-paged `sandbox_exec` call, so what the reviewer
 * received was page one and nothing else -- a truncated, cruder copy of a
 * diff the reviewer fetches itself with `diff_in_container` anyway.  The
 * capture is gone rather than widened (kusabi #208); what the reviewer cannot
 * work out for itself is the base, and that it still gets.
 *
 * @param {Function} callTool   The RPC callTool function (injectable).
 * @param {string}   container  Container ID.
 * @returns {Promise<{ chainBaseLog: string, chainUntracked: string,
 *   chainTruncation: { baseLog: object|null, untracked: object|null } }>}
 */
export async function collectContainerBaseContext(callTool, container) {
  // Base log for review context (own try/catch so failure does not affect probesGreen).
  // `git log --oneline -5` is five lines by construction: it is captured for
  // truncation the same way as the lists, but it cannot page.
  let chainBaseLog = "";
  let baseLogTruncation = null;
  try {
    const baseLogResult = await callTool("sandbox_exec", {
      container_id: container,
      commands: ["git log --oneline -5"],
    });
    const capture = readExecCapture(baseLogResult);
    chainBaseLog = capture.text;
    baseLogTruncation = capture.truncation;
  } catch { /* chainBaseLog stays "" */ }

  // Untracked files for review context (own try/catch).  This list has no
  // bound -- a round that adds 60 files pages -- so its paging is recorded and
  // rendered as a truncation label.
  let chainUntracked = "";
  let untrackedTruncation = null;
  try {
    const untrackedResult = await callTool("sandbox_exec", {
      container_id: container,
      commands: ["git ls-files --others --exclude-standard"],
    });
    const capture = readExecCapture(untrackedResult);
    chainUntracked = capture.text;
    untrackedTruncation = capture.truncation;
  } catch { /* chainUntracked stays "" */ }

  return {
    chainBaseLog,
    chainUntracked,
    chainTruncation: { baseLog: baseLogTruncation, untracked: untrackedTruncation },
  };
}

/**
 * Run `change-scope.mjs` in the container to collect the authoritative change scope (kusabi #379).
 * Fails closed on non-zero exit, empty stdout, or invalid JSON/contract.
 *
 * @param {object} opts
 * @param {Function} opts.callTool
 * @param {string} opts.container
 * @param {string} opts.base Commit SHA the change set is measured against.
 * @param {string} [opts.head="HEAD"] Pre-reset HEAD ref or commit.
 * @returns {Promise<object>} The parsed changeScope object (formatVersion: 1).
 * @throws {Error} when collection fails or produces invalid JSON
 */
export async function collectChangeScope({ callTool, container, base, head = "HEAD" }) {
  if (!base) {
    throw new Error("change-scope: base commit ref must be provided");
  }
  let execResult;
  try {
    execResult = await callTool("sandbox_exec", {
      container_id: container,
      argv: ["node", "plugins/kusabi/scripts/change-scope.mjs", "--base", base, "--head", head],
    });
  } catch (err) {
    // If a mock callTool throws TypeError (e.g. legacy test stubs expecting params.commands[0]),
    // retry with commands so those older suites do not crash on undefined params.commands
    if (err instanceof TypeError) {
      try {
        execResult = await callTool("sandbox_exec", {
          container_id: container,
          commands: [`node plugins/kusabi/scripts/change-scope.mjs --base ${base} --head ${head}`],
        });
      } catch (fallbackErr) {
        throw new Error(`change-scope failed in container ${container}: ${fallbackErr.message}`);
      }
    } else {
      throw new Error(`change-scope failed in container ${container}: ${err.message}`);
    }
  }

  if (execResult && typeof execResult.exit_code === "number" && execResult.exit_code !== 0) {
    const detail = (execResult.error || execResult.stderr || execResult.output || "").trim();
    throw new Error(`change-scope failed with exit code ${execResult.exit_code}: ${detail}`);
  }

  const raw = (execResult?.output ?? "").trim();
  if (!raw) {
    const detail = (execResult?.error || execResult?.stderr || "").trim();
    throw new Error(`change-scope produced empty output${detail ? `: ${detail}` : ""}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`change-scope produced invalid JSON: ${err.message}`);
  }

  if (!parsed || parsed.formatVersion !== 1 || !parsed.resolved || !parsed.paths) {
    throw new Error(`change-scope JSON contract mismatch (formatVersion must be 1): ${raw.slice(0, 100)}`);
  }

  return parsed;
}

// A base ref is interpolated into a single-quoted shell word inside the
// container, so the character set is restricted to what git refs and object
// expressions actually use.  Anything else -- quotes, spaces, `$`, `;`, `&` --
// is rejected rather than escaped: an unusable ref must fail loudly, never be
// mangled into a diff of something else.
const BASE_REF_PATTERN = /^[A-Za-z0-9._@\/^~{}:+-]+$/;

/**
 * Validate a user-supplied base ref before it reaches a shell command.
 *
 * @param {string} base
 * @throws {Error} when the ref contains characters outside BASE_REF_PATTERN.
 */
export function assertContainerBaseRef(base) {
  if (!BASE_REF_PATTERN.test(base)) {
    throw new Error(`--base ${base} is not a usable git revision (allowed characters: letters, digits and ._@/^~{}:+-)`);
  }
}

/**
 * Build the reviewer's input for a container review, reading the container
 * through the existing sunaba RPC tooling (kusabi #204).
 *
 * This is the collection half of the container review input; the rendering
 * half is `renderContainerReviewInput`.  The chain's review phase already has
 * these facts from its probes and renders them directly, so it does not call
 * this; `task --phase review --container <cid>` does, because nothing else on
 * that path reads the container's git state before the job is dispatched.
 *
 * `base`:
 *   - null (the chain's default) -- base commit is HEAD, exactly what the
 *     chain's review renders.
 *   - a ref -- base commit is that ref resolved to a sha.
 *
 * Either way the base commit is the ref the rendered input names as the one
 * to diff against; the diff body itself is no longer captured or inlined
 * (kusabi #208), so `base` reaches the reviewer as an instruction rather than
 * as a truncated `git diff` capture.
 *
 * An unusable `--base` throws: the caller asked for a specific comparison and
 * silently reviewing a different one (or nothing) is the failure mode this
 * whole change exists to remove.  Every OTHER read degrades to "(unavailable)"
 * the way the chain's does -- a flaky container must not abort the review.
 *
 * @param {object}   opts
 * @param {string}   opts.container
 * @param {Function} opts.callTool        RPC callTool (injectable).
 * @param {string|null} [opts.base=null]  Ref the review is measured against.
 * @returns {Promise<string>} The rendered review input.
 * @throws {Error} when `base` is malformed or does not resolve in the container.
 */
export async function collectContainerReviewInput({ container, callTool, base = null, changeScope = undefined }) {
  let baseSha = "";
  if (base) {
    assertContainerBaseRef(base);
    // `|| echo <sentinel>` keeps the exit status zero so the transport reports
    // the outcome in the output rather than as an RPC-level failure.
    let revOutput;
    try {
      const revResult = await callTool("sandbox_exec", {
        container_id: container,
        commands: [`git rev-parse --verify --quiet '${base}^{commit}' || echo __KUSABI_BASE_UNRESOLVED__`],
      });
      revOutput = (revResult?.output ?? "").trim();
    } catch (err) {
      throw new Error(`--base ${base} could not be resolved in container ${container}: ${err.message}`);
    }
    if (!revOutput || revOutput.includes("__KUSABI_BASE_UNRESOLVED__")) {
      throw new Error(`--base ${base} is not a valid revision in container ${container}`);
    }
    baseSha = revOutput.split("\n").pop().trim();
  } else {
    try {
      const headResult = await callTool("sandbox_exec", {
        container_id: container,
        commands: ["git rev-parse HEAD"],
      });
      baseSha = (headResult?.output ?? "").trim();
    } catch { /* baseSha stays "" -> renderBaseFacts says "(unavailable)" */ }
  }

  let effectiveChangeScope = null;
  if (changeScope !== false && changeScope !== null) {
    if (changeScope) {
      effectiveChangeScope = changeScope;
    } else if (baseSha) {
      effectiveChangeScope = await collectChangeScope({
        callTool,
        container,
        base: baseSha,
        head: "HEAD",
      });
    }
  }

  let statusOutput = "";
  let statusTruncation = null;
  try {
    const statusResult = await callTool("sandbox_exec", {
      container_id: container,
      commands: ["git status --porcelain"],
    });
    const capture = readExecCapture(statusResult);
    statusOutput = capture.text;
    statusTruncation = capture.truncation;
  } catch { /* statusOutput stays "" -> "(empty change set)" */ }

  const baseCtx = await collectContainerBaseContext(callTool, container);

  return renderContainerReviewInput({
    container,
    baseSha: effectiveChangeScope?.resolved?.baseSha ?? baseSha,
    baseLog: baseCtx.chainBaseLog,
    statusOutput,
    untrackedFiles: baseCtx.chainUntracked,
    truncation: { ...baseCtx.chainTruncation, status: statusTruncation },
    changeScope: effectiveChangeScope,
  });
}

/**
 * Collect the review-phase context for a round WITHOUT running the probes.
 *
 * Used by chain-resume (kusabi #153①) when a cancelled chain resumes at the
 * review phase of an interrupted round: the probes already ran and their
 * results are on the persisted round record; only the context the review
 * prompt renders (status, base log, untracked) is re-collected from
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
  let chainStatusTruncation = null;
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
    chainStatusTruncation = p3Result.statusTruncation ?? null;
    chainStatusObserved = true;
  } catch {
    // Degraded: fields keep their "unknown" defaults.
  }
  const baseCtx = await collectContainerBaseContext(callTool, container);

  return {
    chainChangedPaths,
    chainNewlyChanged,
    chainStatusObserved,
    chainStatusOutput,
    chainBaseLog: baseCtx.chainBaseLog,
    chainDeliverables,
    chainUntracked: baseCtx.chainUntracked,
    chainTruncation: { ...baseCtx.chainTruncation, status: chainStatusTruncation },
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
 *     `reviewParseable: true`, which is what keeps it out of the
 *     docs/design/phase-chain.md §3.5 unparseable retry: we READ this
 *     output fine, the model ran out of room, and re-dispatching spends
 *     the budget that just proved insufficient.
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
      partialDiagnosis: jsonl.partialDiagnosis || null,
      salvagedVerdict: jsonl.review?.salvagedVerdict === true,
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
    return {
      chainParsedReview: parsed,
      chainVerdict,
      chainFindingsText,
      reviewParseable,
      reviewPartial: false,
      reviewFindingCount: findingsArray.length,
      partialDiagnosis: null,
      salvagedVerdict: false,
    };
  }

  // A2: unparseable review is recorded as a distinct state
  const recoveredV = recoverVerdictFromText(reviewResultText);
  const chainVerdict = recoveredV ? recoveredV.verdict : "unparseable";
  const chainFindingsText = "(review output could not be parsed)";
  return {
    chainParsedReview: null,
    chainVerdict,
    chainFindingsText,
    reviewParseable,
    reviewPartial: false,
    reviewFindingCount: 0,
    partialDiagnosis: null,
    salvagedVerdict: false,
  };
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
 * Render the round's deterministic probe results (P1–P6) into the review
 * prompt (kusabi #236).
 *
 * One line per probe: name, pass state, one-line detail.  The detail is
 * normalised to a single line (internal whitespace collapsed) so the block
 * is always exactly one line per probe \u2014 never a wall of captured output
 * that eats the reviewer's budget.  A missing or empty probe set must
 * render an explicit absence marker \u2014 never an empty string, which would
 * read as "all fine" and hand the reviewer false confidence.
 *
 * @param {Array<{probe: string, passed: boolean, detail: string}>|undefined} probeResults
 * @returns {string}
 */
export function renderProbeReport(probeResults) {
  if (!Array.isArray(probeResults) || probeResults.length === 0) {
    return "(no probe results recorded)";
  }
  return probeResults.map(function (p) {
    const name = p && typeof p.probe === "string" && p.probe ? p.probe : "(unnamed probe)";
    const state = p && p.passed === true ? "passed" : "failed";
    const detail = String((p && p.detail) || "").replace(/\s+/g, " ").trim();
    return "- " + name + " \u2014 " + state + (detail ? " \u2014 " + detail : "");
  }).join("\n");
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
  chainStatusOutput, chainBaseLog, chainUntracked, chainTruncation, roundRecord,
  chainChangedPaths, chainNewlyChanged, chainStatusObserved, chainDeliverables, flagsModel,
  reworkScope, changeScope,
  _dispatchWithFallback: _dispatch = dispatchWithFallback,
} = {}) {
  const skipReview = shouldSkipReview({ chainStatusObserved, chainChangedPaths, chainNewlyChanged, chainDeliverables });

  // ---- P3 empty-change: set probe-sourced discard verdict before review ----
  if (skipReview) {
    roundRecord.verdict = "discard";
    roundRecord.verdictSource = "probe";
    roundRecord.reviewParseable = false;
    // What this discard does NOT mean (kusabi #299).  The round added nothing
    // SINCE THE BASELINE, which is why the review was skipped — it says
    // nothing about whether earlier rounds' work is still in the worktree.
    // In the motivating incident (chain-msvthdq26fdc, 2026-08-16) it was: the
    // empty round was discarded, the chain escalated reading "reviewer
    // discarded the work", and the intact rounds-1–2 worktree it was sitting
    // on eventually shipped.  So record the other fact too, straight from the
    // change set P3 already captured (`git status --porcelain` against the
    // chain base, which P1 leaves HEAD parked at) — no second collection
    // mechanism, and no container call of its own.  Distinct from
    // `worktreeChanged`, which is measured against the RUN's baseline and is
    // false on exactly this path.
    roundRecord.worktreeDirtyVsBase = Array.isArray(chainChangedPaths) && chainChangedPaths.length > 0;
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
    // The review input (the review-target block naming this container and the
    // read-side tools -- `read_file_range`, `search_in_container`,
    // `diff_in_container`, the verify gates -- followed by the base facts and
    // the instruction to fetch the diff against the base) is rendered by
    // renderContainerReviewInput in render.mjs.  It used to be built inline
    // here; `task --phase review --container` sent no review input at all, so
    // the extraction gives both routes the same block from one place
    // (kusabi #204).  The diff body it used to carry is gone: it was one
    // default-paged capture, so it was page one of the diff and nothing else
    // (kusabi #208).
    const effectiveChangeScope = changeScope ?? roundRecord?.changeScope ?? null;
    const reviewInput = renderContainerReviewInput({
      container,
      baseSha,
      baseLog: chainBaseLog,
      statusOutput: chainStatusOutput,
      untrackedFiles: chainUntracked,
      truncation: chainTruncation,
      changeScope: effectiveChangeScope,
    });
    // Single decision point (kusabi #334): the review seam reads the round's
    // scope from the SAME resolveReworkScope decision the driver made — the
    // driver carries its scopeResolution here, the way buildImplementText
    // already receives it.  When the value is absent (older callers, tests)
    // the same function is re-invoked on the same previousRecord; it is
    // deterministic, so the review-resume path — which has no fresh-round
    // block to carry a scopeResolution from — derives the same answer the
    // fresh path derived.  Old records without scope information resolve to
    // "full" and degrade to today's behaviour rather than throwing.
    const reviewScope = reworkScope || resolveReworkScope(previousRecord);
    const priorFindings = renderReviewPriorFindings(previousRecord, reviewScope);

    const reviewPromptText = promptTemplate
      .replaceAll("{{TARGET_LABEL}}", "container " + container + " changes")
      .replaceAll("{{USER_FOCUS}}", brief)
      .replaceAll("{{OUTPUT_SCHEMA}}", JSON.stringify(schemaJson))
      .replaceAll("{{REVIEW_INPUT}}", reviewInput)
      .replaceAll("{{PRIOR_FINDINGS}}", priorFindings)
      // kusabi #236: the round's deterministic probe results (P1–P6) reach
      // the reviewer as {{PROBE_REPORT}}, so the reviewer does not spend
      // findings re-litigating what the probes already measured.  A round
      // with no recorded probes renders the explicit absence marker, never an
      // empty string that reads as "all fine".
      .replaceAll("{{PROBE_REPORT}}", renderProbeReport(roundRecord.probeResults));

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
      partialDiagnosis: _partialDiagnosis, salvagedVerdict: _salvagedVerdict,
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
         reviewPartial: _partial, reviewFindingCount: _findingCount,
         partialDiagnosis: _partialDiagnosis, salvagedVerdict: _salvagedVerdict } = parseReviewResult(reviewResultText));
    }

    roundRecord.reviewJobId = reviewJob.id;
    roundRecord.reviewUsage = reviewJob.usage || null;
    roundRecord.reviewModelEntry = reviewJob.modelEntry || null;
    roundRecord.reviewModelVariant = reviewJob.modelVariant || null;
    roundRecord.reviewFallbacks = reviewJob.fallbacks || null;
    reviewJobStatus = reviewJob.status;
    reviewJobError = reviewJob.error || null;
    // Structured terminal-failure classification (kusabi #215 / #373), carried
    // on the record (single conduit).  Adapter-supplied `job.failure` wins;
    // when the adapter left it null (agy v1, opencode), classify from the
    // observed quota phrases in the error text so a no-payload job is not
    // recorded as `reviewJobFailure: null`.
    roundRecord.reviewJobFailure = reviewJob.failure
      || classifyDispatchQuotaExhaustion(reviewJob.error)
      || null;
    // Failure TEXT, distinct from the structured classification: a job that
    // produced no payload at all must be readable from the round record.
    // Written only when present so a healthy review's record is unchanged.
    if (reviewJob.error) roundRecord.reviewJobError = reviewJob.error;

    chainParsedReview = _parsed;
    chainVerdict = _verdict;
    chainFindingsText = _findings;
    reviewParseable = _parseable;
    roundRecord.reviewParseable = reviewParseable;
    roundRecord.verdict = chainVerdict;
    if (!reviewParseable) {
      roundRecord.verdictSource = "recovered-from-token";
    }
    if (_salvagedVerdict) {
      roundRecord.salvagedVerdict = true;
    }
    // Partial review (kusabi #202): the record must make it visible that the
    // review was incomplete, and how many findings it did carry.  Written
    // only when partial, so records for complete reviews are unchanged.
    if (_partial) {
      roundRecord.reviewPartial = true;
      roundRecord.reviewFindingCount = _findingCount;
      if (_partialDiagnosis) {
        roundRecord.reviewPartialDiagnosis = _partialDiagnosis;
      }
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
    // Kusabi #334: the detector's semantics are shared with chain-stats, so
    // what is narrowed here is the INPUT — previousFindingFiles is reduced to
    // the previous round's findings that were in THIS round's scope.  Held
    // findings (deliberately left for a later round) are not evidence of a
    // stall; in-scope repeats still fire exactly as before.
    chainRepeatedAreas = hasRepeatedAreas(inScopeFindingFiles(previousRecord, reviewScope), chainParsedReview?.findings);
  }

  // Single conduit: record state stays on roundRecord; the return carries
  // only what is not record state (see the docstring above).
  return { chainParsedReview, chainRepeatedAreas, skipReview, reviewJobStatus, reviewJobError };
}

/**
 * Every field on a round record that describes the ROUND'S REVIEW, and that a
 * replacement review seat (kusabi #248) therefore rewrites.
 *
 * The list must stay complete, because several of these are written only
 * CONDITIONALLY by runReviewPhase — `reviewPartial` only when the stream was
 * partial, `verdictSource` only when the result was unparseable, the
 * `reviewFirst*` trio only when the unparseable retry fired.  A field left
 * behind would keep describing the DEAD seat next to the replacement's
 * verdict: a clean `approve` still flagged partial, or sourced
 * "recovered-from-token".  That is exactly the fail-open edge this feature
 * must not add, so archiving CLEARS them rather than trusting the overwrite.
 */
const REVIEW_SEAT_RECORD_FIELDS = [
  "verdict", "verdictSource", "reviewParseable", "salvagedVerdict",
  "reviewPartial", "reviewFindingCount", "reviewPartialDiagnosis",
  "reviewJobId", "reviewUsage", "reviewModelEntry", "reviewModelVariant",
  "reviewFallbacks", "reviewJobFailure", "reviewJobError",
  "reviewUnparseableRetried", "reviewFirstJobId", "reviewFirstUsage", "reviewFirstFallbacks",
  "findingsText", "findings", "findingFiles",
  "disposition",
];

/**
 * Move a round record's FAILED review seat into `reviewSeatFailures` and clear
 * the live review fields, so a replacement seat (kusabi #248) can write its
 * own verdict without the dead seat's state surviving underneath it.
 *
 * The failed seat is preserved, never silently overwritten: the record keeps
 * saying that a first review died and how (`verdict`, its escalate
 * disposition, its job id and spend), and chain-show renders both it and the
 * replacement verdict.  The round itself is NOT duplicated — the same record
 * object is continued in place, so metrics ingest still sees one round row.
 *
 * Called by the driver's review-resume branch, once, immediately before the
 * replacement review is dispatched.  Idempotent in shape (repeated seat
 * failures append), so a chain that burns a second seat archives that one too.
 *
 * @param {object} roundRecord — the round record being resumed, mutated in place.
 * @returns {object} the same record.
 */
export function archiveFailedReviewSeat(roundRecord) {
  if (!roundRecord || typeof roundRecord !== "object") return roundRecord;
  if (!Array.isArray(roundRecord.reviewSeatFailures)) roundRecord.reviewSeatFailures = [];

  const seat = { seat: roundRecord.reviewSeatFailures.length + 1 };
  for (const field of REVIEW_SEAT_RECORD_FIELDS) {
    if (roundRecord[field] !== undefined) seat[field] = roundRecord[field];
    delete roundRecord[field];
  }
  roundRecord.reviewSeatFailures.push(seat);
  return roundRecord;
}

/**
 * Compute chain-wide usage totals from all round records.
 *
 * Archived review seats (kusabi #248) count too: a seat that died mid-stream
 * still burned tokens, and its spend moved off the live `reviewUsage` field
 * when the replacement seat was bought.  Dropping it here would make the
 * chain's reported cost quietly cheaper than the run actually was.
 */
export function computeChainTotals(records) {
  const chainTotals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const rec of records) {
    const seatUsages = Array.isArray(rec.reviewSeatFailures)
      ? rec.reviewSeatFailures.flatMap(function (s) { return [s?.reviewUsage, s?.reviewFirstUsage]; })
      : [];
    for (const usage of [rec.implementUsage, rec.reviewUsage, rec.reviewFirstUsage, ...seatUsages]) {
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
 * chain's state directory as `review-record.md`. Written on terminal
 * dispositions (accept / accept-with-followup / escalate / max-rounds) and
 * as a provisional record on non-completed exits (cancelled / failed) when the
 * last round has probe results. Regeneration overwrites the previous record.
 * The companion only writes the local file and returns its path — posting it
 * to the archive repository is orchestrator-exclusive.
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
 * @param {boolean} [opts.provisional]  — true when chain ended at a non-completed exit.
 * @returns {string} The absolute path of the written record file.
 */
export function writeReviewRecord({
  chainDir, chainId, container, modelChain, maxRounds, brief, orchestrator,
  records, chainTotals, disposition, round, label, finishedAt, provisional,
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
      disposition: typeof disposition === "string" ? disposition : (disposition?.disposition ?? "unknown"),
      round,
      reason: disposition?.reason ?? null,
    },
    finishedAt,
    provisional,
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
    // Structured terminal-failure classification (kusabi #215): null for
    // generic failures; { kind: "quota-exhaustion", ... } when the dispatch
    // classified the terminal payload (see implementJobFailure).
    strategistJobFailure: strategistJob.failure || null,
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
  // The first line carries the reason an orchestrator reads first.  For a
  // probe-sourced discard the recorded reason is deriveDisposition's generic
  // "reviewer discarded the work" — the wrong thing to hand over over an
  // intact worktree (kusabi #299): say the round was empty and whether the
  // worktree still holds the prior rounds' work.  Reviewer-verdict discards
  // keep the recorded reason.  roundDiscardReason owns the condition.
  const reason = roundDiscardReason(roundRecord, disposition.reason || "unknown");
  const orchLine = orchestrator?.model ? "orchestrator=" + orchestrator.model : "";
  const lines = [
    "Chain " + chainId + " escalated at round " + round + ": " + reason,
    orchLine,
    "",
  ];

  // kusabi #336: carry the decisions, not just a task list. When the terminal
  // round record carries a structured `findings` array, render each finding's
  // body and recommendation as a decision for the orchestrator (severity-
  // ordered, budget-bounded). Old records without `findings` keep the current
  // one-line `findingsText` rendering, and a round with no findings at all
  // states that plainly (the first line's reason already says why).
  const findings = roundRecord?.findings;
  if (Array.isArray(findings) && findings.length > 0) {
    lines.push(renderEscalationDecisions(findings, { roundNumber: round }));
  } else {
    const ft = roundRecord?.findingsText;
    if (ft && typeof ft === "string" && ft.length > 0) {
      lines.push("Remaining findings:");
      lines.push(ft);
    } else {
      lines.push("(no findings recorded for this round)");
    }
  }
  lines.push("");

  for (let ri = 0; ri < records.length; ri++) {
    const r = records[ri];
    const detail = r.resumeMethod.detail ? ": " + r.resumeMethod.detail : "";
    const changed = roundChangedColumn(r);
    lines.push("Round " + (ri + 1) + ": model=" + (r.modelEntry || "?") + ", verdict=" + r.verdict + ", probesGreen=" + r.probesGreen + ", changed=" + changed + ", resume=" + r.resumeMethod.type + detail);
  }
  lines.push("", "Hand over to orchestrator for final judgement.");
  return lines.join("\n");
}

/**
 * Render the outcome string for a qualifying refusal (kusabi #293).
 *
 * Reads like the escalate outcome on purpose -- both hand the chain to the
 * orchestrator -- but says the opposite thing about WHOSE defect it is, and
 * names the two contradicting items on their own lines so the orchestrator
 * can open both without reading the round record.  The absence of findings
 * is stated rather than left blank: this round never ran a review.
 */
export function renderRefusalOutcome({ chainId, round, disposition, orchestrator, roundRecord, records }) {
  const refusal = roundRecord?.refusal || null;
  const orchLine = orchestrator?.model ? "orchestrator=" + orchestrator.model : "";
  const lines = [
    "Chain " + chainId + " refused at round " + round + ": the brief contradicts itself.",
    orchLine,
    "",
    "Contradicting items named by the worker:",
  ];
  const anchors = Array.isArray(refusal?.anchors) ? refusal.anchors : [];
  if (anchors.length > 0) {
    for (const a of anchors) lines.push("- " + a.text + "  [" + a.kind + "]");
  } else {
    // Unreachable through the driver (the disposition requires two named
    // anchors), but a renderer must never present an empty list as a fact.
    lines.push("- (not recorded)");
  }
  lines.push("", "Why they cannot both hold:", refusal?.why || "(not recorded)", "");
  for (let ri = 0; ri < records.length; ri++) {
    const r = records[ri];
    const detail = r.resumeMethod?.detail ? ": " + r.resumeMethod.detail : "";
    const changed = roundChangedColumn(r);
    lines.push("Round " + (ri + 1) + ": model=" + (r.modelEntry || "?") + ", outcome=" + (r.roundOutcome || r.verdict) + ", changed=" + changed + ", resume=" + (r.resumeMethod?.type || "?") + detail);
  }
  lines.push(
    "",
    "No review was dispatched (the round changed nothing) and no rework was spent.",
    "This is a BRIEF defect, not a worker failure: fix the contradiction in the brief " +
      "and dispatch again, or decide which of the two items gives way.",
    disposition?.reason ? "Recorded reason: " + disposition.reason : "",
  );
  return lines.join("\n");
}

/**
 * Render the outcome string for a brief-syntax defect (kusabi #303).
 *
 * Same terminal family as the worker's refusal above -- both hand the chain
 * back to the brief's author -- but the contradiction here was found by a
 * PROBE, not by the worker, so the offending section is named from the probe
 * marker and the round summary is the ordinary one.  The two facts an
 * orchestrator needs first are on their own lines: which section cannot be
 * read, and that no rework was spent because none could have won.
 */
export function renderBriefSyntaxDefectOutcome({ chainId, round, disposition, orchestrator, roundRecord, records }) {
  const orchLine = orchestrator?.model ? "orchestrator=" + orchestrator.model : "";
  const lines = [
    "Chain " + chainId + " stopped at round " + round + ": the brief has a section a probe cannot read.",
    orchLine,
    "",
    "Offending brief section(s):",
    roundRecord?.briefSyntaxDefect || "(not recorded)",
    "",
  ];
  for (let ri = 0; ri < records.length; ri++) {
    const r = records[ri];
    const detail = r.resumeMethod?.detail ? ": " + r.resumeMethod.detail : "";
    const changed = roundChangedColumn(r);
    lines.push("Round " + (ri + 1) + ": model=" + (r.modelEntry || "?") + ", outcome=" + (r.roundOutcome || r.verdict) + ", changed=" + changed + ", resume=" + (r.resumeMethod?.type || "?") + detail);
  }
  lines.push(
    "",
    "No rework was dispatched and no rework round was spent: the probe's input is the BRIEF, " +
      "which the worker cannot edit, so every further round would fail on the same syntax.",
    "This is a BRIEF defect, not a worker failure: add entries to the section, or delete the " +
      "heading entirely (an empty section must omit its heading), then re-dispatch.",
    disposition?.reason ? "Recorded reason: " + disposition.reason : "",
  );
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
    const changed2 = roundChangedColumn(r2);
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
 * @param {object|null} [opts.jobFailure=null] — Structured terminal-failure
 *                                        classification (kusabi #215): when the
 *                                        exhausted job's record carries
 *                                        `{ kind: "quota-exhaustion", ... }`,
 *                                        the classified job error (which
 *                                        already holds the operator-facing
 *                                        advice) is shown WITHOUT the generic
 *                                        "Retry when provider is available"
 *                                        capacity footer — that advice is
 *                                        actively wrong for a session-limit
 *                                        block.
 * @param {object[]} opts.records       — Round records so far (includes the
 *                                        aborted partial round).
 * @returns {string}
 */
export function renderProviderExhaustedOutcome({ chainId, round, phase, jobError, records, jobFailure = null }) {
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
      const changed = roundChangedColumn(r);
      lines.push(
        "  Round " + (ri + 1) + ": model=" + (r.modelEntry || "?") +
        ", verdict=" + (r.verdict || "n/a") +
        ", probesGreen=" + (r.probesGreen ?? "n/a") +
        ", changed=" + changed + ", resume=" + (r.resumeMethod?.type || "?") + detail,
      );
    }
    lines.push("");
  }

  if (jobFailure?.kind === "quota-exhaustion") {
    // Classified quota failures: the job error already carries the
    // operator-facing advice (which quota, reset time, backend blocked,
    // what to do instead of retrying — set by the dispatch, kusabi #215).
    // The generic capacity footer below would CONTRADICT it ("Retry when
    // provider is available" is exactly wrong for a session-limit block),
    // so it is omitted and the machine-readable classification is pointed
    // at instead.
    lines.push("Quota exhaustion — the failed job record's `failure` field carries the classification.");
  } else {
    lines.push("Capacity problem — not a quality failure. Retry when provider is available.");
  }
  return lines.join("\n");
}

// =========================================================================
// Deterministic probes — P1, P2, P3, P4 (P5/P6 are further down, beside
// runDeliverablesProbe, because they consume what P2/P3 produce)
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
 * Run every declared smoke entry and return the raw observations.
 *
 * The executor half of the smoke probe, split out of runSmokeProbe unchanged
 * so the pre-dispatch baseline run (kusabi #292) shares this exact loop: a
 * second executor would drift from the one the post-round probe uses, and the
 * whole point of the baseline is that it measures the same thing at a
 * different moment.  The verdict half stays in checkSmokeProbe; runSmokeProbe
 * below is the two composed.
 */
export async function runSmokeEntries({ entries, callTool, container }) {
  const entriesArr = Array.isArray(entries) ? entries : [];
  const observed = [];
  for (let i = 0; i < entriesArr.length; i++) {
    const result = await runSmokeEntry({ entry: entriesArr[i], callTool, container, entryIndex: i });
    observed.push(result);
  }
  return observed;
}

// A listing this big cannot be a realistic `git status --porcelain` page; the
// point of the explicit window is to defeat sandbox_exec's two independent
// truncation layers (summary head-50/tail-50 and paging), exactly as
// captureWorktreeState does.  A cut capture must never stand in for the whole
// listing here: the guard's verdict is "the smoke left no dirt", and that
// verdict cannot be built from a view that could have dropped the dirt.
const STATUS_CAPTURE_PAGE_LIMIT = 1000000;

/**
 * Read HEAD for the baseline smoke's guard.
 *
 * Deliberately NOT captureBaseSha: that one degrades an unreadable HEAD to
 * null because its caller (the chain's base record) has a per-round probe to
 * catch the consequences.  This caller has none — it is the guard itself —
 * so an unreadable HEAD is a failure record here, in the same shape as the
 * porcelain capture's.  An empty output is such a failure: a working
 * `git rev-parse HEAD` always prints a SHA, so "nothing came back" means the
 * measurement failed, not that HEAD is empty.
 *
 * @param {Function} callTool   The RPC callTool function (injectable).
 * @param {string}   container  Container ID.
 * @returns {Promise<{ok: true, sha: string} | {ok: false, reason: string}>}
 */
async function captureHeadForGuard(callTool, container) {
  let result;
  try {
    result = await callTool("sandbox_exec", {
      container_id: container,
      commands: ["git rev-parse HEAD"],
    });
  } catch (err) {
    return { ok: false, reason: `git rev-parse HEAD could not be run: ${err?.message ?? String(err)}` };
  }
  if (result === null || result === undefined) {
    return { ok: false, reason: "git rev-parse HEAD returned no result" };
  }
  const sha = readExecCapture(result).text.trim().split("\n")[0].trim();
  if (sha.length === 0) {
    return { ok: false, reason: "git rev-parse HEAD returned no SHA (HEAD could not be read)" };
  }
  return { ok: true, sha };
}

/**
 * Capture what the baseline smoke must not change: the `git status --porcelain`
 * listing AND the HEAD SHA, both read from inside the container.
 *
 * The read-only measurement the baseline smoke's worktree guard (kusabi #292
 * follow-up) is built on: the baseline runs the declared smoke in the very
 * container the worker is then handed, so a PASSING smoke with write side
 * effects (coverage output, build artifacts, lockfile regeneration, --fix
 * formatters, snapshot updates) would leave the worker a dirtied tree whose
 * untracked artifacts and tracked-file mutations land in the round's diff and
 * review as the worker's work.  Comparing a capture taken immediately before
 * the run with one taken immediately after isolates exactly what the smoke
 * itself added.
 *
 * HEAD rides in the same capture because the porcelain listing CANNOT see it:
 * a smoke that commits, or checks out another SHA, leaves a listing identical
 * to the one before it ran (kusabi #292 follow-up).  That blind spot is worse
 * than dirt — captureBaseSha runs AFTER the baseline, so a smoke-moved HEAD
 * would be recorded as the chain's base and silently become the thing P1, the
 * deliverables probe and the review's diff-vs-base all measure against.  Two
 * numbers from one moment: taking them together is what makes "the smoke
 * changed nothing" a claim about the container rather than about one listing.
 *
 * The capture is requested with truncation defeated (verbose "full" + a
 * page-limit far beyond any real listing) because the verdict depends on the
 * listing being COMPLETE.  When the call throws or the server still reports
 * the output cut, the capture is a failure record, never a partial listing:
 * a guard that is supposed to prove the smoke left no dirt cannot stand on a
 * view that could have dropped the very entry that dirtied the tree.  An
 * unreadable HEAD is the same kind of failure record, for the same reason.
 *
 * @param {Function} callTool   The RPC callTool function (injectable).
 * @param {string}   container  Container ID.
 * @returns {Promise<{ok: true, lines: string[], head: string} | {ok: false, reason: string}>}
 */
export async function captureGitStatusPorcelain(callTool, container) {
  let result;
  try {
    result = await callTool("sandbox_exec", {
      container_id: container,
      commands: ["git status --porcelain"],
      verbose: "full",
      limit: STATUS_CAPTURE_PAGE_LIMIT,
    });
  } catch (err) {
    return { ok: false, reason: `git status could not be run: ${err?.message ?? String(err)}` };
  }
  if (result === null || result === undefined) {
    return { ok: false, reason: "git status returned no result" };
  }
  const capture = readExecCapture(result);
  if (capture.truncation.truncated) {
    return { ok: false, reason: "git status output was truncated (the listing is not complete)" };
  }
  const lines = capture.text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const head = await captureHeadForGuard(callTool, container);
  if (head.ok !== true) return { ok: false, reason: head.reason };
  return { ok: true, lines, head: head.sha };
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

  const observed = await runSmokeEntries({ entries: entriesArr, callTool, container });

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
 * Count the tests a verify result actually RAN (kusabi #197, the P6 oracle).
 *
 * "Verify green" means "the tests that ran passed", not "the tests still
 * exist": a dependency drift once made 273 of 607 tests uncollectable (an
 * import failure makes tests stop existing rather than fail) while verify
 * stayed green.  The number below is what makes that visible.
 *
 * Counting authority: the STRUCTURED fields of the verify result, never a
 * substring match on free text.  `tests.full.total` is the count of tests the
 * full run collected (verified against live sunaba output on this repo,
 * 2026-08-15: `{"tests": {"full": {"status": "ok", "duration": 25.1,
 * "passed": 2033, "total": 2033}}}`).  When `total` is absent but the run
 * reported passed/failed counts, their sum is the number that ran.  When
 * neither is derivable the count is null — never a guess: a fabricated count
 * would either mask a real decrease or invent one.
 *
 * `tests.full` is absent whenever the tests did not run at all (the lint/type
 * precondition failed, `tests.status === "skipped"`), which is null for the
 * same reason: no tests ran, so no count was measured.
 *
 * @param {object|null} verifyResult  — a verify_in_container result.
 * @returns {number|null} Tests collected by the full run, or null when not countable.
 */
export function countVerifyCollected(verifyResult) {
  const full = verifyResult?.tests?.full;
  if (!full || typeof full !== "object") return null;
  if (Number.isInteger(full.total)) return full.total;
  const passed = Number.isInteger(full.passed) ? full.passed : null;
  const failed = Number.isInteger(full.failed) ? full.failed : null;
  if (passed === null && failed === null) return null;
  return (passed ?? 0) + (failed ?? 0);
}

/**
 * Build the chain-start verify baseline record from a verify result.
 *
 * @param {object|null} verifyResult
 * @returns {{ captured: true, gate_passed: boolean, lint: number|null, types: number|null,
 *             collected: number|null, raw: object }}
 */
export function buildVerifyBaseline(verifyResult) {
  return {
    captured: true,
    gate_passed: verifyResult?.gate_passed === true,
    lint: countVerifyViolations(verifyResult, "lint"),
    types: countVerifyViolations(verifyResult, "types"),
    // The count of tests the base itself runs (kusabi #197).  Recorded at
    // chain start beside the lint/type counts and reused by every round —
    // chain-resume included, which never re-captures on a modified worktree.
    collected: countVerifyCollected(verifyResult),
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
 * @returns {Promise<object>} { probe, passed, detail, collected }
 *   `collected` is the number of tests the run that actually executed tests
 *   collected (null when no run got that far) — P6 reads it off this result
 *   instead of issuing a verify call of its own.
 */
export async function runVerifyProbe({ callTool, container, baseline }) {
  // P6 (kusabi #197) must not run verify a second time per round: P2 already
  // ran it, so the collected-test count is stamped onto EVERY return path of
  // the gate below by this wrapper.  `collected` follows the run whose tests
  // actually executed — the tolerated re-run when there was one, otherwise
  // the first call (null when the tests never ran at all).
  const counted = { collected: null };
  const result = await runVerifyGate(counted, { callTool, container, baseline });
  result.collected = counted.collected;
  return result;
}

/**
 * The P2 gate itself.  Split out only so `runVerifyProbe` can stamp the
 * collected count on every return path without threading it through nine
 * return statements (a field a future branch could silently forget).
 *
 * @param {{collected: number|null}} counted  — out-parameter for the count.
 * @param {object} opts  — as runVerifyProbe.
 * @returns {Promise<object>} { probe, passed, detail }
 */
async function runVerifyGate(counted, { callTool, container, baseline }) {
  const verifyResult = await callTool("verify_in_container", {
    container_id: container,
    path: ".",
  });
  counted.collected = countVerifyCollected(verifyResult);

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
  // This is the run whose tests actually executed, so its count is the round's
  // collected count (kusabi #197).  The first call's tests were skipped by the
  // precondition, so it measured nothing; `??` keeps that null rather than
  // letting an unmeasurable re-run overwrite a count with one.
  counted.collected = countVerifyCollected(retryResult) ?? counted.collected;
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
 * Returns the probe result with `changedPaths`, `statusOutput` and
 * `statusTruncation` (what sandbox_exec reported about the status capture's
 * own paging) attached for the chain call site.
 */
export async function runDeliverablesProbe({ deliverables, headingPresent, callTool, container, baseline }) {
  const statusResult = await callTool("sandbox_exec", {
    container_id: container,
    commands: ["git status --porcelain"],
  });
  // The status capture is paged like any other sandbox_exec call, and a change
  // set can exceed a page.  What the server says about the cut is carried out
  // with the text so the review input can label a partial list as partial
  // (kusabi #208) instead of presenting page one as the whole change set.
  const statusCapture = readExecCapture(statusResult);
  const statusOutput = statusCapture.text;
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
  probeResult.statusTruncation = statusCapture.truncation;
  probeResult.worktreeChanged = worktreeChanged;
  return probeResult;
}

// =========================================================================
// P5 / P6 — the deterministic oracle probes (kusabi #197)
// =========================================================================
//
// Both are PURE: P5 reads the change set P3 already computed, P6 reads the
// count P2 already measured.  Neither adds a container call, and neither
// re-derives evidence another probe owns.
//
// A failure of either carries `oracleViolation: true`.  That marker is the
// whole point of the pair: it routes the round to `escalate`, never to an
// automatic rework, because the correct resolution may be "this deletion is
// legitimate, the human approves it" — a judgement no worker can make and no
// rework round can reach.  Escalate IS the exit (kusabi #173: a deterministic
// check with no exit dead-ends chains).

/**
 * P5: frozen — the round's change set must not touch a declared frozen path.
 *
 * The frozen declaration is the brief's `## Frozen Tests` section; recognition
 * and item syntax are exactly the Deliverables set (`parseFrozenTests`).  The
 * change set is the one P3 already computed — the round's NEWLY changed paths
 * with `runProbePhase`'s fallback applied, so an unmeasurable round is
 * compared against the full changed set rather than against "nothing".
 *
 * Matching is prefix-based in BOTH directions, the same rule P3 uses: a frozen
 * entry naming a directory matches every changed path inside it, and a changed
 * path naming a directory (an untracked `dir/` in `git status --porcelain`)
 * matches a frozen entry inside it.  The second direction over-reports rather
 * than under-reports, which is the right bias for a detector whose failure
 * mode is a human being asked one unnecessary question.
 *
 * @param {object} opts
 * @param {string[]} opts.frozen          — declared frozen paths.
 * @param {boolean}  opts.headingPresent  — a `## Frozen Tests` heading exists.
 * @param {string[]} opts.changedPaths    — the round's changed paths.
 * @returns {{ probe: string, passed: boolean, detail: string, oracleViolation?: true }}
 */
export function runFrozenProbe({ frozen, headingPresent, changedPaths }) {
  const probe = "P5: frozen";
  const frozenArr = Array.isArray(frozen) ? frozen : [];
  const changedArr = Array.isArray(changedPaths) ? changedPaths : [];

  if (frozenArr.length === 0) {
    // Heading present but nothing parsed: the declared check would silently
    // not run.  Same author-facing rule as P3/P4 — tell the author to fix the
    // brief syntax rather than let them believe the oracle ran.  No
    // `oracleViolation` marker: nothing was violated, the declaration is
    // unreadable, and that is a brief defect the normal disposition table
    // already routes (exactly as it routes a zero-entry P3/P4).
    if (headingPresent) {
      return {
        probe,
        passed: false,
        detail: "## Frozen Tests heading present but no entries parsed; check brief syntax",
      };
    }
    return { probe, passed: true, detail: "no Frozen Tests declared; check skipped" };
  }

  const touched = [];
  for (const cp of changedArr) {
    const hit = frozenArr.some(function (f) {
      return cp === f || cp.startsWith(f + "/") || f.startsWith(cp + "/");
    });
    if (hit && !touched.includes(cp)) touched.push(cp);
  }

  if (touched.length === 0) {
    return {
      probe,
      passed: true,
      detail: "no frozen path changed; frozen: [" + frozenArr.join(", ") + "]",
    };
  }

  return {
    probe,
    passed: false,
    detail:
      "frozen path(s) changed: [" + touched.join(", ") + "]; " +
      "frozen: [" + frozenArr.join(", ") + "]",
    oracleViolation: true,
  };
}

/**
 * P6: collected — the round's verify must not run fewer tests than the base.
 *
 * Both numbers come from `countVerifyCollected`: the baseline's from the
 * chain-start capture recorded on `chain.json` (never re-captured, so
 * chain-resume compares against the same base as round 1), the round's from
 * P2's own verify run.
 *
 * Either side missing → PASS: an unknown is not a decrease, and failing on it
 * would fail every chain whose verify shape we cannot count.  But the gap is
 * stated in the detail, never left silent — a probe that says nothing reads as
 * "checked, fine", which is the exact confusion this pair exists to remove.
 *
 * @param {object} opts
 * @param {number|null} opts.collected          — tests this round ran.
 * @param {number|null} opts.baselineCollected  — tests the chain-start base ran.
 * @returns {{ probe: string, passed: boolean, detail: string,
 *             limitation?: string, oracleViolation?: true }}
 */
export function runCollectedProbe({ collected, baselineCollected }) {
  const probe = "P6: collected";
  const roundOk = Number.isInteger(collected);
  const baseOk = Number.isInteger(baselineCollected);

  if (!roundOk || !baseOk) {
    const detail =
      "collected count unavailable (baseline " +
      (baseOk ? String(baselineCollected) : "unavailable") +
      ", round " + (roundOk ? String(collected) : "unavailable") +
      "); P6 could not compare, so this round's test count is UNCHECKED";
    return { probe, passed: true, detail, limitation: detail };
  }

  if (collected >= baselineCollected) {
    return {
      probe,
      passed: true,
      detail: "collected " + collected + " >= baseline " + baselineCollected,
    };
  }

  return {
    probe,
    passed: false,
    detail: "collected " + collected + " < baseline " + baselineCollected,
    oracleViolation: true,
  };
}

/**
 * Summarise the round's oracle violations into the single input
 * `deriveDisposition` routes on.
 *
 * One function owns the question "did an oracle probe fail this round?", and
 * it answers from the probe results themselves — no second list of probe
 * names to keep in step with the first.
 *
 * @param {Array<object>|null|undefined} probeResults
 * @returns {string|false} A human-readable summary naming every violation
 *   (so the escalate line names it), or false when there is none.
 */
export function summariseOracleViolations(probeResults) {
  const violated = (Array.isArray(probeResults) ? probeResults : [])
    .filter(function (p) { return p && p.oracleViolation === true; });
  if (violated.length === 0) return false;
  return violated.map(function (p) {
    return (p.probe || "(unnamed probe)") + ": " + (p.detail || "(no detail)");
  }).join("; ");
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
 * @param {object|null} [opts.jobFailure=null] - Structured terminal-failure
 *        classification from the failed job record (kusabi #215):
 *        `{ kind: "quota-exhaustion", quota, backendBlocked, reset }` when
 *        the dispatch classified quota exhaustion, else null.  The renderer
 *        uses it to show the classification instead of the generic capacity
 *        advice ("Retry when provider is available" is exactly wrong for a
 *        session-limit block).
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
  jobFailure = null,
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
    jobFailure,
    records,
  });

  return { records, chainState, outcome };
}

// =========================================================================
// Chain resume (kusabi #153①) — resume-position resolution
// =========================================================================

// ---- replacement review seat (kusabi #248) ------------------------------
//
// A chain can terminate on `escalate` for two very different reasons: the
// review JUDGED the work and found it wanting, or the review SEAT itself died
// mid-stream and never produced a judgement.  Only the second is a spent seat
// over an intact implementation, and only it may be re-bought by chain-resume.
//
// The two seat-failure states the review parser can produce (`partial`,
// `unparseable`) each escalate through deriveDisposition with a reason
// starting with one of these base strings (suffixed by partialDiagnosis
// when available, kusabi #312); the map is keyed by verdict so a seat-failure
// verdict carrying the other verdict's reason reads as inconsistent records,
// not as eligible.
// `needs-attention` and `discard` are deliberately absent: those are completed
// reviews judging the work, and they keep today's refusal.
const REVIEW_SEAT_FAILURE_REASONS = {
  partial: "partial review: stream ended before the verdict line",
  unparseable: "unexpected verdict: unparseable",
};

// The deterministic probes a replacement seat requires a record to COVER.
// runProbePhase always records at least these four (P1 HEAD clean / P2 verify
// gate / P3 deliverables / P4 smoke) on a run that got far enough to be green;
// a shorter list means the probe phase threw partway, so the record cannot
// testify that the work is intact.
//
// P5/P6 (kusabi #197) are deliberately NOT added here: this is a coverage
// floor, and records written before those probes existed must stay resumable.
// It costs nothing in strictness — the all-green check below runs over EVERY
// entry the record holds, so a red P5 disqualifies a seat replacement whether
// or not P5 is named in this list.
const REVIEW_SEAT_PROBES = ["P1", "P2", "P3", "P4"];

/** Not a seat failure at all — the caller keeps its existing refusal verbatim. */
const NOT_A_SEAT_FAILURE = Object.freeze({ eligible: false, detail: null });

/** Seat-failure SHAPE, but the records cannot decide it — name the field. */
function seatRecordsUndecidable(detail) {
  return { eligible: false, detail };
}

/** Append a fail-closed detail to a refusal, when there is one. */
function withSeatDetail(error, detail) {
  return detail ? `${error} — ${detail}` : error;
}

/**
 * Decide whether a chain's FINAL round may buy a replacement review seat
 * (kusabi #248).  Pure: reads only the persisted records, never an LLM and
 * never the worktree.
 *
 * Eligible iff all four hold for the last round record:
 *   1. probes P1–P4 all green,
 *   2. the review verdict is `partial` or `unparseable` (a dead seat — NOT
 *      `needs-attention`, which is a completed review judging the work),
 *   3. the escalate came from that seat failure (not discard, not max-rounds,
 *      not repeated-areas — each of those carries a different
 *      `disposition.reason`),
 *   4. the records needed to decide 1–3 are present and unambiguous.
 *
 * Fail closed (the resume guard's #192 history): a missing or ambiguous field
 * refuses and NAMES the field.  The two negative results are distinct on
 * purpose — `detail: null` means "this escalate was never a seat failure", so
 * the caller's existing refusal stands verbatim; a non-null `detail` means
 * "seat-failure shaped, but undecidable", and it is appended to that refusal.
 *
 * @param {object|null} chainJson — chain.json record.
 * @param {object} [opts]
 * @param {{ backend?: string|null, model?: string|null }|null} [opts.explicitRoute]
 *        — operator-named replacement route (chain-resume `--backend` /
 *        `--model`).  A quota-exhausted seat is never eligible on the SAME
 *        route (kusabi #373); an explicit different route may buy a new seat.
 * @returns {{ eligible: boolean, detail: string|null }}
 */
export function classifyReviewSeatReplacement(chainJson, { explicitRoute } = {}) {
  const records = Array.isArray(chainJson?.records) ? chainJson.records : [];
  const last = records.length > 0 ? records[records.length - 1] : null;
  if (!last || typeof last !== "object") return NOT_A_SEAT_FAILURE;
  if (last.disposition?.disposition !== "escalate") return NOT_A_SEAT_FAILURE;

  // Quota exhaustion is not an unreadable payload (kusabi #373): buying the
  // same seat cannot work.  An explicit different route is the one exception.
  const quota = recordQuotaExhaustion(last);
  const reroutingQuota = quota && explicitRouteDiffersFromRecord(last, explicitRoute);
  if (quota && !reroutingQuota) {
    return seatRecordsUndecidable(quotaReplacementRefusal(quota));
  }

  // The round number addresses the phase the driver re-dispatches; a record
  // that cannot name its own round has no position to resume at.
  if (!Number.isInteger(last.round) || last.round < 1) {
    return seatRecordsUndecidable(
      "the final round record has no usable `round` number — there is no position to resume at"
    );
  }
  const where = `round ${last.round}`;

  // ---- condition 2: a dead SEAT, not a review judgement ----
  // Skipped when rerouting a quota-dead seat: the disposition reason names
  // the exhausted pool, not `unexpected verdict: unparseable`, so the
  // verdict/reason pairing below would refuse a route the operator just named.
  if (!reroutingQuota) {
  const verdict = last.verdict;
  if (typeof verdict !== "string" || verdict === "") {
    return seatRecordsUndecidable(
      "the final round record has no review `verdict` — a dead review seat cannot be told from a completed review"
    );
  }
  const expectedReason = Object.prototype.hasOwnProperty.call(REVIEW_SEAT_FAILURE_REASONS, verdict)
    ? REVIEW_SEAT_FAILURE_REASONS[verdict]
    : null;
  // approve / approve-partial / needs-attention / discard and anything else:
  // a completed review, so this escalate is not a spent seat.
  if (!expectedReason) return NOT_A_SEAT_FAILURE;

  // ---- condition 3: the escalate came from THAT seat failure ----
  const reason = last.disposition?.reason;
  if (typeof reason !== "string" || reason === "") {
    return seatRecordsUndecidable(
      `${where} record has no \`disposition.reason\` — the escalate cause cannot be established`
    );
  }
  if (!reason.startsWith(expectedReason)) {
    // The OTHER seat-failure reason next to this verdict is contradictory
    // records; anything else (max-rounds, discard, repeated areas) is simply
    // a different escalate, which keeps the refusal verbatim.
    const isOtherSeatFailure = Object.entries(REVIEW_SEAT_FAILURE_REASONS).some(
      ([otherVerdict, otherBase]) => otherVerdict !== verdict && reason.startsWith(otherBase)
    );
    return isOtherSeatFailure
      ? seatRecordsUndecidable(
        `${where} record is inconsistent: verdict \`${verdict}\` with \`disposition.reason\` "${reason}"`
      )
      : NOT_A_SEAT_FAILURE;
  }
  } // !reroutingQuota: verdict/reason pairing

  // A replacement review judges an implementation; there must be one.
  if (typeof last.implementJobId !== "string" || !last.implementJobId) {
    return seatRecordsUndecidable(
      `${where} record has no \`implementJobId\` — there is no implementation for a replacement review to judge`
    );
  }

  // ---- condition 1: probes P1–P4 all green ----
  const probeResults = last.probeResults;
  if (!Array.isArray(probeResults) || probeResults.length === 0) {
    return seatRecordsUndecidable(
      `${where} record has no \`probeResults\` — P1–P4 cannot be confirmed green`
    );
  }
  const probeLabels = probeResults.map(function (p) {
    return typeof p?.probe === "string" ? p.probe.split(":")[0].trim() : "";
  });
  const missingProbes = REVIEW_SEAT_PROBES.filter(function (p) { return !probeLabels.includes(p); });
  if (missingProbes.length > 0) {
    return seatRecordsUndecidable(
      `${where} \`probeResults\` does not cover ${missingProbes.join(", ")} — P1–P4 cannot be confirmed green`
    );
  }
  const redProbes = probeResults.filter(function (p) { return p?.passed !== true; });
  if (redProbes.length > 0) {
    const names = redProbes.map(function (p) { return typeof p?.probe === "string" ? p.probe : "(unnamed)"; });
    return seatRecordsUndecidable(
      `${where} \`probeResults\` is not all green (${names.join(", ")}) — the work is not known intact`
    );
  }
  // The summary flag must agree with the entries: `probesGreen` is what the
  // disposition machinery read, so a disagreement is ambiguous records.
  if (last.probesGreen !== true) {
    return seatRecordsUndecidable(
      `${where} record has \`probesGreen\`: ${JSON.stringify(last.probesGreen ?? null)} — a replacement review seat requires green P1–P4`
    );
  }

  return { eligible: true, detail: null };
}

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
 *     any finished status (completed / failed) are errors — with the single
 *     replacement-review-seat exception below, which is decided BEFORE this
 *     gate because such a chain finished normally (status "completed").
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
 *     the chain already finished — error.  ONE exception (kusabi #248): an
 *     `escalate` that classifyReviewSeatReplacement finds eligible — probes
 *     P1–P4 green, verdict `partial`/`unparseable`, and that seat failure is
 *     the recorded escalate cause — resumes at the SAME round's REVIEW phase
 *     to buy a replacement seat.  Never implement: the implementation is
 *     intact and only the seat was consumed, so no round-budget slot is spent
 *     (the return sits before the budget-derived guard).
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
 *   - `reviewSeatReplacement` — true only for the kusabi #248 escalate
 *     exception; tells the driver to archive the failed seat on the record
 *     before dispatching the replacement review
 *   - `reworkCount`, `currentTierIndex`, `strategized`, `session`, `baseSha`
 */
export function resolveChainResume({ control, chainJson, explicitRoute = null }) {
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

  // Replacement review seat (kusabi #248), classified from the records alone
  // and BEFORE the finished-status gate: a chain that escalated on a dead
  // review seat finished NORMALLY (status "completed"), so the gate below
  // would refuse it before the disposition branch ever ran.  `detail` is the
  // fail-closed field name for a seat-shaped escalate whose records cannot
  // decide it; it is null for every other chain, leaving the refusals verbatim.
  const seat = classifyReviewSeatReplacement(chainJson, { explicitRoute });

  if (status !== "cancelled" && !stale && !seat.eligible) {
    return {
      ok: false,
      error: withSeatDetail(`chain already finished (status: ${status})`, seat.detail),
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
    // ---- replacement review seat (kusabi #248) ----
    // The ONE terminal disposition that is resumable: an escalate caused by a
    // dead review seat over green probes.  The resume dispatches the SAME
    // round's REVIEW phase in a fresh session (each phase is a new session;
    // review seats are never reused) — never implement, which is why this
    // returns a review position instead of falling through to the
    // next-round/implement path.  It also returns BEFORE the budget-derived
    // guard below: the round already spent its slot, and re-buying its review
    // spends no new one.
    if (lastDisposition === "escalate" && seat.eligible) {
      return {
        ok: true,
        position: {
          phase: "review",
          round: last.round,
          roundRecord: last,
          records,
          reviewSeatReplacement: true,
          reworkCount: last.reworkCount ?? 0,
          currentTierIndex: last.tierBefore ?? 0,
          strategized,
          session: last.sessionID ?? undefined,
          baseSha,
        },
      };
    }
    if (lastDisposition === "accept" || lastDisposition === "accept-with-followup" || lastDisposition === "escalate") {
      return {
        ok: false,
        error: withSeatDetail(
          `chain already finished (last round ${last.round} disposition: ${lastDisposition})`,
          seat.detail,
        ),
      };
    }
    // A refused-brief-defect ends the chain as terminal (kusabi #293): the
    // brief itself is defective, so resuming would only re-run the same
    // defective brief.  Refuse regardless of control freshness -- even a
    // stale control must not re-dispatch implement on a defective brief.
    if (lastDisposition === "refused-brief-defect") {
      return {
        ok: false,
        error: `chain ended in refused-brief-defect at round ${last.round} \u2014 the brief is defective; fix the brief and re-dispatch a new chain (resume would re-run the same defective brief)`,
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
