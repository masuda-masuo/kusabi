// kaiba-progress-retire.mjs — job-scoped kaiba progress retirement helper
// (kusabi #497 / kaiba#33).
//
// kaiba PR#34 exposes a synchronous one-shot CLI:
//
//     kaiba-progress-retire --job <id>
//
// It exact-matches `progress.job`, leaves NULL/other-job rows untouched, is
// idempotent, rejects ids outside `^[a-zA-Z0-9_-]+$`, and returns nonzero on a
// missing/wrong/unopenable DB. kusabi never touches kaiba's database directly
// — this helper is the ONLY invocation path, and it never throws to callers.
//
// The configured binary comes from env.KAIBA_RETIRE_BIN (deployment/tests) and
// defaults to the `kaiba-progress-retire` name resolved on env.PATH. A missing
// executable (ENOENT) is a SILENT fail-soft no-op — an operator without the
// kaiba CLI installed must not see retirement noise; a nonzero exit, timeout,
// or other spawn failure is the actionable failure call sites record.
//
// Job ids are validated with the same policy as `applyWorkerKaibaIdentity`
// (claude-mcp.mjs): `^[a-zA-Z0-9_-]+$`. Invalid/empty ids never spawn.
// `KUSABI_KAIBA_RETIRE=0` disables retirement entirely (hermetic fixtures and
// shared-backend operators who prefer TTL cleanup).

import { spawnSync } from "node:child_process";

// Same pattern `applyWorkerKaibaIdentity` uses for KAIBA_JOB.
export const KAIBA_JOB_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

// Bounded default: retirement is synchronous at authoritative terminal
// boundaries, so the child must not be able to stall a terminalization.
export const DEFAULT_RETIRE_TIMEOUT_MS = 5000;

/**
 * Retire one job's kaiba progress rows through the kaiba one-shot CLI.
 * Synchronous (spawnSync), job-scoped, idempotent, fail-soft — NEVER throws.
 *
 * @param {object} opts
 * @param {unknown} opts.jobId — must be a string matching ^[a-zA-Z0-9_-]+$
 * @param {NodeJS.ProcessEnv} [opts.env=process.env]
 * @param {number} [opts.timeoutMs=DEFAULT_RETIRE_TIMEOUT_MS]
 * @returns {{
 *   skipped: boolean,   // nothing spawned (opt-out / invalid id / ENOENT)
 *   ok: boolean,        // spawned and exited 0
 *   code: number|null,  // exit code when spawned
 *   timedOut: boolean,  // bounded timeout killed the child
 *   error: string|null, // non-ENOENT spawn failure message
 * }}
 */
export function retireJobProgress({ jobId, env = process.env, timeoutMs = DEFAULT_RETIRE_TIMEOUT_MS }) {
  try {
    const effectiveEnv = env ?? process.env;
    // Operator opt-out: hermetic fixtures and operators who prefer TTL cleanup.
    if (effectiveEnv?.KUSABI_KAIBA_RETIRE === "0") {
      return { skipped: true, ok: true, code: null, timedOut: false, error: null };
    }
    // Invalid/empty ids never spawn — same policy as applyWorkerKaibaIdentity.
    if (typeof jobId !== "string" || !KAIBA_JOB_ID_PATTERN.test(jobId)) {
      return { skipped: true, ok: true, code: null, timedOut: false, error: null };
    }
    const bin =
      typeof effectiveEnv?.KAIBA_RETIRE_BIN === "string" && effectiveEnv.KAIBA_RETIRE_BIN.trim() !== ""
        ? effectiveEnv.KAIBA_RETIRE_BIN.trim()
        : "kaiba-progress-retire";
    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_RETIRE_TIMEOUT_MS;
    const res = spawnSync(bin, ["--job", jobId], { env: effectiveEnv, timeout, encoding: "utf8" });
    if (res.error) {
      if (res.error.code === "ENOENT") {
        // Missing executable: silent fail-soft no-op.
        return { skipped: true, ok: true, code: null, timedOut: false, error: null };
      }
      if (res.error.code === "ETIMEDOUT") {
        // Bounded timeout killed the child (spawnSync also reports
        // signal=SIGTERM here). Actionable: the kaiba CLI hung.
        return { skipped: false, ok: false, code: null, timedOut: true, error: null };
      }
      // Real deployment failure (EACCES, EMFILE, ...): observable, never fatal.
      return {
        skipped: false,
        ok: false,
        code: null,
        timedOut: false,
        error: res.error.message ?? String(res.error),
      };
    }
    return { skipped: false, ok: res.status === 0, code: res.status, timedOut: false, error: null };
  } catch (err) {
    // Never throws to callers, no matter what.
    return {
      skipped: false,
      ok: false,
      code: null,
      timedOut: false,
      error: err?.message ?? String(err),
    };
  }
}