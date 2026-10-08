// Acceptance test oracle for permission provenance (kusabi #661).
//
// Pins expected behavior for phase-default opencode deny names vs explicit
// operator restrictions across direct Codex dispatch and backend fallback.
// This test file acts as the frozen regression oracle before implementation.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { patchEnv } from "./fixtures.mjs";
import { loggedArgs } from "./backend-dispatch-fixtures.mjs";
import { codexMcpToolsForAgent } from "./codex-mcp.mjs";
import { codexDispatch } from "./codex-dispatch.mjs";
import { implementDenyTools, reviewDenyTools, WRITE_TOOL_NAMES } from "./cli.mjs";
import { translateDenyTools } from "./tool-permissions.mjs";
import { dispatchWithFallback, resetFailedRoutes } from "./prompt-execution.mjs";

function fakeResult(status, overrides = {}) {
  return {
    job: {
      id: overrides.id || `job-${Math.random().toString(36).slice(2, 8)}`,
      kind: "task",
      status,
      backend: overrides.backend,
      sessionID: overrides.sessionID || null,
      modelEntry: null,
      modelVariant: null,
      retry: overrides.retry || null,
      fallbacks: null,
      error: null,
      usage: null,
      stats: {},
    },
    resultText: overrides.resultText || "",
    stateDir: null,
  };
}

function fakeCodexContext({ model = "gpt-5.6-sol", thread = "th-oracle-661" } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-codex-oracle-"));
  const binPath = path.join(tmp, "fake-codex.mjs");
  const argsLog = path.join(tmp, "args.ndjson");
  const envLog = path.join(tmp, "env.ndjson");
  const stdinLog = path.join(tmp, "stdin.txt");

  const script = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const NL = String.fromCharCode(10);
fs.appendFileSync(process.env.FAKE_CODEX_ARGS_LOG, JSON.stringify(process.argv.slice(2)) + NL);
const dir = path.join(process.env.CODEX_HOME, "sessions", "${thread}");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "rollout-1.jsonl"), JSON.stringify({
  timestamp: new Date().toISOString(), type: "session_meta",
  payload: { id: "${thread}", cwd: process.cwd(), model: "${model}", model_reasoning_effort: "high", approval_policy: "never", sandbox_policy: "read-only", network_policy: "restricted" }
}) + NL + JSON.stringify({
  timestamp: new Date().toISOString(), type: "turn_context",
  payload: { turn_id: "turn-1", model: "${model}" }
}) + NL);
fs.writeSync(1, JSON.stringify({ type: "thread.started", thread_id: "${thread}" }) + NL);
fs.writeSync(1, JSON.stringify({ type: "item.completed", item: { agent_message: { text: "ORACLE-661-DONE" } } }) + NL);
fs.writeSync(1, JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2 } }) + NL);
`;

  fs.writeFileSync(binPath, script, "utf8");
  fs.chmodSync(binPath, 0o755);
  fs.writeFileSync(argsLog, "", "utf8");
  fs.writeFileSync(envLog, "", "utf8");

  const stateRoot = path.join(tmp, "state");
  const workerConfigDir = path.join(stateRoot, "opencode-config", "opencode");
  fs.mkdirSync(workerConfigDir, { recursive: true });
  fs.writeFileSync(path.join(workerConfigDir, "opencode.jsonc"), JSON.stringify({
    mcp: {
      sunaba: { type: "remote", url: "http://127.0.0.1:8750/mcp" },
      kaiba: { type: "local", command: ["/usr/bin/kaiba"], environment: { KAIBA_AGENT: "worker" } },
    },
  }), "utf8");

  const cwd = path.join(tmp, "cwd");
  const fakeHome = path.join(tmp, "home");
  const operatorCodexHome = path.join(tmp, "operator-codex-home");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(operatorCodexHome, { recursive: true });

  const restoreEnv = patchEnv({
    CODEX_BIN: binPath,
    KUSABI_STATE_DIR: stateRoot,
    FAKE_CODEX_ARGS_LOG: argsLog,
    FAKE_CODEX_ENV_LOG: envLog,
    FAKE_CODEX_STDIN_LOG: stdinLog,
    HOME: fakeHome,
    CODEX_HOME: operatorCodexHome,
  });

  return {
    tmp,
    cwd,
    argsLog,
    model,
    thread,
    restore() {
      restoreEnv();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

describe("acceptance: permission provenance for phase denies vs operator restrictions (kusabi #661)", () => {
  beforeEach(() => resetFailedRoutes());
  afterEach(() => resetFailedRoutes());

  it("criterion 1: codexMcpToolsForAgent('kusabi-implement', implementDenyTools()) retains the 4 container tools and excludes copy and publish/init tools", () => {
    const tools = codexMcpToolsForAgent("kusabi-implement", implementDenyTools());
    assert.ok(tools, "tools must be returned");
    assert.ok(Array.isArray(tools.sunaba), "sunaba tools array must exist");

    // Retains write_file, edit_file, transform_file, sandbox_exec
    assert.ok(tools.sunaba.includes("write_file"), "retains write_file");
    assert.ok(tools.sunaba.includes("edit_file"), "retains edit_file");
    assert.ok(tools.sunaba.includes("transform_file"), "retains transform_file");
    assert.ok(tools.sunaba.includes("sandbox_exec"), "retains sandbox_exec");

    // Excludes copy_project, copy_file
    assert.ok(!tools.sunaba.includes("copy_project"), "excludes copy_project");
    assert.ok(!tools.sunaba.includes("copy_file"), "excludes copy_file");

    // Excludes hardcoded publish/initialize tools
    assert.ok(!tools.sunaba.includes("publish"), "excludes publish");
    assert.ok(!tools.sunaba.includes("sandbox_initialize"), "excludes sandbox_initialize");
  });

  it("criterion 2: codexMcpToolsForAgent('kusabi-review', reviewDenyTools()) retains sandbox_exec, excludes issue/pr write tools and retains read-only restrictions", () => {
    const tools = codexMcpToolsForAgent("kusabi-review", reviewDenyTools());
    assert.ok(tools, "tools must be returned");
    assert.ok(Array.isArray(tools.sunaba), "sunaba tools array must exist");

    // Retains sandbox_exec
    assert.ok(tools.sunaba.includes("sandbox_exec"), "retains sandbox_exec");

    // Excludes issue/pr write tools
    assert.ok(!tools.sunaba.includes("sandbox_issue_write"), "excludes sandbox_issue_write");
    assert.ok(!tools.sunaba.includes("sandbox_pr_review_write"), "excludes sandbox_pr_review_write");

    // Retains existing read-only agent restrictions
    assert.ok(!tools.sunaba.includes("write_file"), "excludes write_file for read-only review agent");
    assert.ok(!tools.sunaba.includes("edit_file"), "excludes edit_file for read-only review agent");
    assert.ok(!tools.sunaba.includes("transform_file"), "excludes transform_file for read-only review agent");
    assert.ok(!tools.sunaba.includes("copy_project"), "excludes copy_project");
    assert.ok(!tools.sunaba.includes("copy_file"), "excludes copy_file");
  });

  it("criterion 3: direct codexDispatch with kusabi-implement and phase map exposes all 4 container tools without reporting them MCP-denied, keeping host read-only", async () => {
    const ctx = fakeCodexContext();
    try {
      const { job } = await codexDispatch({
        cwd: ctx.cwd,
        kind: "task",
        title: "implement task with phase map",
        promptText: "implement the task",
        agent: "kusabi-implement",
        phase: "implement",
        tools: implementDenyTools(),
        timeoutS: 10,
        watchdogS: 10,
        tiers: [[ctx.model]],
        round: 1,
        explicitModel: ctx.model,
      });

      assert.equal(job.status, "completed");

      // Exposes all four container tools
      const sunabaTools = job.codexMcpServers?.sunaba ?? [];
      assert.ok(sunabaTools.includes("write_file"), "sunaba MCP server exposes write_file");
      assert.ok(sunabaTools.includes("edit_file"), "sunaba MCP server exposes edit_file");
      assert.ok(sunabaTools.includes("transform_file"), "sunaba MCP server exposes transform_file");
      assert.ok(sunabaTools.includes("sandbox_exec"), "sunaba MCP server exposes sandbox_exec");

      // Never reports those four as MCP-denied
      const mcpDenies = job.codexMcpEnforcedDenies ?? [];
      assert.ok(!mcpDenies.includes("mcp__sunaba__write_file"), "does not report write_file as MCP-denied");
      assert.ok(!mcpDenies.includes("mcp__sunaba__edit_file"), "does not report edit_file as MCP-denied");
      assert.ok(!mcpDenies.includes("mcp__sunaba__transform_file"), "does not report transform_file as MCP-denied");
      assert.ok(!mcpDenies.includes("mcp__sunaba__sandbox_exec"), "does not report sandbox_exec as MCP-denied");

      // Keeps host read-only argv
      const argv = loggedArgs(ctx.argsLog)[0];
      assert.ok(argv.includes("-s") && argv.includes("read-only"), "argv keeps host read-only sandbox");
    } finally {
      ctx.restore();
    }
  });

  it("criterion 4 (direct): explicit read-only restriction on kusabi-implement in direct Codex dispatch removes all 4 container tools", async () => {
    let codexCalled = false;
    let codexOptsReceived = null;
    const fakeCodexDispatch = async (opts) => {
      codexCalled = true;
      codexOptsReceived = opts;
      return fakeResult("completed", {
        id: "job-codex-direct-readonly",
        backend: "codex",
        resultText: "codex direct readonly ok",
      });
    };

    const readOnlyTools = Object.fromEntries(WRITE_TOOL_NAMES.map((t) => [t, false]));
    const { job } = await dispatchWithFallback({
      _codexDispatch: fakeCodexDispatch,
      tiers: [["codex/gpt-5.6-sol"]],
      round: 1,
      kind: "task",
      agent: "kusabi-implement",
      promptText: "explicit read-only direct task",
      tools: readOnlyTools,
      explicitRestrictions: true,
    });

    assert.equal(job.status, "completed");
    assert.equal(job.backend, "codex");
    assert.equal(codexCalled, true, "codex candidate was invoked");

    // Provenance preserved: codex receives translated tool deny map
    assert.deepEqual(
      codexOptsReceived.tools,
      translateDenyTools(readOnlyTools),
      "direct Codex dispatch receives translated tool deny map under explicit operator restriction",
    );

    // Resolving MCP tools under the explicit restriction removes all four container tools
    const resolved = codexMcpToolsForAgent(codexOptsReceived.agent, codexOptsReceived.tools);
    assert.ok(!resolved.sunaba.includes("write_file"), "explicit read-only removes write_file");
    assert.ok(!resolved.sunaba.includes("edit_file"), "explicit read-only removes edit_file");
    assert.ok(!resolved.sunaba.includes("transform_file"), "explicit read-only removes transform_file");
    assert.ok(!resolved.sunaba.includes("sandbox_exec"), "explicit read-only removes sandbox_exec");
  });

  it("criterion 4 (fallback): fallback path to Codex preserves explicit read-only restriction and removes all 4 container tools", async () => {
    let opencodeCalls = 0;
    const fakeRunner = async () => {
      opencodeCalls++;
      return fakeResult("provider-error", {
        retry: { reason: "free_tier_limit", message: "quota exhausted", attempt: 1, count: 1, terminal: true },
      });
    };

    let codexCalled = false;
    let codexOptsReceived = null;
    const fakeCodexDispatch = async (opts) => {
      codexCalled = true;
      codexOptsReceived = opts;
      return fakeResult("completed", {
        id: "job-codex-fallback-readonly",
        backend: "codex",
        resultText: "codex fallback readonly ok",
      });
    };

    const readOnlyTools = Object.fromEntries(WRITE_TOOL_NAMES.map((t) => [t, false]));
    const { job } = await dispatchWithFallback({
      _runPrompt: fakeRunner,
      _codexDispatch: fakeCodexDispatch,
      tiers: [["opencode/free", "codex/gpt-5.6-sol"]],
      round: 1,
      kind: "task",
      agent: "kusabi-implement",
      promptText: "explicit read-only fallback task",
      tools: readOnlyTools,
      explicitRestrictions: true,
    });

    assert.equal(opencodeCalls, 1, "opencode candidate was attempted");
    assert.equal(codexCalled, true, "codex candidate was invoked as fallback");
    assert.equal(job.status, "completed");
    assert.equal(job.backend, "codex");

    // Provenance preserved: fallback receives translated tool deny map
    assert.deepEqual(
      codexOptsReceived.tools,
      translateDenyTools(readOnlyTools),
      "codex fallback receives translated tool deny map under explicit operator restriction",
    );

    // Resolving MCP tools under the explicit restriction removes all four container tools
    const resolved = codexMcpToolsForAgent(codexOptsReceived.agent, codexOptsReceived.tools);
    assert.ok(!resolved.sunaba.includes("write_file"), "explicit read-only removes write_file");
    assert.ok(!resolved.sunaba.includes("edit_file"), "explicit read-only removes edit_file");
    assert.ok(!resolved.sunaba.includes("transform_file"), "explicit read-only removes transform_file");
    assert.ok(!resolved.sunaba.includes("sandbox_exec"), "explicit read-only removes sandbox_exec");
  });
});
