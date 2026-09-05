import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// sunaba-rpc-compact: acceptance tests for compact structuredContent support
//
// These tests define the contract the implementation must satisfy.
// At baseline (before implementation) the compact-related tests are RED;
// the legacy / regression tests should be GREEN.
// ---------------------------------------------------------------------------

describe("sunaba-rpc compact response support", () => {
  // Helper: build a JSON-RPC SSE response body
  function sseBody(result) {
    return `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}`;
  }

  // Helper: build a compact tools/call result envelope
  function compactEnvelope(structuredContent, text = "Result: ...") {
    return {
      content: [{ type: "text", text }],
      structuredContent,
    };
  }

  // -----------------------------------------------------------------------
  // Criterion 1: Legacy JSON text still parses to original value
  //              even alongside FastMCP {result:JSON-string} structured wrapper
  // -----------------------------------------------------------------------
  describe("legacy JSON text (criterion 1)", () => {
    it("parses text JSON and ignores structuredContent when it is a legacy wrapper", async () => {
      const { unwrapResult } = await import("./sunaba-rpc.mjs");
      const text = JSON.stringify({ gate_passed: true, summary: "all green" });
      const result = unwrapResult({
        content: [{ type: "text", text }],
        structuredContent: { result: text },
      });
      assert.deepEqual(result, { gate_passed: true, summary: "all green" });
    });

    it("treats structuredContent as legacy when result string exactly matches text", async () => {
      const { unwrapResult } = await import("./sunaba-rpc.mjs");
      const text = '{"output":"abc\\n","exit_code":0}';
      const result = unwrapResult({
        content: [{ type: "text", text }],
        structuredContent: { result: text },
      });
      assert.deepEqual(result, { output: "abc\n", exit_code: 0 });
    });
  });

  // -----------------------------------------------------------------------
  // Criterion 2: Compact direct objects are returned whole, including nested
  //              fields and objects with a genuine result key.
  //              Treat structuredContent as authoritative except identifiable
  //              legacy duplicate wrapper.
  // -----------------------------------------------------------------------
  describe("compact structuredContent (criterion 2)", () => {
    it("returns structuredContent as-is instead of truncated summary text", async () => {
      const { unwrapResult } = await import("./sunaba-rpc.mjs");
      const structuredContent = { output: "full output\n", exit_code: 0 };
      const result = unwrapResult({
        content: [{ type: "text", text: "Result: {truncated..." }],
        structuredContent,
      });
      assert.deepEqual(result, structuredContent);
    });

    it("preserves nested objects in structuredContent", async () => {
      const { unwrapResult } = await import("./sunaba-rpc.mjs");
      const structuredContent = {
        items: [
          { name: "a", meta: { x: 1 } },
          { name: "b", meta: { x: 2 } },
        ],
        total: 2,
      };
      const result = unwrapResult({
        content: [{ type: "text", text: "Result: [nested]" }],
        structuredContent,
      });
      assert.deepEqual(result, structuredContent);
      assert.deepEqual(result.items[0].meta, { x: 1 });
    });

    it("does not unwrap an object that has a genuine result key (not legacy)", async () => {
      const { unwrapResult } = await import("./sunaba-rpc.mjs");
      const structuredContent = { result: "actual text", code: 0 };
      const result = unwrapResult({
        content: [{ type: "text", text: "Result: actual text" }],
        structuredContent,
      });
      // Must return the full object, not just the bare string
      assert.deepEqual(result, { result: "actual text", code: 0 });
      assert.equal(typeof result, "object");
    });

    it("treats structuredContent as compact when result string does not match text", async () => {
      const { unwrapResult } = await import("./sunaba-rpc.mjs");
      const structuredContent = { result: "different text" };
      const result = unwrapResult({
        content: [{ type: "text", text: "Result: summary" }],
        structuredContent,
      });
      assert.deepEqual(result, { result: "different text" });
    });
  });

  // -----------------------------------------------------------------------
  // Criterion 3: Structured-only object / empty content works;
  //              compact {items:[]} and {result:null|false|0|'text'} retain
  //              their declared object shapes, no speculative unwrap.
  // -----------------------------------------------------------------------
  describe("structured-only / empty content (criterion 3)", () => {
    it("returns {items:[...]} as-is with empty content", async () => {
      const { unwrapResult } = await import("./sunaba-rpc.mjs");
      const structuredContent = { items: [1, 2, 3] };
      const result = unwrapResult({
        content: [],
        structuredContent,
      });
      assert.deepEqual(result, { items: [1, 2, 3] });
    });

    it("returns {items:[]} for an empty list", async () => {
      const { unwrapResult } = await import("./sunaba-rpc.mjs");
      const structuredContent = { items: [] };
      const result = unwrapResult({
        content: [],
        structuredContent,
      });
      assert.deepEqual(result, { items: [] });
    });

    it("returns {result:null} as an object, not bare null", async () => {
      const { unwrapResult } = await import("./sunaba-rpc.mjs");
      const result = unwrapResult({
        content: [{ type: "text", text: "Result: null" }],
        structuredContent: { result: null },
      });
      assert.deepEqual(result, { result: null });
      assert.equal(typeof result, "object");
    });

    it("returns {result:false} as an object, not bare false", async () => {
      const { unwrapResult } = await import("./sunaba-rpc.mjs");
      const result = unwrapResult({
        content: [{ type: "text", text: "Result: false" }],
        structuredContent: { result: false },
      });
      assert.deepEqual(result, { result: false });
      assert.equal(typeof result, "object");
    });

    it("returns {result:0} as an object, not bare 0", async () => {
      const { unwrapResult } = await import("./sunaba-rpc.mjs");
      const result = unwrapResult({
        content: [{ type: "text", text: "Result: 0" }],
        structuredContent: { result: 0 },
      });
      assert.deepEqual(result, { result: 0 });
      assert.equal(typeof result, "object");
    });

    it("returns {result:'text'} as an object, not bare string", async () => {
      const { unwrapResult } = await import("./sunaba-rpc.mjs");
      const result = unwrapResult({
        content: [{ type: "text", text: "Result: hello" }],
        structuredContent: { result: "hello" },
      });
      assert.deepEqual(result, { result: "hello" });
      assert.equal(typeof result, "object");
    });
  });

  // -----------------------------------------------------------------------
  // Criterion 4: Missing/null/malformed scalar structuredContent falls back
  //              to existing text/raw behavior; supported structuredContent
  //              is a non-array object. Arrays are invalid MCP shape.
  // -----------------------------------------------------------------------
  describe("fallback for missing/null/malformed structuredContent (criterion 4)", () => {
    it("falls back to text parsing when structuredContent is absent", async () => {
      const { unwrapResult } = await import("./sunaba-rpc.mjs");
      const result = unwrapResult({
        content: [{ type: "text", text: '{"key":"value"}' }],
      });
      assert.deepEqual(result, { key: "value" });
    });

    it("falls back to text parsing when structuredContent is null", async () => {
      const { unwrapResult } = await import("./sunaba-rpc.mjs");
      const result = unwrapResult({
        content: [{ type: "text", text: '{"key":"value"}' }],
        structuredContent: null,
      });
      assert.deepEqual(result, { key: "value" });
    });

    it("falls back to text parsing when structuredContent is an array (invalid MCP shape)", async () => {
      const { unwrapResult } = await import("./sunaba-rpc.mjs");
      const result = unwrapResult({
        content: [{ type: "text", text: '{"key":"value"}' }],
        structuredContent: [1, 2, 3],
      });
      assert.deepEqual(result, { key: "value" });
    });

    it("falls back to raw text when structuredContent is a primitive string", async () => {
      const { unwrapResult } = await import("./sunaba-rpc.mjs");
      const result = unwrapResult({
        content: [{ type: "text", text: "plain output" }],
        structuredContent: "not-an-object",
      });
      assert.equal(result, "plain output");
    });

    it("falls back to raw text when structuredContent is a number", async () => {
      const { unwrapResult } = await import("./sunaba-rpc.mjs");
      const result = unwrapResult({
        content: [{ type: "text", text: "plain output" }],
        structuredContent: 42,
      });
      assert.equal(result, "plain output");
    });
  });

  // -----------------------------------------------------------------------
  // Criterion 5: Do not change existing isError handling contract;
  //              error payload object remains available; existing
  //              JSON-RPC error tests unchanged.
  // -----------------------------------------------------------------------
  describe("isError handling (criterion 5)", () => {
    it("text-parsed error payload is returned even with isError on envelope", async () => {
      const { unwrapResult } = await import("./sunaba-rpc.mjs");
      const result = unwrapResult({
        content: [{ type: "text", text: '{"error":"something failed"}' }],
        isError: true,
      });
      assert.deepEqual(result, { error: "something failed" });
    });

    it("compact structuredContent with isError returns the error object", async () => {
      const { unwrapResult } = await import("./sunaba-rpc.mjs");
      const errorPayload = { message: "sandbox_exec failed", code: 1 };
      const result = unwrapResult({
        content: [{ type: "text", text: "Result: sandbox_exec failed" }],
        structuredContent: errorPayload,
        isError: true,
      });
      assert.deepEqual(result, errorPayload);
    });

    it("parseSseResponse still throws on JSON-RPC error (unchanged contract)", async () => {
      const { parseSseResponse } = await import("./sunaba-rpc.mjs");
      const body =
        'data: {"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"internal error"}}';
      assert.throws(() => parseSseResponse(body), /internal error/);
    });
  });

  // -----------------------------------------------------------------------
  // Criterion 6: Mock fetch handshake + tools/call to prove callTool
  //              receives full compact output, not just a gate summary.
  //              No live HTTP dependencies.
  // -----------------------------------------------------------------------
  describe("callTool compact pipeline with mocked fetch (criterion 6)", () => {
    let originalFetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("returns full structuredContent, not truncated summary text", async () => {
      const compactStructured = {
        output: "full detailed output from sandbox_exec\n",
        exit_code: 0,
        summary: "gate passed",
      };

      const toolBody = sseBody(
        compactEnvelope(compactStructured, "Result: gate passed"),
      );

      let callCount = 0;
      globalThis.fetch = async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true,
            headers: { get: (h) => (h === "mcp-session-id" ? "sess-123" : null) },
            body: { cancel: async () => {} },
          };
        }
        if (callCount === 2) {
          return {
            ok: true,
            headers: { get: () => null },
            body: { cancel: async () => {} },
          };
        }
        return {
          ok: true,
          headers: { get: () => null },
          text: async () => toolBody,
        };
      };

      const { callTool } = await import("./sunaba-rpc.mjs");
      const result = await callTool("sandbox_exec", { commands: ["ls"] });

      assert.deepEqual(result, compactStructured);
      assert.equal(result.output, "full detailed output from sandbox_exec\n");
      assert.equal(result.exit_code, 0);
    });

    it("returns legacy JSON text correctly through full pipeline", async () => {
      const legacyJson = JSON.stringify({
        output: "legacy output\n",
        exit_code: 0,
      });
      const toolBody = sseBody({
        content: [{ type: "text", text: legacyJson }],
        structuredContent: { result: legacyJson },
      });

      let callCount = 0;
      globalThis.fetch = async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true,
            headers: { get: (h) => (h === "mcp-session-id" ? "sess-123" : null) },
            body: { cancel: async () => {} },
          };
        }
        if (callCount === 2) {
          return {
            ok: true,
            headers: { get: () => null },
            body: { cancel: async () => {} },
          };
        }
        return {
          ok: true,
          headers: { get: () => null },
          text: async () => toolBody,
        };
      };

      const { callTool } = await import("./sunaba-rpc.mjs");
      const result = await callTool("sandbox_exec", { commands: ["ls"] });
      assert.deepEqual(result, { output: "legacy output\n", exit_code: 0 });
    });

    it("structured-only callTool result with empty content", async () => {
      const toolBody = sseBody({
        content: [],
        structuredContent: { items: [] },
      });

      let callCount = 0;
      globalThis.fetch = async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true,
            headers: { get: (h) => (h === "mcp-session-id" ? "sess-123" : null) },
            body: { cancel: async () => {} },
          };
        }
        if (callCount === 2) {
          return {
            ok: true,
            headers: { get: () => null },
            body: { cancel: async () => {} },
          };
        }
        return {
          ok: true,
          headers: { get: () => null },
          text: async () => toolBody,
        };
      };

      const { callTool } = await import("./sunaba-rpc.mjs");
      const result = await callTool("verify_in_container", {});
      assert.deepEqual(result, { items: [] });
    });
  });

  // -----------------------------------------------------------------------
  // Criterion 7: Existing allowlist, endpoint default, error strings and
  //              HTTP transport semantics stay unchanged.
  // -----------------------------------------------------------------------
  describe("existing contracts unchanged (criterion 7)", () => {
    it("allowlist enforcement still works", async () => {
      const { callTool } = await import("./sunaba-rpc.mjs");
      await assert.rejects(
        () => callTool("publish", {}),
        /not in the allowed list/,
      );
    });

    it("sandbox_exec rejects string commands", async () => {
      const { callTool } = await import("./sunaba-rpc.mjs");
      await assert.rejects(
        () => callTool("sandbox_exec", { commands: "git status" }),
        /commands.*must be an array/,
      );
    });

    it("unwrapResult handles non-object input", async () => {
      const { unwrapResult } = await import("./sunaba-rpc.mjs");
      assert.equal(unwrapResult(null), null);
      assert.equal(unwrapResult("string"), "string");
      assert.equal(unwrapResult(42), 42);
    });

    it("unwrapResult returns raw result when content is absent", async () => {
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

    it("parseSseResponse extracts last data line", async () => {
      const { parseSseResponse } = await import("./sunaba-rpc.mjs");
      const body = [
        'data: {"jsonrpc":"2.0","id":1,"result":{"a":1}}',
        'data: {"jsonrpc":"2.0","id":2,"result":{"b":2}}',
      ].join("\n");
      const result = parseSseResponse(body);
      assert.deepEqual(result, { b: 2 });
    });

    it("parseSseResponse throws on empty body", async () => {
      const { parseSseResponse } = await import("./sunaba-rpc.mjs");
      assert.throws(() => parseSseResponse(""), /no data lines/);
    });
  });
});
