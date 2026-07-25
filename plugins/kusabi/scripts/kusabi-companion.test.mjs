import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  newestChainDir,
  PHASE_AGENTS,
  loadConfig,
  readBriefFile,
  cwdSlug,
  findTranscriptFile,
  extractAssistantText,
  resolveExplainPassage,
  __testProbeBindings,
} from "./kusabi-companion.mjs";
import {
  parseOrchestratorSignature,
} from "./brief-parsing.mjs";
import {
  makeRecord,
  textBlock,
  toolUseBlock,
  toolResultBlock,
  thinkingBlock,
} from "./fixtures.mjs";

// newestChainDir — chain directory selection by mtime
// ---------------------------------------------------------------------------

describe("newestChainDir", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-chaindir-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the newest chain dir by mtime", () => {
    const oldDir = path.join(tmpDir, "chain-old");
    const newDir = path.join(tmpDir, "chain-new");
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(newDir, { recursive: true });
    const oldTime = new Date("2020-01-01").getTime();
    fs.utimesSync(oldDir, oldTime / 1000, oldTime / 1000);
    const result = newestChainDir(tmpDir);
    assert.equal(result, "chain-new");
  });

  it("returns null when chainsDir does not exist", () => {
    const result = newestChainDir(path.join(tmpDir, "nonexistent"));
    assert.equal(result, null);
  });

  it("returns null when no chain-* directories exist", () => {
    fs.mkdirSync(path.join(tmpDir, "some-other-dir"), { recursive: true });
    const result = newestChainDir(tmpDir);
    assert.equal(result, null);
  });

  it("returns null for empty directory", () => {
    const result = newestChainDir(tmpDir);
    assert.equal(result, null);
  });

  it("only matches chain-* directories", () => {
    fs.mkdirSync(path.join(tmpDir, "not_a_chain_dir"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "chain-real"), { recursive: true });
    const result = newestChainDir(tmpDir);
    assert.equal(result, "chain-real");
  });

  it("picks newest among multiple chain dirs", () => {
    const c1 = path.join(tmpDir, "chain-001");
    const c2 = path.join(tmpDir, "chain-002");
    const c3 = path.join(tmpDir, "chain-003");
    fs.mkdirSync(c1, { recursive: true });
    fs.mkdirSync(c2, { recursive: true });
    fs.mkdirSync(c3, { recursive: true });
    const t1 = new Date("2020-06-01").getTime();
    const t2 = new Date("2020-06-02").getTime();
    const t3 = new Date("2020-06-03").getTime();
    fs.utimesSync(c1, t1 / 1000, t1 / 1000);
    fs.utimesSync(c2, t2 / 1000, t2 / 1000);
    fs.utimesSync(c3, t3 / 1000, t3 / 1000);
    const result = newestChainDir(tmpDir);
    assert.equal(result, "chain-003");
  });

  it("uses lexicographic tiebreaker when mtimes are identical", () => {
    const cA = path.join(tmpDir, "chain-aaa");
    const cB = path.join(tmpDir, "chain-bbb");
    fs.mkdirSync(cA, { recursive: true });
    fs.mkdirSync(cB, { recursive: true });
    const sameTime = new Date("2020-01-01").getTime();
    fs.utimesSync(cA, sameTime / 1000, sameTime / 1000);
    fs.utimesSync(cB, sameTime / 1000, sameTime / 1000);
    const result = newestChainDir(tmpDir);
    // Both have same mtime, "chain-aaa" sorts before "chain-bbb" lexicographically
    assert.equal(result, "chain-aaa");
  });
});

// loadConfig — config file loading
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  /** @type {string} */
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-loadConfig-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no config file exists", () => {
    const result = loadConfig(tmpDir);
    assert.equal(result, null);
  });

  it("returns parsed config when valid JSON with models.chain exists", () => {
    const config = {
      models: {
        chain: ["opencode-go/deepseek-v4-flash", "opencode-go/deepseek-v4-pro"],
      },
    };
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify(config), "utf8");
    const result = loadConfig(tmpDir);
    assert.deepEqual(result, config);
  });

  it("returns parsed config when valid JSON with models.phases exists", () => {
    const config = {
      models: {
        phases: { implement: ["opencode-go/deepseek-v4-flash"] },
      },
    };
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify(config), "utf8");
    const result = loadConfig(tmpDir);
    assert.deepEqual(result, config);
  });

  it("returns parsed config when models key is absent", () => {
    const config = { unrelated: true };
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify(config), "utf8");
    const result = loadConfig(tmpDir);
    assert.deepEqual(result, config);
  });

  it("throws on malformed JSON (unparseable)", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), "not json at all", "utf8");
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes(path.join(tmpDir, "config.json")), "error must mention file path");
        assert.ok(err.message.includes("not valid JSON"), "error must mention invalid JSON");
        return true;
      },
    );
  });

  it("throws on null JSON value", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), "null", "utf8");
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes("must contain a JSON object"));
        return true;
      },
    );
  });

  it("throws on array JSON value", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), "[]", "utf8");
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes("must contain a JSON object"));
        return true;
      },
    );
  });

  it("throws when models is not an object", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({ models: "string" }), "utf8");
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes('"models" must be a JSON object'));
        return true;
      },
    );
  });

  it("throws when models.chain is not an array of strings", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({ models: { chain: "not-array" } }), "utf8");
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes('"models.chain" must be an array'));
        return true;
      },
    );
  });

  it("throws when models.chain is an empty array (must not silently drop built-in defaults)", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({ models: { chain: [] } }), "utf8");
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes('"models.chain" must not be empty'));
        return true;
      },
    );
  });

  it("throws when a models.phases entry is an empty array", () => {
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({ models: { phases: { implement: [] } } }),
      "utf8",
    );
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes('"models.phases.implement" must not be empty'));
        return true;
      },
    );
  });

  it("throws when models.phases.phase is not an array of strings", () => {
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({ models: { phases: { implement: "not-array" } } }),
      "utf8",
    );
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes('"models.phases.implement" must be an array'));
        return true;
      },
    );
  });

  it("throws when models.phases is not an object", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({ models: { phases: "string" } }), "utf8");
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes('"models.phases" must be a JSON object'));
        return true;
      },
    );
  });
});

// readBriefFile — brief-file runtime error paths
// ---------------------------------------------------------------------------

describe("readBriefFile", () => {
  it("returns inline text when no --brief-file flag", () => {
    const result = readBriefFile({}, "hello world");
    assert.equal(result, "hello world");
  });

  it("throws when --brief-file and inline text are both provided", () => {
    assert.throws(
      () => readBriefFile({ "brief-file": "/tmp/x.md" }, "inline text"),
      /--brief-file and inline text are mutually exclusive/,
    );
  });

  it("throws when --brief-file points to a missing file", () => {
    assert.throws(
      () => readBriefFile({ "brief-file": "/nonexistent/path/brief.md" }, ""),
      (err) => {
        assert.ok(err.message.includes("--brief-file: cannot read"));
        assert.ok(err.message.includes("/nonexistent/path/brief.md"));
        return true;
      },
    );
  });

  it("returns file content when --brief-file points to a valid file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-brief-"));
    try {
      const filePath = path.join(tmpDir, "brief.md");
      fs.writeFileSync(filePath, "file content here", "utf8");
      const result = readBriefFile({ "brief-file": filePath }, "");
      assert.equal(result, "file content here");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// cwdSlug — path-to-slug conversion
// ---------------------------------------------------------------------------

describe("cwdSlug", () => {
  it("replaces / and . with -", () => {
    assert.equal(cwdSlug("/home/u/dev/x"), "-home-u-dev-x");
  });

  it("handles a path with dots", () => {
    assert.equal(cwdSlug("/home/u/dev/my.project"), "-home-u-dev-my-project");
  });

  it("handles root path", () => {
    assert.equal(cwdSlug("/"), "-");
  });

  it("handles empty string", () => {
    assert.equal(cwdSlug(""), "");
  });

  it("handles path with trailing slash", () => {
    assert.equal(cwdSlug("/home/user/"), "-home-user-");
  });
});

// findTranscriptFile — newest *.jsonl in the slug dir
// ---------------------------------------------------------------------------

describe("findTranscriptFile", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-transcript-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when the slug dir does not exist", () => {
    const result = findTranscriptFile({ baseDir: tmpDir, cwdSlug: "nonexistent-slug" });
    assert.equal(result, null);
  });

  it("returns null when the slug dir has no .jsonl files", () => {
    const slugDir = path.join(tmpDir, "-home-test");
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, "foo.txt"), "not a transcript", "utf8");
    const result = findTranscriptFile({ baseDir: tmpDir, cwdSlug: "-home-test" });
    assert.equal(result, null);
  });

  it("returns the only .jsonl file", () => {
    const slugDir = path.join(tmpDir, "-home-test");
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, "transcript.jsonl"), "{}", "utf8");
    const result = findTranscriptFile({ baseDir: tmpDir, cwdSlug: "-home-test" });
    assert.ok(result.endsWith("transcript.jsonl"));
  });

  it("returns the newest .jsonl when multiple exist", () => {
    const slugDir = path.join(tmpDir, "-home-test");
    fs.mkdirSync(slugDir, { recursive: true });
    // Write an older file first
    fs.writeFileSync(path.join(slugDir, "old.jsonl"), "{}", "utf8");
    const oldMtime = Date.now() - 60000;
    fs.utimesSync(path.join(slugDir, "old.jsonl"), new Date(oldMtime / 1000), new Date(oldMtime / 1000));
    // Write a newer file
    fs.writeFileSync(path.join(slugDir, "new.jsonl"), "{}", "utf8");
    const result = findTranscriptFile({ baseDir: tmpDir, cwdSlug: "-home-test" });
    assert.ok(result.endsWith("new.jsonl"), `expected new.jsonl, got ${result}`);
  });

  it("skips subdirectories and non-jsonl files", () => {
    const slugDir = path.join(tmpDir, "-home-test");
    fs.mkdirSync(path.join(slugDir, "subdir"), { recursive: true });
    fs.writeFileSync(path.join(slugDir, "transcript.jsonl"), "{}", "utf8");
    fs.writeFileSync(path.join(slugDir, "notes.txt"), "hello", "utf8");
    const result = findTranscriptFile({ baseDir: tmpDir, cwdSlug: "-home-test" });
    assert.equal(result, path.join(slugDir, "transcript.jsonl"));
  });

  it("uses filename tiebreak when multiple .jsonl files have the same mtime", () => {
    const slugDir = path.join(tmpDir, "-home-tiebreak");
    fs.mkdirSync(slugDir, { recursive: true });
    const sameTime = new Date(Date.now() - 10000);
    const a = path.join(slugDir, "z-first.jsonl");
    const b = path.join(slugDir, "a-second.jsonl");
    fs.writeFileSync(a, "{}", "utf8");
    fs.writeFileSync(b, "{}", "utf8");
    fs.utimesSync(a, sameTime, sameTime);
    fs.utimesSync(b, sameTime, sameTime);
    const result = findTranscriptFile({ baseDir: tmpDir, cwdSlug: "-home-tiebreak" });
    // "a-second.jsonl" sorts before "z-first.jsonl" lexicographically
    assert.ok(result.endsWith("a-second.jsonl"), `expected a-second.jsonl, got ${result}`);
  });
});

// extractAssistantText — text-block extraction from transcript records
// ---------------------------------------------------------------------------


describe("extractAssistantText", () => {
  it("returns empty string for empty records", () => {
    assert.equal(extractAssistantText([]), "");
  });

  it("returns empty string when no assistant records exist", () => {
    const records = [
      makeRecord("user", [textBlock("hello")]),
      makeRecord("user", [textBlock("world")]),
    ];
    assert.equal(extractAssistantText(records), "");
  });

  it("extracts last assistant text block (default lastN=1)", () => {
    const records = [
      makeRecord("user", [textBlock("question 1")]),
      makeRecord("assistant", [textBlock("answer 1")]),
      makeRecord("user", [textBlock("question 2")]),
      makeRecord("assistant", [textBlock("answer 2"), toolUseBlock("bash", {})]),
    ];
    const result = extractAssistantText(records);
    // Should only include the last assistant's text block, skipping tool_use
    assert.equal(result, "answer 2");
  });

  it("excludes tool_use, tool_result, and thinking blocks by default", () => {
    const records = [
      makeRecord("assistant", [
        textBlock("only text"),
        toolUseBlock("bash", { cmd: "ls" }),
        toolResultBlock("file1\nfile2"),
        thinkingBlock("I should list files"),
      ]),
    ];
    const result = extractAssistantText(records);
    assert.equal(result, "only text");
  });

  it("includes tool_result blocks when includeTools is true", () => {
    const records = [
      makeRecord("assistant", [
        textBlock("running ls"),
        toolUseBlock("bash", { cmd: "ls" }),
        toolResultBlock("file1\nfile2"),
        thinkingBlock("done"),
      ]),
    ];
    const result = extractAssistantText(records, { includeTools: true });
    assert.ok(result.includes("running ls"));
    assert.ok(result.includes("file1\nfile2"));
    // tool_use and thinking still excluded
    assert.ok(!result.includes("bash"));
    assert.ok(!result.includes("done"));
  });

  it("skips trailing tool_use-only assistant records (in-progress turn)", () => {
    const records = [
      makeRecord("assistant", [textBlock("the actual last message")]),
      makeRecord("user", [{ type: "tool_result", content: "output" }]),
      makeRecord("assistant", [toolUseBlock("bash", { cmd: "ls" })]),
      makeRecord("assistant", [toolUseBlock("read", { file: "x" })]),
    ];
    assert.equal(extractAssistantText(records), "the actual last message");
  });

  it("reads tool_result payloads in the real transcript shape (content array / string)", () => {
    const records = [
      makeRecord("assistant", [textBlock("checking output")]),
      makeRecord("user", [
        { type: "tool_result", content: [{ type: "text", text: "array shaped" }] },
        { type: "tool_result", content: "string shaped" },
      ]),
    ];
    assert.equal(extractAssistantText(records), "checking output");
    const widened = extractAssistantText(records, { includeTools: true });
    assert.ok(widened.includes("array shaped"));
    assert.ok(widened.includes("string shaped"));
  });

  it("includes multiple assistant messages with --last N", () => {
    const records = [
      makeRecord("user", [textBlock("q1")]),
      makeRecord("assistant", [textBlock("a1")]),
      makeRecord("user", [textBlock("q2")]),
      makeRecord("assistant", [textBlock("a2")]),
    ];
    const result = extractAssistantText(records, { lastN: 2 });
    // Should include both a1 and a2 (and interleaved user messages)
    assert.ok(result.includes("a1"));
    assert.ok(result.includes("a2"));
    // Should also include user messages between them
    assert.ok(result.includes("q2"));
  });

  it("--last N with includeTools widens context to include tool results across N messages", () => {
    const records = [
      makeRecord("assistant", [textBlock("first answer")]),
      makeRecord("user", [textBlock("follow-up")]),
      makeRecord("assistant", [
        textBlock("second answer"),
        toolUseBlock("bash", {}),
        toolResultBlock("output data"),
      ]),
    ];
    const result = extractAssistantText(records, { lastN: 2, includeTools: true });
    assert.ok(result.includes("first answer"));
    assert.ok(result.includes("follow-up"));
    assert.ok(result.includes("second answer"));
    assert.ok(result.includes("output data"));
  });

  it("handles records without message.content gracefully", () => {
    const records = [
      { type: "assistant" },
      { type: "assistant", message: {} },
      { type: "assistant", message: { content: [textBlock("valid")] } },
    ];
    const result = extractAssistantText(records);
    assert.equal(result, "valid");
  });

  it("extracts inline assistant text from typescript fixture records", () => {
    // Simulate a realistic mini transcript
    const records = [
      { type: "user", message: { content: [{ type: "text", text: "hello" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "hi there" }] } },
      { type: "user", message: { content: [{ type: "text", text: "explain this code" }] } },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "The code does X." },
            { type: "tool_use", name: "bash", input: {} },
            { type: "tool_result", text: "output" },
          ],
        },
      },
    ];
    // Default: last assistant only, no tools
    const defaultResult = extractAssistantText(records);
    assert.equal(defaultResult, "The code does X.");
    // With includeTools
    const toolsResult = extractAssistantText(records, { includeTools: true });
    assert.ok(toolsResult.includes("The code does X."));
    assert.ok(toolsResult.includes("output"));
    // With --last 2
    const last2 = extractAssistantText(records, { lastN: 2 });
    assert.ok(last2.includes("hi there"));
    assert.ok(last2.includes("explain this code"));
    assert.ok(last2.includes("The code does X."));
  });
});

// ---------------------------------------------------------------------------
// resolveExplainPassage — passage resolution (quote bypass, transcript error)
// ---------------------------------------------------------------------------

describe("resolveExplainPassage", () => {
  let tmpBase;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-explain-"));
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  function writeTranscript(slug, records) {
    const slugDir = path.join(tmpBase, slug);
    fs.mkdirSync(slugDir, { recursive: true });
    const file = path.join(slugDir, "session.jsonl");
    fs.writeFileSync(file, records.map(function (r) { return JSON.stringify(r); }).join("\n"), "utf8");
    return file;
  }

  it("returns the explicit quote and skips transcript resolution", () => {
    const result = resolveExplainPassage({
      baseDir: tmpBase,
      cwd: "/home/user/project",
      quote: "This is an explicit passage.",
      last: 1,
    });
    assert.equal(result.passage, "This is an explicit passage.");
    assert.equal(result.source, "quote");
    // quote works even when there is no transcript dir at all
  });

  it("rejects an empty --quote instead of sending an empty prompt", () => {
    for (const empty of ["", "   "]) {
      assert.throws(
        () => resolveExplainPassage({
          baseDir: tmpBase,
          cwd: "/home/user/project",
          quote: empty,
          last: 1,
        }),
        /--quote must not be empty/,
      );
    }
  });

  it("throws when the slug dir does not exist", () => {
    assert.throws(
      () => resolveExplainPassage({
        baseDir: tmpBase,
        cwd: "/home/nonexistent",
        last: 1,
      }),
      /No Claude Code transcript found/,
    );
  });

  it("throws when the transcript file is malformed JSONL", () => {
    const slugDir = path.join(tmpBase, "-home-bad");
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, "bad.jsonl"), "not valid json", "utf8");
    assert.throws(
      () => resolveExplainPassage({
        baseDir: tmpBase,
        cwd: "/home/bad",
        last: 1,
      }),
      /Failed to read transcript/,
    );
  });

  it("throws when the transcript is empty", () => {
    const slugDir = path.join(tmpBase, "-home-empty");
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, "empty.jsonl"), "", "utf8");
    assert.throws(
      () => resolveExplainPassage({
        baseDir: tmpBase,
        cwd: "/home/empty",
        last: 1,
      }),
      /is empty/,
    );
  });

  it("throws when the transcript has no assistant records", () => {
    const records = [
      { type: "user", message: { content: [{ type: "text", text: "hello" }] } },
    ];
    writeTranscript("-home-no-assistant", records);
    assert.throws(
      () => resolveExplainPassage({
        baseDir: tmpBase,
        cwd: "/home/no-assistant",
        last: 1,
      }),
      /No assistant text found/,
    );
  });

  it("extracts the last assistant text passage from a valid transcript", () => {
    const records = [
      { type: "user", message: { content: [{ type: "text", text: "help" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "I can explain this." }] } },
    ];
    writeTranscript("-home-valid", records);
    const result = resolveExplainPassage({
      baseDir: tmpBase,
      cwd: "/home/valid",
      last: 1,
    });
    assert.equal(result.passage, "I can explain this.");
    assert.equal(result.source, "transcript");
  });

  it("passes lastN and includeTools through to extractAssistantText", () => {
    const records = [
      { type: "assistant", message: { content: [
        { type: "text", text: "answer one" },
        { type: "tool_result", text: "tool output" },
      ] } },
    ];
    writeTranscript("-home-tools-test", records);
    const result = resolveExplainPassage({
      baseDir: tmpBase,
      cwd: "/home/tools-test",
      last: 1,
      tools: true,
    });
    assert.equal(result.source, "transcript");
    assert.ok(result.passage.includes("answer one"));
    assert.ok(result.passage.includes("tool output"));
  });

  it("throws on --last 0 (positive integer required)", () => {
    assert.throws(
      () => resolveExplainPassage({ baseDir: tmpBase, cwd: "/tmp/x", last: 0 }),
      /--last must be a positive integer/,
    );
  });

  it("throws on --last -1 (positive integer required)", () => {
    assert.throws(
      () => resolveExplainPassage({ baseDir: tmpBase, cwd: "/tmp/x", last: -1 }),
      /--last must be a positive integer/,
    );
  });

  it("throws on --last NaN (positive integer required)", () => {
    assert.throws(
      () => resolveExplainPassage({ baseDir: tmpBase, cwd: "/tmp/x", last: NaN }),
      /--last must be a positive integer/,
    );
  });

  it("throws on --last 3.5 (non-integer)", () => {
    assert.throws(
      () => resolveExplainPassage({ baseDir: tmpBase, cwd: "/tmp/x", last: 3.5 }),
      /--last must be a positive integer/,
    );
  });

  it("throws on --last Infinity", () => {
    assert.throws(
      () => resolveExplainPassage({ baseDir: tmpBase, cwd: "/tmp/x", last: Infinity }),
      /--last must be a positive integer/,
    );
  });
});

// orchestrator recording (acceptance criteria 1 & 2)
// ---------------------------------------------------------------------------

describe("orchestrator recording", () => {
  it("produces orchestrator data when brief has a signature (criterion 1)", () => {
    const brief = "Orchestrator: claude-fable-5 | session dfbdc7dc | 2026-07-22\n\nImplement the feature.";
    const text = readBriefFile({}, brief);
    const orchestrator = parseOrchestratorSignature(text);
    // Simulate what cmdTask does: store orchestrator on the job record
    const job = {
      id: "job-123",
      kind: "task",
      title: text.slice(0, 80),
      status: "completed",
      orchestrator: orchestrator,
    };
    assert.deepEqual(job.orchestrator, {
      model: "claude-fable-5",
      session: "dfbdc7dc",
      date: "2026-07-22",
    });
  });

  it("produces null orchestrator when brief has no signature (criterion 2)", () => {
    const brief = "Just a normal brief with no orchestrator line.\n\nDo the work.";
    const text = readBriefFile({}, brief);
    const orchestrator = parseOrchestratorSignature(text);
    // Simulate what cmdTask does: orchestrator is null, job has no field or null
    const job = {
      id: "job-456",
      kind: "task",
      title: text.slice(0, 80),
      status: "completed",
      orchestrator: orchestrator,
    };
    assert.equal(job.orchestrator, null);
  });

  it("readBriefFile with --brief-file flag is not needed for inline briefs", () => {
    const brief = "Orchestrator: gpt-4 | session abc123 | 2026-01-01\n\nTask description";
    const text = readBriefFile({}, brief);
    const orchestrator = parseOrchestratorSignature(text);
    assert.deepEqual(orchestrator, {
      model: "gpt-4",
      session: "abc123",
      date: "2026-01-01",
    });
  });
});

// cmdTask probe binding regression test
// ---------------------------------------------------------------------------
// Verifies that the probe functions are locally bound in kusabi-companion.mjs
// so cmdTask (internal function, not exported) can call them without
// ReferenceError.  Before the fix, they were only re-exported via
// `export { X } from "..."` which creates NO local binding.

describe("probe function local bindings", () => {
  it("returns 'function' for all four probe bindings (regression: would have been 'undefined' before fix)", () => {
    const bindings = __testProbeBindings();
    assert.equal(bindings.runSmokeProbe, "function");
    assert.equal(bindings.runHeadCleanProbe, "function");
    assert.equal(bindings.runVerifyProbe, "function");
    assert.equal(bindings.runDeliverablesProbe, "function");
  });
});

// PHASE_AGENTS — maps phase names to agent definition filenames
// ---------------------------------------------------------------------------

describe("PHASE_AGENTS", () => {
  it("contains 7 entries", () => {
    assert.equal(Object.keys(PHASE_AGENTS).length, 7);
  });

  it("maps gofer to kusabi-gofer", () => {
    assert.equal(PHASE_AGENTS.gofer, "kusabi-gofer");
  });

  it("maps all known phases", () => {
    assert.equal(PHASE_AGENTS.draft, "kusabi-draft");
    assert.equal(PHASE_AGENTS.investigate, "kusabi-investigate");
    assert.equal(PHASE_AGENTS.implement, "kusabi-implement");
    assert.equal(PHASE_AGENTS.review, "kusabi-review");
    assert.equal(PHASE_AGENTS.respond, "kusabi-respond");
    assert.equal(PHASE_AGENTS.salvage, "kusabi-salvage");
  });

  it("every phase value ends with a .md file in opencode-agents directory", () => {
    const agentsDir = path.resolve(import.meta.dirname, "..", "opencode-agents");
    for (const [, agentName] of Object.entries(PHASE_AGENTS)) {
      const filePath = path.join(agentsDir, `${agentName}.md`);
      assert.ok(fs.existsSync(filePath), `agent file missing: ${filePath}`);
    }
  });
});

