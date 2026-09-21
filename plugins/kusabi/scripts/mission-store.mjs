// mission-store.mjs — kusabi #530: the mission state store.
//
// A luna mission is a separate, opt-in dispatch surface: the gpt-5.6-luna
// coordinator proposes bounded actions, and a deterministic driver validates
// and executes them (luna-driver.mjs).  This module owns where that mission
// state lives and how it is written:
//
//   - mission state lives under the kusabi state root in
//     `missions/<mission-id>/` (control.json + mission.json + evidence/
//     attempt artifacts + recommendation.md), never anywhere else;
//   - mission ids are validated path segments (`mission-[a-z0-9]+`) BEFORE any
//     filesystem access — the same boundary assertChainIdShape enforces for
//     chain ids;
//   - every write is atomic (the shared atomic-replace helper in
//     state-paths.mjs: a saved record is immediately readable as complete
//     JSON and leaves no temp-file residue behind);
//   - terminal disposition is sticky: once a mission record carries a
//     terminal disposition it can never be overwritten with a different one.
//
// The record carries attempts, bounded inner-chain references, coordinator
// errors, probe results, consult requests, exact seat provenance,
// recommendation and terminal disposition.  Nothing here ever accepts,
// publishes or merges — the mission's terminal result is a host-facing
// recommendation.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "./state-paths.mjs";

/**
 * The host-facing terminal dispositions of kusabi #530/#531.
 *
 * #530 values: `recommend-accept`, `recommend-escalate`, `coordinator-failed`
 * and `budget-exhausted` are the required values; `host-handoff` is the
 * narrowly justified additional terminal value for the `escalate_to_host`
 * action (a host handoff is not a recommendation — it hands the request to
 * a human).
 *
 * #531 values: `sol-blocked` (an uncleared mandatory Sol gate — the audit
 * veto is terminal and only a recorded human override can reopen the
 * mission) and `cancelled` (a stop request was honored — no seat is ever
 * dispatched after stopRequestedAt).  Both are terminal for show/wait
 * surfaces through this set.
 */
export const TERMINAL_MISSION_DISPOSITIONS = new Set([
  "recommend-accept",
  "recommend-escalate",
  "coordinator-failed",
  "budget-exhausted",
  "host-handoff",
  "sol-blocked",
  "cancelled",
]);

/**
 * Mint a fresh mission id in the shape the mission directories use.
 *
 * The id becomes a path segment under `missions/`, so it is restricted to
 * lowercase letters and digits (the same shape assertMissionIdShape accepts).
 */
export function mintMissionId() {
  return `mission-${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Validate an externally supplied mission id against the shape mintMissionId
 * produces.
 *
 * This is a security boundary, not a tidiness check: the id becomes a path
 * segment under `missions/`, so a value containing `/`, `..` or a NUL must
 * never reach path.join.  The shape check rejects all of them by
 * construction — only lowercase letters and digits may follow `mission-`.
 *
 * @param {string} missionId
 * @throws {Error} when the id does not match the generator's shape.
 */
export function assertMissionIdShape(missionId) {
  if (typeof missionId !== "string" || !/^mission-[a-z0-9]+$/.test(missionId)) {
    throw new Error(
      `invalid mission id: "${String(missionId)}" — a mission id must match ` +
      `mission-[a-z0-9]+ (it becomes a path segment under missions/, so /, .. and ` +
      `other separators are refused)`,
    );
  }
}

/** @returns {string} the control-record path of a mission directory. */
export function missionControlFilePath(missionDir) {
  return path.join(missionDir, "control.json");
}

/** @returns {string} the mission-record path of a mission directory. */
export function missionRecordFilePath(missionDir) {
  return path.join(missionDir, "mission.json");
}

/** Read the control record of a mission (null when absent/unreadable). */
export function readMissionControl(missionDir) {
  return readJson(missionControlFilePath(missionDir));
}

/** Read the mission record of a mission (null when absent/unreadable). */
export function readMissionRecord(missionDir) {
  return readJson(missionRecordFilePath(missionDir));
}

/**
 * Write a control record atomically.  The caller supplies the full record —
 * this function does not merge.
 *
 * @param {string} missionDir
 * @param {object} control
 */
export function writeMissionControl(missionDir, control) {
  writeJson(missionControlFilePath(missionDir), control);
}

/**
 * Finalise a mission control record on a terminal path.  Idempotent: a
 * missing control record is left alone.
 *
 * @param {string} missionDir
 * @param {string} status — "completed" (this slice's only terminal status).
 * @returns {object|null} the finalised control record, or null.
 */
export function finalizeMissionControl(missionDir, status) {
  const existing = readMissionControl(missionDir);
  if (!existing) return null;
  const next = { ...existing, status, finishedAt: new Date().toISOString() };
  writeMissionControl(missionDir, next);
  return next;
}
/**
 * The file-based stop predicate for a mission (kusabi #531): true once a stop
 * request has been recorded on the control record.  `luna-cancel` writes it;
 * the driver checks it immediately before every coordinator, Sol, and
 * inner-chain dispatch and again after an inner chain returns.
 *
 * @param {string} missionDir
 * @returns {boolean}
 */
export function missionStopRequested(missionDir) {
  const control = readMissionControl(missionDir);
  return !!(control && control.stopRequestedAt);
}

/**
 * Re-arm a mission control record for a resumed run (kusabi #531): sets
 * status back to "running" with the current process pid and records resumedAt
 * as the recovery trace.  A recorded stop request is deliberately PRESERVED:
 * a stop is never silently forgotten, and missionStopRequested keys off
 * stopRequestedAt so a stale stop still cancels the resumed run (luna-resume
 * settles stop-requested missions to cancelled before the driver is invoked).
 * Idempotent: re-arming an already-running control merely refreshes
 * pid/resumedAt.
 *
 * @param {string} missionDir
 * @returns {object|null} the new control record, or null.
 */
export function rearmMissionControl(missionDir) {
  const existing = readMissionControl(missionDir);
  if (!existing) return null;
  // A recorded stop request is NEVER silently forgotten: luna-resume settles a
  // stop-requested mission to cancelled before the driver runs, and the
  // driver's own stop predicate keys off stopRequestedAt - so a stale stop
  // still cancels rather than resurrecting a mission against its stop.
  const next = {
    ...existing,
    status: "running",
    pid: process.pid,
    finishedAt: undefined,
    resumedAt: new Date().toISOString(),
  };
  writeMissionControl(missionDir, next);
  return next;
}

/**
 * The sanctioned human-override exception to terminal-disposition stickiness
 * (kusabi #531): after a matching human audit override is recorded on a
 * sol-blocked mission, the terminal block is cleared so `luna-resume` can
 * hand the mission back to the driver.  The caller passes the FULL next
 * record (the override already appended, the blocking gate marked
 * overridden, disposition null, status running); this writes it verbatim
 * (bypassing the sticky guard - the override is the one case where a
 * terminal disposition is legitimately reopened) and re-arms the control.
 *
 * Refuses to clear a mission whose disposition is not `sol-blocked` - an
 * override must never reopen a recommendation the host already received.
 *
 * @param {string} missionDir
 * @param {object} nextRecord - the full next mission record.
 * @returns {object} the written record.
 * @throws {Error} when the existing disposition is not sol-blocked.
 */
export function clearMissionBlockForOverride(missionDir, nextRecord) {
  const existing = readMissionRecord(missionDir);
  if (existing && typeof existing.disposition === "string" && existing.disposition !== "sol-blocked") {
    throw new Error(
      `refusing to clear mission block: mission ${existing.missionId ?? path.basename(missionDir)} ` +
      `has disposition ${existing.disposition}, not sol-blocked - only a sol-blocked mission ` +
      `can be reopened by a human audit override`,
    );
  }
  writeJson(missionRecordFilePath(missionDir), nextRecord);
  rearmMissionControl(missionDir);
  return nextRecord;
}


/**
 * Create a mission directory and its two records (control.json + mission.json).
 *
 * A supplied missionId is validated against the minted shape and refused when
 * its directory already exists — two missions sharing a directory would
 * interleave records.  The refusal happens BEFORE any filesystem write for an
 * invalid id (assertMissionIdShape runs first); a taken id is refused by a
 * non-recursive mkdir that throws EEXIST (the same atomic-claim pattern
 * createChainDir uses).
 *
 * @param {string} stateDir — the per-workspace kusabi state directory.
 * @param {object} input
 * @param {string} input.missionId
 * @param {string} input.container
 * @param {string} [input.missionFile]
 * @param {number} [input.pid]
 * @param {object} input.coordinator — {provider, model, substituted}
 * @param {object} input.auditor — {provider, model, substituted}
 * @returns {{ missionId: string, missionDir: string }}
 */
export function createMission(stateDir, { missionId, container, missionFile, pid, coordinator, auditor }) {
  assertMissionIdShape(missionId);
  const missionDir = path.join(stateDir, "missions", missionId);
  const takenMessage = () =>
    `mission id already exists: ${missionId} — two missions sharing a directory would ` +
    `interleave mission records. Pick a fresh --mission-id.`;
  if (fs.existsSync(missionDir)) throw new Error(takenMessage());
  fs.mkdirSync(path.join(stateDir, "missions"), { recursive: true });
  try {
    fs.mkdirSync(missionDir);
  } catch (err) {
    if (err?.code === "EEXIST") throw new Error(takenMessage());
    throw err;
  }
  const now = new Date().toISOString();
  writeMissionControl(missionDir, {
    missionId,
    container,
    pid,
    status: "running",
    startedAt: now,
  });
  writeJson(missionRecordFilePath(missionDir), {
    missionId,
    container,
    missionFile: missionFile ?? null,
    pid,
    status: "running",
    // Exact seat provenance: requested is the seat that was requested (the
    // default seat), actual is the seat the mission actually ran, and
    // substituted tells the two apart loudly.  The resolved seat object may
    // already carry distinct requested/actual values (a substitution); those
    // are preserved verbatim, and each defaults to the model only when the
    // resolved seat omitted it.
    coordinator: {
      ...coordinator,
      requested: coordinator?.requested ?? coordinator?.model ?? null,
      actual: coordinator?.actual ?? coordinator?.model ?? null,
    },
    auditor: {
      ...auditor,
      requested: auditor?.requested ?? auditor?.model ?? null,
      actual: auditor?.actual ?? auditor?.model ?? null,
    },
    attempts: [],
    chains: [],
    coordinatorErrors: 0,
    consults: [],
    probes: [],
    recommendation: null,
    disposition: null,
    startedAt: now,
  });
  return { missionId, missionDir };
}

/**
 * Save a mission record atomically.
 *
 * Terminal disposition is sticky: once the on-disk record carries a terminal
 * disposition, a save that would overwrite it with a DIFFERENT disposition is
 * refused (the terminal result is the single source of truth for the host).
 * Re-saving the SAME terminal disposition (idempotent finalisation) stays
 * allowed.
 *
 * @param {string} missionDir
 * @param {object} record — the full mission record (never merged).
 * @throws {Error} when the save would change a terminal disposition.
 */
export function saveMissionRecord(missionDir, record) {
  const existing = readMissionRecord(missionDir);
  if (
    existing &&
    typeof existing.disposition === "string" &&
    TERMINAL_MISSION_DISPOSITIONS.has(existing.disposition) &&
    record.disposition !== existing.disposition
  ) {
    throw new Error(
      `terminal disposition is sticky: mission ${existing.missionId ?? path.basename(missionDir)} ` +
      `already reached ${existing.disposition}; refusing to overwrite it with ` +
      `${record.disposition ?? "a non-terminal record"}`,
    );
  }
  writeJson(missionRecordFilePath(missionDir), record);
}