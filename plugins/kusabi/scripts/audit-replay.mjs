// audit-replay.mjs — kusabi #532: offline, deterministic replay of Sol audit
// gate decisions from durable records alone.
//
// Replay is OFFLINE and READ-ONLY: every function here is pure and
// synchronous.  A replayed decision consumes only the recorded normalized
// `policyInput` (mission gates) or durable chain/round records (plain
// chains) plus the recorded/configured sampling parameters — no model,
// provider, network, CLI, or database call is made by this surface.
//
// evaluateAuditGate (audit-policy.mjs) remains the SINGLE decision source:
// a replayed decision is `evaluateAuditGate(policyInput)` and nothing else.
// This module never duplicates any trigger logic.
//
// Incomplete or invalid records are COUNTED and SKIPPED with an EXPLICIT
// stable reason (REPLAY_SKIP_REASONS), never guessed and never silently
// merged.  Deterministic sampling (T12) uses the durable subject id — the
// mission id for missions, the chain id for plain chains — together with
// the recorded/configured rate and salt.
//
// Missed-trigger reporting (reportMissedTriggers) is a pure function: it
// surfaces additional mandatory triggers the replay fires that the recorded
// gate lacks WITHOUT changing the stored/live verdict, and keeps sampled-only
// triggers (T12-only) distinct from mandatory ones.

import { evaluateAuditGate } from "./audit-policy.mjs";

/** The stable skip reasons the frozen contract names. */
export const REPLAY_SKIP_REASONS = [
  "missing-policy-input",
  "missing-recorded-decision",
  "invalid-policy-input",
  "malformed-record",
  // A gate recorded as explicitly non-policy-replayable (a Luna-requested
  // consult_sol gate: it fires on the synthetic "consult" reason, which
  // evaluateAuditGate cannot reproduce, so it persists policyInput: null).
  // Never a mismatch — the decision is genuinely not re-derivable.
  "not-policy-replayable",
];

function triggerIds(triggers) {
  return (Array.isArray(triggers) ? triggers : [])
    .map((t) => (typeof t === "string" ? t : t && typeof t === "object" ? t.id : undefined))
    .filter((id) => typeof id === "string");
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Normalize a recorded input clone for replay: an explicit `sampling: null`
 * means "recorded as no sampling" and must replay as absence (a null
 * sampling block is invalid input to evaluateAuditGate).  A recorded object
 * sampling block always wins over any override.
 */
function normalizedReplayInput(policyInput, sampling) {
  const input = { ...(policyInput ?? {}) };
  if (input.sampling === null || input.sampling === undefined) {
    delete input.sampling;
    if (sampling !== undefined) input.sampling = sampling;
  }
  return input;
}

/**
 * Replay ONE recorded gate decision from its recorded normalized policyInput.
 *
 * The recorded input is passed to evaluateAuditGate unchanged (the recorded
 * decision must be reproducible from exactly the bytes that were recorded),
 * so an invalid recorded input throws exactly like evaluateAuditGate — the
 * caller (replayMissionGates) converts that throw into an explicit skip.
 *
 * @param {object} opts
 * @param {string} [opts.gateId] — echoed; the recorded input's own gateId
 *   wins inside the decision.
 * @param {object} opts.policyInput — the recorded normalized policy input.
 * @param {{missionId?: string, rate: number, salt: string}} [opts.sampling] —
 *   folded in ONLY when the recorded input carries no sampling block; a
 *   recorded policyInput.sampling always wins.
 * @returns {{ gateId: string, decision: object, sampled: boolean,
 *             mandatory: boolean, policyVersion: number }}
 */
export function replayGateDecision({ gateId, policyInput, sampling }) {
  const decision = evaluateAuditGate(normalizedReplayInput(policyInput, sampling));
  return {
    gateId: gateId ?? decision.gateId,
    decision,
    sampled: decision.sampled,
    mandatory: decision.mandatory,
    policyVersion: decision.policyVersion,
  };
}

/**
 * Replay every recorded gate of a mission record from its recorded
 * normalized policyInput.
 *
 * A gate whose policyInput is missing (undefined — a legacy gate that never
 * recorded one) is skipped with "missing-policy-input"; a gate recorded as
 * explicitly non-policy-replayable (policyInput: null — a Luna-requested
 * consult gate) is skipped with "not-policy-replayable"; a gate whose
 * recorded decision fields (required/mandatory/triggers) are missing is
 * skipped with "missing-recorded-decision"; a gate whose recorded policyInput
 * throws is skipped with "invalid-policy-input".  A record that is not an
 * object, or whose missionId is not a non-empty string, is a single
 * "malformed-record" skip with no gates.  Nothing is ever guessed.
 *
 * @param {*} record — the mission record (mission.json shape).
 * @param {object} [opts]
 * @param {{rate: number, salt: string}} [opts.sampling] — overrides an ABSENT
 *   recorded sampling block only; the durable mission id is injected as the
 *   sampling.missionId (T12 sample unit) and a recorded policyInput.sampling
 *   always wins, untouched.
 * @returns {{ gates: object[], skipped: object[], counts: object }}
 */
export function replayMissionGates(record, opts = {}) {
  const gates = [];
  const skipped = [];
  let replayed = 0;
  let matched = 0;
  let mismatched = 0;

  if (
    !record ||
    typeof record !== "object" ||
    typeof record.missionId !== "string" ||
    record.missionId.trim() === ""
  ) {
    skipped.push({
      gateId: null,
      reason: "malformed-record",
      detail: "record is not an object or has no usable missionId",
    });
    return {
      gates,
      skipped,
      counts: { replayed: 0, matched: 0, mismatched: 0, skipped: 1 },
    };
  }

  const gateList = Array.isArray(record.auditGates) ? record.auditGates : [];
  // The CLI override ({rate, salt}) is folded in ONLY when the recorded gate
  // input carries no sampling block — and it must carry the durable mission
  // id as its T12 sample unit.  A fully recorded policyInput.sampling always
  // wins and is never overwritten (its subject id / rate / salt are the
  // recorded bytes, replayed verbatim).
  const overrideSampling =
    opts.sampling !== undefined
      ? { missionId: record.missionId, rate: opts.sampling.rate, salt: opts.sampling.salt }
      : undefined;
  for (const gate of gateList) {
    if (!gate || typeof gate !== "object") {
      skipped.push({
        gateId: null,
        reason: "malformed-record",
        detail: "a gate record is not an object",
      });
      continue;
    }
    if (gate.policyInput === undefined) {
      skipped.push({
        gateId: gate.gateId ?? null,
        reason: "missing-policy-input",
        detail: "no recorded normalized policyInput on the gate",
      });
      continue;
    }
    if (gate.policyInput === null) {
      // An explicit null is the consult gate's marker: the gate fired on the
      // synthetic "consult" reason (not a policy trigger), so no policy input
      // was ever evaluated and none can be replayed.  Explicitly
      // non-policy-replayable — never a mismatch against a re-derived
      // decision, and never guessed.
      skipped.push({
        gateId: gate.gateId ?? null,
        reason: "not-policy-replayable",
        detail: "the gate records policyInput: null (Luna-requested consult — not a policy decision)",
      });
      continue;
    }
    const recordedRequired = gate.required;
    const recordedMandatory = gate.mandatory;
    const recordedTriggers = gate.triggers;
    if (
      recordedRequired === undefined ||
      recordedMandatory === undefined ||
      recordedTriggers === undefined
    ) {
      skipped.push({
        gateId: gate.gateId ?? null,
        reason: "missing-recorded-decision",
        detail: "recorded decision fields (required/mandatory/triggers) missing",
      });
      continue;
    }

    let decision;
    try {
      decision = evaluateAuditGate(normalizedReplayInput(gate.policyInput, overrideSampling));
    } catch (err) {
      skipped.push({
        gateId: gate.gateId ?? null,
        reason: "invalid-policy-input",
        detail: err.message,
      });
      continue;
    }

    replayed += 1;
    const recordedIds = triggerIds(recordedTriggers);
    const decisionIds = decision.triggers.map((t) => t.id);
    const match =
      decision.required === recordedRequired &&
      decision.mandatory === recordedMandatory &&
      arraysEqual(recordedIds, decisionIds);
    if (match) matched += 1;
    else mismatched += 1;

    gates.push({
      gateId: gate.gateId ?? decision.gateId,
      phase: gate.phase ?? null,
      origin: gate.origin ?? null,
      recordedVerdict: typeof gate.verdict === "string" ? gate.verdict : null,
      recordedTriggers: recordedIds,
      recordedRequired,
      recordedMandatory,
      recordedSampled: gate.sampled ?? null,
      decision,
      sampled: decision.sampled,
      mandatory: decision.mandatory,
      matchesRecorded: match,
    });
  }

  return {
    gates,
    skipped,
    counts: { replayed, matched, mismatched, skipped: skipped.length },
  };
}

/**
 * Derive the richest available deterministic evaluateAuditGate input from
 * durable chain/round records.  Only fields that are durable and
 * unambiguous are used — the final round's disposition (T10), rework count
 * (T8), findings (T9), a chain-wide no-fix closure when every round measured
 * no worktree change (T2), and the chain id as the T12 sample unit.  An
 * absent field stays absent (empty list / false / null), never invented.
 *
 * @param {object} chainJson — the durable chain.json record.
 * @param {object} roundRecord — a durable round record (replay derives one
 *   input per round).
 * @param {object} [opts]
 * @param {{rate: number, salt: string}} [opts.sampling] — when present, the
 *   T12 sampling block is derived with the CHAIN id as the sample unit.
 * @returns {object} the normalized evaluateAuditGate input.
 */
export function deriveChainGateInput(chainJson, roundRecord, opts = {}) {
  const chainId = chainJson?.chainId;
  const round = roundRecord && typeof roundRecord === "object" ? roundRecord : {};
  const findings = Array.isArray(round.findings)
    ? round.findings
        .filter(
          (f) =>
            f &&
            typeof f === "object" &&
            typeof f.severity === "string" &&
            typeof f.title === "string",
        )
        .map((f) => ({ severity: f.severity, title: f.title }))
    : [];
  const terminalDisposition =
    round.disposition && typeof round.disposition.disposition === "string"
      ? round.disposition.disposition
      : null;
  // T2 is CHAIN-WIDE (adjudication finding): no-fix closure is claimed only
  // when EVERY durable round measured `worktreeChanged === false`.  A round
  // that measured a change, a round that was never measured (absent / null
  // worktreeChanged), or a chain with no durable rounds at all prevents the
  // claim \u2014 the empty/partial history is never read as \"no fixes\".
  const durableRecords = Array.isArray(chainJson?.records) ? chainJson.records : [];
  const noFixClosure =
    durableRecords.length > 0 &&
    durableRecords.every(
      (r) => r && typeof r === "object" && r.worktreeChanged === false,
    );
  return {
    gateId: `chain-replay-${chainId}`,
    changeScope: { added: [], deleted: [], modified: [] },
    testChanges: { deleted: [], weakened: [], skipped: [] },
    verifySkipped: false,
    verifySkipFlags: [],
    reworkCount: typeof round.reworkCount === "number" ? round.reworkCount : 0,
    findings,
    terminalDisposition,
    lunaRecommendsAccept: false,
    issue: { causalHypothesis: false },
    noFixClosure,
    // Sampling (T12) is derived with the chain id as the sample unit only
    // when configured; when absent the key is omitted entirely (never null —
    // evaluateAuditGate treats an explicit null sampling as invalid).
    ...(opts.sampling
      ? { sampling: { missionId: chainId, rate: opts.sampling.rate, salt: opts.sampling.salt } }
      : {}),
    publish: false,
  };
}

/**
 * Replay a plain chain over EVERY durable round record through the derived
 * input above — one gate per round.  A chain.json with no usable chainId is
 * a single "malformed-record" skip; a chain with no durable round records is
 * skipped with "missing-round-record" (a stable explicit reason, not one of
 * the frozen REPLAY_SKIP_REASONS — it names a different, chain-only
 * condition).  A round whose derived input throws (e.g. a legacy round with
 * an unknown finding severity or terminal disposition) is COUNTED and
 * SKIPPED with "invalid-policy-input" — never fatal — and later valid
 * rounds still replay.
 *
 * @param {object} chainJson — the durable chain.json record.
 * @param {object} [opts] — forwarded to deriveChainGateInput (sampling).
 * @returns {{ gates: object[], skipped: object[], counts: object }}
 */
export function replayChainGates(chainJson, opts = {}) {
  if (
    !chainJson ||
    typeof chainJson !== "object" ||
    typeof chainJson.chainId !== "string" ||
    chainJson.chainId === ""
  ) {
    return {
      gates: [],
      skipped: [
        {
          gateId: null,
          reason: "malformed-record",
          detail: "chain record is not an object or has no usable chainId",
        },
      ],
      counts: { replayed: 0, matched: 0, mismatched: 0, skipped: 1 },
    };
  }

  const records = Array.isArray(chainJson.records) ? chainJson.records : [];
  if (records.length === 0) {
    return {
      gates: [],
      skipped: [
        {
          gateId: `chain-replay-${chainJson.chainId}`,
          reason: "missing-round-record",
          detail: "no durable round records on the chain",
        },
      ],
      counts: { replayed: 0, matched: 0, mismatched: 0, skipped: 1 },
    };
  }

  // Every durable round is evaluated independently (adjudication finding):
  // one invalid round is COUNTED and SKIPPED with the same stable
  // invalid-input classification mission replay uses \u2014 it never aborts the
  // chain, and later valid rounds still replay.
  const gates = [];
  const skipped = [];
  let replayed = 0;
  for (const roundRecord of records) {
    const gateId = `chain-replay-${chainJson.chainId}`;
    if (!roundRecord || typeof roundRecord !== "object") {
      skipped.push({
        gateId,
        reason: "malformed-record",
        detail: "a round record is not an object",
      });
      continue;
    }
    let input;
    let decision;
    try {
      input = deriveChainGateInput(chainJson, roundRecord, opts);
      decision = evaluateAuditGate(input);
    } catch (err) {
      skipped.push({
        gateId,
        reason: "invalid-policy-input",
        detail: err.message,
      });
      continue;
    }
    replayed += 1;
    gates.push({
      gateId: input.gateId,
      round: typeof roundRecord.round === "number" ? roundRecord.round : null,
      phase: null,
      origin: decision.mandatory
        ? "policy-mandated"
        : decision.sampled
          ? "sampled"
          : null,
      recordedVerdict: null,
      recordedTriggers: [],
      recordedRequired: null,
      recordedMandatory: null,
      recordedSampled: null,
      decision,
      sampled: decision.sampled,
      mandatory: decision.mandatory,
      matchesRecorded: null,
    });
  }

  return {
    gates,
    skipped,
    counts: { replayed, matched: 0, mismatched: 0, skipped: skipped.length },
  };
}

/**
 * Report the additional mandatory triggers an offline chain-derived replay
 * fires that the recorded live gate lacked, keeping sampled-only triggers
 * (T12-only) distinct.  A pure computation: the stored/live verdict is
 * echoed, never written.
 *
 * @param {object} opts
 * @param {object} opts.recordedGate — the recorded live gate record.
 * @param {object} opts.derivedInput — the offline derived policy input
 *   (deriveChainGateInput output).
 * @param {{missionId?: string, rate: number, salt: string}} [opts.sampling] —
 *   folded in only when the derived input carries no sampling block.
 * @param {string|null} [opts.recordedVerdict] — echoed (may be null).
 * @param {string|null} [opts.liveDisposition] — echoed (may be null).
 * @returns {object} the missed-trigger report.
 */
export function reportMissedTriggers({
  recordedGate,
  derivedInput,
  sampling,
  recordedVerdict = null,
  liveDisposition = null,
}) {
  const recorded = recordedGate && typeof recordedGate === "object" ? recordedGate : {};
  const recordedTriggers = triggerIds(recorded.triggers);
  const decision = evaluateAuditGate(normalizedReplayInput(derivedInput, sampling));
  const additionalMandatory = decision.triggers.filter(
    (t) => t.id !== "T12" && !recordedTriggers.includes(t.id),
  );
  const sampledOnly = decision.triggers.filter((t) => t.id === "T12");
  return {
    gateId: recorded.gateId ?? decision.gateId ?? null,
    recordedVerdict: recordedVerdict ?? null,
    liveDisposition: liveDisposition ?? null,
    recordedTriggers,
    replayedTriggers: decision.triggers.map((t) => t.id),
    additionalMandatory,
    sampledOnly,
    liveVerdictUnchanged: true,
  };
}