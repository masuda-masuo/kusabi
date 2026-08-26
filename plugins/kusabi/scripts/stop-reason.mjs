// stop-reason.mjs — the closed terminal-reason union for worker jobs.
//
// A dispatched worker job (or a chain round's implement job) ends in exactly
// one of a CLOSED set of terminal reasons.  This module is the single source
// of truth for that set and the pure derivation function every writer calls
// and every consumer reads.  No mapping logic lives anywhere else.
//
// `unknown` is the failure sentinel.  It is deliberately NOT a member of
// STOP_REASONS: it is the bucket for statuses a writer could not classify
// (serve-dead / timeout / stalled / error / anything future).  Consumers must
// count `unknown` as a failure — never silently fold it into `completed`.
//
// Design notes (kusabi #380):
//   - The CALLER classifies capacity.  `deriveStopReason` does not know the
//     list of capacity reasons; the caller passes `capacityReason` non-null
//     iff the fail-fast reason is a member of that list.  This keeps the
//     closed set free of provider-specific strings and covers future members
//     automatically.
//   - Substance at job level: a completed wrapper whose writer has no
//     substance measurement (`worktreeChanged === null`) records `completed`.
//     The chain layer, which DOES measure substance per round, passes
//     `worktreeChanged` so empty rounds record `infra-death` /
//     `empty-completion`.

/** The closed set of terminal reasons a worker can end with. */
export const STOP_REASONS = Object.freeze([
  "completed",
  "provider-error",
  "quota-exhausted",
  "empty-completion",
  "cancelled",
  "infra-death",
]);

/** Failure sentinel for an unmappable / future status. Not in STOP_REASONS. */
export const UNKNOWN_STOP_REASON = "unknown";

/**
 * Derive the closed terminal reason for a worker job (or round) from the
 * structured inputs a writer already holds.  Pure — no I/O.
 *
 * Every consumer branch that switches on a stop reason must treat values
 * outside its known set as a failure (never skip them).
 *
 * @param {object} [input]
 * @param {string|null}  [input.capacityReason]  — the fail-fast capacity
 *   reason string (e.g. "free_tier_limit"), or null.  Non-null ⇒
 *   "quota-exhausted" and wins over any terminal provider error.
 * @param {object|null}  [input.providerError]  — `{ reason, terminal, ... }`
 *   or null.  A terminal provider error (terminal === true) ⇒ "provider-error".
 * @param {boolean}      [input.cancelled]      — explicit cancel flag.
 * @param {string|null}  [input.status]         — job.status / round status.
 * @param {object|null}  [input.stats]          — `{ steps, ... }` (steps is
 *   the step count; 0 distinguishes infra-death from empty-completion).
 * @param {boolean|null} [input.worktreeChanged] — substance signal:
 *   true / false / null(unmeasured).  Only consulted for a completed status.
 * @returns {string} one of STOP_REASONS or UNKNOWN_STOP_REASON.
 */
export function deriveStopReason(input) {
  const {
    capacityReason = null,  // fail-fast capacity reason string, or null
    providerError = null,   // { reason, terminal, ... } or null
    cancelled = false,
    status = null,          // job.status
    stats = null,          // { steps, ... }
    worktreeChanged = null, // substance signal: true/false/null(unmeasured)
  } = input || {};

  if (cancelled || status === "cancelled") return "cancelled";
  if (capacityReason) return "quota-exhausted";
  if (providerError && providerError.terminal) return "provider-error";
  if (status === "provider-error") return "provider-error";
  if (status === "completed") {
    const steps = (stats && typeof stats.steps === "number") ? stats.steps : 0;
    if (worktreeChanged === true) return "completed";
    if (worktreeChanged === false) {
      return steps === 0 ? "infra-death" : "empty-completion";
    }
    // substance unmeasured at job level: a completed wrapper alone is still "completed"
    return "completed";
  }
  // serve-dead, timeout, stalled, error, and anything future/unforeseen:
  return UNKNOWN_STOP_REASON;
}
