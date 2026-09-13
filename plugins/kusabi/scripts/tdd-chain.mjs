// tdd-chain.mjs — Incremental TDD chain: parse requirements, build bounded
// slice plans, execute sequential red/green cycles, persist frozen tests.
//
// Designed to plug into the existing chain architecture:
//   chain-cmd.mjs → tdd-chain.mjs (planner + executor) → chain-driver.mjs
//
// Does NOT import chain-driver.mjs, chain-cmd.mjs, or kusabi-companion.mjs.
// Pure functions for parsing/planning; executor delegates to the chain driver
// for the actual dispatch loop.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum slices the planner will produce. Reject plans exceeding this. */
export const MAX_SLICES = 24;

/** Maximum slice items (requirements) the planner will accept in a plan. */
export const MAX_PLAN_ITEMS = 200;

/** Maximum frozen test paths kept across all slices. */
export const MAX_FROZEN_TESTS = 500;

/** Maximum retry attempts per slice before escalation. */
export const MAX_SLICE_RETRIES = 3;

// ---------------------------------------------------------------------------
// Requirement parsing
// ---------------------------------------------------------------------------

/**
 * Generate a stable requirement ID from a heading text.
 * Uses a deterministic short hash so the ID does not change across parses.
 *
 * @param {string} headingText — the requirement heading text (after markers)
 * @returns {string} — e.g. "req-a3f2b1"
 */
export function stableRequirementId(headingText) {
  const slug = headingText
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const hash = crypto.createHash("sha256").update(slug).digest("hex").slice(0, 8);
  return "req-" + hash;
}

/**
 * Parse a Markdown requirement list into stable requirement objects.
 *
 * Each requirement is a `##` heading whose body contains bullet items
 * describing acceptance criteria or expected behavior.
 *
 * @param {string} md — Markdown text of the requirements file.
 * @returns {Array<{ id: string, slug: string, title: string, criteria: string[] }>}
 */
export function parseRequirements(md) {
  if (!md || typeof md !== "string") return [];

  const lines = md.split("\n");
  const requirements = [];
  let current = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Match ## headings (but not ### or deeper)
    const h2Match = trimmed.match(/^##\s+(.+)/);
    if (h2Match) {
      // Save previous
      if (current) requirements.push(current);

      const title = h2Match[1].trim();
      const id = stableRequirementId(title);
      const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      current = { id, slug, title, criteria: [] };
      continue;
    }

    if (!current) continue;

    // Collect bullet items as criteria
    const bulletMatch = trimmed.match(/^[-*+]\s+(.+)/);
    if (bulletMatch) {
      current.criteria.push(bulletMatch[1].trim());
    }
  }

  // Push last requirement
  if (current) requirements.push(current);

  return requirements;
}

// ---------------------------------------------------------------------------
// Slice planning
// ---------------------------------------------------------------------------

/**
 * A single slice in the ordered plan.
 *
 * @typedef {Object} Slice
 * @property {string} id        — deterministic slice ID (e.g. "slice-0")
 * @property {number} index     — 0-based position in the plan
 * @property {string[]} reqIds  — requirement IDs covered by this slice
 * @property {string} title     — human-readable title
 * @property {string} brief     — the text to hand to the chain round
 * @property {"pending"|"red"|"frozen"|"green"|"failed"} status
 * @property {string[]} frozenTests — accumulated frozen test paths
 * @property {number} retryCount
 * @property {string|null} retryReason
 * @property {string|null} lastError
 */

/**
 * Build a bounded ordered slice plan from requirements.
 *
 * Each requirement becomes one slice. Plans exceeding MAX_SLICES or
 * MAX_PLAN_ITEMS are rejected. Empty or duplicate requirements are
 * rejected.
 *
 * @param {Array<{ id: string, title: string, criteria: string[] }>} requirements
 * @param {{ maxSlices?: number, maxItems?: number }} opts
 * @returns {{ ok: true, plan: Slice[] } | { ok: false, error: string }}
 */
export function buildSlicePlan(requirements, opts = {}) {
  const maxSlices = opts.maxSlices ?? MAX_SLICES;
  const maxItems = opts.maxItems ?? MAX_PLAN_ITEMS;

  if (!Array.isArray(requirements) || requirements.length === 0) {
    return { ok: false, error: "no requirements provided" };
  }

  if (requirements.length > maxItems) {
    return {
      ok: false,
      error: `too many requirements: ${requirements.length} exceeds limit of ${maxItems}`,
    };
  }

  // Deduplicate by ID
  const seen = new Set();
  const unique = [];
  for (const req of requirements) {
    if (seen.has(req.id)) {
      return { ok: false, error: `duplicate requirement ID: ${req.id}` };
    }
    seen.add(req.id);
    unique.push(req);
  }

  if (unique.length > maxSlices) {
    return {
      ok: false,
      error: `plan exceeds maximum slices: ${unique.length} > ${maxSlices}`,
    };
  }

  const plan = unique.map((req, index) => ({
    id: "slice-" + index,
    index,
    reqIds: [req.id],
    title: req.title,
    brief: formatSliceBrief(req),
    status: "pending",
    frozenTests: [],
    retryCount: 0,
    retryReason: null,
    lastError: null,
  }));

  return { ok: true, plan };
}

/**
 * Format the brief text for a single slice from a requirement.
 *
 * @param {{ id: string, title: string, criteria: string[] }} req
 * @returns {string}
 */
export function formatSliceBrief(req) {
  const lines = [
    `Implement requirement: ${req.title}`,
    "",
    `Requirement ID: ${req.id}`,
    "",
    "## Acceptance Criteria",
    "",
  ];
  for (const c of req.criteria) {
    lines.push("- " + c);
  }
  lines.push("");
  lines.push("## Deliverables");
  lines.push("");
  lines.push("List the files created or modified in the final answer.");
  lines.push("");
  lines.push("## Smoke");
  lines.push("");
  lines.push("node --test");
  return lines.join("\n");
}

/**
 * Generate a test-author brief for a slice's red phase.
 *
 * The brief instructs the worker to write minimal failing tests for the
 * requirement.  Frozen tests from previous slices are included as context
 * so the worker knows what must not regress.
 *
 * @param {Slice} slice
 * @param {string[]} accumulatedFrozenTests
 * @returns {string}
 */
export function generateTestAuthorBrief(slice, accumulatedFrozenTests = []) {
  const lines = [
    `Write failing tests for requirement: ${slice.title}`,
    "",
    `Slice: ${slice.id}`,
    `Requirement IDs: ${slice.reqIds.join(", ")}`,
    "",
    "## Acceptance Criteria",
    "",
  ];
  // Extract criteria from the slice brief
  const criteria = slice.brief.match(/^- .+$/gm) || [];
  for (const c of criteria) {
    lines.push(c);
  }
  if (accumulatedFrozenTests.length > 0) {
    lines.push("");
    lines.push("## Existing Frozen Tests (do not modify)");
    lines.push("");
    for (const t of accumulatedFrozenTests) {
      lines.push("- " + t);
    }
  }
  lines.push("");
  lines.push("## Deliverables");
  lines.push("");
  lines.push("Write minimal test files that assert the acceptance criteria.");
  lines.push("These tests should FAIL at this point (no implementation exists yet).");
  lines.push("");
  lines.push("## Smoke");
  lines.push("");
  lines.push("node --test");
  return lines.join("\n");
}

/**
 * Generate an implement brief for a slice's green phase.
 *
 * The brief instructs the worker to implement the requirement so that all
 * tests (including accumulated frozen tests) pass.
 *
 * @param {Slice} slice
 * @param {string[]} accumulatedFrozenTests
 * @returns {string}
 */
export function generateImplementBrief(slice, accumulatedFrozenTests = []) {
  const lines = [
    `Implement requirement: ${slice.title}`,
    "",
    `Slice: ${slice.id}`,
    `Requirement IDs: ${slice.reqIds.join(", ")}`,
    "",
    "## Acceptance Criteria",
    "",
  ];
  const criteria = slice.brief.match(/^- .+$/gm) || [];
  for (const c of criteria) {
    lines.push(c);
  }
  if (accumulatedFrozenTests.length > 0) {
    lines.push("");
    lines.push("## Frozen Tests (must all pass)");
    lines.push("");
    for (const t of accumulatedFrozenTests) {
      lines.push("- " + t);
    }
  }
  lines.push("");
  // No ## Deliverables or ## Smoke headings: the TDD executor's implement
  // brief doesn't declare file paths or smoke commands — the P3/P4 probes
  // skip when the headings are absent.
  return lines.join("\n");
}

/**
 * Determine if the current slice should be treated as "red" based on the
 * round record.  A round with completed status and worktree change is red
 * (tests exist but may fail); no worktree change means empty-completion.
 *
 * @param {object} roundRecord
 * @returns {boolean}
 */
export function isSliceRed(roundRecord) {
  if (!roundRecord) return false;
  return roundRecord.implementJobStatus === "completed" && roundRecord.worktreeChanged === true;
}

/**
 * Determine if the current slice should be treated as "green" based on
 * the round record.  A round is green when it completed, probes are
 * green, and the worktree changed (indicating implementation happened).
 *
 * @param {object} roundRecord
 * @returns {boolean}
 */
export function isSliceGreen(roundRecord) {
  if (!roundRecord) return false;
  return (
    roundRecord.implementJobStatus === "completed" &&
    roundRecord.probesGreen === true &&
    roundRecord.worktreeChanged === true
  );
}

/**
 * Extract new test file paths from a round record's changed paths.
 * Looks for .test.mjs, .test.js, .spec.mjs, .spec.js files.
 *
 * @param {object} roundRecord
 * @returns {string[]}
 */
export function extractTestPaths(roundRecord) {
  if (!roundRecord) return [];
  const paths = roundRecord.chainChangedPaths || [];
  return paths.filter((p) => /\.(test|spec)\.(mjs|mts|jsx?|tsx?)$/.test(p));
}

// ---------------------------------------------------------------------------
// Slice execution state
// ---------------------------------------------------------------------------

/**
 * The persisted state for an incremental TDD chain.
 *
 * @typedef {Object} TddChainState
 * @property {string} chainId
 * @property {string} strategy    — "incremental-tdd"
 * @property {string} requirementsFile
 * @property {Slice[]} plan
 * @property {string[]} completedReqIds
 * @property {string[]} accumulatedFrozenTests
 * @property {number} currentSliceIndex
 * @property {"running"|"completed"|"failed"|"cancelled"} status
 * @property {{ attempts: number, reason: string|null, exhausted: boolean }} retryInfo
 * @property {string|null} failureReason
 * @property {string} startedAt
 * @property {string|null} finishedAt
 * @property {number} nextRound — next round number for persistChainState (stable across resumes)
 */

/**
 * Create an initial TDD chain state.
 *
 * @param {object} opts
 * @param {string} opts.chainId
 * @param {string} opts.requirementsFile
 * @param {Slice[]} opts.plan
 * @returns {TddChainState}
 */
export function createTddChainState({ chainId, requirementsFile, plan }) {
  return {
    chainId,
    strategy: "incremental-tdd",
    requirementsFile,
    plan,
    completedReqIds: [],
    accumulatedFrozenTests: [],
    currentSliceIndex: 0,
    status: "running",
    retryInfo: { attempts: 0, reason: null, exhausted: false },
    failureReason: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    nextRound: 1,
  };
}

// ---------------------------------------------------------------------------
// Slice transition logic
// ---------------------------------------------------------------------------

/**
 * Advance to the next slice after a successful green.
 *
 * @param {TddChainState} state — mutated in place
 * @returns {Slice|null} — the next slice, or null if plan is complete
 */
export function advanceSlice(state) {
  if (state.status !== "running") return null;

  const current = state.plan[state.currentSliceIndex];
  if (current) {
    current.status = "green";
    state.completedReqIds.push(...current.reqIds);
    state.accumulatedFrozenTests.push(...current.frozenTests);
  }

  state.currentSliceIndex += 1;
  state.retryInfo = { attempts: 0, reason: null, exhausted: false };

  if (state.currentSliceIndex >= state.plan.length) {
    state.status = "completed";
    state.finishedAt = new Date().toISOString();
    return null;
  }

  const next = state.plan[state.currentSliceIndex];
  if (next) next.status = "pending";
  return next;
}

/**
 * Mark the current slice as red (test authored and failing).
 *
 * @param {TddChainState} state
 */
export function markRed(state) {
  const current = state.plan[state.currentSliceIndex];
  if (current) current.status = "red";
}

/**
 * Freeze test paths after the red phase is verified.
 *
 * @param {TddChainState} state
 * @param {string[]} testPaths — paths of the newly authored tests
 */
export function freezeTests(state, testPaths) {
  const current = state.plan[state.currentSliceIndex];
  if (current) {
    current.status = "frozen";
    current.frozenTests = [...testPaths];
  }
}

/**
 * Mark a slice as failed and handle retry logic.
 *
 * @param {TddChainState} state
 * @param {string} reason
 * @param {{ maxRetries?: number }} opts
 * @returns {{ retriable: boolean, exhausted: boolean }}
 */
export function markSliceFailed(state, reason, opts = {}) {
  const maxRetries = opts.maxRetries ?? MAX_SLICE_RETRIES;
  const current = state.plan[state.currentSliceIndex];
  if (!current) return { retriable: false, exhausted: true };

  current.status = "failed";
  current.lastError = reason;
  current.retryCount += 1;

  state.retryInfo.attempts = current.retryCount;
  state.retryInfo.reason = reason;

  if (current.retryCount >= maxRetries) {
    state.retryInfo.exhausted = true;
    state.status = "failed";
    state.failureReason = `slice ${current.id} exhausted retries after ${current.retryCount} attempts: ${reason}`;
    state.finishedAt = new Date().toISOString();
    return { retriable: false, exhausted: true };
  }

  // Reset for retry
  current.status = "pending";
  current.lastError = null;
  return { retriable: true, exhausted: false };
}

/**
 * Mark a slice as failed with no deliverable (completed worker, no files).
 * This is always treated as a failed attempt.
 *
 * @param {TddChainState} state
 * @param {string} reason
 * @returns {{ retriable: boolean, exhausted: boolean }}
 */
export function markEmptyDiff(state, reason) {
  return markSliceFailed(state, reason || "completed with no deliverable changes");
}

/**
 * Mark the entire TDD chain as cancelled (signal or stop-lever).
 * Persists the cancelled status so the chain-wait predicate resolves.
 *
 * @param {TddChainState} state — mutated in place
 * @param {string} [reason]
 */
export function cancelTddChain(state, reason) {
  state.status = "cancelled";
  state.failureReason = reason || "cancelled by operator";
  state.finishedAt = new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Persist the TDD chain state to disk.
 *
 * @param {string} chainDir — the chain directory
 * @param {TddChainState} state
 */
export function persistTddState(chainDir, state) {
  const statePath = path.join(chainDir, "tdd-chain.json");
  const tmpPath = statePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmpPath, statePath);
}

/**
 * Load the TDD chain state from disk.
 *
 * @param {string} chainDir
 * @returns {TddChainState|null}
 */
export function loadTddState(chainDir) {
  const statePath = path.join(chainDir, "tdd-chain.json");
  if (!fs.existsSync(statePath)) return null;
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Coverage analysis
// ---------------------------------------------------------------------------

/**
 * Compute requirement-to-test coverage from the accumulated state.
 *
 * @param {TddChainState} state
 * @returns {{ covered: string[], uncovered: string[], frozenTestCount: number }}
 */
export function computeCoverage(state) {
  const allReqIds = state.plan.flatMap((s) => s.reqIds);
  const covered = state.completedReqIds.filter((id) => allReqIds.includes(id));
  const uncovered = allReqIds.filter((id) => !covered.includes(id));
  return {
    covered,
    uncovered,
    frozenTestCount: state.accumulatedFrozenTests.length,
  };
}

// ---------------------------------------------------------------------------
// Rendering for chain-show
// ---------------------------------------------------------------------------

/**
 * Render the incremental TDD chain status for chain-show.
 *
 * @param {TddChainState} state
 * @returns {string[]}
 */
export function renderTddChainStatus(state) {
  const lines = [];
  const coverage = computeCoverage(state);

  lines.push("strategy: incremental-tdd");
  lines.push(`requirements file: ${state.requirementsFile}`);
  lines.push(`status: ${state.status}`);

  if (state.failureReason) {
    lines.push(`failure reason: ${state.failureReason}`);
  }

  lines.push(
    `progress: ${state.completedReqIds.length}/${state.plan.length} slices completed`
  );
  lines.push(
    `coverage: ${coverage.covered.length} covered, ${coverage.uncovered.length} uncovered`
  );
  lines.push(`frozen tests: ${coverage.frozenTestCount}`);

  if (state.retryInfo.reason) {
    lines.push(
      `retry: attempt ${state.retryInfo.attempts}, reason: ${state.retryInfo.reason}${
        state.retryInfo.exhausted ? " (EXHAUSTED)" : ""
      }`
    );
  }

  lines.push("");

  // Per-slice detail
  for (const slice of state.plan) {
    const statusIcon =
      slice.status === "green"
        ? "✓"
        : slice.status === "failed"
          ? "✗"
          : slice.status === "frozen"
            ? "❄"
            : slice.status === "red"
              ? "●"
              : "○";
    const reqIds = slice.reqIds.join(", ");
    const retry =
      slice.retryCount > 0 ? ` (retry ${slice.retryCount}/${MAX_SLICE_RETRIES})` : "";
    const frozen = slice.frozenTests.length > 0
      ? ` [${slice.frozenTests.length} frozen]`
      : "";
    lines.push(
      `  ${statusIcon} ${slice.id}: ${slice.title} [${reqIds}]${retry}${frozen}`
    );
  }

  return lines;
}

/**
 * Render requirement-to-test coverage report for final review.
 *
 * @param {TddChainState} state
 * @returns {string}
 */
export function renderCoverageReport(state) {
  const lines = ["## Requirement-to-Test Coverage", ""];
  const coverage = computeCoverage(state);

  for (const slice of state.plan) {
    const frozen = state.accumulatedFrozenTests.filter((t) =>
      slice.frozenTests.includes(t)
    );
    lines.push(`### ${slice.title} (${slice.reqIds.join(", ")})`);
    lines.push(`- Status: ${slice.status}`);
    lines.push(`- Frozen tests: ${frozen.length > 0 ? frozen.join(", ") : "(none)"}`);
    lines.push("");
  }

  lines.push("### Summary");
  lines.push(`- Total requirements: ${state.plan.length}`);
  lines.push(`- Covered: ${coverage.covered.length}`);
  lines.push(`- Uncovered: ${coverage.uncovered.length}`);
  lines.push(`- Total frozen tests: ${coverage.frozenTestCount}`);

  if (coverage.uncovered.length > 0) {
    lines.push(`- Uncovered req IDs: ${coverage.uncovered.join(", ")}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate that a loaded state is usable for resumption.
 *
 * A failed-but-retryable state is resumable ONLY through the retry
 * transition — it must not be treated as ordinary runnable progress.
 * The caller must pass `retryTransition: true` when entering via retry.
 *
 * @param {TddChainState|null} state
 * @param {{ retryTransition?: boolean }} [opts]
 * @returns {{ ok: true, state: TddChainState } | { ok: false, error: string }}
 */
export function validateTddState(state, opts = {}) {
  if (!state) return { ok: false, error: "no TDD chain state found" };
  if (state.strategy !== "incremental-tdd") {
    return { ok: false, error: `unexpected strategy: ${state.strategy}` };
  }
  if (!Array.isArray(state.plan) || state.plan.length === 0) {
    return { ok: false, error: "plan is empty or missing" };
  }
  if (state.status === "completed") {
    return { ok: false, error: "chain already completed" };
  }
  if (state.status === "cancelled") {
    return { ok: false, error: "chain was cancelled" };
  }
  if (state.status === "failed" && state.retryInfo.exhausted) {
    return { ok: false, error: "chain failed: retries exhausted" };
  }
  // A failed-but-retryable state (current slice has retryCount > 0 but not
  // exhausted) is only resumable through the retry transition.  This prevents
  // a failed slice from being treated as ordinary runnable progress — the
  // caller must explicitly acknowledge the retry.
  const currentSlice = state.plan[state.currentSliceIndex];
  if (
    currentSlice &&
    currentSlice.status === "failed" &&
    currentSlice.retryCount > 0 &&
    !opts.retryTransition
  ) {
    return {
      ok: false,
      error: `slice ${currentSlice.id} is in failed state (retry ${currentSlice.retryCount}) — use retry transition`,
    };
  }
  // A frozen or red subphase is resumable: the executor picks up at the
  // correct phase boundary based on the slice's persisted status.
  return { ok: true, state };
}

/**
 * Check if the plan is valid (no unmapped, no duplicates, bounds respected).
 *
 * @param {Slice[]} plan
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validatePlan(plan) {
  if (!Array.isArray(plan)) return { ok: false, error: "plan is not an array" };
  if (plan.length === 0) return { ok: false, error: "plan is empty" };
  if (plan.length > MAX_SLICES) {
    return { ok: false, error: `plan exceeds maximum slices: ${plan.length}` };
  }

  const ids = new Set();
  for (const slice of plan) {
    if (!slice.id) return { ok: false, error: "slice missing id" };
    if (ids.has(slice.id)) return { ok: false, error: `duplicate slice id: ${slice.id}` };
    ids.add(slice.id);
    if (!Array.isArray(slice.reqIds) || slice.reqIds.length === 0) {
      return { ok: false, error: `slice ${slice.id} has no reqIds` };
    }
  }

  return { ok: true };
}
