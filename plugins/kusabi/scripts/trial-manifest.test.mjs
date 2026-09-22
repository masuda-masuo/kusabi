// trial-manifest.test.mjs — acceptance tests for the kusabi #532 trial
// manifest and trial report (issue #532 criteria 7, 8 and 9; frozen for the
// implementation chain).
//
// Interpretation note (stated, never guessed): #532's purpose says the trial
// is "interleaving 10–20 Luna missions with comparable current-orchestration
// tasks".  The unit of the trial is therefore the MISSION (the luna arm
// task); each mission has exactly one comparable current-chain arm task, and
// the arms interleave in the same period.  A manifest therefore carries
// 2 × pairCount tasks where pairCount = mission count ∈ [10, 20].  This
// reconciles criterion 7's "10–20 … tasks" wording with criterion 9's
// "across 20 missions" denominator — the range check is on the PAIR count.
//
// Frozen contract:
//
//   TRIAL_ARMS = ["luna", "current-chain"]        (exact strings)
//   TRIAL_MIN_PAIRS = 10, TRIAL_MAX_PAIRS = 20
//
//   validateTrialManifest(manifest) -> { valid: boolean, errors: string[] }
//     Rejects (each with a distinct, descriptive error):
//       - fewer than 10 or more than 20 pairs            -> "task count out of range"
//       - a pair with a missing or duplicated arm         -> "pair … missing/duplicate arm"
//       - a task with an unknown arm value                -> "task … unknown arm"
//       - consecutive tasks (by startedAt) with the SAME arm
//                                                         -> "arms are not interleaved"
//       - a task missing its pairId or comparabilityKey   -> "task … missing pair/comparability key"
//       - an unparseable startedAt/finishedAt, or finishedAt < startedAt
//                                                         -> "task … malformed date"
//       - a luna task whose subjectId is not "mission-*" or a current-chain
//         task whose subjectId is not "chain-*"           -> "task … subjectId does not match arm"
//       - a numeric observation that is not a finite non-negative number
//                                                         -> "task … must be a non-negative number"
//
//   computeTrialReport(manifest) -> report
//     Aggregates ONLY what the manifest explicitly states (the manifest
//     supplies externally observed facts — there is no durable issue or
//     manual-work store, so manual host work and defect issue references are
//     explicit manifest entries and are NEVER inferred):
//       totals: coordinatorErrors, briefCorrections, missedTriggers,
//         unnecessaryClearConsultations { lunaRequested, policyMandated },
//         reversals, sampledFalseNegatives, falsePositives, hostInterventions,
//         coordinatorRescues, failClosedBlocks, postAcceptDefectsWithin14Days,
//         latencySeconds, tokens { input, output, reasoning, cacheRead,
//         cacheWrite }, cost
//       perArm: the same aggregates split by arm, plus task count
//       latencyOverhead  = (lunaLatencySeconds - chainLatencySeconds) / chainLatencySeconds
//       costOverhead     = (lunaCost - chainCost) / chainCost
//       combinedOverhead = latencyOverhead + costOverhead
//       coordinatorErrorsTrendDown — the per-mission coordinator-error
//         average of the second half of the missions (ordered by startedAt)
//         is <= the first half's (a measured trend, never a guess)
//       postAcceptDefectsWithin14Days — defects whose createdAt lies within
//         14 days AFTER the task's finishedAt (the acceptance time); the
//         referenced issue timestamp comes from the manifest entry
//       earlyStop: { seatReachedRepoState, hostOnlyExit }
//       status — decisionStatus(report), reasons: string[]
//
//   decisionStatus(report) -> "early-stop" | "discard" | "keep" | "insufficient-evidence"
//     Order of evaluation (frozen):
//       1. early-stop: ANY task observed either Codex seat reaching repo
//          state or a host-only exit -> "early-stop";
//       2. mission count < 20 -> "insufficient-evidence" (never keep/tune);
//       3. discard: reversals === 0 && falsePositives >= 3, OR
//          coordinatorRescues / missions > 0.30, OR
//          failClosedBlocks / missions > 0.20 -> "discard";
//       4. keep: reversals >= 2 && falsePositives <= 1 &&
//          coordinatorErrorsTrendDown && combinedOverhead < 0.40 -> "keep";
//       5. otherwise -> "insufficient-evidence".
//     The report never claims a universal model ranking — status and reasons
//     only, no cross-model capability claims.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  TRIAL_ARMS,
  TRIAL_MIN_PAIRS,
  TRIAL_MAX_PAIRS,
  validateTrialManifest,
  computeTrialReport,
  decisionStatus,
} from "./trial-manifest.mjs";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function makeTask(pairIndex, arm, overrides = {}) {
  const pairId = `pair-${String(pairIndex + 1).padStart(2, "0")}`;
  const idx = pairIndex * 2 + (arm === "luna" ? 0 : 1);
  const startedAt = `2026-09-01T09:00:${String(idx).padStart(2, "0")}Z`;
  const finishedAt = `2026-09-01T11:00:${String(idx).padStart(2, "0")}Z`;
  return {
    taskId: `${pairId}-${arm}`,
    pairId,
    comparabilityKey: `issue-${pairIndex + 1}`,
    arm,
    subjectId: arm === "luna" ? `mission-${pairId}` : `chain-${pairId}`,
    startedAt,
    finishedAt,
    coordinatorErrors: arm === "luna" ? 1 : 0,
    briefCorrections: 0,
    missedTriggers: 0,
    unnecessaryClearConsultations: { lunaRequested: 0, policyMandated: 0 },
    reversals: 0,
    sampledFalseNegatives: 0,
    falsePositives: 0,
    hostInterventions: 0,
    coordinatorRescues: 0,
    failClosedBlocks: 0,
    tokens: { input: 10_000, output: 5_000, reasoning: 2_000, cacheRead: 0, cacheWrite: 0 },
    cost: arm === "luna" ? 0.06 : 0.02,
    seatReachedRepoState: false,
    hostOnlyExit: false,
    postAcceptDefects: [],
    ...overrides,
  };
}

function makeManifest(pairCount, perTask = {}) {
  const tasks = [];
  for (let i = 0; i < pairCount; i++) {
    tasks.push(makeTask(i, "luna", perTask.luna?.(i)));
    tasks.push(makeTask(i, "current-chain", perTask.chain?.(i)));
  }
  // The arms must interleave in the same period: ordered by startedAt they
  // strictly alternate.  makeTask's startedAt stamps luna first within a
  // pair, so a plain pair loop already alternates (luna, chain, luna, chain).
  tasks.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return {
    title: "trial-532",
    startedAt: "2026-09-01T09:00:00.000Z",
    tasks,
  };
}

/** A full 20-mission manifest where every keep criterion can be met. */
function keepManifest() {
  return makeManifest(20, {
    luna: (i) => ({
      reversals: 1, // 20 missions -> 20 reversals total, >= 2
      coordinatorErrors: Math.max(0, 5 - i), // trending down
      cost: 0.03,
    }),
  });
}

describe("trial manifest validation (kusabi #532 criterion 7)", () => {
  it("surface: exports the frozen constants and functions", () => {
    assert.deepEqual(TRIAL_ARMS, ["luna", "current-chain"]);
    assert.equal(TRIAL_MIN_PAIRS, 10);
    assert.equal(TRIAL_MAX_PAIRS, 20);
    assert.equal(typeof validateTrialManifest, "function");
    assert.equal(typeof computeTrialReport, "function");
    assert.equal(typeof decisionStatus, "function");
  });

  it("a 10-pair and a 20-pair manifest with alternating arms are valid", () => {
    for (const n of [10, 20]) {
      const { valid, errors } = validateTrialManifest(makeManifest(n));
      assert.equal(valid, true, `expected ${n} pairs to validate: ${errors.join("; ")}`);
    }
  });

  it("rejects out-of-range pair counts (below 10 and above 20)", () => {
    for (const n of [9, 21]) {
      const { valid, errors } = validateTrialManifest(makeManifest(n));
      assert.equal(valid, false, `${n} pairs must be rejected`);
      assert.ok(
        errors.some((e) => /task count out of range/.test(e)),
        `expected an out-of-range error, got: ${errors.join("; ")}`,
      );
    }
  });

  it("rejects a pair that is missing one arm or duplicates an arm", () => {
    const missingChain = makeManifest(10);
    missingChain.tasks = missingChain.tasks.filter((t) => !(t.pairId === "pair-01" && t.arm === "current-chain"));
    const { valid: v1, errors: e1 } = validateTrialManifest(missingChain);
    assert.equal(v1, false);
    assert.ok(e1.some((e) => /pair-01.*missing.*current-chain/.test(e)), e1.join("; "));

    const dupArm = makeManifest(10);
    dupArm.tasks.push(makeTask(0, "current-chain", { taskId: "pair-01-current-chain-dup", startedAt: "2026-09-02T00:00:00Z", finishedAt: "2026-09-02T02:00:00Z" }));
    const { valid: v2, errors: e2 } = validateTrialManifest(dupArm);
    assert.equal(v2, false);
    assert.ok(e2.some((e) => /pair-01.*duplicate/.test(e)), e2.join("; "));
  });

  it("rejects an unknown arm value", () => {
    const m = makeManifest(10);
    m.tasks[0].arm = "opencode-arm";
    const { valid, errors } = validateTrialManifest(m);
    assert.equal(valid, false);
    assert.ok(errors.some((e) => /unknown arm/.test(e)), errors.join("; "));
  });

  it("rejects non-interleaved arms (two same-arm tasks that ran consecutively, ordered by startedAt)", () => {
    const m = makeManifest(10);
    // Chronologically group the first two luna tasks: the second luna task
    // starts between the first luna task and the first chain task, so the
    // startedAt-ordered sequence begins luna, luna — a genuine interleaving
    // violation.  The manifest LIST order is irrelevant to the check.
    const luna = m.tasks.filter((t) => t.arm === "luna");
    const chain = m.tasks.filter((t) => t.arm === "current-chain");
    luna[1].startedAt = "2026-09-01T09:00:00.500Z"; // between luna[0] (09:00:00) and chain[0] (09:00:01)
    m.tasks = [luna[0], luna[1], chain[0], chain[1], ...m.tasks.slice(4)];
    const { valid, errors } = validateTrialManifest(m);
    assert.equal(valid, false);
    assert.ok(errors.some((e) => /arms are not interleaved/.test(e)), errors.join("; "));
  });

  it("accepts a chronologically alternating trial whose JSON entries are SHUFFLED in the manifest (finding 4)", () => {
    // The alternation is evaluated on the startedAt-ordered sequence, so a
    // shuffled list order never breaks a genuinely interleaved trial.
    const m = makeManifest(10);
    // Deterministic shuffle: move every task to a mirrored slot.
    m.tasks = m.tasks.map((t, i) => m.tasks[m.tasks.length - 1 - i]);
    const { valid, errors } = validateTrialManifest(m);
    assert.equal(valid, true, `chronologically interleaved but shuffled entries must stay valid: ${errors.join("; ")}`);
  });

  it("rejects a trial whose JSON entries alternate but whose work was chronologically grouped (finding 4)", () => {
    // List order strictly alternates (luna, chain, luna, chain) while every
    // luna task ran BEFORE every chain task \u2014 the old list-order check
    // accepted this; the chronological check must reject it.
    const m = makeManifest(10);
    const luna = m.tasks.filter((t) => t.arm === "luna");
    const chain = m.tasks.filter((t) => t.arm === "current-chain");
    luna.forEach((t, i) => {
      t.startedAt = `2026-09-01T09:00:${String(i).padStart(2, "0")}Z`;
      t.finishedAt = `2026-09-01T10:00:${String(i).padStart(2, "0")}Z`;
    });
    chain.forEach((t, i) => {
      t.startedAt = `2026-09-01T11:00:${String(i).padStart(2, "0")}Z`;
      t.finishedAt = `2026-09-01T12:00:${String(i).padStart(2, "0")}Z`;
    });
    // Keep the entries strictly alternating in the list.
    m.tasks = [];
    for (let i = 0; i < 10; i++) {
      m.tasks.push(luna[i], chain[i]);
    }
    const { valid, errors } = validateTrialManifest(m);
    assert.equal(valid, false, "chronologically grouped arms must be rejected even when the entries alternate");
    assert.ok(errors.some((e) => /arms are not interleaved/.test(e)), errors.join("; "));
  });

  it("equal startedAt timestamps are handled deterministically (finding 4)", () => {
    // Two same-arm tasks with the EXACT same startedAt are chronologically
    // consecutive under the deterministic tie-break \u2014 rejected, and the
    // result is identical on every validation.
    const grouped = makeManifest(10);
    const luna = grouped.tasks.filter((t) => t.arm === "luna");
    luna[1].startedAt = luna[0].startedAt;
    const first = validateTrialManifest(grouped);
    const second = validateTrialManifest(grouped);
    assert.deepEqual(first, second, "equal timestamps must never produce a non-deterministic result");
    assert.equal(first.valid, false);
    assert.ok(first.errors.some((e) => /arms are not interleaved/.test(e)), first.errors.join("; "));

    // Opposite-arm ties (a luna task and its chain pair starting together)
    // break by taskId and stay alternating \u2014 a valid, deterministic result.
    const tied = makeManifest(10);
    tied.tasks.forEach((t) => {
      t.startedAt = "2026-09-01T09:00:00.000Z";
    });
    const tiedResult = validateTrialManifest(tied);
    assert.deepEqual(tiedResult, validateTrialManifest(tied), "all-tied timestamps validate deterministically");
    assert.equal(tiedResult.valid, true, "taskId tie-break keeps the fixture's pairs alternating: " + tiedResult.errors.join("; "));
  });

  it("rejects a task missing its pairId or comparabilityKey", () => {
    const noPair = makeManifest(10);
    delete noPair.tasks[0].pairId;
    const { valid: v1, errors: e1 } = validateTrialManifest(noPair);
    assert.equal(v1, false);
    assert.ok(e1.some((e) => /missing pair\/comparability key/.test(e)), e1.join("; "));

    const noKey = makeManifest(10);
    delete noKey.tasks[3].comparabilityKey;
    const { valid: v2, errors: e2 } = validateTrialManifest(noKey);
    assert.equal(v2, false);
    assert.ok(e2.some((e) => /missing pair\/comparability key/.test(e)), e2.join("; "));
  });

  it("rejects malformed dates and finishedAt-before-startedAt", () => {
    const badDate = makeManifest(10);
    badDate.tasks[0].startedAt = "not-a-date";
    const { valid: v1, errors: e1 } = validateTrialManifest(badDate);
    assert.equal(v1, false);
    assert.ok(e1.some((e) => /malformed date/.test(e)), e1.join("; "));

    const backwards = makeManifest(10);
    backwards.tasks[0].finishedAt = "2026-01-01T00:00:00.000Z";
    const { valid: v2, errors: e2 } = validateTrialManifest(backwards);
    assert.equal(v2, false);
    assert.ok(e2.some((e) => /finishedAt before startedAt/.test(e)), e2.join("; "));
  });

  it("rejects a subjectId that does not match the arm", () => {
    const m = makeManifest(10);
    m.tasks[0].subjectId = "chain-pair-01"; // luna task with a chain id
    const { valid, errors } = validateTrialManifest(m);
    assert.equal(valid, false);
    assert.ok(errors.some((e) => /subjectId does not match arm/.test(e)), errors.join("; "));
  });

  it("rejects a non-numeric observation", () => {
    const m = makeManifest(10);
    m.tasks[0].reversals = "two";
    const { valid, errors } = validateTrialManifest(m);
    assert.equal(valid, false);
    assert.ok(errors.some((e) => /non-negative number/.test(e)), errors.join("; "));
  });
});

describe("trial report (kusabi #532 criterion 8)", () => {
  it("aggregates every measured fact from explicit manifest entries only", () => {
    const m = makeManifest(12, {
      luna: (i) => ({
        coordinatorErrors: i % 2,                       // 6 errors across 12 missions
        briefCorrections: 1,                            // 12
        missedTriggers: i < 3 ? 1 : 0,                  // 3
        unnecessaryClearConsultations: { lunaRequested: 1, policyMandated: i < 4 ? 1 : 0 },
        reversals: i < 2 ? 1 : 0,                       // 2
        sampledFalseNegatives: i === 5 ? 1 : 0,         // 1
        falsePositives: i === 7 ? 1 : 0,                // 1
        hostInterventions: i === 9 ? 1 : 0,             // 1 (explicit manifest entry)
        coordinatorRescues: i === 9 ? 1 : 0,            // 1
        failClosedBlocks: i === 11 ? 1 : 0,             // 1
        cost: 0.06,
        postAcceptDefects: i === 0
          ? [{ issueRef: "org/repo#101", createdAt: "2026-09-05T00:00:00.000Z" },   // within 14 days
             { issueRef: "org/repo#199", createdAt: "2026-11-01T00:00:00.000Z" }]  // outside 14 days
          : [],
      }),
    });
    const report = computeTrialReport(m);
    assert.equal(report.pairCount, 12);
    assert.equal(report.missionCount, 12);
    assert.equal(report.chainCount, 12);
    assert.equal(report.totals.coordinatorErrors, 6);
    assert.equal(report.totals.briefCorrections, 12);
    assert.equal(report.totals.missedTriggers, 3);
    assert.equal(report.totals.unnecessaryClearConsultations.lunaRequested, 12);
    assert.equal(report.totals.unnecessaryClearConsultations.policyMandated, 4);
    assert.equal(report.totals.reversals, 2);
    assert.equal(report.totals.sampledFalseNegatives, 1);
    assert.equal(report.totals.falsePositives, 1);
    assert.equal(report.totals.hostInterventions, 1, "manual host work comes from the manifest entry, never inferred");
    assert.equal(report.totals.coordinatorRescues, 1);
    assert.equal(report.totals.failClosedBlocks, 1);
    assert.equal(report.totals.postAcceptDefectsWithin14Days, 1, "only the issue timestamp within 14 days of acceptance counts");
    assert.equal(report.totals.cost, 12 * 0.06);
    assert.deepEqual(report.totals.tokens, {
      input: 12 * 10_000,
      output: 12 * 5_000,
      reasoning: 12 * 2_000,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("splits the aggregates by arm (perArm) and computes latency/cost overhead", () => {
    const m = makeManifest(10);
    // luna task duration 2h = 7200s; give the chain arm a shorter duration
    // so the overhead is measurable.
    m.tasks.forEach((t) => {
      if (t.arm === "current-chain") {
        t.startedAt = "2026-09-01T09:00:00.000Z";
        t.finishedAt = "2026-09-01T10:00:00.000Z"; // 3600s vs luna's 7200s
      }
    });
    const report = computeTrialReport(m);
    assert.equal(report.perArm.luna.count, 10);
    assert.equal(report.perArm["current-chain"].count, 10);
    assert.equal(report.perArm.luna.latencySeconds, 10 * 7200);
    assert.equal(report.perArm["current-chain"].latencySeconds, 10 * 3600);
    // latencyOverhead = (72000 - 36000)/36000 = 1.0 ; costOverhead = (0.6-0.2)/0.2 = 2.0
    assert.equal(report.latencyOverhead, 1.0);
    assert.equal(report.costOverhead, 2.0);
    assert.equal(report.combinedOverhead, 3.0);
  });

  it("trends coordinator errors down only when the second half of missions measurably improves", () => {
    const down = makeManifest(10, { luna: (i) => ({ coordinatorErrors: Math.max(0, 4 - i) }) });
    assert.equal(computeTrialReport(down).coordinatorErrorsTrendDown, true);

    const up = makeManifest(10, { luna: (i) => ({ coordinatorErrors: i }) });
    assert.equal(computeTrialReport(up).coordinatorErrorsTrendDown, false);
  });

  it("reports the early-stop flags aggregated from manifest entries", () => {
    const m = makeManifest(10, { luna: (i) => (i === 4 ? { seatReachedRepoState: true } : {}) });
    const report = computeTrialReport(m);
    assert.equal(report.earlyStop.seatReachedRepoState, true);
    assert.equal(report.earlyStop.hostOnlyExit, false);
  });
});

describe("decision criteria (kusabi #532 criterion 9)", () => {
  it("emits early-stop when either Codex seat reached repo state or a host-only exit was observed", () => {
    const repo = makeManifest(10, { luna: (i) => (i === 0 ? { seatReachedRepoState: true } : {}) });
    assert.equal(decisionStatus(computeTrialReport(repo)), "early-stop");

    const hostOnly = makeManifest(10, { chain: (i) => (i === 3 ? { hostOnlyExit: true } : {}) });
    assert.equal(decisionStatus(computeTrialReport(hostOnly)), "early-stop");
  });

  it("emits insufficient evidence for fewer than 20 missions, never keep or discard", () => {
    const ten = makeManifest(10);
    const report = computeTrialReport(ten);
    assert.equal(report.missionCount, 10);
    assert.equal(decisionStatus(report), "insufficient-evidence");

    const nineteen = makeManifest(19);
    assert.equal(decisionStatus(computeTrialReport(nineteen)), "insufficient-evidence");
  });

  it("an absent Luna cost never acts as zero: no KEEP, no -1 cost overhead (finding 4)", () => {
    // 20 valid pairs, every other keep criterion met — only the Luna arm's
    // cost is ABSENT (the key is deleted, never a measured zero).  The
    // report must not compute (0 - chain)/chain = -1 and must not KEEP.
    const m = keepManifest();
    m.tasks.forEach((t) => {
      t.startedAt = "2026-09-01T09:00:00.000Z";
      t.finishedAt = "2026-09-01T11:00:00.000Z";
      if (t.arm === "luna") delete t.cost;
    });
    const report = computeTrialReport(m);
    assert.equal(report.missionCount, 20);
    assert.equal(report.perArm.luna.costMeasured, false, "the Luna arm's cost is unmeasured");
    assert.equal(report.perArm.luna.cost, null, "an absent Luna cost stays null, never 0");
    assert.equal(report.perArm["current-chain"].costMeasured, true);
    assert.equal(report.costOverhead, null, "absent Luna cost must not report -1 or any numeric overhead");
    assert.equal(report.combinedOverhead, null);
    assert.deepEqual(report.missingMeasurements, { latency: false, cost: true });
    assert.equal(decisionStatus(report), "insufficient-evidence",
      "absent required measurements force insufficient-evidence, never keep");
  });

  it("absent Luna latency never acts as zero: no KEEP, latency overhead null (finding 4, symmetric rule)", () => {
    const m = keepManifest();
    m.tasks.forEach((t) => {
      if (t.arm === "luna") {
        t.startedAt = "not-a-date";
        t.finishedAt = "not-a-date";
      }
    });
    const report = computeTrialReport(m);
    assert.equal(report.perArm.luna.latencyMeasured, false, "the Luna arm's latency is unmeasured");
    assert.equal(report.perArm.luna.latencySeconds, null, "absent latency stays null, never 0");
    assert.equal(report.latencyOverhead, null);
    assert.equal(report.combinedOverhead, null);
    assert.deepEqual(report.missingMeasurements, { latency: true, cost: false });
    assert.equal(decisionStatus(report), "insufficient-evidence");
  });

  it("keeps only when all four keep criteria hold across 20 missions", () => {
    const m = keepManifest(); // 20 reversals, 0 false positives, errors down
    // Equalise the durations so the latency overhead is 0 and keep the cost
    // gap small enough that the combined overhead stays below 0.40.
    m.tasks.forEach((t) => {
      t.startedAt = "2026-09-01T09:00:00.000Z";
      t.finishedAt = "2026-09-01T11:00:00.000Z";
      t.cost = t.arm === "luna" ? 0.03 : 0.025;
    });
    const report = computeTrialReport(m);
    assert.equal(report.latencyOverhead, 0);
    assert.ok(report.combinedOverhead < 0.40, `combined overhead ${report.combinedOverhead} must be below 0.40`);
    assert.equal(report.totals.reversals >= 2, true);
    assert.equal(report.totals.falsePositives <= 1, true);
    assert.equal(report.coordinatorErrorsTrendDown, true);
    assert.equal(decisionStatus(report), "keep");
  });

  it("discards on 0 reversals with at least 3 false positives", () => {
    const m = makeManifest(20, { luna: (i) => ({ reversals: 0, falsePositives: i < 3 ? 1 : 0 }) });
    const report = computeTrialReport(m);
    assert.equal(report.totals.reversals, 0);
    assert.equal(report.totals.falsePositives, 3);
    assert.equal(decisionStatus(report), "discard");
  });

  it("discards when coordinator rescues exceed 30% of missions", () => {
    const m = makeManifest(20, { luna: (i) => ({ coordinatorRescues: i < 7 ? 1 : 0 }) }); // 7/20 = 0.35
    const report = computeTrialReport(m);
    assert.equal(report.totals.coordinatorRescues / report.missionCount > 0.30, true);
    assert.equal(decisionStatus(report), "discard");
  });

  it("discards when fail-closed blocks exceed 20% of missions", () => {
    const m = makeManifest(20, { luna: (i) => ({ failClosedBlocks: i < 5 ? 1 : 0 }) }); // 5/20 = 0.25
    const report = computeTrialReport(m);
    assert.equal(report.totals.failClosedBlocks / report.missionCount > 0.20, true);
    assert.equal(decisionStatus(report), "discard");
  });

  it("never emits a universal model ranking: the report carries status and reasons only", () => {
    const report = computeTrialReport(keepManifest());
    assert.equal(typeof report.status, "string");
    assert.ok(Array.isArray(report.reasons));
    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /better than|superior|outperforms/i);
  });
});