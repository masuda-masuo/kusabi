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
import {
  mintMissionId,
  assertMissionIdShape,
  readMissionControl,
  writeMissionControl,
  readMissionRecord,
  saveMissionRecord,
  finalizeMissionControl,
  missionStopRequested,
  clearMissionBlockForOverride,
  TERMINAL_MISSION_DISPOSITIONS,
} from "./mission-store.mjs";
import {
  waitForMission,
  readMissionSnapshot,
  TERMINAL_MISSION_STATUSES,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_APPEAR_TIMEOUT_MS,
  DEFAULT_PROGRESS_TIMEOUT_MS,
} from "./luna-wait.mjs";
import { readChainControl, requestChainStop, isPidAlive } from "./chain-control.mjs";
import { createAuditOverride } from "./audit-verdict.mjs";
import { reconcileMissionState, missionHasLiveJob } from "./luna-reconcile.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPANION_SCRIPT = path.join(HERE, "kusabi-companion.mjs");

/** The exact default seats of #530. */
export const DEFAULT_COORDINATOR_SEAT = { provider: "codex", model: "gpt-5.6-luna" };
export const DEFAULT_AUDITOR_SEAT = { provider: "codex", model: "gpt-5.6-sol" };

/**
 * The mission-owned guarded serve cleanup used when cmdLunaResume settles a
 * stop-requested mission to cancelled WITHOUT invoking the driver: the same
 * semantics the driver applies on its terminal paths - stop the shared serve
 * only when no live jobs remain (the serve is shared with inner chains that
 * may still be running; liveRunningJobs applies the same fossil rule as
 * cmdServeStop).  Best-effort by contract: a cleanup failure must never mask
 * the terminal cancellation.
 *
 * @param {string} cwd
 * @param {string} stateDir
 */
async function resumeSettleGuardedServeStop(cwd, stateDir) {
  const { liveRunningJobs, cmdServeStop } = await import("./kusabi-companion.mjs");
  if (liveRunningJobs(stateDir).length === 0) {
    cmdServeStop(cwd);
  }
}



/**
 * The mission-id shape the cancel/resume surfaces accept (kusabi #531).
 *
 * The frozen acceptance tests steer missions whose ids carry hyphens in the
 * tail (e.g. "mission-cancel-live-chain", "mission-job-live"), so these
 * surfaces accept `mission-` followed by lowercase letters, digits and
 * hyphens — still a single safe path segment (no `/`, no `\`, no `..`, no
 * NUL, no spaces, no uppercase), validated before any filesystem access.
 * The stricter store-level assertMissionIdShape (`mission-[a-z0-9]+`) remains
 * the minting shape for created missions.
 *
 * @param {string} missionId
 * @throws {Error} for a value that is not a safe mission path segment.
 */
function assertMissionIdSurfaceShape(missionId) {
  if (
    typeof missionId !== "string" ||
    !/^mission-[a-z0-9-]+$/.test(missionId) ||
    missionId.includes("..")
  ) {
    throw new Error(
      `invalid mission id: "${String(missionId)}" — a mission id must be a single path segment ` +
      `matching mission-[a-z0-9-]+ (it becomes a path segment under missions/, so /, .. and ` +
      `other separators are refused)`,
    );
  }
}

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


/**
 * cmdLunaCancel - record a stop request on a luna mission (kusabi #531).
 *
 * `text` is the mission id.  Writes the stop request (stopRequestedAt +
 * stopRequestedBy "luna") on the mission control and propagates it to every
 * LIVE inner chain through the existing chain stop lever (requestChainStop);
 * a STALE inner chain is finalised by the existing stale-pid branch (status
 * cancelled + finishedAt + the existing host notification).  After the stop
 * request exists, no coordinator, auditor, or inner-chain seat may be
 * dispatched - the driver enforces that at every dispatch point.
 *
 * Refuses a malformed or missing mission id before writing anything.
 *
 * @param {string} cwd
 * @param {object} input - { text } (the mission id).
 * @returns {Promise<string>} the stop summary.
 */
export async function cmdLunaCancel(cwd, { text }) {
  const missionId = (text ?? "").trim() || null;
  if (!missionId) {
    throw new Error("luna-cancel requires a mission id. Usage: luna-cancel <missionId>");
  }
  assertMissionIdSurfaceShape(missionId);
  const stateDir = stateDirFor(cwd);
  const missionDir = path.join(stateDir, "missions", missionId);
  if (!fs.existsSync(missionDir)) {
    throw new Error(`mission not found: ${missionId}`);
  }

  // Propagate the stop to every recorded inner chain through the EXISTING
  // chain stop lever (requestChainStop semantics): a live chain receives the
  // stop request, a stale chain is finalised cancelled by the stale-pid
  // branch.  An already-terminal chain is left untouched.
  const record = readMissionRecord(missionDir);
  const chains = Array.isArray(record?.chains) ? record.chains : [];
  const chainNotes = [];
  for (const chainId of chains) {
    if (typeof chainId !== "string") continue;
    const chainDir = path.join(stateDir, "chains", chainId);
    if (!fs.existsSync(chainDir)) continue;
    const chainControl = readChainControl(chainDir);
    if (!chainControl || chainControl.status !== "running") continue;
    const result = requestChainStop(chainDir, "luna");
    chainNotes.push(result.wasStale ? `${chainId} (stale - finalised cancelled)` : chainId);
  }

  // Write the stop request (only the stop-request fields are new).
  const control = readMissionControl(missionDir) ?? {};
  writeMissionControl(missionDir, {
    ...control,
    stopRequestedAt: new Date().toISOString(),
    stopRequestedBy: "luna",
  });

  const inner =
    chainNotes.length > 0
      ? ` Stop request propagated to inner chain(s): ${chainNotes.join(", ")}.`
      : "";
  return `stop requested for mission ${missionId}.${inner}`;
}

/**
 * cmdLunaResume - resume a luna mission from its persisted state (kusabi #531).
 *
 * `text` is the mission id.  Refuses while the recorded mission process or a
 * recorded Luna/Sol job is genuinely live; refuses an already-terminal
 * mission unless a matching human audit override is supplied for a
 * sol-blocked mission; settles stale inner chains / seat jobs deterministically
 * (luna-reconcile, through the existing chain stop lever) BEFORE the driver
 * seam is invoked.  Resume is an inline state operation - it never spawns a
 * watcher or waiter process.
 *
 * @param {string} cwd
 * @param {object} input - { flags, text }.
 * @param {object} [opts]
 * @param {object} [opts.inject] - runLunaMission is the driver seam (default:
 *   the real driver); the REST of opts.inject is forwarded into the driver's
 *   input.inject.
 * @param {Function} [opts.spawn] - must never be called (resume never spawns).
 * @returns {Promise<string>} the driver's terminal summary.
 */
export async function cmdLunaResume(cwd, { flags, text }, opts = {}) {
  const missionId = (text ?? "").trim() || null;
  if (!missionId) {
    throw new Error("luna-resume requires a mission id. Usage: luna-resume <missionId>");
  }
  assertMissionIdSurfaceShape(missionId);
  const stateDir = stateDirFor(cwd);
  const missionDir = path.join(stateDir, "missions", missionId);
  if (!fs.existsSync(missionDir)) {
    throw new Error(`mission not found: ${missionId}`);
  }
  const control = readMissionControl(missionDir);
  const record = readMissionRecord(missionDir);
  if (!record || typeof record !== "object") {
    throw new Error(`mission record missing or unreadable for ${missionId}`);
  }

  // ---- 1. liveness guards: a genuinely live mission process or a recorded
  // Luna/Sol job refuses the resume before anything is touched. ----
  if (control?.pid != null && isPidAlive(control.pid)) {
    throw new Error(
      `mission ${missionId} is still running (pid ${control.pid}) - stop it first (luna-cancel)`,
    );
  }
  if (missionHasLiveJob(stateDir, missionId)) {
    throw new Error(
      `mission ${missionId} has a recorded Luna/Sol job still running - ` +
      `wait for it to finish or cancel it, then retry luna-resume`,
    );
  }

  // ---- 2. terminal-state handling (override or refuse) ----
  const disposition = typeof record.disposition === "string" ? record.disposition : null;
  const recordTerminal = disposition !== null && TERMINAL_MISSION_DISPOSITIONS.has(disposition);
  const controlTerminal = control ? TERMINAL_MISSION_STATUSES.has(control.status) : false;

  if (recordTerminal || controlTerminal) {
    const overrideGateId = flags["audit-override"];
    const overrideBy = flags["audit-override-by"];
    const overrideReason = flags["audit-override-reason"];
    const overrideSupplied =
      overrideGateId !== undefined || overrideBy !== undefined || overrideReason !== undefined;

    if (overrideSupplied) {
      // Incomplete overrides are refused before any seat or any record write.
      if (overrideGateId === undefined || String(overrideGateId).trim() === "") {
        throw new Error("luna-resume override requires --audit-override <gateId>");
      }
      if (overrideReason === undefined || String(overrideReason).trim() === "") {
        throw new Error("luna-resume override requires --audit-override-reason <reason>");
      }
      if (overrideBy === undefined || String(overrideBy).trim() === "") {
        throw new Error("luna-resume override requires --audit-override-by <actor>");
      }
      if (disposition !== "sol-blocked") {
        throw new Error(
          `luna-resume override refused: an audit override only applies to a sol-blocked ` +
          `mission (this mission is ${disposition ?? "not blocked"})`,
        );
      }
      const gates = Array.isArray(record.auditGates) ? record.auditGates : [];
      const gate = gates.find(
        (g) => g && g.gateId === overrideGateId && (g.verdict === "block" || g.verdict === "rework"),
      );
      if (!gate) {
        throw new Error(
          `luna-resume override refused: gate ${overrideGateId} is not a blocking gate on mission ${missionId}`,
        );
      }
      if (!gate.verdictRecord || typeof gate.verdictRecord !== "object") {
        throw new Error(
          `luna-resume override refused: gate ${overrideGateId} has no original verdict record to embed`,
        );
      }
      // The override is the ONLY way a Sol block is reconsidered: it embeds
      // the original verdict byte-for-byte, names the human actor, and
      // records the machine-readable resolution.
      const override = createAuditOverride({
        original: gate.verdictRecord,
        resolution: "clear",
        by: String(overrideBy).trim(),
        reason: String(overrideReason).trim(),
        timestamp: Date.now(),
      });
      const nextRecord = {
        ...record,
        overrides: [...(Array.isArray(record.overrides) ? record.overrides : []), override],
        auditGates: gates.map((g) => (g && g.gateId === overrideGateId ? { ...g, overridden: true } : g)),
        disposition: null,
        status: "running",
        recommendation: null,
        terminationReason: null,
      };
      clearMissionBlockForOverride(missionDir, nextRecord);
    } else if (disposition === "sol-blocked") {
      throw new Error(
        `mission ${missionId} is sol-blocked - only a matching human audit override ` +
        `(--audit-override <gateId> --audit-override-reason <reason> --audit-override-by <actor>) ` +
        `lets it proceed`,
      );
    } else {
      throw new Error(
        `mission ${missionId} is already terminal ` +
        `(status=${control?.status ?? "unknown"}, disposition=${disposition ?? "none"}) - nothing to resume`,
      );
    }
  } else if (flags["audit-override"] !== undefined || flags["audit-override-by"] !== undefined || flags["audit-override-reason"] !== undefined) {
    throw new Error(
      `luna-resume override refused: mission ${missionId} is not sol-blocked - an override ` +
      `is only accepted for a blocked mission`,
    );
  }

  // ---- 3. a recorded stop request is never undone: settle the mission
  // cancelled instead of resuming against its stop (criterion 4/5). ----
  if (missionStopRequested(missionDir)) {
    // Reconcile recorded stale/live inner-chain state through the existing
    // deterministic reconciliation path BEFORE the terminal settlement: a
    // stale inner chain is finalised cancelled via the existing chain stop
    // lever (with its existing host notification), a live one receives the
    // stop request, and stale Luna/Sol job records settle - exactly the same
    // settlement a normal resume performs, so a cancelled mission never
    // leaves its inner chains or seat jobs dangling.  Reconciliation is
    // idempotent by construction (terminal chains/jobs are skipped).
    reconcileMissionState({ stateDir, missionId, record });

    const settled = {
      ...record,
      status: "completed",
      disposition: "cancelled",
      recommendation: null,
      terminationReason: "stop requested",
    };
    saveMissionRecord(missionDir, settled);
    finalizeMissionControl(missionDir, "cancelled");
    const recLines = [
      "# Mission recommendation",
      "",
      `mission: ${missionId}`,
      "disposition: cancelled",
      "reason: stop requested",
    ];
    fs.writeFileSync(path.join(missionDir, "recommendation.md"), recLines.join("\n") + "\n", "utf8");
    try {
      const { notifyMissionTerminal } = await import("./chain-notify.mjs");
      notifyMissionTerminal({
        stateDir,
        missionId,
        disposition: "cancelled",
        container: control?.container ?? record.container ?? null,
        cwdLabel: path.basename(cwd),
      });
    } catch { /* best-effort - the terminal record is already durable */ }

    // Mission-owned guarded serve cleanup, exactly once: the mission passed
    // keepServe: true to its inner chains, so it owns the outer serve and
    // must stop it once when it actually recorded inner chain work (the same
    // rule the driver applies on its terminal paths).  The same
    // guardedServeStop inject seam the driver uses applies; the default
    // stops the serve only when no live jobs remain.  Best-effort: a cleanup
    // failure must never mask the terminal cancellation.
    const inject = opts.inject ?? {};
    const driverInject = { ...inject };
    delete driverInject.runLunaMission;
    const recordedChains = Array.isArray(record.chains) ? record.chains : [];
    if (recordedChains.some((c) => typeof c === "string")) {
      const guardedServeStop = driverInject.guardedServeStop ?? resumeSettleGuardedServeStop;
      try {
        await guardedServeStop(cwd, stateDir);
      } catch { /* best-effort - never mask the terminal result */ }
    }
    return `mission ${missionId}: disposition=cancelled (stop request was already recorded - settled).`;
  }

  // ---- 4. deterministic stale-state reconciliation (through the existing
  // chain stop lever and job-store chokepoint) ----
  reconcileMissionState({ stateDir, missionId, record });

  // ---- 5. hand the mission to the driver seam (never a spawned watcher) ----
  const inject = opts.inject ?? {};
  const runLunaMission = inject.runLunaMission ?? (await import("./luna-driver.mjs")).runLunaMission;
  const driverInject = { ...inject };
  delete driverInject.runLunaMission;
  const missionFile = record.missionFile;
  if (!missionFile) {
    throw new Error(`mission ${missionId} has no recorded mission file to resume from`);
  }
  const brief = readMissionFile(missionFile);
  const allowSubstitute = record.coordinator?.substituted === true || flags.allowSubstitute === true;
  return runLunaMission({
    cwd,
    missionFile,
    brief,
    container: control?.container ?? record.container,
    coordinator: record.coordinator,
    auditor: record.auditor,
    allowSubstitute,
    missionId,
    ...(record.budget && typeof record.budget === "object" ? { budget: record.budget } : {}),
    inject: driverInject,
  });
}
