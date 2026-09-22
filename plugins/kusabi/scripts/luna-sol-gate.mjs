// luna-sol-gate.mjs - kusabi #531: the deterministic Sol audit gate for luna
// missions.
//
// This module owns EVERYTHING a gate needs that is not the driver's request
// loop:
//
//   - the deterministic gate decision: policy (evaluateAuditGate) fires on the
//     mission lifecycle points, sampling (T12) selects a mission, and an
//     accepted `consult_sol` request adds an ADDITIVE gate - no lifecycle
//     point unconditionally buys a seat;
//   - the gate evidence envelope (built through the existing audit-envelope
//     contracts against the current mission evidence);
//   - Sol dispatch and verdict parsing/binding through the existing
//     audit-verdict contracts (parseAuditVerdictJsonl / validateAuditVerdict /
//     bindAuditVerdict) - a verdict is authoritative only when gate_id and
//     envelope_sha256 bind to the exact current gate evidence;
//   - fail-closed classification: at a MANDATORY gate, missing / unavailable /
//     empty / malformed / ambiguous / evidence-mismatched results become
//     `sol-blocked`; only sample-only seat unavailability records
//     `audit-sample-skipped` and may proceed;
//   - evidence-change archival: when the evidence fingerprint changes between
//     gates, the stale verdict is archived with reason `evidence-changed`,
//     excluded from the next envelope's `prior_verdicts`, and never deleted;
//   - the bounded-rework decision: consecutive rework verdicts beyond
//     budget.maxRework fail closed `sol-blocked`.
//
// The driver calls evaluateMissionGate at exactly the frozen lifecycle points
// (pre-dispatch, post-chain, pre-accept, consult) and owns what the outcome
// means for the request loop; this module owns how a gate is decided and
// recorded.  Nothing here touches the real Codex CLI unless the default
// realSolDispatch is used (production); tests inject a fake solDispatch.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { evaluateAuditGate, AUDIT_POLICY_VERSION } from "./audit-policy.mjs";
import { buildAuditEnvelope, resolveSolGateSeatFailure } from "./audit-envelope.mjs";
import {
  parseAuditVerdictJsonl,
  validateAuditVerdict,
  bindAuditVerdict,
  AUDIT_VERDICTS,
} from "./audit-verdict.mjs";

/** The gate phases the frozen #531 vocabulary names. */
export const GATE_PHASES = ["pre-dispatch", "post-chain", "pre-accept", "consult"];

/** The additive consult gate's trigger id (a requested audit, not policy tuning). */
export const CONSULT_TRIGGER_ID = "consult";

/** The fail-closed causes the frozen gate records name. */
export const GATE_FAIL_REASONS = [
  "unavailable",
  "empty",
  "missing",
  "malformed",
  "ambiguous",
  "evidence-mismatch",
];

/**
 * A deterministic fingerprint of the mission EVIDENCE the gates judge - the
 * brief plus every worker report, probe raw, consult count and coordinator
 * error count.  This is the pure evidence fingerprint (independent of any
 * gate metadata or prior-verdict list), so it changes exactly when the
 * envelope's evidence bytes change: after any observable action (a chain, a
 * probe, a consult, a coordinator error), not after a gate evaluation.
 *
 * @param {object} opts
 * @param {string} opts.brief
 * @param {object} opts.record - the mission record.
 * @returns {string} a 64-hex sha256.
 */
export function evidenceFingerprint({ brief, record }) {
  const ledger = JSON.stringify({
    attempts: Array.isArray(record.attempts) ? record.attempts.length : 0,
    chains: Array.isArray(record.chains) ? record.chains : [],
    probes: Array.isArray(record.probes) ? record.probes.length : 0,
    consults: Array.isArray(record.consults) ? record.consults.length : 0,
    coordinatorErrors: record.coordinatorErrors ?? 0,
  });
  const parts = [String(brief ?? ""), ledger];
  const attempts = Array.isArray(record.attempts) ? record.attempts : [];
  attempts.forEach((attempt) => parts.push(String(attempt.output ?? attempt.brief ?? "")));
  const probes = Array.isArray(record.probes) ? record.probes : [];
  probes.forEach((probe) => parts.push(String(probe.output ?? "")));
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

/**
 * Archive every non-archived gate verdict whose evidence fingerprint no longer
 * matches the current evidence.  An archived verdict is never deleted and
 * never silently reused: it stays on the record with `archived: true` and
 * `archiveReason: "evidence-changed"`.
 *
 * @param {object} record - the mission record (read only).
 * @param {string} fingerprint - the current evidence fingerprint.
 * @returns {{ gates: object[], changed: boolean }}
 */
export function archiveStaleVerdicts(record, fingerprint) {
  const gates = Array.isArray(record.auditGates) ? record.auditGates : [];
  let changed = false;
  const next = gates.map((g) => {
    if (g && g.archived) return g;
    if (g && g.evidenceFingerprint === fingerprint) return g;
    changed = true;
    return { ...(g ?? {}), archived: true, archiveReason: "evidence-changed" };
  });
  return { gates: next, changed };
}

/**
 * The verdicts that may ride as `prior_verdicts` on the next gate envelope:
 * non-archived gates whose evidence fingerprint still matches the current
 * evidence and whose verdict was actually recorded.  Stale (archived) verdicts
 * are excluded so the envelope can never silently reuse evidence-judged
 * results.
 *
 * @param {object[]} gates
 * @param {string} fingerprint
 * @returns {Array<{gate_id: string, verdict: string, envelope_sha256: string}>}
 */
export function activePriorVerdicts(gates, fingerprint) {
  return (Array.isArray(gates) ? gates : [])
    .filter((g) => g && !g.archived && g.evidenceFingerprint === fingerprint && AUDIT_VERDICTS.includes(g.verdict))
    .map((g) => ({ gate_id: g.gateId, verdict: g.verdict, envelope_sha256: g.envelopeSha256 }));
}

/** The mission-ledger evidence text shared by every mission envelope. */
function missionLedgerText(record) {
  return JSON.stringify({
    attempts: Array.isArray(record.attempts) ? record.attempts.length : 0,
    chains: Array.isArray(record.chains) ? record.chains : [],
    probes: Array.isArray(record.probes) ? record.probes.length : 0,
    consults: Array.isArray(record.consults) ? record.consults.length : 0,
    coordinatorErrors: record.coordinatorErrors ?? 0,
  });
}

/**
 * The immutable evidence items a gate judges - the same evidence surface the
 * coordinator envelope binds (brief + worker reports + probe raws + ledger),
 * so the gate and the coordinator are bound to the same current evidence.
 */
export function missionEvidenceItems({ brief, record }) {
  const items = [
    { role: "luna_brief", source: "mission-file", content: brief ?? "", path: "evidence/mission-brief.txt" },
  ];
  const attempts = Array.isArray(record?.attempts) ? record.attempts : [];
  attempts.forEach((attempt, i) => {
    items.push({
      role: "worker_report",
      source: `attempt-${attempt.index}`,
      content: String(attempt.output ?? attempt.brief ?? ""),
      path: `evidence/worker-report-${i}.txt`,
    });
  });
  const probes = Array.isArray(record?.probes) ? record.probes : [];
  probes.forEach((probe, i) => {
    items.push({
      role: "probe_raw",
      source: `probe-${i}`,
      content: String(probe.output ?? ""),
      path: `evidence/probe-${i}.txt`,
    });
  });
  items.push({
    role: "worker_report",
    source: "mission-ledger",
    content: missionLedgerText(record ?? {}),
    path: "evidence/mission-ledger.txt",
  });
  return items;
}

/**
 * Build the immutable evidence envelope a gate is judged against.  The
 * envelope carries `gate_id`, `envelope_sha256`, `items`, `triggers`,
 * `sampled`/`mandatory` classification and the active `prior_verdicts`.
 *
 * @param {object} input
 * @returns {object} the envelope (with envelope_sha256).
 */
export function buildGateEnvelope({
  missionId,
  missionDir,
  brief,
  record,
  container,
  seat,
  allowSubstitute,
  gateId,
  triggers,
  priorVerdicts,
}) {
  return buildAuditEnvelope({
    gateId,
    missionId,
    chainId: null,
    policyVersion: AUDIT_POLICY_VERSION,
    seat,
    triggers,
    container,
    baseSha: null,
    changeScope: {},
    items: missionEvidenceItems({ brief, record }),
    priorVerdicts,
    allowSubstitute: allowSubstitute === true,
    writeFile: (p, content) => {
      const target = path.join(missionDir, p);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, "utf8");
    },
  });
}

/**
 * The real Sol seat dispatch (production): run the exact gpt-5.6-sol auditor
 * seat through the codex backend with the gate envelope as its ONLY evidence
 * path, and return its raw JSONL output.  The job title follows the frozen
 * job-identification pattern `luna mission <mission-id>: ...` so
 * reconciliation can attribute seat jobs to the mission.
 */
export async function realSolDispatch({ cwd, missionId, envelope, gate, auditor }) {
  const { codexDispatch } = await import("./codex-dispatch.mjs");
  const prompt = [
    `You are the Sol auditor seat for kusabi mission ${missionId}, audit gate ${gate.gateId} (phase: ${gate.phase}).`,
    `The current immutable evidence envelope hash is ${envelope.envelope_sha256}.`,
    ``,
    `Mission evidence envelope:`,
    JSON.stringify(envelope, null, 2),
    ``,
    `Answer with line-oriented JSON records: any finding records, then exactly one ` +
      `verdict record with type "verdict", schema_version 1, gate_id "${gate.gateId}", ` +
      `envelope_sha256 "${envelope.envelope_sha256}", and verdict one of clear | rework | block.`,
  ].join("\n");
  const { resultText } = await codexDispatch({
    cwd,
    kind: "luna-audit",
    title: `luna mission ${missionId}: audit ${gate.gateId}`,
    promptText: prompt,
    agent: null,
    phase: "luna-audit",
    explicitModel: auditor.model,
    tiers: [[auditor.model]],
    session: null,
    tools: {},
    timeoutS: null,
    watchdogS: null,
  });
  return resultText;
}

/**
 * The single gate outcome decision for one mission lifecycle point.
 *
 * The driver calls this at the frozen points and interprets the outcome:
 *   - "not-required"        - policy fired nothing: no seat is bought, no gate
 *                             is recorded.
 *   - "clear"               - the gate is cleared; the driver proceeds.
 *   - "rework"              - the gate demands a bounded rework_chain; the
 *                             driver may continue the loop (the bound is
 *                             enforced here - an excess fails closed).
 *   - "block"               - the gate is blocked; the mission terminates
 *                             sol-blocked and Luna gets no later dispatch.
 *   - "sol-blocked"         - a mandatory gate failed closed (unavailable /
 *                             empty / missing / malformed / ambiguous /
 *                             evidence-mismatch, or the rework bound).
 *   - "audit-sample-skipped" - sample-only unavailability: the single recorded
 *                             fail-open; the driver may proceed.
 *   - "cancelled"           - a stop request landed before the Sol dispatch;
 *                             the driver terminates cancelled.
 *
 * @param {object} input
 * @param {string} input.cwd
 * @param {string} input.missionId
 * @param {string} input.missionDir
 * @param {string} input.brief
 * @param {string} input.container
 * @param {object} input.auditor - {provider, model, ...} the Sol seat.
 * @param {boolean} input.allowSubstitute
 * @param {{rate: number, salt: string}|null|undefined} input.sampling
 * @param {string} input.phase - one of GATE_PHASES.
 * @param {string|null} [input.reason] - the consult_sol reason (consult gates).
 * @param {object} input.record - the current mission record.
 * @param {(args: object) => Promise<string>} input.solDispatch
 * @param {() => boolean} input.stopRequested
 * @param {number} input.maxRework - budget.maxRework.
 * @returns {Promise<object>} see above.
 */
export async function evaluateMissionGate(input) {
  const {
    cwd,
    missionId,
    missionDir,
    brief,
    container,
    auditor,
    allowSubstitute,
    sampling,
    phase,
    reason,
    record,
    solDispatch,
    stopRequested,
    maxRework,
  } = input;

  const gates0 = Array.isArray(record.auditGates) ? record.auditGates : [];
  const gateIndex = gates0.length + 1;
  const gateId = `gate-${gateIndex}`;

  // ---- policy decision: the ONLY way a gate is required ----
  // The normalized policy input is recorded on the gate verbatim so the
  // recorded decision replays offline (kusabi #532 criterion 4) — a replayed
  // decision is evaluateAuditGate(policyInput) and nothing else.
  const policySampling = sampling
    ? { sampling: { missionId, rate: sampling.rate, salt: sampling.salt } }
    : {};
  let decision;
  if (phase === "consult") {
    // An accepted consult_sol is ADDITIVE: Luna asked for an extra audit, so
    // a seat is bought.  It is required but never mandatory (it cannot
    // downgrade or satisfy a separately mandatory gate) and never sampled.
    decision = {
      required: true,
      gateId,
      triggers: [{ id: CONSULT_TRIGGER_ID, detail: reason ?? "Luna requested an additive audit consultation" }],
      sampled: false,
      mandatory: false,
      policyVersion: AUDIT_POLICY_VERSION,
    };
  } else {
    decision = evaluateAuditGate({
      gateId,
      lunaRecommendsAccept: phase === "pre-accept",
      changeScope: {},
      ...policySampling,
    });
  }

  if (!decision.required) {
    return { fired: false, outcome: "not-required", gate: null, decision: null };
  }

  // ---- evidence-change archival + active prior verdicts ----
  const fingerprint = evidenceFingerprint({ brief, record });
  const { gates: gatesAfterArchive } = archiveStaleVerdicts(record, fingerprint);
  const priorVerdicts = activePriorVerdicts(gatesAfterArchive, fingerprint);

  // ---- the gate envelope the seat judges ----
  const envelope = buildGateEnvelope({
    missionId,
    missionDir,
    brief,
    record,
    container,
    seat: auditor,
    allowSubstitute,
    gateId,
    triggers: decision.triggers,
    priorVerdicts,
  });

  // Persist the gate envelope for audit/replay (additive).
  try {
    fs.mkdirSync(path.join(missionDir, "evidence"), { recursive: true });
    fs.writeFileSync(
      path.join(missionDir, "evidence", `gate-envelope-${gateId}.json`),
      `${JSON.stringify(envelope, null, 2)}\n`,
      "utf8",
    );
  } catch { /* best-effort: an envelope write must never change the gate decision */ }

  // The normalized policy input this gate was evaluated with, the
  // consultation origin and the deterministic shadow disposition computed
  // with solVerdict: null.  The shadow is a counterfactual ONLY (kusabi #532
  // criterion 4): it never changes live gating, retries, terminal status or
  // authority.
  //
  // A Luna-requested consult gate is NOT a policy decision: it fires on the
  // synthetic "consult" reason, which evaluateAuditGate cannot reproduce, so
  // no policyInput is fabricated.  The gate persists policyInput: null — the
  // explicit non-policy-replayable marker — with its real origin, actual
  // verdict and shadow outcome.  A policy-evaluated gate persists the exact
  // object evaluateAuditGate saw, so its recorded decision replays offline.
  const policyInput =
    phase === "consult"
      ? null
      : { gateId, lunaRecommendsAccept: phase === "pre-accept", changeScope: {}, ...policySampling };
  const origin =
    phase === "consult"
      ? "luna-requested"
      : decision.mandatory
        ? "policy-mandated"
        : "sampled";
  const shadowDisposition = resolveSolGateSeatFailure({
    required: true,
    mandatory: decision.mandatory,
    sampled: decision.sampled,
    seatAvailable: false,
  }).disposition;

  const baseGate = {
    gateId,
    phase,
    envelopeSha256: envelope.envelope_sha256,
    required: true,
    mandatory: decision.mandatory,
    sampled: decision.sampled,
    triggers: decision.triggers,
    policyInput,
    origin,
    shadowDisposition,
    evidenceFingerprint: fingerprint,
  };

  // Stop check immediately BEFORE the Sol dispatch (criterion 4): a stop
  // request that landed before the auditor seat went out means no auditor
  // seat may be dispatched at all.
  if (stopRequested()) {
    return { fired: true, outcome: "cancelled", gate: null, gates: gatesAfterArchive, envelope, decision };
  }

  // ---- the seat ----
  let rawOutput;
  try {
    rawOutput = await solDispatch({
      cwd,
      missionId,
      missionDir,
      envelope,
      gate: { gateId, phase },
      record: { ...record },
      auditor,
    });
  } catch {
    return seatFailure({
      baseGate,
      gatesAfterArchive,
      envelope,
      decision,
      reason: "unavailable",
    });
  }

  const text = String(rawOutput ?? "");
  if (text.trim() === "") {
    return seatFailure({ baseGate, gatesAfterArchive, envelope, decision, reason: "empty" });
  }

  const parsed = parseAuditVerdictJsonl(text);
  if (parsed.ambiguous) {
    return seatFailure({ baseGate, gatesAfterArchive, envelope, decision, reason: "ambiguous" });
  }
  if (!parsed.verdict) {
    return seatFailure({ baseGate, gatesAfterArchive, envelope, decision, reason: "missing" });
  }

  const validation = validateAuditVerdict(parsed.verdict);
  if (!validation.valid) {
    return seatFailure({ baseGate, gatesAfterArchive, envelope, decision, reason: "malformed" });
  }

  let bound;
  try {
    bound = bindAuditVerdict(parsed.verdict, {
      gateId,
      envelopeSha256: envelope.envelope_sha256,
    });
  } catch {
    return seatFailure({ baseGate, gatesAfterArchive, envelope, decision, reason: "evidence-mismatch" });
  }

  // ---- a verdict was received AND bound to the exact current gate ----
  if (bound.verdict === "rework") {
    const reworkCount = gatesAfterArchive.filter((g) => g && g.verdict === "rework").length;
    const nextReworkCount = reworkCount + 1;
    if (nextReworkCount > maxRework) {
      const gate = {
        ...baseGate,
        verdict: "rework",
        disposition: "sol-blocked",
        reason: "rework-bound",
        verdictRecord: bound,
      };
      return {
        fired: true,
        outcome: "sol-blocked",
        gate,
        gates: [...gatesAfterArchive, gate],
        envelope,
        decision,
      };
    }
    const gate = { ...baseGate, verdict: "rework", disposition: "verdict-recorded", verdictRecord: bound };
    return {
      fired: true,
      outcome: "rework",
      gate,
      gates: [...gatesAfterArchive, gate],
      envelope,
      decision,
    };
  }

  if (bound.verdict === "block") {
    const gate = { ...baseGate, verdict: "block", disposition: "verdict-recorded", verdictRecord: bound };
    return {
      fired: true,
      outcome: "block",
      gate,
      gates: [...gatesAfterArchive, gate],
      envelope,
      decision,
    };
  }

  // clear
  const gate = { ...baseGate, verdict: "clear", disposition: "verdict-recorded", verdictRecord: bound };
  return {
    fired: true,
    outcome: "clear",
    gate,
    gates: [...gatesAfterArchive, gate],
    envelope,
    decision,
  };
}

/**
 * Fail-closed (or the single sampled-only fail-open) classification for a
 * gate whose seat produced no authoritative verdict.  The recorded `reason`
 * is the exact fail-closed cause; the disposition comes from the existing
 * resolveSolGateSeatFailure contract (mandatory wins, sampled-only is the
 * single fail-open, an invariant-shaped required gate fails closed too).
 */
function seatFailure({ baseGate, gatesAfterArchive, envelope, decision, reason }) {
  const seat = resolveSolGateSeatFailure({
    required: true,
    mandatory: decision.mandatory,
    sampled: decision.sampled,
    seatAvailable: false,
  });
  const gate = {
    ...baseGate,
    verdict: null,
    disposition: seat.disposition,
    reason,
  };
  const outcome = seat.disposition === "sol-blocked" ? "sol-blocked" : "audit-sample-skipped";
  return {
    fired: true,
    outcome,
    gate,
    gates: [...gatesAfterArchive, gate],
    envelope,
    decision,
  };
}