import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { dispatchWithFallback, resetFailedRoutes } from "./prompt-execution.mjs";

function result(status, overrides = {}) {
  return {
    job: {
      id: overrides.id || "job-" + status,
      kind: "task",
      status,
      sessionID: overrides.sessionID || "exhausted-session",
      modelEntry: null,
      modelVariant: null,
      error: overrides.error || null,
      failure: overrides.failure || null,
      retry: overrides.retry || null,
      fallbacks: null,
      usage: null,
      stats: { steps: 0 },
    },
    resultText: overrides.resultText || "",
    stateDir: null,
  };
}

async function walk(firstResult, secondResult, options = {}) {
  const calls = [];
  const dispatch = (backend) => async (dispatchOptions) => {
    calls.push({ backend, options: dispatchOptions });
    return calls.length === 1 ? firstResult : secondResult;
  };

  const response = await dispatchWithFallback({
    _backendDispatch: dispatch,
    tiers: [["agy/first", "codex/second"]],
    round: 1,
    session: "exhausted-session",
    sessionProvenance: "agy",
    kind: "task",
    promptText: "walk quota",
    ...options,
  });
  return { calls, response };
}

describe("capacity ladder quota exhaustion", () => {
  it("advances a blocked non-last quota seat and returns the next seat job", async () => {
    resetFailedRoutes();
    const { calls, response } = await walk(
      result("error", {
        id: "agy-quota",
        error: "Individual quota reached. Please upgrade your subscription. Resets in 33m2s.",
        failure: {
          kind: "quota-exhaustion",
          backend: "agy",
          quota: "individual",
          backendBlocked: true,
          reset: "33m2s",
        },
      }),
      result("completed", { id: "codex-success", resultText: "done" }),
    );

    assert.equal(response.job.id, "codex-success");
    assert.deepEqual(calls.map((call) => call.backend), ["agy", "codex"]);
    assert.equal(calls[1].options.session, undefined);
    assert.deepEqual(response.job.fallbacks, [{
      from: "agy/first",
      to: "codex/second",
      reason: "quota-exhaustion",
      attempt: 0,
      message: "Individual quota reached. Please upgrade your subscription. Resets in 33m2s.",
    }]);
  });

  it("classifies an unstructured backend quota error and bounds its fallback message", async () => {
    resetFailedRoutes();
    const error = "Individual quota reached. " + "x".repeat(700);
    const { calls, response } = await walk(
      result("error", { error }),
      result("completed", { id: "codex-success" }),
    );

    assert.equal(calls.length, 2);
    assert.equal(response.job.id, "codex-success");
    assert.equal(response.job.fallbacks[0].reason, "quota-exhaustion");
    assert.equal(response.job.fallbacks[0].message.length, 501);
    assert.ok(response.job.fallbacks[0].message.endsWith("…"));
  });

  it("does not advance a quota classification that does not block the backend", async () => {
    resetFailedRoutes();
    const { calls, response } = await walk(
      result("error", {
        id: "not-blocked",
        error: "quota observed",
        failure: {
          kind: "quota-exhaustion",
          backend: "agy",
          quota: "individual",
          backendBlocked: false,
          reset: null,
        },
      }),
      result("completed", { id: "must-not-run" }),
    );

    assert.equal(calls.length, 1);
    assert.equal(response.job.id, "not-blocked");
    assert.equal(response.job.status, "error");
    assert.equal(response.job.fallbacks, null);
  });

  it("keeps a blocked quota failure unchanged when it is the last seat", async () => {
    resetFailedRoutes();
    const calls = [];
    const response = await dispatchWithFallback({
      _backendDispatch: (backend) => async (options) => {
        calls.push({ backend, options });
        return result("error", {
          id: "last-seat",
          error: "Individual quota reached. Resets in 1h.",
          failure: {
            kind: "quota-exhaustion",
            backend: "agy",
            quota: "individual",
            backendBlocked: true,
            reset: "1h",
          },
        });
      },
      tiers: [["agy/only"]],
      round: 1,
      session: "last-seat-session",
      sessionProvenance: "agy",
      kind: "task",
      promptText: "last seat",
    });

    assert.equal(calls.length, 1);
    assert.equal(response.job.id, "last-seat");
    assert.equal(response.job.status, "error");
    assert.deepEqual(response.job.failure, {
      kind: "quota-exhaustion",
      backend: "agy",
      quota: "individual",
      backendBlocked: true,
      reset: "1h",
    });
  });

  it("keeps a pinned blocked quota failure on the pinned seat", async () => {
    resetFailedRoutes();
    const calls = [];
    const response = await dispatchWithFallback({
      _backendDispatch: (backend) => async (options) => {
        calls.push({ backend, options });
        return result("error", {
          id: "pinned-seat",
          error: "Individual quota reached. Resets in 1h.",
          failure: {
            kind: "quota-exhaustion",
            backend: "agy",
            quota: "individual",
            backendBlocked: true,
            reset: "1h",
          },
        });
      },
      tiers: [["agy/first", "codex/second"]],
      explicitModel: "agy/first",
      round: 1,
      session: "pinned-session",
      sessionProvenance: "agy",
      kind: "task",
      promptText: "pinned seat",
    });

    assert.equal(calls.length, 1);
    assert.equal(response.job.id, "pinned-seat");
    assert.equal(response.job.status, "error");
    assert.equal(response.job.modelEntry, "agy/first");
  });

  it("remembers a quota-advanced route across dispatches", async () => {
    resetFailedRoutes();
    const calls = [];
    const dispatch = (backend) => async (options) => {
      calls.push({ backend, options });
      if (calls.length === 1) {
        return result("provider-error", {
          id: "a-provider-error",
          retry: { terminal: true, reason: "retry", attempt: 1, message: "a failed" },
        });
      }
      if (calls.length === 2) {
        return result("error", {
          id: "agy-quota",
          error: "Individual quota reached. Resets in 1h.",
          failure: {
            kind: "quota-exhaustion",
            backend: "agy",
            quota: "individual",
            backendBlocked: true,
            reset: "1h",
          },
        });
      }
      return result("completed", { id: "c-success" });
    };

    const first = await dispatchWithFallback({
      _backendDispatch: dispatch,
      tiers: [["a/model", "agy/like", "c/model"]],
      round: 1,
      session: "ladder-session",
      sessionProvenance: "opencode",
      kind: "task",
      promptText: "remember quota route",
    });
    assert.equal(first.job.id, "c-success");
    assert.deepEqual(calls.map((call) => call.backend), ["opencode", "agy", "opencode"]);

    const second = await dispatchWithFallback({
      _backendDispatch: dispatch,
      tiers: [["a/model", "agy/like", "c/model"]],
      round: 1,
      session: "ladder-session",
      sessionProvenance: "opencode",
      kind: "task",
      promptText: "remember quota route",
    });
    assert.equal(second.job.id, "c-success");
    assert.deepEqual(calls.map((call) => call.backend), ["opencode", "agy", "opencode", "opencode"]);
  });

  it("does not advance a completed job carrying quota failure data", async () => {
    resetFailedRoutes();
    const { calls, response } = await walk(
      result("completed", {
        id: "completed-with-quota",
        error: "Individual quota reached. Resets in 1h.",
        failure: {
          kind: "quota-exhaustion",
          backend: "agy",
          quota: "individual",
          backendBlocked: true,
          reset: "1h",
        },
      }),
      result("completed", { id: "must-not-run" }),
    );

    assert.equal(calls.length, 1);
    assert.equal(response.job.id, "completed-with-quota");
    assert.equal(response.job.status, "completed");
    assert.equal(response.job.fallbacks, null);
  });

  it("preserves an unbounded provider-error fallback message", async () => {
    resetFailedRoutes();
    const retryMessage = "provider failure: " + "x".repeat(700);
    const { calls, response } = await walk(
      result("provider-error", {
        retry: { reason: "server-error", attempt: 1, message: retryMessage },
      }),
      result("completed", { id: "codex-success" }),
    );

    assert.equal(calls.length, 2);
    assert.equal(response.job.id, "codex-success");
    assert.equal(response.job.fallbacks[0].message, retryMessage);
  });
});
