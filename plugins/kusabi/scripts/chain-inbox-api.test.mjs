// Acceptance tests for kusabi's kaiba inbox notifier boundary.
// The stdio child below is a protocol fixture that substitutes for kaiba.
// These tests do not claim integration with the real merged kaiba server.

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";

import { notifyChainTerminal } from "./chain-notify.mjs";

const fixtureServerSource = String.raw`
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

const [mode, logPath, dedupPath, descendantPidPath] = process.argv.slice(2);
const log = (row) => {
  fs.appendFileSync(logPath, JSON.stringify(row) + "\n");
};
const readRows = () => fs.existsSync(dedupPath) ? JSON.parse(fs.readFileSync(dedupPath, "utf8")) : {};
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const tools = mode === "missing-tool" ? [] : [{
  name: "inbox_append",
  description: "Append an incoming event to the kaiba inbox.",
  inputSchema: {
    type: "object",
    properties: {
      event_key: { type: "string" },
      event_type: { type: "string" },
      subject: { type: "string" },
      title: { type: "string" },
      metadata: { type: "object" }
    },
    required: mode === "schema-mismatch" ? ["not_an_inbox_argument"] : ["event_key", "event_type", "subject", "title", "metadata"],
    additionalProperties: false
  }
}];

let child;
if (mode === "hang") {
  child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(descendantPidPath, String(child.pid));
}
const stop = () => {
  if (child && child.exitCode === null) {
    child.once("exit", () => {
      fs.writeFileSync(logPath + ".stopped", "yes");
      process.exit(0);
    });
    child.kill("SIGTERM");
    return;
  }
  fs.writeFileSync(logPath + ".stopped", "yes");
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try { request = JSON.parse(line.toString()); } catch { continue; }
  log({ request, env: {
    producer: process.env.KAIBA_INBOX_PRODUCER,
    readonly: process.env.KAIBA_READONLY,
    configured: process.env.FIXTURE_CONFIGURED_ENV
  } });
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "kaiba-inbox-fixture", version: "1.0.0" }
    } });
  } else if (request.method === "notifications/initialized") {
    // Notification: intentionally no response.
  } else if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools } });
  } else if (request.method === "tools/call") {
    if (mode === "hang") continue;
    if (mode === "rpc-error") {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "fixture API failure" } });
      continue;
    }
    if (mode === "tool-error") {
      send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "fixture API failure" }], isError: true } });
      continue;
    }
    if (mode === "structured-error") {
      send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "error" }], structuredContent: { error: "fixture API failure" } } });
      continue;
    }
    if (mode === "invalid-reply") {
      send({ jsonrpc: "2.0", id: request.id, result: { content: [] } });
      continue;
    }
    const args = request.params.arguments;
    const rows = readRows();
    const existing = rows[args.event_key];
    if (existing && JSON.stringify(existing.payload) !== JSON.stringify(args)) {
      send({ jsonrpc: "2.0", id: request.id, result: {
        content: [{ type: "text", text: "event key reused with a different payload" }],
        structuredContent: { error: "event key reused with a different payload" }
      } });
      continue;
    }
    const duplicate = Boolean(existing);
    if (!existing) {
      const now = new Date().toISOString();
      rows[args.event_key] = {
        payload: args,
        entry: {
          id: "entry-" + args.event_key,
          producer: "kusabi",
          ...args,
          created_at: now,
          acknowledged_at: now
        }
      };
    }
    fs.writeFileSync(dedupPath, JSON.stringify(rows, null, 2) + "\n");
    const entry = rows[args.event_key].entry;
    send({ jsonrpc: "2.0", id: request.id, result: {
      content: [{ type: "text", text: JSON.stringify({ entry, duplicate }) }],
      structuredContent: { entry, duplicate }
    } });
  }
}
`;

async function nextJsonLine(lines) {
  const next = await lines.next();
  assert.equal(next.done, false, "fixture should write a newline-delimited response");
  return JSON.parse(next.value);
}

describe("fixtureServerSource MCP protocol self-check", () => {
  it("completes initialize, initialized, tools/list, and tools/call over newline-delimited stdio with realistic append replies", async () => {
    const fixture = makeFixture();
    const child = spawn(process.execPath, [fixture.serverPath, "success", fixture.logPath, fixture.dedupPath, fixture.descendantPidPath], { stdio: ["pipe", "pipe", "pipe"] });
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 2000);
    watchdog.unref();
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const sendRequest = (request) => child.stdin.write(JSON.stringify(request) + "\n");
    const args = {
      event_key: "chain-terminal:fixture:occurrence-1",
      event_type: "chain_terminal",
      subject: "fixture",
      title: "fixture workspace",
      metadata: { status: "completed", disposition: "accept", container: "fixture" },
    };

    sendRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fixture-check", version: "1.0.0" } } });
    const initialized = await nextJsonLine(lines);
    assert.equal(initialized.id, 1);
    assert.equal(initialized.result.serverInfo.name, "kaiba-inbox-fixture");

    sendRequest({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    sendRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listed = await nextJsonLine(lines);
    assert.equal(listed.id, 2);
    assert.equal(listed.result.tools[0].name, "inbox_append");

    const call = (id, callArgs) => sendRequest({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "inbox_append", arguments: callArgs } });
    call(3, args);
    const first = await nextJsonLine(lines);
    assert.equal(first.id, 3);
    assert.deepEqual(first.result.structuredContent, JSON.parse(first.result.content[0].text));
    assert.deepEqual(first.result.structuredContent, { entry: {
      id: "entry-chain-terminal:fixture:occurrence-1",
      producer: "kusabi",
      ...args,
      created_at: first.result.structuredContent.entry.created_at,
      acknowledged_at: first.result.structuredContent.entry.acknowledged_at,
    }, duplicate: false });
    assert.equal(Number.isNaN(Date.parse(first.result.structuredContent.entry.created_at)), false);
    assert.equal(Number.isNaN(Date.parse(first.result.structuredContent.entry.acknowledged_at)), false);

    call(4, args);
    const replay = await nextJsonLine(lines);
    assert.equal(replay.id, 4);
    assert.deepEqual(replay.result.structuredContent, { entry: first.result.structuredContent.entry, duplicate: true });

    call(5, { ...args, title: "changed payload" });
    const conflict = await nextJsonLine(lines);
    assert.equal(conflict.id, 5);
    assert.deepEqual(conflict.result.structuredContent, { error: "event key reused with a different payload" });

    child.stdin.end();
    const exitCode = await new Promise((resolve) => child.once("exit", resolve));
    clearTimeout(watchdog);
    assert.equal(exitCode, 0);
    const rows = requestRows(fixture);
    assert.deepEqual(rows.map(({ request }) => request.method), [
      "initialize", "notifications/initialized", "tools/list", "tools/call", "tools/call", "tools/call",
    ]);
    const persisted = JSON.parse(fs.readFileSync(fixture.dedupPath, "utf8"));
    assert.equal(Object.keys(persisted).length, 1);
    assert.deepEqual(persisted[args.event_key].payload, args);
  });
});

const tempDirs = new Set();
const leakedPids = new Set();

function makeFixture(mode = "success") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-chain-inbox-"));
  tempDirs.add(dir);
  const serverPath = path.join(dir, "stdio-fixture.mjs");
  const configPath = path.join(dir, "codex.jsonc");
  const logPath = path.join(dir, "requests.jsonl");
  const dedupPath = path.join(dir, "dedup.json");
  const descendantPidPath = path.join(dir, "descendant.pid");
  fs.writeFileSync(serverPath, fixtureServerSource);
  const config = {
    mcp: {
      kaiba: {
        type: "local",
        command: [process.execPath, serverPath, mode, logPath, dedupPath, descendantPidPath],
        environment: { FIXTURE_CONFIGURED_ENV: "preserved" },
        enabled: true,
      },
    },
  };
  fs.writeFileSync(configPath, "// Operator-owned JSONC MCP config used only by this test.\n" + JSON.stringify(config, null, 2));
  return { dir, serverPath, configPath, logPath, dedupPath, descendantPidPath, config };
}

function makeOptions(fixture, extra = {}) {
  const stateDir = path.join(fixture.dir, "state");
  return {
    stateDir,
    chainId: "chain-fixture-752",
    status: "completed",
    disposition: "accept",
    container: "container-fixture",
    cwdLabel: "fixture workspace",
    env: { KAIBA_DB: path.join(fixture.dir, "sentinel.db") },
    occurrenceId: "occurrence-1",
    mcpConfigFile: fixture.configPath,
    timeoutMs: 2000,
    ...extra,
  };
}

function requestRows(fixture) {
  if (!fs.existsSync(fixture.logPath)) return [];
  return fs.readFileSync(fixture.logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function toolCall(fixture) {
  return requestRows(fixture).find(({ request }) => request.method === "tools/call")?.request;
}

function inboxFile(options) {
  return path.join(options.stateDir, "inbox", options.chainId + ".md");
}

function createSentinelDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE actions (id INTEGER PRIMARY KEY, content TEXT NOT NULL, position REAL NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL, done_at TEXT)");
  db.prepare("INSERT INTO actions (id, content, position, author, created_at) VALUES (?, ?, ?, ?, ?)").run(1, "sentinel agenda row", 1, "human", "2026-01-01T00:00:00.000Z");
  db.close();
  return fs.readFileSync(dbPath);
}

function stopLeakedPid(pid) {
  try { process.kill(pid, "SIGTERM"); } catch { /* The fixture child may already have exited. */ }
}

after(() => {
  for (const pid of leakedPids) stopLeakedPid(pid);
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("notifyChainTerminal kaiba inbox stdio boundary", () => {
  it("uses MCP stdio, process-bound producer overrides, and keeps the sentinel actions database byte-for-byte unchanged", async () => {
    const fixture = makeFixture();
    const options = makeOptions(fixture);
    const beforeDb = createSentinelDb(options.env.KAIBA_DB);

    const result = await notifyChainTerminal(options);

    const rows = requestRows(fixture);
    assert.ok(rows.some(({ request }) => request.method === "initialize"), "initialize handshake observed");
    assert.equal(result.inboxDelivered, true);
    assert.equal(result.inboxPath, inboxFile(options));
    assert.deepEqual(fs.readFileSync(options.env.KAIBA_DB), beforeDb);
    assert.ok(rows.some(({ request }) => request.method === "notifications/initialized"), "initialized notification observed");
    assert.ok(rows.some(({ request }) => request.method === "tools/list"), "tool discovery observed");
    assert.equal(rows.filter(({ request }) => request.method === "tools/call").length, 1);
    const call = toolCall(fixture);
    assert.equal(call.params.name, "inbox_append");
    assert.deepEqual(call.params.arguments, {
      event_key: "chain-terminal:chain-fixture-752:occurrence-1",
      event_type: "chain_terminal",
      subject: "chain-fixture-752",
      title: "fixture workspace",
      metadata: {
        status: "completed",
        disposition: "accept",
        container: "container-fixture",
        inbox_path: path.resolve(inboxFile(options)),
        cwd_label: "fixture workspace",
      },
    });
    assert.equal(Object.hasOwn(call.params.arguments, "producer"), false);
    assert.ok(rows.every(({ env }) => env.producer === "kusabi" && env.readonly === "1"));
    assert.ok(rows.every(({ env }) => env.configured === "preserved"));
    assert.equal(fs.existsSync(inboxFile(options)), true);
  });

  it("retries one occurrence with an unchanged payload and deduplicates, while a later occurrence has a distinct key", async () => {
    const fixture = makeFixture();
    const options = makeOptions(fixture);
    const first = await notifyChainTerminal(options);
    const firstCall = toolCall(fixture);
    const retry = await notifyChainTerminal(options);
    const secondCall = requestRows(fixture).filter(({ request }) => request.method === "tools/call")[1]?.request;
    const later = await notifyChainTerminal({ ...options, occurrenceId: "occurrence-2" });
    const thirdCall = requestRows(fixture).filter(({ request }) => request.method === "tools/call")[2]?.request;

    assert.equal(first.inboxDelivered, true);
    assert.equal(retry.inboxDelivered, true);
    assert.equal(later.inboxDelivered, true);
    assert.deepEqual(secondCall.params.arguments, firstCall.params.arguments);
    assert.equal(retry.duplicate, true);
    assert.equal(thirdCall.params.arguments.event_key, "chain-terminal:chain-fixture-752:occurrence-2");
    assert.notDeepEqual(thirdCall.params.arguments, firstCall.params.arguments);
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(fixture.dedupPath, "utf8"))).length, 2);
  });

  for (const [status, disposition] of [
    ["completed", "accept"],
    ["completed", "accept-with-followup"],
    ["completed", "escalate"],
    ["completed", "refused-brief-defect"],
    ["failed", "accept"],
    ["cancelled", "accept"],
  ]) {
    it(`delivers terminal outcome ${status}/${disposition}`, async () => {
      const fixture = makeFixture();
      const options = makeOptions(fixture, { status, disposition });
      const result = await notifyChainTerminal(options);
      const args = toolCall(fixture)?.params.arguments;

      assert.equal(result.inboxDelivered, true);
      assert.equal(args.event_type, "chain_terminal");
      assert.equal(args.metadata.status, status);
      assert.equal(args.metadata.disposition, disposition);
      assert.equal(fs.existsSync(inboxFile(options)), true);
    });
  }

  it("uses a chain label when cwdLabel is absent", async () => {
    const fixture = makeFixture();
    const options = makeOptions(fixture, { cwdLabel: undefined });
    const result = await notifyChainTerminal(options);
    assert.equal(result.inboxDelivered, true);
    assert.match(toolCall(fixture).params.arguments.title, /chain-fixture-752/);
  });

  it("returns fail-soft for a missing occurrence ID and still writes the local file without launching a server", async () => {
    const fixture = makeFixture();
    const options = makeOptions(fixture, { occurrenceId: undefined });
    const result = await notifyChainTerminal(options);
    assert.equal(result.inboxDelivered, false);
    assert.equal(fs.existsSync(inboxFile(options)), true);
    assert.deepEqual(requestRows(fixture), []);
  });

  it("fails soft for absent, invalid, disabled, remote, and missing-command configurations while preserving the local file", async () => {
    const cases = ["missing", "invalid", "disabled", "remote", "missing-command"];
    for (const kind of cases) {
      const fixture = makeFixture();
      const options = makeOptions(fixture);
      if (kind === "missing") fs.rmSync(fixture.configPath);
      if (kind === "invalid") fs.writeFileSync(fixture.configPath, "{ this is not JSONC");
      if (kind === "disabled") {
        fixture.config.mcp.kaiba.enabled = false;
        fs.writeFileSync(fixture.configPath, JSON.stringify(fixture.config));
      }
      if (kind === "remote") {
        fixture.config.mcp.kaiba = { type: "remote", url: "https://example.invalid/mcp" };
        fs.writeFileSync(fixture.configPath, JSON.stringify(fixture.config));
      }
      if (kind === "missing-command") {
        fixture.config.mcp.kaiba.command = [path.join(fixture.dir, "does-not-exist")];
        fs.writeFileSync(fixture.configPath, JSON.stringify(fixture.config));
      }

      const result = await notifyChainTerminal(options);
      assert.equal(result.inboxDelivered, false, kind);
      assert.equal(fs.existsSync(inboxFile(options)), true, kind);
      assert.equal(requestRows(fixture).some(({ request }) => request.method === "tools/call"), false, kind);
    }
  });

  for (const mode of ["missing-tool", "schema-mismatch"]) {
    it(`returns fail-soft when inbox_append is unavailable or its schema is incompatible (${mode})`, async () => {
      const fixture = makeFixture(mode);
      const options = makeOptions(fixture);
      const result = await notifyChainTerminal(options);
      assert.equal(result.inboxDelivered, false);
      assert.equal(fs.existsSync(inboxFile(options)), true);
      assert.equal(requestRows(fixture).some(({ request }) => request.method === "tools/call"), false);
    });
  }

  for (const mode of ["rpc-error", "tool-error", "structured-error", "invalid-reply"]) {
    it(`returns fail-soft for ${mode} from the inbox API and retains the local file`, async () => {
      const fixture = makeFixture(mode);
      const options = makeOptions(fixture);
      const result = await notifyChainTerminal(options);
      assert.equal(result.inboxDelivered, false);
      assert.equal(fs.existsSync(inboxFile(options)), true);
      assert.equal(toolCall(fixture).params.name, "inbox_append");
    });
  }

  for (const [label, timeoutOptions] of [
    ["default timeout", {}],
    ["maximum-clamped override", { timeoutMs: 10_000 }],
  ]) {
    it(`bounds a stalled call and cleans up descendants with ${label}`, async () => {
      const fixture = makeFixture("hang");
      const options = makeOptions(fixture, timeoutOptions);
      const started = Date.now();
      const result = await notifyChainTerminal(options);

      assert.equal(result.inboxDelivered, false);
      assert.ok(Date.now() - started < 5000, "bounded by a generous failure bound");
      assert.equal(fs.existsSync(inboxFile(options)), true);
      assert.equal(requestRows(fixture).filter(({ request }) => request.method === "tools/call").length, 1);
      const pidText = fs.readFileSync(fixture.descendantPidPath, "utf8");
      const pid = Number(pidText);
      leakedPids.add(pid);
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      assert.equal(alive, false, `fixture descendant ${pid} should be terminated`);
    });
  }

  it("honors opt-out without writing a file or launching the local server", async () => {
    const fixture = makeFixture();
    const options = makeOptions(fixture, { env: { KUSABI_CHAIN_NOTIFY: "0" } });
    const result = await notifyChainTerminal(options);
    assert.equal(result.skipped, true);
    assert.equal(fs.existsSync(inboxFile(options)), false);
    assert.deepEqual(requestRows(fixture), []);
  });

  it("continues to attempt the inbox API when local file writing fails and does not throw", async () => {
    const fixture = makeFixture();
    const options = makeOptions(fixture, { stateDir: path.join(fixture.dir, "file-blocked") });
    fs.writeFileSync(options.stateDir, "not a directory");
    let result;
    assert.doesNotThrow(() => {
      result = notifyChainTerminal(options);
    });
    await result;
    assert.equal(toolCall(fixture)?.params?.name, "inbox_append");
  });
});
