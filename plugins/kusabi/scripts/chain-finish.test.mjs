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
import { ORACLE_UNCHECKED } from "./chain-probes.mjs";

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
// =========================================================================
// kusabi #541 — review-resume accept revalidation with an UNCHECKED oracle.
// The driver threads the recorded `oracleUnchecked` flag into the
// review-resume probeCtx (roundRecord.oracleUnchecked ?? false); finishRound's
// lazy accept re-validation re-measures the oracle on the CURRENT worktree
// and hands the FRESH flag to the re-derivation.  These tests drive
// finishRound through both boundaries: a re-validation whose probes die
// before P5/P6 must escalate with an accurate "unchecked" reason and persist
// the flag, and a RECORDED unchecked flag must reach the resumed disposition
// unchanged.  The recorded marker shape the #541 driver tests use (absent /
// default-false) never enters accept revalidation, which is the gap these
// tests close.
// =========================================================================

describe("review-resume revalidation with an unchecked oracle (kusabi #541)", () => {
  const BRIEF = CHAIN_BRIEF;
  const UNCHECKED = ORACLE_UNCHECKED;

  // The review-resume shape the driver builds (chain-driver.mjs): probeCtx
  // carries RECORDED truth (probesFromRecord=true) and the review re-runs
  // inside finishRound.  Records start empty because the resumed round is the
  // first record of this run.
  function reviewResumeCtx({ tmp, chainDir, dispatch, callTool, effectiveVerifyBaseline = null }) {
    return {
      chainDir, chainId: "chain-541-reval", container: "cid-541", cwd: tmp,
      model: "fake/model", modelChain: [["fake/model"]], maxRounds: 4,
      brief: BRIEF, orchestrator: null, callTool,
      flagsModel: null, reviewFlagsModel: null,
      effectiveReviewChain: [["fake/review"]], effectiveBaseSha: "abc123",
      effectiveVerifyBaseline,
      reviewModel: "fake/review", reviewModelChain: [["fake/review"]],
      reworkModel: null, reworkModelChain: null, reworkBackend: null,
      reviewDispatch: dispatch, injectedDispatch: dispatch,
      reworkTierCount: 1,
      records: [], strategized: false, reworkCount: 0, currentTierIndex: 0,
    };
  }

  function approvingReviewDispatch() {
    const calls = [];
    const dispatch = async (opts) => {
      calls.push(opts);
      if (opts.kind === "review") {
        return {
          job: {
            id: "job-rev-1", status: "completed", modelEntry: "fake/review",
            modelVariant: null, fallbacks: null, sessionID: "sess-rev-1",
            usage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            error: null,
          },
          resultText: JSON.stringify({ schema_version: 1, verdict: "approve", findings: [], summary: "ok", next_steps: [] }),
        };
      }
      throw new Error("unexpected dispatch kind: " + opts.kind);
    };
    dispatch.calls = calls;
    return dispatch;
  }

  // Revalidation probe phase: P1 records HEAD-matches-base, then P2's verify
  // call throws — the P1-P4 sequence dies at P2, so P5/P6 never execute and
  // the run reports the ORACLE_UNCHECKED marker with oracleUnchecked=true.
  // P1 passing before the throw is deliberate: the escalate reason must not
  // claim that P1-P4 evidence is absent.
  function revalidationDiesAtP2CallTool() {
    return async (toolName, params) => {
      if (toolName === "verify_in_container") {
        throw new Error("verify_in_container failed: connection refused");
      }
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params?.commands?.[0] ?? params?.argv?.join(" ") ?? "";
      if (cmd === "git rev-parse HEAD") return { output: "abc123\n" };
      if (cmd === "git status --porcelain") return { output: " M src/foo.js\n" };
      if (cmd === "git diff") return { output: "diff --git a/src/foo.js b/src/foo.js\n" };
      return { output: "" };
    };
  }

  function resumedRoundRecord() {
    return {
      round: 1,
      reworkScope: "full",
      resumeMethod: { type: "continue_session" },
    };
  }

  function revalidationPassesP1P4CallTool() {
    return async (toolName, params) => {
      if (toolName === "verify_in_container") {
        return {
          gate_passed: true,
          lint: [],
          types: [],
          tests: { full: { status: "ok", passed: 10, total: 10 } },
          collected: 10,
        };
      }
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params?.commands?.[0] ?? params?.argv?.join(" ") ?? "";
      if (cmd === "git rev-parse HEAD") return { output: "abc123\n" };
      if (cmd === "git status --porcelain") return { output: " M src/foo.js\n" };
      if (cmd === "git diff") return { output: "diff --git a/src/foo.js b/src/foo.js\n" };
      return { output: "" };
    };
  }

  async function runResume({ roundRecord, probeCtx, callTool, effectiveVerifyBaseline = null }) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-541-reval-"));
    const chainDir = path.join(tmp, "chains", "chain-541-reval");
    fs.mkdirSync(chainDir, { recursive: true });
    writeChainControl(chainDir, {
      chainId: "chain-541-reval", container: "cid-541", pid: process.pid,
      status: "running", round: 0, startedAt: new Date().toISOString(),
    });
    const dispatch = approvingReviewDispatch();
    const ctx = reviewResumeCtx({ tmp, chainDir, dispatch, callTool, effectiveVerifyBaseline });
    const result = await finishRound({
      round: 1, roundRecord, previousRecord: null, probeCtx,
      implementRefusal: null, reworkScope: "full",
    }, ctx);
    return { tmp, chainDir, result, roundRecord };
  }

  it("a review-resumed accept whose re-validation dies before P5/P6 escalates as unchecked and persists the flag", async () => {
    // Recorded truth: green probes, oracle executed and clean — the exact
    // accept shape the four #541 driver tests never enter.  The re-validation
    // re-measures it on the current worktree and dies at P2 (before P5/P6).
    const roundRecord = resumedRoundRecord();
    const probeCtx = {
      probesGreen: true,
      probesFromRecord: true,
      oracleViolation: false,
      oracleUnchecked: false,
      chainChangedPaths: ["src/foo.js"],
      chainNewlyChanged: ["src/foo.js"],
      chainStatusObserved: true,
      chainStatusOutput: " M src/foo.js\n",
      chainBaseLog: "abc123 latest change\n",
      chainDeliverables: ["src/foo.js"],
      chainUntracked: [],
      chainTruncation: null,
      worktreeChanged: true,
      changeScope: { added: [], deleted: [], modified: ["src/foo.js"] },
    };
    const { tmp, result, roundRecord: rr } = await runResume({
      roundRecord, probeCtx, callTool: revalidationDiesAtP2CallTool(),
    });
    try {
      assert.equal(result.done, true);
      // Terminal unchecked escalation with an accurate reason: missing P5/P6
      // oracle evidence, never a measured violation and never absent P1-P4
      // evidence (P1 did run and passed before the throw).
      assert.equal(rr.disposition.disposition, "escalate");
      assert.match(rr.disposition.reason, /P5\/P6 oracle probes did not execute/);
      assert.match(rr.disposition.reason, /UNCHECKED/);
      assert.match(rr.disposition.reason, /no P5\/P6 oracle evidence/);
      assert.doesNotMatch(rr.disposition.reason, /deterministic oracle violation was measured/);
      assert.doesNotMatch(rr.disposition.reason, /no deterministic acceptance evidence/);
      // Persisted flag and marker on the record.
      assert.equal(rr.oracleUnchecked, true);
      assert.equal(rr.oracleViolation, UNCHECKED);
      // The outcome text the orchestrator sees carries the same reason.
      assert.match(result.text, /P5\/P6 oracle probes did not execute/);
      assert.doesNotMatch(result.text, /deterministic oracle violation was measured/);
      // The re-validation itself is recorded (kusabi #262) with the RECORDED
      // truth preserved on the note while the live field carries the fresh
      // measurement.
      assert.ok(rr.probesRevalidated, "the accept re-validation must be recorded");
      assert.equal(rr.probesRevalidated.oracleUnchecked, false,
        "the recorded flag is preserved on the revalidation note");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a recorded oracleUnchecked=true reaches the review-resume disposition unchanged", async () => {
    // The interrupted round's P5/P6 never executed: the record carries the
    // ORACLE_UNCHECKED marker AND the flag.  On resume the first derivation
    // must already escalate as unchecked — the flag is never lost or flipped,
    // and no re-validation is bought for a terminal disposition.
    const roundRecord = resumedRoundRecord();
    roundRecord.oracleViolation = UNCHECKED;
    roundRecord.oracleUnchecked = true;
    const probeCtx = {
      probesGreen: false,
      probesFromRecord: true,
      oracleViolation: UNCHECKED,
      oracleUnchecked: true,
      chainChangedPaths: ["src/foo.js"],
      chainNewlyChanged: ["src/foo.js"],
      chainStatusObserved: true,
      chainStatusOutput: " M src/foo.js\n",
      chainBaseLog: "abc123 latest change\n",
      chainDeliverables: ["src/foo.js"],
      chainUntracked: [],
      chainTruncation: null,
      worktreeChanged: true,
      changeScope: { added: [], deleted: [], modified: ["src/foo.js"] },
    };
    const { tmp, result, roundRecord: rr } = await runResume({
      roundRecord, probeCtx, callTool: revalidationDiesAtP2CallTool(),
    });
    try {
      assert.equal(result.done, true);
      assert.equal(rr.disposition.disposition, "escalate");
      assert.match(rr.disposition.reason, /P5\/P6 oracle probes did not execute/);
      assert.match(rr.disposition.reason, /no P5\/P6 oracle evidence/);
      assert.doesNotMatch(rr.disposition.reason, /deterministic oracle violation was measured/);
      // The flag reaches the disposition UNCHANGED, and the marker string is
      // not rendered as a violation.
      assert.equal(rr.oracleUnchecked, true);
      assert.equal(rr.oracleViolation, UNCHECKED);
      // No re-validation was bought: the disposition was never accept-family.
      assert.equal(rr.probesRevalidated, undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a review-resumed accept whose re-validation reaches P5 but P6 throws escalates as unchecked and persists the flag", async () => {
    // Revalidation reaches P5 and records it, then P6 throws while reading
    // the verify baseline collected count.  Partial evidence (P5 present, P6
    // absent) must NOT count as oracleExecuted — it must persist
    // ORACLE_UNCHECKED with oracleUnchecked=true and escalate as unchecked,
    // never checked-clean false.
    const roundRecord = resumedRoundRecord();
    const probeCtx = {
      probesGreen: true,
      probesFromRecord: true,
      oracleViolation: false,
      oracleUnchecked: false,
      chainChangedPaths: ["src/foo.js"],
      chainNewlyChanged: ["src/foo.js"],
      chainStatusObserved: true,
      chainStatusOutput: " M src/foo.js\n",
      chainBaseLog: "abc123 latest change\n",
      chainDeliverables: ["src/foo.js"],
      chainUntracked: [],
      chainTruncation: null,
      worktreeChanged: true,
      changeScope: { added: [], deleted: [], modified: ["src/foo.js"] },
    };
    let throwsRemaining = 1;
    const effectiveVerifyBaseline = {
      captured: true,
      gate_passed: true,
      lint: 0,
      types: 0,
      get collected() {
        if (throwsRemaining > 0) {
          throwsRemaining--;
          throw new Error("simulated P6 baseline count read failure");
        }
        return 10;
      },
      raw: {},
    };
    const { tmp, result, roundRecord: rr } = await runResume({
      roundRecord,
      probeCtx,
      callTool: revalidationPassesP1P4CallTool(),
      effectiveVerifyBaseline,
    });
    try {
      assert.equal(result.done, true);
      assert.equal(rr.disposition.disposition, "escalate");
      assert.match(rr.disposition.reason, /P5\/P6 oracle probes did not execute/);
      assert.match(rr.disposition.reason, /UNCHECKED/);
      assert.match(rr.disposition.reason, /no P5\/P6 oracle evidence/);
      assert.doesNotMatch(rr.disposition.reason, /deterministic oracle violation was measured/);
      assert.doesNotMatch(rr.disposition.reason, /no deterministic acceptance evidence/);

      // Persisted flag and marker on the record
      assert.equal(rr.oracleUnchecked, true);
      assert.equal(rr.oracleViolation, UNCHECKED);
      assert.notEqual(rr.oracleViolation, false, "must never be checked-clean false");

      // Verify probe results recorded in revalidation: P5 present, P6 absent
      assert.ok(rr.probeResults.some((p) => p && p.probe === "P5: frozen"), "P5 must be recorded");
      assert.ok(!rr.probeResults.some((p) => p && p.probe === "P6: collected"), "P6 must not be recorded");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("finishRound accepts an approving review over green deterministic gates even when change-scope collection failed", async () => {
    // Downstream boundary: a normal round where change-scope collection failed,
    // but all six deterministic P1-P6 probes passed and reviewer approves.
    // The round must accept and never become rework or strategize.
    const roundRecord = {
      round: 1,
      reworkScope: "full",
    };
    const probeResults = [
      { probe: "change-scope (review context)", passed: false, detail: "change-scope collection failed: inject error" },
      { probe: "P1: HEAD clean", passed: true },
      { probe: "P2: verify gate", passed: true },
      { probe: "P3: deliverables", passed: true },
      { probe: "P4: smoke", passed: true },
      { probe: "P5: frozen", passed: true },
      { probe: "P6: collected", passed: true },
    ];
    const probeCtx = {
      probesGreen: true,
      probesFromRecord: false,
      oracleViolation: false,
      oracleUnchecked: false,
      changeScope: null,
      probeResults,
      chainChangedPaths: ["src/foo.js"],
      chainNewlyChanged: ["src/foo.js"],
      chainStatusObserved: true,
      chainStatusOutput: " M src/foo.js\n",
      chainBaseLog: "abc123 latest change\n",
      chainDeliverables: ["src/foo.js"],
      chainUntracked: "",
      chainTruncation: null,
      worktreeChanged: true,
    };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-541-scope-"));
    const chainDir = path.join(tmp, "chains", "chain-541-scope");
    fs.mkdirSync(chainDir, { recursive: true });
    writeChainControl(chainDir, {
      chainId: "chain-541-scope", container: "cid-541", pid: process.pid,
      status: "running", round: 0, startedAt: new Date().toISOString(),
    });
    const dispatch = approvingReviewDispatch();
    const ctx = reviewResumeCtx({ tmp, chainDir, dispatch, callTool: async () => ({ output: "" }) });
    try {
      const result = await finishRound({
        round: 1, roundRecord, previousRecord: null, probeCtx,
        implementRefusal: null, reworkScope: "full",
      }, ctx);
      assert.equal(result.done, true);
      assert.equal(roundRecord.disposition.disposition, "accept");
      assert.notEqual(roundRecord.disposition.disposition, "rework");
      assert.notEqual(roundRecord.disposition.disposition, "strategize");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});