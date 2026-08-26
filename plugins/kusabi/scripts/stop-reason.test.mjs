// stop-reason.test.mjs — unit tests for the closed terminal-reason union (#380).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STOP_REASONS,
  UNKNOWN_STOP_REASON,
  deriveStopReason,
} from "./stop-reason.mjs";

test("STOP_REASONS is frozen and has exactly the 6 values", () => {
  assert.deepEqual(
    [...STOP_REASONS].sort(),
    [
      "cancelled",
      "completed",
      "empty-completion",
      "infra-death",
      "provider-error",
      "quota-exhausted",
    ].sort(),
  );
  assert.equal(STOP_REASONS.length, 6);
  assert.throws(() => {
    // Object.freeze makes the array read-only.
    STOP_REASONS.push("tampered");
  });
});

test("UNKNOWN_STOP_REASON is not a member of STOP_REASONS", () => {
  assert.equal(UNKNOWN_STOP_REASON, "unknown");
  assert.ok(!STOP_REASONS.includes(UNKNOWN_STOP_REASON));
});

test("completed when worktreeChanged is true", () => {
  assert.equal(
    deriveStopReason({ status: "completed", worktreeChanged: true, stats: { steps: 3 } }),
    "completed",
  );
});

test("completed when substance is unmeasured (worktreeChanged null)", () => {
  assert.equal(
    deriveStopReason({ status: "completed", worktreeChanged: null, stats: { steps: 0 } }),
    "completed",
  );
  assert.equal(
    deriveStopReason({ status: "completed" }),
    "completed",
  );
});

test("provider-error from a terminal providerError object", () => {
  assert.equal(
    deriveStopReason({
      status: "completed", // status would not be completed in practice, but providerError.terminal must win
      providerError: { reason: "http-403", terminal: true },
    }),
    "provider-error",
  );
  // the realistic case: status is provider-error
  assert.equal(
    deriveStopReason({ status: "provider-error", providerError: { terminal: true } }),
    "provider-error",
  );
});

test("provider-error from status only (non-terminal providerError)", () => {
  assert.equal(
    deriveStopReason({ status: "provider-error", providerError: { terminal: false } }),
    "provider-error",
  );
});

test("quota-exhausted when capacityReason set, wins over terminal providerError", () => {
  assert.equal(
    deriveStopReason({
      capacityReason: "free_tier_limit",
      providerError: { reason: "free_tier_limit", terminal: true },
      status: "provider-error",
    }),
    "quota-exhausted",
  );
});

test("empty-completion: completed, worktreeChanged false, steps > 0", () => {
  assert.equal(
    deriveStopReason({ status: "completed", worktreeChanged: false, stats: { steps: 4 } }),
    "empty-completion",
  );
});

test("infra-death: completed, worktreeChanged false, steps 0", () => {
  assert.equal(
    deriveStopReason({ status: "completed", worktreeChanged: false, stats: { steps: 0 } }),
    "infra-death",
  );
});

test("cancelled via flag", () => {
  assert.equal(
    deriveStopReason({ cancelled: true, status: "completed" }),
    "cancelled",
  );
});

test("cancelled via status", () => {
  assert.equal(
    deriveStopReason({ status: "cancelled" }),
    "cancelled",
  );
});

test("unknown for unmappable statuses", () => {
  assert.equal(deriveStopReason({ status: "error" }), "unknown");
  assert.equal(deriveStopReason({ status: "serve-dead" }), "unknown");
  assert.equal(deriveStopReason({ status: "timeout" }), "unknown");
  assert.equal(deriveStopReason({ status: "stalled" }), "unknown");
});

test("unknown for an empty input object", () => {
  assert.equal(deriveStopReason({}), "unknown");
  assert.equal(deriveStopReason(), "unknown");
});

test("never returns completed for capacity fail-fast", () => {
  assert.notEqual(
    deriveStopReason({ capacityReason: "free_tier_limit" }),
    "completed",
  );
});

test("never returns completed for a terminal provider error", () => {
  assert.notEqual(
    deriveStopReason({ providerError: { terminal: true } }),
    "completed",
  );
});

test("never returns completed for cancellation", () => {
  assert.notEqual(
    deriveStopReason({ cancelled: true }),
    "completed",
  );
});

test("never returns completed for an unmappable input", () => {
  assert.notEqual(
    deriveStopReason({ status: "error" }),
    "completed",
  );
});
