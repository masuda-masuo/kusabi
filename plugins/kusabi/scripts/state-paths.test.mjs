import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  stateRoot,
} from "./state-paths.mjs";

// stateRoot — state directory resolution with migration
// ---------------------------------------------------------------------------

describe("stateRoot", () => {
  it("uses KUSABI_STATE_DIR env var when set", () => {
    const saved = process.env.KUSABI_STATE_DIR;
    try {
      process.env.KUSABI_STATE_DIR = "/tmp/kusabi-test-custom";
      assert.equal(stateRoot(), "/tmp/kusabi-test-custom");
    } finally {
      if (saved === undefined) delete process.env.KUSABI_STATE_DIR;
      else process.env.KUSABI_STATE_DIR = saved;
    }
  });

  it("falls back to OPENCODE_COMPANION_STATE_DIR when KUSABI_STATE_DIR is not set", () => {
    const savedKusabi = process.env.KUSABI_STATE_DIR;
    const savedOld = process.env.OPENCODE_COMPANION_STATE_DIR;
    try {
      delete process.env.KUSABI_STATE_DIR;
      process.env.OPENCODE_COMPANION_STATE_DIR = "/tmp/kusabi-test-legacy";
      assert.equal(stateRoot(), "/tmp/kusabi-test-legacy");
    } finally {
      if (savedKusabi === undefined) delete process.env.KUSABI_STATE_DIR;
      else process.env.KUSABI_STATE_DIR = savedKusabi;
      if (savedOld === undefined) delete process.env.OPENCODE_COMPANION_STATE_DIR;
      else process.env.OPENCODE_COMPANION_STATE_DIR = savedOld;
    }
  });

  it("returns {home}/.kusabi with default os.homedir() when no env var is set", () => {
    const savedKusabi = process.env.KUSABI_STATE_DIR;
    const savedOld = process.env.OPENCODE_COMPANION_STATE_DIR;
    try {
      delete process.env.KUSABI_STATE_DIR;
      delete process.env.OPENCODE_COMPANION_STATE_DIR;
      const result = stateRoot();
      assert.equal(result, path.join(os.homedir(), ".kusabi"));
    } finally {
      if (savedKusabi === undefined) delete process.env.KUSABI_STATE_DIR;
      else process.env.KUSABI_STATE_DIR = savedKusabi;
      if (savedOld === undefined) delete process.env.OPENCODE_COMPANION_STATE_DIR;
      else process.env.OPENCODE_COMPANION_STATE_DIR = savedOld;
    }
  });

  it("returns {home}/.kusabi with injected home directory", () => {
    const savedKusabi = process.env.KUSABI_STATE_DIR;
    const savedOld = process.env.OPENCODE_COMPANION_STATE_DIR;
    try {
      delete process.env.KUSABI_STATE_DIR;
      delete process.env.OPENCODE_COMPANION_STATE_DIR;
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-"));
      try {
        const result = stateRoot(home);
        assert.equal(result, path.join(home, ".kusabi"));
      } finally {
        fs.rmSync(home, { recursive: true });
      }
    } finally {
      if (savedKusabi === undefined) delete process.env.KUSABI_STATE_DIR;
      else process.env.KUSABI_STATE_DIR = savedKusabi;
      if (savedOld === undefined) delete process.env.OPENCODE_COMPANION_STATE_DIR;
      else process.env.OPENCODE_COMPANION_STATE_DIR = savedOld;
    }
  });

  it("migrates old .opencode-plugin-cc to .kusabi when only old dir exists", () => {
    const savedKusabi = process.env.KUSABI_STATE_DIR;
    const savedOld = process.env.OPENCODE_COMPANION_STATE_DIR;
    try {
      delete process.env.KUSABI_STATE_DIR;
      delete process.env.OPENCODE_COMPANION_STATE_DIR;

      const home = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-"));
      const oldDir = path.join(home, ".opencode-plugin-cc");
      const newDir = path.join(home, ".kusabi");

      // Create old dir with a marker file
      fs.mkdirSync(oldDir, { recursive: true });
      const marker = path.join(oldDir, "migration-marker");
      fs.writeFileSync(marker, "pre-migration data", "utf8");

      try {
        const result = stateRoot(home);
        assert.equal(result, newDir);
        // Old dir should be gone (renamed to new)
        assert.ok(!fs.existsSync(oldDir), "old dir should not exist after migration");
        // New dir should contain the marker
        assert.ok(fs.existsSync(path.join(newDir, "migration-marker")), "migration marker should exist in new dir");
      } finally {
        fs.rmSync(home, { recursive: true });
      }
    } finally {
      if (savedKusabi === undefined) delete process.env.KUSABI_STATE_DIR;
      else process.env.KUSABI_STATE_DIR = savedKusabi;
      if (savedOld === undefined) delete process.env.OPENCODE_COMPANION_STATE_DIR;
      else process.env.OPENCODE_COMPANION_STATE_DIR = savedOld;
    }
  });

  it("skips migration when env var is set even if old dir exists", () => {
    const savedKusabi = process.env.KUSABI_STATE_DIR;
    const savedOld = process.env.OPENCODE_COMPANION_STATE_DIR;
    try {
      delete process.env.KUSABI_STATE_DIR;
      delete process.env.OPENCODE_COMPANION_STATE_DIR;

      const home = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-"));
      const oldDir = path.join(home, ".opencode-plugin-cc");

      // Create old dir
      fs.mkdirSync(oldDir, { recursive: true });

      try {
        // Set env override
        process.env.KUSABI_STATE_DIR = "/tmp/kusabi-env-override-test";
        const result = stateRoot(home);
        assert.equal(result, "/tmp/kusabi-env-override-test");
        // Old dir should still exist (not migrated because env is set)
        assert.ok(fs.existsSync(oldDir), "old dir should still exist when env is set");
      } finally {
        fs.rmSync(home, { recursive: true });
      }
    } finally {
      if (savedKusabi === undefined) delete process.env.KUSABI_STATE_DIR;
      else process.env.KUSABI_STATE_DIR = savedKusabi;
      if (savedOld === undefined) delete process.env.OPENCODE_COMPANION_STATE_DIR;
      else process.env.OPENCODE_COMPANION_STATE_DIR = savedOld;
    }
  });
});

