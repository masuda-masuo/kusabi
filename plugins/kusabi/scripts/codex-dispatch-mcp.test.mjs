// Codex worker MCP coverage tests for kusabi #597.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildCodexArgs,
  codexMcpArgv,
  codexMcpServerDefinitions,
  codexMcpToolsForAgent,
} from "./codex-dispatch.mjs";

const fixture = path.join(import.meta.dirname, "test-fixtures", "codex-worker-opencode.jsonc");

function configOverrides(args) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "-c") values.push(args[i + 1]);
  }
  return values;
}

function assertJsonCompatibleOverrides(args) {
  for (const value of configOverrides(args)) {
    const equals = value.indexOf("=");
    assert.ok(equals > 0, `malformed config override: ${value}`);
    assert.doesNotThrow(() => JSON.parse(value.slice(equals + 1)), value);
  }
}

describe("Codex worker MCP allowlists", () => {
  it("derives implement grants from the Claude allowlist and excludes hardcoded disallowed tools", () => {
    const tools = codexMcpToolsForAgent("kusabi-implement");
    assert.ok(!tools.sunaba.includes("publish"));
    assert.ok(!tools.sunaba.includes("sandbox_initialize"));
    assert.ok(tools.sunaba.includes("read_file_range"));
  });

  it("applies phase and user deny maps before writing enabled_tools", () => {
    const actual = codexMcpToolsForAgent("kusabi-implement", {
      write: false,
      sunaba_sandbox_exec: false,
      sunaba_copy_project: false,
    });
    assert.ok(!actual.sunaba.includes("write_file"));
    assert.ok(!actual.sunaba.includes("sandbox_exec"));
    assert.ok(actual.sunaba.includes("read_file_range"));
  });

  it("delivers implement grants as valid argv overrides on fresh and resume shapes", () => {
    const tools = codexMcpToolsForAgent("kusabi-implement");
    const definitions = codexMcpServerDefinitions(tools, fixture);
    for (const sessionId of [null, "thread-worker"]) {
      const args = buildCodexArgs({
        model: "gpt-5.6-sol",
        cwd: "/repo",
        sessionId,
        jsonSchema: null,
        mcpServers: definitions,
      });
      assert.ok(args.includes("--ignore-user-config"));
      if (sessionId === null) assert.ok(args.includes("-s") && args.includes("read-only"));
      assert.equal(args.includes("mcp_servers={}"), false);
      const enabled = `mcp_servers.sunaba.enabled_tools=${JSON.stringify(tools.sunaba)}`;
      assert.ok(args.includes(enabled), enabled);
      assertJsonCompatibleOverrides(args);
    }
  });

  it("keeps Luna and Sol coordinator argv MCP-less", () => {
    for (const sessionId of [null, "thread-seat"]) {
      const args = buildCodexArgs({
        model: "gpt-5.6-luna",
        cwd: "/repo",
        sessionId,
        jsonSchema: null,
      });
      assert.ok(args.includes("mcp_servers={}"));
      assert.equal(args.some((value) => value.startsWith("mcp_servers.")), false);
      assertJsonCompatibleOverrides(args);
    }
  });

  it("maps JSONC remote/local endpoints, environment, and command args", () => {
    const tools = { sunaba: ["read_file_range"], kaiba: ["recall"] };
    const definitions = codexMcpServerDefinitions(tools, fixture);
    assert.deepEqual(definitions.sunaba, {
      url: "http://fixture-sunaba/mcp",
      enabledTools: tools.sunaba,
    });
    assert.deepEqual(definitions.kaiba, {
      command: "/workspace/.venv/bin/kaiba",
      args: ["--worker"],
      env: { KAIBA_AGENT: "worker" },
      enabledTools: tools.kaiba,
    });
    assert.deepEqual(codexMcpArgv(definitions), [
      "-c", 'mcp_servers.sunaba.url="http://fixture-sunaba/mcp"',
      "-c", 'mcp_servers.sunaba.enabled_tools=["read_file_range"]',
      "-c", 'mcp_servers.sunaba.default_tools_approval_mode="approve"',
      "-c", 'mcp_servers.kaiba.command="/workspace/.venv/bin/kaiba"',
      "-c", 'mcp_servers.kaiba.args=["--worker"]',
      "-c", 'mcp_servers.kaiba.env.KAIBA_AGENT="worker"',
      "-c", 'mcp_servers.kaiba.enabled_tools=["recall"]',
      "-c", 'mcp_servers.kaiba.default_tools_approval_mode="approve"',
    ]);
  });

  it("skips disabled servers from the worker config", () => {
    assert.deepEqual(
      codexMcpServerDefinitions({ shiori: ["*"] }, fixture),
      {},
    );
  });

  it("fails clearly when the worker config or a needed server is missing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-codex-mcp-"));
    try {
      const missing = path.join(root, "missing.jsonc");
      assert.throws(
        () => codexMcpServerDefinitions({ sunaba: ["read_file_range"] }, missing),
        /config is missing/,
      );
      const incomplete = path.join(root, "incomplete.jsonc");
      fs.writeFileSync(incomplete, '{ "mcp": { "sunaba": { "type": "remote", "url": "http://x" } } }');
      assert.throws(
        () => codexMcpServerDefinitions({ sunaba: ["read_file_range"], shiori: ["*"] }, incomplete),
        /server "shiori" is missing/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
