import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sessionProvenanceRefusal, renderChainBanner } from "./chain-cmd.mjs";
import { effectiveTierCount } from "./chain-driver.mjs";

// sessionProvenanceRefusal — the agy --session chain-start gate (kusabi #321)
// ---------------------------------------------------------------------------
// The refusal decision is pure and exported so every case is testable
// without running a chain: an agy implement phase plus a session whose
// provenance is not provably agy refuses, everything else passes.  The gate
// is on the PROPERTY, never on the --session flag: an id the caller
// resolved FROM the job store arrives with its owner record and is provable
// by construction, so there is no flag-shaped branch for it to take — and
// the refusal text never mentions it (asserted below).

describe("sessionProvenanceRefusal (kusabi #321)", () => {
  const AGY = "agy";
  const OPENCODE = "opencode";
  const CLAUDE = "claude";
  const UUID = "123e4567-e89b-12d3-a456-426614174000";

  it("passes a chain with no --session", () => {
    assert.equal(sessionProvenanceRefusal({ session: null, provenance: null, implementBackend: AGY }), null);
    assert.equal(sessionProvenanceRefusal({ session: undefined, provenance: null, implementBackend: AGY }), null);
    assert.equal(sessionProvenanceRefusal({ session: "", provenance: null, implementBackend: AGY }), null);
  });

  it("passes a session the store proves agy-owned on an agy chain", () => {
    assert.equal(sessionProvenanceRefusal({ session: UUID, provenance: AGY, implementBackend: AGY }), null);
  });

  it("refuses a session with no owner record on an agy chain, naming the id", () => {
    const refusal = sessionProvenanceRefusal({ session: UUID, provenance: null, implementBackend: AGY });
    assert.ok(refusal, "an unprovable id on an agy chain must refuse");
    assert.match(refusal, new RegExp(UUID));
    assert.match(refusal, /dispatch refused/);
    assert.match(refusal, /owner record/);
    assert.match(refusal, /provenance cannot be established/);
  });

  it("refuses a session owned by another backend on an agy chain, naming both backends", () => {
    for (const owner of [OPENCODE, CLAUDE]) {
      const refusal = sessionProvenanceRefusal({ session: UUID, provenance: owner, implementBackend: AGY });
      assert.ok(refusal, `an ${owner}-owned id on an agy chain must refuse`);
      assert.match(refusal, new RegExp(UUID));
      assert.match(refusal, new RegExp(owner));
      assert.match(refusal, new RegExp(AGY));
      assert.match(refusal, /belongs to the /);
    }
  });

  it("passes every session shape when the implement phase does not resolve to agy", () => {
    assert.equal(sessionProvenanceRefusal({ session: UUID, provenance: null, implementBackend: OPENCODE }), null);
    assert.equal(sessionProvenanceRefusal({ session: UUID, provenance: CLAUDE, implementBackend: OPENCODE }), null);
    assert.equal(sessionProvenanceRefusal({ session: UUID, provenance: AGY, implementBackend: OPENCODE }), null);
    assert.equal(sessionProvenanceRefusal({ session: UUID, provenance: null, implementBackend: CLAUDE }), null);
    assert.equal(sessionProvenanceRefusal({ session: UUID, provenance: AGY, implementBackend: CLAUDE }), null);
  });

  it("never mentions --resume-last: the gate is property-shaped, with no flag-shaped branch", () => {
    const noOwner = sessionProvenanceRefusal({ session: UUID, provenance: null, implementBackend: AGY });
    const foreign = sessionProvenanceRefusal({ session: UUID, provenance: OPENCODE, implementBackend: AGY });
    assert.doesNotMatch(noOwner, /resume-last/i);
    assert.doesNotMatch(foreign, /resume-last/i);
  });
});


// banner must not claim tiers it cannot walk (reworkTiers=2 on a claude
// rework chain of 2 was a false "can reach top tier" claim at maxRounds >= 3).
// =========================================================================

describe("chain-start banner (kusabi #192 follow-up)", () => {
  const OPENCODE_IMPLEMENT_1 = [["opencode-go/deepseek-v4-pro"]];
  const OPENCODE_REWORK_2 = [["opencode-go/deepseek-v4-flash"], ["opencode-go/deepseek-v4-pro"]];
  const CLAUDE_IMPLEMENT_1 = [["claude/opus"]];
  const CLAUDE_REWORK_2 = [["claude/opus"], ["claude/sonnet-4-5"]];

  it("opencode rework chain of 2: unchanged semantics — can reach top with maxRounds >= 3", () => {
    const tierCount = effectiveTierCount(OPENCODE_IMPLEMENT_1, "opencode");
    const reworkTierCount = effectiveTierCount(OPENCODE_REWORK_2, "opencode");
    assert.equal(tierCount, 1);
    assert.equal(reworkTierCount, 2, "opencode chains keep their full length");
    // roundsToTopTier = 1 + 2 = 3: the top tier needs three rounds.
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount, reworkKeyConfigured: true, maxRounds: 3 }),
      "Chain c1: tiers=1, reworkTiers=2, maxRounds=3 (can reach top tier)\n");
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount, reworkKeyConfigured: true, maxRounds: 2 }),
      "Chain c1: tiers=1, reworkTiers=2, maxRounds=2 (maxRounds insufficient to reach top tier)\n");
  });

  it("claude-native rework chain of 2: effective tier count is 1 — the claim never exceeds ladderTierCount 1", () => {
    const tierCount = effectiveTierCount(CLAUDE_IMPLEMENT_1, "claude");
    const reworkTierCount = effectiveTierCount(CLAUDE_REWORK_2, "claude");
    assert.equal(tierCount, 1);
    assert.equal(reworkTierCount, 1, "a claude chain counts as one tier");
    // roundsToTopTier = 1 + 1 = 2: maxRounds 2 already reaches the (only)
    // top tier.  The pre-fix code computed roundsToTopTier = 3 from the raw
    // length 2 and falsely claimed the top was unreachable at maxRounds 2.
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount, reworkKeyConfigured: true, maxRounds: 2 }),
      "Chain c1: tiers=1, reworkTiers=1, maxRounds=2 (can reach top tier)\n");
    // At maxRounds 3 the pre-fix banner printed reworkTiers=2 and claimed
    // can-reach-top from a 2-tier ladder the claude backend never walks.
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount, reworkKeyConfigured: true, maxRounds: 3 }),
      "Chain c1: tiers=1, reworkTiers=1, maxRounds=3 (can reach top tier)\n");
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount, reworkKeyConfigured: true, maxRounds: 1 }),
      "Chain c1: tiers=1, reworkTiers=1, maxRounds=1 (maxRounds insufficient to reach top tier)\n");
  });

  it("no rework key: today's banner byte-identical (opencode implement chain of 2)", () => {
    const tierCount = effectiveTierCount(OPENCODE_REWORK_2, "opencode");
    assert.equal(tierCount, 2);
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount: 0, reworkKeyConfigured: false, maxRounds: 3 }),
      "Chain c1: tiers=2, maxRounds=3 (can reach top tier)\n");
  });

  it("no rework key, claude implement chain of 2: the implement surface clamps to one tier too", () => {
    const tierCount = effectiveTierCount(CLAUDE_REWORK_2, "claude");
    assert.equal(tierCount, 1);
    // Pre-fix: tiers=2 with roundsToTopTier=3 — a false claim at maxRounds 2.
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount: 0, reworkKeyConfigured: false, maxRounds: 2 }),
      "Chain c1: tiers=1, maxRounds=2 (can reach top tier)\n");
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount: 0, reworkKeyConfigured: false, maxRounds: 3 }),
      "Chain c1: tiers=1, maxRounds=3 (can reach top tier)\n");
  });

  it("no implement chain: no banner line (the caller skips the write)", () => {
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount: 0, reworkTierCount: 0, reworkKeyConfigured: false, maxRounds: 4 }),
      null);
  });
});


describe("smoke baseline wiring (kusabi #292)", () => {
  const chainCmdSource = fs.readFileSync(path.join(import.meta.dirname, "chain-cmd.mjs"), "utf8");
  const taskCmdSource = fs.readFileSync(path.join(import.meta.dirname, "task-cmd.mjs"), "utf8");

  // The body of the top-level function starting at `anchor`, i.e. up to the
  // next top-level export.
  function functionSource(source, anchor) {
    const start = source.indexOf(anchor);
    assert.ok(start >= 0, `anchor not found: ${anchor}`);
    const end = source.indexOf("\nexport ", start + anchor.length);
    return source.slice(start, end === -1 ? undefined : end);
  }

  it("cmdChain runs the baseline before any chain state is created", () => {
    const body = functionSource(chainCmdSource, "export async function cmdChain(");
    const baselineAt = body.indexOf("smokeBaselineReport(");
    const createAt = body.indexOf("createChainDir(");
    assert.ok(baselineAt > 0, "cmdChain must run the baseline");
    assert.ok(createAt > 0, "cmdChain must still create the chain dir");
    assert.ok(baselineAt < createAt, "the baseline must run before any chain state exists");
  });

  it("cmdChainResume performs no baseline execution", () => {
    // By resume time the worktree carries the previous rounds' changes, so a
    // baseline run there would measure the worker's work and call it the
    // brief's fault.  #250's parse-time check is the only smoke guard on this
    // path.
    const body = functionSource(chainCmdSource, "export async function cmdChainResume(");
    assert.ok(!body.includes("smokeBaselineReport("), "resume must not re-run the baseline");
    assert.ok(body.includes("smokeViolationReport("), "resume keeps the #250 parse check");
    // One call site in the whole driver, and it is cmdChain's.
    assert.equal(chainCmdSource.split("await smokeBaselineReport(").length - 1, 1);
  });

  it("cmdTask runs the baseline before the dispatch", () => {
    const body = taskCmdSource.slice(
      taskCmdSource.indexOf("async function cmdTask("),
      taskCmdSource.indexOf("async function cmdReview("),
    );
    const baselineAt = body.indexOf("smokeBaselineReport(");
    const dispatchAt = body.indexOf("await dispatch({");
    assert.ok(baselineAt > 0, "cmdTask must run the baseline");
    assert.ok(dispatchAt > 0, "cmdTask must still dispatch");
    assert.ok(baselineAt < dispatchAt, "the baseline must run before the job is dispatched");
  });
});



describe("session-provenance wiring (kusabi #321)", () => {
  const chainCmdSource = fs.readFileSync(path.join(import.meta.dirname, "chain-cmd.mjs"), "utf8");

  // The body of the top-level function starting at `anchor`, i.e. up to the
  // next top-level export (same shape as the smoke-baseline wiring block).
  function functionSource(source, anchor) {
    const start = source.indexOf(anchor);
    assert.ok(start >= 0, `anchor not found: ${anchor}`);
    const end = source.indexOf("\nexport ", start + anchor.length);
    return source.slice(start, end === -1 ? undefined : end);
  }

  it("cmdChain refuses before any baseline measurement or chain state exists", () => {
    const body = functionSource(chainCmdSource, "export async function cmdChain(");
    const gateAt = body.indexOf("sessionProvenanceRefusal({");
    assert.ok(gateAt > 0, "cmdChain must call the session-provenance gate");
    assert.ok(gateAt < body.indexOf("smokeBaselineReport("), "the gate precedes the smoke baseline run");
    assert.ok(gateAt < body.indexOf("captureVerifyBaseline("), "the gate precedes the verify baseline");
    assert.ok(gateAt < body.indexOf("createChainDir("), "the gate precedes any chain state");
    // The refusal is thrown, not threaded: the sessionProvenance plumbing
    // into runChainDriver stays exactly as it was.
    assert.ok(gateAt < body.indexOf("runChainDriver({"), "the gate precedes the driver call");
    assert.ok(body.includes("sessionProvenance,"), "sessionProvenance must still reach the driver");
  });

  it("the gate lives in cmdChain, not in the resume path (chain-resume resolves its own session)", () => {
    const body = functionSource(chainCmdSource, "export async function cmdChainResume(");
    assert.ok(!body.includes("sessionProvenanceRefusal("), "resume must not run the fresh-chain gate");
    assert.ok(chainCmdSource.includes("sessionProvenanceRefusal("), "the gate exists in chain-cmd");
  });
});

