// Minimal bounded stdio MCP client for kaiba inbox_append.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

let server;
let cleanupTask;
let nextId = 1;
const pending = new Map();
let stdoutLines;
let timeout;

function failPending(error) {
  for (const item of pending.values()) item.reject(error);
  pending.clear();
}

function request(method, params, deadline) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP ${method} timed out`));
    }, Math.max(1, deadline - Date.now()));
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", (error) => {
      if (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

function onLine(line) {
  let message;
  try { message = JSON.parse(line); } catch { failPending(new Error("Malformed MCP JSON response")); return; }
  if (!message || message.jsonrpc !== "2.0" || !Number.isInteger(message.id)) return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error("MCP request failed"));
  else if (!Object.hasOwn(message, "result")) waiter.reject(new Error("MCP response has no result"));
  else waiter.resolve(message.result);
}

function metadataAcceptsObject(schema) {
  if (schema?.type === "object") return true;
  if (Array.isArray(schema?.type)) {
    return schema.type.includes("object") &&
      schema.type.every((type) => type === "object" || type === "null");
  }
  if (!Array.isArray(schema?.anyOf)) return false;
  return schema.anyOf.some((variant) => variant?.type === "object") &&
    schema.anyOf.every((variant) => variant?.type === "object" || variant?.type === "null");
}

function compatibleTool(tool) {
  const schema = tool?.inputSchema;
  const requiredFields = ["event_key", "event_type", "subject", "title"];
  const stringFields = [...requiredFields];
  const allowedFields = new Set([...stringFields, "metadata"]);
  if (tool?.name !== "inbox_append" ||
      schema?.type !== "object" ||
      !schema.properties || typeof schema.properties !== "object" ||
      !Array.isArray(schema.required) ||
      schema.required.some((name) => !allowedFields.has(name)) ||
      !requiredFields.every((name) => schema.required.includes(name)) ||
      !stringFields.every((name) => schema.properties[name]?.type === "string")) {
    return false;
  }

  // kaiba declares metadata as dict | None, which produces an optional
  // nullable object schema. Kusabi always sends a metadata object.
  return metadataAcceptsObject(schema.properties.metadata);
}

function validSuccess(result) {
  if (!result || result.isError === true || result.structuredContent?.error) return null;
  let value = result.structuredContent;
  if (value === undefined) {
    for (const part of result.content ?? []) {
      if (part?.type !== "text" || typeof part.text !== "string") continue;
      try { value = JSON.parse(part.text); break; } catch { /* Try another text block. */ }
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !value.entry || typeof value.entry !== "object" || Array.isArray(value.entry) ||
      typeof value.duplicate !== "boolean") return null;
  return value;
}

function cleanup(signal) {
  if (cleanupTask) return cleanupTask;
  cleanupTask = (async () => {
    clearTimeout(timeout);
    if (stdoutLines) stdoutLines.close();
    if (server) {
      try { process.kill(-server.pid, signal ?? "SIGTERM"); } catch { try { server.kill(signal ?? "SIGTERM"); } catch { /* exited */ } }
      // Keep the grace period even when the direct child exits: descendants may
      // still be handling SIGTERM in the same process group.
      await new Promise((resolve) => setTimeout(resolve, 100));
      try { process.kill(-server.pid, "SIGKILL"); } catch { try { server.kill("SIGKILL"); } catch { /* exited */ } }
    }
  })();
  return cleanupTask;
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const deadline = Date.now() + Math.max(50, Math.min(input.timeoutMs - 200, 1800));
  const env = { ...process.env, ...input.env, KAIBA_INBOX_PRODUCER: "kusabi", KAIBA_READONLY: "1" };
  server = spawn(input.command, input.args, { env, stdio: ["pipe", "pipe", "ignore"], detached: process.platform !== "win32", windowsHide: true });
  stdoutLines = createInterface({ input: server.stdout });
  stdoutLines.on("line", onLine);
  server.on("error", (error) => failPending(error));
  server.on("exit", () => {
    failPending(new Error("MCP server exited before replying"));
  });
  timeout = setTimeout(() => failPending(new Error("MCP attempt timed out")), Math.max(1, deadline - Date.now()));

  const init = await request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "kusabi-chain-notify", version: "1.0.0" },
  }, deadline);
  if (!init || typeof init !== "object" || typeof init.serverInfo?.name !== "string") {
    throw new Error("Invalid MCP initialize response");
  }
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
  const listing = await request("tools/list", {}, deadline);
  if (!listing || !Array.isArray(listing.tools) || !listing.tools.some(compatibleTool)) {
    throw new Error("inbox_append tool unavailable or incompatible");
  }
  const result = await request("tools/call", { name: "inbox_append", arguments: input.event }, deadline);
  const success = validSuccess(result);
  if (!success) throw new Error("inbox_append returned an invalid or failed result");
  process.stdout.write(JSON.stringify({ ok: true, duplicate: success.duplicate }) + "\n");
  await cleanup("SIGTERM");
}

process.on("SIGTERM", () => { cleanup("SIGTERM").finally(() => process.exit(1)); });
process.on("SIGINT", () => { cleanup("SIGINT").finally(() => process.exit(1)); });
try {
  await main();
} catch {
  await cleanup("SIGTERM");
  process.exitCode = 1;
}
