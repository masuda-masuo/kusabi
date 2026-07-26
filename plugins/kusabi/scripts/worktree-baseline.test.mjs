// worktree-baseline.test.mjs — Unit tests for worktree baseline functions
//
// Covers:
//  - computeNewlyChanged baseline comparison
//  - isWorktreeUnchanged equivalence check
//  - checkDeliverablesSinceBaseline probe decisions
//  - resolveWorktreeChanged flag resolution
//  - captureWorktreeState with a throwaway git repo (no live opencode serve)
//  - Missing baseline handling (old records)

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

import {
  computeNewlyChanged,
  isWorktreeUnchanged,
  checkDeliverablesSinceBaseline,
  resolveWorktreeChanged,
  captureWorktreeState,
} from "./worktree-baseline.mjs";

// Sample manifests for pure-function tests
// ---------------------------------------------------------------------------

const BASELINE_EMPTY = { treeHash: "empty", files: {} };

const BASELINE_WITH_FILE = {
  treeHash: "abc123",
  files: {
    "plugins/kusabi/scripts/foo.mjs": "hash-foo-v1",
    "docs/DESIGN.md": "hash-design-v1",
    "src/main.py": "hash-main-v1",
  },
};

const CURRENT_SAME = {
  treeHash: "abc123",
  files: {
    "plugins/kusabi/scripts/foo.mjs": "hash-foo-v1",
    "docs/DESIGN.md": "hash-design-v1",
    "src/main.py": "hash-main-v1",
  },
};

const CURRENT_MODIFIED = {
  treeHash: "def456",
  files: {
    "plugins/kusabi/scripts/foo.mjs": "hash-foo-v2", // changed
    "docs/DESIGN.md": "hash-design-v1",               // same
    "src/main.py": "hash-main-v1",                    // same
  },
};

const CURRENT_ADDED = {
  treeHash: "ghi789",
  files: {
    "plugins/kusabi/scripts/foo.mjs": "hash-foo-v1",
    "docs/DESIGN.md": "hash-design-v1",
    "src/main.py": "hash-main-v1",
    "plugins/kusabi/scripts/bar.mjs": "hash-bar-v1", // new
  },
};

const CURRENT_REMOVED = {
  treeHash: "jkl012",
  files: {
    "plugins/kusabi/scripts/foo.mjs": "hash-foo-v1",
    "docs/DESIGN.md": "hash-design-v1",
    // src/main.py is gone — file was deleted or reverted to HEAD state
  },
};

// =========================================================================
// computeNewlyChanged
// =========================================================================

describe("computeNewlyChanged", () => {
  it("returns empty when both manifests are identical", () => {
    const result = computeNewlyChanged(BASELINE_WITH_FILE, CURRENT_SAME);
    assert.deepEqual(result, []);
  });

  it("detects a single modified file", () => {
    const result = computeNewlyChanged(BASELINE_WITH_FILE, CURRENT_MODIFIED);
    assert.deepEqual(result, ["plugins/kusabi/scripts/foo.mjs"]);
  });

  it("detects a newly added file", () => {
    const result = computeNewlyChanged(BASELINE_WITH_FILE, CURRENT_ADDED);
    assert.deepEqual(result, ["plugins/kusabi/scripts/bar.mjs"]);
  });

  it("detects a removed file", () => {
    const result = computeNewlyChanged(BASELINE_WITH_FILE, CURRENT_REMOVED);
    assert.deepEqual(result, ["src/main.py"]);
  });

  // A missing manifest means the comparison could not be made.  These must be
  // null, not []: an empty array asserts "nothing changed", and shouldSkipReview
  // discards a round on that — so returning [] here would turn a failed
  // measurement into a discarded round.
  it("returns null when baseline is null", () => {
    assert.equal(computeNewlyChanged(null, CURRENT_SAME), null);
  });

  it("returns null when baseline is undefined", () => {
    assert.equal(computeNewlyChanged(undefined, CURRENT_SAME), null);
  });

  it("returns null when current is null", () => {
    assert.equal(computeNewlyChanged(BASELINE_WITH_FILE, null), null);
  });

  it("returns null when current is undefined", () => {
    assert.equal(computeNewlyChanged(BASELINE_WITH_FILE, undefined), null);
  });

  it("returns null when both inputs are missing", () => {
    assert.equal(computeNewlyChanged(null, null), null);
    assert.equal(computeNewlyChanged(undefined, undefined), null);
  });

  it("unknown is distinguishable from 'nothing changed'", () => {
    // The whole point of the null: an identical worktree yields [], a missing
    // measurement yields null, and callers must be able to tell them apart.
    assert.deepEqual(computeNewlyChanged(BASELINE_WITH_FILE, BASELINE_WITH_FILE), []);
    assert.equal(computeNewlyChanged(BASELINE_WITH_FILE, null), null);
  });

  it("handles empty baseline files", () => {
    const result = computeNewlyChanged(BASELINE_EMPTY, CURRENT_ADDED);
    assert.deepEqual(result, Object.keys(CURRENT_ADDED.files));
  });

  it("handles empty current files", () => {
    const result = computeNewlyChanged(BASELINE_WITH_FILE, BASELINE_EMPTY);
    assert.deepEqual(result, Object.keys(BASELINE_WITH_FILE.files));
  });
});

// =========================================================================
// isWorktreeUnchanged
// =========================================================================

describe("isWorktreeUnchanged", () => {
  it("returns true when tree hashes match", () => {
    assert.equal(isWorktreeUnchanged(BASELINE_WITH_FILE, CURRENT_SAME), true);
  });

  it("returns false when tree hashes differ", () => {
    assert.equal(isWorktreeUnchanged(BASELINE_WITH_FILE, CURRENT_MODIFIED), false);
  });

  it("returns false when baseline is null", () => {
    assert.equal(isWorktreeUnchanged(null, CURRENT_SAME), false);
  });

  it("returns false when baseline is undefined", () => {
    assert.equal(isWorktreeUnchanged(undefined, CURRENT_SAME), false);
  });

  it("returns false when current is null", () => {
    assert.equal(isWorktreeUnchanged(BASELINE_WITH_FILE, null), false);
  });

  it("returns false when current is undefined", () => {
    assert.equal(isWorktreeUnchanged(BASELINE_WITH_FILE, undefined), false);
  });
});

// =========================================================================
// checkDeliverablesSinceBaseline
// =========================================================================

describe("checkDeliverablesSinceBaseline", () => {
  // --- dirty baseline + round changed nothing → not a pass ---
  it("fails when baseline is dirty and round changed nothing", () => {
    const result = checkDeliverablesSinceBaseline(
      ["plugins/kusabi/scripts/foo.mjs"],
      [], // newlyChanged is empty
    );
    assert.equal(result.passed, false);
    assert.match(
      result.detail,
      /no paths changed since baseline/,
    );
  });

  // --- dirty baseline + round modified a declared path → pass ---
  it("passes when baseline is dirty and round modified a declared path", () => {
    const result = checkDeliverablesSinceBaseline(
      ["plugins/kusabi/scripts/foo.mjs"],
      ["plugins/kusabi/scripts/foo.mjs"],
    );
    assert.equal(result.passed, true);
    assert.match(result.detail, /touches declared deliverables/);
  });

  // --- clean baseline behaves as before ---
  it("passes when no deliverables declared (trivial pass)", () => {
    const result = checkDeliverablesSinceBaseline([], ["file.js"]);
    assert.equal(result.passed, true);
    assert.match(result.detail, /no Deliverables declared/);
  });

  it("fails when newlyChanged is empty and deliverables are declared", () => {
    const result = checkDeliverablesSinceBaseline(["file.js"], []);
    assert.equal(result.passed, false);
  });

  it("probe name is P3: deliverables", () => {
    const result = checkDeliverablesSinceBaseline([], []);
    assert.equal(result.probe, "P3: deliverables");
  });

  // --- untracked file created by round is detected ---
  it("detects an untracked file created by the round", () => {
    const baseline = {
      treeHash: "base",
      files: {
        "src/main.py": "hash-main-v1",
      },
    };
    const current = {
      treeHash: "curr",
      files: {
        "src/main.py": "hash-main-v1",
        "plugins/kusabi/scripts/new_file.mjs": "hash-new", // untracked new file
      },
    };
    const changed = computeNewlyChanged(baseline, current);
    const result = checkDeliverablesSinceBaseline(
      ["plugins/kusabi/scripts/new_file.mjs"],
      changed,
    );
    assert.equal(result.passed, true);
  });

  // --- missing baseline → unknown ---
  it("treats missing baseline as unknown in worktreeChanged", () => {
    assert.equal(resolveWorktreeChanged(null, CURRENT_SAME), null);
    assert.equal(resolveWorktreeChanged(undefined, CURRENT_SAME), null);
  });

  // --- heading present but no entries parsed → fail ---
  it("fails when heading present but no entries parsed", () => {
    const result = checkDeliverablesSinceBaseline([], ["file.js"], true);
    assert.equal(result.passed, false);
    assert.match(result.detail, /heading present but no entries parsed/);
  });

  // --- heading absent and no entries → trivial pass ---
  it("still passes when heading absent and no entries", () => {
    const result = checkDeliverablesSinceBaseline([], ["file.js"], false);
    assert.equal(result.passed, true);
  });

  // --- directory matching ---
  it("passes when a declared directory contains a newly changed path", () => {
    const result = checkDeliverablesSinceBaseline(
      ["plugins/kusabi/scripts"],
      ["plugins/kusabi/scripts/foo.mjs"],
    );
    assert.equal(result.passed, true);
  });

  it("fails when changed paths are not in declared deliverables", () => {
    const result = checkDeliverablesSinceBaseline(
      ["plugins/kusabi/scripts/foo.mjs"],
      ["docs/DESIGN.md"],
    );
    assert.equal(result.passed, false);
    assert.match(result.detail, /no declared deliverable touched/);
  });

  // --- never throws ---
  it("never throws on any input", () => {
    assert.doesNotThrow(() => checkDeliverablesSinceBaseline(null, null));
    assert.doesNotThrow(() => checkDeliverablesSinceBaseline(undefined, undefined));
    assert.doesNotThrow(() => checkDeliverablesSinceBaseline([], null));
    assert.doesNotThrow(() =>
      checkDeliverablesSinceBaseline("not-array", "not-array"),
    );
  });
});

// =========================================================================
// resolveWorktreeChanged
// =========================================================================

describe("resolveWorktreeChanged", () => {
  it("returns true when worktree changed since baseline", () => {
    const result = resolveWorktreeChanged(BASELINE_WITH_FILE, CURRENT_MODIFIED);
    assert.equal(result, true);
  });

  it("returns false when worktree unchanged since baseline", () => {
    const result = resolveWorktreeChanged(BASELINE_WITH_FILE, CURRENT_SAME);
    assert.equal(result, false);
  });

  it("returns null when baseline is absent (old record)", () => {
    assert.equal(resolveWorktreeChanged(null, CURRENT_SAME), null);
    assert.equal(resolveWorktreeChanged(undefined, CURRENT_SAME), null);
  });

  it("returns null when current capture failed", () => {
    assert.equal(resolveWorktreeChanged(BASELINE_WITH_FILE, null), null);
  });
});

// =========================================================================
// captureWorktreeState with a throwaway git repo
// =========================================================================

describe("captureWorktreeState (throwaway git repo)", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-wtb-test-"));

    // Initialise a throwaway git repo
    execFileSync("git", ["init", tmpDir], { stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "test@test"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: tmpDir });

    // First commit: create a file
    fs.writeFileSync(path.join(tmpDir, "existing.js"), "// existing content");
    execFileSync("git", ["add", "-A"], { cwd: tmpDir });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Create a fake callTool that runs a shell command inside the throwaway
   * git repo.  The repo root is tmpDir so we capture the working-directory
   * approach.
   */
  function makeFakeTool(repoDir) {
    return async (_toolName, params) => {
      if (_toolName !== "sandbox_exec") return { output: "" };
      // Replace /workspace with the temp repo dir for the test
      const cmd = params.commands[0]
        .replace(/cd \/workspace && /, `cd ${repoDir} && `);
      try {
        const stdout = execFileSync("bash", ["-c", cmd], {
          cwd: repoDir,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          stdio: ["pipe", "pipe", "pipe"],
        });
        return { output: stdout };
      } catch (err) {
        return { output: err.stdout || "", stderr: err.stderr || "" };
      }
    };
  }

  it("captures a clean worktree (no modifications)", async () => {
    const tool = makeFakeTool(tmpDir);
    const manifest = await captureWorktreeState(tool, "fake-cid");
    assert.ok(manifest, "should return a manifest");
    assert.ok(manifest.treeHash, "should have a treeHash");
    // Only existing.js should be in the manifest
    assert.ok(manifest.files["existing.js"], "existing.js should be present");
  });

  it("captures a modified file", async () => {
    // Modify the file
    fs.writeFileSync(path.join(tmpDir, "existing.js"), "// modified content");
    const tool = makeFakeTool(tmpDir);
    const manifest = await captureWorktreeState(tool, "fake-cid");
    assert.ok(manifest, "should return a manifest for modified file");
    assert.ok(manifest.files["existing.js"], "existing.js should be in manifest");
  });

  it("captures an untracked (new) file", async () => {
    fs.writeFileSync(path.join(tmpDir, "new_file.py"), "# new untracked file");
    const tool = makeFakeTool(tmpDir);
    const manifest = await captureWorktreeState(tool, "fake-cid");
    assert.ok(manifest);
    assert.ok(manifest.files["new_file.py"], "new_file.py should be in manifest");
    assert.ok(manifest.files["existing.js"], "existing.js should still be in manifest");
  });

  it("baseline comparison detects modified file", async () => {
    const tool1 = makeFakeTool(tmpDir);
    const baseline = await captureWorktreeState(tool1, "fake-cid");

    // Modify a file
    fs.writeFileSync(path.join(tmpDir, "existing.js"), "// modified content");
    const tool2 = makeFakeTool(tmpDir);
    const current = await captureWorktreeState(tool2, "fake-cid");

    assert.ok(baseline);
    assert.ok(current);

    const changed = computeNewlyChanged(baseline, current);
    assert.ok(changed.includes("existing.js"), "should detect modified file");
    assert.equal(changed.length, 1, "only one file should have changed");

    assert.equal(isWorktreeUnchanged(baseline, current), false);
  });

  it("baseline comparison detects new untracked file", async () => {
    const tool1 = makeFakeTool(tmpDir);
    const baseline = await captureWorktreeState(tool1, "fake-cid");

    // Add a new untracked file
    fs.writeFileSync(path.join(tmpDir, "new_file.py"), "# new file");
    const tool2 = makeFakeTool(tmpDir);
    const current = await captureWorktreeState(tool2, "fake-cid");

    assert.ok(baseline);
    assert.ok(current);

    const changed = computeNewlyChanged(baseline, current);
    assert.ok(changed.includes("new_file.py"), "should detect new untracked file");
  });

  it("isWorktreeUnchanged returns true when worktree has not changed", async () => {
    const tool = makeFakeTool(tmpDir);
    const baseline = await captureWorktreeState(tool, "fake-cid");
    const current = await captureWorktreeState(tool, "fake-cid");
    assert.ok(baseline);
    assert.ok(current);
    assert.equal(isWorktreeUnchanged(baseline, current), true);
    assert.equal(resolveWorktreeChanged(baseline, current), false);
  });

  it("returns manifest with modified AND untracked files", async () => {
    // Modify existing + add new
    fs.writeFileSync(path.join(tmpDir, "existing.js"), "// modified content");
    fs.writeFileSync(path.join(tmpDir, "brand_new.rs"), "fn main() {}");
    const tool = makeFakeTool(tmpDir);
    const manifest = await captureWorktreeState(tool, "fake-cid");
    assert.ok(manifest);
    // Both files should be in the manifest
    assert.ok(manifest.files["existing.js"]);
    assert.ok(manifest.files["brand_new.rs"]);
  });

  it("returns null when git repo has no index", async () => {
    // Remove the index
    fs.rmSync(path.join(tmpDir, ".git", "index"), { force: true });
    const tool = makeFakeTool(tmpDir);
    const manifest = await captureWorktreeState(tool, "fake-cid");
    assert.equal(manifest, null);
  });

  it("returns null when the command fails", async () => {
    const failingTool = async () => {
      throw new Error("network error");
    };
    const manifest = await captureWorktreeState(failingTool, "fake-cid");
    assert.equal(manifest, null);
  });

  it("computes correctly from baseline to current (newly changed list)", async () => {
    const tool = makeFakeTool(tmpDir);

    // Baseline: just existing.js
    const baseline = await captureWorktreeState(tool, "fake-cid");

    // Modify existing.js and add a new file
    fs.writeFileSync(path.join(tmpDir, "existing.js"), "// v2");
    fs.writeFileSync(path.join(tmpDir, "readme.md"), "# readme");
    const current = await captureWorktreeState(tool, "fake-cid");

    const changed = computeNewlyChanged(baseline, current);
    // Both existing.js (modified) and readme.md (new) should be in the list
    assert.ok(changed.includes("existing.js"), "modified file should be detected");
    assert.ok(changed.includes("readme.md"), "new file should be detected");
    assert.equal(changed.length, 2, "two files changed");
  });

  it("handles dirty baseline + round changed nothing", async () => {
    const tool = makeFakeTool(tmpDir);

    // First state: dirty (modified existing.js)
    fs.writeFileSync(path.join(tmpDir, "existing.js"), "// dirty state");
    const dirtyBaseline = await captureWorktreeState(tool, "fake-cid");

    // Round does nothing — capture again without changing anything
    const afterRound = await captureWorktreeState(tool, "fake-cid");

    const changed = computeNewlyChanged(dirtyBaseline, afterRound);
    assert.deepEqual(changed, [], "no paths should have changed");

    assert.equal(isWorktreeUnchanged(dirtyBaseline, afterRound), true);
    assert.equal(resolveWorktreeChanged(dirtyBaseline, afterRound), false);
  });

  it("handles dirty baseline + round added a new file", async () => {
    const tool = makeFakeTool(tmpDir);

    // Dirty baseline: existing.js was modified
    fs.writeFileSync(path.join(tmpDir, "existing.js"), "// dirty state");
    const dirtyBaseline = await captureWorktreeState(tool, "fake-cid");

    // Round adds a new file
    fs.writeFileSync(path.join(tmpDir, "new_output.js"), "// round output");
    const afterRound = await captureWorktreeState(tool, "fake-cid");

    const changed = computeNewlyChanged(dirtyBaseline, afterRound);
    assert.deepEqual(changed, ["new_output.js"], "only the new file should appear");

    assert.equal(isWorktreeUnchanged(dirtyBaseline, afterRound), false);
    assert.equal(resolveWorktreeChanged(dirtyBaseline, afterRound), true);
  });
});
