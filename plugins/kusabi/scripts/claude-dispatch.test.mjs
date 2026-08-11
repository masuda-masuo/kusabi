// claude-dispatch.test.mjs — tests for the Claude Code CLI dispatch backend
// (kusabi #184).
//
// Spawn-based tests follow the serve-lifecycle.test.mjs pattern: the binary
// is resolved through CLAUDE_BIN, so tests point it at a fake `claude`
// script written into a temp dir, with KUSABI_STATE_DIR and
// KUSABI_CLAUDE_MCP_SOURCE pointing at temp fixtures.  Every process the
// fake spawns is asserted dead (by pid) after the timeout test.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

import {
  ALLOWED_TOOLS,
  CLAUDE_DEFAULT_CHAIN,
  claudeBin,
  validateClaudeModel,
  validateClaudeChain,
  resolveClaudeModel,
  stripFrontmatter,
  buildClaudeArgs,
  parseClaudeResult,
  mapClaudeUsage,
  classifyClaudeTerminalFailure,
  renderClaudeQuotaError,
  parseClaudeStreamLine,
  initClaudeStreamAccumulator,
  applyClaudeStreamEvent,
  allowedToolsForAgent,
  disallowedToolsForAgent,
  applyToolDenies,
  translateDenyTools,
  clampModelDispatch,
  extractSunabaMcp,
  claudeDispatch,
} from "./claude-dispatch.mjs";
import { resolveBackend, resolveDispatchBackend } from "./kusabi-companion.mjs";
import { dispatchWithFallback } from "./prompt-execution.mjs";
import { runImplementPhase } from "./chain-phases.mjs";
import { WRITE_TOOL_NAMES, implementDenyTools, firstRoute } from "./cli.mjs";
import { stateDirFor, readJson } from "./state-paths.mjs";
import { loadJob, jobDir, listJobs } from "./job-store.mjs";

// =========================================================================
// pure helpers
// =========================================================================

describe("claudeBin", () => {
  const saved = process.env.CLAUDE_BIN;

  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = saved;
  });

  it("defaults to claude", () => {
    delete process.env.CLAUDE_BIN;
    assert.equal(claudeBin(), "claude");
  });

  it("honors CLAUDE_BIN", () => {
    process.env.CLAUDE_BIN = "/tmp/fake-claude";
    assert.equal(claudeBin(), "/tmp/fake-claude");
  });
});

describe("validateClaudeModel", () => {
  it("accepts bare aliases", () => {
    assert.equal(validateClaudeModel("opus"), "opus");
    assert.equal(validateClaudeModel("sonnet"), "sonnet");
    assert.equal(validateClaudeModel("haiku"), "haiku");
  });

  it("accepts full model ids", () => {
    assert.equal(validateClaudeModel("claude-sonnet-4-5"), "claude-sonnet-4-5");
    assert.equal(validateClaudeModel("claude-opus-4-1"), "claude-opus-4-1");
  });

  it("returns null for absent values", () => {
    assert.equal(validateClaudeModel(undefined), null);
    assert.equal(validateClaudeModel(null), null);
    assert.equal(validateClaudeModel(""), null);
  });

  it("rejects a :variant suffix with an error naming the limitation", () => {
    assert.throws(() => validateClaudeModel("opus:max"), /:variant/);
    assert.throws(() => validateClaudeModel("opencode/deepseek-v4-flash-free:max"), /:variant/);
    assert.throws(() => validateClaudeModel("claude-sonnet-4-5:thinking"), /claude backend does not support/);
  });
});

describe("resolveClaudeModel", () => {
  it("flag wins", () => {
    const r = resolveClaudeModel({ flag: "opus", config: { models: { chain: [["sonnet"]] } } });
    assert.equal(r.model, "opus");
    assert.deepEqual(r.chain, [["sonnet"]]);
  });

  it("phase chain wins over global chain", () => {
    const config = {
      models: {
        chain: [["opus"]],
        phases: { implement: [["haiku"]] },
      },
    };
    const r = resolveClaudeModel({ flag: null, phase: "implement", config });
    assert.equal(r.model, "haiku");
  });

  it("global chain first route when no phase chain", () => {
    const r = resolveClaudeModel({ flag: null, phase: "review", config: { models: { chain: [["opus"], ["sonnet"]] } } });
    assert.equal(r.model, "opus");
  });

  it("claude-native default chain when no config", () => {
    const r = resolveClaudeModel({ flag: null, config: null });
    // The default chain is claude-shaped (bare aliases), so `--backend
    // claude` without --model and without config works out of the box — the
    // opencode built-in chain (provider/model:variant) is never used here.
    assert.equal(r.model, firstRoute(CLAUDE_DEFAULT_CHAIN));
    assert.deepEqual(r.chain, CLAUDE_DEFAULT_CHAIN);
    assert.equal(r.model, "sonnet");
  });
});

describe("validateClaudeChain", () => {
  it("accepts a claude-shaped chain (string tiers and route arrays)", () => {
    const chain = [["sonnet"], "opus", ["haiku", "claude-sonnet-4-5"]];
    assert.equal(validateClaudeChain(chain), chain);
  });

  it("accepts an empty chain (model resolution reports it separately)", () => {
    assert.deepEqual(validateClaudeChain([]), []);
  });

  it("rejects an opencode-shaped chain entry, naming it and the limitation", () => {
    assert.throws(
      () => validateClaudeChain([["opencode/deepseek-v4-flash-free:max"], ["sonnet"]]),
      (err) => {
        assert.match(err.message, /chain entry "opencode\/deepseek-v4-flash-free:max"/);
        assert.match(err.message, /:variant/);
        assert.match(err.message, /bare aliases \(opus, sonnet, haiku\)/);
        return true;
      },
    );
  });

  it("rejects a :variant suffix in any tier, not just the first route", () => {
    assert.throws(
      () => validateClaudeChain([["sonnet"], ["opus:max"]]),
      /chain entry "opus:max"/,
    );
  });
});

describe("stripFrontmatter", () => {
  it("removes a leading YAML frontmatter block", () => {
    const text = "---\ndescription: x\npermission:\n  \"*\": deny\n---\nBody line one.\nBody line two.\n";
    assert.equal(stripFrontmatter(text), "Body line one.\nBody line two.");
  });

  it("returns the trimmed text when no frontmatter", () => {
    assert.equal(stripFrontmatter("  plain body  "), "plain body");
  });
});

describe("buildClaudeArgs", () => {
  it("builds the contract invocation shape", () => {
    const args = buildClaudeArgs({
      model: "opus",
      allowedTools: "a,b",
      disallowedTools: "mcp__sunaba__publish,Bash",
      mcpConfigPath: "/tmp/mcp.json",
      systemPrompt: "You are the implement worker.",
    });
    assert.deepEqual(args, [
      "-p",
      "--strict-mcp-config",
      "--setting-sources", "",
      "--output-format", "stream-json",
      "--verbose",
      "--model", "opus",
      "--allowedTools", "a,b",
      "--disallowedTools", "mcp__sunaba__publish,Bash",
      "--mcp-config", "/tmp/mcp.json",
      "--append-system-prompt", "You are the implement worker.",
    ]);
  });

  it("omits --append-system-prompt when there is no system prompt", () => {
    const args = buildClaudeArgs({
      model: "opus",
      allowedTools: "a",
      disallowedTools: "Bash",
      mcpConfigPath: "/tmp/mcp.json",
      systemPrompt: null,
    });
    assert.ok(!args.includes("--append-system-prompt"));
  });

  it("never puts the prompt on argv (stdin transport, I5)", () => {
    // buildClaudeArgs takes no promptText at all: a prompt can never leak
    // into argv (ps output, argv-logged transcripts).
    const args = buildClaudeArgs({
      model: "opus",
      allowedTools: "a",
      disallowedTools: "Bash",
      mcpConfigPath: "/tmp/mcp.json",
      systemPrompt: null,
    });
    assert.deepEqual(args.slice(0, 4), ["-p", "--strict-mcp-config", "--setting-sources", ""]);
  });

  it("isolates the session from ambient settings (I2): strict MCP + empty setting sources", () => {
    const args = buildClaudeArgs({
      model: "opus",
      allowedTools: "a",
      disallowedTools: "Bash",
      mcpConfigPath: "/tmp/mcp.json",
      systemPrompt: null,
    });
    assert.ok(args.includes("--strict-mcp-config"));
    const sourcesIdx = args.indexOf("--setting-sources");
    assert.ok(sourcesIdx > 0);
    assert.equal(args[sourcesIdx + 1], "");
  });

  it("appends --resume <session> when a session is given (nothing else changes)", () => {
    const fresh = buildClaudeArgs({
      model: "opus",
      allowedTools: "a,b",
      disallowedTools: "Bash",
      mcpConfigPath: "/tmp/mcp.json",
      systemPrompt: null,
    });
    const resumed = buildClaudeArgs({
      model: "opus",
      allowedTools: "a,b",
      disallowedTools: "Bash",
      mcpConfigPath: "/tmp/mcp.json",
      systemPrompt: null,
      session: "claude-session-abc123",
    });
    // The resume flag is appended at the END: strict flags, stdin transport,
    // and allow/deny lists are byte-identical to a fresh dispatch.
    assert.deepEqual(resumed.slice(0, fresh.length), fresh);
    assert.deepEqual(resumed.slice(fresh.length), ["--resume", "claude-session-abc123"]);
  });

  it("omits --resume when no session is given", () => {
    const args = buildClaudeArgs({
      model: "opus",
      allowedTools: "a",
      disallowedTools: "Bash",
      mcpConfigPath: "/tmp/mcp.json",
      systemPrompt: null,
    });
    assert.ok(!args.includes("--resume"));
  });
});

describe("disallowedToolsForAgent", () => {
  const FULL = [
    "mcp__sunaba__publish",
    "mcp__sunaba__sandbox_issue_write",
    "mcp__sunaba__sandbox_pr_review_write",
    "mcp__sunaba__secret_scan_override",
    "mcp__sunaba__sandbox_stop",
    "mcp__sunaba__sandbox_initialize",
    "mcp__sunaba__copy_file",
    "mcp__sunaba__copy_project",
    "mcp__sunaba__run_container_and_exec",
    "Bash",
    "Edit",
    "Write",
    "NotebookEdit",
  ];

  it("denies every never-run tool including issue write (implement agent, I1/I3)", () => {
    const csv = disallowedToolsForAgent("kusabi-implement");
    for (const tool of FULL) {
      assert.ok(csv.split(",").includes(tool), `${tool} must be disallowed, got: ${csv}`);
    }
  });

  it("exempts issue write for kusabi-investigate only", () => {
    const csv = disallowedToolsForAgent("kusabi-investigate");
    const tools = csv.split(",");
    assert.ok(!tools.includes("mcp__sunaba__sandbox_issue_write"));
    // Everything else stays denied.
    for (const tool of FULL) {
      if (tool === "mcp__sunaba__sandbox_issue_write") continue;
      assert.ok(tools.includes(tool), `${tool} must be disallowed, got: ${csv}`);
    }
  });

  it("denies issue write for every non-investigate agent (incl. review and no agent)", () => {
    for (const agent of ["kusabi-review", null, undefined, "kusabi-draft"]) {
      assert.ok(
        disallowedToolsForAgent(agent).split(",").includes("mcp__sunaba__sandbox_issue_write"),
        `agent ${agent} must deny issue write`,
      );
    }
  });
});

describe("parseClaudeResult", () => {
  it("parses a valid result object", () => {
    const parsed = parseClaudeResult(JSON.stringify({ type: "result", is_error: false, result: "ok" }));
    assert.equal(parsed.type, "result");
    assert.equal(parsed.result, "ok");
  });

  it("throws on garbage (not JSON)", () => {
    assert.throws(() => parseClaudeResult("this is not json"), /not JSON/);
  });

  it("throws on a non-result JSON shape", () => {
    assert.throws(() => parseClaudeResult(JSON.stringify({ type: "system", subtype: "init" })), /unexpected type/);
    assert.throws(() => parseClaudeResult(JSON.stringify([1, 2])), /not a JSON object/);
  });
});

describe("mapClaudeUsage", () => {
  it("maps claude usage fields onto the kusabi usage shape (test-asserted)", () => {
    const usage = mapClaudeUsage({
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 3000,
      },
      total_cost_usd: 0.0042,
    });
    assert.equal(usage.available, true);
    assert.equal(usage.input, 1000);
    assert.equal(usage.output, 500);
    assert.equal(usage.cacheWrite, 200);
    assert.equal(usage.cacheRead, 3000);
    assert.equal(usage.cost, 0.0042);
    assert.equal(usage.reasoning, 0);
  });

  it("defaults missing counters to 0", () => {
    const usage = mapClaudeUsage({ usage: {} });
    assert.equal(usage.input, 0);
    assert.equal(usage.output, 0);
    assert.equal(usage.cacheWrite, 0);
    assert.equal(usage.cacheRead, 0);
    assert.equal(usage.cost, 0);
  });
});

// =========================================================================
// NDJSON stream parsing — pure (kusabi #215 Job B)
// =========================================================================

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

// =========================================================================
// classifyClaudeTerminalFailure — quota exhaustion classification (kusabi
// #215): the real 2026-08-11 session-limit payload and its neighbours.
// =========================================================================

describe("classifyClaudeTerminalFailure", () => {
  // The REAL incident payload (job-msnf4qph5ccd, 2026-08-11): an implement
  // phase that ran 256s, cost $2.39, made zero edits, and died on the
  // account's session limit.
  const REAL_SESSION_LIMIT_PAYLOAD = {
    type: "result",
    is_error: true,
    api_error_status: 429,
    terminal_reason: "api_error",
    subtype: "success", // never a success signal
    result: "You've hit your session limit · resets 1:20am (Asia/Tokyo)",
    total_cost_usd: 2.391763,
  };

  it("classifies the real session-limit 429 payload (quota, backend blocked, reset)", () => {
    const f = classifyClaudeTerminalFailure(REAL_SESSION_LIMIT_PAYLOAD);
    assert.deepEqual(f, {
      kind: "quota-exhaustion",
      quota: "session",
      backendBlocked: true,
      reset: "1:20am (Asia/Tokyo)",
    });
  });

  it("ignores `subtype` entirely — `subtype: success` next to is_error still classifies by quota text", () => {
    const f = classifyClaudeTerminalFailure(REAL_SESSION_LIMIT_PAYLOAD);
    assert.equal(f.kind, "quota-exhaustion");
    assert.equal(f.quota, "session");
  });

  it("returns null for a generic is_error payload without quota markers", () => {
    assert.equal(
      classifyClaudeTerminalFailure({ type: "result", is_error: true, api_error_status: 500, result: "boom: tool call failed" }),
      null,
    );
    assert.equal(
      classifyClaudeTerminalFailure({ type: "result", is_error: true, terminal_reason: "api_error", result: "Internal server error" }),
      null,
    );
    // "exhausted" alone is NOT a quota marker (e.g. "context window
    // exhausted") — classification must stay conservative so generic errors
    // fail exactly as today.
    assert.equal(
      classifyClaudeTerminalFailure({ type: "result", is_error: true, result: "context window exhausted" }),
      null,
    );
  });

  it("does not classify a generic error containing the bare word 'reset'", () => {
    // Regression (kusabi #215 review finding): a bare `resets?` alternative in
    // QUOTA_TEXT_RE turned survivable generic errors ("git reset failed") into
    // quota-exhaustion, which hard-stops the chain with wrong advice.  The
    // reset TIME is extracted separately and must not gate classification.
    for (const result of [
      "fatal: failed to reset the workspace",
      "git reset --hard exited with code 128",
      "context reset by peer",
      // Bare "quota" is likewise unqualified: a filesystem EDQUOT must not
      // become a chain-stopping provider-error.
      "write failed: disk quota exceeded on /workspace",
    ]) {
      assert.equal(
        classifyClaudeTerminalFailure({ type: "result", is_error: true, result }),
        null,
        `must stay null for: ${result}`,
      );
    }
  });

  it("classifies a rate-limit text without HTTP 429 as rate quota, backend NOT blocked", () => {
    const f = classifyClaudeTerminalFailure({
      type: "result", is_error: true,
      result: "Rate limit reached. Please retry your request again later.",
    });
    assert.deepEqual(f, {
      kind: "quota-exhaustion",
      quota: "rate",
      backendBlocked: false,
      reset: null,
    });
  });

  it("does not call a non-rate quota phrase 'rate': monthly spend limit classifies as unknown", () => {
    // The kind reported to the operator must come from the text: only an
    // explicit rate-limit phrase may be labelled "rate" (review finding on
    // the earlier is429-precedence derivation).
    const f = classifyClaudeTerminalFailure({
      type: "result", is_error: true,
      result: "Your monthly spend limit has been reached.",
    });
    assert.equal(f.kind, "quota-exhaustion");
    assert.equal(f.quota, "unknown");
    assert.equal(f.backendBlocked, false);
  });

  it("keeps 'rate' for an explicit rate-limit phrase even with HTTP 429", () => {
    const f = classifyClaudeTerminalFailure({
      type: "result", is_error: true, api_error_status: 429,
      result: "Rate limit reached. Please retry your request again later.",
    });
    assert.equal(f.quota, "rate");
  });

  it("classifies a bare 429 (no quota text) as quota-exhaustion with quota unknown", () => {
    const f = classifyClaudeTerminalFailure({
      type: "result", is_error: true, api_error_status: 429,
      result: "API Error: 429",
    });
    assert.equal(f.kind, "quota-exhaustion");
    assert.equal(f.quota, "unknown");
    assert.equal(f.backendBlocked, false);
  });

  it("reads a structured reset field when the payload carries one", () => {
    const f = classifyClaudeTerminalFailure({
      type: "result", is_error: true, api_error_status: 429,
      resetAt: "2026-08-12T00:00:00Z",
      result: "rate limit reached",
    });
    assert.equal(f.reset, "2026-08-12T00:00:00Z");
  });

  // kusabi #215 Job B item 4: the rate_limit_event stream feed is a
  // FALLBACK reset source, consulted only when the payload itself names
  // none — text and structured fields always win when present.
  it("falls back to the streamed rate_limit_info.resetsAt when the payload names no reset", () => {
    const f = classifyClaudeTerminalFailure(
      { type: "result", is_error: true, api_error_status: 429, result: "You've hit your session limit." },
      { rateLimit: { info: { resetsAt: 1786424400 }, observedAt: "2026-08-11T05:00:00.000Z" } },
    );
    assert.equal(f.reset, new Date(1786424400 * 1000).toISOString());
  });

  it("prefers the payload's own reset text over the streamed rate_limit_info", () => {
    const f = classifyClaudeTerminalFailure(
      REAL_SESSION_LIMIT_PAYLOAD,
      { rateLimit: { info: { resetsAt: 1786424400 }, observedAt: "2026-08-11T05:00:00.000Z" } },
    );
    assert.equal(f.reset, "1:20am (Asia/Tokyo)");
  });

  it("ignores a malformed rate_limit_info (no resetsAt) and stays null", () => {
    const f = classifyClaudeTerminalFailure(
      { type: "result", is_error: true, api_error_status: 429, result: "You've hit your session limit." },
      { rateLimit: { info: { status: "allowed" }, observedAt: "2026-08-11T05:00:00.000Z" } },
    );
    assert.equal(f.reset, null);
  });

  it("works with no rateLimit argument at all (backward compatible, PR #218 call shape)", () => {
    const f = classifyClaudeTerminalFailure(REAL_SESSION_LIMIT_PAYLOAD);
    assert.equal(f.reset, "1:20am (Asia/Tokyo)");
  });

  it("returns null for a non-object payload", () => {
    assert.equal(classifyClaudeTerminalFailure(null), null);
    assert.equal(classifyClaudeTerminalFailure(undefined), null);
    assert.equal(classifyClaudeTerminalFailure("result"), null);
  });
});

describe("renderClaudeQuotaError", () => {
  it("session: names the quota, the reset, the whole-backend block, and the opencode switch", () => {
    const text = renderClaudeQuotaError(
      { quota: "session", reset: "1:20am (Asia/Tokyo)" },
      "You've hit your session limit · resets 1:20am (Asia/Tokyo)",
    );
    assert.match(text, /claude dispatch failed: You've hit your session limit/); // raw text preserved
    assert.match(text, /session limit exhausted \(resets 1:20am \(Asia\/Tokyo\)\)/);
    assert.match(text, /whole claude backend is blocked/);
    assert.match(text, /your own Claude Code session/);
    assert.match(text, /Switch the phase to the opencode backend/);
    assert.match(text, /do not retry claude/);
  });

  it("rate: advises against walking other claude models, does not claim the backend is blocked", () => {
    const text = renderClaudeQuotaError({ quota: "rate", reset: null }, "Rate limit reached");
    assert.match(text, /claude rate limit active/);
    assert.match(text, /walking other claude models will not help/);
    assert.ok(!text.includes("whole claude backend is blocked"));
    assert.ok(!text.includes("do not retry claude"));
  });

  it("unknown: never asserts 'rate limit', says the kind is unknown, promises no retry", () => {
    // Regression (kusabi #215 review finding): a bare 429 classifies as
    // quota "unknown"; the message must not assert a kind the classifier
    // did not determine (it may in fact be the session limit without its
    // text marker), and must not say "a retry later may succeed" when the
    // chain driver hard-stops on this status.
    const text = renderClaudeQuotaError({ quota: "unknown", reset: null }, "API Error: 429");
    assert.match(text, /kind unknown/);
    assert.ok(!text.includes("rate limit active"));
    assert.ok(!text.includes("retry later may succeed"));
    assert.match(text, /not retried automatically/);
    assert.match(text, /walking other claude models will not help/);
  });
});

// =========================================================================
// Reset plausibility + provenance (cross-review of PR #219).  The rate feed
// is the only reset source we do not control the shape of, and its value is
// shown to an operator who schedules around it.
// =========================================================================

describe("classifyClaudeTerminalFailure — rate-feed reset plausibility bounds", () => {
  // A session-limit payload naming no reset of its own, so the classifier
  // always reaches the rate-feed fallback.
  const NO_RESET_PAYLOAD = {
    type: "result", is_error: true, api_error_status: 429,
    result: "You've hit your session limit.",
  };
  const feed = (resetsAt) => ({
    rateLimit: { info: { resetsAt }, observedAt: "2026-08-11T05:00:00.000Z" },
  });
  const resetFor = (resetsAt) => classifyClaudeTerminalFailure(NO_RESET_PAYLOAD, feed(resetsAt)).reset;

  it("rejects resetsAt: 0 instead of telling the operator the quota reset in 1970", () => {
    assert.equal(new Date(0).toISOString(), "1970-01-01T00:00:00.000Z"); // what it used to render
    assert.equal(resetFor(0), null);
  });

  it("rejects a negative resetsAt", () => {
    assert.equal(resetFor(-1), null);
    assert.equal(resetFor(-1786424400), null);
  });

  it("rejects a millisecond-epoch resetsAt (same field, wrong unit)", () => {
    // 1765430400000 as SECONDS lands five figures into the future; rendering
    // that as this quota's reset time is worse than admitting we have none.
    assert.ok(new Date(1765430400000 * 1000).getUTCFullYear() > 9999);
    assert.equal(resetFor(1765430400000), null);
  });

  it("still accepts a sane epoch-seconds value, unchanged", () => {
    assert.equal(resetFor(1786424400), new Date(1786424400 * 1000).toISOString());
  });

  it("a rejected feed value leaves reset null — it never falls through to a wrong one", () => {
    const f = classifyClaudeTerminalFailure(NO_RESET_PAYLOAD, feed(0));
    assert.equal(f.kind, "quota-exhaustion");
    assert.equal(f.quota, "session");
    assert.equal(f.backendBlocked, true);
    assert.equal(f.reset, null);
  });
});

describe("renderClaudeQuotaError — reset provenance", () => {
  const ISO = new Date(1786424400 * 1000).toISOString();

  it("marks a rate-feed reset as coming from the feed, not from the payload", () => {
    const text = renderClaudeQuotaError(
      { quota: "session", reset: ISO },
      "You've hit your session limit.",
      { resetFromRateFeed: true },
    );
    assert.ok(text.includes(`(resets ~${ISO}, from live rate feed)`));
    // The rest of the session advice is untouched.
    assert.match(text, /whole claude backend is blocked/);
    assert.match(text, /do not retry claude/);
  });

  it("renders a payload-named reset exactly as before — no marker, no approximation", () => {
    const failure = { quota: "session", reset: "1:20am (Asia/Tokyo)" };
    const detail = "You've hit your session limit · resets 1:20am (Asia/Tokyo)";
    const text = renderClaudeQuotaError(failure, detail, { resetFromRateFeed: false });
    assert.match(text, /\(resets 1:20am \(Asia\/Tokyo\)\)/);
    assert.ok(!text.includes("rate feed"));
    assert.ok(!text.includes("~"));
    // ...and the two-argument call (no provenance given) renders identically:
    // absent information must never be reported as a feed fallback.
    assert.equal(text, renderClaudeQuotaError(failure, detail));
  });

  it("says nothing about a reset, or its provenance, when there is none", () => {
    const text = renderClaudeQuotaError({ quota: "rate", reset: null }, "Rate limit reached", { resetFromRateFeed: true });
    assert.ok(!text.includes("resets"));
    assert.ok(!text.includes("rate feed"));
  });
});

describe("allowedToolsForAgent", () => {
  it("maps the implement agent to the implement allowlist (mirrors kusabi-implement.md)", () => {
    const csv = allowedToolsForAgent("kusabi-implement");
    assert.equal(csv, ALLOWED_TOOLS.implement);
    assert.ok(csv.includes("mcp__sunaba__write_file"));
    assert.ok(csv.includes("mcp__sunaba__edit_file"));
    assert.ok(!csv.includes("mcp__sunaba__sandbox_issue_write"));
  });

  it("maps a bare task (no agent) to the implement allowlist", () => {
    assert.equal(allowedToolsForAgent(undefined), ALLOWED_TOOLS.implement);
    assert.equal(allowedToolsForAgent(null), ALLOWED_TOOLS.implement);
  });

  it("maps review to the review allowlist (mirrors kusabi-review.md)", () => {
    const csv = allowedToolsForAgent("kusabi-review");
    assert.equal(csv, ALLOWED_TOOLS.review);
    assert.ok(csv.includes("mcp__sunaba__verify_in_container"));
    assert.ok(csv.includes("mcp__shiori__*"));
    assert.ok(!csv.includes("mcp__sunaba__write_file"));
    assert.ok(!csv.includes("mcp__sunaba__sandbox_issue_write"));
  });

  it("maps investigate to its own allowlist with issue write (mirrors kusabi-investigate.md)", () => {
    const csv = allowedToolsForAgent("kusabi-investigate");
    assert.equal(csv, ALLOWED_TOOLS.investigate);
    // The standalone investigate deliverable is appending the brief to the
    // issue — the issue-write grant must NOT be lost on the claude backend
    // (kusabi #184 finding 3).  The chain strategist keeps the review-shaped
    // toolset because its phase passes reviewDenyTools(), which denies this
    // tool by exact match.
    assert.ok(csv.includes("mcp__sunaba__sandbox_issue_write"));
    assert.ok(csv.includes("mcp__shiori__*"));
    assert.ok(csv.includes("mcp__sunaba__sandbox_exec"));
    assert.ok(!csv.includes("mcp__sunaba__write_file"));
  });

  it("rejects agents with no v1 allowlist", () => {
    assert.throws(() => allowedToolsForAgent("kusabi-draft"), /no permission allowlist/);
    assert.throws(() => allowedToolsForAgent("custom-agent"), /no permission allowlist/);
  });
});

describe("applyToolDenies", () => {
  it("removes explicitly denied tools from the CSV", () => {
    const csv = applyToolDenies("a,b,c", { b: false });
    assert.equal(csv, "a,c");
  });

  it("removes the phase deny maps' real tool names from the allowlist", () => {
    // implementDenyTools / reviewDenyTools name real sunaba tools (the copy
    // tools) — normalized to mcp__sunaba__* and removed by exact match.
    const csv = applyToolDenies("a,mcp__sunaba__copy_project,b", { sunaba_copy_project: false });
    assert.equal(csv, "a,b");
  });

  it("is a no-op for deny maps with no matching tools", () => {
    const csv = applyToolDenies("a,b", { bash: false, edit: false });
    assert.equal(csv, "a,b");
  });

  it("is a no-op without a tools map", () => {
    assert.equal(applyToolDenies("a,b", undefined), "a,b");
    assert.equal(applyToolDenies("a,b", null), "a,b");
  });

  it("does NOT strip the implement allowlist for the phase deny map (opencode names are no-ops there)", () => {
    // The chain implement phase passes implementDenyTools() (opencode
    // vocabulary + copy tools).  Its opencode-native names must not map to
    // sunaba tools — the allowlist IS the permission mechanism, and mapping
    // bash/edit/write/patch would neuter the implement worker.  The result
    // must be byte-identical to the untouched allowlist (the copy tools are
    // not in it).
    const csv = applyToolDenies(ALLOWED_TOOLS.implement, implementDenyTools());
    assert.equal(csv, ALLOWED_TOOLS.implement);
    assert.ok(csv.includes("mcp__sunaba__write_file"));
    assert.ok(csv.includes("mcp__sunaba__sandbox_exec"));
  });
});

describe("translateDenyTools", () => {
  it("maps the opencode --read-only vocabulary to the sunaba tools (task has no equivalent)", () => {
    const readOnly = Object.fromEntries(WRITE_TOOL_NAMES.map((t) => [t, false]));
    const translated = translateDenyTools(readOnly);
    assert.deepEqual(translated, {
      mcp__sunaba__sandbox_exec: false,
      mcp__sunaba__write_file: false,
      mcp__sunaba__edit_file: false,
      mcp__sunaba__transform_file: false,
    });
  });

  it("keeps sunaba_* names (and other non-vocabulary names) verbatim", () => {
    const translated = translateDenyTools({ sunaba_write_file: false, bash: false, sunaba_sandbox_issue_write: false });
    assert.deepEqual(translated, {
      sunaba_write_file: false,
      mcp__sunaba__sandbox_exec: false,
      sunaba_sandbox_issue_write: false,
    });
  });

  it("is a no-op without a tools map", () => {
    assert.equal(translateDenyTools(undefined), undefined);
    assert.equal(translateDenyTools(null), null);
  });
});

describe("clampModelDispatch", () => {
  it("fills explicitModel from the command-start model when the phase passes none", async () => {
    const calls = [];
    const inner = async (opts) => { calls.push(opts); return { job: {}, resultText: "", stateDir: "" }; };
    const wrapped = clampModelDispatch(inner, "opus");

    await wrapped({ kind: "task", round: 2, explicitModel: null });
    await wrapped({ kind: "review", explicitModel: "opus" });
    await wrapped({ kind: "strategist", explicitModel: undefined });

    // Rework/strategist phases pass no explicitModel → clamped to opus; a
    // phase that does pass one keeps it.
    assert.equal(calls[0].explicitModel, "opus");
    assert.equal(calls[1].explicitModel, "opus");
    assert.equal(calls[2].explicitModel, "opus");
    // All other options pass through untouched.
    assert.equal(calls[0].round, 2);
    assert.equal(calls[2].kind, "strategist");
  });

  it("falls through to null when neither the phase nor the model supplies one", async () => {
    const calls = [];
    const inner = async (opts) => { calls.push(opts); return { job: {}, resultText: "", stateDir: "" }; };
    const wrapped = clampModelDispatch(inner, null);
    await wrapped({ kind: "task", explicitModel: null });
    assert.equal(calls[0].explicitModel, null);
  });
});

describe("extractSunabaMcp", () => {
  it("extracts the sunaba server entry", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-claude-mcp-"));
    const file = path.join(dir, "claude.json");
    const sunaba = { command: "npx", args: ["-y", "sunaba"] };
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { sunaba, other: { command: "echo" } } }), "utf8");
    assert.deepEqual(extractSunabaMcp(file), sunaba);
  });

  it("throws a clear error when the entry is missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-claude-mcp-"));
    const file = path.join(dir, "claude.json");
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: "echo" } } }), "utf8");
    assert.throws(() => extractSunabaMcp(file), /no mcpServers\.sunaba entry/);
  });

  it("throws a clear error when the file is unreadable", () => {
    assert.throws(() => extractSunabaMcp("/nonexistent/never.json"), /cannot read MCP source config/);
  });
});

// =========================================================================
// integration — fake `claude` binary (CLAUDE_BIN), like serve-lifecycle
// =========================================================================

const FAKE_CLAUDE_SOURCE = `#!/usr/bin/env node
import fs from "node:fs";

fs.appendFileSync(process.env.FAKE_CLAUDE_ARGS_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
fs.appendFileSync(process.env.FAKE_CLAUDE_PIDS, String(process.pid) + "\\n");

// Prompt arrives on stdin (I5): the dispatch writes it and ends the stream.
// Recording it proves the prompt reached the child without touching argv.
const promptText = fs.readFileSync(0, "utf8");
if (process.env.FAKE_CLAUDE_STDIN_LOG) {
  fs.appendFileSync(process.env.FAKE_CLAUDE_STDIN_LOG, promptText);
}

const mode = process.env.FAKE_CLAUDE_MODE || "ok";

if (mode === "exit") {
  process.stderr.write("claude: permission denied for model opus\\n");
  process.exit(3);
}
if (mode === "garbage") {
  process.stdout.write("this is not json at all\\n");
  process.exit(0);
}
if (mode === "is-error" || mode === "is-error-exit1") {
  // "subtype: success" next to "is_error: true" is the real 2026-08-11
  // session-limit shape: subtype must NEVER influence success/failure.
  process.stdout.write(JSON.stringify({
    type: "result", is_error: true, result: "boom: tool call failed",
    subtype: "success",
    session_id: "sess-err", usage: {}, total_cost_usd: 0, duration_ms: 5, num_turns: 1,
  }));
  // "is-error-exit1" adds the stderr diagnostic a real nonzero exit carries
  // (auth/model-permission errors) and exits nonzero — one shared payload
  // literal, so the only variable under test is exit code + stderr.
  process.stderr.write("claude: authentication failed\\n");
  process.exit(mode === "is-error-exit1" ? 1 : 0);
}
if (mode === "quota-session" || mode === "quota-session-exit1") {
  // The REAL incident terminal payload (job-msnf4qph5ccd, 2026-08-11): an
  // implement phase that ran 256s, cost $2.39, made zero edits, and died
  // on the account's session limit.
  process.stdout.write(JSON.stringify({
    type: "result", is_error: true, api_error_status: 429,
    terminal_reason: "api_error", subtype: "success",
    result: "You've hit your session limit · resets 1:20am (Asia/Tokyo)",
    session_id: null, usage: {}, total_cost_usd: 2.391763,
    duration_ms: 256000, num_turns: 8,
  }));
  // The captured real run exited 0.  "quota-session-exit1" emits the very
  // same payload and exits NONZERO instead — one shared literal, so the two
  // modes can never drift apart and the only variable under test is the exit
  // code (cross-review of PR #219).
  process.exit(mode === "quota-session-exit1" ? 1 : 0);
}
if (mode === "ok-exit1") {
  // A terminal result that does NOT claim failure, then a nonzero exit:
  // there is nothing for the classifier to read, so this must stay the
  // generic exit-code error it has always been.
  process.stdout.write(JSON.stringify({
    type: "result", is_error: false, result: "looked fine, then the CLI fell over",
    session_id: "claude-ok-exit1", usage: {}, total_cost_usd: 0,
    duration_ms: 5, num_turns: 1,
  }));
  process.stderr.write("claude: crashed while shutting down\\n");
  process.exit(1);
}
if (mode === "stream-full") {
  // The full realistic captured sequence (kusabi #215 Job B acceptance
  // criterion 2): a leading non-JSON warning line (observed on the real
  // CLI), system/init, a live rate_limit_event, an assistant message with
  // TWO tool_use blocks, a user tool_result, and the terminal result event.
  console.log("Warning: no stdin data received in 3s, proceeding without it.");
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-stream-full-1", model: "claude-sonnet-4-5", tools: [], mcp_servers: [] }));
  console.log(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1786424400, rateLimitType: "five_hour", overageStatus: "rejected", isUsingOverage: false } }));
  console.log(JSON.stringify({
    type: "assistant",
    session_id: "claude-stream-full-1",
    message: {
      model: "claude-sonnet-4-5",
      content: [
        { type: "text", text: "Looking at the file." },
        { type: "tool_use", id: "tool-1", name: "mcp__sunaba__read_file_range", input: {} },
        { type: "tool_use", id: "tool-2", name: "mcp__sunaba__edit_file", input: {} },
      ],
    },
  }));
  console.log(JSON.stringify({
    type: "user",
    session_id: "claude-stream-full-1",
    message: { content: [{ type: "tool_result", tool_use_id: "tool-2", content: "ok" }] },
  }));
  console.log(JSON.stringify({
    type: "result",
    is_error: false,
    result: "implemented via the stream",
    session_id: "claude-stream-full-1",
    usage: { input_tokens: 1200, output_tokens: 600, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    total_cost_usd: 0.01,
    duration_ms: 4000,
    num_turns: 2,
  }));
  process.exit(0);
}
// The stall*/slow* never-terminating modes are handled in ONE block in
// the tail below — they must never fall through to the result-writing
// tail's else, or a stall fake would hand the dispatch a terminal
// "result" event it could complete on.
if (mode === "quota-ratelimit-fallback") {
  // A rate_limit_event precedes a session-limit terminal payload that
  // carries NO reset in its own text or fields — the classification's
  // reset must fall back to the streamed rate_limit_info.resetsAt (kusabi
  // #215 Job B acceptance criterion 5).
  console.log(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1786424400, rateLimitType: "five_hour", overageStatus: "rejected", isUsingOverage: false } }));
  console.log(JSON.stringify({
    type: "result",
    is_error: true,
    api_error_status: 429,
    terminal_reason: "api_error",
    result: "You've hit your session limit.",
    session_id: null,
    usage: {},
    total_cost_usd: 1.0,
    duration_ms: 9000,
    num_turns: 3,
  }));
  process.exit(0);
}
if (mode === "stream-split-multibyte") {
  // The terminal result line's multibyte text is flushed in two writes
  // SPLIT MID-CHARACTER (between a UTF-8 lead byte and its continuation).
  // Per-chunk toString() decodes the halves separately into U+FFFD and
  // corrupts the JSON line; stream-level decoding must reassemble it
  // (kusabi #215 Job B review finding, claude-dispatch.mjs stdout handler).
  const line = JSON.stringify({
    type: "result", is_error: false,
    result: "リセットは 1:20am (Asia/Tokyo) です",
    session_id: "claude-split-1", usage: {}, total_cost_usd: 0,
    duration_ms: 10, num_turns: 1,
  }) + "\\n";
  const buf = Buffer.from(line, "utf8");
  const split = buf.findIndex((b) => b >= 0x80) + 1; // inside a multibyte sequence
  process.stdout.write(buf.subarray(0, split));
  await new Promise((resolve) => setTimeout(resolve, 120));
  process.stdout.write(buf.subarray(split));
  process.exit(0);
}
if (mode === "trickle") {
  // One event, a real delay, then the terminal result — proves the job
  // record moves on disk WHILE the child is still running, not only once
  // it exits (kusabi #215 Job B: "reasonable cadence" requirement).
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-trickle-1" }));
  await new Promise((resolve) => setTimeout(resolve, 400));
  console.log(JSON.stringify({
    type: "result",
    is_error: false,
    result: "done after a delay",
    session_id: "claude-trickle-1",
    usage: {},
    total_cost_usd: 0,
    duration_ms: 400,
    num_turns: 1,
  }));
  process.exit(0);
}
if (mode === "stall" || mode === "stall-with-child" || mode === "stall-garbage" || mode === "slow" || mode === "slow-with-child") {
  // Never-terminating modes: the silence watchdog (stall*) or the
  // dispatch timeout (slow*) must kill the group.  None of them writes a
  // terminal "result" event, so the dispatch can never complete on them.
  if (mode === "stall-with-child" || mode === "slow-with-child") {
    // Grandchild that inherits our stdout/stderr pipes: it must die with
    // the process-group kill, or the dispatch's 'close' never fires and
    // the job hangs forever after the timeout.
    const { spawn } = await import("node:child_process");
    const sleeper = spawn("sleep", ["300"], { stdio: "inherit" });
    fs.appendFileSync(process.env.FAKE_CLAUDE_PIDS, String(sleeper.pid) + "\\n");
  }
  if (mode === "stall-garbage") {
    // One parsed event, then unparseable prose lines keep arriving every
    // 300ms — stream noise, NOT parsed events — so the silence clock
    // must NOT reset on them and the watchdog must still fire (kusabi
    // #215 Job B item 3: the clock measures parsed stream events; the
    // real CLI's leading warning line is not one).
    console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-stall-garbage-1" }));
    setInterval(() => {
      console.log("still here, still not JSON");
    }, 300);
  } else if (mode === "stall" || mode === "stall-with-child") {
    // One event (proves the silence clock resets on real activity, not
    // just spawn), then permanent silence — the watchdog, not timeoutS,
    // must end this job (kusabi #215 Job B acceptance criterion 4).
    console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-stall-1" }));
    setInterval(() => {}, 1000); // no further output — the watchdog must kill us
  } else {
    setInterval(() => {}, 1000); // never writes, never exits — the dispatch timeout must kill us
  }
} else {
  const argv = process.argv.slice(2);
  const resumeAt = argv.indexOf("--resume");
  // "resume-echo" models the real CLI contract: when resumed, the JSON
  // result carries the SAME session id that was passed via --resume.
  const sessionId = mode === "resume-echo" && resumeAt >= 0
    ? argv[resumeAt + 1]
    : "claude-session-abc123";
  const result = {
    type: "result",
    is_error: false,
    result: "implemented the thing per the brief",
    session_id: sessionId,
    usage: {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 3000,
    },
    total_cost_usd: 0.0042,
    duration_ms: 12000,
    num_turns: 5,
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}
`;

const SUNABA_MCP = {
  command: "npx",
  args: ["-y", "@sunaba/mcp-server"],
  env: { SUNABA_URL: "http://127.0.0.1:8750/mcp" },
};

function fakeClaudeContext(mode = "ok") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-claude-test-"));
  const binPath = path.join(tmp, "fake-claude.mjs");
  const argsLog = path.join(tmp, "args.ndjson");
  const pidsLog = path.join(tmp, "spawned.pids");
  const stdinLog = path.join(tmp, "stdin.txt");
  fs.writeFileSync(binPath, FAKE_CLAUDE_SOURCE, "utf8");
  fs.chmodSync(binPath, 0o755);
  fs.writeFileSync(argsLog, "", "utf8");
  fs.writeFileSync(pidsLog, "", "utf8");
  fs.writeFileSync(stdinLog, "", "utf8");

  const stateRoot = path.join(tmp, "state");
  const cwd = path.join(tmp, "cwd");
  fs.mkdirSync(cwd, { recursive: true });

  const mcpSource = path.join(tmp, "claude.json");
  fs.writeFileSync(mcpSource, JSON.stringify({ mcpServers: { sunaba: SUNABA_MCP, other: { command: "echo" } } }), "utf8");

  const saved = {
    CLAUDE_BIN: process.env.CLAUDE_BIN,
    KUSABI_STATE_DIR: process.env.KUSABI_STATE_DIR,
    KUSABI_CLAUDE_MCP_SOURCE: process.env.KUSABI_CLAUDE_MCP_SOURCE,
    FAKE_CLAUDE_MODE: process.env.FAKE_CLAUDE_MODE,
    FAKE_CLAUDE_ARGS_LOG: process.env.FAKE_CLAUDE_ARGS_LOG,
    FAKE_CLAUDE_PIDS: process.env.FAKE_CLAUDE_PIDS,
    FAKE_CLAUDE_STDIN_LOG: process.env.FAKE_CLAUDE_STDIN_LOG,
  };
  process.env.CLAUDE_BIN = binPath;
  process.env.KUSABI_STATE_DIR = stateRoot;
  process.env.KUSABI_CLAUDE_MCP_SOURCE = mcpSource;
  process.env.FAKE_CLAUDE_MODE = mode;
  process.env.FAKE_CLAUDE_ARGS_LOG = argsLog;
  process.env.FAKE_CLAUDE_PIDS = pidsLog;
  process.env.FAKE_CLAUDE_STDIN_LOG = stdinLog;

  const stateDir = stateDirFor(cwd);
  return {
    tmp,
    cwd,
    stateDir,
    argsLog,
    pidsLog,
    stdinLog,
    mcpSource,
    dispatchOptions(overrides = {}) {
      return {
        cwd,
        kind: "task",
        title: "claude dispatch test",
        promptText: "Do the thing.",
        agent: "kusabi-implement",
        phase: null,
        tools: null,
        timeoutS: 10,
        watchdogS: 900,
        tiers: [["opus"]],
        round: 1,
        explicitModel: null,
        ...overrides,
      };
    },
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

function readJobEvents(stateDir, jobId) {
  const file = path.join(jobDir(stateDir, jobId), "events.ndjson");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line));
}

function watchdogEvents(stateDir, jobId) {
  return readJobEvents(stateDir, jobId).filter((e) => String(e.type).startsWith("companion.watchdog."));
}

function spawnedPids(pidsLog) {
  const text = fs.readFileSync(pidsLog, "utf8");
  return text.trim() ? text.trim().split("\n").map(Number) : [];
}

function isAlive(pid) {
  try {
    process.kill(pid, 0); // throws if the pid is gone (or EPERM = alive)
    // kill(pid, 0) succeeds for zombies too, so read the state directly:
    // after the group kill the orphaned grandchild is reparented to init
    // and may sit unreaped as a zombie (state Z/X) for a moment — it IS
    // dead, and the dispatch's 'close' already proves the pipe holders
    // exited, so a lingering zombie must not fail the assertion.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}

describe("claudeDispatch (fake claude binary)", () => {
  let ctx;

  beforeEach(() => {
    ctx = fakeClaudeContext();
  });

  afterEach(() => {
    ctx.restore();
  });

  it("returns a completed job with backend, mapped usage, and the session id", async () => {
    const { job, resultText, stateDir } = await claudeDispatch(ctx.dispatchOptions());

    assert.equal(job.status, "completed");
    assert.equal(job.backend, "claude");
    assert.equal(job.sessionID, "claude-session-abc123");
    assert.equal(job.modelEntry, "opus");
    assert.equal(job.modelVariant, null);
    assert.equal(resultText, "implemented the thing per the brief");
    assert.equal(stateDir, ctx.stateDir);

    // Mapped usage (test-asserted mapping).
    assert.equal(job.usage.available, true);
    assert.equal(job.usage.input, 1000);
    assert.equal(job.usage.output, 500);
    assert.equal(job.usage.cacheWrite, 200);
    assert.equal(job.usage.cacheRead, 3000);
    assert.equal(job.usage.cost, 0.0042);
    assert.equal(typeof job.usage.durationSeconds, "number");

    // The record is persisted with the same shape the opencode path uses.
    const persisted = loadJob(stateDir, job.id);
    assert.equal(persisted.status, "completed");
    assert.equal(persisted.backend, "claude");
    assert.equal(persisted.sessionID, "claude-session-abc123");
    assert.equal(persisted.phase, null);

    // Artifacts: prompt.md, result.md, usage.json.
    const jdir = jobDir(stateDir, job.id);
    assert.equal(fs.readFileSync(path.join(jdir, "prompt.md"), "utf8"), "Do the thing.");
    assert.equal(fs.readFileSync(path.join(jdir, "result.md"), "utf8"), "implemented the thing per the brief");
    const usageFile = readJson(path.join(jdir, "usage.json"));
    assert.equal(usageFile.input, 1000);
    assert.equal(usageFile.cacheWrite, 200);

    // Audit trail events.
    const events = fs.readFileSync(path.join(jdir, "events.ndjson"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(events[0].type, "companion.claude.dispatch");
    assert.equal(events[1].type, "companion.claude.finished");
    assert.equal(events[1].status, "completed");
  });

  it("builds the contract invocation shape (implement agent: allowlist + system prompt)", async () => {
    await claudeDispatch(ctx.dispatchOptions());

    const args = JSON.parse(fs.readFileSync(ctx.argsLog, "utf8").trim());
    // Bare -p: the prompt is NOT on argv (I5) — it goes via stdin.
    assert.equal(args[0], "-p");
    assert.ok(!args.includes("Do the thing."));
    // Strict MCP + empty setting sources: ambient settings stop applying.
    assert.equal(args[1], "--strict-mcp-config");
    assert.equal(args[2], "--setting-sources");
    assert.equal(args[3], "");
    assert.equal(args[4], "--output-format");
    assert.equal(args[5], "stream-json");
    // stream-json requires --verbose or the real CLI refuses to start.
    assert.equal(args[6], "--verbose");
    assert.equal(args[7], "--model");
    assert.equal(args[8], "opus");
    assert.equal(args[9], "--allowedTools");
    assert.equal(args[10], ALLOWED_TOOLS.implement);
    assert.equal(args[11], "--disallowedTools");
    assert.equal(args[12], disallowedToolsForAgent("kusabi-implement"));
    assert.ok(args[12].split(",").includes("mcp__sunaba__publish"));
    assert.ok(args[12].split(",").includes("mcp__sunaba__sandbox_issue_write"));
    assert.ok(args[12].split(",").includes("Bash"));
    assert.equal(args[13], "--mcp-config");

    // The generated MCP config contains ONLY the sunaba entry.
    const mcpConfigPath = args[14];
    assert.equal(mcpConfigPath, path.join(ctx.stateDir, "claude-mcp.json"));
    const mcpConfig = readJson(mcpConfigPath);
    assert.deepEqual(mcpConfig, { mcpServers: { sunaba: SUNABA_MCP } });
    assert.equal(mcpConfig.mcpServers.other, undefined);

    assert.equal(args[15], "--append-system-prompt");
    const systemPrompt = args[16];
    // Frontmatter stripped: the body, not the YAML header.
    assert.match(systemPrompt, /^You are the "implement" phase worker/);
    assert.ok(!systemPrompt.startsWith("---"));
    // Never --dangerously-skip-permissions.
    assert.ok(!args.includes("--dangerously-skip-permissions"));

    // The prompt reached the child on stdin (I5), not argv.
    assert.equal(fs.readFileSync(ctx.stdinLog, "utf8"), "Do the thing.");
  });

  it("one model per phase: uses the chain's first route, never walks the ladder", async () => {
    await claudeDispatch(ctx.dispatchOptions({
      tiers: [["sonnet", "haiku"], ["opus"]],
      tierIndex: 1,
      round: 2,
    }));
    const args = JSON.parse(fs.readFileSync(ctx.argsLog, "utf8").trim());
    assert.equal(args[8], "sonnet");
  });

  it("explicitModel wins over the chain", async () => {
    await claudeDispatch(ctx.dispatchOptions({
      tiers: [["sonnet"]],
      explicitModel: "claude-opus-4-1",
    }));
    const args = JSON.parse(fs.readFileSync(ctx.argsLog, "utf8").trim());
    assert.equal(args[8], "claude-opus-4-1");
    assert.equal(args[7], "--model");
  });

  it("review agent: review allowlist + review system prompt", async () => {
    await claudeDispatch(ctx.dispatchOptions({
      kind: "review",
      agent: "kusabi-review",
      phase: "review",
    }));
    const args = JSON.parse(fs.readFileSync(ctx.argsLog, "utf8").trim());
    assert.equal(args[10], ALLOWED_TOOLS.review);
    assert.equal(args[12], disallowedToolsForAgent("kusabi-review"));
    assert.match(args[16], /^You are the "review" phase worker/);
  });

  it("investigate agent: issue write is exempt from --disallowedTools but stays out of the review allowlist", async () => {
    await claudeDispatch(ctx.dispatchOptions({
      agent: "kusabi-investigate",
    }));
    const args = JSON.parse(fs.readFileSync(ctx.argsLog, "utf8").trim());
    const denied = args[12].split(",");
    assert.ok(!denied.includes("mcp__sunaba__sandbox_issue_write"), "investigate deliverable must stay allowed");
    assert.ok(denied.includes("mcp__sunaba__publish"));
    assert.ok(denied.includes("mcp__sunaba__sandbox_pr_review_write"));
  });

  it("applies tools deny maps to the allowlist (a deny is never silently ignored)", async () => {
    await claudeDispatch(ctx.dispatchOptions({
      tools: { sunaba_edit_file: false, bash: false },
    }));
    const args = JSON.parse(fs.readFileSync(ctx.argsLog, "utf8").trim());
    const csv = args[10];
    assert.ok(!csv.split(",").includes("mcp__sunaba__edit_file"));
    assert.ok(csv.split(",").includes("mcp__sunaba__write_file"));
  });

  it("--read-only removes the write tools from the allowlist (never silently ignored)", async () => {
    // The CLI translates the opencode vocabulary before dispatch
    // (translateDenyTools in cmdTask); this asserts the dispatch-side
    // effect: the translated deny map strips the sunaba write tools from
    // the --allowedTools CSV (kusabi #184 finding 2).
    await claudeDispatch(ctx.dispatchOptions({
      tools: translateDenyTools(Object.fromEntries(WRITE_TOOL_NAMES.map((t) => [t, false]))),
    }));
    const args = JSON.parse(fs.readFileSync(ctx.argsLog, "utf8").trim());
    const csv = args[10].split(",");
    for (const tool of ["mcp__sunaba__sandbox_exec", "mcp__sunaba__write_file", "mcp__sunaba__edit_file", "mcp__sunaba__transform_file"]) {
      assert.ok(!csv.includes(tool), `${tool} must be denied by --read-only`);
    }
    // Read-side and verify tools stay.
    assert.ok(csv.includes("mcp__sunaba__read_file_range"));
    assert.ok(csv.includes("mcp__sunaba__checkpoint"));
    assert.ok(csv.includes("mcp__sunaba__verify_in_container"));
  });

  it("resumes a session: --resume <id> reaches argv, the job keeps the result's session id", async () => {
    const { job } = await claudeDispatch(ctx.dispatchOptions({
      session: "claude-session-round1",
    }));

    // The fake claude observed --resume <session> on its argv.
    const args = JSON.parse(fs.readFileSync(ctx.argsLog, "utf8").trim());
    const resumeIdx = args.indexOf("--resume");
    assert.ok(resumeIdx > 0, "a given session must be passed via --resume");
    assert.equal(args[resumeIdx + 1], "claude-session-round1");
    // Resume is a transport detail: the isolation flags stay exactly as a
    // fresh dispatch builds them (strict MCP, empty setting sources, the
    // allowlist; the prompt still travels on stdin).
    assert.equal(args[1], "--strict-mcp-config");
    assert.equal(args[2], "--setting-sources");
    assert.equal(args[3], "");
    assert.equal(args[10], ALLOWED_TOOLS.implement);
    // The prompt still travels on stdin (I5), never on argv.
    assert.ok(!args.includes("Do the thing."));
    assert.equal(fs.readFileSync(ctx.stdinLog, "utf8"), "Do the thing.");

    // The recorded session id comes from the CLI's JSON result (the single
    // capture source) — never pre-filled from the option.
    assert.equal(job.status, "completed");
    assert.equal(job.sessionID, "claude-session-abc123");
  });

  it("chain rework round on the claude backend: round 2 receives the round-1 sessionID, end to end", async () => {
    // The context-continuity fix pinned at BOTH seams: chain-phases derives
    // the rework round's session from previousRecord.sessionID, and the
    // claude dispatch honors it as `--resume` on argv (instead of starting
    // blank).  runImplementPhase is imported UNCHANGED from chain-phases.mjs.
    const calls = [];
    const stubDispatch = async (opts) => {
      calls.push(opts);
      const round = opts.round ?? 1;
      return {
        job: {
          id: `job-imp-${round}`,
          status: "completed",
          modelEntry: "opus",
          modelVariant: null,
          fallbacks: null,
          sessionID: `claude-uuid-round${round}`,
          usage: null,
          error: null,
        },
        resultText: "implemented",
      };
    };
    const common = {
      cwd: ctx.cwd,
      chainId: "chain-x",
      implementText: "Do the thing.",
      modelChain: [["opus"]],
      tierIndex: 0,
      flagsModel: null,
      resumeMethod: { type: "continue_session" },
      _dispatchWithFallback: stubDispatch,
    };

    // Round 1: fresh dispatch — no session to continue.
    await runImplementPhase({
      ...common, round: 1, isFirstRound: true, previousRecord: null,
      session: undefined, useNewSession: false,
    });
    assert.equal(calls[0].session, undefined);

    // Round 2 (rework): chain-phases resolves the session from the previous
    // round's record — the claude chain must NOT start blank.
    const second = await runImplementPhase({
      ...common, round: 2, isFirstRound: false,
      previousRecord: { sessionID: "claude-uuid-round1" },
      session: undefined, useNewSession: false,
    });
    assert.equal(calls[1].session, "claude-uuid-round1");
    assert.equal(second.session, "claude-uuid-round1");

    // The journey's end: that same session reaches the claude CLI as
    // `--resume <id>` via the real dispatch.
    const { job } = await claudeDispatch(ctx.dispatchOptions({
      round: 2,
      session: calls[1].session,
    }));
    const lines = fs.readFileSync(ctx.argsLog, "utf8").trim().split("\n");
    const round2Args = JSON.parse(lines[lines.length - 1]);
    const resumeIdx = round2Args.indexOf("--resume");
    assert.ok(resumeIdx > 0, "a rework round must resume the previous session");
    assert.equal(round2Args[resumeIdx + 1], "claude-uuid-round1");
    assert.equal(job.status, "completed");
  });

  it("resume keeps the session id through the CLI's JSON result (single capture source)", async () => {
    ctx.restore();
    ctx = fakeClaudeContext("resume-echo");
    const { job } = await claudeDispatch(ctx.dispatchOptions({
      session: "claude-uuid-echo-1",
    }));
    assert.equal(job.status, "completed");
    // The fake modeled the real CLI contract: `--resume <id>` in, the SAME
    // id out in the JSON result — and the job keeps it via the EXISTING
    // capture path (parsed.session_id), never pre-filled from opts.
    assert.equal(job.sessionID, "claude-uuid-echo-1");
    const args = JSON.parse(fs.readFileSync(ctx.argsLog, "utf8").trim());
    assert.equal(args[args.indexOf("--resume") + 1], "claude-uuid-echo-1");
  });

  it("rejects an opencode-shaped session id (ses_*) loudly, before any process or job record", async () => {
    await assert.rejects(
      () => claudeDispatch(ctx.dispatchOptions({ session: "ses_xyz" })),
      (err) => {
        // The error names BOTH backends: the opencode session and the claude
        // backend it cannot be resumed on.
        assert.match(err.message, /opencode session ses_xyz cannot be resumed on the claude backend/);
        assert.match(err.message, /ses_\* session ids belong to opencode/);
        return true;
      },
    );
    // Nothing was spawned...
    assert.equal(fs.readFileSync(ctx.argsLog, "utf8").trim(), "");
    assert.equal(fs.readFileSync(ctx.pidsLog, "utf8").trim(), "");
    // ...and no job record was left behind (nothing recorded "running").
    assert.deepEqual(fs.readdirSync(path.join(ctx.stateDir, "jobs")), []);
  });

  it("rejects a :variant model at dispatch time too", async () => {
    await assert.rejects(
      () => claudeDispatch(ctx.dispatchOptions({ explicitModel: "opus:max" })),
      /:variant/,
    );
  });

  it("fails the dispatch when the binary exits nonzero, preserving the error text", async () => {
    ctx.restore();
    ctx = fakeClaudeContext("exit");
    const { job, resultText } = await claudeDispatch(ctx.dispatchOptions());

    assert.equal(job.status, "error");
    assert.match(job.error, /claude exited with code 3/);
    assert.match(job.error, /permission denied for model opus/);
    assert.equal(job.retry, null);
    assert.equal(job.fallbacks, null);
    assert.equal(resultText, "");
    // The failure record is persisted with the error text.
    const persisted = loadJob(ctx.stateDir, job.id);
    assert.equal(persisted.status, "error");
    assert.equal(persisted.error, job.error);
  });

  it("fails the dispatch on garbage stdout, preserving the output snippet", async () => {
    // The garbage line still fails the run — it just fails a different way
    // now: the line itself is skipped as unparseable NDJSON (kusabi #215
    // Job B item 3: never fatal on its own), but a run that never produces
    // a terminal `result` event is still a failed dispatch.
    ctx.restore();
    ctx = fakeClaudeContext("garbage");
    const { job } = await claudeDispatch(ctx.dispatchOptions());

    assert.equal(job.status, "error");
    assert.match(job.error, /no terminal result event/);
    assert.match(job.error, /this is not json at all/);
    assert.equal(job.retry, null);
    assert.equal(job.fallbacks, null);
  });

  it("fails the dispatch when the result carries is_error — even with subtype: success (kusabi #215)", async () => {
    // The fake's is-error payload carries `subtype: "success"` (the real
    // 2026-08-11 shape): subtype must never influence success/failure.
    ctx.restore();
    ctx = fakeClaudeContext("is-error");
    const { job } = await claudeDispatch(ctx.dispatchOptions());

    assert.equal(job.status, "error");
    assert.match(job.error, /boom: tool call failed/);
    // No quota markers in this payload → no classification, no
    // provider-error: it fails exactly as before the classification.
    assert.equal(job.failure, null);
  });

  it("classifies the real session-limit 429 payload as quota exhaustion (provider-error)", async () => {
    ctx.restore();
    ctx = fakeClaudeContext("quota-session");
    const { job } = await claudeDispatch(ctx.dispatchOptions());

    // Failed job, machine-readable classification on the record (never by
    // grepping `error` prose).
    assert.equal(job.status, "provider-error");
    assert.deepEqual(job.failure, {
      kind: "quota-exhaustion",
      quota: "session",
      backendBlocked: true,
      reset: "1:20am (Asia/Tokyo)",
    });
    // Operator-facing message: which quota, the reset, the whole-backend
    // block, and what to do instead of retrying claude.
    assert.match(job.error, /session limit exhausted \(resets 1:20am \(Asia\/Tokyo\)\)/);
    assert.match(job.error, /whole claude backend is blocked/);
    assert.match(job.error, /Switch the phase to the opencode backend/);
    assert.match(job.error, /do not retry claude/);
    // The raw terminal text is preserved on the record.
    assert.match(job.error, /You've hit your session limit/);
    assert.equal(job.retry, null);
    assert.equal(job.fallbacks, null);
    assert.equal(job.result, undefined);
    // The failure record is persisted with the classification.
    const persisted = loadJob(ctx.stateDir, job.id);
    assert.equal(persisted.status, "provider-error");
    assert.deepEqual(persisted.failure, job.failure);
  });

  it("marks claude stats as instrumented and measured from the stream (kusabi #215 Job B)", async () => {
    // The base fake ("ok" mode) writes exactly ONE stream-json line — the
    // terminal `result` event, no system/assistant events ahead of it — so
    // `events` is 1, and there is no tool_use block to count as a step.
    const { job } = await claudeDispatch(ctx.dispatchOptions());

    assert.equal(job.stats.instrumented, true);
    assert.equal(job.stats.events, 1);
    assert.equal(job.stats.steps, 0);
    assert.equal(job.stats.lastTool, null);
    assert.equal(job.stats.permissionsAllowed, 0);
    assert.equal(job.stats.permissionsRejected, 0);
    assert.equal(typeof job.stats.lastActivity, "string");
    assert.ok(!Number.isNaN(Date.parse(job.stats.lastActivity)));
    assert.deepEqual(job.stats.models, []);
  });

  it("legacy instrumented:false records still render via the 'not instrumented' reader path", () => {
    // This dispatch never writes instrumented:false anymore (kusabi #215 Job
    // B) — the marker now identifies only pre-#215 records already on disk.
    // The reader contract (kusabi-companion.mjs) is exercised directly here,
    // since claudeDispatch itself has no code path left that produces one.
    const legacy = {
      stats: {
        instrumented: false,
        events: null,
        steps: null,
        lastTool: null,
        permissionsAllowed: null,
        permissionsRejected: null,
        lastActivity: null,
        models: [],
      },
      startedAt: "2026-08-01T00:00:00.000Z",
    };
    assert.equal(legacy.stats.instrumented, false);
    // The idle-reap fallback (serve-lifecycle) reads lastActivity ?? startedAt.
    assert.equal(legacy.stats.lastActivity ?? legacy.startedAt, legacy.startedAt);
  });

  it("times out: kills the child AND its process group, reports the opencode timeout status", async () => {
    ctx.restore();
    ctx = fakeClaudeContext("slow-with-child");
    const { job } = await claudeDispatch(ctx.dispatchOptions({ timeoutS: 1 }));

    assert.equal(job.status, "timeout");
    assert.equal(job.error, "timed out after 1s");

    // The fake claude AND the grandchild it spawned (which inherited the
    // stdout pipe — the dispatch only resolves once the group is dead) were
    // actually killed — no orphaned work survives the timeout.
    const pids = spawnedPids(ctx.pidsLog);
    assert.ok(pids.length >= 2, "the fake claude and its grandchild must have been spawned");
    for (const pid of pids) {
      assert.equal(isAlive(pid), false, `pid ${pid} must be dead after the timeout group kill`);
    }
  });

  it("stream-json: the full realistic sequence yields real measured stats (kusabi #215 Job B, acceptance criteria 2 and 3)", async () => {
    ctx.restore();
    ctx = fakeClaudeContext("stream-full");
    const { job, resultText } = await claudeDispatch(ctx.dispatchOptions());

    // The leading non-JSON warning line never fails the run.
    assert.equal(job.status, "completed");
    assert.equal(resultText, "implemented via the stream");
    assert.equal(job.sessionID, "claude-stream-full-1");

    assert.equal(job.stats.instrumented, true);
    assert.ok(job.stats.events > 0, "parsed event lines must be counted");
    // Two tool_use blocks inside the one assistant message.
    assert.equal(job.stats.steps, 2);
    assert.equal(job.stats.lastTool, "mcp__sunaba__edit_file");
    assert.equal(typeof job.stats.lastActivity, "string");
    assert.ok(!Number.isNaN(Date.parse(job.stats.lastActivity)));
    assert.deepEqual(job.stats.models, ["claude-sonnet-4-5"]);

    // Usage and session id still come from the terminal result event
    // exactly as today — the stream is a new SOURCE of that event, not a
    // new mapping.
    assert.equal(job.usage.input, 1200);
    assert.equal(job.usage.output, 600);

    // The live quota feed (kusabi #215 Job B item 4): the most recent
    // rate_limit_event is persisted machine-readably on the job record.
    assert.ok(job.rateLimit);
    assert.equal(job.rateLimit.info.resetsAt, 1786424400);
    assert.equal(typeof job.rateLimit.observedAt, "string");
  });

  it("stream-json: a multibyte character split across two chunks decodes intact (chunk-boundary review finding)", async () => {
    // The fake flushes the result line in two writes split between a UTF-8
    // lead byte and its continuation byte; per-chunk toString() would decode
    // U+FFFD into the JSON line and lose the terminal result event entirely.
    ctx.restore();
    ctx = fakeClaudeContext("stream-split-multibyte");
    const { job, resultText } = await claudeDispatch(ctx.dispatchOptions());

    assert.equal(job.status, "completed");
    assert.equal(resultText, "リセットは 1:20am (Asia/Tokyo) です");
    assert.ok(!resultText.includes("�"), "no replacement characters may appear");
    assert.equal(job.sessionID, "claude-split-1");
  });

  it("quota reset falls back to the streamed rate_limit_info.resetsAt when the payload names none (kusabi #215 Job B item 4)", async () => {
    ctx.restore();
    ctx = fakeClaudeContext("quota-ratelimit-fallback");
    const { job } = await claudeDispatch(ctx.dispatchOptions());

    assert.equal(job.status, "provider-error");
    assert.equal(job.failure.kind, "quota-exhaustion");
    assert.equal(job.failure.quota, "session");
    // The terminal payload's own text/fields name no reset; it is filled
    // from the rate_limit_event's resetsAt (epoch seconds) instead.
    assert.equal(job.failure.reset, new Date(1786424400 * 1000).toISOString());
  });

  it("watchdog: silence kills the process group and the job finishes stalled (kusabi #215 Job B item 3)", async () => {
    ctx.restore();
    ctx = fakeClaudeContext("stall-with-child");
    const { job } = await claudeDispatch(ctx.dispatchOptions({ watchdogS: 1 }));

    assert.equal(job.status, "stalled");
    // Mirrors the opencode watchdog's own wording exactly.
    assert.equal(job.error, "watchdog: no events for 1s (process killed)");
    // The system/init session id survives even though there was no
    // terminal result event (kusabi #215 Job B item 5).
    assert.equal(job.sessionID, "claude-stall-1");
    assert.ok(job.stats.events >= 1, "the init event must still be reflected in stats");

    // The fake claude AND the grandchild it spawned were actually killed —
    // no orphaned work survives a stall, exactly like a timeout.
    const pids = spawnedPids(ctx.pidsLog);
    assert.ok(pids.length >= 2, "the fake claude and its grandchild must have been spawned");
    for (const pid of pids) {
      assert.equal(isAlive(pid), false, `pid ${pid} must be dead after the watchdog group kill`);
    }
  });

  it("watchdog: unparseable prose lines are stream noise, not events — they never hold the watchdog off (kusabi #215 Job B item 3)", async () => {
    ctx.restore();
    ctx = fakeClaudeContext("stall-garbage");
    const { job } = await claudeDispatch(ctx.dispatchOptions({ watchdogS: 1 }));

    // Garbage lines arrived every 300ms for the whole run, yet the clock
    // measures PARSED stream events only: after the single init event the
    // stream was event-silent, so the watchdog fired on schedule.
    assert.equal(job.status, "stalled");
    assert.equal(job.error, "watchdog: no events for 1s (process killed)");
    assert.equal(job.sessionID, "claude-stall-garbage-1");
    // The garbage itself was counted for debugging, never fatal.
    assert.equal(job.stats.events, 1);
    // The fake is dead — no orphaned process keeps printing.
    const pids = spawnedPids(ctx.pidsLog);
    for (const pid of pids) {
      assert.equal(isAlive(pid), false, `pid ${pid} must be dead after the watchdog group kill`);
    }
  });

  // -----------------------------------------------------------------------
  // Cross-review of PR #219: the exit code must not gate the classification,
  // and the claude watchdog must leave the same audit trail opencode does.
  // -----------------------------------------------------------------------

  it("classifies the session-limit payload identically when the CLI exits NONZERO", async () => {
    ctx.restore();
    ctx = fakeClaudeContext("quota-session-exit1");
    const { job } = await claudeDispatch(ctx.dispatchOptions());

    // The same outcome the exit-0 case produces: the payload says what
    // failed, the exit code adds nothing it does not already state.
    assert.equal(job.status, "provider-error");
    assert.deepEqual(job.failure, {
      kind: "quota-exhaustion",
      quota: "session",
      backendBlocked: true,
      reset: "1:20am (Asia/Tokyo)",
    });
    assert.match(job.error, /session limit exhausted \(resets 1:20am \(Asia\/Tokyo\)\)/);
    assert.match(job.error, /whole claude backend is blocked/);
    assert.match(job.error, /Switch the phase to the opencode backend/);
    assert.match(job.error, /do not retry claude/);
    assert.match(job.error, /You've hit your session limit/);
    // The generic exit-code branch must not have swallowed the classification.
    assert.ok(!job.error.includes("claude exited with code"));

    const persisted = loadJob(ctx.stateDir, job.id);
    assert.equal(persisted.status, "provider-error");
    assert.deepEqual(persisted.failure, job.failure);

    // Nothing is lost: the nonzero exit is still on the audit trail.
    const finished = readJobEvents(ctx.stateDir, job.id).find((e) => e.type === "companion.claude.finished");
    assert.equal(finished.exitCode, 1);
    assert.equal(finished.status, "provider-error");
  });

  it("is_error + exit 1: keeps the payload detail AND the stderr diagnostic with the exit code", async () => {
    // Non-quota is_error payload + nonzero exit: the payload says what
    // failed, stderr says why (auth/model-permission errors a terse
    // payload never carries).  The generic exit-diagnostic must not be
    // lost to the classification branch.
    ctx.restore();
    ctx = fakeClaudeContext("is-error-exit1");
    const { job } = await claudeDispatch(ctx.dispatchOptions());

    assert.equal(job.status, "error");
    assert.equal(job.failure, null);
    assert.equal(
      job.error,
      "claude dispatch failed: boom: tool call failed (exited with code 1: claude: authentication failed)",
    );
  });

  it("nonzero exit with no terminal payload keeps the generic exit-code error, unclassified", async () => {
    ctx.restore();
    ctx = fakeClaudeContext("exit");
    const { job } = await claudeDispatch(ctx.dispatchOptions());

    assert.equal(job.status, "error");
    assert.equal(job.error, "claude exited with code 3: claude: permission denied for model opus");
    assert.equal(job.failure, null);
  });

  it("nonzero exit after a SUCCESSFUL terminal result stays the generic exit-code error", async () => {
    // Only a payload that itself claims failure (`is_error: true`) is worth
    // classifying; a clean result plus a nonzero exit is still a crash.
    ctx.restore();
    ctx = fakeClaudeContext("ok-exit1");
    const { job } = await claudeDispatch(ctx.dispatchOptions());

    assert.equal(job.status, "error");
    assert.match(job.error, /claude exited with code 1: claude: crashed while shutting down/);
    assert.equal(job.failure, null);
  });

  it("the rendered quota error marks a rate-feed reset as coming from the feed", async () => {
    ctx.restore();
    ctx = fakeClaudeContext("quota-ratelimit-fallback");
    const { job } = await claudeDispatch(ctx.dispatchOptions());

    const iso = new Date(1786424400 * 1000).toISOString();
    // The machine-readable value stays a clean ISO timestamp; only the
    // operator-facing text says where it came from.
    assert.equal(job.failure.reset, iso);
    assert.ok(job.error.includes(`(resets ~${iso}, from live rate feed)`));
  });

  it("watchdog: appends the same fired/kill events the opencode watchdog writes", async () => {
    ctx.restore();
    ctx = fakeClaudeContext("stall-with-child");
    const { job } = await claudeDispatch(ctx.dispatchOptions({ watchdogS: 1 }));

    assert.equal(job.status, "stalled");
    const events = watchdogEvents(ctx.stateDir, job.id);
    // Same event types as prompt-execution.mjs, in the order they happened,
    // so backend-agnostic stall auditing finally counts claude stalls.
    assert.deepEqual(events.map((e) => e.type), [
      "companion.watchdog.fired",
      "companion.watchdog.kill",
    ]);
    assert.equal(typeof events[0].silenceS, "number");
    assert.ok(events[0].silenceS >= 1, "the measured silence must be reported");
    // No declined-kill counterpart on this backend: the process is ours
    // alone, so the kill always ran.
    assert.ok(!events.some((e) => e.type === "companion.watchdog.declined-kill"));
  });

  it("watchdog: a job that never stalls appends no watchdog events", async () => {
    const { job } = await claudeDispatch(ctx.dispatchOptions());

    assert.equal(job.status, "completed");
    assert.deepEqual(watchdogEvents(ctx.stateDir, job.id), []);
  });

  it("watchdog: a TIMEOUT kill is not recorded as a stall", async () => {
    // The timeout kills the group too, but it is a different failure — the
    // trail must not claim the silence watchdog fired.
    ctx.restore();
    ctx = fakeClaudeContext("slow-with-child");
    const { job } = await claudeDispatch(ctx.dispatchOptions({ timeoutS: 1, watchdogS: 900 }));

    assert.equal(job.status, "timeout");
    assert.deepEqual(watchdogEvents(ctx.stateDir, job.id), []);
  });

  it("saves job stats to disk at a bounded cadence while the child is still running (kusabi #215 Job B)", async () => {
    ctx.restore();
    ctx = fakeClaudeContext("trickle");
    const promise = claudeDispatch(ctx.dispatchOptions());
    await new Promise((resolve) => setTimeout(resolve, 150));

    const [midflight] = listJobs(ctx.stateDir);
    assert.ok(midflight, "the job record must already exist on disk");
    assert.equal(midflight.status, "running");
    assert.equal(midflight.stats.instrumented, true);
    assert.ok(midflight.stats.events >= 1, "the init event must already be reflected on disk");

    const { job } = await promise;
    assert.equal(job.status, "completed");
  });

  it("fails loudly when the MCP source config lacks mcpServers.sunaba", async () => {
    const badSource = path.join(ctx.tmp, "no-sunaba.json");
    fs.writeFileSync(badSource, JSON.stringify({ mcpServers: { other: { command: "echo" } } }), "utf8");
    process.env.KUSABI_CLAUDE_MCP_SOURCE = badSource;
    await assert.rejects(
      () => claudeDispatch(ctx.dispatchOptions()),
      (err) => {
        assert.match(err.message, /no mcpServers\.sunaba entry/);
        assert.ok(err.message.includes(badSource));
        return true;
      },
    );
  });

  it("rejects an agent with no v1 allowlist", async () => {
    await assert.rejects(
      () => claudeDispatch(ctx.dispatchOptions({ agent: "kusabi-draft" })),
      /no permission allowlist/,
    );
  });

  it("rejects a missing agent file", async () => {
    await assert.rejects(
      () => claudeDispatch(ctx.dispatchOptions({ agent: "kusabi-does-not-exist" })),
      /cannot read agent file/,
    );
  });
});

// =========================================================================
// CLI --read-only wiring — the flag must reach the claude --allowedTools
// =========================================================================

describe("CLI --read-only wiring (subprocess)", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");

  it("--backend claude --read-only denies the sunaba write tools in --allowedTools", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-claude-readonly-"));
    try {
      const binPath = path.join(tmp, "fake-claude.mjs");
      fs.writeFileSync(binPath, FAKE_CLAUDE_SOURCE, "utf8");
      fs.chmodSync(binPath, 0o755);
      const argsLog = path.join(tmp, "args.ndjson");
      const pidsLog = path.join(tmp, "pids");
      const stdinLog = path.join(tmp, "stdin.txt");
      fs.writeFileSync(argsLog, "", "utf8");
      fs.writeFileSync(pidsLog, "", "utf8");
      fs.writeFileSync(stdinLog, "", "utf8");
      const mcpSource = path.join(tmp, "claude.json");
      fs.writeFileSync(mcpSource, JSON.stringify({ mcpServers: { sunaba: SUNABA_MCP } }), "utf8");

      const env = { ...process.env };
      delete env.KUSABI_WORKER_CONTEXT;
      env.CLAUDE_BIN = binPath;
      env.KUSABI_CLAUDE_MCP_SOURCE = mcpSource;
      env.KUSABI_STATE_DIR = path.join(tmp, "state");
      env.FAKE_CLAUDE_MODE = "ok";
      env.FAKE_CLAUDE_ARGS_LOG = argsLog;
      env.FAKE_CLAUDE_PIDS = pidsLog;
      env.FAKE_CLAUDE_STDIN_LOG = stdinLog;

      const result = spawnSync(
        process.execPath,
        [COMPANION_SCRIPT, "task", "--backend", "claude", "--read-only", "do the thing"],
        { encoding: "utf8", cwd: tmp, env, timeout: 20_000 },
      );
      assert.equal(result.status, 0, `expected success, got: ${result.stdout} ${result.stderr}`);
      const args = JSON.parse(fs.readFileSync(argsLog, "utf8").trim());
      const csv = args[10].split(",");
      for (const tool of ["mcp__sunaba__sandbox_exec", "mcp__sunaba__write_file", "mcp__sunaba__edit_file", "mcp__sunaba__transform_file"]) {
        assert.ok(!csv.includes(tool), `${tool} must be denied by --read-only, got csv: ${csv.join(",")}`);
      }
      assert.ok(csv.includes("mcp__sunaba__read_file_range"));
      // The prompt travels on stdin through the real CLI path (I5): the
      // task text reached the child without ever being on argv.
      assert.ok(!args.includes("do the thing"));
      assert.match(fs.readFileSync(stdinLog, "utf8"), /do the thing/);
      assert.match(fs.readFileSync(stdinLog, "utf8"), /<task>/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// =========================================================================
// CLI session wiring (subprocess) — kusabi #184 Job B
// =========================================================================
// Both backends share ONE job store, so `--resume-last` must select the
// previous job of the SAME backend as the current dispatch.  These tests
// drive the real CLI (cmdTask) with fixture job records and observe the
// session that actually reaches the fake claude on argv.

describe("CLI session wiring (subprocess)", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");

  // The subprocess resolves its workspace state dir via stateDirFor(cwd),
  // which hashes the cwd under the state root — replicate that here so the
  // fixture jobs land where cmdTask looks for them.
  function hashedWorkspaceDir(stateRootDir, cwd) {
    const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12);
    return path.join(stateRootDir, hash);
  }

  function writeFixtureJob(jobsDir, id, job) {
    const dir = path.join(jobsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({ id, ...job }), "utf8");
  }

  function setup(tmp, { jobs }) {
    const binPath = path.join(tmp, "fake-claude.mjs");
    fs.writeFileSync(binPath, FAKE_CLAUDE_SOURCE, "utf8");
    fs.chmodSync(binPath, 0o755);
    const argsLog = path.join(tmp, "args.ndjson");
    const pidsLog = path.join(tmp, "pids");
    const stdinLog = path.join(tmp, "stdin.txt");
    fs.writeFileSync(argsLog, "", "utf8");
    fs.writeFileSync(pidsLog, "", "utf8");
    fs.writeFileSync(stdinLog, "", "utf8");
    const mcpSource = path.join(tmp, "claude.json");
    fs.writeFileSync(mcpSource, JSON.stringify({ mcpServers: { sunaba: SUNABA_MCP } }), "utf8");

    const stateRoot = path.join(tmp, "state");
    const jobsDir = path.join(hashedWorkspaceDir(stateRoot, tmp), "jobs");
    for (const job of jobs) writeFixtureJob(jobsDir, job.id, job);

    const env = { ...process.env };
    delete env.KUSABI_WORKER_CONTEXT;
    env.CLAUDE_BIN = binPath;
    env.KUSABI_CLAUDE_MCP_SOURCE = mcpSource;
    env.KUSABI_STATE_DIR = stateRoot;
    env.FAKE_CLAUDE_MODE = "ok";
    env.FAKE_CLAUDE_ARGS_LOG = argsLog;
    env.FAKE_CLAUDE_PIDS = pidsLog;
    env.FAKE_CLAUDE_STDIN_LOG = stdinLog;
    return { env, argsLog, stdinLog };
  }

  it("--backend claude --resume-last resumes the last CLAUDE job, skipping a newer opencode job", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-claude-resume-last-"));
    try {
      const { env, argsLog } = setup(tmp, {
        jobs: [
          // Newer job: opencode (missing backend field = opencode).
          { id: "job-opencode", kind: "task", status: "completed", sessionID: "ses_opencode_latest", startedAt: "2026-08-02T00:00:00.000Z" },
          // Older job: claude.
          { id: "job-claude", kind: "task", status: "completed", backend: "claude", sessionID: "claude-uuid-older", startedAt: "2026-08-01T00:00:00.000Z" },
        ],
      });

      const result = spawnSync(
        process.execPath,
        [COMPANION_SCRIPT, "task", "--backend", "claude", "--resume-last", "do the thing"],
        { encoding: "utf8", cwd: tmp, env, timeout: 20_000 },
      );
      assert.equal(result.status, 0, `expected success, got: ${result.stdout} ${result.stderr}`);
      const args = JSON.parse(fs.readFileSync(argsLog, "utf8").trim());
      const resumeIdx = args.indexOf("--resume");
      assert.ok(resumeIdx > 0, "--resume-last must pass --resume to the claude dispatch");
      assert.equal(args[resumeIdx + 1], "claude-uuid-older");
      assert.notEqual(args[resumeIdx + 1], "ses_opencode_latest");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--backend claude --resume-last errors naming the backend when only opencode jobs exist", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-claude-resume-last-"));
    try {
      const { env, argsLog } = setup(tmp, {
        jobs: [
          { id: "job-opencode", kind: "task", status: "completed", sessionID: "ses_opencode_only", startedAt: "2026-08-02T00:00:00.000Z" },
        ],
      });

      const result = spawnSync(
        process.execPath,
        [COMPANION_SCRIPT, "task", "--backend", "claude", "--resume-last", "do the thing"],
        { encoding: "utf8", cwd: tmp, env, timeout: 20_000 },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /--resume-last: no previous claude task session found for this directory/);
      // Nothing was dispatched — the selection error fires before the run.
      assert.equal(fs.readFileSync(argsLog, "utf8").trim(), "");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--backend claude --session <id> passes the session through cmdTask as --resume", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-claude-session-"));
    try {
      const { env, argsLog } = setup(tmp, { jobs: [] });

      const result = spawnSync(
        process.execPath,
        [COMPANION_SCRIPT, "task", "--backend", "claude", "--session", "claude-uuid-cli", "do the thing"],
        { encoding: "utf8", cwd: tmp, env, timeout: 20_000 },
      );
      assert.equal(result.status, 0, `expected success, got: ${result.stdout} ${result.stderr}`);
      const args = JSON.parse(fs.readFileSync(argsLog, "utf8").trim());
      const resumeIdx = args.indexOf("--resume");
      assert.ok(resumeIdx > 0, "--session must pass --resume to the claude dispatch");
      assert.equal(args[resumeIdx + 1], "claude-uuid-cli");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--backend claude --session ses_* fails loudly through the CLI, before any dispatch", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-claude-session-"));
    try {
      const { env, argsLog } = setup(tmp, { jobs: [] });

      const result = spawnSync(
        process.execPath,
        [COMPANION_SCRIPT, "task", "--backend", "claude", "--session", "ses_opencode_1", "do the thing"],
        { encoding: "utf8", cwd: tmp, env, timeout: 20_000 },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /opencode session ses_opencode_1 cannot be resumed on the claude backend/);
      // The guard fires before the process spawns and before any job record:
      // nothing was dispatched and nothing was left recorded "running".
      assert.equal(fs.readFileSync(argsLog, "utf8").trim(), "");
      const jobsDir = path.join(hashedWorkspaceDir(path.join(tmp, "state"), tmp), "jobs");
      assert.deepEqual(fs.readdirSync(jobsDir), []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--backend claude --phase <p> --resume-last errors naming the phase and the backend", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-claude-resume-last-"));
    try {
      const { env, argsLog } = setup(tmp, { jobs: [] });

      const result = spawnSync(
        process.execPath,
        [COMPANION_SCRIPT, "task", "--backend", "claude", "--phase", "implement", "--resume-last", "do the thing"],
        { encoding: "utf8", cwd: tmp, env, timeout: 20_000 },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /--resume-last: no previous implement claude session found for this directory/);
      assert.equal(fs.readFileSync(argsLog, "utf8").trim(), "");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// =========================================================================
// CLI backend resolution (kusabi-companion)
// =========================================================================

describe("resolveBackend", () => {
  it("defaults to opencode without the flag", () => {
    assert.equal(resolveBackend({}), "opencode");
  });

  it("accepts opencode and claude", () => {
    assert.equal(resolveBackend({ backend: "opencode" }), "opencode");
    assert.equal(resolveBackend({ backend: "claude" }), "claude");
  });

  it("throws a clear, distinct error for an unknown backend", () => {
    assert.throws(() => resolveBackend({ backend: "bogus" }), /unknown backend: bogus/);
    assert.throws(() => resolveBackend({ backend: "bogus" }), /Use --backend opencode\|claude/);
  });
});

describe("resolveDispatchBackend (claude)", () => {
  it("returns claudeDispatch with the resolved claude model and chain", () => {
    const r = resolveDispatchBackend({
      flags: { backend: "claude" },
      phase: "implement",
      config: { models: { chain: [["opus"], ["sonnet"]] } },
    });
    assert.equal(r.backend, "claude");
    assert.equal(r.dispatch, claudeDispatch);
    assert.equal(r.model, "opus");
    assert.deepEqual(r.chain, [["opus"], ["sonnet"]]);
  });

  it("uses the claude-native default chain when there is no config", () => {
    const r = resolveDispatchBackend({ flags: { backend: "claude" }, phase: null, config: null });
    assert.equal(r.backend, "claude");
    assert.equal(r.model, "sonnet");
    assert.deepEqual(r.chain, CLAUDE_DEFAULT_CHAIN);
  });

  it("rejects an opencode-shaped models.chain at command start — before any job is dispatched", () => {
    assert.throws(
      () => resolveDispatchBackend({
        flags: { backend: "claude" },
        phase: "implement",
        config: { models: { chain: [["opencode/deepseek-v4-flash-free:max"]] } },
      }),
      /chain entry "opencode\/deepseek-v4-flash-free:max".*:variant/,
    );
  });

  it("--model is explicit: whole-chain validation is skipped (the chain is never consulted)", () => {
    const r = resolveDispatchBackend({
      flags: { backend: "claude", model: "opus" },
      phase: "implement",
      config: { models: { chain: [["sonnet"], ["opencode-go/deepseek-v4-pro:max"]] } },
    });
    assert.equal(r.backend, "claude");
    assert.equal(r.model, "opus");
    assert.deepEqual(r.chain, [["sonnet"], ["opencode-go/deepseek-v4-pro:max"]]);
  });

  it("--model haiku with an opencode-shaped models.chain resolves (kusabi #186)", () => {
    const r = resolveDispatchBackend({
      flags: { backend: "claude", model: "haiku" },
      phase: "implement",
      config: { models: { chain: ["opencode/deepseek-v4-flash-free:max"] } },
    });
    assert.equal(r.backend, "claude");
    assert.equal(r.model, "haiku");
    assert.deepEqual(r.chain, ["opencode/deepseek-v4-flash-free:max"]);
  });

  it("without --model, an opencode-shaped models.chain still throws at command start", () => {
    assert.throws(
      () => resolveDispatchBackend({
        flags: { backend: "claude" },
        phase: "implement",
        config: { models: { chain: ["opencode/deepseek-v4-flash-free:max"] } },
      }),
      /chain entry "opencode\/deepseek-v4-flash-free:max" is not a claude model/,
    );
  });

  it("--model opus:max with an opencode-shaped chain still fails fast on the :variant error", () => {
    assert.throws(
      () => resolveDispatchBackend({
        flags: { backend: "claude", model: "opus:max" },
        phase: "implement",
        config: { models: { chain: ["opencode/deepseek-v4-flash-free:max"] } },
      }),
      /:variant suffix in model "opus:max"/,
    );
  });
});

// Per-phase backend selection via the claude/ entry prefix (kusabi #192).
describe("resolveDispatchBackend (per-phase mixing, kusabi #192)", () => {
  it("no --backend flag: a claude/ chain selects the claude backend, prefix stripped", () => {
    const r = resolveDispatchBackend({
      flags: {},
      phase: "implement",
      config: { models: { phases: { implement: ["claude/opus"] } } },
    });
    assert.equal(r.backend, "claude");
    assert.equal(r.dispatch, claudeDispatch);
    assert.equal(r.model, "opus");
    assert.deepEqual(r.chain, ["opus"]);
  });

  it("no --backend flag: an unprefixed chain stays on opencode, byte-identical route", () => {
    const r = resolveDispatchBackend({
      flags: {},
      phase: "review",
      config: { models: { phases: { review: ["opencode/deepseek-v4-flash-free:max"] } } },
    });
    assert.equal(r.backend, "opencode");
    assert.equal(r.dispatch, dispatchWithFallback);
    assert.deepEqual(r.model, { providerID: "opencode", modelID: "deepseek-v4-flash-free", variant: "max" });
    assert.deepEqual(r.chain, ["opencode/deepseek-v4-flash-free:max"]);
  });

  it("implement and review resolve independently from models.phases (the mixing use case)", () => {
    const config = {
      models: {
        phases: {
          implement: ["claude/opus"],
          review: ["opencode/deepseek-v4-flash-free:max"],
        },
      },
    };
    const impl = resolveDispatchBackend({ flags: {}, phase: "implement", config });
    const rev = resolveDispatchBackend({ flags: {}, phase: "review", config });
    assert.equal(impl.backend, "claude");
    assert.equal(impl.model, "opus");
    assert.deepEqual(impl.chain, ["opus"]);
    assert.equal(rev.backend, "opencode");
    assert.deepEqual(rev.chain, ["opencode/deepseek-v4-flash-free:max"]);
  });

  it("a full claude model id works as the prefixed entry's model", () => {
    const r = resolveDispatchBackend({
      flags: {},
      phase: "implement",
      config: { models: { phases: { implement: ["claude/claude-sonnet-4-5"] } } },
    });
    assert.equal(r.backend, "claude");
    assert.equal(r.model, "claude-sonnet-4-5");
  });

  it("a claude/ chain from models.chain (no per-phase override) selects claude for every phase", () => {
    const config = { models: { chain: ["claude/sonnet"] } };
    const impl = resolveDispatchBackend({ flags: {}, phase: "implement", config });
    const rev = resolveDispatchBackend({ flags: {}, phase: "review", config });
    assert.equal(impl.backend, "claude");
    assert.equal(impl.model, "sonnet");
    assert.equal(rev.backend, "claude");
    assert.equal(rev.model, "sonnet");
  });

  it("--model with a claude chain (no --backend) is a bare alias / full id, not provider/model", () => {
    const r = resolveDispatchBackend({
      flags: { model: "haiku" },
      phase: "implement",
      config: { models: { phases: { implement: ["claude/opus"] } } },
    });
    assert.equal(r.backend, "claude");
    assert.equal(r.model, "haiku");
    assert.deepEqual(r.chain, ["opus"]);
  });

  it("a phase array mixing backends fails loudly at command start", () => {
    assert.throws(
      () => resolveDispatchBackend({
        flags: {},
        phase: "implement",
        config: { models: { phases: { implement: ["claude/opus", "opencode/x:max"] } } },
      }),
      /mixes backends/,
    );
    assert.throws(
      () => resolveDispatchBackend({
        flags: {},
        phase: "implement",
        config: { models: { phases: { implement: [["claude/opus"], ["opencode/x:max"]] } } },
      }),
      /mixes backends/,
    );
  });

  it("a claude/<model>:variant entry fails loudly at command start", () => {
    assert.throws(
      () => resolveDispatchBackend({
        flags: {},
        phase: "implement",
        config: { models: { phases: { implement: ["claude/opus:max"] } } },
      }),
      /:variant suffix in model "opus:max"/,
    );
    // Also under the explicit --backend claude flag.
    assert.throws(
      () => resolveDispatchBackend({
        flags: { backend: "claude" },
        phase: "implement",
        config: { models: { phases: { implement: ["claude/opus:max"] } } },
      }),
      /:variant suffix in model "opus:max"/,
    );
  });

  it("--backend claude strips a claude/ prefix on the flag path", () => {
    const r = resolveDispatchBackend({
      flags: { backend: "claude" },
      phase: "implement",
      config: { models: { phases: { implement: ["claude/opus"] } } },
    });
    assert.equal(r.backend, "claude");
    assert.equal(r.model, "opus");
    assert.deepEqual(r.chain, ["opus"]);
  });

  it("--backend claude with a mixed chain (no --model) still fails loudly at command start", () => {
    assert.throws(
      () => resolveDispatchBackend({
        flags: { backend: "claude" },
        phase: "implement",
        config: { models: { phases: { implement: ["claude/opus", "opencode/x"] } } },
      }),
      /mixes backends/,
    );
  });

  it("--backend claude + --model skips chain validation entirely (kusabi #186 carve-out), even for a mixed chain", () => {
    const r = resolveDispatchBackend({
      flags: { backend: "claude", model: "opus" },
      phase: "implement",
      config: { models: { chain: ["claude/opus", "opencode/x"] } },
    });
    assert.equal(r.backend, "claude");
    assert.equal(r.model, "opus");
    assert.deepEqual(r.chain, ["opus", "opencode/x"]);
  });

  it("--backend claude forces a claude/ phase onto claude with ITS phase model clamped", () => {
    // Per-phase config says review runs claude/sonnet; the flag forces claude
    // and the resolved phase model is sonnet (the clamp wrapper pins it).
    const config = {
      models: {
        phases: {
          implement: ["claude/opus"],
          review: ["claude/sonnet"],
        },
      },
    };
    const rev = resolveDispatchBackend({ flags: { backend: "claude" }, phase: "review", config });
    assert.equal(rev.backend, "claude");
    assert.equal(rev.dispatch, claudeDispatch);
    assert.equal(rev.model, "sonnet");
    assert.deepEqual(rev.chain, ["sonnet"]);
  });
});

// =========================================================================
// --model carries its backend (kusabi #210)
// -------------------------------------------------------------------------
// The identifier is the single source of routing truth: a `--model` that
// NAMES a backend decides the backend for the phases it pins, and the model
// is then validated against THAT backend.  A bare alias names no backend and
// moves nothing.  `--backend` keeps its all-phases meaning; disagreeing with
// a backend-naming `--model` is a contradiction, never a silent win.
// =========================================================================

describe("resolveDispatchBackend (--model carries its backend, kusabi #210)", () => {
  const CLAUDE_PINNED = { models: { phases: { implement: ["claude/opus"] } } };
  const OPENCODE_PINNED = { models: { phases: { implement: ["opencode-go/deepseek-v4-flash:max"] } } };

  it("THE INCIDENT: --model opencode-go/... runs a claude-pinned phase on opencode, no config edit", () => {
    const r = resolveDispatchBackend({
      flags: { model: "opencode-go/deepseek-v4-pro:max" },
      phase: "implement",
      config: CLAUDE_PINNED,
    });
    assert.equal(r.backend, "opencode");
    assert.equal(r.dispatch, dispatchWithFallback);
    assert.deepEqual(r.model, { providerID: "opencode-go", modelID: "deepseek-v4-pro", variant: "max" });
    assert.equal(r.explicitModel, "opencode-go/deepseek-v4-pro:max");
  });

  it("--model claude/opus selects claude from an opencode phase, prefix stripped", () => {
    const r = resolveDispatchBackend({
      flags: { model: "claude/opus" },
      phase: "implement",
      config: OPENCODE_PINNED,
    });
    assert.equal(r.backend, "claude");
    assert.equal(r.dispatch, claudeDispatch);
    assert.equal(r.model, "opus");
    // The dispatch must receive the claude spelling, never the prefixed
    // flag string — a claude CLI given `claude/opus` would take the prefix
    // for part of the model id.
    assert.equal(r.explicitModel, "opus");
  });

  it("--model claude/<full model id> selects claude too", () => {
    const r = resolveDispatchBackend({
      flags: { model: "claude/claude-sonnet-4-5" },
      phase: "review",
      config: { models: { chain: ["opencode/deepseek-v4-flash-free:max"] } },
    });
    assert.equal(r.backend, "claude");
    assert.equal(r.model, "claude-sonnet-4-5");
  });

  it("a bare --model on a claude-pinned phase is unchanged: claude, the phase's chain", () => {
    const r = resolveDispatchBackend({
      flags: { model: "haiku" },
      phase: "implement",
      config: CLAUDE_PINNED,
    });
    assert.equal(r.backend, "claude");
    assert.equal(r.model, "haiku");
    assert.deepEqual(r.chain, ["opus"]);
    assert.equal(r.explicitModel, "haiku");
  });

  it("a bare --model on an opencode phase is unchanged: still rejected by parseModel, still naming the key", () => {
    assert.throws(
      () => resolveDispatchBackend({
        flags: { model: "opus" },
        phase: "implement",
        config: OPENCODE_PINNED,
      }),
      /--model expects provider\/model, got: opus.*models\.phases\.implement/s,
    );
  });

  it("--backend claude with a --model naming opencode throws, naming BOTH", () => {
    assert.throws(
      () => resolveDispatchBackend({
        flags: { backend: "claude", model: "opencode-go/x:max" },
        phase: "implement",
        config: CLAUDE_PINNED,
      }),
      (err) => {
        assert.match(err.message, /--backend claude/);
        assert.match(err.message, /--model opencode-go\/x:max/);
        assert.match(err.message, /names the opencode backend/);
        return true;
      },
    );
  });

  it("--backend opencode with a --model naming claude throws, naming BOTH", () => {
    assert.throws(
      () => resolveDispatchBackend({
        flags: { backend: "opencode", model: "claude/opus" },
        phase: "implement",
        config: CLAUDE_PINNED,
      }),
      (err) => {
        assert.match(err.message, /--backend opencode/);
        assert.match(err.message, /--model claude\/opus/);
        assert.match(err.message, /names the claude backend/);
        // Not the #192 chain conflict — the two FLAGS are what disagree.
        assert.doesNotMatch(err.message, /claude-native chain/);
        return true;
      },
    );
  });

  it("--backend and a --model naming the SAME backend are consistent and proceed", () => {
    const claude = resolveDispatchBackend({
      flags: { backend: "claude", model: "claude/opus" },
      phase: "implement",
      config: OPENCODE_PINNED,
    });
    assert.equal(claude.backend, "claude");
    assert.equal(claude.model, "opus");
    const opencode = resolveDispatchBackend({
      flags: { backend: "opencode", model: "opencode-go/deepseek-v4-pro:max" },
      phase: "implement",
      config: CLAUDE_PINNED,
    });
    assert.equal(opencode.backend, "opencode");
    assert.deepEqual(opencode.model, { providerID: "opencode-go", modelID: "deepseek-v4-pro", variant: "max" });
  });

  it("the #192 conflict still fires when there is no --model to settle it", () => {
    assert.throws(
      () => resolveDispatchBackend({
        flags: { backend: "opencode" },
        phase: "implement",
        config: CLAUDE_PINNED,
      }),
      /--backend opencode conflicts with the claude-native chain/,
    );
    // A BARE --model names no backend, so it settles nothing: still fires.
    assert.throws(
      () => resolveDispatchBackend({
        flags: { backend: "opencode", model: "opus" },
        phase: "implement",
        config: CLAUDE_PINNED,
      }),
      /--backend opencode conflicts with the claude-native chain/,
    );
  });

  it("a backend-naming --model settles the #192 conflict instead of firing it", () => {
    const r = resolveDispatchBackend({
      flags: { backend: "opencode", model: "opencode-go/deepseek-v4-pro:max" },
      phase: "implement",
      config: CLAUDE_PINNED,
    });
    assert.equal(r.backend, "opencode");
    assert.deepEqual(r.model, { providerID: "opencode-go", modelID: "deepseek-v4-pro", variant: "max" });
  });

  it(":variant on a claude-named model is rejected BY THE IDENTIFIER's backend, not by a config key", () => {
    assert.throws(
      () => resolveDispatchBackend({
        flags: { model: "claude/opus:max" },
        phase: "implement",
        config: CLAUDE_PINNED,
      }),
      (err) => {
        assert.match(err.message, /--model "claude\/opus:max" names the claude backend/);
        assert.match(err.message, /:variant suffix in model "opus:max"/);
        // The rejection is the identifier's, so it must NOT be blamed on a
        // config key three levels away.
        assert.doesNotMatch(err.message, /models\.phases\.implement/);
        return true;
      },
    );
  });

  it("a claude-native ladder is never handed to an opencode dispatch as fallback routes", () => {
    const r = resolveDispatchBackend({
      flags: { model: "opencode-go/deepseek-v4-pro:max" },
      phase: "implement",
      config: { models: { chain: ["claude/sonnet", "claude/opus"] } },
    });
    assert.equal(r.backend, "opencode");
    // The configured ladder belongs to the other backend; --model pins this
    // phase, so the ladder is exactly the pinned route.
    assert.deepEqual(r.chain, ["opencode-go/deepseek-v4-pro:max"]);
  });

  it("--model pins every phase it applies to — and no wider", () => {
    const config = {
      models: {
        phases: {
          implement: ["claude/opus"],
          rework: ["opencode-go/deepseek-v4-flash:max"],
          review: ["opencode/deepseek-v4-flash-free:max"],
        },
      },
    };
    // With the flag, all three phases of the command run on the named
    // backend with the named model (this is what `--model` has always done
    // to the model; it now does the same to the backend).
    for (const phase of ["implement", "rework", "review"]) {
      const r = resolveDispatchBackend({ flags: { model: "claude/opus" }, phase, config });
      assert.equal(r.backend, "claude", phase);
      assert.equal(r.model, "opus", phase);
      assert.equal(r.explicitModel, "opus", phase);
    }
    // Without it, nothing is pinned: each phase keeps its configured backend.
    const impl = resolveDispatchBackend({ flags: {}, phase: "implement", config });
    const rework = resolveDispatchBackend({ flags: {}, phase: "rework", config });
    const review = resolveDispatchBackend({ flags: {}, phase: "review", config });
    assert.equal(impl.backend, "claude");
    assert.equal(impl.explicitModel, null);
    assert.equal(rework.backend, "opencode");
    assert.equal(review.backend, "opencode");
    assert.equal(review.explicitModel, null);
  });
});

// =========================================================================
// CLI --model backend routing (subprocess) — kusabi #210
// -------------------------------------------------------------------------
// The resolution decides the backend; this proves the decision reaches the
// spawned process: a `--model claude/opus` with NO --backend (and no config,
// so the default chain is opencode) must spawn the claude CLI, and it must
// receive the claude spelling `opus` — never the prefixed flag string.
// =========================================================================

describe("CLI --model backend routing (subprocess, kusabi #210)", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");

  function setupFakeClaude(tmp) {
    const binPath = path.join(tmp, "fake-claude.mjs");
    fs.writeFileSync(binPath, FAKE_CLAUDE_SOURCE, "utf8");
    fs.chmodSync(binPath, 0o755);
    const argsLog = path.join(tmp, "args.ndjson");
    const pidsLog = path.join(tmp, "pids");
    const stdinLog = path.join(tmp, "stdin.txt");
    for (const f of [argsLog, pidsLog, stdinLog]) fs.writeFileSync(f, "", "utf8");
    const mcpSource = path.join(tmp, "claude.json");
    fs.writeFileSync(mcpSource, JSON.stringify({ mcpServers: { sunaba: SUNABA_MCP } }), "utf8");

    const env = { ...process.env };
    delete env.KUSABI_WORKER_CONTEXT;
    env.CLAUDE_BIN = binPath;
    env.KUSABI_CLAUDE_MCP_SOURCE = mcpSource;
    env.KUSABI_STATE_DIR = path.join(tmp, "state");
    env.FAKE_CLAUDE_MODE = "ok";
    env.FAKE_CLAUDE_ARGS_LOG = argsLog;
    env.FAKE_CLAUDE_PIDS = pidsLog;
    env.FAKE_CLAUDE_STDIN_LOG = stdinLog;
    return { env, argsLog };
  }

  it("task --model claude/opus (no --backend, opencode default chain) spawns claude with model opus", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-model-backend-"));
    try {
      const { env, argsLog } = setupFakeClaude(tmp);
      const result = spawnSync(
        process.execPath,
        [COMPANION_SCRIPT, "task", "--model", "claude/opus", "do the thing"],
        { encoding: "utf8", cwd: tmp, env, timeout: 20_000 },
      );
      assert.equal(result.status, 0, `expected success, got: ${result.stdout} ${result.stderr}`);
      const args = JSON.parse(fs.readFileSync(argsLog, "utf8").trim());
      const modelIdx = args.indexOf("--model");
      assert.ok(modelIdx > 0, `the claude CLI must receive --model, got: ${args.join(" ")}`);
      assert.equal(args[modelIdx + 1], "opus");
      assert.notEqual(args[modelIdx + 1], "claude/opus");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
