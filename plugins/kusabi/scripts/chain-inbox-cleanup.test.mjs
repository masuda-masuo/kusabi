// Regression coverage for bounded process-group cleanup in the inbox client.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const clientPath = fileURLToPath(new URL("./chain-inbox-client.mjs", import.meta.url));
const tempDirs = new Set();
const descendantPids = new Set();

function makeFixture(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-inbox-cleanup-"));
  tempDirs.add(dir);
  const serverPath = path.join(dir, "server.mjs");
  const pidPath = path.join(dir, "descendant.pid");
  fs.writeFileSync(serverPath, String.raw`
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [mode, pidPath] = process.argv.slice(2);
const descendant = spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
], { stdio: "ignore" });
fs.writeFileSync(pidPath, String(descendant.pid));

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: {
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: mode === "success" ? { name: "cleanup-fixture", version: "1" } : {}
    } });
  } else if (request.method === "notifications/initialized") {
    // Notification has no response.
  } else if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [{
      name: "inbox_append",
      inputSchema: {
        type: "object",
        properties: {
          event_key: { type: "string" },
          event_type: { type: "string" },
          subject: { type: "string" },
          title: { type: "string" },
          metadata: { anyOf: [{ type: "object" }, { type: "null" }] }
        },
        required: ["event_key", "event_type", "subject", "title"]
      }
    }] } });
  } else if (request.method === "tools/call") {
    send({ jsonrpc: "2.0", id: request.id, result: {
      structuredContent: { entry: { id: "entry-1" }, duplicate: false }
    } });
  }
}
`);
  return { dir, serverPath, pidPath, mode };
}

function isRunning(pid) {
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
      return state !== "Z";
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopPid(pid) {
  try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
}

after(() => {
  for (const pid of descendantPids) stopPid(pid);
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("chain inbox client process-group cleanup", () => {
  for (const mode of ["success", "failure"]) {
    it(`kills a SIGTERM-ignoring descendant after the server exits on ${mode} cleanup`, async () => {
      const fixture = makeFixture(mode);
      let pid;
      try {
        const input = {
          command: process.execPath,
          args: [fixture.serverPath, mode, fixture.pidPath],
          env: {},
          event: {
            event_key: "chain-terminal:cleanup:occ-1",
            event_type: "chain_terminal",
            subject: "cleanup",
            title: "cleanup fixture",
            metadata: { status: "completed" },
          },
          timeoutMs: 2000,
        };
        const result = spawnSync(process.execPath, [clientPath], {
          input: JSON.stringify(input),
          encoding: "utf8",
          timeout: 3000,
          stdio: ["pipe", "pipe", "ignore"],
        });

        assert.equal(result.error, undefined);
        assert.equal(result.status, mode === "success" ? 0 : 1);
        assert.equal(fs.existsSync(fixture.pidPath), true);
        pid = Number(fs.readFileSync(fixture.pidPath, "utf8"));
        descendantPids.add(pid);
        const deadline = Date.now() + 1000;
        while (isRunning(pid) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(isRunning(pid), false, `descendant process ${pid} must be gone`);
      } finally {
        if (pid) stopPid(pid);
      }
    });
  }
});
