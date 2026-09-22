// audit-replay.test.mjs — acceptance tests for the kusabi #532 offline replay
// harness (issue #532 criteria 5 and 6; frozen for the implementation chain).
//
// Frozen contract (the tests below are the contract):
//
//   - Replay is OFFLINE and READ-ONLY: every function here is pure and
//     synchronous.  Replaying a mission or a plain chain consumes only
//     durable records (mission.json / chain.json + round-N.json) plus the
//     recorded/configured sampling parameters.  No model, provider, network,
//     CLI, or database call may be made by the replay surface.
//
//   - evaluateAuditGate (audit-policy.mjs) remains the SINGLE decision
//     source.  The replay module must not duplicate any trigger logic: a
//     replayed decision is `evaluateAuditGate(policyInput)` and nothing
//     else.  Tests never re-implement the triggers; they only assert the
//     replay surface delegates to the existing pure policy.
//
//   - Mission replay consumes the RECORDED normalized `policyInput` on each
//     durable gate record (record.auditGates[].policyInput).  When the
//     recorded input is complete, the replayed decision must MATCH the
//     recorded decision (recorded required/mandatory/sampled + trigger ids).
//
//   - Plain-chain replay DERIVES the richest available deterministic input
//     from durable chain/round records (deriveChainGateInput); the derived
//     input only ever uses fields that are durable and unambiguous — the
//     final round's disposition (T10), rework count (T8), findings (T9), a
//     chain-wide no-fix closure when every round measured no worktree change
//     (T2), and the chain id as the T12 sample unit.  Nothing that is not on
//     disk is guessed: an absent field stays absent (empty list / false /
//     null), never invented.
//
//   - Incomplete or invalid records are COUNTED and SKIPPED with an EXPLICIT
//     reason (REPLAY_SKIP_REASONS), never guessed and never silently merged.
//
//   - Missed-trigger reporting (criterion 6): for a legacy mission whose
//     live gate input omitted round evidence, the offline plain-chain-derived
//     input can fire additional MANDATORY triggers.  The report surfaces
//     those additional triggers WITHOUT changing the stored/live verdict
//     (the report is a pure function; the recorded verdict is passed in and
//     never written).  Sampled-only triggers (T12-only) are reported
//     separately from mandatory triggers.
//
//   - T12 sampling uses the durable subject id: the mission id for missions,
//     the chain id for plain chains, plus the recorded/configured rate and
//     salt.  The replay never re-samples with a guessed subject.
//
// Public surface frozen here (all synchronous):
//
//   REPLAY_SKIP_REASONS — ["missing-policy-input", "missing-recorded-decision",
//     "invalid-policy-input", "malformed-record"] (exact strings).
//
//   replayGateDecision({ gateId, policyInput, sampling? }) -> {
//     gateId, decision,          // evaluateAuditGate's full result object
//     sampled, mandatory, policyVersion }
//     Throws when policyInput is invalid (the same failure mode as
//     evaluateAuditGate — never a silent skip).
//
//   replayMissionGates(record, opts = {}) -> {
//     gates: [{ gateId, phase, origin, recordedVerdict, recordedTriggers,
//               recordedRequired, recordedMandatory, recordedSampled,
//               decision, sampled, mandatory, matchesRecorded }],
//     skipped: [{ gateId, reason, detail }],
//     counts: { replayed, matched, mismatched, skipped } }
//     opts.sampling = { rate, salt } overrides an ABSENT recorded sampling
//     block only; a recorded policyInput.sampling always wins.  A gate whose
//     policyInput is missing -> skip reason "missing-policy-input"; whose
//     recorded decision fields (required/mandatory/sampled/triggers) are
//     missing -> "missing-recorded-decision"; whose policyInput throws ->
//     "invalid-policy-input".  A record that is not an object, or a record
//     whose missionId is not a non-empty string, is a single
//     "malformed-record" skip with no gates.
//
//   deriveChainGateInput(chainJson, roundRecord, opts = {}) -> the normalized
//     evaluateAuditGate input derived from durable records:
//       gateId              "chain-replay-<chainId>"
//       changeScope         { added: [], deleted: [], modified: [] } (not
//                           durably recorded for plain chains)
//       testChanges         { deleted: [], weakened: [], skipped: [] }
//       verifySkipped       false, verifySkipFlags []
//       reworkCount         roundRecord.reworkCount ?? 0
//       findings            roundRecord.findings (severity/title objects only)
//       terminalDisposition roundRecord.disposition?.disposition ?? null
//       lunaRecommendsAccept false
//       issue               { causalHypothesis: false }
//       noFixClosure        chain-wide (T2): true ONLY when every durable
//                           round measured `worktreeChanged === false` \u2014 any
//                           true or unmeasured round prevents the claim
//       sampling            opts.sampling ? { missionId: chainJson.chainId,
//                           rate, salt } : null
//       publish             false
//
//   replayChainGates(chainJson, opts = {}) -> the same { gates, skipped,
//     counts } shape, one gate per DURABLE ROUND evaluated over its derived
//     input (each round's disposition/rework/findings with the chain-wide
//     noFixClosure).  A round whose derived input throws (unknown finding
//     severity, unknown terminal disposition) is counted and skipped with
//     "invalid-policy-input" \u2014 never fatal \u2014 and later valid rounds still
//     replay.  A chain.json with no usable chainId is a "malformed-record"
//     skip; a chain with no durable round records is skipped with
//     "missing-round-record".
//
//   reportMissedTriggers({ recordedGate, derivedInput, sampling?,
//                          recordedVerdict?, liveDisposition? }) -> {
//     gateId,
//     recordedVerdict,             // echoed from the call (may be null)
//     liveDisposition,             // echoed from the call (may be null)
//     recordedTriggers: [ids],     // from the recorded gate
//     replayedTriggers: [ids],     // from evaluateAuditGate(derivedInput)
//     additionalMandatory: [{id, detail}],  // mandatory triggers the replay
//                                           // fires that the recorded gate lacks
//     sampledOnly: [{id, detail}],     // replayed T12-only triggers, never
//                                      // counted as mandatory
//     liveVerdictUnchanged: true }     // static guarantee: pure, no writes

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { evaluateAuditGate, AUDIT_POLICY_VERSION } from "./audit-policy.mjs";
import {
  replayGateDecision,
  replayMissionGates,
  replayChainGates,
  deriveChainGateInput,
  reportMissedTriggers,
  REPLAY_SKIP_REASONS,
} from "./audit-replay.mjs";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function makeGate({ gateId = "gate-1", policyInput, extra = {} } = {}) {
  const input = policyInput ?? {
    gateId,
    lunaRecommendsAccept: true,
    changeScope: {},
    sampling: { missionId: "mission-abc", rate: 0, salt: "v1" },
  };
  const decision = evaluateAuditGate(input);
  return {
    gateId,
    phase: "pre-accept",
    origin: "policy-mandated",
    verdict: "clear",
    disposition: "verdict-recorded",
    required: decision.required,
    mandatory: decision.mandatory,
    sampled: decision.sampled,
    triggers: decision.triggers,
    policyInput: input,
    shadowDisposition: "sol-blocked",
    ...extra,
  };
}

const MISSION_RECORD = {
  missionId: "mission-abc",
  status: "completed",
  disposition: "recommend-accept",
  coordinator: { provider: "codex", model: "gpt-5.6-luna", requested: "gpt-5.6-luna", actual: "gpt-5.6-luna", substituted: false, reasoningEffort: "high" },
  auditor: { provider: "codex", model: "gpt-5.6-sol", requested: "gpt-5.6-sol", actual: "gpt-5.6-sol", substituted: false, reasoningEffort: "high" },
  auditGates: [makeGate({ gateId: "gate-1" })],
};

const ROUND_WITH_EVIDENCE = {
  round: 2,
  modelEntry: "opencode-go/deepseek-v4-flash",
  verdict: "approve",
  disposition: { disposition: "escalate", reason: "premise ambiguous" },
  reworkCount: 1,
  worktreeChanged: true,
  findings: [{ severity: "high", title: "Premise unverified", file: "src/x.mjs" }],
  probesGreen: true,
};

const PLAIN_CHAIN = {
  chainId: "chain-1",
  container: "cid-1",
  orchestrator: { model: "claude-opus-5", session: "abc12345", date: "2026-09-01" },
  records: [
    { round: 1, modelEntry: "opencode-go/deepseek-v4-flash", verdict: "approve", disposition: { disposition: "rework" }, worktreeChanged: true, findings: [] },
    ROUND_WITH_EVIDENCE,
  ],
};

describe("audit-replay (kusabi #532 criteria 5 and 6)", () => {
  it("surface: the module exports the frozen replay functions", () => {
    assert.equal(typeof replayGateDecision, "function");
    assert.equal(typeof replayMissionGates, "function");
    assert.equal(typeof replayChainGates, "function");
    assert.equal(typeof deriveChainGateInput, "function");
    assert.equal(typeof reportMissedTriggers, "function");
    assert.deepEqual(REPLAY_SKIP_REASONS, [
      "missing-policy-input",
      "missing-recorded-decision",
      "invalid-policy-input",
      "malformed-record",
      "not-policy-replayable",
    ]);
  });

  it("replayGateDecision reproduces a recorded decision from the recorded policyInput, via evaluateAuditGate alone", () => {
    const gate = MISSION_RECORD.auditGates[0];
    const replayed = replayGateDecision({ gateId: gate.gateId, policyInput: gate.policyInput });
    assert.equal(replayed.gateId, "gate-1");
    assert.equal(replayed.policyVersion, AUDIT_POLICY_VERSION, "the replay must use the existing versioned policy");
    assert.equal(replayed.decision.required, true);
    assert.equal(replayed.decision.mandatory, true);
    assert.equal(replayed.mandatory, true);
    // The replayed decision is EXACTLY the existing pure policy's decision —
    // the replay surface must not duplicate or reshape the trigger logic.
    assert.deepEqual(replayed.decision.triggers, evaluateAuditGate(gate.policyInput).triggers);
  });

  it("replayGateDecision is deterministic and synchronous: no model/provider/network call (criterion 5)", () => {
    const gate = MISSION_RECORD.auditGates[0];
    const first = replayGateDecision({ gateId: gate.gateId, policyInput: gate.policyInput });
    const second = replayGateDecision({ gateId: gate.gateId, policyInput: gate.policyInput });
    assert.deepEqual(first, second, "identical durable input must produce an identical replayed decision");
    // A network/model surface could not be synchronous; a pure function that
    // returns a value (not a Promise) is the offline-read-only guarantee.
    assert.equal(typeof first.decision.required, "boolean");
    assert.equal(first.decision instanceof Promise, false);
  });

  it("replayMissionGates matches the recorded decision when the recorded input is complete (criterion 5)", () => {
    const { gates, skipped, counts } = replayMissionGates(MISSION_RECORD);
    assert.equal(skipped.length, 0);
    assert.deepEqual(counts, { replayed: 1, matched: 1, mismatched: 0, skipped: 0 });
    assert.equal(gates.length, 1);
    assert.equal(gates[0].gateId, "gate-1");
    assert.equal(gates[0].matchesRecorded, true);
    assert.equal(gates[0].decision.required, MISSION_RECORD.auditGates[0].required);
  });

  it("a recorded gate whose decision changed after recording is reported as a mismatch, never silently corrected", () => {
    // The recorded input says recommend-accept (T11 mandatory) but the
    // recorded gate claims required=false — the replay must surface the
    // mismatch, not rewrite the durable record.
    const gate = makeGate({
      gateId: "gate-1",
      extra: { required: false, mandatory: false, triggers: [] },
    });
    const { gates, counts } = replayMissionGates({ ...MISSION_RECORD, auditGates: [gate] });
    assert.equal(gates[0].matchesRecorded, false);
    assert.deepEqual(counts, { replayed: 1, matched: 0, mismatched: 1, skipped: 0 });
  });

  it("gates without a recorded policyInput are counted and skipped with an explicit reason (criterion 5)", () => {
    const legacy = { ...MISSION_RECORD, auditGates: [{ gateId: "gate-1", phase: "pre-accept", verdict: "clear", required: true, mandatory: true, triggers: [] }] };
    const { gates, skipped, counts } = replayMissionGates(legacy);
    assert.equal(gates.length, 0, "a gate without its input is never replayed from a guess");
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].gateId, "gate-1");
    assert.equal(skipped[0].reason, "missing-policy-input");
    assert.deepEqual(counts, { replayed: 0, matched: 0, mismatched: 0, skipped: 1 });
  });

  it("a Luna-requested consult gate (policyInput null, not policy-replayable) is skipped, never counted as a mismatch", () => {
    // A consult_sol gate is ADDITIVE: it fires on the synthetic "consult"
    // reason, which evaluateAuditGate cannot reproduce.  It persists its
    // real origin/verdict/shadow but no replayable policyInput (null) — the
    // replay must skip it with an explicit stable reason rather than report
    // it as a mismatch against a decision that cannot be re-derived.
    const consultGate = {
      ...makeGate({ gateId: "gate-1" }),
      phase: "consult",
      origin: "luna-requested",
      policyInput: null,
    };
    const { gates, skipped, counts } = replayMissionGates({
      ...MISSION_RECORD,
      auditGates: [consultGate, makeGate({ gateId: "gate-2" })],
    });
    assert.equal(gates.length, 1, "the replayable gate replays; the consult gate never re-enters the decision set");
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].gateId, "gate-1");
    assert.equal(skipped[0].reason, "not-policy-replayable");
    assert.deepEqual(counts, { replayed: 1, matched: 1, mismatched: 0, skipped: 1 });
  });

  it("gates without recorded decision fields are counted and skipped with an explicit reason", () => {
    const gate = { ...MISSION_RECORD.auditGates[0] };
    delete gate.required;
    delete gate.mandatory;
    delete gate.triggers;
    const { skipped } = replayMissionGates({ ...MISSION_RECORD, auditGates: [gate] });
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].reason, "missing-recorded-decision");
  });

  it("an invalid recorded policyInput is counted and skipped with an explicit reason, never re-guessed", () => {
    // The durable invalid gate record is constructed directly: makeGate
    // eagerly evaluates its policyInput (and would throw on this one), so the
    // valid decision fields come from a valid input and the STORED input is
    // then overridden with the deliberately invalid durable record — replay
    // alone encounters and classifies it.
    const bad = {
      ...makeGate({ gateId: "gate-1" }),
      policyInput: { gateId: "gate-1", unknownKey: true },
    };
    const { skipped, counts } = replayMissionGates({ ...MISSION_RECORD, auditGates: [bad] });
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].reason, "invalid-policy-input");
    assert.equal(counts.skipped, 1);
  });

  it("a malformed record (no usable missionId) is one explicit skip with no gates", () => {
    const { gates, skipped, counts } = replayMissionGates({ auditGates: [makeGate()] });
    assert.equal(gates.length, 0);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].reason, "malformed-record");
    assert.deepEqual(counts, { replayed: 0, matched: 0, mismatched: 0, skipped: 1 });
  });

  it("deriveChainGateInput builds the richest deterministic input from durable chain/round records (criterion 5)", () => {
    const input = deriveChainGateInput(PLAIN_CHAIN, ROUND_WITH_EVIDENCE);
    assert.equal(input.gateId, "chain-replay-chain-1");
    assert.equal(input.reworkCount, 1, "T8 — durable rework count");
    assert.deepEqual(input.findings, [{ severity: "high", title: "Premise unverified" }], "T9 — durable findings");
    assert.equal(input.terminalDisposition, "escalate", "T10 — the terminal round's disposition");
    assert.equal(input.noFixClosure, false, "the round measured a worktree change");
    assert.equal(input.lunaRecommendsAccept, false, "plain chains have no Luna recommendation");
    assert.equal(input.publish, false);
    assert.deepEqual(input.changeScope, { added: [], deleted: [], modified: [] });
    assert.deepEqual(input.testChanges, { deleted: [], weakened: [], skipped: [] });
  });

  it("deriveChainGateInput derives no-fix closure (T2) chain-wide: true only when EVERY durable round measured no worktree change", () => {
    const noFixRound = { ...ROUND_WITH_EVIDENCE, worktreeChanged: false };
    const allFalse = { ...PLAIN_CHAIN, records: [noFixRound, { ...noFixRound, round: 1 }] };
    assert.equal(deriveChainGateInput(allFalse, noFixRound).noFixClosure, true,
      "every round measured no worktree change \u2014 no-fix closure is claimable");

    const earlierTrue = { ...PLAIN_CHAIN, records: [{ ...noFixRound, round: 1, worktreeChanged: true }, noFixRound] };
    assert.equal(deriveChainGateInput(earlierTrue, noFixRound).noFixClosure, false,
      "an earlier round that measured a worktree change prevents the no-fix claim");

    const laterTrue = { ...PLAIN_CHAIN, records: [noFixRound, { ...noFixRound, round: 2, worktreeChanged: true }] };
    assert.equal(deriveChainGateInput(laterTrue, noFixRound).noFixClosure, false,
      "a later round that measured a worktree change prevents the no-fix claim");

    const unknownRound = { ...noFixRound, worktreeChanged: undefined };
    const unknown = { ...PLAIN_CHAIN, records: [unknownRound, noFixRound] };
    assert.equal(deriveChainGateInput(unknown, noFixRound).noFixClosure, false,
      "an unmeasured round (absent worktreeChanged) prevents the no-fix claim");

    assert.equal(deriveChainGateInput({ ...PLAIN_CHAIN, records: [] }, noFixRound).noFixClosure, false,
      "a chain with no durable rounds never claims no-fix closure");
  });

  it("replayChainGates replays EVERY durable round and reports mandatory triggers derived from durable records (criterion 5)", () => {
    const { gates, skipped, counts } = replayChainGates(PLAIN_CHAIN);
    assert.equal(skipped.length, 0);
    assert.equal(counts.replayed, 2, "both durable rounds replay independently");
    assert.equal(gates[0].round, 1);
    assert.equal(gates[1].round, 2);
    for (const gate of gates) {
      assert.equal(gate.gateId, "chain-replay-chain-1");
    }
    // The evidence round (round 2) carries the mandatory triggers.
    const gate = gates[1];
    assert.equal(gate.mandatory, true, "escalate disposition + high finding + rework are mandatory, never sampled-only");
    const ids = gate.decision.triggers.map((t) => t.id);
    for (const expected of ["T8", "T9", "T10"]) {
      assert.ok(ids.includes(expected), `derived input must fire ${expected}, got ${ids.join(",")}`);
    }
    assert.equal(gate.decision.triggers.some((t) => t.id === "T12"), false, "no sampling configured: T12 must not fire");
  });

  it("T12 sampling uses the durable subject id: the mission id for missions, the chain id for plain chains (criterion 6)", () => {
    // Mission replay: rate=1 forces T12; the sampled trigger must name the
    // MISSION id, not a guessed unit.
    const sampling = { rate: 1, salt: "v1" };
    const missionGate = makeGate({
      gateId: "gate-1",
      policyInput: {
        gateId: "gate-1",
        lunaRecommendsAccept: false,
        changeScope: {},
        sampling: { missionId: MISSION_RECORD.missionId, rate: 1, salt: "v1" },
      },
    });
    const missionGateRecord = {
      ...missionGate,
      sampled: true,
      mandatory: false,
      triggers: evaluateAuditGate(missionGate.policyInput).triggers,
    };
    const { gates: missionGates } = replayMissionGates({ ...MISSION_RECORD, auditGates: [missionGateRecord] });
    const t12 = missionGates[0].decision.triggers.find((t) => t.id === "T12");
    assert.ok(t12, "rate=1 sampling must fire T12 on a mission replay");
    assert.match(t12.detail, /mission-abc/, "T12 must name the mission id as its sample unit");

    // Plain-chain replay: the chain id is the sample unit.
    const chainInput = deriveChainGateInput(PLAIN_CHAIN, ROUND_WITH_EVIDENCE, { sampling });
    assert.deepEqual(chainInput.sampling, { missionId: "chain-1", rate: 1, salt: "v1" });
    const { gates: chainGates } = replayChainGates(PLAIN_CHAIN, { sampling });
    const chainT12 = chainGates[0].decision.triggers.find((t) => t.id === "T12");
    assert.ok(chainT12, "rate=1 sampling must fire T12 on a plain-chain replay");
    assert.match(chainT12.detail, /chain-1/, "T12 must name the chain id as its sample unit");
  });

  it("reportMissedTriggers reports additional mandatory triggers without changing the stored/live verdict (criterion 6)", () => {
    // The live gate's recorded input omitted round evidence: no findings, no
    // disposition.  The offline chain-derived input carries them, so the
    // replay fires T9+T10 the live gate never saw.
    const legacyGate = makeGate({
      gateId: "gate-1",
      policyInput: {
        gateId: "gate-1",
        lunaRecommendsAccept: false,
        changeScope: {},
        sampling: { missionId: "mission-abc", rate: 0, salt: "v1" },
      },
    });
    const derivedInput = deriveChainGateInput(PLAIN_CHAIN, ROUND_WITH_EVIDENCE, { sampling: { rate: 0, salt: "v1" } });
    const report = reportMissedTriggers({
      recordedGate: legacyGate,
      derivedInput,
      recordedVerdict: "clear",
      liveDisposition: "recommend-accept",
    });
    const additionalIds = report.additionalMandatory.map((t) => t.id);
    assert.ok(additionalIds.includes("T9"), `T9 (high finding) must be reported as missed, got ${additionalIds.join(",")}`);
    assert.ok(additionalIds.includes("T10"), `T10 (escalate) must be reported as missed, got ${additionalIds.join(",")}`);
    assert.equal(report.liveVerdictUnchanged, true, "the report is a pure computation — the stored/live verdict is untouched");
    assert.equal(report.recordedVerdict, "clear");
    assert.equal(report.liveDisposition, "recommend-accept");
  });

  it("reportMissedTriggers keeps sampled-only triggers distinct from mandatory triggers (criterion 6)", () => {
    // A legacy mission whose recorded input sampled rate=1 but carried no
    // round evidence: the replay fires ONLY T12 (sampled), never a mandatory
    // trigger.  The report must keep it in sampledOnly and report zero
    // additional mandatory triggers.
    const legacyGate = makeGate({
      gateId: "gate-1",
      policyInput: {
        gateId: "gate-1",
        lunaRecommendsAccept: false,
        changeScope: {},
        sampling: { missionId: "mission-abc", rate: 1, salt: "v1" },
      },
    });
    const emptyRound = {
      round: 1,
      worktreeChanged: true,
      findings: [],
      disposition: { disposition: "accept" },
      reworkCount: 0,
    };
    const derivedInput = deriveChainGateInput({ ...PLAIN_CHAIN, chainId: "mission-abc" }, emptyRound, { sampling: { rate: 1, salt: "v1" } });
    const report = reportMissedTriggers({ recordedGate: legacyGate, derivedInput });
    assert.equal(report.additionalMandatory.length, 0, "a T12-only replay is not a missed mandatory trigger");
    assert.ok(report.sampledOnly.length >= 1, "the sampled trigger must be reported separately");
    assert.ok(report.sampledOnly.every((t) => t.id === "T12"));
  });

  it("mission sampling override stays valid: a recorded gate WITHOUT sampling replays when the CLI supplies {rate,salt}, injecting the durable mission id (finding 1)", () => {
    // The recorded gate never sampled (no policyInput.sampling block); the
    // CLI supplies {rate: 1, salt}.  The override must carry the durable
    // mission id as its T12 sample unit — otherwise evaluateAuditGate would
    // reject the mission-less sampling and the gate would be skipped instead
    // of replayed.
    const noSamplingGate = makeGate({
      gateId: "gate-1",
      policyInput: { gateId: "gate-1", lunaRecommendsAccept: false, changeScope: {} },
    });
    const { gates, skipped, counts } = replayMissionGates(
      { ...MISSION_RECORD, auditGates: [noSamplingGate] },
      { sampling: { rate: 1, salt: "v1" } },
    );
    assert.equal(skipped.length, 0, "the override must make the replay VALID, never a skip");
    assert.equal(counts.skipped, 0);
    assert.equal(gates.length, 1);
    const t12 = gates[0].decision.triggers.find((t) => t.id === "T12");
    assert.ok(t12, "the CLI sampling override must fire T12 on the mission replay");
    assert.match(t12.detail, /mission-abc/, "the durable mission id is injected as the T12 sample unit");
    assert.equal(gates[0].decision.sampled, true);
  });

  it("a fully recorded policyInput.sampling wins over the CLI override \u2014 its subject id/rate/salt are never overwritten (finding 1)", () => {
    const recordedGate = makeGate({
      gateId: "gate-1",
      policyInput: {
        gateId: "gate-1",
        lunaRecommendsAccept: false,
        changeScope: {},
        sampling: { missionId: "mission-other", rate: 1, salt: "v1" },
      },
    });
    // The CLI override (rate 0, salt v2) must NOT replace the recorded block.
    const { gates, skipped } = replayMissionGates(
      { ...MISSION_RECORD, auditGates: [recordedGate] },
      { sampling: { rate: 0, salt: "v2" } },
    );
    assert.equal(skipped.length, 0);
    const t12 = gates[0].decision.triggers.find((t) => t.id === "T12");
    assert.ok(t12, "the RECORDED sampling block still fires T12");
    assert.match(t12.detail, /mission-other/, "the recorded subject id is preserved");
    assert.match(t12.detail, /rate=1/, "the recorded rate is preserved");
    assert.match(t12.detail, /salt=v1/, "the recorded salt is preserved");
    assert.equal(gates[0].matchesRecorded, true, "the replayed decision still matches the recorded one");
  });

  it("an invalid/missing mission id with a sampling override is an explicit skip, never a crash (finding 1)", () => {
    // The record has no usable missionId: even with a CLI sampling override
    // the whole record is one explicit malformed-record skip with no gates.
    const { gates, skipped, counts } = replayMissionGates(
      { auditGates: [makeGate()] },
      { sampling: { rate: 1, salt: "v1" } },
    );
    assert.equal(gates.length, 0);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].reason, "malformed-record");
    assert.deepEqual(counts, { replayed: 0, matched: 0, mismatched: 0, skipped: 1 });

    const blank = replayMissionGates(
      { missionId: "   ", auditGates: [makeGate()] },
      { sampling: { rate: 1, salt: "v1" } },
    );
    assert.equal(blank.skipped.length, 1);
    assert.equal(blank.skipped[0].reason, "malformed-record");
    assert.equal(blank.counts.skipped, 1);
  });

  it("bad legacy chain rounds are skipped, never fatal: an unknown finding severity is counted and later valid rounds still replay (finding 2)", () => {
    const legacyChain = {
      chainId: "chain-legacy-1",
      records: [
        { round: 1, verdict: "approve", findings: [{ severity: "mystery", title: "Legacy" }] },
        ROUND_WITH_EVIDENCE,
      ],
    };
    const { gates, skipped, counts } = replayChainGates(legacyChain);
    assert.equal(skipped.length, 1, "the invalid round is counted and skipped");
    assert.equal(skipped[0].reason, "invalid-policy-input");
    assert.equal(skipped[0].gateId, "chain-replay-chain-legacy-1");
    assert.equal(counts.skipped, 1);
    assert.equal(counts.replayed, 1, "the later valid round still replays");
    assert.equal(gates.length, 1);
    assert.equal(gates[0].round, 2);
    assert.ok(gates[0].decision.triggers.some((t) => t.id === "T9"), "the valid round's high finding still fires T9");
  });

  it("bad legacy chain rounds are skipped, never fatal: an unknown terminal disposition is counted and later valid rounds still replay (finding 2)", () => {
    const legacyChain = {
      chainId: "chain-legacy-2",
      records: [
        { round: 1, verdict: "approve", disposition: { disposition: "bogus-ending" } },
        { round: 2, verdict: "approve", disposition: { disposition: "escalate" }, findings: [] },
      ],
    };
    const { gates, skipped, counts } = replayChainGates(legacyChain);
    assert.equal(skipped.length, 1, "the invalid round is counted and skipped");
    assert.equal(skipped[0].reason, "invalid-policy-input");
    assert.equal(counts.replayed, 1, "the later valid round still replays");
    assert.equal(gates.length, 1);
    assert.equal(gates[0].round, 2);
    assert.ok(gates[0].decision.triggers.some((t) => t.id === "T10"), "the valid round's escalate disposition still fires T10");
  });
});