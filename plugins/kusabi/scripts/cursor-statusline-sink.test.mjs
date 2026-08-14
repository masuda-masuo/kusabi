import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  appendUsage,
  cursorUsageDir,
  CURSOR_SESSION_MAX_AGE_MS,
  formatStatus,
  lastNonEmptyLine,
  resolveLatestCursorSession,
  runStatuslineSink,
  stableStringify,
} from "./cursor-statusline-sink.mjs";

const SINK_SCRIPT = path.join(import.meta.dirname, "cursor-statusline-sink.mjs");

const MEASURED_PAYLOAD = {
  session_id: "d73008ab-1111-2222-3333-444444444444",
  transcript_path: "/tmp/transcript.jsonl",
  cwd: "/home/masuda/dev/projects/claude",
  model: { id: "default", display_name: "Auto" },
  context_window: {
    total_input_tokens: 15616,
    total_output_tokens: 29,
    context_window_size: 256000,
    used_percentage: 6.1,
    remaining_percentage: 93.9,
    current_usage: {
      input_tokens: 14999,
      output_tokens: 29,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 512,
    },
  },
};

function collect() {
  const chunks = [];
  const fn = (s) => { chunks.push(s); };
  fn.text = () => chunks.join("");
  return fn;
}

function jsonlRecords(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

describe("cursorUsageDir", () => {
  it("prefers KUSABI_CURSOR_USAGE_DIR over home", () => {
    const dir = cursorUsageDir({ KUSABI_CURSOR_USAGE_DIR: "/tmp/injected-usage" }, "/no/such/home");
    assert.equal(dir, "/tmp/injected-usage");
  });

  it("trims the env override", () => {
    assert.equal(
      cursorUsageDir({ KUSABI_CURSOR_USAGE_DIR: "  /tmp/trimmed  " }, "/home"),
      "/tmp/trimmed",
    );
  });

  it("defaults to $home/.kusabi/cursor-usage when the env is unset", () => {
    assert.equal(
      cursorUsageDir({}, "/injected-home"),
      path.join("/injected-home", ".kusabi", "cursor-usage"),
    );
  });
});

describe("formatStatus", () => {
  it("renders the measured payload as one status line", () => {
    const line = formatStatus(MEASURED_PAYLOAD);
    assert.equal(line, "Auto | 6.1% | last 14999in/29out (cache r512 w0)");
    assert.equal(line.includes("\n"), false);
  });

  it("says warming up when context_window usage is missing (pre-first-API)", () => {
    assert.equal(
      formatStatus({
        ...MEASURED_PAYLOAD,
        context_window: {
          total_input_tokens: null,
          total_output_tokens: null,
          context_window_size: null,
          used_percentage: null,
          remaining_percentage: null,
          current_usage: null,
        },
      }),
      "Auto | warming up",
    );
  });

  it("falls back to Cursor when model is absent", () => {
    assert.equal(formatStatus({ session_id: "x" }), "Cursor | warming up");
  });
});

describe("appendUsage / runStatuslineSink", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-sink-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends {ts, session_id, model, cwd, context_window} and prints one status line", () => {
    const write = collect();
    const frozen = "2026-08-14T10:00:00.000Z";
    const result = runStatuslineSink({
      stdinText: JSON.stringify(MEASURED_PAYLOAD),
      dir: tmpDir,
      now: frozen,
      write,
    });
    assert.equal(result.appended, true);
    assert.equal(write.text(), `${result.status}\n`);
    assert.equal(write.text().endsWith("\n"), true);
    assert.equal(write.text().trim().includes("\n"), false);

    const file = path.join(tmpDir, `${MEASURED_PAYLOAD.session_id}.jsonl`);
    const records = jsonlRecords(file);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0], {
      ts: frozen,
      session_id: MEASURED_PAYLOAD.session_id,
      model: MEASURED_PAYLOAD.model,
      cwd: MEASURED_PAYLOAD.cwd,
      context_window: MEASURED_PAYLOAD.context_window,
    });
  });

  it("does not append when the previous line has an identical context_window", () => {
    const write = collect();
    const first = runStatuslineSink({
      stdinText: JSON.stringify(MEASURED_PAYLOAD),
      dir: tmpDir,
      now: "2026-08-14T10:00:00.000Z",
      write,
    });
    const second = runStatuslineSink({
      stdinText: JSON.stringify(MEASURED_PAYLOAD),
      dir: tmpDir,
      now: "2026-08-14T10:00:05.000Z",
      write,
    });
    assert.equal(first.appended, true);
    assert.equal(second.appended, false);
    const file = path.join(tmpDir, `${MEASURED_PAYLOAD.session_id}.jsonl`);
    assert.equal(jsonlRecords(file).length, 1);
  });

  it("appends again when context_window changes", () => {
    appendUsage(MEASURED_PAYLOAD, { dir: tmpDir, now: "2026-08-14T10:00:00.000Z" });
    const next = {
      ...MEASURED_PAYLOAD,
      context_window: {
        ...MEASURED_PAYLOAD.context_window,
        used_percentage: 7.2,
        current_usage: {
          ...MEASURED_PAYLOAD.context_window.current_usage,
          input_tokens: 16000,
        },
      },
    };
    assert.equal(appendUsage(next, { dir: tmpDir, now: "2026-08-14T10:00:10.000Z" }), true);
    assert.equal(jsonlRecords(path.join(tmpDir, `${MEASURED_PAYLOAD.session_id}.jsonl`)).length, 2);
  });

  it("treats context_window key-order differences as identical (stable stringify)", () => {
    appendUsage(MEASURED_PAYLOAD, { dir: tmpDir, now: "2026-08-14T10:00:00.000Z" });
    const reordered = {
      ...MEASURED_PAYLOAD,
      context_window: {
        current_usage: MEASURED_PAYLOAD.context_window.current_usage,
        remaining_percentage: 93.9,
        used_percentage: 6.1,
        context_window_size: 256000,
        total_output_tokens: 29,
        total_input_tokens: 15616,
      },
    };
    assert.equal(appendUsage(reordered, { dir: tmpDir, now: "2026-08-14T10:00:01.000Z" }), false);
    assert.ok(stableStringify(reordered.context_window) === stableStringify(MEASURED_PAYLOAD.context_window));
  });

  it("does not write a file when session_id is missing, but still prints a status", () => {
    const write = collect();
    const result = runStatuslineSink({
      stdinText: JSON.stringify({ cwd: "/x", model: { display_name: "Auto" } }),
      dir: tmpDir,
      write,
    });
    assert.equal(result.appended, false);
    assert.equal(result.status, "Auto | warming up");
    assert.deepEqual(fs.readdirSync(tmpDir), []);
  });

  it("sanitises path separators in session_id so the file stays inside the dir", () => {
    appendUsage(
      { session_id: "../escape/me", cwd: "/x", context_window: null },
      { dir: tmpDir, now: "2026-08-14T10:00:00.000Z" },
    );
    const names = fs.readdirSync(tmpDir);
    assert.deepEqual(names, [".._escape_me.jsonl"]);
    assert.equal(fs.existsSync(path.join(tmpDir, names[0])), true);
  });

  it("honours KUSABI_CURSOR_USAGE_DIR and never writes under the injected home", () => {
    const home = path.join(tmpDir, "home");
    const usage = path.join(tmpDir, "usage");
    fs.mkdirSync(home);
    const write = collect();
    runStatuslineSink({
      stdinText: JSON.stringify(MEASURED_PAYLOAD),
      env: { KUSABI_CURSOR_USAGE_DIR: usage },
      home,
      now: "2026-08-14T10:00:00.000Z",
      write,
    });
    assert.equal(fs.existsSync(path.join(usage, `${MEASURED_PAYLOAD.session_id}.jsonl`)), true);
    assert.equal(fs.existsSync(path.join(home, ".kusabi")), false);
  });

  it("broken JSON still exits the helper with a one-line error and no throw", () => {
    const write = collect();
    const result = runStatuslineSink({ stdinText: "{not json", dir: tmpDir, write });
    assert.equal(result.status, "statusline error");
    assert.equal(write.text(), "statusline error\n");
    assert.deepEqual(fs.readdirSync(tmpDir), []);
  });

  it("empty stdin, arrays, and null are fail-soft", () => {
    for (const stdinText of ["", "   ", "null", "[]", "0", "\"str\""]) {
      const write = collect();
      const result = runStatuslineSink({ stdinText, dir: tmpDir, write });
      assert.equal(result.status, "statusline error");
      assert.equal(write.text(), "statusline error\n");
    }
    assert.deepEqual(fs.readdirSync(tmpDir), []);
  });

  it("appends after a corrupt last line instead of crashing", () => {
    const file = path.join(tmpDir, `${MEASURED_PAYLOAD.session_id}.jsonl`);
    fs.writeFileSync(file, "not-json\n");
    assert.equal(appendUsage(MEASURED_PAYLOAD, { dir: tmpDir, now: "2026-08-14T10:00:00.000Z" }), true);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(lines[0], "not-json");
  });
});

describe("resolveLatestCursorSession", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-cursor-resolve-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSession(id, rec) {
    fs.writeFileSync(path.join(tmpDir, `${id}.jsonl`), `${JSON.stringify(rec)}\n`);
  }

  const now = Date.parse("2026-08-14T12:00:00.000Z");
  const cwd = "/proj/a";

  it("returns null when the dir does not exist", () => {
    assert.equal(resolveLatestCursorSession({
      dir: path.join(tmpDir, "missing"),
      cwd,
      now,
    }), null);
  });

  it("returns the newest cwd-matching session_id", () => {
    writeSession("old", {
      ts: "2026-08-14T11:00:00.000Z",
      session_id: "old",
      cwd,
      context_window: null,
    });
    writeSession("new", {
      ts: "2026-08-14T11:30:00.000Z",
      session_id: "new",
      cwd,
      context_window: null,
    });
    writeSession("other-proj", {
      ts: "2026-08-14T11:59:00.000Z",
      session_id: "other-proj",
      cwd: "/proj/b",
      context_window: null,
    });
    assert.equal(resolveLatestCursorSession({ dir: tmpDir, cwd, now }), "new");
  });

  it("ignores a cwd mismatch even when that session is the newest", () => {
    writeSession("neighbour", {
      ts: "2026-08-14T11:59:00.000Z",
      session_id: "neighbour",
      cwd: "/proj/other",
      context_window: null,
    });
    assert.equal(resolveLatestCursorSession({ dir: tmpDir, cwd, now }), null);
  });

  it("ignores a last-line ts older than the max-age threshold", () => {
    writeSession("stale", {
      ts: "2026-08-13T11:00:00.000Z",
      session_id: "stale",
      cwd,
      context_window: null,
    });
    assert.equal(resolveLatestCursorSession({
      dir: tmpDir,
      cwd,
      now,
      maxAgeMs: CURSOR_SESSION_MAX_AGE_MS,
    }), null);
    assert.equal(CURSOR_SESSION_MAX_AGE_MS, 24 * 60 * 60 * 1000);
  });

  it("uses the last line, not an earlier one, for cwd and ts", () => {
    const file = path.join(tmpDir, "moved.jsonl");
    const earlier = JSON.stringify({
      ts: "2026-08-14T11:50:00.000Z",
      session_id: "moved",
      cwd,
      context_window: { n: 1 },
    });
    const later = JSON.stringify({
      ts: "2026-08-14T11:55:00.000Z",
      session_id: "moved",
      cwd: "/proj/b",
      context_window: { n: 2 },
    });
    fs.writeFileSync(file, `${earlier}\n${later}\n`);
    assert.equal(resolveLatestCursorSession({ dir: tmpDir, cwd, now }), null);
    assert.equal(resolveLatestCursorSession({ dir: tmpDir, cwd: "/proj/b", now }), "moved");
  });

  it("skips corrupt files and still returns an eligible sibling", () => {
    fs.writeFileSync(path.join(tmpDir, "bad.jsonl"), "not json\n");
    writeSession("ok", {
      ts: "2026-08-14T11:00:00.000Z",
      session_id: "ok",
      cwd,
      context_window: null,
    });
    assert.equal(resolveLatestCursorSession({ dir: tmpDir, cwd, now }), "ok");
  });

  it("lastNonEmptyLine skips trailing blanks", () => {
    assert.equal(lastNonEmptyLine("a\n\n"), "a");
    assert.equal(lastNonEmptyLine(""), null);
  });
});

describe("cursor-statusline-sink CLI", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-sink-cli-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function run(input, extraEnv = {}) {
    return spawnSync(process.execPath, [SINK_SCRIPT], {
      input,
      encoding: "utf8",
      env: { ...process.env, KUSABI_CURSOR_USAGE_DIR: tmpDir, ...extraEnv },
    });
  }

  it("writes one jsonl line, prints one status line, exit 0", () => {
    const result = run(JSON.stringify(MEASURED_PAYLOAD));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "Auto | 6.1% | last 14999in/29out (cache r512 w0)\n");
    const file = path.join(tmpDir, `${MEASURED_PAYLOAD.session_id}.jsonl`);
    assert.equal(jsonlRecords(file).length, 1);
  });

  it("the same payload resent does not append a second line", () => {
    run(JSON.stringify(MEASURED_PAYLOAD));
    const again = run(JSON.stringify(MEASURED_PAYLOAD));
    assert.equal(again.status, 0);
    const file = path.join(tmpDir, `${MEASURED_PAYLOAD.session_id}.jsonl`);
    assert.equal(jsonlRecords(file).length, 1);
  });

  it("garbage stdin is exit 0 with a one-line error", () => {
    const result = run("{nope");
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "statusline error\n");
    assert.deepEqual(fs.readdirSync(tmpDir), []);
  });
});
