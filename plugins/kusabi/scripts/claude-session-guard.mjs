// claude-session-guard.mjs — Pre-dispatch session-quota guard for Claude Code CLI (kusabi #215, #426).

import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

import { readJson, stateRoot } from "./state-paths.mjs";

// The refusal threshold used when the config names none.
export const CLAUDE_SESSION_GUARD_DEFAULT_PERCENT = 90;

// How long the /usage probe is given to answer before it is killed and the
// reading is treated as unreadable.  The measured wall time is ~450ms; the
// bound is short on purpose — this cost is paid by EVERY claude dispatch, and
// a probe that has to be waited out is a probe that already told us nothing.
// Overridable so tests can drive the timeout path without a 5s wait (mirrors
// KUSABI_CANCEL_KILL_WAIT_MS above).
const USAGE_PROBE_TIMEOUT_MS = 5000;
// Bound on how much of a rogue answer is kept in memory: the real one is a
// few hundred bytes.
const USAGE_PROBE_OUTPUT_CAP = 64 * 1024;

export function usageProbeTimeoutMs() {
  const raw = process.env.KUSABI_CLAUDE_USAGE_PROBE_TIMEOUT_MS;
  if (raw === undefined || raw === "") return USAGE_PROBE_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : USAGE_PROBE_TIMEOUT_MS;
}

/**
 * The kusabi config, read straight from the state root for the guard's own
 * use.  `claudeDispatch` is handed no config (the dispatch contract it shares
 * with `dispatchWithFallback` / `agyDispatch` carries none, and the chain
 * phases that call it never saw one), so the guard reads the ONE key it needs
 * itself rather than threading a config object through every phase.
 *
 * Read-only and fail-quiet: `readJson` returns null for a missing or
 * unparseable file.  A genuinely broken config never reaches here — every
 * command loads and validates it (loadConfig, kusabi-companion.mjs) before
 * any dispatch happens.
 *
 * @returns {object|null}
 */
export function loadClaudeGuardConfig() {
  return readJson(path.join(stateRoot(), "config.json"));
}

/**
 * The guard's settings for this dispatch.
 *
 * Config shape (documented in README.md, "Backends"):
 *
 *   { "claude": { "sessionGuardPercent": 90 } }
 *
 *   - key absent / true      → guard on at the default threshold (90)
 *   - a positive number      → guard on at that threshold
 *   - `false` / `0` / `<0`   → guard OFF: no probe at all, byte-identical to
 *                              the pre-#215 dispatch
 *   - anything unreadable    → guard on at the default threshold; a
 *                              malformed threshold must not silently switch
 *                              the guard off
 *
 * NO config file at all → guard OFF.  This is a real boundary, not an
 * oversight: the guard's threshold is an operator decision, and this dispatch
 * has no other channel to receive one, so a workspace that has never been
 * configured is left byte-identical to today.  Enable it with the two lines
 * above (or `"sessionGuardPercent": true` to take the default).
 *
 * @param {object|null|undefined} config — output of loadClaudeGuardConfig().
 * @returns {{ enabled: boolean, threshold: number|null, reason: string }}
 */
export function resolveClaudeSessionGuard(config) {
  if (config === null || config === undefined || typeof config !== "object" || Array.isArray(config)) {
    return { enabled: false, threshold: null, reason: "no-config" };
  }
  const raw = config.claude === null || typeof config.claude !== "object" || Array.isArray(config.claude)
    ? undefined
    : config.claude.sessionGuardPercent;
  if (raw === false) return { enabled: false, threshold: null, reason: "disabled" };
  if (raw === undefined || raw === null || raw === true) {
    return { enabled: true, threshold: CLAUDE_SESSION_GUARD_DEFAULT_PERCENT, reason: "default" };
  }
  const parsed = typeof raw === "number"
    ? raw
    : (typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN);
  if (!Number.isFinite(parsed)) {
    return { enabled: true, threshold: CLAUDE_SESSION_GUARD_DEFAULT_PERCENT, reason: "unreadable-setting" };
  }
  if (parsed <= 0) return { enabled: false, threshold: null, reason: "disabled" };
  return { enabled: true, threshold: parsed, reason: "configured" };
}

/**
 * The probe invocation, exactly as it was measured (kusabi #215): the bare
 * `/usage` slash command through `-p`, with the json envelope so the prose
 * arrives in a named field instead of mixed into raw stdout.  Nothing else is
 * passed — no --model (it is not consulted), no MCP config, no allow/deny
 * lists: this is a control-plane call, and every flag added here is a flag
 * that can make it fail.
 *
 * @returns {string[]}
 */
export function claudeUsageProbeArgs() {
  return ["-p", "--output-format", "json", "/usage"];
}

// "Current session: 41% used" — the ONLY line this guard reads.  Anchored on
// the two words together so a weekly line ("Current week (Fable): 42% used")
// can never be mistaken for it.
const SESSION_USAGE_RE = /current\s+session\s*:\s*([0-9]{1,3}(?:\.[0-9]+)?)\s*%\s*used/i;

/**
 * The session usage percentage, and the reset time named next to it, from a
 * /usage answer.
 *
 * Accepts either the `--output-format json` envelope (prose in `result`) or
 * bare prose — the shape has no contract, so neither is assumed.  Anything
 * that does not carry a "Current session: NN% used" reading returns
 * `{ percent: null }`, which the caller treats as "could not read the quota"
 * and proceeds.
 *
 * @param {string} text — the probe's stdout.
 * @returns {{ percent: number|null, reset: string|null }}
 */
export function parseClaudeSessionUsage(text) {
  const raw = typeof text === "string" ? text : "";
  let prose = raw;
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed !== null && typeof parsed === "object" && typeof parsed.result === "string") {
      prose = parsed.result;
    }
  } catch { /* not the json envelope: read the raw text */ }
  const m = prose.match(SESSION_USAGE_RE);
  if (!m) return { percent: null, reset: null };
  const percent = Number(m[1]);
  if (!Number.isFinite(percent)) return { percent: null, reset: null };
  return { percent, reset: sessionResetFrom(prose, m.index) };
}

/**
 * The "resets <when>" phrase from the SAME line the session reading was found
 * on — never a neighbouring weekly line, whose reset is a different window
 * (and days away).
 *
 * @param {string} prose
 * @param {number} matchIndex — index of the session reading inside `prose`.
 * @returns {string|null}
 */
function sessionResetFrom(prose, matchIndex) {
  const lineStart = prose.lastIndexOf("\n", matchIndex) + 1;
  const lineEnd = prose.indexOf("\n", matchIndex);
  const line = prose.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  const m = line.match(/resets?\s+(?:at\s+)?(.+?)\s*$/i);
  return m ? m[1].trim() : null;
}

function killProcessGroup(child) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

/**
 * Run the /usage probe and report what it said — or why nothing could be
 * read.  NEVER rejects: every failure mode resolves to `readable: false`,
 * because the caller's only correct response to a broken probe is to proceed.
 *
 * The child runs in its OWN process group and a probe that has to be killed
 * takes that whole group with it, exactly like the worker spawn: a
 * control-plane call must not leave anything running in the operator's
 * session.
 *
 * @param {object} opts
 * @param {string} opts.bin — the resolved claude binary (claudeBin()).
 * @param {string} [opts.cwd]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ readable: true, percent: number, reset: string|null, reason: null,
 *                     detail: null, elapsedMs: number }
 *                  | { readable: false, percent: null, reset: null,
 *                      reason: "spawn-failed"|"timeout"|"exit-nonzero"|"unparsed",
 *                      detail: string, elapsedMs: number }>}
 */
export function probeClaudeSessionUsage({ bin, cwd, timeoutMs = usageProbeTimeoutMs() } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const unreadable = (reason, detail) => resolve({
      readable: false, percent: null, reset: null, reason, detail,
      elapsedMs: Date.now() - startedAt,
    });

    let child;
    try {
      child = spawn(bin, claudeUsageProbeArgs(), {
        cwd,
        // The probe must see the operator's environment: `claude` resolves its
        // credentials from it exactly as the worker does.
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch (err) {
      unreadable("spawn-failed", err.message);
      return;
    }

    let stdout = "";
    let stderr = "";
    let spawnError = null;
    let timedOut = false;

    if (child.stdin) {
      child.stdin.on("error", () => {});
      // The probe's prompt is on argv, so stdin is closed at once: the real
      // CLI otherwise waits on it and warns after 3s, which would double the
      // guard's cost for nothing.
      child.stdin.end("");
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { if (stdout.length < USAGE_PROBE_OUTPUT_CAP) stdout += chunk; });
    child.stderr.on("data", (chunk) => { if (stderr.length < USAGE_PROBE_OUTPUT_CAP) stderr += chunk; });
    child.on("error", (err) => { spawnError = err; });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child);
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (spawnError) {
        unreadable("spawn-failed", `could not start ${bin}: ${spawnError.message}`);
        return;
      }
      if (timedOut) {
        unreadable("timeout", `${bin} /usage did not answer within ${timeoutMs}ms (killed)`);
        return;
      }
      if (code !== 0) {
        const detail = (stderr || stdout || "(no output)").trim().slice(0, 300);
        unreadable("exit-nonzero", `${bin} /usage exited with code ${code}: ${detail}`);
        return;
      }
      const { percent, reset } = parseClaudeSessionUsage(stdout);
      if (percent === null) {
        unreadable("unparsed", `no "Current session: NN% used" reading in: ${stdout.trim().slice(0, 300) || "(empty stdout)"}`);
        return;
      }
      resolve({ readable: true, percent, reset, reason: null, detail: null, elapsedMs: Date.now() - startedAt });
    });
  });
}

/**
 * Fold the guard's settings and the probe's answer into the observation that
 * is persisted on the job record and on the events trail — and the decision.
 *
 * A refused dispatch and a mid-run quota death must never be confusable in
 * the record, and a dispatch that ran PAST the guard has to show what the
 * guard knew when it let it through (including "nothing").  Pure, so the
 * threshold semantics are testable without a subprocess.
 *
 * @param {{threshold: number}} guard — output of resolveClaudeSessionGuard.
 * @param {object} probe — output of probeClaudeSessionUsage.
 * @param {string} [now]
 * @returns {{ threshold: number, percent: number|null, reset: string|null,
 *             readable: boolean, reason: string|null, detail: string|null,
 *             decision: "refused"|"proceeded", observedAt: string,
 *             probeMs: number|null }}
 */
export function claudeSessionGuardObservation(guard, probe, now = new Date().toISOString()) {
  // `>=`: at the threshold the window is already as spent as the operator
  // said they were willing to start into.
  const refuse = probe.readable === true && probe.percent >= guard.threshold;
  return {
    threshold: guard.threshold,
    percent: probe.readable ? probe.percent : null,
    reset: probe.readable ? probe.reset : null,
    readable: probe.readable === true,
    reason: probe.readable ? null : (probe.reason ?? "unknown"),
    detail: probe.readable ? null : (probe.detail ?? null),
    decision: refuse ? "refused" : "proceeded",
    observedAt: now,
    probeMs: typeof probe.elapsedMs === "number" ? probe.elapsedMs : null,
  };
}

/**
 * The detail line the refusal's error text is built around: it must be
 * unmistakably a PRE-dispatch refusal (nothing ran, nothing was spent), and
 * it must carry the measured number and the threshold that rejected it.  The
 * surrounding session-limit advice comes from renderClaudeQuotaError — the
 * same wording a mid-run session limit prints, because the operator's next
 * move is identical.
 *
 * @param {{percent: number, threshold: number}} observation
 * @returns {string}
 */
export function renderClaudeSessionGuardRefusal(observation) {
  return (
    `pre-dispatch session-quota guard refused this dispatch — /usage reports ` +
    `${observation.percent}% of the claude session window already used ` +
    `(refuse at ${observation.threshold}%). No worker was started: this job spent nothing, ` +
    `and the run did not fail mid-flight`
  );
}
