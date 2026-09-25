//
// Tests for Luna post-chain evidence carrying untracked new files (kusabi #572).
//
// Acceptance criteria:
// 1. A stub callTool returning a tracked raw_diff plus untracked: ["a.mjs", "b.test.mjs"],
//    and file contents for both, yields postChain.diff containing the tracked diff first,
//    then both blocks with +-prefixed lines, in order; untrackedIncluded equals ["a.mjs", "b.test.mjs"].
// 2. read_file_range is called with limit: -1 for each untracked path (assert the arguments).
// 3. A read that throws for one file yields [content unavailable: …] for that file while the
//    other file's content is present.
// 4. has_more: true yields the [content incomplete: …] line.
// 5. Content larger than maxBytes (pass a small maxBytes) sets diffTruncated: true and a positive diffOmittedBytes.
// 6. untracked absent / empty → postChain.diff is byte-identical to today's result for the same raw_diff,
//    and read_file_range is never called.
//

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  collectPostChainEvidence,
  formatUntrackedFileDiff,
} from "./luna-driver.mjs";
import { stateDirFor, writeJson } from "./state-paths.mjs";

function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("luna untracked post-chain evidence (kusabi #572)", () => {
  let root;
  let cwd;
  let stateDir;
  let previousStateDir;

  beforeEach(() => {
    root = makeTemp("kusabi-untracked-");
    cwd = path.join(root, "work");
    fs.mkdirSync(cwd, { recursive: true });
    previousStateDir = process.env.KUSABI_STATE_DIR;
    process.env.KUSABI_STATE_DIR = path.join(root, "state");
    stateDir = stateDirFor(cwd);
  });

  afterEach(() => {
    if (previousStateDir === undefined) delete process.env.KUSABI_STATE_DIR;
    else process.env.KUSABI_STATE_DIR = previousStateDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function setupChain({ chainId = "chain-untracked", baseSha = "base-sha-572" } = {}) {
    const chainDir = path.join(stateDir, "chains", chainId);
    writeJson(path.join(chainDir, "chain.json"), {
      baseSha,
      records: [{ round: 1 }],
    });
    writeJson(path.join(chainDir, "round-1.json"), {
      round: 1,
      probeResults: [{ probe: "P1: HEAD clean", passed: true }],
      changeScope: { paths: { unstaged: [] } },
    });
    return { chainId, baseSha };
  }

  describe("formatUntrackedFileDiff helper", () => {
    it("formats content with trailing newline with + prefix on each line", () => {
      const block = formatUntrackedFileDiff("src/index.js", "const a = 1;\nconst b = 2;\n");
      const expected =
        "diff --git a/src/index.js b/src/index.js\n" +
        "new file (untracked; content read with read_file_range)\n" +
        "--- /dev/null\n" +
        "+++ b/src/index.js\n" +
        "+const a = 1;\n" +
        "+const b = 2;\n";
      assert.equal(block, expected);
    });

    it("formats content without trailing newline preserving the last line", () => {
      const block = formatUntrackedFileDiff("src/index.js", "line1\nline2");
      const expected =
        "diff --git a/src/index.js b/src/index.js\n" +
        "new file (untracked; content read with read_file_range)\n" +
        "--- /dev/null\n" +
        "+++ b/src/index.js\n" +
        "+line1\n" +
        "+line2\n";
      assert.equal(block, expected);
    });

    it("formats empty file with headers and no + lines", () => {
      const block = formatUntrackedFileDiff("empty.txt", "");
      const expected =
        "diff --git a/empty.txt b/empty.txt\n" +
        "new file (untracked; content read with read_file_range)\n" +
        "--- /dev/null\n" +
        "+++ b/empty.txt\n";
      assert.equal(block, expected);
    });

    it("formats read error with [content unavailable: <reason>]", () => {
      const block = formatUntrackedFileDiff("err.txt", "", { readError: "permission denied" });
      const expected =
        "diff --git a/err.txt b/err.txt\n" +
        "new file (untracked; content read with read_file_range)\n" +
        "--- /dev/null\n" +
        "+++ b/err.txt\n" +
        "[content unavailable: permission denied]\n";
      assert.equal(block, expected);
    });

    it("formats hasMore flag with [content incomplete: read_file_range reported has_more]", () => {
      const block = formatUntrackedFileDiff("large.txt", "part1\n", { hasMore: true });
      const expected =
        "diff --git a/large.txt b/large.txt\n" +
        "new file (untracked; content read with read_file_range)\n" +
        "--- /dev/null\n" +
        "+++ b/large.txt\n" +
        "+part1\n" +
        "[content incomplete: read_file_range reported has_more]\n";
      assert.equal(block, expected);
    });
  });

  describe("collectPostChainEvidence untracked file handling", () => {
    it("criterion 1 & 2: collects tracked diff, appends untracked blocks in order, and asserts limit: -1", async () => {
      const { chainId } = setupChain();
      const toolCalls = [];

      const callTool = async (name, args) => {
        toolCalls.push({ name, args });
        if (name === "diff_in_container") {
          return {
            status: "ok",
            raw_diff: "diff --git a/tracked.js b/tracked.js\n--- a/tracked.js\n+++ b/tracked.js\n@@ -1 +1 @@\n-old\n+new\n",
            untracked: ["a.mjs", "b.test.mjs"],
          };
        }
        if (name === "read_file_range") {
          if (args.file_path === "a.mjs") {
            return {
              status: "ok",
              content: "const a = 1;\nexport default a;\n",
              has_more: false,
              error: null,
            };
          }
          if (args.file_path === "b.test.mjs") {
            return {
              status: "ok",
              content: "import test from 'node:test';\n",
              has_more: false,
              error: null,
            };
          }
        }
        throw new Error(`unexpected tool call: ${name}`);
      };

      const pc = await collectPostChainEvidence({
        stateDir,
        chainId,
        container: "container-572",
        callTool,
      });

      // Assert untrackedIncluded equals ["a.mjs", "b.test.mjs"]
      assert.deepEqual(pc.untrackedIncluded, ["a.mjs", "b.test.mjs"]);

      // Assert tool calls and limit: -1
      assert.equal(toolCalls.length, 3);
      assert.equal(toolCalls[0].name, "diff_in_container");
      assert.equal(toolCalls[0].args.container_id, "container-572");
      assert.equal(toolCalls[0].args.base, "base-sha-572");
      assert.equal(toolCalls[0].args.raw, true);

      assert.equal(toolCalls[1].name, "read_file_range");
      assert.equal(toolCalls[1].args.container_id, "container-572");
      assert.equal(toolCalls[1].args.file_path, "a.mjs");
      assert.equal(toolCalls[1].args.limit, -1);

      assert.equal(toolCalls[2].name, "read_file_range");
      assert.equal(toolCalls[2].args.container_id, "container-572");
      assert.equal(toolCalls[2].args.file_path, "b.test.mjs");
      assert.equal(toolCalls[2].args.limit, -1);

      // Assert postChain.diff contains tracked diff first, then both untracked blocks in order
      const expectedDiff =
        "diff --git a/tracked.js b/tracked.js\n--- a/tracked.js\n+++ b/tracked.js\n@@ -1 +1 @@\n-old\n+new\n" +
        "diff --git a/a.mjs b/a.mjs\n" +
        "new file (untracked; content read with read_file_range)\n" +
        "--- /dev/null\n" +
        "+++ b/a.mjs\n" +
        "+const a = 1;\n" +
        "+export default a;\n" +
        "diff --git a/b.test.mjs b/b.test.mjs\n" +
        "new file (untracked; content read with read_file_range)\n" +
        "--- /dev/null\n" +
        "+++ b/b.test.mjs\n" +
        "+import test from 'node:test';\n";

      assert.equal(pc.diff, expectedDiff);
      assert.equal(pc.diffTruncated, false);
      assert.equal(pc.diffOmittedBytes, 0);
    });

    it("criterion 1: handles tracked raw_diff that does not end in a newline", async () => {
      const { chainId } = setupChain();
      const callTool = async (name) => {
        if (name === "diff_in_container") {
          return {
            status: "ok",
            raw_diff: "diff --git a/tracked.js b/tracked.js\n+NEW",
            untracked: ["a.mjs"],
          };
        }
        if (name === "read_file_range") {
          return {
            status: "ok",
            content: "line1\n",
            has_more: false,
            error: null,
          };
        }
        throw new Error(`unexpected tool: ${name}`);
      };

      const pc = await collectPostChainEvidence({
        stateDir,
        chainId,
        container: "cid",
        callTool,
      });

      assert.ok(pc.diff.startsWith("diff --git a/tracked.js b/tracked.js\n+NEW\ndiff --git a/a.mjs b/a.mjs\n"));
    });

    it("criterion 3: when read throws for one file, yields [content unavailable: …] and keeps other file and tracked diff", async () => {
      const { chainId } = setupChain();
      const callTool = async (name, args) => {
        if (name === "diff_in_container") {
          return {
            status: "ok",
            raw_diff: "diff --git a/tracked.js b/tracked.js\n+tracked\n",
            untracked: ["first.js", "failing.js", "third.js"],
          };
        }
        if (name === "read_file_range") {
          if (args.file_path === "first.js") {
            return { status: "ok", content: "console.log(1);\n", has_more: false };
          }
          if (args.file_path === "failing.js") {
            throw new Error("container filesystem error");
          }
          if (args.file_path === "third.js") {
            return { status: "ok", content: "console.log(3);\n", has_more: false };
          }
        }
        throw new Error(`unexpected tool: ${name}`);
      };

      const pc = await collectPostChainEvidence({
        stateDir,
        chainId,
        container: "cid",
        callTool,
      });

      assert.deepEqual(pc.untrackedIncluded, ["first.js", "failing.js", "third.js"]);
      assert.ok(pc.diff.includes("diff --git a/tracked.js b/tracked.js\n+tracked\n"));
      assert.ok(pc.diff.includes("diff --git a/first.js b/first.js\nnew file (untracked; content read with read_file_range)\n--- /dev/null\n+++ b/first.js\n+console.log(1);\n"));
      assert.ok(pc.diff.includes("diff --git a/failing.js b/failing.js\nnew file (untracked; content read with read_file_range)\n--- /dev/null\n+++ b/failing.js\n[content unavailable: container filesystem error]\n"));
      assert.ok(pc.diff.includes("diff --git a/third.js b/third.js\nnew file (untracked; content read with read_file_range)\n--- /dev/null\n+++ b/third.js\n+console.log(3);\n"));
    });

    it("criterion 3: handles read_file_range status: 'error' and non-null error", async () => {
      const { chainId } = setupChain();
      const callTool = async (name, args) => {
        if (name === "diff_in_container") {
          return {
            status: "ok",
            raw_diff: "",
            untracked: ["status-err.js", "non-null-err.js", "missing-content.js"],
          };
        }
        if (name === "read_file_range") {
          if (args.file_path === "status-err.js") {
            return { status: "error", error: "read failed with error status" };
          }
          if (args.file_path === "non-null-err.js") {
            return { status: "ok", error: "file unreadable", content: null };
          }
          if (args.file_path === "missing-content.js") {
            return { status: "ok", error: null }; // no content property
          }
        }
        throw new Error(`unexpected tool: ${name}`);
      };

      const pc = await collectPostChainEvidence({
        stateDir,
        chainId,
        container: "cid",
        callTool,
      });

      assert.ok(pc.diff.includes("[content unavailable: read failed with error status]\n"));
      assert.ok(pc.diff.includes("[content unavailable: file unreadable]\n"));
      assert.ok(pc.diff.includes("[content unavailable: read_file_range returned no content]\n"));
    });

    it("criterion 4: when read_file_range reports has_more: true, appends [content incomplete: …]", async () => {
      const { chainId } = setupChain();
      const callTool = async (name) => {
        if (name === "diff_in_container") {
          return {
            status: "ok",
            raw_diff: "diff --git a/tracked.js b/tracked.js\n",
            untracked: ["truncated-file.js"],
          };
        }
        if (name === "read_file_range") {
          return {
            status: "ok",
            content: "const partial = true;\n",
            has_more: true,
            error: null,
          };
        }
        throw new Error(`unexpected tool: ${name}`);
      };

      const pc = await collectPostChainEvidence({
        stateDir,
        chainId,
        container: "cid",
        callTool,
      });

      const expectedBlock =
        "diff --git a/truncated-file.js b/truncated-file.js\n" +
        "new file (untracked; content read with read_file_range)\n" +
        "--- /dev/null\n" +
        "+++ b/truncated-file.js\n" +
        "+const partial = true;\n" +
        "[content incomplete: read_file_range reported has_more]\n";

      assert.ok(pc.diff.includes(expectedBlock));
    });

    it("criterion 5: combined content larger than maxBytes sets diffTruncated: true and positive diffOmittedBytes", async () => {
      const { chainId } = setupChain();
      const callTool = async (name) => {
        if (name === "diff_in_container") {
          return {
            status: "ok",
            raw_diff: "diff --git a/tracked.js b/tracked.js\n+TRACKED\n",
            untracked: ["large.txt"],
          };
        }
        if (name === "read_file_range") {
          return {
            status: "ok",
            content: "Z".repeat(5000) + "\n",
            has_more: false,
          };
        }
        throw new Error(`unexpected tool: ${name}`);
      };

      const pc = await collectPostChainEvidence({
        stateDir,
        chainId,
        container: "cid",
        callTool,
        maxBytes: 200,
      });

      assert.equal(pc.diffTruncated, true);
      assert.ok(pc.diffOmittedBytes > 0);
      assert.ok(Buffer.byteLength(pc.diff, "utf8") <= 200);
    });

    it("criterion 6: untracked absent → postChain.diff is byte-identical to today's result, read_file_range never called", async () => {
      const { chainId } = setupChain();
      const toolCalls = [];
      const rawDiff = "diff --git a/file.js b/file.js\n+NEW";

      const callTool = async (name, args) => {
        toolCalls.push({ name, args });
        return {
          status: "ok",
          raw_diff: rawDiff,
          // untracked absent
        };
      };

      const pc = await collectPostChainEvidence({
        stateDir,
        chainId,
        container: "cid",
        callTool,
      });

      assert.equal(pc.diff, rawDiff);
      assert.equal(pc.diffTruncated, false);
      assert.equal(pc.diffOmittedBytes, 0);
      assert.equal(pc.untrackedIncluded, undefined);

      const readFileCalls = toolCalls.filter((c) => c.name === "read_file_range");
      assert.equal(readFileCalls.length, 0, "read_file_range must never be called");
    });

    it("criterion 6: untracked empty array → postChain.diff is byte-identical to today's result, read_file_range never called", async () => {
      const { chainId } = setupChain();
      const toolCalls = [];
      const rawDiff = "diff --git a/file.js b/file.js\n+NEW\n";

      const callTool = async (name, args) => {
        toolCalls.push({ name, args });
        return {
          status: "ok",
          raw_diff: rawDiff,
          untracked: [],
        };
      };

      const pc = await collectPostChainEvidence({
        stateDir,
        chainId,
        container: "cid",
        callTool,
      });

      assert.equal(pc.diff, rawDiff);
      assert.equal(pc.diffTruncated, false);
      assert.equal(pc.diffOmittedBytes, 0);
      assert.equal(pc.untrackedIncluded, undefined);

      const readFileCalls = toolCalls.filter((c) => c.name === "read_file_range");
      assert.equal(readFileCalls.length, 0, "read_file_range must never be called");
    });

    it("spec 2: empty untracked file gets header lines and no + lines", async () => {
      const { chainId } = setupChain();
      const callTool = async (name) => {
        if (name === "diff_in_container") {
          return {
            status: "ok",
            raw_diff: "",
            untracked: ["empty.txt"],
          };
        }
        if (name === "read_file_range") {
          return {
            status: "ok",
            content: "",
            has_more: false,
          };
        }
        throw new Error(`unexpected tool: ${name}`);
      };

      const pc = await collectPostChainEvidence({
        stateDir,
        chainId,
        container: "cid",
        callTool,
      });

      const expected =
        "diff --git a/empty.txt b/empty.txt\n" +
        "new file (untracked; content read with read_file_range)\n" +
        "--- /dev/null\n" +
        "+++ b/empty.txt\n";

      assert.equal(pc.diff, expected);
      assert.ok(!pc.diff.includes("+empty.txt"));
      assert.ok(!pc.diff.includes("+\n"));
    });

    it("spec 2: file without trailing newline still gets its last line prefixed with +", async () => {
      const { chainId } = setupChain();
      const callTool = async (name) => {
        if (name === "diff_in_container") {
          return {
            status: "ok",
            raw_diff: "",
            untracked: ["no-eol.txt"],
          };
        }
        if (name === "read_file_range") {
          return {
            status: "ok",
            content: "first line\nlast line without newline",
            has_more: false,
          };
        }
        throw new Error(`unexpected tool: ${name}`);
      };

      const pc = await collectPostChainEvidence({
        stateDir,
        chainId,
        container: "cid",
        callTool,
      });

      const expected =
        "diff --git a/no-eol.txt b/no-eol.txt\n" +
        "new file (untracked; content read with read_file_range)\n" +
        "--- /dev/null\n" +
        "+++ b/no-eol.txt\n" +
        "+first line\n" +
        "+last line without newline\n";

      assert.equal(pc.diff, expected);
    });

    it("spec 2: when raw_diff is empty string, untracked diff starts directly without leading newline", async () => {
      const { chainId } = setupChain();
      const callTool = async (name) => {
        if (name === "diff_in_container") {
          return {
            status: "ok",
            raw_diff: "",
            untracked: ["brand-new.js"],
          };
        }
        if (name === "read_file_range") {
          return {
            status: "ok",
            content: "export const x = 1;\n",
            has_more: false,
          };
        }
        throw new Error(`unexpected tool: ${name}`);
      };

      const pc = await collectPostChainEvidence({
        stateDir,
        chainId,
        container: "cid",
        callTool,
      });

      assert.ok(pc.diff.startsWith("diff --git a/brand-new.js b/brand-new.js\n"));
      assert.ok(!pc.diff.startsWith("\n"));
    });
  });
});
