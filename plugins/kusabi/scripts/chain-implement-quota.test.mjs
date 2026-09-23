// chain-implement-quota.test.mjs — implement-side quota exhaustion stop and rendering (kusabi #453)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { runChainDriver } from "./chain-driver.mjs";
import { runImplementPhase } from "./chain-run.mjs";
import { renderChainShow, formatQuotaLine } from "./render-chain.mjs";
import { readChainControl, writeChainControl } from "./chain-control.mjs";
import { readJson } from "./state-paths.mjs";

const BRIEF = "Implement X.\\n\\n## Deliverables\\n- src/foo.js\\n";
const AGY_QUOTA_ERROR = "agy dispatch failed: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 33m2s.";

function makeFakeCallTool({ onCall } = {}) {
  return async (toolName, params) => {
    if (onCall) onCall(toolName, params);
    if (toolName === "verify_in_container") return { gate_passed: true };
    if (toolName !== "sandbox_exec") return { output: "" };
    const cmd = params.commands?.[0] ?? "";
    if (cmd.includes("change-scope.mjs")) {
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
    if (cmd.startsWith("cd /workspace &&") && cmd.includes("TMPIDX=")) {
      return { output: "ERROR_NO_INDEX\\n" };
    }
    if (cmd === "git rev-parse HEAD") return { output: "abc123\\n" };
    if (cmd === "git status --porcelain") return { output: " M src/foo.js\\n" };
    if (cmd === "git log --oneline -5") return { output: "abc123 latest change\\n" };
    if (cmd === "git diff") return { output: "diff --git a/src/foo.js b/src/foo.js\\n" };
    if (cmd === "git ls-files --others --exclude-standard") return { output: "" };
    return { output: "" };
  };
}

describe("implement quota exhaustion (kusabi #453)", () => {
  it("stops chain with failed status when implement job hits quota exhaustion (AC 1 & 2)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-imp-quota-"));
    try {
      const chainDir = path.join(tmp, "chains", "chain-test");
      fs.mkdirSync(chainDir, { recursive: true });
      writeChainControl(chainDir, {
        chainId: "chain-test", container: "cid-1", pid: process.pid,
        status: "running", round: 0, startedAt: new Date().toISOString(),
      });

      const toolCalls = [];
      const fakeCall = makeFakeCallTool({
        onCall: (toolName, params) => {
          toolCalls.push({ toolName, params });
        },
      });

      const dispatches = [];
      const dispatch = async (opts) => {
        dispatches.push(opts);
        if (opts.kind === "task") {
          return {
            job: {
              id: "job-imp-1",
              status: "error",
              modelEntry: "gemini-3.8-flash-high",
              modelVariant: null,
              fallbacks: null,
              sessionID: "sess-1",
              usage: null,
              error: AGY_QUOTA_ERROR,
              failure: null,
            },
            resultText: "",
          };
        }
        throw new Error(`unexpected dispatch of kind: ${opts.kind}`);
      };

      const outcome = await runChainDriver({
        cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
        model: "gemini-3.8-flash-high", modelChain: [["gemini-3.8-flash-high"]], maxRounds: 4,
        brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
        callTool: fakeCall,
        backend: "agy", reviewBackend: "agy",
        dispatchWithFallback: dispatch,
        keepServe: true,
        signalReceived: () => false,
        resume: null,
      });

      // Chain status must be \"failed\" (AC 1)
      const control = readChainControl(chainDir);
      assert.equal(control.status, "failed");
      assert.equal(control.round, 1);

      // No probes ran for the round (AC 1)
      const probeCalls = toolCalls.filter((c) =>
        c.toolName === "verify_in_container" ||
        (c.toolName === "sandbox_exec" && (
          c.params.commands?.[0]?.includes("git status --porcelain") ||
          c.params.commands?.[0]?.includes("git diff")
        ))
      );
      assert.equal(probeCalls.length, 0, "no probes must run for this round");

      // No review dispatched (AC 1)
      const reviewDispatches = dispatches.filter((d) => d.kind === "review");
      assert.equal(reviewDispatches.length, 0, "no review must be dispatched");
      assert.equal(dispatches.length, 1, "only the implement task should be dispatched");

      // Terminal outcome text names quota exhaustion (backend agy and reset 33m2s) and not \"empty round discarded\" (AC 2)
      assert.match(outcome, /implement provider exhausted/);
      assert.match(outcome, /Individual quota reached/);
      assert.match(outcome, /Resets in 33m2s/);
      assert.doesNotMatch(outcome, /empty round discarded/);

      // Round record has implementJobError and implementJobFailure stamped (Spec 1)
      const round1 = readJson(path.join(chainDir, "round-1.json"));
      assert.equal(round1.implementJobError, AGY_QUOTA_ERROR);
      assert.equal(round1.implementJobFailure?.kind, "quota-exhaustion");
      assert.equal(round1.implementJobFailure?.backend, "agy");
      assert.equal(round1.implementJobFailure?.quota, "individual");
      assert.equal(round1.implementJobFailure?.reset, "33m2s");
      assert.equal(round1.implementJobFailure?.backendBlocked, true);

      // Chain state records
      const chainState = readJson(path.join(chainDir, "chain.json"));
      assert.equal(chainState.records.length, 1);
      assert.deepEqual(chainState.records[0].implementJobFailure, round1.implementJobFailure);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("renders quota: and implement job error: in chain-show output (AC 3)", () => {
    const round = {
      round: 1,
      verdict: "discard",
      probesGreen: false,
      modelEntry: "agy/gemini-3.8-flash-high",
      resumeMethod: { type: "continue_session" },
      worktreeChanged: false,
      implementJobError: "agy dispatch failed: Individual quota reached. Resets in 33m2s.",
      implementJobFailure: {
        kind: "quota-exhaustion",
        backend: "agy",
        quota: "individual",
        backendBlocked: true,
        reset: "33m2s",
      },
      disposition: {
        disposition: "escalate",
        reason: "quota exhausted (agy individual pool); resets in 33m2s",
      },
      probeResults: [],
    };
    const show = renderChainShow({ chainId: "chain-x" }, [round]);
    assert.match(show, /quota: agy individual pool exhausted; resets in 33m2s/);
    assert.match(show, /implement job error: agy dispatch failed: Individual quota reached\. Resets in 33m2s\./);
  });

  it("formatQuotaLine formats pool and reset correctly", () => {
    assert.equal(
      formatQuotaLine({ kind: "quota-exhaustion", backend: "agy", quota: "individual", reset: "33m2s" }),
      "quota: agy individual pool exhausted; resets in 33m2s"
    );
    assert.equal(
      formatQuotaLine({ kind: "quota-exhaustion", backend: "opencode", quota: "free-tier", reset: null }),
      "quota: opencode free-tier pool exhausted"
    );
    assert.equal(formatQuotaLine(null), "");
  });

  it("unchanged: implement job with generic error follows existing path and runs probes (AC 4)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-imp-generic-err-"));
    try {
      const chainDir = path.join(tmp, "chains", "chain-test");
      fs.mkdirSync(chainDir, { recursive: true });
      writeChainControl(chainDir, {
        chainId: "chain-test", container: "cid-1", pid: process.pid,
        status: "running", round: 0, startedAt: new Date().toISOString(),
      });

      const toolCalls = [];
      const fakeCall = makeFakeCallTool({
        onCall: (toolName, params) => {
          toolCalls.push({ toolName, params });
        },
      });

      const dispatch = async (opts) => {
        if (opts.kind === "task") {
          return {
            job: {
              id: "job-imp-err",
              status: "error",
              modelEntry: "gemini-3.8-flash-high",
              modelVariant: null,
              fallbacks: null,
              sessionID: "sess-1",
              usage: null,
              error: "Some syntax error or internal model exception",
              failure: null,
            },
            resultText: "",
          };
        }
        if (opts.kind === "review") {
          return {
            job: {
              id: "job-rev-1",
              status: "completed",
              modelEntry: "gemini-3.8-flash-high",
              modelVariant: null,
              fallbacks: null,
              sessionID: "sess-rev-1",
              usage: null,
              error: null,
              failure: null,
            },
            resultText: "VERDICT: discard\\n",
          };
        }
        throw new Error(`unexpected dispatch: ${opts.kind}`);
      };

      await runChainDriver({
        cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
        model: "gemini-3.8-flash-high", modelChain: [["gemini-3.8-flash-high"]], maxRounds: 1,
        brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
        callTool: fakeCall,
        backend: "agy", reviewBackend: "agy",
        dispatchWithFallback: dispatch,
        keepServe: true,
        signalReceived: () => false,
        resume: null,
      });

      // Probes DID run because implementJobFailure was null and status was not provider-error
      const probeCalls = toolCalls.filter((c) =>
        c.toolName === "verify_in_container" ||
        (c.toolName === "sandbox_exec" && (
          c.params.commands?.[0]?.includes("git status --porcelain") ||
          c.params.commands?.[0]?.includes("git diff")
        ))
      );
      assert.ok(probeCalls.length > 0, "probes should have run for generic error");

      const round1 = readJson(path.join(chainDir, "round-1.json"));
      assert.equal(round1.implementJobError, "Some syntax error or internal model exception");
      assert.equal(round1.implementJobFailure, undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("unchanged: implement job with provider-error status stops chain (AC 4)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-imp-provider-err-"));
    try {
      const chainDir = path.join(tmp, "chains", "chain-test");
      fs.mkdirSync(chainDir, { recursive: true });
      writeChainControl(chainDir, {
        chainId: "chain-test", container: "cid-1", pid: process.pid,
        status: "running", round: 0, startedAt: new Date().toISOString(),
      });

      const dispatch = async (opts) => {
        if (opts.kind === "task") {
          return {
            job: {
              id: "job-imp-prov",
              status: "provider-error",
              modelEntry: "gemini-3.8-flash-high",
              modelVariant: null,
              fallbacks: null,
              sessionID: null,
              usage: null,
              error: "All routes exhausted: provider unavailable",
              failure: null,
            },
            resultText: "",
          };
        }
        throw new Error(`unexpected dispatch: ${opts.kind}`);
      };

      const outcome = await runChainDriver({
        cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
        model: "gemini-3.8-flash-high", modelChain: [["gemini-3.8-flash-high"]], maxRounds: 1,
        brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
        callTool: makeFakeCallTool(),
        backend: "agy", reviewBackend: "agy",
        dispatchWithFallback: dispatch,
        keepServe: true,
        signalReceived: () => false,
        resume: null,
      });

      const control = readChainControl(chainDir);
      assert.equal(control.status, "failed");
      assert.match(outcome, /implement provider exhausted/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("unchanged: review-side quota handling escalates with quota reason and shows in chain-show (AC 4)", () => {
    const chain = { chainId: "chain-quota" };
    const rounds = [{
      round: 1,
      verdict: "unparseable",
      reviewParseable: false,
      reviewJobError: "agy dispatch failed: Individual quota reached. Resets in 1h1m21s.",
      reviewJobFailure: {
        kind: "quota-exhaustion",
        backend: "agy",
        quota: "individual",
        backendBlocked: true,
        reset: "1h1m21s",
      },
      disposition: {
        disposition: "escalate",
        reason: "quota exhausted (agy individual pool); resets in 1h1m21s",
      },
    }];
    const result = renderChainShow(chain, rounds, [], { status: "completed", pid: 0 });
    assert.match(result, /escalated at round 1 \(quota exhausted \(agy individual pool\); resets in 1h1m21s\)/);
    assert.match(result, /quota: agy individual pool exhausted; resets in 1h1m21s/);
    assert.match(result, /review job error: agy dispatch failed: Individual quota reached/);
  });

  it("runImplementPhase stamps implementJobFailure on roundRecord when present (Spec 1)", async () => {
    const agyError = "agy dispatch failed: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 33m2s.";
    const result = await runImplementPhase({
      cwd: "/tmp", chainId: "chain-test", round: 1, isFirstRound: true,
      implementText: "brief", modelChain: [["gemini-3.8-flash-high"]], tierIndex: 0,
      useNewSession: false, session: undefined, resumeMethod: { type: "fresh_session" },
      flagsModel: null, backend: "agy",
      _dispatchWithFallback: async () => ({
        job: {
          id: "job-fail", status: "error", modelEntry: "gemini-3.8-flash-high",
          modelVariant: null, fallbacks: null, sessionID: null,
          usage: null, error: agyError, failure: null,
        },
        resultText: "",
      }),
    });
    assert.equal(result.implementJobStatus, "error");
    assert.equal(result.roundRecord.implementJobError, agyError);
    assert.deepEqual(result.roundRecord.implementJobFailure, {
      kind: "quota-exhaustion",
      backend: "agy",
      quota: "individual",
      backendBlocked: true,
      reset: "33m2s",
    });

    // Healthy round does not have implementJobFailure or implementJobError stamped
    const healthyResult = await runImplementPhase({
      cwd: "/tmp", chainId: "chain-test", round: 1, isFirstRound: true,
      implementText: "brief", modelChain: [["gemini-3.8-flash-high"]], tierIndex: 0,
      useNewSession: false, session: undefined, resumeMethod: { type: "fresh_session" },
      flagsModel: null, backend: "agy",
      _dispatchWithFallback: async () => ({
        job: {
          id: "job-ok", status: "completed", modelEntry: "gemini-3.8-flash-high",
          modelVariant: null, fallbacks: null, sessionID: "sess-ok",
          usage: null, error: null, failure: null,
        },
        resultText: "done",
      }),
    });
    assert.equal(healthyResult.roundRecord.implementJobFailure, undefined);
    assert.equal(healthyResult.roundRecord.implementJobError, undefined);
  });
});
