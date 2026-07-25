import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { callTool, unwrapResult, parseSseResponse } from "./sunaba-rpc.mjs";

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

