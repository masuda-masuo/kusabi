// kaiba-progress-retire.test.mjs — acceptance tests for the job-scoped kaiba
// progress retirement helper (kusabi #497 / kaiba#33).
//
// Public surface pinned by these tests (the frozen oracle for the implementer):
//
//   module: plugins/kusabi/scripts/kaiba-progress-retire.mjs
//
//   retireJobProgress({ jobId, env = process.env, timeoutMs = <bounded default> })
//     -> result object, NEVER throws to callers.
//
//   result fields:
//     skipped   true  — nothing was spawned (or the binary was missing): silent
//                       no-op. Covers KUSABI_KAIBA_RETIRE=0 opt-out, invalid or
//                       empty job ids, and ENOENT (missing executable).
//     ok        true  — spawned and exited 0. Nothing to record.
//     ok        false — spawned and FAILED: nonzero exit (code), timeout
//                       (timedOut), or another spawn error (error). This is the
//                       "actionable failure" the call sites record an event for.
//     code      number|null — exit code when spawned.
//     timedOut  boolean     — true when the bounded timeout killed the child.
//     error     string|null — spawn failure message (non-ENOENT) or null.
//
// The configured binary is taken from env.KAIBA_RETIRE_BIN and defaults to
// `kaiba-progress-retire` resolved on env.PATH. It is invoked synchronously
// (spawnSync) as `--job <id>`. Job ids must match ^[a-zA-Z0-9_-]+$ — the same
// policy as applyWorkerKaibaIdentity (claude-mcp.mjs).
//
// The external kaiba contract this encodes (kaiba PR#34, merged):
//   kaiba-progress-retire --job <id> exact-matches progress.job, leaves NULL /
//   other-job rows untouched, is idempotent, rejects ids outside
//   ^[a-zA-Z0-9_-]+$, and returns nonzero on missing/wrong/unopenable DB.
// kusabi never alters kaiba's DB directly; it only invokes this command.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The module under test does not exist yet — this is the baseline-red state.
// Load it dynamically so the failure mode is an assertion about the missing
// feature, not a load-time crash of the whole test file.
let mod = null;
async function loadModule() {
  if (mod) return mod;
  try {
    mod = await import("./kaiba-progress-retire.mjs");
  } catch (err) {
    assert.fail(
      `kaiba-progress-retire.mjs must exist and export retireJobProgress — ` +
        `module import failed (${err.code ?? err.message})`
    );
  }
  assert.equal(
    typeof mod.retireJobProgress,
    "function",
    "kaiba-progress-retire.mjs must export retireJobProgress({ jobId, env, timeoutMs })"
  );
  return mod;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A fake `kaiba-progress-retire` executable. It logs its argv as one JSON line
// per invocation to $KUSABI_RETIRE_LOG, honours $KUSABI_RETIRE_EXIT (nonzero
// exit for failure tests) and $KUSABI_RETIRE_SLEEP_MS (busy-wait for timeout
// tests), then exits 0 by default.
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

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-retire-test-"));
}

function readLog(logFile) {
  if (!fs.existsSync(logFile)) return [];
  return fs
    .readFileSync(logFile, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

describe("kaiba-progress-retire", () => {
  let tmpDir;
  let fakeBin;
  let logFile;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fakeBin = makeFakeBin(path.join(tmpDir, "fake-retire-bin"));
    logFile = path.join(tmpDir, "retire.log");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // env for a retire call: process.env plus the fake binary and log file.
  function retireEnv(overrides = {}) {
    return {
      ...process.env,
      KAIBA_RETIRE_BIN: fakeBin,
      KUSABI_RETIRE_LOG: logFile,
      ...overrides,
    };
  }

  it("exports retireJobProgress as the retirement helper", async () => {
    const m = await loadModule();
    assert.equal(typeof m.retireJobProgress, "function");
  });

  it("spawns the configured binary synchronously with `--job <id>` on success", async () => {
    const { retireJobProgress } = await loadModule();
    const res = retireJobProgress({ jobId: "job-abc123", env: retireEnv() });
    assert.deepEqual(readLog(logFile), [["--job", "job-abc123"]]);
    assert.equal(res.ok, true);
    assert.equal(res.skipped, false);
    assert.equal(res.code, 0);
  });

  it("defaults to the kaiba-progress-retire binary name resolved on PATH", async () => {
    const { retireJobProgress } = await loadModule();
    // Put a fake named exactly `kaiba-progress-retire` first on PATH and do NOT
    // set KAIBA_RETIRE_BIN: the helper must fall back to the default name.
    makeFakeBin(path.join(tmpDir, "kaiba-progress-retire"));
    const env = {
      ...process.env,
      PATH: `${tmpDir}:${process.env.PATH ?? ""}`,
      KUSABI_RETIRE_LOG: logFile,
    };
    delete env.KAIBA_RETIRE_BIN;
    const res = retireJobProgress({ jobId: "job-xyz", env });
    assert.deepEqual(readLog(logFile), [["--job", "job-xyz"]]);
    assert.equal(res.ok, true);
    assert.equal(res.skipped, false);
  });

  it("reports a nonzero exit as an actionable failure without throwing", async () => {
    const { retireJobProgress } = await loadModule();
    const env = retireEnv({ KUSABI_RETIRE_EXIT: "3" });
    const res = retireJobProgress({ jobId: "job-fail1", env });
    assert.equal(res.ok, false);
    assert.equal(res.skipped, false);
    assert.equal(res.code, 3);
    assert.deepEqual(readLog(logFile), [["--job", "job-fail1"]]);
  });

  it("treats a missing executable as a silent fail-soft no-op", async () => {
    const { retireJobProgress } = await loadModule();
    const env = retireEnv({ KAIBA_RETIRE_BIN: path.join(tmpDir, "no-such-binary") });
    const res = retireJobProgress({ jobId: "job-missing", env });
    // `skipped` is the silent marker; whether `ok` mirrors it is not pinned.
    // The job-store tests pin the observable consequence: ENOENT records no
    // companion.kaiba.retire event.
    assert.equal(res.skipped, true, "ENOENT must be a silent no-op, not a failure");
  });

  it("times out after the bounded timeout and reports timedOut", async () => {
    const { retireJobProgress } = await loadModule();
    const env = retireEnv({ KUSABI_RETIRE_SLEEP_MS: "8000" });
    const started = Date.now();
    const res = retireJobProgress({ jobId: "job-hang1", env, timeoutMs: 250 });
    assert.equal(res.timedOut, true);
    assert.equal(res.ok, false);
    assert.equal(res.skipped, false);
    // Loose sanity bound: the call must return, not wait for the 8s sleep.
    assert.ok(Date.now() - started < 5000, "retirement must be bounded");
  });

  it("never spawns for invalid or empty job ids", async () => {
    const { retireJobProgress } = await loadModule();
    for (const bad of ["bad id!", "job id with spaces", "", "job/../escape", 42, null, undefined]) {
      const res = retireJobProgress({ jobId: bad, env: retireEnv() });
      assert.equal(res.skipped, true, `jobId ${JSON.stringify(bad)} must not spawn`);
    }
    assert.deepEqual(readLog(logFile), [], "no spawn may happen for invalid ids");
  });

  it("never spawns when KUSABI_KAIBA_RETIRE=0 (operator opt-out)", async () => {
    const { retireJobProgress } = await loadModule();
    const env = retireEnv({ KUSABI_KAIBA_RETIRE: "0" });
    const res = retireJobProgress({ jobId: "job-optout1", env });
    assert.equal(res.skipped, true);
    assert.deepEqual(readLog(logFile), []);
  });

  it("surfaces non-ENOENT spawn failures (EACCES) as actionable", async () => {
    const { retireJobProgress } = await loadModule();
    // A directory is not executable: spawnSync fails with EACCES — a real
    // deployment failure, unlike ENOENT, and must be observable.
    const env = retireEnv({ KAIBA_RETIRE_BIN: tmpDir });
    const res = retireJobProgress({ jobId: "job-eacces1", env });
    assert.equal(res.skipped, false);
    assert.equal(res.ok, false);
    assert.ok(res.error, "spawn failure must carry an error message");
  });

  it("repeating the same job id is safe (kaiba retire is idempotent)", async () => {
    const { retireJobProgress } = await loadModule();
    const env = retireEnv();
    retireJobProgress({ jobId: "job-dup1", env });
    retireJobProgress({ jobId: "job-dup1", env });
    assert.deepEqual(readLog(logFile), [
      ["--job", "job-dup1"],
      ["--job", "job-dup1"],
    ]);
  });
});