// eval-cmd: the read-only `evaluation` replay surface (kusabi #532) moved out
// of kusabi-companion.mjs verbatim (pure move refactor): assertEvalSubjectShape,
// findSubjectRecord, evalSampleRate and cmdEvaluation.  No behaviour change.

import { stateRoot, readJson } from "./state-paths.mjs";
// kusabi #532: the offline replay surface the read-only `evaluation`
// subcommand reports over (pure, synchronous — no model/network/dispatch).
import { replayMissionGates, replayChainGates } from "./audit-replay.mjs";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// evaluation (kusabi #532) — read-only offline replay of a named mission or
// plain chain from durable records alone, plus the replayed gate results.
// Never writes, never spawns, never dispatches: the subject id selects the
// record type by shape (mission-* -> mission replay, chain-* -> plain-chain
// replay) and the replay surface is the pure audit-replay module.
// ---------------------------------------------------------------------------

/** A subject id is a path segment under <stateRoot>/<slug>/{missions,chains}/. */
function assertEvalSubjectShape(subject, kind) {
  if (
    typeof subject !== "string" ||
    !new RegExp(`^${kind}-[a-z0-9-]+$`).test(subject) ||
    subject.includes("..")
  ) {
    throw new Error(
      `evaluation: invalid ${kind} id "${String(subject)}" — it must be a single path segment ` +
        `matching ${kind}-[a-z0-9-]+ (it becomes a path segment under the state root)`,
    );
  }
}

/** Find `<stateRoot>/<slug>/<kindDir>/<subject>/<recordFile>` across workspaces. */
function findSubjectRecord(subject, kindDir, recordFile) {
  const root = stateRoot();
  if (!fs.existsSync(root)) return null;
  let workspaceDirs;
  try {
    workspaceDirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return null;
  }
  for (const wdirent of workspaceDirs) {
    const target = path.join(root, wdirent.name, kindDir, subject, recordFile);
    if (fs.existsSync(target)) return target;
  }
  return null;
}

function evalSampleRate(raw) {
  if (raw === undefined) return 0;
  const rate = Number(raw);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new Error(`--sample-rate expects a number in [0, 1], got: ${raw}`);
  }
  return rate;
}

/**
 * cmdEvaluation — replay a named durable mission or plain chain and report
 * the replayed gate results (read-only, no LLM, no dispatch).
 *
 * `text` is the subject id.  A mission-* subject replays the recorded gates
 * from their recorded normalized policyInput (replayMissionGates); a chain-*
 * subject derives the richest durable input from chain.json + the terminal
 * round record (replayChainGates).  Gates whose recorded input is missing or
 * invalid are reported with the explicit stable skip reason — never guessed.
 * A missing subject is a usage error that fails BEFORE any dispatch.
 *
 * @param {string} cwd
 * @param {object} input — { flags, text }.
 * @returns {string} the evaluation manifest text.
 */
export function cmdEvaluation(cwd, { flags, text }) {
  const subject = (text ?? "").trim() || null;
  if (!subject) {
    throw new Error(
      "evaluation requires a subject id (a mission id or a chain id). " +
      "Usage: evaluation <missionId|chainId> [--sample-rate <0..1>] [--salt <string>]",
    );
  }
  const sampling =
    flags["sample-rate"] !== undefined || flags.salt !== undefined
      ? { rate: evalSampleRate(flags["sample-rate"]), salt: flags.salt ?? "v1" }
      : undefined;
  const lines = [];

  if (subject.startsWith("mission-")) {
    assertEvalSubjectShape(subject, "mission");
    const recordPath = findSubjectRecord(subject, "missions", "mission.json");
    if (!recordPath) {
      throw new Error(`evaluation: mission not found: ${subject}`);
    }
    const record = readJson(recordPath);
    if (!record || typeof record !== "object") {
      throw new Error(`evaluation: mission record unreadable for ${subject}`);
    }
    const { gates, skipped, counts } = replayMissionGates(record, {
      ...(sampling ? { sampling } : {}),
    });
    lines.push(`evaluation manifest: mission ${subject}`);
    lines.push(
      `  status: ${record.status ?? "unknown"}  disposition: ${record.disposition ?? "none"}  ` +
        `replayed: ${counts.replayed}  matched: ${counts.matched}  mismatched: ${counts.mismatched}  skipped: ${counts.skipped}`,
    );
    for (const gate of gates) {
      const triggerIds = gate.decision.triggers.map((t) => t.id).join(", ");
      lines.push(
        `  ${gate.gateId} (${gate.phase ?? "?"}, origin: ${gate.origin ?? "not recorded"}): ` +
          `recorded verdict ${gate.recordedVerdict ?? "none"} — replay ` +
          `${gate.matchesRecorded ? "matches" : "MISMATCHES"} the recorded decision` +
          (triggerIds ? ` (triggers: ${triggerIds})` : ""),
      );
    }
    for (const skip of skipped) {
      lines.push(
        `  skipped: ${skip.gateId ?? subject} — ${skip.reason} (${skip.detail})`,
      );
    }
    return lines.join("\n");
  }

  if (subject.startsWith("chain-")) {
    assertEvalSubjectShape(subject, "chain");
    const chainPath = findSubjectRecord(subject, "chains", "chain.json");
    if (!chainPath) {
      throw new Error(`evaluation: chain not found: ${subject}`);
    }
    const chainJson = readJson(chainPath);
    if (!chainJson || typeof chainJson !== "object") {
      throw new Error(`evaluation: chain record unreadable for ${subject}`);
    }
    const { gates, skipped, counts } = replayChainGates(chainJson, {
      ...(sampling ? { sampling } : {}),
    });
    lines.push(`evaluation manifest: chain ${subject}`);
    lines.push(
      `  replayed: ${counts.replayed}  skipped: ${counts.skipped}`,
    );
    for (const gate of gates) {
      lines.push(`  ${gate.gateId}:`);
      for (const t of gate.decision.triggers) {
        lines.push(`    ${t.id}: ${t.detail}`);
      }
      if (gate.decision.triggers.length === 0) {
        lines.push("    (no triggers fired on the derived durable input)");
      }
    }
    for (const skip of skipped) {
      lines.push(
        `  skipped: ${skip.gateId ?? subject} — ${skip.reason} (${skip.detail})`,
      );
    }
    return lines.join("\n");
  }

  throw new Error(
    `evaluation: unknown subject id: ${subject} — a subject id starts with ` +
      `mission- (mission replay) or chain- (plain-chain replay)`,
  );
}
