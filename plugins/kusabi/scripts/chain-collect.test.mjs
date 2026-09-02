import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectContainerBaseContext,
  CHANGE_SCOPE_CONTAINER_PATH,
  CHANGE_SCOPE_HOST_PATH,
  collectChangeScope,
  assertContainerBaseRef,
  collectContainerReviewInput,
  collectReviewContext,
} from "./chain-collect.mjs";
import {
  shouldSkipReview,
} from "./chain-review.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// =========================================================================
// Source guards (kusabi #449)
// =========================================================================

describe("chain-collect source guards (kusabi #449)", () => {
  it("chain-phases.mjs does not export moved container collection functions or constants", () => {
    const chainPhasesSrc = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "chain-phases.mjs"), "utf8");
    assert.ok(!chainPhasesSrc.includes("export async function collectContainerBaseContext("));
    assert.ok(!chainPhasesSrc.includes("export async function collectChangeScope("));
    assert.ok(!chainPhasesSrc.includes("export function assertContainerBaseRef("));
    assert.ok(!chainPhasesSrc.includes("export async function collectContainerReviewInput("));
    assert.ok(!chainPhasesSrc.includes("export async function collectReviewContext("));
    assert.ok(!chainPhasesSrc.includes("export const CHANGE_SCOPE_CONTAINER_PATH"));
    assert.ok(!chainPhasesSrc.includes("export const CHANGE_SCOPE_HOST_PATH"));
  });

  it("chain-phases.mjs does not import chain-collect.mjs", () => {
    const chainPhasesSrc = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "chain-phases.mjs"), "utf8");
    assert.ok(!chainPhasesSrc.includes('from "./chain-collect.mjs"'));
    assert.ok(!chainPhasesSrc.includes("from './chain-collect.mjs'"));
  });

  it("chain-collect.mjs does not import chain-phases.mjs", () => {
    const chainCollectSrc = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "chain-collect.mjs"), "utf8");
    assert.ok(!chainCollectSrc.includes('from "./chain-phases.mjs"'));
    assert.ok(!chainCollectSrc.includes("from './chain-phases.mjs'"));
  });

  it("exports CHANGE_SCOPE_CONTAINER_PATH and CHANGE_SCOPE_HOST_PATH", () => {
    assert.equal(CHANGE_SCOPE_CONTAINER_PATH, "/tmp/kusabi-change-scope.mjs");
    assert.ok(CHANGE_SCOPE_HOST_PATH.endsWith("change-scope.mjs"));
  });
});

// =========================================================================
// =========================================================================
// collectReviewContext — review context without re-running probes (resume)
// =========================================================================

describe("collectReviewContext", () => {
  function fakeReviewContextCallTool({ statusOutput = "" } = {}) {
    return async (toolName, params) => {
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands[0];
      if (cmd === "git status --porcelain") return { output: statusOutput };
      if (cmd === "git log --oneline -5") return { output: "abc123 latest change\n" };
      if (cmd === "git ls-files --others --exclude-standard") return { output: "untracked.txt\n" };
      return { output: "" };
    };
  }

  it("collects status/changed paths, base log and untracked without running probes", async () => {
    const callTool = fakeReviewContextCallTool({ statusOutput: " M src/foo.js\n" });
    const ctx = await collectReviewContext({
      container: "fake-cid",
      brief: "Implement X.\n\n## Deliverables\n- src/foo.js\n",
      callTool,
      worktreeBaseline: null,
    });

    assert.deepEqual(ctx.chainChangedPaths, ["src/foo.js"]);
    assert.deepEqual(ctx.chainNewlyChanged, ["src/foo.js"]); // baseline null → full changed set
    assert.equal(ctx.chainStatusObserved, true);
    assert.equal(ctx.chainStatusOutput, " M src/foo.js\n");
    assert.equal(ctx.chainBaseLog, "abc123 latest change\n");
    assert.equal(ctx.chainUntracked, "untracked.txt\n");
    assert.deepEqual(ctx.chainDeliverables, ["src/foo.js"]);
    // No diff is collected on the resume path either (kusabi #208).
    assert.equal(ctx.chainDiff, undefined);
  });

  it("carries the paging facts of the captures it made", async () => {
    const callTool = async (toolName, params) => {
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands[0];
      if (cmd === "git status --porcelain") {
        // Live-server shape for a cut response: shown === total_lines, and
        // next_offset is the number of lines actually returned.
        return { output: " M src/foo.js\n", shown: 137, total_lines: 137, truncated: true, has_more: true, next_offset: 1 };
      }
      if (cmd === "git ls-files --others --exclude-standard") return { output: "untracked.txt\n" };
      return { output: "" };
    };
    const ctx = await collectReviewContext({
      container: "fake-cid",
      brief: "Implement X.\n\n## Deliverables\n- src/foo.js\n",
      callTool,
      worktreeBaseline: null,
    });
    assert.deepEqual(ctx.chainTruncation.status, { truncated: true, total: 137 });
    assert.equal(ctx.chainTruncation.untracked.truncated, false);
  });

  it("yields empty strings for unreadable context calls instead of throwing", async () => {
    const callTool = async (toolName, params) => {
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands[0];
      if (cmd === "git status --porcelain") return { output: "" };
      throw new Error("sandbox unreachable");
    };
    const ctx = await collectReviewContext({
      container: "fake-cid",
      brief: "Implement X.",
      callTool,
      worktreeBaseline: null,
    });
    assert.equal(ctx.chainBaseLog, "");
    assert.equal(ctx.chainUntracked, "");
    assert.deepEqual(ctx.chainChangedPaths, []);
    // A capture that never happened is not a capture that was cut.
    assert.equal(ctx.chainTruncation.baseLog, null);
    assert.equal(ctx.chainTruncation.untracked, null);
  });

  it("degrades to unobserved status when the probe RPC fails instead of throwing (#153①)", async () => {
    // This context is collected on the RECOVERY path — a transient
    // container/RPC failure must not turn the resumed chain terminal.
    const callTool = async () => { throw new Error("container unreachable"); };
    const ctx = await collectReviewContext({
      container: "fake-cid",
      brief: "Implement X.\n\n## Deliverables\n- src/foo.js\n",
      callTool,
      worktreeBaseline: null,
    });
    assert.equal(ctx.chainStatusObserved, false); // unknown — never "nothing changed"
    assert.deepEqual(ctx.chainChangedPaths, []);
    assert.equal(ctx.chainBaseLog, "");
    // An unobserved status must not skip the review as an empty change set.
    assert.equal(
      shouldSkipReview({
        chainStatusObserved: ctx.chainStatusObserved,
        chainChangedPaths: ctx.chainChangedPaths,
        chainNewlyChanged: ctx.chainNewlyChanged,
        chainDeliverables: ctx.chainDeliverables,
      }),
      false,
    );
  });

  it("collectContainerBaseContext alone returns the two context strings", async () => {
    const callTool = fakeReviewContextCallTool({});
    const baseCtx = await collectContainerBaseContext(callTool, "fake-cid");
    assert.equal(baseCtx.chainBaseLog, "abc123 latest change\n");
    assert.equal(baseCtx.chainUntracked, "untracked.txt\n");
    assert.equal(baseCtx.chainDiff, undefined);
  });

  it("collectContainerBaseContext issues no git diff at all", async () => {
    // The capture is removed, not widened: it read one default-paged page and
    // the reviewer fetches the diff itself (kusabi #208).
    const commands = [];
    const callTool = async (tool, params) => {
      commands.push(params.commands?.[0] ?? "");
      return { output: "" };
    };
    await collectContainerBaseContext(callTool, "fake-cid");
    assert.deepEqual(commands, ["git log --oneline -5", "git ls-files --others --exclude-standard"]);
  });
});

// ---------------------------------------------------------------------------
// collectContainerReviewInput — the task path's review input (kusabi #204)
// ---------------------------------------------------------------------------

describe("collectContainerReviewInput", () => {
  // Records every command issued so the tests can assert on what was actually
  // run in the container, not only on the rendered text.
  function recordingTool(handler) {
    const commands = [];
    return {
      commands,
      callTool: async (tool, params) => {
        const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
        commands.push(cmd);
        return handler(cmd, params);
      },
    };
  }

  const DUMMY_SCOPE = {
    formatVersion: 1,
    repositoryRoot: "/workspace",
    input: { base: "deadbeefcafe", head: "HEAD" },
    resolved: { baseSha: "deadbeefcafe", headSha: "deadbeefcafe", mergeBaseSha: "deadbeefcafe" },
    paths: { committed: [], staged: [], unstaged: ["src/foo.js"], untracked: ["src/new.js"] },
  };

  function defaultHandler(cmd, params) {
    const fullCmd = params?.commands?.[0] ?? params?.argv?.join(" ") ?? (typeof cmd === "string" ? cmd : "");
    if (fullCmd.includes("change-scope.mjs")) {
      return { output: JSON.stringify(DUMMY_SCOPE) };
    }
    if (fullCmd === "git rev-parse HEAD") return { output: "deadbeefcafe\n" };
    if (fullCmd === "git status --porcelain") return { output: " M src/foo.js\n" };
    if (fullCmd === "git log --oneline -5") return { output: "deadbee latest\n" };
    if (fullCmd === "git ls-files --others --exclude-standard") return { output: "src/new.js\n" };
    return { output: "" };
  }

  it("without --base, renders the container block against HEAD and captures no diff", async () => {
    const { commands, callTool } = recordingTool(defaultHandler);
    const input = await collectContainerReviewInput({ container: "cid123", callTool });

    assert.ok(input.startsWith("## Review target"));
    assert.ok(input.includes("container `cid123`"));
    assert.ok(input.includes("`diff_in_container`"));
    assert.ok(input.includes("- Base commit: `deadbeefcafe`"));
    assert.ok(input.includes('"formatVersion": 1'));
    assert.ok(input.includes('"src/foo.js"'));
    assert.ok(input.includes('"src/new.js"'));
    // The base is what the reviewer cannot derive, so it is named as the ref
    // to fetch against; the diff body is not captured at all (kusabi #208).
    assert.ok(input.includes("Fetching the diff is YOUR job"));
    assert.ok(input.includes("`base` set to `deadbeefcafe`"));
    assert.ok(!input.includes("diff --git"));
    // Same default the chain uses: HEAD.
    assert.ok(commands.includes("git rev-parse HEAD"));
    assert.ok(commands.some((c) => c.includes("change-scope.mjs")));
    assert.ok(
      !commands.some((c) => c.startsWith("git diff")),
      `no git diff may be issued, got: ${JSON.stringify(commands)}`,
    );
  });

  it("with --base, resolves that ref and names it as the ref to diff against", async () => {
    const { commands, callTool } = recordingTool((cmd, params) => {
      const fullCmd = params?.commands?.[0] ?? params?.argv?.join(" ") ?? (typeof cmd === "string" ? cmd : "");
      if (fullCmd.includes("change-scope.mjs")) {
        return {
          output: JSON.stringify({
            formatVersion: 1,
            repositoryRoot: "/workspace",
            input: { base: "c355fa61a7fee5402ed7ba999bd2fe2eeb46a842", head: "HEAD" },
            resolved: { baseSha: "c355fa61a7fee5402ed7ba999bd2fe2eeb46a842", headSha: "deadbeefcafe", mergeBaseSha: "c355fa61a7fee5402ed7ba999bd2fe2eeb46a842" },
            paths: { committed: [], staged: [], unstaged: ["src/foo.js"], untracked: [] },
          }),
        };
      }
      if (fullCmd.startsWith("git rev-parse --verify")) return { output: "c355fa61a7fee5402ed7ba999bd2fe2eeb46a842\n" };
      if (fullCmd === "git status --porcelain") return { output: " M src/foo.js\n" };
      if (fullCmd === "git log --oneline -5") return { output: "c355fa6 base\n" };
      return { output: "" };
    });
    const input = await collectContainerReviewInput({ container: "cid123", callTool, base: "c355fa6" });

    assert.ok(commands.some((c) => c.startsWith("git rev-parse --verify --quiet 'c355fa6^{commit}'")));
    assert.ok(commands.some((c) => c.includes("change-scope.mjs")));
    assert.ok(
      !commands.some((c) => c.startsWith("git diff")),
      `--base must reach the reviewer as an instruction, not a capture, got: ${JSON.stringify(commands)}`,
    );
    assert.ok(input.includes("- Base commit: `c355fa61a7fee5402ed7ba999bd2fe2eeb46a842`"));
    assert.ok(input.includes("`base` set to `c355fa61a7fee5402ed7ba999bd2fe2eeb46a842`"));
    assert.ok(input.includes('"formatVersion": 1'));
  });

  it("labels a change-set list the container paged, counting the lines it actually shows", async () => {
    // The defect #208 fixes: a one-page capture that reads as the whole thing.
    // What is captured now is a file list, and a file list can page too.
    //
    // The envelope is the live server's cut shape: 50 lines returned out of
    // 137, reported as shown=137 (== total_lines) with next_offset=50.  The
    // numerator in the label must come from the 50 lines in the block, NOT
    // from `shown` -- rendering `shown` gives "showing 137 of 137", a
    // truncation label that says nothing was withheld.
    const { callTool } = recordingTool((cmd) => {
      if (cmd === "git rev-parse HEAD") return { output: "deadbeefcafe\n" };
      if (cmd === "git status --porcelain") {
        return {
          status: "ok",
          output: Array.from({ length: 50 }, (_, i) => " M src/f" + i + ".js").join("\n") + "\n",
          shown: 137,
          total_lines: 137,
          truncated: true,
          next_offset: 50,
          has_more: true,
        };
      }
      return { output: "" };
    });
    const input = await collectContainerReviewInput({ container: "cid123", callTool, changeScope: false });
    assert.ok(input.includes("**Change set truncated (showing 50 of 137 lines).**"));
    assert.ok(!input.includes("showing 137 of 137"), "the response's own shown-count must never be rendered");
    assert.ok(input.includes("`diff_in_container` reports the complete file list"));

    // The label's own numbers must agree with the label: a numerator that is
    // not strictly below the denominator announces a cut and then denies it.
    const counts = /showing (\d+) of (\d+) lines/.exec(input);
    assert.ok(counts, "the paged label must carry counts");
    assert.ok(Number(counts[1]) < Number(counts[2]), `numerator must be below the denominator, got ${counts[0]}`);
  });

  it("labels a change set the container cut with truncated:false and has_more:true", async () => {
    // Measured on the live server: paging can cut the output while
    // `truncated` stays false (that flag is the summary layer).  Reading
    // `truncated` alone would let this one through unlabelled.
    const { callTool } = recordingTool((cmd) => {
      if (cmd === "git rev-parse HEAD") return { output: "deadbeefcafe\n" };
      if (cmd === "git status --porcelain") {
        return {
          status: "ok",
          output: Array.from({ length: 25 }, (_, i) => " M src/f" + i + ".js").join("\n") + "\n",
          shown: 61,
          total_lines: 61,
          truncated: false,
          next_offset: 25,
          has_more: true,
        };
      }
      return { output: "" };
    });
    const input = await collectContainerReviewInput({ container: "cid123", callTool, changeScope: false });
    assert.ok(input.includes("**Change set truncated (showing 25 of 61 lines).**"));
  });

  it("labels nothing when the container reports every capture complete", async () => {
    const { callTool } = recordingTool((cmd) => {
      const complete = (output) => ({ status: "ok", output, shown: 1, total_lines: 1, truncated: false, next_offset: null, has_more: false });
      if (cmd === "git rev-parse HEAD") return complete("deadbeefcafe\n");
      if (cmd === "git status --porcelain") return complete(" M src/foo.js\n");
      if (cmd === "git log --oneline -5") return complete("deadbee latest\n");
      if (cmd === "git ls-files --others --exclude-standard") return complete("src/new.js\n");
      return complete("");
    });
    const input = await collectContainerReviewInput({ container: "cid123", callTool, changeScope: false });
    assert.ok(!input.includes("truncated"), "a complete capture must not be labelled as cut");
  });

  it("throws when --base does not resolve in the container", async () => {
    const { callTool } = recordingTool((cmd) => {
      if (cmd.startsWith("git rev-parse --verify")) return { output: "__KUSABI_BASE_UNRESOLVED__\n" };
      return { output: "" };
    });
    await assert.rejects(
      () => collectContainerReviewInput({ container: "cid123", callTool, base: "nosuchref" }),
      /--base nosuchref is not a valid revision in container cid123/,
    );
  });

  it("throws when the base lookup itself fails, naming the container", async () => {
    const callTool = async () => { throw new Error("sunaba-rpc: tools/call failed (HTTP 500)"); };
    await assert.rejects(
      () => collectContainerReviewInput({ container: "cid123", callTool, base: "c355fa6" }),
      /--base c355fa6 could not be resolved in container cid123/,
    );
  });

  it("rejects a base ref with shell metacharacters before issuing any command", async () => {
    const { commands, callTool } = recordingTool(defaultHandler);
    await assert.rejects(
      () => collectContainerReviewInput({ container: "cid123", callTool, base: "abc'; rm -rf /; echo '" }),
      /is not a usable git revision/,
    );
    assert.deepEqual(commands, []);
  });

  it("degrades to (unavailable) instead of throwing when the container is unreachable", async () => {
    const callTool = async () => { throw new Error("sunaba-rpc: initialize failed (HTTP 502)"); };
    const input = await collectContainerReviewInput({ container: "cid123", callTool });
    assert.ok(input.includes("## Review target"));
    assert.ok(input.includes("- Base commit: (unavailable)"));
    // No base to name: the instruction says so and names the fallback rather
    // than disappearing.
    assert.ok(input.includes("Fetching the diff is YOUR job"));
    assert.ok(input.includes("`worktree: true`"));
  });

  it("produces a well-formed input when the change set is empty", async () => {
    const { callTool } = recordingTool((cmd) => {
      if (cmd === "git rev-parse HEAD") return { output: "deadbeefcafe\n" };
      if (cmd === "git log --oneline -5") return { output: "deadbee latest\n" };
      return { output: "" };
    });
    const input = await collectContainerReviewInput({ container: "cid123", callTool, changeScope: false });
    assert.ok(input.includes("(empty change set)"));
    assert.ok(input.includes("`base` set to `deadbeefcafe`"));
    assert.ok(!input.includes("```diff"));
    // Balanced fences: an empty diff must not leave the prompt half-fenced.
    assert.equal((input.match(/```/g) || []).length % 2, 0);
    assert.ok(input.endsWith("must not be flagged as such."));
  });
});

describe("assertContainerBaseRef", () => {
  it("accepts the ref shapes git actually uses", () => {
    for (const ref of ["c355fa6", "main", "origin/main", "HEAD~3", "v1.2.3", "HEAD^{commit}", "refs/heads/feature-x"]) {
      assert.doesNotThrow(() => assertContainerBaseRef(ref));
    }
  });

  it("rejects anything that could break out of the shell word", () => {
    for (const ref of ["a b", "a'b", 'a"b', "a;b", "a$(b)", "a&&b", "a|b", "`b`"]) {
      assert.throws(() => assertContainerBaseRef(ref), /is not a usable git revision/);
    }
  });
});

// The base ref used to select which `git diff` was captured; that capture is
// gone (kusabi #208), so what these pin is the seam it moved to: the ref
// reaches the reviewer as the base named in the fetch instruction, and no diff
// is ever run in the container on either route.

describe("base ref reaches the reviewer as an instruction, not a capture", () => {
  function recorder() {
    const commands = [];
    return {
      commands,
      callTool: async (tool, params) => {
        const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
        commands.push(cmd);
        if (cmd.includes("change-scope.mjs")) {
          const base = cmd.includes("c355fa61a7fee5402ed7ba999bd2fe2eeb46a842") ? "c355fa61a7fee5402ed7ba999bd2fe2eeb46a842" : "deadbeefcafe";
          return {
            output: JSON.stringify({
              formatVersion: 1,
              repositoryRoot: "/workspace",
              input: { base, head: "HEAD" },
              resolved: { baseSha: base, headSha: "deadbeefcafe", mergeBaseSha: base },
              paths: { committed: [], staged: [], unstaged: [], untracked: [] },
            }),
          };
        }
        if (cmd.startsWith("git rev-parse --verify")) return { output: "c355fa61a7fee5402ed7ba999bd2fe2eeb46a842\n" };
        if (cmd === "git rev-parse HEAD") return { output: "deadbeefcafe\n" };
        return { output: "" };
      },
    };
  }

  it("names HEAD when no base is given, and runs no diff", async () => {
    const { commands, callTool } = recorder();
    const input = await collectContainerReviewInput({ container: "cid123", callTool });
    assert.ok(input.includes("`base` set to `deadbeefcafe`"));
    assert.ok(!commands.some((c) => c.startsWith("git diff")));
  });

  it("names the resolved base when one is given, and runs no diff", async () => {
    const { commands, callTool } = recorder();
    const input = await collectContainerReviewInput({ container: "cid123", callTool, base: "c355fa6" });
    assert.ok(input.includes("`base` set to `c355fa61a7fee5402ed7ba999bd2fe2eeb46a842`"));
    assert.ok(!commands.some((c) => c.startsWith("git diff")));
  });

  it("collectContainerBaseContext takes no base argument to honour", async () => {
    const { commands, callTool } = recorder();
    await collectContainerBaseContext(callTool, "cid123");
    assert.deepEqual(commands, ["git log --oneline -5", "git ls-files --others --exclude-standard"]);
  });
});

// ---------------------------------------------------------------------------
// change-scope wiring into review and probe phases (kusabi #379)
// ---------------------------------------------------------------------------

describe("change-scope wiring into review and probe phases (kusabi #379)", () => {
  const FIXTURE_CHANGE_SCOPE = {
    formatVersion: 1,
    repositoryRoot: "/workspace",
    input: { base: "base-sha-123", head: "HEAD" },
    resolved: {
      baseSha: "base-sha-123",
      headSha: "head-sha-456",
      mergeBaseSha: "base-sha-123",
    },
    paths: {
      committed: ["src/committed.js"],
      staged: ["src/staged.js"],
      unstaged: ["src/unstaged.js"],
      untracked: ["src/untracked.js"],
    },
  };

  it("change-scope invalid JSON fails closed in collectContainerReviewInput (throws, does not substitute porcelain)", async () => {
    const callTool = async (toolName, params) => {
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
      if (cmd.includes("change-scope.mjs")) {
        return { output: "not valid json {{" };
      }
      if (cmd.startsWith("git rev-parse --verify") || cmd === "git rev-parse HEAD") return { output: "base123\n" };
      if (cmd === "git status --porcelain") return { output: " M porcelain-file.js\n" };
      return { output: "" };
    };

    await assert.rejects(
      () => collectContainerReviewInput({ container: "cid-fail-json", callTool, base: "base123" }),
      /change-scope produced invalid JSON/,
    );
  });

  it("change-scope empty stdout fails closed in collectContainerReviewInput (throws, does not substitute porcelain)", async () => {
    const callTool = async (toolName, params) => {
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
      if (cmd.includes("change-scope.mjs")) {
        return { output: "" };
      }
      if (cmd.startsWith("git rev-parse --verify") || cmd === "git rev-parse HEAD") return { output: "base123\n" };
      if (cmd === "git status --porcelain") return { output: " M porcelain-file.js\n" };
      return { output: "" };
    };

    await assert.rejects(
      () => collectContainerReviewInput({ container: "cid-fail-empty-task", callTool, base: "base123" }),
      /change-scope produced empty output/,
    );
  });

  it("change-scope empty stdout fails closed for container cid123 (no production special-case)", async () => {
    const callTool = async (toolName, params) => {
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
      if (cmd.includes("change-scope.mjs")) {
        return { output: "" };
      }
      if (cmd.startsWith("git rev-parse --verify") || cmd === "git rev-parse HEAD") return { output: "base123\n" };
      if (cmd === "git status --porcelain") return { output: " M porcelain-file.js\n" };
      return { output: "" };
    };

    await assert.rejects(
      () => collectContainerReviewInput({ container: "cid123", callTool, base: "base123" }),
      /change-scope produced empty output/,
    );
  });


  it("change-scope formatVersion contract mismatch fails closed in collectContainerReviewInput", async () => {
    const callTool = async (toolName, params) => {
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
      if (cmd.includes("change-scope.mjs")) {
        return { output: JSON.stringify({ formatVersion: 2, resolved: {}, paths: {} }) };
      }
      if (cmd.startsWith("git rev-parse --verify") || cmd === "git rev-parse HEAD") return { output: "base123\n" };
      return { output: "" };
    };

    await assert.rejects(
      () => collectContainerReviewInput({ container: "cid-fail-contract", callTool, base: "base123" }),
      /change-scope JSON contract mismatch/,
    );
  });

  it("collectContainerReviewInput records change-scope invocation, contains JSON, and runs no git diff", async () => {
    const invocations = [];
    const commands = [];
    const callTool = async (toolName, params) => {
      const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
      commands.push(cmd);
      invocations.push({ toolName, params });
      if (cmd.includes("change-scope.mjs")) {
        return { output: JSON.stringify(FIXTURE_CHANGE_SCOPE) };
      }
      if (cmd.startsWith("git rev-parse --verify")) {
        return { output: "base-sha-123\n" };
      }
      return { output: "" };
    };

    const input = await collectContainerReviewInput({ container: "cid-scope-test", callTool, base: "base-sha-123" });

    // Injects change-scope.mjs into the container before exec
    const injectCall = invocations.find((i) => i.toolName === "copy_file");
    assert.ok(injectCall, "must invoke copy_file to inject change-scope.mjs");
    assert.equal(injectCall.params.container_id, "cid-scope-test");
    assert.equal(injectCall.params.dest_path, "/tmp/kusabi-change-scope.mjs");
    assert.ok(injectCall.params.local_src_file.endsWith("change-scope.mjs"));

    // Records change-scope invocation with argv and without commands
    const scopeCall = invocations.find((i) => i.params?.argv?.some((a) => a.includes("change-scope.mjs")));
    assert.ok(scopeCall, "must invoke change-scope.mjs with argv");
    assert.equal(scopeCall.params.commands, undefined, "must not pass commands when argv is used");
    assert.deepEqual(scopeCall.params.argv, ["node", "/tmp/kusabi-change-scope.mjs", "--base", "base-sha-123", "--head", "HEAD"]);
    assert.ok(invocations.indexOf(injectCall) < invocations.indexOf(scopeCall), "inject must precede sandbox_exec");

    // Existing assertion: no git diff may be issued
    assert.ok(!commands.some((c) => c.startsWith("git diff")), "no git diff may be issued");
    // Rendered input contains the JSON
    assert.ok(input.includes("Authoritative change set (`change-scope`):"));
    assert.ok(input.includes('"formatVersion": 1'));
    assert.ok(input.includes('"src/committed.js"'));
    assert.ok(input.includes('"src/staged.js"'));
    assert.ok(input.includes('"src/unstaged.js"'));
    assert.ok(input.includes('"src/untracked.js"'));
    // Diff instruction names base
    assert.ok(input.includes("Fetching the diff is YOUR job"));
    assert.ok(input.includes("`base` set to `base-sha-123`"));
  });

  it("change-scope inject failure in collectChangeScope throws and does not exec fallback", async () => {
    const executed = [];
    const callTool = async (toolName, params) => {
      if (toolName === "copy_file") {
        throw new Error("copy_file failed: disk full");
      }
      executed.push({ toolName, params });
      return { output: "" };
    };

    await assert.rejects(
      () => collectChangeScope({ container: "cid-fail-inject", callTool, base: "base-sha-123" }),
      /change-scope inject failed in container cid-fail-inject: copy_file failed: disk full/,
    );
    assert.equal(executed.length, 0, "sandbox_exec must not be invoked when inject fails");
  });

  it("change-scope inject returning error object fails closed", async () => {
    const executed = [];
    const callTool = async (toolName, params) => {
      if (toolName === "copy_file") {
        return { error: "failed to write to /tmp" };
      }
      executed.push({ toolName, params });
      return { output: "" };
    };

    await assert.rejects(
      () => collectChangeScope({ container: "cid-fail-inject-obj", callTool, base: "base-sha-123" }),
      /change-scope inject failed in container cid-fail-inject-obj: failed to write to \/tmp/,
    );
    assert.equal(executed.length, 0, "sandbox_exec must not be invoked when inject returns error");
  });

  it("collectReviewContext does not invoke change-scope.mjs", async () => {
    const commands = [];
    const callTool = async (toolName, params) => {
      const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
      commands.push(cmd);
      if (cmd === "git status --porcelain") return { output: "" };
      if (cmd === "git log --oneline -5") return { output: "base commit\n" };
      if (cmd.startsWith("git ls-files --others")) return { output: "" };
      return { output: "" };
    };

    const reviewCtx = await collectReviewContext({
      container: "cid-resume",
      brief: "## Deliverables\n\n- `src/foo.js`\n",
      callTool,
      worktreeBaseline: null,
      roundRecord: { changeScope: FIXTURE_CHANGE_SCOPE },
    });

    // Crucial check: change-scope was NOT executed
    assert.ok(!commands.some((c) => c.includes("change-scope.mjs")), "collectReviewContext must not invoke change-scope.mjs");
    // roundRecord is untouched and context is collected
    assert.equal(reviewCtx.chainStatusObserved, true);
  });
});
