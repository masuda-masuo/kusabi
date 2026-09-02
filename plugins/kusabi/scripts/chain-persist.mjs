// chain-persist.mjs — Chain state persistence and review-record writing
// for cmdChain (kusabi #451).
//
// Pure and state-writing functions for chain-wide usage totals,
// persisting round and chain state, and writing the postable review record.

import fs from "node:fs";
import path from "node:path";

import { renderReviewRecord } from "./render.mjs";
import { writeJson } from "./state-paths.mjs";

/**
 * Compute chain-wide usage totals from all round records.
 *
 * Archived review seats (kusabi #248) count too: a seat that died mid-stream
 * still burned tokens, and its spend moved off the live `reviewUsage` field
 * when the replacement seat was bought.  Dropping it here would make the
 * chain's reported cost quietly cheaper than the run actually was.
 */
export function computeChainTotals(records) {
  const chainTotals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const rec of records) {
    const seatUsages = Array.isArray(rec.reviewSeatFailures)
      ? rec.reviewSeatFailures.flatMap(function (s) { return [s?.reviewUsage, s?.reviewFirstUsage]; })
      : [];
    for (const usage of [rec.implementUsage, rec.reviewUsage, rec.reviewFirstUsage, ...seatUsages]) {
      if (usage && usage.available) {
        chainTotals.input += usage.input || 0;
        chainTotals.output += usage.output || 0;
        chainTotals.reasoning += usage.reasoning || 0;
        chainTotals.cacheRead += usage.cacheRead || 0;
        chainTotals.cacheWrite += usage.cacheWrite || 0;
        chainTotals.cost += usage.cost || 0;
      }
    }
  }
  return chainTotals;
}

/**
 * Persist a round record and update chain.json.
 *
 * Writes both `round-N.json` and `chain.json` to the chain directory.
 *
 * `interrupted` (kusabi #153①): the chain stopped at a phase boundary inside
 * this round (implement + probes done, review not run).  The record is marked
 * `interrupted` so chain-show renders it as a partial round and chain-resume
 * can pick up at the next phase.  control.json is finalised by the caller.
 *
 * The round is pushed into `records` idempotently: a chain-resumed round was
 * already pushed when its partial state was persisted at stop time.
 */
export function persistChainState({
  chainDir, round, roundRecord, chainId, container, model, modelChain,
  reviewModel = null, reviewModelChain = null,
  reworkModel = null, reworkModelChain = null, reworkBackend = null,
  maxRounds, brief, orchestrator, records, baseSha, chainTotals,
  strategized, chainFollowupDraft, interrupted = false, verifyBaseline = null,
}) {
  if (interrupted) {
    roundRecord.interrupted = true;
    roundRecord.interruptedAfter = "probes";
  } else if (roundRecord.interrupted) {
    // The round completed after a resume: `interrupted` means "still
    // partial", so a completed round must not keep claiming it (#153①
    // review — chain-show would render a finished, dispositioned round as
    // "interrupted" forever).  The history moves to a separate trace field;
    // `resumed: true` stays for the recovery narrative.
    delete roundRecord.interrupted;
    delete roundRecord.interruptedAfter;
    roundRecord.wasInterrupted = true;
  }
  if (!records.includes(roundRecord)) {
    records.push(roundRecord);
  }
  writeJson(path.join(chainDir, "round-" + round + ".json"), roundRecord);
  writeJson(path.join(chainDir, "chain.json"), {
    chainId,
    container,
    model,
    modelChain,
    // Per-phase review dispatch context (kusabi #192): the review phase's
    // own model + route chain, so chain-resume re-dispatches review on the
    // same backend/model it originally ran on.  Old chain.json files lack
    // these; chain-resume falls back to modelChain / the record's backend.
    reviewModel,
    reviewModelChain,
    // Per-round rework dispatch context (kusabi #192 axis 2): the rework
    // phase's own model, route chain and backend, so chain-resume
    // re-dispatches rework rounds on the same backend/model they originally
    // ran on.  Null on chains without models.phases.rework (rework rounds
    // then continue on the implement resolution); chain.json files written
    // before the key existed lack these keys and chain-resume treats key
    // absence as legacy.
    reworkModel,
    reworkModelChain,
    reworkBackend,
    maxRounds,
    brief,
    orchestrator,
    records,
    baseSha,
    chainTotals,
    strategized,
    followupIssueDraft: chainFollowupDraft,
    // Chain-start verify baseline (kusabi #173): captured on the pristine
    // base before round-1 implement, reused verbatim by chain-resume.
    verifyBaseline,
  });
}

/**
 * Write the chain's postable review record (kusabi #52).
 *
 * Rendered by the pure `renderReviewRecord` (render.mjs) and written to the
 * chain's state directory as `review-record.md`. Written on terminal
 * dispositions (accept / accept-with-followup / escalate / max-rounds) and
 * as a provisional record on non-completed exits (cancelled / failed) when the
 * last round has probe results. Regeneration overwrites the previous record.
 * The companion only writes the local file and returns its path — posting it
 * to the archive repository is orchestrator-exclusive.
 *
 * @param {object} opts
 * @param {string} opts.chainDir
 * @param {string} opts.chainId
 * @param {string} opts.container
 * @param {Array}  [opts.modelChain]
 * @param {number} [opts.maxRounds]
 * @param {string} [opts.brief]
 * @param {object|null} [opts.orchestrator]
 * @param {Array}  [opts.records]       — round records (used as-is).
 * @param {object} [opts.chainTotals]   — existing chainTotals; recomputed
 *                                       from records only when not given.
 * @param {{disposition: string, round: number, reason?: string|null}} opts.disposition
 *                                       — the FINAL disposition.
 * @param {string} [opts.label]         — repo/cwd label for the header.
 * @param {string} [opts.finishedAt]    — ISO timestamp; defaults to now.
 * @param {boolean} [opts.provisional]  — true when chain ended at a non-completed exit.
 * @returns {string} The absolute path of the written record file.
 */
export function writeReviewRecord({
  chainDir, chainId, container, modelChain, maxRounds, brief, orchestrator,
  records, chainTotals, disposition, round, label, finishedAt, provisional,
}) {
  const safeRecords = Array.isArray(records) ? records : [];
  const markdown = renderReviewRecord({
    chainId,
    container,
    label,
    brief,
    orchestrator,
    modelChain,
    maxRounds,
    records: safeRecords,
    chainTotals: chainTotals ?? computeChainTotals(safeRecords),
    disposition: {
      disposition: typeof disposition === "string" ? disposition : (disposition?.disposition ?? "unknown"),
      round,
      reason: disposition?.reason ?? null,
    },
    finishedAt,
    provisional,
  });
  const recordPath = path.join(chainDir, "review-record.md");
  fs.mkdirSync(chainDir, { recursive: true });
  // Atomic write: readers must never observe a truncated record — the file is
  // posted as authoritative by the orchestrator.
  const tmpPath = recordPath + ".tmp";
  fs.writeFileSync(tmpPath, markdown, "utf8");
  fs.renameSync(tmpPath, recordPath);
  return recordPath;
}
