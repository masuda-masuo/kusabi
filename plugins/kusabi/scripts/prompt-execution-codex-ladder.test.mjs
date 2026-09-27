import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { dispatchWithFallback, resetFailedRoutes } from "./prompt-execution.mjs";

function fakeResult(status, overrides = {}) {
  return {
    job: {
      id: overrides.id || `job-${Math.random().toString(36).slice(2, 8)}`,
      kind: "task",
      status,
      backend: overrides.backend,
      sessionID: overrides.sessionID || null,
      modelEntry: null,
      modelVariant: null,
      retry: overrides.retry || null,
      fallbacks: null,
      error: null,
      usage: null,
      stats: {},
    },
    resultText: overrides.resultText || "",
    stateDir: null,
  };
}

function quotaFailure(backend) {
  return fakeResult("provider-error", {
    backend,
    retry: {
      reason: "free_tier_limit",
      message: "quota exhausted",
      attempt: 1,
      terminal: true,
    },
  });
}

describe("dispatchWithFallback codex ladder", () => {
  beforeEach(() => resetFailedRoutes());
  afterEach(() => resetFailedRoutes());

  it("dispatches a mixed opencode/agy/codex ladder on each route's backend", async () => {
    const calls = [];
    const backendDispatch = (backend) => async (opts) => {
      calls.push({ backend, opts });
      if (backend === "codex") {
        return fakeResult("completed", {
          backend,
          resultText: "codex completed",
        });
      }
      return quotaFailure(backend);
    };

    const { job, resultText } = await dispatchWithFallback({
      _backendDispatch: backendDispatch,
      _runPrompt: async () => {
        throw new Error("mixed ladder must not use the opencode fallback path");
      },
      tiers: [["opencode-go/a", "agy/b", "codex/gpt-5.6-luna"]],
      round: 1,
      kind: "task",
      promptText: "implement",
    });

    assert.deepEqual(calls.map(({ backend }) => backend), ["opencode", "agy", "codex"]);
    const codex = calls[2].opts;
    assert.equal(codex.explicitModel, "gpt-5.6-luna");
    assert.equal(codex.model, "gpt-5.6-luna");
    assert.deepEqual(codex.tiers, [["gpt-5.6-luna"]]);
    assert.equal(job.backend, "codex");
    assert.equal(job.modelEntry, "codex/gpt-5.6-luna");
    assert.equal(resultText, "codex completed");
  });

  it("drops a previous backend's session before the codex fallback", async () => {
    let codexOpts;
    const backendDispatch = (backend) => async (opts) => {
      if (backend === "agy") {
        return quotaFailure(backend);
      }
      codexOpts = opts;
      return fakeResult("completed", { backend, resultText: "fresh codex session" });
    };

    const { job } = await dispatchWithFallback({
      _backendDispatch: backendDispatch,
      tiers: [["agy/b", "codex/gpt-5.6-luna"]],
      round: 1,
      session: "agy-conversation-id",
      sessionProvenance: "agy",
      kind: "task",
      promptText: "implement",
    });

    assert.equal(codexOpts.session, undefined);
    assert.equal(codexOpts.sessionProvenance, undefined);
    assert.equal(job.backend, "codex");
  });

  it("passes explicit tool restrictions unchanged to codex instead of skipping it", async () => {
    let codexOpts;
    const tools = {
      mcp__sunaba__sandbox_exec: true,
      mcp__sunaba__sandbox_write_file: false,
    };
    const codexDispatch = async (opts) => {
      codexOpts = opts;
      return fakeResult("completed", { backend: "codex", resultText: "restricted codex run" });
    };

    const { job, resultText } = await dispatchWithFallback({
      _codexDispatch: codexDispatch,
      tiers: [["codex/gpt-5.6-luna"]],
      round: 1,
      kind: "task",
      promptText: "audit",
      tools,
      explicitRestrictions: true,
    });

    assert.equal(codexOpts.tools, tools);
    assert.equal(codexOpts.explicitModel, "gpt-5.6-luna");
    assert.equal(job.backend, "codex");
    assert.equal(resultText, "restricted codex run");
  });

  it("continues past a codex provider failure to the next backend", async () => {
    const calls = [];
    const backendDispatch = (backend) => async (opts) => {
      calls.push({ backend, opts });
      if (backend === "codex") return quotaFailure(backend);
      return fakeResult("completed", { backend, resultText: "opencode recovery" });
    };

    const { job, resultText } = await dispatchWithFallback({
      _backendDispatch: backendDispatch,
      tiers: [["codex/gpt-5.6-luna", "opencode-go/recovery"]],
      round: 1,
      kind: "task",
      promptText: "recover",
    });

    assert.deepEqual(calls.map(({ backend }) => backend), ["codex", "opencode"]);
    assert.equal(job.backend, "opencode");
    assert.equal(resultText, "opencode recovery");
  });
});
