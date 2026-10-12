// chain-notify.test.mjs — local terminal inbox behavior and MCP boundary smoke tests.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

import {
  notifyChainTerminal,
  stateDirForChain,
  chainIdFromDir,
} from "./chain-notify.mjs";

const tempDirs = new Set();
function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-notify-test-"));
  tempDirs.add(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

const fixtureSource = String.raw`
import fs from "node:fs";
import { createInterface } from "node:readline";
const [logPath, mode] = process.argv.slice(2);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  fs.appendFileSync(logPath, JSON.stringify(request) + "\n");
  if (request.method === "initialize") send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fixture", version: "1" } } });
  if (request.method === "tools/list") {
    if (mode === "missing-tool") {
      send({ jsonrpc: "2.0", id: request.id, result: { tools: [] } });
      continue;
    }
    const metadataSchema = mode === "optional-null-metadata"
      ? { anyOf: [{ type: "object" }, { type: "null" }] }
      : { type: "object" };
    const required = ["event_key", "event_type", "subject", "title"];
    if (mode === "required-unknown-field") required.push("unknown_argument");
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [{
      name: "inbox_append",
      inputSchema: {
        type: "object",
        properties: {
          event_key: { type: "string" },
          event_type: { type: "string" },
          subject: { type: "string" },
          title: { type: "string" },
          metadata: metadataSchema
        },
        required
      }
    }] } });
  }
  if (request.method === "tools/call") send({ jsonrpc: "2.0", id: request.id, result: { structuredContent: { entry: { id: "entry-1" }, duplicate: false } } });
}
`;

function makeMcpFixture(dir, mode = "standard") {
  const serverPath = path.join(dir, "server.mjs");
  const logPath = path.join(dir, "requests.jsonl");
  const configPath = path.join(dir, "config.jsonc");
  fs.writeFileSync(serverPath, fixtureSource);
  fs.writeFileSync(configPath, JSON.stringify({ mcp: { kaiba: {
    type: "local",
    command: [process.execPath, serverPath, logPath, mode],
    environment: {},
    enabled: true,
  } } }));
  return { serverPath, logPath, configPath };
}

describe("chain notifier local behavior", () => {
  it("derives stateDir from a chain directory", () => {
    assert.equal(stateDirForChain("/home/user/.kusabi/abc/chains/chain-x"), "/home/user/.kusabi/abc");
  });

  it("extracts the chain ID from its directory name", () => {
    assert.equal(chainIdFromDir("/some/path/chain-x"), "chain-x");
  });

  it("writes a durable local inbox and emits a structured terminal event", () => {
    const dir = makeTmpDir();
    const fixture = makeMcpFixture(dir);
    const stateDir = path.join(dir, "state");
    const dbPath = path.join(dir, "kaiba.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE actions (id INTEGER PRIMARY KEY, content TEXT NOT NULL)");
    db.prepare("INSERT INTO actions VALUES (1, 'human row')").run();
    db.close();
    const beforeDb = fs.readFileSync(dbPath);

    const result = notifyChainTerminal({
      stateDir,
      chainId: "chain-test",
      status: "completed",
      disposition: "accept",
      container: "container-1",
      cwdLabel: "repo",
      occurrenceId: "occ-1",
      mcpConfigFile: fixture.configPath,
      env: { KAIBA_DB: dbPath },
    });

    assert.equal(result.inboxDelivered, true);
    assert.equal(result.duplicate, false);
    assert.equal(result.inboxPath, path.join(stateDir, "inbox", "chain-test.md"));
    const body = fs.readFileSync(result.inboxPath, "utf8");
    assert.match(body, /chain-test/);
    assert.match(body, /completed/);
    assert.match(body, /accept/);
    assert.ok(body.includes("Run `kusabi-companion chain-show chain-test`"));
    assert.doesNotMatch(body, /\$\{chainId\}/);
    assert.deepEqual(fs.readFileSync(dbPath), beforeDb, "notifier leaves kaiba actions database unchanged");

    const requests = fs.readFileSync(fixture.logPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(requests.map((request) => request.method), [
      "initialize", "notifications/initialized", "tools/list", "tools/call",
    ]);
    assert.deepEqual(requests.at(-1).params.arguments, {
      event_key: "chain-terminal:chain-test:occ-1",
      event_type: "chain_terminal",
      subject: "chain-test",
      title: "repo",
      metadata: {
        status: "completed",
        disposition: "accept",
        container: "container-1",
        inbox_path: path.resolve(result.inboxPath),
        cwd_label: "repo",
      },
    });
  });

  it("keeps the local inbox file idempotent for repeated notification of one chain", () => {
    const dir = makeTmpDir();
    const fixture = makeMcpFixture(dir);
    const options = {
      stateDir: dir,
      chainId: "chain-idempotent",
      status: "completed",
      disposition: "accept",
      container: "container-1",
      cwdLabel: "repo",
      occurrenceId: "occ-1",
      mcpConfigFile: fixture.configPath,
    };

    const first = notifyChainTerminal(options);
    const firstBody = fs.readFileSync(first.inboxPath, "utf8");
    const second = notifyChainTerminal(options);

    assert.equal(first.inboxPath, second.inboxPath);
    assert.equal(fs.readFileSync(second.inboxPath, "utf8"), firstBody);
    assert.equal(fs.readdirSync(path.join(dir, "inbox")).filter((name) => name.endsWith(".md")).length, 1);
  });

  it("maps omitted disposition, container, and cwd label to the established nullable metadata fields", () => {
    const dir = makeTmpDir();
    const fixture = makeMcpFixture(dir);
    const result = notifyChainTerminal({
      stateDir: dir,
      chainId: "chain-null-metadata",
      status: "failed",
      occurrenceId: "occ-1",
      mcpConfigFile: fixture.configPath,
    });
    const args = JSON.parse(fs.readFileSync(fixture.logPath, "utf8").trim().split("\n").at(-1)).params.arguments;

    assert.equal(result.inboxDelivered, true);
    assert.equal(args.title, "chain-null-metadata");
    assert.deepEqual(args.metadata, {
      status: "failed",
      disposition: null,
      container: null,
      inbox_path: path.resolve(result.inboxPath),
      cwd_label: "",
    });
  });

  for (const [label, contents] of [
    ["absent", null],
    ["empty", ""],
    ["whitespace-only", "   "],
  ]) {
    it(`fails soft for an ${label} operator MCP config while retaining the local inbox file`, () => {
      const dir = makeTmpDir();
      const fixture = makeMcpFixture(dir);
      if (contents === null) fs.rmSync(fixture.configPath);
      else fs.writeFileSync(fixture.configPath, contents);
      const result = notifyChainTerminal({
        stateDir: dir,
        chainId: `chain-config-${label}`,
        status: "cancelled",
        occurrenceId: "occ-1",
        mcpConfigFile: fixture.configPath,
      });

      assert.equal(result.inboxDelivered, false);
      assert.equal(fs.existsSync(result.inboxPath), true);
      assert.equal(fs.existsSync(fixture.logPath), false);
    });
  }

  it("accepts kaiba's optional nullable metadata schema and sends a metadata object", () => {
    const dir = makeTmpDir();
    const fixture = makeMcpFixture(dir, "optional-null-metadata");
    const result = notifyChainTerminal({
      stateDir: dir,
      chainId: "chain-optional-metadata",
      status: "completed",
      occurrenceId: "occ-1",
      mcpConfigFile: fixture.configPath,
    });
    const call = fs.readFileSync(fixture.logPath, "utf8").trim().split("\n").map(JSON.parse)
      .find((request) => request.method === "tools/call");

    assert.equal(result.inboxDelivered, true);
    assert.equal(typeof call.params.arguments.metadata, "object");
    assert.equal(Array.isArray(call.params.arguments.metadata), false);
  });

  it("rejects an inbox schema with an unknown required argument", () => {
    const dir = makeTmpDir();
    const fixture = makeMcpFixture(dir, "required-unknown-field");
    const result = notifyChainTerminal({
      stateDir: dir,
      chainId: "chain-incompatible-schema",
      status: "completed",
      occurrenceId: "occ-1",
      mcpConfigFile: fixture.configPath,
    });
    const requests = fs.readFileSync(fixture.logPath, "utf8").trim().split("\n").map(JSON.parse);

    assert.equal(result.inboxDelivered, false);
    assert.equal(requests.some((request) => request.method === "tools/call"), false);
  });

  it("fails soft when inbox_append is missing from the configured API", () => {
    const dir = makeTmpDir();
    const fixture = makeMcpFixture(dir, "missing-tool");
    const result = notifyChainTerminal({
      stateDir: dir,
      chainId: "chain-missing-api",
      status: "completed",
      occurrenceId: "occ-1",
      mcpConfigFile: fixture.configPath,
    });
    const requests = fs.readFileSync(fixture.logPath, "utf8").trim().split("\n").map(JSON.parse);

    assert.equal(result.inboxDelivered, false);
    assert.equal(fs.existsSync(result.inboxPath), true);
    assert.equal(requests.some((request) => request.method === "tools/call"), false);
  });

  it("missing occurrence IDs retain the local file without calling the API", () => {
    const dir = makeTmpDir();
    const fixture = makeMcpFixture(dir);
    const result = notifyChainTerminal({
      stateDir: dir,
      chainId: "chain-no-occurrence",
      status: "failed",
      mcpConfigFile: fixture.configPath,
    });
    assert.equal(result.inboxDelivered, false);
    assert.equal(fs.existsSync(result.inboxPath), true);
    assert.equal(fs.existsSync(fixture.logPath), false);
  });

  it("fails soft when the configured inbox server is unavailable", () => {
    const dir = makeTmpDir();
    const configPath = path.join(dir, "config.jsonc");
    fs.writeFileSync(configPath, JSON.stringify({ mcp: { kaiba: {
      type: "local",
      command: [path.join(dir, "missing-server")],
      enabled: true,
    } } }));
    const result = notifyChainTerminal({
      stateDir: dir,
      chainId: "chain-offline",
      status: "cancelled",
      occurrenceId: "occ-1",
      mcpConfigFile: configPath,
    });
    assert.equal(result.inboxDelivered, false);
    assert.equal(fs.existsSync(result.inboxPath), true);
  });

  it("opt-out skips both the local file and kaiba inbox", () => {
    const dir = makeTmpDir();
    const fixture = makeMcpFixture(dir);
    const result = notifyChainTerminal({
      stateDir: dir,
      chainId: "chain-optout",
      status: "completed",
      occurrenceId: "occ-1",
      mcpConfigFile: fixture.configPath,
      env: { KUSABI_CHAIN_NOTIFY: "0" },
    });
    assert.deepEqual(result, { skipped: true });
    assert.equal(fs.existsSync(path.join(dir, "inbox")), false);
    assert.equal(fs.existsSync(fixture.logPath), false);
  });
});
