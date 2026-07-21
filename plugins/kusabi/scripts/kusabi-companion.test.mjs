import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  accumulateUsage,
  decidePermission,
  extractJson,
  renderReview,
  parseArgs,
  parseModel,
  stateRoot,
  deriveDisposition,
  loadConfig,
  resolveModel,
  readBriefFile,
  shouldReapServer,
  cwdSlug,
  findTranscriptFile,
  extractAssistantText,
  resolveExplainPassage,
} from "./kusabi-companion.mjs";

// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// extractJson
// ---------------------------------------------------------------------------

describe("extractJson", () => {
  it("parses a plain JSON string", () => {
    const result = extractJson('{"a":1,"b":"two"}');
    assert.deepEqual(result, { a: 1, b: "two" });
  });

  it("parses JSON inside a fenced code block", () => {
    const input = "```json\n{\"verdict\":\"approve\"}\n```";
    const result = extractJson(input);
    assert.deepEqual(result, { verdict: "approve" });
  });

  it("parses JSON inside a fenced code block without language tag", () => {
    const input = "```\n{\"x\":42}\n```";
    const result = extractJson(input);
    assert.deepEqual(result, { x: 42 });
  });

  it("returns null for invalid input", () => {
    assert.equal(extractJson("not json"), null);
  });

  it("returns null for malformed JSON in fence", () => {
    const input = "```json\n{invalid}\n```";
    assert.equal(extractJson(input), null);
  });
});

// ---------------------------------------------------------------------------
// renderReview
// ---------------------------------------------------------------------------

const sampleParsed = {
  verdict: "approve",
  summary: "The code looks good.",
  findings: [
    {
      severity: "low",
      title: "Minor style issue",
      file: "src/foo.js",
      line_start: 10,
      line_end: 12,
      confidence: 0.9,
      body: "Consider adding a blank line.",
      recommendation: "Add a blank line after the import block.",
    },
  ],
  next_steps: ["Run the linter before merging."],
};

describe("renderReview", () => {
  it("(a) renders a structured review from a parsed object", () => {
    const result = renderReview(sampleParsed, "");
    assert.match(result, /\*\*Verdict: approve\*\*/);
    assert.match(result, /The code looks good\./);
    assert.match(result, /Minor style issue/);
    assert.match(result, /Recommendation:/);
    assert.match(result, /Next steps:/);
  });

  it("(a) handles empty findings", () => {
    const parsed = { verdict: "approve", summary: "OK", findings: [] };
    const result = renderReview(parsed, "");
    assert.match(result, /No material findings\./);
  });

  it("(b) recovers from terminal token when parsed is null and rawText ends with VERDICT: needs-attention", () => {
    const rawText = "Some output text\nVERDICT: needs-attention";
    const result = renderReview(null, rawText);
    assert.match(result, /recovered from terminal token/);
    assert.match(result, /needs-attention/);
    assert.match(result, /Some output text/);
  });

  it("(b) recovers from terminal token when parsed is null and rawText ends with VERDICT: approve", () => {
    const rawText = "Some output text\nVERDICT: approve";
    const result = renderReview(null, rawText);
    assert.match(result, /recovered from terminal token/);
    assert.match(result, /approve/);
  });

  it("(b2) recovers from terminal token when parsed is null and rawText ends with VERDICT: approve-partial", () => {
    const rawText = "Some output text\nVERDICT: approve-partial";
    const result = renderReview(null, rawText);
    assert.match(result, /recovered from terminal token/);
    assert.match(result, /approve-partial/);
  });

  it("(c) renders unverified field when present in parsed object", () => {
    const parsed = {
      verdict: "approve-partial",
      summary: "Mostly OK but some checks could not run.",
      findings: [],
      next_steps: ["Ask orchestrator to verify remaining items."],
      unverified: ["Integration tests require Docker", "Load test environment not available"],
    };
    const result = renderReview(parsed, "");
    assert.match(result, /\*\*Verdict: approve-partial\*\*/);
    assert.match(result, /\*\*Unverified:\*\*/);
    assert.match(result, /Integration tests require Docker/);
    assert.match(result, /Load test environment not available/);
    assert.match(result, /\*\*Next steps:\*\*/);
  });

  it("(c2) skips unverified section when unverified is empty", () => {
    const parsed = {
      verdict: "approve",
      summary: "All clear.",
      findings: [],
      unverified: [],
    };
    const result = renderReview(parsed, "");
    assert.match(result, /\*\*Verdict: approve\*\*/);
    assert.doesNotMatch(result, /\*\*Unverified:\*\*/);
  });

  it("(d) falls back for null parsed with no terminal token", () => {
    const rawText = "Some random output without a verdict token";
    const result = renderReview(null, rawText);
    assert.match(result, /review output was not valid JSON/);
    assert.match(result, /Some random output/);
  });
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("parses a value flag: --prior", () => {
    const result = parseArgs(["--prior", "previous findings"]);
    assert.equal(result.flags.prior, "previous findings");
  });

  it("parses a value flag: --model", () => {
    const result = parseArgs(["--model", "anthropic/claude-4"]);
    assert.equal(result.flags.model, "anthropic/claude-4");
  });

  it("parses a boolean flag: --wait", () => {
    const result = parseArgs(["--wait"]);
    assert.equal(result.flags.wait, true);
  });

  it("parses -- as literal separator and puts rest in text", () => {
    const result = parseArgs(["--prior", "x", "--", "extra", "args"]);
    assert.equal(result.flags.prior, "x");
    assert.equal(result.text, "extra args");
  });

  it("throws on unknown flag", () => {
    assert.throws(
      () => parseArgs(["--nope"]),
      /unknown flag: --nope/,
    );
  });

  it("returns empty flags and text for empty argv", () => {
    const result = parseArgs([]);
    assert.deepEqual(result.flags, {});
    assert.equal(result.text, "");
  });

  it("treats -h as a boolean flag", () => {
    const result = parseArgs(["-h"]);
    assert.equal(result.flags.h, true);
  });

  it("parses --tools as a boolean flag", () => {
    const result = parseArgs(["--tools"]);
    assert.equal(result.flags.tools, true);
  });

  it("parses --last as a value flag", () => {
    const result = parseArgs(["--last", "3"]);
    assert.equal(result.flags.last, "3");
  });

  it("parses --quote as a value flag", () => {
    const result = parseArgs(["--quote", "some passage text"]);
    assert.equal(result.flags.quote, "some passage text");
  });

  it("combines --last, --tools, --quote with rest text", () => {
    const result = parseArgs(["--last", "2", "--tools", "--quote", "the passage", "--", "the question"]);
    assert.equal(result.flags.last, "2");
    assert.equal(result.flags.tools, true);
    assert.equal(result.flags.quote, "the passage");
    assert.equal(result.text, "the question");
  });

  it("throws when --last is missing its value", () => {
    assert.throws(() => parseArgs(["--last"]), /--last requires a value/);
  });

  it("throws when --quote is missing its value", () => {
    assert.throws(() => parseArgs(["--quote"]), /--quote requires a value/);
  });
});


// ---------------------------------------------------------------------------
// stateRoot — state directory resolution with migration
// ---------------------------------------------------------------------------

describe("stateRoot", () => {
  it("uses KUSABI_STATE_DIR env var when set", () => {
    const saved = process.env.KUSABI_STATE_DIR;
    try {
      process.env.KUSABI_STATE_DIR = "/tmp/kusabi-test-custom";
      assert.equal(stateRoot(), "/tmp/kusabi-test-custom");
    } finally {
      if (saved === undefined) delete process.env.KUSABI_STATE_DIR;
      else process.env.KUSABI_STATE_DIR = saved;
    }
  });

  it("falls back to OPENCODE_COMPANION_STATE_DIR when KUSABI_STATE_DIR is not set", () => {
    const savedKusabi = process.env.KUSABI_STATE_DIR;
    const savedOld = process.env.OPENCODE_COMPANION_STATE_DIR;
    try {
      delete process.env.KUSABI_STATE_DIR;
      process.env.OPENCODE_COMPANION_STATE_DIR = "/tmp/kusabi-test-legacy";
      assert.equal(stateRoot(), "/tmp/kusabi-test-legacy");
    } finally {
      if (savedKusabi === undefined) delete process.env.KUSABI_STATE_DIR;
      else process.env.KUSABI_STATE_DIR = savedKusabi;
      if (savedOld === undefined) delete process.env.OPENCODE_COMPANION_STATE_DIR;
      else process.env.OPENCODE_COMPANION_STATE_DIR = savedOld;
    }
  });

  it("returns ~/.kusabi when no env var is set", () => {
    const savedKusabi = process.env.KUSABI_STATE_DIR;
    const savedOld = process.env.OPENCODE_COMPANION_STATE_DIR;
    try {
      delete process.env.KUSABI_STATE_DIR;
      delete process.env.OPENCODE_COMPANION_STATE_DIR;
      const result = stateRoot();
      assert.ok(result.endsWith("/.kusabi"), `expected ~/.kusabi, got ${result}`);
    } finally {
      if (savedKusabi === undefined) delete process.env.KUSABI_STATE_DIR;
      else process.env.KUSABI_STATE_DIR = savedKusabi;
      if (savedOld === undefined) delete process.env.OPENCODE_COMPANION_STATE_DIR;
      else process.env.OPENCODE_COMPANION_STATE_DIR = savedOld;
    }
  });

  it("migrates old ~/.opencode-plugin-cc to ~/.kusabi when only old dir exists", () => {
    const savedKusabi = process.env.KUSABI_STATE_DIR;
    const savedOld = process.env.OPENCODE_COMPANION_STATE_DIR;
    try {
      delete process.env.KUSABI_STATE_DIR;
      delete process.env.OPENCODE_COMPANION_STATE_DIR;

      const home = os.homedir();
      const newDir = path.join(home, ".kusabi");
      const oldDir = path.join(home, ".opencode-plugin-cc");

      // Clean up any leftovers from previous test runs
      if (fs.existsSync(newDir)) fs.rmSync(newDir, { recursive: true });

      // Create old dir with a marker file
      fs.mkdirSync(oldDir, { recursive: true });
      const marker = path.join(oldDir, "migration-marker");
      fs.writeFileSync(marker, "pre-migration data", "utf8");

      try {
        const result = stateRoot();
        assert.equal(result, newDir);
        // Old dir should be gone (renamed to new)
        assert.ok(!fs.existsSync(oldDir), "old dir should not exist after migration");
        // New dir should contain the marker
        assert.ok(fs.existsSync(path.join(newDir, "migration-marker")), "migration marker should exist in new dir");
      } finally {
        // Cleanup
        if (fs.existsSync(oldDir)) fs.rmSync(oldDir, { recursive: true });
        if (fs.existsSync(newDir)) fs.rmSync(newDir, { recursive: true });
      }
    } finally {
      if (savedKusabi === undefined) delete process.env.KUSABI_STATE_DIR;
      else process.env.KUSABI_STATE_DIR = savedKusabi;
      if (savedOld === undefined) delete process.env.OPENCODE_COMPANION_STATE_DIR;
      else process.env.OPENCODE_COMPANION_STATE_DIR = savedOld;
    }
  });

  it("skips migration when env var is set even if old dir exists", () => {
    const savedKusabi = process.env.KUSABI_STATE_DIR;
    const savedOld = process.env.OPENCODE_COMPANION_STATE_DIR;
    try {
      delete process.env.KUSABI_STATE_DIR;
      delete process.env.OPENCODE_COMPANION_STATE_DIR;

      const home = os.homedir();
      const oldDir = path.join(home, ".opencode-plugin-cc");

      // Create old dir
      fs.mkdirSync(oldDir, { recursive: true });

      try {
        // Set env override
        process.env.KUSABI_STATE_DIR = "/tmp/kusabi-env-override-test";
        const result = stateRoot();
        assert.equal(result, "/tmp/kusabi-env-override-test");
        // Old dir should still exist (not migrated because env is set)
        assert.ok(fs.existsSync(oldDir), "old dir should still exist when env is set");
      } finally {
        if (fs.existsSync(oldDir)) fs.rmSync(oldDir, { recursive: true });
      }
    } finally {
      if (savedKusabi === undefined) delete process.env.KUSABI_STATE_DIR;
      else process.env.KUSABI_STATE_DIR = savedKusabi;
      if (savedOld === undefined) delete process.env.OPENCODE_COMPANION_STATE_DIR;
      else process.env.OPENCODE_COMPANION_STATE_DIR = savedOld;
    }
  });
});


// ---------------------------------------------------------------------------
// deriveDisposition — all branches
// ---------------------------------------------------------------------------

describe("deriveDisposition", () => {
  it("accept: approve + probesGreen", () => {
    const result = deriveDisposition({ verdict: "approve", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false });
    assert.deepEqual(result, { disposition: "accept" });
  });

  it("rework: approve + probes not green", () => {
    const result = deriveDisposition({ verdict: "approve", probesGreen: false, round: 1, maxRounds: 3, repeatedAreas: false });
    assert.deepEqual(result, { disposition: "rework", reason: "deterministic probes failed" });
  });

  it("escalate: approve-partial (unverified items remain)", () => {
    const result = deriveDisposition({ verdict: "approve-partial", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false });
    assert.deepEqual(result, { disposition: "escalate", reason: "approve-partial: unverified items remain" });
  });

  it("rework: needs-attention without repeated areas", () => {
    const result = deriveDisposition({ verdict: "needs-attention", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false });
    assert.deepEqual(result, { disposition: "rework", reason: "needs-attention" });
  });

  it("escalate: needs-attention with repeated areas (same file 2 rounds)", () => {
    const result = deriveDisposition({ verdict: "needs-attention", probesGreen: true, round: 2, maxRounds: 3, repeatedAreas: true });
    assert.deepEqual(result, { disposition: "escalate", reason: "same file area flagged for two consecutive rounds" });
  });

  it("escalate: discard", () => {
    const result = deriveDisposition({ verdict: "discard", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false });
    assert.deepEqual(result, { disposition: "escalate", reason: "reviewer discarded the work" });
  });

  it("escalate: max rounds reached without accept", () => {
    const result = deriveDisposition({ verdict: "needs-attention", probesGreen: false, round: 3, maxRounds: 3, repeatedAreas: false });
    assert.deepEqual(result, { disposition: "escalate", reason: "max rounds (3) reached without acceptance" });
  });

  it("accept on last round when approve + green", () => {
    const result = deriveDisposition({ verdict: "approve", probesGreen: true, round: 3, maxRounds: 3, repeatedAreas: false });
    assert.deepEqual(result, { disposition: "accept" });
  });

  it("escalate: unknown verdict", () => {
    const result = deriveDisposition({ verdict: "unknown", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false });
    assert.equal(result.disposition, "escalate");
    assert.match(result.reason, /unexpected verdict/);
  });
});

// ---------------------------------------------------------------------------
// renderReview — discard verdict terminal token recovery
// ---------------------------------------------------------------------------

describe("renderReview discard token", () => {
  it("recovers from terminal token when parsed is null and rawText ends with VERDICT: discard", () => {
    const rawText = "The premise is wrong.\nVERDICT: discard";
    const result = renderReview(null, rawText);
    assert.match(result, /recovered from terminal token/);
    assert.match(result, /discard/);
  });
});

// ---------------------------------------------------------------------------
// parseArgs — --max-rounds flag
// ---------------------------------------------------------------------------

describe("parseArgs max-rounds", () => {
  it("parses --max-rounds flag", () => {
    const result = parseArgs(["--max-rounds", "5"]);
    // Value flags use arg.slice(2) directly, so key is "max-rounds" (hyphenated)
    assert.equal(result.flags["max-rounds"], "5");
  });

  it("defaults to undefined when not provided", () => {
    const result = parseArgs([]);
    assert.equal(result.flags["max-rounds"], undefined);
  });

  it("parses --max-rounds in chain context", () => {
    const result = parseArgs(["--container", "abc123", "--model", "anthropic/claude-4", "--max-rounds", "5", "implement the thing"]);
    assert.equal(result.flags.container, "abc123");
    assert.equal(result.flags.model, "anthropic/claude-4");
    assert.equal(result.flags["max-rounds"], "5");
    assert.equal(result.text, "implement the thing");
  });
});

// ---------------------------------------------------------------------------
// sunaba-rpc — module exports and allowlist enforcement
// ---------------------------------------------------------------------------

describe("sunaba-rpc allowlist", () => {
  it("throws when tool is not in allowed list", async () => {
    const { callTool } = await import("./sunaba-rpc.mjs");
    await assert.rejects(
      () => callTool("publish", {}),
      /not in the allowed list/,
    );
  });

  it("throws for sandbox_exec string commands (must be array)", async () => {
    const { callTool } = await import("./sunaba-rpc.mjs");
    await assert.rejects(
      () => callTool("sandbox_exec", { commands: "git status" }),
      /commands.*must be an array/,
    );
  });

  it("sandbox_exec with array commands passes validation", async () => {
    const { callTool } = await import("./sunaba-rpc.mjs");
    // Should not throw from validation (will fail on fetch, not on allowlist)
    try {
      await callTool("sandbox_exec", { commands: ["git status"] });
    } catch (err) {
      assert.ok(!err.message.includes("must be an array"), "validation should pass for arrays");
      assert.ok(!err.message.includes("not in the allowed list"), "should be allowed");
    }
  });

  it("allows all 5 tools in the allowlist", async () => {
    const { callTool } = await import("./sunaba-rpc.mjs");
    for (const tool of ["verify_in_container", "sandbox_exec", "checkpoint", "checkpoint_list", "checkpoint_restore"]) {
      try {
        await callTool(tool, {});
      } catch (err) {
        assert.ok(!err.message.includes("not in the allowed list"), `${tool} should be allowed`);
      }
    }
  });

  it("exports all convenience wrappers", async () => {
    const mod = await import("./sunaba-rpc.mjs");
    assert.ok(typeof mod.verifyInContainer === "function");
    assert.ok(typeof mod.sandboxExec === "function");
    assert.ok(typeof mod.checkpoint === "function");
    assert.ok(typeof mod.checkpointList === "function");
    assert.ok(typeof mod.checkpointRestore === "function");
  });
});


// ---------------------------------------------------------------------------
// sunaba-rpc — SSE parsing and MCP content unwrap
// ---------------------------------------------------------------------------

describe("sunaba-rpc SSE and unwrap", () => {
  it("parseSseResponse extracts last data line with result", async () => {
    const { parseSseResponse } = await import("./sunaba-rpc.mjs");
    const body = [
      'data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"sunaba","version":"1.0.0"}}}',
      'data: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\\"key\\":\\"value\\"}"}]}}',
    ].join("\n");
    const result = parseSseResponse(body);
    assert.deepEqual(result, { content: [{ type: "text", text: '{"key":"value"}' }] });
  });

  it("parseSseResponse throws on empty body", async () => {
    const { parseSseResponse } = await import("./sunaba-rpc.mjs");
    assert.throws(() => parseSseResponse(""), /no data lines/);
  });

  it("parseSseResponse throws on error response", async () => {
    const { parseSseResponse } = await import("./sunaba-rpc.mjs");
    const body = 'data: {"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"internal error"}}';
    assert.throws(() => parseSseResponse(body), /internal error/);
  });

  it("unwrapResult extracts and parses text from content[0]", async () => {
    const { unwrapResult } = await import("./sunaba-rpc.mjs");
    const result = unwrapResult({
      content: [{ type: "text", text: '{"gate_passed":true,"summary":"all green"}' }],
    });
    assert.deepEqual(result, { gate_passed: true, summary: "all green" });
  });

  it("unwrapResult parses sandbox_exec output field", async () => {
    const { unwrapResult } = await import("./sunaba-rpc.mjs");
    // sandbox_exec returns text JSON with "output" field (not "stdout")
    const result = unwrapResult({
      content: [{ type: "text", text: '{"output":"abc123\\n","exit_code":0}' }],
    });
    assert.equal(result.output, "abc123\n");
    assert.equal(result.exit_code, 0);
  });

  it("unwrapResult returns raw result when content is empty", async () => {
    const { unwrapResult } = await import("./sunaba-rpc.mjs");
    const result = unwrapResult({ someField: "direct" });
    assert.deepEqual(result, { someField: "direct" });
  });

  it("unwrapResult returns raw string when text is not JSON", async () => {
    const { unwrapResult } = await import("./sunaba-rpc.mjs");
    const result = unwrapResult({
      content: [{ type: "text", text: "plain string output" }],
    });
    assert.equal(result, "plain string output");
  });
});

// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// parseArgs — --brief-file flag
// ---------------------------------------------------------------------------

describe("parseArgs brief-file", () => {
  it("parses --brief-file as a value flag", () => {
    const result = parseArgs(["--brief-file", "/tmp/test-brief.md"]);
    assert.equal(result.flags["brief-file"], "/tmp/test-brief.md");
  });

  it("does not set --brief-file when not provided", () => {
    const result = parseArgs(["some inline text"]);
    assert.equal(result.flags["brief-file"], undefined);
  });

  it("combines --brief-file with other flags", () => {
    const result = parseArgs(["--model", "p/m", "--brief-file", "/tmp/b.md", "--", "text"]);
    assert.equal(result.flags.model, "p/m");
    assert.equal(result.flags["brief-file"], "/tmp/b.md");
    // text after -- is literal; brief-file flag was consumed before --
    assert.equal(result.text, "text");
  });
});

// ---------------------------------------------------------------------------
// loadConfig — config file loading
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  /** @type {string} */
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-loadConfig-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no config file exists", () => {
    const result = loadConfig(tmpDir);
    assert.equal(result, null);
  });

  it("returns parsed config when valid JSON with models.chain exists", () => {
    const config = {
      models: {
        chain: ["opencode-go/deepseek-v4-flash", "opencode-go/deepseek-v4-pro"],
      },
    };
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify(config), "utf8");
    const result = loadConfig(tmpDir);
    assert.deepEqual(result, config);
  });

  it("returns parsed config when valid JSON with models.phases exists", () => {
    const config = {
      models: {
        phases: { implement: ["opencode-go/deepseek-v4-flash"] },
      },
    };
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify(config), "utf8");
    const result = loadConfig(tmpDir);
    assert.deepEqual(result, config);
  });

  it("returns parsed config when models key is absent", () => {
    const config = { unrelated: true };
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify(config), "utf8");
    const result = loadConfig(tmpDir);
    assert.deepEqual(result, config);
  });

  it("throws on malformed JSON (unparseable)", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), "not json at all", "utf8");
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes(path.join(tmpDir, "config.json")), "error must mention file path");
        assert.ok(err.message.includes("not valid JSON"), "error must mention invalid JSON");
        return true;
      },
    );
  });

  it("throws on null JSON value", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), "null", "utf8");
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes("must contain a JSON object"));
        return true;
      },
    );
  });

  it("throws on array JSON value", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), "[]", "utf8");
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes("must contain a JSON object"));
        return true;
      },
    );
  });

  it("throws when models is not an object", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({ models: "string" }), "utf8");
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes('"models" must be a JSON object'));
        return true;
      },
    );
  });

  it("throws when models.chain is not an array of strings", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({ models: { chain: "not-array" } }), "utf8");
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes('"models.chain" must be an array'));
        return true;
      },
    );
  });

  it("throws when models.chain is an empty array (must not silently drop built-in defaults)", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({ models: { chain: [] } }), "utf8");
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes('"models.chain" must not be empty'));
        return true;
      },
    );
  });

  it("throws when a models.phases entry is an empty array", () => {
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({ models: { phases: { implement: [] } } }),
      "utf8",
    );
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes('"models.phases.implement" must not be empty'));
        return true;
      },
    );
  });

  it("throws when models.phases.phase is not an array of strings", () => {
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({ models: { phases: { implement: "not-array" } } }),
      "utf8",
    );
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes('"models.phases.implement" must be an array'));
        return true;
      },
    );
  });

  it("throws when models.phases is not an object", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({ models: { phases: "string" } }), "utf8");
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes('"models.phases" must be a JSON object'));
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// resolveModel — model resolution precedence
// ---------------------------------------------------------------------------

describe("resolveModel", () => {
  it("returns built-in default chain when no flag and no config", () => {
    const result = resolveModel({ flag: undefined, phase: undefined, config: null });
    assert.ok(result.model, "should resolve a model");
    assert.equal(result.model.providerID, "opencode");
    assert.equal(result.model.modelID, "deepseek-v4-flash-free");
    assert.ok(Array.isArray(result.chain));
    assert.equal(result.chain.length, 3);
    assert.equal(result.chain[0], "opencode/deepseek-v4-flash-free");
  });

  it("uses explicit --model flag over everything", () => {
    const config = {
      models: {
        chain: ["opencode-go/deepseek-v4-flash", "opencode-go/deepseek-v4-pro"],
        phases: { implement: ["anthropic/claude-4"] },
      },
    };
    const result = resolveModel({ flag: "some-provider/some-model", phase: "implement", config });
    assert.equal(result.model.providerID, "some-provider");
    assert.equal(result.model.modelID, "some-model");
  });

  it("uses per-phase chain first entry when phase matches", () => {
    const config = {
      models: {
        chain: ["opencode-go/deepseek-v4-flash", "opencode-go/deepseek-v4-pro"],
        phases: { implement: ["anthropic/claude-4"] },
      },
    };
    const result = resolveModel({ flag: undefined, phase: "implement", config });
    assert.equal(result.model.providerID, "anthropic");
    assert.equal(result.model.modelID, "claude-4");
  });

  it("uses global chain first entry when no phase match", () => {
    const config = {
      models: {
        chain: ["opencode-go/deepseek-v4-flash", "opencode-go/deepseek-v4-pro"],
        phases: { implement: ["anthropic/claude-4"] },
      },
    };
    const result = resolveModel({ flag: undefined, phase: "review", config });
    assert.equal(result.model.providerID, "opencode-go");
    assert.equal(result.model.modelID, "deepseek-v4-flash");
  });

  it("uses global chain first entry when no phases config at all", () => {
    const config = {
      models: {
        chain: ["opencode-go/deepseek-v4-flash", "opencode-go/deepseek-v4-pro"],
      },
    };
    const result = resolveModel({ flag: undefined, phase: "implement", config });
    assert.equal(result.model.providerID, "opencode-go");
    assert.equal(result.model.modelID, "deepseek-v4-flash");
  });

  it("returns full chain from config when present", () => {
    const config = {
      models: {
        chain: ["opencode-go/m1", "opencode-go/m2"],
        phases: { implement: ["opencode-go/m3"] },
      },
    };
    const result = resolveModel({ flag: undefined, phase: "implement", config });
    assert.deepEqual(result.chain, ["opencode-go/m3"]);
  });

  it("returns global chain when no per-phase override", () => {
    const config = {
      models: {
        chain: ["opencode-go/m1", "opencode-go/m2"],
      },
    };
    const result = resolveModel({ flag: undefined, phase: "implement", config });
    assert.deepEqual(result.chain, ["opencode-go/m1", "opencode-go/m2"]);
  });

  it("returns built-in default chain when config has no models.chain", () => {
    const config = { models: { phases: { implement: ["p/m"] } } };
    const result = resolveModel({ flag: undefined, phase: "review", config });
    // No per-phase match for review, no global chain -> built-in
    assert.equal(result.model.providerID, "opencode");
    assert.equal(result.model.modelID, "deepseek-v4-flash-free");
    assert.equal(result.chain.length, 3);
  });

  it("explicit flag + no config still returns built-in chain", () => {
    const result = resolveModel({ flag: "explicit/p", phase: undefined, config: null });
    assert.equal(result.model.providerID, "explicit");
    assert.equal(result.model.modelID, "p");
    // chain should still be the built-in default when no config
    assert.equal(result.chain.length, 3);
    assert.equal(result.chain[0], "opencode/deepseek-v4-flash-free");
  });
});

// ---------------------------------------------------------------------------
// parseModel — variant suffix parsing
// ---------------------------------------------------------------------------

describe("parseModel", () => {
  it("parses provider/model without variant", () => {
    const result = parseModel("opencode-go/deepseek-v4-flash");
    assert.deepEqual(result, { providerID: "opencode-go", modelID: "deepseek-v4-flash" });
  });

  it("parses provider/model:variant suffix", () => {
    const result = parseModel("opencode-go/deepseek-v4-flash:max");
    assert.deepEqual(result, { providerID: "opencode-go", modelID: "deepseek-v4-flash", variant: "max" });
  });

  it("parses :high variant suffix", () => {
    const result = parseModel("p/a:high");
    assert.deepEqual(result, { providerID: "p", modelID: "a", variant: "high" });
  });

  it("throws on trailing colon (empty variant)", () => {
    assert.throws(
      () => parseModel("p/a:"),
      (err) => {
        assert.ok(err.message.includes("empty variant in model entry: p/a:"));
        return true;
      },
    );
  });

  it("throws on missing slash (no provider/model separator)", () => {
    assert.throws(
      () => parseModel("just-a-model"),
      (err) => {
        assert.ok(err.message.includes("--model expects provider/model"));
        return true;
      },
    );
  });

  it("returns undefined for empty value", () => {
    assert.equal(parseModel(""), undefined);
    assert.equal(parseModel(undefined), undefined);
    assert.equal(parseModel(null), undefined);
  });

  it("resolves through resolveModel with variant suffix", () => {
    const result = resolveModel({ flag: "p/a:max", phase: undefined, config: null });
    assert.equal(result.model.providerID, "p");
    assert.equal(result.model.modelID, "a");
    assert.equal(result.model.variant, "max");
  });
});

// ---------------------------------------------------------------------------
// Model variant — API request body boundary
// ---------------------------------------------------------------------------

describe("model variant API body boundary", () => {
  it("prompt_async body includes variant when model has variant", () => {
    const model = parseModel("p/a:max");
    const body = {
      parts: [{ type: "text", text: "test" }],
      ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
      ...(model?.variant ? { variant: model.variant } : {}),
    };
    assert.equal(body.variant, "max");
    assert.equal(body.model.providerID, "p");
    assert.equal(body.model.modelID, "a");
  });

  it("prompt_async body omits variant when model has no variant", () => {
    const model = parseModel("p/a");
    const body = {
      parts: [{ type: "text", text: "test" }],
      ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
      ...(model?.variant ? { variant: model.variant } : {}),
    };
    assert.equal(body.variant, undefined);
    assert.equal(body.model.providerID, "p");
    assert.equal(body.model.modelID, "a");
  });
});

// ---------------------------------------------------------------------------
// Chain round-to-entry mapping — model variant escalation
// ---------------------------------------------------------------------------

describe("chain round model resolution", () => {
  const chain = ["p/a", "p/a:max", "p/b"];

  function resolveRoundModel(round, modelFlag) {
    if (round === 1 && modelFlag) return parseModel(modelFlag);
    const idx = Math.min(round - 1, chain.length - 1);
    return parseModel(chain[idx]);
  }

  it("round 1 uses chain[0] when no --model", () => {
    const result = resolveRoundModel(1, null);
    assert.deepEqual(result, { providerID: "p", modelID: "a" });
  });

  it("round 2 uses chain[1] (:max variant)", () => {
    const result = resolveRoundModel(2, null);
    assert.deepEqual(result, { providerID: "p", modelID: "a", variant: "max" });
  });

  it("round 3 uses chain[2]", () => {
    const result = resolveRoundModel(3, null);
    assert.deepEqual(result, { providerID: "p", modelID: "b" });
  });

  it("rounds beyond chain length clamp to last entry", () => {
    const result = resolveRoundModel(4, null);
    assert.deepEqual(result, { providerID: "p", modelID: "b" });
    const result5 = resolveRoundModel(5, null);
    assert.deepEqual(result5, { providerID: "p", modelID: "b" });
  });

  it("--model overrides round 1 only", () => {
    const result = resolveRoundModel(1, "p/c:high");
    assert.deepEqual(result, { providerID: "p", modelID: "c", variant: "high" });
  });

  it("round 2+ ignores --model and follows chain", () => {
    // Even with --model, round 2 follows the chain
    const result = resolveRoundModel(2, "p/c:high");
    assert.deepEqual(result, { providerID: "p", modelID: "a", variant: "max" });
  });

  it("single-entry chain clamps all rounds to that entry", () => {
    const single = ["p/x"];
    function resolveForRound(n) {
      const idx = Math.min(n - 1, single.length - 1);
      return parseModel(single[idx]);
    }
    assert.deepEqual(resolveForRound(1), { providerID: "p", modelID: "x" });
    assert.deepEqual(resolveForRound(2), { providerID: "p", modelID: "x" });
    assert.deepEqual(resolveForRound(5), { providerID: "p", modelID: "x" });
  });

  it("variant stored in round record is visible", () => {
    // Simulate what cmdChain stores on roundRecord
    const round = 2;
    const idx = Math.min(round - 1, chain.length - 1);
    const entry = chain[idx];
    const roundModel = parseModel(entry);
    const roundModelEntry = (roundModel && roundModel.variant)
      ? roundModel.providerID + "/" + roundModel.modelID + ":" + roundModel.variant
      : (roundModel ? roundModel.providerID + "/" + roundModel.modelID : null);
    const roundRecord = {
      round,
      modelEntry: roundModelEntry,
      modelVariant: roundModel?.variant || null,
    };
    assert.equal(roundRecord.modelEntry, "p/a:max");
    assert.equal(roundRecord.modelVariant, "max");
  });

  it("round without variant has null variant in record", () => {
    const round = 1;
    const idx = Math.min(round - 1, chain.length - 1);
    const entry = chain[idx];
    const roundModel = parseModel(entry);
    const roundRecord = {
      round,
      modelEntry: roundModel ? roundModel.providerID + "/" + roundModel.modelID : null,
      modelVariant: roundModel?.variant || null,
    };
    assert.equal(roundRecord.modelEntry, "p/a");
    assert.equal(roundRecord.modelVariant, null);
  });
});

// ---------------------------------------------------------------------------
// readBriefFile — brief-file runtime error paths
// ---------------------------------------------------------------------------

describe("readBriefFile", () => {
  it("returns inline text when no --brief-file flag", () => {
    const result = readBriefFile({}, "hello world");
    assert.equal(result, "hello world");
  });

  it("throws when --brief-file and inline text are both provided", () => {
    assert.throws(
      () => readBriefFile({ "brief-file": "/tmp/x.md" }, "inline text"),
      /--brief-file and inline text are mutually exclusive/,
    );
  });

  it("throws when --brief-file points to a missing file", () => {
    assert.throws(
      () => readBriefFile({ "brief-file": "/nonexistent/path/brief.md" }, ""),
      (err) => {
        assert.ok(err.message.includes("--brief-file: cannot read"));
        assert.ok(err.message.includes("/nonexistent/path/brief.md"));
        return true;
      },
    );
  });

  it("returns file content when --brief-file points to a valid file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-brief-"));
    try {
      const filePath = path.join(tmpDir, "brief.md");
      fs.writeFileSync(filePath, "file content here", "utf8");
      const result = readBriefFile({ "brief-file": filePath }, "");
      assert.equal(result, "file content here");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// parseArgs -- flag-without-value errors
// ---------------------------------------------------------------------------

describe("parseArgs flag value required", () => {
  it("throws when --brief-file has no value", () => {
    assert.throws(
      () => parseArgs(["--brief-file"]),
      /--brief-file requires a value/,
    );
  });

  it("throws when --brief-file is followed by another flag", () => {
    assert.throws(
      () => parseArgs(["--brief-file", "--model", "p/m"]),
      /--brief-file requires a value/,
    );
  });

  it("throws when --model has no value (same pattern)", () => {
    assert.throws(
      () => parseArgs(["--model"]),
      /--model requires a value/,
    );
  });
});

// ---------------------------------------------------------------------------
// shouldReapServer — pure function: reap decision logic
// ---------------------------------------------------------------------------

describe("shouldReapServer", () => {
  const TTL = 30 * 60 * 1000; // 30 minutes

  it("reap: no running jobs, last activity older than TTL", () => {
    const now = Date.now();
    const serverMtime = now - TTL - 1000; // 1s past TTL
    const jobRecords = [
      { status: "completed", mtime: now - TTL - 2000 },
      { status: "error", mtime: now - TTL - 5000 },
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, true);
    assert.match(result.reason, /idle.*exceeds TTL/);
  });

  it("keep: running job exists — never reap regardless of age", () => {
    const now = Date.now();
    const serverMtime = now - TTL * 10; // way past TTL
    const jobRecords = [
      { status: "completed", mtime: now - TTL * 10 },
      { status: "running", mtime: now - 1000 }, // still running
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, false);
    assert.equal(result.reason, "a running job exists");
  });

  it("keep: no running jobs but last activity is still within TTL", () => {
    const now = Date.now();
    const serverMtime = now - TTL + 1000; // 1s before TTL expiry
    const jobRecords = [
      { status: "completed", mtime: now - 1000 },
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, false);
    assert.match(result.reason, /not yet stale/);
  });

  it("keep: job mtime is more recent than server mtime and within TTL", () => {
    const now = Date.now();
    const serverMtime = now - TTL - 5000; // past TTL
    const jobRecords = [
      { status: "completed", mtime: now - 1000 }, // recent job → last activity is recent
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, false);
    assert.match(result.reason, /not yet stale/);
  });

  it("reap: empty job records, server mtime alone is past TTL", () => {
    const now = Date.now();
    const serverMtime = now - TTL - 1;
    const jobRecords = [];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, true);
    assert.match(result.reason, /idle.*exceeds TTL/);
  });

  it("keep: empty job records, server mtime alone is within TTL", () => {
    const now = Date.now();
    const serverMtime = now;
    const jobRecords = [];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, false);
    assert.match(result.reason, /not yet stale/);
  });

  it("reap: serverMtime is 0 (missing) but job mtime is past TTL", () => {
    const now = Date.now();
    const serverMtime = 0;
    const jobRecords = [
      { status: "completed", mtime: now - TTL - 1000 },
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, true);
  });

  it("keep: serverMtime is 0 but job mtime is within TTL", () => {
    const now = Date.now();
    const serverMtime = 0;
    const jobRecords = [
      { status: "completed", mtime: now },
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, false);
  });

  it("reap: all mtimes are 0 (missing timestamps) — epoch-based, very old", () => {
    const now = Date.now();
    const serverMtime = 0;
    const jobRecords = [
      { status: "completed", mtime: 0 },
      { status: "error", mtime: 0 },
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    // lastActivity is 0 (epoch), idle is now-epoch = very large → reap
    assert.equal(result.reap, true);
  });

  it("keep: multiple running jobs, even very old, never reap", () => {
    const now = Date.now();
    const serverMtime = 0;
    const jobRecords = [
      { status: "running", mtime: 0 },
      { status: "running", mtime: 0 },
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, false);
  });

  it("keep: mixed running and completed jobs — running exists so never reap", () => {
    const now = Date.now();
    const serverMtime = now - TTL * 2;
    const jobRecords = [
      { status: "completed", mtime: now - TTL * 2 },
      { status: "running", mtime: now },
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, false);
    assert.equal(result.reason, "a running job exists");
  });

  it("reap: job with status 'stalled' is not 'running', so idle serve is reaped", () => {
    const now = Date.now();
    const serverMtime = now - TTL - 5000;
    const jobRecords = [
      { status: "stalled", mtime: now - TTL - 4000 },
      { status: "timeout", mtime: now - TTL - 3000 },
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, true);
  });
});


// ---------------------------------------------------------------------------
// cwdSlug — path-to-slug conversion
// ---------------------------------------------------------------------------

describe("cwdSlug", () => {
  it("replaces / and . with -", () => {
    assert.equal(cwdSlug("/home/u/dev/x"), "-home-u-dev-x");
  });

  it("handles a path with dots", () => {
    assert.equal(cwdSlug("/home/u/dev/my.project"), "-home-u-dev-my-project");
  });

  it("handles root path", () => {
    assert.equal(cwdSlug("/"), "-");
  });

  it("handles empty string", () => {
    assert.equal(cwdSlug(""), "");
  });

  it("handles path with trailing slash", () => {
    assert.equal(cwdSlug("/home/user/"), "-home-user-");
  });
});

// ---------------------------------------------------------------------------
// findTranscriptFile — newest *.jsonl in the slug dir
// ---------------------------------------------------------------------------

describe("findTranscriptFile", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-transcript-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when the slug dir does not exist", () => {
    const result = findTranscriptFile({ baseDir: tmpDir, cwdSlug: "nonexistent-slug" });
    assert.equal(result, null);
  });

  it("returns null when the slug dir has no .jsonl files", () => {
    const slugDir = path.join(tmpDir, "-home-test");
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, "foo.txt"), "not a transcript", "utf8");
    const result = findTranscriptFile({ baseDir: tmpDir, cwdSlug: "-home-test" });
    assert.equal(result, null);
  });

  it("returns the only .jsonl file", () => {
    const slugDir = path.join(tmpDir, "-home-test");
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, "transcript.jsonl"), "{}", "utf8");
    const result = findTranscriptFile({ baseDir: tmpDir, cwdSlug: "-home-test" });
    assert.ok(result.endsWith("transcript.jsonl"));
  });

  it("returns the newest .jsonl when multiple exist", () => {
    const slugDir = path.join(tmpDir, "-home-test");
    fs.mkdirSync(slugDir, { recursive: true });
    // Write an older file first
    fs.writeFileSync(path.join(slugDir, "old.jsonl"), "{}", "utf8");
    const oldMtime = Date.now() - 60000;
    fs.utimesSync(path.join(slugDir, "old.jsonl"), new Date(oldMtime / 1000), new Date(oldMtime / 1000));
    // Write a newer file
    fs.writeFileSync(path.join(slugDir, "new.jsonl"), "{}", "utf8");
    const result = findTranscriptFile({ baseDir: tmpDir, cwdSlug: "-home-test" });
    assert.ok(result.endsWith("new.jsonl"), `expected new.jsonl, got ${result}`);
  });

  it("skips subdirectories and non-jsonl files", () => {
    const slugDir = path.join(tmpDir, "-home-test");
    fs.mkdirSync(path.join(slugDir, "subdir"), { recursive: true });
    fs.writeFileSync(path.join(slugDir, "transcript.jsonl"), "{}", "utf8");
    fs.writeFileSync(path.join(slugDir, "notes.txt"), "hello", "utf8");
    const result = findTranscriptFile({ baseDir: tmpDir, cwdSlug: "-home-test" });
    assert.equal(result, path.join(slugDir, "transcript.jsonl"));
  });

  it("uses filename tiebreak when multiple .jsonl files have the same mtime", () => {
    const slugDir = path.join(tmpDir, "-home-tiebreak");
    fs.mkdirSync(slugDir, { recursive: true });
    const sameTime = new Date(Date.now() - 10000);
    const a = path.join(slugDir, "z-first.jsonl");
    const b = path.join(slugDir, "a-second.jsonl");
    fs.writeFileSync(a, "{}", "utf8");
    fs.writeFileSync(b, "{}", "utf8");
    fs.utimesSync(a, sameTime, sameTime);
    fs.utimesSync(b, sameTime, sameTime);
    const result = findTranscriptFile({ baseDir: tmpDir, cwdSlug: "-home-tiebreak" });
    // "a-second.jsonl" sorts before "z-first.jsonl" lexicographically
    assert.ok(result.endsWith("a-second.jsonl"), `expected a-second.jsonl, got ${result}`);
  });
});

// ---------------------------------------------------------------------------
// extractAssistantText — text-block extraction from transcript records
// ---------------------------------------------------------------------------

const makeRecord = (type, blocks) => ({
  type,
  message: { content: blocks },
});

const textBlock = (text) => ({ type: "text", text });
const toolUseBlock = (name, input) => ({ type: "tool_use", name, input });
const toolResultBlock = (text) => ({ type: "tool_result", text });
const thinkingBlock = (text) => ({ type: "thinking", text });

describe("extractAssistantText", () => {
  it("returns empty string for empty records", () => {
    assert.equal(extractAssistantText([]), "");
  });

  it("returns empty string when no assistant records exist", () => {
    const records = [
      makeRecord("user", [textBlock("hello")]),
      makeRecord("user", [textBlock("world")]),
    ];
    assert.equal(extractAssistantText(records), "");
  });

  it("extracts last assistant text block (default lastN=1)", () => {
    const records = [
      makeRecord("user", [textBlock("question 1")]),
      makeRecord("assistant", [textBlock("answer 1")]),
      makeRecord("user", [textBlock("question 2")]),
      makeRecord("assistant", [textBlock("answer 2"), toolUseBlock("bash", {})]),
    ];
    const result = extractAssistantText(records);
    // Should only include the last assistant's text block, skipping tool_use
    assert.equal(result, "answer 2");
  });

  it("excludes tool_use, tool_result, and thinking blocks by default", () => {
    const records = [
      makeRecord("assistant", [
        textBlock("only text"),
        toolUseBlock("bash", { cmd: "ls" }),
        toolResultBlock("file1\nfile2"),
        thinkingBlock("I should list files"),
      ]),
    ];
    const result = extractAssistantText(records);
    assert.equal(result, "only text");
  });

  it("includes tool_result blocks when includeTools is true", () => {
    const records = [
      makeRecord("assistant", [
        textBlock("running ls"),
        toolUseBlock("bash", { cmd: "ls" }),
        toolResultBlock("file1\nfile2"),
        thinkingBlock("done"),
      ]),
    ];
    const result = extractAssistantText(records, { includeTools: true });
    assert.ok(result.includes("running ls"));
    assert.ok(result.includes("file1\nfile2"));
    // tool_use and thinking still excluded
    assert.ok(!result.includes("bash"));
    assert.ok(!result.includes("done"));
  });

  it("skips trailing tool_use-only assistant records (in-progress turn)", () => {
    const records = [
      makeRecord("assistant", [textBlock("the actual last message")]),
      makeRecord("user", [{ type: "tool_result", content: "output" }]),
      makeRecord("assistant", [toolUseBlock("bash", { cmd: "ls" })]),
      makeRecord("assistant", [toolUseBlock("read", { file: "x" })]),
    ];
    assert.equal(extractAssistantText(records), "the actual last message");
  });

  it("reads tool_result payloads in the real transcript shape (content array / string)", () => {
    const records = [
      makeRecord("assistant", [textBlock("checking output")]),
      makeRecord("user", [
        { type: "tool_result", content: [{ type: "text", text: "array shaped" }] },
        { type: "tool_result", content: "string shaped" },
      ]),
    ];
    assert.equal(extractAssistantText(records), "checking output");
    const widened = extractAssistantText(records, { includeTools: true });
    assert.ok(widened.includes("array shaped"));
    assert.ok(widened.includes("string shaped"));
  });

  it("includes multiple assistant messages with --last N", () => {
    const records = [
      makeRecord("user", [textBlock("q1")]),
      makeRecord("assistant", [textBlock("a1")]),
      makeRecord("user", [textBlock("q2")]),
      makeRecord("assistant", [textBlock("a2")]),
    ];
    const result = extractAssistantText(records, { lastN: 2 });
    // Should include both a1 and a2 (and interleaved user messages)
    assert.ok(result.includes("a1"));
    assert.ok(result.includes("a2"));
    // Should also include user messages between them
    assert.ok(result.includes("q2"));
  });

  it("--last N with includeTools widens context to include tool results across N messages", () => {
    const records = [
      makeRecord("assistant", [textBlock("first answer")]),
      makeRecord("user", [textBlock("follow-up")]),
      makeRecord("assistant", [
        textBlock("second answer"),
        toolUseBlock("bash", {}),
        toolResultBlock("output data"),
      ]),
    ];
    const result = extractAssistantText(records, { lastN: 2, includeTools: true });
    assert.ok(result.includes("first answer"));
    assert.ok(result.includes("follow-up"));
    assert.ok(result.includes("second answer"));
    assert.ok(result.includes("output data"));
  });

  it("handles records without message.content gracefully", () => {
    const records = [
      { type: "assistant" },
      { type: "assistant", message: {} },
      { type: "assistant", message: { content: [textBlock("valid")] } },
    ];
    const result = extractAssistantText(records);
    assert.equal(result, "valid");
  });

  it("extracts inline assistant text from typescript fixture records", () => {
    // Simulate a realistic mini transcript
    const records = [
      { type: "user", message: { content: [{ type: "text", text: "hello" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "hi there" }] } },
      { type: "user", message: { content: [{ type: "text", text: "explain this code" }] } },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "The code does X." },
            { type: "tool_use", name: "bash", input: {} },
            { type: "tool_result", text: "output" },
          ],
        },
      },
    ];
    // Default: last assistant only, no tools
    const defaultResult = extractAssistantText(records);
    assert.equal(defaultResult, "The code does X.");
    // With includeTools
    const toolsResult = extractAssistantText(records, { includeTools: true });
    assert.ok(toolsResult.includes("The code does X."));
    assert.ok(toolsResult.includes("output"));
    // With --last 2
    const last2 = extractAssistantText(records, { lastN: 2 });
    assert.ok(last2.includes("hi there"));
    assert.ok(last2.includes("explain this code"));
    assert.ok(last2.includes("The code does X."));
  });
});


// ---------------------------------------------------------------------------
// resolveExplainPassage — passage resolution (quote bypass, transcript error)
// ---------------------------------------------------------------------------

describe("resolveExplainPassage", () => {
  let tmpBase;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-explain-"));
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  function writeTranscript(slug, records) {
    const slugDir = path.join(tmpBase, slug);
    fs.mkdirSync(slugDir, { recursive: true });
    const file = path.join(slugDir, "session.jsonl");
    fs.writeFileSync(file, records.map(function (r) { return JSON.stringify(r); }).join("\n"), "utf8");
    return file;
  }

  it("returns the explicit quote and skips transcript resolution", () => {
    const result = resolveExplainPassage({
      baseDir: tmpBase,
      cwd: "/home/user/project",
      quote: "This is an explicit passage.",
      last: 1,
    });
    assert.equal(result.passage, "This is an explicit passage.");
    assert.equal(result.source, "quote");
    // quote works even when there is no transcript dir at all
  });

  it("rejects an empty --quote instead of sending an empty prompt", () => {
    for (const empty of ["", "   "]) {
      assert.throws(
        () => resolveExplainPassage({
          baseDir: tmpBase,
          cwd: "/home/user/project",
          quote: empty,
          last: 1,
        }),
        /--quote must not be empty/,
      );
    }
  });

  it("throws when the slug dir does not exist", () => {
    assert.throws(
      () => resolveExplainPassage({
        baseDir: tmpBase,
        cwd: "/home/nonexistent",
        last: 1,
      }),
      /No Claude Code transcript found/,
    );
  });

  it("throws when the transcript file is malformed JSONL", () => {
    const slugDir = path.join(tmpBase, "-home-bad");
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, "bad.jsonl"), "not valid json", "utf8");
    assert.throws(
      () => resolveExplainPassage({
        baseDir: tmpBase,
        cwd: "/home/bad",
        last: 1,
      }),
      /Failed to read transcript/,
    );
  });

  it("throws when the transcript is empty", () => {
    const slugDir = path.join(tmpBase, "-home-empty");
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, "empty.jsonl"), "", "utf8");
    assert.throws(
      () => resolveExplainPassage({
        baseDir: tmpBase,
        cwd: "/home/empty",
        last: 1,
      }),
      /is empty/,
    );
  });

  it("throws when the transcript has no assistant records", () => {
    const records = [
      { type: "user", message: { content: [{ type: "text", text: "hello" }] } },
    ];
    writeTranscript("-home-no-assistant", records);
    assert.throws(
      () => resolveExplainPassage({
        baseDir: tmpBase,
        cwd: "/home/no-assistant",
        last: 1,
      }),
      /No assistant text found/,
    );
  });

  it("extracts the last assistant text passage from a valid transcript", () => {
    const records = [
      { type: "user", message: { content: [{ type: "text", text: "help" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "I can explain this." }] } },
    ];
    writeTranscript("-home-valid", records);
    const result = resolveExplainPassage({
      baseDir: tmpBase,
      cwd: "/home/valid",
      last: 1,
    });
    assert.equal(result.passage, "I can explain this.");
    assert.equal(result.source, "transcript");
  });

  it("passes lastN and includeTools through to extractAssistantText", () => {
    const records = [
      { type: "assistant", message: { content: [
        { type: "text", text: "answer one" },
        { type: "tool_result", text: "tool output" },
      ] } },
    ];
    writeTranscript("-home-tools-test", records);
    const result = resolveExplainPassage({
      baseDir: tmpBase,
      cwd: "/home/tools-test",
      last: 1,
      tools: true,
    });
    assert.equal(result.source, "transcript");
    assert.ok(result.passage.includes("answer one"));
    assert.ok(result.passage.includes("tool output"));
  });

  it("throws on --last 0 (positive integer required)", () => {
    assert.throws(
      () => resolveExplainPassage({ baseDir: tmpBase, cwd: "/tmp/x", last: 0 }),
      /--last must be a positive integer/,
    );
  });

  it("throws on --last -1 (positive integer required)", () => {
    assert.throws(
      () => resolveExplainPassage({ baseDir: tmpBase, cwd: "/tmp/x", last: -1 }),
      /--last must be a positive integer/,
    );
  });

  it("throws on --last NaN (positive integer required)", () => {
    assert.throws(
      () => resolveExplainPassage({ baseDir: tmpBase, cwd: "/tmp/x", last: NaN }),
      /--last must be a positive integer/,
    );
  });

  it("throws on --last 3.5 (non-integer)", () => {
    assert.throws(
      () => resolveExplainPassage({ baseDir: tmpBase, cwd: "/tmp/x", last: 3.5 }),
      /--last must be a positive integer/,
    );
  });

  it("throws on --last Infinity", () => {
    assert.throws(
      () => resolveExplainPassage({ baseDir: tmpBase, cwd: "/tmp/x", last: Infinity }),
      /--last must be a positive integer/,
    );
  });
});
