#!/usr/bin/env node
// sunaba-rpc: raw JSON-RPC (streamable HTTP) client for Sunaba.
//
// This module is NOT an MCP client — it speaks plain HTTP POST + SSE
// to the Sunaba MCP endpoint so the companion's non-LLM pipeline can
// invoke a limited set of tools (verify_in_container, sandbox_exec,
// checkpoint, checkpoint_list, checkpoint_restore) without going
// through the LLM layer.
//
// The tool allowlist is hardcoded — no configuration can widen it.
// This is a deliberate design invariant: publish and issue write are
// structurally uncallable from here.

import { fileURLToPath } from "node:url";
import process from "node:process";

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const ALLOWED_TOOLS = new Set([
  "verify_in_container",
  "sandbox_exec",
  "checkpoint",
  "checkpoint_list",
  "checkpoint_restore",
]);

// 127.0.0.1 (not "localhost"): node fetch may resolve localhost to ::1 while
// the sunaba systemd service binds IPv4 only. Port 8750 is the live binding.
const DEFAULT_ENDPOINT = "http://127.0.0.1:8750/mcp";

// Streamable HTTP requires this Accept header on every request (406 without).
const BASE_HEADERS = {
  "content-type": "application/json",
  "accept": "application/json, text/event-stream",
};

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

let _requestId = 0;
function nextId() {
  return ++_requestId;
}

function jsonRpcRequest(method, params) {
  return {
    jsonrpc: "2.0",
    id: nextId(),
    method,
    params: params ?? {},
  };
}

// ---------------------------------------------------------------------------
// SSE response parsing
// ---------------------------------------------------------------------------

/**
 * Parse an SSE-style response body and return the last data line as parsed JSON.
 * Sunaba's streamable HTTP returns lines like:
 *   data: {"jsonrpc":"2.0","id":1,"result":{...}}
 *
 * We collect all data: lines, and the *last* one is the complete result
 * (intermediate lines may be progress notifications).
 */
function parseSseResponse(body) {
  const dataLines = [];
  for (const line of body.split("\n")) {
    if (line.startsWith("data:")) {
      const json = line.slice(5).trim();
      if (json) {
        dataLines.push(json);
      }
    }
  }
  if (dataLines.length === 0) {
    throw new Error("sunaba-rpc: no data lines in SSE response");
  }
  // The last data line carries the final result (or error).
  const last = JSON.parse(dataLines[dataLines.length - 1]);
  if (last.error) {
    const msg = last.error.message ?? JSON.stringify(last.error);
    throw new Error(`sunaba-rpc error: ${msg}`);
  }
  if (last.result === undefined || last.result === null) {
    throw new Error("sunaba-rpc: response has no result");
  }
  return last.result;
}

/**
 * Unwrap the MCP tools/call response envelope.
 *
 * Sunaba returns `{ content: [{ type: "text", text: "<JSON string>" }] }`.
 * We extract and parse the text from content[0].
 * If content is empty or absent, return the raw result as-is (some tools
 * like initialize return non-content results).
 *
 * For sandbox_exec specifically, the parsed JSON uses field name `output`
 * (not `stdout`).
 */
function unwrapResult(result) {
  if (!result || typeof result !== "object") return result;
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) {
    // Non-content result (e.g. initialize serverInfo); return as-is.
    return result;
  }
  const first = content[0];
  if (first?.type === "text" && typeof first.text === "string") {
    try {
      return JSON.parse(first.text);
    } catch {
      // text is not JSON; return the raw string value as a convenience
      return first.text;
    }
  }
  // Unknown content shape; return the whole result.
  return result;
}

// ---------------------------------------------------------------------------
// HTTP transport (streamable HTTP)
// ---------------------------------------------------------------------------

/**
 * Perform a full streamable HTTP handshake + tool call:
 * 1. POST /mcp with {"method":"initialize",...} → read session-id from header
 * 2. POST /mcp with {"method":"notifications/initialized",...} (no response expected)
 * 3. POST /mcp with {"method":"tools/call",...} → parse SSE, return result
 */
export async function callTool(toolName, args = {}) {
  if (!ALLOWED_TOOLS.has(toolName)) {
    throw new Error(
      `sunaba-rpc: tool "${toolName}" is not in the allowed list. ` +
      `Allowed: ${[...ALLOWED_TOOLS].join(", ")}`,
    );
  }

  // Validate sandbox_exec commands is always an array
  if (toolName === "sandbox_exec" && args.commands !== undefined) {
    if (!Array.isArray(args.commands)) {
      throw new Error(
        'sunaba-rpc: sandbox_exec "commands" must be an array (string received)',
      );
    }
  }

  const endpoint = process.env.KUSABI_SUNABA_URL || DEFAULT_ENDPOINT;

  // ------ Phase 1: initialize ------
  const initReq = jsonRpcRequest("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "kusabi-companion", version: "1.0.0" },
  });

  const initRes = await fetch(endpoint, {
    method: "POST",
    headers: BASE_HEADERS,
    body: JSON.stringify(initReq),
  });

  if (!initRes.ok) {
    throw new Error(
      `sunaba-rpc: initialize failed (HTTP ${initRes.status})`,
    );
  }

  const sessionId = initRes.headers.get("mcp-session-id");
  if (!sessionId) {
    throw new Error(
      "sunaba-rpc: initialize response missing mcp-session-id header",
    );
  }

  // Parse initialize result (may be SSE or direct JSON; we only need the
  // session-id from the header, but drain the body to keep the connection healthy).
  await initRes.body?.cancel();

  // ------ Phase 2: notifications/initialized (fire-and-forget) ------
  const notifReq = jsonRpcRequest("notifications/initialized", {});
  // Notifications have no id in JSON-RPC, but our helper always adds one.
  // We strip it here to comply with the spec (notifications are id-less).
  delete notifReq.id;

  const notifRes = await fetch(endpoint, {
    method: "POST",
    headers: { ...BASE_HEADERS, "mcp-session-id": sessionId },
    body: JSON.stringify(notifReq),
  });
  // Drain body (notifications produce no meaningful response body).
  await notifRes.body?.cancel();

  // ------ Phase 3: tools/call ------
  const toolReq = jsonRpcRequest("tools/call", { name: toolName, arguments: args });

  const toolRes = await fetch(endpoint, {
    method: "POST",
    headers: { ...BASE_HEADERS, "mcp-session-id": sessionId },
    body: JSON.stringify(toolReq),
  });

  if (!toolRes.ok) {
    throw new Error(
      `sunaba-rpc: tools/call failed (HTTP ${toolRes.status})`,
    );
  }

  const body = await toolRes.text();
  const raw = parseSseResponse(body);
  return unwrapResult(raw);
}

// ---------------------------------------------------------------------------
// convenience wrappers
// ---------------------------------------------------------------------------

export async function verifyInContainer(args = {}) {
  return callTool("verify_in_container", args);
}

export async function sandboxExec(args = {}) {
  return callTool("sandbox_exec", args);
}

export async function checkpoint(args = {}) {
  return callTool("checkpoint", args);
}

export async function checkpointList(args = {}) {
  return callTool("checkpoint_list", args);
}

export async function checkpointRestore(args = {}) {
  return callTool("checkpoint_restore", args);
}

// Exported for testing
export { unwrapResult, parseSseResponse };

// ---------------------------------------------------------------------------
// CLI entry (for testing)
// ---------------------------------------------------------------------------

async function main() {
  const [toolName, ...jsonArgs] = process.argv.slice(2);
  if (!toolName) {
    process.stdout.write("Usage: sunaba-rpc.mjs <toolName> [jsonArgs]\\n");
    process.exit(1);
  }
  const args = jsonArgs.length ? JSON.parse(jsonArgs.join(" ")) : {};
  const result = await callTool(toolName, args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\\n`);
    process.exit(1);
  });
}
