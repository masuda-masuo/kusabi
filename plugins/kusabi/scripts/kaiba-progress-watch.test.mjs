// kaiba-progress-watch.test.mjs — tests for kaiba progress WAL watcher
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  resolveKaibaDbPath,
  formatProgressLine,
  renderProgressLines,
  readJobProgressEvents,
  renderJobProgress,
  startKaibaProgressWatch,
  KAIBA_PROGRESS_EVENT_TYPE,
} from "./kaiba-progress-watch.mjs";
import { jobDir } from "./job-store.mjs";

function createTempDir(prefix = "kusabi-progress-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initKaibaDb(dbPath, { userVersion = 4, createTable = true } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  if (createTable) {
    db.exec(`
      CREATE TABLE progress (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        agent TEXT,
        job TEXT,
        created_at TEXT NOT NULL
      )
    `);
  }
  if (userVersion !== undefined) {
    db.exec(`PRAGMA user_version = ${userVersion}`);
  }
  return db;
}

describe("kaiba-progress-watch", () => {
  let tmpDir;
  let stateDir;
  let dbPath;

  beforeEach(() => {
    tmpDir = createTempDir();
    stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    dbPath = path.join(tmpDir, "kaiba.db");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  describe("resolveKaibaDbPath", () => {
    it("uses KAIBA_DB from environment when set", () => {
      const customPath = "/custom/path/kaiba.db";
      assert.equal(resolveKaibaDbPath({ KAIBA_DB: customPath }), customPath);
    });

    it("falls back to ~/.kaiba/kaiba.db when KAIBA_DB is absent or empty", () => {
      const expected = path.join(os.homedir(), ".kaiba", "kaiba.db");
      assert.equal(resolveKaibaDbPath({}), expected);
      assert.equal(resolveKaibaDbPath({ KAIBA_DB: "" }), expected);
      assert.equal(resolveKaibaDbPath({ KAIBA_DB: "   " }), expected);
    });
  });

  describe("formatProgressLine and renderProgressLines", () => {
    it("formats multi-line content into single line and truncates if oversized", () => {
      assert.equal(formatProgressLine("hello\nworld"), "hello world");
      assert.equal(formatProgressLine("single line"), "single line");
      const longText = "a".repeat(250);
      const formatted = formatProgressLine(longText, 100);
      assert.equal(formatted.length, 100);
      assert.ok(formatted.endsWith("..."));
    });

    it("renders empty array when no events given", () => {
      assert.deepEqual(renderProgressLines([]), []);
      assert.deepEqual(renderProgressLines(null), []);
    });

    it("renders progress header and capped items with omission notice", () => {
      const events = [
        { content: "note 1" },
        { content: "note 2" },
        { content: "note 3" },
        { content: "note 4" },
        { content: "note 5" },
      ];
      const rendered = renderProgressLines(events, 3);
      assert.deepEqual(rendered, [
        "progress:",
        "  (... 2 earlier note(s) omitted)",
        "  - note 3",
        "  - note 4",
        "  - note 5",
      ]);
    });
  });

  describe("drain and watch lifecycle", () => {
    it("drain sees a matching row and appends to events.ndjson", () => {
      const writer = initKaibaDb(dbPath);
      const jobId = "job-test-1";
      fs.mkdirSync(jobDir(stateDir, jobId), { recursive: true });

      const watcher = startKaibaProgressWatch({ stateDir, jobId, dbPath });
      try {
        writer.prepare(
          "INSERT INTO progress (content, agent, job, created_at) VALUES (?, ?, ?, ?)"
        ).run("working on task A", "worker", jobId, "2026-08-29T00:00:00.000Z");

        watcher.drain();

        const events = readJobProgressEvents(stateDir, jobId);
        assert.equal(events.length, 1);
        assert.equal(events[0].type, KAIBA_PROGRESS_EVENT_TYPE);
        assert.equal(events[0].content, "working on task A");
        assert.equal(events[0].agent, "worker");
        assert.equal(events[0].job, jobId);
        assert.equal(events[0].created_at, "2026-08-29T00:00:00.000Z");
        assert.equal(events[0].id, 1);
      } finally {
        watcher.stop();
        writer.close();
      }
    });

    it("a row with a different job is ignored", () => {
      const writer = initKaibaDb(dbPath);
      const jobId = "job-test-my-job";
      fs.mkdirSync(jobDir(stateDir, jobId), { recursive: true });

      const watcher = startKaibaProgressWatch({ stateDir, jobId, dbPath });
      try {
        writer.prepare(
          "INSERT INTO progress (content, agent, job, created_at) VALUES (?, ?, ?, ?)"
        ).run("note for other job", "worker", "job-other", "2026-08-29T00:00:00.000Z");

        watcher.drain();

        const events = readJobProgressEvents(stateDir, jobId);
        assert.equal(events.length, 0);
      } finally {
        watcher.stop();
        writer.close();
      }
    });

    it("job IS NULL is ignored", () => {
      const writer = initKaibaDb(dbPath);
      const jobId = "job-test-null-check";
      fs.mkdirSync(jobDir(stateDir, jobId), { recursive: true });

      const watcher = startKaibaProgressWatch({ stateDir, jobId, dbPath });
      try {
        writer.prepare(
          "INSERT INTO progress (content, agent, job, created_at) VALUES (?, ?, ?, ?)"
        ).run("note with null job", "worker", null, "2026-08-29T00:00:00.000Z");

        watcher.drain();

        const events = readJobProgressEvents(stateDir, jobId);
        assert.equal(events.length, 0);
      } finally {
        watcher.stop();
        writer.close();
      }
    });

    it("missing db does not throw and stop is silent", () => {
      const missingPath = path.join(tmpDir, "does-not-exist", "kaiba.db");
      const jobId = "job-missing-db";
      fs.mkdirSync(jobDir(stateDir, jobId), { recursive: true });

      const watcher = startKaibaProgressWatch({ stateDir, jobId, dbPath: missingPath });
      assert.doesNotThrow(() => {
        watcher.drain();
        watcher.stop();
      });
      const events = readJobProgressEvents(stateDir, jobId);
      assert.equal(events.length, 0);
    });

    it("data_version unchanged skips redundant SELECT", () => {
      const writer = initKaibaDb(dbPath);
      const jobId = "job-dv-test";
      fs.mkdirSync(jobDir(stateDir, jobId), { recursive: true });

      const watcher = startKaibaProgressWatch({ stateDir, jobId, dbPath });
      try {
        // Initial drain ran during startKaibaProgressWatch.
        // Wrap db.prepare on watcher.db to count SELECT executions.
        let selectPrepareCount = 0;
        const originalPrepare = watcher.db.prepare.bind(watcher.db);
        watcher.db.prepare = function (sql) {
          if (typeof sql === "string" && sql.includes("FROM progress")) {
            selectPrepareCount++;
          }
          return originalPrepare(sql);
        };

        // Drain with no writes: data_version should match lastDataVersion, SELECT is skipped
        watcher.drain();
        assert.equal(selectPrepareCount, 0);

        // Now write a row
        writer.prepare(
          "INSERT INTO progress (content, agent, job, created_at) VALUES (?, ?, ?, ?)"
        ).run("new note", "worker", jobId, "2026-08-29T00:00:00.000Z");

        // Drain after write: data_version changed, SELECT runs
        watcher.drain();
        assert.equal(selectPrepareCount, 1);

        // Drain again without writes: SELECT is skipped
        watcher.drain();
        assert.equal(selectPrepareCount, 1);
      } finally {
        watcher.stop();
        writer.close();
      }
    });

    it("stop() is idempotent", () => {
      const writer = initKaibaDb(dbPath);
      const jobId = "job-idempotent-stop";
      fs.mkdirSync(jobDir(stateDir, jobId), { recursive: true });

      const watcher = startKaibaProgressWatch({ stateDir, jobId, dbPath });
      assert.doesNotThrow(() => {
        watcher.stop();
        watcher.stop();
        watcher.stop();
      });
      writer.close();
    });

    it("ignores db with user_version < 4 without throwing", () => {
      const writer = initKaibaDb(dbPath, { userVersion: 3 });
      const jobId = "job-old-version";
      fs.mkdirSync(jobDir(stateDir, jobId), { recursive: true });

      const watcher = startKaibaProgressWatch({ stateDir, jobId, dbPath });
      try {
        writer.prepare(
          "INSERT INTO progress (content, agent, job, created_at) VALUES (?, ?, ?, ?)"
        ).run("should be ignored", "worker", jobId, "2026-08-29T00:00:00.000Z");

        watcher.drain();
        const events = readJobProgressEvents(stateDir, jobId);
        assert.equal(events.length, 0);
      } finally {
        watcher.stop();
        writer.close();
      }
    });

    it("ignores db without progress table without throwing", () => {
      const writer = initKaibaDb(dbPath, { userVersion: 4, createTable: false });
      const jobId = "job-no-table";
      fs.mkdirSync(jobDir(stateDir, jobId), { recursive: true });

      const watcher = startKaibaProgressWatch({ stateDir, jobId, dbPath });
      try {
        watcher.drain();
        const events = readJobProgressEvents(stateDir, jobId);
        assert.equal(events.length, 0);
      } finally {
        watcher.stop();
        writer.close();
      }
    });

    it("initial drain catches rows written before watch started", () => {
      const writer = initKaibaDb(dbPath);
      const jobId = "job-pre-mint";
      fs.mkdirSync(jobDir(stateDir, jobId), { recursive: true });

      writer.prepare(
        "INSERT INTO progress (content, agent, job, created_at) VALUES (?, ?, ?, ?)"
      ).run("early note before start", "worker", jobId, "2026-08-29T00:00:00.000Z");

      const watcher = startKaibaProgressWatch({ stateDir, jobId, dbPath });
      try {
        const events = readJobProgressEvents(stateDir, jobId);
        assert.equal(events.length, 1);
        assert.equal(events[0].content, "early note before start");
      } finally {
        watcher.stop();
        writer.close();
      }
    });

    it("renderJobProgress reads and formats progress from events.ndjson", () => {
      const jobId = "job-render-test";
      const dir = jobDir(stateDir, jobId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "events.ndjson"),
        [
          JSON.stringify({ type: "other.event" }),
          JSON.stringify({
            type: KAIBA_PROGRESS_EVENT_TYPE,
            id: 1,
            created_at: "2026-08-29T00:00:00Z",
            agent: "worker",
            job: jobId,
            content: "first note",
          }),
          JSON.stringify({
            type: KAIBA_PROGRESS_EVENT_TYPE,
            id: 2,
            created_at: "2026-08-29T00:01:00Z",
            agent: "worker",
            job: jobId,
            content: "second note",
          }),
        ].join("\n") + "\n",
        "utf8"
      );

      const lines = renderJobProgress(stateDir, jobId);
      assert.deepEqual(lines, [
        "progress:",
        "  - first note",
        "  - second note",
      ]);
    });
  });
});
