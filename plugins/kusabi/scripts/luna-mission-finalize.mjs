// Ordered terminal persistence, recommendation, notification and cleanup.
import fs from "node:fs";
import path from "node:path";
import { readJson } from "./state-paths.mjs";
import { finalizeMissionControl } from "./mission-store.mjs";
import { renderRecommendation } from "./render-recommendation.mjs";
import { replaceRecord } from "./luna-mission-ledger.mjs";

/**
 * The mission's one-time outer serve cleanup, using the same guarded
 * semantics the chain driver applies to its own serve-stop: stop the shared
 * serve only when no live jobs remain (liveRunningJobs applies the same
 * fossil rule as cmdServeStop).  The mission passes `keepServe: true` to
 * inner chains, so the chains never stop the serve themselves — the mission
 * is the single outer serve owner and must stop it exactly once, after all
 * inner work, when it actually invoked inner chain work.
 *
 * Best-effort by contract: a cleanup failure must never mask the mission's
 * terminal result (the caller wraps this).
 *
 * @param {string} cwd
 * @param {string} stateDir
 */
export async function defaultGuardedServeStop(cwd, stateDir) {
  const { liveRunningJobs, cmdServeStop } = await import("./job-control-cmd.mjs");
  const hasRunning = liveRunningJobs(stateDir).length > 0;
  if (!hasRunning) {
    cmdServeStop(cwd);
  }
}

/**
 * Write the host-facing recommendation artifact for a terminal mission.
 * `finish` writes the recommendation; `escalate_to_host` writes the handoff
 * reason; the failure dispositions write their disposition and, when present,
 * a reason (e.g. the budget bound that was exhausted, or the fail-closed
 * cause of a sol-blocked gate).
 */
export function writeRecommendationFile(missionDir, {
  missionId,
  disposition,
  recommendation,
  reason,
  gate,
  lastCorrectionDetail,
  lastCoordinatorErrorDetail,
  record,
  briefText,
  stateDir,
}) {
  const chains = {};
  const chainIds = new Set();
  if (Array.isArray(record?.chains)) {
    for (const cid of record.chains) {
      if (typeof cid === "string" && cid) chainIds.add(cid);
    }
  }
  if (Array.isArray(record?.attempts)) {
    for (const att of record.attempts) {
      const cid = att?.chainId ?? att?.postChain?.chainId;
      if (typeof cid === "string" && cid) chainIds.add(cid);
    }
  }
  const effectiveStateDir = stateDir ?? (missionDir ? path.dirname(path.dirname(missionDir)) : null);
  const chainControls = {};
  for (const cid of chainIds) {
    let chainJson = null;
    try {
      if (effectiveStateDir) {
        chainJson = readJson(path.join(effectiveStateDir, "chains", cid, "chain.json"));
      }
    } catch {
      chainJson = null;
    }
    chains[cid] = (chainJson && typeof chainJson === "object") ? chainJson : null;

    let controlJson = null;
    try {
      if (effectiveStateDir) {
        controlJson = readJson(path.join(effectiveStateDir, "chains", cid, "control.json"));
      }
    } catch {
      controlJson = null;
    }
    chainControls[cid] = (controlJson && typeof controlJson === "object") ? controlJson : null;
  }

  const gateEnvelopes = {};
  const gateIds = new Set();
  if (gate?.gateId) gateIds.add(gate.gateId);
  if (Array.isArray(record?.auditGates)) {
    for (const g of record.auditGates) {
      if (g?.gateId) gateIds.add(g.gateId);
    }
  }
  for (const gid of gateIds) {
    let envJson = null;
    try {
      if (missionDir) {
        envJson = readJson(path.join(missionDir, "evidence", `gate-envelope-${gid}.json`));
      }
    } catch {
      envJson = null;
    }
    gateEnvelopes[gid] = (envJson && typeof envJson === "object") ? envJson : null;
  }

  const content = renderRecommendation({
    missionId,
    disposition,
    recommendation,
    reason,
    gate,
    lastCorrectionDetail,
    lastCoordinatorErrorDetail,
    record,
    briefText,
    chains,
    chainControls,
    gateEnvelopes,
  });

  fs.writeFileSync(path.join(missionDir, "recommendation.md"), content, "utf8");
}

/**
 * The default terminal mission notification (kusabi #531): one inbox record,
 * one deduplicated kaiba agenda row.  See chain-notify.notifyMissionTerminal.
 */
export async function defaultMissionNotify({ missionId, disposition, container, cwdLabel, stateDir, reason }) {
  const { notifyMissionTerminal } = await import("./chain-notify.mjs");
  return notifyMissionTerminal({
    stateDir,
    missionId,
    disposition,
    container,
    cwdLabel,
    reason,
  });
}

export async function finalizeMission(ctx, outcome) {
  const { missionId, missionDir, brief, stateDir, container, cwd,
    notifyMissionTerminal, guardedServeStop } = ctx;
  // ---- terminal finalisation (sticky by construction: it happens once) ----
  const terminationReason = outcome.handoffReason ?? outcome.reason ?? null;
  // Terminal wall-clock timing (kusabi #532 criterion 2): finishedAt is set
  // on terminal completion, and latencySeconds is the recorded wall clock
  // (finishedAt − startedAt); only when the durable startedAt is parseable
  // — a record without one gets finishedAt but never a fabricated latency.
  const finishedAt = new Date().toISOString();
  let latencySeconds;
  if (typeof ctx.record.startedAt === "string" && ctx.record.startedAt) {
    const startedMs = Date.parse(ctx.record.startedAt);
    if (Number.isFinite(startedMs)) {
      latencySeconds = (Date.parse(finishedAt) - startedMs) / 1000;
    }
  }
  replaceRecord(ctx, {
    status: "completed",
    disposition: outcome.disposition,
    recommendation: outcome.recommendation,
    terminationReason,
    finishedAt,
    ...(latencySeconds !== undefined ? { latencySeconds } : {}),
  });
  finalizeMissionControl(missionDir, outcome.disposition === "cancelled" ? "cancelled" : "completed");
  const lastCoordinatorErrorDetail =
    outcome.lastCoordinatorErrorDetail ??
    (Array.isArray(ctx.record.coordinatorErrorsDetails) && ctx.record.coordinatorErrorsDetails.length > 0
      ? ctx.record.coordinatorErrorsDetails[ctx.record.coordinatorErrorsDetails.length - 1]?.detail
      : null);
  writeRecommendationFile(missionDir, {
    missionId,
    disposition: outcome.disposition,
    recommendation: outcome.recommendation,
    reason: terminationReason,
    gate: outcome.gate,
    lastCorrectionDetail: outcome.lastCorrectionDetail,
    lastCoordinatorErrorDetail,
    record: ctx.record,
    briefText: brief,
    stateDir,
  });

  // ---- exactly one terminal notification per terminal mission ----
  const notifyReason =
    outcome.disposition === "sol-blocked" && outcome.gate
      ? (() => {
          const g = outcome.gate;
          const vr = g?.verdictRecord;
          const text =
            (typeof vr?.block_reason === "string" && vr.block_reason.trim()) ||
            (typeof vr?.summary === "string" && vr.summary.trim()) ||
            terminationReason ||
            "";
          const verdict = typeof g?.verdict === "string" ? g.verdict : "none";
          return g?.gateId ? `${g.gateId} ${verdict}: ${text}`.trim() : terminationReason;
        })()
      : terminationReason;

  try {
    await notifyMissionTerminal({
      missionId,
      disposition: outcome.disposition,
      missionDir,
      recommendation: outcome.recommendation,
      container,
      cwdLabel: path.basename(cwd),
      stateDir,
      reason: notifyReason ?? undefined,
    });
  } catch { /* best-effort — the terminal ctx.record is already durable */ }

  // ---- one-time outer serve cleanup (the mission owns the serve because it
  // passes keepServe: true to inner chains) ----
  // Runs on every terminal path — including coordinator failures and chain
  // failures — but only when inner chain work was actually invoked: a mission
  // with no inner chain never invents cleanup work.  Best-effort: a cleanup
  // failure must never mask the primary terminal result.
  if (ctx.invokedInnerChain || ctx.invokedInvestigation) {
    try {
      await guardedServeStop(cwd, stateDir);
    } catch { /* best-effort — never mask the terminal result */ }
  }

  return (
    `mission ${missionId}: disposition=${outcome.disposition}` +
    (outcome.recommendation ? ` recommendation=${outcome.recommendation}` : "") +
    (outcome.disposition === "cancelled" ? ` (cancelled)` : "") +
    (outcome.disposition === "sol-blocked" ? ` (${terminationReason ?? "sol-blocked"})` : "") +
    ` (recommendation: ${path.join(missionDir, "recommendation.md")})`
  );}
