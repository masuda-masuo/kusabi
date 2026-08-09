// claude-dispatch.test.mjs — tests for the Claude Code CLI dispatch backend
// (kusabi #184).
//
// Spawn-based tests follow the serve-lifecycle.test.mjs pattern: the binary
// is resolved through CLAUDE_BIN, so tests point it at a fake `claude`
// script written into a temp dir, with KUSABI_STATE_DIR and
// KUSABI_CLAUDE_MCP_SOURCE pointing at temp fixtures.  Every process the
// fake spawns is asserted dead (by pid) after the timeout test.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

import {
  ALLOWED_TOOLS,
  CLAUDE_DEFAULT_CHAIN,
  claudeBin,
  validateClaudeModel,
  validateClaudeChain,
  resolveClaudeModel,
  stripFrontmatter,
  buildClaudeArgs,
  parseClaudeResult,
  mapClaudeUsage,
  allowedToolsForAgent,
  disallowedToolsForAgent,
  applyToolDenies,
  translateDenyTools,
  clampModelDispatch,
  extractSunabaMcp,
  claudeDispatch,
} from "./claude-dispatch.mjs";
import { resolveBackend, resolveDispatchBackend } from "./kusabi-companion.mjs";
import { runImplementPhase } from "./chain-phases.mjs";
import { WRITE_TOOL_NAMES, implementDenyTools, firstRoute } from "./cli.mjs";
import { stateDirFor, readJson } from "./state-paths.mjs";
import { loadJob, jobDir } from "./job-store.mjs";

// =========================================================================
// pure helpers
// =========================================================================

describe("claudeBin", () => {
  const saved = process.env.CLAUDE_BIN;

  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = saved;
  });

  it("defaults to claude", () => {
    delete process.env.CLAUDE_BIN;
    assert.equal(claudeBin(), "claude");
  });

  it("honors CLAUDE_BIN", () => {
    process.env.CLAUDE_BIN = "/tmp/fake-claude";
    assert.equal(claudeBin(), "/tmp/fake-claude");
  });
});

describe("validateClaudeModel", () => {
  it("accepts bare aliases", () => {
    assert.equal(validateClaudeModel("opus"), "opus");
    assert.equal(validateClaudeModel("sonnet"), "sonnet");
    assert.equal(validateClaudeModel("haiku"), "haiku");
  });

  it("accepts full model ids", () => {
    assert.equal(validateClaudeModel("claude-sonnet-4-5"), "claude-sonnet-4-5");
    assert.equal(validateClaudeModel("claude-opus-4-1"), "claude-opus-4-1");
  });

  it("returns null for absent values", () => {
    assert.equal(validateClaudeModel(undefined), null);
    assert.equal(validateClaudeModel(null), null);
    assert.equal(validateClaudeModel(""), null);
  });

  it("rejects a :variant suffix with an error naming the limitation", () => {
    assert.throws(() => validateClaudeModel("opus:max"), /:variant/);
    assert.throws(() => validateClaudeModel("opencode/deepseek-v4-flash-free:max"), /:variant/);
    assert.throws(() => validateClaudeModel("claude-sonnet-4-5:thinking"), /claude backend does not support/);
  });
});

describe("resolveClaudeModel", () => {
  it("flag wins", () => {
    const r = resolveClaudeModel({ flag: "opus", config: { models: { chain: [["sonnet"]] } } });
    assert.equal(r.model, "opus");
    assert.deepEqual(r.chain, [["sonnet"]]);
  });

  it("phase chain wins over global chain", () => {
    const config = {
      models: {
        chain: [["opus"]],
        phases: { implement: [["haiku"]] },
      },
    };
    const r = resolveClaudeModel({ flag: null, phase: "implement", config });
    assert.equal(r.model, "haiku");
  });

  it("global chain first route when no phase chain", () => {
    const r = resolveClaudeModel({ flag: null, phase: "review", config: { models: { chain: [["opus"], ["sonnet"]] } } });
    assert.equal(r.model, "opus");
  });

  it("claude-native default chain when no config", () => {
    const r = resolveClaudeModel({ flag: null, config: null });
    // The default chain is claude-shaped (bare aliases), so `--backend
    // claude` without --model and without config works out of the box — the
    // opencode built-in chain (provider/model:variant) is never used here.
    assert.equal(r.model, firstRoute(CLAUDE_DEFAULT_CHAIN));
    assert.deepEqual(r.chain, CLAUDE_DEFAULT_CHAIN);
    assert.equal(r.model, "sonnet");
  });
});

describe("validateClaudeChain", () => {
  it("accepts a claude-shaped chain (string tiers and route arrays)", () => {
    const chain = [["sonnet"], "opus", ["haiku", "claude-sonnet-4-5"]];
    assert.equal(validateClaudeChain(chain), chain);
  });

  it("accepts an empty chain (model resolution reports it separately)", () => {
    assert.deepEqual(validateClaudeChain([]), []);
  });

  it("rejects an opencode-shaped chain entry, naming it and the limitation", () => {
    assert.throws(
      () => validateClaudeChain([["opencode/deepseek-v4-flash-free:max"], ["sonnet"]]),
      (err) => {
        assert.match(err.message, /chain entry "opencode\/deepseek-v4-flash-free:max"/);
        assert.match(err.message, /:variant/);
        assert.match(err.message, /bare aliases \(opus, sonnet, haiku\)/);
        return true;
      },
    );
  });

  it("rejects a :variant suffix in any tier, not just the first route", () => {
    assert.throws(
      () => validateClaudeChain([["sonnet"], ["opus:max"]]),
      /chain entry "opus:max"/,
    );
  });
});

describe("stripFrontmatter", () => {
  it("removes a leading YAML frontmatter block", () => {
    const text = "---\ndescription: x\npermission:\n  \"*\": deny\n---\nBody line one.\nBody line two.\n";
    assert.equal(stripFrontmatter(text), "Body line one.\nBody line two.");
  });

  it("returns the trimmed text when no frontmatter", () => {
    assert.equal(stripFrontmatter("  plain body  "), "plain body");
  });
});

describe("buildClaudeArgs", () => {
  it("builds the contract invocation shape", () => {
    const args = buildClaudeArgs({
      model: "opus",
      allowedTools: "a,b",
      disallowedTools: "mcp__sunaba__publish,Bash",
      mcpConfigPath: "/tmp/mcp.json",
      systemPrompt: "You are the implement worker.",
    });
    assert.deepEqual(args, [
      "-p",
      "--strict-mcp-config",
      "--setting-sources", "",
      "--output-format", "json",
      "--model", "opus",
      "--allowedTools", "a,b",
      "--disallowedTools", "mcp__sunaba__publish,Bash",
      "--mcp-config", "/tmp/mcp.json",
      "--append-system-prompt", "You are the implement worker.",
    ]);
  });

  it("omits --append-system-prompt when there is no system prompt", () => {
    const args = buildClaudeArgs({
      model: "opus",
      allowedTools: "a",
      disallowedTools: "Bash",
      mcpConfigPath: "/tmp/mcp.json",
      systemPrompt: null,
    });
    assert.ok(!args.includes("--append-system-prompt"));
  });

  it("never puts the prompt on argv (stdin transport, I5)", () => {
    // buildClaudeArgs takes no promptText at all: a prompt can never leak
    // into argv (ps output, argv-logged transcripts).
    const args = buildClaudeArgs({
      model: "opus",
      allowedTools: "a",
      disallowedTools: "Bash",
      mcpConfigPath: "/tmp/mcp.json",
      systemPrompt: null,
    });
    assert.deepEqual(args.slice(0, 4), ["-p", "--strict-mcp-config", "--setting-sources", ""]);
  });

  it("isolates the session from ambient settings (I2): strict MCP + empty setting sources", () => {
    const args = buildClaudeArgs({
      model: "opus",
      allowedTools: "a",
      disallowedTools: "Bash",
      mcpConfigPath: "/tmp/mcp.json",
      systemPrompt: null,
    });
    assert.ok(args.includes("--strict-mcp-config"));
    const sourcesIdx = args.indexOf("--setting-sources");
    assert.ok(sourcesIdx > 0);
    assert.equal(args[sourcesIdx + 1], "");
  });

  it("appends --resume <session> when a session is given (nothing else changes)", () => {
    const fresh = buildClaudeArgs({
      model: "opus",
      allowedTools: "a,b",
      disallowedTools: "Bash",
      mcpConfigPath: "/tmp/mcp.json",
      systemPrompt: null,
    });
    const resumed = buildClaudeArgs({
      model: "opus",
      allowedTools: "a,b",
      disallowedTools: "Bash",
      mcpConfigPath: "/tmp/mcp.json",
      systemPrompt: null,
      session: "claude-session-abc123",
    });
    // The resume flag is appended at the END: strict flags, stdin transport,
    // and allow/deny lists are byte-identical to a fresh dispatch.
    assert.deepEqual(resumed.slice(0, fresh.length), fresh);
    assert.deepEqual(resumed.slice(fresh.length), ["--resume", "claude-session-abc123"]);
  });

  it("omits --resume when no session is given", () => {
    const args = buildClaudeArgs({
      model: "opus",
      allowedTools: "a",
      disallowedTools: "Bash",
      mcpConfigPath: "/tmp/mcp.json",
      systemPrompt: null,
    });
    assert.ok(!args.includes("--resume"));
  });
});

describe("disallowedToolsForAgent", () => {
  const FULL = [
    "mcp__sunaba__publish",
    "mcp__sunaba__sandbox_issue_write",
    "mcp__sunaba__sandbox_pr_review_write",
    "mcp__sunaba__secret_scan_override",
    "mcp__sunaba__sandbox_stop",
    "mcp__sunaba__sandbox_initialize",
    "mcp__sunaba__copy_file",
    "mcp__sunaba__copy_project",
    "mcp__sunaba__run_container_and_exec",
    "Bash",
    "Edit",
    "Write",
    "NotebookEdit",
  ];

  it("denies every never-run tool including issue write (implement agent, I1/I3)", () => {
    const csv = disallowedToolsForAgent("kusabi-implement");
    for (const tool of FULL) {
      assert.ok(csv.split(",").includes(tool), `${tool} must be disallowed, got: ${csv}`);
    }
  });

  it("exempts issue write for kusabi-investigate only", () => {
    const csv = disallowedToolsForAgent("kusabi-investigate");
    const tools = csv.split(",");
    assert.ok(!tools.includes("mcp__sunaba__sandbox_issue_write"));
    // Everything else stays denied.
    for (const tool of FULL) {
      if (tool === "mcp__sunaba__sandbox_issue_write") continue;
      assert.ok(tools.includes(tool), `${tool} must be disallowed, got: ${csv}`);
    }
  });

  it("denies issue write for every non-investigate agent (incl. review and no agent)", () => {
    for (const agent of ["kusabi-review", null, undefined, "kusabi-draft"]) {
      assert.ok(
        disallowedToolsForAgent(agent).split(",").includes("mcp__sunaba__sandbox_issue_write"),
        `agent ${agent} must deny issue write`,
      );
    }
  });
});

describe("parseClaudeResult", () => {
  it("parses a valid result object", () => {
    const parsed = parseClaudeResult(JSON.stringify({ type: "result", is_error: false, result: "ok" }));
    assert.equal(parsed.type, "result");
    assert.equal(parsed.result, "ok");
  });

  it("throws on garbage (not JSON)", () => {
    assert.throws(() => parseClaudeResult("this is not json"), /not JSON/);
  });

  it("throws on a non-result JSON shape", () => {
    assert.throws(() => parseClaudeResult(JSON.stringify({ type: "system", subtype: "init" })), /unexpected type/);
    assert.throws(() => parseClaudeResult(JSON.stringify([1, 2])), /not a JSON object/);
  });
});

describe("mapClaudeUsage", () => {
  it("maps claude usage fields onto the kusabi usage shape (test-asserted)", () => {
    const usage = mapClaudeUsage({
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 3000,
      },
      total_cost_usd: 0.0042,
    });
    assert.equal(usage.available, true);
    assert.equal(usage.input, 1000);
    assert.equal(usage.output, 500);
    assert.equal(usage.cacheWrite, 200);
    assert.equal(usage.cacheRead, 3000);
    assert.equal(usage.cost, 0.0042);
    assert.equal(usage.reasoning, 0);
  });

  it("defaults missing counters to 0", () => {
    const usage = mapClaudeUsage({ usage: {} });
    assert.equal(usage.input, 0);
    assert.equal(usage.output, 0);
    assert.equal(usage.cacheWrite, 0);
    assert.equal(usage.cacheRead, 0);
    assert.equal(usage.cost, 0);
  });
});

describe("allowedToolsForAgent", () => {
  it("maps the implement agent to the implement allowlist (mirrors kusabi-implement.md)", () => {
    const csv = allowedToolsForAgent("kusabi-implement");
    assert.equal(csv, ALLOWED_TOOLS.implement);
    assert.ok(csv.includes("mcp__sunaba__write_file"));
    assert.ok(csv.includes("mcp__sunaba__edit_file"));
    assert.ok(!csv.includes("mcp__sunaba__sandbox_issue_write"));
  });

  it("maps a bare task (no agent) to the implement allowlist", () => {
    assert.equal(allowedToolsForAgent(undefined), ALLOWED_TOOLS.implement);
    assert.equal(allowedToolsForAgent(null), ALLOWED_TOOLS.implement);
  });

  it("maps review to the review allowlist (mirrors kusabi-review.md)", () => {
    const csv = allowedToolsForAgent("kusabi-review");
    assert.equal(csv, ALLOWED_TOOLS.review);
    assert.ok(csv.includes("mcp__sunaba__verify_in_container"));
    assert.ok(csv.includes("mcp__shiori__*"));
    assert.ok(!csv.includes("mcp__sunaba__write_file"));
    assert.ok(!csv.includes("mcp__sunaba__sandbox_issue_write"));
  });

  it("maps investigate to its own allowlist with issue write (mirrors kusabi-investigate.md)", () => {
    const csv = allowedToolsForAgent("kusabi-investigate");
    assert.equal(csv, ALLOWED_TOOLS.investigate);
    // The standalone investigate deliverable is appending the brief to the
    // issue — the issue-write grant must NOT be lost on the claude backend
    // (kusabi #184 finding 3).  The chain strategist keeps the review-shaped
    // toolset because its phase passes reviewDenyTools(), which denies this
    // tool by exact match.
    assert.ok(csv.includes("mcp__sunaba__sandbox_issue_write"));
    assert.ok(csv.includes("mcp__shiori__*"));
    assert.ok(csv.includes("mcp__sunaba__sandbox_exec"));
    assert.ok(!csv.includes("mcp__sunaba__write_file"));
  });

  it("rejects agents with no v1 allowlist", () => {
    assert.throws(() => allowedToolsForAgent("kusabi-draft"), /no permission allowlist/);
    assert.throws(() => allowedToolsForAgent("custom-agent"), /no permission allowlist/);
  });
});

describe("applyToolDenies", () => {
  it("removes explicitly denied tools from the CSV", () => {
    const csv = applyToolDenies("a,b,c", { b: false });
    assert.equal(csv, "a,c");
  });

  it("removes the phase deny maps' real tool names from the allowlist", () => {
    // implementDenyTools / reviewDenyTools name real sunaba tools (the copy
    // tools) — normalized to mcp__sunaba__* and removed by exact match.
    const csv = applyToolDenies("a,mcp__sunaba__copy_project,b", { sunaba_copy_project: false });
    assert.equal(csv, "a,b");
  });

  it("is a no-op for deny maps with no matching tools", () => {
    const csv = applyToolDenies("a,b", { bash: false, edit: false });
    assert.equal(csv, "a,b");
  });

  it("is a no-op without a tools map", () => {
    assert.equal(applyToolDenies("a,b", undefined), "a,b");
    assert.equal(applyToolDenies("a,b", null), "a,b");
  });

  it("does NOT strip the implement allowlist for the phase deny map (opencode names are no-ops there)", () => {
    // The chain implement phase passes implementDenyTools() (opencode
    // vocabulary + copy tools).  Its opencode-native names must not map to
    // sunaba tools — the allowlist IS the permission mechanism, and mapping
    // bash/edit/write/patch would neuter the implement worker.  The result
    // must be byte-identical to the untouched allowlist (the copy tools are
    // not in it).
    const csv = applyToolDenies(ALLOWED_TOOLS.implement, implementDenyTools());
    assert.equal(csv, ALLOWED_TOOLS.implement);
    assert.ok(csv.includes("mcp__sunaba__write_file"));
    assert.ok(csv.includes("mcp__sunaba__sandbox_exec"));
  });
});

describe("translateDenyTools", () => {
  it("maps the opencode --read-only vocabulary to the sunaba tools (task has no equivalent)", () => {
    const readOnly = Object.fromEntries(WRITE_TOOL_NAMES.map((t) => [t, false]));
    const translated = translateDenyTools(readOnly);
    assert.deepEqual(translated, {
      mcp__sunaba__sandbox_exec: false,
      mcp__sunaba__write_file: false,
      mcp__sunaba__edit_file: false,
      mcp__sunaba__transform_file: false,
    });
  });

  it("keeps sunaba_* names (and other non-vocabulary names) verbatim", () => {
    const translated = translateDenyTools({ sunaba_write_file: false, bash: false, sunaba_sandbox_issue_write: false });
    assert.deepEqual(translated, {
      sunaba_write_file: false,
      mcp__sunaba__sandbox_exec: false,
      sunaba_sandbox_issue_write: false,
    });
  });

  it("is a no-op without a tools map", () => {
    assert.equal(translateDenyTools(undefined), undefined);
    assert.equal(translateDenyTools(null), null);
  });
});

describe("clampModelDispatch", () => {
  it("fills explicitModel from the command-start model when the phase passes none", async () => {
    const calls = [];
    const inner = async (opts) => { calls.push(opts); return { job: {}, resultText: "", stateDir: "" }; };
    const wrapped = clampModelDispatch(inner, "opus");

    await wrapped({ kind: "task", round: 2, explicitModel: null });
    await wrapped({ kind: "review", explicitModel: "opus" });
    await wrapped({ kind: "strategist", explicitModel: undefined });

    // Rework/strategist phases pass no explicitModel → clamped to opus; a
    // phase that does pass one keeps it.
    assert.equal(calls[0].explicitModel, "opus");
    assert.equal(calls[1].explicitModel, "opus");
    assert.equal(calls[2].explicitModel, "opus");
    // All other options pass through untouched.
    assert.equal(calls[0].round, 2);
    assert.equal(calls[2].kind, "strategist");
  });

  it("falls through to null when neither the phase nor the model supplies one", async () => {
    const calls = [];
    const inner = async (opts) => { calls.push(opts); return { job: {}, resultText: "", stateDir: "" }; };
    const wrapped = clampModelDispatch(inner, null);
    await wrapped({ kind: "task", explicitModel: null });
    assert.equal(calls[0].explicitModel, null);
  });
});

describe("extractSunabaMcp", () => {
  it("extracts the sunaba server entry", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-claude-mcp-"));
    const file = path.join(dir, "claude.json");
    const sunaba = { command: "npx", args: ["-y", "sunaba"] };
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { sunaba, other: { command: "echo" } } }), "utf8");
    assert.deepEqual(extractSunabaMcp(file), sunaba);
  });

  it("throws a clear error when the entry is missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-claude-mcp-"));
    const file = path.join(dir, "claude.json");
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: "echo" } } }), "utf8");
    assert.throws(() => extractSunabaMcp(file), /no mcpServers\.sunaba entry/);
  });

  it("throws a clear error when the file is unreadable", () => {
    assert.throws(() => extractSunabaMcp("/nonexistent/never.json"), /cannot read MCP source config/);
  });
});

// =========================================================================
// integration — fake `claude` binary (CLAUDE_BIN), like serve-lifecycle
// =========================================================================

const FAKE_CLAUDE_SOURCE = `#!/usr/bin/env node
import fs from "node:fs";

fs.appendFileSync(process.env.FAKE_CLAUDE_ARGS_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
fs.appendFileSync(process.env.FAKE_CLAUDE_PIDS, String(process.pid) + "\\n");

// Prompt arrives on stdin (I5): the dispatch writes it and ends the stream.
// Recording it proves the prompt reached the child without touching argv.
const promptText = fs.readFileSync(0, "utf8");
if (process.env.FAKE_CLAUDE_STDIN_LOG) {
  fs.appendFileSync(process.env.FAKE_CLAUDE_STDIN_LOG, promptText);
}

const mode = process.env.FAKE_CLAUDE_MODE || "ok";

if (mode === "exit") {
  process.stderr.write("claude: permission denied for model opus\\n");
  process.exit(3);
}
if (mode === "garbage") {
  process.stdout.write("this is not json at all\\n");
  process.exit(0);
}
if (mode === "is-error") {
  process.stdout.write(JSON.stringify({
    type: "result", is_error: true, result: "boom: tool call failed",
    session_id: "sess-err", usage: {}, total_cost_usd: 0, duration_ms: 5, num_turns: 1,
  }));
  process.exit(0);
}
if (mode === "slow" || mode === "slow-with-child") {
  if (mode === "slow-with-child") {
    // Grandchild that inherits our stdout/stderr pipes: it must die with
    // the process-group kill, or the dispatch's 'close' never fires and
    // the job hangs forever after the timeout.
    const { spawn } = await import("node:child_process");
    const sleeper = spawn("sleep", ["300"], { stdio: "inherit" });
    fs.appendFileSync(process.env.FAKE_CLAUDE_PIDS, String(sleeper.pid) + "\\n");
  }
  setInterval(() => {}, 1000); // never writes, never exits — the dispatch timeout must kill us
} else {
  const argv = process.argv.slice(2);
  const resumeAt = argv.indexOf("--resume");
  // "resume-echo" models the real CLI contract: when resumed, the JSON
  // result carries the SAME session id that was passed via --resume.
  const sessionId = mode === "resume-echo" && resumeAt >= 0
    ? argv[resumeAt + 1]
    : "claude-session-abc123";
  const result = {
    type: "result",
    is_error: false,
    result: "implemented the thing per the brief",
    session_id: sessionId,
    usage: {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 3000,
    },
    total_cost_usd: 0.0042,
    duration_ms: 12000,
    num_turns: 5,
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}
`;

const SUNABA_MCP = {
  command: "npx",
  args: ["-y", "@sunaba/mcp-server"],
  env: { SUNABA_URL: "http://127.0.0.1:8750/mcp" },
};

function fakeClaudeContext(mode = "ok") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-claude-test-"));
  const binPath = path.join(tmp, "fake-claude.mjs");
  const argsLog = path.join(tmp, "args.ndjson");
  const pidsLog = path.join(tmp, "spawned.pids");
  const stdinLog = path.join(tmp, "stdin.txt");
  fs.writeFileSync(binPath, FAKE_CLAUDE_SOURCE, "utf8");
  fs.chmodSync(binPath, 0o755);
  fs.writeFileSync(argsLog, "", "utf8");
  fs.writeFileSync(pidsLog, "", "utf8");
  fs.writeFileSync(stdinLog, "", "utf8");

  const stateRoot = path.join(tmp, "state");
  const cwd = path.join(tmp, "cwd");
  fs.mkdirSync(cwd, { recursive: true });

  const mcpSource = path.join(tmp, "claude.json");
  fs.writeFileSync(mcpSource, JSON.stringify({ mcpServers: { sunaba: SUNABA_MCP, other: { command: "echo" } } }), "utf8");

  const saved = {
    CLAUDE_BIN: process.env.CLAUDE_BIN,
    KUSABI_STATE_DIR: process.env.KUSABI_STATE_DIR,
    KUSABI_CLAUDE_MCP_SOURCE: process.env.KUSABI_CLAUDE_MCP_SOURCE,
    FAKE_CLAUDE_MODE: process.env.FAKE_CLAUDE_MODE,
    FAKE_CLAUDE_ARGS_LOG: process.env.FAKE_CLAUDE_ARGS_LOG,
    FAKE_CLAUDE_PIDS: process.env.FAKE_CLAUDE_PIDS,
    FAKE_CLAUDE_STDIN_LOG: process.env.FAKE_CLAUDE_STDIN_LOG,
  };
  process.env.CLAUDE_BIN = binPath;
  process.env.KUSABI_STATE_DIR = stateRoot;
  process.env.KUSABI_CLAUDE_MCP_SOURCE = mcpSource;
  process.env.FAKE_CLAUDE_MODE = mode;
  process.env.FAKE_CLAUDE_ARGS_LOG = argsLog;
  process.env.FAKE_CLAUDE_PIDS = pidsLog;
  process.env.FAKE_CLAUDE_STDIN_LOG = stdinLog;

  const stateDir = stateDirFor(cwd);
  return {
    tmp,
    cwd,
    stateDir,
    argsLog,
    pidsLog,
    stdinLog,
    mcpSource,
    dispatchOptions(overrides = {}) {
      return {
        cwd,
        kind: "task",
        title: "claude dispatch test",
        promptText: "Do the thing.",
        agent: "kusabi-implement",
        phase: null,
        tools: null,
        timeoutS: 10,
        watchdogS: 900,
        tiers: [["opus"]],
        round: 1,
        explicitModel: null,
        ...overrides,
      };
    },
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

function spawnedPids(pidsLog) {
  const text = fs.readFileSync(pidsLog, "utf8");
  return text.trim() ? text.trim().split("\n").map(Number) : [];
}

function isAlive(pid) {
  try {
    process.kill(pid, 0); // throws if the pid is gone (or EPERM = alive)
    // kill(pid, 0) succeeds for zombies too, so read the state directly:
    // after the group kill the orphaned grandchild is reparented to init
    // and may sit unreaped as a zombie (state Z/X) for a moment — it IS
    // dead, and the dispatch's 'close' already proves the pipe holders
    // exited, so a lingering zombie must not fail the assertion.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}

describe("claudeDispatch (fake claude binary)", () => {
  let ctx;

  beforeEach(() => {
    ctx = fakeClaudeContext();
  });

  afterEach(() => {
    ctx.restore();
  });

  it("returns a completed job with backend, mapped usage, and the session id", async () => {
    const { job, resultText, stateDir } = await claudeDispatch(ctx.dispatchOptions());

    assert.equal(job.status, "completed");
    assert.equal(job.backend, "claude");
    assert.equal(job.sessionID, "claude-session-abc123");
    assert.equal(job.modelEntry, "opus");
    assert.equal(job.modelVariant, null);
    assert.equal(resultText, "implemented the thing per the brief");
    assert.equal(stateDir, ctx.stateDir);

    // Mapped usage (test-asserted mapping).
    assert.equal(job.usage.available, true);
    assert.equal(job.usage.input, 1000);
    assert.equal(job.usage.output, 500);
    assert.equal(job.usage.cacheWrite, 200);
    assert.equal(job.usage.cacheRead, 3000);
    assert.equal(job.usage.cost, 0.0042);
    assert.equal(typeof job.usage.durationSeconds, "number");

    // The record is persisted with the same shape the opencode path uses.
    const persisted = loadJob(stateDir, job.id);
    assert.equal(persisted.status, "completed");
    assert.equal(persisted.backend, "claude");
    assert.equal(persisted.sessionID, "claude-session-abc123");
    assert.equal(persisted.phase, null);

    // Artifacts: prompt.md, result.md, usage.json.
    const jdir = jobDir(stateDir, job.id);
    assert.equal(fs.readFileSync(path.join(jdir, "prompt.md"), "utf8"), "Do the thing.");
    assert.equal(fs.readFileSync(path.join(jdir, "result.md"), "utf8"), "implemented the thing per the brief");
    const usageFile = readJson(path.join(jdir, "usage.json"));
    assert.equal(usageFile.input, 1000);
    assert.equal(usageFile.cacheWrite, 200);

    // Audit trail events.
    const events = fs.readFileSync(path.join(jdir, "events.ndjson"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(events[0].type, "companion.claude.dispatch");
    assert.equal(events[1].type, "companion.claude.finished");
    assert.equal(events[1].status, "completed");
  });

  it("builds the contract invocation shape (implement agent: allowlist + system prompt)", async () => {
    await claudeDispatch(ctx.dispatchOptions());

    const args = JSON.parse(fs.readFileSync(ctx.argsLog, "utf8").trim());
    // Bare -p: the prompt is NOT on argv (I5) — it goes via stdin.
    assert.equal(args[0], "-p");
    assert.ok(!args.includes("Do the thing."));
    // Strict MCP + empty setting sources: ambient settings stop applying.
    assert.equal(args[1], "--strict-mcp-config");
    assert.equal(args[2], "--setting-sources");
    assert.equal(args[3], "");
    assert.equal(args[4], "--output-format");
    assert.equal(args[5], "json");
    assert.equal(args[6], "--model");
    assert.equal(args[7], "opus");
    assert.equal(args[8], "--allowedTools");
    assert.equal(args[9], ALLOWED_TOOLS.implement);
    assert.equal(args[10], "--disallowedTools");
    assert.equal(args[11], disallowedToolsForAgent("kusabi-implement"));
    assert.ok(args[11].split(",").includes("mcp__sunaba__publish"));
    assert.ok(args[11].split(",").includes("mcp__sunaba__sandbox_issue_write"));
    assert.ok(args[11].split(",").includes("Bash"));
    assert.equal(args[12], "--mcp-config");

    // The generated MCP config contains ONLY the sunaba entry.
    const mcpConfigPath = args[13];
    assert.equal(mcpConfigPath, path.join(ctx.stateDir, "claude-mcp.json"));
    const mcpConfig = readJson(mcpConfigPath);
    assert.deepEqual(mcpConfig, { mcpServers: { sunaba: SUNABA_MCP } });
    assert.equal(mcpConfig.mcpServers.other, undefined);

    assert.equal(args[14], "--append-system-prompt");
    const systemPrompt = args[15];
    // Frontmatter stripped: the body, not the YAML header.
    assert.match(systemPrompt, /^You are the "implement" phase worker/);
    assert.ok(!systemPrompt.startsWith("---"));
    // Never --dangerously-skip-permissions.
    assert.ok(!args.includes("--dangerously-skip-permissions"));

    // The prompt reached the child on stdin (I5), not argv.
    assert.equal(fs.readFileSync(ctx.stdinLog, "utf8"), "Do the thing.");
  });

  it("one model per phase: uses the chain's first route, never walks the ladder", async () => {
    await claudeDispatch(ctx.dispatchOptions({
      tiers: [["sonnet", "haiku"], ["opus"]],
      tierIndex: 1,
      round: 2,
    }));
    const args = JSON.parse(fs.readFileSync(ctx.argsLog, "utf8").trim());
    assert.equal(args[7], "sonnet");
  });

  it("explicitModel wins over the chain", async () => {
    await claudeDispatch(ctx.dispatchOptions({
      tiers: [["sonnet"]],
      explicitModel: "claude-opus-4-1",
    }));
    const args = JSON.parse(fs.readFileSync(ctx.argsLog, "utf8").trim());
    assert.equal(args[7], "claude-opus-4-1");
    assert.equal(args[6], "--model");
  });

  it("review agent: review allowlist + review system prompt", async () => {
    await claudeDispatch(ctx.dispatchOptions({
      kind: "review",
      agent: "kusabi-review",
      phase: "review",
    }));
    const args = JSON.parse(fs.readFileSync(ctx.argsLog, "utf8").trim());
    assert.equal(args[9], ALLOWED_TOOLS.review);
    assert.equal(args[11], disallowedToolsForAgent("kusabi-review"));
    assert.match(args[15], /^You are the "review" phase worker/);
  });

  it("investigate agent: issue write is exempt from --disallowedTools but stays out of the review allowlist", async () => {
    await claudeDispatch(ctx.dispatchOptions({
      agent: "kusabi-investigate",
    }));
    const args = JSON.parse(fs.readFileSync(ctx.argsLog, "utf8").trim());
    const denied = args[11].split(",");
    assert.ok(!denied.includes("mcp__sunaba__sandbox_issue_write"), "investigate deliverable must stay allowed");
    assert.ok(denied.includes("mcp__sunaba__publish"));
    assert.ok(denied.includes("mcp__sunaba__sandbox_pr_review_write"));
  });

  it("applies tools deny maps to the allowlist (a deny is never silently ignored)", async () => {
    await claudeDispatch(ctx.dispatchOptions({
      tools: { sunaba_edit_file: false, bash: false },
    }));
    const args = JSON.parse(fs.readFileSync(ctx.argsLog, "utf8").trim());
    const csv = args[9];
    assert.ok(!csv.split(",").includes("mcp__sunaba__edit_file"));
    assert.ok(csv.split(",").includes("mcp__sunaba__write_file"));
  });

  it("--read-only removes the write tools from the allowlist (never silently ignored)", async () => {
    // The CLI translates the opencode vocabulary before dispatch
    // (translateDenyTools in cmdTask); this asserts the dispatch-side
    // effect: the translated deny map strips the sunaba write tools from
    // the --allowedTools CSV (kusabi #184 finding 2).
    await claudeDispatch(ctx.dispatchOptions({
      tools: translateDenyTools(Object.fromEntries(WRITE_TOOL_NAMES.map((t) => [t, false]))),
    }));
    const args = JSON.parse(fs.readFileSync(ctx.argsLog, "utf8").trim());
    const csv = args[9].split(",");
    for (const tool of ["mcp__sunaba__sandbox_exec", "mcp__sunaba__write_file", "mcp__sunaba__edit_file", "mcp__sunaba__transform_file"]) {
      assert.ok(!csv.includes(tool), `${tool} must be denied by --read-only`);
    }
    // Read-side and verify tools stay.
    assert.ok(csv.includes("mcp__sunaba__read_file_range"));
    assert.ok(csv.includes("mcp__sunaba__checkpoint"));
    assert.ok(csv.includes("mcp__sunaba__verify_in_container"));
  });

  it("resumes a session: --resume <id> reaches argv, the job keeps the result's session id", async () => {
    const { job } = await claudeDispatch(ctx.dispatchOptions({
      session: "claude-session-round1",
    }));

    // The fake claude observed --resume <session> on its argv.
    const args = JSON.parse(fs.readFileSync(ctx.argsLog, "utf8").trim());
    const resumeIdx = args.indexOf("--resume");
    assert.ok(resumeIdx > 0, "a given session must be passed via --resume");
    assert.equal(args[resumeIdx + 1], "claude-session-round1");
    // Resume is a transport detail: the isolation flags stay exactly as a
    // fresh dispatch builds them (strict MCP, empty setting sources, the
    // allowlist; the prompt still travels on stdin).
    assert.equal(args[1], "--strict-mcp-config");
    assert.equal(args[2], "--setting-sources");
    assert.equal(args[3], "");
    assert.equal(args[9], ALLOWED_TOOLS.implement);
    // The prompt still travels on stdin (I5), never on argv.
    assert.ok(!args.includes("Do the thing."));
    assert.equal(fs.readFileSync(ctx.stdinLog, "utf8"), "Do the thing.");

    // The recorded session id comes from the CLI's JSON result (the single
    // capture source) — never pre-filled from the option.
    assert.equal(job.status, "completed");
    assert.equal(job.sessionID, "claude-session-abc123");
  });

  it("chain rework round on the claude backend: round 2 receives the round-1 sessionID, end to end", async () => {
    // The context-continuity fix pinned at BOTH seams: chain-phases derives
    // the rework round's session from previousRecord.sessionID, and the
    // claude dispatch honors it as `--resume` on argv (instead of starting
    // blank).  runImplementPhase is imported UNCHANGED from chain-phases.mjs.
    const calls = [];
    const stubDispatch = async (opts) => {
      calls.push(opts);
      const round = opts.round ?? 1;
      return {
        job: {
          id: `job-imp-${round}`,
          status: "completed",
          modelEntry: "opus",
          modelVariant: null,
          fallbacks: null,
          sessionID: `claude-uuid-round${round}`,
          usage: null,
          error: null,
        },
        resultText: "implemented",
      };
    };
    const common = {
      cwd: ctx.cwd,
      chainId: "chain-x",
      implementText: "Do the thing.",
      modelChain: [["opus"]],
      tierIndex: 0,
      flagsModel: null,
      resumeMethod: { type: "continue_session" },
      _dispatchWithFallback: stubDispatch,
    };

    // Round 1: fresh dispatch — no session to continue.
    await runImplementPhase({
      ...common, round: 1, isFirstRound: true, previousRecord: null,
      session: undefined, useNewSession: false,
    });
    assert.equal(calls[0].session, undefined);

    // Round 2 (rework): chain-phases resolves the session from the previous
    // round's record — the claude chain must NOT start blank.
    const second = await runImplementPhase({
      ...common, round: 2, isFirstRound: false,
      previousRecord: { sessionID: "claude-uuid-round1" },
      session: undefined, useNewSession: false,
    });
    assert.equal(calls[1].session, "claude-uuid-round1");
    assert.equal(second.session, "claude-uuid-round1");

    // The journey's end: that same session reaches the claude CLI as
    // `--resume <id>` via the real dispatch.
    const { job } = await claudeDispatch(ctx.dispatchOptions({
      round: 2,
      session: calls[1].session,
    }));
    const lines = fs.readFileSync(ctx.argsLog, "utf8").trim().split("\n");
    const round2Args = JSON.parse(lines[lines.length - 1]);
    const resumeIdx = round2Args.indexOf("--resume");
    assert.ok(resumeIdx > 0, "a rework round must resume the previous session");
    assert.equal(round2Args[resumeIdx + 1], "claude-uuid-round1");
    assert.equal(job.status, "completed");
  });

  it("resume keeps the session id through the CLI's JSON result (single capture source)", async () => {
    ctx.restore();
    ctx = fakeClaudeContext("resume-echo");
    const { job } = await claudeDispatch(ctx.dispatchOptions({
      session: "claude-uuid-echo-1",
    }));
    assert.equal(job.status, "completed");
    // The fake modeled the real CLI contract: `--resume <id>` in, the SAME
    // id out in the JSON result — and the job keeps it via the EXISTING
    // capture path (parsed.session_id), never pre-filled from opts.
    assert.equal(job.sessionID, "claude-uuid-echo-1");
    const args = JSON.parse(fs.readFileSync(ctx.argsLog, "utf8").trim());
    assert.equal(args[args.indexOf("--resume") + 1], "claude-uuid-echo-1");
  });

  it("rejects an opencode-shaped session id (ses_*) loudly, before any process or job record", async () => {
    await assert.rejects(
      () => claudeDispatch(ctx.dispatchOptions({ session: "ses_xyz" })),
      (err) => {
        // The error names BOTH backends: the opencode session and the claude
        // backend it cannot be resumed on.
        assert.match(err.message, /opencode session ses_xyz cannot be resumed on the claude backend/);
        assert.match(err.message, /ses_\* session ids belong to opencode/);
        return true;
      },
    );
    // Nothing was spawned...
    assert.equal(fs.readFileSync(ctx.argsLog, "utf8").trim(), "");
    assert.equal(fs.readFileSync(ctx.pidsLog, "utf8").trim(), "");
    // ...and no job record was left behind (nothing recorded "running").
    assert.deepEqual(fs.readdirSync(path.join(ctx.stateDir, "jobs")), []);
  });

  it("rejects a :variant model at dispatch time too", async () => {
    await assert.rejects(
      () => claudeDispatch(ctx.dispatchOptions({ explicitModel: "opus:max" })),
      /:variant/,
    );
  });

  it("fails the dispatch when the binary exits nonzero, preserving the error text", async () => {
    ctx.restore();
    ctx = fakeClaudeContext("exit");
    const { job, resultText } = await claudeDispatch(ctx.dispatchOptions());

    assert.equal(job.status, "error");
    assert.match(job.error, /claude exited with code 3/);
    assert.match(job.error, /permission denied for model opus/);
    assert.equal(job.retry, null);
    assert.equal(job.fallbacks, null);
    assert.equal(resultText, "");
    // The failure record is persisted with the error text.
    const persisted = loadJob(ctx.stateDir, job.id);
    assert.equal(persisted.status, "error");
    assert.equal(persisted.error, job.error);
  });

  it("fails the dispatch on garbage stdout, preserving the output snippet", async () => {
    ctx.restore();
    ctx = fakeClaudeContext("garbage");
    const { job } = await claudeDispatch(ctx.dispatchOptions());

    assert.equal(job.status, "error");
    assert.match(job.error, /unparseable output/);
    assert.match(job.error, /this is not json at all/);
    assert.equal(job.retry, null);
    assert.equal(job.fallbacks, null);
  });

  it("fails the dispatch when the result carries is_error", async () => {
    ctx.restore();
    ctx = fakeClaudeContext("is-error");
    const { job } = await claudeDispatch(ctx.dispatchOptions());

    assert.equal(job.status, "error");
    assert.match(job.error, /boom: tool call failed/);
  });

  it("times out: kills the child AND its process group, reports the opencode timeout status", async () => {
    ctx.restore();
    ctx = fakeClaudeContext("slow-with-child");
    const { job } = await claudeDispatch(ctx.dispatchOptions({ timeoutS: 1 }));

    assert.equal(job.status, "timeout");
    assert.equal(job.error, "timed out after 1s");

    // The fake claude AND the grandchild it spawned (which inherited the
    // stdout pipe — the dispatch only resolves once the group is dead) were
    // actually killed — no orphaned work survives the timeout.
    const pids = spawnedPids(ctx.pidsLog);
    assert.ok(pids.length >= 2, "the fake claude and its grandchild must have been spawned");
    for (const pid of pids) {
      assert.equal(isAlive(pid), false, `pid ${pid} must be dead after the timeout group kill`);
    }
  });

  it("fails loudly when the MCP source config lacks mcpServers.sunaba", async () => {
    const badSource = path.join(ctx.tmp, "no-sunaba.json");
    fs.writeFileSync(badSource, JSON.stringify({ mcpServers: { other: { command: "echo" } } }), "utf8");
    process.env.KUSABI_CLAUDE_MCP_SOURCE = badSource;
    await assert.rejects(
      () => claudeDispatch(ctx.dispatchOptions()),
      (err) => {
        assert.match(err.message, /no mcpServers\.sunaba entry/);
        assert.ok(err.message.includes(badSource));
        return true;
      },
    );
  });

  it("rejects an agent with no v1 allowlist", async () => {
    await assert.rejects(
      () => claudeDispatch(ctx.dispatchOptions({ agent: "kusabi-draft" })),
      /no permission allowlist/,
    );
  });

  it("rejects a missing agent file", async () => {
    await assert.rejects(
      () => claudeDispatch(ctx.dispatchOptions({ agent: "kusabi-does-not-exist" })),
      /cannot read agent file/,
    );
  });
});

// =========================================================================
// CLI --read-only wiring — the flag must reach the claude --allowedTools
// =========================================================================

describe("CLI --read-only wiring (subprocess)", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");

  it("--backend claude --read-only denies the sunaba write tools in --allowedTools", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-claude-readonly-"));
    try {
      const binPath = path.join(tmp, "fake-claude.mjs");
      fs.writeFileSync(binPath, FAKE_CLAUDE_SOURCE, "utf8");
      fs.chmodSync(binPath, 0o755);
      const argsLog = path.join(tmp, "args.ndjson");
      const pidsLog = path.join(tmp, "pids");
      const stdinLog = path.join(tmp, "stdin.txt");
      fs.writeFileSync(argsLog, "", "utf8");
      fs.writeFileSync(pidsLog, "", "utf8");
      fs.writeFileSync(stdinLog, "", "utf8");
      const mcpSource = path.join(tmp, "claude.json");
      fs.writeFileSync(mcpSource, JSON.stringify({ mcpServers: { sunaba: SUNABA_MCP } }), "utf8");

      const env = { ...process.env };
      delete env.KUSABI_WORKER_CONTEXT;
      env.CLAUDE_BIN = binPath;
      env.KUSABI_CLAUDE_MCP_SOURCE = mcpSource;
      env.KUSABI_STATE_DIR = path.join(tmp, "state");
      env.FAKE_CLAUDE_MODE = "ok";
      env.FAKE_CLAUDE_ARGS_LOG = argsLog;
      env.FAKE_CLAUDE_PIDS = pidsLog;
      env.FAKE_CLAUDE_STDIN_LOG = stdinLog;

      const result = spawnSync(
        process.execPath,
        [COMPANION_SCRIPT, "task", "--backend", "claude", "--read-only", "do the thing"],
        { encoding: "utf8", cwd: tmp, env, timeout: 20_000 },
      );
      assert.equal(result.status, 0, `expected success, got: ${result.stdout} ${result.stderr}`);
      const args = JSON.parse(fs.readFileSync(argsLog, "utf8").trim());
      const csv = args[9].split(",");
      for (const tool of ["mcp__sunaba__sandbox_exec", "mcp__sunaba__write_file", "mcp__sunaba__edit_file", "mcp__sunaba__transform_file"]) {
        assert.ok(!csv.includes(tool), `${tool} must be denied by --read-only, got csv: ${csv.join(",")}`);
      }
      assert.ok(csv.includes("mcp__sunaba__read_file_range"));
      // The prompt travels on stdin through the real CLI path (I5): the
      // task text reached the child without ever being on argv.
      assert.ok(!args.includes("do the thing"));
      assert.match(fs.readFileSync(stdinLog, "utf8"), /do the thing/);
      assert.match(fs.readFileSync(stdinLog, "utf8"), /<task>/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// =========================================================================
// CLI session wiring (subprocess) — kusabi #184 Job B
// =========================================================================
// Both backends share ONE job store, so `--resume-last` must select the
// previous job of the SAME backend as the current dispatch.  These tests
// drive the real CLI (cmdTask) with fixture job records and observe the
// session that actually reaches the fake claude on argv.

describe("CLI session wiring (subprocess)", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");

  // The subprocess resolves its workspace state dir via stateDirFor(cwd),
  // which hashes the cwd under the state root — replicate that here so the
  // fixture jobs land where cmdTask looks for them.
  function hashedWorkspaceDir(stateRootDir, cwd) {
    const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12);
    return path.join(stateRootDir, hash);
  }

  function writeFixtureJob(jobsDir, id, job) {
    const dir = path.join(jobsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({ id, ...job }), "utf8");
  }

  function setup(tmp, { jobs }) {
    const binPath = path.join(tmp, "fake-claude.mjs");
    fs.writeFileSync(binPath, FAKE_CLAUDE_SOURCE, "utf8");
    fs.chmodSync(binPath, 0o755);
    const argsLog = path.join(tmp, "args.ndjson");
    const pidsLog = path.join(tmp, "pids");
    const stdinLog = path.join(tmp, "stdin.txt");
    fs.writeFileSync(argsLog, "", "utf8");
    fs.writeFileSync(pidsLog, "", "utf8");
    fs.writeFileSync(stdinLog, "", "utf8");
    const mcpSource = path.join(tmp, "claude.json");
    fs.writeFileSync(mcpSource, JSON.stringify({ mcpServers: { sunaba: SUNABA_MCP } }), "utf8");

    const stateRoot = path.join(tmp, "state");
    const jobsDir = path.join(hashedWorkspaceDir(stateRoot, tmp), "jobs");
    for (const job of jobs) writeFixtureJob(jobsDir, job.id, job);

    const env = { ...process.env };
    delete env.KUSABI_WORKER_CONTEXT;
    env.CLAUDE_BIN = binPath;
    env.KUSABI_CLAUDE_MCP_SOURCE = mcpSource;
    env.KUSABI_STATE_DIR = stateRoot;
    env.FAKE_CLAUDE_MODE = "ok";
    env.FAKE_CLAUDE_ARGS_LOG = argsLog;
    env.FAKE_CLAUDE_PIDS = pidsLog;
    env.FAKE_CLAUDE_STDIN_LOG = stdinLog;
    return { env, argsLog, stdinLog };
  }

  it("--backend claude --resume-last resumes the last CLAUDE job, skipping a newer opencode job", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-claude-resume-last-"));
    try {
      const { env, argsLog } = setup(tmp, {
        jobs: [
          // Newer job: opencode (missing backend field = opencode).
          { id: "job-opencode", kind: "task", status: "completed", sessionID: "ses_opencode_latest", startedAt: "2026-08-02T00:00:00.000Z" },
          // Older job: claude.
          { id: "job-claude", kind: "task", status: "completed", backend: "claude", sessionID: "claude-uuid-older", startedAt: "2026-08-01T00:00:00.000Z" },
        ],
      });

      const result = spawnSync(
        process.execPath,
        [COMPANION_SCRIPT, "task", "--backend", "claude", "--resume-last", "do the thing"],
        { encoding: "utf8", cwd: tmp, env, timeout: 20_000 },
      );
      assert.equal(result.status, 0, `expected success, got: ${result.stdout} ${result.stderr}`);
      const args = JSON.parse(fs.readFileSync(argsLog, "utf8").trim());
      const resumeIdx = args.indexOf("--resume");
      assert.ok(resumeIdx > 0, "--resume-last must pass --resume to the claude dispatch");
      assert.equal(args[resumeIdx + 1], "claude-uuid-older");
      assert.notEqual(args[resumeIdx + 1], "ses_opencode_latest");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--backend claude --resume-last errors naming the backend when only opencode jobs exist", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-claude-resume-last-"));
    try {
      const { env, argsLog } = setup(tmp, {
        jobs: [
          { id: "job-opencode", kind: "task", status: "completed", sessionID: "ses_opencode_only", startedAt: "2026-08-02T00:00:00.000Z" },
        ],
      });

      const result = spawnSync(
        process.execPath,
        [COMPANION_SCRIPT, "task", "--backend", "claude", "--resume-last", "do the thing"],
        { encoding: "utf8", cwd: tmp, env, timeout: 20_000 },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /--resume-last: no previous claude task session found for this directory/);
      // Nothing was dispatched — the selection error fires before the run.
      assert.equal(fs.readFileSync(argsLog, "utf8").trim(), "");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--backend claude --session <id> passes the session through cmdTask as --resume", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-claude-session-"));
    try {
      const { env, argsLog } = setup(tmp, { jobs: [] });

      const result = spawnSync(
        process.execPath,
        [COMPANION_SCRIPT, "task", "--backend", "claude", "--session", "claude-uuid-cli", "do the thing"],
        { encoding: "utf8", cwd: tmp, env, timeout: 20_000 },
      );
      assert.equal(result.status, 0, `expected success, got: ${result.stdout} ${result.stderr}`);
      const args = JSON.parse(fs.readFileSync(argsLog, "utf8").trim());
      const resumeIdx = args.indexOf("--resume");
      assert.ok(resumeIdx > 0, "--session must pass --resume to the claude dispatch");
      assert.equal(args[resumeIdx + 1], "claude-uuid-cli");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--backend claude --session ses_* fails loudly through the CLI, before any dispatch", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-claude-session-"));
    try {
      const { env, argsLog } = setup(tmp, { jobs: [] });

      const result = spawnSync(
        process.execPath,
        [COMPANION_SCRIPT, "task", "--backend", "claude", "--session", "ses_opencode_1", "do the thing"],
        { encoding: "utf8", cwd: tmp, env, timeout: 20_000 },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /opencode session ses_opencode_1 cannot be resumed on the claude backend/);
      // The guard fires before the process spawns and before any job record:
      // nothing was dispatched and nothing was left recorded "running".
      assert.equal(fs.readFileSync(argsLog, "utf8").trim(), "");
      const jobsDir = path.join(hashedWorkspaceDir(path.join(tmp, "state"), tmp), "jobs");
      assert.deepEqual(fs.readdirSync(jobsDir), []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--backend claude --phase <p> --resume-last errors naming the phase and the backend", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-claude-resume-last-"));
    try {
      const { env, argsLog } = setup(tmp, { jobs: [] });

      const result = spawnSync(
        process.execPath,
        [COMPANION_SCRIPT, "task", "--backend", "claude", "--phase", "implement", "--resume-last", "do the thing"],
        { encoding: "utf8", cwd: tmp, env, timeout: 20_000 },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /--resume-last: no previous implement claude session found for this directory/);
      assert.equal(fs.readFileSync(argsLog, "utf8").trim(), "");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// =========================================================================
// CLI backend resolution (kusabi-companion)
// =========================================================================

describe("resolveBackend", () => {
  it("defaults to opencode without the flag", () => {
    assert.equal(resolveBackend({}), "opencode");
  });

  it("accepts opencode and claude", () => {
    assert.equal(resolveBackend({ backend: "opencode" }), "opencode");
    assert.equal(resolveBackend({ backend: "claude" }), "claude");
  });

  it("throws a clear, distinct error for an unknown backend", () => {
    assert.throws(() => resolveBackend({ backend: "bogus" }), /unknown backend: bogus/);
    assert.throws(() => resolveBackend({ backend: "bogus" }), /Use --backend opencode\|claude/);
  });
});

describe("resolveDispatchBackend (claude)", () => {
  it("returns claudeDispatch with the resolved claude model and chain", () => {
    const r = resolveDispatchBackend({
      flags: { backend: "claude" },
      phase: "implement",
      config: { models: { chain: [["opus"], ["sonnet"]] } },
    });
    assert.equal(r.backend, "claude");
    assert.equal(r.dispatch, claudeDispatch);
    assert.equal(r.model, "opus");
    assert.deepEqual(r.chain, [["opus"], ["sonnet"]]);
  });

  it("uses the claude-native default chain when there is no config", () => {
    const r = resolveDispatchBackend({ flags: { backend: "claude" }, phase: null, config: null });
    assert.equal(r.backend, "claude");
    assert.equal(r.model, "sonnet");
    assert.deepEqual(r.chain, CLAUDE_DEFAULT_CHAIN);
  });

  it("rejects an opencode-shaped models.chain at command start — before any job is dispatched", () => {
    assert.throws(
      () => resolveDispatchBackend({
        flags: { backend: "claude" },
        phase: "implement",
        config: { models: { chain: [["opencode/deepseek-v4-flash-free:max"]] } },
      }),
      /chain entry "opencode\/deepseek-v4-flash-free:max".*:variant/,
    );
  });

  it("--model is explicit: whole-chain validation is skipped (the chain is never consulted)", () => {
    const r = resolveDispatchBackend({
      flags: { backend: "claude", model: "opus" },
      phase: "implement",
      config: { models: { chain: [["sonnet"], ["opencode-go/deepseek-v4-pro:max"]] } },
    });
    assert.equal(r.backend, "claude");
    assert.equal(r.model, "opus");
    assert.deepEqual(r.chain, [["sonnet"], ["opencode-go/deepseek-v4-pro:max"]]);
  });

  it("--model haiku with an opencode-shaped models.chain resolves (kusabi #186)", () => {
    const r = resolveDispatchBackend({
      flags: { backend: "claude", model: "haiku" },
      phase: "implement",
      config: { models: { chain: ["opencode/deepseek-v4-flash-free:max"] } },
    });
    assert.equal(r.backend, "claude");
    assert.equal(r.model, "haiku");
    assert.deepEqual(r.chain, ["opencode/deepseek-v4-flash-free:max"]);
  });

  it("without --model, an opencode-shaped models.chain still throws at command start", () => {
    assert.throws(
      () => resolveDispatchBackend({
        flags: { backend: "claude" },
        phase: "implement",
        config: { models: { chain: ["opencode/deepseek-v4-flash-free:max"] } },
      }),
      /chain entry "opencode\/deepseek-v4-flash-free:max" is not a claude model/,
    );
  });

  it("--model opus:max with an opencode-shaped chain still fails fast on the :variant error", () => {
    assert.throws(
      () => resolveDispatchBackend({
        flags: { backend: "claude", model: "opus:max" },
        phase: "implement",
        config: { models: { chain: ["opencode/deepseek-v4-flash-free:max"] } },
      }),
      /:variant suffix in model "opus:max"/,
    );
  });
});
