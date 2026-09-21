// luna-cmd.mjs — kusabi #530: the luna mission CLI surfaces.
//
// Four adapters on top of the mission machinery:
//
//   cmdLuna        — run a luna mission in the foreground (the driver runs
//                    the gpt-5.6-luna coordinator and executes its bounded
//                    requests deterministically).
//   cmdLunaDetach  — launch a luna mission in a detached background process
//                    and print the exact `kusabi-companion luna-wait
//                    <mission-id>` command line.  No LLM runs in the
//                    launcher; the mission id is minted HERE so the wait line
//                    can name the mission before the child created it.
//   cmdLunaWait    — block until a NAMED mission reaches a terminal state
//                    (read-only, no LLM, no serve, SIGTERM-safe).
//   cmdLunaShow    — render a read-only digest of a mission: exact seat
//                    provenance/substitution, attempts and inner chain ids,
//                    errors/consults, state and recommendation.
//
// Both creating commands require `--container <cid>` and
// `--mission-file <path>`.  The seats default to the exact codex/gpt-5.6-luna
// coordinator and codex/gpt-5.6-sol auditor; any substitution is refused
// BEFORE mission creation unless `--allow-substitute` explicitly authorizes
// it, and authorized substitution is loud in the records and rendered output.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { stateDirFor } from "./state-paths.mjs";
import { mintMissionId, assertMissionIdShape } from "./mission-store.mjs";
import {
  waitForMission,
  readMissionSnapshot,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_APPEAR_TIMEOUT_MS,
  DEFAULT_PROGRESS_TIMEOUT_MS,
} from "./luna-wait.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPANION_SCRIPT = path.join(HERE, "kusabi-companion.mjs");

/** The exact default seats of #530. */
export const DEFAULT_COORDINATOR_SEAT = { provider: "codex", model: "gpt-5.6-luna" };
export const DEFAULT_AUDITOR_SEAT = { provider: "codex", model: "gpt-5.6-sol" };

/**
 * Read the mission brief file.  A missing or unreadable file refuses before
 * the driver (or the detach child) exists.
 *
 * @param {string} missionFile
 * @returns {string}
 * @throws {Error} when the file cannot be read.
 */
export function readMissionFile(missionFile) {
  let text;
  try {
    text = fs.readFileSync(missionFile, "utf8");
  } catch (err) {
    throw new Error(
      `mission file not found or unreadable: ${missionFile} (${err.message ?? String(err)})`,
    );
  }
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(`mission file is empty: ${missionFile}`);
  }
  return trimmed;
}

/**
 * Resolve the coordinator/auditor seats from the mission flags.
 *
 * `--coordinator-model <provider/model>` and `--auditor-model <provider/model>`
 * select the seats (defaults: codex/gpt-5.6-luna and codex/gpt-5.6-sol).  A
 * non-codex provider is refused outright; any model substitution is refused
 * unless `--allow-substitute` authorizes it.
 *
 * @param {object} flags — parsed CLI flags.
 * @returns {{ coordinator: {provider: string, model: string, substituted: boolean},
 *             auditor: {provider: string, model: string, substituted: boolean},
 *             allowSubstitute: boolean }}
 */
export function resolveMissionSeats(flags) {
  const allowSubstitute = flags.allowSubstitute === true;
  const coordinator = resolveSeat(flags["coordinator-model"], DEFAULT_COORDINATOR_SEAT, "coordinator", allowSubstitute);
  const auditor = resolveSeat(flags["auditor-model"], DEFAULT_AUDITOR_SEAT, "auditor", allowSubstitute);
  return { coordinator, auditor, allowSubstitute };
}

function resolveSeat(flagValue, def, role, allowSubstitute) {
  let provider = def.provider;
  let model = def.model;
  if (flagValue) {
    const idx = flagValue.indexOf("/");
    if (idx < 0) {
      throw new Error(`--${role}-model expects provider/model, got: ${flagValue}`);
    }
    provider = flagValue.slice(0, idx);
    model = flagValue.slice(idx + 1);
  }
  if (provider !== "codex") {
    throw new Error(
      `luna requires the codex backend for the ${role} seat; got provider "${provider}" — ` +
      `the luna mode never leaves the codex seats`,
    );
  }
  const substituted = model !== def.model;
  if (substituted && !allowSubstitute) {
    throw new Error(
      `${role} seat substitution refused: requested model "${model}" is not the exact seat ` +
      `${def.model}. Pass --allow-substitute to authorize it explicitly — substitution is ` +
      `loud in mission records and output.`,
    );
  }
  return { provider, model, substituted };
}

/**
 * cmdLuna — run a luna mission in the foreground.
 *
 * @param {string} cwd
 * @param {object} input — { flags, text }.
 * @param {object} [opts]
 * @param {object} [opts.inject]
 * @param {Function} [opts.inject.runLunaMission] — test-only driver seam.
 * @returns {Promise<string>} the driver's terminal summary.
 */
export async function cmdLuna(cwd, { flags }, opts = {}) {
  const container = flags.container;
  if (!container) throw new Error("luna requires --container <cid>");
  const missionFile = flags["mission-file"];
  if (!missionFile) throw new Error("luna requires --mission-file <path>");
  const brief = readMissionFile(missionFile);
  const { coordinator, auditor, allowSubstitute } = resolveMissionSeats(flags);
  const runLunaMission =
    opts.inject?.runLunaMission ?? (await import("./luna-driver.mjs")).runLunaMission;
  const missionId = flags["mission-id"] ?? null;
  return runLunaMission({
    cwd,
    missionFile,
    brief,
    container,
    coordinator,
    auditor,
    allowSubstitute,
    ...(missionId ? { missionId } : {}),
  });
}

/**
 * cmdLunaDetach — launch a luna mission in a detached background process and
 * print the exact `kusabi-companion luna-wait <mission-id>` command line.
 *
 * Every pre-flight refusal (missing flags, unreadable mission file, seat
 * substitution, taken mission id) happens BEFORE anything is spawned — a
 * refused dispatch never prints a wait line for a mission that will not
 * exist.
 *
 * @param {string} cwd
 * @param {object} input — { flags, text }.
 * @param {object} [opts]
 * @param {Function} [opts.spawn] — test-only spawn seam.
 * @param {Function} [opts.mintMissionId] — test-only id mint.
 * @param {string} [opts.stateRoot] — state root override.
 * @returns {Promise<string>} the launch banner.
 */
export async function cmdLunaDetach(cwd, { flags }, opts = {}) {
  const container = flags.container;
  if (!container) throw new Error("luna requires --container <cid>");
  const missionFile = flags["mission-file"];
  if (!missionFile) throw new Error("luna requires --mission-file <path>");
  // Pre-flight validations that must refuse BEFORE anything is spawned: an
  // unreadable mission file and an unauthorized/non-codex seat.
  readMissionFile(missionFile);
  resolveMissionSeats(flags);

  const stateDir = stateDirFor(cwd);

  // The mission id is minted in the parent (or supplied + validated) so the
  // wait line can name the mission before the child created it.  An id whose
  // missions/<id> directory already exists would be refused by the child's
  // createMission — refuse here with the same failure so no wait line latches
  // onto a pre-existing mission.
  const missionId = flags["mission-id"] ?? (opts.mintMissionId ? opts.mintMissionId() : mintMissionId());
  assertMissionIdShape(missionId);
  if (fs.existsSync(path.join(stateDir, "missions", missionId))) {
    throw new Error(`mission id already exists: ${missionId} — pick a fresh --mission-id`);
  }

  fs.mkdirSync(stateDir, { recursive: true });
  const logFile = path.join(stateDir, `luna-detach-${Date.now()}.log`);
  const logFd = fs.openSync(logFile, "a");

  const args = [
    COMPANION_SCRIPT,
    "luna",
    "--container", container,
    "--mission-file", missionFile,
    "--mission-id", missionId,
  ];
  // Forward exactly the explicitly supplied seat/substitution flags so the
  // child runs what the parent validated — defaults need not be redundantly
  // forwarded (the child applies them itself).
  if (flags["coordinator-model"] !== undefined) {
    args.push("--coordinator-model", flags["coordinator-model"]);
  }
  if (flags["auditor-model"] !== undefined) {
    args.push("--auditor-model", flags["auditor-model"]);
  }
  if (flags.allowSubstitute === true) {
    args.push("--allow-substitute");
  }
  const child = (opts.spawn || spawn)(process.execPath, args, {
    cwd,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
  });
  if (child.unref) child.unref();
  fs.closeSync(logFd);

  const lines = [
    `Detached luna mission launched (pid ${child.pid ?? "unknown"}).`,
    `Log: ${logFile}`,
    "",
    "To wait for completion, run:",
    `  kusabi-companion luna-wait ${missionId}`,
  ];
  return lines.join("\n");
}

/**
 * Read a flag holding a duration in seconds and return it in milliseconds.
 * A malformed value is refused rather than silently falling back to the
 * default.
 */
function waitDurationFlag(flags, name, fallbackMs) {
  const raw = flags[name];
  if (raw === undefined) return fallbackMs;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`--${name} expects a positive number of seconds, got: ${raw}`);
  }
  return seconds * 1000;
}

/**
 * cmdLunaWait — block until a NAMED mission reaches a terminal state.
 *
 * Read-only, no LLM, no serve, no child processes: a pure poll loop that is
 * safe to SIGTERM at any moment.  Every way the WAIT itself failed throws
 * (missing mission, malformed id, malformed records, stall) and main()'s
 * catch turns that into a non-zero exit.
 *
 * @param {string} cwd
 * @param {object} input — { flags, text }.
 * @returns {Promise<string>} the one-line mission digest.
 */
export function cmdLunaWait(cwd, { flags, text }) {
  const missionId = (text ?? "").trim() || null;
  if (!missionId) {
    throw new Error("luna-wait requires a mission id. Usage: luna-wait <missionId>");
  }
  const stateDir = stateDirFor(cwd);
  const missionsDir = path.join(stateDir, "missions");
  return waitForMission({
    missionsDir,
    missionId,
    pollIntervalMs: waitDurationFlag(flags, "poll-interval", DEFAULT_POLL_INTERVAL_MS),
    appearTimeoutMs: waitDurationFlag(flags, "appear-timeout", DEFAULT_APPEAR_TIMEOUT_MS),
    progressTimeoutMs: waitDurationFlag(flags, "progress-timeout", DEFAULT_PROGRESS_TIMEOUT_MS),
  }).then((outcome) => outcome.digest);
}

/**
 * Render a read-only mission digest: exact seat provenance/substitution,
 * attempts and inner chain ids, errors/consults, state and recommendation.
 *
 * @param {object} snapshot — readMissionSnapshot result.
 * @returns {string}
 */
export function renderMissionShow(snapshot) {
  const record = snapshot.record ?? {};
  const coordinator = record.coordinator ?? {};
  const auditor = record.auditor ?? {};
  const lines = [];
  lines.push(`Mission: ${snapshot.missionId}`);
  lines.push(`Status: ${snapshot.status}`);
  if (record.disposition) lines.push(`Disposition: ${record.disposition}`);
  if (record.recommendation) lines.push(`Recommendation: ${record.recommendation}`);
  const coordSeat = `${coordinator.provider ?? "?"}/${coordinator.model ?? "?"}`;
  lines.push(
    `Coordinator seat: ${coordSeat}` +
    (coordinator.substituted
      ? ` (substituted: true, requested ${coordinator.requested ?? coordinator.model})`
      : " (substituted: false)"),
  );
  const audSeat = `${auditor.provider ?? "?"}/${auditor.model ?? "?"}`;
  lines.push(
    `Auditor seat: ${audSeat}` +
    (auditor.substituted
      ? ` (substituted: true, requested ${auditor.requested ?? auditor.model})`
      : " (substituted: false)"),
  );
  lines.push(
    `Inner chains: ${Array.isArray(record.chains) && record.chains.length > 0 ? record.chains.join(", ") : "(none)"}`,
  );
  lines.push(`Attempts: ${Array.isArray(record.attempts) ? record.attempts.length : 0}`);
  lines.push(`Coordinator errors: ${record.coordinatorErrors ?? 0}`);
  lines.push(`Consults: ${Array.isArray(record.consults) ? record.consults.length : 0}`);
  return lines.join("\n");
}

/**
 * cmdLunaShow — render a mission digest (read-only, no LLM).
 *
 * @param {string} cwd
 * @param {object} input — { flags, text } (the mission id is the text).
 * @returns {string} the rendered digest.
 * @throws {Error} for a missing mission or a malformed mission id.
 */
export async function cmdLunaShow(cwd, { text }) {
  const missionId = (text ?? "").trim() || null;
  if (!missionId) {
    throw new Error("luna-show requires a mission id. Usage: luna-show <missionId>");
  }
  assertMissionIdShape(missionId);
  const stateDir = stateDirFor(cwd);
  const missionsDir = path.join(stateDir, "missions");
  const snapshot = readMissionSnapshot(missionsDir, missionId);
  if (!snapshot.exists) {
    throw new Error(`mission not found: ${missionId}`);
  }
  return renderMissionShow(snapshot);
}