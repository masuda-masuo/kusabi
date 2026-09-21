// luna-wait.mjs — block until a named luna mission reaches a terminal state.
//
// Missions are dispatched detached (luna-detach spawns an unrefed child), so
// no completion signal exists.  This module watches mission STATE
// (control.json + mission.json under missions/<mission-id>/), exactly like
// chain-wait watches chain state:
//
//   - it waits for a NAMED mission (no --next, no recency selection — the
//     detach launcher hands the exact mission id back);
//   - it is read-only: waiting never writes, modifies or removes mission
//     state;
//   - it is a pure poll loop with no child processes and no signal handlers —
//     safe to SIGTERM at any moment, killing it leaves no state change and no
//     orphan;
//   - a terminal mission (control status terminal, OR a terminal disposition
//     in the mission record even while the control still says running — the
//     pre-finalise window) resolves with a digest;
//   - every way the WAIT itself failed throws MissionWaitError (missing
//     mission, malformed mission id, malformed records, progress timeout).
//
// The wait never touches the real Codex CLI, a real companion child, or a
// real state root.

import fs from "node:fs";
import path from "node:path";
import { readJson } from "./state-paths.mjs";
import { TERMINAL_MISSION_DISPOSITIONS } from "./mission-store.mjs";

export { TERMINAL_MISSION_DISPOSITIONS } from "./mission-store.mjs";

/** Control-record statuses that mean the mission process is done with it. */
export const TERMINAL_MISSION_STATUSES = new Set(["completed", "cancelled", "failed"]);

export const DEFAULT_POLL_INTERVAL_MS = 2_000;
// The mission directory appears early in the driver (before any container
// work), so the appear window is short: a detach child that cannot create it
// is refusing in pre-flight, not doing real work.
export const DEFAULT_APPEAR_TIMEOUT_MS = 10_000;
// Generous backstop for a mission whose process is alive but making no
// progress — the same role DEFAULT_PROGRESS_TIMEOUT_MS plays for chains.
export const DEFAULT_PROGRESS_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * Every way the wait itself failed.  `code` is the machine-readable half:
 * "usage", "no-mission-appeared", "stalled".
 */
export class MissionWaitError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "MissionWaitError";
    this.code = code;
  }
}

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Read everything a wait/show decides on, in one shot.
 *
 * @param {string} missionsDir — `<stateDir>/missions`.
 * @param {string} missionId
 * @returns {{
 *   missionId: string, missionDir: string, exists: boolean,
 *   control: object|null, record: object|null, status: string,
 *   disposition: string|null, terminal: boolean, fingerprint: string,
 * }}
 */
export function readMissionSnapshot(missionsDir, missionId) {
  const missionDir = path.join(missionsDir, missionId);
  const exists = fs.existsSync(missionDir);
  const control = exists ? readJson(path.join(missionDir, "control.json")) : null;
  const record = exists ? readJson(path.join(missionDir, "mission.json")) : null;
  const status = typeof control?.status === "string" ? control.status : "unknown";
  const disposition = typeof record?.disposition === "string" ? record.disposition : null;
  // `running` + a terminal disposition is the pre-finalise window: the driver
  // writes mission.json (with the disposition) a moment before it finalises
  // control.json, so the disposition is on disk before the status catches up.
  const terminal =
    exists &&
    (TERMINAL_MISSION_STATUSES.has(status) ||
      (disposition !== null && TERMINAL_MISSION_DISPOSITIONS.has(disposition)));
  // Any observable movement, including a rewrite that changed no field we
  // read: a mission still writing is a mission still working.
  const fingerprint = JSON.stringify([
    exists,
    status,
    disposition,
    Array.isArray(record?.attempts) ? record.attempts.length : 0,
    Array.isArray(record?.chains) ? record.chains.length : 0,
    record?.coordinatorErrors ?? 0,
    Array.isArray(record?.consults) ? record.consults.length : 0,
    mtimeOf(path.join(missionDir, "control.json")),
    mtimeOf(path.join(missionDir, "mission.json")),
  ]);
  return {
    missionId,
    missionDir,
    exists,
    control,
    record,
    status,
    disposition,
    terminal,
    fingerprint,
  };
}

/** The one-line digest a completed wait prints (and a substitution is loud in). */
export function formatMissionDigest(snapshot, { waitedMs = 0 } = {}) {
  const coord = snapshot.record?.coordinator;
  const substitution =
    coord && coord.substituted
      ? ` coordinator=${coord.provider}/${coord.model} (substituted: true, requested ${coord.requested ?? coord.model})`
      : "";
  return `mission ${snapshot.missionId}: status=${snapshot.status} ` +
    `disposition=${snapshot.disposition ?? "none"} ` +
    `attempts=${Array.isArray(snapshot.record?.attempts) ? snapshot.record.attempts.length : 0} ` +
    `chains=${Array.isArray(snapshot.record?.chains) ? snapshot.record.chains.length : 0}` +
    `${substitution} waited=${Math.round(waitedMs / 1000)}s`;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Block until a named mission reaches a terminal state.
 *
 * Resolves with `{ ...snapshot, digest }` when the mission is terminal,
 * whatever its disposition.  Throws MissionWaitError when the WAIT failed: a
 * malformed mission id (usage), no mission id at all (usage), a named mission
 * that never appeared (no-mission-appeared), or the mission stalled (stalled).
 *
 * Everything the loop cannot decide from files is injected — `sleep` and
 * `now` are the seams the tests fake.
 *
 * @param {object} opts
 * @param {string} opts.missionsDir       - `<stateDir>/missions`.
 * @param {string|null} opts.missionId    - the mission to wait on.
 * @param {number} [opts.pollIntervalMs]
 * @param {number} [opts.appearTimeoutMs] - bound on a named mission whose
 *                                          directory has not appeared yet.
 * @param {number} [opts.progressTimeoutMs]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {() => number} [opts.now]
 */
export async function waitForMission({
  missionsDir,
  missionId,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  appearTimeoutMs = DEFAULT_APPEAR_TIMEOUT_MS,
  progressTimeoutMs = DEFAULT_PROGRESS_TIMEOUT_MS,
  sleep = defaultSleep,
  now = Date.now,
} = {}) {
  const startedAt = now();

  if (!missionId) {
    throw new MissionWaitError(
      "luna-wait needs a mission id (a mission id starts with mission- and is a single path segment)",
      "usage",
    );
  }
  // Shape check BEFORE any polling: waiting on a typo is worse than the
  // error, and an id that is not mission-* or that carries a path separator
  // would escape missions/ or join onto another directory.
  if (typeof missionId !== "string" || !/^mission-[a-z0-9]+$/.test(missionId)) {
    throw new MissionWaitError(
      `invalid mission id: ${JSON.stringify(missionId)} — a mission id must match ` +
      `mission-[a-z0-9]+ and be a single path segment`,
      "usage",
    );
  }

  // The mission may not exist yet: luna-detach mints the id in the parent and
  // hands it back the instant it spawns the child, while the child creates
  // missions/<id> only after its own pre-flight.  "Not there yet" is the
  // normal shape of a wait started right after the launcher returned.
  while (!fs.existsSync(path.join(missionsDir, missionId))) {
    if (now() - startedAt >= appearTimeoutMs) {
      throw new MissionWaitError(
        `no mission appeared within ${Math.round(appearTimeoutMs / 1000)}s for mission ${missionId} ` +
        `(searched ${missionsDir}) — the launcher may still be in its pre-flight, or it ` +
        `exited without ever creating the mission`,
        "no-mission-appeared",
      );
    }
    await sleep(pollIntervalMs);
  }

  let fingerprint = null;
  let lastProgressAt = startedAt;

  for (;;) {
    const snapshot = readMissionSnapshot(missionsDir, missionId);
    if (snapshot.terminal) {
      return { ...snapshot, digest: formatMissionDigest(snapshot, { waitedMs: now() - startedAt }) };
    }

    if (snapshot.fingerprint !== fingerprint) {
      fingerprint = snapshot.fingerprint;
      lastProgressAt = now();
    }

    const staleMs = now() - lastProgressAt;
    if (staleMs >= progressTimeoutMs) {
      throw new MissionWaitError(
        `mission ${missionId} stalled: last observed status=${snapshot.status} ` +
        `disposition=${snapshot.disposition ?? "none"} — unchanged for ` +
        `${Math.round(staleMs / 1000)}s. Mission state is written at dispatch and attempt ` +
        `boundaries only, so it can no longer advance — inspect with: ` +
        `kusabi-companion luna-show ${missionId}`,
        "stalled",
      );
    }

    await sleep(pollIntervalMs);
  }
}