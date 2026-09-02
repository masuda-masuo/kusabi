import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { dispatchWithFallback } from "./prompt-execution.mjs";
import { claudeDispatch } from "./claude-dispatch.mjs";
import { createFakeCallTool } from "./fixtures.mjs";
import { saveJob } from "./job-store.mjs";
import {
  runChainDriver,
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
import { computeChainTotals } from "./chain-phases.mjs";
import { resolveChainResume } from "./chain-resume-resolve.mjs";
import { readJson, writeJson } from "./state-paths.mjs";
import { renderChainShow } from "./render.mjs";
import { TERMINAL_DISPOSITIONS } from "./chain-wait.mjs";


/** Valid change-scope JSON for driver mocks (kusabi #379). Production must not fabricate this. */
function fakeChangeScopeResult(params) {
  const cmd = params?.commands?.[0] ?? params?.argv?.join(" ") ?? "";
  if (typeof cmd === "string" && cmd.includes("change-scope.mjs")) {
    return {
      output: JSON.stringify({
        formatVersion: 1,
        repositoryRoot: "/workspace",
        input: { base: "abc123", head: "HEAD" },
        resolved: { baseSha: "abc123", headSha: "abc123", mergeBaseSha: "abc123" },
        paths: { committed: [], staged: [], unstaged: [], untracked: [] },
      }),
    };
  }
  return null;
}
// sessionProvenanceRefusal — the agy --session chain-start gate (kusabi #321)
// ---------------------------------------------------------------------------
// The refusal decision is pure and exported so every case is testable
// without running a chain: an agy implement phase plus a session whose
// provenance is not provably agy refuses, everything else passes.  The gate
// is on the PROPERTY, never on the --session flag: an id the caller
// resolved FROM the job store arrives with its owner record and is provable

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
      const scope = fakeChangeScopeResult(params);
      if (scope) return scope;
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
    reviewResult = JSON.stringify({ schema_version: 1, verdict: "approve", findings: [], summary: "ok", next_steps: [] }),
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
      probesGreen: false,
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
    // The finding has to be NAMED: since kusabi #299 a needs-attention that
    // names nothing over green probes escalates instead of reworking, and
    // this test is about the rework ladder, not about that row.
    const dispatch = makeFakeDispatch({
      reviewResult: JSON.stringify({
        schema_version: 1,
        verdict: "needs-attention",
        summary: "s",
        findings: [{ severity: "medium", title: "Still broken", body: "b", recommendation: "r", confidence: 0.8, line_start: 1, line_end: 1, file: "src/foo.js" }],
        next_steps: [],
      }),
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

    // A cancelled chain post-probe produces a provisional review record (issue #357)
    assert.equal(fs.existsSync(path.join(chainDir, "review-record.md")), true);
    assert.match(text, /review record: .*review-record\.md/);

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
      const scope = fakeChangeScopeResult(params);
      if (scope) return scope;
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

    assert.match(text, /escalated at round 1: empty round discarded by probe; worktree CLEAN vs the chain base/);
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
        const scope = fakeChangeScopeResult(params);
        if (scope) return scope;
        execCalls.push(params.commands?.[0] ?? params.argv?.join(" ") ?? "");
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
    // The re-validation set is the FULL probe set: P5/P6 are re-measured with
    // the rest (kusabi #197 follow-up), so a violation that landed in the gap
    // cannot reach an accept.
    assert.deepEqual(
      round1.probeResults.map((p) => p.probe),
      ["P1: HEAD clean", "P2: verify gate", "P3: deliverables", "P4: smoke", "P5: frozen", "P6: collected"],
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
      probesGreen: false,
      modelEntry: "fake/model",
      modelVariant: null,
      fallbacks: null,
      implementJobId: "job-imp-3",
      sessionID: "sess-3",
      implementUsage: null,
      tierBefore: 0,
      reworkStrategyReason: null,
      reworkCount: 0,
      probeResults: [{ probe: "P1: HEAD clean", passed: false, detail: "recorded before the stop" }],
      worktreeChanged: true,
      interrupted: true,
      interruptedAfter: "probes",
    };
    const { chainDir } = makeChainState({ records: [partial] });
    const callTool = probeCountingCallTool();
    // The resumed review finds a problem => rework; the next
    // round's implement hits provider exhaustion so the chain stops there.
    const dispatch = makeFakeDispatch({
      reviewResult: JSON.stringify({
        schema_version: 1,
        verdict: "needs-attention",
        summary: "s",
        findings: [{ severity: "medium", title: "t", body: "fix the parser", recommendation: "r", confidence: 0.8, line_start: 1, line_end: 1, file: "src/foo.js" }],
        next_steps: [],
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
    assert.equal(round3.probesGreen, false);
    assert.deepEqual(round3.probeResults, [
      { probe: "P1: HEAD clean", passed: false, detail: "recorded before the stop" },
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
  const APPROVE = JSON.stringify({ schema_version: 1, verdict: "approve", findings: [], summary: "ok", next_steps: [] });
  const REWORK = JSON.stringify({
    schema_version: 1,
    verdict: "needs-attention",
    summary: "s",
    findings: [{ severity: "medium", title: "t", body: "fix the parser", recommendation: "fix", confidence: 0.8, line_start: 1, line_end: 1, file: "src/foo.js" }],
    next_steps: [],
  });

  function fakeCallTool({ statusOutput = " M src/foo.js\n", gatePassedSequence } = {}) {
    let verifyCount = 0;
    return async (toolName, params) => {
      if (toolName === "verify_in_container") {
        verifyCount += 1;
        if (Array.isArray(gatePassedSequence)) {
          return { gate_passed: gatePassedSequence[verifyCount - 1] ?? true };
        }
        return { gate_passed: false };
      }
      if (toolName !== "sandbox_exec") return { output: "" };
      const scope = fakeChangeScopeResult(params);
      if (scope) return scope;
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
      callTool: fakeCallTool({ gatePassedSequence: [true] }),
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
      callTool: fakeCallTool({ gatePassedSequence: [false, true] }),
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
        callTool: fakeCallTool({ gatePassedSequence: [true] }),
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
  const APPROVE = JSON.stringify({ schema_version: 1, verdict: "approve", findings: [], summary: "ok", next_steps: [] });
  const REWORK = JSON.stringify({
    schema_version: 1,
    verdict: "needs-attention",
    summary: "s",
    findings: [{ severity: "medium", title: "t", body: "fix the parser", recommendation: "fix", confidence: 0.8, line_start: 1, line_end: 1, file: "src/foo.js" }],
    next_steps: [],
  });

  function fakeCallTool({ statusOutput = " M src/foo.js\n", gatePassedSequence } = {}) {
    let verifyCount = 0;
    return async (toolName, params) => {
      if (toolName === "verify_in_container") {
        verifyCount += 1;
        if (Array.isArray(gatePassedSequence)) {
          return { gate_passed: gatePassedSequence[verifyCount - 1] ?? true };
        }
        return { gate_passed: false };
      }
      if (toolName !== "sandbox_exec") return { output: "" };
      const scope = fakeChangeScopeResult(params);
      if (scope) return scope;
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
      callTool: fakeCallTool({ gatePassedSequence: [false, true] }),
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
      callTool: fakeCallTool({ gatePassedSequence: [false, true] }),
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
      schema_version: 1,
      verdict: "needs-attention",
      summary: "s",
      findings: [{ severity: "medium", title: "t", body: "fix the parser", recommendation: "r", confidence: 0.8, line_start: 1, line_end: 1, file: "src/a.js" }],
      next_steps: [],
    });
    const reworkB = JSON.stringify({
      schema_version: 1,
      verdict: "needs-attention",
      summary: "s",
      findings: [{ severity: "medium", title: "t", body: "fix the parser", recommendation: "r", confidence: 0.8, line_start: 1, line_end: 1, file: "src/b.js" }],
      next_steps: [],
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
      callTool: fakeCallTool({ gatePassedSequence: [false, false, true] }),
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
      schema_version: 1,
      verdict: "needs-attention",
      summary: "s",
      findings: [{ severity: "medium", title: "t", body: "fix the parser", recommendation: "r", confidence: 0.8, line_start: 1, line_end: 1, file: "src/a.js" }],
      next_steps: [],
    });
    const reworkB = JSON.stringify({
      schema_version: 1,
      verdict: "needs-attention",
      summary: "s",
      findings: [{ severity: "medium", title: "t", body: "fix the parser", recommendation: "r", confidence: 0.8, line_start: 1, line_end: 1, file: "src/b.js" }],
      next_steps: [],
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
      callTool: fakeCallTool({ gatePassedSequence: [false, false, true] }),
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
        callTool: fakeCallTool({ gatePassedSequence: [true] }),
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
      schema_version: 1,
      verdict: "needs-attention",
      summary: "s",
      findings: [{ severity: "medium", title: "t", body: "fix the parser", recommendation: "r", confidence: 0.8, line_start: 1, line_end: 1, file: "src/a.js" }],
      next_steps: [],
    });
    const reworkB = JSON.stringify({
      schema_version: 1,
      verdict: "needs-attention",
      summary: "s",
      findings: [{ severity: "medium", title: "t", body: "fix the parser", recommendation: "r", confidence: 0.8, line_start: 1, line_end: 1, file: "src/b.js" }],
      next_steps: [],
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
      callTool: fakeCallTool({ gatePassedSequence: [false, false, true] }),
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
      schema_version: 1,
      verdict: "needs-attention",
      summary: "s",
      findings: [{ severity: "medium", title: "t", body: "fix the parser", recommendation: "r", confidence: 0.8, line_start: 1, line_end: 1, file: "src/a.js" }],
      next_steps: [],
    });
    const reworkB = JSON.stringify({
      schema_version: 1,
      verdict: "needs-attention",
      summary: "s",
      findings: [{ severity: "medium", title: "t", body: "fix the parser", recommendation: "r", confidence: 0.8, line_start: 1, line_end: 1, file: "src/b.js" }],
      next_steps: [],
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
      callTool: fakeCallTool({ gatePassedSequence: [false, false, true] }),
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
      const scope = fakeChangeScopeResult(params);
      if (scope) return scope;
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
    return { severity: "medium", title: "Design decision " + n, file, line_start: 1, line_end: 1, confidence: 0.8, kind: "design", body: "b", recommendation: "r" };
  }
  function mechFinding(n, file) {
    return { severity: "medium", title: "Mechanical fix " + n, file, line_start: 10, line_end: 10, confidence: 0.8, kind: "mechanical", body: "b", recommendation: "r" };
  }
  function reviewResult(verdict, findings) {
    return JSON.stringify({ schema_version: 1, verdict, findings, summary: "s", next_steps: [] });
  }

  // `gatePassed: false` makes P2 red, which is what a probe-failure rework
  // (the "full" scope, per resolveReworkScope) actually looks like.
  function makeCallTool({ gatePassed = false, gatePassedSequence } = {}) {
    let verifyCount = 0;
    return async (toolName, params) => {
      if (toolName === "verify_in_container") {
        verifyCount += 1;
        if (Array.isArray(gatePassedSequence)) {
          return { gate_passed: gatePassedSequence[verifyCount - 1] ?? true };
        }
        return { gate_passed: gatePassed };
      }
      if (toolName !== "sandbox_exec") return { output: "" };
      const scope = fakeChangeScopeResult(params);
      if (scope) return scope;
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

  function runFresh({ maxRounds, reviewResults, callTool = makeCallTool({ gatePassedSequence: [false, false, false, true] }) }) {
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
          callTool, dispatchWithFallback: dispatch,
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

  async function runResume({ chainDir, maxRounds, reviewResults, callTool = makeCallTool({ gatePassedSequence: [true] }) }) {
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
      callTool, dispatchWithFallback: dispatch,
      keepServe: true, signalReceived: () => false,
      resume: resolution.position,
    });
    return { text, calls };
  }

  it("runs a mechanical scope round after mixed findings without consuming the design budget", async () => {
    const fx = runFresh({
      maxRounds: 2,
      callTool: makeCallTool({ gatePassedSequence: [false, false, true] }),
      reviewResults: [
        reviewResult("needs-attention", [designFinding(1, "src/a.js"), mechFinding(1, "src/b.js")]),
        reviewResult("needs-attention", [{ ...mechFinding(2, "src/c.js"), severity: "medium" }]),
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
      assert.ok(imp3.promptText.includes("### [medium] Design decision 2 (src/c.js:1)"));
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
      callTool: makeCallTool({ gatePassed: false }),
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
      // A "full" round IS the probe-failure rework (resolveReworkScope: no
      // structured findings → the whole prior findingsText), so the red gate
      // is what makes this the full-round chain the test is about.  Since
      // kusabi #299, needs-attention naming nothing over GREEN probes is an
      // incomplete review and escalates instead of reworking.
      callTool: makeCallTool({ gatePassed: false }),
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
      callTool: makeCallTool({ gatePassed: false }),
      reviewResults: [
        reviewResult("needs-attention", [designFinding(1, "src/a.js"), mechFinding(1, "src/b.js")]),
        reviewResult("needs-attention", [{ ...mechFinding(2, "src/c.js"), severity: "medium" }]),
        reviewResult("needs-attention", [{ ...mechFinding(3, "src/d.js"), severity: "medium" }]),
        reviewResult("needs-attention", [{ ...mechFinding(4, "src/e.js"), severity: "medium" }]),
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
      findings: [{ ...mechFinding(2, "src/c.js"), severity: "medium" }],
      findingFiles: ["src/c.js"],
      findingsText: "mechanical findings",
    };
    const { tmp, chainDir } = makeChainState({ records: [r1, r2], maxRounds: 2 });
    try {
      const { text, calls } = await runResume({
        chainDir, maxRounds: 2,
        callTool: makeCallTool({ gatePassedSequence: [false, true] }),
        reviewResults: [
          reviewResult("needs-attention", [{ ...mechFinding(3, "src/d.js"), severity: "medium" }]),
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


// =========================================================================
// runChainDriver — P5/P6 oracle routing (kusabi #197)
// -------------------------------------------------------------------------
// A frozen-test edit or a drop in the collected test count must terminate the
// round as `escalate` with the violation named — never a rework, never an
// accept, whatever the reviewer said.  These drive the real round loop so the
// wiring from probe → round record → deriveDisposition is covered end to end.
// =========================================================================

describe("runChainDriver oracle routing", () => {
  const FROZEN_BRIEF = [
    "Implement X.",
    "",
    "## Deliverables",
    "- src/foo.js",
    "",
    "## Frozen Tests (do not touch)",
    "- tests/frozen.test.mjs",
    "",
  ].join("\n");

  const PLAIN_BRIEF = "Implement X.\n\n## Deliverables\n- src/foo.js\n";

  function oracleCallTool({ statusOutput, verifyResult }) {
    return async (toolName, params) => {
      if (toolName === "verify_in_container") return verifyResult;
      if (toolName !== "sandbox_exec") return { output: "" };
      const scope = fakeChangeScopeResult(params);
      if (scope) return scope;
      const cmd = params.commands[0];
      // captureWorktreeState: capture failure → baseline null (graceful)
      if (cmd.startsWith("cd /workspace &&") && cmd.includes("TMPIDX=")) {
        return { output: "ERROR_NO_INDEX\n" };
      }
      if (cmd === "git rev-parse HEAD") return { output: "abc123\n" };
      if (cmd === "git status --porcelain") return { output: statusOutput };
      if (cmd === "git log --oneline -5") return { output: "abc123 latest change\n" };
      if (cmd === "git ls-files --others --exclude-standard") return { output: "" };
      return { output: "" };
    };
  }

  // The reviewer APPROVES in every case below: the oracle must override it.
  function approvingDispatch() {
    return async (opts) => {
      if (opts.kind === "review") {
        return {
          job: {
            id: "job-rev-1", status: "completed", modelEntry: "fake/review", modelVariant: null,
            fallbacks: null, sessionID: "sess-rev", usage: null, error: null,
          },
          resultText: JSON.stringify({ schema_version: 1, verdict: "approve", findings: [], summary: "ok", next_steps: [] }),
        };
      }
      return {
        job: {
          id: "job-imp-1", status: "completed", modelEntry: "fake/model", modelVariant: null,
          fallbacks: null, sessionID: "sess-imp-1", usage: null, error: null,
        },
        resultText: "implemented",
      };
    };
  }

  async function runFreshChain({ brief, statusOutput, verifyResult, verifyBaseline }) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-oracle-"));
    const chainDir = path.join(tmp, "chains", "chain-oracle");
    fs.mkdirSync(chainDir, { recursive: true });
    writeChainControl(chainDir, {
      chainId: "chain-oracle", container: "cid-1", pid: process.pid,
      status: "running", round: 0, startedAt: new Date().toISOString(),
    });
    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-oracle", container: "cid-1",
      model: "fake/model", modelChain: [["fake/model"]], maxRounds: 4,
      brief, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      verifyBaseline,
      callTool: oracleCallTool({ statusOutput, verifyResult }),
      dispatchWithFallback: approvingDispatch(),
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });
    return { tmp, chainDir, text };
  }

  const GREEN_VERIFY = {
    gate_passed: true, lint: [], types: [],
    tests: { full: { status: "ok", passed: 10, total: 10 } },
  };
  const GREEN_BASELINE = { captured: true, gate_passed: true, lint: 0, types: 0, collected: 10, raw: {} };

  it("escalates (never reworks, never accepts) when the round touched a frozen path", async () => {
    const { tmp, chainDir, text } = await runFreshChain({
      brief: FROZEN_BRIEF,
      statusOutput: " M src/foo.js\n M tests/frozen.test.mjs\n",
      verifyResult: GREEN_VERIFY,
      verifyBaseline: GREEN_BASELINE,
    });
    try {
      // The reviewer approved; the oracle overrides it and names the path.
      assert.match(text, /escalated at round 1/);
      assert.match(text, /oracle violation/);
      assert.match(text, /tests\/frozen\.test\.mjs/);

      const round1 = readJson(path.join(chainDir, "round-1.json"));
      assert.equal(round1.verdict, "approve");
      assert.equal(round1.disposition.disposition, "escalate");
      const p5 = round1.probeResults.find((p) => p.probe === "P5: frozen");
      assert.equal(p5.passed, false);
      assert.match(p5.detail, /tests\/frozen\.test\.mjs/);
      assert.match(round1.oracleViolation, /P5: frozen/);

      // Terminal, and terminal as an ESCALATE — not a failed chain.
      const control = readChainControl(chainDir);
      assert.equal(control.status, "completed");
      assert.equal(control.round, 1);
      assert.equal(fs.existsSync(path.join(chainDir, "chain.json")), true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("escalates when the round's verify ran fewer tests than the chain-start baseline", async () => {
    const { tmp, chainDir, text } = await runFreshChain({
      brief: PLAIN_BRIEF,
      statusOutput: " M src/foo.js\n",
      verifyResult: {
        gate_passed: true, lint: [], types: [],
        tests: { full: { status: "ok", passed: 334, total: 334 } },
      },
      verifyBaseline: { captured: true, gate_passed: true, lint: 0, types: 0, collected: 607, raw: {} },
    });
    try {
      assert.match(text, /escalated at round 1/);
      assert.match(text, /collected 334 < baseline 607/);

      const round1 = readJson(path.join(chainDir, "round-1.json"));
      assert.equal(round1.verdict, "approve");
      assert.equal(round1.disposition.disposition, "escalate");
      const p6 = round1.probeResults.find((p) => p.probe === "P6: collected");
      assert.equal(p6.passed, false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a brief with no `## Frozen Tests` section still accepts on an approve with green probes", async () => {
    const { tmp, chainDir, text } = await runFreshChain({
      brief: PLAIN_BRIEF,
      statusOutput: " M src/foo.js\n",
      verifyResult: GREEN_VERIFY,
      verifyBaseline: GREEN_BASELINE,
    });
    try {
      assert.match(text, /accepted at round 1/);
      const round1 = readJson(path.join(chainDir, "round-1.json"));
      assert.equal(round1.disposition.disposition, "accept");
      assert.equal(round1.probesGreen, true);
      assert.equal(round1.oracleViolation, false);
      const p5 = round1.probeResults.find((p) => p.probe === "P5: frozen");
      assert.equal(p5.passed, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});


// =========================================================================
// runChainDriver — P5/P6 on the resumed-accept re-validation (kusabi #197
// follow-up)
// -------------------------------------------------------------------------
// The #262 re-validation re-measures the probe truth an accept from a
// review-resume is about to finalise on.  P5/P6 belong in that set: the
// recorded marker only covers violations measured BEFORE the stop/escalate,
// and the truths P5 and P6 read (the change set, the collected count) are
// exactly the ones that move in the gap.  A frozen-path edit landed in the
// gap is invisible to P1–P4 — HEAD unchanged, tests still green — so without
// these the accept would finalise with `oracleViolation` still false.
//
// The recorded round below is ALL SIX probes green with no violation
// recorded: the round itself measured nothing wrong.  Everything these tests
// catch happened after it.
// =========================================================================

describe("runChainDriver resumed-accept oracle re-validation (kusabi #197 follow-up)", () => {
  const FROZEN_BRIEF = [
    "Implement X.",
    "",
    "## Deliverables",
    "- src/foo.js",
    "",
    "## Frozen Tests (do not touch)",
    "- tests/frozen.test.mjs",
    "",
  ].join("\n");

  const PLAIN_BRIEF = "Implement X.\n\n## Deliverables\n- src/foo.js\n";

  // Round 1 implemented, all six probes recorded green, then the review SEAT
  // died mid-stream and the chain escalated on it (#248) — the record a
  // replacement review seat resumes from.
  function seatDeadRoundAllGreen() {
    return {
      round: 1,
      reworkScope: "full",
      // Round 1 of the original run: the implement phase stamps this on every
      // record, and the escalate renderer reads it back per round.
      resumeMethod: { type: "fresh_session" },
      modelEntry: "fake/model",
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
        { probe: "P5: frozen", passed: true, detail: "recorded before the escalate" },
        { probe: "P6: collected", passed: true, detail: "recorded before the escalate" },
      ],
      // Nothing was violated as of the escalate.  The gap is the subject here.
      oracleViolation: false,
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

  function makeResumableChain({ brief, verifyBaseline }) {
    const records = [seatDeadRoundAllGreen()];
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-revalidate-oracle-"));
    const chainDir = path.join(tmp, "chains", "chain-test");
    fs.mkdirSync(chainDir, { recursive: true });
    writeJson(path.join(chainDir, "chain.json"), {
      chainId: "chain-test", container: "cid-1", model: "fake/model",
      modelChain: [["fake/model"]], maxRounds: 4,
      brief, orchestrator: null, records,
      baseSha: "abc123",
      chainTotals: computeChainTotals(records),
      strategized: false, followupIssueDraft: null,
      verifyBaseline,
    });
    writeChainControl(chainDir, {
      chainId: "chain-test", container: "cid-1", pid: 0,
      status: "completed", round: 1,
      finishedAt: "2026-08-01T01:00:00.000Z",
    });
    return { tmp, chainDir };
  }

  // The worktree as it stands NOW, at resume time: `statusOutput` is the
  // fresh change set, `verifyResult` the fresh verify run.  Verify calls are
  // counted so the tests can assert P6 buys no second one — it reads the
  // fresh P2's count, exactly as it does in a normal round.
  function revalidationCallTool({ statusOutput, verifyResult }) {
    const verifyCalls = [];
    const fn = async (toolName, params) => {
      if (toolName === "verify_in_container") {
        verifyCalls.push(params);
        return verifyResult;
      }
      if (toolName !== "sandbox_exec") return { output: "" };
      const scope = fakeChangeScopeResult(params);
      if (scope) return scope;
      const cmd = params.commands[0];
      // captureWorktreeState: capture failure → baseline null (graceful)
      if (cmd.startsWith("cd /workspace &&") && cmd.includes("TMPIDX=")) {
        return { output: "ERROR_NO_INDEX\n" };
      }
      if (cmd === "git rev-parse HEAD") return { output: "abc123\n" };
      if (cmd === "git status --porcelain") return { output: statusOutput };
      if (cmd === "git log --oneline -5") return { output: "abc123 latest change\n" };
      if (cmd === "git diff") return { output: "diff --git a/src/foo.js b/src/foo.js\n" };
      if (cmd === "git ls-files --others --exclude-standard") return { output: "" };
      return { output: "" };
    };
    fn.verifyCalls = verifyCalls;
    return fn;
  }

  // The replacement review APPROVES in every case below: the freshly measured
  // oracle must override it.
  function approvingDispatch() {
    return async (opts) => {
      if (opts.kind === "review") {
        return {
          job: {
            id: "job-rev-2", status: "completed", modelEntry: "fake/review", modelVariant: null,
            fallbacks: null, sessionID: "sess-rev-2", usage: null, error: null,
          },
          resultText: JSON.stringify({ schema_version: 1, verdict: "approve", findings: [], summary: "ok", next_steps: [] }),
        };
      }
      return {
        job: {
          id: "job-imp-1", status: "completed", modelEntry: "fake/model", modelVariant: null,
          fallbacks: null, sessionID: "sess-imp-1", usage: null, error: null,
        },
        resultText: "implemented",
      };
    };
  }

  // Mirrors cmdChainResume for the replacement-seat entry.
  async function resumeWith({ chainDir, brief, callTool }) {
    const resolution = resolveChainResume({
      control: readChainControl(chainDir),
      chainJson: readJson(path.join(chainDir, "chain.json")),
    });
    assert.equal(resolution.ok, true);
    assert.equal(resolution.position.phase, "review");
    assert.equal(resolution.position.reviewSeatReplacement, true);
    rearmChainControl({ chainDir, round: resolution.position.round });
    const tmp = path.dirname(path.dirname(chainDir));
    const chainJson = readJson(path.join(chainDir, "chain.json"));
    return runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
      model: "fake/model", modelChain: [["fake/model"]], maxRounds: 4,
      brief, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      // Reuse the recorded baseline; never re-capture (kusabi #173).
      verifyBaseline: chainJson.verifyBaseline ?? null,
      callTool,
      dispatchWithFallback: approvingDispatch(),
      keepServe: true,
      signalReceived: () => false,
      resume: resolution.position,
    });
  }

  const GREEN_VERIFY_10 = {
    gate_passed: true, lint: [], types: [],
    tests: { full: { status: "ok", passed: 10, total: 10 } },
  };
  const BASELINE_10 = { captured: true, gate_passed: true, lint: 0, types: 0, collected: 10, raw: {} };

  it("escalates a resumed accept whose FRESH change set touches a frozen path (P5 measured after the gap)", async () => {
    const { tmp, chainDir } = makeResumableChain({
      brief: FROZEN_BRIEF,
      verifyBaseline: BASELINE_10,
    });
    // The gap: a frozen-test file was edited after the escalate.  HEAD never
    // moved and the tests still pass, so P1–P4 are all green — only P5 can
    // see this.
    const callTool = revalidationCallTool({
      statusOutput: " M src/foo.js\n M tests/frozen.test.mjs\n",
      verifyResult: GREEN_VERIFY_10,
    });
    try {
      const text = await resumeWith({ chainDir, brief: FROZEN_BRIEF, callTool });

      // The replacement review approved; the freshly measured oracle overrides
      // it and names the path.
      assert.doesNotMatch(text, /accepted at round/);
      assert.match(text, /escalated at round 1/);
      assert.match(text, /oracle violation/);
      assert.match(text, /tests\/frozen\.test\.mjs/);

      const round1 = readJson(path.join(chainDir, "round-1.json"));
      assert.equal(round1.verdict, "approve");
      assert.equal(round1.disposition.disposition, "escalate");

      // The round record's FRESH probe results carry the failing P5, and
      // P1–P4 are green — the violation is the only reason for the escalate.
      const freshP5 = round1.probeResults.find((p) => p.probe === "P5: frozen");
      assert.equal(freshP5.passed, false);
      assert.match(freshP5.detail, /tests\/frozen\.test\.mjs/);
      for (const name of ["P1: HEAD clean", "P2: verify gate", "P3: deliverables", "P4: smoke"]) {
        assert.equal(round1.probeResults.find((p) => p.probe === name).passed, true, name + " must be green");
      }
      assert.equal(round1.probesGreen, false);
      // The live marker is the fresh measurement, not the recorded false.
      assert.match(round1.oracleViolation, /P5: frozen/);

      // Both truths stay on the record: recorded green with no violation,
      // beside the fresh red.
      assert.equal(round1.probesRevalidated.probesGreen, true);
      assert.equal(round1.probesRevalidated.oracleViolation, false);
      assert.equal(round1.probesRevalidated.recordedDisposition.disposition, "accept");
      assert.deepEqual(
        round1.probesRevalidated.probeResults.map((p) => p.detail),
        Array(6).fill("recorded before the escalate"),
      );

      // P6 read the fresh P2's count: no second verify call was issued.
      assert.equal(callTool.verifyCalls.length, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("escalates a resumed accept whose FRESH collected count is below the chain-start baseline (P6)", async () => {
    const { tmp, chainDir } = makeResumableChain({
      brief: PLAIN_BRIEF,
      verifyBaseline: { captured: true, gate_passed: true, lint: 0, types: 0, collected: 607, raw: {} },
    });
    // The gap: 273 tests stopped being collectable.  The gate is still green
    // — the tests that ran passed — so only P6 can see this.
    const callTool = revalidationCallTool({
      statusOutput: " M src/foo.js\n",
      verifyResult: {
        gate_passed: true, lint: [], types: [],
        tests: { full: { status: "ok", passed: 334, total: 334 } },
      },
    });
    try {
      const text = await resumeWith({ chainDir, brief: PLAIN_BRIEF, callTool });

      assert.doesNotMatch(text, /accepted at round/);
      assert.match(text, /escalated at round 1/);
      assert.match(text, /oracle violation/);
      assert.match(text, /collected 334 < baseline 607/);

      const round1 = readJson(path.join(chainDir, "round-1.json"));
      assert.equal(round1.verdict, "approve");
      assert.equal(round1.disposition.disposition, "escalate");
      const freshP6 = round1.probeResults.find((p) => p.probe === "P6: collected");
      assert.equal(freshP6.passed, false);
      assert.match(freshP6.detail, /collected 334 < baseline 607/);
      assert.equal(round1.probeResults.find((p) => p.probe === "P2: verify gate").passed, true);
      assert.match(round1.oracleViolation, /P6: collected/);
      assert.equal(round1.probesRevalidated.probesGreen, true);
      assert.equal(round1.probesRevalidated.oracleViolation, false);
      assert.equal(round1.probesRevalidated.recordedDisposition.disposition, "accept");
      assert.equal(callTool.verifyCalls.length, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("leaves the accept standing when the fresh P5/P6 are green — no Frozen Tests section, no derivable count", async () => {
    // No `## Frozen Tests` heading → P5 skipped-and-green; a verify result
    // with no `tests.full` and a baseline with no `collected` → P6 cannot
    // compare, which is a PASS with the limitation stated.  This is the
    // unchanged-behaviour case.
    const { tmp, chainDir } = makeResumableChain({
      brief: PLAIN_BRIEF,
      verifyBaseline: { captured: true, gate_passed: true, lint: 0, types: 0, raw: {} },
    });
    const callTool = revalidationCallTool({
      statusOutput: " M src/foo.js\n",
      verifyResult: { gate_passed: true },
    });
    try {
      const text = await resumeWith({ chainDir, brief: PLAIN_BRIEF, callTool });

      assert.match(text, /accepted at round 1/);
      assert.doesNotMatch(text, /oracle violation/);

      const round1 = readJson(path.join(chainDir, "round-1.json"));
      assert.equal(round1.verdict, "approve");
      assert.equal(round1.disposition.disposition, "accept");
      assert.equal(round1.probesGreen, true);
      assert.equal(round1.oracleViolation, false);

      // The fresh set really is all six, and the two new ones are green for
      // the stated reasons — not silently absent.
      assert.deepEqual(
        round1.probeResults.map((p) => p.probe),
        ["P1: HEAD clean", "P2: verify gate", "P3: deliverables", "P4: smoke", "P5: frozen", "P6: collected"],
      );
      const freshP5 = round1.probeResults.find((p) => p.probe === "P5: frozen");
      assert.equal(freshP5.passed, true);
      assert.match(freshP5.detail, /no Frozen Tests declared; check skipped/);
      const freshP6 = round1.probeResults.find((p) => p.probe === "P6: collected");
      assert.equal(freshP6.passed, true);
      assert.match(freshP6.detail, /UNCHECKED/);

      // The re-validation still fired exactly once and still preserved the
      // recorded truth beside the fresh run.
      assert.equal(callTool.verifyCalls.length, 1);
      assert.equal(round1.probesRevalidated.probesGreen, true);
      assert.equal(round1.probesRevalidated.oracleViolation, false);
      assert.equal(round1.probesRevalidated.recordedDisposition.disposition, "accept");

      const control = readChainControl(chainDir);
      assert.equal(control.status, "completed");
      assert.equal(control.round, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
describe("CLI smoke baseline (kusabi #292)", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");

  // A minimal sunaba MCP endpoint: callTool POSTs initialize (needs the
  // mcp-session-id response header), notifications/initialized, then
  // tools/call (parsed as SSE, unwrapped from result.content[0].text as
  // JSON).  Every tools/call answers with the same tool result, which is all
  // the baseline run needs: it is the FIRST container call the chain makes.
  // The one exception is `git status --porcelain` \u2014 the baseline's worktree
  // guard (kusabi #292) captures it before and after the smoke \u2014 which is
  // routed to its own scripted output: a string answers every call the same
  // way, an array one entry per call (a "!THROW!" entry makes the call throw).
  // The SHA the stub reports for `git rev-parse HEAD` unless a test scripts
  // something else: one value answering every call is a container whose HEAD
  // never moved, which is what every pre-existing case here assumes.
  const STUB_HEAD_SHA = "7c0ffee0000000000000000000000000deadbeef";

  function startSunabaStub({ toolResult, gitStatus = "", gitHead = STUB_HEAD_SHA }) {
    let gitStatusCalls = 0;
    let gitHeadCalls = 0;
    // Every tools/call the child makes, whatever the tool.  A refusal that
    // must fire BEFORE any container work proves itself by leaving this at
    // zero (kusabi #321).
    let toolsCall = 0;
    const server = http.createServer((req, res) => {
      res.on("error", () => {});
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        let payload = null;
        try {
          payload = JSON.parse(body);
        } catch {
          // not JSON \u2014 still answer the handshake
        }
        if (payload?.method === "tools/call") toolsCall += 1;
        res.setHeader("mcp-session-id", "stub-session");
        res.writeHead(200, { "content-type": "text/event-stream" });
        let callResult = toolResult;
        const isGitStatus = payload?.method === "tools/call"
          && payload.params?.name === "sandbox_exec"
          && payload.params?.arguments?.commands?.[0] === "git status --porcelain";
        if (isGitStatus) {
          const statuses = Array.isArray(gitStatus) ? gitStatus : [gitStatus];
          const scripted = statuses[gitStatusCalls] ?? "";
          if (scripted === "!THROW!") {
            res.end("data: {\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32000,\"message\":\"stub rpc exploded\"}}\n\n");
            return;
          }
          callResult = { output: scripted };
          gitStatusCalls++;
        }
        // `git rev-parse HEAD` rides in the same capture as the status
        // listing (kusabi #292 follow-up), so it is routed the same way: a
        // string answers every call identically (HEAD never moved), an array
        // one entry per call, "!THROW!" makes that call fail.
        const isGitHead = payload?.method === "tools/call"
          && payload.params?.name === "sandbox_exec"
          && payload.params?.arguments?.commands?.[0] === "git rev-parse HEAD";
        if (isGitHead) {
          const heads = Array.isArray(gitHead) ? gitHead : [gitHead];
          const scripted = heads[gitHeadCalls] ?? heads[heads.length - 1] ?? "";
          if (scripted === "!THROW!") {
            res.end("data: {\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32000,\"message\":\"stub head read exploded\"}}\n\n");
            return;
          }
          callResult = { output: `${scripted}\n` };
          gitHeadCalls++;
        }
        const envelope = payload?.method === "tools/call"
          ? {
            jsonrpc: "2.0",
            id: payload.id ?? 1,
            result: { content: [{ type: "text", text: JSON.stringify(callResult) }] },
          }
          : {
            jsonrpc: "2.0",
            id: payload?.id ?? 1,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              serverInfo: { name: "kusabi-stub", version: "0.0.0" },
            },
          };
        res.end(`data: ${JSON.stringify(envelope)}\n\n`);
      });
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        resolve({ server, url: `http://127.0.0.1:${port}/mcp`, toolsCallCount: () => toolsCall });
      });
    });
  }

  // spawn, not spawnSync: spawnSync blocks this process's event loop, so the
  // stub above could never answer the child.
  function runCompanion(args, { cwd, stateRootDir, url }) {
    return new Promise((resolve) => {
      const env = { ...process.env };
      delete env.KUSABI_WORKER_CONTEXT;
      env.KUSABI_STATE_DIR = stateRootDir;
      env.KUSABI_SUNABA_URL = url;
      env.OPENCODE_BIN = path.join(cwd, "no-such-opencode-bin");
      const child = spawn(process.execPath, [COMPANION_SCRIPT, ...args], { cwd, env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => child.kill("SIGTERM"), 20_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ status: code, stdout, stderr });
      });
    });
  }

  // The child hashes its own cwd to pick a state dir; on a host where the
  // temp path is a symlink that hash is not reproducible here.  Scan every
  // workspace dir instead — the claim is that NO round state exists anywhere.
  function workspaceDirs(stateRootDir) {
    if (!fs.existsSync(stateRootDir)) return [];
    return fs.readdirSync(stateRootDir).map((d) => path.join(stateRootDir, d));
  }

  it("refuses the dispatch and creates no round state when the baseline is red", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-smoke-baseline-red-"));
    const { server, url } = await startSunabaStub({ toolResult: { output: "SMOKE_EXIT=1\n" } });
    try {
      const briefPath = path.join(tmp, "brief.md");
      fs.writeFileSync(briefPath, "# Task\n\nOrchestrator: test-model | session s-1 | 2026-08-16\n\n## Deliverables\n\n- `src/x.mjs`\n\n## Smoke\n\n- `npm test`\n");
      const stateRootDir = path.join(tmp, "state");
      const result = await runCompanion(
        ["chain", "--container", "cid-1", "--brief-file", briefPath],
        { cwd: tmp, stateRootDir, url },
      );

      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stdout, /dispatch refused/);
      assert.match(result.stdout, /`npm test`: expected exit 0, observed exit 1/);
      assert.match(result.stdout, /before any worker change/);

      for (const dir of workspaceDirs(stateRootDir)) {
        assert.ok(!fs.existsSync(path.join(dir, "chains")), "no chain state may be created");
        const jobsDir = path.join(dir, "jobs");
        if (fs.existsSync(jobsDir)) {
          assert.deepEqual(fs.readdirSync(jobsDir), [], "no job may be created");
        }
      }
    } finally {
      server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("dispatches as before when the baseline is green", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-smoke-baseline-green-"));
    const { server, url } = await startSunabaStub({ toolResult: { output: "SMOKE_EXIT=0\n" } });
    try {
      const briefPath = path.join(tmp, "brief.md");
      fs.writeFileSync(briefPath, "# Task\n\nOrchestrator: test-model | session s-1 | 2026-08-16\n\n## Deliverables\n\n- `src/x.mjs`\n\n## Smoke\n\n- `npm test`\n");
      const stateRootDir = path.join(tmp, "state");
      const result = await runCompanion(
        ["chain", "--container", "cid-1", "--max-rounds", "1", "--brief-file", briefPath],
        { cwd: tmp, stateRootDir, url },
      );

      // The dispatch itself cannot succeed (OPENCODE_BIN does not exist);
      // what matters is that the chain got PAST the baseline — it printed its
      // start banner and created its chain state, exactly as before #292.
      assert.doesNotMatch(result.stdout, /dispatch refused/);
      assert.match(result.stdout, /^Chain .*tiers=/m);
      const chained = workspaceDirs(stateRootDir).some((d) => fs.existsSync(path.join(d, "chains")));
      assert.ok(chained, `the chain must proceed to create its state: ${result.stdout}`);
    } finally {
      server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses a passing smoke that dirtied the worktree, before any round state", async () => {
    // Green exit code, but the smoke wrote: the baseline's own execution
    // dirtied the tree the worker would be handed, so the dispatch must be
    // refused with the dirt named \u2014 a worker inheriting it would carry the
    // artifacts into the round's diff and review as its own work.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-smoke-baseline-dirt-"));
    const { server, url } = await startSunabaStub({
      toolResult: { output: "SMOKE_EXIT=0\n" },
      gitStatus: ["", "?? coverage/\n"],
    });
    try {
      const briefPath = path.join(tmp, "brief.md");
      fs.writeFileSync(briefPath, "# Task\n\nOrchestrator: test-model | session s-1 | 2026-08-16\n\n## Deliverables\n\n- `src/x.mjs`\n\n## Smoke\n\n- `npm test`\n");
      const stateRootDir = path.join(tmp, "state");
      const result = await runCompanion(
        ["chain", "--container", "cid-1", "--max-rounds", "1", "--brief-file", briefPath],
        { cwd: tmp, stateRootDir, url },
      );

      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stdout, /dispatch refused/);
      assert.match(result.stdout, /modified the worktree/);
      assert.match(result.stdout, /\?\? coverage\//);
      for (const dir of workspaceDirs(stateRootDir)) {
        assert.ok(!fs.existsSync(path.join(dir, "chains")), "no chain state may be created");
        const jobsDir = path.join(dir, "jobs");
        if (fs.existsSync(jobsDir)) {
          assert.deepEqual(fs.readdirSync(jobsDir), [], "no job may be created");
        }
      }
    } finally {
      server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses when the post-smoke worktree check itself fails", async () => {
    // Fail-closed: a guard whose verdict is "the smoke left no dirt" must not
    // dispatch when the measurement that would prove it came back as an RPC
    // error \u2014 same stance as an unobservable exit code being a red baseline.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-smoke-baseline-unverifiable-"));
    const { server, url } = await startSunabaStub({
      toolResult: { output: "SMOKE_EXIT=0\n" },
      gitStatus: ["", "!THROW!"],
    });
    try {
      const briefPath = path.join(tmp, "brief.md");
      fs.writeFileSync(briefPath, "# Task\n\nOrchestrator: test-model | session s-1 | 2026-08-16\n\n## Deliverables\n\n- `src/x.mjs`\n\n## Smoke\n\n- `npm test`\n");
      const stateRootDir = path.join(tmp, "state");
      const result = await runCompanion(
        ["chain", "--container", "cid-1", "--max-rounds", "1", "--brief-file", briefPath],
        { cwd: tmp, stateRootDir, url },
      );

      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stdout, /dispatch refused/);
      assert.match(result.stdout, /could not be verified/);
      assert.match(result.stdout, /stub rpc exploded/);
      for (const dir of workspaceDirs(stateRootDir)) {
        assert.ok(!fs.existsSync(path.join(dir, "chains")), "no chain state may be created");
      }
    } finally {
      server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses a smoke that moved HEAD behind a clean status listing, before any round state", async () => {
    // The blind spot this closes (kusabi #292 follow-up): the smoke commits,
    // so `git status --porcelain` is EMPTY both times and the dirt guard sees
    // a spotless container -- while the chain's base SHA, captured after the
    // baseline, is now the SHA the smoke created.  Every later comparison
    // would run against it and report nothing wrong.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-smoke-baseline-headmove-"));
    const { server, url } = await startSunabaStub({
      toolResult: { output: "SMOKE_EXIT=0\n" },
      gitStatus: ["", ""],
      gitHead: ["1111111111111111111111111111111111111111", "2222222222222222222222222222222222222222"],
    });
    try {
      const briefPath = path.join(tmp, "brief.md");
      fs.writeFileSync(briefPath, "# Task\n\nOrchestrator: test-model | session s-1 | 2026-08-16\n\n## Deliverables\n\n- `src/x.mjs`\n\n## Smoke\n\n- `npm test`\n");
      const stateRootDir = path.join(tmp, "state");
      const result = await runCompanion(
        ["chain", "--container", "cid-1", "--max-rounds", "1", "--brief-file", briefPath],
        { cwd: tmp, stateRootDir, url },
      );

      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stdout, /dispatch refused/);
      assert.match(result.stdout, /moved HEAD/);
      assert.match(result.stdout, /1111111111111111111111111111111111111111/);
      assert.match(result.stdout, /2222222222222222222222222222222222222222/);
      // A clean listing must not be reported as dirt: the two failures are
      // distinct and only the real one may be named.
      assert.doesNotMatch(result.stdout, /modified the worktree/);
      for (const dir of workspaceDirs(stateRootDir)) {
        assert.ok(!fs.existsSync(path.join(dir, "chains")), "no chain state may be created");
        const jobsDir = path.join(dir, "jobs");
        if (fs.existsSync(jobsDir)) {
          assert.deepEqual(fs.readdirSync(jobsDir), [], "no job may be created");
        }
      }
    } finally {
      server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses when the HEAD read itself fails", async () => {
    // Same fail-closed stance as the status capture: HEAD unread means "the
    // smoke moved nothing" cannot be claimed, so the dispatch does not happen.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-smoke-baseline-headfail-"));
    const { server, url } = await startSunabaStub({
      toolResult: { output: "SMOKE_EXIT=0\n" },
      gitHead: ["!THROW!"],
    });
    try {
      const briefPath = path.join(tmp, "brief.md");
      fs.writeFileSync(briefPath, "# Task\n\nOrchestrator: test-model | session s-1 | 2026-08-16\n\n## Deliverables\n\n- `src/x.mjs`\n\n## Smoke\n\n- `npm test`\n");
      const stateRootDir = path.join(tmp, "state");
      const result = await runCompanion(
        ["chain", "--container", "cid-1", "--max-rounds", "1", "--brief-file", briefPath],
        { cwd: tmp, stateRootDir, url },
      );

      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stdout, /dispatch refused/);
      assert.match(result.stdout, /could not be verified/);
      assert.match(result.stdout, /stub head read exploded/);
      for (const dir of workspaceDirs(stateRootDir)) {
        assert.ok(!fs.existsSync(path.join(dir, "chains")), "no chain state may be created");
      }
    } finally {
      server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses a single-shot task with a red baseline, before any job exists", async () => {
    // `task --container` runs the same P4 after the worker returns, so the
    // same red would be recorded against the same innocent worker.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-smoke-baseline-task-"));
    const { server, url } = await startSunabaStub({ toolResult: { output: "SMOKE_EXIT=1\n" } });
    try {
      const briefPath = path.join(tmp, "brief.md");
      fs.writeFileSync(briefPath, "# Task\n\nOrchestrator: test-model | session s-1 | 2026-08-16\n\n## Deliverables\n\n- `src/x.mjs`\n\n## Smoke\n\n- `npm test`\n");
      const stateRootDir = path.join(tmp, "state");
      const result = await runCompanion(
        ["task", "--phase", "implement", "--container", "cid-1", "--brief-file", briefPath],
        { cwd: tmp, stateRootDir, url },
      );

      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stdout, /dispatch refused/);
      assert.match(result.stdout, /`npm test`: expected exit 0, observed exit 1/);
      for (const dir of workspaceDirs(stateRootDir)) {
        const jobsDir = path.join(dir, "jobs");
        if (fs.existsSync(jobsDir)) {
          assert.deepEqual(fs.readdirSync(jobsDir), [], "no job may be created");
        }
      }
    } finally {
      server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---- session-provenance refusal (kusabi #321) ----
  // The whole point of the issue: the refusal must fire at command start,
  // BEFORE any baseline measurement or container work.  The message alone
  // cannot tell an early refusal from a late one — the agy backstop throws
  // the same class of error AFTER the chain state exists — so these run the
  // real CLI against the stub and count container calls: an early refusal
  // is a chain that never touched the container and never created state.
  // The owner record that proves (or fails to prove) the session's backend
  // is written into the job store BEFORE the chain starts; the child hashes
  // its own cwd to pick its state dir, exactly like the baseline tests
  // above.
  describe("session-provenance refusal (kusabi #321)", () => {
    function writeOwnerRecord(stateRootDir, cwd, sessionID, backend) {
      const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12);
      saveJob(path.join(stateRootDir, hash), {
        id: "job-owner-" + Date.now().toString(36),
        sessionID,
        backend,
        status: "completed",
        startedAt: new Date().toISOString(),
      });
    }

    // No ## Smoke section: the smoke baseline runs nothing, so the only
    // container calls a refused chain could have made are the ones this
    // block counts.
    const BRIEF = "# Task\n\nOrchestrator: test-model | session s-1 | 2026-08-16\n\n## Deliverables\n\n- `src/x.mjs`\n";
    const SESSION = "123e4567-e89b-12d3-a456-426614174000";
    const FOREIGN = "123e4567-e89b-12d3-a456-426614174001";
    const AGY_OWNED = "123e4567-e89b-12d3-a456-426614174002";

    function writeBrief(tmp) {
      const briefPath = path.join(tmp, "brief.md");
      fs.writeFileSync(briefPath, BRIEF);
      return briefPath;
    }

    it("refuses an ownerless --session on an agy chain before any container call or chain state", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-session-ownerless-"));
      const { server, url, toolsCallCount } = await startSunabaStub({ toolResult: { output: "SMOKE_EXIT=0\n" } });
      try {
        const stateRootDir = path.join(tmp, "state");
        const result = await runCompanion(
          ["chain", "--backend", "agy", "--session", SESSION, "--container", "cid-1", "--brief-file", writeBrief(tmp)],
          { cwd: tmp, stateRootDir, url },
        );

        assert.notEqual(result.status, 0, result.stdout);
        assert.match(result.stdout, /dispatch refused/);
        assert.match(result.stdout, new RegExp(SESSION));
        assert.match(result.stdout, /owner record/);
        assert.match(result.stdout, /provenance cannot be established/);
        assert.equal(toolsCallCount(), 0, "the refusal must fire before the first container call");
        for (const dir of workspaceDirs(stateRootDir)) {
          assert.ok(!fs.existsSync(path.join(dir, "chains")), "no chain state may be created");
        }
      } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("refuses a foreign-backend-owned --session on an agy chain, naming both backends, before any container call", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-session-foreign-"));
      const { server, url, toolsCallCount } = await startSunabaStub({ toolResult: { output: "SMOKE_EXIT=0\n" } });
      try {
        const stateRootDir = path.join(tmp, "state");
        writeOwnerRecord(stateRootDir, tmp, FOREIGN, "opencode");
        const result = await runCompanion(
          ["chain", "--backend", "agy", "--session", FOREIGN, "--container", "cid-1", "--brief-file", writeBrief(tmp)],
          { cwd: tmp, stateRootDir, url },
        );

        assert.notEqual(result.status, 0, result.stdout);
        assert.match(result.stdout, /dispatch refused/);
        assert.match(result.stdout, new RegExp(FOREIGN));
        assert.match(result.stdout, /opencode/);
        assert.match(result.stdout, /agy/);
        assert.equal(toolsCallCount(), 0, "the refusal must fire before the first container call");
        for (const dir of workspaceDirs(stateRootDir)) {
          assert.ok(!fs.existsSync(path.join(dir, "chains")), "no chain state may be created");
        }
      } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("an agy-owned --session proceeds past the gate on an agy chain", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-session-agy-"));
      const { server, url } = await startSunabaStub({ toolResult: { output: "SMOKE_EXIT=0\n" } });
      try {
        const stateRootDir = path.join(tmp, "state");
        writeOwnerRecord(stateRootDir, tmp, AGY_OWNED, "agy");
        const result = await runCompanion(
          ["chain", "--backend", "agy", "--session", AGY_OWNED, "--container", "cid-1", "--max-rounds", "1", "--brief-file", writeBrief(tmp)],
          { cwd: tmp, stateRootDir, url },
        );

        // The dispatch itself cannot succeed (no agy binary in the child
        // env); what matters is that the chain got PAST the gate — it
        // printed its start banner and created its chain state, exactly as
        // before #321.
        assert.doesNotMatch(result.stdout, /dispatch refused/);
        assert.match(result.stdout, /^Chain .*tiers=/m);
        const chained = workspaceDirs(stateRootDir).some((d) => fs.existsSync(path.join(d, "chains")));
        assert.ok(chained, `the chain must proceed to create its state: ${result.stdout}`);
      } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("an ownerless --session changes nothing when the implement phase does not resolve to agy", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-session-opencode-"));
      const { server, url } = await startSunabaStub({ toolResult: { output: "SMOKE_EXIT=0\n" } });
      try {
        const stateRootDir = path.join(tmp, "state");
        // No --backend: the implement phase resolves to opencode, where an
        // unknown session id is a separate question (#321 excludes it) — the
        // same ownerless id that refuses on agy must sail through here.
        const result = await runCompanion(
          ["chain", "--session", SESSION, "--container", "cid-1", "--max-rounds", "1", "--brief-file", writeBrief(tmp)],
          { cwd: tmp, stateRootDir, url },
        );

        assert.doesNotMatch(result.stdout, /dispatch refused/);
        assert.match(result.stdout, /^Chain .*tiers=/m);
        const chained = workspaceDirs(stateRootDir).some((d) => fs.existsSync(path.join(d, "chains")));
        assert.ok(chained, `the chain must proceed to create its state: ${result.stdout}`);
      } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});

// =========================================================================
// runChainDriver — qualifying refusal (kusabi #293)
// -------------------------------------------------------------------------
// An empty change set used to mean exactly one thing: discard → escalate.
// These drive the three cases that population now splits into, end to end
// through the real driver, and check the two properties the mechanism is
// worth nothing without: a refusal is TERMINAL and distinct, and it costs
// the worker neither a rework round nor a discard on its record.
// =========================================================================

describe("runChainDriver qualifying refusal (kusabi #293)", () => {
  const BRIEF = "Implement X.\n\n## Deliverables\n- src/foo.js\n";

  // REFUSAL_REPORT anchors on "## Frozen tests" and on
  // plugins/kusabi/scripts/chain-phases.test.mjs.  The existence gate
  // (verifyRefusalAnchors) lets a block qualify only when each anchor names
  // a REAL item -- a heading the brief actually has, a file the worktree
  // actually contains -- so the qualifying tests must run against a brief
  // that carries the heading AND a cwd that contains the file (the fixture
  // pattern proven in the "existence gate: a block naming two REAL items"
  // test below).
  const GATE_BRIEF = "Implement X.\n\n## Frozen tests\n\nAll existing tests pass unchanged.\n\n## Deliverables\n- src/foo.js\n";

  const REFUSAL_REPORT = [
    "I stopped without editing: the brief cannot be satisfied.",
    "",
    "```kusabi-refusal",
    "anchor: ## Frozen tests",
    "anchor: plugins/kusabi/scripts/chain-phases.test.mjs",
    "why: the frozen section requires every existing test to pass unchanged, while the spec requires the opposite output for the input that test pins.",
    "```",
    "",
    "No files were changed.",
  ].join("\n");

  // Two anchors, neither of them a NAMED item: free prose does not qualify.
  const PROSE_REFUSAL_REPORT = [
    "```kusabi-refusal",
    "anchor: the brief wants the tests untouched",
    "anchor: and it also wants different output",
    "why: they conflict.",
    "```",
  ].join("\n");

  function refusalCallTool({ statusOutput, cwd } = {}) {
    return async (toolName, params) => {
      if (toolName === "verify_in_container") {
        return {
          gate_passed: true, lint: [], types: [],
          tests: { full: { status: "ok", passed: 10, total: 10 } },
        };
      }
      if (toolName !== "sandbox_exec") return { output: "" };
      const scope = fakeChangeScopeResult(params);
      if (scope) return scope;
      const cmd = params.commands[0];
      if (cmd.includes("test -e ")) {
        const lines = [];
        const matches = cmd.matchAll(/test -e '([^']+)'/g);
        for (const m of matches) {
          const p = m[1];
          const fullPath = cwd ? path.join(cwd, p) : p;
          const exists = fs.existsSync(fullPath);
          lines.push(exists ? `OK ${p}` : `NO ${p}`);
        }
        return { output: lines.join("\n") + "\n" };
      }
      if (cmd.startsWith("cd /workspace &&") && cmd.includes("TMPIDX=")) {
        return { output: "ERROR_NO_INDEX\n" };
      }
      if (cmd === "git rev-parse HEAD") return { output: "abc123\n" };
      if (cmd === "git status --porcelain") return { output: statusOutput };
      if (cmd === "git log --oneline -5") return { output: "abc123 latest change\n" };
      if (cmd === "git ls-files --others --exclude-standard") return { output: "" };
      return { output: "" };
    };
  }

  // The reviewer APPROVES whenever it is dispatched at all: on the refusal
  // path it must never be dispatched, and on the stray-block path the
  // ordinary accept must survive the stray block untouched.
  function reportingDispatch(implementReport) {
    const dispatch = async (opts) => {
      if (opts.kind === "review") {
        return {
          job: {
            id: "job-rev-1", status: "completed", modelEntry: "fake/review", modelVariant: null,
            fallbacks: null, sessionID: "sess-rev", usage: null, error: null,
          },
          resultText: JSON.stringify({ schema_version: 1, verdict: "approve", findings: [], summary: "ok", next_steps: [] }),
        };
      }
      return {
        job: {
          id: "job-imp-" + (opts.round ?? 1), status: "completed", modelEntry: "fake/model",
          modelVariant: null, fallbacks: null, sessionID: "sess-imp-1", usage: null, error: null,
        },
        resultText: implementReport,
      };
    };
    const calls = [];
    const wrapped = async (opts) => { calls.push(opts); return dispatch(opts); };
    wrapped.calls = calls;
    return wrapped;
  }

  async function runFreshChain({ statusOutput, implementReport, gate = false }) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-refusal-"));
    const chainDir = path.join(tmp, "chains", "chain-refusal");
    fs.mkdirSync(chainDir, { recursive: true });
    if (gate) {
      // The existence gate verifies REFUSAL_REPORT's repo-path anchor
      // against the worktree at cwd, so the anchor file must really exist
      // there; the brief is GATE_BRIEF, which really has the heading.
      fs.mkdirSync(path.join(tmp, "plugins", "kusabi", "scripts"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "plugins", "kusabi", "scripts", "chain-phases.test.mjs"), "// fixture\n");
    }
    writeChainControl(chainDir, {
      chainId: "chain-refusal", container: "cid-1", pid: process.pid,
      status: "running", round: 0, startedAt: new Date().toISOString(),
    });
    const dispatch = reportingDispatch(implementReport);
    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-refusal", container: "cid-1",
      model: "fake/model", modelChain: [["fake/model"], ["fake/pro"]], maxRounds: 4,
      brief: gate ? GATE_BRIEF : BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      verifyBaseline: { captured: true, gate_passed: true, lint: 0, types: 0, collected: 10, raw: {} },
      callTool: refusalCallTool({ statusOutput, cwd: tmp }),
      dispatchWithFallback: dispatch,
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });
    return { tmp, chainDir, text, dispatch };
  }

  it("empty change set + qualifying block: terminal refused-brief-defect, attributed as a refusal", async () => {
    // gate: the block's anchors must be REAL items, so run against the brief
    // carrying the "## Frozen tests" heading and a cwd containing the anchor
    // file (the fixture pattern of the "existence gate: REAL items" test).
    const { tmp, chainDir, text, dispatch } = await runFreshChain({
      statusOutput: "",
      implementReport: REFUSAL_REPORT,
      gate: true,
    });
    try {
      // The chain ends on the refusal, and the outcome names both items.
      assert.match(text, /refused at round 1/);
      assert.match(text, /## Frozen tests/);
      assert.match(text, /plugins\/kusabi\/scripts\/chain-phases\.test\.mjs/);
      assert.match(text, /BRIEF defect/);
      assert.doesNotMatch(text, /accepted at round/);
      assert.doesNotMatch(text, /escalated at round/);

      // No review seat was bought: the round changed nothing to review.
      assert.equal(dispatch.calls.some((c) => c.kind === "review"), false);

      const round1 = readJson(path.join(chainDir, "round-1.json"));
      assert.equal(round1.disposition.disposition, "refused-brief-defect");
      // Attribution: a refusal, never a discard charged to the worker seat.
      assert.equal(round1.roundOutcome, "refusal");
      assert.equal(round1.verdict, "refusal");
      assert.notEqual(round1.verdict, "discard");
      assert.equal(round1.refusal.anchors.length, 2);
      assert.deepEqual(round1.refusal.anchors.map((a) => a.kind), ["brief-section", "repo-path"]);
      assert.match(round1.refusal.why, /opposite output/);
      assert.equal(round1.strayRefusalBlock, undefined);

      // The rework budget is untouched: no second round, no rework strategy.
      assert.equal(round1.reworkCount, 0);
      assert.equal(round1.pendingReworkStrategy, null);
      assert.equal(fs.existsSync(path.join(chainDir, "round-2.json")), false);
      assert.equal(readJson(path.join(chainDir, "chain.json")).records.length, 1);

      // Terminal for chain-wait, both by control status and by disposition.
      const control = readChainControl(chainDir);
      assert.equal(control.status, "completed");
      assert.equal(control.round, 1);
      assert.equal(TERMINAL_DISPOSITIONS.has("refused-brief-defect"), true);

      // chain-show renders the disposition line plus the two named items.
      const shown = renderChainShow(
        readJson(path.join(chainDir, "chain.json")),
        [round1],
        [],
        control,
      );
      assert.match(shown, /status: refused at round 1 — brief defect/);
      assert.match(shown, /disposition: refused-brief-defect/);
      assert.match(shown, /refusal: contradicting items named by the worker/);
      assert.match(shown, /- ## Frozen tests \[brief-section\]/);
      assert.match(shown, /- plugins\/kusabi\/scripts\/chain-phases\.test\.mjs \[repo-path\]/);
      assert.match(shown, /why: the frozen section requires/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("an interruption between implement and finishRound survives chain-resume: the resumed round still refuses (kusabi #293 review)", async () => {
    // The designed stop point (kusabi #153①): a stop requested while the
    // implement round is in flight is honoured AFTER the probes, persisting
    // the partial round.  The refusal descriptor must be persisted with it --
    // the report text is deliberately discarded, so the parse cannot be
    // repeated after the stop -- or the review-resume would classify the
    // empty change set as a discard and charge the honest refusal to the
    // worker seat exactly as before #293.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-refusal-stop-"));
    const chainDir = path.join(tmp, "chains", "chain-refusal");
    fs.mkdirSync(chainDir, { recursive: true });
    // The existence gate verifies REFUSAL_REPORT's repo-path anchor against
    // the worktree at cwd, so the anchor file must really exist there (and
    // the brief must be GATE_BRIEF, which really has the heading) -- both
    // runs below must see the same REAL items, fresh and resumed alike.
    fs.mkdirSync(path.join(tmp, "plugins", "kusabi", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "plugins", "kusabi", "scripts", "chain-phases.test.mjs"), "// fixture\n");
    writeChainControl(chainDir, {
      chainId: "chain-refusal", container: "cid-1", pid: process.pid,
      status: "running", round: 0, startedAt: new Date().toISOString(),
    });
    const dispatch = reportingDispatch(REFUSAL_REPORT);
    const dispatchWithStop = async (opts) => {
      const result = await dispatch(opts);
      if (opts.kind === "task") {
        // The stop arrives while the round is in flight -- exactly what
        // chain-cancel does via requestChainStop.
        writeChainControl(chainDir, {
          ...readChainControl(chainDir),
          stopRequestedAt: new Date().toISOString(),
          stopRequestedBy: "test",
        });
      }
      return result;
    };
    try {
      const cancelled = await runChainDriver({
        cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-refusal", container: "cid-1",
        model: "fake/model", modelChain: [["fake/model"], ["fake/pro"]], maxRounds: 4,
        brief: GATE_BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
        verifyBaseline: { captured: true, gate_passed: true, lint: 0, types: 0, collected: 10, raw: {} },
        callTool: refusalCallTool({ statusOutput: "", cwd: tmp }),
        dispatchWithFallback: dispatchWithStop,
        keepServe: true,
        signalReceived: () => false,
        resume: null,
      });
      assert.match(cancelled, /cancelled during round 1/);

      // The partial round is persisted WITH the refusal descriptor on it.
      const partial = readJson(path.join(chainDir, "round-1.json"));
      assert.equal(partial.interrupted, true);
      assert.equal(partial.interruptedAfter, "probes");
      assert.equal(partial.implementRefusal.qualifies, true);
      assert.equal(partial.implementRefusal.anchors.length, 2);
      assert.match(partial.implementRefusal.why, /opposite output/);

      // Resume exactly as cmdChainResume wires it: resolve the position from
      // the records alone, re-arm the control, run the driver at the same
      // round's review phase.
      const resolution = resolveChainResume({
        control: readChainControl(chainDir),
        chainJson: readJson(path.join(chainDir, "chain.json")),
      });
      assert.equal(resolution.ok, true);
      assert.equal(resolution.position.phase, "review");
      assert.equal(resolution.position.round, 1);
      rearmChainControl({
        chainDir,
        round: resolution.position.phase === "review" ? resolution.position.round : resolution.position.round - 1,
      });

      const text = await runChainDriver({
        cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-refusal", container: "cid-1",
        model: "fake/model", modelChain: [["fake/model"], ["fake/pro"]], maxRounds: 4,
        brief: GATE_BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
        // Mirror cmdChainResume: reuse the verify baseline recorded in
        // chain.json; never re-capture on the modified worktree (kusabi #173).
        verifyBaseline: readJson(path.join(chainDir, "chain.json")).verifyBaseline ?? null,
        callTool: refusalCallTool({ statusOutput: "", cwd: tmp }),
        dispatchWithFallback: dispatch,
        keepServe: true,
        signalReceived: () => false,
        resume: resolution.position,
      });

      // The resumed round terminates as the refusal the original finishRound
      // would have produced -- never as a worker discard.
      assert.match(text, /refused at round 1/);
      assert.match(text, /## Frozen tests/);
      assert.match(text, /BRIEF defect/);
      assert.doesNotMatch(text, /escalated at round/);

      const round1 = readJson(path.join(chainDir, "round-1.json"));
      assert.equal(round1.disposition.disposition, "refused-brief-defect");
      // Attribution: a refusal, never a discard charged to the worker seat.
      assert.equal(round1.roundOutcome, "refusal");
      assert.equal(round1.verdict, "refusal");
      assert.notEqual(round1.verdict, "discard");
      assert.equal(round1.refusal.anchors.length, 2);
      assert.match(round1.refusal.why, /opposite output/);
      // The interruption history stays visible on the completed round.
      assert.equal(round1.wasInterrupted, true);
      assert.equal(round1.resumed, true);
      // Terminal on the first round: no rework, no second round.
      assert.equal(round1.reworkCount, 0);
      assert.equal(round1.pendingReworkStrategy, null);
      assert.equal(fs.existsSync(path.join(chainDir, "round-2.json")), false);

      // No review seat was bought on the resumed path either: the round
      // changed nothing to review.
      assert.equal(dispatch.calls.some((c) => c.kind === "review"), false);

      const control = readChainControl(chainDir);
      assert.equal(control.status, "completed");
      assert.equal(control.round, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("empty change set + no block: discard → escalate, exactly as before", async () => {
    const { tmp, chainDir, text } = await runFreshChain({
      statusOutput: "",
      implementReport: "Implemented the feature. All tests pass.",
    });
    try {
      assert.match(text, /escalated at round 1/);
      assert.doesNotMatch(text, /refused at round/);
      const round1 = readJson(path.join(chainDir, "round-1.json"));
      assert.equal(round1.verdict, "discard");
      assert.equal(round1.verdictSource, "probe");
      assert.equal(round1.disposition.disposition, "escalate");
      assert.equal(round1.roundOutcome, undefined);
      assert.equal(round1.refusal, undefined);
      assert.equal(round1.refusalRejected, undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("empty change set + block with no named anchors: still a discard, shortfall recorded", async () => {
    const { tmp, chainDir, text } = await runFreshChain({
      statusOutput: "",
      implementReport: PROSE_REFUSAL_REPORT,
    });
    try {
      // Routing is the pre-existing discard → escalate, byte for byte.
      assert.match(text, /escalated at round 1/);
      assert.doesNotMatch(text, /refused at round/);
      const round1 = readJson(path.join(chainDir, "round-1.json"));
      assert.equal(round1.verdict, "discard");
      assert.equal(round1.disposition.disposition, "escalate");
      assert.equal(round1.refusal, undefined);
      // …but the attempt is visible, so the round does not read as a lazy one.
      assert.match(round1.refusalRejected, /did not qualify/);
      assert.match(round1.refusalRejected, /no named anchors/);
      const shown = renderChainShow(
        readJson(path.join(chainDir, "chain.json")), [round1], [], readChainControl(chainDir),
      );
      assert.match(shown, /!! refusal not qualifying:/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a round that edited files never refuses, whatever its report says", async () => {
    const { tmp, chainDir, text } = await runFreshChain({
      statusOutput: " M src/foo.js\n",
      implementReport: REFUSAL_REPORT,
    });
    try {
      // Normal routes apply: the reviewer approved and the probes are green.
      assert.match(text, /accepted at round 1/);
      assert.doesNotMatch(text, /refused at round/);
      const round1 = readJson(path.join(chainDir, "round-1.json"));
      assert.equal(round1.disposition.disposition, "accept");
      assert.equal(round1.verdict, "approve");
      assert.equal(round1.refusal, undefined);
      // The stray block is surfaced rather than swallowed.
      assert.equal(round1.strayRefusalBlock.anchors.length, 2);
      assert.match(round1.strayRefusalBlock.note, /accompanied by edits is not a refusal/);
      const shown = renderChainShow(
        readJson(path.join(chainDir, "chain.json")), [round1], [], readChainControl(chainDir),
      );
      assert.match(shown, /!! stray refusal block:/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("existence gate: a block naming two REAL items still refuses end to end", async () => {
    // The gate must not reject honest refusals: the two anchors here check
    // out against the brief and the worktree (a real heading, a real file at
    // cwd), so the round terminates as a refusal exactly as before the gate.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-refusal-gate-"));
    const chainDir = path.join(tmp, "chains", "chain-refusal");
    fs.mkdirSync(chainDir, { recursive: true });
    fs.mkdirSync(path.join(tmp, "plugins", "kusabi", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "plugins", "kusabi", "scripts", "chain-phases.test.mjs"), "// fixture\n");
    writeChainControl(chainDir, {
      chainId: "chain-refusal", container: "cid-1", pid: process.pid,
      status: "running", round: 0, startedAt: new Date().toISOString(),
    });
    const gateBrief = "Implement X.\n\n## Frozen tests\n\nAll existing tests pass unchanged.\n\n## Deliverables\n- src/foo.js\n";
    const dispatch = reportingDispatch(REFUSAL_REPORT);
    try {
      const text = await runChainDriver({
        cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-refusal", container: "cid-1",
        model: "fake/model", modelChain: [["fake/model"], ["fake/pro"]], maxRounds: 4,
        brief: gateBrief, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
        verifyBaseline: { captured: true, gate_passed: true, lint: 0, types: 0, collected: 10, raw: {} },
        callTool: refusalCallTool({ statusOutput: "", cwd: tmp }),
        dispatchWithFallback: dispatch,
        keepServe: true,
        signalReceived: () => false,
        resume: null,
      });
      assert.match(text, /refused at round 1/);
      assert.match(text, /## Frozen tests/);
      assert.match(text, /plugins\/kusabi\/scripts\/chain-phases\.test\.mjs/);
      const round1 = readJson(path.join(chainDir, "round-1.json"));
      assert.equal(round1.disposition.disposition, "refused-brief-defect");
      assert.equal(round1.roundOutcome, "refusal");
      assert.equal(round1.verdict, "refusal");
      assert.equal(round1.refusal.anchors.length, 2);
      assert.equal(round1.refusal.qualifies, true);
      // The verified descriptor replaced the shape-only stamp on the record.
      assert.equal(round1.implementRefusal.qualifies, true);
      assert.equal(round1.refusalRejected, undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("existence gate: invented anchors no longer qualify — discard with the miss recorded", async () => {
    // The exact abuse case the gate exists for: REFUSAL_REPORT names
    // "## Frozen tests" although this brief has no such section, and the
    // worktree (cwd) contains no such file.  Before the gate the block
    // qualified on shape alone and terminated as a refusal; now both anchors
    // are unnamed, the round is the pre-existing discard, and the miss is
    // recorded so the round does not read as a lazy one.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-refusal-forge-"));
    const chainDir = path.join(tmp, "chains", "chain-refusal");
    fs.mkdirSync(chainDir, { recursive: true });
    writeChainControl(chainDir, {
      chainId: "chain-refusal", container: "cid-1", pid: process.pid,
      status: "running", round: 0, startedAt: new Date().toISOString(),
    });
    const dispatch = reportingDispatch(REFUSAL_REPORT);
    try {
      const text = await runChainDriver({
        cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-refusal", container: "cid-1",
        model: "fake/model", modelChain: [["fake/model"], ["fake/pro"]], maxRounds: 4,
        brief: "Implement X.\n\n## Deliverables\n- src/foo.js\n", orchestrator: null,
        baseSha: "abc123", worktreeBaseline: null,
        verifyBaseline: { captured: true, gate_passed: true, lint: 0, types: 0, collected: 10, raw: {} },
        callTool: refusalCallTool({ statusOutput: "", cwd: tmp }),
        dispatchWithFallback: dispatch,
        keepServe: true,
        signalReceived: () => false,
        resume: null,
      });
      // Routing is the pre-existing discard → escalate; the forgery does not ride.
      assert.match(text, /escalated at round 1/);
      assert.doesNotMatch(text, /refused at round/);
      const round1 = readJson(path.join(chainDir, "round-1.json"));
      assert.equal(round1.verdict, "discard");
      assert.equal(round1.verdictSource, "probe");
      assert.equal(round1.disposition.disposition, "escalate");
      assert.equal(round1.refusal, undefined);
      // The attempt is visible, with each invented anchor named and why.
      assert.match(round1.refusalRejected, /did not qualify/);
      assert.match(round1.refusalRejected, /anchor\(s\) not found/);
      assert.match(round1.refusalRejected, /## Frozen tests \(no such heading in the brief\)/);
      assert.match(round1.refusalRejected, /chain-phases\.test\.mjs \(no such file or directory in the repo\)/);
      // The verified descriptor replaced the shape-only stamp on the record.
      assert.equal(round1.implementRefusal.qualifies, false);
      // No rework budget consumed by the forgery: same as any discard.
      assert.equal(round1.reworkCount, 0);
      assert.equal(round1.pendingReworkStrategy, null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("container refusal anchor verification: inspects container filesystem, single-quotes paths, and bypasses host cwd (kusabi #351)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-container-refusal-"));
    const chainDir = path.join(tmp, "chains", "chain-refusal");
    fs.mkdirSync(chainDir, { recursive: true });
    writeChainControl(chainDir, {
      chainId: "chain-refusal", container: "cid-1", pid: process.pid,
      status: "running", round: 0, startedAt: new Date().toISOString(),
    });

    const brief = "Implement X.\n\n## Spec\n\nContradiction.\n\n## Deliverables\n- src/foo.js\n";
    const reportText = [
      "```kusabi-refusal",
      "anchor: ## Spec",
      "anchor: tests/a.py",
      "anchor: tests/missing.py",
      "why: spec contradicts test.",
      "```",
    ].join("\n");

    const execCalls = [];
    const callTool = async (toolName, params) => {
      if (toolName === "verify_in_container") {
        return {
          gate_passed: true, lint: [], types: [],
          tests: { full: { status: "ok", passed: 10, total: 10 } },
        };
      }
      if (toolName !== "sandbox_exec") return { output: "" };
      const scope = fakeChangeScopeResult(params);
      if (scope) return scope;
      const cmd = params.commands[0];
      execCalls.push(cmd);
      if (cmd.includes("test -e ")) {
        return { output: "OK tests/a.py\nNO tests/missing.py\n" };
      }
      if (cmd === "git rev-parse HEAD") return { output: "abc123\n" };
      if (cmd === "git status --porcelain") return { output: "" };
      return { output: "" };
    };

    const dispatch = reportingDispatch(reportText);

    // tests/a.py DOES NOT exist in host tmp directory!
    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-refusal", container: "cid-1",
      model: "fake/model", modelChain: [["fake/model"]], maxRounds: 4,
      brief, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      verifyBaseline: { captured: true, gate_passed: true, lint: 0, types: 0, collected: 10, raw: {} },
      callTool,
      dispatchWithFallback: dispatch,
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });

    try {
      assert.match(text, /refused at round 1/);

      const round1 = readJson(path.join(chainDir, "round-1.json"));
      assert.equal(round1.disposition.disposition, "refused-brief-defect");
      assert.equal(round1.roundOutcome, "refusal");
      assert.equal(round1.implementRefusal.qualifies, true);

      // tests/a.py is named and verified
      assert.ok(round1.implementRefusal.anchors.some((a) => a.name === "tests/a.py"));
      assert.ok(!round1.implementRefusal.unnamedAnchors.some((u) => u.startsWith("tests/a.py")));

      // tests/missing.py is listed under unnamed with exact wording
      assert.ok(round1.implementRefusal.unnamedAnchors.some((u) => u === "tests/missing.py (no such file or directory in the repo)"));

      // Exactly one sandbox_exec call for anchor checking
      const anchorExecs = execCalls.filter((c) => c.includes("test -e "));
      assert.equal(anchorExecs.length, 1);

      // Both paths are single-quoted in the command string sent to sandbox_exec
      const anchorCmd = anchorExecs[0];
      assert.ok(anchorCmd.includes("'tests/a.py'"));
      assert.ok(anchorCmd.includes("'tests/missing.py'"));
      assert.equal(
        anchorCmd,
        "test -e 'tests/a.py' && echo 'OK tests/a.py' || echo 'NO tests/a.py' && test -e 'tests/missing.py' && echo 'OK tests/missing.py' || echo 'NO tests/missing.py'"
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("container refusal anchor verification: container sandbox_exec failure disqualifies refusal with warning without crashing (kusabi #351)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-container-err-refusal-"));
    const chainDir = path.join(tmp, "chains", "chain-refusal");
    fs.mkdirSync(chainDir, { recursive: true });
    writeChainControl(chainDir, {
      chainId: "chain-refusal", container: "cid-1", pid: process.pid,
      status: "running", round: 0, startedAt: new Date().toISOString(),
    });

    const brief = "Implement X.\n\n## Spec\n\nContradiction.\n\n## Deliverables\n- src/foo.js\n";
    const reportText = [
      "```kusabi-refusal",
      "anchor: ## Spec",
      "anchor: tests/a.py",
      "why: spec contradicts test.",
      "```",
    ].join("\n");

    const callTool = async (toolName, params) => {
      if (toolName === "verify_in_container") {
        return {
          gate_passed: true, lint: [], types: [],
          tests: { full: { status: "ok", passed: 10, total: 10 } },
        };
      }
      if (toolName !== "sandbox_exec") return { output: "" };
      const scope = fakeChangeScopeResult(params);
      if (scope) return scope;
      const cmd = params.commands[0];
      if (cmd.includes("test -e ")) {
        throw new Error("container RPC dead");
      }
      if (cmd === "git rev-parse HEAD") return { output: "abc123\n" };
      if (cmd === "git status --porcelain") return { output: "" };
      return { output: "" };
    };

    const dispatch = reportingDispatch(reportText);

    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-refusal", container: "cid-1",
      model: "fake/model", modelChain: [["fake/model"]], maxRounds: 4,
      brief, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      verifyBaseline: { captured: true, gate_passed: true, lint: 0, types: 0, collected: 10, raw: {} },
      callTool,
      dispatchWithFallback: dispatch,
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });

    try {
      assert.match(text, /escalated at round 1/);

      const round1 = readJson(path.join(chainDir, "round-1.json"));
      assert.equal(round1.implementRefusal.qualifies, false);
      assert.match(round1.implementRefusal.disqualification, /container path existence check failed/);
      assert.match(round1.implementRefusal.disqualification, /container RPC dead/);
      assert.ok(round1.warnings.some((w) => w.includes("container path existence check failed")));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("container refusal anchor verification: when container is not set, inspects host cwd and never calls sandbox_exec for anchors (kusabi #351)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-host-refusal-"));
    const chainDir = path.join(tmp, "chains", "chain-refusal");
    fs.mkdirSync(chainDir, { recursive: true });
    fs.mkdirSync(path.join(tmp, "tests"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "tests", "a.py"), "# test");

    writeChainControl(chainDir, {
      chainId: "chain-refusal", container: null, pid: process.pid,
      status: "running", round: 0, startedAt: new Date().toISOString(),
    });

    const brief = "Implement X.\n\n## Spec\n\nContradiction.\n\n## Deliverables\n- src/foo.js\n";
    const reportText = [
      "```kusabi-refusal",
      "anchor: ## Spec",
      "anchor: tests/a.py",
      "why: spec contradicts test.",
      "```",
    ].join("\n");

    const execCalls = [];
    const callTool = async (toolName, params) => {
      if (toolName === "sandbox_exec") {
        const scope = fakeChangeScopeResult(params);
        if (scope) return scope;
        execCalls.push(params.commands?.[0] ?? params.argv?.join(" ") ?? "");
      }
      return { output: "" };
    };

    const dispatch = reportingDispatch(reportText);

    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-refusal", container: null,
      model: "fake/model", modelChain: [["fake/model"]], maxRounds: 4,
      brief, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      verifyBaseline: { captured: true, gate_passed: true, lint: 0, types: 0, collected: 10, raw: {} },
      callTool,
      dispatchWithFallback: dispatch,
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });

    try {
      assert.match(text, /refused at round 1/);

      const round1 = readJson(path.join(chainDir, "round-1.json"));
      assert.equal(round1.implementRefusal.qualifies, true);

      const anchorExecs = execCalls.filter((c) => c.includes("test -e "));
      assert.equal(anchorExecs.length, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// =========================================================================
// runChainDriver — brief-reachable probe failure terminates (kusabi #303)
// -------------------------------------------------------------------------
// The chain-msvwhslx6e60 incident (2026-08-17): a `## Frozen Tests` heading
// whose body was prose.  P5 correctly failed every round on "heading present
// but no entries parsed" — and every one of those rounds was unwinnable,
// because the probe's input is the BRIEF, which the worker cannot edit.  The
// normal disposition table nonetheless read `probesGreen=false` as a rework
// and spent the whole 4-round budget.
//
// These run the real driver end to end and check the two halves: a
// brief-reachable failure terminates at its first occurrence with no rework
// dispatched, and a worktree-reachable failure still buys its rework exactly
// as before.
// =========================================================================

describe("runChainDriver brief-syntax defect (kusabi #303)", () => {
  // The live shape: a canonical `## Frozen Tests` heading followed by prose.
  const DEFECTIVE_BRIEF = [
    "Implement X.",
    "",
    "## Deliverables",
    "- src/foo.js",
    "",
    "## Frozen Tests",
    "",
    "(none frozen by name — use judgement.)",
    "",
  ].join("\n");

  // The control group: a readable frozen section.  The round then fails P3 on
  // a WORKTREE-reachable fact (it changed something, but not the declared
  // deliverable), which the worker can fix — so that failure must still route
  // to a rework.
  const WORKTREE_FAILURE_BRIEF = [
    "Implement X.",
    "",
    "## Deliverables",
    "- src/foo.js",
    "",
    "## Frozen Tests",
    "- tests/a.test.mjs",
    "",
  ].join("\n");

  function chainCallTool({ statusOutput }) {
    return async (toolName, params) => {
      if (toolName === "verify_in_container") {
        return {
          gate_passed: true, lint: [], types: [],
          tests: { full: { status: "ok", passed: 10, total: 10 } },
        };
      }
      if (toolName !== "sandbox_exec") return { output: "" };
      const scope = fakeChangeScopeResult(params);
      if (scope) return scope;
      const cmd = params.commands[0];
      if (cmd.startsWith("cd /workspace &&") && cmd.includes("TMPIDX=")) {
        return { output: "ERROR_NO_INDEX\n" };
      }
      if (cmd === "git rev-parse HEAD") return { output: "abc123\n" };
      if (cmd === "git status --porcelain") return { output: statusOutput };
      if (cmd === "git log --oneline -5") return { output: "abc123 latest change\n" };
      if (cmd === "git ls-files --others --exclude-standard") return { output: "" };
      return { output: "" };
    };
  }

  // The reviewer APPROVES every round: without the #303 row the round would
  // derive `rework` on "deterministic probes failed", which is exactly the
  // routing under test.
  function approvingDispatch() {
    const calls = [];
    const dispatch = async (opts) => {
      calls.push(opts);
      if (opts.kind === "review") {
        return {
          job: {
            id: "job-rev-" + calls.length, status: "completed", modelEntry: "fake/review",
            modelVariant: null, fallbacks: null, sessionID: "sess-rev", usage: null, error: null,
          },
          resultText: JSON.stringify({ schema_version: 1, verdict: "approve", findings: [], summary: "ok", next_steps: [] }),
        };
      }
      return {
        job: {
          id: "job-imp-" + (opts.round ?? 1), status: "completed", modelEntry: "fake/model",
          modelVariant: null, fallbacks: null, sessionID: "sess-imp-1", usage: null, error: null,
        },
        resultText: "Done; report follows.",
      };
    };
    dispatch.calls = calls;
    return dispatch;
  }

  async function runFresh({ brief, statusOutput, dispatchWithFallback: customDispatch, reviewJobStatus, reviewJobError }) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-briefsyntax-"));
    const chainDir = path.join(tmp, "chains", "chain-bsd");
    fs.mkdirSync(chainDir, { recursive: true });
    writeChainControl(chainDir, {
      chainId: "chain-bsd", container: "cid-1", pid: process.pid,
      status: "running", round: 0, startedAt: new Date().toISOString(),
    });
    const dispatch = customDispatch || (reviewJobStatus ? async (opts) => {
      if (opts.kind === "review") {
        return { job: { id: "job-rev-1", status: reviewJobStatus, error: reviewJobError || "quota limit" }, resultText: "" };
      }
      return { job: { id: "job-1", status: "completed" }, resultText: "verdict: approve" };
    } : approvingDispatch());
    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-bsd", container: "cid-1",
      model: "fake/model", modelChain: [["fake/model"], ["fake/pro"]], maxRounds: 4,
      brief, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      verifyBaseline: { captured: true, gate_passed: true, lint: 0, types: 0, collected: 10, raw: {} },
      callTool: chainCallTool({ statusOutput }),
      dispatchWithFallback: dispatch,
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });
    return { tmp, chainDir, text, dispatch };
  }

  it("terminates at round 1 with no rework dispatched, and attributes the defect to the brief", async () => {
    const { tmp, chainDir, text, dispatch } = await runFresh({
      brief: DEFECTIVE_BRIEF,
      statusOutput: " M src/foo.js\n",
    });
    try {
      // ---- the outcome an orchestrator reads ----
      assert.match(text, /stopped at round 1/);
      assert.match(text, /## Frozen Tests heading present but no entries parsed/);
      assert.match(text, /No rework was dispatched/);
      assert.match(text, /BRIEF defect, not a worker failure/);
      assert.match(text, /an empty section must omit its heading/);
      assert.doesNotMatch(text, /accepted at round/);
      assert.doesNotMatch(text, /escalated at round/);
      assert.doesNotMatch(text, /reached max rounds/);

      const round1 = readJson(path.join(chainDir, "round-1.json"));
      assert.equal(round1.disposition.disposition, "refused-brief-defect");
      // The record names the offending section and whose defect it is.
      assert.equal(
        round1.briefSyntaxDefect,
        "P5: frozen: ## Frozen Tests heading present but no entries parsed",
      );
      assert.equal(round1.roundOutcome, "brief-syntax-defect");
      assert.match(round1.disposition.reason, /brief author's defect, not the worker's/);
      assert.match(round1.disposition.reason, /Fix the brief and re-dispatch/);

      // The probe itself is unchanged: P5 failed, and it is not an oracle
      // violation (nothing was violated; the declaration is unreadable).
      const p5 = round1.probeResults.find((p) => p.probe === "P5: frozen");
      assert.equal(p5.passed, false);
      assert.match(p5.detail, /heading present but no entries parsed/);
      assert.equal(round1.oracleViolation, false);
      assert.equal(round1.probesGreen, false);

      // ---- no round was bought ----
      assert.equal(round1.reworkCount, 0);
      assert.equal(round1.pendingReworkStrategy, null);
      assert.equal(fs.existsSync(path.join(chainDir, "round-2.json")), false);
      assert.equal(readJson(path.join(chainDir, "chain.json")).records.length, 1);
      assert.equal(dispatch.calls.filter((c) => c.kind !== "review").length, 1);

      // ---- terminal for chain-wait and legible in chain-show ----
      const control = readChainControl(chainDir);
      assert.equal(control.status, "completed");
      assert.equal(control.round, 1);
      assert.equal(TERMINAL_DISPOSITIONS.has("refused-brief-defect"), true);
      const shown = renderChainShow(
        readJson(path.join(chainDir, "chain.json")), [round1], [], control,
      );
      assert.match(shown, /status: refused at round 1 — brief defect/);
      assert.match(shown, /disposition: refused-brief-defect/);
      assert.match(shown, /## Frozen Tests/);
      // No worker refusal happened, so the worker-named-items block is absent.
      assert.doesNotMatch(shown, /contradicting items named by the worker/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("leaves a WORKTREE-reachable probe failure on today's rework routing", async () => {
    // Same fixture, readable frozen section, and a change set that touches
    // nothing declared: P3 fails on a fact the worker can fix, so the round
    // must still buy its rework.
    const { tmp, chainDir, text, dispatch } = await runFresh({
      brief: WORKTREE_FAILURE_BRIEF,
      statusOutput: " M src/other.js\n",
    });
    try {
      const round1 = readJson(path.join(chainDir, "round-1.json"));
      assert.equal(round1.disposition.disposition, "rework");
      assert.equal(round1.disposition.reason, "deterministic probes failed");
      assert.equal(round1.briefSyntaxDefect, undefined);
      assert.equal(round1.roundOutcome, undefined);
      const p3 = round1.probeResults.find((p) => p.probe === "P3: deliverables");
      assert.equal(p3.passed, false);
      assert.match(p3.detail, /no declared deliverable touched/);
      // A rework round WAS dispatched.
      assert.equal(fs.existsSync(path.join(chainDir, "round-2.json")), true);
      assert.ok(dispatch.calls.filter((c) => c.kind !== "review").length > 1);
      assert.doesNotMatch(text, /stopped at round 1/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  describe("provisional review records (issue #357)", () => {
    it("writes a provisional review record on review provider error exit when probes were run", async () => {
      const { tmp, chainDir, text } = await runFresh({
        brief: "Implement X.\n## Deliverables\n- src/x.js\n",
        statusOutput: " M src/x.js\n",
        reviewJobStatus: "provider-error",
        reviewJobError: "quota exceeded",
      });
      try {
        const recordPath = path.join(chainDir, "review-record.md");
        assert.equal(fs.existsSync(recordPath), true, "provisional review-record.md must be written");
        assert.match(text, /review record: .*review-record\.md/);

        const content = fs.readFileSync(recordPath, "utf8");
        assert.match(content, /Note: PROVISIONAL RECORD — chain did not reach a disposition and may be superseded by chain-resume\./);
        assert.match(content, /Final disposition: failed at round 1 of 4/);
        assert.match(content, /_No review verdict was delivered for this chain — implementation remains unadjudicated\._/);
        assert.match(content, /\| 1 \| unknown \| _No review verdict delivered — unadjudicated implementation_ \| _fill_ \| _fill_ \|/);

        const control = readChainControl(chainDir);
        assert.equal(control.status, "failed");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("does not write a review record when cancelled before any round's probes run", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-stop-preround-"));
      try {
        const chainDir = path.join(tmp, "chains", "chain-stop-pre");
        fs.mkdirSync(chainDir, { recursive: true });
        writeChainControl(chainDir, {
          chainId: "chain-stop-pre", container: "cid-1", pid: process.pid,
          status: "running", round: 0, startedAt: new Date().toISOString(),
          stopRequestedAt: new Date().toISOString(),
        });

        const outcome = await runChainDriver({
          cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-stop-pre", container: "cid-1",
          model: "fake/model", modelChain: [["fake/model"]], maxRounds: 3,
          brief: "Implement X.\n", orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
          verifyBaseline: null,
          callTool: async (toolName, params) => fakeChangeScopeResult(params) ?? createFakeCallTool()(toolName, params),
          dispatchWithFallback: approvingDispatch(),
          keepServe: true,
          signalReceived: () => false,
          resume: null,
        });

        assert.match(outcome, /Chain chain-stop-pre cancelled at round 1 \(stop requested\)\./);
        assert.doesNotMatch(outcome, /review record:/);
        assert.equal(fs.existsSync(path.join(chainDir, "review-record.md")), false);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("rethrows the original exception if an error occurs mid-round without being swallowed", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-throw-"));
      try {
        const chainDir = path.join(tmp, "chains", "chain-err");
        fs.mkdirSync(chainDir, { recursive: true });
        writeChainControl(chainDir, {
          chainId: "chain-err", container: "cid-1", pid: process.pid,
          status: "running", round: 0, startedAt: new Date().toISOString(),
        });

        const customDispatch = async () => {
          throw new Error("unexpected internal crash");
        };

        await assert.rejects(
          async () => {
            await runChainDriver({
              cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-err", container: "cid-1",
              model: "fake/model", modelChain: [["fake/model"]], maxRounds: 3,
              brief: "Implement X.\n", orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
              verifyBaseline: null,
              callTool: async (toolName, params) => fakeChangeScopeResult(params) ?? createFakeCallTool()(toolName, params),
              dispatchWithFallback: customDispatch,
              keepServe: true,
              signalReceived: () => false,
              resume: null,
            });
          },
          {
            name: "Error",
            message: "unexpected internal crash",
          }
        );
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});

describe("runChainDriver quota-exhausted review (kusabi #373)", () => {
  const BRIEF = "Implement X.\n\n## Deliverables\n- src/foo.js\n";
  const AGY_ERR = "agy dispatch failed: agy returned no payload {\"status\":\"ERROR\",\"response\":\"\",\"error\":\"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h1m21s.\"}";

  function fakeCallTool() {
    return async (toolName, params) => {
      if (toolName === "verify_in_container") return { gate_passed: true };
      if (toolName !== "sandbox_exec") return { output: "" };
      const scope = fakeChangeScopeResult(params);
      if (scope) return scope;
      const cmd = params.commands[0];
      if (cmd.startsWith("cd /workspace &&") && cmd.includes("TMPIDX=")) {
        return { output: "ERROR_NO_INDEX\n" };
      }
      if (cmd === "git rev-parse HEAD") return { output: "abc123\n" };
      if (cmd === "git status --porcelain") return { output: " M src/foo.js\n" };
      if (cmd === "git log --oneline -5") return { output: "abc123 latest change\n" };
      if (cmd === "git diff") return { output: "diff --git a/src/foo.js b/src/foo.js\n" };
      if (cmd === "git ls-files --others --exclude-standard") return { output: "" };
      return { output: "" };
    };
  }

  it("escalates naming the exhausted pool instead of unexpected verdict: unparseable", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-quota-round-"));
    try {
      const chainDir = path.join(tmp, "chains", "chain-test");
      fs.mkdirSync(chainDir, { recursive: true });
      writeChainControl(chainDir, {
        chainId: "chain-test", container: "cid-1", pid: process.pid,
        status: "running", round: 0, startedAt: new Date().toISOString(),
      });
      const dispatch = async (opts) => {
        if (opts.kind === "review") {
          return {
            job: {
              id: "job-rev-1", status: "error", modelEntry: "gemini-3.6-flash-high",
              modelVariant: null, fallbacks: null, sessionID: null,
              usage: null, error: AGY_ERR, failure: null,
            },
            resultText: "",
          };
        }
        return {
          job: {
            id: "job-imp-1", status: "completed", modelEntry: "gemini-3.6-flash-high",
            modelVariant: null, fallbacks: null, sessionID: "sess-1",
            usage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            error: null,
          },
          resultText: "implemented",
        };
      };
      const text = await runChainDriver({
        cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
        model: "gemini-3.6-flash-high", modelChain: [["gemini-3.6-flash-high"]], maxRounds: 4,
        brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
        callTool: fakeCallTool(),
        backend: "agy", reviewBackend: "agy",
        dispatchWithFallback: dispatch,
        keepServe: true,
        signalReceived: () => false,
        resume: null,
      });
      assert.match(text, /quota exhausted \(agy individual pool\)/);
      assert.doesNotMatch(text, /unexpected verdict: unparseable/);
      const round1 = readJson(path.join(chainDir, "round-1.json"));
      assert.equal(round1.reviewJobFailure.kind, "quota-exhaustion");
      assert.equal(round1.reviewJobFailure.backend, "agy");
      assert.equal(round1.reviewJobError, AGY_ERR);
      assert.equal(round1.disposition.disposition, "escalate");
      assert.match(round1.disposition.reason, /quota exhausted \(agy individual pool\)/);
      assert.doesNotMatch(round1.disposition.reason, /unparseable/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});


// ---------------------------------------------------------------------------
// runChainDriver — change-scope fail-closed through the real driver path (kusabi #379)
// ---------------------------------------------------------------------------
// Empty stdout / non-zero exit from change-scope.mjs must fail the probe phase
// closed: no changeScope is persisted, and the review prompt is not given a
// fabricated authoritative scope. These go through runChainDriver (not an
// isolated runProbePhase mock).

describe("runChainDriver change-scope fail-closed (kusabi #379)", () => {
  const BRIEF = "Implement X.\n\n## Deliverables\n- src/real.js\n";

  function callToolForDriver(changeScopeResult) {
    return async (toolName, params) => {
      if (toolName === "verify_in_container") {
        return {
          gate_passed: true, lint: [], types: [],
          tests: { full: { status: "ok", passed: 10, total: 10 } },
        };
      }
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
      if (cmd.includes("change-scope.mjs")) {
        return changeScopeResult;
      }
      if (cmd.startsWith("cd /workspace &&") && cmd.includes("TMPIDX=")) {
        return { output: "ERROR_NO_INDEX\n" };
      }
      if (cmd === "git rev-parse HEAD") return { output: "abc123\n" };
      if (cmd === "git status --porcelain") return { output: " M src/real.js\n" };
      if (cmd === "git log --oneline -5") return { output: "abc123 latest\n" };
      if (cmd === "git ls-files --others --exclude-standard") return { output: "" };
      return { output: "" };
    };
  }

  function recordingDispatch() {
    const calls = [];
    const dispatch = async (opts) => {
      calls.push(opts);
      if (opts.kind === "review") {
        return {
          job: {
            id: "job-rev-1", status: "completed", modelEntry: "fake/review",
            modelVariant: null, fallbacks: null, sessionID: "sess-rev",
            usage: null, error: null,
          },
          resultText: JSON.stringify({ schema_version: 1, verdict: "approve", findings: [], summary: "ok", next_steps: [] }),
        };
      }
      return {
        job: {
          id: "job-imp-1", status: "completed", modelEntry: "fake/model",
          modelVariant: null, fallbacks: null, sessionID: "sess-imp-1",
          usage: null, error: null,
        },
        resultText: "implemented",
      };
    };
    dispatch.calls = calls;
    return dispatch;
  }

  async function runWith(changeScopeResult) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-scope-fail-"));
    const chainDir = path.join(tmp, "chains", "chain-scope");
    fs.mkdirSync(chainDir, { recursive: true });
    writeChainControl(chainDir, {
      chainId: "chain-scope", container: "cid-1", pid: process.pid,
      status: "running", round: 0, startedAt: new Date().toISOString(),
    });
    const dispatch = recordingDispatch();
    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-scope", container: "cid-1",
      model: "fake/model", modelChain: [["fake/model"]], maxRounds: 4,
      brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      verifyBaseline: { captured: true, gate_passed: true, lint: 0, types: 0, collected: 10, raw: {} },
      callTool: callToolForDriver(changeScopeResult),
      dispatchWithFallback: dispatch,
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });
    return { tmp, chainDir, text, dispatch };
  }

  it("empty change-scope stdout fails the round closed: no changeScope persisted, review has no fabricated scope", async () => {
    const { tmp, chainDir, dispatch } = await runWith({ output: "" });
    try {
      const round1 = readJson(path.join(chainDir, "round-1.json"));
      assert.equal(round1.changeScope, null);
      assert.equal(round1.probesGreen, false);
      const rpc = round1.probeResults.find((p) => p.passed === false);
      assert.ok(rpc, "must record a failed probe");
      assert.match(String(rpc.detail), /change-scope produced empty output/);
      const reviewCalls = dispatch.calls.filter((c) => c.kind === "review");
      for (const call of reviewCalls) {
        assert.doesNotMatch(
          call.promptText ?? "",
          /Authoritative change set \(`change-scope`\):/,
          "review must not be given a fabricated change-scope",
        );
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("non-zero change-scope exit fails the round closed: no changeScope persisted, review has no fabricated scope", async () => {
    const { tmp, chainDir, dispatch } = await runWith({
      exit_code: 1,
      stderr: "change-scope: base ref not found\n",
      output: "change-scope: base ref not found\n",
    });
    try {
      const round1 = readJson(path.join(chainDir, "round-1.json"));
      assert.equal(round1.changeScope, null);
      assert.equal(round1.probesGreen, false);
      const rpc = round1.probeResults.find((p) => p.passed === false);
      assert.ok(rpc, "must record a failed probe");
      assert.match(String(rpc.detail), /change-scope failed with exit code 1/);
      const reviewCalls = dispatch.calls.filter((c) => c.kind === "review");
      for (const call of reviewCalls) {
        assert.doesNotMatch(
          call.promptText ?? "",
          /Authoritative change set \(`change-scope`\):/,
          "review must not be given a fabricated change-scope",
        );
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
