// audit-policy.mjs — deterministic Sol audit gate policy (kusabi #524 slice 3, #528)
//
// Pure, versioned, replayable decision of WHEN a Sol seat must audit a gate.
// The driver calls it; Luna never does.  No I/O, no Math.random, no model
// interpretation: every trigger is derived from an explicitly normalized
// input contract (below), so the same input always yields the same result in
// any process, locale, or platform, and the recorded input is sufficient to
// re-derive every trigger decision offline.
//
// The input contract is deliberately normalized rather than parsed:
//
//   evaluateAuditGate({
//     gateId: string,                  // REQUIRED — stable gate id ("gate-1")
//     changeScope: {                   // normalized changed paths, repo-relative
//       added: string[],               // paths added this round
//       deleted: string[],             // paths deleted this round
//       modified: string[],            // paths modified this round
//     },
//     testChanges: {                   // normalized test signals (T6)
//       deleted: string[],             // test paths deleted
//       weakened: string[],            // test paths weakened (assertions removed, xfail)
//       skipped: string[],             // test paths skipped (.skip / disabled)
//     },
//     verifySkipped: boolean,          // T7 — the verify gate was skipped
//     verifySkipFlags: string[],       // T7 — the skip flag names (e.g. ["--skip-lint-gate"])
//     reworkCount: number,             // T8 — rework rounds already spent (0 = first attempt)
//     findings: Array<{severity: "critical"|"high"|"medium"|"low"}>,
//                                      // T9 — normalized review findings
//     terminalDisposition: string|null,// T10 — the terminal chain disposition
//                                      //   (accept, accept-with-followup, escalate,
//                                      //   refused-brief-defect, max-rounds, sol-blocked,
//                                      //   strategize, rework)
//     lunaRecommendsAccept: boolean,   // T11
//     issue: { causalHypothesis: boolean },
//                                      // T1 — the issue states a causal hypothesis
//     noFixClosure: boolean,           // T2 — the chain closed having changed no files
//     sampling: {                      // T12 — reproducible sampling
//       missionId: string,             //   the mission id
//       rate: number,                  //   sampling rate in [0, 1]
//       salt: string,                  //   a fixed salt, e.g. "v1"
//     },
//     publish: boolean,                // T13 — a pre-publish gate (host-only/advisory in v1)
//   })
//
// Unknown input keys, wrong types, out-of-range values and underspecified
// required fields all throw a descriptive Error instead of guessing.

import { createHash } from "node:crypto";

/** Policy version.  Bump when a trigger, a threshold, or a prefix set changes. */
export const AUDIT_POLICY_VERSION = 1;

/** The trigger ids in the order they are evaluated and reported. */
export const AUDIT_GATE_TRIGGERS = [
  "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11", "T12", "T13",
];

/**
 * Path prefixes counted as "public API or schema" surface under policy v1
 * (the `audit.publicApiPaths` defaults from the accepted #524 design).  A NEW
 * file added under one of these prefixes triggers T3.
 */
export const PUBLIC_API_PATH_PREFIXES = ["plugins/kusabi/schemas/", "docs/design/"];

/** The design-document tree.  Any change (added/deleted/modified) triggers T5. */
export const DESIGN_DOC_PREFIX = "docs/design/";

/**
 * The chain dispositions that name an escalation-family ending (T10).  These
 * are the terminal endings that say "this round did not simply finish": the
 * chain escalated, was refused as a brief defect, or ran out of rounds.
 */
export const ESCALATION_FAMILY_DISPOSITIONS = new Set([
  "escalate",
  "refused-brief-defect",
  "max-rounds",
]);

/**
 * The full chain-disposition vocabulary, used to fail loud on a misspelled
 * `terminalDisposition` instead of silently never firing T10.
 */
export const CHAIN_DISPOSITIONS = new Set([
  "accept",
  "accept-with-followup",
  "escalate",
  "refused-brief-defect",
  "max-rounds",
  "sol-blocked",
  "strategize",
  "rework",
]);

/** T8 fires from the first rework onward (a "repeated" attempt). */
export const REPEATED_RETRY_MIN_REWORK = 1;

/** The review severity vocabulary findings may carry (T9). */
export const FINDING_SEVERITIES = ["critical", "high", "medium", "low"];

const TOP_LEVEL_KEYS = [
  "gateId", "changeScope", "testChanges", "verifySkipped", "verifySkipFlags",
  "reworkCount", "findings", "terminalDisposition", "lunaRecommendsAccept",
  "issue", "noFixClosure", "sampling", "publish",
];

function fail(message) {
  throw new Error(`audit-policy: ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireStringArray(value, what) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${what} must be an array of repo-relative paths`);
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "") {
      fail(`${what} entries must be non-empty strings`);
    }
  }
  return value;
}

function requireBoolean(value, what) {
  if (value === undefined) return false;
  if (typeof value !== "boolean") fail(`${what} must be a boolean`);
  return value;
}

/**
 * Validate and normalize the evaluator input.  Throws on invalid or
 * underspecified input; returns a fully normalized copy with defaults filled.
 *
 * @param {object} input
 * @returns {object} normalized input
 */
export function validateAuditGateInput(input) {
  if (!isPlainObject(input)) fail("input must be an object");
  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      fail(`unknown input key: ${key}`);
    }
  }

  const gateId = input.gateId;
  if (typeof gateId !== "string" || gateId.trim() === "") {
    fail("gateId is required and must be a non-empty string");
  }

  const normalized = { gateId };

  // changeScope — normalized changed-path lists.
  if (input.changeScope !== undefined) {
    if (!isPlainObject(input.changeScope)) fail("changeScope must be an object");
    for (const key of Object.keys(input.changeScope)) {
      if (key !== "added" && key !== "deleted" && key !== "modified") {
        fail(`unknown changeScope key: ${key}`);
      }
    }
    normalized.changeScope = {
      added: requireStringArray(input.changeScope.added, "changeScope.added"),
      deleted: requireStringArray(input.changeScope.deleted, "changeScope.deleted"),
      modified: requireStringArray(input.changeScope.modified, "changeScope.modified"),
    };
  } else {
    normalized.changeScope = { added: [], deleted: [], modified: [] };
  }

  // testChanges — normalized test-related signals (T6).
  if (input.testChanges !== undefined) {
    if (!isPlainObject(input.testChanges)) fail("testChanges must be an object");
    for (const key of Object.keys(input.testChanges)) {
      if (key !== "deleted" && key !== "weakened" && key !== "skipped") {
        fail(`unknown testChanges key: ${key}`);
      }
    }
    normalized.testChanges = {
      deleted: requireStringArray(input.testChanges.deleted, "testChanges.deleted"),
      weakened: requireStringArray(input.testChanges.weakened, "testChanges.weakened"),
      skipped: requireStringArray(input.testChanges.skipped, "testChanges.skipped"),
    };
  } else {
    normalized.testChanges = { deleted: [], weakened: [], skipped: [] };
  }

  // verify (T7).
  normalized.verifySkipped = requireBoolean(input.verifySkipped, "verifySkipped");
  normalized.verifySkipFlags = requireStringArray(input.verifySkipFlags, "verifySkipFlags");

  // reworkCount (T8).
  if (input.reworkCount !== undefined) {
    if (!Number.isInteger(input.reworkCount) || input.reworkCount < 0) {
      fail("reworkCount must be a non-negative integer");
    }
    normalized.reworkCount = input.reworkCount;
  } else {
    normalized.reworkCount = 0;
  }

  // findings (T9).
  if (input.findings !== undefined) {
    if (!Array.isArray(input.findings)) fail("findings must be an array");
    for (const finding of input.findings) {
      if (!isPlainObject(finding)) fail("each finding must be an object");
      if (!FINDING_SEVERITIES.includes(finding.severity)) {
        fail(`finding severity must be one of ${FINDING_SEVERITIES.join(", ")}`);
      }
    }
    normalized.findings = [...input.findings];
  } else {
    normalized.findings = [];
  }

  // terminalDisposition (T10).
  if (input.terminalDisposition !== undefined && input.terminalDisposition !== null) {
    if (typeof input.terminalDisposition !== "string" || input.terminalDisposition.trim() === "") {
      fail("terminalDisposition must be a non-empty string or null");
    }
    if (!CHAIN_DISPOSITIONS.has(input.terminalDisposition)) {
      fail(`unknown terminalDisposition: ${input.terminalDisposition}`);
    }
    normalized.terminalDisposition = input.terminalDisposition;
  } else {
    normalized.terminalDisposition = null;
  }

  // lunaRecommendsAccept (T11).
  normalized.lunaRecommendsAccept = requireBoolean(input.lunaRecommendsAccept, "lunaRecommendsAccept");

  // issue (T1).
  if (input.issue !== undefined) {
    if (!isPlainObject(input.issue)) fail("issue must be an object");
    for (const key of Object.keys(input.issue)) {
      if (key !== "causalHypothesis") fail(`unknown issue key: ${key}`);
    }
    if (input.issue.causalHypothesis !== undefined &&
        typeof input.issue.causalHypothesis !== "boolean") {
      fail("issue.causalHypothesis must be a boolean");
    }
    normalized.issue = { causalHypothesis: input.issue.causalHypothesis === true };
  } else {
    normalized.issue = { causalHypothesis: false };
  }

  // noFixClosure (T2).
  normalized.noFixClosure = requireBoolean(input.noFixClosure, "noFixClosure");

  // sampling (T12) — validated by sampleDecision itself.
  if (input.sampling !== undefined) {
    if (!isPlainObject(input.sampling)) fail("sampling must be an object");
    for (const key of Object.keys(input.sampling)) {
      if (key !== "missionId" && key !== "rate" && key !== "salt") {
        fail(`unknown sampling key: ${key}`);
      }
    }
    sampleDecision(
      input.sampling.missionId,
      input.sampling.rate,
      input.sampling.salt,
    );
    normalized.sampling = {
      missionId: input.sampling.missionId,
      rate: input.sampling.rate,
      salt: input.sampling.salt,
    };
  } else {
    normalized.sampling = null;
  }

  // publish (T13).
  normalized.publish = requireBoolean(input.publish, "publish");

  return normalized;
}

/**
 * Reproducible sampling decision (T12).  SHA-256 of the mission id and salt;
 * never Math.random.  Identical inputs produce identical outputs in any
 * process, locale, or platform.
 *
 * The hash is read as an unsigned 32-bit integer and scaled to [0, 1); the
 * sample fires when that fraction is strictly below `rate`.  Boundary rates
 * therefore fall out of the arithmetic: 0 never samples, 1 always samples.
 *
 * @param {string} missionId — non-empty mission id (the sample unit).
 * @param {number} rate — sampling rate in [0, 1]; 0 = never, 1 = always.
 * @param {string} salt — non-empty salt, e.g. "v1", so a re-seeded run can
 *   draw a different sample without changing the id.
 * @returns {boolean} whether this mission is sampled into the audit.
 */
export function sampleDecision(missionId, rate, salt) {
  if (typeof missionId !== "string" || missionId.trim() === "") {
    fail("sampleDecision: missionId must be a non-empty string");
  }
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 1) {
    fail("sampleDecision: rate must be a finite number in [0, 1]");
  }
  if (typeof salt !== "string" || salt.trim() === "") {
    fail("sampleDecision: salt must be a non-empty string");
  }
  if (rate === 0) return false;
  if (rate === 1) return true;

  // Only the mission id and salt are hashed; the rate sets the THRESHOLD the
  // scaled hash is compared against.  That keeps sampling monotone in the
  // rate (raising the rate can only add missions, never remove one) and means
  // a config change never reshuffles the whole sample.
  const text = `${missionId}\u0000${salt}`;
  const digest = createHash("sha256").update(text).digest("hex");
  const bucket = parseInt(digest.slice(0, 8), 16); // 0 .. 2^32-1
  return bucket / 0x100000000 < rate;
}

/** All paths named by the change scope, for prefix-trigger matching (T5). */
function allChangedPaths(changeScope) {
  return [
    ...changeScope.added,
    ...changeScope.deleted,
    ...changeScope.modified,
  ];
}

/**
 * The deterministic Sol audit gate decision.
 *
 * @param {object} input — see the module contract above.
 * @returns {{
 *   required: boolean,       // a Sol audit gate is needed at all
 *   gateId: string,          // echoed from the input
 *   triggers: Array<{id: string, detail: string}>,  // matching triggers, T1..T13 order
 *   sampled: boolean,        // T12 fired (this gate was reached via sampling)
 *   mandatory: boolean,      // any trigger OTHER than T12 fired — the gate
 *                            //   fails closed; sampled-only gates are the sole
 *                            //   deliberate fail-open (Sol unavailable).
 *   policyVersion: number,
 * }}
 */
export function evaluateAuditGate(input) {
  const v = validateAuditGateInput(input);
  const triggers = [];

  // T1 — causal hypothesis in the issue.
  if (v.issue.causalHypothesis) {
    triggers.push({
      id: "T1",
      detail: "the issue states a causal hypothesis, which an independent auditor should test",
    });
  }

  // T2 — no-fix closure: the chain closed having changed no files.
  if (v.noFixClosure) {
    triggers.push({
      id: "T2",
      detail: "the chain closed without changing any files (no-fix closure)",
    });
  }

  // T3 — new public API or schema path added.
  const addedPublic = v.changeScope.added.filter((p) =>
    PUBLIC_API_PATH_PREFIXES.some((prefix) => p.startsWith(prefix)),
  );
  if (addedPublic.length > 0) {
    triggers.push({
      id: "T3",
      detail: `new public API/schema path(s) added: ${addedPublic.join(", ")}`,
    });
  }

  // T4 — new files.
  if (v.changeScope.added.length > 0) {
    triggers.push({
      id: "T4",
      detail: `${v.changeScope.added.length} new file(s): ${v.changeScope.added.join(", ")}`,
    });
  }

  // T5 — design-document change.
  const designChanged = allChangedPaths(v.changeScope).filter((p) => p.startsWith(DESIGN_DOC_PREFIX));
  if (designChanged.length > 0) {
    triggers.push({
      id: "T5",
      detail: `design-document path(s) changed: ${designChanged.join(", ")}`,
    });
  }

  // T6 — deleted, weakened, or skipped tests.
  const testParts = [];
  if (v.testChanges.deleted.length > 0) {
    testParts.push(`deleted: ${v.testChanges.deleted.join(", ")}`);
  }
  if (v.testChanges.weakened.length > 0) {
    testParts.push(`weakened: ${v.testChanges.weakened.join(", ")}`);
  }
  if (v.testChanges.skipped.length > 0) {
    testParts.push(`skipped: ${v.testChanges.skipped.join(", ")}`);
  }
  if (testParts.length > 0) {
    triggers.push({
      id: "T6",
      detail: `tests deleted, weakened, or skipped: ${testParts.join("; ")}`,
    });
  }

  // T7 — verify skip flags.
  if (v.verifySkipped || v.verifySkipFlags.length > 0) {
    const flags = v.verifySkipFlags.length > 0 ? v.verifySkipFlags.join(", ") : "(verify skipped, no flags named)";
    triggers.push({
      id: "T7",
      detail: `the verify gate was skipped (${flags})`,
    });
  }

  // T8 — repeated retry.
  if (v.reworkCount >= REPEATED_RETRY_MIN_REWORK) {
    triggers.push({
      id: "T8",
      detail: `repeated retry: this is rework round ${v.reworkCount} (a round after at least one retry)`,
    });
  }

  // T9 — high or critical finding.
  const consequential = v.findings.filter(
    (f) => f.severity === "high" || f.severity === "critical",
  );
  if (consequential.length > 0) {
    const counts = {
      high: consequential.filter((f) => f.severity === "high").length,
      critical: consequential.filter((f) => f.severity === "critical").length,
    };
    const parts = [];
    if (counts.high > 0) parts.push(`${counts.high} high`);
    if (counts.critical > 0) parts.push(`${counts.critical} critical`);
    triggers.push({
      id: "T9",
      detail: `consequential finding(s): ${parts.join(" and ")}`,
    });
  }

  // T10 — terminal chain disposition in the escalation family.
  if (v.terminalDisposition !== null && ESCALATION_FAMILY_DISPOSITIONS.has(v.terminalDisposition)) {
    triggers.push({
      id: "T10",
      detail: `terminal chain disposition is ${v.terminalDisposition}`,
    });
  }

  // T11 — Luna recommends accept.
  if (v.lunaRecommendsAccept) {
    triggers.push({
      id: "T11",
      detail: "Luna recommends accept — an independent audit is required before the recommendation can be trusted",
    });
  }

  // T12 — reproducible sampling.
  let sampled = false;
  if (v.sampling !== null) {
    sampled = sampleDecision(v.sampling.missionId, v.sampling.rate, v.sampling.salt);
    if (sampled) {
      triggers.push({
        id: "T12",
        detail: `sampled by sampleDecision(missionId=${v.sampling.missionId}, rate=${v.sampling.rate}, salt=${v.sampling.salt})`,
      });
    }
  }

  // T13 — pre-publish (host-only/advisory in v1, but represented and replayable).
  if (v.publish) {
    triggers.push({
      id: "T13",
      detail: "pre-publish gate (host-only/advisory in v1)",
    });
  }

  const mandatory = triggers.some((t) => t.id !== "T12");
  return {
    required: triggers.length > 0,
    gateId: v.gateId,
    triggers,
    sampled,
    mandatory,
    policyVersion: AUDIT_POLICY_VERSION,
  };
}