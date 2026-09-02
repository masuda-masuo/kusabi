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
  allowedToolsForAgent,
  disallowedToolsForAgent,
  applyToolDenies,
  translateDenyTools,
  clampModelDispatch,
  sunabaProfileForAgent,
  claudeDispatch,
  CLAUDE_WRITE_WATCHDOG_DEFAULT_WARN_S,
  resolveClaudeWriteWatchdog,
  writeWatchdogAppliesToPhase,
  isClaudeWriteToolName,
  eventHasClaudeWriteTool,
  renderClaudeWriteWatchdogError,
  CLAUDE_REPEAT_ARGS_PREVIEW_MAX,
  resolveClaudeRepeatWatchdog,
  isClaudeRepeatUntrackedToolName,
  normalizeClaudeRepeatArgs,
  claudeRepeatChainKey,
  claudeRepeatArgsPreview,
  claudeRepeatChainAdvance,
  foldClaudeRepeatCalls,
  renderClaudeRepeatWatchdogError,
  runClaudeProcess,
} from "./claude-dispatch.mjs";
import { agyDispatch } from "./agy-dispatch.mjs";
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

  it("grants kaiba recall and progress to all three supported agents — never remember (kusabi #279, #391)", () => {
    // Write permission follows the inspection hierarchy: every agent
    // dispatched here has its output inspected, so it reads the store,
    // records in-flight progress notes, and reports durable facts for the
    // orchestrator to file.  On the store's first day workers filed review
    // summaries and completion reports, which the prompt-level contract
    // failed to prevent — so the grant itself is the guard now.
    for (const agent of ["kusabi-implement", "kusabi-review", "kusabi-investigate"]) {
      const csv = allowedToolsForAgent(agent);
      assert.ok(csv.includes("mcp__kaiba__recall"), `${agent} must allow mcp__kaiba__recall`);
      assert.ok(csv.includes("mcp__kaiba__progress"), `${agent} must allow mcp__kaiba__progress`);
      assert.ok(!csv.includes("mcp__kaiba__remember"), `${agent} must NOT allow mcp__kaiba__remember`);
    }
  });

  it("no phase toolset pairs kaiba recall with remember, and none grants a kaiba wildcard", () => {
    // The invariant stated over every entry of ALLOWED_TOOLS rather than the
    // three agent names: a future phase added to the map is covered too.  A
    // glob like `mcp__kaiba__*` would re-allow remember by pattern, so the
    // only acceptable kaiba entry is the exact recall tool.
    for (const [phase, csv] of Object.entries(ALLOWED_TOOLS)) {
      const kaibaTools = csv.split(",").filter(t => t.startsWith("mcp__kaiba__"));
      assert.deepEqual(kaibaTools, ["mcp__kaiba__recall", "mcp__kaiba__progress"], `${phase}: kaiba must be recall and progress only`);
    }
  });

  it("maps kusabi-test-author to the implement allowlist minus run_python (kusabi #408)", () => {
    const csv = allowedToolsForAgent("kusabi-test-author");
    assert.equal(csv, ALLOWED_TOOLS.testAuthor);
    assert.ok(csv.includes("mcp__sunaba__write_file"));
    assert.ok(csv.includes("mcp__sunaba__edit_file"));
    assert.ok(csv.includes("mcp__sunaba__verify_in_container"));
    assert.ok(!csv.includes("mcp__sunaba__sandbox_issue_write"));
    assert.ok(!csv.includes("mcp__sunaba__publish"));
    // Acceptance criterion 2: identical to the implement allowlist EXCEPT for
    // the absent run_python grant.  Enforce the "otherwise identical" clause
    // directly rather than trusting the hand-listed positives above.
    const implementTools = ALLOWED_TOOLS.implement.split(",");
    const testAuthorTools = new Set(csv.split(","));
    for (const t of implementTools) {
      if (t === "mcp__sunaba__run_python") {
        assert.ok(!testAuthorTools.has(t), `test-author must NOT grant ${t}`);
      } else {
        assert.ok(testAuthorTools.has(t), `test-author must keep implement tool ${t}`);
      }
    }
    assert.equal(testAuthorTools.size, implementTools.length - 1, "test-author must differ from implement only by the run_python removal");
  });

  it("maps kusabi-plan to the review allowlist minus shiori (kusabi #409)", () => {
    const csv = allowedToolsForAgent("kusabi-plan");
    assert.equal(csv, ALLOWED_TOOLS.plan);
    assert.ok(csv.includes("mcp__sunaba__verify_in_container"));
    assert.ok(!csv.includes("mcp__shiori__*"));
    assert.ok(!csv.includes("mcp__sunaba__write_file"));
    assert.ok(!csv.includes("mcp__sunaba__sandbox_issue_write"));
    // Acceptance criterion 1: identical to the review allowlist EXCEPT for the
    // absent shiori grant.  Enforce the "otherwise identical" clause directly.
    const reviewTools = ALLOWED_TOOLS.review.split(",");
    const planTools = new Set(csv.split(","));
    for (const t of reviewTools) {
      if (t.startsWith("mcp__shiori__")) {
        assert.ok(!planTools.has(t), `plan must NOT grant ${t}`);
      } else {
        assert.ok(planTools.has(t), `plan must keep review tool ${t}`);
      }
    }
    const shioriCount = reviewTools.filter(t => t.startsWith("mcp__shiori__")).length;
    assert.equal(planTools.size, reviewTools.length - shioriCount, "plan must differ from review only by the shiori removal");
  });

  it("no v1 allowlist still thrown for unknown agents (error text names test-author and plan)", () => {
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


describe("sunabaProfileForAgent", () => {
  it("maps the implement agent — and a bare task — to the implement profile", () => {
    assert.equal(sunabaProfileForAgent("kusabi-implement"), "implement");
    assert.equal(sunabaProfileForAgent(undefined), "implement");
    assert.equal(sunabaProfileForAgent(null), "implement");
  });

  it("maps review to the review profile", () => {
    assert.equal(sunabaProfileForAgent("kusabi-review"), "review");
  });

  it("gives investigate NO profile — no single profile covers its allowlist", () => {
    // Its allowlist is the review-shaped read tools PLUS sandbox_issue_write;
    // the unfiltered list is the correct cover (kusabi #274 acceptance 4).
    assert.equal(sunabaProfileForAgent("kusabi-investigate"), null);
  });

  it("gives unknown agents NO profile (the full list is the safe default)", () => {
    assert.equal(sunabaProfileForAgent("kusabi-draft"), null);
    assert.equal(sunabaProfileForAgent("custom-agent"), null);
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
if (mode === "writes" || mode === "no-write-then-finish") {
  // Two streams that keep the SILENCE watchdog fed the whole way (a parsed
  // event every 200ms) and differ only in WHICH tool they call: "writes"
  // calls a file-mutating one, "no-write-then-finish" only reads.  Telling
  // those two apart is the write watchdog's entire job (kusabi #215 item 3).
  // Both end with a real terminal result, so the run's own outcome is
  // observable next to whatever the watchdog did.
  const tool = mode === "writes" ? "mcp__sunaba__edit_file" : "mcp__sunaba__read_file_range";
  const ticks = Number(process.env.FAKE_CLAUDE_TICKS || "12");
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-cadence-1" }));
  for (let i = 0; i < ticks; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    console.log(JSON.stringify({
      type: "assistant",
      session_id: "claude-cadence-1",
      message: { model: "claude-sonnet-4-5", content: [{ type: "tool_use", id: "tool-" + i, name: tool, input: {} }] },
    }));
  }
  console.log(JSON.stringify({
    type: "result", is_error: false, result: "ran to completion",
    session_id: "claude-cadence-1", usage: {}, total_cost_usd: 0,
    duration_ms: 200 * ticks, num_turns: ticks,
  }));
  process.exit(0);
}
if (mode === "repeat-identical" || mode === "repeat-untracked" || mode === "repeat-denied" || mode === "repeat-huge-args") {
  // The repeat watchdog's never-terminating fixtures (kusabi #234): every
  // tick is a parsed assistant event carrying a tool_use block WITH input,
  // and the SAME call repeats forever — only the count-based watchdog can
  // end these runs.  All four share this block and differ in WHICH tool
  // repeats and with what input.
  const init = {
    "repeat-identical": { session: "claude-repeat-1" },
    "repeat-untracked": { session: "claude-repeat-untracked-1" },
    "repeat-denied": { session: "claude-repeat-denied-1" },
    "repeat-huge-args": { session: "claude-repeat-huge-1" },
  }[mode];
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: init.session }));
  let n = 0;
  setInterval(() => {
    n += 1;
    let block;
    if (mode === "repeat-identical") {
      // Invariant 1: the SAME file-mutating call, same arguments, every
      // tick.  Every tick is a parsed event (silence clock reset) and every
      // tick is a file-mutating call (write clock reset) — the two
      // time-based watchdogs are satisfied forever; only a count-based
      // chain can end this run.
      block = {
        type: "tool_use",
        id: "edit-" + n,
        name: "mcp__sunaba__edit_file",
        input: { file: "src/worker.js", file_contents: "export const x = 1;" },
      };
    } else if (mode === "repeat-untracked") {
      // Invariant 2: a bookkeeping tool (TodoWrite) alternates with the
      // repeated call.  Untracked calls are TRANSPARENT to the chain —
      // neither increment nor reset — so the edit_file calls still count as
      // consecutive across them (deepseek-harness's todo_write precedent).
      block = n % 2 === 1
        ? { type: "tool_use", id: "edit-" + n, name: "mcp__sunaba__edit_file", input: { file: "src/worker.js", file_contents: "export const x = 1;" } }
        : { type: "tool_use", id: "todo-" + n, name: "TodoWrite", input: { todos: [{ content: "keep editing src/worker.js", status: "in_progress" }] } };
    } else if (mode === "repeat-denied") {
      // Invariant 3: the repeated call is DENIED by kusabi — Bash is on the
      // belt-and-braces DISALLOWED_TOOLS list, so every one of these calls
      // would be refused in a real session.  The refusal does not stop the
      // model from repeating them, and the chain must count them.
      block = { type: "tool_use", id: "bash-" + n, name: "Bash", input: { command: "ls" } };
    } else {
      // Invariant 5: the repeated input is ~460 chars — far past the
      // 200-char preview cap — so the warned event's preview is visibly
      // truncated while identity comparison still uses the FULL normalized
      // string.
      block = { type: "tool_use", id: "huge-" + n, name: "mcp__sunaba__edit_file", input: { file: "src/worker.js", file_contents: "// common leading comment that fills the preview window " + "x".repeat(400) + "a" } };
    }
    console.log(JSON.stringify({
      type: "assistant",
      session_id: init.session,
      message: { model: "claude-sonnet-4-5", content: mode === "repeat-identical" ? [{ type: "text", text: "Working on it." }, block] : [block] },
    }));
  }, 50);
  // Never-terminating, and must never fall through to the result-writing
  // tail's else (which would exit(0) and let the dispatch COMPLETE on these
  // modes): the count-based watchdog, or nothing, ends this run.
  await new Promise(() => {});
}
if (mode === "repeat-then-change" || mode === "repeat-huge-differ") {
  // The repeat watchdog's terminating fixtures (kusabi #234): the repeated
  // call chain is crossed, then the worker changes what it does — the chain
  // must reset on the different call and the run completes on its own.
  const init = {
    "repeat-then-change": { session: "claude-repeat-change-1" },
    "repeat-huge-differ": { session: "claude-repeat-differ-1" },
  }[mode];
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: init.session }));
  let contents;
  if (mode === "repeat-then-change") {
    // Three identical calls (warn at threshold 3), then three with
    // DIFFERENT arguments.
    contents = ["export const x = 1;", "export const x = 1;", "export const x = 1;", "export const x = 2;", "export const x = 2;", "export const x = 2;"];
  } else {
    // Three calls with input A, then three with input B whose first 200
    // characters are IDENTICAL to A's — only the tail differs.  A
    // comparison against the truncated preview would count B as a
    // continuation of A's chain and reach killThreshold 5; the full-string
    // comparison resets on B (invariant 5).
    contents = ["a", "a", "a", "b", "b", "b"].map((s) => "// common leading comment that fills the preview window " + "x".repeat(400) + s);
  }
  for (let i = 0; i < contents.length; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    console.log(JSON.stringify({
      type: "assistant",
      session_id: init.session,
      message: { model: "claude-sonnet-4-5", content: [{ type: "tool_use", id: "tool-" + i, name: "mcp__sunaba__edit_file", input: { file: "src/worker.js", file_contents: contents[i] } }] },
    }));
  }
  console.log(JSON.stringify({
    type: "result", is_error: false, result: "changed approach mid-run",
    session_id: init.session, usage: {}, total_cost_usd: 0,
    duration_ms: 300, num_turns: contents.length,
  }));
  process.exit(0);
}
// The stall*/slow*/no-write never-terminating modes are handled in ONE
// block in the tail below — they must never fall through to the
// result-writing tail's else, or a stall fake would hand the dispatch a
// terminal "result" event it could complete on.
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
if (mode === "stall" || mode === "stall-with-child" || mode === "stall-garbage" || mode === "slow" || mode === "slow-with-child" || mode === "no-write") {
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
  } else if (mode === "no-write") {
    // The recorded incident in miniature (kusabi #215 item 3): busy forever,
    // producing nothing.  A READ tool call every 200ms holds the silence
    // watchdog off indefinitely — only the write watchdog can end this run.
    console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-no-write-1" }));
    let n = 0;
    setInterval(() => {
      n += 1;
      console.log(JSON.stringify({
        type: "assistant",
        session_id: "claude-no-write-1",
        message: { model: "claude-sonnet-4-5", content: [{ type: "tool_use", id: "read-" + n, name: "mcp__sunaba__read_file_range", input: {} }] },
      }));
    }, 200);
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

/**
 * @param {string} mode — FAKE_CLAUDE_MODE for the fake binary.
 * @param {{config?: object|null}} [opts] — when `config` is given it is
 *        written to <stateRoot>/config.json, which is where the claude
 *        backend's config-driven features (the session guard, the write
 *        watchdog) read from.  Default null: NO config file at all, which is
 *        the pre-existing behaviour every earlier test relies on.
 */
function fakeClaudeContext(mode = "ok", { config = null } = {}) {
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
  if (config !== null) {
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(path.join(stateRoot, "config.json"), JSON.stringify(config, null, 2), "utf8");
  }

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

// The write watchdog's own trail (kusabi #215 item 3).  Its prefix is
// deliberately distinct from the silence pair's, so `watchdogEvents` above
// keeps meaning exactly what it always meant and neither can be mistaken
// for the other.
function writeWatchdogEvents(stateDir, jobId) {
  return readJobEvents(stateDir, jobId).filter((e) => String(e.type).startsWith("companion.write-watchdog."));
}

// The repeat watchdog's own trail (kusabi #234).  Its prefix is distinct
// from both siblings', so the filters above keep meaning exactly what they
// always meant.
function repeatWatchdogEvents(stateDir, jobId) {
  return readJobEvents(stateDir, jobId).filter((e) => String(e.type).startsWith("companion.repeat-watchdog."));
}

// The volatile fields that make two identical runs differ on the record:
// ids, timestamps, the child's process identity, and the observation/duration
// stamps derived from them.  Stripping them lets a test assert byte- and
// event-equivalence between two runs of the SAME fixture (kusabi #234
// invariant 4) — the comparison then covers everything the dispatch itself
// controls.
function stripVolatile(job) {
  const copy = { ...job };
  delete copy.id;
  delete copy.startedAt;
  delete copy.finishedAt;
  delete copy.process;
  // The record names its working directory, and two independent fixtures
  // necessarily live in different temp trees — the comparison is about the
  // dispatch's own output, not about where it happened.
  delete copy.cwd;
  if (copy.stats) {
    copy.stats = { ...copy.stats };
    delete copy.stats.lastActivity;
  }
  if (copy.rateLimit) {
    copy.rateLimit = { ...copy.rateLimit, observedAt: null };
  }
  if (copy.usage) {
    copy.usage = { ...copy.usage };
    delete copy.usage.durationSeconds;
  }
  return copy;
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
    // (kusabi #388) terminal reason stamped at the job-level write.
    assert.equal(job.stopReason, "completed");
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
    assert.equal(persisted.stopReason, "completed");
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

    // The generated MCP config contains ONLY the sunaba entry, at a path
    // that names a REAL file at spawn time (kusabi #276): the config is
    // per-dispatch — it lives in this job's own directory, so no other
    // dispatch in the same cwd can overwrite it before this child reads it.
    const mcpConfigPath = args[14];
    assert.ok(fs.existsSync(mcpConfigPath), "--mcp-config must name a file that exists at spawn time");
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

  // ---- kaiba pass-through (kusabi #279) ----
  // The default fixture has NO kaiba entry, and the invocation-shape test
  // above already pins that the generated config stays exactly
  // `{ mcpServers: { sunaba } }`.  These drive the kaiba-present and
  // error cases end to end.

  it("a source kaiba entry reaches the generated config, filed under worker with KAIBA_JOB — never the operator's identity", async () => {
    // The host entry is the OPERATOR's own registration (KAIBA_AGENT=claude).
    // A dispatched worker is not that session: conclusions it writes must
    // not be attributed to it — authorship exists precisely to tell them
    // apart — so the generated config always carries KAIBA_AGENT=worker and
    // KAIBA_JOB=<job.id>.
    const sourceKaiba = {
      command: "/usr/local/bin/kaiba",
      env: { KAIBA_WORKSPACE: "dev", KAIBA_AGENT: "claude" },
    };
    fs.writeFileSync(
      ctx.mcpSource,
      JSON.stringify({ mcpServers: { sunaba: SUNABA_MCP, kaiba: sourceKaiba, other: { command: "echo" } } }),
      "utf8",
    );
    const { job } = await claudeDispatch(ctx.dispatchOptions());

    const args = JSON.parse(fs.readFileSync(ctx.argsLog, "utf8").trim());
    const mcpConfig = readJson(args[args.indexOf("--mcp-config") + 1]);
    assert.deepEqual(mcpConfig.mcpServers.sunaba, SUNABA_MCP);
    assert.deepEqual(mcpConfig.mcpServers.kaiba, {
      command: "/usr/local/bin/kaiba",
      env: { KAIBA_WORKSPACE: "dev", KAIBA_AGENT: "worker", KAIBA_JOB: job.id },
    });
    // The operator's registration on disk is untouched — the rewrite came
    // back on a copy.
    const source = JSON.parse(fs.readFileSync(ctx.mcpSource, "utf8"));
    assert.deepEqual(source.mcpServers.kaiba, sourceKaiba);
  });

  it("without a kaiba entry the generated config is exactly today's — no kaiba, no error", async () => {
    // The machine that has not adopted kaiba must keep dispatching
    // unchanged (kusabi #279): this fixture's source config has no kaiba
    // entry, so the generated config must deep-equal the pre-kaiba shape.
    await claudeDispatch(ctx.dispatchOptions());
    const args = JSON.parse(fs.readFileSync(ctx.argsLog, "utf8").trim());
    const mcpConfig = readJson(args[args.indexOf("--mcp-config") + 1]);
    assert.deepEqual(mcpConfig, { mcpServers: { sunaba: SUNABA_MCP } });
    assert.equal(mcpConfig.mcpServers.kaiba, undefined);
  });

  it("a malformed source config still throws in pre-flight — an optional server never softens the loud failure", async () => {
    fs.writeFileSync(ctx.mcpSource, "{ not json", "utf8");
    await assert.rejects(() => claudeDispatch(ctx.dispatchOptions()), /is not valid JSON/);
    // Nothing was spawned: no argv line was recorded.
    assert.equal(fs.readFileSync(ctx.argsLog, "utf8").trim(), "");
  });

  it("a missing sunaba entry still throws in pre-flight even when kaiba is present", async () => {
    fs.writeFileSync(
      ctx.mcpSource,
      JSON.stringify({ mcpServers: { kaiba: { command: "/usr/local/bin/kaiba" } } }),
      "utf8",
    );
    await assert.rejects(() => claudeDispatch(ctx.dispatchOptions()), /no mcpServers\.sunaba entry/);
    assert.equal(fs.readFileSync(ctx.argsLog, "utf8").trim(), "");
  });

  it("a malformed kaiba entry fails the dispatch in pre-flight \u2014 no job record, nothing spawned, and the error names the kaiba key", async () => {
    // The entry is present but cannot be a server entry.  Unlike ABSENCE
    // (silent, kusabi #279), this is an operator error: it must fail loudly
    // BEFORE any job record exists — and the message must be distinguishable
    // from the missing-sunaba failure by naming the kaiba key.
    fs.writeFileSync(
      ctx.mcpSource,
      JSON.stringify({ mcpServers: { sunaba: SUNABA_MCP, kaiba: "kaiba" } }),
      "utf8",
    );
    await assert.rejects(
      () => claudeDispatch(ctx.dispatchOptions()),
      /mcpServers\.kaiba .* not a server entry/,
    );
    // Nothing was spawned and no job record exists: the failure landed in
    // pre-flight, before either could be created.
    assert.equal(fs.readFileSync(ctx.argsLog, "utf8").trim(), "");
    assert.deepEqual(listJobs(ctx.stateDir), []);
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

  // ---- sunaba tool profiles (kusabi #274) ----
  //
  // The default fixture's sunaba entry is stdio, and the invocation-shape
  // test above already asserts it reaches the generated config byte-identical
  // (stdio has no query string to carry a profile).  These point the source
  // config at an HTTP entry instead and follow the profile end to end.

  /** Rewrite the fixture's MCP source with an HTTP sunaba entry. */
  function useHttpSunabaSource(url = "http://127.0.0.1:8750/mcp") {
    fs.writeFileSync(
      ctx.mcpSource,
      JSON.stringify({ mcpServers: { sunaba: { type: "http", url }, other: { command: "echo" } } }),
      "utf8",
    );
  }

  /**
   * The sunaba url in the generated MCP config of the last dispatch.  The
   * config is a per-dispatch file (kusabi #276) that lives with its job, so
   * it is still on disk after the dispatch completes.
   */
  function generatedSunabaUrl() {
    const args = JSON.parse(fs.readFileSync(ctx.argsLog, "utf8").trim().split("\n").pop());
    return readJson(args[args.indexOf("--mcp-config") + 1]).mcpServers.sunaba.url;
  }

  it("review agent: the generated MCP config's sunaba url carries profile=review", async () => {
    useHttpSunabaSource();
    await claudeDispatch(ctx.dispatchOptions({ kind: "review", agent: "kusabi-review", phase: "review" }));
    assert.equal(generatedSunabaUrl(), "http://127.0.0.1:8750/mcp?profile=review");
  });

  it("implement agent: the generated MCP config's sunaba url carries profile=implement", async () => {
    useHttpSunabaSource();
    await claudeDispatch(ctx.dispatchOptions({ agent: "kusabi-implement" }));
    assert.equal(generatedSunabaUrl(), "http://127.0.0.1:8750/mcp?profile=implement");
  });

  it("keeps the source url's other query parameters when appending the profile", async () => {
    useHttpSunabaSource("http://127.0.0.1:8750/mcp?token=abc");
    await claudeDispatch(ctx.dispatchOptions({ agent: "kusabi-implement" }));
    assert.equal(generatedSunabaUrl(), "http://127.0.0.1:8750/mcp?token=abc&profile=implement");
  });

  it("investigate agent: no profile parameter — the full tool list is its cover", async () => {
    useHttpSunabaSource();
    await claudeDispatch(ctx.dispatchOptions({ agent: "kusabi-investigate" }));
    assert.equal(generatedSunabaUrl(), "http://127.0.0.1:8750/mcp");
  });

  it("leaves a profile named in the source config untouched", async () => {
    useHttpSunabaSource("http://127.0.0.1:8750/mcp?profile=issue");
    await claudeDispatch(ctx.dispatchOptions({ agent: "kusabi-implement" }));
    assert.equal(generatedSunabaUrl(), "http://127.0.0.1:8750/mcp?profile=issue");
  });

  it("overlapping dispatches in the same cwd each read the config their own pre-flight wrote", async () => {
    // The failure this guards (kusabi #276): the generated config used to be
    // ONE file per cwd, so two dispatches whose spawn windows overlap — a
    // chain and a stand-alone task, or two tasks — raced it.  Dispatch A
    // wrote `profile=implement` and spawned; dispatch B overwrote the same
    // file with `profile=review` before A's claude process had read
    // `--mcp-config`, and A's worker ran with the review profile, its write
    // tools simply absent.
    //
    // Interleave them the way the real world does: A's pre-flight writes its
    // config and spawns, then B's pre-flight writes ITS config and spawns —
    // both in the SAME cwd.  The assertion is on CONTENT, never on a
    // filename shape: whatever path each dispatch handed to `--mcp-config`
    // must still contain the profile that dispatch resolved.  With the old
    // shared per-cwd file, A's path IS B's path, so the implement assertion
    // below reads B's review config and fails.
    useHttpSunabaSource();
    const promiseA = claudeDispatch(ctx.dispatchOptions({ agent: "kusabi-implement" }));
    const promiseB = claudeDispatch(ctx.dispatchOptions({
      kind: "review",
      agent: "kusabi-review",
      phase: "review",
      // The only argv difference between the two lines in the args log, so
      // each dispatch's line — and therefore its `--mcp-config` path — can
      // be identified after both have run.
      explicitModel: "claude-opus-4-1",
    }));
    const [resultA, resultB] = await Promise.all([promiseA, promiseB]);
    assert.equal(resultA.job.status, "completed");
    assert.equal(resultB.job.status, "completed");

    const lines = fs.readFileSync(ctx.argsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2, "one argv line per dispatch");
    const argsFor = (model) => {
      const line = lines.find((l) => l[l.indexOf("--model") + 1] === model);
      assert.ok(line, `expected an argv line carrying --model ${model}`);
      return line;
    };
    const mcpConfigPathFor = (argv) => argv[argv.indexOf("--mcp-config") + 1];
    const aPath = mcpConfigPathFor(argsFor("opus"));
    const bPath = mcpConfigPathFor(argsFor("claude-opus-4-1"));

    // A's file still exists and still carries A's own entry — B's write
    // must not have touched it, and A must not have read B's.
    assert.ok(fs.existsSync(aPath), "A's --mcp-config path must still exist after B's dispatch");
    assert.equal(readJson(aPath).mcpServers.sunaba.url, "http://127.0.0.1:8750/mcp?profile=implement");
    assert.ok(fs.existsSync(bPath), "B's --mcp-config path must still exist");
    assert.equal(readJson(bPath).mcpServers.sunaba.url, "http://127.0.0.1:8750/mcp?profile=review");
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
    // round's record — the claude chain must NOT start blank.  The carry it
    // reports is the id the dispatch actually used or created (kusabi #324):
    // here the stub returns `claude-uuid-round2`, the observed id, which is
    // preferred over the told candidate `claude-uuid-round1`.
    const second = await runImplementPhase({
      ...common, round: 2, isFirstRound: false,
      previousRecord: { sessionID: "claude-uuid-round1" },
      session: undefined, useNewSession: false,
    });
    assert.equal(calls[1].session, "claude-uuid-round1");
    assert.equal(second.session, "claude-uuid-round2");

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
    // (kusabi #388) an unmappable error status records the "unknown" sentinel.
    assert.equal(job.stopReason, "unknown");
    const persisted = loadJob(ctx.stateDir, job.id);
    assert.equal(persisted.stopReason, "unknown");
  });

  it("classifies the real session-limit 429 payload as quota exhaustion (provider-error)", async () => {
    ctx.restore();
    ctx = fakeClaudeContext("quota-session");
    const { job } = await claudeDispatch(ctx.dispatchOptions());

    // Failed job, machine-readable classification on the record (never by
    // grepping `error` prose).
    assert.equal(job.status, "provider-error");
    // (kusabi #388) a classified quota exhaustion stamps "quota-exhausted" —
    // never "completed" and never a generic "provider-error".
    assert.equal(job.stopReason, "quota-exhausted");
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
    assert.equal(persisted.stopReason, "quota-exhausted");
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
    // (kusabi #388) a classified quota exhaustion stamps "quota-exhausted" —
    // never "completed" and never a generic "provider-error".
    assert.equal(job.stopReason, "quota-exhausted");
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
    assert.equal(persisted.stopReason, "quota-exhausted");
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

// pre-dispatch session-quota guard — integration (fake claude binary)
// =========================================================================
//
// One fake binary answers BOTH invocations and logs them to SEPARATE files:
// the /usage probe (control plane) and the worker dispatch.  "the worker was
// never spawned" is the whole assertion of the refusal test, so it must not
// depend on picking argv apart in a shared log.

const FAKE_GUARD_CLAUDE_SOURCE = `#!/usr/bin/env node
import fs from "node:fs";

const NL = String.fromCharCode(10);
const argv = process.argv.slice(2);

if (argv.includes("/usage")) {
  fs.appendFileSync(process.env.FAKE_CLAUDE_USAGE_LOG, JSON.stringify(argv) + NL);
  fs.appendFileSync(process.env.FAKE_CLAUDE_USAGE_PIDS, String(process.pid) + NL);
  const mode = process.env.FAKE_CLAUDE_USAGE_MODE || "at-41";
  if (mode === "hang") {
    // Never answers, never exits: the guard's own timeout must kill this
    // whole group and degrade to "could not read the quota".
    setInterval(() => {}, 1000);
  } else if (mode === "exit") {
    process.stderr.write("claude: /usage failed (not logged in)" + NL);
    process.exit(7);
  } else if (mode === "garbage") {
    process.stdout.write("Usage: claude [options] [command]" + NL);
    process.exit(0);
  } else {
    // The REAL /usage answer shape (measured 2026-08-11): prose in the json
    // envelope's result field, zero cost, zero turns, no model called.
    const percent = mode.indexOf("at-") === 0 ? mode.slice(3) : "41";
    process.stdout.write(JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Current session: " + percent + "% used \\u00b7 resets Aug 11, 1:59pm (Asia/Tokyo)" + NL +
        "Current week (all models): 37% used \\u00b7 resets Aug 16, 1:59am (Asia/Tokyo)" + NL +
        "Current week (Fable): 42% used \\u00b7 resets Aug 16, 1:59am (Asia/Tokyo)",
      session_id: null,
      usage: {},
      total_cost_usd: 0,
      duration_ms: 450,
      duration_api_ms: 0,
      num_turns: 0,
    }));
    process.exit(0);
  }
} else {
  fs.readFileSync(0, "utf8");
  fs.appendFileSync(process.env.FAKE_CLAUDE_WORKER_LOG, JSON.stringify(argv) + NL);
  process.stdout.write(JSON.stringify({
    type: "result",
    is_error: false,
    result: "implemented the thing per the brief",
    session_id: "claude-guard-session-1",
    usage: { input_tokens: 10, output_tokens: 5 },
    total_cost_usd: 0.001,
    duration_ms: 10,
    num_turns: 1,
  }) + NL);
  process.exit(0);
}
`;

const FAKE_AGY_FOR_GUARD_SOURCE = `#!/usr/bin/env node
import fs from "node:fs";

const NL = String.fromCharCode(10);
fs.appendFileSync(process.env.FAKE_AGY_ARGS_LOG, JSON.stringify(process.argv.slice(2)) + NL);
process.stdout.write(JSON.stringify({
  conversation_id: "6f5f0f1e-0000-4a1b-9c2d-1122334455aa",
  status: "SUCCESS",
  response: "implemented the thing per the brief",
  duration_seconds: 1.5,
  num_turns: 1,
  usage: { input_tokens: 10, output_tokens: 5 },
}));
process.exit(0);
`;

/**
 * A dispatch sandbox for the guard: a temp state root whose config.json is
 * whatever the test says (or absent), and a fake claude that answers the
 * /usage probe per FAKE_CLAUDE_USAGE_MODE.
 */
function guardContext({ config = {}, usageMode = "at-41" } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-claude-guard-"));
  const binPath = path.join(tmp, "fake-claude.mjs");
  fs.writeFileSync(binPath, FAKE_GUARD_CLAUDE_SOURCE, "utf8");
  fs.chmodSync(binPath, 0o755);
  const agyBinPath = path.join(tmp, "fake-agy.mjs");
  fs.writeFileSync(agyBinPath, FAKE_AGY_FOR_GUARD_SOURCE, "utf8");
  fs.chmodSync(agyBinPath, 0o755);

  const usageLog = path.join(tmp, "usage.ndjson");
  const usagePids = path.join(tmp, "usage.pids");
  const workerLog = path.join(tmp, "worker.ndjson");
  const agyArgsLog = path.join(tmp, "agy-args.ndjson");
  for (const file of [usageLog, usagePids, workerLog, agyArgsLog]) fs.writeFileSync(file, "", "utf8");

  const stateRootDir = path.join(tmp, "state");
  fs.mkdirSync(stateRootDir, { recursive: true });
  if (config !== null) {
    fs.writeFileSync(path.join(stateRootDir, "config.json"), JSON.stringify(config, null, 2), "utf8");
  }

  const cwd = path.join(tmp, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const mcpSource = path.join(tmp, "claude.json");
  fs.writeFileSync(mcpSource, JSON.stringify({ mcpServers: { sunaba: SUNABA_MCP } }), "utf8");

  const saved = {
    CLAUDE_BIN: process.env.CLAUDE_BIN,
    AGY_BIN: process.env.AGY_BIN,
    KUSABI_STATE_DIR: process.env.KUSABI_STATE_DIR,
    KUSABI_CLAUDE_MCP_SOURCE: process.env.KUSABI_CLAUDE_MCP_SOURCE,
    KUSABI_CLAUDE_USAGE_PROBE_TIMEOUT_MS: process.env.KUSABI_CLAUDE_USAGE_PROBE_TIMEOUT_MS,
    FAKE_CLAUDE_USAGE_MODE: process.env.FAKE_CLAUDE_USAGE_MODE,
    FAKE_CLAUDE_USAGE_LOG: process.env.FAKE_CLAUDE_USAGE_LOG,
    FAKE_CLAUDE_USAGE_PIDS: process.env.FAKE_CLAUDE_USAGE_PIDS,
    FAKE_CLAUDE_WORKER_LOG: process.env.FAKE_CLAUDE_WORKER_LOG,
    FAKE_AGY_ARGS_LOG: process.env.FAKE_AGY_ARGS_LOG,
  };
  process.env.CLAUDE_BIN = binPath;
  process.env.AGY_BIN = agyBinPath;
  process.env.KUSABI_STATE_DIR = stateRootDir;
  process.env.KUSABI_CLAUDE_MCP_SOURCE = mcpSource;
  // The hang test must not sit out the real 5s bound.
  process.env.KUSABI_CLAUDE_USAGE_PROBE_TIMEOUT_MS = "400";
  process.env.FAKE_CLAUDE_USAGE_MODE = usageMode;
  process.env.FAKE_CLAUDE_USAGE_LOG = usageLog;
  process.env.FAKE_CLAUDE_USAGE_PIDS = usagePids;
  process.env.FAKE_CLAUDE_WORKER_LOG = workerLog;
  process.env.FAKE_AGY_ARGS_LOG = agyArgsLog;

  const lines = (file) => {
    const text = fs.readFileSync(file, "utf8").trim();
    return text ? text.split("\n").filter(Boolean) : [];
  };

  return {
    tmp,
    cwd,
    binPath,
    stateDir: stateDirFor(cwd),
    probes: () => lines(usageLog).map((l) => JSON.parse(l)),
    probePids: () => lines(usagePids).map(Number),
    workerRuns: () => lines(workerLog).map((l) => JSON.parse(l)),
    agyRuns: () => lines(agyArgsLog).map((l) => JSON.parse(l)),
    dispatchOptions(overrides = {}) {
      return {
        cwd,
        kind: "task",
        title: "session guard test",
        promptText: "Do the thing.",
        agent: "kusabi-implement",
        phase: "implement",
        tools: null,
        timeoutS: 20,
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
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

describe("claudeDispatch — pre-dispatch session-quota guard (kusabi #215)", () => {
  let ctx;

  afterEach(() => {
    if (ctx) ctx.restore();
    ctx = null;
  });

  it("criterion 1: at 95% the dispatch is REFUSED before any worker is spawned", async () => {
    ctx = guardContext({ config: {}, usageMode: "at-95" });

    const { job, resultText, stateDir } = await claudeDispatch(ctx.dispatchOptions());

    // The probe ran exactly once, with the measured control-plane argv...
    assert.deepEqual(ctx.probes(), [["-p", "--output-format", "json", "/usage"]]);
    // ...and the worker binary was NEVER invoked: nothing was spent.
    assert.deepEqual(ctx.workerRuns(), []);
    assert.equal(job.process, null, "no child was spawned, so there is no pid to record");
    assert.equal(resultText, "");

    // Finalised as a session-quota failure through the EXISTING machinery, so
    // the chain's provider-exhaustion stop needs no new logic.
    assert.equal(job.status, "provider-error");
    assert.deepEqual(job.failure, {
      kind: "quota-exhaustion",
      quota: "session",
      backendBlocked: true,
      reset: "Aug 11, 1:59pm (Asia/Tokyo)",
    });

    // The error text names the guard, the reading, the reset and the advice.
    assert.match(job.error, /pre-dispatch session-quota guard refused/);
    assert.match(job.error, /95% of the claude session window already used/);
    assert.match(job.error, /refuse at 90%/);
    assert.match(job.error, /No worker was started/);
    assert.match(job.error, /session limit exhausted \(resets Aug 11, 1:59pm \(Asia\/Tokyo\)\)/);
    assert.match(job.error, /Switch the phase to the opencode backend/);
    // It must not read as a mid-run death.
    assert.ok(!/exited with code/.test(job.error), job.error);

    // The observation is on the record, machine-readable.
    assert.equal(job.sessionGuard.decision, "refused");
    assert.equal(job.sessionGuard.percent, 95);
    assert.equal(job.sessionGuard.threshold, 90);
    assert.equal(job.sessionGuard.readable, true);
    assert.equal(job.sessionGuard.reason, null);
    assert.equal(job.sessionGuard.reset, "Aug 11, 1:59pm (Asia/Tokyo)");
    assert.equal(typeof job.sessionGuard.observedAt, "string");

    // And persisted, with the finishedAt of a job that is over.
    const persisted = loadJob(stateDir, job.id);
    assert.equal(persisted.status, "provider-error");
    assert.equal(persisted.sessionGuard.decision, "refused");
    assert.deepEqual(persisted.failure, job.failure);
    assert.equal(typeof persisted.finishedAt, "string");
    assert.equal(persisted.stats.events, 0);
    // kusabi #388: the closed terminal reason is stamped on the session-quota
    // guard refusal (capacity exhaustion -> "quota-exhausted").
    assert.equal(job.stopReason, "quota-exhausted");
    assert.equal(persisted.stopReason, "quota-exhausted");
    // No result.md: nothing produced a result.
    assert.equal(fs.existsSync(path.join(jobDir(stateDir, job.id), "result.md")), false);
    // The prompt is still on disk — a refused dispatch is auditable.
    assert.equal(fs.readFileSync(path.join(jobDir(stateDir, job.id), "prompt.md"), "utf8"), "Do the thing.");

    // The events trail shows the observation AND the refusal.
    const events = readJobEvents(stateDir, job.id);
    assert.deepEqual(events.map((e) => e.type), [
      "companion.claude.dispatch",
      "companion.claude.session-guard",
      "companion.claude.dispatch-refused",
      "companion.claude.finished",
    ]);
    const observed = events.find((e) => e.type === "companion.claude.session-guard");
    assert.equal(observed.percent, 95);
    assert.equal(observed.threshold, 90);
    assert.equal(observed.decision, "refused");
    const refused = events.find((e) => e.type === "companion.claude.dispatch-refused");
    assert.equal(refused.reason, "session-quota-guard");
    assert.equal(refused.percent, 95);
    assert.equal(refused.reset, "Aug 11, 1:59pm (Asia/Tokyo)");
    const finished = events.find((e) => e.type === "companion.claude.finished");
    assert.equal(finished.status, "provider-error");
    assert.equal(finished.spawned, false, "the trail must say no worker ran");
    assert.equal(finished.exitCode, null);
  });

  it("criterion 2: at 41% the dispatch proceeds, carrying what the guard saw", async () => {
    ctx = guardContext({ config: {}, usageMode: "at-41" });

    const { job, resultText, stateDir } = await claudeDispatch(ctx.dispatchOptions());

    assert.equal(job.status, "completed");
    assert.equal(resultText, "implemented the thing per the brief");
    assert.equal(ctx.probes().length, 1);
    assert.equal(ctx.workerRuns().length, 1, "the worker must run");
    assert.equal(job.failure, null);

    assert.equal(job.sessionGuard.decision, "proceeded");
    assert.equal(job.sessionGuard.percent, 41);
    assert.equal(job.sessionGuard.threshold, 90);
    assert.equal(job.sessionGuard.readable, true);
    assert.equal(job.sessionGuard.reset, "Aug 11, 1:59pm (Asia/Tokyo)");

    const persisted = loadJob(stateDir, job.id);
    assert.equal(persisted.sessionGuard.percent, 41);
    assert.equal(persisted.sessionGuard.decision, "proceeded");

    const events = readJobEvents(stateDir, job.id);
    const observed = events.find((e) => e.type === "companion.claude.session-guard");
    assert.equal(observed.percent, 41);
    assert.equal(observed.decision, "proceeded");
    assert.ok(!events.some((e) => e.type === "companion.claude.dispatch-refused"));
  });

  it("criterion 3a: a probe that exits nonzero → proceed, quota unreadable", async () => {
    ctx = guardContext({ config: {}, usageMode: "exit" });

    const { job } = await claudeDispatch(ctx.dispatchOptions());

    assert.equal(job.status, "completed");
    assert.equal(ctx.workerRuns().length, 1);
    assert.equal(job.sessionGuard.decision, "proceeded");
    assert.equal(job.sessionGuard.readable, false);
    assert.equal(job.sessionGuard.percent, null);
    assert.equal(job.sessionGuard.reason, "exit-nonzero");
    assert.match(job.sessionGuard.detail, /exited with code 7/);
    assert.match(job.sessionGuard.detail, /not logged in/);
    assert.equal(job.failure, null);
  });

  it("criterion 3b: a probe that prints garbage → proceed, quota unreadable", async () => {
    ctx = guardContext({ config: {}, usageMode: "garbage" });

    const { job, stateDir } = await claudeDispatch(ctx.dispatchOptions());

    assert.equal(job.status, "completed");
    assert.equal(ctx.workerRuns().length, 1);
    assert.equal(job.sessionGuard.readable, false);
    assert.equal(job.sessionGuard.reason, "unparsed");
    assert.match(job.sessionGuard.detail, /Current session/);
    assert.match(job.sessionGuard.detail, /Usage: claude/);
    const observed = readJobEvents(stateDir, job.id).find((e) => e.type === "companion.claude.session-guard");
    assert.equal(observed.readable, false);
    assert.equal(observed.decision, "proceeded");
  });

  it("criterion 3c: a probe that hangs is killed and → proceed, quota unreadable", async () => {
    ctx = guardContext({ config: {}, usageMode: "hang" });

    const started = Date.now();
    const { job } = await claudeDispatch(ctx.dispatchOptions());
    const elapsed = Date.now() - started;

    assert.equal(job.status, "completed");
    assert.equal(ctx.workerRuns().length, 1);
    assert.equal(job.sessionGuard.readable, false);
    assert.equal(job.sessionGuard.reason, "timeout");
    assert.match(job.sessionGuard.detail, /did not answer within 400ms/);
    assert.equal(job.sessionGuard.percent, null);
    assert.equal(job.sessionGuard.decision, "proceeded");
    // The bound is real: the dispatch was not held up for the 20s timeoutS.
    assert.ok(elapsed < 15000, `the guard must not hold the dispatch open: ${elapsed}ms`);
    // And the hung probe is not still sitting in the operator's session.
    const pids = ctx.probePids();
    assert.equal(pids.length, 1);
    assert.equal(isAlive(pids[0]), false, "a killed probe must not leak a process");
  });

  it("criterion 4: the guard disabled by config → no probe at all, trail unchanged", async () => {
    ctx = guardContext({ config: { claude: { sessionGuardPercent: false } }, usageMode: "at-95" });

    const { job, resultText, stateDir } = await claudeDispatch(ctx.dispatchOptions());

    assert.deepEqual(ctx.probes(), [], "a disabled guard must not spawn the probe");
    assert.equal(ctx.workerRuns().length, 1);
    assert.equal(job.status, "completed");
    assert.equal(resultText, "implemented the thing per the brief");
    assert.equal(job.sessionGuard, null);
    // Byte-identical trail to a pre-#215 dispatch.
    assert.deepEqual(readJobEvents(stateDir, job.id).map((e) => e.type), [
      "companion.claude.dispatch",
      "companion.claude.finished",
    ]);
  });

  it("criterion 4: threshold 0 disables it too", async () => {
    ctx = guardContext({ config: { claude: { sessionGuardPercent: 0 } }, usageMode: "at-95" });

    const { job } = await claudeDispatch(ctx.dispatchOptions());

    assert.deepEqual(ctx.probes(), []);
    assert.equal(job.status, "completed");
    assert.equal(job.sessionGuard, null);
  });

  it("a workspace with no config.json at all is left byte-identical (documented boundary)", async () => {
    ctx = guardContext({ config: null, usageMode: "at-95" });

    const { job } = await claudeDispatch(ctx.dispatchOptions());

    assert.deepEqual(ctx.probes(), []);
    assert.equal(job.status, "completed");
    assert.equal(job.sessionGuard, null);
  });

  it("criterion 5: a custom threshold is honored — 50 refuses at 60%", async () => {
    ctx = guardContext({ config: { claude: { sessionGuardPercent: 50 } }, usageMode: "at-60" });

    const { job } = await claudeDispatch(ctx.dispatchOptions());

    assert.equal(job.status, "provider-error");
    assert.deepEqual(ctx.workerRuns(), []);
    assert.equal(job.sessionGuard.threshold, 50);
    assert.equal(job.sessionGuard.percent, 60);
    assert.match(job.error, /60% of the claude session window already used/);
    assert.match(job.error, /refuse at 50%/);
    assert.equal(job.failure.quota, "session");
    assert.equal(job.failure.backendBlocked, true);
  });

  it("criterion 5: the same custom threshold still lets 41% through", async () => {
    ctx = guardContext({ config: { claude: { sessionGuardPercent: 50 } }, usageMode: "at-41" });

    const { job } = await claudeDispatch(ctx.dispatchOptions());

    assert.equal(job.status, "completed");
    assert.equal(ctx.workerRuns().length, 1);
    assert.equal(job.sessionGuard.decision, "proceeded");
    assert.equal(job.sessionGuard.threshold, 50);
  });

  it("negative control: the SAME 95% fake dispatches normally with the guard off", async () => {
    // The refusal above must be caused by the guard and by nothing else in
    // the fixture: same binary, same 95% answer, guard disabled → the worker
    // runs and the job completes.
    ctx = guardContext({ config: { claude: { sessionGuardPercent: false } }, usageMode: "at-95" });

    const { job } = await claudeDispatch(ctx.dispatchOptions());

    assert.equal(job.status, "completed");
    assert.notEqual(job.status, "provider-error");
    assert.equal(job.failure, null);
    assert.equal(ctx.workerRuns().length, 1, "with the guard off, the 95% window does not stop the worker");
    assert.deepEqual(ctx.probes(), []);
  });

  it("criterion 6: the agy backend is never probed, even with the guard enabled", async () => {
    ctx = guardContext({ config: { claude: { sessionGuardPercent: 90 } }, usageMode: "at-95" });

    const { job } = await agyDispatch({
      ...ctx.dispatchOptions(),
      agent: "kusabi-implement",
      tiers: [["gemini-3.6-flash-high"]],
    });

    assert.equal(job.status, "completed");
    assert.equal(job.backend, "agy");
    assert.equal(ctx.agyRuns().length, 1, "the agy worker must run");
    // The claude control plane was not touched: agy is a separate wallet.
    assert.deepEqual(ctx.probes(), []);
    assert.deepEqual(ctx.workerRuns(), []);
    assert.equal(job.sessionGuard, undefined, "the agy record has no claude guard field");
  });

  it("criterion 6: the opencode dispatch path knows nothing about the guard", () => {
    // The opencode backend is a different account, so its dispatch must not
    // reach the claude session guard at all.  Asserted at the module boundary
    // (prompt-execution.mjs imports nothing from claude-dispatch.mjs), which
    // is what makes the "no probe on that path" claim structural rather than
    // a property of one scenario.
    const source = fs.readFileSync(new URL("./prompt-execution.mjs", import.meta.url), "utf8");
    assert.ok(!source.includes("claude-dispatch.mjs"), "the opencode dispatch must not import the claude dispatch");
    assert.ok(!source.includes("/usage"), "the opencode dispatch must not run the /usage probe");
    assert.ok(!source.includes("sessionGuard"), "the opencode dispatch must not carry the guard");
  });
});

// =========================================================================
// write-tool watchdog (kusabi #215 item 3)
// =========================================================================
//
// The incident this exists for: an implement-phase claude job that ran 256s,
// cost $2.39 and produced ZERO edits — chatty, busy, and holding the silence
// watchdog off the whole time by reading files.

describe("resolveClaudeWriteWatchdog", () => {
  it("no config, and a config without the key, leave the feature entirely OFF", () => {
    for (const absent of [null, undefined, "nope", [1, 2]]) {
      const w = resolveClaudeWriteWatchdog(absent);
      assert.deepEqual(w, { enabled: false, warnS: null, killS: null, reason: "no-config" });
    }
    for (const config of [{}, { models: { chain: [["opus"]] } }, { claude: {} }, { claude: "yes" }, { claude: null }]) {
      const w = resolveClaudeWriteWatchdog(config);
      assert.equal(w.enabled, false, `expected ${JSON.stringify(config)} to leave the watchdog off`);
      assert.equal(w.reason, "absent");
      assert.equal(w.warnS, null);
      assert.equal(w.killS, null);
    }
  });

  it("false disables explicitly; true is warn-only at the default warn bound", () => {
    assert.deepEqual(
      resolveClaudeWriteWatchdog({ claude: { writeWatchdog: false } }),
      { enabled: false, warnS: null, killS: null, reason: "disabled" },
    );
    assert.deepEqual(
      resolveClaudeWriteWatchdog({ claude: { writeWatchdog: true } }),
      { enabled: true, warnS: CLAUDE_WRITE_WATCHDOG_DEFAULT_WARN_S, killS: null, reason: "default" },
    );
    assert.equal(CLAUDE_WRITE_WATCHDOG_DEFAULT_WARN_S, 300);
  });

  it("0 (and any negative number) at the section level is OFF — the session guard's convention", () => {
    // An operator who disables the sibling session guard with 0 and mirrors
    // the shape here must not silently arm a watchdog (cross-review [low],
    // chain-msojs3cvdf4a).
    for (const raw of [0, -1, -300, "0", "-1", "-300"]) {
      assert.deepEqual(
        resolveClaudeWriteWatchdog({ claude: { writeWatchdog: raw } }),
        { enabled: false, warnS: null, killS: null, reason: "disabled" },
        `expected writeWatchdog: ${raw} to disable the feature`,
      );
    }
  });

  it("warnS alone is warn-only; a LATER killS warns then kills", () => {
    assert.deepEqual(
      resolveClaudeWriteWatchdog({ claude: { writeWatchdog: { warnS: 120 } } }),
      { enabled: true, warnS: 120, killS: null, reason: "configured" },
    );
    assert.deepEqual(
      resolveClaudeWriteWatchdog({ claude: { writeWatchdog: { warnS: 300, killS: 900 } } }),
      { enabled: true, warnS: 300, killS: 900, reason: "configured" },
    );
    // A JSON config may carry the numbers as strings; they still read.
    assert.deepEqual(
      resolveClaudeWriteWatchdog({ claude: { writeWatchdog: { warnS: "120", killS: "240" } } }),
      { enabled: true, warnS: 120, killS: 240, reason: "configured" },
    );
    // killS with no warnS: the warn bound defaults (an ABSENT warnS is not a
    // malformed one), and the configured kill is honored on top of it.
    assert.deepEqual(
      resolveClaudeWriteWatchdog({ claude: { writeWatchdog: { killS: 900 } } }),
      { enabled: true, warnS: CLAUDE_WRITE_WATCHDOG_DEFAULT_WARN_S, killS: 900, reason: "configured" },
    );
  });

  it("killS absent or 0 is warn-only — killing is opt-in ON TOP of warning", () => {
    for (const raw of [{ warnS: 60 }, { warnS: 60, killS: 0 }, { warnS: 60, killS: null }]) {
      const w = resolveClaudeWriteWatchdog({ claude: { writeWatchdog: raw } });
      assert.equal(w.enabled, true, `expected ${JSON.stringify(raw)} to stay armed`);
      assert.equal(w.warnS, 60);
      assert.equal(w.killS, null, `expected ${JSON.stringify(raw)} to be warn-only`);
    }
  });

  it("killS <= warnS is DROPPED to warn-only, never normalized upward", () => {
    // Normalizing would kill a job on a bound the operator never wrote; the
    // watchdog's contract is warn-BEFORE-kill, so a kill that cannot come
    // after the warning is removed instead of moved.
    for (const killS of [60, 30, 1]) {
      const w = resolveClaudeWriteWatchdog({ claude: { writeWatchdog: { warnS: 60, killS } } });
      assert.deepEqual(w, { enabled: true, warnS: 60, killS: null, reason: "kill-not-after-warn" });
    }
  });

  it("a malformed value NEVER yields a killing configuration", () => {
    // A malformed threshold must not silently arm a destructive action —
    // this deliberately differs from the session guard's "malformed →
    // default ON": refusing a dispatch is conservative, killing is not.
    const malformed = ["soon", -5, true, {}, [], NaN, "", 0];
    for (const warnS of malformed) {
      const w = resolveClaudeWriteWatchdog({ claude: { writeWatchdog: { warnS, killS: 900 } } });
      assert.equal(w.enabled, true, `warnS ${JSON.stringify(warnS)} must keep the warning`);
      assert.equal(w.warnS, CLAUDE_WRITE_WATCHDOG_DEFAULT_WARN_S);
      assert.equal(w.killS, null, `warnS ${JSON.stringify(warnS)} must never leave a kill armed`);
      assert.equal(w.reason, "malformed-setting");
    }
    for (const killS of ["soon", -5, true, {}, [], NaN, ""]) {
      const w = resolveClaudeWriteWatchdog({ claude: { writeWatchdog: { warnS: 120, killS } } });
      assert.equal(w.enabled, true, `killS ${JSON.stringify(killS)} must keep the warning`);
      assert.equal(w.warnS, 120, "a readable warnS survives an unreadable killS");
      assert.equal(w.killS, null, `killS ${JSON.stringify(killS)} must never arm a kill`);
      assert.equal(w.reason, "malformed-setting");
    }
    // The whole section in a shape this does not understand: the operator
    // asked for the feature, so honor the ask at its safest setting.
    for (const raw of ["yes", 900, [300, 900]]) {
      const w = resolveClaudeWriteWatchdog({ claude: { writeWatchdog: raw } });
      assert.deepEqual(w, {
        enabled: true, warnS: CLAUDE_WRITE_WATCHDOG_DEFAULT_WARN_S, killS: null, reason: "malformed-setting",
      });
    }
  });
});

describe("writeWatchdogAppliesToPhase", () => {
  it("is armed for implement only — every read-shaped phase is exempt", () => {
    assert.equal(writeWatchdogAppliesToPhase("implement"), true);
    for (const phase of ["review", "investigate", "draft", "respond", "salvage", "gofer", "strategize"]) {
      assert.equal(writeWatchdogAppliesToPhase(phase), false, `${phase} must never trip the write watchdog`);
    }
  });

  it("no phase at all is off, never on", () => {
    for (const phase of [null, undefined, "", 0, {}]) {
      assert.equal(writeWatchdogAppliesToPhase(phase), false);
    }
  });

  it("test-author is armed — its deliverable is a test file edit (kusabi #408)", () => {
    // plan stays out: it is read-only and legitimately never writes.
    assert.equal(writeWatchdogAppliesToPhase("test-author"), true);
    assert.equal(writeWatchdogAppliesToPhase("plan"), false, "plan must never trip the write watchdog");
  });

  it("chain rework rounds dispatch under the phase name 'implement'", () => {
    // The gate is only correct if rework rounds carry the phase it names.
    // runImplementPhase (chain-phases.mjs) dispatches EVERY implement round —
    // round 1 and every rework round — with phase: "implement"; the
    // `models.phases.rework` config key selects a MODEL, it is not a
    // dispatch phase name.  Asserted at the source, so a future rename
    // cannot silently disarm the watchdog for rework rounds.
    const source = fs.readFileSync(new URL("./chain-phases.mjs", import.meta.url), "utf8");
    const dispatchPhases = [...source.matchAll(/phase: "([a-z]+)"/g)].map((m) => m[1]);
    assert.ok(dispatchPhases.includes("implement"), "chain-phases must dispatch an implement phase");
    assert.ok(!dispatchPhases.includes("rework"), "no dispatch uses a distinct 'rework' phase name");
  });
});

describe("isClaudeWriteToolName / eventHasClaudeWriteTool", () => {
  it("counts the sunaba mutators and the native editing tools", () => {
    for (const name of [
      "mcp__sunaba__write_file", "mcp__sunaba__edit_file", "mcp__sunaba__transform_file",
      "mcp__sunaba__undo_file_edit", "mcp__sunaba__checkpoint_restore",
      "Write", "Edit", "MultiEdit", "NotebookEdit",
    ]) {
      assert.equal(isClaudeWriteToolName(name), true, `${name} must count as a write`);
    }
    // The prefix is stripped, so a differently-named MCP server still counts.
    assert.equal(isClaudeWriteToolName("mcp__other__edit_file"), true);
    assert.equal(isClaudeWriteToolName("edit_file"), true);
  });

  it("does NOT count reads, searches, execs, or a plain checkpoint", () => {
    for (const name of [
      "mcp__sunaba__read_file_range", "mcp__sunaba__search_in_container", "mcp__sunaba__list_files",
      "mcp__sunaba__sandbox_exec", "mcp__sunaba__verify_in_container", "mcp__sunaba__diff_in_container",
      "mcp__sunaba__issue_view", "mcp__sunaba__checkpoint", "Read", "Grep", "Bash", "Skill",
      "", null, undefined, 42, {},
    ]) {
      assert.equal(isClaudeWriteToolName(name), false, `${JSON.stringify(name)} must not count as a write`);
    }
  });

  it("reads the same tool_use path applyClaudeStreamEvent folds", () => {
    const assistant = (names) => ({
      type: "assistant",
      message: { model: "claude-sonnet-4-5", content: names.map((name, i) => ({ type: "tool_use", id: `t${i}`, name })) },
    });
    assert.equal(eventHasClaudeWriteTool(assistant(["mcp__sunaba__edit_file"])), true);
    // One write among many reads still counts.
    assert.equal(eventHasClaudeWriteTool(assistant([
      "mcp__sunaba__read_file_range", "mcp__sunaba__search_in_container", "mcp__sunaba__write_file",
    ])), true);
    assert.equal(eventHasClaudeWriteTool(assistant(["mcp__sunaba__read_file_range"])), false);
    // Non-assistant events, and junk, are never writes and never throw.
    for (const evt of [
      { type: "system", subtype: "init" },
      { type: "result", is_error: false },
      { type: "assistant" },
      { type: "assistant", message: { content: "not an array" } },
      { type: "assistant", message: { content: [null, "text", { type: "text", text: "edit_file" }] } },
      null, undefined, "assistant", 7,
    ]) {
      assert.equal(eventHasClaudeWriteTool(evt), false);
    }
  });
});

describe("renderClaudeWriteWatchdogError", () => {
  it("is distinct from the silence watchdog's wording", () => {
    assert.equal(
      renderClaudeWriteWatchdogError(900),
      "write-watchdog: no write-tool call for 900s on an implement phase (process killed)",
    );
    assert.notEqual(renderClaudeWriteWatchdogError(900), "watchdog: no events for 900s (process killed)");
  });
});

describe("runClaudeProcess — write watchdog", () => {
  it("a child that exits before the 250ms poll still gets its warning", async () => {
    // The polled interval can be beaten to the finish line — a descheduled
    // parent can receive the child's whole output together with its exit,
    // and the close callback clears the interval before the timers phase
    // runs.  The warning is an audit fact about the run, not a property of
    // scheduler luck, so a short-lived child that never wrote anything must
    // still produce EXACTLY one warning (whichever path observed it).
    // A child that lives ~120ms against a 10ms warn bound: a margin no
    // scheduling outcome closes, and well inside the 250ms poll, so this
    // normally exercises the close-time reading rather than the interval.
    const seen = [];
    const result = await runClaudeProcess({
      bin: process.execPath,
      args: ["-e", "setTimeout(() => {}, 120)"],
      timeoutS: 20,
      watchdogS: 0,
      promptText: "",
      writeWatchdog: { warnS: 0.01, killS: null },
      onWriteWatchdog: (e) => seen.push(e),
    });
    assert.equal(result.spawnError, null, "the child must have started for this to say anything");
    assert.equal(result.writeStalled, false, "warn-only must never kill");
    assert.deepEqual(seen.map((e) => e.kind), ["warned"]);
  });

  it("no writeWatchdog option means no clock, no warning, no kill", async () => {
    const seen = [];
    const result = await runClaudeProcess({
      bin: process.execPath,
      args: ["-e", "setTimeout(() => {}, 120)"],
      timeoutS: 20,
      watchdogS: 0,
      promptText: "",
      onWriteWatchdog: (e) => seen.push(e),
    });
    assert.deepEqual(seen, []);
    assert.equal(result.writeStalled, false);
  });
});

describe("claudeDispatch — write-tool watchdog (kusabi #215 item 3)", () => {
  let ctx;

  afterEach(() => {
    if (ctx) {
      ctx.restore();
      fs.rmSync(ctx.tmp, { recursive: true, force: true });
    }
    ctx = null;
  });

  // Every config below disables the SESSION guard explicitly: it reads the
  // same config.json, and a config file WITHOUT `sessionGuardPercent` turns
  // it on at the default threshold — which would spawn a /usage probe these
  // tests are not about (and would sit out the probe timeout on the
  // never-terminating fakes).
  const withWatchdog = (writeWatchdog) => ({ claude: { sessionGuardPercent: false, writeWatchdog } });

  // Diagnostic context for write-watchdog test failures (kusabi #288).
  // Carries enough information to diagnose without reproducing: the full
  // event list, the on-disk record (distinguishing absent from null),
  // wall time, fixture configuration, and terminal job state.
  function writeWatchdogDiag({ events, stateDir, jobId, job, wallMs, ticks, intervalMs }) {
    let onDiskInfo;
    try {
      const onDisk = loadJob(stateDir, jobId);
      if (!onDisk || typeof onDisk !== "object") {
        onDiskInfo = "writeWatchdog=<record unreadable: not an object>";
      } else if (!("writeWatchdog" in onDisk)) {
        onDiskInfo = "writeWatchdog=undefined (key absent)";
      } else if (onDisk.writeWatchdog === null) {
        onDiskInfo = "writeWatchdog=null (key present)";
      } else {
        onDiskInfo = `writeWatchdog=${JSON.stringify(onDisk.writeWatchdog)} (key present)`;
      }
    } catch (err) {
      onDiskInfo = `writeWatchdog=<record unreadable: ${err?.message || err}>`;
    }
    return [
      `events=${JSON.stringify(events)}`,
      onDiskInfo,
      `wallMs=${wallMs} ticks=${ticks} intervalMs=${intervalMs}`,
      `status=${job?.status} error=${JSON.stringify(job?.error)}`,
    ].join(", ");
  }

  it("criterion 3: warn then kill on an implement phase whose stream never writes", async () => {
    const TICKS = 12;
    const INTERVAL_MS = 200;
    const start = Date.now();
    ctx = fakeClaudeContext("no-write", { config: withWatchdog({ warnS: 1, killS: 2 }) });
    const { job } = await claudeDispatch(ctx.dispatchOptions({ phase: "implement", timeoutS: 30, watchdogS: 900 }));
    const wallMs = Date.now() - start;

    assert.equal(job.status, "stalled");
    assert.equal(job.error, "write-watchdog: no write-tool call for 2s on an implement phase (process killed)");

    const events = writeWatchdogEvents(ctx.stateDir, job.id);
    const diag = writeWatchdogDiag({ events, stateDir: ctx.stateDir, jobId: job.id, job, wallMs, ticks: TICKS, intervalMs: INTERVAL_MS });
    assert.ok(events.length >= 2, `warn-then-kill expects 2+ events — got ${events.length}; ${diag}`);
    assert.deepEqual(events.map((e) => e.type), [
      "companion.write-watchdog.warned",
      "companion.write-watchdog.fired",
      "companion.write-watchdog.kill",
    ], diag);
    assert.ok(events[0].idleS >= 1, `warned event must carry the measured idle seconds, got ${events[0].idleS}; ${diag}`);
    assert.equal(events[0].warnS, 1);
    assert.equal(events[0].killS, 2);
    assert.equal(events[0].phase, "implement");
    assert.ok(events[1].idleS >= 2, `fired event must carry the measured idle seconds, got ${events[1].idleS}; ${diag}`);

    // The SILENCE watchdog must not claim this stall: its clock was being
    // reset by the read events the whole time.
    assert.deepEqual(watchdogEvents(ctx.stateDir, job.id), []);

    // Recorded on the job, and on disk.
    assert.equal(job.writeWatchdog.warned, true);
    assert.equal(job.writeWatchdog.killed, true);
    assert.equal(job.writeWatchdog.warnS, 1);
    assert.equal(job.writeWatchdog.killS, 2);
    assert.equal(loadJob(ctx.stateDir, job.id).status, "stalled");

    // The whole process group is dead, exactly as the silence watchdog leaves it.
    for (const pid of spawnedPids(ctx.pidsLog)) {
      assert.equal(isAlive(pid), false, `pid ${pid} must be dead after the write-watchdog group kill`);
    }
  });

  it("criterion 4: a write-tool call resets the clock — a writing worker never warns", async () => {
    // Writes every 200ms for ~2.4s under warnS: 1 / killS: 2 — bounds this
    // run would trip many times over if the clock did not reset.
    ctx = fakeClaudeContext("writes", { config: withWatchdog({ warnS: 1, killS: 2 }) });
    const { job } = await claudeDispatch(ctx.dispatchOptions({ phase: "implement", timeoutS: 30, watchdogS: 900 }));

    assert.equal(job.status, "completed");
    assert.deepEqual(writeWatchdogEvents(ctx.stateDir, job.id), []);
    assert.equal(job.writeWatchdog.warned, false);
    assert.equal(job.writeWatchdog.killed, false);
    assert.equal(job.stats.lastTool, "mcp__sunaba__edit_file");
  });

  it("criterion 5: the same config on a review-phase job never arms the watchdog", async () => {
    // Identical stream and identical config as the warn-only case below —
    // ONLY the phase differs, so the phase gate is what is under test.
    ctx = fakeClaudeContext("no-write-then-finish", { config: withWatchdog({ warnS: 1, killS: 2 }) });
    const { job } = await claudeDispatch(ctx.dispatchOptions({ phase: "review", timeoutS: 30, watchdogS: 900 }));

    assert.equal(job.status, "completed");
    assert.deepEqual(writeWatchdogEvents(ctx.stateDir, job.id), []);
    assert.equal(job.writeWatchdog, undefined, "an unarmed dispatch records no watchdog field at all");
    assert.ok(!("writeWatchdog" in loadJob(ctx.stateDir, job.id)));
  });

  it("criterion 6: warn-only mode warns once and never kills", async () => {
    // Widen the margin: 40 ticks × 200ms = ~8s against warnS: 1 — the warn
    // window is ~7s (7× the threshold, clearing the 4× minimum).
    const savedTicks = process.env.FAKE_CLAUDE_TICKS;
    process.env.FAKE_CLAUDE_TICKS = "40";
    try {
      const TICKS = 40;
      const INTERVAL_MS = 200;
      const start = Date.now();
      ctx = fakeClaudeContext("no-write-then-finish", { config: withWatchdog({ warnS: 1 }) });
      const { job } = await claudeDispatch(ctx.dispatchOptions({ phase: "implement", timeoutS: 30, watchdogS: 900 }));
      const wallMs = Date.now() - start;

      // The run's own outcome, untouched by the warning.
      assert.equal(job.status, "completed");
      assert.equal(job.error, null);
      assert.equal(job.sessionID, "claude-cadence-1");

      const events = writeWatchdogEvents(ctx.stateDir, job.id);
      const diag = writeWatchdogDiag({ events, stateDir: ctx.stateDir, jobId: job.id, job, wallMs, ticks: TICKS, intervalMs: INTERVAL_MS });
      assert.ok(events.length >= 1, `warn-only warns EXACTLY once — got 0 events; ${diag}`);
      assert.deepEqual(events.map((e) => e.type), ["companion.write-watchdog.warned"], `warn-only warns EXACTLY once; ${diag}`);
      assert.equal(events[0].killS, null, diag);
      assert.equal(job.writeWatchdog.warned, true);
      assert.equal(job.writeWatchdog.killed, false);
      assert.ok(job.writeWatchdog.warnedAt, "the warning is timestamped on the record");
      assert.ok(job.writeWatchdog.idleS >= 1, diag);
      for (const pid of spawnedPids(ctx.pidsLog)) {
        // The fake exits on its own; nothing here killed it.
        assert.equal(isAlive(pid), false);
      }
    } finally {
      if (savedTicks === undefined) delete process.env.FAKE_CLAUDE_TICKS;
      else process.env.FAKE_CLAUDE_TICKS = savedTicks;
    }
  });

  it("criterion 1: a config WITHOUT the key leaves the dispatch and the record as they were", async () => {
    ctx = fakeClaudeContext("stream-full", { config: { claude: { sessionGuardPercent: false } } });
    const { job } = await claudeDispatch(ctx.dispatchOptions({ phase: "implement" }));

    assert.equal(job.status, "completed");
    assert.equal(job.writeWatchdog, undefined);
    assert.ok(!("writeWatchdog" in loadJob(ctx.stateDir, job.id)), "no new key on the on-disk record");
    assert.deepEqual(writeWatchdogEvents(ctx.stateDir, job.id), []);
  });

  it("criterion 1: no config file at all leaves the dispatch and the record as they were", async () => {
    ctx = fakeClaudeContext("stream-full");
    const { job } = await claudeDispatch(ctx.dispatchOptions({ phase: "implement" }));

    assert.equal(job.status, "completed");
    assert.equal(job.writeWatchdog, undefined);
    assert.ok(!("writeWatchdog" in loadJob(ctx.stateDir, job.id)));
    assert.deepEqual(writeWatchdogEvents(ctx.stateDir, job.id), []);
  });

  it("an explicitly disabled watchdog is off even on an implement phase", async () => {
    ctx = fakeClaudeContext("no-write-then-finish", { config: withWatchdog(false) });
    const { job } = await claudeDispatch(ctx.dispatchOptions({ phase: "implement", timeoutS: 30, watchdogS: 900 }));

    assert.equal(job.status, "completed");
    assert.equal(job.writeWatchdog, undefined);
    assert.deepEqual(writeWatchdogEvents(ctx.stateDir, job.id), []);
  });

  it("criterion 7: an ARMED write watchdog leaves the silence watchdog's own stall untouched", async () => {
    // A silent job with the write watchdog armed at bounds it cannot reach:
    // the silence watchdog must still fire first, with ITS status, ITS
    // wording and ITS events, and the write watchdog must add nothing.
    ctx = fakeClaudeContext("stall", { config: withWatchdog({ warnS: 60, killS: 120 }) });
    const { job } = await claudeDispatch(ctx.dispatchOptions({ phase: "implement", timeoutS: 30, watchdogS: 1 }));

    assert.equal(job.status, "stalled");
    assert.equal(job.error, "watchdog: no events for 1s (process killed)");
    assert.deepEqual(watchdogEvents(ctx.stateDir, job.id).map((e) => e.type), [
      "companion.watchdog.fired",
      "companion.watchdog.kill",
    ]);
    assert.deepEqual(writeWatchdogEvents(ctx.stateDir, job.id), []);
    assert.equal(job.writeWatchdog.killed, false);
  });
});
// =========================================================================
// repeat-tool watchdog (kusabi #234)
// =========================================================================
//
// The third sibling: the silence and write watchdogs both measure TIME, so
// a worker that repeats the SAME tool call with the SAME arguments holds
// both clocks off forever — chatty, writing, and saying the same thing
// every time.  This one counts consecutive identical calls — chain key
// `(tool name, deep-key-sorted JSON.stringify(input))` — at the same fold
// point the write watchdog already observes, so the fixtures below carry
// `input` on every tool_use block, exactly as real transcripts do
// (invariant 6).

describe("resolveClaudeRepeatWatchdog", () => {
  it("no config, and a config without the key, leave the feature entirely OFF", () => {
    for (const absent of [null, undefined, "nope", [1, 2]]) {
      const w = resolveClaudeRepeatWatchdog(absent);
      assert.deepEqual(w, { enabled: false, threshold: null, killThreshold: null, reason: "no-config" });
    }
    for (const config of [{}, { models: { chain: [["opus"]] } }, { claude: {} }, { claude: "yes" }, { claude: null }]) {
      const w = resolveClaudeRepeatWatchdog(config);
      assert.equal(w.enabled, false, `expected ${JSON.stringify(config)} to leave the watchdog off`);
      assert.equal(w.reason, "absent");
      assert.equal(w.threshold, null);
      assert.equal(w.killThreshold, null);
    }
  });

  it("valid thresholds arm the watchdog; numeric strings read", () => {
    assert.deepEqual(
      resolveClaudeRepeatWatchdog({ claude: { repeatWatchdog: { threshold: 5, killThreshold: 12 } } }),
      { enabled: true, threshold: 5, killThreshold: 12, reason: "configured" },
    );
    // A JSON config may carry the numbers as strings; they still read.
    assert.deepEqual(
      resolveClaudeRepeatWatchdog({ claude: { repeatWatchdog: { threshold: "5", killThreshold: "12" } } }),
      { enabled: true, threshold: 5, killThreshold: 12, reason: "configured" },
    );
    // The minimum viable configuration: warn on the 2nd identical call,
    // kill on the 3rd.
    assert.deepEqual(
      resolveClaudeRepeatWatchdog({ claude: { repeatWatchdog: { threshold: 2, killThreshold: 3 } } }),
      { enabled: true, threshold: 2, killThreshold: 3, reason: "configured" },
    );
  });

  it("ANY present-but-invalid value THROWS — loudly, never a silent fallback (invariant 4)", () => {
    // The write watchdog's fail-open resolution does NOT carry over: a
    // count watchdog has no warn-only shape, so there is no safe reading of
    // a malformed threshold — the dispatch must fail at load instead of
    // running unguarded or killing on a bound the operator never wrote.
    const invalid = [
      { claude: { repeatWatchdog: false } },
      { claude: { repeatWatchdog: true } },
      { claude: { repeatWatchdog: 0 } },
      { claude: { repeatWatchdog: "5" } },
      { claude: { repeatWatchdog: [5, 12] } },
      { claude: { repeatWatchdog: {} } },
      { claude: { repeatWatchdog: { threshold: 5 } } },
      { claude: { repeatWatchdog: { killThreshold: 12 } } },
      { claude: { repeatWatchdog: { threshold: 1, killThreshold: 12 } } },
      { claude: { repeatWatchdog: { threshold: 0, killThreshold: 3 } } },
      { claude: { repeatWatchdog: { threshold: 2.5, killThreshold: 12 } } },
      { claude: { repeatWatchdog: { threshold: "soon", killThreshold: 12 } } },
      { claude: { repeatWatchdog: { threshold: 5, killThreshold: 5 } } },
      { claude: { repeatWatchdog: { threshold: 5, killThreshold: 3 } } },
      { claude: { repeatWatchdog: { threshold: 5, killThreshold: 2 } } },
      { claude: { repeatWatchdog: { threshold: 5, killThreshold: "soon" } } },
    ];
    for (const config of invalid) {
      assert.throws(
        () => resolveClaudeRepeatWatchdog(config),
        /repeatWatchdog/,
        `expected ${JSON.stringify(config)} to fail loudly`,
      );
    }
  });
});

describe("normalizeClaudeRepeatArgs / claudeRepeatChainKey", () => {
  it("property order is not part of the identity (deep key sort)", () => {
    assert.equal(normalizeClaudeRepeatArgs({ a: 1, b: 2 }), normalizeClaudeRepeatArgs({ b: 2, a: 1 }));
    assert.equal(
      normalizeClaudeRepeatArgs({ file: "a.js", options: { cache: true, mode: "fast" } }),
      normalizeClaudeRepeatArgs({ options: { mode: "fast", cache: true }, file: "a.js" }),
    );
    // Nested arrays sort their elements' keys too.
    assert.equal(
      normalizeClaudeRepeatArgs({ list: [{ b: 1, a: 2 }] }),
      normalizeClaudeRepeatArgs({ list: [{ a: 2, b: 1 }] }),
    );
  });

  it("array element order IS part of the identity", () => {
    assert.notEqual(normalizeClaudeRepeatArgs({ tags: ["a", "b"] }), normalizeClaudeRepeatArgs({ tags: ["b", "a"] }));
    assert.equal(normalizeClaudeRepeatArgs({ tags: [1, 2] }), normalizeClaudeRepeatArgs({ tags: [1, 2] }));
  });

  it("an absent input normalizes to the empty arguments", () => {
    assert.equal(normalizeClaudeRepeatArgs(undefined), "{}");
    assert.equal(normalizeClaudeRepeatArgs(null), "{}");
    assert.equal(normalizeClaudeRepeatArgs({}), "{}");
  });

  it("primitive inputs normalize to their JSON", () => {
    assert.equal(normalizeClaudeRepeatArgs("ls"), "\"ls\"");
    assert.equal(normalizeClaudeRepeatArgs(42), "42");
    assert.equal(normalizeClaudeRepeatArgs(["a", "b"]), "[\"a\",\"b\"]");
  });

  it("the chain key embeds the tool name — same args, different tool, different identity", () => {
    assert.notEqual(claudeRepeatChainKey("edit_file", { a: 1 }), claudeRepeatChainKey("write_file", { a: 1 }));
    assert.equal(claudeRepeatChainKey("edit_file", { a: 1 }), claudeRepeatChainKey("edit_file", { a: 1 }));
  });

  it("identity is the FULL normalized string — a differing tail resets even past the preview cap (invariant 5)", () => {
    const longA = { file: "src/worker.js", file_contents: "// common leading comment " + "x".repeat(400) + "a" };
    const longB = { file: "src/worker.js", file_contents: "// common leading comment " + "x".repeat(400) + "b" };
    assert.ok(longA.file_contents.length > CLAUDE_REPEAT_ARGS_PREVIEW_MAX, "the fixture must exceed the preview cap");
    // Identical first CLAUDE_REPEAT_ARGS_PREVIEW_MAX characters...
    assert.equal(
      longA.file_contents.slice(0, CLAUDE_REPEAT_ARGS_PREVIEW_MAX),
      longB.file_contents.slice(0, CLAUDE_REPEAT_ARGS_PREVIEW_MAX),
    );
    // ...but different identities: a preview-truncated comparison would
    // have counted them as the same call.
    assert.notEqual(normalizeClaudeRepeatArgs(longA), normalizeClaudeRepeatArgs(longB));
  });
});

describe("claudeRepeatArgsPreview", () => {
  it("truncates past the cap with an ellipsis — and the chain never reads it", () => {
    const key = claudeRepeatChainKey("edit_file", { file_contents: "y".repeat(500) });
    const preview = claudeRepeatArgsPreview(key);
    assert.equal(preview.length, CLAUDE_REPEAT_ARGS_PREVIEW_MAX + 1);
    assert.ok(preview.endsWith("…"), "the cut is marked, never silent");
    // The chain compares the FULL key; the preview is a record only.
    assert.deepEqual(claudeRepeatChainAdvance(null, key), { key, count: 1 });
  });

  it("short normalized args pass through untruncated", () => {
    assert.equal(claudeRepeatArgsPreview(claudeRepeatChainKey("edit_file", { a: 1 })), "{\"a\":1}");
  });
});

describe("claudeRepeatChainAdvance", () => {
  it("increments on the same key, resets to 1 on any other", () => {
    const k1 = claudeRepeatChainKey("edit_file", { a: 1 });
    const k2 = claudeRepeatChainKey("edit_file", { a: 2 });
    const c1 = claudeRepeatChainAdvance(null, k1);
    assert.deepEqual(c1, { key: k1, count: 1 });
    assert.deepEqual(claudeRepeatChainAdvance(c1, k1), { key: k1, count: 2 });
    assert.deepEqual(claudeRepeatChainAdvance({ key: k1, count: 2 }, k2), { key: k2, count: 1 });
  });
});

describe("isClaudeRepeatUntrackedToolName", () => {
  it("names the bookkeeping tools only — transparency, never exemption", () => {
    for (const name of ["TodoWrite", "todo_write", "mcp__x__TodoWrite", "mcp__other__todo_write"]) {
      assert.equal(isClaudeRepeatUntrackedToolName(name), true, `${name} must be transparent to the chain`);
    }
    // Everything that does real work stays tracked — including tools that
    // ARE on this list's own family in other shapes.
    for (const name of [
      "edit_file", "mcp__sunaba__edit_file", "write_file", "Bash", "Read", "Grep",
      "mcp__sunaba__checkpoint", "mcp__sunaba__read_file_range",
      "", null, undefined, 42, {},
    ]) {
      assert.equal(isClaudeRepeatUntrackedToolName(name), false, `${JSON.stringify(name)} must be tracked`);
    }
  });
});

describe("foldClaudeRepeatCalls", () => {
  const assistant = (blocks) => ({ type: "assistant", message: { content: blocks } });
  const tool = (name, input) => ({ type: "tool_use", id: "t", name, input });

  it("folds every tracked tool_use block in stream order — the same path the write watchdog folds", () => {
    const seen = [];
    foldClaudeRepeatCalls(assistant([
      tool("mcp__sunaba__read_file_range", { file: "a" }),
      tool("mcp__sunaba__edit_file", { file: "a", file_contents: "x" }),
      tool("mcp__sunaba__edit_file", { file: "a", file_contents: "x" }),
    ]), (name, key) => seen.push([name, key]));
    assert.equal(seen.length, 3);
    assert.equal(seen[0][0], "mcp__sunaba__read_file_range");
    assert.equal(seen[1][0], "mcp__sunaba__edit_file");
    assert.equal(seen[1][1], seen[2][1], "identical inputs fold to identical chain keys");
  });

  it("untracked bookkeeping calls are TRANSPARENT — skipped, never a reset (invariant 2)", () => {
    const seen = [];
    foldClaudeRepeatCalls(assistant([
      tool("mcp__sunaba__edit_file", { file: "a", file_contents: "x" }),
      tool("TodoWrite", { todos: [] }),
      tool("mcp__sunaba__edit_file", { file: "a", file_contents: "x" }),
    ]), (name, key) => seen.push(key));
    assert.equal(seen.length, 2, "the TodoWrite call folds nothing");
    assert.equal(seen[0], seen[1], "the two edit_file calls are consecutive — TodoWrite neither incremented nor reset");
  });

  it("non-assistant events and junk fold nothing and never throw", () => {
    let calls = 0;
    for (const evt of [
      { type: "system", subtype: "init" },
      { type: "result", is_error: false },
      { type: "assistant" },
      { type: "assistant", message: { content: "not an array" } },
      { type: "assistant", message: { content: [null, "text", { type: "text", text: "edit_file" }] } },
      null, undefined, "assistant", 7,
    ]) {
      foldClaudeRepeatCalls(evt, () => { calls += 1; });
    }
    assert.equal(calls, 0);
  });
});

describe("renderClaudeRepeatWatchdogError", () => {
  it("is distinct from BOTH siblings' wording", () => {
    const text = renderClaudeRepeatWatchdogError("mcp__sunaba__edit_file", 5);
    assert.equal(
      text,
      "repeat-watchdog: mcp__sunaba__edit_file called 5 consecutive times with identical arguments on an implement phase (process killed)",
    );
    assert.notEqual(text, "watchdog: no events for 900s (process killed)");
    assert.notEqual(text, "write-watchdog: no write-tool call for 900s on an implement phase (process killed)");
  });
});

describe("runClaudeProcess — repeat watchdog", () => {
  it("no repeatWatchdog option means no chain, no events, no kill", async () => {
    const seen = [];
    const result = await runClaudeProcess({
      bin: process.execPath,
      args: ["-e", "setTimeout(() => {}, 120)"],
      timeoutS: 20,
      watchdogS: 0,
      promptText: "",
      onRepeatWatchdog: (e) => seen.push(e),
    });
    assert.deepEqual(seen, []);
    assert.equal(result.repeatStalled, false);
  });

  it("identical consecutive calls warn at threshold and kill at killThreshold", async () => {
    const src = "const t={type:'assistant',message:{content:[{type:'tool_use',name:'mcp__sunaba__edit_file',input:{file:'a',file_contents:'x'}}]}};[1,2,3,4,5].forEach(()=>console.log(JSON.stringify(t)))";
    const seen = [];
    const result = await runClaudeProcess({
      bin: process.execPath,
      args: ["-e", src],
      timeoutS: 20,
      watchdogS: 0,
      promptText: "",
      repeatWatchdog: { threshold: 3, killThreshold: 5 },
      onRepeatWatchdog: (e) => seen.push(e),
    });
    assert.equal(result.repeatStalled, true);
    assert.deepEqual(seen.map((e) => e.kind), ["warned", "fired", "kill"]);
    assert.equal(seen[0].tool, "mcp__sunaba__edit_file");
    assert.equal(seen[0].count, 3);
    assert.equal(seen[1].count, 5);
  });

  it("a different call resets the chain before the threshold is reached", async () => {
    const a = "{type:'assistant',message:{content:[{type:'tool_use',name:'mcp__sunaba__edit_file',input:{file:'a',file_contents:'x'}}]}}";
    const b = "{type:'assistant',message:{content:[{type:'tool_use',name:'mcp__sunaba__edit_file',input:{file:'a',file_contents:'y'}}]}}";
    const src = `[${a},${a},${b},${b}].forEach((t)=>console.log(JSON.stringify(t)))`;
    const seen = [];
    const result = await runClaudeProcess({
      bin: process.execPath,
      args: ["-e", src],
      timeoutS: 20,
      watchdogS: 0,
      promptText: "",
      repeatWatchdog: { threshold: 3, killThreshold: 5 },
      onRepeatWatchdog: (e) => seen.push(e),
    });
    assert.equal(result.repeatStalled, false);
    assert.deepEqual(seen, [], "the reset kept every chain below the threshold");
  });
});

describe("claudeDispatch — repeat-tool watchdog (kusabi #234)", () => {
  let ctx;

  afterEach(() => {
    if (ctx) {
      ctx.restore();
      fs.rmSync(ctx.tmp, { recursive: true, force: true });
    }
    ctx = null;
  });

  // Same session-guard note as the write watchdog tests: every config below
  // disables it explicitly — a config file WITHOUT `sessionGuardPercent`
  // turns it on at the default threshold and would spawn a /usage probe
  // these tests are not about.
  const withRepeat = (threshold, killThreshold) => ({
    claude: { sessionGuardPercent: false, repeatWatchdog: { threshold, killThreshold } },
  });

  it("invariant 1: identical consecutive calls are caught while BOTH time clocks are satisfied", async () => {
    // The fixture calls mcp__sunaba__edit_file with the SAME input every
    // tick.  Every tick is a parsed event (silence clock reset) and every
    // tick is a file-mutating call (write clock reset) — a worker like this
    // would satisfy both time-based watchdogs forever.  Only the count-based
    // chain can end this run.
    ctx = fakeClaudeContext("repeat-identical", { config: withRepeat(3, 5) });
    const { job } = await claudeDispatch(ctx.dispatchOptions({ phase: "implement", timeoutS: 30, watchdogS: 900 }));

    assert.equal(job.status, "stalled");
    assert.equal(
      job.error,
      "repeat-watchdog: mcp__sunaba__edit_file called 5 consecutive times with identical arguments on an implement phase (process killed)",
    );

    const events = repeatWatchdogEvents(ctx.stateDir, job.id);
    assert.deepEqual(events.map((e) => e.type), [
      "companion.repeat-watchdog.warned",
      "companion.repeat-watchdog.fired",
      "companion.repeat-watchdog.kill",
    ]);
    assert.equal(events[0].tool, "mcp__sunaba__edit_file");
    assert.equal(events[0].count, 3);
    assert.equal(events[0].threshold, 3);
    assert.equal(events[0].killThreshold, 5);
    assert.equal(events[0].phase, "implement");
    // Short normalized args pass through untruncated: the full normalized
    // input, deep-key-sorted.
    assert.equal(events[0].argsPreview, "{\"file\":\"src/worker.js\",\"file_contents\":\"export const x = 1;\"}");
    assert.equal(events[1].tool, "mcp__sunaba__edit_file");
    assert.equal(events[1].count, 5);

    // Neither sibling claims this stall: the stream was busy the whole way.
    assert.deepEqual(watchdogEvents(ctx.stateDir, job.id), []);
    assert.deepEqual(writeWatchdogEvents(ctx.stateDir, job.id), []);

    // Recorded on the job, and on disk.
    assert.equal(job.repeatWatchdog.warned, true);
    assert.ok(job.repeatWatchdog.warnedAt, "the warning is timestamped on the record");
    assert.equal(job.repeatWatchdog.tool, "mcp__sunaba__edit_file");
    assert.equal(job.repeatWatchdog.count, 5);
    assert.equal(job.repeatWatchdog.threshold, 3);
    assert.equal(job.repeatWatchdog.killThreshold, 5);
    assert.equal(loadJob(ctx.stateDir, job.id).status, "stalled");

    // The whole process group is dead, exactly as the siblings leave it.
    for (const pid of spawnedPids(ctx.pidsLog)) {
      assert.equal(isAlive(pid), false, `pid ${pid} must be dead after the repeat-watchdog group kill`);
    }
  });

  it("invariant 2: untracked bookkeeping calls interleaved still count as consecutive", async () => {
    // edit_file X → TodoWrite → edit_file X → ... — the TodoWrite calls are
    // TRANSPARENT: neither increment nor reset, so the edit_file calls chain
    // across them.
    ctx = fakeClaudeContext("repeat-untracked", { config: withRepeat(3, 5) });
    const { job } = await claudeDispatch(ctx.dispatchOptions({ phase: "implement", timeoutS: 30, watchdogS: 900 }));

    assert.equal(job.status, "stalled");
    assert.equal(
      job.error,
      "repeat-watchdog: mcp__sunaba__edit_file called 5 consecutive times with identical arguments on an implement phase (process killed)",
    );
    const events = repeatWatchdogEvents(ctx.stateDir, job.id);
    assert.equal(events[0].count, 3, "warned at the 3rd edit_file across two TodoWrite interleavings");
    assert.equal(events[1].count, 5, "killed at the 5th edit_file across four TodoWrite interleavings");
    assert.equal(events[1].tool, "mcp__sunaba__edit_file");
  });

  it("invariant 3: DENIED calls count — a worker hammering a denied tool is the loop to break", async () => {
    // Bash is on the belt-and-braces DISALLOWED_TOOLS list, so kusabi
    // refuses every one of these calls in a real session; the refusal does
    // not stop the model from repeating them, and the chain must count them.
    ctx = fakeClaudeContext("repeat-denied", { config: withRepeat(3, 5) });
    const { job } = await claudeDispatch(ctx.dispatchOptions({ phase: "implement", timeoutS: 30, watchdogS: 900 }));

    assert.equal(job.status, "stalled");
    assert.equal(
      job.error,
      "repeat-watchdog: Bash called 5 consecutive times with identical arguments on an implement phase (process killed)",
    );
    const events = repeatWatchdogEvents(ctx.stateDir, job.id);
    assert.equal(events[1].tool, "Bash");
    assert.equal(events[1].count, 5);
  });

  it("invariant 4: config absent leaves the dispatch and the record byte-equivalent to a no-watchdog run", async () => {
    // Run A: NO repeatWatchdog key at all.  Run B: the key IS present but
    // the phase gate refuses to arm it — the same "watchdog not armed"
    // state, reached through the other door.  Same fixture, same phase; the
    // two runs must produce identical records (modulo ids/timestamps) and
    // identical event trails.
    const ctxA = fakeClaudeContext("stream-full", { config: null });
    const { job: jobA } = await claudeDispatch(ctxA.dispatchOptions({ phase: "review" }));
    ctx = fakeClaudeContext("stream-full", { config: withRepeat(3, 5) });
    const { job: jobB } = await claudeDispatch(ctx.dispatchOptions({ phase: "review" }));

    assert.equal(jobA.repeatWatchdog, undefined, "no watchdog field on the unarmed dispatch");
    assert.ok(!("repeatWatchdog" in loadJob(ctxA.stateDir, jobA.id)), "no new key on the on-disk record");
    assert.deepEqual(repeatWatchdogEvents(ctxA.stateDir, jobA.id), []);

    const stripEventBin = (events) => events.map((e) => (e.bin === undefined ? e : { ...e, bin: "FAKE" }));
    assert.deepEqual(stripVolatile(jobA), stripVolatile(jobB), "absent-config record equals the gated-off run's record");
    assert.deepEqual(
      stripEventBin(readJobEvents(ctxA.stateDir, jobA.id)),
      stripEventBin(readJobEvents(ctx.stateDir, jobB.id)),
      "absent-config events equal the gated-off run's events",
    );
    fs.rmSync(ctxA.tmp, { recursive: true, force: true });
  });

  it("invariant 5: a truncated args preview never affects identity comparison", async () => {
    // The repeated input is ~460 chars — far past the 200-char preview cap —
    // so the warned event's preview is visibly truncated.  Identity is the
    // FULL normalized string: the identical huge calls still chain, warn at
    // 3 and kill at 5.
    ctx = fakeClaudeContext("repeat-huge-args", { config: withRepeat(3, 5) });
    const { job } = await claudeDispatch(ctx.dispatchOptions({ phase: "implement", timeoutS: 30, watchdogS: 900 }));

    assert.equal(job.status, "stalled");
    const events = repeatWatchdogEvents(ctx.stateDir, job.id);
    assert.ok(events[0].argsPreview.endsWith("…"), "the preview is truncated, and the cut is marked");
    assert.equal(events[0].argsPreview.length, CLAUDE_REPEAT_ARGS_PREVIEW_MAX + 1);
    assert.equal(events[1].count, 5, "the full-string chain still counted every identical call");
  });

  it("invariant 5: two huge inputs sharing the preview window but differing in the tail are NOT consecutive", async () => {
    // Three calls with input A, then three with input B whose first 200
    // characters are IDENTICAL to A's — only the tail differs.  A comparison
    // against the truncated preview would count B as a continuation of A and
    // reach killThreshold 5; the full-string comparison resets on B and the
    // run completes with a single warning.
    ctx = fakeClaudeContext("repeat-huge-differ", { config: withRepeat(3, 5) });
    const { job } = await claudeDispatch(ctx.dispatchOptions({ phase: "implement", timeoutS: 30, watchdogS: 900 }));

    assert.equal(job.status, "completed");
    assert.equal(job.error, null);
    const events = repeatWatchdogEvents(ctx.stateDir, job.id);
    assert.deepEqual(events.map((e) => e.type), ["companion.repeat-watchdog.warned"], "warned exactly once, never killed");
    assert.equal(events[0].count, 3);
    assert.equal(job.repeatWatchdog.warned, true);
    assert.equal(job.repeatWatchdog.count, 3);
  });

  it("warns exactly once, then a different call resets the chain and the run completes", async () => {
    // Three identical calls (warn at threshold 3), then three calls with
    // DIFFERENT arguments: the chain resets on the first different call and
    // never reaches killThreshold 9.  The warning stays EXACTLY once.
    ctx = fakeClaudeContext("repeat-then-change", { config: withRepeat(3, 9) });
    const { job } = await claudeDispatch(ctx.dispatchOptions({ phase: "implement", timeoutS: 30, watchdogS: 900 }));

    assert.equal(job.status, "completed");
    assert.equal(job.error, null);
    const events = repeatWatchdogEvents(ctx.stateDir, job.id);
    assert.deepEqual(events.map((e) => e.type), ["companion.repeat-watchdog.warned"]);
    assert.equal(events[0].count, 3);
    assert.equal(job.repeatWatchdog.warned, true);
    assert.equal(job.repeatWatchdog.count, 3);
  });

  it("an invalid claude.repeatWatchdog fails the dispatch LOUDLY before any record exists (invariant 4)", async () => {
    ctx = fakeClaudeContext("ok", { config: { claude: { sessionGuardPercent: false, repeatWatchdog: { threshold: 5 } } } });
    await assert.rejects(claudeDispatch(ctx.dispatchOptions({ phase: "implement" })), /repeatWatchdog/);
    assert.deepEqual(listJobs(ctx.stateDir), [], "a config error must not leave a job record behind");
  });

  it("the same config on a review-phase job never arms the watchdog", async () => {
    ctx = fakeClaudeContext("repeat-then-change", { config: withRepeat(3, 5) });
    const { job } = await claudeDispatch(ctx.dispatchOptions({ phase: "review", timeoutS: 30, watchdogS: 900 }));

    assert.equal(job.status, "completed");
    assert.deepEqual(repeatWatchdogEvents(ctx.stateDir, job.id), []);
    assert.equal(job.repeatWatchdog, undefined, "an unarmed dispatch records no watchdog field at all");
    assert.ok(!("repeatWatchdog" in loadJob(ctx.stateDir, job.id)));
  });

  it("an armed repeat watchdog leaves the siblings' own paths untouched", async () => {
    // The write watchdog is armed at bounds this busy run cannot reach; the
    // REPEAT watchdog owns the stall, and neither sibling adds a thing — no
    // spurious write warning, no silence claim, no overwritten error text.
    ctx = fakeClaudeContext("repeat-identical", {
      config: {
        claude: {
          sessionGuardPercent: false,
          writeWatchdog: { warnS: 60, killS: 120 },
          repeatWatchdog: { threshold: 3, killThreshold: 5 },
        },
      },
    });
    const { job } = await claudeDispatch(ctx.dispatchOptions({ phase: "implement", timeoutS: 30, watchdogS: 900 }));

    assert.equal(job.status, "stalled");
    assert.match(job.error, /^repeat-watchdog:/);
    assert.deepEqual(writeWatchdogEvents(ctx.stateDir, job.id), []);
    assert.deepEqual(watchdogEvents(ctx.stateDir, job.id), []);
    assert.equal(job.writeWatchdog.killed, false);
    assert.equal(job.writeWatchdog.warned, false);
    assert.equal(job.repeatWatchdog.warned, true);
  });
});
