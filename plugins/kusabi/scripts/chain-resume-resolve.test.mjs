import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  archiveFailedReviewSeat,
  classifyReviewSeatReplacement,
  resolveChainResume,
} from "./chain-resume-resolve.mjs";
import {
  computeChainTotals,
} from "./chain-persist.mjs";
import {
  recordQuotaExhaustion,
  quotaExhaustionReason,
  quotaReplacementRefusal,
  explicitRouteDiffersFromRecord,
} from "./chain-phases.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");

// =========================================================================
// resolveChainResume — resume-position decision (kusabi #153①)
// =========================================================================

describe("resolveChainResume", () => {
  function baseChainJson(overrides = {}) {
    return {
      chainId: "chain-test",
      container: "cid-1",
      model: "fake/model",
      modelChain: [["fake/model"], ["fake/pro"]],
      maxRounds: 4,
      brief: "Implement X.",
      orchestrator: null,
      records: [],
      baseSha: "abc123",
      chainTotals: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      strategized: false,
      followupIssueDraft: null,
      ...overrides,
    };
  }

  function partialRound(overrides = {}) {
    return {
      round: 3,
      resumeMethod: { type: "continue_session" },
      startedAt: "2026-08-01T00:00:00.000Z",
      verdict: null,
      probesGreen: true,
      modelEntry: "fake/model",
      implementJobId: "job-imp-3",
      sessionID: "sess-3",
      implementUsage: null,
      tierBefore: 1,
      reworkStrategyReason: null,
      reworkCount: 2,
      probeResults: [],
      worktreeChanged: true,
      interrupted: true,
      interruptedAfter: "probes",
      ...overrides,
    };
  }

  it("errors when the control record is missing", () => {
    const result = resolveChainResume({ control: null, chainJson: baseChainJson() });
    assert.equal(result.ok, false);
    assert.match(result.error, /no control record/);
  });

  it("errors when chain.json is missing", () => {
    const result = resolveChainResume({ control: { status: "cancelled" }, chainJson: null });
    assert.equal(result.ok, false);
    assert.match(result.error, /no chain\.json/);
  });

  it("errors for a running chain (live pid)", () => {
    const control = {
      chainId: "chain-test", container: "cid-1", pid: process.pid,
      status: "running", round: 2, startedAt: new Date().toISOString(),
    };
    const result = resolveChainResume({ control, chainJson: baseChainJson() });
    assert.equal(result.ok, false);
    assert.match(result.error, /still running/);
  });

  it("errors for a stopping chain (stop requested, live pid)", () => {
    const control = {
      chainId: "chain-test", container: "cid-1", pid: process.pid,
      status: "running", round: 2, startedAt: new Date().toISOString(),
      stopRequestedAt: new Date().toISOString(), stopRequestedBy: "cli",
    };
    const result = resolveChainResume({ control, chainJson: baseChainJson() });
    assert.equal(result.ok, false);
    assert.match(result.error, /still running/);
  });

  it("errors for a completed chain", () => {
    const control = {
      chainId: "chain-test", container: "cid-1", pid: 0,
      status: "completed", round: 2, finishedAt: new Date().toISOString(),
    };
    const result = resolveChainResume({ control, chainJson: baseChainJson() });
    assert.equal(result.ok, false);
    assert.match(result.error, /already finished/);
  });

  it("errors for a failed chain", () => {
    const control = {
      chainId: "chain-test", container: "cid-1", pid: 0,
      status: "failed", round: 2, finishedAt: new Date().toISOString(),
    };
    const result = resolveChainResume({ control, chainJson: baseChainJson() });
    assert.equal(result.ok, false);
    assert.match(result.error, /already finished/);
  });

  it("treats a running record with a dead pid as resumable (abnormal stop)", () => {
    const control = {
      chainId: "chain-test", container: "cid-1", pid: 0, // dead
      status: "running", round: 2,
    };
    const chainJson = baseChainJson({ records: [partialRound()] });
    const result = resolveChainResume({ control, chainJson });
    assert.equal(result.ok, true);
    assert.equal(result.position.phase, "review");
  });

  it("resumes at the review phase of the interrupted round, carrying its context", () => {
    const control = {
      chainId: "chain-test", container: "cid-1", pid: 0,
      status: "cancelled", round: 3, finishedAt: new Date().toISOString(),
    };
    const partial = partialRound();
    const chainJson = baseChainJson({ records: [partial], strategized: true });
    const result = resolveChainResume({ control, chainJson });

    assert.equal(result.ok, true);
    const p = result.position;
    assert.equal(p.phase, "review");
    assert.equal(p.round, 3);
    assert.equal(p.roundRecord, partial);
    assert.equal(p.reworkCount, 2);           // carried, not incremented
    assert.equal(p.currentTierIndex, 1);      // from tierBefore
    assert.equal(p.strategized, true);
    assert.equal(p.session, "sess-3");
    assert.equal(p.baseSha, "abc123");
  });

  it("resumes at the next round's implement after a rework disposition, with escalated tier and rework count", () => {
    const control = {
      chainId: "chain-test", container: "cid-1", pid: 0,
      status: "cancelled", round: 2, finishedAt: new Date().toISOString(),
    };
    const complete = {
      round: 2,
      implementJobId: "job-imp-2",
      reviewJobId: "job-rev-2",
      verdict: "needs-attention",
      findingsText: "fix it",
      sessionID: "sess-2",
      tierBefore: 0,
      tierAfter: 1,
      reworkCount: 1,
      pendingReworkStrategy: { tierDelta: 1, newSession: true, reason: "2nd rework: escalate tier" },
      disposition: { disposition: "rework", reason: "needs-attention" },
    };
    const chainJson = baseChainJson({ records: [complete] });
    const result = resolveChainResume({ control, chainJson });

    assert.equal(result.ok, true);
    const p = result.position;
    assert.equal(p.phase, "implement");
    assert.equal(p.round, 3);
    assert.equal(p.roundRecord, null);
    assert.equal(p.reworkCount, 2);        // 1 + the consumed rework
    assert.equal(p.currentTierIndex, 1);   // tierAfter carried
    assert.equal(p.session, "sess-2");
  });

  it("does not consume a rework after a strategize disposition", () => {
    const control = {
      chainId: "chain-test", container: "cid-1", pid: 0,
      status: "cancelled", round: 2, finishedAt: new Date().toISOString(),
    };
    const complete = {
      round: 2,
      implementJobId: "job-imp-2",
      reviewJobId: "job-rev-2",
      verdict: "needs-attention",
      sessionID: "sess-2",
      tierBefore: 1,
      tierAfter: 1,
      reworkCount: 1,
      pendingReworkStrategy: { tierDelta: 0, newSession: true, reason: "strategized: new session" },
      disposition: { disposition: "strategize", reason: "same file area flagged twice" },
    };
    const chainJson = baseChainJson({ records: [complete], strategized: true });
    const result = resolveChainResume({ control, chainJson });

    assert.equal(result.ok, true);
    assert.equal(result.position.phase, "implement");
    assert.equal(result.position.round, 3);
    assert.equal(result.position.reworkCount, 1); // strategize consumed none
    assert.equal(result.position.currentTierIndex, 1);
  });

  it("errors for a cancelled chain whose last round was accepted", () => {
    const control = { chainId: "chain-test", container: "cid-1", pid: 0, status: "cancelled", round: 2 };
    const complete = {
      round: 2,
      implementJobId: "job-imp-2",
      reviewJobId: "job-rev-2",
      verdict: "approve",
      disposition: { disposition: "accept" },
    };
    const result = resolveChainResume({ control, chainJson: baseChainJson({ records: [complete] }) });
    assert.equal(result.ok, false);
    assert.match(result.error, /already finished/);
  });

  it("errors for a cancelled chain whose last round escalated", () => {
    const control = { chainId: "chain-test", container: "cid-1", pid: 0, status: "cancelled", round: 2 };
    const complete = {
      round: 2,
      implementJobId: "job-imp-2",
      reviewJobId: "job-rev-2",
      verdict: "discard",
      disposition: { disposition: "escalate" },
    };
    const result = resolveChainResume({ control, chainJson: baseChainJson({ records: [complete] }) });
    assert.equal(result.ok, false);
    assert.match(result.error, /already finished/);
  });

  // kusabi #293: refused-brief-defect is terminal.  Even a STALE control
  // (status "running", dead pid) must not resume into a fresh implement
  // round on the same defective brief -- the brief must be fixed and a new
  // chain re-dispatched instead.
  it("refuses resume for a stale control whose last round refused the brief as defective", () => {
    const control = {
      chainId: "chain-test", container: "cid-1", pid: 0, // dead
      status: "running", round: 2,
    };
    const complete = {
      round: 2,
      implementJobId: "job-imp-2",
      reviewJobId: "job-rev-2",
      verdict: "discard",
      disposition: { disposition: "refused-brief-defect", reason: "the two named anchors contradict" },
    };
    const result = resolveChainResume({ control, chainJson: baseChainJson({ records: [complete] }) });
    assert.equal(result.ok, false);
    assert.match(result.error, /refused-brief-defect/);
    assert.match(result.error, /brief is defective/);
    assert.match(result.error, /re-dispatch a new chain/);
  });

  it("refuses resume for a fresh cancelled control whose last round refused the brief as defective", () => {
    const control = { chainId: "chain-test", container: "cid-1", pid: 0, status: "cancelled", round: 2 };
    const complete = {
      round: 2,
      implementJobId: "job-imp-2",
      reviewJobId: "job-rev-2",
      verdict: "discard",
      disposition: { disposition: "refused-brief-defect" },
    };
    const result = resolveChainResume({ control, chainJson: baseChainJson({ records: [complete] }) });
    assert.equal(result.ok, false);
    assert.match(result.error, /refused-brief-defect/);
    assert.match(result.error, /brief is defective/);
    assert.match(result.error, /re-dispatch a new chain/);
  });

  it("errors when there are no round records at all", () => {
    const control = { chainId: "chain-test", container: "cid-1", pid: 0, status: "cancelled", round: 0 };
    const result = resolveChainResume({ control, chainJson: baseChainJson() });
    assert.equal(result.ok, false);
    assert.match(result.error, /no round records to resume from/);
  });

  it("errors for a record with no implement job (no phase boundary)", () => {
    const control = { chainId: "chain-test", container: "cid-1", pid: 0, status: "cancelled", round: 3 };
    const broken = { round: 3, verdict: null, interrupted: true };
    const result = resolveChainResume({ control, chainJson: baseChainJson({ records: [broken] }) });
    assert.equal(result.ok, false);
    assert.match(result.error, /no implement job/);
  });

  it("errors for an inconsistent record (review present, no disposition)", () => {
    const control = { chainId: "chain-test", container: "cid-1", pid: 0, status: "cancelled", round: 3 };
    const broken = { round: 3, implementJobId: "job-3", reviewJobId: "job-rev-3", verdict: "approve" };
    const result = resolveChainResume({ control, chainJson: baseChainJson({ records: [broken] }) });
    assert.equal(result.ok, false);
    assert.match(result.error, /inconsistent/);
  });

  it("errors when rework would exceed maxRounds", () => {
    const control = { chainId: "chain-test", container: "cid-1", pid: 0, status: "cancelled", round: 4 };
    const complete = {
      round: 4,
      implementJobId: "job-imp-4",
      reviewJobId: "job-rev-4",
      verdict: "needs-attention",
      tierBefore: 1,
      tierAfter: 1,
      reworkCount: 2,
      disposition: { disposition: "rework", reason: "needs-attention" },
    };
    const result = resolveChainResume({ control, chainJson: baseChainJson({ records: [complete], maxRounds: 4 }) });
    assert.equal(result.ok, false);
    assert.match(result.error, /max rounds \(4\) already reached/);
  });

  // kusabi #60 step 2: the resume gate mirrors the driver's budget semantics.
  // The raw round number may exceed maxRounds when mechanical rounds ran for
  // free; resume is refused only when the derived budget is spent or the
  // 2 × maxRounds hard cap would be exceeded.
  it("allows resume when mechanical rounds pushed the round number past maxRounds but budget remains", () => {
    const control = { chainId: "chain-test", container: "cid-1", pid: 0, status: "cancelled", round: 2 };
    const reworkRecord = (round, reworkScope) => ({
      round,
      reworkScope,
      implementJobId: "job-imp-" + round,
      reviewJobId: "job-rev-" + round,
      verdict: "needs-attention",
      disposition: { disposition: "rework", reason: "needs-attention" },
    });
    const result = resolveChainResume({
      control,
      chainJson: baseChainJson({
        records: [reworkRecord(1, "full"), reworkRecord(2, "mechanical")],
        maxRounds: 2,
      }),
    });
    // Round 2 is the last completed round (nextRound 3 > maxRounds 2), but
    // only round 1 consumed budget (1 < 2) and 3 ≤ 2 × 2 — resume is valid.
    assert.equal(result.ok, true);
    assert.equal(result.position.phase, "implement");
    assert.equal(result.position.round, 3);
    assert.equal(result.position.records.length, 2);
  });

  it("refuses resume when the derived budget is spent even while rounds remain under the hard cap", () => {
    const control = { chainId: "chain-test", container: "cid-1", pid: 0, status: "cancelled", round: 3 };
    const reworkRecord = (round) => ({
      round,
      reworkScope: "full",
      implementJobId: "job-imp-" + round,
      reviewJobId: "job-rev-" + round,
      verdict: "needs-attention",
      disposition: { disposition: "rework", reason: "needs-attention" },
    });
    const result = resolveChainResume({
      control,
      chainJson: baseChainJson({ records: [1, 2, 3].map(reworkRecord), maxRounds: 3 }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /max rounds \(3\) already reached/);
  });

  it("refuses resume when the 2 × maxRounds hard cap would be exceeded even with budget remaining", () => {
    const control = { chainId: "chain-test", container: "cid-1", pid: 0, status: "cancelled", round: 4 };
    const reworkRecord = (round, reworkScope) => ({
      round,
      reworkScope,
      implementJobId: "job-imp-" + round,
      reviewJobId: "job-rev-" + round,
      verdict: "needs-attention",
      disposition: { disposition: "rework", reason: "needs-attention" },
    });
    const result = resolveChainResume({
      control,
      chainJson: baseChainJson({
        records: [
          reworkRecord(1, "full"),
          reworkRecord(2, "mechanical"),
          reworkRecord(3, "mechanical"),
          reworkRecord(4, "mechanical"),
        ],
        maxRounds: 2,
      }),
    });
    // Budget 1 < 2 remains, but round 5 > 2 × 2 would break the hard cap.
    assert.equal(result.ok, false);
    assert.match(result.error, /max rounds \(2\) already reached/);
  });

  it("errors when chain.json has no modelChain", () => {
    const control = { chainId: "chain-test", container: "cid-1", pid: 0, status: "cancelled", round: 3 };
    const chainJson = baseChainJson({ modelChain: undefined, records: [partialRound()] });
    const result = resolveChainResume({ control, chainJson });
    assert.equal(result.ok, false);
    assert.match(result.error, /no modelChain/);
  });

  it("errors when chain.json has no brief", () => {
    const control = { chainId: "chain-test", container: "cid-1", pid: 0, status: "cancelled", round: 3 };
    const chainJson = baseChainJson({ brief: "", records: [partialRound()] });
    const result = resolveChainResume({ control, chainJson });
    assert.equal(result.ok, false);
    assert.match(result.error, /no brief/);
  });

  // =======================================================================
  // Replacement review seat (kusabi #248)
  //
  // Fixtures reproduce chain-mssxxuu3cc16: round 1 implement complete, probes
  // all green, the review seat died mid-stream (`partial`), the chain
  // escalated on that seat failure and finalised as status "completed".  The
  // implementation was intact; only the seat was consumed.
  // =======================================================================

  // The chain finished NORMALLY on the escalate, so control status is
  // "completed" with a dead pid -- not "cancelled".
  const seatControl = {
    chainId: "chain-test", container: "cid-1", pid: 0,
    status: "completed", round: 1, finishedAt: "2026-08-01T01:00:00.000Z",
  };

  const greenProbes = () => ([
    { probe: "P1: HEAD clean", passed: true, detail: "HEAD matches base abc123" },
    { probe: "P2: verify gate", passed: true, detail: JSON.stringify({ gate_passed: true }) },
    { probe: "P3: deliverables", passed: true, detail: "touches declared deliverables" },
    { probe: "P4: smoke", passed: true, detail: "all smoke entries exited 0" },
  ]);

  function deadSeatRound(overrides = {}) {
    return {
      round: 1,
      reworkScope: "full",
      implementJobId: "job-imp-1",
      reviewJobId: "job-rev-1",
      sessionID: "sess-1",
      tierBefore: 0,
      tierAfter: 0,
      reworkCount: 0,
      probesGreen: true,
      probeResults: greenProbes(),
      worktreeChanged: true,
      verdict: "partial",
      reviewParseable: true,
      reviewPartial: true,
      reviewFindingCount: 3,
      disposition: {
        disposition: "escalate",
        reason: "partial review: stream ended before the verdict line",
      },
      ...overrides,
    };
  }

  it("allows a review-position resume for an escalate caused by a dead review seat", () => {
    const record = deadSeatRound();
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({ records: [record], maxRounds: 4 }),
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.position.reviewSeatReplacement, true);
    // The resumed record is the SAME object -- the round is continued in
    // place, never duplicated.
    assert.equal(result.position.roundRecord, record);
    assert.equal(result.position.records.length, 1);
    assert.equal(result.position.reworkCount, 0);
    assert.equal(result.position.currentTierIndex, 0);
    assert.equal(result.position.session, "sess-1");
  });

  // The invariant: for every allowed resume under this feature the NEXT
  // dispatched phase is review, at the SAME round -- never implement.
  it("resolves the allowed case to the same round's review phase, never implement", () => {
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({ records: [deadSeatRound({ round: 3 })], maxRounds: 4 }),
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.position.phase, "review");
    assert.notEqual(result.position.phase, "implement");
    assert.equal(result.position.round, 3);
  });

  it("allows the unparseable seat failure on the same terms as partial", () => {
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({
        records: [deadSeatRound({
          verdict: "unparseable",
          reviewParseable: false,
          verdictSource: "recovered-from-token",
          reviewPartial: undefined,
          reviewFindingCount: undefined,
          disposition: { disposition: "escalate", reason: "unexpected verdict: unparseable" },
        })],
      }),
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.position.phase, "review");
  });

  it("refuses a needs-attention escalate -- a completed review judging the work", () => {
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({
        records: [deadSeatRound({
          verdict: "needs-attention",
          reviewPartial: undefined,
          reviewFindingCount: undefined,
          disposition: {
            disposition: "escalate",
            reason: "same file area flagged for two consecutive rounds",
          },
        })],
      }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /already finished/);
    // Today's refusal, verbatim -- no field-naming detail appended.
    assert.doesNotMatch(result.error, /—/);
  });

  it("refuses a discard-based escalate", () => {
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({
        records: [deadSeatRound({
          verdict: "discard",
          reviewPartial: undefined,
          reviewFindingCount: undefined,
          disposition: { disposition: "escalate", reason: "reviewer discarded the work" },
        })],
      }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /already finished/);
    assert.doesNotMatch(result.error, /—/);
  });

  it("refuses a max-rounds escalate even when the verdict is a seat failure", () => {
    // Budget exhausted: deriveDisposition's max-rounds terminal fires before
    // the partial branch, so the recorded reason is the max-rounds one.  The
    // seat did fail, but the escalate did not come FROM the seat failure.
    const result = resolveChainResume({
      control: { ...seatControl, round: 2 },
      chainJson: baseChainJson({
        records: [
          deadSeatRound({
            round: 1,
            verdict: "needs-attention",
            reviewPartial: undefined,
            disposition: { disposition: "rework", reason: "needs-attention" },
          }),
          deadSeatRound({
            round: 2,
            disposition: {
              disposition: "escalate",
              reason: "max rounds (2) reached without acceptance",
            },
          }),
        ],
        maxRounds: 2,
      }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /already finished/);
    assert.doesNotMatch(result.error, /—/);
  });

  it("refuses an accepted chain", () => {
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({
        records: [deadSeatRound({
          verdict: "approve",
          reviewPartial: undefined,
          reviewFindingCount: undefined,
          disposition: { disposition: "accept" },
        })],
      }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /already finished/);
    assert.doesNotMatch(result.error, /—/);
  });

  it("refuses a seat-shaped escalate whose probe results are missing, naming the field", () => {
    const record = deadSeatRound();
    delete record.probeResults;
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({ records: [record] }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /already finished/);
    assert.match(result.error, /probeResults/);
    assert.match(result.error, /P1–P4 cannot be confirmed green/);
  });

  it("refuses a seat-shaped escalate whose probe results do not cover P1–P4", () => {
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({
        records: [deadSeatRound({ probeResults: greenProbes().slice(0, 2) })],
      }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /does not cover P3, P4/);
  });

  it("refuses a seat-shaped escalate whose probes were red", () => {
    const probes = greenProbes();
    probes[1] = { probe: "P2: verify gate", passed: false, detail: "{}" };
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({
        records: [deadSeatRound({ probeResults: probes, probesGreen: false })],
      }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /not all green \(P2: verify gate\)/);
  });

  it("refuses when probesGreen disagrees with the probe entries", () => {
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({ records: [deadSeatRound({ probesGreen: undefined })] }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /probesGreen/);
  });

  it("refuses a seat-shaped escalate with no recorded disposition reason, naming the field", () => {
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({
        records: [deadSeatRound({ disposition: { disposition: "escalate" } })],
      }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /disposition\.reason/);
  });

  it("refuses a seat-failure escalate with no implement job, naming the field", () => {
    const record = deadSeatRound();
    delete record.implementJobId;
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({ records: [record] }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /implementJobId/);
  });

  it("refuses an escalate whose record carries no verdict at all, naming the field", () => {
    const record = deadSeatRound();
    delete record.verdict;
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({ records: [record] }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /`verdict`/);
  });

  it("refuses a seat verdict paired with the other seat state's reason (inconsistent)", () => {
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({
        records: [deadSeatRound({
          disposition: { disposition: "escalate", reason: "unexpected verdict: unparseable" },
        })],
      }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /inconsistent/);
  });

  it("still refuses a live chain that would otherwise be seat-eligible", () => {
    const result = resolveChainResume({
      control: { ...seatControl, pid: process.pid, status: "running" },
      chainJson: baseChainJson({ records: [deadSeatRound()] }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /still running/);
  });

  it("refuses a seat-eligible chain whose chain.json has no brief", () => {
    // The general preconditions still apply: eligibility widens WHICH chains
    // reach the position decision, not what the driver needs to run.
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({ brief: "", records: [deadSeatRound()] }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /no brief/);
  });

  it("allows a second replacement seat after an earlier one already failed", () => {
    // Each resume is an explicit operator action; a round that burned two
    // seats carries the first in reviewSeatFailures and stays eligible.
    const record = deadSeatRound({
      reviewSeatFailures: [{ seat: 1, verdict: "unparseable" }],
    });
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({ records: [record] }),
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.position.phase, "review");
  });

  it("allows seat replacement when partial disposition reason has diagnosis suffix (kusabi #312)", () => {
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({
        records: [deadSeatRound({
          disposition: {
            disposition: "escalate",
            reason: "partial review: stream ended before the verdict line (format: records present but no verdict record arrived)",
          },
        })],
      }),
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.position.phase, "review");
    assert.equal(result.position.reviewSeatReplacement, true);
  });

  it("refuses chain-resume for a quota-exhausted review seat (kusabi #373)", () => {
    const failure = {
      kind: "quota-exhaustion",
      backend: "agy",
      quota: "individual",
      backendBlocked: true,
      reset: "1h1m21s",
    };
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({
        records: [deadSeatRound({
          reviewBackend: "agy",
          backend: "agy",
          verdict: "unparseable",
          reviewParseable: false,
          reviewPartial: undefined,
          reviewFindingCount: undefined,
          reviewJobFailure: failure,
          disposition: {
            disposition: "escalate",
            reason: quotaExhaustionReason(failure),
          },
        })],
      }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /already finished/);
    assert.match(result.error, /quota exhaustion/);
    assert.match(result.error, /--backend opencode\|claude\|agy\|cursor/);
  });

  it("allows chain-resume for a quota-exhausted seat when --backend names a different route", () => {
    const failure = {
      kind: "quota-exhaustion",
      backend: "agy",
      quota: "individual",
      backendBlocked: true,
      reset: "1h1m21s",
    };
    const result = resolveChainResume({
      control: seatControl,
      chainJson: baseChainJson({
        records: [deadSeatRound({
          reviewBackend: "agy",
          backend: "agy",
          verdict: "unparseable",
          reviewParseable: false,
          reviewPartial: undefined,
          reviewFindingCount: undefined,
          reviewJobFailure: failure,
          disposition: {
            disposition: "escalate",
            reason: quotaExhaustionReason(failure),
          },
        })],
      }),
      explicitRoute: { backend: "cursor" },
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.position.phase, "review");
    assert.equal(result.position.reviewSeatReplacement, true);
  });
});

// =========================================================================
// classifyReviewSeatReplacement / archiveFailedReviewSeat (kusabi #248)
// =========================================================================

describe("classifyReviewSeatReplacement", () => {
  function seatEligibleRecord(overrides = {}) {
    return {
      round: 1,
      implementJobId: "job-imp-1",
      probesGreen: true,
      probeResults: [
        { probe: "P1: HEAD clean", passed: true },
        { probe: "P2: verify gate", passed: true },
        { probe: "P3: deliverables", passed: true },
        { probe: "P4: smoke", passed: true },
      ],
      verdict: "partial",
      disposition: {
        disposition: "escalate",
        reason: "partial review: stream ended before the verdict line",
      },
      ...overrides,
    };
  }

  it("is not a seat failure when there are no records", () => {
    const result = classifyReviewSeatReplacement({ records: [] });
    assert.equal(result.eligible, false);
    assert.equal(result.detail, null);
  });

  it("is not a seat failure for a non-terminal disposition", () => {
    const result = classifyReviewSeatReplacement({
      records: [{ round: 1, verdict: "needs-attention", disposition: { disposition: "rework" } }],
    });
    assert.equal(result.eligible, false);
    assert.equal(result.detail, null);
  });

  it("names the round field when the record cannot say which round it is", () => {
    const result = classifyReviewSeatReplacement({
      records: [{
        verdict: "partial",
        disposition: { disposition: "escalate", reason: "partial review: stream ended before the verdict line" },
      }],
    });
    assert.equal(result.eligible, false);
    assert.match(result.detail, /`round`/);
  });

  it("classifies partial with bare base reason as eligible (AC2a)", () => {
    const result = classifyReviewSeatReplacement({
      records: [seatEligibleRecord()],
    });
    assert.equal(result.eligible, true);
    assert.equal(result.detail, null);
  });

  it("classifies partial with diagnosis suffixed reason as eligible (AC2b)", () => {
    const result = classifyReviewSeatReplacement({
      records: [seatEligibleRecord({
        disposition: {
          disposition: "escalate",
          reason: "partial review: stream ended before the verdict line (format: records present but no verdict record arrived)",
        },
      })],
    });
    assert.equal(result.eligible, true);
    assert.equal(result.detail, null);
  });

  it("classifies unparseable with bare base reason as eligible", () => {
    const result = classifyReviewSeatReplacement({
      records: [seatEligibleRecord({
        verdict: "unparseable",
        disposition: {
          disposition: "escalate",
          reason: "unexpected verdict: unparseable",
        },
      })],
    });
    assert.equal(result.eligible, true);
    assert.equal(result.detail, null);
  });

  it("classifies partial paired with other base reason (bare or suffixed) as inconsistent records (AC2c)", () => {
    const bareOther = classifyReviewSeatReplacement({
      records: [seatEligibleRecord({
        verdict: "partial",
        disposition: {
          disposition: "escalate",
          reason: "unexpected verdict: unparseable",
        },
      })],
    });
    assert.equal(bareOther.eligible, false);
    assert.match(bareOther.detail, /inconsistent: verdict `partial` with `disposition\.reason` "unexpected verdict: unparseable"/);

    const suffixedOther = classifyReviewSeatReplacement({
      records: [seatEligibleRecord({
        verdict: "partial",
        disposition: {
          disposition: "escalate",
          reason: "unexpected verdict: unparseable (format: garbage)",
        },
      })],
    });
    assert.equal(suffixedOther.eligible, false);
    assert.match(suffixedOther.detail, /inconsistent: verdict `partial` with `disposition\.reason` "unexpected verdict: unparseable \(format: garbage\)"/);
  });

  it("classifies unparseable paired with partial base reason (bare or suffixed) as inconsistent records", () => {
    const barePartial = classifyReviewSeatReplacement({
      records: [seatEligibleRecord({
        verdict: "unparseable",
        disposition: {
          disposition: "escalate",
          reason: "partial review: stream ended before the verdict line",
        },
      })],
    });
    assert.equal(barePartial.eligible, false);
    assert.match(barePartial.detail, /inconsistent: verdict `unparseable` with `disposition\.reason` "partial review: stream ended before the verdict line"/);

    const suffixedPartial = classifyReviewSeatReplacement({
      records: [seatEligibleRecord({
        verdict: "unparseable",
        disposition: {
          disposition: "escalate",
          reason: "partial review: stream ended before the verdict line (format: broken)",
        },
      })],
    });
    assert.equal(suffixedPartial.eligible, false);
    assert.match(suffixedPartial.detail, /inconsistent: verdict `unparseable` with `disposition\.reason` "partial review: stream ended before the verdict line \(format: broken\)"/);
  });

  it("classifies unrelated escalate reasons as NOT_A_SEAT_FAILURE (AC2d)", () => {
    for (const reason of [
      "max rounds (3) reached without acceptance",
      "reviewer discarded the work",
      "repeated finding areas across rounds",
    ]) {
      const result = classifyReviewSeatReplacement({
        records: [seatEligibleRecord({
          verdict: "partial",
          disposition: {
            disposition: "escalate",
            reason,
          },
        })],
      });
      assert.equal(result.eligible, false);
      assert.equal(result.detail, null);
    }
  });

  it("refuses a quota-exhausted seat as not replaceable on the same route (kusabi #373)", () => {
    const failure = {
      kind: "quota-exhaustion",
      backend: "agy",
      quota: "individual",
      backendBlocked: true,
      reset: "1h1m21s",
    };
    const result = classifyReviewSeatReplacement({
      records: [seatEligibleRecord({
        reviewBackend: "agy",
        backend: "agy",
        verdict: "unparseable",
        reviewJobFailure: failure,
        reviewJobError: "agy dispatch failed: Individual quota reached. Resets in 1h1m21s.",
        disposition: {
          disposition: "escalate",
          reason: quotaExhaustionReason(failure),
        },
      })],
    });
    assert.equal(result.eligible, false);
    assert.match(result.detail, /quota exhaustion/);
    assert.match(result.detail, /--backend opencode\|claude\|agy\|cursor/);
    assert.match(result.detail, /--model/);
  });

  it("allows a quota-exhausted seat when the operator names a different backend", () => {
    const failure = {
      kind: "quota-exhaustion",
      backend: "agy",
      quota: "individual",
      backendBlocked: true,
      reset: "1h1m21s",
    };
    const record = seatEligibleRecord({
      reviewBackend: "agy",
      backend: "agy",
      verdict: "unparseable",
      reviewJobFailure: failure,
      disposition: {
        disposition: "escalate",
        reason: quotaExhaustionReason(failure),
      },
    });
    const refused = classifyReviewSeatReplacement({ records: [record] }, { explicitRoute: { backend: "agy" } });
    assert.equal(refused.eligible, false);
    const allowed = classifyReviewSeatReplacement({ records: [record] }, { explicitRoute: { backend: "cursor" } });
    assert.equal(allowed.eligible, true);
    assert.equal(allowed.detail, null);
  });

  it("allows a quota-exhausted seat when --model names a different backend", () => {
    const failure = {
      kind: "quota-exhaustion",
      backend: "agy",
      quota: "individual",
      backendBlocked: true,
      reset: "1h1m21s",
    };
    const record = seatEligibleRecord({
      reviewBackend: "agy",
      backend: "agy",
      verdict: "unparseable",
      reviewJobFailure: failure,
      disposition: {
        disposition: "escalate",
        reason: quotaExhaustionReason(failure),
      },
    });
    const allowed = classifyReviewSeatReplacement(
      { records: [record] },
      { explicitRoute: { model: "cursor/default" } },
    );
    assert.equal(allowed.eligible, true);
    assert.equal(explicitRouteDiffersFromRecord(record, { model: "cursor/default" }), true);
    assert.equal(explicitRouteDiffersFromRecord(record, { backend: "agy" }), false);
    assert.equal(recordQuotaExhaustion(record), failure);
    assert.match(quotaReplacementRefusal(failure), /--backend opencode\|claude\|agy\|cursor/);
  });
});

describe("archiveFailedReviewSeat", () => {
  function liveRecord() {
    return {
      round: 2,
      implementJobId: "job-imp-2",
      probesGreen: true,
      verdict: "partial",
      verdictSource: "recovered-from-token",
      reviewParseable: false,
      salvagedVerdict: true,
      reviewPartial: true,
      reviewFindingCount: 4,
      reviewPartialDiagnosis: "format: records present but no verdict record arrived",
      reviewJobId: "job-rev-2",
      reviewUsage: { available: true, input: 10, output: 5, cost: 0.5 },
      reviewModelEntry: "fake/model",
      reviewModelVariant: null,
      reviewFallbacks: [],
      reviewJobFailure: null,
      reviewUnparseableRetried: true,
      reviewFirstJobId: "job-rev-2a",
      reviewFirstUsage: { available: true, input: 3, output: 1, cost: 0.1 },
      reviewFirstFallbacks: [],
      findingsText: "one finding",
      findings: [{ severity: "high", title: "t", file: "a.mjs" }],
      findingFiles: ["a.mjs"],
      disposition: { disposition: "escalate", reason: "partial review: stream ended before the verdict line" },
    };
  }

  it("moves every review field onto the archived seat and clears the live ones", () => {
    const record = archiveFailedReviewSeat(liveRecord());
    assert.equal(record.reviewSeatFailures.length, 1);
    const seat = record.reviewSeatFailures[0];
    assert.equal(seat.seat, 1);
    assert.equal(seat.verdict, "partial");
    assert.equal(seat.salvagedVerdict, true);
    assert.equal(seat.reviewPartialDiagnosis, "format: records present but no verdict record arrived");
    assert.equal(seat.reviewJobId, "job-rev-2");
    assert.equal(seat.disposition.disposition, "escalate");
    assert.deepEqual(seat.findingFiles, ["a.mjs"]);
    // Conditionally-written fields must NOT survive on the live record: a
    // clean replacement verdict must not inherit "partial" or
    // "recovered-from-token" from the seat that died.
    for (const field of [
      "verdict", "verdictSource", "reviewParseable", "salvagedVerdict",
      "reviewPartial", "reviewFindingCount", "reviewPartialDiagnosis",
      "reviewJobId", "reviewUsage", "reviewModelEntry", "reviewModelVariant", "reviewFallbacks",
      "reviewJobFailure", "reviewUnparseableRetried", "reviewFirstJobId", "reviewFirstUsage",
      "reviewFirstFallbacks", "findingsText", "findings", "findingFiles", "disposition",
    ]) {
      assert.equal(Object.prototype.hasOwnProperty.call(record, field), false, `${field} survived archiving`);
    }
    // Non-review round state is untouched.
    assert.equal(record.round, 2);
    assert.equal(record.implementJobId, "job-imp-2");
    assert.equal(record.probesGreen, true);
  });

  it("appends a second seat rather than replacing the first", () => {
    const record = archiveFailedReviewSeat(liveRecord());
    record.verdict = "unparseable";
    record.reviewJobId = "job-rev-2b";
    archiveFailedReviewSeat(record);
    assert.equal(record.reviewSeatFailures.length, 2);
    assert.deepEqual(record.reviewSeatFailures.map((s) => s.seat), [1, 2]);
    assert.equal(record.reviewSeatFailures[0].verdict, "partial");
    assert.equal(record.reviewSeatFailures[1].verdict, "unparseable");
  });

  it("keeps the dead seat's spend in the chain totals", () => {
    const record = archiveFailedReviewSeat(liveRecord());
    // The replacement seat writes its own usage onto the live field.
    record.reviewUsage = { available: true, input: 100, output: 50, cost: 2 };
    const totals = computeChainTotals([record]);
    // 10 + 3 (dead seat + its retry) + 100 (replacement).
    assert.equal(totals.input, 113);
    assert.equal(totals.output, 56);
    assert.ok(Math.abs(totals.cost - 2.6) < 1e-9, `cost was ${totals.cost}`);
  });
});

// =========================================================================
// Source guards for kusabi #441
// =========================================================================

describe("chain-resume-resolve source guards (kusabi #441)", () => {
  it("chain-phases.mjs does not export moved resume-resolution functions", () => {
    const chainPhasesSrc = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "chain-phases.mjs"), "utf8");
    assert.ok(!chainPhasesSrc.includes("export function resolveChainResume("));
    assert.ok(!chainPhasesSrc.includes("export function archiveFailedReviewSeat("));
    assert.ok(!chainPhasesSrc.includes("export function classifyReviewSeatReplacement("));
  });

  it("chain-phases.mjs does not import chain-resume-resolve.mjs", () => {
    const chainPhasesSrc = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "chain-phases.mjs"), "utf8");
    assert.ok(!chainPhasesSrc.includes('from "./chain-resume-resolve.mjs"'));
    assert.ok(!chainPhasesSrc.includes("from './chain-resume-resolve.mjs'"));
  });
});
