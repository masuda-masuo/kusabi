import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  stableRequirementId,
  parseRequirements,
  buildSlicePlan,
  formatSliceBrief,
  generateTestAuthorBrief,
  generateImplementBrief,
  isSliceRed,
  isSliceGreen,
  extractTestPaths,
  createTddChainState,
  advanceSlice,
  markRed,
  freezeTests,
  markSliceFailed,
  markEmptyDiff,
  persistTddState,
  loadTddState,
  computeCoverage,
  renderTddChainStatus,
  renderCoverageReport,
  validateTddState,
  validatePlan,
  MAX_SLICES,
  MAX_SLICE_RETRIES,
} from "./tdd-chain.mjs";


// ---------------------------------------------------------------------------
// stableRequirementId
// ---------------------------------------------------------------------------

describe("stableRequirementId", () => {
  it("produces deterministic IDs from heading text", () => {
    const id1 = stableRequirementId("User Authentication");
    const id2 = stableRequirementId("User Authentication");
    assert.equal(id1, id2);
  });

  it("produces different IDs for different headings", () => {
    const id1 = stableRequirementId("User Authentication");
    const id2 = stableRequirementId("Data Export");
    assert.notEqual(id1, id2);
  });

  it("produces IDs with the req- prefix", () => {
    const id = stableRequirementId("Test");
    assert.match(id, /^req-[a-f0-9]{8}$/);
  });
});


// ---------------------------------------------------------------------------
// parseRequirements
// ---------------------------------------------------------------------------

describe("parseRequirements", () => {
  it("parses a simple Markdown requirement list", () => {
    const md = [
      "# Requirements",
      "",
      "## User Authentication",
      "- Users can log in with email/password",
      "- Sessions expire after 30 minutes",
      "",
      "## Data Export",
      "- Export to CSV",
      "- Export to JSON",
    ].join("\n");

    const reqs = parseRequirements(md);
    assert.equal(reqs.length, 2);
    assert.equal(reqs[0].title, "User Authentication");
    assert.equal(reqs[0].criteria.length, 2);
    assert.equal(reqs[1].title, "Data Export");
    assert.equal(reqs[1].criteria.length, 2);
  });

  it("produces stable IDs for the same input", () => {
    const md = "## Feature A\n- criterion 1\n";
    const reqs1 = parseRequirements(md);
    const reqs2 = parseRequirements(md);
    assert.equal(reqs1[0].id, reqs2[0].id);
  });

  it("returns empty array for empty/null input", () => {
    assert.deepEqual(parseRequirements(null), []);
    assert.deepEqual(parseRequirements(""), []);
    assert.deepEqual(parseRequirements(undefined), []);
  });

  it("ignores headings that are not ## level", () => {
    const md = [
      "# Top Level",
      "## Valid",
      "- item",
      "### Sub",
      "- sub item",
      "## Another",
      "- another item",
    ].join("\n");

    const reqs = parseRequirements(md);
    assert.equal(reqs.length, 2);
    assert.equal(reqs[0].title, "Valid");
    assert.equal(reqs[1].title, "Another");
  });

  it("collects bullet items as criteria", () => {
    const md = "## Feature\n- criterion 1\n- criterion 2\n- criterion 3\n";
    const reqs = parseRequirements(md);
    assert.equal(reqs[0].criteria.length, 3);
  });

  it("generates slugs from titles", () => {
    const md = "## User Login Flow\n- item\n";
    const reqs = parseRequirements(md);
    assert.equal(reqs[0].slug, "user-login-flow");
  });
});


// ---------------------------------------------------------------------------
// buildSlicePlan
// ---------------------------------------------------------------------------

describe("buildSlicePlan", () => {
  const sampleReqs = [
    { id: "req-1", slug: "auth", title: "Authentication", criteria: ["criterion 1"] },
    { id: "req-2", slug: "export", title: "Export", criteria: ["criterion 2"] },
  ];

  it("builds a plan from requirements", () => {
    const result = buildSlicePlan(sampleReqs);
    assert.equal(result.ok, true);
    assert.equal(result.plan.length, 2);
    assert.deepEqual(result.plan[0].reqIds, ["req-1"]);
    assert.deepEqual(result.plan[1].reqIds, ["req-2"]);
  });

  it("rejects empty input", () => {
    const result = buildSlicePlan([]);
    assert.equal(result.ok, false);
    assert.match(result.error, /no requirements/);
  });

  it("rejects null input", () => {
    const result = buildSlicePlan(null);
    assert.equal(result.ok, false);
  });

  it("rejects duplicate requirement IDs", () => {
    const reqs = [
      { id: "req-1", slug: "a", title: "A", criteria: [] },
      { id: "req-1", slug: "b", title: "B", criteria: [] },
    ];
    const result = buildSlicePlan(reqs);
    assert.equal(result.ok, false);
    assert.match(result.error, /duplicate requirement ID/);
  });

  it("rejects plans exceeding MAX_SLICES", () => {
    const reqs = Array.from({ length: MAX_SLICES + 1 }, (_, i) => ({
      id: "req-" + i,
      slug: "s" + i,
      title: "Slice " + i,
      criteria: [],
    }));
    const result = buildSlicePlan(reqs);
    assert.equal(result.ok, false);
    assert.match(result.error, /exceeds maximum slices/);
  });

  it("initializes slice status as pending", () => {
    const result = buildSlicePlan(sampleReqs);
    assert.equal(result.plan[0].status, "pending");
  });

  it("sets slice ID to slice-{index}", () => {
    const result = buildSlicePlan(sampleReqs);
    assert.equal(result.plan[0].id, "slice-0");
    assert.equal(result.plan[1].id, "slice-1");
  });
});


// ---------------------------------------------------------------------------
// formatSliceBrief
// ---------------------------------------------------------------------------

describe("formatSliceBrief", () => {
  it("includes the requirement title and criteria", () => {
    const req = {
      id: "req-1",
      title: "Feature X",
      criteria: ["Criterion A", "Criterion B"],
    };
    const brief = formatSliceBrief(req);
    assert.match(brief, /Feature X/);
    assert.match(brief, /Criterion A/);
    assert.match(brief, /Criterion B/);
  });

  it("includes Deliverables section", () => {
    const req = { id: "req-1", title: "F", criteria: [] };
    const brief = formatSliceBrief(req);
    assert.match(brief, /## Deliverables/);
  });

  it("includes Smoke section", () => {
    const req = { id: "req-1", title: "F", criteria: [] };
    const brief = formatSliceBrief(req);
    assert.match(brief, /## Smoke/);
  });
});


// ---------------------------------------------------------------------------
// TDD chain state lifecycle
// ---------------------------------------------------------------------------

describe("createTddChainState", () => {
  it("creates initial state", () => {
    const plan = [
      { id: "slice-0", index: 0, reqIds: ["r1"], title: "A", brief: "", status: "pending", frozenTests: [], retryCount: 0, retryReason: null, lastError: null },
    ];
    const state = createTddChainState({
      chainId: "chain-1",
      requirementsFile: "reqs.md",
      plan,
    });
    assert.equal(state.chainId, "chain-1");
    assert.equal(state.strategy, "incremental-tdd");
    assert.equal(state.status, "running");
    assert.equal(state.currentSliceIndex, 0);
    assert.equal(state.completedReqIds.length, 0);
  });
});


describe("advanceSlice", () => {
  function makeState(sliceCount = 2) {
    const plan = Array.from({ length: sliceCount }, (_, i) => ({
      id: "slice-" + i,
      index: i,
      reqIds: ["r" + i],
      title: "S" + i,
      brief: "",
      status: "pending",
      frozenTests: [],
      retryCount: 0,
      retryReason: null,
      lastError: null,
    }));
    return createTddChainState({ chainId: "c1", requirementsFile: "r.md", plan });
  }

  it("marks current slice green and advances", () => {
    const state = makeState();
    const next = advanceSlice(state);
    assert.equal(state.plan[0].status, "green");
    assert.equal(state.currentSliceIndex, 1);
    assert.deepEqual(state.completedReqIds, ["r0"]);
    assert.deepEqual(next.id, "slice-1");
  });

  it("returns null and marks completed when all slices done", () => {
    const state = makeState(1);
    const next = advanceSlice(state);
    assert.equal(next, null);
    assert.equal(state.status, "completed");
    assert.equal(state.finishedAt !== null, true);
  });

  it("clears retry info on advance", () => {
    const state = makeState();
    state.retryInfo = { attempts: 2, reason: "some error", exhausted: false };
    advanceSlice(state);
    assert.equal(state.retryInfo.attempts, 0);
    assert.equal(state.retryInfo.reason, null);
  });
});


describe("markRed / freezeTests", () => {
  it("marks current slice as red", () => {
    const plan = [
      { id: "s0", index: 0, reqIds: ["r0"], title: "A", brief: "", status: "pending", frozenTests: [], retryCount: 0, retryReason: null, lastError: null },
    ];
    const state = createTddChainState({ chainId: "c1", requirementsFile: "r.md", plan });
    markRed(state);
    assert.equal(state.plan[0].status, "red");
  });

  it("freezes test paths and marks as frozen", () => {
    const plan = [
      { id: "s0", index: 0, reqIds: ["r0"], title: "A", brief: "", status: "red", frozenTests: [], retryCount: 0, retryReason: null, lastError: null },
    ];
    const state = createTddChainState({ chainId: "c1", requirementsFile: "r.md", plan });
    freezeTests(state, ["tests/test-auth.mjs"]);
    assert.equal(state.plan[0].status, "frozen");
    assert.deepEqual(state.plan[0].frozenTests, ["tests/test-auth.mjs"]);
  });
});


describe("markSliceFailed", () => {
  function makeState() {
    const plan = [
      { id: "s0", index: 0, reqIds: ["r0"], title: "A", brief: "", status: "pending", frozenTests: [], retryCount: 0, retryReason: null, lastError: null },
    ];
    return createTddChainState({ chainId: "c1", requirementsFile: "r.md", plan });
  }

  it("increments retry count and marks retriable", () => {
    const state = makeState();
    const result = markSliceFailed(state, "implement failed");
    assert.equal(result.retriable, true);
    assert.equal(state.plan[0].retryCount, 1);
    assert.equal(state.retryInfo.attempts, 1);
  });

  it("exhausts retries and marks failed", () => {
    const state = makeState();
    for (let i = 0; i < MAX_SLICE_RETRIES; i++) {
      markSliceFailed(state, "error " + i);
    }
    assert.equal(state.status, "failed");
    assert.match(state.failureReason, /exhausted retries/);
  });

  it("resets slice status for retry", () => {
    const state = makeState();
    markSliceFailed(state, "error");
    assert.equal(state.plan[0].status, "pending");
  });
});


describe("markEmptyDiff", () => {
  it("treats empty diff as a failed attempt", () => {
    const plan = [
      { id: "s0", index: 0, reqIds: ["r0"], title: "A", brief: "", status: "pending", frozenTests: [], retryCount: 0, retryReason: null, lastError: null },
    ];
    const state = createTddChainState({ chainId: "c1", requirementsFile: "r.md", plan });
    const result = markEmptyDiff(state, "completed with no deliverable changes");
    assert.equal(result.retriable, true);
    // lastError is reset to null when status is set back to pending for retry
    assert.equal(state.plan[0].lastError, null);
    assert.equal(state.plan[0].retryCount, 1);
  });
});


// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("persistTddState / loadTddState", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-tdd-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips state through disk", () => {
    const plan = [
      { id: "s0", index: 0, reqIds: ["r0"], title: "A", brief: "b", status: "green", frozenTests: ["t1"], retryCount: 1, retryReason: "err", lastError: null },
    ];
    const state = createTddChainState({ chainId: "c1", requirementsFile: "r.md", plan });
    state.completedReqIds = ["r0"];
    state.accumulatedFrozenTests = ["t1"];
    state.currentSliceIndex = 1;

    persistTddState(tmpDir, state);
    const loaded = loadTddState(tmpDir);

    assert.ok(loaded);
    assert.equal(loaded.chainId, "c1");
    assert.equal(loaded.plan[0].status, "green");
    assert.deepEqual(loaded.completedReqIds, ["r0"]);
    assert.deepEqual(loaded.accumulatedFrozenTests, ["t1"]);
  });

  it("returns null for non-existent state", () => {
    assert.equal(loadTddState(tmpDir), null);
  });

  it("uses atomic write (no partial files on crash)", () => {
    const plan = [
      { id: "s0", index: 0, reqIds: ["r0"], title: "A", brief: "b", status: "pending", frozenTests: [], retryCount: 0, retryReason: null, lastError: null },
    ];
    const state = createTddChainState({ chainId: "c1", requirementsFile: "r.md", plan });
    persistTddState(tmpDir, state);

    // After write, no .tmp file should exist
    assert.equal(fs.existsSync(path.join(tmpDir, "tdd-chain.json.tmp")), false);
    assert.equal(fs.existsSync(path.join(tmpDir, "tdd-chain.json")), true);
  });
});


// ---------------------------------------------------------------------------
// Coverage analysis
// ---------------------------------------------------------------------------

describe("computeCoverage", () => {
  it("computes covered and uncovered requirements", () => {
    const plan = [
      { id: "s0", index: 0, reqIds: ["r0", "r1"], title: "A", brief: "", status: "green", frozenTests: [], retryCount: 0, retryReason: null, lastError: null },
      { id: "s1", index: 1, reqIds: ["r2"], title: "B", brief: "", status: "pending", frozenTests: [], retryCount: 0, retryReason: null, lastError: null },
    ];
    const state = createTddChainState({ chainId: "c1", requirementsFile: "r.md", plan });
    state.completedReqIds = ["r0", "r1"];
    state.accumulatedFrozenTests = ["t1", "t2"];

    const coverage = computeCoverage(state);
    assert.deepEqual(coverage.covered, ["r0", "r1"]);
    assert.deepEqual(coverage.uncovered, ["r2"]);
    assert.equal(coverage.frozenTestCount, 2);
  });

  it("handles fully covered plan", () => {
    const plan = [
      { id: "s0", index: 0, reqIds: ["r0"], title: "A", brief: "", status: "green", frozenTests: [], retryCount: 0, retryReason: null, lastError: null },
    ];
    const state = createTddChainState({ chainId: "c1", requirementsFile: "r.md", plan });
    state.completedReqIds = ["r0"];

    const coverage = computeCoverage(state);
    assert.equal(coverage.uncovered.length, 0);
  });
});


// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("renderTddChainStatus", () => {
  it("renders strategy and progress", () => {
    const plan = [
      { id: "s0", index: 0, reqIds: ["r0"], title: "Auth", brief: "", status: "green", frozenTests: ["t1"], retryCount: 0, retryReason: null, lastError: null },
      { id: "s1", index: 1, reqIds: ["r1"], title: "Export", brief: "", status: "pending", frozenTests: [], retryCount: 0, retryReason: null, lastError: null },
    ];
    const state = createTddChainState({ chainId: "c1", requirementsFile: "r.md", plan });
    state.completedReqIds = ["r0"];
    state.accumulatedFrozenTests = ["t1"];

    const lines = renderTddChainStatus(state);
    assert.ok(lines.some((l) => l.includes("strategy: incremental-tdd")));
    assert.ok(lines.some((l) => l.includes("1/2 slices completed")));
  });

  it("shows retry info when present", () => {
    const plan = [
      { id: "s0", index: 0, reqIds: ["r0"], title: "A", brief: "", status: "pending", frozenTests: [], retryCount: 2, retryReason: "implement failed", lastError: "implement failed" },
    ];
    const state = createTddChainState({ chainId: "c1", requirementsFile: "r.md", plan });
    state.retryInfo = { attempts: 2, reason: "implement failed", exhausted: false };

    const lines = renderTddChainStatus(state);
    assert.ok(lines.some((l) => l.includes("retry: attempt 2")));
  });

  it("shows failure reason when present", () => {
    const plan = [
      { id: "s0", index: 0, reqIds: ["r0"], title: "A", brief: "", status: "failed", frozenTests: [], retryCount: 3, retryReason: "error", lastError: "error" },
    ];
    const state = createTddChainState({ chainId: "c1", requirementsFile: "r.md", plan });
    state.status = "failed";
    state.failureReason = "exhausted";

    const lines = renderTddChainStatus(state);
    assert.ok(lines.some((l) => l.includes("failure reason:")));
  });
});


describe("renderCoverageReport", () => {
  it("renders a coverage report with per-slice detail", () => {
    const plan = [
      { id: "s0", index: 0, reqIds: ["r0"], title: "Auth", brief: "", status: "green", frozenTests: ["test-auth.mjs"], retryCount: 0, retryReason: null, lastError: null },
    ];
    const state = createTddChainState({ chainId: "c1", requirementsFile: "r.md", plan });
    state.completedReqIds = ["r0"];
    state.accumulatedFrozenTests = ["test-auth.mjs"];

    const report = renderCoverageReport(state);
    assert.match(report, /## Requirement-to-Test Coverage/);
    assert.match(report, /Auth/);
    assert.match(report, /test-auth\.mjs/);
  });
});


// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validateTddState", () => {
  it("rejects null state", () => {
    const result = validateTddState(null);
    assert.equal(result.ok, false);
  });

  it("rejects non-incremental-tdd strategy", () => {
    const state = { strategy: "other", plan: [{}], status: "running" };
    const result = validateTddState(state);
    assert.equal(result.ok, false);
    assert.match(result.error, /unexpected strategy/);
  });

  it("rejects empty plan", () => {
    const state = { strategy: "incremental-tdd", plan: [], status: "running" };
    const result = validateTddState(state);
    assert.equal(result.ok, false);
    assert.match(result.error, /plan is empty/);
  });

  it("rejects already completed chain", () => {
    const state = { strategy: "incremental-tdd", plan: [{}], status: "completed" };
    const result = validateTddState(state);
    assert.equal(result.ok, false);
    assert.match(result.error, /already completed/);
  });

  it("rejects failed chain with exhausted retries", () => {
    const state = {
      strategy: "incremental-tdd",
      plan: [{}],
      status: "failed",
      retryInfo: { exhausted: true },
    };
    const result = validateTddState(state);
    assert.equal(result.ok, false);
    assert.match(result.error, /retries exhausted/);
  });

  it("accepts valid running state", () => {
    const state = {
      strategy: "incremental-tdd",
      plan: [{ id: "s0" }],
      status: "running",
    };
    const result = validateTddState(state);
    assert.equal(result.ok, true);
  });
});


describe("validatePlan", () => {
  it("rejects non-array plan", () => {
    assert.equal(validatePlan(null).ok, false);
    assert.equal(validatePlan("string").ok, false);
  });

  it("rejects empty plan", () => {
    assert.equal(validatePlan([]).ok, false);
  });

  it("rejects duplicate slice IDs", () => {
    const plan = [
      { id: "s0", reqIds: ["r0"] },
      { id: "s0", reqIds: ["r1"] },
    ];
    assert.equal(validatePlan(plan).ok, false);
  });

  it("rejects slice with no reqIds", () => {
    const plan = [{ id: "s0", reqIds: [] }];
    assert.equal(validatePlan(plan).ok, false);
  });

  it("accepts valid plan", () => {
    const plan = [
      { id: "s0", reqIds: ["r0"] },
      { id: "s1", reqIds: ["r1"] },
    ];
    assert.equal(validatePlan(plan).ok, true);
  });
});


// ---------------------------------------------------------------------------
// generateTestAuthorBrief
// ---------------------------------------------------------------------------

describe("generateTestAuthorBrief", () => {
  const sampleSlice = {
    id: "slice-0",
    index: 0,
    reqIds: ["req-abc"],
    title: "User Login",
    brief: "Implement requirement: User Login\n\nRequirement ID: req-abc\n\n## Acceptance Criteria\n\n- Users can log in with email\n- Passwords are validated",
    status: "pending",
    frozenTests: [],
    retryCount: 0,
    retryReason: null,
    lastError: null,
  };

  it("generates a brief for writing failing tests", () => {
    const brief = generateTestAuthorBrief(sampleSlice);
    assert.match(brief, /Write failing tests for requirement: User Login/);
    assert.match(brief, /Slice: slice-0/);
    assert.match(brief, /Requirement IDs: req-abc/);
    assert.match(brief, /FAIL/);
  });

  it("includes acceptance criteria from the slice brief", () => {
    const brief = generateTestAuthorBrief(sampleSlice);
    assert.match(brief, /Users can log in with email/);
  });

  it("includes accumulated frozen tests when present", () => {
    const brief = generateTestAuthorBrief(sampleSlice, ["tests/auth.test.mjs"]);
    assert.match(brief, /Existing Frozen Tests/);
    assert.match(brief, /tests\/auth\.test\.mjs/);
  });

  it("omits frozen tests section when empty", () => {
    const brief = generateTestAuthorBrief(sampleSlice, []);
    assert.doesNotMatch(brief, /Existing Frozen Tests/);
  });
});


// ---------------------------------------------------------------------------
// generateImplementBrief
// ---------------------------------------------------------------------------

describe("generateImplementBrief", () => {
  const sampleSlice = {
    id: "slice-0",
    index: 0,
    reqIds: ["req-abc"],
    title: "User Login",
    brief: "Implement requirement: User Login\n\nRequirement ID: req-abc\n\n## Acceptance Criteria\n\n- Users can log in with email",
    status: "frozen",
    frozenTests: ["tests/login.test.mjs"],
    retryCount: 0,
    retryReason: null,
    lastError: null,
  };

  it("generates a brief for implementing the requirement", () => {
    const brief = generateImplementBrief(sampleSlice);
    assert.match(brief, /Implement requirement: User Login/);
    assert.match(brief, /Slice: slice-0/);
  });

  it("includes frozen tests that must pass", () => {
    const brief = generateImplementBrief(sampleSlice, ["tests/login.test.mjs", "tests/auth.test.mjs"]);
    assert.match(brief, /Frozen Tests.*must all pass/);
    assert.match(brief, /tests\/login\.test\.mjs/);
    assert.match(brief, /tests\/auth\.test\.mjs/);
  });

  it("omits frozen tests section when empty", () => {
    const brief = generateImplementBrief(sampleSlice, []);
    assert.doesNotMatch(brief, /Frozen Tests/);
  });
});


// ---------------------------------------------------------------------------
// isSliceRed / isSliceGreen
// ---------------------------------------------------------------------------

describe("isSliceRed", () => {
  it("returns true for a completed round with worktree changes", () => {
    assert.equal(isSliceRed({ implementJobStatus: "completed", worktreeChanged: true }), true);
  });

  it("returns false for a completed round with no worktree changes", () => {
    assert.equal(isSliceRed({ implementJobStatus: "completed", worktreeChanged: false }), false);
  });

  it("returns false for a failed job", () => {
    assert.equal(isSliceRed({ implementJobStatus: "error", worktreeChanged: true }), false);
  });

  it("returns false for null", () => {
    assert.equal(isSliceRed(null), false);
  });
});

describe("isSliceGreen", () => {
  it("returns true for completed + probesGreen + worktreeChanged", () => {
    assert.equal(isSliceGreen({
      implementJobStatus: "completed",
      probesGreen: true,
      worktreeChanged: true,
    }), true);
  });

  it("returns false when probes are not green", () => {
    assert.equal(isSliceGreen({
      implementJobStatus: "completed",
      probesGreen: false,
      worktreeChanged: true,
    }), false);
  });

  it("returns false when worktree not changed", () => {
    assert.equal(isSliceGreen({
      implementJobStatus: "completed",
      probesGreen: true,
      worktreeChanged: false,
    }), false);
  });

  it("returns false for null", () => {
    assert.equal(isSliceGreen(null), false);
  });
});


// ---------------------------------------------------------------------------
// extractTestPaths
// ---------------------------------------------------------------------------

describe("extractTestPaths", () => {
  it("extracts .test.mjs paths from changed paths", () => {
    const record = { chainChangedPaths: ["src/foo.mjs", "tests/foo.test.mjs", "tests/bar.spec.mjs"] };
    assert.deepEqual(extractTestPaths(record), ["tests/foo.test.mjs", "tests/bar.spec.mjs"]);
  });

  it("returns empty array when no test paths found", () => {
    const record = { chainChangedPaths: ["src/foo.mjs", "README.md"] };
    assert.deepEqual(extractTestPaths(record), []);
  });

  it("returns empty array for null record", () => {
    assert.deepEqual(extractTestPaths(null), []);
  });

  it("returns empty array when chainChangedPaths is absent", () => {
    assert.deepEqual(extractTestPaths({}), []);
  });
});


// ---------------------------------------------------------------------------
// validateTddState — tightened retry transition
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Integration: TDD executor slice ordering + frozen test accumulation
// ---------------------------------------------------------------------------

describe("TDD executor integration (slice ordering + frozen accumulation)", () => {
  it("proves slice 2 cannot start before slice 1 is green and frozen tests accumulate", () => {
    // Build a 2-slice plan
    const plan = [
      {
        id: "slice-0", index: 0, reqIds: ["req-auth"], title: "Auth",
        brief: "Implement requirement: Auth\n\nRequirement ID: req-auth\n\n## Acceptance Criteria\n\n- Login works",
        status: "pending", frozenTests: [], retryCount: 0, retryReason: null, lastError: null,
      },
      {
        id: "slice-1", index: 1, reqIds: ["req-export"], title: "Export",
        brief: "Implement requirement: Export\n\nRequirement ID: req-export\n\n## Acceptance Criteria\n\n- Export works",
        status: "pending", frozenTests: [], retryCount: 0, retryReason: null, lastError: null,
      },
    ];

    const state = createTddChainState({
      chainId: "test-chain", requirementsFile: "reqs.md", plan,
    });

    // --- Simulate slice 0 lifecycle ---

    // Start slice 0: mark red
    assert.equal(state.currentSliceIndex, 0);
    markRed(state);
    assert.equal(state.plan[0].status, "red");

    // Freeze tests for slice 0
    freezeTests(state, ["tests/auth.test.mjs"]);
    assert.equal(state.plan[0].status, "frozen");
    assert.deepEqual(state.plan[0].frozenTests, ["tests/auth.test.mjs"]);

    // Advance slice 0 (green)
    const nextSlice = advanceSlice(state);
    assert.equal(state.plan[0].status, "green");
    assert.deepEqual(state.completedReqIds, ["req-auth"]);
    assert.deepEqual(state.accumulatedFrozenTests, ["tests/auth.test.mjs"]);
    assert.equal(state.currentSliceIndex, 1);
    assert.ok(nextSlice);
    assert.equal(nextSlice.id, "slice-1");

    // --- Slice 1 must not have started yet ---
    assert.equal(state.plan[1].status, "pending");
    assert.deepEqual(state.plan[1].frozenTests, []);

    // --- Simulate slice 1 lifecycle with accumulated frozen tests ---

    // Generate briefs: slice 1 brief should include accumulated frozen tests
    const testAuthorBrief = generateTestAuthorBrief(state.plan[1], state.accumulatedFrozenTests);
    assert.match(testAuthorBrief, /Write failing tests for requirement: Export/);
    assert.match(testAuthorBrief, /tests\/auth\.test\.mjs/);

    // Mark slice 1 red
    markRed(state);
    assert.equal(state.plan[1].status, "red");

    // Freeze tests for slice 1
    freezeTests(state, ["tests/export.test.mjs"]);
    assert.equal(state.plan[1].status, "frozen");

    // Implement brief should include ALL frozen tests (both slices)
    const implementBrief = generateImplementBrief(state.plan[1], state.accumulatedFrozenTests);
    assert.match(implementBrief, /Frozen Tests.*must all pass/);
    assert.match(implementBrief, /tests\/auth\.test\.mjs/);

    // Advance slice 1
    const done = advanceSlice(state);
    assert.equal(done, null); // no more slices
    assert.equal(state.status, "completed");
    assert.deepEqual(state.accumulatedFrozenTests, ["tests/auth.test.mjs", "tests/export.test.mjs"]);
    assert.deepEqual(state.completedReqIds, ["req-auth", "req-export"]);
  });

  it("verifies that a failed slice blocks progression", () => {
    const plan = [
      {
        id: "slice-0", index: 0, reqIds: ["r0"], title: "A",
        brief: "Implement requirement: A\n\n## Acceptance Criteria\n\n- item",
        status: "pending", frozenTests: [], retryCount: 0, retryReason: null, lastError: null,
      },
      {
        id: "slice-1", index: 1, reqIds: ["r1"], title: "B",
        brief: "Implement requirement: B\n\n## Acceptance Criteria\n\n- item",
        status: "pending", frozenTests: [], retryCount: 0, retryReason: null, lastError: null,
      },
    ];
    const state = createTddChainState({
      chainId: "c1", requirementsFile: "r.md", plan,
    });

    // Fail slice 0 (not exhausted)
    const result = markSliceFailed(state, "implement error");
    assert.equal(result.retriable, true);
    assert.equal(state.currentSliceIndex, 0); // still on slice 0
    assert.equal(state.plan[0].status, "pending"); // reset for retry
    assert.equal(state.plan[1].status, "pending"); // slice 1 untouched

    // Exhaust retries on slice 0
    markSliceFailed(state, "error 1");
    markSliceFailed(state, "error 2");
    const exhausted = markSliceFailed(state, "error 3");
    assert.equal(exhausted.exhausted, true);
    assert.equal(state.status, "failed");
    assert.equal(state.plan[1].status, "pending"); // slice 1 never started
  });
});


describe("validateTddState (retry transition tightening)", () => {
  it("accepts a valid running state", () => {
    const state = {
      strategy: "incremental-tdd",
      plan: [{ id: "s0" }],
      status: "running",
      currentSliceIndex: 0,
      retryInfo: { exhausted: false },
    };
    assert.equal(validateTddState(state).ok, true);
  });

  it("rejects a failed-but-retryable state without retryTransition", () => {
    const state = {
      strategy: "incremental-tdd",
      plan: [{ id: "s0", status: "failed", retryCount: 1 }],
      status: "running",
      currentSliceIndex: 0,
      retryInfo: { exhausted: false },
    };
    const result = validateTddState(state);
    assert.equal(result.ok, false);
    assert.match(result.error, /use retry transition/);
  });

  it("accepts a failed-but-retryable state with retryTransition", () => {
    const state = {
      strategy: "incremental-tdd",
      plan: [{ id: "s0", status: "failed", retryCount: 1 }],
      status: "running",
      currentSliceIndex: 0,
      retryInfo: { exhausted: false },
    };
    const result = validateTddState(state, { retryTransition: true });
    assert.equal(result.ok, true);
  });

  it("does not require retryTransition for pending slices", () => {
    const state = {
      strategy: "incremental-tdd",
      plan: [{ id: "s0", status: "pending", retryCount: 0 }],
      status: "running",
      currentSliceIndex: 0,
      retryInfo: { exhausted: false },
    };
    assert.equal(validateTddState(state).ok, true);
  });
});
