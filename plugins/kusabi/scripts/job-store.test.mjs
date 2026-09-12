// job-store.test.mjs — acceptance tests for job-scoped kaiba progress
// retirement at the saveJob chokepoint (kusabi #497 / kaiba#33).
//
// Contract pinned by these tests:
//
//   saveJob(stateDir, job) is the ONE write chokepoint for job records. A save
//   whose status is terminal must synchronously invoke kaiba progress
//   retirement for that job (through kaiba-progress-retire.mjs); a
//   nonterminal save (status `running`, including incremental stats saves)
//   must never invoke it.
//
//   Terminal job statuses (every status that exists today):
//     completed, error, stalled, timeout, cancelled, provider-error, serve-dead
//
//   On an ACTIONABLE retire failure (nonzero exit, timeout, non-ENOENT spawn
//   error) saveJob must append a `companion.kaiba.retire` event to the job's
//   events.ndjson and must NOT change the job's verdict. ENOENT (missing
//   binary), invalid job ids, and KUSABI_KAIBA_RETIRE=0 are silent no-ops:
//   no spawn, no event.
//
//   Duplicate terminal saves are safe: each spawns again and the kaiba side is
//   idempotent. The existing cancelled-sticky invariant is unchanged.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveJob, loadJob, jobDir, appendEvent } from "./job-store.mjs";

const RETIRE_EVENT_TYPE = "companion.kaiba.retire";

// Every terminal job status that exists in the dispatchers today. A transition
// persisted with any of these must retire; `running` and anything else must
// not.
const TERMINAL_STATUSES = ["completed", "error", "stalled", "timeout", "cancelled", "provider-error", "serve-dead"];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-job-store-test-"));
}

// Fake `kaiba-progress-retire`: logs argv lines to $KUSABI_RETIRE_LOG, exits
// per $KUSABI_RETIRE_EXIT (default 0), busy-waits per $KUSABI_RETIRE_SLEEP_MS.
function makeFakeBin(file) {
  const script = [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    'const logFile = process.env.KUSABI_RETIRE_LOG;',
    'if (logFile) fs.appendFileSync(logFile, JSON.stringify(process.argv.slice(2)) + "\\n");',
    'if (process.env.KUSABI_RETIRE_EXIT) process.exit(Number(process.env.KUSABI_RETIRE_EXIT));',
    'if (process.env.KUSABI_RETIRE_SLEEP_MS) {',
    "  const end = Date.now() + Number(process.env.KUSABI_RETIRE_SLEEP_MS);",
    "  while (Date.now() < end) {}",
    "}",
    "process.exit(0);",
    "",
  ].join("\n");
  fs.writeFileSync(file, script, "utf8");
  fs.chmodSync(file, 0o755);
  return file;
}

function readRetireLog(logFile) {
  if (!fs.existsSync(logFile)) return [];
  return fs
    .readFileSync(logFile, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

function readEvents(stateDir, jobId) {
  const file = path.join(jobDir(stateDir, jobId), "events.ndjson");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

function readRetireEvents(stateDir, jobId) {
  return readEvents(stateDir, jobId).filter((e) => e.type === RETIRE_EVENT_TYPE);
}

describe("saveJob kaiba retirement hook", () => {
  let tmpDir;
  let stateDir;
  let fakeBin;
  let logFile;
  let savedEnv = {};

  beforeEach(() => {
    tmpDir = makeTmpDir();
    stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fakeBin = makeFakeBin(path.join(tmpDir, "fake-retire-bin"));
    logFile = path.join(tmpDir, "retire.log");
    // Save and arm the retirement env: fake binary, retire enabled, log on.
    for (const key of ["KAIBA_RETIRE_BIN", "KUSABI_KAIBA_RETIRE", "KUSABI_RETIRE_LOG", "KUSABI_RETIRE_EXIT"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.KAIBA_RETIRE_BIN = fakeBin;
    delete process.env.KUSABI_KAIBA_RETIRE;
    delete process.env.KUSABI_RETIRE_EXIT;
    process.env.KUSABI_RETIRE_LOG = logFile;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  function terminalJob(status, id = `job-${status}`) {
    return { id, status, startedAt: new Date().toISOString(), error: null };
  }

  it("retires synchronously on every terminal status save", () => {
    for (const status of TERMINAL_STATUSES) {
      // The retire log is append-only across the whole loop, so scope each
      // assertion to the entries this save produced: truncate before the
      // save, then require exactly one entry for this job. Missing,
      // duplicate, and wrong-job retirement per terminal save all still fail.
      fs.writeFileSync(logFile, "", "utf8");
      const job = terminalJob(status);
      saveJob(stateDir, job);
      // No await: retirement must have happened before saveJob returned.
      const log = readRetireLog(logFile);
      assert.deepEqual(log, [["--job", job.id]], `status ${status} must retire once`);
      assert.equal(loadJob(stateDir, job.id).status, status, `status ${status} must be preserved`);
    }
  });

  it("gates on terminal status: running saves never spawn, a terminal save does", () => {
    const running = terminalJob("running", "job-running-1");
    saveJob(stateDir, running);
    saveJob(stateDir, { ...running, stats: { input: 1 } });
    saveJob(stateDir, { ...running, stats: { input: 2 } });
    assert.deepEqual(readRetireLog(logFile), [], "running saves must never spawn");

    const done = terminalJob("completed", "job-running-1");
    saveJob(stateDir, done);
    assert.deepEqual(readRetireLog(logFile), [["--job", "job-running-1"]]);
  });

  it("treats an unknown status as nonterminal and still retires a terminal one", () => {
    saveJob(stateDir, terminalJob("waiting", "job-unknown-1"));
    assert.deepEqual(readRetireLog(logFile), [], "unknown status must not spawn");
    saveJob(stateDir, terminalJob("completed", "job-unknown-2"));
    assert.deepEqual(readRetireLog(logFile), [["--job", "job-unknown-2"]]);
  });

  it("records a companion.kaiba.retire event on nonzero exit without changing the verdict", () => {
    process.env.KUSABI_RETIRE_EXIT = "2";
    const job = terminalJob("error", "job-nonzero-1");
    job.error = "provider exploded";
    saveJob(stateDir, job);
    const events = readRetireEvents(stateDir, job.id);
    assert.equal(events.length, 1, "a nonzero retire exit must be observable");
    assert.equal(events[0].type, RETIRE_EVENT_TYPE);
    assert.equal(events[0].code, 2);
    const onDisk = loadJob(stateDir, job.id);
    assert.equal(onDisk.status, "error", "retire failure must not change the verdict");
    assert.equal(onDisk.error, "provider exploded");
  });

  it("records an event on non-ENOENT spawn failure (EACCES) without changing the verdict", () => {
    // Point the binary at a directory: spawn fails with EACCES — a deployment
    // failure that must be observable, unlike ENOENT.
    process.env.KAIBA_RETIRE_BIN = tmpDir;
    const job = terminalJob("cancelled", "job-eacces-1");
    saveJob(stateDir, job);
    const events = readRetireEvents(stateDir, job.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, RETIRE_EVENT_TYPE);
    assert.ok(events[0].error, "spawn failure event must carry an error message");
    assert.equal(loadJob(stateDir, job.id).status, "cancelled");
  });

  it("does not let a failed retire-event append escape saveJob or change the verdict", () => {
    process.env.KUSABI_RETIRE_EXIT = "1";
    const job = terminalJob("error", "job-append-fail-1");
    // Pre-existing event line, then make the events.ndjson path un-appendable
    // (read-only file): the observability write fails with EACCES, the
    // deployment shape this contract must survive. Retirement is still
    // attempted; only its observability is lost, silently, and the already
    // persisted terminal JSON is untouched.
    const eventsFile = path.join(jobDir(stateDir, job.id), "events.ndjson");
    fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
    fs.writeFileSync(eventsFile, `${JSON.stringify({ type: "companion.claude.dispatch", backend: "claude" })}\n`, "utf8");
    fs.chmodSync(eventsFile, 0o400);
    saveJob(stateDir, job); // must not throw
    assert.deepEqual(readRetireLog(logFile), [["--job", job.id]], "retirement must still be attempted");
    const onDisk = loadJob(stateDir, job.id);
    assert.equal(onDisk.status, "error", "the terminal JSON must stay persisted");
    assert.equal(onDisk.error, null);
    assert.deepEqual(
      readEvents(stateDir, job.id),
      [{ type: "companion.claude.dispatch", backend: "claude" }],
      "no partial retire event may be appended"
    );
  });

  it("is a silent ENOENT no-op, and a later working binary still retires", () => {
    process.env.KAIBA_RETIRE_BIN = path.join(tmpDir, "no-such-binary");
    const job = terminalJob("completed", "job-enoent-1");
    saveJob(stateDir, job);
    assert.deepEqual(readRetireLog(logFile), []);
    assert.deepEqual(readRetireEvents(stateDir, job.id), [], "ENOENT must not record an event");
    assert.equal(loadJob(stateDir, job.id).status, "completed");

    process.env.KAIBA_RETIRE_BIN = fakeBin;
    saveJob(stateDir, terminalJob("completed", "job-enoent-2"));
    assert.deepEqual(readRetireLog(logFile), [["--job", "job-enoent-2"]]);
  });

  it("never spawns for an invalid job id, while a valid id still retires", () => {
    saveJob(stateDir, terminalJob("completed", "bad id!"));
    assert.deepEqual(readRetireLog(logFile), [], "invalid ids must never spawn");
    saveJob(stateDir, terminalJob("completed", "job-valid-1"));
    assert.deepEqual(readRetireLog(logFile), [["--job", "job-valid-1"]]);
  });

  it("never spawns when KUSABI_KAIBA_RETIRE=0, and resumes when it is unset", () => {
    process.env.KUSABI_KAIBA_RETIRE = "0";
    saveJob(stateDir, terminalJob("completed", "job-optout-1"));
    assert.deepEqual(readRetireLog(logFile), []);
    assert.deepEqual(readRetireEvents(stateDir, "job-optout-1"), []);

    delete process.env.KUSABI_KAIBA_RETIRE;
    saveJob(stateDir, terminalJob("completed", "job-optout-2"));
    assert.deepEqual(readRetireLog(logFile), [["--job", "job-optout-2"]]);
  });

  it("duplicate terminal saves are safe and intentionally idempotent", () => {
    const job = terminalJob("completed", "job-dup-1");
    saveJob(stateDir, job);
    saveJob(stateDir, { ...job, result: "second save" });
    assert.deepEqual(readRetireLog(logFile), [
      ["--job", "job-dup-1"],
      ["--job", "job-dup-1"],
    ]);
    assert.equal(loadJob(stateDir, job.id).status, "completed");
  });

  it("preserves the cancelled-sticky invariant while still retiring", () => {
    const job = terminalJob("cancelled", "job-sticky-1");
    saveJob(stateDir, job);
    const overrideAttempt = { ...job, status: "error", error: "dispatch saw a failure" };
    saveJob(stateDir, overrideAttempt);
    // Both saves were terminal transitions: both retire (idempotent on kaiba).
    assert.deepEqual(readRetireLog(logFile), [
      ["--job", "job-sticky-1"],
      ["--job", "job-sticky-1"],
    ]);
    const onDisk = loadJob(stateDir, job.id);
    assert.equal(onDisk.status, "cancelled", "cancelled must stay sticky");
    assert.equal(onDisk.overridden.length, 1);
    assert.equal(onDisk.overridden[0].status, "error");
  });

  it("does not re-retire a running save demoted by cancelled stickiness, but a terminal save still retires", () => {
    const job = terminalJob("cancelled", "job-sticky-run-1");
    saveJob(stateDir, job);
    assert.deepEqual(readRetireLog(logFile), [["--job", job.id]], "the cancelled terminal save must retire");

    // A stats save still carrying `running` is demoted to the sticky
    // `cancelled` verdict. The retire decision is based on the INCOMING save
    // status (nonterminal), before sticky normalization, so it must not
    // invoke retire again.
    saveJob(stateDir, { ...job, status: "running", stats: { input: 7 } });
    assert.deepEqual(
      readRetireLog(logFile),
      [["--job", job.id]],
      "a running save demoted to cancelled must not invoke retire again"
    );
    assert.equal(loadJob(stateDir, job.id).status, "cancelled", "cancelled must stay sticky");

    // A genuinely terminal incoming save is still a terminal boundary, even
    // under the sticky regime.
    saveJob(stateDir, { ...job, status: "completed", result: "later" });
    assert.deepEqual(readRetireLog(logFile), [
      ["--job", job.id],
      ["--job", job.id],
    ], "a genuine terminal save must still retire");
  });

  it("keeps previously appended events intact next to the retire event", () => {
    process.env.KUSABI_RETIRE_EXIT = "1";
    const job = terminalJob("error", "job-events-1");
    appendEvent(stateDir, job.id, { type: "companion.claude.dispatch", backend: "claude" });
    saveJob(stateDir, job);
    const all = readEvents(stateDir, job.id);
    assert.equal(all.length, 2);
    assert.equal(all[0].type, "companion.claude.dispatch");
    assert.equal(all[1].type, RETIRE_EVENT_TYPE);
  });

  it("never throws to the caller and stays observable when the retire binary fails", () => {
    process.env.KUSABI_RETIRE_EXIT = "1";
    const job = terminalJob("error", "job-nothrow-1");
    saveJob(stateDir, job); // would fail the test by throwing
    assert.equal(loadJob(stateDir, job.id).status, "error");
    assert.equal(readRetireEvents(stateDir, job.id).length, 1);
  });
});