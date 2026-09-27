// luna-smoke-finished-state.test.mjs — kusabi #588: the coordinator-facing
// Smoke rule must state BOTH halves of the contract.  The baseline half
// ("meet its expected exit on the unmodified checkout unless baseline-red")
// was the only half stated, and Luna satisfied it by asserting the
// pre-change state (counting the definitions the task deletes), which the
// worker then correctly refused as a self-contradicting brief — three times
// in two real missions.  The finished-state half pins that a Smoke line must
// also hold after the change, and that proving removal takes an absence
// check (exit 1) annotated baseline-red.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadCoordinatorSchema, renderCoordinatorContract } from "./luna-prompt.mjs";

function smokeRule() {
  return loadCoordinatorSchema().inner_brief?.properties?.smoke?.description ?? "";
}

describe("the Smoke rule states the finished-state half (kusabi #588)", () => {
  it("says every Smoke line must also meet its expected exit after the deliverables are done", () => {
    assert.match(smokeRule(), /after the deliverables are done/);
  });

  it("forbids asserting pre-change content the chain removes or changes", () => {
    assert.match(smokeRule(), /never assert what the unmodified checkout contains that the chain removes or changes/);
  });

  it("tells the coordinator a removal is proven by an exit-1 absence check annotated baseline-red", () => {
    const rule = smokeRule();
    assert.match(rule, /absence check/);
    assert.match(rule, /`exit 1`/);
    assert.match(rule, /annotate it `baseline-red`/);
  });

  it("reaches the coordinator prompt verbatim", () => {
    assert.ok(renderCoordinatorContract().includes(smokeRule()));
  });
});
