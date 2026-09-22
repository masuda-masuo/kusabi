import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeChainControl } from "./chain-control.mjs";
import { runChainDriver } from "./chain-driver.mjs";
import { finishRound } from "./chain-finish.mjs";
import { handleProviderExhaustion } from "./chain-outcomes.mjs";
import { readJson } from "./state-paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Source guard: runChainDriver's function body must not contain nested
 * function definitions for finishRound / finaliseChain / finaliseProvisionalChain
 * (kusabi #422 Job 3).  These were lifted to chain-finish.mjs.
 */
describe("chain-finish source guard", () => {
  it("runChainDriver does not contain nested finishRound / finaliseChain / finaliseProvisionalChain", () => {
    const driverSource = fs.readFileSync(
      path.join(__dirname, "chain-driver.mjs"),
      "utf8",
    );

    // Find the runChainDriver function body: from the export line to the next
    // top-level export (or end of file).
    const exportStart = driverSource.indexOf("export async function runChainDriver(");
    assert.ok(exportStart !== -1, "runChainDriver must be exported");

    // Find the next top-level export after runChainDriver
    const afterDriver = driverSource.indexOf("\nexport ", exportStart + 1);
    const driverBody = afterDriver !== -1
      ? driverSource.slice(exportStart, afterDriver)
      : driverSource.slice(exportStart);

    // These patterns must NOT appear as nested function definitions inside
    // runChainDriver.  A leading `function` keyword (possibly after
    // whitespace/indentation) followed by the name indicates a nested def.
    const nestedPatterns = [
      /(?:^|\n)\s+function\s+finishRound\s*\(/m,
      /(?:^|\n)\s+function\s+finaliseChain\s*\(/m,
      /(?:^|\n)\s+function\s+finaliseProvisionalChain\s*\(/m,
    ];

    for (const pattern of nestedPatterns) {
      assert.ok(
        !pattern.test(driverBody),
        `runChainDriver must not contain a nested ${pattern.source} definition`,
      );
    }
  });

  it("chain-finish.mjs exports finishRound, finaliseChain, finaliseProvisionalChain", () => {
    const finishSource = fs.readFileSync(
      path.join(__dirname, "chain-finish.mjs"),
      "utf8",
    );

    assert.ok(
      /export\s+async\s+function\s+finishRound\s*\(/.test(finishSource),
      "chain-finish.mjs must export finishRound",
    );
    assert.ok(
      /export\s+function\s+finaliseChain\s*\(/.test(finishSource),
      "chain-finish.mjs must export finaliseChain",
    );
    assert.ok(
      /export\s+function\s+finaliseProvisionalChain\s*\(/.test(finishSource),
      "chain-finish.mjs must export finaliseProvisionalChain",
    );
  });

  it("chain-finish.mjs does not import chain-cmd.mjs or kusabi-companion.mjs", () => {
    const finishSource = fs.readFileSync(
      path.join(__dirname, "chain-finish.mjs"),
      "utf8",
    );

    assert.ok(
      !/from\s+["']\.\/chain-cmd\.mjs["']/.test(finishSource),
      "chain-finish.mjs must not import chain-cmd.mjs",
    );
    assert.ok(
      !/from\s+["']\.\/kusabi-companion\.mjs["']/.test(finishSource),
      "chain-finish.mjs must not import kusabi-companion.mjs",
    );
  });

  it("chain-driver.mjs does not re-export finishRound / finaliseChain / finaliseProvisionalChain", () => {
    const driverSource = fs.readFileSync(
      path.join(__dirname, "chain-driver.mjs"),
      "utf8",
    );

    // These should only be imported, not re-exported
    const reExportPatterns = [
      /export\s*\{[^}]*\bfinishRound\b/,
      /export\s*\{[^}]*\bfinaliseChain\b/,
      /export\s*\{[^}]*\bfinaliseProvisionalChain\b/,
    ];

    for (const pattern of reExportPatterns) {
      assert.ok(
        !pattern.test(driverSource),
        `chain-driver.mjs must not re-export ${pattern.source}`,
      );
    }
  });
});

// =========================================================================
// kusabi #532 — a failed Luna inner chain stays attributable to its mission.
// handleProviderExhaustion writes the TERMINAL chain.json for both
// provider-exhausted phases (review, strategize); the optional mission link
// must ride on it exactly like a successful chain's, and a plain chain must
// omit the key (byte-identical serialization).
// =========================================================================

const CHAIN_BRIEF = "Implement X.\n\n## Deliverables\n- src/foo.js\n";

/** The probe-phase callTool fake: git/verify/change-scope canned answers. */
function fakeCallTool() {
  return async (toolName, params) => {
    if (toolName === "verify_in_container") return { gate_passed: true };
    if (toolName !== "sandbox_exec") return { output: "" };
    const cmd = params?.commands?.[0] ?? params?.argv?.join(" ") ?? "";
    if (typeof cmd === "string" && cmd.includes("change-scope.mjs")) {
      return {
        output: JSON.stringify({
          formatVersion: 1, repositoryRoot: "/workspace",
          input: { base: "abc123", head: "HEAD" },
          resolved: { baseSha: "abc123", headSha: "abc123", mergeBaseSha: "abc123" },
          paths: { committed: [], staged: [], unstaged: [], untracked: [] },
        }),
      };
    }
    if (cmd.startsWith("cd /workspace &&") && cmd.includes("TMPIDX=")) {
      return { output: "ERROR_NO_INDEX\n" };
    }
    if (cmd === "git rev-parse HEAD") return { output: "abc123\n" };
    if (cmd === "git status --porcelain") return { output: " M src/foo.js\n" };
    if (cmd === "git log --oneline -5") return { output: "abc123 latest change\n" };
    if (cmd === "git diff") return { output: "diff --git a/src/foo.js b/src/foo.js\n" };
    if (cmd === "git ls-files --others --exclude-standard") return { output: "untracked.txt\n" };
    return { output: "" };
  };
}

/** Implement completes; review hits provider exhaustion. */
function reviewExhaustedDispatch() {
  const calls = [];
  const dispatch = async (opts) => {
    calls.push(opts);
    if (opts.kind === "review") {
      return {
        job: {
          id: "job-rev-1", status: "provider-error", modelEntry: "fake/review",
          modelVariant: null, fallbacks: null, sessionID: "sess-rev-1",
          usage: null, error: "All routes exhausted: fake/review",
        },
        resultText: "",
      };
    }
    return {
      job: {
        id: "job-imp-1", status: "completed", modelEntry: "fake/model",
        modelVariant: null, fallbacks: null, sessionID: "sess-imp-1",
        usage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
        error: null,
      },
      resultText: "implemented",
    };
  };
  dispatch.calls = calls;
  return dispatch;
}

describe("provider-exhaustion mission linkage (kusabi #532)", () => {
  it("handleProviderExhaustion carries missionId on the terminal chainState for both exhausted phases and omits it for a plain chain", () => {
    for (const phase of ["review", "strategize"]) {
      // Luna inner chain: the terminal chainState keeps its mission link.
      const luna = handleProviderExhaustion({
        records: [],
        roundRecord: { round: 1 },
        currentTierIndex: 0,
        phase,
        chainId: "chain-x",
        round: 1,
        container: "cid-1",
        model: "fake/model",
        modelChain: [["fake/model"]],
        maxRounds: 4,
        brief: CHAIN_BRIEF,
        orchestrator: null,
        baseSha: "abc123",
        strategized: false,
        missionId: "mission-abc",
      });
      assert.equal(luna.chainState.missionId, "mission-abc",
        `${phase}: a failed Luna inner chain keeps its mission attribution`);
      assert.equal(luna.chainState.chainId, "chain-x");

      // Plain chain: the key is absent entirely, never null/false.
      const plain = handleProviderExhaustion({
        records: [],
        roundRecord: { round: 1 },
        currentTierIndex: 0,
        phase,
        chainId: "chain-x",
        round: 1,
        container: "cid-1",
        model: "fake/model",
        modelChain: [["fake/model"]],
        maxRounds: 4,
        brief: CHAIN_BRIEF,
        orchestrator: null,
        baseSha: "abc123",
        strategized: false,
      });
      assert.equal("missionId" in plain.chainState, false,
        `${phase}: a plain chain omits the mission key`);
    }
  });

  it("a Luna inner chain failing review provider exhaustion persists missionId on chain.json; a plain chain omits the key", async () => {
    async function runChain({ missionId }) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-532-rev-exhaust-"));
      const chainDir = path.join(tmp, "chains", "chain-x");
      fs.mkdirSync(chainDir, { recursive: true });
      writeChainControl(chainDir, {
        chainId: "chain-x", container: "cid-1", pid: process.pid,
        status: "running", round: 0, startedAt: new Date().toISOString(),
      });
      const text = await runChainDriver({
        cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-x", container: "cid-1",
        model: "fake/model", modelChain: [["fake/model"]], maxRounds: 4,
        brief: CHAIN_BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
        callTool: fakeCallTool(),
        dispatchWithFallback: reviewExhaustedDispatch(),
        keepServe: true,
        signalReceived: () => false,
        resume: null,
        // The luna driver threads the owning mission id; a plain chain omits it.
        ...(missionId ? { missionId } : {}),
      });
      return { tmp, chainDir, text };
    }

    const luna = await runChain({ missionId: "mission-abc" });
    try {
      assert.match(luna.text, /review provider exhausted/);
      const chainJson = readJson(path.join(luna.chainDir, "chain.json"));
      assert.equal(chainJson.missionId, "mission-abc",
        "a failed Luna inner chain keeps its mission attribution on the terminal chain.json");
      assert.equal(chainJson.records.length, 1);
    } finally {
      fs.rmSync(luna.tmp, { recursive: true, force: true });
    }

    const plain = await runChain({ missionId: null });
    try {
      assert.match(plain.text, /review provider exhausted/);
      const chainJson = readJson(path.join(plain.chainDir, "chain.json"));
      assert.equal("missionId" in chainJson, false,
        "a plain chain's terminal chain.json must not carry a missionId key");
    } finally {
      fs.rmSync(plain.tmp, { recursive: true, force: true });
    }
  });

  it("a Luna inner chain failing strategize provider exhaustion persists missionId on chain.json", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-532-strat-exhaust-"));
    const chainDir = path.join(tmp, "chains", "chain-x");
    fs.mkdirSync(chainDir, { recursive: true });

    // Round 1 reworked with a finding on src/foo.js; round 2's review
    // re-flags the SAME in-scope file (repeatedAreas) while the deterministic
    // probes fail (probesGreen false), so the disposition derives
    // "strategize" (deterministic probes failed + same area twice) and the
    // strategist phase runs — and exhausts the provider, writing the
    // terminal chain.json.
    const round1 = {
      round: 1,
      reworkScope: "full",
      resumeMethod: { type: "fresh_session" },
      verdict: "approve",
      probesGreen: false,
      disposition: { disposition: "rework" },
      findings: [{
        severity: "high", title: "API shape decision", body: "needs a decision",
        file: "src/foo.js", line_start: 1, line_end: 5, confidence: 0.9,
        recommendation: "decide", kind: "design",
      }],
      findingFiles: ["src/foo.js"],
      findingsText: "[high] API shape decision (src/foo.js:1)",
    };
    const roundRecord = { round: 2, reworkScope: "full" };

    const dispatch = async (opts) => {
      if (opts.kind === "review") {
        return {
          job: {
            id: "job-rev-2", status: "completed", modelEntry: "fake/review",
            modelVariant: null, fallbacks: null, sessionID: "sess-rev-2",
            usage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            error: null,
          },
          resultText: JSON.stringify({
            schema_version: 1, verdict: "approve",
            summary: "same file area still flagged",
            findings: [{
              severity: "high", title: "still there", body: "same area still flagged",
              file: "src/foo.js", line_start: 1, line_end: 5, confidence: 0.9,
              recommendation: "fix it",
            }],
            next_steps: [],
          }),
        };
      }
      if (opts.kind === "strategist") {
        return {
          job: {
            id: "job-strat-1", status: "provider-error", modelEntry: "fake/model",
            modelVariant: null, fallbacks: null, sessionID: "sess-strat-1",
            usage: null, error: "All routes exhausted: fake/model",
          },
          resultText: "",
        };
      }
      throw new Error("unexpected dispatch kind: " + opts.kind);
    };

    const probeCtx = {
      probesGreen: false,
      chainChangedPaths: ["src/foo.js"],
      chainNewlyChanged: true,
      chainStatusObserved: true,
      chainStatusOutput: " M src/foo.js\n",
      chainBaseLog: "abc123 latest change\n",
      chainDeliverables: ["src/foo.js"],
      chainUntracked: [],
      chainTruncation: null,
      changeScope: { added: [], deleted: [], modified: ["src/foo.js"] },
      oracleViolation: false,
    };

    const records = [round1];
    const ctx = {
      chainDir, chainId: "chain-x", container: "cid-1", cwd: tmp,
      model: "fake/model", modelChain: [["fake/model"]], maxRounds: 4,
      brief: CHAIN_BRIEF, orchestrator: null, callTool: fakeCallTool(),
      flagsModel: null, reviewFlagsModel: null,
      effectiveReviewChain: [["fake/review"]], effectiveBaseSha: "abc123",
      effectiveVerifyBaseline: null,
      reviewModel: "fake/review", reviewModelChain: [["fake/review"]],
      reworkModel: null, reworkModelChain: null, reworkBackend: null,
      reviewDispatch: dispatch, injectedDispatch: dispatch,
      reworkTierCount: 1,
      missionId: "mission-abc",
      records, strategized: false, reworkCount: 1, currentTierIndex: 0,
    };

    const result = await finishRound(
      { round: 2, roundRecord, previousRecord: round1, probeCtx, implementRefusal: null, reworkScope: null },
      ctx,
    );
    try {
      assert.equal(result.done, true);
      assert.match(result.text, /strategize provider exhausted/);
      const chainJson = readJson(path.join(chainDir, "chain.json"));
      assert.equal(chainJson.missionId, "mission-abc",
        "a Luna inner chain that exhausts at strategize keeps its mission attribution");
      assert.equal(chainJson.records.length, 2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});