// chain-substance.test.mjs — unit tests for the escalate substantive/
// no-work classifier (kusabi #165).
//
// The classifier is shared by chain-stats.mjs (chain.json `records` round
// shapes, `worktreeChanged`) and metrics-report.mjs (metrics round rows,
// `worktree_changed`); both spellings must classify identically.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyEscalate, roundWorktreeChanged, roundWorkerProducedChange } from "./chain-substance.mjs";

// ---------------------------------------------------------------------------
// roundWorktreeChanged — three-valued field reader
// ---------------------------------------------------------------------------

describe("roundWorktreeChanged", () => {
  it("reads the chain.json spelling (worktreeChanged)", () => {
    assert.equal(roundWorktreeChanged({ worktreeChanged: true }), true);
    assert.equal(roundWorktreeChanged({ worktreeChanged: false }), false);
  });

  it("reads the metrics-row spelling (worktree_changed, 1/0)", () => {
    assert.equal(roundWorktreeChanged({ worktree_changed: 1 }), true);
    assert.equal(roundWorktreeChanged({ worktree_changed: 0 }), false);
  });

  it("returns null for an absent or unmeasurable field — never 'no change'", () => {
    assert.equal(roundWorktreeChanged({}), null);
    assert.equal(roundWorktreeChanged({ worktreeChanged: null }), null);
    assert.equal(roundWorktreeChanged({ worktree_changed: null }), null);
    assert.equal(roundWorktreeChanged(undefined), null);
    assert.equal(roundWorktreeChanged(null), null);
  });
});

// ---------------------------------------------------------------------------
// classifyEscalate
// ---------------------------------------------------------------------------

describe("classifyEscalate", () => {
  it("infra death with no rounds at all → no-work (nothing was ever produced)", () => {
    assert.equal(classifyEscalate([]), "no-work");
    assert.equal(classifyEscalate(undefined), "no-work");
    assert.equal(classifyEscalate(null), "no-work");
  });

  it("infra death: rounds with changed=NO and ~0 output → no-work", () => {
    const rounds = [
      {
        round: 1,
        worktreeChanged: false,
        implementUsage: { available: true, input: 12, output: 0, cost: 0 },
      },
    ];
    assert.equal(classifyEscalate(rounds), "no-work");
  });

  it("722-token zero-change shape: big output but every round measured no change → no-work", () => {
    // The WSL 2026-08-04 incident: the implement round produced 722 output
    // tokens and zero changes.  Output tokens must NOT make it substantive —
    // the `changed` signal is the backbone, token counts are not a criterion.
    const rounds = [
      {
        round: 1,
        worktreeChanged: false,
        implementUsage: { available: true, input: 4000, output: 722, cost: 0.0004 },
        verdict: "needs-attention",
      },
    ];
    assert.equal(classifyEscalate(rounds), "no-work");
  });

  it("substantive escalate: a round that changed the worktree, later rejected → substantive", () => {
    // Round 1 changed the worktree; round 2 measured no further change and
    // the chain escalated.  The worker DID produce a change set — the
    // rejection does not undo that.
    const rounds = [
      { round: 1, worktreeChanged: true, verdict: "needs-attention" },
      { round: 2, worktreeChanged: false, verdict: "needs-attention" },
    ];
    assert.equal(classifyEscalate(rounds), "substantive");
  });

  it("a later changed round after earlier no-change rounds → substantive", () => {
    const rounds = [
      { round: 1, worktreeChanged: false },
      { round: 2, worktreeChanged: true },
    ];
    assert.equal(classifyEscalate(rounds), "substantive");
  });

  it("rounds exist but the field is absent (old records) → unknown, never no-work", () => {
    // Pre-#165 chain.json records carry no worktreeChanged at all.
    const rounds = [
      { round: 1, verdict: "needs-attention", implementUsage: { available: true, output: 0 } },
    ];
    assert.equal(classifyEscalate(rounds), "unknown");
  });

  it("mixed measured-no-change and unmeasured rounds → unknown, never no-work", () => {
    const rounds = [
      { round: 1, worktreeChanged: false },
      { round: 2 }, // died before probes — never measured
    ];
    assert.equal(classifyEscalate(rounds), "unknown");
  });

  it("all rounds measured no change → no-work even when the chain has several rounds", () => {
    const rounds = [
      { round: 1, worktree_changed: 0 },
      { round: 2, worktree_changed: 0 },
      { round: 3, worktree_changed: 0 },
    ];
    assert.equal(classifyEscalate(rounds), "no-work");
  });

  it("metrics-row spelling classifies identically to the chain.json spelling", () => {
    assert.equal(
      classifyEscalate([{ round: 1, worktree_changed: 1 }]),
      classifyEscalate([{ round: 1, worktreeChanged: true }]),
    );
    assert.equal(
      classifyEscalate([{ round: 1, worktree_changed: 0 }]),
      classifyEscalate([{ round: 1, worktreeChanged: false }]),
    );
  });

  it("is disposition-agnostic — the label never reads the disposition field", () => {
    // The classifier must never be able to change a disposition decision;
    // it is only CALLED on escalated chains by the reporting surfaces.  A
    // chain whose rounds carry an accept disposition but a changed round
    // still classifies by the changed signal alone.
    const rounds = [
      { round: 1, worktreeChanged: true, disposition: { disposition: "accept" } },
    ];
    assert.equal(classifyEscalate(rounds), "substantive");
  });

  it("kusabi #380 — a record WITHOUT stopReason keeps the worktreeChanged heuristic", () => {
    // Legacy records (all history before the stop-reason field) must produce
    // byte-identical classification to before the feature.
    assert.equal(classifyEscalate([{ round: 1, worktreeChanged: true }]), "substantive");
    assert.equal(classifyEscalate([{ round: 1, worktreeChanged: false }]), "no-work");
    assert.equal(classifyEscalate([{ round: 1 }]), "unknown");
  });

  it("kusabi #380 — a closed stopReason overrides worktreeChanged for the split", () => {
    // Every non-completed reason fails closed into no-work.
    assert.equal(classifyEscalate([{ round: 1, stopReason: "infra-death" }]), "no-work");
    assert.equal(classifyEscalate([{ round: 1, stopReason: "empty-completion" }]), "no-work");
    assert.equal(classifyEscalate([{ round: 1, stopReason: "provider-error" }]), "no-work");
    assert.equal(classifyEscalate([{ round: 1, stopReason: "quota-exhausted" }]), "no-work");
    assert.equal(classifyEscalate([{ round: 1, stopReason: "cancelled" }]), "no-work");
  });

  it("kusabi #380 — unknown stopReason fails closed (never substantive)", () => {
    assert.equal(classifyEscalate([{ round: 1, stopReason: "unknown" }]), "no-work");
    // A future/unforeseen value is not in the closed set and not 'unknown'.
    assert.equal(classifyEscalate([{ round: 1, stopReason: "some-future-status" }]), "no-work");
  });

  it("kusabi #380 — completed defers to the measured substance signal", () => {
    assert.equal(classifyEscalate([{ round: 1, stopReason: "completed", worktreeChanged: true }]), "substantive");
    assert.equal(classifyEscalate([{ round: 1, stopReason: "completed", worktreeChanged: false }]), "no-work");
    // unmeasured at round level → unknown, not no-work, so it is never
    // silently read as substantive.
    assert.equal(classifyEscalate([{ round: 1, stopReason: "completed" }]), "unknown");
  });

  it("kusabi #380 — roundWorkerProducedChange returns the three-valued verdict", () => {
    assert.equal(roundWorkerProducedChange({ stopReason: "completed", worktreeChanged: true }), true);
    assert.equal(roundWorkerProducedChange({ stopReason: "completed", worktreeChanged: false }), false);
    assert.equal(roundWorkerProducedChange({ stopReason: "provider-error" }), false);
    assert.equal(roundWorkerProducedChange({ worktreeChanged: true }), true);
    assert.equal(roundWorkerProducedChange({}), null);
  });
});
