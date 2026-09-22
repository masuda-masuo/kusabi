// mission-ingest.mjs — parse kusabi luna mission records into mission /
// audit_gate rows, and a directory walker that feeds them into the metrics
// store (kusabi #532 criterion 2).
//
// Split the same way as chain-ingest.mjs: `parseMissionRecord` is a pure
// function (an already-JSON.parse'd mission.json object in, row shapes out),
// unit-testable with inline fixtures.  `ingestMissionDirectory` is the only
// piece that touches the filesystem or the database, and it never opens a
// database itself — `db` is always passed in by the caller (metrics-ingest
// command), which is what keeps this module testable against `:memory:`.
//
// NULL discipline (the existing three-state contract): a MISSING legacy
// field stays SQL NULL, never coerced to 0 or to a guessed value.  A
// measured 0 (e.g. host_interventions: 0) stays 0 — absent and
// measured-zero are different facts.

import fs from "node:fs";
import path from "node:path";
import {
  upsertMission,
  upsertAuditGate,
  upsertSourceFile,
  isSourceFileUnchanged,
} from "./metrics-db.mjs";

function toBoolInt(v) {
  if (v === true) return 1;
  if (v === false) return 0;
  return null;
}

function str(v) {
  return typeof v === "string" ? v : null;
}

function num(v) {
  return typeof v === "number" ? v : null;
}

function tsMsOf(ts) {
  if (typeof ts !== "string" || !ts) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Parse one already-`JSON.parse`d mission.json object into row shapes.
 *
 * Pure — no I/O.  Returns `null` when the record is not recognisable as a
 * mission record at all (no usable `missionId`); the caller counts that as a
 * parse failure.  Everything else degrades field-by-field: an absent or
 * malformed sub-field becomes `null` on the row rather than throwing or
 * silently becoming 0.
 *
 * The gate rows preserve the recorded gate's phase, consultation origin
 * ("luna-requested" | "policy-mandated" | "sampled"), verdict, disposition,
 * fail-closed reason, required/mandatory/sampled flags, the normalized
 * policyInput (as JSON, verbatim) and the deterministic shadow disposition
 * computed with solVerdict: null.
 *
 * @param {*} missionJson
 * @param {{ workspaceSlug?: string }} [ctx]
 * @returns {{ missionRow: object, gateRows: object[] } | null}
 */
export function parseMissionRecord(missionJson, ctx = {}) {
  if (!missionJson || typeof missionJson !== "object") return null;
  const missionId = missionJson.missionId;
  if (typeof missionId !== "string" || !missionId) return null;

  const coordinator =
    missionJson.coordinator && typeof missionJson.coordinator === "object"
      ? missionJson.coordinator
      : {};
  const auditor =
    missionJson.auditor && typeof missionJson.auditor === "object"
      ? missionJson.auditor
      : {};
  const tokens =
    missionJson.tokens && typeof missionJson.tokens === "object"
      ? missionJson.tokens
      : {};

  const missionRow = {
    missionId,
    workspaceSlug: ctx.workspaceSlug ?? null,
    container: str(missionJson.container),
    status: str(missionJson.status),
    // Exact seat provenance — requested vs actual vs substituted, preserved
    // verbatim; an absent field stays NULL.
    coordinatorProvider: str(coordinator.provider),
    coordinatorModel: str(coordinator.model),
    coordinatorModelRequested: str(coordinator.requested),
    coordinatorModelActual: str(coordinator.actual),
    coordinatorReasoningEffort: str(coordinator.reasoningEffort),
    coordinatorSubstituted: toBoolInt(coordinator.substituted),
    auditorProvider: str(auditor.provider),
    auditorModel: str(auditor.model),
    auditorModelRequested: str(auditor.requested),
    auditorModelActual: str(auditor.actual),
    auditorReasoningEffort: str(auditor.reasoningEffort),
    auditorSubstituted: toBoolInt(auditor.substituted),
    coordinatorErrors: num(missionJson.coordinatorErrors),
    briefCorrections: num(missionJson.briefCorrections),
    hostInterventions: num(missionJson.hostInterventions),
    startedAt: str(missionJson.startedAt),
    startedMs: tsMsOf(missionJson.startedAt),
    finishedAt: str(missionJson.finishedAt),
    finishedMs: tsMsOf(missionJson.finishedAt),
    latencySeconds: num(missionJson.latencySeconds),
    tokensInput: num(tokens.input),
    tokensOutput: num(tokens.output),
    tokensReasoning: num(tokens.reasoning),
    tokensCacheRead: num(tokens.cacheRead),
    tokensCacheWrite: num(tokens.cacheWrite),
    cost: num(missionJson.cost),
    disposition: str(missionJson.disposition),
    recommendation: str(missionJson.recommendation),
  };

  const gateRows = [];
  const gates = Array.isArray(missionJson.auditGates) ? missionJson.auditGates : [];
  for (const gate of gates) {
    if (!gate || typeof gate !== "object") continue;
    gateRows.push({
      gateId: str(gate.gateId),
      missionId,
      phase: str(gate.phase),
      origin: str(gate.origin),
      verdict: str(gate.verdict),
      disposition: str(gate.disposition),
      reason: str(gate.reason),
      required: toBoolInt(gate.required),
      mandatory: toBoolInt(gate.mandatory),
      sampled: toBoolInt(gate.sampled),
      policyInput:
        gate.policyInput && typeof gate.policyInput === "object"
          ? JSON.stringify(gate.policyInput)
          : null,
      shadowDisposition: str(gate.shadowDisposition),
      recordedAt: str(gate.recordedAt),
    });
  }

  return { missionRow, gateRows };
}

/**
 * Walk `stateRoot` (the kusabi state root, e.g. `~/.kusabi`) for mission
 * records at `<stateRoot>/<workspace-hash>/missions/mission-<id>/mission.json`,
 * parse each with `parseMissionRecord`, and upsert mission + audit_gate rows
 * into `db`.
 *
 * A mission directory with no `mission.json` is silently skipped (nothing
 * usable was ever persisted) and never counted.  Two distinct problem
 * counters, kept separate deliberately (mirroring chain-ingest.mjs):
 * `ioFailures` counts a whole `mission.json` that could not be stat'd or
 * read; `parseFailures` counts a `mission.json` that WAS read but failed
 * `JSON.parse`, or parsed to something with no usable `missionId`.
 *
 * Re-running over unchanged files skips them via the source_file skip-cache
 * (speed only — never load-bearing; the PRIMARY KEY + INSERT OR REPLACE
 * upserts make re-ingest idempotent on their own).
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} stateRoot
 * @returns {{
 *   workspacesScanned: number, missionsScanned: number,
 *   filesSkippedUnchanged: number, ioFailures: number, parseFailures: number,
 *   missionsIngested: number, gatesIngested: number,
 * }}
 */
export function ingestMissionDirectory(db, stateRoot) {
  const summary = {
    workspacesScanned: 0,
    missionsScanned: 0,
    filesSkippedUnchanged: 0,
    ioFailures: 0,
    parseFailures: 0,
    missionsIngested: 0,
    gatesIngested: 0,
  };

  if (!fs.existsSync(stateRoot)) return summary;

  let workspaceDirs;
  try {
    workspaceDirs = fs.readdirSync(stateRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return summary;
  }

  for (const wdirent of workspaceDirs) {
    const missionsDir = path.join(stateRoot, wdirent.name, "missions");
    if (!fs.existsSync(missionsDir)) continue;
    summary.workspacesScanned += 1;

    let missionDirs;
    try {
      missionDirs = fs.readdirSync(missionsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      continue;
    }

    for (const mdirent of missionDirs) {
      if (!mdirent.name.startsWith("mission-")) continue;
      const missionJsonPath = path.join(missionsDir, mdirent.name, "mission.json");
      if (!fs.existsSync(missionJsonPath)) continue; // died before persisting — not a failure

      summary.missionsScanned += 1;

      let stat;
      try {
        stat = fs.statSync(missionJsonPath);
      } catch {
        summary.ioFailures += 1;
        continue;
      }

      if (isSourceFileUnchanged(db, missionJsonPath, stat.size, stat.mtimeMs)) {
        summary.filesSkippedUnchanged += 1;
        continue;
      }

      let raw;
      try {
        raw = fs.readFileSync(missionJsonPath, "utf8");
      } catch {
        summary.ioFailures += 1;
        continue;
      }

      let missionJson;
      try {
        missionJson = JSON.parse(raw);
      } catch {
        summary.parseFailures += 1;
        continue;
      }

      const parsed = parseMissionRecord(missionJson, { workspaceSlug: wdirent.name });
      if (!parsed) {
        summary.parseFailures += 1;
        continue;
      }

      summary.missionsIngested += 1;
      summary.gatesIngested += parsed.gateRows.length;

      upsertMission(db, parsed.missionRow);
      for (const gate of parsed.gateRows) upsertAuditGate(db, gate);
      upsertSourceFile(db, {
        path: missionJsonPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ingestedAt: new Date().toISOString(),
      });
    }
  }

  return summary;
}