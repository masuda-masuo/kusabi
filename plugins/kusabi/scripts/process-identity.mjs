// process-identity.mjs — what makes a recorded pid safe to signal later (kusabi #209, #601).
//
// Split out of claude-dispatch.mjs (pure move, no behaviour change): the
// /proc-based identity token (starttime) recorded next to a dispatch's pid so
// `cancel` — a different process — can verify and SIGKILL the recorded
// process group without hitting a recycled pid.  Everything here fails
// CLOSED: when /proc cannot be read, or the token is missing or mismatched,
// nothing is signalled.  Shared with backend-process-runner.mjs and the
// companion.

import fs from "node:fs";
import process from "node:process";

// =========================================================================
// process identity — what makes a recorded pid safe to signal later
// =========================================================================
//
// `cancel` runs in a DIFFERENT process from the dispatch, so the only way it
// can reach the spawned child is through the pid persisted on the job
// record.  A pid on its own is not a safe kill target: pids are recycled and
// a record can outlive its process by days.  Measured on this machine: a pid
// recorded 8 days earlier had been reused as an unrelated process's thread
// id, and signalling it took down a live server for 22 minutes.
//
// So every recorded pid is stored with an IDENTITY TOKEN and re-verified
// immediately before anything is signalled.  The token is field 22 of
// /proc/<pid>/stat, `starttime` (clock ticks since boot).  That is
// sufficient here because:
//   - it is assigned once when the process is forked and never changes for
//     the rest of its life (exec included), so it is stable between the
//     dispatch that records it and the cancel that checks it;
//   - it is not inherited: a recycled pid necessarily belongs to a process
//     that started later, so its starttime differs.  (pid, starttime) is the
//     kernel's own process identity — the same pair pidfd-less tooling has
//     always used;
//   - it does not lie for a thread id either: /proc/<tid>/stat carries that
//     thread's own starttime, so the TID-reuse case above is refused too;
//   - reading it needs no privileges and no cooperation from the process.
//
// Everything here fails CLOSED: when /proc cannot be read, or the token is
// missing, or it does not match, NOTHING is signalled.  A leaked process
// costs a wasted container; a mis-aimed SIGKILL costs someone else's work.

// How long a signalled process group is given to actually disappear before
// the stop is reported as failed.  kill() returning means the signal was
// delivered, not that anything died, so the disappearance is polled for.
// Overridable so tests can drive the could-not-stop path without a 5 s wait
// (mirrors KUSABI_SERVE_READY_TIMEOUT_MS in serve-lifecycle.mjs).
const KILL_CONFIRM_WAIT_MS = 5000;
const KILL_CONFIRM_POLL_MS = 50;

export function killConfirmWaitMs() {
  const raw = process.env.KUSABI_CANCEL_KILL_WAIT_MS;
  if (raw === undefined || raw === "") return KILL_CONFIRM_WAIT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : KILL_CONFIRM_WAIT_MS;
}

/**
 * Parse the /proc/<pid>/stat fields identity and liveness need.  Throws the
 * underlying fs error when the entry cannot be read — with /proc present,
 * ENOENT means the pid is gone.
 *
 * @param {number} pid
 * @returns {{ state: string, pgrp: number, startTime: string }}
 */
export function readProcessStat(pid) {
  const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  // Fields 1 (pid) and 2 (comm) are skipped by hand: comm is the executable
  // name in parentheses and may itself contain spaces and parentheses, so
  // only the LAST ")" reliably ends it.  After it, field N sits at index
  // N-3: state = 3, pgrp = 5, starttime = 22.
  const rest = text.slice(text.lastIndexOf(")") + 2).split(" ");
  return { state: rest[0], pgrp: Number(rest[2]), startTime: rest[19] };
}

// True when /proc is present at all (Linux); false where it is not (macOS),
// which is what tells "the pid is gone" apart from "this platform cannot
// answer".
function procAvailable() {
  try {
    return fs.existsSync("/proc/self/stat");
  } catch {
    return false;
  }
}

// A pid in state Z (zombie) or X (dead) exists as a /proc entry but is NOT
// alive: it runs no code and holds no resources, it is just an exit status
// waiting to be reaped.  kill(pid, 0) cannot tell the difference — the state
// field can, and must, or a group kill would never read as complete while an
// orphaned grandchild waits for init to reap it.
function liveState(state) {
  return state !== "Z" && state !== "X";
}

/**
 * The identity token to persist next to a pid, or null when it cannot be
 * read.  A null token is not a licence to kill: stopRecordedProcess refuses
 * to signal a pid it cannot verify.
 *
 * @param {number} pid
 * @returns {string|null}
 */
export function processStartToken(pid) {
  try {
    return readProcessStat(pid).startTime ?? null;
  } catch {
    return null;
  }
}

/**
 * The live (non-zombie) members of process group *pgid*, or null when the
 * group cannot be enumerated (no /proc).
 *
 * @param {number} pgid
 * @returns {number[]|null}
 */
export function processGroupMembers(pgid) {
  let entries;
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return null;
  }
  const members = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const stat = readProcessStat(pid);
      if (stat.pgrp === pgid && liveState(stat.state)) members.push(pid);
    } catch { /* vanished or unreadable between readdir and read */ }
  }
  return members;
}

// True when nothing is left running in process group *pgid*.  /proc is the
// primary source (it sees zombies for what they are); where it is absent,
// kill(-pgid, 0) is the only probe available and ESRCH is the answer.
function groupIsGone(pgid) {
  const members = processGroupMembers(pgid);
  if (members !== null) return members.length === 0;
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (err) {
    return err?.code === "ESRCH";
  }
}

function stopResult(outcome, pid, signalled, reason, survivors = []) {
  return { outcome, pid, signalled, reason, survivors };
}

/**
 * Stop a dispatch's process group from another process, using the identity
 * recorded on the job record (kusabi #209).
 *
 * Never signals a pid it cannot prove is the recorded process, and never
 * reports a stop it did not watch happen: after the SIGKILL the group is
 * polled until it is empty or the bounded wait runs out.
 *
 * @param {{pid?: number, startTime?: string}|null|undefined} recorded
 *        the job record's `process` field.
 * @param {{waitMs?: number, pollMs?: number}} [opts]
 * @returns {Promise<{outcome: "stopped"|"already-gone"|"identity-mismatch"|"unverifiable"|"no-record"|"alive",
 *                    pid: number|null, signalled: boolean, reason: string, survivors: number[]}>}
 *   - `stopped`          — signalled, and the whole group was observed gone.
 *   - `already-gone`     — nothing to signal; the process had already exited.
 *   - `identity-mismatch`— the pid is live but is NOT this job's process
 *                          (recycled pid / thread id): not signalled, and the
 *                          job's own process is therefore gone.
 *   - `unverifiable`     — the pid may well be the process, it just cannot be
 *                          proven: not signalled, and the job may still run.
 *   - `no-record`        — the record names no pid at all.
 *   - `alive`            — signalled, and something in the group survived.
 */
export async function stopRecordedProcess(
  recorded,
  { waitMs, pollMs = KILL_CONFIRM_POLL_MS, now = () => performance.now() } = {},
) {
  const pid = Number(recorded?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return stopResult("no-record", null, false, "the job record carries no process id");
  }
  const token = recorded?.startTime ?? null;

  let stat;
  try {
    stat = readProcessStat(pid);
  } catch (err) {
    if (procAvailable() && err?.code === "ENOENT") {
      return stopResult("already-gone", pid, false, `pid ${pid} is no longer running`);
    }
    return stopResult("unverifiable", pid, false, `cannot read /proc/${pid}/stat (${err?.code ?? err?.message ?? err})`);
  }
  if (!liveState(stat.state)) {
    return stopResult("already-gone", pid, false, `pid ${pid} is an unreaped corpse (process state ${stat.state}), not a running process`);
  }
  if (!token) {
    return stopResult("unverifiable", pid, false, `the record carries pid ${pid} with no identity token, so the live pid cannot be proven to be this job's process`);
  }
  if (stat.startTime !== String(token)) {
    return stopResult("identity-mismatch", pid, false, `pid ${pid} now belongs to a different process (recorded start time ${token}, observed ${stat.startTime})`);
  }
  if (stat.pgrp !== pid) {
    // Every child this dispatch spawns is detached, i.e. the leader of its
    // own group (pgrp == pid).  A verified pid that is not a group leader is
    // a shape this code has never produced, so refuse rather than guess
    // which group `kill(-pid)` would hit.
    return stopResult("unverifiable", pid, false, `pid ${pid} is not the leader of its process group (pgrp ${stat.pgrp}); a dispatch child always is`);
  }

  // Identity confirmed.  SIGKILL the whole GROUP, exactly as the in-dispatch
  // timeout does: the CLI has its own children (its sunaba MCP server, tool
  // commands) and killing only the leader would leave them writing into the
  // container the operator is about to reuse.
  try {
    process.kill(-pid, "SIGKILL");
  } catch (err) {
    if (err?.code === "ESRCH") {
      return stopResult("already-gone", pid, false, `process group ${pid} vanished before it could be signalled`);
    }
    return stopResult("alive", pid, false, `SIGKILL to process group ${pid} failed: ${err?.code ?? err?.message ?? err}`);
  }

  const deadline = now() + (waitMs ?? killConfirmWaitMs());
  for (;;) {
    if (groupIsGone(pid)) {
      return stopResult("stopped", pid, true, `process group ${pid} is gone`);
    }
    if (now() >= deadline) {
      const survivors = processGroupMembers(pid) ?? [];
      return stopResult(
        "alive",
        pid,
        true,
        `process group ${pid} still has live members after SIGKILL${survivors.length ? ` (pids ${survivors.join(", ")})` : ""}`,
        survivors,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
