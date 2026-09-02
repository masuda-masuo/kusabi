import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  accumulateUsage,
  catalogMissFromError,
  decidePermission,
  dispatchWithFallback,
  failedRoutes,
  providerStatusFromError,
  resetFailedRoutes,
} from "./prompt-execution.mjs";
import { stateDirFor } from "./state-paths.mjs";

// decidePermission — always returns "once"
// ---------------------------------------------------------------------------

describe("decidePermission", () => {
  it("returns 'once' with no arguments", () => {
    assert.equal(decidePermission(), "once");
  });

  it("returns 'once' with arbitrary arguments", () => {
    assert.equal(decidePermission("anything"), "once");
    assert.equal(decidePermission(42, { foo: 1 }), "once");
  });
});

// accumulateUsage
// ---------------------------------------------------------------------------

describe("accumulateUsage", () => {
  it("aggregates per-message tokens from message.updated events", () => {
    const events = [
      {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_1",
            role: "assistant",
            modelID: "deepseek-v4-flash",
            providerID: "opencode-go",
            cost: 0.0015,
            tokens: { total: 500, input: 200, output: 300, reasoning: 50, cache: { read: 1000, write: 0 } },
          },
        },
      },
      {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_2",
            role: "assistant",
            modelID: "deepseek-v4-flash",
            providerID: "opencode-go",
            cost: 0.0005,
            tokens: { total: 150, input: 50, output: 100, reasoning: 10, cache: { read: 500, write: 0 } },
          },
        },
      },
    ];
    const result = accumulateUsage(events);
    assert.equal(result.available, true);
    assert.equal(result.input, 250);
    assert.equal(result.output, 400);
    assert.equal(result.reasoning, 60);
    assert.equal(result.cacheRead, 1500);
    assert.equal(result.cacheWrite, 0);
    assert.equal(result.cost, 0.002);
    assert.equal(result.model, "opencode-go/deepseek-v4-flash");
  });

  it("uses the last update per message id (overwrites earlier partial data)", () => {
    const events = [
      {
        type: "message.updated",
        properties: {
          info: { id: "msg_1", role: "assistant", modelID: "m1", providerID: "p1", cost: 0.001, tokens: { input: 10, output: 20 } },
        },
      },
      {
        type: "message.updated",
        properties: {
          info: { id: "msg_1", role: "assistant", modelID: "m1", providerID: "p1", cost: 0.003, tokens: { input: 100, output: 200 } },
        },
      },
    ];
    const result = accumulateUsage(events);
    assert.equal(result.input, 100);
    assert.equal(result.output, 200);
    assert.equal(result.cost, 0.003);
  });

  it("returns available=false when no usage-related events exist", () => {
    const events = [
      { type: "session.idle", properties: {} },
      { type: "permission.asked", properties: { permission: { type: "bash" } } },
    ];
    const result = accumulateUsage(events);
    assert.equal(result.available, false);
  });

  it("returns available=false for empty event array", () => {
    const result = accumulateUsage([]);
    assert.equal(result.available, false);
  });

  it("ignores events with null/undefined properties", () => {
    const events = [
      { type: "message.updated", properties: {} },
      null,
      undefined,
      { type: "session.updated", properties: {} },
    ];
    const result = accumulateUsage(events);
    assert.equal(result.available, false);
  });

  it("session reuse: only counts messages observed during this job, not session cumulative", () => {
    // Simulate a reused session: the first session.updated shows cumulative tokens
    // from a previous job, but only message.updated for the new job's message is counted.
    const events = [
      {
        type: "session.updated",
        properties: {
          sessionID: "ses_reused",
          info: {
            id: "ses_reused",
            tokens: { input: 5000, output: 2000, reasoning: 1000, cache: { read: 100000, write: 0 } },
            cost: 0.02,
          },
        },
      },
      {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_new",
            role: "assistant",
            modelID: "deepseek-v4-flash",
            providerID: "opencode-go",
            cost: 0.001,
            tokens: { input: 300, output: 150, reasoning: 20, cache: { read: 5000, write: 0 } },
          },
        },
      },
    ];
    const result = accumulateUsage(events);
    // Should reflect only the new message, not the cumulative session totals.
    assert.equal(result.available, true);
    assert.equal(result.input, 300);
    assert.equal(result.output, 150);
    assert.equal(result.cost, 0.001);
  });

  it("falls back to session delta when no message.updated events but session deltas exist", () => {
    const events = [
      {
        type: "session.updated",
        properties: {
          sessionID: "ses_x",
          info: { id: "ses_x", tokens: { input: 100, output: 50 }, cost: 0.001, model: { providerID: "p1", id: "m1" } },
        },
      },
      {
        type: "session.updated",
        properties: {
          sessionID: "ses_x",
          info: { id: "ses_x", tokens: { input: 500, output: 200 }, cost: 0.005, model: { providerID: "p1", id: "m1" } },
        },
      },
    ];
    const result = accumulateUsage(events);
    assert.equal(result.available, true);
    assert.equal(result.input, 400);
    assert.equal(result.output, 150);
    assert.equal(result.cost, 0.004);
    assert.equal(result.model, "p1/m1");
  });

  it("returns available=false when only one session.updated with no messages", () => {
    const events = [
      {
        type: "session.updated",
        properties: {
          sessionID: "ses_x",
          info: { id: "ses_x", tokens: { input: 1000, output: 500 } },
        },
      },
    ];
    const result = accumulateUsage(events);
    assert.equal(result.available, false);
  });

  it("handles session.updated without tokens field gracefully", () => {
    const events = [
      { type: "session.updated", properties: { sessionID: "ses_x", info: { id: "ses_x" } } },
    ];
    const result = accumulateUsage(events);
    assert.equal(result.available, false);
  });

  it("handles message.updated without tokens field gracefully", () => {
    const events = [
      { type: "message.updated", properties: { info: { id: "msg_1", role: "assistant" } } },
    ];
    const result = accumulateUsage(events);
    assert.equal(result.available, false);
  });

  it("uses session delta when messages exist but have zero tokens", () => {
    const events = [
      {
        type: "message.updated",
        properties: {
          info: { id: "msg_1", role: "assistant", modelID: "m1", providerID: "p1", cost: 0, tokens: { input: 0, output: 0 } },
        },
      },
      {
        type: "session.updated",
        properties: {
          sessionID: "ses_x",
          info: { id: "ses_x", tokens: { input: 100, output: 50 }, cost: 0.001, model: { providerID: "p1", id: "m1" } },
        },
      },
      {
        type: "session.updated",
        properties: {
          sessionID: "ses_x",
          info: { id: "ses_x", tokens: { input: 300, output: 120 }, cost: 0.003, model: { providerID: "p1", id: "m1" } },
        },
      },
    ];
    const result = accumulateUsage(events);
    // Messages exist (with zero tokens), so per-message is used (zero tokens).
    assert.equal(result.available, true);
    assert.equal(result.input, 0);
    assert.equal(result.output, 0);
  });
});

// shouldFailFast — fail-fast decision for provider retry loops
// =========================================================================

import { shouldFailFast } from "./prompt-execution.mjs";

describe("shouldFailFast", () => {
  it("capacity reason free_tier_limit at attempt 1 → stop + terminal", () => {
    const result = shouldFailFast({ reason: "free_tier_limit", attempt: 1, steps: 0 });
    assert.equal(result.stop, true);
    assert.equal(result.terminal, true);
  });

  it("capacity reason free_tier_limit at attempt 2 → stop + terminal (no threshold)", () => {
    const result = shouldFailFast({ reason: "free_tier_limit", attempt: 2, steps: 0 });
    assert.equal(result.stop, true);
    assert.equal(result.terminal, true);
  });

  it("non-capacity reason at attempt 3 with steps=0 → stop", () => {
    const result = shouldFailFast({ reason: "rate_limit", attempt: 3, steps: 0 });
    assert.equal(result.stop, true);
    assert.equal(result.terminal, false);
  });

  it("non-capacity reason at attempt 3 with steps=0 and null reason → stop", () => {
    const result = shouldFailFast({ reason: null, attempt: 3, steps: 0 });
    assert.equal(result.stop, true);
    assert.equal(result.terminal, false);
  });

  it("non-capacity reason at attempt 3 with steps=0 and undefined reason → stop", () => {
    const result = shouldFailFast({ reason: undefined, attempt: 3, steps: 0 });
    assert.equal(result.stop, true);
    assert.equal(result.terminal, false);
  });

  it("non-capacity reason at attempt 2 with steps=0 → no stop (below threshold)", () => {
    const result = shouldFailFast({ reason: "rate_limit", attempt: 2, steps: 0 });
    assert.equal(result.stop, false);
  });

  it("non-capacity reason at attempt 1 with steps=0 → no stop", () => {
    const result = shouldFailFast({ reason: "rate_limit", attempt: 1, steps: 0 });
    assert.equal(result.stop, false);
  });

  it("non-capacity reason at attempt 5 with steps > 0 → no stop (real work in progress)", () => {
    const result = shouldFailFast({ reason: "rate_limit", attempt: 5, steps: 3 });
    assert.equal(result.stop, false);
  });

  it("no reason at attempt 4 with steps > 0 → no stop", () => {
    const result = shouldFailFast({ reason: null, attempt: 4, steps: 1 });
    assert.equal(result.stop, false);
  });

  it("capacity reason still fires even when steps > 0", () => {
    // Capacity is terminal regardless of progress.
    const result = shouldFailFast({ reason: "free_tier_limit", attempt: 1, steps: 5 });
    assert.equal(result.stop, true);
    assert.equal(result.terminal, true);
  });

  it("empty reason string is not treated as capacity", () => {
    const result = shouldFailFast({ reason: "", attempt: 3, steps: 0 });
    assert.equal(result.stop, true);  // attempt >= 3 + steps === 0
    assert.equal(result.terminal, false);  // NOT capacity
  });

  it("uses retryCount as fallback when attempt is absent (0)", () => {
    // Provider emits retry events but never numbers attempts — attempt is
    // always 0.  retryCount=3 should trip the threshold.
    const result = shouldFailFast({ reason: "rate_limit", attempt: 0, steps: 0, retryCount: 3 });
    assert.equal(result.stop, true);
    assert.equal(result.terminal, false);
  });

  it("retryCount fallback does not fire below threshold", () => {
    const result = shouldFailFast({ reason: "rate_limit", attempt: 0, steps: 0, retryCount: 2 });
    assert.equal(result.stop, false);
  });

  it("retryCount fallback works when attempt is undefined", () => {
    const result = shouldFailFast({ reason: "rate_limit", attempt: undefined, steps: 0, retryCount: 3 });
    assert.equal(result.stop, true);
    assert.equal(result.terminal, false);
  });

  it("attempt takes priority over retryCount when both are present", () => {
    // If the provider DOES number attempts, use that value, not retryCount.
    const result = shouldFailFast({ reason: "rate_limit", attempt: 1, steps: 0, retryCount: 10 });
    assert.equal(result.stop, false);  // attempt=1 < 3, even with high retryCount
  });
});

// =========================================================================
// dispatchWithFallback — integration tests with injected fake prompt runner
// =========================================================================

/**
 * Build a fake prompt-runner result object.
 */
function fakeResult(status, overrides = {}) {
  return {
    job: {
      id: overrides.id || "job-" + Math.random().toString(36).slice(2, 8),
      kind: "task",
      status,
      sessionID: overrides.sessionID || "sess-1",
      modelEntry: null,
      modelVariant: null,
      error: overrides.error || null,
      retry: overrides.retry || null,
      fallbacks: null,
      usage: overrides.usage !== undefined ? overrides.usage : null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      stats: { steps: overrides.steps || 0, ...(overrides.stats || {}) },
    },
    resultText: overrides.resultText || "",
    stateDir: overrides.stateDir || null,
  };
}

describe("dispatchWithFallback", () => {
  // Each test resets failedRoutes so tests do not interfere.
  beforeEach(() => {
    resetFailedRoutes();
  });

  afterEach(() => {
    resetFailedRoutes();
  });

  it("first route terminal failure → next tier route succeeds with fallbacks trail", async () => {
    let callCount = 0;
    const fakeRunner = async () => {
      callCount++;
      if (callCount === 1) {
        // First route (flash-free) fails with a terminal reason.
        return fakeResult("provider-error", {
          retry: { reason: "free_tier_limit", message: "quota exhausted", attempt: 1, count: 1, terminal: true },
        });
      }
      // Second route (flash) succeeds.
      return fakeResult("completed", { resultText: "done" });
    };

    const { job, resultText } = await dispatchWithFallback({
      _runPrompt: fakeRunner,
      tiers: [["route/flash-free", "route/flash"], ["route/pro"]],
      round: 1,
      kind: "task",
      promptText: "test",
    });

    assert.equal(job.status, "completed");
    assert.equal(resultText, "done");
    // The job should name the route that actually succeeded.
    assert.equal(job.modelEntry, "route/flash");
    // Fallbacks trail should record the first route's failure.
    assert.ok(Array.isArray(job.fallbacks));
    assert.equal(job.fallbacks.length, 1);
    assert.equal(job.fallbacks[0].from, "route/flash-free");
    assert.equal(job.fallbacks[0].to, "route/flash");
    assert.equal(job.fallbacks[0].reason, "free_tier_limit");
    assert.equal(job.fallbacks[0].terminal, undefined); // not stored on fallback entry directly
    // Terminal failure is remembered.
    assert.ok(failedRoutes.has("route/flash-free"));
  });

  it("every route fails → returns provider-error with exhaustive error", async () => {
    let callCount = 0;
    const fakeRunner = async () => {
      callCount++;
      return fakeResult("provider-error", {
        retry: { reason: "rate_limit", message: "try again later", attempt: 3, count: 3, terminal: false },
      });
    };

    const { job } = await dispatchWithFallback({
      _runPrompt: fakeRunner,
      tiers: [["route/a", "route/b"], ["route/c"]],
      round: 1,
      kind: "task",
      promptText: "test",
    });

    assert.equal(job.status, "provider-error");
    assert.ok(job.error.includes("All routes exhausted:"));
    assert.ok(job.error.includes("route/a"));
    assert.ok(job.error.includes("route/b"));
    assert.ok(job.error.includes("route/c"));
    assert.ok(Array.isArray(job.fallbacks));
    assert.equal(job.fallbacks.length, 3);
    assert.equal(callCount, 3);
  });

  it("all routes fail → returns substantial attempt that spent tokens over later 0/0 quota retry (kusabi #412)", async () => {
    let callCount = 0;
    const fakeRunner = async () => {
      callCount++;
      if (callCount === 1) {
        // First route ran 62 steps and spent tokens before hitting provider-error
        return fakeResult("provider-error", {
          id: "job-mtdzrhmv9e71",
          usage: { available: true, input: 181539, output: 17174 },
          steps: 62,
          retry: { reason: "rate_limit", message: "rate limit exceeded", attempt: 1, count: 1, terminal: false },
        });
      }
      // Second route failed immediately with 0 tokens / 0 steps
      return fakeResult("provider-error", {
        id: "job-mte0cb81ce91",
        usage: { available: false, input: 0, output: 0 },
        steps: 0,
        retry: { reason: "free_tier_limit", message: "Free usage exceeded, subscribe to Go", attempt: 1, count: 1, terminal: true },
      });
    };

    const { job } = await dispatchWithFallback({
      _runPrompt: fakeRunner,
      tiers: [["route/free-a", "route/free-b"]],
      round: 1,
      kind: "task",
      promptText: "test",
    });

    assert.equal(job.status, "provider-error");
    assert.equal(job.id, "job-mtdzrhmv9e71");
    assert.deepEqual(job.usage, { available: true, input: 181539, output: 17174 });
    assert.equal(job.stats.steps, 62);
    assert.equal(job.modelEntry, "route/free-a");
    assert.ok(Array.isArray(job.fallbacks));
    assert.equal(job.fallbacks.length, 2);
    // Route 1 fallback entry
    assert.equal(job.fallbacks[0].from, "route/free-a");
    assert.equal(job.fallbacks[0].to, "route/free-b");
    assert.equal(job.fallbacks[0].jobId, "job-mtdzrhmv9e71");
    assert.deepEqual(job.fallbacks[0].usage, { available: true, input: 181539, output: 17174 });
    // Route 2 fallback entry preserves quota death visibility
    assert.equal(job.fallbacks[1].from, "route/free-b");
    assert.equal(job.fallbacks[1].to, null);
    assert.equal(job.fallbacks[1].reason, "free_tier_limit");
    assert.equal(job.fallbacks[1].message, "Free usage exceeded, subscribe to Go");
    assert.equal(job.fallbacks[1].jobId, "job-mte0cb81ce91");
    // All routes exhausted error names both routes and quota reason
    assert.ok(job.error.includes("All routes exhausted:"));
    assert.ok(job.error.includes("route/free-a"));
    assert.ok(job.error.includes("route/free-b"));
    assert.ok(job.error.includes("free_tier_limit"));
    assert.ok(job.error.includes("Free usage exceeded, subscribe to Go"));
  });

  it("all routes fail with 0 tokens → chooses attempt with more steps", async () => {
    let callCount = 0;
    const fakeRunner = async () => {
      callCount++;
      if (callCount === 1) {
        return fakeResult("provider-error", {
          id: "job-step-10",
          usage: null,
          steps: 10,
          retry: { reason: "timeout", attempt: 1, terminal: false },
        });
      }
      return fakeResult("provider-error", {
        id: "job-step-0",
        usage: null,
        steps: 0,
        retry: { reason: "free_tier_limit", attempt: 1, terminal: true },
      });
    };

    const { job } = await dispatchWithFallback({
      _runPrompt: fakeRunner,
      tiers: [["route/x", "route/y"]],
      round: 1,
      kind: "task",
      promptText: "test",
    });

    assert.equal(job.status, "provider-error");
    assert.equal(job.id, "job-step-10");
    assert.equal(job.stats.steps, 10);
    assert.equal(job.fallbacks.length, 2);
  });

  it("does not throw and does not loop forever on all-exhausted", async () => {
    const fakeRunner = async () => {
      return fakeResult("provider-error", {
        retry: { reason: "rate_limit", attempt: 1, count: 1, terminal: false },
      });
    };

    // Only one candidate — should return immediately.
    const { job } = await dispatchWithFallback({
      _runPrompt: fakeRunner,
      tiers: [["route/only"]],
      round: 1,
      kind: "task",
      promptText: "test",
    });

    assert.equal(job.status, "provider-error");
  });

  it("--model override producing provider-error does NOT fall back to tier routes", async () => {
    let callCount = 0;
    const fakeRunner = async () => {
      callCount++;
      return fakeResult("provider-error", {
        retry: { reason: "free_tier_limit", message: "quota exceeded", attempt: 1, count: 1, terminal: true },
      });
    };

    const { job } = await dispatchWithFallback({
      _runPrompt: fakeRunner,
      tiers: [["route/default"], ["route/fallback"]],
      round: 1,
      explicitModel: "custom/override-model",
      kind: "task",
      promptText: "test",
    });

    assert.equal(job.status, "provider-error");
    assert.equal(callCount, 1);
    assert.ok(job.error.includes("custom/override-model"));
    assert.ok(job.error.includes("quota exceeded"));
  });

  it("pinned route in failedRoutes reports distinct error message", async () => {
    // First dispatch: terminal failure on pinned route.
    await dispatchWithFallback({
      _runPrompt: async () => fakeResult("provider-error", {
        retry: { reason: "free_tier_limit", message: "quota", attempt: 1, count: 1, terminal: true },
      }),
      tiers: [["route/default"]],
      round: 1,
      explicitModel: "custom/pinned-model",
      kind: "task",
      promptText: "test",
    });

    assert.ok(failedRoutes.has("custom/pinned-model"));

    // Second dispatch with same pinned route: should report pinned model is dead.
    const { job } = await dispatchWithFallback({
      _runPrompt: async () => fakeResult("completed", { resultText: "ok" }),
      tiers: [["route/default"]],
      round: 1,
      explicitModel: "custom/pinned-model",
      kind: "task",
      promptText: "test",
    });

    assert.equal(job.status, "provider-error");
    assert.equal(job.error, 'Pinned model "custom/pinned-model" has already failed terminally in this process.');
  });

  it("non-terminal failure is NOT added to failedRoutes", async () => {
    let callCount = 0;
    const fakeRunner = async () => {
      callCount++;
      if (callCount === 1) {
        return fakeResult("provider-error", {
          retry: { reason: "rate_limit", message: "transient", attempt: 3, count: 3, terminal: false },
        });
      }
      return fakeResult("completed", { resultText: "ok" });
    };

    await dispatchWithFallback({
      _runPrompt: fakeRunner,
      tiers: [["route/a", "route/b"]],
      round: 1,
      kind: "task",
      promptText: "test",
    });

    // The first route failed with a non-terminal reason — should NOT be
    // remembered for later dispatches.
    assert.equal(failedRoutes.has("route/a"), false);
  });

  it("terminal failure IS added to failedRoutes", async () => {
    const fakeRunner = async () => {
      return fakeResult("provider-error", {
        retry: { reason: "free_tier_limit", message: "quota", attempt: 1, count: 1, terminal: true },
      });
    };

    await dispatchWithFallback({
      _runPrompt: fakeRunner,
      tiers: [["route/doomed"]],
      round: 1,
      kind: "task",
      promptText: "test",
    });

    assert.ok(failedRoutes.has("route/doomed"));
  });

  it("terminal failure remembered across dispatches", async () => {
    // First dispatch: terminal failure on a route.
    await dispatchWithFallback({
      _runPrompt: async () => fakeResult("provider-error", {
        retry: { reason: "free_tier_limit", message: "gone", attempt: 1, count: 1, terminal: true },
      }),
      tiers: [["route/dead"]],
      round: 1,
      kind: "task",
      promptText: "test",
    });

    assert.ok(failedRoutes.has("route/dead"));

    // Second dispatch: the dead route should be skipped by selectRoutes.
    let secondCalled = false;
    const fakeRunner2 = async () => {
      secondCalled = true;
      return fakeResult("completed", { resultText: "ok" });
    };

    const { job } = await dispatchWithFallback({
      _runPrompt: fakeRunner2,
      tiers: [["route/dead", "route/alive"]],
      round: 1,
      kind: "task",
      promptText: "test",
    });

    // The alive route should have been selected (dead route skipped).
    assert.equal(job.modelEntry, "route/alive");
    assert.equal(secondCalled, true); // only called once for the alive route
  });
});

// =========================================================================
// classifyJobOutcome — pure function: outcome → status + error
// =========================================================================

import { classifyJobOutcome } from "./prompt-execution.mjs";

describe("classifyJobOutcome", () => {
  it("serve-dead takes precedence over all other outcomes", () => {
    const result = classifyJobOutcome({
      serveDead: { pid: 12345, port: 45063, since: "2026-07-26T12:00:00.000Z" },
      providerError: { reason: "free_tier_limit", attempt: 1, terminal: true, message: "quota" },
      watchdogFired: true,
      watchdogKilled: false,
      watchdogS: 900,
      sawIdle: false,
      sessionError: null,
      timeoutS: 300,
    });
    assert.equal(result.status, "serve-dead");
    assert.ok(result.error.includes("12345"));
    assert.ok(result.error.includes("45063"));
    assert.ok(result.error.includes("serve process died"));
  });

  it("provider-error is reported correctly", () => {
    const result = classifyJobOutcome({
      serveDead: null,
      providerError: { reason: "free_tier_limit", attempt: 1, terminal: true, message: "quota exhausted" },
      watchdogFired: false,
      watchdogKilled: false,
      watchdogS: 900,
      sawIdle: false,
      sessionError: null,
      timeoutS: 300,
    });
    assert.equal(result.status, "provider-error");
    assert.ok(result.error.includes("free_tier_limit"));
    assert.ok(result.error.includes("attempt 1"));
    assert.ok(result.error.includes("[terminal]"));
    assert.ok(result.error.includes("quota exhausted"));
  });

  it("non-terminal provider error is reported without [terminal] tag", () => {
    const result = classifyJobOutcome({
      serveDead: null,
      providerError: { reason: "rate_limit", attempt: 3, terminal: false, message: "try again" },
      watchdogFired: false,
      watchdogKilled: false,
      watchdogS: 900,
      sawIdle: false,
      sessionError: null,
      timeoutS: 300,
    });
    assert.equal(result.status, "provider-error");
    assert.ok(!result.error.includes("[terminal]"));
    assert.ok(result.error.includes("attempt 3"));
  });

  it("stalled (watchdog fired, process NOT killed)", () => {
    const result = classifyJobOutcome({
      serveDead: null,
      providerError: null,
      watchdogFired: true,
      watchdogKilled: false,
      watchdogS: 900,
      sawIdle: false,
      sessionError: null,
      timeoutS: 300,
    });
    assert.equal(result.status, "stalled");
    assert.ok(result.error.includes("no events for 900s"));
    assert.ok(!result.error.includes("killed"));
  });

  it("stalled (watchdog fired, process killed)", () => {
    const result = classifyJobOutcome({
      serveDead: null,
      providerError: null,
      watchdogFired: true,
      watchdogKilled: true,
      watchdogS: 900,
      sawIdle: false,
      sessionError: null,
      timeoutS: 300,
    });
    assert.equal(result.status, "stalled");
    assert.ok(result.error.includes("process killed"));
  });

  it("timeout when aborted but no idle and no session error", () => {
    const result = classifyJobOutcome({
      serveDead: null,
      providerError: null,
      watchdogFired: false,
      watchdogKilled: false,
      watchdogS: 0,
      sawIdle: false,
      sessionError: null,
      timeoutS: 120,
    });
    assert.equal(result.status, "timeout");
    assert.ok(result.error.includes("timed out after 120s"));
  });

  it("session error", () => {
    const result = classifyJobOutcome({
      serveDead: null,
      providerError: null,
      watchdogFired: false,
      watchdogKilled: false,
      watchdogS: 0,
      sawIdle: false,
      sessionError: '{"message":"something broke"}',
      timeoutS: 120,
    });
    assert.equal(result.status, "error");
    assert.equal(result.error, '{"message":"something broke"}');
  });

  it("completed when sawIdle with no error", () => {
    const result = classifyJobOutcome({
      serveDead: null,
      providerError: null,
      watchdogFired: false,
      watchdogKilled: false,
      watchdogS: 0,
      sawIdle: true,
      sessionError: null,
      timeoutS: 300,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.error, null);
  });

  it("no idle and no error is a timeout, not completed", () => {
    // The session never reported idle, so the watcher ended without the
    // session finishing.  This is the production shape of a timeout — the
    // caller has always aborted by the time it classifies, so "did we abort"
    // carries no information and is deliberately not an input.
    const result = classifyJobOutcome({
      serveDead: null,
      providerError: null,
      watchdogFired: false,
      watchdogKilled: false,
      watchdogS: 0,
      sawIdle: false,
      sessionError: null,
      timeoutS: 300,
    });
    assert.equal(result.status, "timeout");
  });

  it("stalled cannot be confused with serve-dead — serve-dead wins", () => {
    // Both conditions true: serve-dead must win.
    const result = classifyJobOutcome({
      serveDead: { pid: 999, port: 44444, since: "2026-07-26T12:00:00.000Z" },
      providerError: null,
      watchdogFired: true,
      watchdogKilled: false,
      watchdogS: 900,
      sawIdle: false,
      sessionError: null,
      timeoutS: 300,
    });
    assert.equal(result.status, "serve-dead");
    assert.ok(!result.error.includes("stalled"));
    assert.ok(!result.error.includes("watchdog"));
  });

  it("sawIdle is completed, not timeout", () => {
    // The session reported idle, so it finished — the cleanup abort that
    // always precedes classification must not turn that into a timeout.
    const result = classifyJobOutcome({
      serveDead: null,
      providerError: null,
      watchdogFired: false,
      watchdogKilled: false,
      watchdogS: 0,
      sawIdle: true,
      sessionError: null,
      timeoutS: 300,
    });
    assert.equal(result.status, "completed");
  });
});
// =========================================================================
// providerStatusFromError — session.error provider classification (kusabi #233)
// =========================================================================
// The incident payload (2026-08-13): a session.error whose error object is
// APIError-shaped with a structured `data.statusCode` — HTTP 401,
// isRetryable: false, and NO retry events before it.  These unit tests pin
// which payloads count as provider-scoped evidence (walk the tier) and
// which keep today's `error` outcome (fail closed).

const INCIDENT_401 = {
  name: "APIError",
  data: {
    message: "Upstream request failed: [invalid_bearer_credential] Missing or invalid bearer credential",
    statusCode: 401,
    isRetryable: false,
  },
};

describe("providerStatusFromError", () => {
  it("recognises the incident 401 APIError payload", () => {
    assert.deepEqual(providerStatusFromError(INCIDENT_401), {
      statusCode: 401,
      message: "Upstream request failed: [invalid_bearer_credential] Missing or invalid bearer credential",
    });
  });

  it("recognises 403, 429 and every 5xx statusCode", () => {
    for (const code of [403, 429, 500, 502, 503, 599]) {
      const result = providerStatusFromError({
        name: "APIError",
        data: { statusCode: code, message: "upstream refused" },
      });
      assert.equal(result.statusCode, code);
      assert.equal(result.message, "upstream refused");
    }
  });

  it("rejects statusCodes outside the provider-failure ranges", () => {
    for (const code of [0, 300, 400, 404, 418, 600, -1]) {
      assert.equal(providerStatusFromError({ name: "APIError", data: { statusCode: code } }), null);
    }
  });

  it("rejects a non-APIError name even with a provider statusCode", () => {
    assert.equal(providerStatusFromError({ name: "SomeOtherError", data: { statusCode: 401 } }), null);
    assert.equal(providerStatusFromError({ data: { statusCode: 401 } }), null);
    assert.equal(providerStatusFromError({ name: null, data: { statusCode: 401 } }), null);
  });

  it("rejects missing, null or malformed data", () => {
    assert.equal(providerStatusFromError({ name: "APIError" }), null);
    assert.equal(providerStatusFromError({ name: "APIError", data: null }), null);
    assert.equal(providerStatusFromError({ name: "APIError", data: "401" }), null);
    assert.equal(providerStatusFromError({ name: "APIError", data: [] }), null);
  });

  it("rejects a non-numeric statusCode", () => {
    assert.equal(providerStatusFromError({ name: "APIError", data: { statusCode: "401" } }), null);
    assert.equal(providerStatusFromError({ name: "APIError", data: { statusCode: null } }), null);
  });

  it("rejects null, undefined and primitive payloads", () => {
    assert.equal(providerStatusFromError(null), null);
    assert.equal(providerStatusFromError(undefined), null);
    assert.equal(providerStatusFromError("APIError"), null);
    assert.equal(providerStatusFromError(401), null);
  });

  it("tolerates a missing or non-string data.message", () => {
    assert.equal(providerStatusFromError({ name: "APIError", data: { statusCode: 429 } }).message, "");
    assert.equal(providerStatusFromError({ name: "APIError", data: { statusCode: 429, message: 42 } }).message, "");
  });

  it("tolerates extra payload fields (isRetryable, retryAfter, ...)", () => {
    const result = providerStatusFromError({
      name: "APIError",
      data: { message: "Upstream request failed", statusCode: 401, isRetryable: false, retryAfter: 5 },
    });
    assert.equal(result.statusCode, 401);
  });
});

// =========================================================================
// catalogMissFromError — session.error catalog-miss classification (kusabi #431)
// =========================================================================

const INCIDENT_CATALOG_MISS = {
  name: "UnknownError",
  data: {
    message: "Model not found: opencode/hy3-free. Did you mean: ling-3.0-flash-fin-free, mimo-v2.5-free, muse-spark-1.2-contributor-free?",
  },
};

describe("catalogMissFromError", () => {
  it("recognises the incident UnknownError catalog-miss payload", () => {
    assert.deepEqual(catalogMissFromError(INCIDENT_CATALOG_MISS), {
      reason: "catalog-miss",
      message: "Model not found: opencode/hy3-free. Did you mean: ling-3.0-flash-fin-free, mimo-v2.5-free, muse-spark-1.2-contributor-free?",
      terminal: true,
    });
  });

  it("rejects UnknownError whose message does not contain 'Model not found'", () => {
    assert.equal(catalogMissFromError({ name: "UnknownError", data: { message: "Internal server error" } }), null);
    assert.equal(catalogMissFromError({ name: "UnknownError", data: { message: "Model error" } }), null);
  });

  it("rejects UnknownError with missing, non-string, or malformed data.message", () => {
    assert.equal(catalogMissFromError({ name: "UnknownError" }), null);
    assert.equal(catalogMissFromError({ name: "UnknownError", data: null }), null);
    assert.equal(catalogMissFromError({ name: "UnknownError", data: {} }), null);
    assert.equal(catalogMissFromError({ name: "UnknownError", data: { message: 123 } }), null);
    assert.equal(catalogMissFromError({ name: "UnknownError", data: { message: null } }), null);
  });

  it("rejects non-UnknownError names even with 'Model not found' message", () => {
    assert.equal(catalogMissFromError({ name: "APIError", data: { message: "Model not found: foo" } }), null);
    assert.equal(catalogMissFromError({ name: "OtherError", data: { message: "Model not found: foo" } }), null);
  });

  it("rejects null, undefined and primitive payloads", () => {
    assert.equal(catalogMissFromError(null), null);
    assert.equal(catalogMissFromError(undefined), null);
    assert.equal(catalogMissFromError("UnknownError"), null);
    assert.equal(catalogMissFromError(500), null);
  });
});

// =========================================================================
// dispatchWithFallback — session.error-shaped provider failure advances the
// walk within the dispatch only (kusabi #233)
// =========================================================================
// The fake runner below returns exactly what runPrompt now produces for the
// incident stream: a provider-error job whose `retry` record carries the
// structured HTTP status (reason "http-401"), attempt 0, and terminal false.

describe("dispatchWithFallback — non-retryable provider failure (session.error shape)", () => {
  beforeEach(() => {
    resetFailedRoutes();
  });

  afterEach(() => {
    resetFailedRoutes();
  });

  it("advances to the next route of the same tier, records the fallback and the reason", async () => {
    let callCount = 0;
    const fakeRunner = async () => {
      callCount++;
      if (callCount === 1) {
        return fakeResult("provider-error", {
          retry: {
            reason: "http-401",
            message: "Upstream request failed: [invalid_bearer_credential] Missing or invalid bearer credential",
            attempt: 0,
            count: 0,
            terminal: false,
          },
        });
      }
      return fakeResult("completed", { resultText: "done via route two" });
    };

    const { job, resultText } = await dispatchWithFallback({
      _runPrompt: fakeRunner,
      tiers: [["route/free", "route/go"]],
      round: 1,
      kind: "task",
      promptText: "test",
    });

    assert.equal(job.status, "completed");
    assert.equal(resultText, "done via route two");
    assert.equal(job.modelEntry, "route/go");
    // Each route attempted exactly once — no same-route retry.
    assert.equal(callCount, 2);
    // No route poisoning: the 401 route is not remembered across dispatches.
    assert.equal(failedRoutes.size, 0);
    assert.ok(Array.isArray(job.fallbacks));
    assert.equal(job.fallbacks.length, 1);
    assert.deepEqual(job.fallbacks[0], {
      from: "route/free",
      to: "route/go",
      reason: "http-401",
      attempt: 0,
      message: "Upstream request failed: [invalid_bearer_credential] Missing or invalid bearer credential",
    });
  });

  it("a plain error (no structured status) keeps today's behavior: no walk", async () => {
    let callCount = 0;
    const fakeRunner = async () => {
      callCount++;
      return fakeResult("error", { error: '{"message":"something broke"}' });
    };

    const { job } = await dispatchWithFallback({
      _runPrompt: fakeRunner,
      tiers: [["route/free", "route/go"]],
      round: 1,
      kind: "task",
      promptText: "test",
    });

    assert.equal(job.status, "error");
    assert.equal(callCount, 1, "the second route must not be tried");
    assert.equal(job.fallbacks, null);
  });

  it("catalog-miss provider failure advances to next route and poisons the route", async () => {
    let callCount = 0;
    const fakeRunner = async () => {
      callCount++;
      if (callCount === 1) {
        return fakeResult("provider-error", {
          retry: {
            reason: "catalog-miss",
            message: "Model not found: opencode/hy3-free",
            attempt: 0,
            count: 0,
            terminal: true,
          },
        });
      }
      return fakeResult("completed", { resultText: "done via route two" });
    };

    const { job, resultText } = await dispatchWithFallback({
      _runPrompt: fakeRunner,
      tiers: [["opencode/hy3-free", "opencode/ling-3.0"]],
      round: 1,
      kind: "task",
      promptText: "test",
    });

    assert.equal(job.status, "completed");
    assert.equal(resultText, "done via route two");
    assert.equal(job.modelEntry, "opencode/ling-3.0");
    assert.equal(callCount, 2);
    assert.ok(failedRoutes.has("opencode/hy3-free"));
    assert.ok(Array.isArray(job.fallbacks));
    assert.equal(job.fallbacks.length, 1);
    assert.deepEqual(job.fallbacks[0], {
      from: "opencode/hy3-free",
      to: "opencode/ling-3.0",
      reason: "catalog-miss",
      attempt: 0,
      message: "Model not found: opencode/hy3-free",
    });
  });
});

// =========================================================================
// end-to-end: non-retryable provider failure walks the tier (kusabi #233)
// =========================================================================
// runPrompt is driven through dispatchWithFallback against a spawned fake
// `opencode serve` (same pattern as serve-lifecycle.test.mjs): OPENCODE_BIN
// points at a script that speaks just enough of the HTTP + SSE protocol.
// The first session it creates receives the scripted session.error (no
// retry events — the incident's exact shape); later sessions idle out with
// a final assistant message so the walk's second route completes.  The
// fake serve logs every session creation and prompt_async call so the
// attempt count per route is asserted from the wire, not from the code.

function fakeServeSource({ firstError }) {
  return `#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";

const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf("--port") + 1]);
const sessions = [];
let nextSession = 0;
const log = process.env.KUSABI_TEST_LOG;

const FIRST_ERROR = ${JSON.stringify(firstError)};

function sse(res, event) {
  res.write("data: " + JSON.stringify(event) + "\\n\\n");
}

const server = http.createServer((req, res) => {
  res.on("error", () => {});
  const url = new URL(req.url, "http://127.0.0.1:" + port);
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (req.method === "GET" && url.pathname === "/session") {
      // Health probe (ensureServer / serverHealthy).
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
      return;
    }
    if (req.method === "POST" && url.pathname === "/session") {
      const id = "ses-" + (++nextSession);
      sessions.push({ id, outcome: nextSession === 1 ? "error" : "idle", emitted: false });
      if (log) fs.appendFileSync(log, "create " + id + "\\n");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id }));
      return;
    }
    const segs = url.pathname.split("/");
    const sessionId = segs[2];
    if (req.method === "POST" && segs[3] === "prompt_async") {
      if (log) fs.appendFileSync(log, "prompt " + sessionId + "\\n");
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    if (req.method === "POST" && segs[3] === "abort") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    if (req.method === "GET" && segs[3] === "message") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([
        { info: { role: "assistant" }, parts: [{ type: "text", text: "survived via route two" }] },
      ]));
      return;
    }
    if (req.method === "GET" && url.pathname === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const session = sessions[sessions.length - 1];
      if (session && !session.emitted) {
        session.emitted = true;
        const props = { sessionID: session.id };
        if (session.outcome === "error") {
          sse(res, { type: "session.error", properties: { ...props, error: FIRST_ERROR } });
        } else {
          sse(res, { type: "session.idle", properties: props });
        }
        res.end();
        return;
      }
      // Already emitted (or nothing yet): hold the connection open instead
      // of ending it, so a reconnect can never spin on re-emitted events.
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
});
server.listen(port, "127.0.0.1");
setInterval(() => {}, 1000);
`;
}

function incidentServeContext({ firstError }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-233-test-"));
  const binPath = path.join(tmp, "fake-serve.mjs");
  fs.writeFileSync(binPath, fakeServeSource({ firstError }), "utf8");
  fs.chmodSync(binPath, 0o755);
  const stateRoot = path.join(tmp, "state");
  const cwd = path.join(tmp, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const testLog = path.join(tmp, "requests.log");
  fs.writeFileSync(testLog, "", "utf8");
  const saved = {
    OPENCODE_BIN: process.env.OPENCODE_BIN,
    KUSABI_STATE_DIR: process.env.KUSABI_STATE_DIR,
    KUSABI_SERVE_READY_TIMEOUT_MS: process.env.KUSABI_SERVE_READY_TIMEOUT_MS,
    KUSABI_TEST_LOG: process.env.KUSABI_TEST_LOG,
  };
  // Set env first: stateDirFor hashes cwd under KUSABI_STATE_DIR, so it
  // must see the temp root or the returned paths point at the real root.
  process.env.OPENCODE_BIN = binPath;
  process.env.KUSABI_STATE_DIR = stateRoot;
  process.env.KUSABI_SERVE_READY_TIMEOUT_MS = "8000";
  process.env.KUSABI_TEST_LOG = testLog;
  const stateDir = stateDirFor(cwd);
  return {
    tmp,
    cwd,
    stateDir,
    testLog,
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
    killAll() {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(stateDir, "server.json"), "utf8"));
        try { process.kill(rec.pid, "SIGKILL"); } catch { /* already gone */ }
      } catch { /* no record written */ }
    },
    rm() {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

function loadJobRecords(stateDir) {
  return fs
    .readdirSync(path.join(stateDir, "jobs"))
    .map((id) => JSON.parse(fs.readFileSync(path.join(stateDir, "jobs", id, "job.json"), "utf8")));
}

function requestLogLines(testLog) {
  return fs.readFileSync(testLog, "utf8").trim().split("\n");
}

function dispatchIncidentOpts(cwd, title) {
  return {
    cwd,
    tiers: [["opencode/deepseek-v4-flash-free:max", "opencode-go/deepseek-v4-flash:max"]],
    round: 1,
    kind: "task",
    title,
    promptText: "review this",
    timeoutS: 30,
    watchdogS: 0,
  };
}

describe("dispatchWithFallback — end-to-end against a fake serve (kusabi #233)", () => {
  beforeEach(() => {
    resetFailedRoutes();
  });

  afterEach(() => {
    resetFailedRoutes();
  });

  it("the incident stream (401 APIError session.error, no retry events) advances to the tier's second route", async () => {
    const ctx = incidentServeContext({ firstError: INCIDENT_401 });
    try {
      const { job, resultText } = await dispatchWithFallback(dispatchIncidentOpts(ctx.cwd, "incident reproduction"));

      // The walk advanced to the surviving route in the same tier instead
      // of finishing `error` on the first one.
      assert.equal(job.status, "completed");
      assert.equal(job.modelEntry, "opencode-go/deepseek-v4-flash:max");
      assert.equal(resultText, "survived via route two");

      // The job record carries the fallback trail and the reason.
      assert.ok(Array.isArray(job.fallbacks));
      assert.equal(job.fallbacks.length, 1);
      assert.equal(job.fallbacks[0].from, "opencode/deepseek-v4-flash-free:max");
      assert.equal(job.fallbacks[0].to, "opencode-go/deepseek-v4-flash:max");
      assert.equal(job.fallbacks[0].reason, "http-401");
      assert.equal(job.fallbacks[0].attempt, 0);
      assert.match(job.fallbacks[0].message, /invalid_bearer_credential/);

      // No same-route retry: each route exactly once, two distinct sessions.
      assert.deepEqual(requestLogLines(ctx.testLog), [
        "create ses-1", "prompt ses-1",
        "create ses-2", "prompt ses-2",
      ]);

      // No route poisoning: nothing crossed into failedRoutes.
      assert.equal(failedRoutes.size, 0);

      // The failed route's own record: provider-error, retry carries the
      // structured status, terminal false.
      const records = loadJobRecords(ctx.stateDir);
      assert.equal(records.length, 2);
      const failedRec = records.find((r) => r.status === "provider-error");
      const okRec = records.find((r) => r.status === "completed");
      assert.ok(failedRec, "the first route's record must be provider-error");
      assert.ok(okRec, "the second route's record must be completed");
      assert.equal(failedRec.retry.reason, "http-401");
      assert.equal(failedRec.retry.attempt, 0);
      assert.equal(failedRec.retry.terminal, false);

      // The audit trail shows the provider-error and fallback events with
      // the reason on the failed route's stream.
      const events = fs.readFileSync(path.join(ctx.stateDir, "jobs", failedRec.id, "events.ndjson"), "utf8")
        .trim().split("\n").map(JSON.parse);
      const types = events.map((e) => e.type);
      assert.ok(types.includes("session.error"));
      assert.ok(types.includes("companion.provider-error"));
      const fbEvent = events.find((e) => e.type === "companion.fallback");
      assert.equal(fbEvent.from, "opencode/deepseek-v4-flash-free:max");
      assert.equal(fbEvent.to, "opencode-go/deepseek-v4-flash:max");
      assert.equal(fbEvent.reason, "http-401");
    } finally {
      ctx.killAll();
      ctx.restore();
      ctx.rm();
    }
  });

  it("403 / 429 / 5xx structured payloads advance the walk the same way", async () => {
    for (const code of [403, 429, 500, 503]) {
      const ctx = incidentServeContext({
        firstError: { name: "APIError", data: { statusCode: code, message: `upstream refused ${code}` } },
      });
      try {
        const { job } = await dispatchWithFallback(dispatchIncidentOpts(ctx.cwd, `code ${code}`));

        assert.equal(job.status, "completed", `code ${code} must walk to the second route`);
        assert.equal(job.modelEntry, "opencode-go/deepseek-v4-flash:max");
        assert.equal(job.fallbacks.length, 1);
        assert.equal(job.fallbacks[0].reason, `http-${code}`);
        assert.deepEqual(requestLogLines(ctx.testLog), [
          "create ses-1", "prompt ses-1",
          "create ses-2", "prompt ses-2",
        ]);
        assert.equal(failedRoutes.size, 0);
      } finally {
        ctx.killAll();
        ctx.restore();
        ctx.rm();
      }
    }
  });

  it("a session.error WITHOUT a structured status keeps today's error outcome and stops the walk", async () => {
    const ctx = incidentServeContext({ firstError: { message: "something broke" } });
    try {
      const { job } = await dispatchWithFallback(dispatchIncidentOpts(ctx.cwd, "plain error"));

      // Unchanged behavior: status `error`, no fallback trail, no walk.
      assert.equal(job.status, "error");
      assert.equal(job.fallbacks, null);
      assert.deepEqual(requestLogLines(ctx.testLog), [
        "create ses-1", "prompt ses-1",
      ]);
      assert.equal(failedRoutes.size, 0);

      const records = loadJobRecords(ctx.stateDir);
      assert.equal(records.length, 1);
      const events = fs.readFileSync(path.join(ctx.stateDir, "jobs", records[0].id, "events.ndjson"), "utf8")
        .trim().split("\n").map(JSON.parse);
      const types = events.map((e) => e.type);
      assert.ok(types.includes("session.error"));
      assert.ok(!types.includes("companion.provider-error"));
      assert.ok(!types.includes("companion.fallback"));
    } finally {
      ctx.killAll();
      ctx.restore();
      ctx.rm();
    }
  });

  it("the incident UnknownError stream ('Model not found') advances to the tier's second route and poisons the dead route", async () => {
    const ctx = incidentServeContext({ firstError: INCIDENT_CATALOG_MISS });
    try {
      const { job, resultText } = await dispatchWithFallback(dispatchIncidentOpts(ctx.cwd, "catalog miss incident"));

      assert.equal(job.status, "completed");
      assert.equal(job.modelEntry, "opencode-go/deepseek-v4-flash:max");
      assert.equal(resultText, "survived via route two");

      assert.ok(Array.isArray(job.fallbacks));
      assert.equal(job.fallbacks.length, 1);
      assert.equal(job.fallbacks[0].from, "opencode/deepseek-v4-flash-free:max");
      assert.equal(job.fallbacks[0].to, "opencode-go/deepseek-v4-flash:max");
      assert.equal(job.fallbacks[0].reason, "catalog-miss");
      assert.equal(job.fallbacks[0].attempt, 0);

      assert.ok(failedRoutes.has("opencode/deepseek-v4-flash-free:max"));
    } finally {
      ctx.killAll();
      ctx.restore();
      ctx.rm();
    }
  });

  it("an UnknownError WITHOUT 'Model not found' in message keeps today's error outcome and does NOT walk", async () => {
    const ctx = incidentServeContext({
      firstError: { name: "UnknownError", data: { message: "Internal server crash" } },
    });
    try {
      const { job } = await dispatchWithFallback(dispatchIncidentOpts(ctx.cwd, "unknown error without catalog miss"));

      assert.equal(job.status, "error");
      assert.equal(job.fallbacks, null);
      assert.deepEqual(requestLogLines(ctx.testLog), [
        "create ses-1", "prompt ses-1",
      ]);
      assert.equal(failedRoutes.size, 0);
    } finally {
      ctx.killAll();
      ctx.restore();
      ctx.rm();
    }
  });
});
