// cursor-dispatch.test.mjs — tests for the Cursor CLI dispatch backend
// (kusabi #374).
//
// Spawn-based tests follow the agy-dispatch.test.mjs pattern: CURSOR_BIN
// points at a fake `cursor-agent` script in a temp dir, KUSABI_STATE_DIR
// points at a temp state root.  THE REAL `cursor-agent` BINARY IS NEVER
// REQUIRED.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import {
  CURSOR_BACKEND,
  CURSOR_DEFAULT_CHAIN,
  DEFAULT_CURSOR_MODEL,
  cursorBin,
  validateCursorModel,
  validateCursorChain,
  resolveCursorModel,
  cursorModelIsPinned,
  buildCursorArgs,
  assistantTextFromEvent,
  cursorPayload,
  mapCursorUsage,
  cursorDispatch,
  cursorToolNameFromEvent,
  initCursorStreamAccumulator,
  applyCursorStreamEvent,
} from "./cursor-dispatch.mjs";
import {
  BACKENDS,
  resolveBackend,
  backendDispatch,
  backendPinsModel,
  resolveDispatchBackend,
} from "./kusabi-companion.mjs";
import { splitRouteBackend, resolveModelBackend, backendSupportsResume } from "./cli.mjs";
import { stateDirFor } from "./state-paths.mjs";
import { loadJob, jobDir } from "./job-store.mjs";

const SESSION_ID = "92f5e07b-1111-2222-3333-444455556666";

const FAKE_CURSOR_SOURCE = `#!/usr/bin/env node
import fs from "node:fs";

const NL = String.fromCharCode(10);
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CURSOR_ARGS_LOG, JSON.stringify(argv) + NL);

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdin = Buffer.concat(chunks).toString("utf8");
fs.writeFileSync(process.env.FAKE_CURSOR_STDIN_LOG, stdin);

const mode = process.env.FAKE_CURSOR_MODE || "ok";
const session = "${SESSION_ID}";
const usage = {
  inputTokens: 10543,
  outputTokens: 34,
  cacheReadTokens: 5376,
  cacheWriteTokens: 0,
};

function emit(obj) {
  fs.writeSync(1, JSON.stringify({ session_id: session, ...obj }) + NL);
}

if (mode === "exit") {
  process.stderr.write("cursor-agent: crashed" + NL);
  process.exit(3);
}
if (mode === "no-result") {
  emit({ type: "thinking", subtype: "delta" });
  emit({ type: "assistant", message: { content: [{ type: "text", text: "almost" }] } });
  process.exit(0);
}
if (mode === "empty-result") {
  emit({ type: "thinking", subtype: "completed" });
  emit({ type: "assistant", message: { content: [{ type: "text", text: "" }] } });
  emit({ type: "result", subtype: "success", is_error: false, result: "", usage });
  process.exit(0);
}
if (mode === "is-error-payload") {
  emit({ type: "thinking", subtype: "delta" });
  emit({ type: "assistant", message: { content: [{ type: "text", text: "ALPHA-7" }] } });
  emit({ type: "result", subtype: "success", is_error: true, result: "ALPHA-7", usage });
  process.exit(0);
}
if (mode === "ok") {
  emit({ type: "thinking", subtype: "delta" });
  emit({ type: "thinking", subtype: "completed" });
  emit({ type: "assistant", message: { content: [{ type: "text", text: "ALPHA-7" }] } });
  emit({ type: "result", subtype: "success", is_error: false, result: "ALPHA-7", usage });
  process.exit(0);
}
if (mode === "tools") {
  emit({ type: "thinking", subtype: "delta" });
  emit({ type: "tool_call", subtype: "started", call_id: "call-1", tool_call: { readToolCall: { args: { path: "/tmp/x" } } } });
  emit({ type: "tool_call", subtype: "completed", call_id: "call-1", tool_call: { readToolCall: { result: {} } } });
  emit({ type: "connection", subtype: "reconnecting" });
  emit({ type: "retry", subtype: "starting" });
  emit({ type: "tool_call", subtype: "started", call_id: "call-2", tool_call: { mcpToolCall: { args: { name: "kaiba-agenda", args: {}, toolCallId: "x", providerIdentifier: "kaiba" } } } });
  emit({ type: "tool_call", subtype: "completed", call_id: "call-2", tool_call: { mcpToolCall: { args: { name: "kaiba-agenda" } } } });
  emit({ type: "tool_call", subtype: "completed", call_id: "call-3", tool_call: { getMcpToolsToolCall: { args: { server: "sunaba" } } } });
  emit({ type: "assistant", message: { content: [{ type: "text", text: "ALPHA-7" }] } });
  emit({ type: "result", subtype: "success", is_error: false, result: "ALPHA-7", usage });
  process.exit(0);
}
if (mode === "tools-nameless") {
  emit({ type: "tool_call", subtype: "started", call_id: "call-anon" });
  emit({ type: "tool_call", subtype: "completed", call_id: "call-anon" });
  emit({ type: "assistant", message: { content: [{ type: "text", text: "ALPHA-7" }] } });
  emit({ type: "result", subtype: "success", is_error: false, result: "ALPHA-7", usage });
  process.exit(0);
}
process.exit(0);
`;

function fakeCursorContext() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-cursor-test-"));
  const binPath = path.join(tmp, "fake-cursor-agent.mjs");
  const argsLog = path.join(tmp, "args.ndjson");
  const stdinLog = path.join(tmp, "stdin.txt");
  fs.writeFileSync(binPath, FAKE_CURSOR_SOURCE, "utf8");
  fs.chmodSync(binPath, 0o755);
  fs.writeFileSync(argsLog, "", "utf8");

  const stateRoot = path.join(tmp, "state");
  const cwd = path.join(tmp, "cwd");
  const fakeHome = path.join(tmp, "home");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(fakeHome, { recursive: true });

  const saved = {
    CURSOR_BIN: process.env.CURSOR_BIN,
    KUSABI_STATE_DIR: process.env.KUSABI_STATE_DIR,
    FAKE_CURSOR_MODE: process.env.FAKE_CURSOR_MODE,
    FAKE_CURSOR_ARGS_LOG: process.env.FAKE_CURSOR_ARGS_LOG,
    FAKE_CURSOR_STDIN_LOG: process.env.FAKE_CURSOR_STDIN_LOG,
    HOME: process.env.HOME,
  };
  process.env.CURSOR_BIN = binPath;
  process.env.KUSABI_STATE_DIR = stateRoot;
  process.env.FAKE_CURSOR_MODE = "ok";
  process.env.FAKE_CURSOR_ARGS_LOG = argsLog;
  process.env.FAKE_CURSOR_STDIN_LOG = stdinLog;
  process.env.HOME = fakeHome;

  const stateDir = stateDirFor(cwd);
  return {
    tmp,
    cwd,
    stateDir,
    argsLog,
    stdinLog,
    fakeHome,
    setMode(next) { process.env.FAKE_CURSOR_MODE = next; },
    dispatchOptions(overrides = {}) {
      return {
        cwd,
        kind: "task",
        title: "cursor dispatch test",
        promptText: "Say the token.",
        agent: null,
        phase: null,
        tools: null,
        timeoutS: 20,
        watchdogS: 900,
        tiers: [["default"]],
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
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function loggedArgs(argsLog) {
  const text = fs.readFileSync(argsLog, "utf8").trim();
  return text ? text.split("\n").map((l) => JSON.parse(l)) : [];
}

describe("cursorBin", () => {
  const saved = process.env.CURSOR_BIN;
  afterEach(() => {
    if (saved === undefined) delete process.env.CURSOR_BIN;
    else process.env.CURSOR_BIN = saved;
  });

  it("defaults to cursor-agent", () => {
    delete process.env.CURSOR_BIN;
    assert.equal(cursorBin(), "cursor-agent");
  });

  it("honours CURSOR_BIN", () => {
    process.env.CURSOR_BIN = "/tmp/fake-cursor-agent";
    assert.equal(cursorBin(), "/tmp/fake-cursor-agent");
  });
});

describe("validateCursorModel", () => {
  it("accepts any non-empty id, including the literal default", () => {
    for (const id of ["default", "composer-1.5", "gpt-5", "a-model-that-does-not-exist-yet"]) {
      assert.equal(validateCursorModel(id), id);
    }
  });

  it("treats absent/empty as null", () => {
    assert.equal(validateCursorModel(undefined), null);
    assert.equal(validateCursorModel(null), null);
    assert.equal(validateCursorModel(""), null);
  });

  it("rejects a :variant suffix, naming the offending model", () => {
    assert.throws(
      () => validateCursorModel("composer-1.5:fast"),
      /:variant suffix in model "composer-1.5:fast"/,
    );
  });
});

describe("validateCursorChain", () => {
  it("accepts a chain of plain ids including default", () => {
    const chain = [["default"], ["composer-1.5"]];
    assert.deepEqual(validateCursorChain(chain), chain);
  });

  it("rejects a :variant entry, naming it", () => {
    assert.throws(
      () => validateCursorChain([["default"], ["composer-1.5:fast"]]),
      /chain entry "composer-1.5:fast"/,
    );
  });
});

describe("resolveCursorModel", () => {
  it("falls back to the cursor-native default chain", () => {
    const r = resolveCursorModel({ config: null });
    assert.deepEqual(r.chain, CURSOR_DEFAULT_CHAIN);
    assert.equal(r.model, DEFAULT_CURSOR_MODEL);
  });

  it("the default chain is ONE tier of the literal default", () => {
    assert.deepEqual(CURSOR_DEFAULT_CHAIN, [["default"]]);
  });
});

describe("buildCursorArgs — the --model residue trap", () => {
  it("default (unpinned) argv has no --model", () => {
    assert.deepEqual(
      buildCursorArgs({ model: "default", pinned: false }),
      ["-p", "--approve-mcps", "--force", "--output-format", "stream-json"],
    );
  });

  it("pinned argv includes --model <id> exactly once", () => {
    assert.deepEqual(
      buildCursorArgs({ model: "composer-1.5", pinned: true }),
      ["-p", "--approve-mcps", "--force", "--output-format", "stream-json", "--model", "composer-1.5"],
    );
  });

  it("--resume <id> is present exactly when a session is passed", () => {
    const without = buildCursorArgs({ model: "default", pinned: false });
    assert.equal(without.includes("--resume"), false);
    const withResume = buildCursorArgs({
      model: "default",
      pinned: false,
      sessionId: SESSION_ID,
    });
    assert.deepEqual(
      withResume,
      ["-p", "--approve-mcps", "--force", "--output-format", "stream-json", "--resume", SESSION_ID],
    );
  });

  it("cursorModelIsPinned is false for default and true for a real id", () => {
    assert.equal(cursorModelIsPinned("default"), false);
    assert.equal(cursorModelIsPinned("composer-1.5"), true);
    assert.equal(cursorModelIsPinned(null), false);
  });
});

describe("parseCursorStreamLine / cursorPayload", () => {
  it("accumulates assistant text from message.content[].text", () => {
    const evt = {
      type: "assistant",
      message: { content: [{ type: "text", text: "ALPHA" }, { type: "text", text: "-7" }] },
    };
    assert.equal(assistantTextFromEvent(evt), "ALPHA-7");
  });

  it("payload presence decides success; is_error is advisory", () => {
    const ok = cursorPayload({
      type: "result",
      is_error: true,
      result: "ALPHA-7",
      session_id: SESSION_ID,
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.text, "ALPHA-7");
    assert.equal(ok.isError, true);
    assert.equal(ok.sessionId, SESSION_ID);

    const empty = cursorPayload({ type: "result", is_error: false, result: "" });
    assert.equal(empty.ok, false);
    assert.match(empty.error, /empty or missing `result`/);
  });

  it("mapCursorUsage uses the shared job-record shape", () => {
    const usage = mapCursorUsage({
      usage: { inputTokens: 10543, outputTokens: 34, cacheReadTokens: 5376, cacheWriteTokens: 0 },
    });
    assert.equal(usage.available, true);
    assert.equal(usage.input, 10543);
    assert.equal(usage.output, 34);
    assert.equal(usage.reasoning, 0);
    assert.equal(usage.cacheRead, 5376);
    assert.equal(usage.cacheWrite, 0);
    assert.equal(usage.total, 0);
    assert.equal(usage.cost, 0);
  });
});

describe("CLI argument layer", () => {
  it("--backend cursor is accepted and maps to cursorDispatch", () => {
    assert.equal(resolveBackend({ backend: "cursor" }), "cursor");
    assert.equal(backendDispatch("cursor"), cursorDispatch);
    assert.equal(backendPinsModel("cursor"), true);
  });

  it("cursor/<id> route entries split through the existing machinery", () => {
    assert.deepEqual(
      splitRouteBackend("cursor/composer-1.5"),
      { route: "composer-1.5", backend: "cursor" },
    );
    assert.deepEqual(
      resolveModelBackend("cursor/composer-1.5"),
      { backend: "cursor", model: "composer-1.5" },
    );
  });

  it("backendSupportsResume(\"cursor\") is true (measured 2026-08-23)", () => {
    assert.equal(backendSupportsResume("cursor"), true);
  });

  it("an unknown backend still errors naming the full list including cursor", () => {
    assert.throws(() => resolveBackend({ backend: "bogus" }), /unknown backend: bogus/);
    assert.throws(() => resolveBackend({ backend: "bogus" }), /Use --backend opencode\|claude\|agy\|cursor/);
  });

  it("cursor is a member of BACKENDS, not a special case beside it", () => {
    assert.deepEqual(BACKENDS, ["opencode", "claude", "agy", "cursor"]);
  });

  it("--backend cursor and --model cursor/<id> reach cursorDispatch", () => {
    const viaFlag = resolveDispatchBackend({
      flags: { backend: "cursor" },
      phase: "implement",
      config: {},
    });
    assert.equal(viaFlag.dispatch, cursorDispatch);
    assert.equal(viaFlag.backend, "cursor");
    assert.equal(viaFlag.model, "default");
    assert.equal(viaFlag.explicitModel, null);

    const viaModel = resolveDispatchBackend({
      flags: { model: "cursor/composer-1.5" },
      phase: "implement",
      config: {},
    });
    assert.equal(viaModel.dispatch, cursorDispatch);
    assert.equal(viaModel.backend, "cursor");
    assert.equal(viaModel.model, "composer-1.5");
    assert.equal(viaModel.explicitModel, "composer-1.5");
  });
});

describe("cursor stream stats from tool_call", () => {
  it("started+completed pair sharing one call_id counts as one step", () => {
    const acc = initCursorStreamAccumulator();
    applyCursorStreamEvent(acc, {
      type: "tool_call", subtype: "started", call_id: "call-1",
      tool_call: { readToolCall: { args: { path: "/tmp/x" } } },
    });
    applyCursorStreamEvent(acc, {
      type: "tool_call", subtype: "completed", call_id: "call-1",
      tool_call: { readToolCall: { result: {} } },
    });
    assert.equal(acc.steps, 1);
    assert.equal(acc.lastTool, "read");
    assert.equal(acc.events, 2);
  });

  it("a completed line whose started was never seen still counts (156-vs-162)", () => {
    const acc = initCursorStreamAccumulator();
    applyCursorStreamEvent(acc, {
      type: "tool_call", subtype: "completed", call_id: "call-only-completed",
      tool_call: { getMcpToolsToolCall: { args: { server: "sunaba" } } },
    });
    assert.equal(acc.steps, 1);
    assert.equal(acc.lastTool, "getMcpTools");
  });

  it("mcpToolCall reports args.name, not the stem mcp", () => {
    const acc = initCursorStreamAccumulator();
    applyCursorStreamEvent(acc, {
      type: "tool_call", subtype: "started", call_id: "call-mcp",
      tool_call: {
        mcpToolCall: {
          args: { name: "kaiba-agenda", args: {}, toolCallId: "x", providerIdentifier: "kaiba" },
        },
      },
    });
    assert.equal(acc.lastTool, "kaiba-agenda");
    assert.notEqual(acc.lastTool, "mcp");
    assert.equal(
      cursorToolNameFromEvent({
        type: "tool_call",
        tool_call: { mcpToolCall: { args: { name: "kaiba-agenda" } } },
      }),
      "kaiba-agenda",
    );
  });

  it("lastTool follows the most recent named tool_call", () => {
    const acc = initCursorStreamAccumulator();
    applyCursorStreamEvent(acc, {
      type: "tool_call", subtype: "started", call_id: "call-1",
      tool_call: { readToolCall: { args: { path: "/tmp/x" } } },
    });
    applyCursorStreamEvent(acc, {
      type: "tool_call", subtype: "completed", call_id: "call-1",
      tool_call: { readToolCall: { result: {} } },
    });
    applyCursorStreamEvent(acc, {
      type: "tool_call", subtype: "started", call_id: "call-2",
      tool_call: { mcpToolCall: { args: { name: "kaiba-agenda" } } },
    });
    applyCursorStreamEvent(acc, {
      type: "tool_call", subtype: "completed", call_id: "call-2",
      tool_call: { mcpToolCall: { args: { name: "kaiba-agenda" } } },
    });
    assert.equal(acc.steps, 2);
    assert.equal(acc.lastTool, "kaiba-agenda");
  });

  it("tool_call with no recognisable name still counts a step; lastTool stays null", () => {
    const acc = initCursorStreamAccumulator();
    applyCursorStreamEvent(acc, { type: "tool_call", subtype: "started", call_id: "call-a" });
    applyCursorStreamEvent(acc, { type: "tool_call", subtype: "completed", call_id: "call-a" });
    applyCursorStreamEvent(acc, {
      type: "tool_call", subtype: "started", call_id: "call-b",
      tool_call: { args: {} },
    });
    assert.equal(acc.steps, 2);
    assert.equal(acc.lastTool, null);
    assert.equal(cursorToolNameFromEvent({ type: "tool_call", subtype: "started" }), null);
  });

  it("missing call_id falls back to counting started, not completed", () => {
    const acc = initCursorStreamAccumulator();
    applyCursorStreamEvent(acc, {
      type: "tool_call", subtype: "started",
      tool_call: { readToolCall: { args: { path: "/tmp/x" } } },
    });
    applyCursorStreamEvent(acc, {
      type: "tool_call", subtype: "completed",
      tool_call: { readToolCall: { result: {} } },
    });
    assert.equal(acc.steps, 1);
  });

  it("connection and retry lines do not throw and do not count as steps", () => {
    const acc = initCursorStreamAccumulator();
    applyCursorStreamEvent(acc, { type: "connection", subtype: "reconnecting" });
    applyCursorStreamEvent(acc, { type: "retry", subtype: "starting" });
    applyCursorStreamEvent(acc, { type: "system", subtype: "init" });
    applyCursorStreamEvent(acc, { type: "user" });
    assert.equal(acc.steps, 0);
    assert.equal(acc.lastTool, null);
    assert.equal(acc.events, 4);
  });
});

describe("cursorDispatch (fake cursor-agent)", () => {
  let ctx;
  beforeEach(() => { ctx = fakeCursorContext(); });
  afterEach(() => { ctx.restore(); });

  it("happy path: returns result text, usage, and session id", async () => {
    const { job, resultText, stateDir } = await cursorDispatch(ctx.dispatchOptions());
    assert.equal(job.status, "completed");
    assert.equal(job.backend, CURSOR_BACKEND);
    assert.equal(job.modelEntry, "default");
    assert.equal(resultText, "ALPHA-7");
    assert.equal(job.sessionID, SESSION_ID);
    assert.equal(job.usage.available, true);
    assert.equal(job.usage.input, 10543);
    assert.equal(job.usage.output, 34);
    assert.equal(job.usage.cacheRead, 5376);
    assert.equal(job.usage.cacheWrite, 0);
    assert.equal(job.cursorIsError, false);
    assert.equal(job.modelResidueHazard, null);
    assert.equal(stateDir, ctx.stateDir);

    const persisted = loadJob(stateDir, job.id);
    assert.equal(persisted.sessionID, SESSION_ID);
    assert.equal(fs.readFileSync(path.join(jobDir(stateDir, job.id), "result.md"), "utf8"), "ALPHA-7");
  });

  it("prompt reaches the child on stdin, not argv", async () => {
    await cursorDispatch(ctx.dispatchOptions({ promptText: "SECRET-PROMPT-TOKEN" }));
    const argv = loggedArgs(ctx.argsLog)[0];
    assert.equal(argv.includes("SECRET-PROMPT-TOKEN"), false);
    const stdin = fs.readFileSync(ctx.stdinLog, "utf8");
    assert.match(stdin, /SECRET-PROMPT-TOKEN/);
  });

  it("--model is absent by default and present exactly when pinned", async () => {
    await cursorDispatch(ctx.dispatchOptions());
    const def = loggedArgs(ctx.argsLog)[0];
    assert.equal(def.includes("--model"), false);
    assert.deepEqual(def, ["-p", "--approve-mcps", "--force", "--output-format", "stream-json"]);

    fs.writeFileSync(ctx.argsLog, "", "utf8");
    await cursorDispatch(ctx.dispatchOptions({ explicitModel: "composer-1.5" }));
    const pinned = loggedArgs(ctx.argsLog)[0];
    assert.equal(pinned.includes("--model"), true);
    assert.equal(pinned[pinned.indexOf("--model") + 1], "composer-1.5");
    const { job } = await cursorDispatch(ctx.dispatchOptions({ explicitModel: "composer-1.5" }));
    assert.match(job.modelResidueHazard, /cli-config\.json/);
  });

  it("--resume <id> is present exactly when a session is passed", async () => {
    await cursorDispatch(ctx.dispatchOptions());
    assert.equal(loggedArgs(ctx.argsLog)[0].includes("--resume"), false);

    fs.writeFileSync(ctx.argsLog, "", "utf8");
    await cursorDispatch(ctx.dispatchOptions({ session: SESSION_ID }));
    const argv = loggedArgs(ctx.argsLog)[0];
    const idx = argv.indexOf("--resume");
    assert.ok(idx >= 0);
    assert.equal(argv[idx + 1], SESSION_ID);
  });

  it("missing terminal line / empty result / non-zero exit are distinguishable failures", async () => {
    ctx.setMode("no-result");
    const missing = await cursorDispatch(ctx.dispatchOptions());
    assert.equal(missing.job.status, "error");
    assert.match(missing.job.error, /no terminal result line/);

    ctx.setMode("empty-result");
    const empty = await cursorDispatch(ctx.dispatchOptions());
    assert.equal(empty.job.status, "error");
    assert.match(empty.job.error, /empty or missing `result`/);

    ctx.setMode("exit");
    const exited = await cursorDispatch(ctx.dispatchOptions());
    assert.equal(exited.job.status, "error");
    assert.match(exited.job.error, /exited with code 3/);
  });

  it("is_error true with a non-empty result is NOT discarded; the flag is recorded", async () => {
    ctx.setMode("is-error-payload");
    const { job, resultText } = await cursorDispatch(ctx.dispatchOptions());
    assert.equal(job.status, "completed");
    assert.equal(resultText, "ALPHA-7");
    assert.equal(job.cursorIsError, true);
  });

  it("records unenforced tool denies rather than pretending they hold", async () => {
    const { job } = await cursorDispatch(ctx.dispatchOptions({
      tools: { bash: false, write: false, read: true },
    }));
    assert.deepEqual(job.toolDeniesUnenforced, ["bash", "write"]);
  });

  it("never writes under ~/.cursor/ (HOME is a temp dir in this test)", async () => {
    await cursorDispatch(ctx.dispatchOptions({ explicitModel: "composer-1.5" }));
    const cursorDir = path.join(ctx.fakeHome, ".cursor");
    assert.equal(fs.existsSync(cursorDir), false);
  });

  it("tool_call started+completed pairs fill stats.steps once and lastTool with the most recent name", async () => {
    ctx.setMode("tools");
    const { job } = await cursorDispatch(ctx.dispatchOptions());
    assert.equal(job.status, "completed");
    assert.equal(job.stats.steps, 3);
    assert.equal(job.stats.lastTool, "getMcpTools");
    const persisted = loadJob(ctx.stateDir, job.id);
    assert.equal(persisted.stats.steps, 3);
    assert.equal(persisted.stats.lastTool, "getMcpTools");
  });

  it("nameless tool_call lines still count steps and leave lastTool null", async () => {
    ctx.setMode("tools-nameless");
    const { job } = await cursorDispatch(ctx.dispatchOptions());
    assert.equal(job.status, "completed");
    assert.equal(job.stats.steps, 1);
    assert.equal(job.stats.lastTool, null);
  });
});
