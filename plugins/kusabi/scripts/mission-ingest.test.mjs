// mission-ingest.test.mjs — acceptance tests for the kusabi #532 mission
// ingest (issue #532 criterion 2; frozen for the implementation chain).
//
// Frozen contract:
//
//   parseMissionRecord(missionJson, ctx = {}) -> { missionRow, gateRows } | null
//     Pure — no I/O.  Returns null when the record is not recognisable as a
//     mission record (no usable missionId); the caller counts that as a
//     parse failure.  Everything else degrades field-by-field to null.
//
//     The mission row preserves EXACTLY:
//       mission id, workspace slug, container, status,
//       coordinator provider / model / requested / actual / reasoning effort /
//         substituted, and the same set for the auditor,
//       coordinator errors, brief corrections, host interventions,
//       started/finished timestamps and latency seconds,
//       token/cost fields (tokens_input/output/reasoning/cache_read/cache_write,
//         cost), disposition, recommendation.
//     The gate rows preserve the recorded gate's phase, consultation origin
//     ("luna-requested" | "policy-mandated" | "sampled"), verdict,
//     disposition, fail-closed reason, required/mandatory/sampled flags, the
//     normalized policyInput (as JSON) and the deterministic
//     shadow_disposition computed with solVerdict: null.
//
//     MISSING legacy fields remain SQL NULL, never coerced to 0 or to a
//     guessed value.  A measured 0 (e.g. host_interventions: 0) stays 0 —
//     absent and measured-zero are different facts.
//
//   ingestMissionDirectory(db, stateRoot) -> summary
//     Walks `<stateRoot>/<slug>/missions/mission-<id>/mission.json` and
//     upserts mission + audit_gate rows through the metrics store helpers
//     (upsertMission / upsertAuditGate from metrics-db.mjs).  Mirrors the
//     chain walker's counters:
//       { workspacesScanned, missionsScanned, filesSkippedUnchanged,
//         ioFailures, parseFailures, missionsIngested, gatesIngested }
//     A mission directory with no mission.json is silently skipped (nothing
//     usable was ever persisted); a mission.json that cannot be read counts
//     ioFailures; one that is read but fails JSON.parse or has no missionId
//     counts parseFailures.  Re-running over unchanged files skips them via
//     the source_file skip-cache (speed only — never load-bearing).
//
// The record shape ingested here is the mission.json written by the luna
// driver (mission-store.mjs createMission plus the #532 additive fields).

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openMetricsDb, countRows } from "./metrics-db.mjs";
import {
  parseMissionRecord,
  ingestMissionDirectory,
} from "./mission-ingest.mjs";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const GATE = {
  gateId: "gate-1",
  phase: "pre-dispatch",
  origin: "policy-mandated",
  verdict: "clear",
  disposition: "verdict-recorded",
  reason: null,
  required: true,
  mandatory: true,
  sampled: false,
  policyInput: {
    gateId: "gate-1",
    lunaRecommendsAccept: false,
    changeScope: { added: [], deleted: [], modified: [] },
    sampling: null,
  },
  shadowDisposition: "sol-blocked",
  recordedAt: "2026-09-01T09:00:05.000Z",
};

function makeMission(overrides = {}) {
  return {
    missionId: "mission-abc",
    container: "cid-1",
    missionFile: "/tmp/mission.md",
    pid: 4242,
    status: "completed",
    coordinator: {
      provider: "codex",
      model: "gpt-5.6-luna",
      requested: "gpt-5.6-luna",
      actual: "gpt-5.6-luna",
      substituted: false,
      reasoningEffort: "high",
    },
    auditor: {
      provider: "codex",
      model: "gpt-5.6-sol",
      requested: "gpt-5.6-sol",
      actual: "gpt-5.6-sol",
      substituted: false,
      reasoningEffort: "high",
    },
    attempts: [{ index: 1, action: "run_chain", chainId: "chain-inner-1" }],
    chains: ["chain-inner-1"],
    coordinatorErrors: 2,
    briefCorrections: 1,
    hostInterventions: 0,
    tokens: { input: 1000, output: 500, reasoning: 200, cacheRead: 10, cacheWrite: 5 },
    cost: 0.042,
    startedAt: "2026-09-01T09:00:00.000Z",
    finishedAt: "2026-09-01T11:30:00.000Z",
    latencySeconds: 9000,
    recommendation: "recommend-accept",
    disposition: "recommend-accept",
    auditGates: [GATE],
    ...overrides,
  };
}

/** A legacy pre-#532 mission record: provenance but no new fields at all. */
function legacyMission() {
  const rec = makeMission();
  delete rec.briefCorrections;
  delete rec.hostInterventions;
  delete rec.tokens;
  delete rec.cost;
  delete rec.finishedAt;
  delete rec.latencySeconds;
  delete rec.auditGates;
  delete rec.coordinator.reasoningEffort;
  delete rec.auditor.reasoningEffort;
  return rec;
}

describe("parseMissionRecord (kusabi #532 criterion 2)", () => {
  it("surface: exports parseMissionRecord and ingestMissionDirectory", () => {
    assert.equal(typeof parseMissionRecord, "function");
    assert.equal(typeof ingestMissionDirectory, "function");
  });

  it("returns null for a record with no usable mission id (caller counts it as a parse failure)", () => {
    assert.equal(parseMissionRecord(null), null);
    assert.equal(parseMissionRecord({}), null);
    assert.equal(parseMissionRecord({ missionId: 7 }), null);
  });

  it("preserves the exact coordinator/auditor provider, requested/actual model, reasoning effort and substitution state", () => {
    const { missionRow } = parseMissionRecord(makeMission());
    assert.equal(missionRow.missionId, "mission-abc");
    assert.equal(missionRow.coordinatorProvider, "codex");
    assert.equal(missionRow.coordinatorModel, "gpt-5.6-luna");
    assert.equal(missionRow.coordinatorModelRequested, "gpt-5.6-luna");
    assert.equal(missionRow.coordinatorModelActual, "gpt-5.6-luna");
    assert.equal(missionRow.coordinatorReasoningEffort, "high");
    assert.equal(missionRow.coordinatorSubstituted, 0);
    assert.equal(missionRow.auditorProvider, "codex");
    assert.equal(missionRow.auditorModel, "gpt-5.6-sol");
    assert.equal(missionRow.auditorModelRequested, "gpt-5.6-sol");
    assert.equal(missionRow.auditorModelActual, "gpt-5.6-sol");
    assert.equal(missionRow.auditorReasoningEffort, "high");
    assert.equal(missionRow.auditorSubstituted, 0);
  });

  it("preserves an authorized substitution exactly (requested != actual, substituted = 1)", () => {
    const rec = makeMission({
      coordinator: {
        provider: "codex",
        model: "gpt-5.6-luna-alternate",
        requested: "gpt-5.6-luna",
        actual: "gpt-5.6-luna-alternate",
        substituted: true,
        reasoningEffort: "high",
      },
    });
    const { missionRow } = parseMissionRecord(rec);
    assert.equal(missionRow.coordinatorModel, "gpt-5.6-luna-alternate");
    assert.equal(missionRow.coordinatorModelRequested, "gpt-5.6-luna");
    assert.equal(missionRow.coordinatorModelActual, "gpt-5.6-luna-alternate");
    assert.equal(missionRow.coordinatorSubstituted, 1);
  });

  it("preserves coordinator errors, brief corrections, host interventions, timestamps/latency and token/cost fields", () => {
    const { missionRow } = parseMissionRecord(makeMission());
    assert.equal(missionRow.coordinatorErrors, 2);
    assert.equal(missionRow.briefCorrections, 1);
    assert.equal(missionRow.hostInterventions, 0, "a measured zero intervention is 0, never NULL");
    assert.equal(missionRow.startedAt, "2026-09-01T09:00:00.000Z");
    assert.equal(missionRow.startedMs, Date.parse("2026-09-01T09:00:00.000Z"));
    assert.equal(missionRow.finishedAt, "2026-09-01T11:30:00.000Z");
    assert.equal(missionRow.finishedMs, Date.parse("2026-09-01T11:30:00.000Z"));
    assert.equal(missionRow.latencySeconds, 9000);
    assert.equal(missionRow.tokensInput, 1000);
    assert.equal(missionRow.tokensOutput, 500);
    assert.equal(missionRow.tokensReasoning, 200);
    assert.equal(missionRow.tokensCacheRead, 10);
    assert.equal(missionRow.tokensCacheWrite, 5);
    assert.equal(missionRow.cost, 0.042);
    assert.equal(missionRow.disposition, "recommend-accept");
    assert.equal(missionRow.recommendation, "recommend-accept");
  });

  it("preserves the gate consultation origin, policy input and shadow disposition", () => {
    const { gateRows } = parseMissionRecord(makeMission());
    assert.equal(gateRows.length, 1);
    const g = gateRows[0];
    assert.equal(g.gateId, "gate-1");
    assert.equal(g.missionId, "mission-abc");
    assert.equal(g.phase, "pre-dispatch");
    assert.equal(g.origin, "policy-mandated");
    assert.equal(g.verdict, "clear");
    assert.equal(g.disposition, "verdict-recorded");
    assert.equal(g.required, 1);
    assert.equal(g.mandatory, 1);
    assert.equal(g.sampled, 0);
    assert.deepEqual(JSON.parse(g.policyInput), GATE.policyInput, "the normalized policyInput must survive verbatim");
    assert.equal(g.shadowDisposition, "sol-blocked");
  });

  it("missing legacy fields remain NULL, never 0 or a guessed value", () => {
    const { missionRow, gateRows } = parseMissionRecord(legacyMission());
    assert.equal(missionRow.coordinatorReasoningEffort, null);
    assert.equal(missionRow.auditorReasoningEffort, null);
    assert.equal(missionRow.briefCorrections, null);
    assert.equal(missionRow.hostInterventions, null);
    assert.equal(missionRow.tokensInput, null);
    assert.equal(missionRow.tokensOutput, null);
    assert.equal(missionRow.tokensReasoning, null);
    assert.equal(missionRow.tokensCacheRead, null);
    assert.equal(missionRow.tokensCacheWrite, null);
    assert.equal(missionRow.cost, null);
    assert.equal(missionRow.finishedAt, null);
    assert.equal(missionRow.finishedMs, null);
    assert.equal(missionRow.latencySeconds, null);
    assert.equal(gateRows.length, 0, "a legacy record with no auditGates yields no gate rows");
  });

  it("a legacy gate record without an origin is preserved as NULL, never guessed", () => {
    const rec = makeMission({ auditGates: [{ ...GATE, origin: undefined }] });
    delete rec.auditGates[0].origin;
    const { gateRows } = parseMissionRecord(rec);
    assert.equal(gateRows[0].origin, null);
  });
});

describe("ingestMissionDirectory (kusabi #532 criterion 2)", () => {
  let root;
  let stateRoot;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-mission-ingest-"));
    stateRoot = path.join(root, "state");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeMission(slug, missionJson) {
    const dir = path.join(stateRoot, slug, "missions", missionJson.missionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "mission.json"), JSON.stringify(missionJson), "utf8");
    return dir;
  }

  it("ingests mission and audit_gate rows through the metrics store helpers", () => {
    writeMission("ws-hash-1", makeMission());
    const db = openMetricsDb(":memory:");
    const summary = ingestMissionDirectory(db, stateRoot);
    assert.deepEqual(summary, {
      workspacesScanned: 1,
      missionsScanned: 1,
      filesSkippedUnchanged: 0,
      ioFailures: 0,
      parseFailures: 0,
      missionsIngested: 1,
      gatesIngested: 1,
    });
    assert.equal(countRows(db, "mission"), 1);
    assert.equal(countRows(db, "audit_gate"), 1);

    const row = db.prepare("SELECT * FROM mission WHERE mission_id = ?").get("mission-abc");
    assert.equal(row.coordinator_provider, "codex");
    assert.equal(row.coordinator_model_requested, "gpt-5.6-luna");
    assert.equal(row.coordinator_model_actual, "gpt-5.6-luna");
    assert.equal(row.coordinator_reasoning_effort, "high");
    assert.equal(row.coordinator_substituted, 0);
    assert.equal(row.brief_corrections, 1);
    assert.equal(row.host_interventions, 0);
    assert.equal(row.latency_seconds, 9000);
    assert.equal(row.cost, 0.042);

    const gate = db.prepare("SELECT * FROM audit_gate WHERE gate_id = ? AND mission_id = ?").get("gate-1", "mission-abc");
    assert.equal(gate.origin, "policy-mandated");
    assert.equal(gate.shadow_disposition, "sol-blocked");
    assert.equal(gate.sampled, 0);
  });

  it("re-running over unchanged files skips them (source_file skip-cache)", () => {
    writeMission("ws-hash-1", makeMission());
    const db = openMetricsDb(":memory:");
    const first = ingestMissionDirectory(db, stateRoot);
    const second = ingestMissionDirectory(db, stateRoot);
    assert.equal(first.missionsIngested, 1);
    assert.equal(second.missionsIngested, 0, "an unchanged mission file must not be re-ingested");
    assert.equal(second.filesSkippedUnchanged, 1);
    assert.equal(countRows(db, "mission"), 1, "re-ingest never duplicates rows");
    assert.equal(countRows(db, "audit_gate"), 1);
  });

  it("counts unreadable files as ioFailures and malformed JSON as parseFailures", () => {
    const dir = writeMission("ws-hash-1", makeMission());
    fs.writeFileSync(path.join(dir, "mission.json"), "{ not json", "utf8");
    const db = openMetricsDb(":memory:");
    const summary = ingestMissionDirectory(db, stateRoot);
    assert.equal(summary.ioFailures, 0);
    assert.equal(summary.parseFailures, 1);
    assert.equal(summary.missionsIngested, 0);
    assert.equal(countRows(db, "mission"), 0);
  });

  it("skips mission directories with no mission.json (nothing usable was ever persisted)", () => {
    fs.mkdirSync(path.join(stateRoot, "ws-hash-1", "missions", "mission-orphan"), { recursive: true });
    const db = openMetricsDb(":memory:");
    const summary = ingestMissionDirectory(db, stateRoot);
    assert.equal(summary.missionsScanned, 0);
    assert.equal(summary.missionsIngested, 0);
    assert.equal(summary.ioFailures, 0);
  });

  it("returns an all-zero summary for a missing state root", () => {
    const db = openMetricsDb(":memory:");
    const summary = ingestMissionDirectory(db, path.join(root, "does-not-exist"));
    assert.equal(summary.missionsIngested, 0);
    assert.equal(summary.workspacesScanned, 0);
  });
});