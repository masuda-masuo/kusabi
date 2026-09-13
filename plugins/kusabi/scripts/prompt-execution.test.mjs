import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  accumulateUsage,
  catalogMissFromError,
  classifyIncompleteCompletedRun,
  decidePermission,
  dispatchWithFallback,
  failedRoutes,
  finalizeIncompleteCompletedRun,
  finishedUnknownSignal,
  incompleteRunError,
  phaseRequiresOutput,
  probeEvidenceIncomplete,
  providerStatusFromError,
  resetFailedRoutes,
} from "./prompt-execution.mjs";
import { stateDirFor } from "./state-paths.mjs";
import { loadJob, saveJob } from "./job-store.mjs";
import { cmdTask } from "./task-cmd.mjs";
import { commandOutcome } from "./kusabi-companion.mjs";
import { resolveResumeLastSession } from "./kusabi-companion.mjs";
import { WRITE_TOOL_NAMES, implementDenyTools, reviewDenyTools } from "./cli.mjs";
import { translateDenyTools } from "./claude-dispatch.mjs";

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

  it("fake-dispatch: tier [['opencode/a', 'opencode/b', 'agy/gemini-3.8-flash-high']], first two provider-error, third succeeds on agy without opencode session (kusabi #470)", async () => {
    let callCount = 0;
    const opencodeSessions = [];
    const fakeRunner = async (opts) => {
      callCount++;
      opencodeSessions.push(opts.session);
      return fakeResult("provider-error", {
        retry: { reason: "rate_limit", message: "temporarily unavailable", attempt: 1, count: 1, terminal: false },
      });
    };

    let agyCalled = false;
    let agyOptsReceived = null;
    const fakeAgyDispatch = async (opts) => {
      agyCalled = true;
      agyOptsReceived = opts;
      return fakeResult("completed", {
        id: "agy-job-470",
        resultText: "agy work complete",
        backend: "agy",
      });
    };

    const { job, resultText } = await dispatchWithFallback({
      _runPrompt: fakeRunner,
      _agyDispatch: fakeAgyDispatch,
      tiers: [["opencode/a", "opencode/b", "agy/gemini-3.8-flash-high"]],
      round: 1,
      session: "ses_opencode_active_session",
      sessionProvenance: "opencode",
      kind: "task",
      promptText: "do implement",
    });

    assert.equal(callCount, 2, "both opencode candidates were tried");
    assert.deepEqual(opencodeSessions, ["ses_opencode_active_session", "ses_opencode_active_session"], "opencode candidates received session");
    assert.equal(agyCalled, true, "agy candidate was called");
    assert.equal(agyOptsReceived.session, undefined, "agy attempt did not receive the opencode session id");
    assert.equal(agyOptsReceived.explicitModel, "gemini-3.8-flash-high");
    assert.equal(job.status, "completed");
    assert.equal(job.backend, "agy");
    assert.equal(resultText, "agy work complete");
    assert.ok(Array.isArray(job.fallbacks));
    assert.ok(job.fallbacks.length >= 2, "fallbacks length >= 2");
    assert.equal(job.fallbacks[0].from, "opencode/a");
    assert.equal(job.fallbacks[0].to, "opencode/b");
    assert.equal(job.fallbacks[1].from, "opencode/b");
    assert.equal(job.fallbacks[1].to, "agy/gemini-3.8-flash-high");
  });

  it("pin test: mixed config + explicitModel for an opencode route that fails terminally does not walk to agy (kusabi #470)", async () => {
    let opencodeCalls = 0;
    const fakeRunner = async () => {
      opencodeCalls++;
      return fakeResult("provider-error", {
        retry: { reason: "free_tier_limit", message: "quota exhausted", attempt: 1, count: 1, terminal: true },
      });
    };

    let agyCalls = 0;
    const fakeAgyDispatch = async () => {
      agyCalls++;
      return fakeResult("completed", { backend: "agy" });
    };

    const { job } = await dispatchWithFallback({
      _runPrompt: fakeRunner,
      _agyDispatch: fakeAgyDispatch,
      tiers: [["opencode/a", "opencode/b", "agy/gemini-3.8-flash-high"]],
      explicitModel: "opencode/a",
      round: 1,
      kind: "task",
      promptText: "pinned task",
    });

    assert.equal(opencodeCalls, 1, "only pinned model was attempted");
    assert.equal(agyCalls, 0, "did not walk to agy");
    assert.equal(job.status, "provider-error");
    assert.ok(failedRoutes.has("opencode/a"));
  });

  // mixed-backend explicit restriction fallback (kusabi #482)
  // -------------------------------------------------------------------------

  it("fake-dispatch: opencode quota failure does not walk to agy when explicit --read-only restriction is present (kusabi #482)", async () => {
    let opencodeCalls = 0;
    const fakeRunner = async () => {
      opencodeCalls++;
      return fakeResult("provider-error", {
        retry: { reason: "free_tier_limit", message: "quota exhausted", attempt: 1, count: 1, terminal: true },
      });
    };

    let agyCalled = false;
    const fakeAgyDispatch = async () => {
      agyCalled = true;
      return fakeResult("completed", { backend: "agy", resultText: "unrestricted agy run" });
    };

    const readOnlyTools = Object.fromEntries(WRITE_TOOL_NAMES.map((t) => [t, false]));
    const { job } = await dispatchWithFallback({
      _runPrompt: fakeRunner,
      _agyDispatch: fakeAgyDispatch,
      tiers: [["opencode/free", "agy/gemini-3.8-flash-high"]],
      round: 1,
      kind: "task",
      promptText: "audit task",
      tools: readOnlyTools,
      explicitRestrictions: true,
    });

    assert.equal(opencodeCalls, 1, "opencode candidate was attempted");
    assert.equal(agyCalled, false, "agy candidate must never be invoked when explicit restriction is present");
    assert.notEqual(job.status, "completed", "must not report success/unrestricted execution");
    const explanation = [
      job.error,
      job.stopReason,
      ...(job.fallbacks ?? []).map((f) => `${f.reason} ${f.message}`),
    ].filter(Boolean).join(" ");
    assert.match(
      explanation,
      /(?:cannot apply|restriction cannot be applied|not supported on the agy backend|no per-job tool permission flags|cannot enforce explicit restriction)/i,
      "terminal result must explain that agy cannot apply the explicit restriction"
    );
  });

  it("fake-dispatch: opencode quota failure does not walk to cursor when explicit --deny restriction is present (kusabi #482)", async () => {
    let opencodeCalls = 0;
    const fakeRunner = async () => {
      opencodeCalls++;
      return fakeResult("provider-error", {
        retry: { reason: "free_tier_limit", message: "quota exhausted", attempt: 1, count: 1, terminal: true },
      });
    };

    let cursorCalled = false;
    const fakeCursorDispatch = async () => {
      cursorCalled = true;
      return fakeResult("completed", { backend: "cursor", resultText: "unrestricted cursor run" });
    };

    const { job } = await dispatchWithFallback({
      _runPrompt: fakeRunner,
      _cursorDispatch: fakeCursorDispatch,
      tiers: [["opencode/free", "cursor/default"]],
      round: 1,
      kind: "task",
      promptText: "audit task",
      tools: { bash: false },
      explicitRestrictions: true,
    });

    assert.equal(opencodeCalls, 1, "opencode candidate was attempted");
    assert.equal(cursorCalled, false, "cursor candidate must never be invoked when explicit restriction is present");
    assert.notEqual(job.status, "completed", "must not report success/unrestricted execution");
    const explanation = [
      job.error,
      job.stopReason,
      ...(job.fallbacks ?? []).map((f) => `${f.reason} ${f.message}`),
    ].filter(Boolean).join(" ");
    assert.match(
      explanation,
      /(?:cannot apply|restriction cannot be applied|not supported on the cursor backend|no per-job tool permission flags|cannot enforce explicit restriction)/i,
      "terminal result must explain that cursor cannot apply the explicit restriction"
    );
  });

  it("fake-dispatch: opencode quota failure falls back to claude with translated tool vocabulary (kusabi #482)", async () => {
    let opencodeCalls = 0;
    const fakeRunner = async () => {
      opencodeCalls++;
      return fakeResult("provider-error", {
        retry: { reason: "free_tier_limit", message: "quota exhausted", attempt: 1, count: 1, terminal: true },
      });
    };

    let claudeOptsReceived = null;
    const fakeClaudeDispatch = async (opts) => {
      claudeOptsReceived = opts;
      return fakeResult("completed", {
        id: "job-claude-fallback",
        backend: "claude",
        resultText: "claude restricted run done",
      });
    };

    const readOnlyTools = Object.fromEntries(WRITE_TOOL_NAMES.map((t) => [t, false]));
    const { job, resultText } = await dispatchWithFallback({
      _runPrompt: fakeRunner,
      _claudeDispatch: fakeClaudeDispatch,
      tiers: [["opencode/free", "claude/claude-sonnet-4-6"]],
      round: 1,
      kind: "task",
      promptText: "read-only audit task",
      tools: readOnlyTools,
      explicitRestrictions: true,
    });

    assert.equal(opencodeCalls, 1, "opencode candidate was attempted");
    assert.ok(claudeOptsReceived, "claude candidate was invoked");
    assert.deepEqual(
      claudeOptsReceived.tools,
      translateDenyTools(readOnlyTools),
      "claude fallback must receive translated tool deny map"
    );
    assert.equal(job.status, "completed");
    assert.equal(job.backend, "claude");
    assert.equal(resultText, "claude restricted run done");
  });

  it("fake-dispatch: mixed tier [opencode, agy, claude] skips agy and invokes claude with translated restrictions on opencode quota failure (kusabi #482)", async () => {
    let opencodeCalls = 0;
    const fakeRunner = async () => {
      opencodeCalls++;
      return fakeResult("provider-error", {
        retry: { reason: "free_tier_limit", message: "quota exhausted", attempt: 1, count: 1, terminal: true },
      });
    };

    let agyCalled = false;
    const fakeAgyDispatch = async () => {
      agyCalled = true;
      return fakeResult("completed", { backend: "agy", resultText: "agy should not run" });
    };

    let claudeCalled = false;
    let claudeOptsReceived = null;
    const fakeClaudeDispatch = async (opts) => {
      claudeCalled = true;
      claudeOptsReceived = opts;
      return fakeResult("completed", {
        id: "job-claude-mixed-fallback",
        backend: "claude",
        resultText: "claude success",
      });
    };

    const readOnlyTools = Object.fromEntries(WRITE_TOOL_NAMES.map((t) => [t, false]));
    const { job, resultText } = await dispatchWithFallback({
      _runPrompt: fakeRunner,
      _agyDispatch: fakeAgyDispatch,
      _claudeDispatch: fakeClaudeDispatch,
      tiers: [["opencode/free", "agy/gemini-3.8-flash-high", "claude/claude-sonnet-4-6"]],
      round: 1,
      kind: "task",
      promptText: "read-only audit task",
      tools: readOnlyTools,
      explicitRestrictions: true,
    });

    assert.equal(opencodeCalls, 1, "opencode candidate was attempted");
    assert.equal(agyCalled, false, "agy candidate must be skipped because it cannot apply explicit restriction");
    assert.equal(claudeCalled, true, "claude candidate must be invoked as compatible fallback");
    assert.deepEqual(
      claudeOptsReceived.tools,
      translateDenyTools(readOnlyTools),
      "claude fallback must receive translated tool deny map"
    );
    assert.equal(job.status, "completed");
    assert.equal(job.backend, "claude");
    assert.equal(resultText, "claude success");
  });

  it("fake-dispatch: phase-default reviewDenyTools continues to reach agy fallback when no explicit restriction was given (kusabi #482)", async () => {
    let opencodeCalls = 0;
    const fakeRunner = async () => {
      opencodeCalls++;
      return fakeResult("provider-error", {
        retry: { reason: "rate_limit", message: "busy", attempt: 1, count: 1, terminal: false },
      });
    };

    let agyCalled = false;
    let agyOptsReceived = null;
    const fakeAgyDispatch = async (opts) => {
      agyCalled = true;
      agyOptsReceived = opts;
      return fakeResult("completed", {
        id: "agy-job-phase-default",
        backend: "agy",
        resultText: "agy review complete",
      });
    };

    const phaseTools = reviewDenyTools();
    const { job, resultText } = await dispatchWithFallback({
      _runPrompt: fakeRunner,
      _agyDispatch: fakeAgyDispatch,
      tiers: [["opencode/free", "agy/gemini-3.8-flash-high"]],
      round: 1,
      phase: "review",
      kind: "task",
      promptText: "review audit",
      tools: phaseTools,
    });

    assert.equal(opencodeCalls, 1);
    assert.equal(agyCalled, true, "agy candidate is called for phase-default deny map");
    assert.deepEqual(agyOptsReceived.tools, phaseTools, "agy receives phase-default tools map");
    assert.equal(job.status, "completed");
    assert.equal(job.backend, "agy");
    assert.equal(resultText, "agy review complete");
  });

  it("fake-dispatch: phase-default implementDenyTools continues to reach cursor fallback when no explicit restriction was given (kusabi #482)", async () => {
    let opencodeCalls = 0;
    const fakeRunner = async () => {
      opencodeCalls++;
      return fakeResult("provider-error", {
        retry: { reason: "rate_limit", message: "busy", attempt: 1, count: 1, terminal: false },
      });
    };

    let cursorCalled = false;
    let cursorOptsReceived = null;
    const fakeCursorDispatch = async (opts) => {
      cursorCalled = true;
      cursorOptsReceived = opts;
      return fakeResult("completed", {
        id: "cursor-job-phase-default",
        backend: "cursor",
        resultText: "cursor implement complete",
      });
    };

    const phaseTools = implementDenyTools();
    const { job, resultText } = await dispatchWithFallback({
      _runPrompt: fakeRunner,
      _cursorDispatch: fakeCursorDispatch,
      tiers: [["opencode/free", "cursor/default"]],
      round: 1,
      phase: "implement",
      kind: "task",
      promptText: "implement task",
      tools: phaseTools,
    });

    assert.equal(opencodeCalls, 1);
    assert.equal(cursorCalled, true, "cursor candidate is called for phase-default deny map");
    assert.deepEqual(cursorOptsReceived.tools, phaseTools, "cursor receives phase-default tools map");
    assert.equal(job.status, "completed");
    assert.equal(job.backend, "cursor");
    assert.equal(resultText, "cursor implement complete");
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


// =========================================================================
// cmdTask command boundary — preserve backend of final fallback attempt
// (kusabi #483)
// =========================================================================

const CMD_TASK_483_BRIEF = [
  "## Purpose",
  "",
  "Exercise mixed-backend task fallback persistence.",
  "",
].join("\n");

async function runCmdTask483(finalStatus) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-483-test-"));
  const stateRoot = path.join(tmp, "state");
  const cwd = path.join(tmp, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(
    path.join(stateRoot, "config.json"),
    JSON.stringify({
      models: {
        chain: [["opencode/opencode-test", "agy/gemini-3.8-flash-high"]],
      },
    }),
    "utf8",
  );

  const savedStateRoot = process.env.KUSABI_STATE_DIR;
  process.env.KUSABI_STATE_DIR = stateRoot;
  const dispatchCalls = [];
  const attemptBackends = [];

  try {
    const output = commandOutcome(await cmdTask(cwd, {
      flags: {},
      text: CMD_TASK_483_BRIEF,
      _dispatch: async (opts) => {
        dispatchCalls.push(opts);
        return dispatchWithFallback({
          ...opts,
          _backendDispatch: (backend) => async () => {
            attemptBackends.push(backend);
            if (backend === "opencode") {
              return fakeResult("provider-error", {
                id: "job-483-opencode",
                sessionID: "ses-483-opencode",
                retry: {
                  reason: "free_tier_limit",
                  message: "opencode quota exhausted",
                  attempt: 1,
                  terminal: true,
                },
              });
            }
            return fakeResult(finalStatus, {
              id: `job-483-agy-${finalStatus}`,
              sessionID: "agy-session-483",
              backend: "agy",
              error: finalStatus === "completed" ? null : "agy final attempt failed",
              resultText: finalStatus === "completed" ? "agy completed" : "",
            });
          },
        });
      },
    }));

    const stateDir = stateDirFor(cwd);
    const job = loadJob(stateDir, `job-483-agy-${finalStatus}`);
    return {
      output: output.text,
      exitCode: output.exitCode,
      job,
      resumedSession: resolveResumeLastSession(stateDir, { backend: "agy" }),
      dispatchCalls,
      attemptBackends,
    };
  } finally {
    if (savedStateRoot === undefined) delete process.env.KUSABI_STATE_DIR;
    else process.env.KUSABI_STATE_DIR = savedStateRoot;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("cmdTask mixed-backend fallback persistence (kusabi #483)", () => {
  beforeEach(() => {
    resetFailedRoutes();
  });

  afterEach(() => {
    resetFailedRoutes();
  });

  it("persists and displays agy when opencode falls back to a successful agy attempt", async () => {
    const { output, job, resumedSession, dispatchCalls, attemptBackends } = await runCmdTask483("completed");

    assert.equal(dispatchCalls.length, 1);
    assert.deepEqual(attemptBackends, ["opencode", "agy"]);
    assert.equal(job.status, "completed");
    assert.equal(job.backend, "agy");
    assert.equal(job.sessionID, "agy-session-483");
    assert.equal(resumedSession, "agy-session-483");
    assert.match(output, /^agy task /);
    assert.match(output, /continue in agy/);
  });

  it("persists agy when the final agy fallback attempt fails", async () => {
    const { output, job, attemptBackends } = await runCmdTask483("timeout");

    assert.deepEqual(attemptBackends, ["opencode", "agy"]);
    assert.equal(job.status, "timeout");
    assert.equal(job.backend, "agy");
    assert.equal(job.sessionID, "agy-session-483");
    assert.match(output, /^agy task /);
    assert.match(output, /agy final attempt failed/);
  });
});


// =========================================================================
// task command exit propagation — public command boundary (kusabi #484)
// =========================================================================

const CMD_TASK_484_BRIEF = [
  "Orchestrator: test | session kusabi-484 | 2026-09-07",
  "",
  "## Purpose",
  "",
  "Exercise task command exit propagation.",
  "",
].join("\n");

async function runCmdTask484(status, { resultText = "", probeResults = undefined, phase = null } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-484-test-"));
  const stateRoot = path.join(tmp, "state");
  const cwd = path.join(tmp, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(
    path.join(stateRoot, "config.json"),
    JSON.stringify({ models: { chain: [["opencode/opencode-test"]] } }),
    "utf8",
  );

  const savedStateRoot = process.env.KUSABI_STATE_DIR;
  process.env.KUSABI_STATE_DIR = stateRoot;
  try {
    const output = await cmdTask(cwd, {
      flags: phase ? { phase } : {},
      text: CMD_TASK_484_BRIEF,
      _dispatch: async (opts) => dispatchWithFallback({
        ...opts,
        _backendDispatch: () => async () => {
          const result = fakeResult(status, {
            id: `job-484-${status}`,
            error: status === "completed" ? null : `${status} dispatch failed`,
            resultText,
            retry: status === "provider-error"
              ? { reason: "provider_failure", message: `${status} dispatch failed`, attempt: 1, terminal: true }
              : null,
          });
          if (probeResults !== undefined) {
            result.job.probeResults = probeResults;
            result.job.probesGreen = probeResults.every((probe) => probe.passed);
          }
          return result;
        },
      }),
    });
    return commandOutcome(output);
  } finally {
    if (savedStateRoot === undefined) delete process.env.KUSABI_STATE_DIR;
    else process.env.KUSABI_STATE_DIR = savedStateRoot;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("cmdTask exit propagation (kusabi #484)", () => {
  beforeEach(() => resetFailedRoutes());
  afterEach(() => resetFailedRoutes());

  it("completed task exits 0", async () => {
    const result = await runCmdTask484("completed", { resultText: "task complete" });
    assert.equal(result.exitCode, 0);
    assert.match(result.text, /task complete/);
  });

  for (const status of ["error", "provider-error", "timeout", "cancelled"]) {
    it(`${status} dispatch exits nonzero and keeps its failure text`, async () => {
      const result = await runCmdTask484(status);
      assert.notEqual(result.exitCode, 0);
      assert.match(result.text, new RegExp(`${status} dispatch failed`));
    });
  }

  it("completed task with a failed deterministic probe exits nonzero", async () => {
    const result = await runCmdTask484("completed", {
      resultText: "task completed",
      probeResults: [{ probe: "verify", passed: false, detail: "1 test failed" }],
    });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.text, /Probes:[\s\S]*verify — FAIL/);
  });

  it("successful review execution with findings remains exit 0", async () => {
    const result = await runCmdTask484("completed", {
      phase: "review",
      resultText: "review findings: 1 issue",
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.text, /review findings: 1 issue/);
  });
});


// =========================================================================
// spawned CLI exit propagation (kusabi #484 follow-up)
// =========================================================================
// The in-process #484 suite above exercises `cmdTask` -> `commandOutcome` in
// the same process.  A regression that strips the outcome object at the
// public CLI boundary (e.g. `main` always flushAndExit(0)) would still pass
// those tests because the exitCode is checked via commandOutcome, not via
// the actual process exit code.  This spawned fixture runs the real
// kusabi-companion.mjs entrypoint via spawnSync so the process status is
// the actual exit code -- a regression would surface here.

function spawnedFakeServeSource({ firstError }) {
  // Minimal fake `opencode serve` that emits a single terminal session.error
  // for the first session, then holds the SSE connection open.  A config with
  // one tier and one route means there is no fallback -- the error is terminal.
  return `#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";

const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf("--port") + 1]);
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
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
      return;
    }
    if (req.method === "POST" && url.pathname === "/session") {
      const id = "ses-" + (++nextSession);
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
    if (req.method === "GET" && url.pathname === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const props = { sessionID: "ses-" + nextSession };
      sse(res, { type: "session.error", properties: { ...props, error: FIRST_ERROR } });
      res.end();
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

const SPAWNED_CLI_484_BRIEF = [
  "Orchestrator: test | session kusabi-484-spawned | 2026-09-08",
  "",
  "## Purpose",
  "",
  "Exercise task command exit propagation via the real CLI boundary.",
  "",
].join("\n");

describe("spawned CLI exit propagation (kusabi #484 follow-up)", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");
  const SPAWNED_401 = {
    name: "APIError",
    data: {
      message: "Upstream request failed: [invalid_bearer_credential] Missing or invalid bearer credential",
      statusCode: 401,
      isRetryable: false,
    },
  };

  it("a spawned task that fails through the real CLI boundary exits nonzero", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-484-spawned-"));
    try {
      const binPath = path.join(tmp, "fake-serve.mjs");
      fs.writeFileSync(binPath, spawnedFakeServeSource({ firstError: SPAWNED_401 }), "utf8");
      fs.chmodSync(binPath, 0o755);

      const stateRoot = path.join(tmp, "state");
      const cwd = path.join(tmp, "cwd");
      fs.mkdirSync(cwd, { recursive: true });
      fs.mkdirSync(stateRoot, { recursive: true });
      fs.writeFileSync(
        path.join(stateRoot, "config.json"),
        JSON.stringify({ models: { chain: [["opencode/opencode-test"]] } }),
        "utf8",
      );

      const testLog = path.join(tmp, "requests.log");
      fs.writeFileSync(testLog, "", "utf8");

      const env = { ...process.env };
      delete env.KUSABI_WORKER_CONTEXT;
      env.OPENCODE_BIN = binPath;
      env.KUSABI_STATE_DIR = stateRoot;
      env.KUSABI_SERVE_READY_TIMEOUT_MS = "8000";
      env.KUSABI_TEST_LOG = testLog;

      const result = spawnSync(
        process.execPath,
        [COMPANION_SCRIPT, "task", "--model", "opencode/opencode-test", SPAWNED_CLI_484_BRIEF],
        { encoding: "utf8", cwd, env, timeout: 30_000 },
      );

      // The real CLI must propagate the nonzero exit code through the process.
      assert.notEqual(result.status, 0, `expected nonzero exit, got: ${result.stdout} ${result.stderr}`);
      // The failure text must appear on stdout (commandOutcome -> stdout).
      assert.match(result.stdout, /401/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
// =========================================================================
// kusabi #496 — finished-unknown signal and incomplete-run classification
// =========================================================================
// A detached task whose provider stream ends `finish: "unknown"` then idle,
// with NO final message and only a recovered event/reasoning reconstruction,
// is a candidate incomplete write for phases that must produce output.  The
// STREAM signal alone (finish unknown + no final payload) is recorded by
// runPrompt; the terminal non-success verdict is finalized at the layer that
// owns probe truth (cmdTask after its container probe phase), and only when
// the probe evidence proves it deterministic (no declared deliverable
// changes AND failed P3/P4).  A complete-but-message-less write run whose
// deliverables/probes are green is never falsely failed.
//
// The incident's actual recorded line (job-mtyfpjlc8452, 2026-09) is the
// FLAT `{ finish: "unknown" }` shape on session.status — the end-to-end
// fixtures below drive that exact line through the real runPrompt over a
// fake serve; the structured opencode shape is covered by a second
// end-to-end fixture and by the unit tests.

describe("finishedUnknownSignal", () => {
  it("recognises the structured session.status finished-unknown shape", () => {
    assert.equal(finishedUnknownSignal({
      type: "session.status",
      properties: {
        sessionID: "ses-1",
        status: { type: "finished", finish: "unknown", reason: { type: "done" } },
      },
    }), true);
  });

  it("recognises the incident's flat recorded shape { finish: \"unknown\" }", () => {
    assert.equal(finishedUnknownSignal({
      type: "session.status",
      properties: { sessionID: "ses-1", finish: "unknown" },
    }), true);
  });

  it("rejects done / error / cancel / max-turns finishes", () => {
    for (const finish of ["done", "error", "cancel", "max-turns", null, undefined]) {
      assert.equal(finishedUnknownSignal({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type: "finished", finish } },
      }), false, `finish=${finish}`);
    }
  });

  it("rejects non-finished status types even with finish unknown", () => {
    for (const type of ["start", "retry", "permission"]) {
      assert.equal(finishedUnknownSignal({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type, finish: "unknown" } },
      }), false, `status.type=${type}`);
    }
  });

  it("tolerates missing or malformed properties", () => {
    assert.equal(finishedUnknownSignal(null), false);
    assert.equal(finishedUnknownSignal({}), false);
    assert.equal(finishedUnknownSignal({ type: "session.idle" }), false);
    assert.equal(finishedUnknownSignal({ type: "session.status", properties: { status: "finished" } }), false);
    assert.equal(finishedUnknownSignal({ type: "session.status" }), false);
  });
});

describe("phaseRequiresOutput", () => {
  it("write-producing phases require output", () => {
    for (const phase of ["implement", "test-author", "investigate", "gofer", "draft", "respond", "salvage", null]) {
      assert.equal(phaseRequiresOutput(phase, "task"), true, `phase=${phase}`);
    }
  });

  it("plan and review are read-only", () => {
    assert.equal(phaseRequiresOutput("plan", "task"), false);
    assert.equal(phaseRequiresOutput("review", "task"), false);
  });

  it("kind review is read-only even without a phase", () => {
    assert.equal(phaseRequiresOutput(null, "review"), false);
  });
});

describe("probeEvidenceIncomplete", () => {
  const red = (probe, passed) => ({ probe, passed });

  it("P3 and P4 both red is deterministic incomplete evidence", () => {
    assert.equal(probeEvidenceIncomplete({
      probeResults: [
        red("P3: deliverables", false),
        red("P4: smoke", false),
        red("P2: verify", true),
      ],
    }), true);
  });

  it("either probe green is NOT incomplete evidence (complete-but-message-less runs pass)", () => {
    assert.equal(probeEvidenceIncomplete({
      probeResults: [red("P3: deliverables", true), red("P4: smoke", false)],
    }), false, "P3 green");
    assert.equal(probeEvidenceIncomplete({
      probeResults: [red("P3: deliverables", false), red("P4: smoke", true)],
    }), false, "P4 green");
  });

  it("a missing P3 or P4 is NOT incomplete evidence", () => {
    assert.equal(probeEvidenceIncomplete({
      probeResults: [red("P3: deliverables", false)],
    }), false, "P4 absent");
    assert.equal(probeEvidenceIncomplete({
      probeResults: [red("P4: smoke", false)],
    }), false, "P3 absent");
  });

  it("absent or non-array probe results are NOT incomplete evidence", () => {
    assert.equal(probeEvidenceIncomplete({ probeResults: null }), false);
    assert.equal(probeEvidenceIncomplete({ probeResults: undefined }), false);
    assert.equal(probeEvidenceIncomplete({ probeResults: [] }), false);
    assert.equal(probeEvidenceIncomplete({ probeResults: "nope" }), false);
  });
});

describe("classifyIncompleteCompletedRun", () => {
  const RED = [
    { probe: "P3: deliverables", passed: false, detail: "no declared deliverable paths changed" },
    { probe: "P4: smoke", passed: false, detail: "declared test files absent, pytest exit 4" },
  ];
  const GREEN = [
    { probe: "P3: deliverables", passed: true, detail: "touches declared deliverables" },
    { probe: "P4: smoke", passed: true, detail: "all smoke command(s) passed" },
  ];

  it("regression fixture (job-mtyfpjlc8452): finish unknown + recovered + no final + write phase + P3/P4 red is incomplete", () => {
    assert.equal(classifyIncompleteCompletedRun({
      finishedUnknown: true,
      phase: "test-author",
      kind: "task",
      resultRecord: { source: "recovered", recovered: true, fetchFailed: false },
      probeResults: RED,
    }), true);
  });

  it("recovered with nothing to recover (source none) is incomplete for a write phase with red probes", () => {
    assert.equal(classifyIncompleteCompletedRun({
      finishedUnknown: true,
      phase: "implement",
      kind: "task",
      resultRecord: { source: "none", recovered: false, fetchFailed: false },
      probeResults: RED,
    }), true);
  });

  it("a complete-but-message-less write run with green P3/P4 is NOT incomplete", () => {
    assert.equal(classifyIncompleteCompletedRun({
      finishedUnknown: true,
      phase: "test-author",
      kind: "task",
      resultRecord: { source: "recovered", recovered: true, fetchFailed: false },
      probeResults: GREEN,
    }), false);
  });

  it("no probe evidence (probes never ran) is NOT incomplete", () => {
    assert.equal(classifyIncompleteCompletedRun({
      finishedUnknown: true,
      phase: "test-author",
      kind: "task",
      resultRecord: { source: "recovered", recovered: true, fetchFailed: false },
      probeResults: null,
    }), false);
  });

  it("a valid final payload is never downgraded", () => {
    assert.equal(classifyIncompleteCompletedRun({
      finishedUnknown: true,
      phase: "test-author",
      kind: "task",
      resultRecord: { source: "final-message", recovered: false },
      probeResults: RED,
    }), false);
  });

  it("no finished-unknown signal is not incomplete", () => {
    assert.equal(classifyIncompleteCompletedRun({
      finishedUnknown: false,
      phase: "test-author",
      kind: "task",
      resultRecord: { source: "recovered", recovered: true },
      probeResults: RED,
    }), false);
  });

  it("read-only plan/review with a recovered result stays completed even with red probes", () => {
    assert.equal(classifyIncompleteCompletedRun({
      finishedUnknown: true,
      phase: "plan",
      kind: "task",
      resultRecord: { source: "recovered", recovered: true },
      probeResults: RED,
    }), false);
    assert.equal(classifyIncompleteCompletedRun({
      finishedUnknown: true,
      phase: "review",
      kind: "task",
      resultRecord: { source: "recovered", recovered: true },
      probeResults: RED,
    }), false);
  });

  it("unavailable (fetch failed) is not deterministic incomplete evidence", () => {
    // We could not even ask for the final message; it may well exist.
    assert.equal(classifyIncompleteCompletedRun({
      finishedUnknown: true,
      phase: "implement",
      kind: "task",
      resultRecord: { source: "unavailable", recovered: false, fetchFailed: true },
      probeResults: RED,
    }), false);
  });

  it("a missing result record is not incomplete", () => {
    assert.equal(classifyIncompleteCompletedRun({
      finishedUnknown: true,
      phase: "implement",
      kind: "task",
      resultRecord: null,
      probeResults: RED,
    }), false);
  });
});

describe("incompleteRunError", () => {
  it("names the phase and the deterministic evidence", () => {
    const err = incompleteRunError({ phase: "test-author" });
    assert.match(err, /incomplete execution/);
    assert.match(err, /finish "unknown"/);
    assert.match(err, /no final message was produced/);
    assert.match(err, /test-author/);
  });
});

describe("finalizeIncompleteCompletedRun", () => {
  const RED = [
    { probe: "P3: deliverables", passed: false, detail: "no declared deliverable paths changed" },
    { probe: "P4: smoke", passed: false, detail: "declared test files absent, pytest exit 4" },
    { probe: "P2: verify", passed: true, detail: "1062 passed" },
  ];
  const GREEN = [
    { probe: "P3: deliverables", passed: true, detail: "touches declared deliverables" },
    { probe: "P4: smoke", passed: true, detail: "all smoke command(s) passed" },
    { probe: "P2: verify", passed: true, detail: "1062 passed" },
  ];

  function signalJob(overrides = {}) {
    return {
      id: "job-finalize",
      kind: "task",
      phase: "test-author",
      status: "completed",
      stopReason: "completed",
      error: null,
      result: { source: "recovered", recovered: true, fetchFailed: false, recovery: { source: "opencode-events", chars: 42 } },
      noFinalEvidence: { finishedUnknown: true, source: "recovered", recovered: true, phase: "test-author" },
      ...overrides,
    };
  }

  it("closes the recovered/no-final write run as error when P3/P4 are red", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-496-finalize-"));
    try {
      const job = signalJob();
      const stateDir = path.join(tmp, "state");
      const fired = finalizeIncompleteCompletedRun({ job, probeResults: RED, stateDir });
      assert.equal(fired, true);
      assert.equal(job.status, "error");
      assert.equal(job.stopReason, "unknown", "stop reason must never be 'completed'");
      assert.match(job.error, /incomplete execution/);
      assert.match(job.error, /test-author/);

      const events = fs.readFileSync(path.join(stateDir, "jobs", job.id, "events.ndjson"), "utf8")
        .trim().split("\n").map(JSON.parse);
      const incompleteEvent = events.find((e) => e.type === "companion.result.incomplete");
      assert.ok(incompleteEvent, "companion.result.incomplete event recorded");
      assert.equal(incompleteEvent.source, "recovered");
      assert.equal(incompleteEvent.finishedUnknown, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps a complete-but-message-less write run completed when P3/P4 are green", () => {
    const job = signalJob();
    const fired = finalizeIncompleteCompletedRun({ job, probeResults: GREEN, stateDir: null });
    assert.equal(fired, false);
    assert.equal(job.status, "completed");
    assert.equal(job.error, null);
  });

  it("keeps a run whose probes never ran completed", () => {
    const job = signalJob();
    const fired = finalizeIncompleteCompletedRun({ job, probeResults: null, stateDir: null });
    assert.equal(fired, false);
    assert.equal(job.status, "completed");
  });

  it("does nothing without the recorded stream signal", () => {
    const job = signalJob({ noFinalEvidence: null });
    const fired = finalizeIncompleteCompletedRun({ job, probeResults: RED, stateDir: null });
    assert.equal(fired, false);
    assert.equal(job.status, "completed");
  });

  it("does nothing for a read-only plan phase", () => {
    const job = signalJob({ phase: "plan" });
    const fired = finalizeIncompleteCompletedRun({ job, probeResults: RED, stateDir: null });
    assert.equal(fired, false);
    assert.equal(job.status, "completed");
  });

  it("does nothing for a job that is not completed", () => {
    const job = signalJob({ status: "timeout" });
    const fired = finalizeIncompleteCompletedRun({ job, probeResults: RED, stateDir: null });
    assert.equal(fired, false);
    assert.equal(job.status, "timeout");
  });
});

// =========================================================================
// kusabi #496 — end-to-end: runPrompt over a fake serve with the incident
// stream shape (flat `finish: "unknown"` -> idle, no final message)
// =========================================================================

function incompleteServeSource({ finalMessage, finishShape = "flat" }) {
  return `#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";

const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf("--port") + 1]);
let nextSession = 0;
const log = process.env.KUSABI_TEST_LOG;
const FINAL_MESSAGE = ${JSON.stringify(finalMessage)};
const FINISH_SHAPE = ${JSON.stringify(finishShape)};

function sse(res, event) {
  res.write("data: " + JSON.stringify(event) + "\\n\\n");
}

const server = http.createServer((req, res) => {
  res.on("error", () => {});
  const url = new URL(req.url, "http://127.0.0.1:" + port);
  req.on("data", () => {});
  req.on("end", () => {
    if (req.method === "GET" && url.pathname === "/session") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
      return;
    }
    if (req.method === "POST" && url.pathname === "/session") {
      const id = "ses-" + (++nextSession);
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
      res.end(JSON.stringify(FINAL_MESSAGE
        ? [{ info: { role: "assistant" }, parts: [{ type: "text", text: "final answer" }] }]
        : []));
      return;
    }
    if (req.method === "GET" && url.pathname === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const id = "ses-" + nextSession;
      // The incident stream shape: the provider closes with a session.status
      // finished-unknown event — the FLAT { finish: "unknown" } line exactly
      // as recorded for job-mtyfpjlc8452 (or the structured opencode shape
      // when FINISH_SHAPE is "structured") — an assistant text part lands
      // (the recovered reasoning), then the session goes idle with NO final
      // assistant message ever emitted.
      sse(res, FINISH_SHAPE === "structured"
        ? {
            type: "session.status",
            properties: { sessionID: id, status: { type: "finished", finish: "unknown", reason: { type: "done" } } },
          }
        : {
            type: "session.status",
            properties: { sessionID: id, finish: "unknown" },
          });
      sse(res, {
        type: "message.updated",
        properties: {
          sessionID: id,
          info: {
            id: "msg-1",
            role: "assistant",
            modelID: "deepseek-v4-flash",
            providerID: "opencode-go",
            tokens: { total: 10, input: 5, output: 5 },
          },
        },
      });
      sse(res, {
        type: "message.part.updated",
        properties: {
          sessionID: id,
          part: { id: "part-1", messageID: "msg-1", type: "text", text: "unfinished reasoning that breaks off mid-sentence" },
        },
      });
      sse(res, { type: "session.idle", properties: { sessionID: id } });
      res.end();
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

function incompleteServeContext({ finalMessage, finishShape = "flat" }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-496-test-"));
  const binPath = path.join(tmp, "fake-serve.mjs");
  fs.writeFileSync(binPath, incompleteServeSource({ finalMessage, finishShape }), "utf8");
  fs.chmodSync(binPath, 0o755);
  const stateRoot = path.join(tmp, "state");
  const cwd = path.join(tmp, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const saved = {
    OPENCODE_BIN: process.env.OPENCODE_BIN,
    KUSABI_STATE_DIR: process.env.KUSABI_STATE_DIR,
    KUSABI_SERVE_READY_TIMEOUT_MS: process.env.KUSABI_SERVE_READY_TIMEOUT_MS,
  };
  process.env.OPENCODE_BIN = binPath;
  process.env.KUSABI_STATE_DIR = stateRoot;
  process.env.KUSABI_SERVE_READY_TIMEOUT_MS = "8000";
  const stateDir = stateDirFor(cwd);
  return {
    tmp,
    cwd,
    stateDir,
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

function incompleteDispatchOpts(cwd, phase) {
  return {
    cwd,
    tiers: [["opencode-go/deepseek-v4-flash:max"]],
    round: 1,
    kind: "task",
    title: "kusabi 496 fixture",
    promptText: "implement the declared deliverables",
    phase,
    timeoutS: 30,
    watchdogS: 0,
  };
}

const INCIDENT_RED_PROBES = [
  { probe: "P3: deliverables", passed: false, detail: "no declared deliverable paths changed" },
  { probe: "P4: smoke", passed: false, detail: "declared test files absent, pytest exit 4" },
  { probe: "P2: verify", passed: true, detail: "1062 passed" },
];

describe("runPrompt — recovered/no-final stream signal (kusabi #496)", () => {
  beforeEach(() => {
    resetFailedRoutes();
  });

  afterEach(() => {
    resetFailedRoutes();
  });

  function assertSignalRecorded(job, ctx, phase) {
    // runPrompt never guesses the verdict: the stream signal is recorded on
    // the job and the dispatch classification stays completed.
    assert.equal(job.status, "completed");
    assert.equal(job.stopReason, "completed");
    assert.equal(job.error, null);
    assert.equal(job.result.source, "recovered");
    assert.equal(job.result.recovered, true);
    assert.equal(job.noFinalEvidence.finishedUnknown, true);
    assert.equal(job.noFinalEvidence.source, "recovered");
    assert.equal(job.noFinalEvidence.phase, phase);

    const events = fs.readFileSync(path.join(ctx.stateDir, "jobs", job.id, "events.ndjson"), "utf8")
      .trim().split("\n").map(JSON.parse);
    const types = events.map((e) => e.type);
    assert.ok(types.includes("session.status"));
    assert.ok(types.includes("session.idle"));
    assert.ok(types.includes("companion.result.recovered"));
    assert.ok(types.includes("companion.result.no-final"));
    assert.ok(!types.includes("companion.result.incomplete"), "the verdict is not guessed at dispatch time");
  }

  it("incident line (flat finish unknown) + idle + recovered no-final records the signal; the probe-truth layer closes it as non-success", async () => {
    const ctx = incompleteServeContext({ finalMessage: false, finishShape: "flat" });
    try {
      const { job, resultText, stateDir } = await dispatchWithFallback(incompleteDispatchOpts(ctx.cwd, "test-author"));

      // The incident's actual recorded line driven through the real watcher:
      // the signal is recorded, the run is NOT reclassified at dispatch.
      assertSignalRecorded(job, ctx, "test-author");

      // The recovered result is preserved as the returned text and on disk.
      assert.match(resultText, /unfinished reasoning that breaks off mid-sentence/);
      const resultFile = path.join(ctx.stateDir, "jobs", job.id, "result.md");
      assert.match(fs.readFileSync(resultFile, "utf8"), /unfinished reasoning that breaks off mid-sentence/);

      // The terminal verdict belongs to the probe-truth layer: with the
      // incident's probe evidence (P3/P4 red, base suite green) the SAME job
      // is closed as non-success -- exactly what cmdTask does after its
      // container probe phase.
      const fired = finalizeIncompleteCompletedRun({ job, probeResults: INCIDENT_RED_PROBES, stateDir });
      assert.equal(fired, true);
      assert.equal(job.status, "error");
      assert.equal(job.stopReason, "unknown", "stop reason must never be 'completed'");
      assert.match(job.error, /incomplete execution/);
      assert.match(job.error, /finish "unknown"/);
      assert.match(job.error, /test-author/);

      // The probe-truth layer persists the closed record (cmdTask saves right
      // after finalizing; the test mirrors that exactly).
      saveJob(stateDir, job);
      const persisted = loadJob(ctx.stateDir, job.id);
      assert.equal(persisted.status, "error");
      assert.equal(persisted.stopReason, "unknown");
      assert.equal(persisted.result.recovered, true);
      assert.equal(persisted.noFinalEvidence.finishedUnknown, true);
      assert.equal(persisted.phase, "test-author");

      // Audit trail: the recovery event, the no-final signal, and the final
      // incompleteness verdict.
      const events = fs.readFileSync(path.join(ctx.stateDir, "jobs", job.id, "events.ndjson"), "utf8")
        .trim().split("\n").map(JSON.parse);
      const types = events.map((e) => e.type);
      assert.ok(types.includes("companion.result.recovered"));
      assert.ok(types.includes("companion.result.no-final"));
      assert.ok(types.includes("companion.result.incomplete"));
      const incompleteEvent = events.find((e) => e.type === "companion.result.incomplete");
      assert.equal(incompleteEvent.source, "recovered");
      assert.equal(incompleteEvent.finishedUnknown, true);

      // `error` is not a provider-error: the walk does not advance or poison.
      assert.equal(failedRoutes.size, 0);
    } finally {
      ctx.killAll();
      ctx.restore();
      ctx.rm();
    }
  });

  it("the structured opencode finished-unknown shape also flows through the real path", async () => {
    const ctx = incompleteServeContext({ finalMessage: false, finishShape: "structured" });
    try {
      const { job } = await dispatchWithFallback(incompleteDispatchOpts(ctx.cwd, "implement"));
      assertSignalRecorded(job, ctx, "implement");
    } finally {
      ctx.killAll();
      ctx.restore();
      ctx.rm();
    }
  });

  it("a valid final payload preserves completed success even after finish unknown", async () => {
    const ctx = incompleteServeContext({ finalMessage: true, finishShape: "flat" });
    try {
      const { job, resultText } = await dispatchWithFallback(incompleteDispatchOpts(ctx.cwd, "implement"));

      assert.equal(job.status, "completed");
      assert.equal(job.stopReason, "completed");
      assert.equal(job.error, null);
      assert.equal(job.result.source, "final-message");
      assert.equal(job.result.recovered, false);
      assert.equal(job.noFinalEvidence, undefined, "a real final message records no no-final signal");
      assert.equal(resultText, "final answer");
    } finally {
      ctx.killAll();
      ctx.restore();
      ctx.rm();
    }
  });

  it("read-only plan keeps its recovered result as completed success and records no signal", async () => {
    const ctx = incompleteServeContext({ finalMessage: false, finishShape: "flat" });
    try {
      const { job, resultText } = await dispatchWithFallback(incompleteDispatchOpts(ctx.cwd, "plan"));

      assert.equal(job.status, "completed");
      assert.equal(job.stopReason, "completed");
      assert.equal(job.error, null);
      assert.equal(job.result.source, "recovered");
      assert.equal(job.result.recovered, true);
      assert.equal(job.noFinalEvidence, undefined, "the read-only carve-out records no no-final signal");
      assert.match(resultText, /unfinished reasoning that breaks off mid-sentence/);
    } finally {
      ctx.killAll();
      ctx.restore();
      ctx.rm();
    }
  });
});

// =========================================================================
// kusabi #496 — cmdTask boundary: the probe-truth layer closes the verdict
// =========================================================================
// The probes run AFTER the dispatch and are recorded on the job by cmdTask
// (chain layer equivalent: runProbePhase).  The recovered/no-final write run
// is therefore finalized HERE, with the probe evidence in hand: P3/P4 red
// closes it as non-success (and the task exits nonzero), while a
// complete-but-message-less write run whose deliverables/probes are green
// is not falsely failed.

const CMD_TASK_496_BRIEF = [
  "Orchestrator: test | session kusabi-496-task | 2026-09-13",
  "",
  "## Purpose",
  "",
  "Exercise recovered-incomplete task probe visibility.",
  "",
  "## Deliverables",
  "",
  "- tests/test_search_log_export.py",
  "- tests/test_search_log_calibrate.py",
  "",
].join("\n");

/**
 * A job exactly as runPrompt leaves a recovered/no-final run: completed with
 * the recorded stream signal, plus the probe results the container probe
 * phase records on it (the fixture's dispatch seam stands in for cmdTask's
 * own probe block, which needs a live container).
 */
function recoveredNoFinalJob({ id, phase = "test-author", probeResults, resultText = "recovered reasoning-only text" }) {
  const hasProbes = Array.isArray(probeResults) && probeResults.length > 0;
  const probesGreen = hasProbes ? probeResults.every((p) => p.passed) : undefined;
  return {
    job: {
      id,
      kind: "task",
      title: "kusabi 496 fixture",
      status: "completed",
      stopReason: "completed",
      phase,
      sessionID: "ses-496",
      modelEntry: "opencode-go/deepseek-v4-flash:max",
      modelVariant: null,
      error: null,
      retry: null,
      fallbacks: null,
      usage: { input: 5, output: 5, phase, durationSeconds: 3 },
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      stats: {
        events: 9,
        steps: 4,
        lastTool: null,
        permissionsAllowed: 0,
        permissionsRejected: 0,
        lastActivity: null,
        models: ["opencode-go/deepseek-v4-flash"],
      },
      noFinalEvidence: { finishedUnknown: true, source: "recovered", recovered: true, phase },
      result: {
        source: "recovered",
        recovered: true,
        fetchFailed: false,
        fetchError: null,
        recovery: { source: "opencode-events", chars: 42, reason: "no-final-message" },
      },
      ...(hasProbes ? { probeResults, probesGreen } : {}),
    },
    resultText,
    stateDir: null,
  };
}

async function runCmdTask496Recovered({ probeResults }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-496-task-"));
  const stateRoot = path.join(tmp, "state");
  const cwd = path.join(tmp, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(
    path.join(stateRoot, "config.json"),
    JSON.stringify({ models: { chain: [["opencode/opencode-test"]] } }),
    "utf8",
  );

  const savedStateRoot = process.env.KUSABI_STATE_DIR;
  process.env.KUSABI_STATE_DIR = stateRoot;
  const stateDir = stateDirFor(cwd);
  try {
    const output = await cmdTask(cwd, {
      flags: { phase: "test-author" },
      text: CMD_TASK_496_BRIEF,
      _dispatch: async (opts) => dispatchWithFallback({
        ...opts,
        _backendDispatch: () => async () => recoveredNoFinalJob({
          id: "job-496-recovered",
          phase: "test-author",
          probeResults,
        }),
      }),
    });
    // The events are read BEFORE tmp cleanup so the test body can assert on
    // the audit trail without racing the fixture's finally.
    const eventsPath = path.join(stateDir, "jobs", "job-496-recovered", "events.ndjson");
    const events = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf8") : "";
    return { outcome: commandOutcome(output), job: loadJob(stateDir, "job-496-recovered"), stateDir, events };
  } finally {
    if (savedStateRoot === undefined) delete process.env.KUSABI_STATE_DIR;
    else process.env.KUSABI_STATE_DIR = savedStateRoot;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("cmdTask recovered/no-final finalization (kusabi #496)", () => {
  it("finish unknown + recovered no-final + P3/P4 red closes as non-success and the task exits nonzero", async () => {
    const probeResults = [
      { probe: "P3: deliverables", passed: false, detail: "no declared deliverable paths changed" },
      { probe: "P4: smoke", passed: false, detail: "declared test files absent, pytest exit 4" },
      { probe: "P2: verify", passed: true, detail: "1062 passed" },
    ];
    const { outcome, job, events } = await runCmdTask496Recovered({ probeResults });

    // Nonzero exit: an incomplete recovered run is not a successful task.
    assert.notEqual(outcome.exitCode, 0);

    // The task output surfaces the incompleteness AND the failed probes.
    assert.match(outcome.text, /incomplete execution/);
    assert.match(outcome.text, /Probes:/);
    assert.match(outcome.text, /P3: deliverables \u2014 FAIL/);
    assert.match(outcome.text, /P4: smoke \u2014 FAIL/);

    // The stored result keeps the closed non-success status, the recovered
    // marker, the stream signal, and the probe truth (P3/P4 red, base green).
    assert.equal(job.status, "error");
    assert.equal(job.stopReason, "unknown");
    assert.equal(job.result.recovered, true);
    assert.equal(job.noFinalEvidence.finishedUnknown, true);
    assert.equal(job.probesGreen, false);
    assert.equal(job.probeResults.length, 3);
    const p3 = job.probeResults.find((p) => p.probe === "P3: deliverables");
    const p4 = job.probeResults.find((p) => p.probe === "P4: smoke");
    assert.ok(p3 && p3.passed === false);
    assert.ok(p4 && p4.passed === false);
    const p2 = job.probeResults.find((p) => p.probe === "P2: verify");
    assert.ok(p2 && p2.passed === true);

    // The incompleteness verdict lands in the audit trail (the no-final
    // stream signal is recorded by runPrompt and is covered by the end-to-end
    // runPrompt fixtures above, which drive the real stream).
    assert.match(events, /companion.result.incomplete/);
  });

  it("a complete-but-message-less write run with P3/P4 green is not falsely failed", async () => {
    const probeResults = [
      { probe: "P3: deliverables", passed: true, detail: "touches declared deliverables" },
      { probe: "P4: smoke", passed: true, detail: "all smoke command(s) passed" },
      { probe: "P2: verify", passed: true, detail: "1062 passed" },
    ];
    const { outcome, job } = await runCmdTask496Recovered({ probeResults });

    assert.equal(outcome.exitCode, 0);
    assert.equal(job.status, "completed");
    assert.equal(job.stopReason, "completed");
    assert.equal(job.error, null);
    assert.equal(job.result.recovered, true);
    assert.equal(job.noFinalEvidence.finishedUnknown, true);
    assert.equal(job.probesGreen, true);
  });

  it("a run whose probes never ran (no container) keeps its dispatch classification", async () => {
    const { outcome, job } = await runCmdTask496Recovered({ probeResults: null });

    assert.equal(outcome.exitCode, 0);
    assert.equal(job.status, "completed");
    assert.equal(job.stopReason, "completed");
    assert.equal(job.error, null);
    assert.equal(job.result.recovered, true);
    assert.equal(job.probeResults, undefined, "no probe truth was recorded");
  });
});
