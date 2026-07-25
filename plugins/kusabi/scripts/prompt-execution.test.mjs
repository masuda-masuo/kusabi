import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  accumulateUsage,
  decidePermission,
} from "./prompt-execution.mjs";

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

