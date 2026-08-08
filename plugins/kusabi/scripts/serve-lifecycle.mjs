// serve-lifecycle.mjs — opencode server start/stop/health/reap
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import process from "node:process";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { stateDirFor, readJson, writeJson } from "./state-paths.mjs";

const SERVER_READY_TIMEOUT_MS = 20_000;

// How long the spawned serve is given to answer a health probe.  Overridable
// via KUSABI_SERVE_READY_TIMEOUT_MS so tests can drive the timeout path
// without waiting 20 s (kusabi #162); the module constant stays the default.
export function serverReadyTimeoutMs() {
  const raw = process.env.KUSABI_SERVE_READY_TIMEOUT_MS;
  if (raw === undefined || raw === "") return SERVER_READY_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : SERVER_READY_TIMEOUT_MS;
}

export function opencodeBin() {
  return process.env.OPENCODE_BIN || "opencode";
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export function authHeader(server) {
  const user = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  return { authorization: `Basic ${Buffer.from(`${user}:${server.password}`).toString("base64")}` };
}

// Build the env for the spawned opencode serve process. Pulled out as its
// own pure function (kusabi #136 fix 3) so it is unit-testable without
// spawning a real serve: KUSABI_WORKER_CONTEXT="1" is the marker every tool
// process a worker session runs (bash included) inherits as a descendant of
// this serve. The companion's CLI entry refuses job-creating subcommands
// when it sees the marker, closing the path the #136 fork bomb used to
// re-invoke itself from inside a worker's own bash.
export function buildServeEnv(baseEnv, password, stateDir) {
  const env = { ...baseEnv, OPENCODE_SERVER_PASSWORD: password, KUSABI_WORKER_CONTEXT: "1" };
  // The serve's own state dir is stamped as well, so a live process can be
  // attributed back to the state dir that should name it in server.json —
  // reapOrphanedServes() reads this marker to find serves no record names.
  if (stateDir) env.KUSABI_SERVE_STATE_DIR = stateDir;
  return env;
}

// A `running` job record is written when its driver starts and only
// rewritten when the driver finishes.  A driver that dies without a chance
// to rewrite (crash, killed terminal, machine sleep) leaves the record
// `running` forever.  The record carries no pid, so the only liveness
// signal is its activity timestamp — stats.lastActivity, falling back to
// startedAt.  A `running` record whose last activity is older than
// RUNNING_STALE_MS is a fossil: it must not count as proof that work is in
// flight (kusabi #162 follow-up).  This is a read-side judgement only — the
// record on disk is never rewritten.
export const RUNNING_STALE_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * @param {{status?: string, stats?: object, startedAt?: string}} job
 * @param {number} now — epoch ms at decision time
 * @returns {boolean} true when *job* is a `running` record whose last
 *   activity (stats.lastActivity, falling back to startedAt) is older than
 *   RUNNING_STALE_MS.  False for every other status and for records with no
 *   usable activity timestamp (staleness cannot be proven, so the record
 *   still counts as running).
 */
export function runningRecordIsStale(job, now = Date.now()) {
  if (job?.status !== "running") return false;
  const raw = job?.stats?.lastActivity ?? job?.startedAt;
  if (typeof raw !== "string" || raw === "") return false;
  const activity = Date.parse(raw);
  if (!Number.isFinite(activity)) return false;
  return now - activity > RUNNING_STALE_MS;
}

export async function serverHealthy(server) {
  if (!server?.port || !server?.password) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/session`, {
      headers: authHeader(server),
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Make sure a healthy `opencode serve` exists for *cwd* and return its
 * record.  Reuses the recorded serve from server.json when it answers a
 * health probe; otherwise starts one.
 *
 * Start-up is serialised per state directory with an atomic mkdir lock
 * (`serve.lock`) so concurrent callers for the same cwd end up with exactly
 * one live serve (kusabi #162): a caller that loses the lock race waits for
 * the winner's server.json instead of spawning a second process.  Every
 * failure path kills the process it spawned before throwing, so no live
 * serve ever outlives a call that did not record it in server.json.
 */
export async function ensureServer(cwd) {
  const stateDir = stateDirFor(cwd);
  const serverFile = path.join(stateDir, "server.json");
  const timeoutMs = serverReadyTimeoutMs();

  const existing = readJson(serverFile);
  if (await serverHealthy(existing)) return { ...existing, stateDir };

  const lockDir = path.join(stateDir, "serve.lock");
  for (;;) {
    let acquired = false;
    try {
      fs.mkdirSync(lockDir);
      acquired = true;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      // Another caller is starting a serve.  Wait (bounded) for its
      // server.json to appear and become healthy, then reuse it.
      const published = await waitForPublishedHealthy(serverFile, lockDir, timeoutMs);
      if (published) return { ...published, stateDir };
      if (lockIsStale(lockDir, timeoutMs)) {
        // The holder gave up (or died) without publishing: a lock older than
        // the ready timeout is stale.  Take it over and start ourselves.
        try { fs.rmdirSync(lockDir); } catch { /* raced: another caller took it */ }
        continue;
      }
      // The lock is still fresh — its holder is legitimately starting and
      // has not had its own full window yet.  Fail rather than stack a
      // second spawn; the holder will publish or clean up.
      throw new Error(`opencode serve did not become ready within ${timeoutMs}ms (concurrent start-up in ${stateDir})`);
    }
    if (acquired) {
      try {
        return await startServer({ stateDir, serverFile, cwd, timeoutMs });
      } finally {
        try { fs.rmdirSync(lockDir); } catch { /* best-effort */ }
      }
    }
  }
}

// Wait for the lock holder to publish a healthy server.json.  Returns the
// published record when it appears, or null when the holder releases the
// lock without publishing (failed start-up) or the wait bound expires.
async function waitForPublishedHealthy(serverFile, lockDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const published = readJson(serverFile);
    if (published && (await serverHealthy(published))) return published;
    if (!fs.existsSync(lockDir)) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

function lockIsStale(lockDir, timeoutMs) {
  try {
    return Date.now() - fs.statSync(lockDir).mtimeMs > timeoutMs;
  } catch {
    return true; // lock vanished — caller should retry acquisition
  }
}

// Spawn the serve and poll health while holding the lock.  On success the
// record is written to server.json (the lock holder's finally releases the
// lock afterwards); on any failure the spawned child is killed before the
// error propagates, so a live serve is never left unrecorded.
async function startServer({ stateDir, serverFile, cwd, timeoutMs }) {
  const port = await freePort();
  const password = crypto.randomBytes(16).toString("hex");
  const logFile = path.join(stateDir, "server.log");
  const logFd = fs.openSync(logFile, "a");
  let child;
  try {
    child = spawn(opencodeBin(), ["serve", "--port", String(port)], {
      cwd,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: buildServeEnv(process.env, password, stateDir),
    });
  } catch (err) {
    try { fs.closeSync(logFd); } catch { /* best-effort */ }
    throw err;
  }
  fs.closeSync(logFd);
  child.unref();
  child.on("exit", (code, signal) => {
    try {
      const line = `[${new Date().toISOString()}] process exited: pid ${child.pid}, exit-code=${code}, signal=${signal}\n`;
      fs.appendFileSync(logFile, line, "utf8");
    } catch { /* best-effort */ }
  });

  const server = { port, password, pid: child.pid, cwd, startedAt: new Date().toISOString() };
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (await serverHealthy(server)) {
        writeJson(serverFile, server);
        return { ...server, stateDir };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`opencode serve did not become ready within ${timeoutMs}ms (log: ${logFile})`);
  } catch (err) {
    await killChildGracefully(child);
    throw err;
  }
}

// SIGTERM the child and wait for it to exit; SIGKILL after a short grace if
// it ignores SIGTERM.  `child.unref()` keeps it from holding the parent's
// event loop open but does not stop us from killing it.
async function killChildGracefully(child) {
  if (!child || child.pid == null) return;
  if (child.exitCode !== null || child.signalCode !== null) return; // already gone
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    process.kill(child.pid, "SIGTERM");
  } catch {
    return; // already gone
  }
  await Promise.race([exited, new Promise((r) => setTimeout(r, 1_500))]);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ }
    await Promise.race([exited, new Promise((r) => setTimeout(r, 1_500))]);
  }
}

export async function api(server, method, apiPath, body) {
  const res = await fetch(`http://127.0.0.1:${server.port}${apiPath}`, {
    method,
    headers: { ...authHeader(server), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${apiPath} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Scan all hash directories under the state root and reap idle serves whose
 * last activity is older than *ttlMs*.  A serve is never touched when any of
 * its jobs still has a *fresh* `running` record — a `running` record whose
 * last activity is older than RUNNING_STALE_MS is a fossil and does not pin
 * the serve (kusabi #162 follow-up).
 *
 * Every recorded pid is checked against isOurServe() before anything can be
 * signalled (kusabi #181): a record can outlive the serve by days and the
 * pid may by then belong to a stranger (recycled pid, or a TID of an
 * unrelated process — the liveness check passes for a live TID).  A *refuted*
 * record is deleted without killing, so the next call does not look at that
 * pid again.  An *unverifiable* record (hidepid, older marker set) is left
 * alone: deleting it would strand a genuine serve that is merely
 * unprovable.  With `keepIdentityFailed` (serve-stop invocations) even
 * refuted records are left for the invoking command to adjudicate, so its
 * reason-bearing refusal reaches the user.  Every identity refusal is
 * appended to the state dir's server.log — the sweep never acts silently.
 *
 * Best-effort: per-directory errors are caught and the function never throws.
 *
 * @param {string} root
 * @param {number} ttlMs
 * @param {{ keepIdentityFailed?: boolean }} [opts]
 */
export function reapIdleServes(root, ttlMs, opts = {}) {
  if (!fs.existsSync(root)) return;
  let entries;
  try { entries = fs.readdirSync(root); } catch { return; }
  // Identity confirmation is /proc-based.  Where /proc is unavailable the
  // sweep cannot tell our serves from strangers and degrades to a no-op
  // (kusabi #181), matching reapOrphanedServes — a leaked serve costs
  // memory, shooting a stranger costs someone else's process.
  try { fs.readdirSync("/proc"); } catch { return; }
  for (const entry of entries) {
    try {
      const hashDir = path.join(root, entry);
      if (!fs.statSync(hashDir).isDirectory()) continue;
      const serverFile = path.join(hashDir, "server.json");
      if (!fs.existsSync(serverFile)) continue;

      const server = readJson(serverFile);
      if (!server?.pid) continue;

      // Pid alive?
      try { process.kill(server.pid, 0); } catch { continue; }

      // Is this pid really one of our serves?  A record can outlive the
      // serve by days; the pid may by then belong to something else
      // entirely (a recycled pid, or a TID of an unrelated process — the
      // liveness check above passes for a live TID).  Never signal a pid we
      // cannot attribute to our own serve (kusabi #181).
      const identity = isOurServe(server.pid, { root, stateDir: hashDir });
      if (!identity.ours) {
        const logLine = `[${new Date().toISOString()}] reap-idle: pid ${server.pid} refused (${identity.class}: ${identity.reason}) — no signal sent`;
        if (identity.class === "refuted" && !opts.keepIdentityFailed) {
          // The record positively names a process that is not our serve (or
          // is gone): the record is what is invalid.  Delete it without
          // killing, and say so in server.log — a silent disappearance is
          // exactly the confusion the identity gate exists to prevent.
          try { fs.unlinkSync(serverFile); } catch { /* best-effort */ }
          try { fs.appendFileSync(path.join(hashDir, "server.log"), `${logLine}; server.json removed\n`, "utf8"); } catch { /* best-effort */ }
        } else if (identity.class === "unverifiable") {
          // The pid may well be our serve — we just cannot prove it.  The
          // record is the only handle to that process: deleting it would
          // strand it (unreachable by serve-stop, invisible to the orphan
          // sweep) and spawn a duplicate on the next dispatch.  Fail closed
          // and keep the handle; the next ensureServer() health probe can
          // still reuse a healthy serve.
          try { fs.appendFileSync(path.join(hashDir, "server.log"), `${logLine}; server.json kept (identity unprovable)\n`, "utf8"); } catch { /* best-effort */ }
        } else {
          // refuted + keepIdentityFailed: left for the invoking command
          // (serve-stop) to adjudicate and report.
          try { fs.appendFileSync(path.join(hashDir, "server.log"), `${logLine}; server.json kept (left for the invoking command)\n`, "utf8"); } catch { /* best-effort */ }
        }
        continue;
      }

      // Collect job statuses + mtimes.
      const jobRecords = [];
      const jobsDir = path.join(hashDir, "jobs");
      if (fs.existsSync(jobsDir)) {
        const jobIds = fs.readdirSync(jobsDir);
        for (const jobId of jobIds) {
          const jobFile = path.join(jobsDir, jobId, "job.json");
          if (!fs.existsSync(jobFile)) continue;
          const job = readJson(jobFile);
          if (!job) continue;
          try {
            jobRecords.push({
              status: job.status,
              mtime: fs.statSync(jobFile).mtimeMs,
              stats: job.stats,
              startedAt: job.startedAt,
            });
          } catch { /* skip unreadable job */ }
        }
      }

      const serverMtime = fs.statSync(serverFile).mtimeMs;
      const now = Date.now();
      const decision = shouldReapServer({ serverMtime, jobRecords, now, ttlMs });

      if (decision.reap) {
        try { process.kill(server.pid); } catch { /* already gone */ }
        try { fs.unlinkSync(serverFile); } catch { /* best-effort */ }
      }
    } catch { /* best-effort per hash dir */ }
  }
}

/**
 * Judge whether a serve process is dead based on its pid.
 *
 * Uses `process.kill(pid, 0)` which tests whether the process exists
 * without sending a signal.  ESRCH means the process is definitively gone.
 * EPERM means the process exists (we just cannot signal it), so that is
 * treated as alive.
 *
 * @param {number|null} pid \u2014 The PID to check.
 * @returns {{ dead: boolean, reason: string|null }}
 *   - `dead`: true when the process is definitively gone (ESRCH).
 *   - `reason`: a description of what was observed when dead.
 */
export function judgeServeDeath(pid) {
  if (pid == null) return { dead: false, reason: null };
  try {
    process.kill(pid, 0);
    return { dead: false, reason: null };
  } catch (err) {
    if (err && err.code === "ESRCH") {
      return { dead: true, reason: `pid ${pid} not found (ESRCH)` };
    }
    // EPERM or other errors \u2014 process exists
    return { dead: false, reason: null };
  }
}

// Reap orphaned `opencode serve` processes: live processes carrying kusabi's
// serve marker (KUSABI_WORKER_CONTEXT=1 plus KUSABI_SERVE_STATE_DIR pointing
// under *root*) whose pid is not named by that state dir's server.json.
// Such serves are invisible to serve-stop and to reapIdleServes (both start
// from server.json) and would hold memory forever; PR #163 stopped creating
// them, this recovers ones that already exist (kusabi #162 follow-up).
//
// Identification is isOurServe() — the same identity gate every kill site
// uses (kusabi #181): /proc/<pid>/environ carries the marker env that
// buildServeEnv() stamps into every spawned serve, and /proc/<pid>/cmdline
// is sanity-checked for a bare "serve" argv token so descendant tool/bash
// processes that merely inherited the marker env are never touched.  A
// start-up in progress (fresh serve.lock) is never killed, and a recorded
// serve is never killed.  Best-effort throughout: unreadable or vanished
// pids are skipped, and the sweep degrades to a no-op where /proc is
// unavailable (macOS) — it never throws.
export function reapOrphanedServes(root) {
  let pids;
  try {
    pids = fs.readdirSync("/proc").filter((e) => /^\d+$/.test(e));
  } catch {
    return; // /proc unavailable → no-op, never an error
  }
  for (const pidEntry of pids) {
    try {
      const pid = Number(pidEntry);
      const identity = isOurServe(pid, { root });
      if (!identity.ours) continue;
      // A start-up in progress holds a fresh serve.lock — that window is
      // legitimate, never kill.
      if (startupInProgress(identity.markerStateDir)) continue;
      const server = readJson(path.join(identity.markerStateDir, "server.json"));
      if (server?.pid === pid) continue; // recorded — leave alone
      process.kill(pid);
    } catch { /* best-effort per pid: vanished, unreadable, unkillable */ }
  }
}

/**
 * The single place that answers "may I signal this pid": is it one of our
 * `opencode serve` processes?
 *
 * Every serve we spawn carries the marker env buildServeEnv() stamps
 * (KUSABI_WORKER_CONTEXT=1 plus KUSABI_SERVE_STATE_DIR) and an argv with a
 * bare "serve" token.  A server.json record can outlive the serve by days,
 * so the pid it holds may by then belong to something else entirely — a
 * recycled pid, or even a thread id (TID) of an unrelated process.  /proc
 * never lies here: /proc/<pid>/environ and /proc/<pid>/cmdline return the
 * owning process's own environ and cmdline (verified by measurement for the
 * TID case too), so a marker-env check or a cmdline check catches the TID
 * case and the pid-reuse case alike (kusabi #181).
 *
 * Every kill site (reapIdleServes, cmdServeStop, the watchdog,
 * reapOrphanedServes) goes through this gate so a fourth site cannot grow a
 * fourth standard.  The helper never kills — callers own the consequence.
 * Fails closed: when /proc is unavailable or the pid's contents cannot be
 * read, the answer is "not ours".  A leaked serve costs memory; shooting a
 * stranger costs someone else's process.
 *
 * Refusals carry a `class` so callers can tell the two very different kinds
 * of "no" apart (kusabi #181 follow-up):
 *
 *   - "refuted" — a positive conflict: the pid's contents prove it is not
 *     the serve this record names (marker naming a different state dir,
 *     argv without a bare "serve" token, or the process is gone).  The
 *     record is invalid and safe to delete.
 *   - "unverifiable" — the pid may well BE our serve, we just cannot prove
 *     it: /proc unavailable (macOS), environ/cmdline unreadable (hidepid
 *     mounts), or a marker set older than this code (KUSABI_SERVE_STATE_DIR
 *     is only stamped since 2026-08-03, KUSABI_WORKER_CONTEXT=1 only since
 *     2026-07-27).  Deleting the record here would strand a live serve:
 *     serve-stop could never stop it again, the orphan sweep cannot identify
 *     it (it needs the marker), and the next dispatch would spawn a
 *     duplicate.  Record-driven sites must decline WITHOUT deleting so the
 *     record survives and the next ensureServer() health probe can still
 *     reuse the genuine serve.
 *
 * @param {number} pid
 * @param {{ root?: string, stateDir?: string }} [opts]
 *   root     — the marker's KUSABI_SERVE_STATE_DIR must live under this
 *              state root (like reapOrphanedServes' sweep root)
 *   stateDir — when given, the marker's KUSABI_SERVE_STATE_DIR must equal it
 *              (the caller's own state dir)
 * @returns {{ ours: boolean, class: "ours"|"refuted"|"unverifiable", reason: string|null, markerStateDir: string|null }}
 *   `ours` is true only when all three checks pass.  `class` distinguishes
 *   the two refusal kinds above.  `reason` explains a refusal for logging;
 *   `markerStateDir` is the state dir the marker names (null when the marker
 *   is absent/unreadable).
 */
export function isOurServe(pid, { root = null, stateDir = null } = {}) {
  let env;
  try {
    env = readProcEnv(pid);
  } catch (err) {
    // ENOENT with /proc present means the process is gone — nothing alive
    // to strand, so the record is refuted.  EACCES (hidepid) / EPERM / a
    // missing /proc (macOS) mean a possibly-live process we cannot inspect:
    // unverifiable.
    const gone = !procUnavailable() && err?.code === "ENOENT";
    return {
      ours: false,
      class: gone ? "refuted" : "unverifiable",
      reason: `cannot read /proc/${pid}/environ (${err?.code ?? err?.message ?? err})`,
      markerStateDir: null,
    };
  }
  if (env.KUSABI_WORKER_CONTEXT !== "1") {
    // No marker at all: the process may predate KUSABI_WORKER_CONTEXT=1
    // (stamped only since 2026-07-27) and still BE our serve — a genuine
    // pre-marker serve is stranded if its record is deleted (unreachable by
    // serve-stop, invisible to the orphan sweep).  Its argv still carries a
    // bare "serve" token, so the cmdline decides: token present → may well
    // be our serve, unverifiable (record kept); token absent → positively
    // not our serve, refuted (record deletable).  Either way nothing is
    // ever signalled — the kill sites still require the full marker set.
    let cmdline;
    try {
      cmdline = readProcCmdline(pid);
    } catch (err) {
      // Same gone-vs-unreadable rule as the environ read above: ENOENT with
      // /proc present means the process is gone — nothing alive to strand,
      // so refuted.  EACCES (hidepid) / EPERM / a missing /proc (macOS) mean
      // a possibly-live process we cannot inspect: unverifiable.
      const gone = !procUnavailable() && err?.code === "ENOENT";
      return {
        ours: false,
        class: gone ? "refuted" : "unverifiable",
        reason: `cannot read /proc/${pid}/cmdline (${err?.code ?? err?.message ?? err})`,
        markerStateDir: null,
      };
    }
    if (cmdline.includes("serve")) {
      return { ours: false, class: "unverifiable", reason: `pid ${pid} carries no KUSABI_WORKER_CONTEXT=1 marker but argv (${cmdline.filter(Boolean).join(" ")}) has a bare "serve" token (serve predates 2026-07-27?)`, markerStateDir: null };
    }
    return { ours: false, class: "refuted", reason: `pid ${pid} does not carry the KUSABI_WORKER_CONTEXT=1 marker`, markerStateDir: null };
  }
  const markerStateDir = env.KUSABI_SERVE_STATE_DIR;
  if (!markerStateDir) {
    // The marker is present but predates KUSABI_SERVE_STATE_DIR (stamped
    // only since 2026-08-03): very likely one of our older serves, just not
    // attributable to a state dir — unverifiable, never refuted.
    return { ours: false, class: "unverifiable", reason: `pid ${pid} carries KUSABI_WORKER_CONTEXT=1 but no KUSABI_SERVE_STATE_DIR (older marker set)`, markerStateDir: null };
  }
  if (root && !pathIsUnder(root, markerStateDir)) {
    return { ours: false, class: "refuted", reason: `pid ${pid} names state dir ${markerStateDir}, which is not under ${root}`, markerStateDir };
  }
  if (stateDir && !samePath(stateDir, markerStateDir)) {
    return { ours: false, class: "refuted", reason: `pid ${pid} names state dir ${markerStateDir}, not ${stateDir}`, markerStateDir };
  }
  // cmdline sanity check: the serve process itself carries a bare "serve"
  // argv token; its descendants inherit the marker env but not that argv,
  // so they are never matched here.
  let cmdline;
  try {
    cmdline = readProcCmdline(pid);
  } catch (err) {
    const gone = !procUnavailable() && err?.code === "ENOENT";
    return {
      ours: false,
      class: gone ? "refuted" : "unverifiable",
      reason: `cannot read /proc/${pid}/cmdline (${err?.code ?? err?.message ?? err})`,
      markerStateDir,
    };
  }
  if (!cmdline.includes("serve")) {
    return { ours: false, class: "refuted", reason: `pid ${pid} argv (${cmdline.filter(Boolean).join(" ")}) carries no bare "serve" token`, markerStateDir };
  }
  return { ours: true, class: "ours", reason: null, markerStateDir };
}

// True when /proc cannot be listed at all (macOS-style degradation).
function procUnavailable() {
  try {
    fs.readdirSync("/proc");
    return false;
  } catch {
    return true;
  }
}

// True when both paths resolve to the same directory (realpath when
// possible, resolve otherwise): containment in both directions is equality.
function samePath(a, b) {
  return pathIsUnder(a, b) && pathIsUnder(b, a);
}

function readProcEnv(pid) {
  const text = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
  const env = {};
  for (const entry of text.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

function readProcCmdline(pid) {
  return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
}

function pathIsUnder(root, dir) {
  let r = root;
  let d = dir;
  try { r = fs.realpathSync(root); } catch { r = path.resolve(root); }
  try { d = fs.realpathSync(dir); } catch { d = path.resolve(dir); }
  return d === r || d.startsWith(r + path.sep);
}

function startupInProgress(stateDir) {
  const lockDir = path.join(stateDir, "serve.lock");
  let lockMtime;
  try { lockMtime = fs.statSync(lockDir).mtimeMs; } catch { return false; }
  try {
    return Date.now() - lockMtime <= serverReadyTimeoutMs();
  } catch {
    return false;
  }
}

/**
 * @param {object} opts
 * @param {number} opts.serverMtime  — mtimeMs of server.json
 * @param {Array<{status: string, mtime: number, stats?: object, startedAt?: string}>} opts.jobRecords
 * @param {number} opts.now          — Date.now() at decision time
 * @param {number} opts.ttlMs        — idle TTL in milliseconds
 * @returns {{ reap: boolean, reason: string }}
 */
export function shouldReapServer({ serverMtime, jobRecords, now, ttlMs }) {
  const hasRunning = jobRecords.some(function (j) {
    // A `running` record whose last activity is older than RUNNING_STALE_MS
    // is a fossil (the driver died without rewriting it) — it does not pin
    // the serve.
    return j.status === "running" && !runningRecordIsStale(j, now);
  });
  if (hasRunning) return { reap: false, reason: "a running job exists" };

  let maxJobMtime = 0;
  for (let i = 0; i < jobRecords.length; i++) {
    maxJobMtime = Math.max(maxJobMtime, jobRecords[i].mtime || 0);
  }
  const lastActivity = Math.max(serverMtime || 0, maxJobMtime);
  const idleMs = now - lastActivity;

  if (idleMs > ttlMs) {
    return { reap: true, reason: "idle " + idleMs + "ms exceeds TTL " + ttlMs + "ms" };
  }
  return { reap: false, reason: "not yet stale (idle " + idleMs + "ms, TTL " + ttlMs + "ms)" };
}
