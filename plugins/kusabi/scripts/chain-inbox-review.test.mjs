import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { notifyChainTerminal } from "./chain-notify.mjs";

const tempDirs = new Set();
const originalHttpPort = process.env.KAIBA_HTTP_PORT;

const fixtureSource = String.raw`
import fs from "node:fs";
import { createInterface } from "node:readline";

const [logPath, envPath] = process.argv.slice(2);
fs.writeFileSync(envPath, JSON.stringify({
  httpPort: process.env.KAIBA_HTTP_PORT ?? null,
  producer: process.env.KAIBA_INBOX_PRODUCER ?? null,
  readonly: process.env.KAIBA_READONLY ?? null,
  preserved: process.env.FIXTURE_PRESERVED_ENV ?? null
}));
const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const tool = {
  name: "inbox_append",
  inputSchema: {
    type: "object",
    properties: {
      event_key: { type: "string" }, event_type: { type: "string" },
      subject: { type: "string" }, title: { type: "string" },
      metadata: { type: "object" }
    },
    required: ["event_key", "event_type", "subject", "title", "metadata"]
  }
};
lines.on("line", (line) => {
  const request = JSON.parse(line);
  fs.appendFileSync(logPath, JSON.stringify(request) + "\n");
  // This fixture models kaiba's HTTP mode: it does not speak MCP over stdio.
  if (process.env.KAIBA_HTTP_PORT) return;
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "stdio-env-fixture", version: "1" }
    } });
  } else if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [tool] } });
  } else if (request.method === "tools/call") {
    const args = request.params.arguments;
    const entry = { id: "fixture-entry", ...args };
    send({ jsonrpc: "2.0", id: request.id, result: {
      structuredContent: { entry, duplicate: false }
    } });
  }
});
`;

function makeFixture(configuredHttpPort) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-inbox-review-"));
  tempDirs.add(dir);
  const serverPath = path.join(dir, "server.mjs");
  const configPath = path.join(dir, "opencode.jsonc");
  const logPath = path.join(dir, "requests.jsonl");
  const envPath = path.join(dir, "child-env.json");
  fs.writeFileSync(serverPath, fixtureSource);
  const environment = { FIXTURE_PRESERVED_ENV: "configured-preserved" };
  if (configuredHttpPort) environment.KAIBA_HTTP_PORT = "8770";
  fs.writeFileSync(configPath, JSON.stringify({
    mcp: { kaiba: {
      type: "local",
      command: [process.execPath, serverPath, logPath, envPath],
      environment,
      enabled: true
    } }
  }));
  return { dir, configPath, logPath, envPath };
}

function requestRows(fixture) {
  if (!fs.existsSync(fixture.logPath)) return [];
  return fs.readFileSync(fixture.logPath, "utf8").trim().split("\n")
    .filter(Boolean).map((line) => JSON.parse(line));
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  if (originalHttpPort === undefined) delete process.env.KAIBA_HTTP_PORT;
  else process.env.KAIBA_HTTP_PORT = originalHttpPort;
});

describe("stdio notifier clears inherited and configured KAIBA_HTTP_PORT", () => {
  for (const source of ["inherited", "configured"]) {
    it(`delivers over stdio when KAIBA_HTTP_PORT comes from ${source}`, async () => {
      const fixture = makeFixture(source === "configured");
      if (source === "inherited") process.env.KAIBA_HTTP_PORT = "8771";
      else delete process.env.KAIBA_HTTP_PORT;

      const stateDir = path.join(fixture.dir, "state");
      const result = await notifyChainTerminal({
        stateDir,
        chainId: "chain-http-env-review",
        status: "completed",
        disposition: "accept",
        container: "fixture-container",
        cwdLabel: "fixture workspace",
        occurrenceId: "http-env-occurrence",
        mcpConfigFile: fixture.configPath,
        env: { KAIBA_DB: path.join(fixture.dir, "isolated.db") },
        timeoutMs: 1000
      });

      assert.equal(result.inboxDelivered, true);
      assert.deepEqual(JSON.parse(fs.readFileSync(fixture.envPath, "utf8")), {
        httpPort: null,
        producer: "kusabi",
        readonly: "1",
        preserved: "configured-preserved"
      });
      assert.deepEqual(requestRows(fixture).map((request) => request.method), [
        "initialize", "notifications/initialized", "tools/list", "tools/call"
      ]);
      assert.equal(fs.existsSync(path.join(stateDir, "inbox", "chain-http-env-review.md")), true);
    });
  }
});
