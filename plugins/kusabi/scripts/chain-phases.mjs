// chain-phases.mjs — Round lifecycle phases for cmdChain.
//
// Every function in this module receives cross-round state (baseSha,
// strategized, records) as explicit arguments and returns results as
// explicit return values — nothing is captured from an enclosing scope.
//
// Quota classification and recorded-failure / explicit-route helpers
// (classifyDispatchQuotaExhaustion, quotaExhaustionReason, quotaReplacementRefusal,
// recordQuotaExhaustion, explicitRouteDiffersFromRecord) live in
// chain-quota.mjs (kusabi #453).
//
// Chain-wide usage totals, round/chain.json persistence, and review-record.md
// writing (computeChainTotals, persistChainState, writeReviewRecord) live in
// chain-persist.mjs (kusabi #451).
//
// Container-context collection (collectContainerBaseContext,
// CHANGE_SCOPE_CONTAINER_PATH, CHANGE_SCOPE_HOST_PATH, collectChangeScope,
// assertContainerBaseRef, collectContainerReviewInput, collectReviewContext)
// lives in chain-collect.mjs (kusabi #449).
//
// Implement prompt assembly, implement dispatch, and probe orchestration
// (withContainerWorkspace, buildImplementText, runImplementPhase, runProbePhase)
// live in chain-run.mjs (kusabi #447).
//
// Probe functions (runHeadCleanProbe, runVerifyProbe, runDeliverablesProbe,
// runSmokeProbe, runSmokeEntry) live in chain-probes.mjs.
//
// Review functions (runReviewPhase, parseReviewResult, buildReviewRepairPrompt,
// shouldSkipReview, renderProbeReport, renderReviewPriorFindings) live in
// chain-review.mjs (kusabi #435).
//
// Outcome rendering (renderAcceptOutcome, renderAcceptWithFollowupOutcome,
// renderEscalateOutcome, renderRefusalOutcome, renderBriefSyntaxDefectOutcome,
// renderMaxRoundsOutcome, renderProviderExhaustedOutcome, handleProviderExhaustion)
// lives in chain-outcomes.mjs (kusabi #439).
//
// Resume position and replacement review seat resolution (resolveChainResume,
// classifyReviewSeatReplacement, archiveFailedReviewSeat) live in
// chain-resume-resolve.mjs (kusabi #441).
//
// Strategize prompt assembly and dispatch (runStrategizePhase)
// lives in chain-strategize.mjs (kusabi #455).
//
// Rework scheduling, path-normalised stall detection, and tier escalation
// (normalizeFilePath, hasRepeatedAreas, resolveReworkScope,
// inScopeFindingFiles, applyTierEscalation, recordReworkEscalation)
// live in chain-rework.mjs (kusabi #457).


import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// resolveRoundResume is defined below and is the only resume-resolution
// mechanism.  checkpoint_restore was removed in issue #114 — the chain
// never rolls the worktree back.
import {
  buildVerifyBaseline,
} from "./chain-probes.mjs";

// =========================================================================
// Setup / initialisation
// =========================================================================

/**
 * Mint a fresh chain id in the shape the chain directories use.
 *
 * Extracted from createChainDir (kusabi #514): chain-detach mints the id in
 * the PARENT so it can hand the id back to the caller before the child has
 * even created the directory — `chain-wait <id>` then waits for the chain
 * by name instead of selecting by recency (--next), which keyed on cwd and
 * let two orchestrators working the same repo select each other's chains.
 */
export function mintChainId() {
  return `chain-${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
}

/**
 * Validate an externally supplied chain id against the shape mintChainId
 * produces.
 *
 * This is a security boundary, not a tidiness check: the id becomes a path
 * segment under `chains/`, so a value containing `/`, `..` or a NUL must
 * never reach path.join.  The shape check rejects all of them by
 * construction — only lowercase letters and digits may follow `chain-`.
 *
 * @param {string} chainId
 * @throws {Error} when the id does not match the generator's shape.
 */
export function assertChainIdShape(chainId) {
  if (typeof chainId !== "string" || !/^chain-[a-z0-9]+$/.test(chainId)) {
    throw new Error(
      `invalid chain id: ${JSON.stringify(chainId)} — a chain id must match ` +
      `chain-[a-z0-9]+ (it becomes a path segment under chains/, so /, .. and ` +
      `other separators are refused)`,
    );
  }
}

/**
 * The refusal for a chain id whose directory already exists.
 *
 * One wording, shared by createChainDir and cmdChainDetach (kusabi #514
 * finding 1): the detach launcher must refuse a pre-existing id in the
 * PARENT with the same words the child's createChainDir would have used,
 * so the operator meets one refusal text wherever it fires.
 *
 * @param {string} chainId
 * @returns {string}
 */
export function chainIdExistsMessage(chainId) {
  return (
    `chain id already exists: ${chainId} — two chains sharing a directory would ` +
    `interleave round records. Pick a fresh --chain-id or inspect the existing ` +
    `chain with chain-show ${chainId}.`
  );
}

/**
 * Refuse an id whose chains/<id> directory already exists.
 *
 * Used by the detach launcher in the parent (finding 1) and by
 * createChainDir's own fast path; the EEXIST catch in createChainDir is the
 * atomic backstop that makes the guarantee under a check-then-act race
 * (finding 2).  The id must already be shape-validated — it is joined onto
 * the chains/ path.
 *
 * @param {string} stateDir
 * @param {string} chainId
 * @throws {Error} with chainIdExistsMessage when the directory exists.
 */
export function assertChainIdAvailable(stateDir, chainId) {
  if (fs.existsSync(path.join(stateDir, "chains", chainId))) {
    throw new Error(chainIdExistsMessage(chainId));
  }
}

/**
 * Create a chain directory and return its identity.
 *
 * A supplied chainId (kusabi #514) is validated against the minted shape and
 * refused when its directory already exists — two chains sharing a
 * directory would interleave round records, so the id must be fresh.  When
 * no id is supplied one is minted.
 *
 * The refusal is enforced by an atomic claim, not a check-then-act
 * (finding 2): chains/ is created recursively, then the chain directory
 * itself is created with a NON-recursive mkdir that throws EEXIST on an
 * existing directory — so two dispatches that pass the existsSync fast path
 * in the same window cannot both "create" it and interleave round records.
 *
 * @param {string} stateDir
 * @param {string|null} [chainId] — externally supplied id; minted when null.
 * @returns {{ chainId: string, chainDir: string }}
 */
export function createChainDir(stateDir, chainId = null) {
  const id = chainId ?? mintChainId();
  assertChainIdShape(id);
  const chainDir = path.join(stateDir, "chains", id);
  // Fast path for the friendlier error before any write; the EEXIST catch
  // below is what must make the guarantee.
  assertChainIdAvailable(stateDir, id);
  fs.mkdirSync(path.join(stateDir, "chains"), { recursive: true });
  try {
    fs.mkdirSync(chainDir);
  } catch (err) {
    if (err?.code === "EEXIST") {
      throw new Error(chainIdExistsMessage(id));
    }
    throw err;
  }
  return { chainId: id, chainDir };
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
