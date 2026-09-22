// codex-dispatch.test.mjs — tests for the Codex CLI dispatch backend
// (kusabi #527).
//
// Spawn-based tests follow the cursor-dispatch.test.mjs pattern: CODEX_BIN
// points at a fake `codex` script in a temp dir, KUSABI_STATE_DIR points at
// a temp state root.  THE REAL `codex` BINARY IS NEVER REQUIRED.
//
// The fake also WRITES the rollout the provenance verifier reads
// ($CODEX_HOME/sessions/<thread>/rollout-*.jsonl), records the child's
// HOME/CODEX_HOME env, and logs the argv + stdin, so the exact fresh/resume
// invocation shape, the dedicated job-owned state, and the post-close
// provenance cross-check are all asserted against the fake's own records.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import {
  CODEX_BACKEND,
  CODEX_DEFAULT_CHAIN,
  CODEX_SUPPORTED_MODELS,
  CODEX_REASONING_EFFORT,
  CODEX_SANDBOX_POLICY,
  codexBin,
  validateCodexModel,
  validateCodexChain,
  resolveCodexModel,
  buildCodexArgs,
  codexJsonSchemaFor,
  parseCodexStreamLine,
  codexThreadIdFromEvent,
  codexAssistantTextFromEvent,
  initCodexStreamAccumulator,
  applyCodexStreamEvent,
  mapCodexUsage,
  codexHomeForJob,
  linkOperatorAuth,
  parseRolloutProvenance,
  verifyRolloutProvenance,
  readRolloutProvenance,
  assertNoCodexSession,
  codexDispatch,
} from "./codex-dispatch.mjs";
import {
  BACKENDS,
  resolveBackend,
  backendDispatch,
  backendPinsModel,
  resolveDispatchBackend,
  resolveResumeLastSession,
} from "./kusabi-companion.mjs";
import { splitRouteBackend, resolveModelBackend, backendSupportsResume, WRITE_TOOL_NAMES, implementDenyTools, reviewDenyTools } from "./cli.mjs";
import { renderHeader } from "./render.mjs";
import { stateDirFor } from "./state-paths.mjs";
import { loadJob, jobDir, listJobs } from "./job-store.mjs";
import { stopRecordedProcess } from "./claude-dispatch.mjs";

const THREAD_ID = "thread-527-9f3c2a1b";
const MODEL = "gpt-5.6-sol";
const OTHER_MODEL = "gpt-5.6-luna";

// ---------------------------------------------------------------------------
// the fake `codex` binary
// ---------------------------------------------------------------------------
// Placeholders __MODEL_OK__ / __THREAD_ID__ / __MISMATCH_MODEL__ are
// substituted per context so the rollout the fake writes records the model
// the test actually requested.  The fake body deliberately uses NO template
// literals and NO `${...}`, so this outer template literal interpolates
// nothing by accident.

const FAKE_CODEX_TEMPLATE = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const NL = String.fromCharCode(10);
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CODEX_ARGS_LOG, JSON.stringify(argv) + NL);

let homeContents = [];
try {
  homeContents = fs.readdirSync(process.env.CODEX_HOME);
} catch (e) {
  homeContents = ["<unreadable>"];
}
fs.writeFileSync(process.env.FAKE_CODEX_ENV_LOG, JSON.stringify({
  HOME: process.env.HOME,
  CODEX_HOME: process.env.CODEX_HOME,
  KUSABI_WORKER_CONTEXT: process.env.KUSABI_WORKER_CONTEXT ?? null,
  codexHomeContents: homeContents,
}) + NL);

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdin = Buffer.concat(chunks).toString("utf8");
fs.writeFileSync(process.env.FAKE_CODEX_STDIN_LOG, stdin);

const mode = process.env.FAKE_CODEX_MODE || "ok";
const thread = "__THREAD_ID__";
const model = "__MODEL_OK__";

function emit(obj) {
  fs.writeSync(1, JSON.stringify(obj) + NL);
}

function writeRollout(actualModel, effort) {
  const dir = path.join(process.env.CODEX_HOME, "sessions", thread);
  fs.mkdirSync(dir, { recursive: true });
  const recs = [
    { timestamp: new Date().toISOString(), type: "session_meta", payload: { id: thread, cwd: process.cwd(), model: actualModel, model_reasoning_effort: effort, approval_policy: "never", sandbox_policy: "read-only", network_policy: "restricted" } },
    { timestamp: new Date().toISOString(), type: "turn_context", payload: { turn_id: "turn-1", model: actualModel } },
  ];
  const body = recs.map(function (r) { return JSON.stringify(r); }).join(NL) + NL;
  fs.writeFileSync(path.join(dir, "rollout-1.jsonl"), body);
}

function writeResumeRollout(originalModel, resumedModel, resumedEffort) {
  const dir = path.join(process.env.CODEX_HOME, "sessions", thread);
  fs.mkdirSync(dir, { recursive: true });
  // A resumed thread's rollout holds the ORIGINAL session's records (the
  // session_meta and its matching turn-1) followed by the resumed
  // invocation's turn_context (turn-2) — no new session_meta, because the
  // resumed run continues the SAME thread/session.  The provenance verifier
  // must bind to the resumed turn's evidence, never to the stale matching
  // original turn or the original session_meta.
  const recs = [
    { timestamp: new Date().toISOString(), type: "session_meta", payload: { id: thread, cwd: process.cwd(), model: originalModel, model_reasoning_effort: "high", approval_policy: "never", sandbox_policy: "read-only", network_policy: "restricted" } },
    { timestamp: new Date().toISOString(), type: "turn_context", payload: { turn_id: "turn-1", model: originalModel } },
    { timestamp: new Date().toISOString(), type: "turn_context", payload: { turn_id: "turn-2", model: resumedModel, model_reasoning_effort: resumedEffort } },
  ];
  const body = recs.map(function (r) { return JSON.stringify(r); }).join(NL) + NL;
  fs.writeFileSync(path.join(dir, "rollout-1.jsonl"), body);
}

const usage = { input_tokens: 10543, cached_input_tokens: 5376, cache_write_input_tokens: 0, output_tokens: 34 };

if (mode === "exit") {
  process.stderr.write("codex: crashed" + NL);
  process.exit(3);
} else if (mode === "sleep") {
  writeRollout(model, "high");
  emit({ type: "thread.started", thread_id: thread });
  setTimeout(function () { process.exit(0); }, 15000);
} else if (mode === "no-result") {
  writeRollout(model, "high");
  emit({ type: "thread.started", thread_id: thread });
  emit({ type: "turn.started", turn_id: "turn-1" });
  emit({ type: "turn.completed", usage: {} });
  process.exit(0);
} else if (mode === "empty-result") {
  writeRollout(model, "high");
  emit({ type: "thread.started", thread_id: thread });
  emit({ type: "item.completed", item: { agent_message: { text: "" } } });
  process.exit(0);
} else if (mode === "malformed") {
  writeRollout(model, "high");
  fs.writeSync(1, "this is not json" + NL);
  fs.writeSync(1, "{\\"type\\":\\"thread.started\\"" + NL);
  process.exit(0);
} else if (mode === "mismatch-model") {
  writeRollout("__MISMATCH_MODEL__", "high");
  emit({ type: "thread.started", thread_id: thread });
  emit({ type: "item.completed", item: { agent_message: { text: "ALPHA-7" } } });
  process.exit(0);
} else if (mode === "mismatch-effort") {
  writeRollout(model, "low");
  emit({ type: "thread.started", thread_id: thread });
  emit({ type: "item.completed", item: { agent_message: { text: "ALPHA-7" } } });
  process.exit(0);
} else if (mode === "resume-no-thread") {
  // A resumed invocation whose stream omits a fresh thread.started event:
  // the CLI continues the known thread silently.  Matching resumed-turn
  // evidence in the rollout; the known thread id must still be recorded.
  writeResumeRollout(model, model, "high");
  emit({ type: "turn.started", turn_id: "turn-2" });
  emit({ type: "item.completed", item: { agent_message: { text: "ALPHA" } } });
  emit({ type: "item.completed", item: { agent_message: { text: "-7" } } });
  emit({ type: "turn.completed", usage: usage });
  process.exit(0);
} else if (mode === "resume-mismatch-model") {
  writeResumeRollout(model, "__MISMATCH_MODEL__", "high");
  emit({ type: "turn.started", turn_id: "turn-2" });
  emit({ type: "item.completed", item: { agent_message: { text: "ALPHA-7" } } });
  emit({ type: "turn.completed", usage: usage });
  process.exit(0);
} else if (mode === "resume-mismatch-effort") {
  writeResumeRollout(model, model, "low");
  emit({ type: "turn.started", turn_id: "turn-2" });
  emit({ type: "item.completed", item: { agent_message: { text: "ALPHA-7" } } });
  emit({ type: "turn.completed", usage: usage });
  process.exit(0);
} else if (mode === "no-rollout") {
  emit({ type: "thread.started", thread_id: thread });
  emit({ type: "item.completed", item: { agent_message: { text: "ALPHA-7" } } });
  process.exit(0);
} else if (mode === "schema") {
  writeRollout(model, "high");
  emit({ type: "thread.started", thread_id: thread });
  emit({ type: "item.completed", item: { agent_message: { text: "{\\"verdict\\":\\"approve\\"}" } } });
  emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
  process.exit(0);
} else if (mode === "flat") {
  writeRollout(model, "high");
  emit({ type: "thread.started", thread_id: thread });
  emit({ type: "turn.started", turn_id: "turn-1" });
  emit({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ action: "read_probe", envelope_sha256: "deadbeef", tool: "read_file_range", path: "evidence/probes.json" }) } });
  emit({ type: "item.completed", item: { type: "tool_call", id: "t1", input: {} } });
  emit({ type: "turn.completed", usage: usage });
  process.exit(0);
} else {
writeRollout(model, "high");
emit({ type: "thread.started", thread_id: thread });
emit({ type: "turn.started", turn_id: "turn-1" });
emit({ type: "item.completed", item: { agent_message: { text: "ALPHA" } } });
emit({ type: "item.completed", item: { agent_message: { text: "-7" } } });
emit({ type: "turn.completed", usage: usage });
process.exit(0);
}
`;

function fakeCodexContext({ model = MODEL, thread = THREAD_ID, mismatchModel = OTHER_MODEL } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-codex-test-"));
  const binPath = path.join(tmp, "fake-codex.mjs");
  const argsLog = path.join(tmp, "args.ndjson");
  const envLog = path.join(tmp, "env.ndjson");
  const stdinLog = path.join(tmp, "stdin.txt");
  fs.writeFileSync(
    binPath,
    FAKE_CODEX_TEMPLATE
      .replaceAll("__MODEL_OK__", model)
      .replaceAll("__THREAD_ID__", thread)
      .replaceAll("__MISMATCH_MODEL__", mismatchModel),
    "utf8",
  );
  fs.chmodSync(binPath, 0o755);
  fs.writeFileSync(argsLog, "", "utf8");
  fs.writeFileSync(envLog, "", "utf8");

  const stateRoot = path.join(tmp, "state");
  const cwd = path.join(tmp, "cwd");
  const fakeHome = path.join(tmp, "home");
  const operatorCodexHome = path.join(tmp, "operator-codex-home");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(operatorCodexHome, { recursive: true });

  const saved = {
    CODEX_BIN: process.env.CODEX_BIN,
    KUSABI_STATE_DIR: process.env.KUSABI_STATE_DIR,
    FAKE_CODEX_MODE: process.env.FAKE_CODEX_MODE,
    FAKE_CODEX_ARGS_LOG: process.env.FAKE_CODEX_ARGS_LOG,
    FAKE_CODEX_ENV_LOG: process.env.FAKE_CODEX_ENV_LOG,
    FAKE_CODEX_STDIN_LOG: process.env.FAKE_CODEX_STDIN_LOG,
    HOME: process.env.HOME,
    CODEX_HOME: process.env.CODEX_HOME,
  };
  process.env.CODEX_BIN = binPath;
  process.env.KUSABI_STATE_DIR = stateRoot;
  process.env.FAKE_CODEX_MODE = "ok";
  process.env.FAKE_CODEX_ARGS_LOG = argsLog;
  process.env.FAKE_CODEX_ENV_LOG = envLog;
  process.env.FAKE_CODEX_STDIN_LOG = stdinLog;
  process.env.HOME = fakeHome;
  process.env.CODEX_HOME = operatorCodexHome;

  const stateDir = stateDirFor(cwd);
  return {
    tmp,
    cwd,
    stateDir,
    argsLog,
    envLog,
    stdinLog,
    fakeHome,
    operatorCodexHome,
    setMode(next) { process.env.FAKE_CODEX_MODE = next; },
    dispatchOptions(overrides = {}) {
      return {
        cwd,
        kind: "task",
        title: "codex dispatch test",
        promptText: "Say the token.",
        agent: null,
        phase: null,
        tools: null,
        timeoutS: 20,
        watchdogS: 900,
        tiers: [["gpt-5.6-luna", "gpt-5.6-sol"]],
        round: 1,
        explicitModel: MODEL,
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

function loggedEnv(envLog) {
  const text = fs.readFileSync(envLog, "utf8").trim();
  return text ? JSON.parse(text.split("\n").pop()) : null;
}

function jobCodexHome(ctx, job) {
  return path.join(jobDir(ctx.stateDir, job.id), "codex-home");
}

describe("codexBin", () => {
  const saved = process.env.CODEX_BIN;
  afterEach(() => {
    if (saved === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = saved;
  });

  it("defaults to codex", () => {
    delete process.env.CODEX_BIN;
    assert.equal(codexBin(), "codex");
  });

  it("honours CODEX_BIN", () => {
    process.env.CODEX_BIN = "/tmp/fake-codex";
    assert.equal(codexBin(), "/tmp/fake-codex");
  });
});

describe("validateCodexModel", () => {
  it("accepts exactly the supported seat ids", () => {
    assert.deepEqual(CODEX_SUPPORTED_MODELS, ["gpt-5.6-luna", "gpt-5.6-sol"]);
    for (const id of CODEX_SUPPORTED_MODELS) {
      assert.equal(validateCodexModel(id), id);
    }
  });

  it("treats absent/empty as null", () => {
    assert.equal(validateCodexModel(undefined), null);
    assert.equal(validateCodexModel(null), null);
    assert.equal(validateCodexModel(""), null);
  });

  it("rejects a :variant suffix, naming the offending model", () => {
    assert.throws(
      () => validateCodexModel("gpt-5.6-sol:fast"),
      /:variant suffix in model "gpt-5.6-sol:fast"/,
    );
  });

  it("rejects an unsupported model id (v1 executes the exact seats only)", () => {
    assert.throws(
      () => validateCodexModel("gpt-5.7-future"),
      /does not support model "gpt-5.7-future"/,
    );
  });
});

describe("validateCodexChain", () => {
  it("accepts a chain of exact seat ids", () => {
    const chain = [["gpt-5.6-luna"], ["gpt-5.6-sol"]];
    assert.deepEqual(validateCodexChain(chain), chain);
  });

  it("rejects a :variant or unknown entry, naming it", () => {
    assert.throws(
      () => validateCodexChain([["gpt-5.6-luna:max"]]),
      /chain entry "gpt-5.6-luna:max"/,
    );
    assert.throws(
      () => validateCodexChain([["gpt-5.7-future"]]),
      /chain entry "gpt-5.7-future"/,
    );
  });
});

describe("resolveCodexModel", () => {
  it("falls back to the codex-native default chain of exact seat ids", () => {
    const r = resolveCodexModel({ config: null });
    assert.deepEqual(r.chain, CODEX_DEFAULT_CHAIN);
    assert.equal(r.model, "gpt-5.6-luna");
  });

  it("the default chain is ONE tier holding the exact seat ids", () => {
    assert.deepEqual(CODEX_DEFAULT_CHAIN, [["gpt-5.6-luna", "gpt-5.6-sol"]]);
  });
});

describe("buildCodexArgs — the measured fresh/resume contract", () => {
  it("fresh argv is byte-exact: exec + isolation flags + read-only sandbox + --json + -m + effort + empty mcp + stdin marker", () => {
    assert.deepEqual(
      buildCodexArgs({ model: "gpt-5.6-sol", cwd: "/repo", sessionId: null, jsonSchema: null }),
      [
        "exec",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "-C", "/repo",
        "-s", "read-only",
        "--json",
        "-m", "gpt-5.6-sol",
        "-c", 'model_reasoning_effort="high"',
        "-c", "mcp_servers={}",
        "-",
      ],
    );
  });

  it("resume argv is byte-exact: exec resume <thread> + config-carried sandbox/approval, no -s, no -a", () => {
    const argv = buildCodexArgs({ model: "gpt-5.6-sol", cwd: "/repo", sessionId: THREAD_ID, jsonSchema: null });
    assert.deepEqual(argv, [
      "exec", "resume", THREAD_ID,
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "-C", "/repo",
      "-m", "gpt-5.6-sol",
      "-c", 'model_reasoning_effort="high"',
      "-c", "mcp_servers={}",
      "-c", 'sandbox_mode="read-only"',
      "-c", 'approval_policy="never"',
      "--json",
      "-",
    ]);
    assert.equal(argv.includes("-s"), false, "resume has no --sandbox flag");
    assert.equal(argv.includes("-a"), false, "-a is never passed to codex exec");
  });

  it("--output-schema rides argv only when a schema is supplied, before the stdin marker", () => {
    const schema = '{"type":"object"}';
    const withSchema = buildCodexArgs({ model: "gpt-5.6-sol", cwd: "/repo", sessionId: null, jsonSchema: schema });
    const idx = withSchema.indexOf("--output-schema");
    assert.ok(idx >= 0);
    assert.equal(withSchema[idx + 1], schema);
    assert.equal(withSchema[withSchema.length - 1], "-");
    const without = buildCodexArgs({ model: "gpt-5.6-sol", cwd: "/repo", sessionId: null, jsonSchema: null });
    assert.equal(without.includes("--output-schema"), false);
  });

  it("--ephemeral is NEVER passed (persistence of the rollout/session is required)", () => {
    for (const argv of [
      buildCodexArgs({ model: "gpt-5.6-sol", cwd: "/repo", sessionId: null, jsonSchema: null }),
      buildCodexArgs({ model: "gpt-5.6-sol", cwd: "/repo", sessionId: THREAD_ID, jsonSchema: null }),
    ]) {
      assert.equal(argv.includes("--ephemeral"), false);
    }
  });

  it("the reasoning effort config is exactly high on both shapes", () => {
    const fresh = buildCodexArgs({ model: "gpt-5.6-luna", cwd: "/repo", sessionId: null, jsonSchema: null });
    const resume = buildCodexArgs({ model: "gpt-5.6-luna", cwd: "/repo", sessionId: THREAD_ID, jsonSchema: null });
    assert.ok(fresh.includes(`model_reasoning_effort="${CODEX_REASONING_EFFORT}"`));
    assert.ok(resume.includes(`model_reasoning_effort="${CODEX_REASONING_EFFORT}"`));
    assert.equal(CODEX_REASONING_EFFORT, "high");
    assert.equal(CODEX_SANDBOX_POLICY, "read-only");
  });
});

describe("codex stream parsing", () => {
  it("parseCodexStreamLine tolerates blank lines and non-JSON prose", () => {
    assert.equal(parseCodexStreamLine(""), null);
    assert.equal(parseCodexStreamLine("  "), null);
    assert.equal(parseCodexStreamLine("just some prose"), null);
    assert.equal(parseCodexStreamLine('{"type":"thread.started"'), null);
    const parsed = parseCodexStreamLine('{"type":"turn.started"}');
    assert.equal(parsed.type, "turn.started");
  });

  it("extracts the thread id from thread.started", () => {
    assert.equal(codexThreadIdFromEvent({ type: "thread.started", thread_id: THREAD_ID }), THREAD_ID);
    assert.equal(codexThreadIdFromEvent({ type: "turn.started" }), null);
  });

  it("extracts assistant text from item.completed.item.agent_message.text", () => {
    assert.equal(
      codexAssistantTextFromEvent({ type: "item.completed", item: { agent_message: { text: "ALPHA-7" } } }),
      "ALPHA-7",
    );
    assert.equal(codexAssistantTextFromEvent({ type: "item.completed", item: {} }), "");
  });

  it("extracts assistant text from the CURRENT flat item.completed shape and keeps the legacy nested shape", () => {
    // The live Codex CLI event shape (incident mission-mucn5qb2a76e2095):
    // item.type === "agent_message" with the terminal text on item.text.
    assert.equal(
      codexAssistantTextFromEvent({ type: "item.completed", item: { type: "agent_message", text: "ALPHA-7" } }),
      "ALPHA-7",
    );
    // The previously measured nested shape remains part of the contract.
    assert.equal(
      codexAssistantTextFromEvent({ type: "item.completed", item: { agent_message: { text: "ALPHA-7" } } }),
      "ALPHA-7",
    );
    // Non-agent items never contribute text.
    assert.equal(codexAssistantTextFromEvent({ type: "item.completed", item: { type: "tool_call", id: "t1" } }), "");
    assert.equal(codexAssistantTextFromEvent({ type: "item.completed", item: {} }), "");
  });

  it("non-agent item.completed events contribute no assistant text; malformed shapes stay non-throwing", () => {
    const acc = initCodexStreamAccumulator();
    applyCodexStreamEvent(acc, { type: "item.completed", item: { type: "tool_call", id: "t1" } });
    applyCodexStreamEvent(acc, { type: "item.completed", item: { type: "agent_message", text: "ALPHA" } });
    applyCodexStreamEvent(acc, { type: "item.completed", item: { type: "custom_tool_call", id: "t2" } });
    assert.equal(acc.steps, 3, "every completed item still counts as one step");
    assert.equal(acc.assistantText, "ALPHA", "only the flat agent_message item contributes text");
    assert.doesNotThrow(() => applyCodexStreamEvent(acc, { type: "item.completed", item: null }));
    assert.doesNotThrow(() => applyCodexStreamEvent(acc, { type: "item.completed", item: { type: "agent_message", text: 42 } }));
  });

  it("fold accumulates thread id, assistant text (both framings), steps, and usage", () => {
    const acc = initCodexStreamAccumulator();
    applyCodexStreamEvent(acc, { type: "thread.started", thread_id: THREAD_ID });
    applyCodexStreamEvent(acc, { type: "turn.started", turn_id: "turn-1" });
    applyCodexStreamEvent(acc, { type: "item.completed", item: { agent_message: { text: "ALPHA" } } });
    applyCodexStreamEvent(acc, { type: "item.completed", item: { agent_message: { text: "-7" } } });
    applyCodexStreamEvent(acc, {
      type: "turn.completed",
      usage: { input_tokens: 10543, cached_input_tokens: 5376, cache_write_input_tokens: 0, output_tokens: 34 },
    });
    assert.equal(acc.threadId, THREAD_ID);
    assert.equal(acc.assistantText, "ALPHA-7");
    assert.equal(acc.steps, 2);
    assert.equal(acc.events, 5);
    assert.equal(acc.usageEvent.type, "turn.completed");
  });

  it("malformed events never throw", () => {
    const acc = initCodexStreamAccumulator();
    assert.doesNotThrow(() => applyCodexStreamEvent(acc, null));
    assert.doesNotThrow(() => applyCodexStreamEvent(acc, { type: "item.completed", item: "not-an-object" }));
    assert.doesNotThrow(() => applyCodexStreamEvent(acc, "string"));
    assert.equal(acc.events, 1);
  });

  it("mapCodexUsage maps ALL measured snake-case token fields", () => {
    const usage = mapCodexUsage({
      usage: { input_tokens: 10543, cached_input_tokens: 5376, cache_write_input_tokens: 0, output_tokens: 34 },
    });
    assert.equal(usage.available, true);
    assert.equal(usage.input, 10543);
    assert.equal(usage.output, 34);
    assert.equal(usage.reasoning, 0);
    assert.equal(usage.cacheRead, 5376);
    assert.equal(usage.cacheWrite, 0);
    assert.equal(usage.total, 10543 + 5376 + 34);
    assert.equal(usage.cost, 0);
  });
});

describe("dedicated state and auth bridge", () => {
  it("codexHomeForJob is a job-owned directory under the job record", () => {
    assert.equal(
      codexHomeForJob("/state", "job-abc"),
      path.join("/state", "jobs", "job-abc", "codex-home"),
    );
  });

  it("linkOperatorAuth symlinks the operator auth cache and never copies contents", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-codex-auth-"));
    const saved = process.env.CODEX_HOME;
    try {
      const operatorHome = path.join(tmp, "op");
      const jobHome = path.join(tmp, "job");
      fs.mkdirSync(operatorHome, { recursive: true });
      fs.writeFileSync(path.join(operatorHome, "auth.json"), "SECRET-TOKEN-MATERIAL", "utf8");
      process.env.CODEX_HOME = operatorHome;
      const outcome = linkOperatorAuth(jobHome);
      assert.equal(outcome.bridge, "symlinked");
      const link = fs.readlinkSync(path.join(jobHome, "auth.json"));
      assert.equal(link, path.join(operatorHome, "auth.json"));
      // The bridge is a symlink: the job dir never contains the contents.
      const files = [];
      const walk = (dir) => {
        for (const name of fs.readdirSync(dir)) {
          const full = path.join(dir, name);
          const st = fs.lstatSync(full);
          if (st.isDirectory()) walk(full);
          else if (st.isSymbolicLink()) files.push(`link:${fs.readlinkSync(full)}`);
          else files.push(fs.readFileSync(full, "utf8"));
        }
      };
      walk(jobHome);
      assert.equal(files.some((f) => typeof f === "string" && f.includes("SECRET-TOKEN-MATERIAL")), false);
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("linkOperatorAuth is a silent no-op when the operator has no auth file", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-codex-auth-none-"));
    const saved = process.env.CODEX_HOME;
    try {
      const operatorHome = path.join(tmp, "op");
      fs.mkdirSync(operatorHome, { recursive: true });
      process.env.CODEX_HOME = operatorHome;
      const outcome = linkOperatorAuth(path.join(tmp, "job"));
      assert.equal(outcome.bridge, "none");
      assert.equal(fs.existsSync(path.join(tmp, "job", "auth.json")), false);
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("rollout provenance verification", () => {
  const SESSION_META = (over) => ({
    timestamp: "2026-09-20T00:00:00.000Z",
    type: "session_meta",
    payload: {
      id: THREAD_ID,
      cwd: "/repo",
      model: MODEL,
      model_reasoning_effort: "high",
      approval_policy: "never",
      sandbox_policy: "read-only",
      network_policy: "restricted",
      ...over,
    },
  });
  const TURN_CONTEXT = { timestamp: "2026-09-20T00:00:00.000Z", type: "turn_context", payload: { turn_id: "turn-1", model: MODEL } };

  it("verified when the rollout model matches and effort is high", () => {
    const rollout = parseRolloutProvenance([JSON.stringify(SESSION_META()), JSON.stringify(TURN_CONTEXT)].join("\n"));
    const v = verifyRolloutProvenance({ rollout, requestedModel: MODEL });
    assert.equal(v.state, "verified");
    assert.equal(v.model, MODEL);
    assert.equal(v.reasoningEffort, "high");
    assert.equal(v.approvalPolicy, "never");
    assert.equal(v.sandboxPolicy, "read-only");
    assert.equal(v.networkPolicy, "restricted");
  });

  it("model mismatch fails closed naming requested and actual", () => {
    const rollout = parseRolloutProvenance(JSON.stringify(SESSION_META({ model: OTHER_MODEL })));
    const v = verifyRolloutProvenance({ rollout, requestedModel: MODEL });
    assert.equal(v.state, "mismatch");
    assert.equal(v.kind, "model");
    assert.equal(v.requested, MODEL);
    assert.equal(v.actual, OTHER_MODEL);
  });

  it("reasoning-effort mismatch fails closed naming requested and actual", () => {
    const rollout = parseRolloutProvenance(JSON.stringify(SESSION_META({ model_reasoning_effort: "low" })));
    const v = verifyRolloutProvenance({ rollout, requestedModel: MODEL });
    assert.equal(v.state, "mismatch");
    assert.equal(v.kind, "reasoning-effort");
    assert.equal(v.requested, "high");
    assert.equal(v.actual, "low");
  });

  it("no rollout is UNVERIFIABLE, never silently verified", () => {
    const v = verifyRolloutProvenance({ rollout: { found: false }, requestedModel: MODEL });
    assert.equal(v.state, "unverifiable");
    assert.match(v.reason, /no-rollout-record/);
  });

  it("a rollout without a model field is unverifiable, not verified", () => {
    const rollout = parseRolloutProvenance(JSON.stringify(SESSION_META({ model: undefined })));
    const v = verifyRolloutProvenance({ rollout, requestedModel: MODEL });
    assert.equal(v.state, "unverifiable");
    assert.match(v.reason, /rollout-model-field-absent/);
  });

  it("the model may come from turn_context payloads when session_meta lacks one", () => {
    const rollout = parseRolloutProvenance(JSON.stringify(TURN_CONTEXT));
    assert.equal(rollout.model, MODEL);
    const v = verifyRolloutProvenance({ rollout, requestedModel: MODEL });
    assert.equal(v.state, "verified");
  });

  it("tolerates malformed rollout lines", () => {
    const rollout = parseRolloutProvenance("not json\n" + JSON.stringify(SESSION_META()));
    assert.equal(rollout.found, true);
    assert.equal(rollout.model, MODEL);
  });

  // -------------------------------------------------------------------------
  // RESUMED-dispatch binding (kusabi #527 review follow-up): verification
  // must bind to the resumed invocation's OWN turn_context evidence (the
  // LAST turn in the thread's rollout), never a stale matching turn from the
  // original session.
  // -------------------------------------------------------------------------

  it("RESUMED: original matching turn + resumed mismatching turn fails closed (resumed evidence wins)", () => {
    // The dangerous shape: the resumed run continues the SAME thread, so the
    // rollout has ONE session_meta and the original matching turn-1, and only
    // the resumed turn-2 reveals the model switch.  The stale original
    // evidence must never verify the run.
    const content = [
      JSON.stringify(SESSION_META()),                                       // original session: model MODEL
      JSON.stringify(TURN_CONTEXT),                                         // original turn-1: model MODEL
      JSON.stringify({ ...TURN_CONTEXT, payload: { turn_id: "turn-2", model: OTHER_MODEL } }), // resumed turn
    ].join("\n");
    const rollout = parseRolloutProvenance(content);
    const v = verifyRolloutProvenance({ rollout, requestedModel: MODEL, resumed: true });
    assert.equal(v.state, "mismatch");
    assert.equal(v.kind, "model");
    assert.equal(v.requested, MODEL);
    assert.equal(v.actual, OTHER_MODEL);
  });

  it("RESUMED: a matching resumed-turn fixture verifies and records actual model/effort", () => {
    const content = [
      JSON.stringify(SESSION_META()),
      JSON.stringify(TURN_CONTEXT),
      JSON.stringify({ ...TURN_CONTEXT, payload: { turn_id: "turn-2", model: MODEL, model_reasoning_effort: "high" } }),
    ].join("\n");
    const rollout = parseRolloutProvenance(content);
    const v = verifyRolloutProvenance({ rollout, requestedModel: MODEL, resumed: true });
    assert.equal(v.state, "verified");
    assert.equal(v.model, MODEL);
    assert.equal(v.reasoningEffort, "high");
  });

  it("RESUMED: a resumed-turn effort mismatch fails closed even when the original session matched", () => {
    const content = [
      JSON.stringify(SESSION_META()),
      JSON.stringify(TURN_CONTEXT),
      JSON.stringify({ ...TURN_CONTEXT, payload: { turn_id: "turn-2", model: MODEL, model_reasoning_effort: "low" } }),
    ].join("\n");
    const rollout = parseRolloutProvenance(content);
    const v = verifyRolloutProvenance({ rollout, requestedModel: MODEL, resumed: true });
    assert.equal(v.state, "mismatch");
    assert.equal(v.kind, "reasoning-effort");
    assert.equal(v.requested, "high");
    assert.equal(v.actual, "low");
  });

  it("RESUMED: a rollout with no turn_context at all is unverifiable, never verified from stale session evidence", () => {
    const rollout = parseRolloutProvenance(JSON.stringify(SESSION_META()));
    const v = verifyRolloutProvenance({ rollout, requestedModel: MODEL, resumed: true });
    assert.equal(v.state, "unverifiable");
    assert.match(v.reason, /no-resumed-turn-evidence/);
  });

  it("RESUMED: fresh-path verification of the same fixture still uses the fresh aggregate", () => {
    const content = [
      JSON.stringify(SESSION_META({ model: OTHER_MODEL })),
      JSON.stringify(TURN_CONTEXT), // first named turn: MODEL
    ].join("\n");
    const rollout = parseRolloutProvenance(content);
    const v = verifyRolloutProvenance({ rollout, requestedModel: MODEL, resumed: false });
    // Fresh semantics unchanged: the last session_meta's model wins.
    assert.equal(v.state, "mismatch");
    assert.equal(v.actual, OTHER_MODEL);
  });
});

describe("assertNoCodexSession", () => {
  it("refuses an opencode ses_* id on shape, even with codex provenance", () => {
    assert.throws(
      () => assertNoCodexSession("ses_abc", { provenance: "codex" }),
      /ses_\* session ids belong to opencode/,
    );
  });

  it("resumes a thread id only on positive codex provenance", () => {
    assert.throws(
      () => assertNoCodexSession(THREAD_ID, { provenance: "claude" }),
      /job store attributes it to the claude backend/,
    );
    assert.throws(
      () => assertNoCodexSession(THREAD_ID, { provenance: null }),
      /no kusabi job record reports it/,
    );
    assert.doesNotThrow(() => assertNoCodexSession(THREAD_ID, { provenance: "codex" }));
    assert.doesNotThrow(() => assertNoCodexSession(null, {}));
    assert.doesNotThrow(() => assertNoCodexSession("", { provenance: "codex" }));
  });
});
describe("CLI argument layer", () => {
  it("--backend codex is accepted and maps to codexDispatch", () => {
    assert.equal(resolveBackend({ backend: "codex" }), "codex");
    assert.equal(backendDispatch("codex"), codexDispatch);
    assert.equal(backendPinsModel("codex"), true);
  });

  it("codex/<id> route entries split through the existing machinery", () => {
    assert.deepEqual(
      splitRouteBackend("codex/gpt-5.6-sol"),
      { route: "gpt-5.6-sol", backend: "codex" },
    );
    assert.deepEqual(
      resolveModelBackend("codex/gpt-5.6-sol"),
      { backend: "codex", model: "gpt-5.6-sol" },
    );
  });

  it("backendSupportsResume(\"codex\") is true (measured 2026-09-20)", () => {
    assert.equal(backendSupportsResume("codex"), true);
  });

  it("an unknown backend still errors naming the full list including codex", () => {
    assert.throws(() => resolveBackend({ backend: "bogus" }), /unknown backend: bogus/);
    assert.throws(() => resolveBackend({ backend: "bogus" }), /Use --backend opencode\|claude\|agy\|cursor\|codex/);
  });

  it("codex is a member of BACKENDS, not a special case beside it", () => {
    assert.deepEqual(BACKENDS, ["opencode", "claude", "agy", "cursor", "codex"]);
  });

  it("--backend codex and --model codex/<seat> reach codexDispatch", () => {
    const viaFlag = resolveDispatchBackend({
      flags: { backend: "codex" },
      phase: "implement",
      config: {},
    });
    assert.equal(viaFlag.dispatch, codexDispatch);
    assert.equal(viaFlag.backend, "codex");
    assert.equal(viaFlag.model, "gpt-5.6-luna");
    assert.equal(viaFlag.explicitModel, null);

    const viaModel = resolveDispatchBackend({
      flags: { model: "codex/gpt-5.6-sol" },
      phase: "implement",
      config: {},
    });
    assert.equal(viaModel.dispatch, codexDispatch);
    assert.equal(viaModel.backend, "codex");
    assert.equal(viaModel.model, "gpt-5.6-sol");
    assert.equal(viaModel.explicitModel, "gpt-5.6-sol");
  });

  it("codex/model:variant is rejected at command start, attributed to the codex backend", () => {
    assert.throws(
      () => resolveDispatchBackend({ flags: { model: "codex/gpt-5.6-sol:fast" }, phase: "implement", config: {} }),
      (error) => error.flagError === true && /the codex backend: .*:variant/.test(error.message),
    );
  });

  it("an unsupported codex model id is rejected at command start", () => {
    assert.throws(
      () => resolveDispatchBackend({ flags: { model: "codex/gpt-5.7-future" }, phase: "implement", config: {} }),
      /does not support model "gpt-5.7-future"/,
    );
  });
});

describe("renderHeader for a codex job", () => {
  const base = {
    id: "job-cx1",
    kind: "task",
    status: "completed",
    backend: "codex",
    sessionID: THREAD_ID,
    startedAt: "2026-09-20T00:00:00.000Z",
    finishedAt: "2026-09-20T00:02:32.000Z",
    phase: "implement",
    modelEntry: MODEL,
  };

  it("labels the backend, advertises the EXECUTABLE codex resume incantation, and renders measured provenance", () => {
    const text = renderHeader({
      ...base,
      codexHome: "/state/jobs/job-cx1/codex-home",
      codexProvenance: { state: "verified", model: MODEL, reasoningEffort: "high" },
      reasoningEffort: "high",
      usage: { available: true, input: 10543, output: 34 },
    });
    assert.match(text, /^codex task job-cx1 \u2014 completed/);
    // The continuation is executable AS PRINTED: HOME and CODEX_HOME point at
    // the exact job-owned home recorded on the job (kusabi #527 finding 1).
    assert.ok(text.includes(
      "continue in codex: `HOME='/state/jobs/job-cx1/codex-home' " +
      "CODEX_HOME='/state/jobs/job-cx1/codex-home' codex exec resume " + THREAD_ID + "`",
    ));
    assert.match(text, /actual model: gpt-5.6-sol \(verified from rollout\)/);
    assert.match(text, /reasoning effort: high/);
    assert.doesNotMatch(text, /opencode -s/);
  });

  it("renders an explicit CODEX_HOME instruction when the record has no persisted codex home", () => {
    const text = renderHeader({ ...base });
    assert.match(text, /continue in codex: `codex exec resume .*` after setting CODEX_HOME to the job-owned codex home/);
  });

  it("shell-quotes a codex home with spaces and single quotes so the command stays executable", () => {
    const text = renderHeader({ ...base, codexHome: "/state/dir with space/o'brien/codex home" });
    // POSIX single-quote escaping: `o'brien` becomes `o'\''brien`.
    assert.ok(text.includes(
      "continue in codex: `HOME='/state/dir with space/o'\\''brien/codex home' " +
      "CODEX_HOME='/state/dir with space/o'\\''brien/codex home' codex exec resume " + THREAD_ID + "`",
    ));
  });

  it("renders an unverifiable provenance explicitly, never as verified", () => {
    const text = renderHeader({ ...base, codexProvenance: { state: "unverifiable", reason: "no-rollout-record" } });
    assert.match(text, /provenance: unverifiable \(no-rollout-record\)/);
    assert.doesNotMatch(text, /actual model:/);
  });

  it("renders a provenance mismatch naming requested and actual", () => {
    const text = renderHeader({
      ...base,
      codexProvenance: { state: "mismatch", kind: "model", requested: MODEL, actual: OTHER_MODEL },
    });
    assert.match(text, /provenance MISMATCH: requested model gpt-5.6-sol, rollout shows gpt-5.6-luna/);
  });
});

describe("codexDispatch (fake codex)", () => {
  let ctx;
  beforeEach(() => { ctx = fakeCodexContext(); });
  afterEach(() => { ctx.restore(); });

  it("happy path: returns result text, usage, thread id, and verified provenance", async () => {
    const { job, resultText, stateDir } = await codexDispatch(ctx.dispatchOptions());
    assert.equal(job.status, "completed");
    assert.equal(job.backend, CODEX_BACKEND);
    assert.equal(job.modelEntry, MODEL);
    assert.equal(resultText, "ALPHA-7");
    assert.equal(job.sessionID, THREAD_ID);
    assert.equal(job.usage.available, true);
    assert.equal(job.usage.input, 10543);
    assert.equal(job.usage.output, 34);
    assert.equal(job.usage.cacheRead, 5376);
    assert.equal(job.usage.cacheWrite, 0);
    assert.equal(job.usage.total, 10543 + 5376 + 34);
    assert.equal(job.reasoningEffort, "high");
    assert.equal(job.sandboxPolicy, "read-only");
    assert.equal(job.codexCommandTool, true, "the built-in command tool remains — never claim tool-free");
    assert.equal(job.mcpServersConfigured, false);
    assert.equal(job.codexProvenance.state, "verified");
    assert.equal(job.codexProvenance.model, MODEL);
    assert.equal(job.substituted, false, "verified-exact provenance must record substituted: false");
    assert.equal(job.stopReason, "completed");
    assert.equal(stateDir, ctx.stateDir);

    const persisted = loadJob(stateDir, job.id);
    assert.equal(persisted.sessionID, THREAD_ID);
    assert.equal(persisted.codexProvenance.state, "verified");
    assert.equal(persisted.substituted, false, "the persisted job record must carry substituted: false");
    assert.equal(fs.readFileSync(path.join(jobDir(stateDir, job.id), "result.md"), "utf8"), "ALPHA-7");
  });

  it("regression: the exact live flat item.completed shape (item.type agent_message, item.text) completes the job with the extracted text", async () => {
    // The live Codex CLI emits the terminal assistant text as
    // item.completed with item: { type: "agent_message", text } (the shape
    // that broke mission-mucn5qb2a76e2095).  This fixture must complete the
    // job exactly like the nested shape does.
    ctx.setMode("flat");
    const { job, resultText, stateDir } = await codexDispatch(ctx.dispatchOptions());
    assert.equal(job.status, "completed");
    assert.equal(job.stats.steps, 2, "the flat agent_message item and the tool item each count one step");
    const readProbe = { action: "read_probe", envelope_sha256: "deadbeef", tool: "read_file_range", path: "evidence/probes.json" };
    assert.equal(resultText, JSON.stringify(readProbe), "the flat item.text payload is the dispatched result");
    assert.equal(job.sessionID, THREAD_ID);
    const persisted = loadJob(stateDir, job.id);
    assert.equal(persisted.status, "completed");
    assert.equal(fs.readFileSync(path.join(jobDir(stateDir, job.id), "result.md"), "utf8"), JSON.stringify(readProbe));
  });

  it("persists the job-owned codex home and renders a continuation targeting the SAME home the dispatch used", async () => {
    const { job, stateDir } = await codexDispatch(ctx.dispatchOptions());
    const persisted = loadJob(stateDir, job.id);
    const home = codexHomeForJob(stateDir, job.id);
    assert.equal(persisted.codexHome, home, "dispatch persists the exact job-owned codex home");
    assert.equal(persisted.sessionID, THREAD_ID);
    const text = renderHeader(persisted);
    // The rendered continuation is executable as printed and points HOME and
    // CODEX_HOME at the SAME job-owned home the dispatch ran under.
    assert.ok(text.includes(
      "continue in codex: `HOME='" + home + "' CODEX_HOME='" + home + "' codex exec resume " + THREAD_ID + "`",
    ));
    assert.equal(text.includes("SECRET-TOKEN"), false, "auth material never rendered");
  });

  it("prompt reaches the child on stdin, never argv", async () => {
    await codexDispatch(ctx.dispatchOptions({ promptText: "SECRET-PROMPT-TOKEN" }));
    const argv = loggedArgs(ctx.argsLog)[0];
    assert.equal(argv.includes("SECRET-PROMPT-TOKEN"), false);
    const stdin = fs.readFileSync(ctx.stdinLog, "utf8");
    assert.match(stdin, /SECRET-PROMPT-TOKEN/);
  });

  it("argv is the exact fresh shape with the requested exact model", async () => {
    await codexDispatch(ctx.dispatchOptions({ explicitModel: "gpt-5.6-sol" }));
    assert.deepEqual(loggedArgs(ctx.argsLog)[0], [
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "-C", ctx.cwd,
      "-s", "read-only",
      "--json",
      "-m", "gpt-5.6-sol",
      "-c", 'model_reasoning_effort="high"',
      "-c", "mcp_servers={}",
      "-",
    ]);
  });

  it("HOME and CODEX_HOME both point at the job-owned directory, never the parent's", async () => {
    const { job } = await codexDispatch(ctx.dispatchOptions());
    const expected = jobCodexHome(ctx, job);
    const env = loggedEnv(ctx.envLog);
    assert.equal(env.HOME, expected);
    assert.equal(env.CODEX_HOME, expected);
    assert.notEqual(env.HOME, ctx.fakeHome, "child must not inherit the parent HOME");
    assert.notEqual(env.CODEX_HOME, ctx.operatorCodexHome, "child must not inherit the operator CODEX_HOME");
    assert.equal(env.KUSABI_WORKER_CONTEXT, "1");
    // The job-owned home starts isolated: no config.toml, no rules, no
    // sessions dir, no MCP config at spawn (the fake may only see the auth
    // symlink).  No inherited user config/rules/MCP.
    assert.ok(env.codexHomeContents.length === 0 || env.codexHomeContents.includes("auth.json"));
    assert.equal(env.codexHomeContents.includes("config.toml"), false);
    assert.equal(env.codexHomeContents.includes("rules"), false);
    assert.equal(env.codexHomeContents.includes("sessions"), false);
  });

  it("creates the minimum auth symlink when the operator auth cache exists, and leaks no contents", async () => {
    fs.writeFileSync(path.join(ctx.operatorCodexHome, "auth.json"), "SECRET-TOKEN-MATERIAL", "utf8");
    const { job, stateDir } = await codexDispatch(ctx.dispatchOptions());
    const home = jobCodexHome(ctx, job);
    assert.equal(fs.readlinkSync(path.join(home, "auth.json")), path.join(ctx.operatorCodexHome, "auth.json"));
    // Auth contents must never appear in any publishable/recorded file.
    const jobRoot = jobDir(stateDir, job.id);
    for (const name of ["job.json", "result.md", "usage.json", "events.ndjson"]) {
      const file = path.join(jobRoot, name);
      if (!fs.existsSync(file)) continue;
      assert.equal(
        fs.readFileSync(file, "utf8").includes("SECRET-TOKEN-MATERIAL"),
        false,
        `auth contents leaked into ${name}`,
      );
    }
    // The event records the bridge KIND only.
    const events = fs.readFileSync(path.join(jobRoot, "events.ndjson"), "utf8");
    assert.match(events, /"authBridge":"symlinked"/);
  });

  it("resume: session with codex provenance produces the resume argv and preserves the thread id", async () => {
    const { job, resultText } = await codexDispatch(ctx.dispatchOptions({
      session: THREAD_ID,
      sessionProvenance: "codex",
    }));
    assert.equal(resultText, "ALPHA-7");
    assert.equal(job.sessionID, THREAD_ID);
    const argv = loggedArgs(ctx.argsLog)[0];
    assert.equal(argv[0], "exec");
    assert.equal(argv[1], "resume");
    assert.equal(argv[2], THREAD_ID);
    assert.equal(argv.includes("-s"), false, "no --sandbox on resume");
    assert.equal(argv.includes("-a"), false, "never -a");
    assert.ok(argv.includes('sandbox_mode="read-only"'));
    assert.ok(argv.includes('approval_policy="never"'));
  });

  it("resume: records the KNOWN thread id even when the resume stream omits thread.started", async () => {
    ctx.setMode("resume-no-thread");
    const { job, resultText, stateDir } = await codexDispatch(ctx.dispatchOptions({
      session: THREAD_ID,
      sessionProvenance: "codex",
    }));
    assert.equal(job.status, "completed");
    assert.equal(resultText, "ALPHA-7");
    assert.equal(job.sessionID, THREAD_ID, "the known resumed thread id must be persisted");
    // The matching resumed-turn evidence verifies and records actual
    // model/effort from the resumed turn, not the original session's.
    assert.equal(job.codexProvenance.state, "verified");
    assert.equal(job.codexProvenance.model, MODEL);
    assert.equal(job.codexProvenance.reasoningEffort, "high");
    assert.equal(job.substituted, false, "verified resumed turn must record substituted: false");
    const persisted = loadJob(stateDir, job.id);
    assert.equal(persisted.sessionID, THREAD_ID);
  });

  it("--resume-last after a resumed job selects the SAME thread and resumes it, never fresh", async () => {
    ctx.setMode("resume-no-thread");
    await codexDispatch(ctx.dispatchOptions({ session: THREAD_ID, sessionProvenance: "codex" }));
    // --resume-last selection: the newest same-backend task job's sessionID.
    const selected = resolveResumeLastSession(ctx.stateDir, { backend: "codex" });
    assert.equal(selected, THREAD_ID);
    // A follow-up dispatch with that selection resumes the SAME thread.
    fs.writeFileSync(ctx.argsLog, "", "utf8");
    const second = await codexDispatch(ctx.dispatchOptions({
      session: selected,
      sessionProvenance: "codex",
    }));
    assert.equal(second.job.sessionID, THREAD_ID);
    const argv = loggedArgs(ctx.argsLog)[0];
    assert.equal(argv[0], "exec");
    assert.equal(argv[1], "resume");
    assert.equal(argv[2], THREAD_ID);
  });

  it("resume provenance mismatch (model) fails closed even though the original session matched", async () => {
    ctx.setMode("resume-mismatch-model");
    const { job, resultText } = await codexDispatch(ctx.dispatchOptions({
      session: THREAD_ID,
      sessionProvenance: "codex",
    }));
    assert.equal(job.status, "error");
    assert.match(job.error, /codex provenance mismatch: requested model gpt-5.6-sol but the recorded rollout shows gpt-5.6-luna/);
    assert.match(job.error, /no result was written and no substitute model was attempted/);
    assert.equal(resultText, "");
    assert.equal(fs.existsSync(path.join(jobDir(ctx.stateDir, job.id), "result.md")), false);
    assert.equal(job.codexProvenance.state, "mismatch");
    assert.equal(job.substituted, true, "an observed model mismatch must record substituted: true");
  });

  it("resume provenance mismatch (effort) on the resumed turn fails closed", async () => {
    ctx.setMode("resume-mismatch-effort");
    const { job } = await codexDispatch(ctx.dispatchOptions({
      session: THREAD_ID,
      sessionProvenance: "codex",
    }));
    assert.equal(job.status, "error");
    assert.match(job.error, /requested reasoning-effort high but the recorded rollout shows low/);
    assert.equal(fs.existsSync(path.join(jobDir(ctx.stateDir, job.id), "result.md")), false);
  });

  it("resume refuses unknown or cross-backend session ownership BEFORE any job record", async () => {
    await assert.rejects(
      () => codexDispatch(ctx.dispatchOptions({ session: THREAD_ID, sessionProvenance: null })),
      /cannot be resumed on the codex backend/,
    );
    await assert.rejects(
      () => codexDispatch(ctx.dispatchOptions({ session: THREAD_ID, sessionProvenance: "cursor" })),
      /job store attributes it to the cursor backend/,
    );
    await assert.rejects(
      () => codexDispatch(ctx.dispatchOptions({ session: "ses_opencode1", sessionProvenance: "codex" })),
      /ses_\* session ids belong to opencode/,
    );
  });

  it("--output-schema framing: argv carries the schema and the terminal JSON text is the result", async () => {
    ctx.setMode("schema");
    const { job, resultText } = await codexDispatch(ctx.dispatchOptions({ agent: "kusabi-review" }));
    assert.equal(job.status, "completed");
    assert.equal(resultText, '{"verdict":"approve"}');
    const argv = loggedArgs(ctx.argsLog)[0];
    const idx = argv.indexOf("--output-schema");
    assert.ok(idx >= 0, "review dispatch carries --output-schema");
    assert.equal(argv[idx + 1], JSON.stringify(JSON.parse(codexJsonSchemaFor("kusabi-review"))));
    assert.equal(job.jsonSchemaEnforced, true);
  });

  it("write-tool denies are sandbox-enforced; non-write denies are recorded as unenforced", async () => {
    const { job } = await codexDispatch(ctx.dispatchOptions({
      tools: { bash: false, write: false, read: true, sunaba_copy_project: false },
    }));
    // bash/write are the canonical read-only write boundary the fixed sandbox
    // enforces; sunaba_copy_project is a per-tool claim the CLI cannot
    // enforce (kusabi #527 finding 2).
    assert.deepEqual(job.codexSandboxEnforcedDenies, ["bash", "write"]);
    assert.deepEqual(job.toolDeniesUnenforced, ["sunaba_copy_project"]);
  });

  it("the operator read-only map is entirely sandbox-enforced, never unenforced", async () => {
    const readOnlyMap = Object.fromEntries(WRITE_TOOL_NAMES.map((t) => [t, false]));
    const { job } = await codexDispatch(ctx.dispatchOptions({ tools: readOnlyMap }));
    assert.deepEqual(job.codexSandboxEnforcedDenies, [...WRITE_TOOL_NAMES]);
    assert.deepEqual(job.toolDeniesUnenforced, []);
  });

  it("a phase deny map keeps its non-write entries genuinely unenforced", async () => {
    const { job } = await codexDispatch(ctx.dispatchOptions({ tools: implementDenyTools() }));
    assert.deepEqual(job.codexSandboxEnforcedDenies, [...WRITE_TOOL_NAMES]);
    assert.deepEqual(job.toolDeniesUnenforced, ["sunaba_copy_project", "sunaba_copy_file"]);
  });

  it("a review phase deny map keeps issue/pr write denies unenforced too", async () => {
    const { job } = await codexDispatch(ctx.dispatchOptions({ tools: reviewDenyTools() }));
    assert.deepEqual(job.codexSandboxEnforcedDenies, [...WRITE_TOOL_NAMES]);
    assert.deepEqual(job.toolDeniesUnenforced, [
      "sunaba_copy_project",
      "sunaba_copy_file",
      "sunaba_sandbox_issue_write",
      "sunaba_sandbox_pr_review_write",
    ]);
  });

  it("read-only active does not erase a genuine phase deny (combination)", async () => {
    const { job } = await codexDispatch(ctx.dispatchOptions({
      tools: { bash: false, write: false, sunaba_copy_project: false },
    }));
    assert.deepEqual(job.codexSandboxEnforcedDenies, ["bash", "write"]);
    assert.deepEqual(job.toolDeniesUnenforced, ["sunaba_copy_project"]);
  });

  it("missing terminal message / non-JSON stream / empty result are distinguishable failures", async () => {
    ctx.setMode("no-result");
    const missing = await codexDispatch(ctx.dispatchOptions());
    assert.equal(missing.job.status, "error");
    assert.match(missing.job.error, /produced no terminal assistant message/);

    ctx.setMode("malformed");
    const malformed = await codexDispatch(ctx.dispatchOptions());
    assert.equal(malformed.job.status, "error");
    assert.match(malformed.job.error, /produced no terminal assistant message/);

    ctx.setMode("empty-result");
    const empty = await codexDispatch(ctx.dispatchOptions());
    assert.equal(empty.job.status, "error");
    assert.match(empty.job.error, /produced no terminal assistant message/);
  });

  it("nonzero exit is a failure naming the exit code", async () => {
    ctx.setMode("exit");
    const { job } = await codexDispatch(ctx.dispatchOptions());
    assert.equal(job.status, "error");
    assert.match(job.error, /exited with code 3/);
  });

  it("spawn failure is a failed job naming the binary", async () => {
    const saved = process.env.CODEX_BIN;
    process.env.CODEX_BIN = path.join(ctx.tmp, "does-not-exist");
    try {
      const { job } = await codexDispatch(ctx.dispatchOptions());
      assert.equal(job.status, "error");
      assert.match(job.error, /could not start/);
    } finally {
      process.env.CODEX_BIN = saved;
    }
  });

  it("the outer timeout kills the group and classifies timeout", async () => {
    ctx.setMode("sleep");
    const { job } = await codexDispatch(ctx.dispatchOptions({
      timeoutS: 1,
      watchdogS: null,
    }));
    assert.equal(job.status, "timeout");
    assert.match(job.error, /timed out after 1s/);
    assert.equal(fs.existsSync(path.join(jobDir(ctx.stateDir, job.id), "result.md")), false);
  });

  it("the silence watchdog kills the group and classifies stalled", async () => {
    ctx.setMode("sleep");
    const { job } = await codexDispatch(ctx.dispatchOptions({
      timeoutS: null,
      watchdogS: 1,
    }));
    assert.equal(job.status, "stalled");
    assert.match(job.error, /watchdog: no events for 1s \(process killed\)/);
  });

  it("actual-model mismatch fails closed: job error, no result, no substitute model", async () => {
    ctx.setMode("mismatch-model");
    const { job, resultText } = await codexDispatch(ctx.dispatchOptions());
    assert.equal(job.status, "error");
    assert.match(job.error, /codex provenance mismatch: requested model gpt-5.6-sol but the recorded rollout shows gpt-5.6-luna/);
    assert.match(job.error, /no result was written and no substitute model was attempted/);
    assert.equal(resultText, "");
    assert.equal(fs.existsSync(path.join(jobDir(ctx.stateDir, job.id), "result.md")), false);
    assert.equal(job.codexProvenance.state, "mismatch");
    assert.equal(job.substituted, true, "an observed model mismatch must record substituted: true");
    const persisted = loadJob(ctx.stateDir, job.id);
    assert.equal(persisted.status, "error");
  });

  it("reasoning-effort mismatch fails closed too", async () => {
    ctx.setMode("mismatch-effort");
    const { job } = await codexDispatch(ctx.dispatchOptions());
    assert.equal(job.status, "error");
    assert.match(job.error, /requested reasoning-effort high but the recorded rollout shows low/);
    assert.equal(fs.existsSync(path.join(jobDir(ctx.stateDir, job.id), "result.md")), false);
  });

  it("missing rollout is unverifiable but the run still completes (provenance marked, not claimed)", async () => {
    ctx.setMode("no-rollout");
    const { job, resultText } = await codexDispatch(ctx.dispatchOptions());
    assert.equal(job.status, "completed");
    assert.equal(resultText, "ALPHA-7");
    assert.equal(job.codexProvenance.state, "unverifiable");
    assert.match(job.codexProvenance.reason, /no-rollout-record/);
    assert.equal(job.substituted, null, "unverifiable provenance must record substituted: null, never a claimed false");
  });

  it("cancellation kills the process group through the recorded identity token (kusabi #209 lever)", async () => {
    ctx.setMode("sleep");
    const pending = codexDispatch(ctx.dispatchOptions({ timeoutS: null, watchdogS: null }));
    // Poll the job store until the child exists and the record carries the
    // identity token the `cancel` command verifies before signalling.
    let running = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      running = listJobs(ctx.stateDir).find((j) => j.status === "running" && j.process?.pid);
      if (running) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(running, "the running codex job must be recorded with a process");
    assert.ok(running.process.startTime, "the recorded process carries the identity token");
    const stop = await stopRecordedProcess(running.process);
    assert.equal(stop.outcome, "stopped");
    await pending;
  });
});

describe("readRolloutProvenance over the job-owned home", () => {
  it("finds and verifies the rollout written by the child under the job CODEX_HOME", async () => {
    let ctx;
    ctx = fakeCodexContext();
    try {
      const { job } = await codexDispatch(ctx.dispatchOptions());
      const home = jobCodexHome(ctx, job);
      const read = readRolloutProvenance({ codexHome: home, requestedModel: MODEL });
      assert.equal(read.state, "verified");
      assert.equal(read.model, MODEL);
      assert.equal(read.sandboxPolicy, "read-only");
      assert.equal(read.approvalPolicy, "never");
      assert.equal(read.networkPolicy, "restricted");
    } finally {
      ctx.restore();
    }
  });

  it("never throws on an unreadable or absent home", () => {
    const outcome = readRolloutProvenance({ codexHome: path.join(os.tmpdir(), "no-such-codex-home"), requestedModel: MODEL });
    assert.equal(outcome.state, "unverifiable");
  });
});