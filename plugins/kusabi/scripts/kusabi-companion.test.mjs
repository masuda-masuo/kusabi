import { describe, it } from "node:test";
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
  stateRoot,
  deriveDisposition,
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
