// result-recovery.test.mjs — recovering a completed job's result when the
// model never emitted a final message (kusabi #198).
//
// Every assertion here is on recovered CONTENT, not on the absence of an
// exception: the defect being fixed produced a 0-byte result.md without
// throwing anything, so "did not throw" proves nothing about it.  Fixtures
// are small files written into a temp dir — the opencode source reads a job's
// events.ndjson, the claude source reads a Claude Code transcript located by
// session id, and both are found through the same interface.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import {
  RECOVERED_RESULT_MARKER,
  RECOVERY_SOURCES,
  markRecovered,
  recoverFromOpencodeEvents,
  recoverFromClaudeTranscript,
  findClaudeTranscript,
  resolveCompletedResult,
} from "./result-recovery.mjs";
import { claudeDispatch, claudeFinalMessage } from "./claude-dispatch.mjs";
import { extractJson } from "./render.mjs";
import { loadJob, jobDir } from "./job-store.mjs";
import { stateDirFor } from "./state-paths.mjs";

// =========================================================================
// fixtures — opencode event stream
// =========================================================================

/** A `message.updated` declaring a message's role (this is what tells the */
/*  recovery which parts are the model's answer and which are the prompt).  */
function messageUpdated(id, role) {
  return { type: "message.updated", properties: { info: { id, role, modelID: "m1", providerID: "p1" } } };
}

/** `message.part.delta` in the nested-part shape. */
function partDelta(partID, text, messageID = "msg_a") {
  return {
    type: "message.part.delta",
    properties: { sessionID: "ses_1", part: { id: partID, messageID, sessionID: "ses_1", type: "text", text } },
  };
}

/** `message.part.updated` carrying the part's full text so far. */
function partUpdated(partID, text, messageID = "msg_a") {
  return {
    type: "message.part.updated",
    properties: { sessionID: "ses_1", part: { id: partID, messageID, sessionID: "ses_1", type: "text", text } },
  };
}

/** `message.part.delta` in the flat shape (partID + field + delta). */
function flatDelta(partID, delta, messageID = "msg_a") {
  return {
    type: "message.part.delta",
    properties: { sessionID: "ses_1", messageID, partID, field: "text", delta },
  };
}

const SESSION_IDLE = { type: "session.idle", properties: { sessionID: "ses_1" } };

describe("recoverFromOpencodeEvents", () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-recover-oc-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Write `lines` (objects, or raw strings for damage) as an events.ndjson. */
  function writeEvents(lines) {
    const file = path.join(dir, "events.ndjson");
    const body = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");
    fs.writeFileSync(file, body ? `${body}\n` : "", "utf8");
    return file;
  }

  it("keeps an incremental chunk that is a prefix of what came before", () => {
    // Regression: the first implementation decided delta-vs-snapshot by prefix
    // testing, so any chunk that happened to be a prefix of the accumulated
    // text was discarded as a stale snapshot.  On the real 1.8 MB stream of
    // job-msn8ktw24af4 that silently deleted the words "Let" and "N"
    // mid-sentence.  The shape below is that stream's: 6,684 flat deltas.
    const file = writeEvents([
      messageUpdated("msg_a", "assistant"),
      flatDelta("prt_1", "Let me start by reading the diff."),
      flatDelta("prt_1", "\n\n"),
      flatDelta("prt_1", "Let"),
      flatDelta("prt_1", " me first attach to the container."),
      SESSION_IDLE,
    ]);

    const recovered = recoverFromOpencodeEvents(file);
    assert.equal(
      recovered.text,
      "Let me start by reading the diff.\n\nLet me first attach to the container.",
    );
  });

  it("still collapses a re-emitted snapshot into one copy", () => {
    // The other half of the trade: a snapshot restating the whole part must
    // not be appended twice.  `message.part.updated` carries snapshots.
    const file = writeEvents([
      messageUpdated("msg_a", "assistant"),
      partUpdated("prt_1", "The review found"),
      partUpdated("prt_1", "The review found three issues."),
      partUpdated("prt_1", "The review found"),
      SESSION_IDLE,
    ]);

    const recovered = recoverFromOpencodeEvents(file);
    assert.equal(recovered.text, "The review found three issues.");
  });

  it("concatenates part text in arrival order — exact recovered string", () => {
    const file = writeEvents([
      messageUpdated("msg_a", "assistant"),
      partDelta("prt_1", "The review "),
      partDelta("prt_1", "found three "),
      partDelta("prt_1", "issues in the patch."),
      SESSION_IDLE,
    ]);

    const recovered = recoverFromOpencodeEvents(file);
    assert.equal(recovered.text, "The review found three issues in the patch.");
    assert.equal(recovered.notes.parts, 1);
    assert.equal(recovered.notes.malformed, 0);
  });

  it("joins distinct parts of the same message with a newline", () => {
    const file = writeEvents([
      messageUpdated("msg_a", "assistant"),
      partDelta("prt_1", "## Findings"),
      partDelta("prt_2", "The dispatch drops the output."),
    ]);

    assert.equal(recoverFromOpencodeEvents(file).text, "## Findings\nThe dispatch drops the output.");
  });

  it("text carried on both a .delta and a later .updated appears exactly once", () => {
    const file = writeEvents([
      messageUpdated("msg_a", "assistant"),
      partDelta("prt_1", "The dispatch path "),
      partUpdated("prt_1", "The dispatch path "),
      partDelta("prt_1", "drops the model output."),
      partUpdated("prt_1", "The dispatch path drops the model output."),
      SESSION_IDLE,
    ]);

    const text = recoverFromOpencodeEvents(file).text;
    assert.equal(text, "The dispatch path drops the model output.");
    assert.equal(text.match(/drops the model output/g).length, 1);
  });

  it("a re-emitted stale snapshot does not duplicate what is already collected", () => {
    const file = writeEvents([
      messageUpdated("msg_a", "assistant"),
      partUpdated("prt_1", "alpha beta"),
      partUpdated("prt_1", "alpha"),
      partUpdated("prt_1", "alpha beta gamma"),
    ]);

    assert.equal(recoverFromOpencodeEvents(file).text, "alpha beta gamma");
  });

  it("recovers the flat delta shape too (partID + field + delta)", () => {
    const file = writeEvents([
      messageUpdated("msg_a", "assistant"),
      flatDelta("prt_1", "alpha "),
      flatDelta("prt_1", "beta"),
    ]);

    assert.equal(recoverFromOpencodeEvents(file).text, "alpha beta");
  });

  it("recovers the model's output and NOT the prompt echoed back in the stream", () => {
    const prompt = "<worker_guardrails>\nYou are a delegated worker.\n</worker_guardrails>\nReview the diff.";
    const file = writeEvents([
      messageUpdated("msg_prompt", "user"),
      partUpdated("prt_0", prompt, "msg_prompt"),
      messageUpdated("msg_a", "assistant"),
      partDelta("prt_1", "Reviewed. One finding: the result is written empty."),
      SESSION_IDLE,
    ]);

    const recovered = recoverFromOpencodeEvents(file);
    assert.equal(recovered.text, "Reviewed. One finding: the result is written empty.");
    assert.ok(!recovered.text.includes("worker_guardrails"), "the prompt must not be in the recovered result");
    assert.equal(recovered.notes.skippedNonAssistant, 1);
  });

  it("ignores non-text parts, including text buried in a tool part", () => {
    const file = writeEvents([
      messageUpdated("msg_a", "assistant"),
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "prt_tool", messageID: "msg_a", type: "tool", tool: "bash",
            state: { input: { command: "npm test" }, text: "TOOL NOISE" },
          },
        },
      },
      { type: "message.part.updated", properties: { part: { id: "prt_step", messageID: "msg_a", type: "step-start" } } },
      partDelta("prt_1", "only the assistant text"),
    ]);

    const recovered = recoverFromOpencodeEvents(file);
    assert.equal(recovered.text, "only the assistant text");
    assert.ok(!recovered.text.includes("TOOL NOISE"));
  });

  it("a stream ending at session.idle with no final message still yields the whole answer", () => {
    const file = writeEvents([
      { type: "session.updated", properties: { info: { id: "ses_1" } } },
      messageUpdated("msg_prompt", "user"),
      partUpdated("prt_0", "Review the diff.", "msg_prompt"),
      messageUpdated("msg_a", "assistant"),
      partDelta("prt_1", "## Findings\n\n"),
      partDelta("prt_1", "1. result.md is written empty when the session goes idle"),
      partUpdated("prt_1", "## Findings\n\n1. result.md is written empty when the session goes idle"),
      SESSION_IDLE,
    ]);

    const recovered = recoverFromOpencodeEvents(file);
    assert.equal(
      recovered.text,
      "## Findings\n\n1. result.md is written empty when the session goes idle",
    );
  });

  it("recovers around a malformed line and counts it", () => {
    const file = writeEvents([
      messageUpdated("msg_a", "assistant"),
      partDelta("prt_1", "before the damage "),
      '{"type":"message.part.delta","properties":{"part":{"text":"trunc',
      partDelta("prt_1", "after the damage"),
    ]);

    const recovered = recoverFromOpencodeEvents(file);
    assert.equal(recovered.text, "before the damage after the damage");
    assert.equal(recovered.notes.malformed, 1);
  });

  it("an empty events.ndjson recovers nothing, without throwing", () => {
    const recovered = recoverFromOpencodeEvents(writeEvents([]));
    assert.equal(recovered.text, "");
    assert.equal(recovered.notes.events, 0);
  });

  it("a missing events.ndjson recovers nothing, without throwing", () => {
    const recovered = recoverFromOpencodeEvents(path.join(dir, "does-not-exist.ndjson"));
    assert.equal(recovered.text, "");
    assert.equal(recovered.notes.reason, "events-file-unreadable");
  });

  it("a part whose message role was never recorded is skipped, and says so", () => {
    const file = writeEvents([partDelta("prt_1", "role unknown, provenance unknown")]);
    const recovered = recoverFromOpencodeEvents(file);
    assert.equal(recovered.text, "");
    assert.equal(recovered.notes.skippedUnknownRole, 1);
  });

  it("is deterministic — the same file yields the same result every time", () => {
    const file = writeEvents([
      messageUpdated("msg_a", "assistant"),
      partDelta("prt_1", "alpha "),
      partUpdated("prt_1", "alpha "),
      partDelta("prt_2", "beta"),
      SESSION_IDLE,
    ]);

    const first = recoverFromOpencodeEvents(file);
    const second = recoverFromOpencodeEvents(file);
    assert.equal(first.text, "alpha \nbeta");
    assert.deepEqual(second, first);
  });

  it("is synchronous — it cannot be awaiting a network call", () => {
    const file = writeEvents([messageUpdated("msg_a", "assistant"), partDelta("prt_1", "offline")]);
    const recovered = recoverFromOpencodeEvents(file);
    assert.equal(recovered.then, undefined);
    assert.equal(recovered.text, "offline");
  });
});

// =========================================================================
// fixtures — Claude Code transcript
// =========================================================================

function assistantRecord(uuid, blocks, extra = {}) {
  return {
    type: "assistant",
    uuid,
    sessionId: "sess-1",
    requestId: `req_${uuid}`,
    timestamp: "2026-08-10T12:00:00.000Z",
    message: { role: "assistant", model: "claude-opus-5", content: blocks, usage: { input_tokens: 1 } },
    ...extra,
  };
}

function userRecord(uuid, text) {
  return {
    type: "user",
    uuid,
    sessionId: "sess-1",
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

describe("findClaudeTranscript / recoverFromClaudeTranscript", () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-claude-projects-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Write a transcript for `sessionId` under project directory `project`. */
  function writeTranscript(project, sessionId, lines) {
    const projectDir = path.join(root, project);
    fs.mkdirSync(projectDir, { recursive: true });
    const file = path.join(projectDir, `${sessionId}.jsonl`);
    const body = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");
    fs.writeFileSync(file, body ? `${body}\n` : "", "utf8");
    return file;
  }

  it("finds the transcript by session id, whichever project directory holds it", () => {
    fs.mkdirSync(path.join(root, "-home-someone-other-repo"), { recursive: true });
    const file = writeTranscript("-home-masuda-dev-projects-kusabi", "sess-1", [assistantRecord("u1", [])]);

    assert.equal(findClaudeTranscript("sess-1", root), file);
    assert.equal(findClaudeTranscript("sess-nowhere", root), null);
  });

  it("reconstructs the assistant text — exact recovered string", () => {
    writeTranscript("-home-masuda-proj", "sess-1", [
      { type: "summary", summary: "a summary record we do not understand" },
      userRecord("u0", "Review the diff. <worker_guardrails>do not push</worker_guardrails>"),
      assistantRecord("u1", [{ type: "thinking", thinking: "let me look at the dispatch path" }]),
      assistantRecord("u2", [{ type: "text", text: "## Findings" }]),
      assistantRecord("u3", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } }]),
      assistantRecord("u4", [{ type: "text", text: "1. result.md is written empty" }]),
    ]);

    const recovered = recoverFromClaudeTranscript("sess-1", root);
    assert.equal(recovered.text, "## Findings\n1. result.md is written empty");
    assert.equal(recovered.notes.textBlocks, 2);
    assert.equal(recovered.notes.thinkingBlocks, 1);
    assert.ok(recovered.notes.transcript.endsWith("sess-1.jsonl"));
  });

  it("recovers the model's output and NOT the prompt held in the user records", () => {
    writeTranscript("-p", "sess-1", [
      userRecord("u0", "<worker_guardrails>\nYou are a delegated worker.\n</worker_guardrails>"),
      assistantRecord("u1", [{ type: "text", text: "Understood — starting the review." }]),
    ]);

    const recovered = recoverFromClaudeTranscript("sess-1", root);
    assert.equal(recovered.text, "Understood — starting the review.");
    assert.ok(!recovered.text.includes("worker_guardrails"));
  });

  it("leaves out subagent (sidechain) records and duplicated records", () => {
    writeTranscript("-p", "sess-1", [
      assistantRecord("u1", [{ type: "text", text: "main chain" }]),
      assistantRecord("u2", [{ type: "text", text: "SUBAGENT OUTPUT" }], { isSidechain: true }),
      assistantRecord("u1", [{ type: "text", text: "main chain" }]),
    ]);

    const recovered = recoverFromClaudeTranscript("sess-1", root);
    assert.equal(recovered.text, "main chain");
    assert.equal(recovered.notes.sidechainRecords, 1);
  });

  it("a session id with no transcript anywhere recovers nothing, and says which", () => {
    const recovered = recoverFromClaudeTranscript("sess-pruned", root);
    assert.equal(recovered.text, "");
    assert.equal(recovered.notes.reason, "transcript-not-found");
    assert.equal(recovered.notes.transcript, null);
  });

  it("no session id at all recovers nothing, and says which", () => {
    assert.equal(recoverFromClaudeTranscript(null, root).notes.reason, "no-session-id");
    assert.equal(recoverFromClaudeTranscript("", root).notes.reason, "no-session-id");
  });

  it("a missing projects root is a normal outcome, not an error", () => {
    const recovered = recoverFromClaudeTranscript("sess-1", path.join(root, "nope", "gone"));
    assert.equal(recovered.text, "");
    assert.equal(recovered.notes.reason, "transcript-not-found");
  });

  it("a path-shaped session id is refused rather than followed out of the root", () => {
    assert.equal(findClaudeTranscript("../../etc/passwd", root), null);
    assert.equal(findClaudeTranscript("sub/dir/sess-1", root), null);
  });

  it("a malformed line costs that line only", () => {
    writeTranscript("-p", "sess-1", [
      assistantRecord("u1", [{ type: "text", text: "before" }]),
      '{"type":"assistant","message":{"content":[{"type":"text","text":"trunc',
      assistantRecord("u2", [{ type: "text", text: "after" }]),
    ]);

    const recovered = recoverFromClaudeTranscript("sess-1", root);
    assert.equal(recovered.text, "before\nafter");
    assert.equal(recovered.notes.malformed, 1);
  });

  it("an empty transcript, and records of unknown shape, recover nothing without throwing", () => {
    writeTranscript("-p", "sess-empty", []);
    assert.equal(recoverFromClaudeTranscript("sess-empty", root).text, "");

    writeTranscript("-p", "sess-odd", [
      { type: "assistant" },
      { type: "assistant", message: { content: "a bare string body" } },
      { type: "system", subtype: "init" },
      42,
    ]);
    const odd = recoverFromClaudeTranscript("sess-odd", root);
    assert.equal(odd.text, "a bare string body");
    assert.equal(odd.notes.malformed, 1);
  });
});

// =========================================================================
// the interface — one shape, source selected by backend
// =========================================================================

describe("resolveCompletedResult", () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-resolve-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeEvents(lines) {
    const file = path.join(dir, "events.ndjson");
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
    return file;
  }

  const withOutput = [
    messageUpdated("msg_a", "assistant"),
    partDelta("prt_1", "half-finished analysis"),
  ];

  it("a final message wins: byte-identical result, and no source is read", () => {
    let recoverCalls = 0;
    const sources = {
      opencode: { name: "spy", describe: "spy", recover: () => { recoverCalls += 1; return { text: "recovered", notes: {} }; } },
    };

    const resolved = resolveCompletedResult({
      backend: "opencode",
      fetched: { ok: true, text: "the model's final answer" },
      coords: { eventsPath: writeEvents(withOutput) },
      sources,
    });

    assert.equal(resolved.text, "the model's final answer");
    assert.equal(recoverCalls, 0, "recovery must not run when a final message exists");
    assert.equal(resolved.record.source, "final-message");
    assert.equal(resolved.record.recovered, false);
    assert.equal(resolved.record.fetchFailed, false);
  });

  it("no final message: the opencode source recovers, and the result is marked", () => {
    const resolved = resolveCompletedResult({
      backend: "opencode",
      fetched: { ok: true, text: "" },
      coords: { eventsPath: writeEvents(withOutput) },
    });

    assert.ok(resolved.text.startsWith(RECOVERED_RESULT_MARKER), "a recovered result is identifiable as recovered");
    assert.ok(resolved.text.endsWith("half-finished analysis"));
    assert.equal(resolved.record.recovered, true);
    assert.equal(resolved.record.source, "recovered");
    assert.equal(resolved.record.recovery.source, "opencode-events");
    assert.equal(resolved.record.recovery.chars, "half-finished analysis".length);
    assert.equal(resolved.record.fetchFailed, false);
  });

  it("no final message: the claude source recovers from the transcript, by session id", () => {
    const root = path.join(dir, "projects");
    fs.mkdirSync(path.join(root, "-home-masuda-kusabi"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "-home-masuda-kusabi", "sess-9.jsonl"),
      JSON.stringify(assistantRecord("u1", [{ type: "text", text: "25,477 characters of review" }])) + "\n",
      "utf8",
    );

    const resolved = resolveCompletedResult({
      backend: "claude",
      fetched: { ok: true, text: "" },
      coords: { sessionId: "sess-9", claudeProjectsRoot: root },
    });

    assert.ok(resolved.text.startsWith(RECOVERED_RESULT_MARKER));
    assert.ok(resolved.text.endsWith("25,477 characters of review"));
    assert.equal(resolved.record.recovery.source, "claude-transcript");
    assert.equal(resolved.record.recovered, true);
  });

  it("a fetch failure is distinguishable from a genuinely absent message", () => {
    const eventsPath = path.join(dir, "events.ndjson");
    fs.writeFileSync(eventsPath, "", "utf8");

    const broken = resolveCompletedResult({
      backend: "opencode",
      fetched: { ok: false, error: "connect ECONNREFUSED 127.0.0.1:4096" },
      coords: { eventsPath },
    });
    assert.equal(broken.text, "");
    assert.equal(broken.record.source, "unavailable");
    assert.equal(broken.record.fetchFailed, true);
    assert.equal(broken.record.fetchError, "connect ECONNREFUSED 127.0.0.1:4096");

    const silent = resolveCompletedResult({
      backend: "opencode",
      fetched: { ok: true, text: "" },
      coords: { eventsPath },
    });
    assert.equal(silent.text, "");
    assert.equal(silent.record.source, "none");
    assert.equal(silent.record.fetchFailed, false);
    assert.equal(silent.record.fetchError, null);

    assert.notEqual(broken.record.source, silent.record.source);
  });

  it("a fetch failure still recovers, and the record keeps the failure", () => {
    const resolved = resolveCompletedResult({
      backend: "opencode",
      fetched: { ok: false, error: "socket hang up" },
      coords: { eventsPath: writeEvents(withOutput) },
    });

    assert.ok(resolved.text.endsWith("half-finished analysis"));
    assert.equal(resolved.record.recovered, true);
    assert.equal(resolved.record.fetchFailed, true);
    assert.equal(resolved.record.fetchError, "socket hang up");
  });

  it("an unknown backend recovers nothing instead of throwing", () => {
    const resolved = resolveCompletedResult({
      backend: "some-future-backend",
      fetched: { ok: true, text: "" },
      coords: {},
    });
    assert.equal(resolved.text, "");
    assert.equal(resolved.record.source, "none");
    assert.equal(resolved.record.recovery.reason, "no-recovery-source-for-backend");
  });

  it("a source that throws does not fail the dispatch", () => {
    const sources = {
      opencode: {
        name: "explodes",
        describe: "a source that throws",
        recover: () => { throw new Error("unexpected shape"); },
      },
    };
    const resolved = resolveCompletedResult({
      backend: "opencode",
      fetched: { ok: true, text: "" },
      coords: {},
      sources,
    });
    assert.equal(resolved.text, "");
    assert.equal(resolved.record.recovery.reason, "recovery-threw");
    assert.match(resolved.record.recovery.error, /unexpected shape/);
  });

  it("both backends are served by the one interface, in one shape", () => {
    assert.deepEqual(Object.keys(RECOVERY_SOURCES).sort(), ["claude", "opencode"]);
    for (const source of Object.values(RECOVERY_SOURCES)) {
      assert.equal(typeof source.recover, "function");
      assert.equal(typeof source.describe, "string");
    }
  });

  it("the banner does not disturb verdict extraction from a recovered review", () => {
    const verdict = '{"verdict":"needs-attention","findings":[]}';
    const marked = markRecovered(`Here is the review:\n${verdict}`, "the event stream");
    assert.deepEqual(extractJson(marked), { verdict: "needs-attention", findings: [] });
  });
});

// =========================================================================
// claudeFinalMessage — the two ways a final message can be absent
// =========================================================================

describe("claudeFinalMessage", () => {
  it("a result string is the final message, empty or not", () => {
    assert.deepEqual(claudeFinalMessage({ result: "done" }), { ok: true, text: "done" });
    assert.deepEqual(claudeFinalMessage({ result: "" }), { ok: true, text: "" });
  });

  it("a non-string result keeps its long-standing JSON rendering", () => {
    assert.deepEqual(claudeFinalMessage({ result: { a: 1 } }), { ok: true, text: '{"a":1}' });
  });

  it("a missing result field is a failure to read, not an absent message", () => {
    assert.equal(claudeFinalMessage({}).ok, false);
    assert.equal(claudeFinalMessage(null).ok, false);
  });
});

// =========================================================================
// integration — claudeDispatch writes a recovered result.md (fake `claude`)
// =========================================================================

const FAKE_CLAUDE_SOURCE = `#!/usr/bin/env node
import fs from "node:fs";
fs.readFileSync(0, "utf8");
process.stdout.write(JSON.stringify({
  type: "result",
  is_error: false,
  result: process.env.FAKE_CLAUDE_RESULT || "",
  session_id: process.env.FAKE_CLAUDE_SESSION,
  usage: { input_tokens: 1000, output_tokens: 500 },
  total_cost_usd: 0.1,
  duration_ms: 10,
  num_turns: 1,
}));
`;

function claudeContext() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-recover-dispatch-"));
  const binPath = path.join(tmp, "fake-claude.mjs");
  fs.writeFileSync(binPath, FAKE_CLAUDE_SOURCE, "utf8");
  fs.chmodSync(binPath, 0o755);

  const cwd = path.join(tmp, "cwd");
  fs.mkdirSync(cwd, { recursive: true });

  const mcpSource = path.join(tmp, "claude.json");
  fs.writeFileSync(mcpSource, JSON.stringify({ mcpServers: { sunaba: { command: "echo" } } }), "utf8");

  const projects = path.join(tmp, "projects", "-home-masuda-kusabi");
  fs.mkdirSync(projects, { recursive: true });

  const saved = {
    CLAUDE_BIN: process.env.CLAUDE_BIN,
    KUSABI_STATE_DIR: process.env.KUSABI_STATE_DIR,
    KUSABI_CLAUDE_MCP_SOURCE: process.env.KUSABI_CLAUDE_MCP_SOURCE,
    KUSABI_CLAUDE_PROJECTS_DIR: process.env.KUSABI_CLAUDE_PROJECTS_DIR,
    FAKE_CLAUDE_RESULT: process.env.FAKE_CLAUDE_RESULT,
    FAKE_CLAUDE_SESSION: process.env.FAKE_CLAUDE_SESSION,
  };
  process.env.CLAUDE_BIN = binPath;
  process.env.KUSABI_STATE_DIR = path.join(tmp, "state");
  process.env.KUSABI_CLAUDE_MCP_SOURCE = mcpSource;
  process.env.KUSABI_CLAUDE_PROJECTS_DIR = path.join(tmp, "projects");
  process.env.FAKE_CLAUDE_SESSION = "sess-recovered-1";

  return {
    tmp,
    cwd,
    stateDir: stateDirFor(cwd),
    /** Lay down the transcript the CLI would have written for this session. */
    writeTranscript(text) {
      fs.writeFileSync(
        path.join(projects, "sess-recovered-1.jsonl"),
        [
          JSON.stringify(userRecord("u0", "the brief the worker was given")),
          JSON.stringify(assistantRecord("u1", [{ type: "text", text }])),
        ].join("\n") + "\n",
        "utf8",
      );
    },
    options() {
      return {
        cwd,
        kind: "task",
        title: "recovery integration",
        promptText: "Do the thing.",
        agent: "kusabi-implement",
        phase: null,
        tools: null,
        timeoutS: 30,
        watchdogS: 900,
        tiers: [["opus"]],
        round: 1,
        explicitModel: null,
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

describe("claudeDispatch — result recovery", () => {
  let ctx;

  beforeEach(() => {
    ctx = claudeContext();
  });

  afterEach(() => {
    ctx.restore();
  });

  it("a completed job with no final message gets result.md from its transcript", async () => {
    ctx.writeTranscript("The review, cut off mid-sen");
    process.env.FAKE_CLAUDE_RESULT = "";

    const { job, resultText, stateDir } = await claudeDispatch(ctx.options());

    assert.equal(job.status, "completed");
    assert.equal(job.sessionID, "sess-recovered-1");

    const written = fs.readFileSync(path.join(jobDir(stateDir, job.id), "result.md"), "utf8");
    assert.equal(written, resultText);
    assert.ok(written.startsWith(RECOVERED_RESULT_MARKER), "the written result is marked as recovered");
    assert.ok(written.endsWith("The review, cut off mid-sen"));
    assert.ok(!written.includes("the brief the worker was given"), "the prompt must not be in the result");

    const persisted = loadJob(stateDir, job.id);
    assert.equal(persisted.result.recovered, true);
    assert.equal(persisted.result.source, "recovered");
    assert.equal(persisted.result.recovery.source, "claude-transcript");
    assert.equal(persisted.result.fetchFailed, false);

    const events = fs.readFileSync(path.join(jobDir(stateDir, job.id), "events.ndjson"), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l));
    const recoveredEvent = events.find((e) => e.type === "companion.result.recovered");
    assert.ok(recoveredEvent, "the recovery is on the audit trail");
    assert.equal(recoveredEvent.chars, "The review, cut off mid-sen".length);
  });

  it("a job that does have a final message is untouched by any of this", async () => {
    ctx.writeTranscript("earlier turn text that must NOT be used");
    process.env.FAKE_CLAUDE_RESULT = "implemented the thing per the brief";

    const { job, resultText, stateDir } = await claudeDispatch(ctx.options());

    assert.equal(resultText, "implemented the thing per the brief");
    assert.equal(
      fs.readFileSync(path.join(jobDir(stateDir, job.id), "result.md"), "utf8"),
      "implemented the thing per the brief",
    );

    const persisted = loadJob(stateDir, job.id);
    assert.equal(persisted.result.source, "final-message");
    assert.equal(persisted.result.recovered, false);
    assert.equal(persisted.result.recovery, null);
    assert.equal(job.status, "completed");
  });

  it("no final message and no transcript leaves an empty result, marked as such", async () => {
    process.env.FAKE_CLAUDE_RESULT = "";

    const { job, resultText, stateDir } = await claudeDispatch(ctx.options());

    assert.equal(resultText, "");
    assert.equal(fs.readFileSync(path.join(jobDir(stateDir, job.id), "result.md"), "utf8"), "");
    const persisted = loadJob(stateDir, job.id);
    assert.equal(persisted.result.source, "none");
    assert.equal(persisted.result.recovered, false);
    assert.equal(persisted.result.recovery.reason, "transcript-not-found");
  });
});
