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

    // Modify a file.  The replacement must differ in SIZE, not just bytes:
    // a same-size write can land inside the fixture commit's mtime at coarse
    // filesystem timestamp granularity, and then git's stat cache skips
    // re-hashing the entry during `git add -A` (the temp-index copy's fresh
    // mtime also defeats the racy-clean re-check) — the modification goes
    // undetected and this test flakes (observed on CI, run 31464361388,
    // 2026-08-11; passed on rerun).  A size change forces the re-hash under
    // any timestamp granularity.
    fs.writeFileSync(path.join(tmpDir, "existing.js"), "// modified content, longer than before");
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

// =========================================================================
// captureWorktreeState — truncation contract (kusabi #143)
// =========================================================================
//
// captureWorktreeState must never return a partial manifest: retrieval is
// verified-complete (the parsed entry count equals the shell's COUNT marker
// and the sandbox_exec response carries no truncation sign) or the capture
// is null.  The fix has three parts: verbose="full" (disables sunaba's
// pre-pagination summary truncation at max_lines=100), an explicit large
// `limit` (defeats the default 50-line page), and the COUNT/truncation
// verification.  These tests drive the function with injected fake
// callTools: canned responses pin the parser contracts, and a faithful fake
// reproducing sunaba's real output pipeline (truncate_output then
// paginate_output — see sunaba src/sunaba/tools/exec.py) proves that large
// listings succeed end-to-end.

describe("captureWorktreeState truncation contract", () => {
  /**
   * Fake callTool returning a canned sandbox_exec response; records every
   * call's params so tests can assert on the request shape.
   */
  function makeFakeTool(response, calls) {
    return async (toolName, params) => {
      calls.push(params);
      if (toolName !== "sandbox_exec") return { output: "" };
      return response;
    };
  }

  /**
   * Fake callTool that reproduces sunaba's real sandbox_exec output pipeline
   * (src/sunaba/tools/exec.py): sanitize -> truncate_output(verbose,
   * max_lines=100) -> paginate_output(offset, limit), returning the same
   * response fields (shown/total_lines/truncated/next_offset/has_more).
   * A listing can only arrive complete when the request disables summary
   * truncation with verbose="full" AND pages with a large enough limit —
   * exactly the fix under test.  Without verbose="full", any listing over
   * max_lines is reduced to head-50 / "... (N lines omitted)" / tail-50
   * with truncated=true BEFORE pagination can see it.
   */
  function faithfulSunabaFake(fullOutput, calls) {
    return async (toolName, params) => {
      calls.push(params);
      if (toolName !== "sandbox_exec") return { output: "" };
      if (!fullOutput || !fullOutput.trim()) {
        return {
          status: "ok",
          output: "",
          shown: 0,
          total_lines: 0,
          truncated: false,
          next_offset: null,
          has_more: false,
        };
      }
      const maxLines = 100;
      const lines = fullOutput.split("\n");
      const totalLines = lines.length;
      let display = fullOutput;
      let truncated = false;
      let shown = totalLines;
      if (params.verbose !== "full" && totalLines > maxLines) {
        const headCount = Math.floor(maxLines / 2);
        const tailCount = maxLines - headCount;
        const head = lines.slice(0, headCount);
        const tail = lines.slice(-tailCount);
        display = head
          .concat(["... (" + (totalLines - maxLines) + " lines omitted)"], tail)
          .join("\n");
        truncated = true;
        shown = head.length + 1 + tail.length;
      }
      const displayLines = display.split("\n");
      const offset = params.offset ?? 0;
      const limit = params.limit ?? 50;
      const page = displayLines.slice(offset, offset + limit);
      const hasMore = offset + limit < displayLines.length;
      return {
        status: "ok",
        output: page.join("\n"),
        shown,
        total_lines: totalLines,
        truncated,
        next_offset: hasMore ? offset + limit : null,
        has_more: hasMore,
      };
    };
  }

  /** Build a complete listing: TREE_HASH + n sorted hash|path entries + COUNT. */
  function buildListing(n) {
    const lines = ["TREE_HASH=tree-" + n];
    const expected = {};
    for (let i = 0; i < n; i++) {
      const filePath = "file-" + String(i).padStart(3, "0");
      const hash = "hash-" + String(i).padStart(3, "0");
      lines.push(hash + "|" + filePath);
      expected[filePath] = hash;
    }
    lines.push("COUNT=" + n);
    return { text: lines.join("\n"), expected };
  }

  it("complete small listing → manifest with correct treeHash and files map", async () => {
    const output = [
      "TREE_HASH=abc123",
      "hash-foo|src/foo.mjs",
      "hash-bar|docs/guide.md",
      "COUNT=2",
    ].join("\n");
    const calls = [];
    // Mimic the real sunaba_exec response shape from the incident:
    // truncated/has_more present and false.
    const tool = makeFakeTool(
      { output, truncated: false, has_more: false, next_offset: null },
      calls,
    );
    const manifest = await captureWorktreeState(tool, "fake-cid");
    assert.ok(manifest, "complete listing must yield a manifest");
    assert.equal(manifest.treeHash, "abc123");
    assert.deepEqual(manifest.files, {
      "src/foo.mjs": "hash-foo",
      "docs/guide.md": "hash-bar",
    });
  });

  it("requests verbose=full and an explicit large page limit from sandbox_exec", async () => {
    const calls = [];
    const tool = makeFakeTool({ output: "TREE_HASH=abc\nCOUNT=0" }, calls);
    await captureWorktreeState(tool, "fake-cid");
    assert.equal(calls.length, 1);
    const params = calls[0];
    assert.equal(params.container_id, "fake-cid");
    // verbose="full" disables sunaba's pre-pagination summary truncation
    // (head-50/tail-50 at max_lines=100): a large limit alone cannot
    // recover the omitted middle, so this flag is part of the fix.
    assert.equal(
      params.verbose,
      "full",
      "capture must disable summary truncation via verbose=full",
    );
    // The pre-fix call omitted `limit`, so sunaba's 50-line default page
    // silently truncated any repo with more than ~49 tracked files.
    assert.ok(
      Number.isInteger(params.limit) && params.limit >= 10000,
      "capture must pass an explicit large limit (got " + params.limit + ")",
    );
  });

  it("truncated: true in the response → null", async () => {
    const output = [
      "TREE_HASH=abc123",
      "hash-a|a.js",
      "hash-b|b.js",
      "COUNT=2",
    ].join("\n");
    const tool = makeFakeTool({ output, truncated: true }, []);
    const manifest = await captureWorktreeState(tool, "fake-cid");
    assert.equal(manifest, null);
  });

  it("has_more: true in the response → null", async () => {
    const output = [
      "TREE_HASH=abc123",
      "hash-a|a.js",
      "hash-b|b.js",
      "COUNT=2",
    ].join("\n");
    const tool = makeFakeTool({ output, has_more: true }, []);
    const manifest = await captureWorktreeState(tool, "fake-cid");
    assert.equal(manifest, null);
  });

  it("COUNT marker mismatch (fewer parsed entries than COUNT) → null", async () => {
    // Three entries delivered but the pipeline counted five: retrieval or
    // parsing lost lines — the capture is unverifiable.
    const output = [
      "TREE_HASH=abc123",
      "hash-a|a.js",
      "hash-b|b.js",
      "hash-c|c.js",
      "COUNT=5",
    ].join("\n");
    const tool = makeFakeTool({ output }, []);
    const manifest = await captureWorktreeState(tool, "fake-cid");
    assert.equal(manifest, null);
  });

  it("unparseable line silently dropped → COUNT mismatch → null", async () => {
    // A line with no pipe is not an entry; it would be silently ignored, so
    // the parsed count falls below COUNT and the capture is rejected.
    const output = [
      "TREE_HASH=abc123",
      "hash-a|a.js",
      "some garbage line without a pipe",
      "hash-b|b.js",
      "COUNT=3",
    ].join("\n");
    const tool = makeFakeTool({ output }, []);
    const manifest = await captureWorktreeState(tool, "fake-cid");
    assert.equal(manifest, null);
  });

  it("missing COUNT marker → null", async () => {
    const output = [
      "TREE_HASH=abc123",
      "hash-a|a.js",
      "hash-b|b.js",
    ].join("\n");
    const tool = makeFakeTool({ output }, []);
    const manifest = await captureWorktreeState(tool, "fake-cid");
    assert.equal(manifest, null);
  });

  it("regression: 300-entry listing succeeds against a faithful sunaba model (verbose=full + large limit)", async () => {
    // The pre-fix defect had two layers: sunaba's summary truncation
    // (max_lines=100) kept only head-50/tail-50 with truncated=true, and its
    // default 50-line page cut the rest — a repo with more than ~49 tracked
    // files produced a manifest containing only the alphabetically-first
    // paths (or, with the flag check, null).  The faithful fake reproduces
    // sunaba's real pipeline (truncate_output then paginate_output), so this
    // test proves the fixed request — verbose="full" + large limit — yields
    // the complete 302-line listing through the same pipeline a real server
    // runs.
    const { text, expected } = buildListing(300);
    const calls = [];
    const tool = faithfulSunabaFake(text, calls);
    const manifest = await captureWorktreeState(tool, "fake-cid");
    assert.ok(manifest, "300-entry listing must yield a manifest");
    assert.equal(manifest.treeHash, "tree-300");
    assert.equal(Object.keys(manifest.files).length, 300);
    assert.deepEqual(manifest.files, expected);
    // the request that made it possible: summary truncation disabled, and a
    // page window covering the whole display in one response
    assert.equal(calls[0].verbose, "full");
    assert.ok(calls[0].limit >= 300, "limit must cover the whole listing");
  });

  it("regression: 99 tracked files (101 lines) succeeds against the faithful sunaba model", async () => {
    // 99 entries + TREE_HASH + COUNT = 101 lines, just past sunaba's
    // summary max_lines=100: with default verbose this listing is destroyed
    // before pagination; with verbose="full" it arrives complete.
    const { text, expected } = buildListing(99);
    const calls = [];
    const tool = faithfulSunabaFake(text, calls);
    const manifest = await captureWorktreeState(tool, "fake-cid");
    assert.ok(manifest, "99-entry listing must yield a manifest");
    assert.equal(Object.keys(manifest.files).length, 99);
    assert.deepEqual(manifest.files, expected);
    assert.equal(calls[0].verbose, "full");
  });

  it("faithful model sanity: pre-fix request shapes are summary-truncated (the failure the fix defeats)", async () => {
    // Direct checks of the faithful fake, proving it models the real server:
    // requests without verbose="full" get head-50/tail-50 with
    // truncated=true — responses captureWorktreeState must (and does)
    // reject as incomplete.
    const { text } = buildListing(300);
    const calls = [];
    const tool = faithfulSunabaFake(text, calls);

    // Pre-fix shape: no verbose, default limit=50 -> page 0 of the truncated
    // display is TREE_HASH + the first 49 entries, truncated=true.
    const page0 = await tool("sandbox_exec", {
      container_id: "fake-cid",
      commands: ["x"],
      limit: 50,
    });
    assert.equal(page0.truncated, true);
    assert.equal(page0.output.split("\n").length, 50);
    assert.ok(!page0.output.includes("COUNT=300"));
    // feeding that response shape into the capture yields null, never a
    // 49-entry manifest
    const manifest = await captureWorktreeState(
      makeFakeTool({ output: page0.output, truncated: true }, []),
      "fake-cid",
    );
    assert.equal(manifest, null);

    // Same request without verbose but a page window big enough to see the
    // middle: the display is head-50 / "... (202 lines omitted)" / tail-50.
    // The omitted middle is unrecoverable by any page window — which is why
    // verbose="full" is part of the fix.
    const fullPage = await tool("sandbox_exec", {
      container_id: "fake-cid",
      commands: ["x"],
      limit: 500,
    });
    assert.equal(fullPage.truncated, true);
    assert.match(fullPage.output, /lines omitted/);
    assert.equal(fullPage.output.split("\n").length, 101);
    const nullManifest = await captureWorktreeState(
      makeFakeTool({ output: fullPage.output, truncated: true }, []),
      "fake-cid",
    );
    assert.equal(nullManifest, null);
  });

  it("regression: pre-fix failure shape (first 49 lines only, truncation flagged) → null, never a 49-entry manifest", async () => {
    // Exactly what the incident produced: the response was cut at sunaba's
    // 50-line default page (TREE_HASH + 49 entries) with truncated=true.
    const { text } = buildListing(300);
    const truncatedOutput = text.split("\n").slice(0, 50).join("\n");
    assert.ok(!truncatedOutput.includes("COUNT=300"));
    const tool = makeFakeTool({ output: truncatedOutput, truncated: true }, []);
    const manifest = await captureWorktreeState(tool, "fake-cid");
    assert.equal(
      manifest,
      null,
      "truncated listing must never yield a partial manifest",
    );
  });

  it("regression: 49-entry window without truncation flag but COUNT missing → null", async () => {
    // The same cut delivered WITHOUT the truncation flag: the COUNT marker
    // is absent, so the capture is still rejected — never a 49-entry
    // manifest even if sunaba failed to flag the truncation.
    const { text } = buildListing(300);
    const cutOutput = text.split("\n").slice(0, 50).join("\n");
    const tool = makeFakeTool({ output: cutOutput }, []);
    const manifest = await captureWorktreeState(tool, "fake-cid");
    assert.equal(manifest, null);
  });

  it("preserves pipe-containing paths (first pipe is the separator)", async () => {
    const output = [
      "TREE_HASH=abc123",
      "hash-1|src/odd|name.js",
      "hash-2|plain.js",
      "COUNT=2",
    ].join("\n");
    const tool = makeFakeTool({ output }, []);
    const manifest = await captureWorktreeState(tool, "fake-cid");
    assert.ok(manifest);
    assert.equal(manifest.files["src/odd|name.js"], "hash-1");
    assert.equal(manifest.files["plain.js"], "hash-2");
  });

  it("empty listing with COUNT=0 → manifest with empty files", async () => {
    const tool = makeFakeTool({ output: "TREE_HASH=empty\nCOUNT=0" }, []);
    const manifest = await captureWorktreeState(tool, "fake-cid");
    assert.ok(manifest);
    assert.equal(manifest.treeHash, "empty");
    assert.deepEqual(manifest.files, {});
  });

  it("ERROR_NO_INDEX → null", async () => {
    const tool = makeFakeTool({ output: "ERROR_NO_INDEX\n" }, []);
    const manifest = await captureWorktreeState(tool, "fake-cid");
    assert.equal(manifest, null);
  });

  it("empty output → null", async () => {
    const tool = makeFakeTool({ output: "" }, []);
    const manifest = await captureWorktreeState(tool, "fake-cid");
    assert.equal(manifest, null);
  });
});
