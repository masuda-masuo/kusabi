// luna-reconcile.test.mjs — acceptance tests for the kusabi #531 stale-state
// reconciliation performed by luna-resume.
//
// Frozen acceptance contract (kusabi #531 criterion 6, plus the
// criterion-5 negative "reconciliation does not spawn watchers or waiters"):
//
//   - dead mission PIDs and stale mission / Luna / Sol / inner-chain records
//     reconcile DETERMINISTICALLY: a mission control whose pid is gone does
//     not block resume, and a stale inner chain is settled through the
//     EXISTING chain stop/finalize behavior (requestChainStop's stale-pid
//     branch: status cancelled + finishedAt + one host notification);
//   - stale Luna/Sol job records — the job-store rows a mission's seat
//     dispatches recorded (the existing coordinator title pattern is
//     "luna mission <mission-id>: ...") — settle to a terminal status when
//     their recorded process is gone;
//   - repeated reconciliation is IDEMPOTENT: a second run changes nothing —
//     no second notification, no status churn, no rewrites;
//   - reconciliation never spawns a watcher or waiter process, and never
//     touches a chain that is already terminal.
//
// The reconciliation entry point is `cmdLunaResume` (luna-cmd.mjs): the
// resume flow reconciles stale state BEFORE invoking the driver seam
// (opts.inject.runLunaMission).  These tests drive cmdLunaResume with a
// counting fake driver seam so only the reconcile outcomes are observed —
// nothing here runs a real mission, a real model, Docker, GitHub, or a
// background watcher.
//
// Job identification assumption (documented): a mission's seat jobs are the
// job-store records whose title starts with "luna mission <mission-id>:" —
// the exact title pattern the existing realCoordinatorDispatch already
// emits today ("luna mission ${missionId}: coordinator dispatch").
//
// Liveness is real-pid based: process.pid = alive, 99999999 = dead (the
// same convention chain-control.test.mjs uses).

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { stateDirFor, readJson, writeJson } from "./state-paths.mjs";

let cmdModule = null;
async function lunaResumeHandler() {
  if (cmdModule === null) {
    const mod = await import("./luna-cmd.mjs");
    if (typeof mod.cmdLunaResume !== "function") {
      throw new Error(
        "luna-cmd.mjs does not export cmdLunaResume \u2014 the #531 luna-resume " +
        "surface is not implemented yet (baseline-red). The reconcile entry point must " +
        "exist before these acceptance tests can run."
      );
    }
    cmdModule = mod;
  }
  return cmdModule;
}

function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const DEAD_PID = 99999999;

/** Create a kaiba-compatible actions table in a temp DB; returns the path. */
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

function readOpenActions(dbPath) {
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
  try {
    return db.prepare("SELECT * FROM actions WHERE done_at IS NULL").all();
  } finally {
    db.close();
  }
}

const MISSION_BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-reconcile-test | 2026-09-21",
  "",
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/luna-reconcile.test.mjs` — the #531 reconcile freeze.",
  "",
  "## Smoke",
  "",
  "- `node --test plugins/kusabi/scripts/luna-reconcile.test.mjs`",
].join("\n");

const SEATS = {
  coordinator: { provider: "codex", model: "gpt-5.6-luna", substituted: false },
  auditor: { provider: "codex", model: "gpt-5.6-sol", substituted: false },
};

describe("luna stale-state reconciliation (kusabi #531 criterion 6)", () => {
  let root;
  let cwd;
  let stateDir;
  let previousStateDir;
  let missionFile;
  let kaibaDbPath;
  let previousKaibaDb;

  beforeEach(() => {
    root = makeTemp("kusabi-luna-reconcile-");
    cwd = path.join(root, "work");
    fs.mkdirSync(cwd, { recursive: true });
    missionFile = path.join(root, "mission.md");
    fs.writeFileSync(missionFile, MISSION_BRIEF, "utf8");
    previousStateDir = process.env.KUSABI_STATE_DIR;
    process.env.KUSABI_STATE_DIR = path.join(root, "state");
    stateDir = stateDirFor(cwd);
    kaibaDbPath = createKaibaDb(root);
    previousKaibaDb = process.env.KAIBA_DB;
    process.env.KAIBA_DB = kaibaDbPath;
  });

  afterEach(() => {
    if (previousStateDir === undefined) delete process.env.KUSABI_STATE_DIR;
    else process.env.KUSABI_STATE_DIR = previousStateDir;
    if (previousKaibaDb === undefined) delete process.env.KAIBA_DB;
    else process.env.KAIBA_DB = previousKaibaDb;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeMission(id, { control = {}, record = {} } = {}) {
    const missionDir = path.join(stateDir, "missions", id);
    fs.mkdirSync(missionDir, { recursive: true });
    writeJson(path.join(missionDir, "control.json"), {
      missionId: id,
      container: "test-cid",
      pid: DEAD_PID,
      status: "running",
      startedAt: "2026-09-21T00:00:00.000Z",
      ...control,
    });
    writeJson(path.join(missionDir, "mission.json"), {
      missionId: id,
      container: "test-cid",
      missionFile,
      pid: DEAD_PID,
      status: "running",
      ...SEATS,
      attempts: [],
      chains: [],
      coordinatorErrors: 0,
      consults: [],
      probes: [],
      recommendation: null,
      disposition: null,
      startedAt: "2026-09-21T00:00:00.000Z",
      ...record,
    });
    return missionDir;
  }

  function writeChain(chainId, control) {
    const chainDir = path.join(stateDir, "chains", chainId);
    fs.mkdirSync(chainDir, { recursive: true });
    writeJson(path.join(chainDir, "control.json"), {
      chainId,
      container: "test-cid",
      pid: DEAD_PID,
      status: "running",
      round: 0,
      startedAt: "2026-09-21T00:00:00.000Z",
      ...control,
    });
    writeJson(path.join(chainDir, "chain.json"), {
      chainId,
      container: "test-cid",
      records: [],
    });
    return chainDir;
  }

  function writeJob(jobId, job) {
    const jobDir = path.join(stateDir, "jobs", jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    writeJson(path.join(jobDir, "job.json"), {
      id: jobId,
      status: "running",
      ...job,
    });
  }

  function readJob(jobId) {
    return readJson(path.join(stateDir, "jobs", jobId, "job.json"));
  }

  function chainControl(chainId) {
    return readJson(path.join(stateDir, "chains", chainId, "control.json"));
  }

  /** Run cmdLunaResume with a counting driver seam and a spawn seam that must never fire. */
  async function resumeOnce(missionId, { driver = null, spawn = null } = {}) {
    const mod = await lunaResumeHandler();
    let driverCalls = 0;
    let lastInput = null;
    const driverSeam = driver ?? (async (input) => {
      driverCalls += 1;
      lastInput = input;
      return "mission resumed";
    });
    const spawnSeam = spawn ?? (() => { throw new Error("reconcile must never spawn a process"); });
    const out = await mod.cmdLunaResume(cwd, { flags: {}, text: missionId }, {
      inject: { runLunaMission: driverSeam },
      spawn: spawnSeam,
    });
    return { out, driverCalls, lastInput };
  }

  it("surface: luna-cmd exports cmdLunaResume (baseline-red on current main)", async () => {
    const mod = await lunaResumeHandler();
    assert.equal(typeof mod.cmdLunaResume, "function");
  });

  it("a stale inner chain is settled through the existing chain stop/finalize behavior (criterion 6)", async () => {
    writeMission("mission-stale-chain", { record: { chains: ["chain-stale1"] } });
    writeChain("chain-stale1", { pid: DEAD_PID });

    const { driverCalls } = await resumeOnce("mission-stale-chain");

    assert.equal(driverCalls, 1, "the dead mission pid must not block the resume");
    // The existing stale-pid branch of the chain stop lever finalised it.
    const inner = chainControl("chain-stale1");
    assert.equal(inner.status, "cancelled", "the stale chain is finalised cancelled");
    assert.ok(inner.finishedAt, "the stale chain carries a finishedAt");
    assert.equal(inner.stopRequestedBy, "luna");
    // One host-side terminal notification for the stale chain (inbox + kaiba).
    const inboxDir = path.join(stateDir, "inbox");
    assert.ok(fs.existsSync(path.join(inboxDir, "chain-stale1.md")), "the stale chain notifies via the inbox");
    assert.equal(readOpenActions(kaibaDbPath).length, 1, "the stale chain notifies via one kaiba row");
  });

  it("an already-terminal inner chain is left untouched — no re-notification, no rewrite (criterion 6)", async () => {
    writeMission("mission-terminal-chain", { record: { chains: ["chain-done"] } });
    const chainDir = writeChain("chain-done", {
      status: "completed",
      pid: DEAD_PID,
      finishedAt: "2026-09-21T00:00:00.000Z",
    });
    const before = fs.readFileSync(path.join(chainDir, "control.json"), "utf8");

    const { driverCalls } = await resumeOnce("mission-terminal-chain");

    assert.equal(driverCalls, 1, "a terminal chain must not block the mission resume");
    assert.equal(fs.readFileSync(path.join(chainDir, "control.json"), "utf8"), before,
      "a completed chain is never rewritten by reconciliation");
    assert.ok(!fs.existsSync(path.join(stateDir, "inbox", "chain-done.md")),
      "no duplicate notification for an already-terminal chain");
    assert.equal(readOpenActions(kaibaDbPath).length, 0);
  });

  it("stale Luna/Sol job records settle deterministically (criterion 6)", async () => {
    writeMission("mission-job-stale", {});
    writeJob("job-luna-stale", {
      title: "luna mission mission-job-stale: coordinator dispatch",
      process: { pid: DEAD_PID, startTime: 1, recordedAt: "2026-09-21T00:00:00.000Z" },
    });
    writeJob("job-sol-stale", {
      title: "luna mission mission-job-stale: audit gate-1",
      process: { pid: DEAD_PID, startTime: 2, recordedAt: "2026-09-21T00:00:00.000Z" },
    });

    const { driverCalls } = await resumeOnce("mission-job-stale");

    assert.equal(driverCalls, 1);
    assert.notEqual(readJob("job-luna-stale").status, "running", "the stale Luna job must settle");
    assert.notEqual(readJob("job-sol-stale").status, "running", "the stale Sol job must settle");
    assert.ok(readJob("job-luna-stale").finishedAt, "a settled job carries its terminal marker");
  });

  it("a live mission seat job is not reconciled — resume refuses (criterion 5/6 boundary)", async () => {
    writeMission("mission-job-live", {});
    writeJob("job-luna-live", {
      title: "luna mission mission-job-live: coordinator dispatch",
      process: { pid: process.pid, startTime: 3, recordedAt: "2026-09-21T00:00:00.000Z" },
    });
    let driverCalls = 0;
    await assert.rejects(
      resumeOnce("mission-job-live", {
        driver: async () => { driverCalls += 1; return "x"; },
      }),
      /still running|running/i,
    );
    assert.equal(driverCalls, 0, "a genuinely running Luna job must refuse the resume");
  });

  it("repeated reconciliation is idempotent — a second run changes nothing (criterion 6)", async () => {
    writeMission("mission-idempotent", { record: { chains: ["chain-idem"] } });
    writeChain("chain-idem", { pid: DEAD_PID });
    writeJob("job-luna-idem", {
      title: "luna mission mission-idempotent: coordinator dispatch",
      process: { pid: DEAD_PID, startTime: 4, recordedAt: "2026-09-21T00:00:00.000Z" },
    });

    await resumeOnce("mission-idempotent");
    const chainAfter1 = chainControl("chain-idem");
    const jobAfter1 = readJob("job-luna-idem");
    const inboxAfter1 = fs.readFileSync(path.join(stateDir, "inbox", "chain-idem.md"), "utf8");
    assert.equal(readOpenActions(kaibaDbPath).length, 1);

    await resumeOnce("mission-idempotent");
    const chainAfter2 = chainControl("chain-idem");
    const jobAfter2 = readJob("job-luna-idem");

    assert.deepEqual(chainAfter2, chainAfter1, "a second reconcile must not rewrite the settled chain");
    assert.deepEqual(jobAfter2, jobAfter1, "a second reconcile must not rewrite the settled job");
    assert.equal(
      fs.readFileSync(path.join(stateDir, "inbox", "chain-idem.md"), "utf8"),
      inboxAfter1,
      "a second reconcile must not re-emit the inbox notification",
    );
    assert.equal(readOpenActions(kaibaDbPath).length, 1, "a second reconcile must not duplicate the kaiba row");
  });

  it("reconciliation never spawns a watcher or waiter process (criterion 5 negative)", async () => {
    writeMission("mission-nospawn", { record: { chains: ["chain-nospawn"] } });
    writeChain("chain-nospawn", { pid: DEAD_PID });
    let spawnCalls = 0;
    const spawn = () => { spawnCalls += 1; return { pid: 1, unref: () => {} }; };

    const { driverCalls } = await resumeOnce("mission-nospawn", { spawn });

    assert.equal(driverCalls, 1, "reconciliation proceeds in-process");
    assert.equal(spawnCalls, 0, "reconciliation must not spawn a watcher, waiter, or any child");
  });
});