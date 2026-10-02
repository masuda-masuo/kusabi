// The existing gate adapter; policy remains in luna-sol-gate.
import { evaluateMissionGate } from "./luna-sol-gate.mjs";
import { recordGates } from "./luna-mission-ledger.mjs";

/**
 * The single gate-evaluation helper: runs evaluateMissionGate, persists the
 * gate records, and returns the outcome.  A "cancelled" outcome means a
 * stop request landed before the Sol dispatch.
 */
export async function runGate(ctx, { phase, reason }) {
  const { cwd, missionId, missionDir, brief, container, auditor, input,
    solDispatch, stopRequested, budget, defaultBudget } = ctx;
  const result = await evaluateMissionGate({
    cwd,
    missionId,
    missionDir,
    brief,
    container,
    auditor,
    allowSubstitute: input.allowSubstitute,
    sampling: input.sampling,
    phase,
    reason: reason ?? null,
    record: ctx.record,
    solDispatch,
    stopRequested,
    maxRework: budget.maxRework ?? defaultBudget.maxRework,
  });
  if (result.fired) recordGates(ctx, result.gates);
  return result;
}

