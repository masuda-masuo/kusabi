// chain-resume-resolve.mjs — Resume position and replacement review seat resolution.
//
// Extracted from chain-phases.mjs (kusabi #441).
// Pure decisions and record mutations for resuming stopped chains:
//   - resolveChainResume: determines the phase, round, and context to continue at.
//   - classifyReviewSeatReplacement: decides whether an escalate disposition qualifies
//     for a replacement review seat (kusabi #248).
//   - archiveFailedReviewSeat: moves a dead review seat's fields into reviewSeatFailures
//     and clears the live fields before buying a replacement seat.

import { effectiveStatus } from "./chain-control.mjs";
import {
  recordQuotaExhaustion,
  explicitRouteDiffersFromRecord,
  quotaReplacementRefusal,
} from "./chain-phases.mjs";

/**
 * Every field on a round record that describes the ROUND'S REVIEW, and that a
 * replacement review seat (kusabi #248) therefore rewrites.
 *
 * The list must stay complete, because several of these are written only
 * CONDITIONALLY by runReviewPhase — `reviewPartial` only when the stream was
 * partial, `verdictSource` only when the result was unparseable, the
 * `reviewFirst*` trio only when the unparseable retry fired.  A field left
 * behind would keep describing the DEAD seat next to the replacement's
 * verdict: a clean `approve` still flagged partial, or sourced
 * "recovered-from-token".  That is exactly the fail-open edge this feature
 * must not add, so archiving CLEARS them rather than trusting the overwrite.
 */
const REVIEW_SEAT_RECORD_FIELDS = [
  "verdict", "verdictSource", "reviewParseable", "salvagedVerdict",
  "reviewPartial", "reviewFindingCount", "reviewPartialDiagnosis",
  "reviewJobId", "reviewUsage", "reviewModelEntry", "reviewModelVariant",
  "reviewFallbacks", "reviewJobFailure", "reviewJobError",
  "reviewUnparseableRetried", "reviewSchemaRepaired", "reviewFirstJobId", "reviewFirstUsage", "reviewFirstFallbacks",
  "findingsText", "findings", "findingFiles",
  "disposition",
];

/**
 * Move a round record's FAILED review seat into `reviewSeatFailures` and clear
 * the live review fields, so a replacement seat (kusabi #248) can write its
 * own verdict without the dead seat's state surviving underneath it.
 *
 * The failed seat is preserved, never silently overwritten: the record keeps
 * saying that a first review died and how (`verdict`, its escalate
 * disposition, its job id and spend), and chain-show renders both it and the
 * replacement verdict.  The round itself is NOT duplicated — the same record
 * object is continued in place, so metrics ingest still sees one round row.
 *
 * Called by the driver's review-resume branch, once, immediately before the
 * replacement review is dispatched.  Idempotent in shape (repeated seat
 * failures append), so a chain that burns a second seat archives that one too.
 *
 * @param {object} roundRecord — the round record being resumed, mutated in place.
 * @returns {object} the same record.
 */
export function archiveFailedReviewSeat(roundRecord) {
  if (!roundRecord || typeof roundRecord !== "object") return roundRecord;
  if (!Array.isArray(roundRecord.reviewSeatFailures)) roundRecord.reviewSeatFailures = [];

  const seat = { seat: roundRecord.reviewSeatFailures.length + 1 };
  for (const field of REVIEW_SEAT_RECORD_FIELDS) {
    if (roundRecord[field] !== undefined) seat[field] = roundRecord[field];
    delete roundRecord[field];
  }
  roundRecord.reviewSeatFailures.push(seat);
  return roundRecord;
}

// =========================================================================
// Chain resume (kusabi #153①) — resume-position resolution
// =========================================================================

// ---- replacement review seat (kusabi #248) ------------------------------
//
// A chain can terminate on `escalate` for two very different reasons: the
// review JUDGED the work and found it wanting, or the review SEAT itself died
// mid-stream and never produced a judgement.  Only the second is a spent seat
// over an intact implementation, and only it may be re-bought by chain-resume.
//
// The two seat-failure states the review parser can produce (`partial`,
// `unparseable`) each escalate through deriveDisposition with a reason
// starting with one of these base strings (suffixed by partialDiagnosis
// when available, kusabi #312); the map is keyed by verdict so a seat-failure
// verdict carrying the other verdict's reason reads as inconsistent records,
// not as eligible.
// `needs-attention` and `discard` are deliberately absent: those are completed
// reviews judging the work, and they keep today's refusal.
const REVIEW_SEAT_FAILURE_REASONS = {
  partial: "partial review: stream ended before the verdict line",
  unparseable: "unexpected verdict: unparseable",
};

// The deterministic probes a replacement seat requires a record to COVER.
// runProbePhase always records at least these four (P1 HEAD clean / P2 verify
// gate / P3 deliverables / P4 smoke) on a run that got far enough to be green;
// a shorter list means the probe phase threw partway, so the record cannot
// testify that the work is intact.
//
// P5/P6 (kusabi #197) are deliberately NOT added here: this is a coverage
// floor, and records written before those probes existed must stay resumable.
// It costs nothing in strictness — the all-green check below runs over EVERY
// entry the record holds, so a red P5 disqualifies a seat replacement whether
// or not P5 is named in this list.
const REVIEW_SEAT_PROBES = ["P1", "P2", "P3", "P4"];

/** Not a seat failure at all — the caller keeps its existing refusal verbatim. */
const NOT_A_SEAT_FAILURE = Object.freeze({ eligible: false, detail: null });

/** Seat-failure SHAPE, but the records cannot decide it — name the field. */
function seatRecordsUndecidable(detail) {
  return { eligible: false, detail };
}

/** Append a fail-closed detail to a refusal, when there is one. */
function withSeatDetail(error, detail) {
  return detail ? `${error} — ${detail}` : error;
}

/**
 * Decide whether a chain's FINAL round may buy a replacement review seat
 * (kusabi #248).  Pure: reads only the persisted records, never an LLM and
 * never the worktree.
 *
 * Eligible iff all four hold for the last round record:
 *   1. probes P1–P4 all green,
 *   2. the review verdict is `partial` or `unparseable` (a dead seat — NOT
 *      `needs-attention`, which is a completed review judging the work),
 *   3. the escalate came from that seat failure (not discard, not max-rounds,
 *      not repeated-areas — each of those carries a different
 *      `disposition.reason`),
 *   4. the records needed to decide 1–3 are present and unambiguous.
 *
 * Fail closed (the resume guard's #192 history): a missing or ambiguous field
 * refuses and NAMES the field.  The two negative results are distinct on
 * purpose — `detail: null` means "this escalate was never a seat failure", so
 * the caller's existing refusal stands verbatim; a non-null `detail` means
 * "seat-failure shaped, but undecidable", and it is appended to that refusal.
 *
 * @param {object|null} chainJson — chain.json record.
 * @param {object} [opts]
 * @param {{ backend?: string|null, model?: string|null }|null} [opts.explicitRoute]
 *        — operator-named replacement route (chain-resume `--backend` /
 *        `--model`).  A quota-exhausted seat is never eligible on the SAME
 *        route (kusabi #373); an explicit different route may buy a new seat.
 * @returns {{ eligible: boolean, detail: string|null }}
 */
export function classifyReviewSeatReplacement(chainJson, { explicitRoute } = {}) {
  const records = Array.isArray(chainJson?.records) ? chainJson.records : [];
  const last = records.length > 0 ? records[records.length - 1] : null;
  if (!last || typeof last !== "object") return NOT_A_SEAT_FAILURE;
  if (last.disposition?.disposition !== "escalate") return NOT_A_SEAT_FAILURE;

  // Quota exhaustion is not an unreadable payload (kusabi #373): buying the
  // same seat cannot work.  An explicit different route is the one exception.
  const quota = recordQuotaExhaustion(last);
  const reroutingQuota = quota && explicitRouteDiffersFromRecord(last, explicitRoute);
  if (quota && !reroutingQuota) {
    return seatRecordsUndecidable(quotaReplacementRefusal(quota));
  }

  // The round number addresses the phase the driver re-dispatches; a record
  // that cannot name its own round has no position to resume at.
  if (!Number.isInteger(last.round) || last.round < 1) {
    return seatRecordsUndecidable(
      "the final round record has no usable `round` number — there is no position to resume at"
    );
  }
  const where = `round ${last.round}`;

  // ---- condition 2: a dead SEAT, not a review judgement ----
  // Skipped when rerouting a quota-dead seat: the disposition reason names
  // the exhausted pool, not `unexpected verdict: unparseable`, so the
  // verdict/reason pairing below would refuse a route the operator just named.
  if (!reroutingQuota) {
  const verdict = last.verdict;
  if (typeof verdict !== "string" || verdict === "") {
    return seatRecordsUndecidable(
      "the final round record has no review `verdict` — a dead review seat cannot be told from a completed review"
    );
  }
  const expectedReason = Object.prototype.hasOwnProperty.call(REVIEW_SEAT_FAILURE_REASONS, verdict)
    ? REVIEW_SEAT_FAILURE_REASONS[verdict]
    : null;
  // approve / approve-partial / needs-attention / discard and anything else:
  // a completed review, so this escalate is not a spent seat.
  if (!expectedReason) return NOT_A_SEAT_FAILURE;

  // ---- condition 3: the escalate came from THAT seat failure ----
  const reason = last.disposition?.reason;
  if (typeof reason !== "string" || reason === "") {
    return seatRecordsUndecidable(
      `${where} record has no \`disposition.reason\` — the escalate cause cannot be established`
    );
  }
  if (!reason.startsWith(expectedReason)) {
    // The OTHER seat-failure reason next to this verdict is contradictory
    // records; anything else (max-rounds, discard, repeated areas) is simply
    // a different escalate, which keeps the refusal verbatim.
    const isOtherSeatFailure = Object.entries(REVIEW_SEAT_FAILURE_REASONS).some(
      ([otherVerdict, otherBase]) => otherVerdict !== verdict && reason.startsWith(otherBase)
    );
    return isOtherSeatFailure
      ? seatRecordsUndecidable(
        `${where} record is inconsistent: verdict \`${verdict}\` with \`disposition.reason\` "${reason}"`
      )
      : NOT_A_SEAT_FAILURE;
  }
  } // !reroutingQuota: verdict/reason pairing

  // A replacement review judges an implementation; there must be one.
  if (typeof last.implementJobId !== "string" || !last.implementJobId) {
    return seatRecordsUndecidable(
      `${where} record has no \`implementJobId\` — there is no implementation for a replacement review to judge`
    );
  }

  // ---- condition 1: probes P1–P4 all green ----
  const probeResults = last.probeResults;
  if (!Array.isArray(probeResults) || probeResults.length === 0) {
    return seatRecordsUndecidable(
      `${where} record has no \`probeResults\` — P1–P4 cannot be confirmed green`
    );
  }
  const probeLabels = probeResults.map(function (p) {
    return typeof p?.probe === "string" ? p.probe.split(":")[0].trim() : "";
  });
  const missingProbes = REVIEW_SEAT_PROBES.filter(function (p) { return !probeLabels.includes(p); });
  if (missingProbes.length > 0) {
    return seatRecordsUndecidable(
      `${where} \`probeResults\` does not cover ${missingProbes.join(", ")} — P1–P4 cannot be confirmed green`
    );
  }
  const redProbes = probeResults.filter(function (p) { return p?.passed !== true; });
  if (redProbes.length > 0) {
    const names = redProbes.map(function (p) { return typeof p?.probe === "string" ? p.probe : "(unnamed)"; });
    return seatRecordsUndecidable(
      `${where} \`probeResults\` is not all green (${names.join(", ")}) — the work is not known intact`
    );
  }
  // The summary flag must agree with the entries: `probesGreen` is what the
  // disposition machinery read, so a disagreement is ambiguous records.
  if (last.probesGreen !== true) {
    return seatRecordsUndecidable(
      `${where} record has \`probesGreen\`: ${JSON.stringify(last.probesGreen ?? null)} — a replacement review seat requires green P1–P4`
    );
  }

  return { eligible: true, detail: null };
}

/**
 * Decide where a stopped chain resumes, from its persisted state alone.
 *
 * Pure function: reads nothing, writes nothing.  The caller still validates
 * container reachability before re-running (a resumed chain's work lives in
 * the recorded container; the state root is machine-local).
 *
 * Preconditions (explicit errors for everything else):
 *   - The chain must be stopped: status "cancelled", or "running" with a dead
 *     pid (stale — abnormal stop).  A live process (running / stopping) and
 *     any finished status (completed / failed) are errors — with the single
 *     replacement-review-seat exception below, which is decided BEFORE this
 *     gate because such a chain finished normally (status "completed").
 *
 * Resume position, from the LAST round record in chain.json:
 *   - Last record has implement done but no review/disposition (an
 *     interrupted round persisted at stop time) → resume at that round's
 *     REVIEW phase, continuing the persisted partial record.
 *   - Last record is complete with disposition rework/strategize → resume at
 *     the NEXT round's IMPLEMENT phase (rework: with the escalated
 *     tier/reworkCount; strategize: with the fresh-session lever from the
 *     record's pendingReworkStrategy).
 *   - Terminal dispositions (accept / accept-with-followup / escalate) mean
 *     the chain already finished — error.  ONE exception (kusabi #248): an
 *     `escalate` that classifyReviewSeatReplacement finds eligible — probes
 *     P1–P4 green, verdict `partial`/`unparseable`, and that seat failure is
 *     the recorded escalate cause — resumes at the SAME round's REVIEW phase
 *     to buy a replacement seat.  Never implement: the implementation is
 *     intact and only the seat was consumed, so no round-budget slot is spent
 *     (the return sits before the budget-derived guard).
 *
 * Cross-round state (reworkCount, currentTierIndex, strategized, session,
 * baseSha) is derived from the record fields so the resumed run continues the
 * ladder exactly where the original left off.
 *
 * `currentTierIndex` addresses the chain the NEXT round dispatches on
 * (kusabi #192 axis 2): the implement chain for a round-1 resume, the REWORK
 * chain from round 2 on when a models.phases.rework chain was configured
 * (rework rounds run the tier ladder over the rework chain; the persisted
 * tierAfter/tierBefore were recorded against it).  The driver re-dispatches
 * rework rounds on the rework resolution restored from chain.json, so the
 * index is applied to the same chain it was recorded against.
 *
 * @param {object}  opts
 * @param {object|null} opts.control    — control.json record.
 * @param {object|null} opts.chainJson  — chain.json record.
 * @returns {{ ok: true, position: object } | { ok: false, error: string }}
 *   `position`:
 *   - `phase`        — "review" | "implement"
 *   - `round`        — round to continue at
 *   - `roundRecord`  — the persisted partial record (review-resume only)
 *   - `records`      — chain.json records array (continued in place)
 *   - `reviewSeatReplacement` — true only for the kusabi #248 escalate
 *     exception; tells the driver to archive the failed seat on the record
 *     before dispatching the replacement review
 *   - `reworkCount`, `currentTierIndex`, `strategized`, `session`, `baseSha`
 */
export function resolveChainResume({ control, chainJson, explicitRoute = null }) {
  if (!control) {
    return { ok: false, error: "no control record (control.json missing)" };
  }
  if (!chainJson) {
    return { ok: false, error: "no chain.json (nothing was persisted)" };
  }

  const { status, stale } = effectiveStatus(control);
  if (status === "running" || status === "stopping") {
    return {
      ok: false,
      error: `chain is still running (pid ${control.pid}) — stop it first (chain-cancel)`,
    };
  }

  // Replacement review seat (kusabi #248), classified from the records alone
  // and BEFORE the finished-status gate: a chain that escalated on a dead
  // review seat finished NORMALLY (status "completed"), so the gate below
  // would refuse it before the disposition branch ever ran.  `detail` is the
  // fail-closed field name for a seat-shaped escalate whose records cannot
  // decide it; it is null for every other chain, leaving the refusals verbatim.
  const seat = classifyReviewSeatReplacement(chainJson, { explicitRoute });

  if (status !== "cancelled" && !stale && !seat.eligible) {
    return {
      ok: false,
      error: withSeatDetail(`chain already finished (status: ${status})`, seat.detail),
    };
  }

  if (!Array.isArray(chainJson.modelChain) || chainJson.modelChain.length === 0) {
    return { ok: false, error: "chain.json has no modelChain to dispatch with" };
  }
  if (typeof chainJson.brief !== "string" || !chainJson.brief.trim()) {
    return { ok: false, error: "chain.json has no brief to continue with" };
  }

  const maxRounds = Number.isInteger(chainJson.maxRounds) && chainJson.maxRounds > 0
    ? chainJson.maxRounds
    : 4;
  const records = Array.isArray(chainJson.records) ? chainJson.records : [];
  const last = records.length > 0 ? records[records.length - 1] : null;
  const strategized = !!chainJson.strategized;
  const baseSha = chainJson.baseSha ?? null;

  if (!last) {
    return {
      ok: false,
      error: "no round records to resume from (the chain stopped before completing a round)",
    };
  }

  const lastDisposition = last.disposition?.disposition;
  if (lastDisposition) {
    // ---- replacement review seat (kusabi #248) ----
    // The ONE terminal disposition that is resumable: an escalate caused by a
    // dead review seat over green probes.  The resume dispatches the SAME
    // round's REVIEW phase in a fresh session (each phase is a new session;
    // review seats are never reused) — never implement, which is why this
    // returns a review position instead of falling through to the
    // next-round/implement path.  It also returns BEFORE the budget-derived
    // guard below: the round already spent its slot, and re-buying its review
    // spends no new one.
    if (lastDisposition === "escalate" && seat.eligible) {
      return {
        ok: true,
        position: {
          phase: "review",
          round: last.round,
          roundRecord: last,
          records,
          reviewSeatReplacement: true,
          reworkCount: last.reworkCount ?? 0,
          currentTierIndex: last.tierBefore ?? 0,
          strategized,
          session: last.sessionID ?? undefined,
          baseSha,
        },
      };
    }
    if (lastDisposition === "accept" || lastDisposition === "accept-with-followup" || lastDisposition === "escalate") {
      return {
        ok: false,
        error: withSeatDetail(
          `chain already finished (last round ${last.round} disposition: ${lastDisposition})`,
          seat.detail,
        ),
      };
    }
    // A refused-brief-defect ends the chain as terminal (kusabi #293): the
    // brief itself is defective, so resuming would only re-run the same
    // defective brief.  Refuse regardless of control freshness -- even a
    // stale control must not re-dispatch implement on a defective brief.
    if (lastDisposition === "refused-brief-defect") {
      return {
        ok: false,
        error: `chain ended in refused-brief-defect at round ${last.round} \u2014 the brief is defective; fix the brief and re-dispatch a new chain (resume would re-run the same defective brief)`,
      };
    }
    const nextRound = (last.round ?? records.length) + 1;
    // ---- budget-derived guard (kusabi #60 step 2) ----
    // Mirrors the driver's budget semantics: maxRounds buys design/full
    // rounds only, mechanical rounds are free, so the raw round number may
    // legitimately exceed maxRounds (hard cap 2 × maxRounds).  Resume is
    // refused only when the derived budget is spent or the hard cap would be
    // exceeded — never on the raw round count alone.
    //
    // Records without a `reworkScope` field predate the scheduling change;
    // for such chains the round number IS the budget (every round was full),
    // so the legacy guard applies: nextRound > maxRounds means the budget is
    // spent.  Once any record carries `reworkScope`, the budget is derived
    // by counting non-mechanical records exactly as the driver does.
    const anyScoped = records.some((r) => r.reworkScope !== undefined);
    const budgetExhausted = anyScoped
      ? records.filter((r) => r.reworkScope !== "mechanical").length >= maxRounds
        || nextRound > 2 * maxRounds
      : nextRound > maxRounds;
    if (budgetExhausted) {
      return {
        ok: false,
        error: `max rounds (${maxRounds}) already reached at round ${last.round}`,
      };
    }
    return {
      ok: true,
      position: {
        phase: "implement",
        round: nextRound,
        roundRecord: null,
        records,
        // A rework consumed one rework; a strategize did not.
        reworkCount: (last.reworkCount ?? 0) + (lastDisposition === "rework" ? 1 : 0),
        currentTierIndex: last.tierAfter ?? last.tierBefore ?? 0,
        strategized,
        session: last.sessionID ?? undefined,
        baseSha,
      },
    };
  }

  // No disposition → partial (interrupted) round.
  if (!last.implementJobId) {
    return {
      ok: false,
      error: `round ${last.round ?? "?"} record has no implement job — no phase boundary to resume at`,
    };
  }
  if (last.reviewJobId || last.verdict) {
    return {
      ok: false,
      error: `round ${last.round} record is inconsistent (review present but no disposition) — manual inspection required`,
    };
  }
  return {
    ok: true,
    position: {
      phase: "review",
      round: last.round,
      roundRecord: last,
      records,
      reworkCount: last.reworkCount ?? 0,
      currentTierIndex: last.tierBefore ?? 0,
      strategized,
      session: last.sessionID ?? undefined,
      baseSha,
    },
  };
}
