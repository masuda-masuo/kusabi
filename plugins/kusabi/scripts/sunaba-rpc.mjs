#!/usr/bin/env node
// sunaba-rpc: raw JSON-RPC (streamable HTTP) client for Sunaba.
//
// This module is NOT an MCP client — it speaks plain HTTP POST + SSE
// to the Sunaba MCP endpoint so the companion's non-LLM pipeline can
// invoke a limited set of tools (verify_in_container, sandbox_exec,
// checkpoint, checkpoint_list, copy_file) without going through the LLM layer.
//
// The tool allowlist is hardcoded — no configuration can widen it.
// This is a deliberate design invariant: publish and issue write are
// structurally uncallable from here.  checkpoint_restore was removed
// in issue #114 — the chain never rolls the worktree back.
//
// kusabi #530 follow-up (mission-mucv2fzt47784ba9): the three read-only
// Luna probe tools (read_file_range, search_in_container, list_files) were
// added so the deterministic mission driver's mediated read_probe requests
// reach the real bridge in production.  They are READ-ONLY — nothing with
// write or exec authority was added.

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
  "copy_file",
  // The exact read-only probe tools the luna mission driver mediates for the
  // gpt-5.6-luna coordinator seat (kusabi #530).  Nothing else is added: the
  // write/exec authority boundary above is unchanged.
  "read_file_range",
  "search_in_container",
  "list_files",
]);

// 127.0.0.1 (not "localhost"): node fetch may resolve localhost to ::1 while
// the sunaba systemd service binds IPv4 only. Port 8750 is the live binding.
const DEFAULT_ENDPOINT = "http://127.0.0.1:8750/mcp";

// Streamable HTTP requires this Accept header on every request (406 without).
const BASE_HEADERS = {
  "content-type": "application/json",
  "accept": "application/json, text/event-stream",
};

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 1_800_000;

function resolveTimeoutMs(envName, fallback) {
  const v = Number(process.env[envName]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

function resolveCallTimeoutMs(opts) {
  if (typeof opts === "number" && Number.isInteger(opts) && opts > 0) {
    return opts;
  }
  if (opts && typeof opts === "object" && opts.timeoutMs !== undefined) {
    const v = Number(opts.timeoutMs);
    if (Number.isInteger(v) && v > 0) {
      return v;
    }
  }
  return resolveTimeoutMs("KUSABI_SUNABA_CALL_TIMEOUT_MS", DEFAULT_CALL_TIMEOUT_MS);
}

function isTimeoutOrAbortError(err) {
  if (!err) return false;
  if (err.name === "TimeoutError" || err.name === "AbortError") return true;
  if (err.cause && typeof err.cause === "object") {
    if (err.cause.name === "TimeoutError" || err.cause.name === "AbortError") return true;
  }
  return false;
}

function translateTimeout(err, step, ms, endpoint) {
  if (err?.code === "SUNABA_RPC_TIMEOUT") {
    return err;
  }
  if (isTimeoutOrAbortError(err)) {
    const error = new Error(
      `sunaba-rpc: ${step} timed out after ${ms} ms (${endpoint}) — the sunaba daemon accepted the connection but did not answer`,
    );
    error.code = "SUNABA_RPC_TIMEOUT";
    return error;
  }
  return err;
}

async function boundedFetch(step, endpoint, init, ms) {
  const signal = init.signal ?? AbortSignal.timeout(ms);
  try {
    return await fetch(endpoint, { ...init, signal });
  } catch (err) {
    throw translateTimeout(err, step, ms, endpoint);
  }
}

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

  const structuredContent = result.structuredContent;
  const content = result.content;

  // If structuredContent is a non-null, non-array object, decide whether
  // it is compact (authoritative) or legacy (duplicate wrapper).
  //
  // Legacy shape: { result: <string exactly equal to content[0].text> }
  //   – FastMCP sends the full JSON string in both text and structuredContent.
  //   – We must fall through to text parsing to preserve legacy behaviour.
  //
  // Compact shape: everything else that is a valid object.
  //   – structuredContent holds the decoded dict directly; return it whole.
  if (
    structuredContent !== null &&
    structuredContent !== undefined &&
    typeof structuredContent === "object" &&
    !Array.isArray(structuredContent)
  ) {
    const keys = Object.keys(structuredContent);
    const firstText =
      Array.isArray(content) &&
      content.length > 0 &&
      content[0]?.type === "text" &&
      typeof content[0].text === "string"
        ? content[0].text
        : undefined;

    const isLegacy =
      keys.length === 1 &&
      keys[0] === "result" &&
      typeof structuredContent.result === "string" &&
      structuredContent.result === firstText;

    if (!isLegacy) {
      // Compact: structuredContent is authoritative — return it whole.
      return structuredContent;
    }
    // Legacy duplicated wrapper — fall through to text parsing below.
  }

  // Original text-based unwrap (legacy path).
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
export async function callTool(toolName, args = {}, opts = {}) {
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
  const handshakeTimeoutMs = resolveTimeoutMs(
    "KUSABI_SUNABA_HANDSHAKE_TIMEOUT_MS",
    DEFAULT_HANDSHAKE_TIMEOUT_MS,
  );
  const callTimeoutMs = resolveCallTimeoutMs(opts);

  // ------ Phase 1: initialize ------
  const initReq = jsonRpcRequest("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "kusabi-companion", version: "1.0.0" },
  });

  const initRes = await boundedFetch("initialize", endpoint, {
    method: "POST",
    headers: BASE_HEADERS,
    body: JSON.stringify(initReq),
  }, handshakeTimeoutMs);

  if (!initRes.ok) {
    await initRes.body?.cancel().catch(() => {});
    throw new Error(
      `sunaba-rpc: initialize failed (HTTP ${initRes.status})`,
    );
  }

  const sessionId = initRes.headers.get("mcp-session-id");
  if (!sessionId) {
    await initRes.body?.cancel().catch(() => {});
    throw new Error(
      "sunaba-rpc: initialize response missing mcp-session-id header",
    );
  }

  // Parse initialize result (may be SSE or direct JSON; we only need the
  // session-id from the header, but drain the body to keep the connection healthy).
  await initRes.body?.cancel().catch(() => {});

  // ------ Phase 2: notifications/initialized (fire-and-forget) ------
  const notifReq = jsonRpcRequest("notifications/initialized", {});
  // Notifications have no id in JSON-RPC, but our helper always adds one.
  // We strip it here to comply with the spec (notifications are id-less).
  delete notifReq.id;

  const notifRes = await boundedFetch("notifications/initialized", endpoint, {
    method: "POST",
    headers: { ...BASE_HEADERS, "mcp-session-id": sessionId },
    body: JSON.stringify(notifReq),
  }, handshakeTimeoutMs);
  // Drain body (notifications produce no meaningful response body).
  await notifRes.body?.cancel().catch(() => {});

  // ------ Phase 3: tools/call ------
  const toolReq = jsonRpcRequest("tools/call", { name: toolName, arguments: args });

  const callSignal = AbortSignal.timeout(callTimeoutMs);
  const toolRes = await boundedFetch(`tools/call ${toolName}`, endpoint, {
    method: "POST",
    headers: { ...BASE_HEADERS, "mcp-session-id": sessionId },
    body: JSON.stringify(toolReq),
    signal: callSignal,
  }, callTimeoutMs);

  if (!toolRes.ok) {
    await toolRes.body?.cancel().catch(() => {});
    throw new Error(
      `sunaba-rpc: tools/call failed (HTTP ${toolRes.status})`,
    );
  }

  let body;
  try {
    body = await toolRes.text();
  } catch (err) {
    throw translateTimeout(err, `tools/call ${toolName}`, callTimeoutMs, endpoint);
  }

  const raw = parseSseResponse(body);
  return unwrapResult(raw);
}

// ---------------------------------------------------------------------------
// convenience wrappers (used by the companion's non-LLM pipeline)
// ---------------------------------------------------------------------------

export async function verifyInContainer(args = {}, opts = {}) {
  return callTool("verify_in_container", args, opts);
}

export async function sandboxExec(args = {}, opts = {}) {
  return callTool("sandbox_exec", args, opts);
}

// Exported for testing
export { unwrapResult, parseSseResponse, DEFAULT_HANDSHAKE_TIMEOUT_MS, DEFAULT_CALL_TIMEOUT_MS };

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
