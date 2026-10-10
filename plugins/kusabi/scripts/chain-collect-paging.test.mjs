import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import {
  collectChangeScope,
  collectContainerReviewInput,
  CHANGE_SCOPE_HOST_PATH,
  CHANGE_SCOPE_CONTAINER_PATH,
} from "./chain-collect.mjs";

/**
 * Creates a realistic Sunaba RPC fake that models:
 * 1. Default 50-line pagination window (params.limit ?? 50) and offset (params.offset ?? 0).
 * 2. Summary truncation (head-50 / tail-50 at max_lines=100) before pagination when verbose !== "full".
 * 3. Explicit verbose: "full" which bypasses summary truncation.
 * 4. Incremental pagination via read_output(container_id, output_id, offset, limit) or sandbox_exec(offset).
 * 5. Real execution of change-scope.mjs against a provided git repository when invoked.
 */
function makeSunabaFake({ tempRepoDir, baseSha, headSha, execOverride } = {}) {
  const calls = [];
  const outputStore = new Map();
  let outputCounter = 0;

  const callTool = async (toolName, params) => {
    calls.push({ toolName, params });

    if (toolName === "copy_file") {
      return { status: "ok" };
    }

    if (toolName === "read_output") {
      const stored = outputStore.get(params?.output_id);
      if (!stored) {
        return { status: "error", error: `Output ID ${params?.output_id} not found` };
      }
      const offset = params?.offset ?? 0;
      const limit = params?.limit ?? 50;
      const pageLines = stored.displayLines.slice(offset, offset + limit);
      const hasMore = (offset + limit) < stored.displayLines.length;
      return {
        status: "ok",
        output_id: params?.output_id,
        offset,
        output: pageLines.join("\n"),
        shown: pageLines.length,
        total_lines: stored.totalLines,
        truncated: stored.summaryTruncated || hasMore,
        next_offset: hasMore ? offset + limit : null,
        has_more: hasMore,
      };
    }

    if (toolName === "sandbox_exec") {
      if (typeof execOverride === "function") {
        const overrideResult = execOverride(params);
        if (overrideResult !== null && overrideResult !== undefined) {
          return overrideResult;
        }
      }

      const fullCmd = params?.commands?.[0] ?? params?.argv?.join(" ") ?? "";

      if (fullCmd.includes("git rev-parse")) {
        return {
          status: "ok",
          exit_code: 0,
          output: `${baseSha}\n`,
          shown: 1,
          total_lines: 1,
          truncated: false,
          has_more: false,
          next_offset: null,
        };
      }

      if (fullCmd.includes("git status")) {
        return {
          status: "ok",
          exit_code: 0,
          output: "",
          shown: 0,
          total_lines: 0,
          truncated: false,
          has_more: false,
          next_offset: null,
        };
      }

      if (fullCmd.includes("git log")) {
        return {
          status: "ok",
          exit_code: 0,
          output: `${baseSha?.slice(0, 7) ?? "deadbee"} init\n`,
          shown: 1,
          total_lines: 1,
          truncated: false,
          has_more: false,
          next_offset: null,
        };
      }

      if (fullCmd.includes("git ls-files")) {
        return {
          status: "ok",
          exit_code: 0,
          output: "",
          shown: 0,
          total_lines: 0,
          truncated: false,
          has_more: false,
          next_offset: null,
        };
      }

      if (fullCmd.includes("change-scope.mjs")) {
        const args = params?.argv ? params.argv.slice(2) : ["--base", baseSha, "--head", headSha];
        const execResult = spawnSync(process.execPath, [CHANGE_SCOPE_HOST_PATH, ...args], {
          cwd: tempRepoDir,
          encoding: "utf8",
        });

        if (execResult.status !== 0) {
          return {
            status: "error",
            exit_code: execResult.status ?? 1,
            stderr: execResult.stderr || "",
            output: execResult.stdout || "",
          };
        }

        const rawLines = (execResult.stdout ?? "").split("\n");
        const totalLines = rawLines.length;
        const maxLines = params?.max_lines ?? 100;
        const isFullVerbose = params?.verbose === "full";

        let displayLines = rawLines;
        let summaryTruncated = false;
        if (!isFullVerbose && totalLines > maxLines) {
          const headCount = Math.floor(maxLines / 2);
          const tailCount = maxLines - headCount;
          const head = rawLines.slice(0, headCount);
          const tail = rawLines.slice(-tailCount);
          const omittedCount = totalLines - maxLines;
          displayLines = head.concat([`... (${omittedCount} lines omitted)`], tail);
          summaryTruncated = true;
        }

        const offset = params?.offset ?? 0;
        const limit = params?.limit ?? 50;
        const pageLines = displayLines.slice(offset, offset + limit);
        const hasMore = (offset + limit) < displayLines.length;
        const nextOffset = hasMore ? (offset + limit) : null;
        const isTruncated = summaryTruncated || hasMore;

        const outputId = `out_${++outputCounter}`;
        outputStore.set(outputId, {
          rawLines,
          displayLines: isFullVerbose ? rawLines : displayLines,
          totalLines,
          summaryTruncated,
        });

        return {
          status: "ok",
          exit_code: 0,
          output: pageLines.join("\n"),
          shown: pageLines.length,
          total_lines: totalLines,
          truncated: isTruncated,
          next_offset: nextOffset,
          has_more: hasMore,
          output_id: outputId,
          resource: "read_output(container_id, output_id, offset=0, limit=100)",
        };
      }

      return {
        status: "ok",
        exit_code: 0,
        output: "",
        shown: 0,
        total_lines: 0,
        truncated: false,
        has_more: false,
        next_offset: null,
      };
    }

    return { status: "ok", output: "" };
  };

  return { callTool, calls, outputStore };
}

describe("large change-scope transport regression (kusabi #667)", () => {
  const NUM_COMMITTED_FILES = 90;
  let tempRepoDir;
  let baseSha;
  let headSha;

  before(() => {
    tempRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-change-scope-paging-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: tempRepoDir });
    execFileSync("git", ["config", "user.name", "kusabi-test"], { cwd: tempRepoDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempRepoDir });

    fs.writeFileSync(path.join(tempRepoDir, "base.txt"), "base content\n");
    execFileSync("git", ["add", "base.txt"], { cwd: tempRepoDir });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: tempRepoDir });
    baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tempRepoDir, encoding: "utf8" }).trim();

    for (let i = 0; i < NUM_COMMITTED_FILES; i++) {
      const fname = `file_${String(i).padStart(3, "0")}.txt`;
      fs.writeFileSync(path.join(tempRepoDir, fname), `content line for ${fname}\n`);
    }
    execFileSync("git", ["add", "."], { cwd: tempRepoDir });
    execFileSync("git", ["commit", "-m", `add ${NUM_COMMITTED_FILES} files`], { cwd: tempRepoDir });
    headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tempRepoDir, encoding: "utf8" }).trim();
  });

  after(() => {
    if (tempRepoDir && fs.existsSync(tempRepoDir)) {
      fs.rmSync(tempRepoDir, { recursive: true, force: true });
    }
  });

  describe("fake modeling checks", () => {
    it("models Sunaba 50-line paging, 100-line summary truncation, and full verbose bypass", async () => {
      const { callTool } = makeSunabaFake({ tempRepoDir, baseSha, headSha });

      // Default call: 50 lines, summary truncated (exceeds 100 max_lines), has_more: true
      const defaultPage = await callTool("sandbox_exec", {
        container_id: "cid-test",
        argv: ["node", CHANGE_SCOPE_CONTAINER_PATH, "--base", baseSha, "--head", headSha],
      });
      assert.equal(defaultPage.shown, 50);
      assert.ok(defaultPage.total_lines > 100);
      assert.equal(defaultPage.truncated, true);
      assert.equal(defaultPage.has_more, true);
      assert.equal(defaultPage.next_offset, 50);
      assert.ok(defaultPage.output_id);

      // Explicit verbose: "full" and limit: 200 retrieves complete payload
      const fullCapture = await callTool("sandbox_exec", {
        container_id: "cid-test",
        argv: ["node", CHANGE_SCOPE_CONTAINER_PATH, "--base", baseSha, "--head", headSha],
        verbose: "full",
        limit: 200,
      });
      assert.equal(fullCapture.shown, defaultPage.total_lines);
      assert.equal(fullCapture.total_lines, defaultPage.total_lines);
      assert.equal(fullCapture.truncated, false);
      assert.equal(fullCapture.has_more, false);
      assert.equal(fullCapture.next_offset, null);
      const parsedScope = JSON.parse(fullCapture.output);
      assert.equal(parsedScope.paths.committed.length, NUM_COMMITTED_FILES);

      // read_output retrieves subsequent page by output_id
      const page2 = await callTool("read_output", {
        container_id: "cid-test",
        output_id: defaultPage.output_id,
        offset: 50,
        limit: 50,
      });
      assert.equal(page2.offset, 50);
      assert.equal(page2.shown, 50);
      assert.equal(page2.has_more, true);
    });
  });

  describe("acceptance criterion 1: collectChangeScope complete capture under default-paging fake", () => {
    it("collectChangeScope returns exact complete scope for payload exceeding 50 lines", async () => {
      const { callTool } = makeSunabaFake({ tempRepoDir, baseSha, headSha });
      const scope = await collectChangeScope({
        callTool,
        container: "cid-paging-test",
        base: baseSha,
        head: headSha,
      });

      assert.equal(scope.formatVersion, 1);
      assert.equal(scope.resolved.baseSha, baseSha);
      assert.equal(scope.resolved.headSha, headSha);
      assert.equal(scope.resolved.mergeBaseSha, baseSha);
      assert.equal(scope.paths.committed.length, NUM_COMMITTED_FILES);
      assert.equal(scope.paths.committed[0], "file_000.txt");
      const lastFile = `file_${String(NUM_COMMITTED_FILES - 1).padStart(3, "0")}.txt`;
      assert.equal(scope.paths.committed[NUM_COMMITTED_FILES - 1], lastFile);
      assert.deepEqual(scope.paths.staged, []);
      assert.deepEqual(scope.paths.unstaged, []);
      assert.deepEqual(scope.paths.untracked, []);
    });
  });

  describe("acceptance criterion 2: collectContainerReviewInput succeeds without aborting", () => {
    it("collectContainerReviewInput succeeds for large scope and includes final path and authoritative base", async () => {
      const { callTool } = makeSunabaFake({ tempRepoDir, baseSha, headSha });
      const input = await collectContainerReviewInput({
        container: "cid-paging-test",
        callTool,
        base: baseSha,
      });

      assert.ok(typeof input === "string");
      assert.ok(input.startsWith("## Review target"));
      assert.ok(input.includes("Authoritative change set (`change-scope`):"));
      assert.ok(input.includes(`- Base commit: \`${baseSha}\``));
      assert.ok(input.includes(`\`base\` set to \`${baseSha}\``));
      assert.ok(input.includes('"file_000.txt"'));
      const lastFile = `file_${String(NUM_COMMITTED_FILES - 1).padStart(3, "0")}.txt`;
      assert.ok(input.includes(`"${lastFile}"`), `review input must include final path ${lastFile}`);
      assert.ok(!input.includes("diff --git"));
    });
  });

  describe("acceptance criterion 3: malformed JSON and nonzero execution remain errors", () => {
    const errorCases = [
      {
        name: "nonzero execution in sandbox_exec fails closed without porcelain substitution",
        container: "cid-fail-exit",
        response: {
          status: "error",
          exit_code: 1,
          stderr: "git rev-list fatal: bad object ref",
          output: "",
        },
        expected: /change-scope failed with exit code 1: git rev-list fatal: bad object ref/,
      },
      {
        name: "genuinely malformed JSON output fails closed without synthetic scope or porcelain fallback",
        container: "cid-fail-json",
        response: {
          status: "ok",
          exit_code: 0,
          output: "{ unclosed_json_syntax: [",
        },
        expected: /change-scope produced invalid JSON/,
      },
      {
        name: "JSON contract mismatch fails closed (formatVersion must be 1)",
        container: "cid-fail-contract",
        response: {
          status: "ok",
          exit_code: 0,
          output: JSON.stringify({ formatVersion: 999, resolved: {}, paths: {} }),
        },
        expected: /change-scope JSON contract mismatch/,
      },
    ];

    for (const { name, container, response, expected } of errorCases) {
      it(name, async () => {
        const { callTool } = makeSunabaFake({
          tempRepoDir,
          baseSha,
          headSha,
          execOverride: (params) => {
            const fullCmd = params?.commands?.[0] ?? params?.argv?.join(" ") ?? "";
            return fullCmd.includes("change-scope.mjs") ? response : null;
          },
        });

        await assert.rejects(
          () => collectChangeScope({ callTool, container, base: baseSha, head: headSha }),
          expected,
        );
        await assert.rejects(
          () => collectContainerReviewInput({ container, callTool, base: baseSha }),
          expected,
        );
      });
    }
  });
});
