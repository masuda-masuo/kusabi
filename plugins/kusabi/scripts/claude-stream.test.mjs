// claude-stream.test.mjs — tests for NDJSON stream parsing and accumulator (kusabi #426).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

import {
  parseClaudeStreamLine,
  initClaudeStreamAccumulator,
  applyClaudeStreamEvent,
} from "./claude-stream.mjs";

// Source guard: moved names must NOT be defined in claude-dispatch.mjs
// after the move to claude-stream.mjs (kusabi #426).
describe("claude-stream source guard", () => {
  it("claude-dispatch.mjs contains no export function parseClaudeStreamLine(", () => {
    const dispatchSrc = fs.readFileSync(
      path.join(import.meta.dirname, "claude-dispatch.mjs"),
      "utf8",
    );
    assert.ok(
      !dispatchSrc.includes("export function parseClaudeStreamLine("),
      "claude-dispatch.mjs must not export parseClaudeStreamLine",
    );
  });
});

describe("parseClaudeStreamLine", () => {
  it("parses a valid JSON object line", () => {
    const evt = parseClaudeStreamLine('{"type":"system","subtype":"init"}');
    assert.deepEqual(evt, { type: "system", subtype: "init" });
  });

  it("returns null for a blank line", () => {
    assert.equal(parseClaudeStreamLine(""), null);
    assert.equal(parseClaudeStreamLine("   "), null);
  });

  it("returns null for non-JSON prose (the observed leading warning line)", () => {
    assert.equal(
      parseClaudeStreamLine("Warning: no stdin data received in 3s, proceeding without it."),
      null,
    );
  });

  it("returns null for JSON that is not an object (array, number, string)", () => {
    assert.equal(parseClaudeStreamLine("[1,2,3]"), null);
    assert.equal(parseClaudeStreamLine("42"), null);
    assert.equal(parseClaudeStreamLine('"just a string"'), null);
    assert.equal(parseClaudeStreamLine("null"), null);
  });
});

describe("applyClaudeStreamEvent", () => {
  it("counts every recognized event as one of 'events', regardless of type", () => {
    const acc = initClaudeStreamAccumulator();
    applyClaudeStreamEvent(acc, { type: "system", subtype: "init", session_id: "s1" }, "t1");
    applyClaudeStreamEvent(acc, { type: "user", message: { content: [] } }, "t2");
    assert.equal(acc.events, 2);
    assert.equal(acc.lastActivity, "t2");
  });

  it("captures the session id from system/init only", () => {
    const acc = initClaudeStreamAccumulator();
    applyClaudeStreamEvent(acc, { type: "system", subtype: "thinking_tokens", estimated_tokens: 10 }, "t1");
    assert.equal(acc.sessionIdFromInit, null);
    applyClaudeStreamEvent(acc, { type: "system", subtype: "init", session_id: "claude-init-1" }, "t2");
    assert.equal(acc.sessionIdFromInit, "claude-init-1");
  });

  it("keeps the most recent rate_limit_event, stamped with when it was observed", () => {
    const acc = initClaudeStreamAccumulator();
    applyClaudeStreamEvent(acc, { type: "rate_limit_event", rate_limit_info: { resetsAt: 1 } }, "t1");
    applyClaudeStreamEvent(acc, { type: "rate_limit_event", rate_limit_info: { resetsAt: 2 } }, "t2");
    assert.deepEqual(acc.rateLimit, { info: { resetsAt: 2 }, observedAt: "t2" });
  });

  it("counts tool_use blocks as steps and tracks the most recent tool name", () => {
    const acc = initClaudeStreamAccumulator();
    applyClaudeStreamEvent(acc, {
      type: "assistant",
      message: {
        model: "claude-sonnet-4-5",
        content: [
          { type: "text", text: "thinking" },
          { type: "tool_use", id: "1", name: "mcp__sunaba__read_file_range" },
        ],
      },
    }, "t1");
    applyClaudeStreamEvent(acc, {
      type: "assistant",
      message: { model: "claude-sonnet-4-5", content: [{ type: "tool_use", id: "2", name: "mcp__sunaba__edit_file" }] },
    }, "t2");
    assert.equal(acc.steps, 2);
    assert.equal(acc.lastTool, "mcp__sunaba__edit_file");
    // Same model on both messages — deduped, not doubled.
    assert.deepEqual(acc.models, ["claude-sonnet-4-5"]);
  });

  it("dedupes models across multiple assistant messages", () => {
    const acc = initClaudeStreamAccumulator();
    applyClaudeStreamEvent(acc, { type: "assistant", message: { model: "opus", content: [] } }, "t1");
    applyClaudeStreamEvent(acc, { type: "assistant", message: { model: "sonnet", content: [] } }, "t2");
    applyClaudeStreamEvent(acc, { type: "assistant", message: { model: "opus", content: [] } }, "t3");
    assert.deepEqual(acc.models, ["opus", "sonnet"]);
  });

  it("keeps the LAST result event when a stream carries more than one", () => {
    const acc = initClaudeStreamAccumulator();
    applyClaudeStreamEvent(acc, { type: "result", result: "first" }, "t1");
    applyClaudeStreamEvent(acc, { type: "result", result: "second" }, "t2");
    assert.equal(acc.resultEvent.result, "second");
  });

  it("ignores user events beyond counting them (no stat they contribute today)", () => {
    const acc = initClaudeStreamAccumulator();
    applyClaudeStreamEvent(acc, { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }, "t1");
    assert.equal(acc.events, 1);
    assert.equal(acc.steps, 0);
  });
});
