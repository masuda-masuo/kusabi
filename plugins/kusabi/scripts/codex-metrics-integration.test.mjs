// codex-metrics-integration.test.mjs — Integration tests for Codex usage
// ingestion into the metrics store via cmdMetricsIngest and the CLI flag parser.
//
// These call real command functions with synthetic fixtures and verify that
// Codex rows reach the DB and report correctly.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { cmdMetricsIngest } from "./metrics-cmd.mjs";
import { parseArgs } from "./cli.mjs";
import { openMetricsDb, countRows } from "./metrics-db.mjs";

// ---------------------------------------------------------------------------
// Fixture helpers — same shapes as codex-usage-ingest.test.mjs
// ---------------------------------------------------------------------------

const SESSION_ID = "integ-session";
const CWD = "/work/example";

function sessionMeta({ ts = "2026-09-05T10:00:00.000Z", id = SESSION_ID, cwd = CWD } = {}) {
  return { timestamp: ts, type: "session_meta", payload: { id, cwd } };
}

function turnContext({ ts = "2026-09-05T10:00:01.000Z", turnId = "turn-a", model = "gpt-6-astra" } = {}) {
  return { timestamp: ts, type: "turn_context", payload: { turn_id: turnId, model } };
}

function tokenUsageRecord({
  ts = "2026-09-05T10:00:02.000Z",
  sessionId = SESSION_ID,
  turnId = "turn-a",
  responseId = "resp-1",
  usage = { input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 10, output_tokens: 20, total_tokens: 120 },
} = {}) {
  return {
    timestamp: ts,
    type: "token_usage_record",
    payload: {
      thread_id: sessionId,
      session_id: sessionId,
      turn_id: turnId,
      response_id: responseId,
      usage,
    },
  };
}

function buildBasicLines() {
  return [
    JSON.stringify(sessionMeta({})),
    JSON.stringify(turnContext({})),
    JSON.stringify(tokenUsageRecord({})),
  ].join("\n") + "\n";
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-codex-integ-"));
}

// ---------------------------------------------------------------------------
// CLI flag parsing — --codex-usage-dir
// ---------------------------------------------------------------------------

describe("CLI --codex-usage-dir flag", () => {
  it("parses --codex-usage-dir as a value flag", () => {
    const result = parseArgs(["--codex-usage-dir", "/tmp/codex"]);
    assert.equal(result.flags["codex-usage-dir"], "/tmp/codex");
  });

  it("does not set --codex-usage-dir when not provided", () => {
    const result = parseArgs(["some text"]);
    assert.equal(result.flags["codex-usage-dir"], undefined);
  });

  it("combines --codex-usage-dir with other flags", () => {
    const result = parseArgs(["--model", "p/m", "--codex-usage-dir", "/tmp/c", "--", "text"]);
    assert.equal(result.flags.model, "p/m");
    assert.equal(result.flags["codex-usage-dir"], "/tmp/c");
    assert.equal(result.text, "text");
  });
});

// ---------------------------------------------------------------------------
// Integration: cmdMetricsIngest with Codex usage
// ---------------------------------------------------------------------------

describe("cmdMetricsIngest — Codex usage integration", () => {
  let origCodexHome;

  beforeEach(() => {
    origCodexHome = process.env.CODEX_HOME;
  });

  afterEach(() => {
    if (origCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = origCodexHome;
    }
  });

  it("ingests Codex usage rows into the DB via cmdMetricsIngest", () => {
    const tmpDir = makeTempDir();
    const codexDir = path.join(tmpDir, "codex-sessions");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, "session.jsonl"), buildBasicLines(), "utf8");

    const dbPath = path.join(tmpDir, "test.db");
    try {
      const output = cmdMetricsIngest("/workspace", {
        flags: {
          db: dbPath,
          "codex-usage-dir": codexDir,
          "transcript-dir": path.join(tmpDir, "no-such-transcripts"),
          "cursor-usage-dir": path.join(tmpDir, "no-such-cursor"),
          "state-root": tmpDir,
        },
      });

      assert.ok(output.includes("Codex usage:"));
      assert.ok(output.includes("files scanned:             1"));
      assert.ok(output.includes("turns:                     1"));

      // Verify DB has the turn row
      const db = openMetricsDb(dbPath);
      try {
        assert.equal(countRows(db, "turn"), 1);
        assert.equal(countRows(db, "session"), 1);
        const turn = db.prepare("SELECT * FROM turn WHERE request_id = ?").get("codex:resp-1");
        assert.ok(turn);
        assert.equal(turn.session_id, SESSION_ID);
        assert.equal(turn.input, 30);
        assert.equal(turn.model, "gpt-6-astra");
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("repeated ingestion is idempotent", () => {
    const tmpDir = makeTempDir();
    const codexDir = path.join(tmpDir, "codex-sessions");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, "session.jsonl"), buildBasicLines(), "utf8");

    const dbPath = path.join(tmpDir, "test.db");
    try {
      const flags = {
        db: dbPath,
        "codex-usage-dir": codexDir,
        "transcript-dir": path.join(tmpDir, "no-such-transcripts"),
        "cursor-usage-dir": path.join(tmpDir, "no-such-cursor"),
        "state-root": tmpDir,
      };

      cmdMetricsIngest("/workspace", { flags });
      const db1 = openMetricsDb(dbPath);
      const count1 = countRows(db1, "turn");
      db1.close();

      cmdMetricsIngest("/workspace", { flags });
      const db2 = openMetricsDb(dbPath);
      const count2 = countRows(db2, "turn");
      db2.close();

      assert.equal(count1, 1);
      assert.equal(count2, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("CODEX_HOME env var is used as default directory", () => {
    const tmpDir = makeTempDir();
    const codexHome = path.join(tmpDir, "codex-home");
    const codexDir = path.join(codexHome, "sessions");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, "session.jsonl"), buildBasicLines(), "utf8");

    process.env.CODEX_HOME = codexHome;
    const dbPath = path.join(tmpDir, "test.db");
    try {
      const output = cmdMetricsIngest("/workspace", {
        flags: {
          db: dbPath,
          // No --codex-usage-dir: should use CODEX_HOME/sessions
          "transcript-dir": path.join(tmpDir, "no-such-transcripts"),
          "cursor-usage-dir": path.join(tmpDir, "no-such-cursor"),
          "state-root": tmpDir,
        },
      });
      assert.ok(output.includes("Codex usage:"));
      // Should have found the file via CODEX_HOME/sessions
      assert.ok(output.includes("files scanned:             1"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("explicit --codex-usage-dir overrides CODEX_HOME", () => {
    const tmpDir = makeTempDir();
    const codexDir = path.join(tmpDir, "codex-explicit");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, "session.jsonl"), buildBasicLines(), "utf8");

    process.env.CODEX_HOME = path.join(tmpDir, "codex-home-does-not-exist");
    const dbPath = path.join(tmpDir, "test.db");
    try {
      const output = cmdMetricsIngest("/workspace", {
        flags: {
          db: dbPath,
          "codex-usage-dir": codexDir,
          "transcript-dir": path.join(tmpDir, "no-such-transcripts"),
          "cursor-usage-dir": path.join(tmpDir, "no-such-cursor"),
          "state-root": tmpDir,
        },
      });
      assert.ok(output.includes("Codex usage:"));
      assert.ok(output.includes("files scanned:             1"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("--dry-run does not create or modify the target DB", () => {
    const tmpDir = makeTempDir();
    const codexDir = path.join(tmpDir, "codex-sessions");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, "session.jsonl"), buildBasicLines(), "utf8");

    const dbPath = path.join(tmpDir, "should-not-exist.db");
    try {
      const output = cmdMetricsIngest("/workspace", {
        flags: {
          dryRun: true,
          db: dbPath,
          "codex-usage-dir": codexDir,
          "transcript-dir": path.join(tmpDir, "no-such-transcripts"),
          "cursor-usage-dir": path.join(tmpDir, "no-such-cursor"),
          "state-root": tmpDir,
        },
      });
      assert.ok(output.includes("Metrics ingest (dry run — nothing written)"));
      assert.ok(output.includes("db: (discarded, in-memory)"));
      assert.ok(!fs.existsSync(dbPath), "dry run must not create db file");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("missing codex directory produces warning but does not fail", () => {
    const tmpDir = makeTempDir();
    const dbPath = path.join(tmpDir, "test.db");
    try {
      const output = cmdMetricsIngest("/workspace", {
        flags: {
          db: dbPath,
          "codex-usage-dir": path.join(tmpDir, "nonexistent-codex-" + Date.now()),
          "transcript-dir": path.join(tmpDir, "no-such-transcripts"),
          "cursor-usage-dir": path.join(tmpDir, "no-such-cursor"),
          "state-root": tmpDir,
        },
      });
      assert.ok(output.includes("Codex usage:"));
      assert.ok(output.includes("warning:"));
      assert.ok(output.includes("files scanned:             0"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
