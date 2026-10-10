import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  stateRoot,
  readJson,
  writeJson,
} from "./state-paths.mjs";
import { patchEnv } from "./fixtures.mjs";

// stateRoot — state directory resolution with migration
// ---------------------------------------------------------------------------

describe("stateRoot", () => {
  let restoreEnv;
  let home;

  beforeEach(() => {
    restoreEnv = patchEnv({
      KUSABI_STATE_DIR: undefined,
      OPENCODE_COMPANION_STATE_DIR: undefined,
    });
    home = undefined;
  });

  afterEach(() => {
    try {
      if (home) fs.rmSync(home, { recursive: true, force: true });
    } finally {
      restoreEnv();
    }
  });

  it("uses KUSABI_STATE_DIR env var when set", () => {
    process.env.KUSABI_STATE_DIR = "/tmp/kusabi-test-custom";
    assert.equal(stateRoot(), "/tmp/kusabi-test-custom");
  });

  it("falls back to OPENCODE_COMPANION_STATE_DIR when KUSABI_STATE_DIR is not set", () => {
    process.env.OPENCODE_COMPANION_STATE_DIR = "/tmp/kusabi-test-legacy";
    assert.equal(stateRoot(), "/tmp/kusabi-test-legacy");
  });

  it("returns {home}/.kusabi with default os.homedir() when no env var is set", () => {
    const result = stateRoot();
    assert.equal(result, path.join(os.homedir(), ".kusabi"));
  });

  it("returns {home}/.kusabi with injected home directory", () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-"));
    const result = stateRoot(home);
    assert.equal(result, path.join(home, ".kusabi"));
  });

  it("migrates old .opencode-plugin-cc to .kusabi when only old dir exists", () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-"));
    const oldDir = path.join(home, ".opencode-plugin-cc");
    const newDir = path.join(home, ".kusabi");

    // Create old dir with a marker file
    fs.mkdirSync(oldDir, { recursive: true });
    const marker = path.join(oldDir, "migration-marker");
    fs.writeFileSync(marker, "pre-migration data", "utf8");

    const result = stateRoot(home);
    assert.equal(result, newDir);
    // Old dir should be gone (renamed to new)
    assert.ok(!fs.existsSync(oldDir), "old dir should not exist after migration");
    // New dir should contain the marker
    assert.ok(fs.existsSync(path.join(newDir, "migration-marker")), "migration marker should exist in new dir");
  });

  it("skips migration when env var is set even if old dir exists", () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-"));
    const oldDir = path.join(home, ".opencode-plugin-cc");

    // Create old dir
    fs.mkdirSync(oldDir, { recursive: true });

    // Set env override
    process.env.KUSABI_STATE_DIR = "/tmp/kusabi-env-override-test";
    const result = stateRoot(home);
    assert.equal(result, "/tmp/kusabi-env-override-test");
    // Old dir should still exist (not migrated because env is set)
    assert.ok(fs.existsSync(oldDir), "old dir should still exist when env is set");
  });
});
// writeJson — atomic replace (kusabi #511)
// ---------------------------------------------------------------------------

describe("writeJson atomic replace", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-writejson-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("replaces the target with the new full content and leaves no temp files", () => {
    const file = path.join(tmpDir, "job.json");
    writeJson(file, { id: "job-atomic-1", status: "running" });
    writeJson(file, { id: "job-atomic-1", status: "completed", phase: "implement" });

    assert.deepEqual(readJson(file), { id: "job-atomic-1", status: "completed", phase: "implement" });
    assert.equal(
      fs.readFileSync(file, "utf8"),
      `${JSON.stringify({ id: "job-atomic-1", status: "completed", phase: "implement" }, null, 2)}\n`,
      "trailing newline is preserved",
    );
    assert.deepEqual(fs.readdirSync(tmpDir), ["job.json"], "no temp files left behind");
  });

  it("keeps the old target content and removes the temp file when the temp write throws mid-way", () => {
    const file = path.join(tmpDir, "job.json");
    const oldValue = { id: "job-atomic-2", status: "running", version: 1 };
    writeJson(file, oldValue);

    const realWriteFileSync = fs.writeFileSync;
    let tempWriteAttempted = false;
    fs.writeFileSync = (target, data, ...rest) => {
      if (target !== file && path.basename(target).startsWith(`.${path.basename(file)}.`)) {
        // Simulate a torn temp write: partial bytes on the temp path, then fail.
        tempWriteAttempted = true;
        realWriteFileSync(target, '{"id": "job-atomic-2", "status": "ru', "utf8");
        throw new Error("simulated disk full");
      }
      return realWriteFileSync(target, data, ...rest);
    };

    let thrown = null;
    try {
      writeJson(file, { id: "job-atomic-2", status: "completed", version: 2 });
    } catch (err) {
      thrown = err;
    } finally {
      fs.writeFileSync = realWriteFileSync;
    }

    assert.ok(tempWriteAttempted, "the temp path write should have been attempted");
    assert.ok(thrown instanceof Error, "writeJson must rethrow the temp write failure");
    assert.match(thrown.message, /simulated disk full/);
    // The target is untouched: still the old full content, never a partial mix.
    assert.deepEqual(readJson(file), oldValue);
    assert.deepEqual(fs.readdirSync(tmpDir), ["job.json"], "temp file removed on failure");
  });

  it("removes the temp file and rethrows when the rename over the target fails", () => {
    const file = path.join(tmpDir, "job.json");
    const oldValue = { id: "job-atomic-3", status: "running", version: 1 };
    writeJson(file, oldValue);

    const realRenameSync = fs.renameSync;
    let renameAttempted = false;
    fs.renameSync = (from, to) => {
      if (to === file) {
        renameAttempted = true;
        throw new Error("simulated rename failure");
      }
      return realRenameSync(from, to);
    };

    let thrown = null;
    try {
      writeJson(file, { id: "job-atomic-3", status: "completed", version: 2 });
    } catch (err) {
      thrown = err;
    } finally {
      fs.renameSync = realRenameSync;
    }

    assert.ok(renameAttempted, "the rename over the target should have been attempted");
    assert.ok(thrown instanceof Error, "writeJson must rethrow the rename failure");
    assert.match(thrown.message, /simulated rename failure/);
    assert.deepEqual(readJson(file), oldValue, "target keeps the old content");
    assert.deepEqual(fs.readdirSync(tmpDir), ["job.json"], "temp file removed on failure");
  });
});
