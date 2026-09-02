// chain-quota.mjs — Quota classification and recorded-failure / explicit-route
// helpers for cmdChain (kusabi #453).
//
// Pure predicates and formatters for classifying dispatch failures as quota
// exhaustion, printing quota-exhaustion reasons, refusing replacement seats
// without route change, and reading/checking quota state on round records.
//
// Does not import chain-phases.mjs, kusabi-companion.mjs, chain-driver.mjs,
// chain-finish.mjs, chain-cmd.mjs, chain-run.mjs, chain-review.mjs, or
// chain-resume-resolve.mjs.

import {
  resolveModelBackend,
} from "./cli.mjs";

// =========================================================================
// Dispatch-failure quota classification (kusabi #373)
//
// A review (or implement) job that produced NO payload is not an unreadable
// verdict: `verdict: unparseable` means a payload arrived and could not be
// read.  When the backend named a quota-exhausted pool in the failure text,
// the round record must carry that as its own field so chain-show and
// chain-resume can tell the two failures apart without opening job.json.
//
// Classify ONLY phrases that have been observed.  A false positive here
// hard-stops a chain that could have continued (agy-dispatch.mjs documents
// the same principle for its own quota handling).
// Observed:
//   agy:      "Individual quota reached. Please upgrade your subscription
//              to increase your limits. Resets in 1h1m21s."
//   opencode: "Free usage exceeded, subscribe to Go"
// Claude already classifies from the structured payload (kusabi #215) and
// writes job.failure; this layer fills in when the adapter left failure null.
// =========================================================================

const AGY_QUOTA_MARKER = "Individual quota reached";
const OPENCODE_QUOTA_MARKER = "Free usage exceeded";

/**
 * Classify a dispatch-failure text as quota exhaustion of a named backend.
 * Returns null when the text does not contain an observed phrase.
 *
 * @param {string|null|undefined} errorText
 * @returns {null | {
 *   kind: "quota-exhaustion",
 *   backend: "agy" | "opencode",
 *   quota: "individual" | "free-tier",
 *   backendBlocked: boolean,
 *   reset: string | null,
 * }}
 */
export function classifyDispatchQuotaExhaustion(errorText) {
  if (typeof errorText !== "string" || errorText.length === 0) return null;
  if (errorText.includes(AGY_QUOTA_MARKER)) {
    const resetMatch = errorText.match(/Resets in ([^\s.]+)/);
    return {
      kind: "quota-exhaustion",
      backend: "agy",
      quota: "individual",
      backendBlocked: true,
      reset: resetMatch ? resetMatch[1] : null,
    };
  }
  if (errorText.includes(OPENCODE_QUOTA_MARKER)) {
    return {
      kind: "quota-exhaustion",
      backend: "opencode",
      quota: "free-tier",
      backendBlocked: true,
      reset: null,
    };
  }
  return null;
}

/**
 * The escalate reason chain-show prints for a quota-exhausted review seat.
 * Named so the digest never reads as `unexpected verdict: unparseable`.
 *
 * @param {object} failure — `{ kind: "quota-exhaustion", ... }`
 * @returns {string}
 */
export function quotaExhaustionReason(failure) {
  const backend = failure?.backend || "provider";
  const pool = failure?.quota === "free-tier"
    ? "free-tier pool"
    : failure?.quota === "individual"
      ? "individual pool"
      : failure?.quota
        ? failure.quota + " pool"
        : "pool";
  const reset = failure?.reset
    ? (/^\d/.test(String(failure.reset)) ? "; resets in " + failure.reset : "; resets " + failure.reset)
    : "";
  return "quota exhausted (" + backend + " " + pool + ")" + reset;
}

/**
 * chain-resume refusal when the recorded failure was quota exhaustion and
 * the operator did not name a different route.
 *
 * @param {object} failure
 * @returns {string}
 */
export function quotaReplacementRefusal(failure) {
  const backend = failure?.backend || "the current backend";
  const quota = failure?.quota ? " (" + failure.quota + ")" : "";
  return (
    "review seat died of quota exhaustion on " + backend + quota +
    ". Buying the same seat cannot work. Route the replacement with " +
    "--backend opencode|claude|agy|cursor or --model <id> (a different backend or model)."
  );
}

/**
 * The structured quota-exhaustion fact on a round record, or null.
 *
 * @param {object|null|undefined} record
 * @returns {object|null}
 */
export function recordQuotaExhaustion(record) {
  const failure = record?.reviewJobFailure;
  if (failure && failure.kind === "quota-exhaustion") return failure;
  return null;
}

/**
 * True when the operator named a model or backend that is not the recorded
 * review seat's route — the one case where buying a replacement after quota
 * exhaustion can work.
 *
 * @param {object} record
 * @param {{ backend?: string|null, model?: string|null }|null|undefined} explicitRoute
 * @returns {boolean}
 */
export function explicitRouteDiffersFromRecord(record, explicitRoute) {
  if (!explicitRoute || typeof explicitRoute !== "object") return false;
  const recordedBackend = record.reviewBackend ?? record.backend ?? "opencode";
  if (explicitRoute.backend && explicitRoute.backend !== recordedBackend) return true;
  if (explicitRoute.model) {
    let spec;
    try {
      spec = resolveModelBackend(explicitRoute.model);
    } catch {
      spec = null;
    }
    if (spec?.backend && spec.backend !== recordedBackend) return true;
    const recordedModel = record.reviewModelEntry ?? "";
    const wanted = spec?.model ?? explicitRoute.model;
    if (wanted && wanted !== recordedModel && explicitRoute.model !== recordedModel) return true;
  }
  return false;
}
