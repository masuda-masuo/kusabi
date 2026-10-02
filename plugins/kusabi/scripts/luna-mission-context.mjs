// Invocation-local inputs, seams and create/resume state for a Luna mission.
import fs from "node:fs";
import path from "node:path";
import { stateDirFor } from "./state-paths.mjs";
import {
  mintMissionId, assertMissionIdShape, createMission, readMissionRecord,
  saveMissionRecord, rearmMissionControl, missionStopRequested,
  TERMINAL_MISSION_DISPOSITIONS,
} from "./mission-store.mjs";
import { realSolDispatch } from "./luna-sol-gate.mjs";

export async function createMissionContext(input, defaults) {
  const {
    realCoordinatorDispatch, defaultGuardedServeStop, defaultMissionNotify,
    defaultBaseline, defaultInvestigationDispatch, resolveMissionSeat,
    DEFAULT_COORDINATOR_SEAT, DEFAULT_AUDITOR_SEAT, DEFAULT_BUDGET, capProbeOutput,
  } = defaults;
  const { cwd, missionFile, brief, container } = input;
  const inject = input.inject ?? {};
  const coordinatorDispatch =
    inject.coordinatorDispatch ??
    ((args) => realCoordinatorDispatch(args));
  const runChainLifecycle =
    inject.runChainLifecycle ??
    (await import("./chain-cmd.mjs")).runChainLifecycle;
  const callTool = inject.callTool ?? (await import("./sunaba-rpc.mjs")).callTool;
  const guardedServeStop = inject.guardedServeStop ?? defaultGuardedServeStop;
  const solDispatch = inject.solDispatch ?? realSolDispatch;
  const notifyMissionTerminal = inject.notifyMissionTerminal ?? defaultMissionNotify;
  const baselineSeam = inject.baseline ?? ((args) => defaultBaseline({ ...args, callTool }));
  const investigationDispatchSeam =
    inject.investigationDispatch ??
    ((args) => defaultInvestigationDispatch(args));

  // ---- exact seat resolution (refused BEFORE mission creation) ----
  const coordinator = resolveMissionSeat(input.coordinator, DEFAULT_COORDINATOR_SEAT, "coordinator", input.allowSubstitute);
  const auditor = resolveMissionSeat(input.auditor, DEFAULT_AUDITOR_SEAT, "auditor", input.allowSubstitute);

  // ---- mission identity (refused before any filesystem write) ----
  const missionId = input.missionId ?? mintMissionId();
  assertMissionIdShape(missionId);

  const budget = { ...DEFAULT_BUDGET, ...(input.budget ?? {}) };
  const stateDir = stateDirFor(cwd);
  const missionDir = path.join(stateDir, "missions", missionId);
  const resuming = fs.existsSync(missionDir);

  if (!resuming) {
    createMission(stateDir, {
      missionId,
      container,
      missionFile,
      pid: process.pid,
      coordinator,
      auditor,
    });
  }
  let record = readMissionRecord(missionDir);
  if (!record || typeof record !== "object") {
    throw new Error(`mission record missing or unreadable for ${missionId} (${missionDir}/mission.json)`);
  }

  if (resuming) {
    // A mission that already reached a terminal disposition has already
    // notified and must never dispatch again (luna-resume refuses terminal
    // missions; this guard covers direct driver calls).  The one exception is
    // a sol-blocked mission reopened by a recorded human override —
    // cmdLunaResume clears the terminal disposition in that case BEFORE the
    // driver runs, so a terminal disposition here means "already finished".
    if (
      typeof record.disposition === "string" &&
      TERMINAL_MISSION_DISPOSITIONS.has(record.disposition)
    ) {
      return { alreadyTerminal: (
        `mission ${missionId}: disposition=${record.disposition} ` +
        `(already terminal; nothing dispatched)`
      ) };
    }
    rearmMissionControl(missionDir);
  }

  // Persist the effective budget on the record so show/wait can explain a
  // budget-exhausted termination (the bound and the counts that hit it).
  record = { ...record, budget: { ...budget }, missionDir };
  saveMissionRecord(missionDir, record);
  // The coordinator error cap reuses the attempts budget: a coordinator that
  // cannot produce an executable stream within the mission's bounded attempts
  // budget fails closed as `coordinator-failed`.
  const coordinatorErrorCap = Math.max(1, budget.maxAttempts);

  // The next dispatch continues the persisted evidence numbering (resume):
  // envelope files are named envelope-<N>.json, so the count of existing ones
  // is the deterministic continuation point.
  const evidenceDir = path.join(missionDir, "evidence");
  const dispatchIndex = fs.existsSync(evidenceDir)
    ? fs.readdirSync(evidenceDir).filter((f) => /^envelope-\d+\.json$/.test(f)).length
    : 0;

  // The stop predicate keys off the recorded stop request (control.json
  // stopRequestedAt).  It is checked immediately before every coordinator,
  // Sol, and inner-chain dispatch and again after an inner chain returns.
  const stopRequested = () => missionStopRequested(missionDir);

  return {
    input, cwd, missionFile, brief, container, inject, coordinatorDispatch,
    runChainLifecycle, callTool, guardedServeStop, solDispatch,
    notifyMissionTerminal, baselineSeam, investigationDispatchSeam,
    coordinator, auditor, missionId, budget, stateDir, missionDir, record,
    coordinatorErrorCap, dispatchIndex, stopRequested, capProbeOutput,
    defaultBudget: DEFAULT_BUDGET,
  };
}
