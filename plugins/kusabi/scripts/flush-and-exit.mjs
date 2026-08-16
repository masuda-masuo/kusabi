// flush-and-exit.mjs — drain stdout/stderr, then exit with a code (kusabi #243).
//
// Lifted verbatim out of kusabi-companion.mjs by kusabi #277.  The behaviour is
// unchanged; what changed is what a *child process* pays to reach it.  The #243
// tests spawn `node --input-type=module -e 'import { flushAndExit } from
// <module>; process.stdout.write(<150KiB>); flushAndExit(code)'` and measure the
// whole thing against a wall-clock budget, so the child's import cost sits
// inside the measured window.  Importing the companion pulled its entire graph
// (~30 local modules) in before the child could write its first byte — under
// contention that doubled spawn-to-first-byte (measured: 300ms → 604ms with the
// box oversubscribed), which is pure noise in a test about draining a pipe, and
// from the parent a child that is still importing is indistinguishable from one
// that has hung.  This file's import graph is node builtins only, so the window
// measures the drain and nothing else.  kusabi-companion.test.mjs pins that
// property — keep the imports below `node:`-only, or the noise comes back.
//
// (The #277 CI flake itself turned out to be a race in the test collector, not
// here; its post-mortem is in the suite banner in kusabi-companion.test.mjs.)

import process from "node:process";

/**
 * Drain stdout and stderr, then process.exit(code).
 *
 * Piped stdout is buffered asynchronously. process.exit() drops whatever is
 * still in that buffer, so a payload over the pipe capacity (typically 64KiB)
 * arrives truncated mid-line (kusabi #243). File redirects write synchronously
 * and do not show the bug. An empty write's callback fires only after prior
 * chunks have been handed to the kernel — empirically the 200KiB delayed-pipe
 * case (`| (sleep 1; cat)`) delivers in full, while a bare process.exit() stops
 * at 65536. We still process.exit afterwards so leftover handles (serve
 * sockets/timers from ensureServer) cannot hang the process. TTY and file
 * dests typically invoke the callback on the next tick with no extra delay.
 *
 * `code` reaches exactly two places: process.exitCode, and the argument of the
 * one process.exit() call. Nothing below branches on its value, both drains are
 * started before either can finish, and the exit is reachable only after both
 * have settled. That is the whole answer to "does the non-zero path stall on a
 * full, paused pipe?" (kusabi #277, candidate B): a stall that hit exit 7 and
 * spared exit 0 has no mechanism here, because the two runs execute the same
 * statements in the same order with a different integer. Back-pressure from a
 * paused reader delays the callback for as long as the reader stays paused —
 * that is the flow control working, and it ends when the reader resumes,
 * whatever the code. The regression test for this is "drains an oversized,
 * full pipe identically for exit 0 and exit 7" in kusabi-companion.test.mjs,
 * which holds the reader shut until the child reports the whole payload still
 * queued, so both codes are measured against a genuinely full pipe.
 *
 * @param {number} code
 */
export function flushAndExit(code) {
  const exitCode = Number.isInteger(code) ? code : 1;
  process.exitCode = exitCode;

  let pending = 2;
  let exited = false;
  const done = () => {
    if (exited) return;
    pending -= 1;
    if (pending > 0) return;
    exited = true;
    process.exit(exitCode);
  };

  drainStream(process.stdout, done);
  drainStream(process.stderr, done);
}

/** @param {NodeJS.WriteStream} stream @param {() => void} cb */
function drainStream(stream, cb) {
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    cb();
  };

  if (!stream || typeof stream.write !== "function" || stream.destroyed || stream.writableFinished) {
    settle();
    return;
  }

  stream.once("error", settle);
  try {
    stream.write("", settle);
  } catch {
    settle();
  }
}
