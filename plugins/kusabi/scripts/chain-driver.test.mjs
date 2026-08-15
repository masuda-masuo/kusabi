import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { dispatchWithFallback } from "./prompt-execution.mjs";
import { claudeDispatch } from "./claude-dispatch.mjs";
import {
  publishWarningForBrief,
  runChainDriver,
  effectiveTierCount,
  renderChainBanner,
  resolveReviewDispatch,
  resolveResumeDispatches,
  resolveResumeReviewContext,
  resolveResumeReworkContext,
} from "./chain-driver.mjs";
import {
  readChainControl,
  writeChainControl,
  rearmChainControl,
} from "./chain-control.mjs";
import {
  resolveChainResume,
  computeChainTotals,
} from "./chain-phases.mjs";
import { readJson, writeJson } from "./state-paths.mjs";

// publishWarningForBrief — chain-start publish guard (kusabi #153)
// ---------------------------------------------------------------------------
// publish is orchestrator-exclusive; a brief that demands it cannot be
// executed by the worker.  The chain prints this warning verbatim at start.
// The exact text is fixed here so the runtime output cannot drift.

describe("publishWarningForBrief", () => {
  it("returns the warning for a brief that demands publish", () => {
    const warning = publishWarningForBrief("## PUBLISH (mandatory)\n\nDo the work.");
    assert.ok(warning, "warning must be non-null");
    assert.match(warning, /publish を要求している/);
    assert.match(warning, /ワーカーは publish できない/);
    assert.match(warning, /オーケストレーター専権/);
  });

  it("returns the warning for inline 'PUBLISH must ...' style demands", () => {
    const warning = publishWarningForBrief("Fix the bug. PUBLISH must happen after the gate.");
    assert.ok(warning);
    assert.match(warning, /オーケストレーター専権/);
  });

  it("returns null when the brief does not demand publish", () => {
    assert.equal(publishWarningForBrief("Implement the feature and verify."), null);
    assert.equal(publishWarningForBrief("publish is orchestrator-exclusive; workers cannot call it."), null);
    assert.equal(publishWarningForBrief(""), null);
  });

  it("is exactly one line (no embedded newlines)", () => {
    const warning = publishWarningForBrief("## PUBLISH (mandatory)");
    assert.equal(warning.split("\n").length, 1);
  });
});

// =========================================================================
// runChainDriver — resume paths (kusabi #153①)
// -------------------------------------------------------------------------
// Drives the shared chain loop with fake callTool / dispatch, exactly as
// cmdChainResume wires it: resolveChainResume → rearmChainControl →
// runChainDriver(resume: position).
// =========================================================================

describe("runChainDriver resume", () => {
  const BRIEF = "Implement X.\n\n## Deliverables\n- src/foo.js\n";

  function fakeResumeCallTool({ statusOutput = " M src/foo.js\n", headSha = "abc123" } = {}) {
    return async (toolName, params) => {
      if (toolName === "verify_in_container") {
        return { gate_passed: true };
      }
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands[0];
      // captureWorktreeState: capture failure → baseline null (graceful)
      if (cmd.startsWith("cd /workspace &&") && cmd.includes("TMPIDX=")) {
        return { output: "ERROR_NO_INDEX\n" };
      }
      if (cmd === "git rev-parse HEAD") return { output: headSha + "\n" };
      if (cmd === "git status --porcelain") return { output: statusOutput };
      if (cmd === "git log --oneline -5") return { output: "abc123 latest change\n" };
      if (cmd === "git diff") return { output: "diff --git a/src/foo.js b/src/foo.js\n" };
      if (cmd === "git ls-files --others --exclude-standard") return { output: "untracked.txt\n" };
      return { output: "" };
    };
  }

  function makeFakeDispatch({
    reviewResult = JSON.stringify({ verdict: "approve", findings: [], summary: "ok" }),
    implementStatus = "completed",
    implementFailure = null,
  } = {}) {
    const dispatch = async (opts) => {
      if (opts.kind === "review") {
        return {
          job: {
            id: "job-rev-1", status: "completed", modelEntry: "fake/review", modelVariant: null,
            fallbacks: null, sessionID: "sess-rev",
            usage: { available: true, input: 2, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            error: null,
          },
          resultText: reviewResult,
        };
      }
      if (opts.kind === "task") {
        return {
          job: {
            id: "job-imp-" + (opts.round ?? 1), status: implementStatus,
            modelEntry: "fake/model", modelVariant: null, fallbacks: null,
            sessionID: "sess-imp-" + (opts.round ?? 1),
            usage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            error: implementStatus === "provider-error"
              ? (implementFailure
                  // The classified error the claude dispatch actually writes
                  // (renderClaudeQuotaError); the chain surface must show it.
                  ? "claude dispatch failed: You've hit your session limit · resets 1:20am (Asia/Tokyo) — " +
                    "session limit exhausted (resets 1:20am (Asia/Tokyo)): the whole claude backend is " +
                    "blocked, including your own Claude Code session (same account window). Switch the " +
                    "phase to the opencode backend (--model <provider>/<model>); do not retry claude."
                  : "All routes exhausted: fake/model — retry at attempt 3")
              : null,
            failure: implementFailure,
          },
          resultText: "implemented",
        };
      }
      if (opts.kind === "strategist") {
        return {
          job: {
            id: "job-strat-1", status: "completed", modelEntry: "fake/strat", modelVariant: null,
            fallbacks: null, sessionID: "sess-strat",
            usage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            error: null,
          },
          resultText: "restructure the module",
        };
      }
      throw new Error("unexpected dispatch kind: " + opts.kind);
    };
    dispatch.calls = [];
    const wrapped = async (opts) => {
      dispatch.calls.push(opts);
      return dispatch(opts);
    };
    wrapped.calls = dispatch.calls;
    return wrapped;
  }

  function makeChainState({ records, controlOverrides = {}, chainId = "chain-test" } = {}) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-resume-"));
    const chainDir = path.join(tmp, "chains", chainId);
    fs.mkdirSync(chainDir, { recursive: true });
    writeJson(path.join(chainDir, "chain.json"), {
      chainId, container: "cid-1", model: "fake/model",
      modelChain: [["fake/model"], ["fake/pro"]], maxRounds: 4,
      brief: BRIEF, orchestrator: null, records,
      baseSha: "abc123",
      chainTotals: computeChainTotals(records),
      strategized: false, followupIssueDraft: null,
    });
    writeChainControl(chainDir, {
      chainId, container: "cid-1", pid: 0,
      status: "cancelled", round: 3,
      stopRequestedAt: "2026-08-01T00:00:00.000Z", stopRequestedBy: "cli",
      finishedAt: "2026-08-01T00:00:00.000Z",
      ...controlOverrides,
    });
    return { tmp, chainDir };
  }

  // Mirrors cmdChainResume: resolve the position, re-arm the control, run.
  async function resumeChain({ chainDir, dispatch, statusOutput, callTool }) {
    const resolution = resolveChainResume({
      control: readChainControl(chainDir),
      chainJson: readJson(path.join(chainDir, "chain.json")),
    });
    assert.equal(resolution.ok, true);
    rearmChainControl({
      chainDir,
      round: resolution.position.phase === "review" ? resolution.position.round : resolution.position.round - 1,
    });
    const tmp = path.dirname(path.dirname(chainDir));
    const chainJson = readJson(path.join(chainDir, "chain.json"));
    return runChainDriver({
      cwd: tmp, stateDir: path.dirname(path.dirname(chainDir)), chainDir,
      chainId: "chain-test", container: "cid-1",
      model: "fake/model", modelChain: [["fake/model"], ["fake/pro"]], maxRounds: 4,
      brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      // Mirror cmdChainResume: reuse the verify baseline recorded in
      // chain.json; never re-capture on the modified worktree (kusabi #173).
      verifyBaseline: chainJson.verifyBaseline ?? null,
      callTool: callTool ?? fakeResumeCallTool({ statusOutput }),
      dispatchWithFallback: dispatch,
      keepServe: true,
      signalReceived: () => false,
      resume: resolution.position,
    });
  }

  it("resumes an interrupted round at review and completes it (implement done, review not run)", async () => {
    const partial = {
      round: 3,
      resumeMethod: { type: "continue_session" },
      startedAt: "2026-08-01T00:00:00.000Z",
      verdict: null,
      probesGreen: true,
      modelEntry: "fake/model",
      modelVariant: null,
      fallbacks: null,
      implementJobId: "job-imp-3",
      sessionID: "sess-3",
      implementUsage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
      tierBefore: 0,
      reworkStrategyReason: null,
      reworkCount: 2,
      probeResults: [{ probe: "P1: HEAD clean", passed: true, detail: "ok" }],
      worktreeChanged: true,
      interrupted: true,
      interruptedAfter: "probes",
    };
    const { chainDir } = makeChainState({ records: [partial] });
    const dispatch = makeFakeDispatch(); // review approves

    const text = await resumeChain({ chainDir, dispatch });

    assert.match(text, /accepted at round 3/);
    // The resumed review actually dispatched (kind review, round 3)
    assert.ok(dispatch.calls.some((c) => c.kind === "review"), "review must be dispatched");

    // Terminal disposition => the postable review record exists and its path
    // is printed in the terminal output (kusabi #52).  The resumed path goes
    // through the same finalisation point as a fresh chain.
    const recordPath = path.join(chainDir, "review-record.md");
    assert.ok(fs.existsSync(recordPath), "review-record.md must exist after a terminal disposition");
    assert.match(text, /review record: .*review-record\.md/);
    const recordText = fs.readFileSync(recordPath, "utf8");
    assert.match(recordText, /# \[review-record\] .* chain-test — Implement X\./);
    assert.match(recordText, /Final disposition: accepted at round 3 of 4/);
    assert.match(recordText, /## Findings adjudication \(fill at inspection\)/);
    assert.match(recordText, /## 判例として \(fill at inspection\)/);

    const control = readChainControl(chainDir);
    assert.equal(control.status, "completed");
    assert.equal(control.round, 3);

    const round3 = readJson(path.join(chainDir, "round-3.json"));
    assert.equal(round3.reviewJobId, "job-rev-1");
    assert.equal(round3.verdict, "approve");
    assert.equal(round3.disposition.disposition, "accept");
    assert.equal(round3.resumed, true);
    // A completed round is no longer "interrupted" — that flag means "still
    // partial" (#153① review).  The history moves to wasInterrupted.
    assert.equal(round3.interrupted, undefined);
    assert.equal(round3.interruptedAfter, undefined);
    assert.equal(round3.wasInterrupted, true);

    const chainJson = readJson(path.join(chainDir, "chain.json"));
    assert.equal(chainJson.records.length, 1); // no duplicate push
  });

  it("carries tier/reworkCount into the next round after a resumed review that reworks", async () => {
    const partial = {
      round: 3,
      resumeMethod: { type: "continue_session" },
      startedAt: "2026-08-01T00:00:00.000Z",
      verdict: null,
      probesGreen: true,
      modelEntry: "fake/model",
      modelVariant: null,
      fallbacks: null,
      implementJobId: "job-imp-3",
      sessionID: "sess-3",
      implementUsage: null,
      tierBefore: 0,
      reworkStrategyReason: null,
      reworkCount: 1,
      probeResults: [],
      worktreeChanged: true,
      interrupted: true,
      interruptedAfter: "probes",
    };
    const { chainDir } = makeChainState({ records: [partial] });
    // Review finds problems → rework; the next round's implement hits provider
    // exhaustion so the test can observe the carried tier/reworkCount.
    const dispatch = makeFakeDispatch({
      reviewResult: JSON.stringify({ verdict: "needs-attention", findings: [] }),
      implementStatus: "provider-error",
    });

    const text = await resumeChain({ chainDir, dispatch });

    assert.match(text, /implement provider exhausted/);

    // Cross-round context derived at resume (position) — the ladder continues
    const round3 = readJson(path.join(chainDir, "round-3.json"));
    assert.equal(round3.disposition.disposition, "rework");
    assert.equal(round3.tierAfter, 1); // 0 + 1 (2nd rework escalates), 2-tier chain, not clamped

    const round4 = readJson(path.join(chainDir, "round-4.json"));
    assert.equal(round4.tierBefore, 1);   // carried currentTierIndex
    assert.equal(round4.reworkCount, 2);  // 1 + the consumed rework
    // round 4 is a NEW round after the resumed one — only the resumed round
    // itself carries the resumed trace
    assert.equal(round4.resumed, undefined);

    const control = readChainControl(chainDir);
    assert.equal(control.status, "failed");
    assert.equal(control.round, 4);
  });

  it("resumes a rework chain at the next round's implement, keeping prior-findings context", async () => {
    const complete = {
      round: 2,
      resumeMethod: { type: "fresh_session" },
      startedAt: "2026-08-01T00:00:00.000Z",
      verdict: "needs-attention",
      probesGreen: false,
      modelEntry: "fake/model",
      modelVariant: null,
      fallbacks: null,
      implementJobId: "job-imp-2",
      reviewJobId: "job-rev-2",
      sessionID: "sess-2",
      implementUsage: null,
      reviewUsage: null,
      tierBefore: 0,
      tierAfter: 1,
      reworkCount: 1,
      pendingReworkStrategy: { tierDelta: 1, newSession: true, reason: "2nd rework: escalate tier, new session, keep artifacts" },
      disposition: { disposition: "rework", reason: "needs-attention" },
      findingsText: "fix the parser",
    };
    const { chainDir } = makeChainState({ records: [complete], controlOverrides: { round: 2 } });
    const dispatch = makeFakeDispatch({ implementStatus: "provider-error" });

    const text = await resumeChain({ chainDir, dispatch });

    assert.match(text, /implement provider exhausted/);

    // The resumed round's implement ran with the previous round's findings
    const impCall = dispatch.calls.find((c) => c.kind === "task");
    assert.ok(impCall, "implement must be dispatched");
    assert.equal(impCall.round, 3);
    assert.match(impCall.promptText, /Prior findings/);
    assert.match(impCall.promptText, /fix the parser/);

    const round3 = readJson(path.join(chainDir, "round-3.json"));
    assert.equal(round3.tierBefore, 1);   // carried from round 2 tierAfter
    assert.equal(round3.reworkCount, 2);  // 1 + the consumed rework
    assert.equal(round3.resumed, true);

    const control = readChainControl(chainDir);
    assert.equal(control.status, "failed");
    assert.equal(control.round, 3);
  });

  it("dies a quota-classified implement failure with the classification, not the generic retry advice (kusabi #215)", async () => {
    // The implement dispatch returns the REAL 2026-08-11 session-limit
    // classification (status provider-error + structured `failure`), as the
    // claude backend now produces.  The failed-round surface — what the
    // operator sees when the round dies — must show the classification
    // instead of the generic error text, and must NOT contradict it with
    // "Retry when provider is available".
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-quota-chain-"));
    const chainDir = path.join(tmp, "chains", "chain-test");
    fs.mkdirSync(chainDir, { recursive: true });
    writeChainControl(chainDir, {
      chainId: "chain-test", container: "cid-1", pid: process.pid,
      status: "running", round: 0, startedAt: new Date().toISOString(),
    });

    const dispatch = makeFakeDispatch({
      implementStatus: "provider-error",
      implementFailure: {
        kind: "quota-exhaustion",
        quota: "session",
        backendBlocked: true,
        reset: "1:20am (Asia/Tokyo)",
      },
    });

    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
      model: "fake/model", modelChain: [["fake/model"], ["fake/pro"]], maxRounds: 4,
      brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      callTool: fakeResumeCallTool(),
      dispatchWithFallback: dispatch,
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });

    // The chain stops at implement provider exhaustion and the surface
    // carries the classified message.
    assert.match(text, /implement provider exhausted/);
    assert.match(text, /whole claude backend is blocked/);
    assert.match(text, /Switch the phase to the opencode backend/);
    assert.match(text, /do not retry claude/);
    assert.ok(!text.includes("Retry when provider is available"),
      "the generic capacity footer must not contradict a session-limit classification");

    const control = readChainControl(chainDir);
    assert.equal(control.status, "failed");

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("persists the interrupted round when stopped after probes (stop-accept path)", async () => {
    // Fresh chain (resume: null).  The implement dispatch writes a stop
    // request into control.json as a side effect; the driver's after-probes
    // stop check must persist the partial round and finalise round N.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-resume-stop-"));
    const chainDir = path.join(tmp, "chains", "chain-test");
    fs.mkdirSync(chainDir, { recursive: true });
    writeChainControl(chainDir, {
      chainId: "chain-test", container: "cid-1", pid: process.pid,
      status: "running", round: 0, startedAt: new Date().toISOString(),
    });

    const dispatch = makeFakeDispatch();
    const dispatchWithStop = async (opts) => {
      const result = await dispatch(opts);
      if (opts.kind === "task") {
        // The stop arrives while the round is in flight — exactly what
        // chain-cancel does via requestChainStop.
        writeChainControl(chainDir, {
          ...readChainControl(chainDir),
          stopRequestedAt: new Date().toISOString(),
          stopRequestedBy: "test",
        });
      }
      return result;
    };

    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
      model: "fake/model", modelChain: [["fake/model"], ["fake/pro"]], maxRounds: 4,
      brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      callTool: fakeResumeCallTool(),
      dispatchWithFallback: dispatchWithStop,
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });

    assert.match(text, /cancelled during round 1/);
    assert.match(text, /Progress preserved/);
    assert.match(text, /chain-resume chain-test/);

    const control = readChainControl(chainDir);
    assert.equal(control.status, "cancelled");
    assert.equal(control.round, 1); // control round matches actual progress

    const round1 = readJson(path.join(chainDir, "round-1.json"));
    assert.equal(round1.implementJobId, "job-imp-1");
    assert.equal(round1.interrupted, true);
    assert.equal(round1.interruptedAfter, "probes");
    assert.ok(round1.probeResults.length > 0);
    assert.equal(round1.reviewJobId, undefined); // no review was bought

    const chainJson = readJson(path.join(chainDir, "chain.json"));
    assert.equal(chainJson.records.length, 1);
    assert.equal(chainJson.records[0].interrupted, true);

    // A cancelled chain produces no review record (kusabi #52) — the record
    // exists only when a terminal disposition is reached.
    assert.equal(fs.existsSync(path.join(chainDir, "review-record.md")), false);
    assert.doesNotMatch(text, /review record:/);

    // The persisted partial record is resumable
    const resolution = resolveChainResume({
      control: readChainControl(chainDir),
      chainJson: readJson(path.join(chainDir, "chain.json")),
    });
    assert.equal(resolution.ok, true);
    assert.equal(resolution.position.phase, "review");
    assert.equal(resolution.position.round, 1);
  });

  it("reuses the chain-start verify baseline on resume and never re-captures on the modified worktree (kusabi #173)", async () => {
    // Round 1 reworked (probes red on a dirty base).  chain.json carries the
    // baseline recorded at chain start: lint 190, types 0.  The resumed round
    // 2 keeps the same 190 lint violations (worker added none) and green tests
    // after the tolerated re-run → P2 must PASS because the RESUME path reused
    // the recorded baseline.  If resume re-captured the baseline from the
    // modified worktree, captureVerifyBaseline would fire an extra
    // verify_in_container call before round 2's probes — the call log below
    // asserts that never happens.
    const complete = {
      round: 1,
      resumeMethod: { type: "fresh_session" },
      startedAt: "2026-08-01T00:00:00.000Z",
      verdict: "needs-attention",
      probesGreen: false,
      modelEntry: "fake/model",
      modelVariant: null,
      fallbacks: null,
      implementJobId: "job-imp-1",
      reviewJobId: "job-rev-1",
      sessionID: "sess-1",
      implementUsage: null,
      reviewUsage: null,
      tierBefore: 0,
      tierAfter: 1,
      reworkCount: 1,
      pendingReworkStrategy: { tierDelta: 1, newSession: true, reason: "2nd rework: escalate tier" },
      disposition: { disposition: "rework", reason: "needs-attention" },
      findingsText: "fix it",
    };
    const verifyBaseline = {
      captured: true,
      gate_passed: false,
      lint: 190,
      types: 0,
      raw: { gate_passed: false },
    };

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-resume-baseline-"));
    const chainDir = path.join(tmp, "chains", "chain-test");
    fs.mkdirSync(chainDir, { recursive: true });
    writeJson(path.join(chainDir, "chain.json"), {
      chainId: "chain-test", container: "cid-1", model: "fake/model",
      modelChain: [["fake/model"], ["fake/pro"]], maxRounds: 4,
      brief: BRIEF, orchestrator: null, records: [complete],
      baseSha: "abc123",
      chainTotals: computeChainTotals([complete]),
      strategized: false, followupIssueDraft: null,
      verifyBaseline,
    });
    writeChainControl(chainDir, {
      chainId: "chain-test", container: "cid-1", pid: 0,
      status: "cancelled", round: 1,
      stopRequestedAt: "2026-08-01T00:00:00.000Z", stopRequestedBy: "cli",
      finishedAt: "2026-08-01T00:00:00.000Z",
    });

    // Call log: verify_in_container calls plus the sandbox_exec commands.
    const verifyCalls = [];
    const lint190 = [];
    for (let i = 0; i < 190; i++) {
      lint190.push({ rule: "no-unused-vars", file: "/workspace/src/f" + i + ".py", line: 1, message: "x", severity: "error" });
    }
    const callTool = async (toolName, params) => {
      if (toolName === "verify_in_container") {
        verifyCalls.push(params);
        if (verifyCalls.length === 1) {
          // Round 2's P2: same 190 lint violations as the base, tests skipped.
          return {
            gate_passed: false,
            lint: lint190,
            types: [],
            tests: { status: "skipped", message: "precondition gate failed; tests not run" },
            gate_fail_reasons: ["lint (eslint): 190 violation(s)"],
          };
        }
        // Tolerated re-run (skip_lint_gate): tests green.
        return { gate_passed: true, lint: [], types: [], tests: { full: { status: "ok", passed: 1, total: 1 } } };
      }
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands[0];
      if (cmd.startsWith("cd /workspace &&") && cmd.includes("TMPIDX=")) {
        return { output: "ERROR_NO_INDEX\n" };
      }
      if (cmd === "git rev-parse HEAD") return { output: "abc123\n" };
      if (cmd === "git status --porcelain") return { output: " M src/foo.js\n" };
      if (cmd === "git log --oneline -5") return { output: "abc123 latest change\n" };
      if (cmd === "git diff") return { output: "diff --git a/src/foo.js b/src/foo.js\n" };
      if (cmd === "git ls-files --others --exclude-standard") return { output: "untracked.txt\n" };
      return { output: "" };
    };

    const dispatch = makeFakeDispatch(); // review approves
    const text = await resumeChain({ chainDir, dispatch, callTool });

    assert.match(text, /accepted at round 2/);
    // Exactly the round's P2 + tolerated re-run — NO extra baseline capture at
    // resume time.
    assert.equal(verifyCalls.length, 2, "resume must not re-capture the baseline");
    assert.equal(verifyCalls[1].skip_lint_gate, true);

    const round2 = readJson(path.join(chainDir, "round-2.json"));
    const p2 = round2.probeResults.find((p) => p.probe === "P2: verify gate");
    assert.equal(p2.passed, true);
    assert.match(p2.detail, /lint 190 \(baseline 190, tolerated\)/);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // The chain driver records the dispatch backend on the round record and
  // threads the backend-specific dispatch through every phase (kusabi #184).
  // A backend:"claude" chain must dispatch through the injected dispatch
  // (claudeDispatch in production) and persist backend on round-N.json and
  // chain.json records, with modelEntry/modelVariant taken from the job
  // result, not from flags.
  it("records backend claude on the round and persists it in chain state", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-chain-backend-"));
    const chainDir = path.join(tmp, "chains", "chain-test");
    fs.mkdirSync(chainDir, { recursive: true });
    writeChainControl(chainDir, {
      chainId: "chain-test", container: "cid-1", pid: process.pid,
      status: "running", round: 0, startedAt: new Date().toISOString(),
    });

    const dispatch = makeFakeDispatch();
    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
      model: "fake/model", modelChain: [["fake/model"]], maxRounds: 1,
      brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      callTool: fakeResumeCallTool(),
      dispatchWithFallback: dispatch,
      backend: "claude",
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });

    assert.match(text, /accepted at round 1/);
    // The chain actually dispatched through the injected (backend-specific)
    // dispatch — implement + review both fired.
    assert.equal(dispatch.calls.length, 2);
    assert.ok(dispatch.calls.every((c) => c.kind === "task" || c.kind === "review"));

    const round1 = readJson(path.join(chainDir, "round-1.json"));
    assert.equal(round1.backend, "claude");
    assert.equal(round1.modelEntry, "fake/model");
    assert.equal(round1.modelVariant, null);

    const chainJson = readJson(path.join(chainDir, "chain.json"));
    assert.equal(chainJson.records.length, 1);
    assert.equal(chainJson.records[0].backend, "claude");
    assert.equal(chainJson.records[0].modelEntry, "fake/model");

    const control = readChainControl(chainDir);
    assert.equal(control.status, "completed");
    assert.equal(control.round, 1);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ---- replacement review seat: loud refusal on an empty change set
  // (kusabi #248 follow-up) ----
  // A seat-replacement resume whose container no longer holds the round's
  // changes (fresh clone, reset worktree) must refuse loudly instead of
  // flowing into the empty-change-set review skip and dead-ending in a
  // silent discard-escalate.  Fixture mirrors chain-phases.test.mjs's
  // deadSeatRound: round 1 implement complete, probes P1-P4 green, the
  // review seat died mid-stream (`partial`), the chain escalated on that
  // seat failure and finished normally (control status "completed").
  it("refuses a seat-replacement resume whose change set is empty, before any dispatch, leaving the record untouched", async () => {
    const seatDeadRecord = {
      round: 1,
      reworkScope: "full",
      implementJobId: "job-imp-1",
      reviewJobId: "job-rev-1",
      sessionID: "sess-1",
      tierBefore: 0,
      tierAfter: 0,
      reworkCount: 0,
      probesGreen: true,
      probeResults: [
        { probe: "P1: HEAD clean", passed: true, detail: "HEAD matches base abc123" },
        { probe: "P2: verify gate", passed: true, detail: "{}" },
        { probe: "P3: deliverables", passed: true, detail: "touches declared deliverables" },
        { probe: "P4: smoke", passed: true, detail: "all smoke entries exited 0" },
      ],
      worktreeChanged: true,
      verdict: "partial",
      reviewParseable: true,
      reviewPartial: true,
      reviewFindingCount: 3,
      disposition: {
        disposition: "escalate",
        reason: "partial review: stream ended before the verdict line",
      },
    };
    const { chainDir } = makeChainState({
      records: [seatDeadRecord],
      controlOverrides: { status: "completed", round: 1, finishedAt: "2026-08-01T01:00:00.000Z" },
    });
    const dispatch = makeFakeDispatch();
    // An empty worktree: `git status --porcelain` reports nothing, so the
    // collected change set is empty and the review machinery would skip.
    let refusal = null;
    try {
      await resumeChain({ chainDir, dispatch, statusOutput: "" });
    } catch (err) {
      refusal = err;
    }
    assert.ok(refusal, "seat-replacement resume with an empty change set must refuse");
    // The named refusal: the container no longer holds the round's changes,
    // a replacement review has nothing to review, re-run the chain instead.
    assert.match(refusal.message, /cannot resume chain chain-test with a replacement review seat/);
    assert.match(refusal.message, /no longer holds round 1's changes/);
    assert.match(refusal.message, /nothing to review/);
    assert.match(refusal.message, /Re-run the chain instead/);
    // No review dispatch happens -- no job at all was dispatched.
    assert.equal(dispatch.calls.length, 0, "no dispatch may happen on the refusal path");

    // The chain record does not claim a review happened: nothing was
    // persisted (no round-N.json appears) and chain.json still carries the
    // seat-failure escalate -- not a discard-escalate.
    assert.equal(fs.existsSync(path.join(chainDir, "round-1.json")), false, "no round record may be written on the refusal path");
    const chainJson = readJson(path.join(chainDir, "chain.json"));
    assert.equal(chainJson.records.length, 1);
    assert.equal(chainJson.records[0].disposition.disposition, "escalate");
    assert.equal(chainJson.records[0].disposition.reason, "partial review: stream ended before the verdict line");
    assert.equal(chainJson.records[0].reviewSeatFailures, undefined, "the seat is not archived on the refusal path");
    assert.equal(chainJson.records[0].verdict, "partial");
  });

  // The refusal is seat-replacement-only (kusabi #248 follow-up): an
  // INTERRUPTED round (#153) legitimately reviews whatever the worktree
  // holds -- an empty change set there keeps the pre-existing behaviour
  // (probe-sourced discard -> escalate), never the refusal.
  it("does NOT refuse an interrupted round (#153) with an empty change set -- pre-existing discard-escalate stands", async () => {
    const partial = {
      round: 1,
      resumeMethod: { type: "continue_session" },
      startedAt: "2026-08-01T00:00:00.000Z",
      verdict: null,
      probesGreen: true,
      modelEntry: "fake/model",
      modelVariant: null,
      fallbacks: null,
      implementJobId: "job-imp-1",
      sessionID: "sess-1",
      implementUsage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
      tierBefore: 0,
      reworkStrategyReason: null,
      reworkCount: 0,
      probeResults: [{ probe: "P1: HEAD clean", passed: true, detail: "ok" }],
      worktreeChanged: true,
      interrupted: true,
      interruptedAfter: "probes",
    };
    const { chainDir } = makeChainState({ records: [partial] });
    const dispatch = makeFakeDispatch();

    const text = await resumeChain({ chainDir, dispatch, statusOutput: "" });

    assert.match(text, /escalated at round 1: reviewer discarded the work/);
    assert.equal(dispatch.calls.length, 0); // skip path: no review job dispatched
    const round1 = readJson(path.join(chainDir, "round-1.json"));
    assert.equal(round1.verdict, "discard");
    assert.equal(round1.verdictSource, "probe");
    assert.equal(round1.disposition.disposition, "escalate");
    assert.equal(round1.disposition.reason, "reviewer discarded the work");
  });

  // =======================================================================
  // Lazy re-validation of RECORDED probe truth (kusabi #262)
  // -----------------------------------------------------------------------
  // A review-resume (interrupted round #153, or replacement review seat
  // #248) derives its disposition from probe truth measured BEFORE the
  // stop/escalate.  Between then and now the container worktree can have
  // moved.  An accept CONSUMES that recorded truth, so it must re-measure on
  // the current worktree before finalising; a rework must not, because the
  // next round it buys re-measures everything anyway.
  //
  // The probe count is read off verify_in_container: a review-resume runs no
  // probes of its own, and P2 issues exactly one call per probe phase on
  // these fixtures (green gate → no tolerated re-run; red gate with
  // `tests.full` → tests ran and failed, also no re-run).  So the call count
  // IS the number of probe phases that ran.
  // =======================================================================

  // Round 1 implemented, probes P1-P4 green, then the review SEAT died
  // mid-stream and the chain escalated on it (#248).  Recorded probe details
  // are tagged so a fresh run is distinguishable from the recorded one.
  function seatDeadRound() {
    return {
      round: 1,
      reworkScope: "full",
      implementJobId: "job-imp-1",
      reviewJobId: "job-rev-1",
      sessionID: "sess-1",
      tierBefore: 0,
      tierAfter: 0,
      reworkCount: 0,
      probesGreen: true,
      probeResults: [
        { probe: "P1: HEAD clean", passed: true, detail: "recorded before the escalate" },
        { probe: "P2: verify gate", passed: true, detail: "recorded before the escalate" },
        { probe: "P3: deliverables", passed: true, detail: "recorded before the escalate" },
        { probe: "P4: smoke", passed: true, detail: "recorded before the escalate" },
      ],
      worktreeChanged: true,
      verdict: "partial",
      reviewParseable: true,
      reviewPartial: true,
      reviewFindingCount: 3,
      disposition: {
        disposition: "escalate",
        reason: "partial review: stream ended before the verdict line",
      },
    };
  }

  // fakeResumeCallTool plus a verify_in_container counter, and a settable
  // verify result so a test can degrade the worktree after the escalate.
  // headSha drives what `git rev-parse HEAD` reports, so a test can move
  // the fake worktree's HEAD; every sandbox_exec command is recorded in
  // execCalls so a test can assert what did (and did not) run.
  function probeCountingCallTool({ verifyResult = { gate_passed: true }, statusOutput, headSha } = {}) {
    const base = fakeResumeCallTool({ statusOutput, headSha });
    const verifyCalls = [];
    const execCalls = [];
    const fn = async (toolName, params) => {
      if (toolName === "verify_in_container") {
        verifyCalls.push(params);
        return verifyResult;
      }
      if (toolName === "sandbox_exec") {
        execCalls.push(params.commands[0]);
      }
      return base(toolName, params);
    };
    fn.verifyCalls = verifyCalls;
    fn.execCalls = execCalls;
    return fn;
  }

  it("re-runs the probes once before an accept from a resumed review and finalises it when they come back green (kusabi #262)", async () => {
    const { chainDir } = makeChainState({
      records: [seatDeadRound()],
      controlOverrides: { status: "completed", round: 1, finishedAt: "2026-08-01T01:00:00.000Z" },
    });
    // The worktree still matches the recorded state: the fresh probes pass.
    const callTool = probeCountingCallTool();
    const dispatch = makeFakeDispatch(); // the replacement review approves

    const text = await resumeChain({ chainDir, dispatch, callTool });

    assert.match(text, /accepted at round 1/);
    assert.equal(callTool.verifyCalls.length, 1, "the accept must re-measure the probes exactly once");

    const round1 = readJson(path.join(chainDir, "round-1.json"));
    assert.equal(round1.verdict, "approve");
    assert.equal(round1.disposition.disposition, "accept");
    assert.equal(round1.probesGreen, true);

    // The record SHOWS the re-validation: the recorded truth is preserved
    // beside the fresh results that replaced it.
    assert.ok(round1.probesRevalidated, "the record must show that recorded-green was re-validated");
    assert.equal(round1.probesRevalidated.probesGreen, true);
    assert.match(round1.probesRevalidated.reason, /kusabi #262/);
    assert.deepEqual(
      round1.probesRevalidated.probeResults.map((p) => p.detail),
      ["recorded before the escalate", "recorded before the escalate", "recorded before the escalate", "recorded before the escalate"],
    );
    // ...and the live probe fields are the FRESH run, not the recorded one.
    assert.deepEqual(
      round1.probeResults.map((p) => p.probe),
      ["P1: HEAD clean", "P2: verify gate", "P3: deliverables", "P4: smoke"],
    );
    assert.ok(round1.probeResults.every((p) => p.passed));
    assert.ok(
      round1.probeResults.every((p) => p.detail !== "recorded before the escalate"),
      "the live probe results must be the re-measured ones",
    );
  });

  it("does not finalise an accept from a resumed review when the re-run comes back red; the red-probe disposition decides (kusabi #262)", async () => {
    const { chainDir } = makeChainState({
      records: [seatDeadRound()],
      controlOverrides: { status: "completed", round: 1, finishedAt: "2026-08-01T01:00:00.000Z" },
    });
    // The worktree was degraded after the escalate: the verify gate now runs
    // the tests and they fail (tests.full present => tests ran, one call).
    const callTool = probeCountingCallTool({
      verifyResult: {
        gate_passed: false,
        lint: [],
        types: [],
        tests: { full: { status: "fail", passed: 0, total: 1 } },
      },
    });
    // The replacement review still approves.  The next round's implement hits
    // provider exhaustion so the chain stops where the test can read it.
    const dispatch = makeFakeDispatch({ implementStatus: "provider-error" });

    const text = await resumeChain({ chainDir, dispatch, callTool });

    assert.doesNotMatch(text, /accepted at round/);
    assert.match(text, /implement provider exhausted/);
    // Once and only once: the re-derived rework does not re-trigger the
    // re-run, and round 2's implement dies before its own probes.
    assert.equal(callTool.verifyCalls.length, 1);

    const round1 = readJson(path.join(chainDir, "round-1.json"));
    // The review approved, but the accept never finalised: approve + red
    // probes is exactly what a normal round would derive.
    assert.equal(round1.verdict, "approve");
    assert.equal(round1.disposition.disposition, "rework");
    assert.equal(round1.disposition.reason, "deterministic probes failed");
    // Both truths are visible on the record: recorded green AND fresh red.
    assert.equal(round1.probesRevalidated.probesGreen, true);
    assert.equal(round1.probesRevalidated.recordedDisposition.disposition, "accept");
    assert.equal(round1.probesGreen, false);
    const freshP2 = round1.probeResults.find((p) => p.probe === "P2: verify gate");
    assert.equal(freshP2.passed, false);
  });

  it("re-validation P1 compares and never resets: a moved HEAD is red, no git reset, accept does not finalise, recorded truth preserved (kusabi #262 follow-up)", async () => {
    const { chainDir } = makeChainState({
      records: [seatDeadRound()],
      controlOverrides: { status: "completed", round: 1, finishedAt: "2026-08-01T01:00:00.000Z" },
    });
    // The worktree HEAD moved after the escalate (operator hand-edit,
    // another job, a partial restore): rev-parse now reports a different
    // SHA than the recorded baseSha.  Everything else still measures green.
    const callTool = probeCountingCallTool({ headSha: "def456" });
    const dispatch = makeFakeDispatch({ implementStatus: "provider-error" });

    const text = await resumeChain({ chainDir, dispatch, callTool });

    assert.doesNotMatch(text, /accepted at round/);
    assert.match(text, /implement provider exhausted/);

    // The probe phase issued NO reset: a measurement must not mutate the
    // state it measures.  The fake container's HEAD is whatever the
    // operator left it at — the re-validation never touched it.
    assert.ok(
      !callTool.execCalls.some((cmd) => cmd.startsWith("git reset")),
      "the re-validation must never issue a git reset",
    );
    // Once and only once: the re-derived rework does not re-trigger the
    // re-run, and round 2's implement dies before its own probes.
    assert.equal(callTool.verifyCalls.length, 1);

    const round1 = readJson(path.join(chainDir, "round-1.json"));
    const freshP1 = round1.probeResults.find((p) => p.probe === "P1: HEAD clean");
    assert.equal(freshP1.passed, false);
    assert.match(freshP1.detail, /HEAD def456 != base abc123/);
    assert.doesNotMatch(freshP1.detail, /reset/);
    // The review approved, but the accept never finalised: approve + red
    // probes is exactly what a normal round would derive — the same red
    // disposition as the verify-gate failure test above.
    assert.equal(round1.verdict, "approve");
    assert.equal(round1.disposition.disposition, "rework");
    assert.equal(round1.disposition.reason, "deterministic probes failed");
    // Both truths are visible on the record: recorded green AND fresh red.
    assert.equal(round1.probesRevalidated.probesGreen, true);
    assert.equal(round1.probesRevalidated.recordedDisposition.disposition, "accept");
    assert.equal(round1.probesGreen, false);
    // The re-run could not measure worktreeChanged (no baseline on this
    // path), so the recorded true stays true — it does not degrade to null.
    assert.equal(round1.worktreeChanged, true);
    assert.equal(round1.probesRevalidated.worktreeChanged, true);
  });

  it("re-runs no probes when a resumed review reworks — the next round re-measures anyway (kusabi #262)", async () => {
    const partial = {
      round: 3,
      resumeMethod: { type: "continue_session" },
      startedAt: "2026-08-01T00:00:00.000Z",
      verdict: null,
      probesGreen: true,
      modelEntry: "fake/model",
      modelVariant: null,
      fallbacks: null,
      implementJobId: "job-imp-3",
      sessionID: "sess-3",
      implementUsage: null,
      tierBefore: 0,
      reworkStrategyReason: null,
      reworkCount: 0,
      probeResults: [{ probe: "P1: HEAD clean", passed: true, detail: "recorded before the stop" }],
      worktreeChanged: true,
      interrupted: true,
      interruptedAfter: "probes",
    };
    const { chainDir } = makeChainState({ records: [partial] });
    const callTool = probeCountingCallTool();
    // The resumed review finds a high-severity problem => rework; the next
    // round's implement hits provider exhaustion so the chain stops there.
    const dispatch = makeFakeDispatch({
      reviewResult: JSON.stringify({
        verdict: "needs-attention",
        findings: [{ severity: "high", file: "src/foo.js", description: "fix the parser" }],
      }),
      implementStatus: "provider-error",
    });

    const text = await resumeChain({ chainDir, dispatch, callTool });

    assert.match(text, /implement provider exhausted/);
    assert.equal(callTool.verifyCalls.length, 0, "a rework disposition must buy no probe re-run");

    const round3 = readJson(path.join(chainDir, "round-3.json"));
    assert.equal(round3.disposition.disposition, "rework");
    assert.equal(round3.probesRevalidated, undefined);
    // The recorded probe truth is left exactly as the stop wrote it.
    assert.equal(round3.probesGreen, true);
    assert.deepEqual(round3.probeResults, [
      { probe: "P1: HEAD clean", passed: true, detail: "recorded before the stop" },
    ]);
  });

  it("leaves a NON-resumed round untouched: probes run once, in-round, and nothing is re-validated (kusabi #262)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-chain-norevalidate-"));
    const chainDir = path.join(tmp, "chains", "chain-test");
    fs.mkdirSync(chainDir, { recursive: true });
    writeChainControl(chainDir, {
      chainId: "chain-test", container: "cid-1", pid: process.pid,
      status: "running", round: 0, startedAt: new Date().toISOString(),
    });
    const callTool = probeCountingCallTool();

    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
      model: "fake/model", modelChain: [["fake/model"]], maxRounds: 1,
      brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      callTool,
      dispatchWithFallback: makeFakeDispatch(),
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });

    assert.match(text, /accepted at round 1/);
    // The round's own P2 and nothing else: an accept whose probe truth was
    // measured in-round never re-measures.
    assert.equal(callTool.verifyCalls.length, 1);
    const round1 = readJson(path.join(chainDir, "round-1.json"));
    assert.equal(round1.disposition.disposition, "accept");
    assert.equal(round1.probesRevalidated, undefined);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// =========================================================================
// runChainDriver — per-phase backend mixing (kusabi #192)
// -------------------------------------------------------------------------
// The driver threads TWO backend-specific dispatches: one for the implement
// phase (and the strategist, which follows the implement resolution) and one
// for the review phase.  Round records carry `backend` (implement) and
// `reviewBackend` (review, always set).  Session lineage never crosses
// backends: a rework implement round only continues a session created by the
// implement backend.
// =========================================================================

describe("runChainDriver per-phase backends (kusabi #192)", () => {
  const BRIEF = "Implement X.\n\n## Deliverables\n- src/foo.js\n";
  const APPROVE = JSON.stringify({ verdict: "approve", findings: [], summary: "ok" });
  const REWORK = JSON.stringify({
    verdict: "needs-attention",
    findings: [{ severity: "high", file: "src/foo.js", description: "fix the parser" }],
  });

  function fakeCallTool({ statusOutput = " M src/foo.js\n" } = {}) {
    return async (toolName, params) => {
      if (toolName === "verify_in_container") {
        return { gate_passed: true };
      }
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands[0];
      if (cmd.startsWith("cd /workspace &&") && cmd.includes("TMPIDX=")) {
        return { output: "ERROR_NO_INDEX\n" };
      }
      if (cmd === "git rev-parse HEAD") return { output: "abc123\n" };
      if (cmd === "git status --porcelain") return { output: statusOutput };
      if (cmd === "git log --oneline -5") return { output: "abc123 latest change\n" };
      if (cmd === "git diff") return { output: "diff --git a/src/foo.js b/src/foo.js\n" };
      if (cmd === "git ls-files --others --exclude-standard") return { output: "untracked.txt\n" };
      return { output: "" };
    };
  }

  // The implement-side fake: claude-shaped (bare-alias modelEntry, UUID
  // session ids).  Records every dispatch options object.
  function makeImplementDispatch() {
    const calls = [];
    const dispatch = async (opts) => {
      calls.push(opts);
      if (opts.kind === "task") {
        return {
          job: {
            id: "job-imp-" + (opts.round ?? 1), status: "completed",
            modelEntry: "opus", modelVariant: null, fallbacks: null,
            sessionID: "claude-uuid-" + (opts.round ?? 1),
            usage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            error: null,
          },
          resultText: "implemented",
        };
      }
      if (opts.kind === "strategist") {
        return {
          job: {
            id: "job-strat-1", status: "completed",
            modelEntry: "opus", modelVariant: null, fallbacks: null,
            sessionID: "claude-uuid-strat",
            usage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            error: null,
          },
          resultText: "restructure the module",
        };
      }
      throw new Error("unexpected implement dispatch kind: " + opts.kind);
    };
    return { dispatch, calls };
  }

  // The review-side fake: opencode-shaped (provider/model modelEntry, ses_*
  // session ids).  Records every dispatch options object.  `reviewResult`
  // may be a value or a function (opts) => string, so tests can switch the
  // verdict between rounds.
  function makeReviewDispatch({ reviewResult = APPROVE } = {}) {
    const calls = [];
    const dispatch = async (opts) => {
      calls.push(opts);
      if (opts.kind === "review") {
        return {
          job: {
            id: "job-rev-" + (opts.round ?? 1), status: "completed",
            modelEntry: "opencode/deepseek-v4-flash-free", modelVariant: "max",
            fallbacks: null, sessionID: "ses_review_" + (opts.round ?? 1),
            usage: { available: true, input: 2, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            error: null,
          },
          resultText: typeof reviewResult === "function" ? reviewResult(opts) : reviewResult,
        };
      }
      throw new Error("unexpected review dispatch kind: " + opts.kind);
    };
    return { dispatch, calls };
  }

  function makeChainDir() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-phase-backend-"));
    const chainDir = path.join(tmp, "chains", "chain-test");
    fs.mkdirSync(chainDir, { recursive: true });
    writeChainControl(chainDir, {
      chainId: "chain-test", container: "cid-1", pid: process.pid,
      status: "running", round: 0, startedAt: new Date().toISOString(),
    });
    return { tmp, chainDir };
  }

  it("dispatches implement on claude and review on opencode, recording both backends and per-phase models/agents", async () => {
    const { tmp, chainDir } = makeChainDir();
    const implement = makeImplementDispatch();
    const review = makeReviewDispatch();

    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
      model: "opus", modelChain: [["opus"]],
      reviewModel: { providerID: "opencode", modelID: "deepseek-v4-flash-free", variant: "max" },
      reviewModelChain: [["opencode/deepseek-v4-flash-free:max"]],
      maxRounds: 1,
      brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      callTool: fakeCallTool(),
      backend: "claude", reviewBackend: "opencode",
      dispatchWithFallback: implement.dispatch,
      reviewDispatchWithFallback: review.dispatch,
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });

    assert.match(text, /accepted at round 1/);

    // The implement dispatch ran on the claude-shaped fake: one task call
    // with the claude model chain and the implement agent.
    assert.equal(implement.calls.length, 1);
    assert.equal(implement.calls[0].kind, "task");
    assert.equal(implement.calls[0].agent, "kusabi-implement");
    assert.deepEqual(implement.calls[0].tiers, [["opus"]]);

    // The review dispatch ran on the opencode-shaped fake: one review call
    // with the review route chain and the review agent.
    assert.equal(review.calls.length, 1);
    assert.equal(review.calls[0].kind, "review");
    assert.equal(review.calls[0].agent, "kusabi-review");
    assert.deepEqual(review.calls[0].tiers, [["opencode/deepseek-v4-flash-free:max"]]);

    // Round record: backend = implement backend, reviewBackend = review
    // backend (always set), reviewModelEntry from the review job.
    const round1 = readJson(path.join(chainDir, "round-1.json"));
    assert.equal(round1.backend, "claude");
    assert.equal(round1.reviewBackend, "opencode");
    assert.equal(round1.reviewModelEntry, "opencode/deepseek-v4-flash-free");

    const chainJson = readJson(path.join(chainDir, "chain.json"));
    assert.equal(chainJson.records[0].backend, "claude");
    assert.equal(chainJson.records[0].reviewBackend, "opencode");
    // The review-phase context is persisted for chain-resume.
    assert.deepEqual(chainJson.reviewModelChain, [["opencode/deepseek-v4-flash-free:max"]]);

    const control = readChainControl(chainDir);
    assert.equal(control.status, "completed");

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("session lineage stays within the implement backend across rework rounds (never the review backend's session)", async () => {
    const { tmp, chainDir } = makeChainDir();
    const implement = makeImplementDispatch();
    // Review finds problems in round 1 (rework); the review dispatch then
    // switches to approve so round 2 accepts.
    let reviewCount = 0;
    const reviewInner = makeReviewDispatch({
      reviewResult: () => (++reviewCount === 1 ? REWORK : APPROVE),
    });
    const review = reviewInner.dispatch;
    review.calls = reviewInner.calls;

    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
      model: "opus", modelChain: [["opus"]],
      reviewModelChain: [["opencode/deepseek-v4-flash-free:max"]],
      maxRounds: 2,
      brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      callTool: fakeCallTool(),
      backend: "claude", reviewBackend: "opencode",
      dispatchWithFallback: implement.dispatch,
      reviewDispatchWithFallback: review,
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });

    assert.match(text, /accepted at round 2/);

    // Two implement rounds: round 1 starts fresh, round 2 (rework) continues
    // round 1's implement session — never the review backend's ses_* id.
    const implementCalls = implement.calls.filter((c) => c.kind === "task");
    assert.equal(implementCalls.length, 2);
    assert.equal(implementCalls[0].session, undefined);
    assert.equal(implementCalls[1].session, "claude-uuid-1");
    for (const c of implementCalls) {
      assert.ok(c.session === undefined || c.session.startsWith("claude-uuid-"),
        "implement must never receive the review backend's session");
    }

    // The review backend's session ids never entered the record lineage.
    const round1 = readJson(path.join(chainDir, "round-1.json"));
    assert.equal(round1.sessionID, "claude-uuid-1");
    const round2 = readJson(path.join(chainDir, "round-2.json"));
    assert.equal(round2.sessionID, "claude-uuid-2");
    assert.equal(round2.backend, "claude");
    assert.equal(round2.reviewBackend, "opencode");

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("resume drops a session created by the other backend: the rework implement round starts fresh", async () => {
    // Adversarial seam test for invariant 5: the resume position carries a
    // session whose record ran on the OTHER backend (an opencode ses_* id
    // being resumed on a claude implement — and the reverse).  The driver
    // must drop it, and runImplementPhase's previousRecord fallback must
    // also refuse it, so the round starts fresh.
    const previousOpencode = {
      round: 1, resumeMethod: { type: "continue_session" },
      startedAt: "2026-08-01T00:00:00.000Z",
      verdict: "needs-attention", probesGreen: false,
      modelEntry: "fake/model", modelVariant: null, fallbacks: null,
      implementJobId: "job-imp-1", reviewJobId: "job-rev-1",
      sessionID: "ses_opencode_1", implementUsage: null, reviewUsage: null,
      tierBefore: 0, tierAfter: 1, reworkCount: 1,
      pendingReworkStrategy: { tierDelta: 1, newSession: false, reason: "rework" },
      disposition: { disposition: "rework", reason: "needs-attention" },
      findingsText: "fix the parser",
      backend: "opencode",
    };
    const previousClaude = {
      ...previousOpencode,
      sessionID: "claude-uuid-1",
      backend: "claude",
    };

    async function driveResume({ previous, driverBackend }) {
      const { tmp, chainDir } = makeChainDir();
      writeJson(path.join(chainDir, "chain.json"), {
        chainId: "chain-test", container: "cid-1", model: "opus",
        modelChain: [["opus"]], maxRounds: 4,
        brief: BRIEF, orchestrator: null, records: [previous],
        baseSha: "abc123", chainTotals: computeChainTotals([previous]),
        strategized: false, followupIssueDraft: null,
      });
      const implement = makeImplementDispatch();
      const review = makeReviewDispatch();
      const text = await runChainDriver({
        cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
        model: "opus", modelChain: [["opus"]], maxRounds: 4,
        brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
        callTool: fakeCallTool(),
        backend: driverBackend, reviewBackend: "opencode",
        dispatchWithFallback: implement.dispatch,
        reviewDispatchWithFallback: review.dispatch,
        keepServe: true,
        signalReceived: () => false,
        resume: {
          phase: "implement", round: 2, roundRecord: null, records: [previous],
          reworkCount: 1, currentTierIndex: 0, strategized: false,
          session: previous.sessionID, baseSha: "abc123",
        },
      });
      const impRound2 = implement.calls.find((c) => c.kind === "task" && c.round === 2);
      fs.rmSync(tmp, { recursive: true, force: true });
      return { text, impRound2 };
    }

    // claude implement must not continue an opencode session.
    const a = await driveResume({ previous: previousOpencode, driverBackend: "claude" });
    assert.ok(a.impRound2, "round-2 implement must be dispatched");
    assert.ok(a.impRound2.session == null, "foreign opencode session must be dropped (fresh start)");
    assert.match(a.text, /accepted at round 2/);

    // opencode implement must not continue a claude session (the direction
    // the existing ses_* guard in claudeDispatch does not cover).
    const b = await driveResume({ previous: previousClaude, driverBackend: "opencode" });
    assert.ok(b.impRound2, "round-2 implement must be dispatched");
    assert.ok(b.impRound2.session == null, "foreign claude session must be dropped (fresh start)");
    assert.match(b.text, /accepted at round 2/);
  });
});

// =========================================================================
// runChainDriver — per-round rework tiering (kusabi #192 axis 2)
// -------------------------------------------------------------------------
// models.phases.rework: implement rounds AFTER round 1 dispatch from the
// rework resolution — own chain, own backend, own dispatch — while the
// tier ladder climbs over the REWORK chain (first rework at its tier 0).
// Absent key → rework rounds keep the implement resolution byte-identically.
// Round records stamp the backend each round's implement job ACTUALLY used.
// =========================================================================

describe("runChainDriver per-round rework tiering (kusabi #192 axis 2)", () => {
  const BRIEF = "Implement X.\n\n## Deliverables\n- src/foo.js\n";
  const APPROVE = JSON.stringify({ verdict: "approve", findings: [], summary: "ok" });
  const REWORK = JSON.stringify({
    verdict: "needs-attention",
    findings: [{ severity: "high", file: "src/foo.js", description: "fix the parser" }],
  });

  function fakeCallTool({ statusOutput = " M src/foo.js\n" } = {}) {
    return async (toolName, params) => {
      if (toolName === "verify_in_container") {
        return { gate_passed: true };
      }
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands[0];
      if (cmd.startsWith("cd /workspace &&") && cmd.includes("TMPIDX=")) {
        return { output: "ERROR_NO_INDEX\n" };
      }
      if (cmd === "git rev-parse HEAD") return { output: "abc123\n" };
      if (cmd === "git status --porcelain") return { output: statusOutput };
      if (cmd === "git log --oneline -5") return { output: "abc123 latest change\n" };
      if (cmd === "git diff") return { output: "diff --git a/src/foo.js b/src/foo.js\n" };
      if (cmd === "git ls-files --others --exclude-standard") return { output: "untracked.txt\n" };
      return { output: "" };
    };
  }

  // One dispatch fake per phase seam.  `kind` gates the accepted phase
  // (task = implement, review = review); `sessionPrefix` gives ids of the
  // shape that phase's backend would produce (claude-uuid-* for the claude
  // fake, ses_* for the opencode fakes) so session lineage assertions can
  // tell the fakes apart.
  function makePhaseDispatch({ kind, modelEntry, sessionPrefix, resultText }) {
    const calls = [];
    const dispatch = async (opts) => {
      calls.push(opts);
      // The strategist runs on the IMPLEMENT seam (runStrategizePhase threads
      // the implement dispatch); a task fake must answer it so a strategize
      // disposition in a fixture does not crash the chain.
      if (opts.kind === "strategist" && kind === "task") {
        return {
          job: {
            id: "strategist-job-" + (opts.round ?? 1), status: "completed",
            modelEntry, modelVariant: null, fallbacks: null,
            sessionID: sessionPrefix + "-strat",
            usage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            error: null,
          },
          resultText: "restructure the module",
        };
      }
      if (opts.kind !== kind) {
        throw new Error("unexpected dispatch kind: " + opts.kind + " on the " + kind + " seam");
      }
      return {
        job: {
          id: kind + "-job-" + (opts.round ?? 1), status: "completed",
          modelEntry, modelVariant: null, fallbacks: null,
          sessionID: sessionPrefix + (opts.round ?? 1),
          usage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
          error: null,
        },
        resultText,
      };
    };
    return { dispatch, calls };
  }

  function makeReviewDispatch({ reviewResults }) {
    const calls = [];
    let idx = 0;
    const dispatch = async (opts) => {
      calls.push(opts);
      if (opts.kind !== "review") {
        throw new Error("unexpected dispatch kind on the review seam: " + opts.kind);
      }
      const resultText = reviewResults[Math.min(idx, reviewResults.length - 1)];
      idx += 1;
      return {
        job: {
          id: "review-job-" + (opts.round ?? 1), status: "completed",
          modelEntry: "opencode-go/deepseek-v4-flash", modelVariant: null, fallbacks: null,
          sessionID: "ses_review_" + (opts.round ?? 1),
          usage: { available: true, input: 2, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
          error: null,
        },
        resultText,
      };
    };
    return { dispatch, calls };
  }

  function makeChainDir() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-rework-tier-"));
    const chainDir = path.join(tmp, "chains", "chain-test");
    fs.mkdirSync(chainDir, { recursive: true });
    writeChainControl(chainDir, {
      chainId: "chain-test", container: "cid-1", pid: process.pid,
      status: "running", round: 0, startedAt: new Date().toISOString(),
    });
    return { tmp, chainDir };
  }

  it("mixed backends: round 1 dispatches claude/opus, a rework round dispatches the opencode flash route with a FRESH session, and records carry each round's true backend", async () => {
    const { tmp, chainDir } = makeChainDir();
    const implement = makePhaseDispatch({ kind: "task", modelEntry: "opus", sessionPrefix: "claude-uuid-", resultText: "implemented" });
    const rework = makePhaseDispatch({ kind: "task", modelEntry: "opencode-go/deepseek-v4-flash", sessionPrefix: "ses_rework_", resultText: "implemented" });
    const review = makeReviewDispatch({ reviewResults: [REWORK, APPROVE] });

    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
      model: "opus", modelChain: [["opus"]],
      reworkModel: "deepseek-v4-flash", reworkModelChain: [["opencode-go/deepseek-v4-flash"]],
      reworkBackend: "opencode",
      reviewModelChain: [["opencode-go/deepseek-v4-flash"]],
      maxRounds: 2,
      brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      callTool: fakeCallTool(),
      backend: "claude", reviewBackend: "opencode",
      dispatchWithFallback: implement.dispatch,
      reworkDispatchWithFallback: rework.dispatch,
      reviewDispatchWithFallback: review.dispatch,
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });

    assert.match(text, /accepted at round 2/);

    // Round 1 implement: the claude fake, implement chain, no session.
    assert.equal(implement.calls.length, 1);
    assert.equal(implement.calls[0].round, 1);
    assert.deepEqual(implement.calls[0].tiers, [["opus"]]);
    assert.ok(implement.calls[0].session == null);

    // Round 2 (rework): the opencode rework fake, REWORK chain, FRESH
    // session — the claude round's session id never crosses backends.
    assert.equal(rework.calls.length, 1);
    assert.equal(rework.calls[0].round, 2);
    assert.deepEqual(rework.calls[0].tiers, [["opencode-go/deepseek-v4-flash"]]);
    assert.ok(rework.calls[0].session == null, "rework round must start fresh across backends");

    // Round records: backend reflects the route each round ACTUALLY used.
    const round1 = readJson(path.join(chainDir, "round-1.json"));
    assert.equal(round1.backend, "claude");
    assert.equal(round1.modelEntry, "opus");
    assert.equal(round1.sessionID, "claude-uuid-1");
    const round2 = readJson(path.join(chainDir, "round-2.json"));
    assert.equal(round2.backend, "opencode");
    assert.equal(round2.modelEntry, "opencode-go/deepseek-v4-flash");
    assert.equal(round2.sessionID, "ses_rework_2");

    // chain.json persists the rework dispatch context for chain-resume.
    const chainJson = readJson(path.join(chainDir, "chain.json"));
    assert.deepEqual(chainJson.reworkModelChain, [["opencode-go/deepseek-v4-flash"]]);
    assert.equal(chainJson.reworkModel, "deepseek-v4-flash");
    assert.equal(chainJson.reworkBackend, "opencode");

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("same-backend tiering: a rework round continues the session and dispatches the rework chain's route", async () => {
    const { tmp, chainDir } = makeChainDir();
    const implement = makePhaseDispatch({ kind: "task", modelEntry: "opencode-go/deepseek-v4-pro", sessionPrefix: "ses_imp_", resultText: "implemented" });
    const rework = makePhaseDispatch({ kind: "task", modelEntry: "opencode-go/deepseek-v4-flash", sessionPrefix: "ses_rework_", resultText: "implemented" });
    const review = makeReviewDispatch({ reviewResults: [REWORK, APPROVE] });

    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
      model: { providerID: "opencode-go", modelID: "deepseek-v4-pro" },
      modelChain: [["opencode-go/deepseek-v4-pro"]],
      reworkModel: "deepseek-v4-flash", reworkModelChain: [["opencode-go/deepseek-v4-flash"]],
      reworkBackend: "opencode",
      reviewModelChain: [["opencode-go/deepseek-v4-flash"]],
      maxRounds: 2,
      brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      callTool: fakeCallTool(),
      backend: "opencode", reviewBackend: "opencode",
      dispatchWithFallback: implement.dispatch,
      reworkDispatchWithFallback: rework.dispatch,
      reviewDispatchWithFallback: review.dispatch,
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });

    assert.match(text, /accepted at round 2/);

    // Round 1 on the implement seam with the implement chain.
    assert.equal(implement.calls.length, 1);
    assert.deepEqual(implement.calls[0].tiers, [["opencode-go/deepseek-v4-pro"]]);
    // Round 2 (rework) on the rework seam with the flash route, session
    // CONTINUED — the lineage guard passes on a same-backend rework.
    assert.equal(rework.calls.length, 1);
    assert.deepEqual(rework.calls[0].tiers, [["opencode-go/deepseek-v4-flash"]]);
    assert.equal(rework.calls[0].session, "ses_imp_1", "same-backend rework continues the implement session");

    const round1 = readJson(path.join(chainDir, "round-1.json"));
    const round2 = readJson(path.join(chainDir, "round-2.json"));
    assert.equal(round1.backend, "opencode");
    assert.equal(round2.backend, "opencode");
    assert.equal(round2.sessionID, "ses_rework_2");

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("the tier ladder climbs over the REWORK chain: first rework at its tier 0, next rework at its tier 1", async () => {
    const { tmp, chainDir } = makeChainDir();
    const implement = makePhaseDispatch({ kind: "task", modelEntry: "opencode-go/deepseek-v4-pro", sessionPrefix: "ses_imp_", resultText: "implemented" });
    const rework = makePhaseDispatch({ kind: "task", modelEntry: "opencode-go/deepseek-v4-flash", sessionPrefix: "ses_rework_", resultText: "implemented" });
    // Distinct finding files per round: same-file repeats would trigger the
    // strategize lever instead of the plain rework this test exercises.
    const reworkA = JSON.stringify({
      verdict: "needs-attention",
      findings: [{ severity: "high", file: "src/a.js", description: "fix the parser" }],
    });
    const reworkB = JSON.stringify({
      verdict: "needs-attention",
      findings: [{ severity: "high", file: "src/b.js", description: "fix the parser" }],
    });
    const review = makeReviewDispatch({ reviewResults: [reworkA, reworkB, APPROVE] });

    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
      model: "deepseek-v4-pro", modelChain: [["opencode-go/deepseek-v4-pro"]],
      reworkModel: "deepseek-v4-flash",
      reworkModelChain: [["opencode-go/deepseek-v4-flash"], ["opencode-go/deepseek-v4-pro"]],
      reworkBackend: "opencode",
      reviewModelChain: [["opencode-go/deepseek-v4-flash"]],
      maxRounds: 3,
      brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      callTool: fakeCallTool(),
      backend: "opencode", reviewBackend: "opencode",
      dispatchWithFallback: implement.dispatch,
      reworkDispatchWithFallback: rework.dispatch,
      reviewDispatchWithFallback: review.dispatch,
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });

    assert.match(text, /accepted at round 3/);

    // Both rework rounds went to the rework seam with the REWORK chain; the
    // tier index climbed 0 → 1 within it.
    const reworkCalls = rework.calls.filter((c) => c.round >= 2);
    assert.equal(reworkCalls.length, 2);
    assert.equal(reworkCalls[0].round, 2);
    assert.equal(reworkCalls[0].tierIndex, 0, "first rework starts at the rework chain's tier 0");
    assert.equal(reworkCalls[1].round, 3);
    assert.equal(reworkCalls[1].tierIndex, 1, "second rework escalates within the rework chain");
    for (const c of reworkCalls) {
      assert.deepEqual(c.tiers, [["opencode-go/deepseek-v4-flash"], ["opencode-go/deepseek-v4-pro"]],
        "rework rounds address the rework chain");
    }

    const round2 = readJson(path.join(chainDir, "round-2.json"));
    assert.equal(round2.tierBefore, 0);
    const round3 = readJson(path.join(chainDir, "round-3.json"));
    assert.equal(round3.tierBefore, 1);
    assert.equal(round3.tierAfter, 1);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("a single-tier rework chain clamps the escalation exactly as today, over the rework chain", async () => {
    const { tmp, chainDir } = makeChainDir();
    const implement = makePhaseDispatch({ kind: "task", modelEntry: "opencode-go/deepseek-v4-pro", sessionPrefix: "ses_imp_", resultText: "implemented" });
    const rework = makePhaseDispatch({ kind: "task", modelEntry: "opencode-go/deepseek-v4-flash", sessionPrefix: "ses_rework_", resultText: "implemented" });
    const reworkA = JSON.stringify({
      verdict: "needs-attention",
      findings: [{ severity: "high", file: "src/a.js", description: "fix the parser" }],
    });
    const reworkB = JSON.stringify({
      verdict: "needs-attention",
      findings: [{ severity: "high", file: "src/b.js", description: "fix the parser" }],
    });
    const review = makeReviewDispatch({ reviewResults: [reworkA, reworkB, APPROVE] });

    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
      model: "deepseek-v4-pro", modelChain: [["opencode-go/deepseek-v4-pro"]],
      reworkModel: "deepseek-v4-flash", reworkModelChain: [["opencode-go/deepseek-v4-flash"]],
      reworkBackend: "opencode",
      reviewModelChain: [["opencode-go/deepseek-v4-flash"]],
      maxRounds: 3,
      brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      callTool: fakeCallTool(),
      backend: "opencode", reviewBackend: "opencode",
      dispatchWithFallback: implement.dispatch,
      reworkDispatchWithFallback: rework.dispatch,
      reviewDispatchWithFallback: review.dispatch,
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });

    assert.match(text, /accepted at round 3/);

    const reworkCalls = rework.calls.filter((c) => c.round >= 2);
    assert.equal(reworkCalls.length, 2);
    assert.equal(reworkCalls[1].tierIndex, 0, "escalation clamps at the single-tier rework chain's top");
    const round2 = readJson(path.join(chainDir, "round-2.json"));
    assert.equal(round2.tierClamped, true);
    assert.match(round2.tierClampReason, /single-tier chain/);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("chain-resume with the key re-dispatches the rework round on the rework backend/model; a legacy chain.json resumes on the implement resolution", async () => {
    function previousRecord({ backend, sessionID }) {
      return {
        round: 1, resumeMethod: { type: "continue_session" },
        startedAt: "2026-08-01T00:00:00.000Z",
        verdict: "needs-attention", probesGreen: true,
        modelEntry: backend === "claude" ? "opus" : "opencode-go/deepseek-v4-pro",
        modelVariant: null, fallbacks: null,
        implementJobId: "job-imp-1", reviewJobId: "job-rev-1",
        sessionID, implementUsage: null, reviewUsage: null,
        tierBefore: 0, tierAfter: 0, reworkCount: 0,
        pendingReworkStrategy: { tierDelta: 0, newSession: false, reason: "rework" },
        disposition: { disposition: "rework", reason: "needs-attention" },
        findingsText: "fix the parser",
        backend,
      };
    }

    async function driveResume({ previous, reworkCtx, reworkBackend }) {
      const { tmp, chainDir } = makeChainDir();
      writeJson(path.join(chainDir, "chain.json"), {
        chainId: "chain-test", container: "cid-1", model: "opus",
        modelChain: [["opus"]], maxRounds: 2,
        brief: BRIEF, orchestrator: null, records: [previous],
        baseSha: "abc123", chainTotals: computeChainTotals([previous]),
        strategized: false, followupIssueDraft: null,
        ...reworkCtx,
      });
      const implement = makePhaseDispatch({ kind: "task", modelEntry: "opencode-go/deepseek-v4-pro", sessionPrefix: "ses_imp_", resultText: "implemented" });
      const rework = makePhaseDispatch({ kind: "task", modelEntry: "opencode-go/deepseek-v4-flash", sessionPrefix: "ses_rework_", resultText: "implemented" });
      const review = makeReviewDispatch({ reviewResults: [APPROVE] });
      const text = await runChainDriver({
        cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
        model: "opus", modelChain: [["opus"]],
        reworkModel: reworkCtx.reworkModel ?? null,
        reworkModelChain: reworkCtx.reworkModelChain ?? null,
        reworkBackend,
        maxRounds: 2,
        brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
        callTool: fakeCallTool(),
        backend: "opencode", reviewBackend: "opencode",
        dispatchWithFallback: implement.dispatch,
        // A rework seam only exists when the chain.json carried rework keys
        // (legacy: null → the driver falls back to the implement dispatch).
        reworkDispatchWithFallback: reworkCtx.reworkModelChain ? rework.dispatch : null,
        reviewDispatchWithFallback: review.dispatch,
        keepServe: true,
        signalReceived: () => false,
        resume: {
          phase: "implement", round: 2, roundRecord: null, records: [previous],
          reworkCount: 1, currentTierIndex: 0, strategized: false,
          session: previous.sessionID, baseSha: "abc123",
        },
      });
      const round2 = readJson(path.join(chainDir, "round-2.json"));
      fs.rmSync(tmp, { recursive: true, force: true });
      return { text, round2, implementCalls: implement.calls, reworkCalls: rework.calls };
    }

    // Axis-2 chain.json (rework key present): the rework round re-dispatches
    // on the rework seam with the rework chain; same-backend session lineage
    // continues the implement session.
    const axis2 = await driveResume({
      previous: previousRecord({ backend: "opencode", sessionID: "ses_imp_1" }),
      reworkCtx: {
        reworkModel: "deepseek-v4-flash",
        reworkModelChain: [["opencode-go/deepseek-v4-flash"]],
        reworkBackend: "opencode",
      },
      reworkBackend: "opencode",
    });
    assert.match(axis2.text, /accepted at round 2/);
    assert.equal(axis2.implementCalls.length, 0, "round 2 must NOT dispatch on the implement seam");
    assert.equal(axis2.reworkCalls.length, 1);
    assert.deepEqual(axis2.reworkCalls[0].tiers, [["opencode-go/deepseek-v4-flash"]]);
    assert.equal(axis2.reworkCalls[0].session, "ses_imp_1", "same-backend rework continues the session");
    assert.equal(axis2.round2.backend, "opencode");

    // Axis-2 chain.json, cross-backend: the claude round's session must not
    // reach the opencode rework dispatch (fresh start), and the rework round
    // still uses the rework chain.
    const cross = await driveResume({
      previous: previousRecord({ backend: "claude", sessionID: "claude-uuid-1" }),
      reworkCtx: {
        reworkModel: "deepseek-v4-flash",
        reworkModelChain: [["opencode-go/deepseek-v4-flash"]],
        reworkBackend: "opencode",
      },
      reworkBackend: "opencode",
    });
    assert.match(cross.text, /accepted at round 2/);
    assert.equal(cross.reworkCalls.length, 1);
    assert.ok(cross.reworkCalls[0].session == null, "foreign claude session dropped on the opencode rework round");
    assert.equal(cross.round2.backend, "opencode");

    // Legacy chain.json (NO rework keys): rework rounds keep the implement
    // resolution — the implement seam dispatches round 2 with the
    // implement chain, byte-identical to today.
    const legacy = await driveResume({
      previous: previousRecord({ backend: "opencode", sessionID: "ses_imp_1" }),
      reworkCtx: {},
      reworkBackend: null,
    });
    assert.match(legacy.text, /accepted at round 2/);
    assert.equal(legacy.reworkCalls.length, 0, "no rework seam on a legacy chain.json");
    assert.equal(legacy.implementCalls.length, 1);
    assert.equal(legacy.implementCalls[0].round, 2);
    assert.deepEqual(legacy.implementCalls[0].tiers, [["opus"]], "legacy rework round uses the implement chain");
    assert.equal(legacy.implementCalls[0].session, "ses_imp_1", "legacy rework round continues the session");
    assert.equal(legacy.round2.backend, "opencode");
  });

  it("a multi-entry claude REWORK ladder never records tierAfter > 0 (backend-aware clamp, kusabi #192 follow-up)", async () => {
    const { tmp, chainDir } = makeChainDir();
    const implement = makePhaseDispatch({ kind: "task", modelEntry: "opus", sessionPrefix: "claude-uuid-", resultText: "implemented" });
    const rework = makePhaseDispatch({ kind: "task", modelEntry: "sonnet", sessionPrefix: "claude-uuid-rw-", resultText: "implemented" });
    const reworkA = JSON.stringify({
      verdict: "needs-attention",
      findings: [{ severity: "high", file: "src/a.js", description: "fix the parser" }],
    });
    const reworkB = JSON.stringify({
      verdict: "needs-attention",
      findings: [{ severity: "high", file: "src/b.js", description: "fix the parser" }],
    });
    const review = makeReviewDispatch({ reviewResults: [reworkA, reworkB, APPROVE] });

    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
      model: "opus", modelChain: [["opus"]],
      reworkModel: "sonnet",
      // Multi-entry claude chain — legal config (kusabi #184), but the
      // claude backend never walks its tiers: the model is pinned to the
      // rework command-start model on every rework round.
      reworkModelChain: [["opus"], ["sonnet"]],
      reworkBackend: "claude",
      reviewModelChain: [["opencode-go/deepseek-v4-flash"]],
      maxRounds: 3,
      brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      callTool: fakeCallTool(),
      backend: "claude", reviewBackend: "opencode",
      dispatchWithFallback: implement.dispatch,
      reworkDispatchWithFallback: rework.dispatch,
      reviewDispatchWithFallback: review.dispatch,
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });

    assert.match(text, /accepted at round 3/);

    // Both rework rounds dispatch at tier 0 — the clamp pins the tier index
    // to the claude ladder's single effective tier.
    const reworkCalls = rework.calls.filter((c) => c.round >= 2);
    assert.equal(reworkCalls.length, 2);
    assert.equal(reworkCalls[0].tierIndex, 0, "first rework at the claude ladder's only tier");
    assert.equal(reworkCalls[1].tierIndex, 0, "second rework stays clamped at tier 0");

    // Records: tierAfter never exceeds 0 on a claude ladder — kusabi #153's
    // recorded-tier-vs-actual-model contradiction must not return through
    // the claude rework surface (the modelEntry never changes: "sonnet" on
    // every rework round while the raw chain length would claim 0 → 1).
    const round2 = readJson(path.join(chainDir, "round-2.json"));
    assert.equal(round2.tierBefore, 0);
    assert.equal(round2.tierAfter, 0, "claude ladder: tierAfter must never exceed 0");
    assert.equal(round2.tierClamped, true);
    assert.match(round2.tierClampReason, /single-tier chain/);
    assert.equal(round2.modelEntry, "sonnet");
    const round3 = readJson(path.join(chainDir, "round-3.json"));
    assert.equal(round3.tierBefore, 0);
    assert.equal(round3.tierAfter, 0, "claude ladder: tierAfter must never exceed 0");

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("a multi-entry claude IMPLEMENT ladder (no rework key) also clamps: tierAfter stays 0 (pre-existing base surface, kusabi #192 follow-up)", async () => {
    const { tmp, chainDir } = makeChainDir();
    const implement = makePhaseDispatch({ kind: "task", modelEntry: "opus", sessionPrefix: "claude-uuid-", resultText: "implemented" });
    const reworkA = JSON.stringify({
      verdict: "needs-attention",
      findings: [{ severity: "high", file: "src/a.js", description: "fix the parser" }],
    });
    const reworkB = JSON.stringify({
      verdict: "needs-attention",
      findings: [{ severity: "high", file: "src/b.js", description: "fix the parser" }],
    });
    const review = makeReviewDispatch({ reviewResults: [reworkA, reworkB, APPROVE] });

    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
      model: "opus",
      // Multi-entry claude IMPLEMENT chain, no models.phases.rework key:
      // rework rounds keep the implement resolution (effectiveReworkChain is
      // the implement chain) — the base surface the follow-up also fixes.
      modelChain: [["opus"], ["sonnet"]],
      reviewModelChain: [["opencode-go/deepseek-v4-flash"]],
      maxRounds: 3,
      brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      callTool: fakeCallTool(),
      backend: "claude", reviewBackend: "opencode",
      dispatchWithFallback: implement.dispatch,
      reworkDispatchWithFallback: null,
      reviewDispatchWithFallback: review.dispatch,
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });

    assert.match(text, /accepted at round 3/);

    // Rework rounds run on the implement seam (no rework key) at tier 0.
    const implementCalls = implement.calls.filter((c) => c.round >= 2);
    assert.equal(implementCalls.length, 2);
    assert.equal(implementCalls[0].tierIndex, 0);
    assert.equal(implementCalls[1].tierIndex, 0, "claude implement ladder never escalates");

    const round2 = readJson(path.join(chainDir, "round-2.json"));
    assert.equal(round2.tierBefore, 0);
    assert.equal(round2.tierAfter, 0, "claude implement ladder: tierAfter must never exceed 0");
    assert.equal(round2.tierClamped, true);
    assert.match(round2.tierClampReason, /single-tier chain/);
    const round3 = readJson(path.join(chainDir, "round-3.json"));
    assert.equal(round3.tierAfter, 0);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// =========================================================================
// chain-start banner (kusabi #192 follow-up) — backend-aware tier counts
// -------------------------------------------------------------------------
// The banner line (B7) had zero coverage before this block.  A claude-native
// chain has an effective tier count of min(1, length): claudeDispatch pins
// every phase to the command-start model, so its ladder never climbs and the
// banner must not claim tiers it cannot walk (reworkTiers=2 on a claude
// rework chain of 2 was a false "can reach top tier" claim at maxRounds >= 3).
// =========================================================================

describe("chain-start banner (kusabi #192 follow-up)", () => {
  const OPENCODE_IMPLEMENT_1 = [["opencode-go/deepseek-v4-pro"]];
  const OPENCODE_REWORK_2 = [["opencode-go/deepseek-v4-flash"], ["opencode-go/deepseek-v4-pro"]];
  const CLAUDE_IMPLEMENT_1 = [["claude/opus"]];
  const CLAUDE_REWORK_2 = [["claude/opus"], ["claude/sonnet-4-5"]];

  it("opencode rework chain of 2: unchanged semantics — can reach top with maxRounds >= 3", () => {
    const tierCount = effectiveTierCount(OPENCODE_IMPLEMENT_1, "opencode");
    const reworkTierCount = effectiveTierCount(OPENCODE_REWORK_2, "opencode");
    assert.equal(tierCount, 1);
    assert.equal(reworkTierCount, 2, "opencode chains keep their full length");
    // roundsToTopTier = 1 + 2 = 3: the top tier needs three rounds.
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount, reworkKeyConfigured: true, maxRounds: 3 }),
      "Chain c1: tiers=1, reworkTiers=2, maxRounds=3 (can reach top tier)\n");
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount, reworkKeyConfigured: true, maxRounds: 2 }),
      "Chain c1: tiers=1, reworkTiers=2, maxRounds=2 (maxRounds insufficient to reach top tier)\n");
  });

  it("claude-native rework chain of 2: effective tier count is 1 — the claim never exceeds ladderTierCount 1", () => {
    const tierCount = effectiveTierCount(CLAUDE_IMPLEMENT_1, "claude");
    const reworkTierCount = effectiveTierCount(CLAUDE_REWORK_2, "claude");
    assert.equal(tierCount, 1);
    assert.equal(reworkTierCount, 1, "a claude chain counts as one tier");
    // roundsToTopTier = 1 + 1 = 2: maxRounds 2 already reaches the (only)
    // top tier.  The pre-fix code computed roundsToTopTier = 3 from the raw
    // length 2 and falsely claimed the top was unreachable at maxRounds 2.
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount, reworkKeyConfigured: true, maxRounds: 2 }),
      "Chain c1: tiers=1, reworkTiers=1, maxRounds=2 (can reach top tier)\n");
    // At maxRounds 3 the pre-fix banner printed reworkTiers=2 and claimed
    // can-reach-top from a 2-tier ladder the claude backend never walks.
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount, reworkKeyConfigured: true, maxRounds: 3 }),
      "Chain c1: tiers=1, reworkTiers=1, maxRounds=3 (can reach top tier)\n");
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount, reworkKeyConfigured: true, maxRounds: 1 }),
      "Chain c1: tiers=1, reworkTiers=1, maxRounds=1 (maxRounds insufficient to reach top tier)\n");
  });

  it("no rework key: today's banner byte-identical (opencode implement chain of 2)", () => {
    const tierCount = effectiveTierCount(OPENCODE_REWORK_2, "opencode");
    assert.equal(tierCount, 2);
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount: 0, reworkKeyConfigured: false, maxRounds: 3 }),
      "Chain c1: tiers=2, maxRounds=3 (can reach top tier)\n");
  });

  it("no rework key, claude implement chain of 2: the implement surface clamps to one tier too", () => {
    const tierCount = effectiveTierCount(CLAUDE_REWORK_2, "claude");
    assert.equal(tierCount, 1);
    // Pre-fix: tiers=2 with roundsToTopTier=3 — a false claim at maxRounds 2.
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount: 0, reworkKeyConfigured: false, maxRounds: 2 }),
      "Chain c1: tiers=1, maxRounds=2 (can reach top tier)\n");
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount: 0, reworkKeyConfigured: false, maxRounds: 3 }),
      "Chain c1: tiers=1, maxRounds=3 (can reach top tier)\n");
  });

  it("no implement chain: no banner line (the caller skips the write)", () => {
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount: 0, reworkTierCount: 0, reworkKeyConfigured: false, maxRounds: 4 }),
      null);
  });
});

// =========================================================================
// chain-resume review dispatch fallback (kusabi #192 finding)
// -------------------------------------------------------------------------
// cmdChainResume used to pass an UNDEFINED review seam for an opencode
// review on a mixed chain (implement claude / review opencode).  runChainDriver
// then fell back to the implement dispatch — the CLAUDE dispatch — so the
// review job silently ran on the claude CLI with the implement's model while
// the round record claimed reviewBackend=opencode.  The driver fallback is
// now backend-aware (resolveReviewDispatch) and the resume wiring always
// passes an explicit review seam (resolveResumeDispatches).
// =========================================================================

describe("chain-resume review dispatch fallback (kusabi #192 finding)", () => {
  const BRIEF = "Implement X.\n\n## Deliverables\n- src/foo.js\n";

  function fakeCallTool() {
    return async (toolName, params) => {
      if (toolName === "verify_in_container") {
        return { gate_passed: true };
      }
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands[0];
      if (cmd.startsWith("cd /workspace &&") && cmd.includes("TMPIDX=")) {
        return { output: "ERROR_NO_INDEX\n" };
      }
      if (cmd === "git rev-parse HEAD") return { output: "abc123\n" };
      if (cmd === "git status --porcelain") return { output: " M src/foo.js\n" };
      if (cmd === "git log --oneline -5") return { output: "abc123 latest change\n" };
      if (cmd === "git diff") return { output: "diff --git a/src/foo.js b/src/foo.js\n" };
      if (cmd === "git ls-files --others --exclude-standard") return { output: "untracked.txt\n" };
      return { output: "" };
    };
  }

  it("resolveReviewDispatch: an undefined review seam on a mixed chain never yields the claude implement dispatch", () => {
    const claudeFake = async () => { throw new Error("review must not reach the claude dispatch"); };
    // The prescribed scenario: undefined review seam + claude implement
    // dispatch + reviewBackend opencode.
    const r = resolveReviewDispatch({
      injectedReviewDispatch: null,
      injectedDispatch: claudeFake,
      backend: "claude",
      reviewBackend: "opencode",
    });
    assert.equal(r, dispatchWithFallback);
    assert.notEqual(r, claudeFake);
  });

  it("resolveReviewDispatch: same-backend chains keep the single dispatch (pre-#192 contract)", () => {
    const fake = async () => {};
    assert.equal(
      resolveReviewDispatch({ injectedReviewDispatch: null, injectedDispatch: fake, backend: "claude", reviewBackend: "claude" }),
      fake,
    );
    assert.equal(
      resolveReviewDispatch({ injectedReviewDispatch: null, injectedDispatch: fake, backend: "opencode", reviewBackend: "opencode" }),
      fake,
    );
  });

  it("resolveReviewDispatch: an explicit review seam wins; reverse mixing falls back to claudeDispatch", () => {
    const fake = async () => {};
    const seam = async () => {};
    assert.equal(
      resolveReviewDispatch({ injectedReviewDispatch: seam, injectedDispatch: fake, backend: "claude", reviewBackend: "opencode" }),
      seam,
    );
    assert.equal(
      resolveReviewDispatch({ injectedReviewDispatch: null, injectedDispatch: fake, backend: "opencode", reviewBackend: "claude" }),
      claudeDispatch,
    );
  });

  it("resolveResumeDispatches: a mixed chain resumes review on the opencode dispatch, never undefined", () => {
    const d = resolveResumeDispatches({
      resumeBackend: "claude",
      resumeReviewBackend: "opencode",
      model: "opus",
      reviewModel: null,
    });
    assert.equal(d.reviewDispatchWithFallback, dispatchWithFallback);
    // The implement seam stays the clamped claude dispatch.
    assert.equal(typeof d.dispatchWithFallback, "function");
    assert.notEqual(d.dispatchWithFallback, dispatchWithFallback);
    assert.notEqual(d.dispatchWithFallback, claudeDispatch);
  });

  it("resolveResumeDispatches: a claude review resumes on the clamped claude dispatch; legacy opencode chains keep today's seams", () => {
    const claude = resolveResumeDispatches({
      resumeBackend: "claude",
      resumeReviewBackend: "claude",
      model: "opus",
      reviewModel: "sonnet",
    });
    assert.equal(typeof claude.reviewDispatchWithFallback, "function");
    assert.notEqual(claude.reviewDispatchWithFallback, dispatchWithFallback);
    assert.notEqual(claude.reviewDispatchWithFallback, claudeDispatch);
    // clampModelDispatch pins the recorded review model (semantics covered by
    // the clampModelDispatch tests; here the wrapper shape is asserted).
    assert.equal(typeof claude.dispatchWithFallback, "function");

    // Pre-#192 chains (no reviewBackend recorded -> falls back to backend):
    // opencode resume keeps the pre-#192 seams — implement seam undefined
    // (driver default dispatchWithFallback), review seam now explicit but
    // identical in effect.
    const legacy = resolveResumeDispatches({
      resumeBackend: "opencode",
      resumeReviewBackend: "opencode",
      model: null,
      reviewModel: null,
    });
    assert.equal(legacy.dispatchWithFallback, undefined);
    assert.equal(legacy.reviewDispatchWithFallback, dispatchWithFallback);
  });

  it("runChainDriver with the buggy seam values (undefined review seam, claude implement, reviewBackend opencode) never sends the review job to the claude dispatch", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-fallback-fix-"));
    const chainDir = path.join(tmp, "chains", "chain-test");
    fs.mkdirSync(chainDir, { recursive: true });
    writeChainControl(chainDir, {
      chainId: "chain-test", container: "cid-1", pid: process.pid,
      status: "running", round: 0, startedAt: new Date().toISOString(),
    });

    let claudeCalls = 0;
    const claudeImplement = async (opts) => {
      claudeCalls += 1;
      if (opts.kind === "task") {
        return {
          job: {
            id: "job-imp-1", status: "completed", modelEntry: "opus",
            modelVariant: null, fallbacks: null, sessionID: "claude-uuid-1",
            usage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            error: null,
          },
          resultText: "implemented",
        };
      }
      throw new Error("review must not reach the claude dispatch");
    };

    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
      model: "opus", modelChain: [["opus"]],
      // Empty review chain: the REAL opencode dispatch (dispatchWithFallback)
      // fails fast with a "No available routes" provider-error job — no
      // serve spawn, no hang — while still proving WHICH dispatch the review
      // phase used: the opencode one, never the claude fake.
      reviewModelChain: [],
      maxRounds: 1,
      brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      callTool: fakeCallTool(),
      backend: "claude", reviewBackend: "opencode",
      dispatchWithFallback: claudeImplement,
      reviewDispatchWithFallback: undefined, // the buggy cmdChainResume seam value
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });

    // The chain stops at review provider exhaustion (the opencode dispatch's
    // empty-chain job), and the claude dispatch was called exactly once: the
    // implement round.  The review job never reached it.
    assert.match(text, /review provider exhausted/);
    assert.match(text, /No available routes/);
    assert.equal(claudeCalls, 1, "the claude dispatch must serve implement only");

    // Records stay truthful: implement claude, review opencode — and the
    // review job id is the opencode dispatch's provider-error job.
    const round1 = readJson(path.join(chainDir, "round-1.json"));
    assert.equal(round1.backend, "claude");
    assert.equal(round1.reviewBackend, "opencode");
    assert.match(round1.reviewJobId, /^no-route-/);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// =========================================================================
// resolveResumeReviewContext — legacy chain.json review-model fallback
// -------------------------------------------------------------------------
// cmdChainResume feeds chain.json's review dispatch context into
// resolveResumeDispatches.  A pre-#192 chain.json has NO reviewModel /
// reviewModelChain keys: key absence is the legacy marker, and the review
// clamp must fall back to the implement model/chain (pre-#192 clamped the
// whole chain to chainJson.model).  A #192-era chain.json may persist null
// on a mixed chain (opencode review) — that null must stay null and never
// silently borrow the implement values.
// =========================================================================
describe("resolveResumeReviewContext (kusabi #192 legacy fallback)", () => {
  it("legacy chain.json (no reviewModel key): the review clamp receives the implement model", () => {
    const legacy = {
      model: "sonnet",
      modelChain: [["opus"]],
    };
    const ctx = resolveResumeReviewContext(legacy);
    assert.equal(ctx.reviewModel, "sonnet", "key absence falls back to the implement model");
    assert.deepEqual(ctx.reviewModelChain, [["opus"]], "key absence falls back to the implement chain");
  });

  it("legacy chain.json with a missing model too: falls back to null, never undefined", () => {
    const ctx = resolveResumeReviewContext({ modelChain: [["opus"]] });
    assert.equal(ctx.reviewModel, null);
    assert.deepEqual(ctx.reviewModelChain, [["opus"]]);
  });

  it("a NEW chain.json persisting reviewModel: null / reviewModelChain: null keeps null (no borrowing from the implement chain)", () => {
    const mixed = {
      model: "opus",
      modelChain: [["opus"]],
      reviewModel: null,
      reviewModelChain: null,
    };
    const ctx = resolveResumeReviewContext(mixed);
    assert.equal(ctx.reviewModel, null, "persisted null must stay null");
    assert.equal(ctx.reviewModelChain, null, "persisted null must stay null");
  });

  it("a NEW chain.json with recorded review values returns them verbatim", () => {
    const mixed = {
      model: "opus",
      modelChain: [["opus"]],
      reviewModel: "deepseek/x",
      reviewModelChain: [["deepseek/x"]],
    };
    const ctx = resolveResumeReviewContext(mixed);
    assert.equal(ctx.reviewModel, "deepseek/x");
    assert.deepEqual(ctx.reviewModelChain, [["deepseek/x"]]);
  });

  it("composition: the legacy fallback feeds resolveResumeDispatches, so a claude review resumes clamped to the implement model", () => {
    const legacy = { model: "sonnet", modelChain: [["opus"]] };
    const ctx = resolveResumeReviewContext(legacy);
    const d = resolveResumeDispatches({
      resumeBackend: "claude",
      resumeReviewBackend: "claude",
      model: legacy.model ?? null,
      reviewModel: ctx.reviewModel,
    });
    // Clamped claude wrapper: neither the raw claude dispatch nor the
    // opencode dispatch — the review pins the recorded (implement) model.
    assert.equal(typeof d.reviewDispatchWithFallback, "function");
    assert.notEqual(d.reviewDispatchWithFallback, claudeDispatch);
    assert.notEqual(d.reviewDispatchWithFallback, dispatchWithFallback);
  });
});

// =========================================================================
// resolveResumeReworkContext — legacy chain.json rework-model fallback
// -------------------------------------------------------------------------
// The rework mirror of resolveResumeReviewContext (kusabi #192 axis 2): a
// pre-axis-2 chain.json has NO reworkModel / reworkModelChain /
// reworkBackend keys — key absence is the legacy marker, and the rework
// rounds continue on the implement model/chain.  A NEW chain.json persists
// the keys (null when no models.phases.rework key was configured), and a
// persisted null must stay null — never silently borrow the implement
// chain.
// =========================================================================

describe("resolveResumeReworkContext (kusabi #192 axis 2 legacy fallback)", () => {
  it("a legacy chain.json (no rework keys) falls back to the implement model and chain", () => {
    const legacy = { model: "sonnet", modelChain: [["opus"], ["claude-sonnet-4-5"]] };
    const ctx = resolveResumeReworkContext(legacy);
    assert.equal(ctx.reworkModel, "sonnet", "key absence falls back to the implement model");
    assert.deepEqual(ctx.reworkModelChain, [["opus"], ["claude-sonnet-4-5"]],
      "key absence falls back to the implement chain");
    assert.equal(ctx.reworkBackend, null, "no implement-side backend to fall back to; caller resolves null → implement backend");
  });

  it("a legacy chain.json without even a model still yields nulls, not undefined", () => {
    const ctx = resolveResumeReworkContext({ modelChain: [["opus"]] });
    assert.equal(ctx.reworkModel, null);
    assert.deepEqual(ctx.reworkModelChain, [["opus"]]);
  });

  it("a NEW chain.json persisting nulls keeps them (no borrowing from the implement chain)", () => {
    const mixed = {
      model: "opus",
      modelChain: [["opus"]],
      reworkModel: null,
      reworkModelChain: null,
      reworkBackend: null,
    };
    const ctx = resolveResumeReworkContext(mixed);
    assert.equal(ctx.reworkModel, null, "persisted null must stay null");
    assert.equal(ctx.reworkModelChain, null, "persisted null must stay null");
    assert.equal(ctx.reworkBackend, null, "persisted null must stay null");
  });

  it("an axis-2 chain.json carries the rework context verbatim", () => {
    const mixed = {
      model: "opus",
      modelChain: [["opus"]],
      reworkModel: "deepseek-v4-flash",
      reworkModelChain: [["opencode-go/deepseek-v4-flash"]],
      reworkBackend: "opencode",
    };
    const ctx = resolveResumeReworkContext(mixed);
    assert.equal(ctx.reworkModel, "deepseek-v4-flash");
    assert.deepEqual(ctx.reworkModelChain, [["opencode-go/deepseek-v4-flash"]]);
    assert.equal(ctx.reworkBackend, "opencode");
  });
});

// =========================================================================
// runChainDriver — rework scheduling by finding kind (kusabi #60 step 2)
// -------------------------------------------------------------------------
// maxRounds buys design/full rounds only; mechanical rounds are free.  The
// round loop derives the budget from the records alone (never persisted),
// stops at the 2 × maxRounds hard cap, and hands deriveDisposition the
// budget-adjusted round ordinal so its max-rounds terminal fires on budget.
// =========================================================================

describe("runChainDriver rework scheduling", () => {
  const BRIEF = "Implement X.\n\n## Deliverables\n- src/foo.js\n";
  const MECH_SENTENCE = "This round resolves ONLY the following mechanical checklist; other known findings are deliberately out of scope this round.";
  const DESIGN_SENTENCE = "This round resolves ONLY the following design finding; other known findings are deliberately out of scope this round.";

  function designFinding(n, file) {
    return { severity: "high", title: "Design decision " + n, file, line_start: 1, kind: "design", body: "b", recommendation: "r" };
  }
  function mechFinding(n, file) {
    return { severity: "medium", title: "Mechanical fix " + n, file, line_start: 10, kind: "mechanical", body: "b", recommendation: "r" };
  }
  function reviewResult(verdict, findings) {
    return JSON.stringify({ verdict, findings, summary: "s" });
  }

  function makeCallTool() {
    return async (toolName, params) => {
      if (toolName === "verify_in_container") return { gate_passed: true };
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands[0];
      if (cmd.startsWith("cd /workspace &&") && cmd.includes("TMPIDX=")) return { output: "ERROR_NO_INDEX\n" };
      if (cmd === "git rev-parse HEAD") return { output: "abc123\n" };
      if (cmd === "git status --porcelain") return { output: " M src/foo.js\n" };
      if (cmd === "git log --oneline -5") return { output: "abc123 latest change\n" };
      if (cmd === "git diff") return { output: "diff --git a/src/foo.js b/src/foo.js\n" };
      if (cmd === "git ls-files --others --exclude-standard") return { output: "untracked.txt\n" };
      return { output: "" };
    };
  }

  // Review results are consumed per review dispatch, in order; implement
  // dispatches always complete.  `calls` records every dispatch option so
  // tests can inspect the implement prompts.
  function makeQueueDispatch(reviewResults) {
    const calls = [];
    let reviewIdx = 0;
    const dispatch = async (opts) => {
      calls.push(opts);
      if (opts.kind === "review") {
        const resultText = reviewResults[Math.min(reviewIdx, reviewResults.length - 1)];
        reviewIdx += 1;
        return {
          job: {
            id: "job-rev-" + reviewIdx, status: "completed", modelEntry: "fake/review",
            modelVariant: null, fallbacks: null, sessionID: "sess-rev-" + reviewIdx,
            usage: { available: true, input: 2, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            error: null,
          },
          resultText,
        };
      }
      if (opts.kind === "task") {
        return {
          job: {
            id: "job-imp-" + (opts.round ?? 1), status: "completed", modelEntry: "fake/model",
            modelVariant: null, fallbacks: null, sessionID: "sess-imp-" + (opts.round ?? 1),
            usage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            error: null,
          },
          resultText: "implemented",
        };
      }
      throw new Error("unexpected dispatch kind: " + opts.kind);
    };
    return { dispatch, calls };
  }

  function runFresh({ maxRounds, reviewResults }) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-sched-"));
    const chainDir = path.join(tmp, "chains", "chain-test");
    fs.mkdirSync(chainDir, { recursive: true });
    writeChainControl(chainDir, {
      chainId: "chain-test", container: "cid-1", pid: process.pid,
      status: "running", round: 0, startedAt: new Date().toISOString(),
    });
    const { dispatch, calls } = makeQueueDispatch(reviewResults);
    return {
      tmp, chainDir, calls,
      run() {
        return runChainDriver({
          cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
          model: "fake/model", modelChain: [["fake/model"]], maxRounds,
          brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
          callTool: makeCallTool(), dispatchWithFallback: dispatch,
          keepServe: true, signalReceived: () => false, resume: null,
        });
      },
    };
  }

  function makeChainState({ records, maxRounds }) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-sched-resume-"));
    const chainDir = path.join(tmp, "chains", "chain-test");
    fs.mkdirSync(chainDir, { recursive: true });
    writeJson(path.join(chainDir, "chain.json"), {
      chainId: "chain-test", container: "cid-1", model: "fake/model",
      modelChain: [["fake/model"]], maxRounds,
      brief: BRIEF, orchestrator: null, records,
      baseSha: "abc123",
      chainTotals: computeChainTotals(records),
      strategized: false, followupIssueDraft: null,
    });
    writeChainControl(chainDir, {
      chainId: "chain-test", container: "cid-1", pid: 0,
      status: "cancelled", round: records.length,
      stopRequestedAt: "2026-08-01T00:00:00.000Z", stopRequestedBy: "cli",
      finishedAt: "2026-08-01T00:00:00.000Z",
    });
    return { tmp, chainDir };
  }

  async function runResume({ chainDir, maxRounds, reviewResults }) {
    const resolution = resolveChainResume({
      control: readChainControl(chainDir),
      chainJson: readJson(path.join(chainDir, "chain.json")),
    });
    assert.equal(resolution.ok, true);
    rearmChainControl({
      chainDir,
      round: resolution.position.phase === "review" ? resolution.position.round : resolution.position.round - 1,
    });
    const { dispatch, calls } = makeQueueDispatch(reviewResults);
    const stateDir = path.dirname(path.dirname(chainDir));
    const text = await runChainDriver({
      cwd: stateDir, stateDir, chainDir,
      chainId: "chain-test", container: "cid-1",
      model: "fake/model", modelChain: [["fake/model"]], maxRounds,
      brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      callTool: makeCallTool(), dispatchWithFallback: dispatch,
      keepServe: true, signalReceived: () => false,
      resume: resolution.position,
    });
    return { text, calls };
  }

  it("runs a mechanical scope round after mixed findings without consuming the design budget", async () => {
    const fx = runFresh({
      maxRounds: 2,
      reviewResults: [
        reviewResult("needs-attention", [designFinding(1, "src/a.js"), mechFinding(1, "src/b.js")]),
        reviewResult("needs-attention", [{ ...mechFinding(2, "src/c.js"), severity: "high" }]),
        reviewResult("approve", []),
      ],
    });
    try {
      const text = await fx.run();
      assert.match(text, /accepted at round 3/);

      const round1 = readJson(path.join(fx.chainDir, "round-1.json"));
      assert.equal(round1.reworkScope, "full");
      const round2 = readJson(path.join(fx.chainDir, "round-2.json"));
      assert.equal(round2.reworkScope, "mechanical");
      // Round 2 is a free round: it sits at budget position 1 (not 2), so
      // needs-attention reworks instead of hitting the max-rounds terminal.
      assert.equal(round2.disposition.disposition, "rework");
      const round3 = readJson(path.join(fx.chainDir, "round-3.json"));
      assert.equal(round3.reworkScope, "mechanical");
      assert.equal(round3.disposition.disposition, "accept");

      // Round 2's implement brief is the scoped mechanical checklist: the
      // design finding is deliberately held back.
      const imp2 = fx.calls.find((c) => c.kind === "task" && c.round === 2);
      assert.ok(imp2, "round 2 implement must be dispatched");
      assert.ok(imp2.promptText.includes(MECH_SENTENCE));
      assert.ok(imp2.promptText.includes("Mechanical fix 1"));
      assert.ok(!imp2.promptText.includes("Design decision 1"));

      const control = readChainControl(fx.chainDir);
      assert.equal(control.status, "completed");
      assert.equal(control.round, 3);
    } finally {
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("repeated mixed reviews alternate mechanical/design (never two mechanical in a row) and the design round consumes budget", async () => {
    // Followup: after a mechanical round, a mixed set schedules the design
    // finding instead of a second mechanical batch.  With maxRounds=2 the
    // chain must run full -> mechanical -> design and then escalate when the
    // design round exhausts the budget at round 3 — never a 4-round
    // mechanical tail ending on the 2 x maxRounds hard cap.
    const fx = runFresh({
      maxRounds: 2,
      reviewResults: [
        reviewResult("needs-attention", [designFinding(1, "src/a.js"), mechFinding(1, "src/b.js")]),
        reviewResult("needs-attention", [designFinding(2, "src/c.js"), mechFinding(2, "src/d.js")]),
        reviewResult("needs-attention", [designFinding(3, "src/e.js"), mechFinding(3, "src/f.js")]),
        reviewResult("needs-attention", [designFinding(4, "src/g.js"), mechFinding(4, "src/h.js")]),
      ],
    });
    try {
      const text = await fx.run();
      // Round 3 is the design round at budget position 2 of 2, so the
      // max-rounds terminal fires there.
      assert.match(text, /escalated at round 3: max rounds \(2\) reached without acceptance/);

      const round1 = readJson(path.join(fx.chainDir, "round-1.json"));
      assert.equal(round1.reworkScope, "full");
      assert.equal(round1.disposition.disposition, "rework");
      const round2 = readJson(path.join(fx.chainDir, "round-2.json"));
      assert.equal(round2.reworkScope, "mechanical");
      assert.equal(round2.disposition.disposition, "rework");
      const round3 = readJson(path.join(fx.chainDir, "round-3.json"));
      assert.equal(round3.reworkScope, "design");
      // The design round consumed the last budget slot: escalate, not rework.
      assert.equal(round3.disposition.disposition, "escalate");
      // No second mechanical round after round 2, no round 4 at all.
      assert.equal(fs.existsSync(path.join(fx.chainDir, "round-4.json")), false);
      assert.equal(fx.calls.filter((c) => c.kind === "task").length, 3);

      // Round 3's brief is the design scope over round 2's findings (the
      // previous record) with the FULL per-finding rendering (followup):
      // heading with severity/location, not the one-line
      // "[high] Design decision 2 (src/c.js:1)" row.
      const imp3 = fx.calls.find((c) => c.kind === "task" && c.round === 3);
      assert.ok(imp3, "round 3 implement must be dispatched");
      assert.ok(imp3.promptText.includes(DESIGN_SENTENCE));
      assert.ok(imp3.promptText.includes("### [high] Design decision 2 (src/c.js:1)"));
      assert.ok(imp3.promptText.includes("Design decision 2"));
      assert.ok(!imp3.promptText.includes("Mechanical fix 2"));

      const control = readChainControl(fx.chainDir);
      assert.equal(control.status, "completed");
      assert.equal(control.round, 3);
    } finally {
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("repeated mixed reviews keep alternating across several rounds and stop inside the 2 x maxRounds hard cap", async () => {
    // maxRounds=3: the chain must alternate full, mechanical, design,
    // mechanical, design and escalate at round 5 when the second design
    // round exhausts the budget (position 3 of 3) — inside the hard cap of
    // 6, with round 6 never started.
    const fx = runFresh({
      maxRounds: 3,
      reviewResults: [
        reviewResult("needs-attention", [designFinding(1, "src/a.js"), mechFinding(1, "src/b.js")]),
        reviewResult("needs-attention", [designFinding(2, "src/c.js"), mechFinding(2, "src/d.js")]),
        reviewResult("needs-attention", [designFinding(3, "src/e.js"), mechFinding(3, "src/f.js")]),
        reviewResult("needs-attention", [designFinding(4, "src/g.js"), mechFinding(4, "src/h.js")]),
        reviewResult("needs-attention", [designFinding(5, "src/i.js"), mechFinding(5, "src/j.js")]),
        reviewResult("approve", []),
      ],
    });
    try {
      const text = await fx.run();
      assert.match(text, /escalated at round 5: max rounds \(3\) reached without acceptance/);

      const scopes = [];
      for (let r = 1; r <= 5; r++) {
        const rec = readJson(path.join(fx.chainDir, "round-" + r + ".json"));
        scopes.push(rec.reworkScope);
      }
      // full, mechanical, design, mechanical, design — never two mechanical
      // in a row across five rounds of mixed reviews.
      assert.deepEqual(scopes, ["full", "mechanical", "design", "mechanical", "design"]);
      // Hard cap (2 x maxRounds = 6) respected: the budget exhausted first.
      assert.equal(fs.existsSync(path.join(fx.chainDir, "round-6.json")), false);
      assert.equal(fx.calls.filter((c) => c.kind === "task").length, 5);

      const control = readChainControl(fx.chainDir);
      assert.equal(control.status, "completed");
      assert.equal(control.round, 5);
    } finally {
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("a chain of only full rounds behaves exactly as today (same rounds, same disposition)", async () => {
    const fx = runFresh({
      maxRounds: 4,
      reviewResults: [
        reviewResult("needs-attention", []),
        reviewResult("needs-attention", []),
        reviewResult("needs-attention", []),
        reviewResult("needs-attention", []),
      ],
    });
    try {
      const text = await fx.run();
      // Round 4 hits the max-rounds terminal inside deriveDisposition and
      // escalates — the same terminal and wording as the pre-scheduling loop.
      assert.match(text, /escalated at round 4: max rounds \(4\) reached without acceptance/);

      for (let r = 1; r <= 4; r++) {
        const rec = readJson(path.join(fx.chainDir, "round-" + r + ".json"));
        assert.equal(rec.reworkScope, "full");
        if (r < 4) {
          assert.equal(rec.disposition.disposition, "rework");
        } else {
          // The max-rounds terminal fires on BUDGET at the final full round,
          // exactly as the pre-scheduling loop did on the raw round number.
          assert.equal(rec.disposition.disposition, "escalate");
          assert.match(rec.disposition.reason, /max rounds \(4\) reached without acceptance/);
        }
      }
      // No extra mechanical rounds: every round consumed budget, so the loop
      // stopped after maxRounds rounds exactly like today.
      assert.equal(fx.calls.filter((c) => c.kind === "task").length, 4);
      assert.equal(fs.existsSync(path.join(fx.chainDir, "round-5.json")), false);

      const control = readChainControl(fx.chainDir);
      assert.equal(control.status, "completed");
      assert.equal(control.round, 4);
    } finally {
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("the 2 × maxRounds hard cap terminates a mechanical-only tail via the max-rounds path", async () => {
    const fx = runFresh({
      maxRounds: 2,
      reviewResults: [
        reviewResult("needs-attention", [designFinding(1, "src/a.js"), mechFinding(1, "src/b.js")]),
        reviewResult("needs-attention", [{ ...mechFinding(2, "src/c.js"), severity: "high" }]),
        reviewResult("needs-attention", [{ ...mechFinding(3, "src/d.js"), severity: "high" }]),
        reviewResult("needs-attention", [{ ...mechFinding(4, "src/e.js"), severity: "high" }]),
      ],
    });
    try {
      const text = await fx.run();
      assert.match(text, /reached max rounds \(2\) without acceptance/);

      // Four rounds ran with maxRounds=2 (1 full + 3 free mechanical rounds);
      // the 2 × maxRounds hard cap stopped the loop, not the budget.
      assert.equal(fx.calls.filter((c) => c.kind === "task").length, 4);
      assert.equal(fs.existsSync(path.join(fx.chainDir, "round-5.json")), false);

      const round1 = readJson(path.join(fx.chainDir, "round-1.json"));
      assert.equal(round1.reworkScope, "full");
      assert.equal(round1.disposition.disposition, "rework");
      for (let r = 2; r <= 4; r++) {
        const rec = readJson(path.join(fx.chainDir, "round-" + r + ".json"));
        assert.equal(rec.reworkScope, "mechanical");
        // Still at budget position 1 — never escalates on budget.
        assert.equal(rec.disposition.disposition, "rework");
      }

      const control = readChainControl(fx.chainDir);
      assert.equal(control.status, "completed");
      // The max-rounds terminal records the ACTUAL last round (4), never the
      // nominal maxRounds (2) — control.round and the review record must
      // agree with the persisted round-N.json files (kusabi #60 step 2 review).
      assert.equal(control.round, 4);
      const recordText = fs.readFileSync(path.join(fx.chainDir, "review-record.md"), "utf8");
      assert.match(recordText, /Final disposition: max-rounds at round 4 of 2/);
    } finally {
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("a resumed chain recomputes the budget from records alone (no new persisted state)", async () => {
    const r1 = {
      round: 1, reworkScope: "full", resumeMethod: { type: "fresh_session" },
      startedAt: "2026-08-01T00:00:00.000Z", verdict: "needs-attention", probesGreen: true,
      modelEntry: "fake/model", modelVariant: null, fallbacks: null,
      implementJobId: "job-imp-1", reviewJobId: "job-rev-1", sessionID: "sess-1",
      implementUsage: null, reviewUsage: null, tierBefore: 0, tierAfter: 0, reworkCount: 0,
      pendingReworkStrategy: { tierDelta: 0, newSession: false, reason: "1st rework: same tier, continue session, keep artifacts" },
      disposition: { disposition: "rework", reason: "needs-attention" },
      findings: [designFinding(1, "src/a.js"), mechFinding(1, "src/b.js")],
      findingFiles: ["src/a.js", "src/b.js"],
      findingsText: "mixed findings",
    };
    const r2 = {
      round: 2, reworkScope: "mechanical", resumeMethod: { type: "continue_session" },
      startedAt: "2026-08-01T00:00:00.000Z", verdict: "needs-attention", probesGreen: true,
      modelEntry: "fake/model", modelVariant: null, fallbacks: null,
      implementJobId: "job-imp-2", reviewJobId: "job-rev-2", sessionID: "sess-2",
      implementUsage: null, reviewUsage: null, tierBefore: 0, tierAfter: 0, reworkCount: 1,
      pendingReworkStrategy: { tierDelta: 0, newSession: false, reason: "1st rework: same tier, continue session, keep artifacts" },
      disposition: { disposition: "rework", reason: "needs-attention" },
      findings: [mechFinding(2, "src/c.js")],
      findingFiles: ["src/c.js"],
      findingsText: "mechanical findings",
    };
    const { tmp, chainDir } = makeChainState({ records: [r1, r2], maxRounds: 4 });
    try {
      const { text, calls } = await runResume({ chainDir, maxRounds: 4, reviewResults: [reviewResult("approve", [])] });
      assert.match(text, /accepted at round 3/);

      // The resumed round's scope is re-derived from round 2's
      // mechanical-only findings — no persisted budget state is consulted.
      const round3 = readJson(path.join(chainDir, "round-3.json"));
      assert.equal(round3.reworkScope, "mechanical");
      assert.equal(round3.disposition.disposition, "accept");

      const imp3 = calls.find((c) => c.kind === "task" && c.round === 3);
      assert.ok(imp3, "round 3 implement must be dispatched");
      assert.ok(imp3.promptText.includes(MECH_SENTENCE));
      assert.ok(!imp3.promptText.includes("Design decision 1"));

      const chainJson = readJson(path.join(chainDir, "chain.json"));
      assert.equal(chainJson.records.length, 3);
      // Budget is derived by counting records, never persisted.
      assert.equal(chainJson.budgetUsed, undefined);

      const control = readChainControl(chainDir);
      assert.equal(control.status, "completed");
      assert.equal(control.round, 3);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("resumes a mechanical-tail chain whose raw round count exceeds maxRounds while budget remains", async () => {
    // maxRounds=2; round 1 full (mixed findings), round 2 mechanical
    // (mechanical-only findings), both rework — chain cancelled after round 2.
    // Budget used = 1 < 2, so the RESUME GATE (kusabi #60 step 2 review) must
    // admit the chain even though nextRound 3 > maxRounds 2, and the driver
    // must run rounds 3-4 (the 2 × maxRounds hard cap).
    const r1 = {
      round: 1, reworkScope: "full", resumeMethod: { type: "fresh_session" },
      startedAt: "2026-08-01T00:00:00.000Z", verdict: "needs-attention", probesGreen: true,
      modelEntry: "fake/model", modelVariant: null, fallbacks: null,
      implementJobId: "job-imp-1", reviewJobId: "job-rev-1", sessionID: "sess-1",
      implementUsage: null, reviewUsage: null, tierBefore: 0, tierAfter: 0, reworkCount: 0,
      pendingReworkStrategy: { tierDelta: 0, newSession: false, reason: "1st rework: same tier, continue session, keep artifacts" },
      disposition: { disposition: "rework", reason: "needs-attention" },
      findings: [designFinding(1, "src/a.js"), mechFinding(1, "src/b.js")],
      findingFiles: ["src/a.js", "src/b.js"],
      findingsText: "mixed findings",
    };
    const r2 = {
      round: 2, reworkScope: "mechanical", resumeMethod: { type: "continue_session" },
      startedAt: "2026-08-01T00:00:00.000Z", verdict: "needs-attention", probesGreen: true,
      modelEntry: "fake/model", modelVariant: null, fallbacks: null,
      implementJobId: "job-imp-2", reviewJobId: "job-rev-2", sessionID: "sess-2",
      implementUsage: null, reviewUsage: null, tierBefore: 0, tierAfter: 0, reworkCount: 1,
      pendingReworkStrategy: { tierDelta: 0, newSession: false, reason: "1st rework: same tier, continue session, keep artifacts" },
      disposition: { disposition: "rework", reason: "needs-attention" },
      findings: [{ ...mechFinding(2, "src/c.js"), severity: "high" }],
      findingFiles: ["src/c.js"],
      findingsText: "mechanical findings",
    };
    const { tmp, chainDir } = makeChainState({ records: [r1, r2], maxRounds: 2 });
    try {
      const { text, calls } = await runResume({
        chainDir, maxRounds: 2,
        reviewResults: [
          reviewResult("needs-attention", [{ ...mechFinding(3, "src/d.js"), severity: "high" }]),
          reviewResult("approve", []),
        ],
      });
      assert.match(text, /accepted at round 4/);

      // The resumed run continued to raw round 4 with budget 1 of 2, then the
      // 2 × maxRounds hard cap ended the loop (round 5 never ran).
      const round3 = readJson(path.join(chainDir, "round-3.json"));
      assert.equal(round3.reworkScope, "mechanical");
      assert.equal(round3.disposition.disposition, "rework");
      const round4 = readJson(path.join(chainDir, "round-4.json"));
      assert.equal(round4.reworkScope, "mechanical");
      assert.equal(round4.disposition.disposition, "accept");
      assert.equal(fs.existsSync(path.join(chainDir, "round-5.json")), false);

      // Round 3's implement brief is the scoped mechanical checklist.
      const imp3 = calls.find((c) => c.kind === "task" && c.round === 3);
      assert.ok(imp3, "round 3 implement must be dispatched");
      assert.ok(imp3.promptText.includes(MECH_SENTENCE));

      const chainJson = readJson(path.join(chainDir, "chain.json"));
      assert.equal(chainJson.records.length, 4);
      const control = readChainControl(chainDir);
      assert.equal(control.status, "completed");
      assert.equal(control.round, 4);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a review-resume completes the interrupted round even when it spent the last budget slot", async () => {
    const complete = (round) => ({
      round, reworkScope: "full", resumeMethod: { type: "fresh_session" },
      startedAt: "2026-08-01T00:00:00.000Z", verdict: "needs-attention", probesGreen: true,
      modelEntry: "fake/model", modelVariant: null, fallbacks: null,
      implementJobId: "job-imp-" + round, reviewJobId: "job-rev-" + round, sessionID: "sess-" + round,
      implementUsage: null, reviewUsage: null, tierBefore: 0, tierAfter: 0, reworkCount: round - 1,
      pendingReworkStrategy: { tierDelta: 0, newSession: false, reason: "1st rework: same tier" },
      disposition: { disposition: "rework", reason: "needs-attention" },
      findings: [], findingFiles: [], findingsText: "(no structured findings)",
    });
    const partial = {
      round: 4, reworkScope: "full", resumeMethod: { type: "continue_session" },
      startedAt: "2026-08-01T00:00:00.000Z", verdict: null, probesGreen: true,
      modelEntry: "fake/model", modelVariant: null, fallbacks: null,
      implementJobId: "job-imp-4", sessionID: "sess-4", implementUsage: null,
      tierBefore: 0, reworkCount: 3,
      probeResults: [{ probe: "P1: HEAD clean", passed: true, detail: "ok" }],
      worktreeChanged: true, interrupted: true, interruptedAfter: "probes",
    };
    const { tmp, chainDir } = makeChainState({ records: [complete(1), complete(2), complete(3), partial], maxRounds: 4 });
    try {
      const { text } = await runResume({ chainDir, maxRounds: 4, reviewResults: [reviewResult("approve", [])] });
      assert.match(text, /accepted at round 4/);

      const round4 = readJson(path.join(chainDir, "round-4.json"));
      assert.equal(round4.disposition.disposition, "accept");
      assert.equal(round4.resumed, true);
      assert.equal(round4.reworkScope, "full");

      const control = readChainControl(chainDir);
      assert.equal(control.status, "completed");
      assert.equal(control.round, 4);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
