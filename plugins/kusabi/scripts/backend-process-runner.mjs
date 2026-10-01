// backend-process-runner.mjs — shared subprocess lifecycle for CLI backends.
//
// Extracted from agy-dispatch.mjs and cursor-dispatch.mjs (kusabi #462) to
// eliminate duplicated spawn, stdout line framing, timeout, silence-watchdog,
// process-group termination, and close/error plumbing.
//
// This module owns ONLY the mechanical lifecycle.  Backend-specific parsing,
// payload rules, usage mapping, prompt construction, and Claude-only behavior
// stay in their respective adapters.

import process from "node:process";
import { spawn } from "node:child_process";
import { processStartToken } from "./process-identity.mjs";

// =========================================================================
// shared predicates
// =========================================================================

/**
 * The ONE usable-timeout predicate: a positive finite number of seconds.
 * Used by both adapters to decide whether to arm the outer timer and the
 * silence watchdog.  A truthy-only check would accept "3600" (string); a
 * hand-copied `typeof === "number" && > 0` would accept Infinity.  Both are
 * banned here so both adapters share one rule in one place (kusabi #328).
 *
 * @param {unknown} value
 * @returns {boolean} true only for a positive finite number of seconds.
 */
export function isUsableTimeoutS(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Resolve a timeout or watchdog bound for a CLI backend: the one place that
 * decides whether a usable bound was supplied and what number it is.
 *
 * REFUSES rather than coerces.  A string (`"3600"`), `NaN`, zero, a
 * negative number, `Infinity`, `-Infinity`, `null`, or an absent value is
 * not a usable positive number of seconds, and none of them arms either bound.
 * kusabi's own callers pass positive whole numbers (the CLI seam converts with
 * `Number(...)`, the defaults are literals); any other shape is a caller
 * bug, and the honest handling of a bug is to leave the bound unset —
 * not to guess at a number the caller never explicitly resolved.  In
 * particular, coercing `"3600"` would arm the outer timer while an inner
 * or sibling bound stayed off wherever the coercion did not propagate — the
 * half-armed state this resolver exists to remove across every CLI backend.
 *
 * Backends call this ONCE and hand the SAME value to all consumers, so every
 * site consumes one decision instead of re-deciding.  Each site re-checks
 * with the same predicate on that value, so even a direct call to one site
 * cannot reach a different conclusion from the other.
 *
 * @param {unknown} value — the raw bound from the dispatch options.
 * @returns {number|null} the resolved bound in seconds, or null when no
 *          usable bound was supplied.
 */
export function resolveBoundS(value) {
  return isUsableTimeoutS(value) ? value : null;
}

// =========================================================================
// process-group kill
// =========================================================================

/**
 * Kill the child's whole process group.  Backends spawn MCP servers and tool
 * subprocesses of their own; signalling only the direct child leaves those
 * running against the shared container after the job record says timeout.
 *
 * @param {import("node:child_process").ChildProcess} child
 */
export function killProcessGroup(child) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The group may already be gone; fall back to the direct child.
    try { child.kill("SIGKILL"); } catch { /* already dead */ }
  }
}

// =========================================================================
// shared process lifecycle
// =========================================================================

/**
 * Spawn a CLI backend, frame its stdout into lines, and honour timeout and
 * silence-watchdog bounds.  The caller decides what each line means (via
 * `parseLine`) and what happens to the job record (via `onLine`, `onWatchdog`).
 *
 * Two adapters share this lifecycle:
 *   - agy: prompt on argv, no stdin; `parseLine` = `parseAgyStreamLine`.
 *   - cursor: prompt on stdin, no argv payload; `parseLine` = `parseCursorStreamLine`.
 *
 * The `parseLine` function determines which lines are "parsed events" that
 * reset the silence clock.  Return non-null for events, null for noise.
 * Both `parseAgyStreamLine` and `parseCursorStreamLine` already have this
 * shape.
 *
 * @param {object} opts
 * @param {string} opts.bin — the binary to spawn.
 * @param {string[]} opts.args — command-line arguments.
 * @param {string} opts.cwd — working directory.
 * @param {object} [opts.env] — extra environment overrides applied on top of
 *        the parent env for the child (ADDITIVE, never a replacement).  The
 *        codex backend (kusabi #527) uses this to point HOME and CODEX_HOME
 *        at a job-owned directory so the child never inherits the operator's
 *        config/rules/sessions/MCP files.  Spawn-time only; the parent's
 *        process.env is untouched.
 * @param {string|null} [opts.promptText] — optional prompt to write to stdin.
 *        When present, stdin is a pipe the prompt is written to and closed.
 *        When absent/null, stdin is ignored (the prompt is on argv).
 * @param {number|null} [opts.timeoutS] — the outer timeout bound, already
 *        resolved by the caller.  A positive finite number arms this timer;
 *        anything else arms nothing (kusabi #328).
 * @param {number|null} [opts.watchdogS] — the silence watchdog bound, already
 *        resolved (and floored, for agy) by the caller.  A positive finite
 *        number arms the watchdog at that interval; anything else arms none.
 * @param {(info: {pid: number, startTime: string|null}) => void} [opts.onStart] — called with the
 *        child's pid and identity token the instant it exists, so `cancel` has a lever.
 * @param {(line: string) => void} [opts.onLine] — called with each complete
 *        stdout line, parsed or not; the caller folds parsed lines into its
 *        accumulator.  Wrapped: a stats-fold bug must never take down the
 *        dispatch.
 * @param {(event: {kind: "fired", silenceS: number}|{kind: "kill"}) => void}
 *        [opts.onWatchdog] — called with `{kind: "fired", silenceS}` the
 *        moment the watchdog expires (BEFORE the group kill, so the audit
 *        trail can never be lost to the kill) and with `{kind: "kill"}`
 *        after the kill.  Wrapped: an audit-trail failure must never take
 *        down the kill.
 * @param {(line: string) => object|null} opts.parseLine — returns non-null
 *        for parsed events (which reset the silence clock), null for noise.
 * @param {(ctl: {spawnedAt: number, now: () => number, kill: () => void, isKilled: () => boolean, addInterval: (fn: Function, ms: number) => NodeJS.Timeout, clearInterval: (timer: NodeJS.Timeout) => void}) => {onParsed?: (parsed: object) => void, onClose?: () => void}|void} [opts.extend]
 *        — optional adapter extension hook called immediately after spawn.
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string,
 *                     timedOut: boolean, stalled: boolean,
 *                     spawnError: Error|null }>}
 */
export function runBackendProcess({
  bin, args, cwd, promptText, timeoutS, watchdogS,
  env, onStart, onLine, onWatchdog, parseLine, extend,
}) {
  return new Promise((resolve) => {
    const hasStdin = typeof promptText === "string";
    const spawnedAt = Date.now();
    const child = spawn(bin, args, {
      cwd,
      // `env` overrides ride on top of the parent env (additive); the only
      // base marker every backend child carries is KUSABI_WORKER_CONTEXT.
      env: { ...process.env, KUSABI_WORKER_CONTEXT: "1", ...(env ?? {}) },
      stdio: [hasStdin ? "pipe" : "ignore", "pipe", "pipe"],
      // Own process group (session leader): the timeout/watchdog kill
      // targets the group, so the backend's children die with it.
      detached: true,
    });
    if (typeof onStart === "function" && child.pid) {
      const startTime = processStartToken(child.pid);
      try { onStart({ pid: child.pid, startTime }); } catch { /* best-effort */ }
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let stalled = false;
    let siblingKilled = false;
    let spawnError = null;
    let lineBuffer = "";
    // The silence clock starts at spawn, not at the first event: captured
    // before spawn() so a parent stalled during setup cannot shorten the
    // measured idle (kusabi #215 Job B item 3, #619).  A child that never
    // prints anything at all still trips the watchdog.
    let lastEventAt = spawnedAt;

    const extraIntervals = new Set();
    const ctl = {
      spawnedAt,
      now: () => Date.now(),
      kill: () => {
        siblingKilled = true;
        killProcessGroup(child);
      },
      isKilled: () => timedOut || stalled || siblingKilled,
      addInterval: (fn, ms) => {
        const timer = setInterval(fn, ms);
        extraIntervals.add(timer);
        return timer;
      },
      clearInterval: (timer) => {
        extraIntervals.delete(timer);
        globalThis.clearInterval(timer);
      },
    };

    let hooks = {};
    if (typeof extend === "function") {
      try {
        hooks = extend(ctl) ?? {};
      } catch {
        /* best-effort */
      }
    }

    // Delivers one complete NDJSON line to the caller and resets the
    // silence clock the watchdog measures against.  Only a PARSED event
    // resets the clock: an unparseable prose line is stream noise, not
    // activity — it must not masquerade as an event and hold the watchdog
    // off.
    function deliverLine(line) {
      const parsed = parseLine(line);
      if (parsed !== null) {
        lastEventAt = Date.now();
        if (typeof hooks.onParsed === "function") {
          try {
            hooks.onParsed(parsed);
          } catch {
            /* wrapped: a throw must not break line delivery */
          }
        }
      }
      if (typeof onLine === "function") {
        try { onLine(line); } catch { /* a stats-fold bug must not take down the dispatch */ }
      }
    }

    // Write the prompt to stdin when the caller supplies one (cursor pattern).
    // When no prompt is given, stdin is "ignore" and this block is skipped.
    if (hasStdin && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(promptText);
    }

    // UTF-8 decoding must be stream-level, not chunk-level: a multibyte
    // character split across two "data" chunks decodes to U+FFFD under
    // per-chunk toString(), corrupting the JSON line it sits in — and a
    // corrupted terminal result line is a lost run.  setEncoding routes
    // chunks through a StringDecoder that holds partial byte sequences back
    // until they complete.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      lineBuffer += chunk;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop(); // last element: an unterminated partial line, or ""
      for (const line of lines) deliverLine(line);
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => { spawnError = err; });

    // The SAME predicate both adapters use to decide arming (kusabi #328):
    // a positive finite number arms this timer, anything else arms nothing.
    // The caller is responsible for resolving and (when needed) flooring the
    // value before passing it in; this site does not re-resolve.
    const timer = isUsableTimeoutS(timeoutS)
      ? setTimeout(() => {
          // A run another bound already killed carries that bound's
          // diagnosis; the timeout must not relabel it in the moment between
          // the kill and the child's close.
          if (stalled || siblingKilled) return;
          timedOut = true;
          killProcessGroup(child);
        }, timeoutS * 1000)
      : null;

    // Silence watchdog: polled rather than a single deadline timer, since the
    // bound restarts on every parsed stream event.  250ms resolution keeps a
    // small test watchdog tight without meaningful overhead against real
    // multi-minute intervals.  The bound was already resolved by the caller;
    // re-checking here with isUsableTimeoutS keeps a direct call honest too.
    // Reports each step to the caller so the stall lands in the job's audit
    // trail AT THE MOMENT it is detected, not after the process has closed —
    // the "fired" notification runs BEFORE the group kill, so a failing trail
    // can never swallow the kill.  Wrapped: an audit-trail failure must never
    // take down the kill that is this watchdog's actual job.
    const notifyWatchdog = (event) => {
      if (typeof onWatchdog !== "function") return;
      try { onWatchdog(event); } catch { /* best-effort audit trail */ }
    };
    const watchdogTimer = isUsableTimeoutS(watchdogS)
      ? setInterval(() => {
          // `siblingKilled` joins the guard for one reason: once an adapter's
          // own watchdog (via `ctl.kill`) has killed the group the stream
          // stops, so silence would grow and this watchdog would report a
          // stall it did not cause (and overwrite the adapter's distinct
          // error text).  With no adapter kill, this reads exactly as it did
          // before (kusabi #215 item 3, #234).
          if (timedOut || stalled || siblingKilled) return;
          const silenceMs = Date.now() - lastEventAt;
          if (silenceMs > watchdogS * 1000) {
            stalled = true;
            clearInterval(watchdogTimer);
            // Measured silence, rounded to seconds — the same quantity the
            // opencode/claude watchdog reports, not the configured bound.
            notifyWatchdog({ kind: "fired", silenceS: Math.round(silenceMs / 1000) });
            killProcessGroup(child);
            notifyWatchdog({ kind: "kill" });
          }
        }, 250)
      : null;

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (watchdogTimer) clearInterval(watchdogTimer);
      for (const t of extraIntervals) globalThis.clearInterval(t);
      extraIntervals.clear();
      if (lineBuffer) deliverLine(lineBuffer);
      if (typeof hooks.onClose === "function") {
        try {
          hooks.onClose();
        } catch {
          /* best-effort */
        }
      }
      resolve({ code, stdout, stderr, timedOut, stalled, spawnError });
    });
  });
}
