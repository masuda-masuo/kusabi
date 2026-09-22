// trial-manifest.mjs — kusabi #532: the 10–20 pair Luna trial manifest and
// evaluation report.
//
// The unit of the trial is a comparable PAIR: one Luna mission (the luna
// arm) and one current-practice chain (the current-chain arm), interleaved
// in the same period.  A manifest carries 2 × pairCount tasks where
// pairCount = mission count ∈ [10, 20].
//
// validateTrialManifest validates the EXPLICIT facts a manifest must state:
// pair count range, complete pairs, known arms, interleaving by startedAt,
// pair/comparability keys, parseable dates, arm-matching subject ids, and
// finite non-negative observations.  computeTrialReport aggregates ONLY what
// the manifest explicitly states — the manifest supplies externally observed
// facts (manual host work and defect issue references are explicit manifest
// entries, never inferred, because kusabi has no durable store for them).
//
// decisionStatus applies the frozen #524 criteria in order:
//   1. early-stop: ANY task observed either Codex seat reaching repo state
//      or a host-only exit;
//   2. mission count < 20 -> "insufficient-evidence" (never keep/tune);
//   3. discard: 0 reversals with ≥3 false positives, OR coordinator rescues
//      > 30% of missions, OR fail-closed blocks > 20% of missions;
//   4. keep: ≥2 true reversals across 20 missions, ≤1 false positive,
//      coordinator errors trending down, combined latency/cost overhead
//      < 40%;
//   5. otherwise -> "insufficient-evidence".
// The report carries status and reasons only — it never claims a universal
// model ranking.

/** The frozen arm vocabulary. */
export const TRIAL_ARMS = ["luna", "current-chain"];
export const TRIAL_MIN_PAIRS = 10;
export const TRIAL_MAX_PAIRS = 20;

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

const NUMERIC_FIELDS = [
  "coordinatorErrors",
  "briefCorrections",
  "missedTriggers",
  "reversals",
  "sampledFalseNegatives",
  "falsePositives",
  "hostInterventions",
  "coordinatorRescues",
  "failClosedBlocks",
  "cost",
];

const TOKEN_FIELDS = ["input", "output", "reasoning", "cacheRead", "cacheWrite"];

function taskLabel(task) {
  return typeof task?.taskId === "string" && task.taskId ? task.taskId : "(unnamed task)";
}

/**
 * Validate a trial manifest against the frozen structural and factual rules.
 *
 * @param {*} manifest — { title?, startedAt?, tasks: [...] }.
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateTrialManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { valid: false, errors: ["manifest is not an object"] };
  }
  const tasks = Array.isArray(manifest.tasks) ? manifest.tasks : [];
  const pairCount = tasks.length / 2;

  // Pair-count range: the range check is on the PAIR count (criterion 9's
  // "across 20 missions" denominator), so 2 × pairCount tasks are expected.
  if (pairCount < TRIAL_MIN_PAIRS || pairCount > TRIAL_MAX_PAIRS) {
    errors.push(
      `task count out of range: ${tasks.length} task(s) = ${pairCount} pair(s) — ` +
        `a trial needs ${TRIAL_MIN_PAIRS}-${TRIAL_MAX_PAIRS} pairs`,
    );
  }

  // Pair completeness: every pair id must carry exactly one of each arm.
  const byPair = new Map();
  for (const task of tasks) {
    if (!task || typeof task !== "object") {
      errors.push("a task entry is not an object");
      continue;
    }
    const pairId = task.pairId;
    if (typeof pairId !== "string" || pairId === "") {
      errors.push(`task ${taskLabel(task)} is missing pair/comparability key (pairId)`);
      continue;
    }
    if (typeof task.comparabilityKey !== "string" || task.comparabilityKey === "") {
      errors.push(`task ${taskLabel(task)} is missing pair/comparability key (comparabilityKey)`);
    }
    if (!byPair.has(pairId)) byPair.set(pairId, []);
    byPair.get(pairId).push(task);
  }
  for (const [pairId, pairTasks] of byPair) {
    for (const arm of TRIAL_ARMS) {
      const count = pairTasks.filter((t) => t && t.arm === arm).length;
      if (count === 0) errors.push(`pair ${pairId} is missing ${arm} arm`);
      if (count > 1) errors.push(`pair ${pairId} has duplicate ${arm} arm`);
    }
  }

  // Arm vocabulary, interleaving, dates, subject ids, numeric observations.
  for (const task of tasks) {
    if (!task || typeof task !== "object") continue;
    const label = taskLabel(task);

    if (!TRIAL_ARMS.includes(task.arm)) {
      errors.push(`task ${label} has unknown arm: ${task.arm}`);
      continue;
    }

    const startedMs = Date.parse(task.startedAt);
    const finishedMs = Date.parse(task.finishedAt);
    if (!Number.isFinite(startedMs) || !Number.isFinite(finishedMs)) {
      errors.push(
        `task ${label} has malformed date: startedAt=${task.startedAt} finishedAt=${task.finishedAt}`,
      );
    } else if (finishedMs < startedMs) {
      errors.push(`task ${label} has finishedAt before startedAt`);
    }

    const expectedPrefix = task.arm === "luna" ? "mission-" : "chain-";
    if (typeof task.subjectId !== "string" || !task.subjectId.startsWith(expectedPrefix)) {
      errors.push(
        `task ${label} subjectId does not match arm: a ${task.arm} task must use a ` +
          `"${expectedPrefix}*" subject id (got ${task.subjectId})`,
      );
    }

    for (const field of NUMERIC_FIELDS) {
      const v = task[field];
      if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
        errors.push(`task ${label} must be a non-negative number: ${field}=${v}`);
      }
    }
    const consults = task.unnecessaryClearConsultations;
    if (consults !== undefined && consults !== null) {
      for (const field of ["lunaRequested", "policyMandated"]) {
        const v = consults[field];
        if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
          errors.push(
            `task ${label} must be a non-negative number: unnecessaryClearConsultations.${field}=${v}`,
          );
        }
      }
    }
    const tokens = task.tokens;
    if (tokens !== undefined && tokens !== null) {
      for (const field of TOKEN_FIELDS) {
        const v = tokens[field];
        if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
          errors.push(`task ${label} must be a non-negative number: tokens.${field}=${v}`);
        }
      }
    }
  }

  // Interleaving follows CHRONOLOGY, never the manifest's listed order
  // (adjudication finding): a trial whose JSON entries alternate while the
  // actual work was chronologically grouped must be rejected.  The tasks are
  // stably sorted by startedAt first (deterministic tie handling: taskId,
  // then the listed index), and the alternation is validated on that
  // chronological order — two same-arm tasks that ran consecutively are a
  // violation no matter how the entries are listed.
  const chronological = [...tasks]
    .map((t, index) => ({ t, index }))
    .sort((a, b) => {
      const aMs = Date.parse(a.t.startedAt);
      const bMs = Date.parse(b.t.startedAt);
      if (aMs !== bMs) return aMs - bMs;
      const aId = String(a.t.taskId ?? "");
      const bId = String(b.t.taskId ?? "");
      if (aId !== bId) return aId.localeCompare(bId);
      return a.index - b.index;
    })
    .map((x) => x.t);
  for (let i = 1; i < chronological.length; i++) {
    const prev = chronological[i - 1];
    const curr = chronological[i];
    if (!prev || typeof prev !== "object" || !curr || typeof curr !== "object") continue;
    if (prev.arm === curr.arm && TRIAL_ARMS.includes(prev.arm)) {
      errors.push(
        `arms are not interleaved: ${taskLabel(prev)} and ${taskLabel(curr)} ` +
          `are consecutive ${prev.arm} tasks (ordered by startedAt)`,
      );
      break;
    }
  }

  return { valid: errors.length === 0, errors };
}

/** The default empty aggregate shape for an arm (no measured facts). */
function emptyAggregate() {
  return {
    coordinatorErrors: 0,
    briefCorrections: 0,
    missedTriggers: 0,
    unnecessaryClearConsultations: { lunaRequested: 0, policyMandated: 0 },
    reversals: 0,
    sampledFalseNegatives: 0,
    falsePositives: 0,
    hostInterventions: 0,
    coordinatorRescues: 0,
    failClosedBlocks: 0,
    postAcceptDefectsWithin14Days: 0,
    // Latency and cost are MEASURED totals: absent stays null (never 0), and
    // the presence flag records whether every task of the arm actually
    // reported the measurement — an absent value must never act as zero in
    // overhead arithmetic (kusabi #532 adjudication finding 4).
    latencySeconds: null,
    latencyMeasured: false,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: null,
    costMeasured: false,
  };
}

function latencySecondsOf(task) {
  const startedMs = Date.parse(task?.startedAt);
  const finishedMs = Date.parse(task?.finishedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(finishedMs)) return null;
  return (finishedMs - startedMs) / 1000;
}

/** Defects whose referenced issue timestamp lies within 14 days AFTER the
 * acceptance time (the task's finishedAt).  The manifest entry is the only
 * source — kusabi has no durable issue store, so nothing is ever inferred. */
function postAcceptDefectsWithin14Days(task) {
  const finishedMs = Date.parse(task?.finishedAt);
  if (!Number.isFinite(finishedMs)) return 0;
  const defects = Array.isArray(task?.postAcceptDefects) ? task.postAcceptDefects : [];
  let count = 0;
  for (const defect of defects) {
    const createdMs = Date.parse(defect?.createdAt);
    if (!Number.isFinite(createdMs)) continue;
    const diff = createdMs - finishedMs;
    if (diff >= 0 && diff <= FOURTEEN_DAYS_MS) count += 1;
  }
  return count;
}

function numberSum(list, field) {
  return list.reduce((acc, t) => acc + (typeof t?.[field] === "number" ? t[field] : 0), 0);
}

function fieldSum(list, getter) {
  return list.reduce((acc, t) => acc + (getter(t) ?? 0), 0);
}

/** Cost sums carry decimal cents; a plain reduce accumulates float noise
 * (0.06 × 12 → 0.7200000000000002).  Round to the 10th decimal so the
 * reported figures are the exact decimals the manifest stated. */
function roundCost(value) {
  return Math.round(value * 1e10) / 1e10;
}

/**
 * Aggregate the measured facts of one list of tasks.  Only what the manifest
 * explicitly states is aggregated; a missing numeric observation contributes
 * nothing (never converted to a guessed value).
 */
function aggregate(list) {
  const agg = emptyAggregate();
  agg.coordinatorErrors = numberSum(list, "coordinatorErrors");
  agg.briefCorrections = numberSum(list, "briefCorrections");
  agg.missedTriggers = numberSum(list, "missedTriggers");
  agg.unnecessaryClearConsultations.lunaRequested = fieldSum(
    list,
    (t) => t?.unnecessaryClearConsultations?.lunaRequested,
  );
  agg.unnecessaryClearConsultations.policyMandated = fieldSum(
    list,
    (t) => t?.unnecessaryClearConsultations?.policyMandated,
  );
  agg.reversals = numberSum(list, "reversals");
  agg.sampledFalseNegatives = numberSum(list, "sampledFalseNegatives");
  agg.falsePositives = numberSum(list, "falsePositives");
  agg.hostInterventions = numberSum(list, "hostInterventions");
  agg.coordinatorRescues = numberSum(list, "coordinatorRescues");
  agg.failClosedBlocks = numberSum(list, "failClosedBlocks");
  agg.postAcceptDefectsWithin14Days = list.reduce(
    (acc, t) => acc + postAcceptDefectsWithin14Days(t),
    0,
  );
  // Latency is measured only when EVERY task of the arm has a parseable
  // wall clock — a partial sum would silently undercount and must not act
  // as the arm's measured latency.
  const latencies = list.map(latencySecondsOf);
  agg.latencyMeasured = list.length > 0 && latencies.every((v) => v !== null);
  agg.latencySeconds = agg.latencyMeasured
    ? latencies.reduce((acc, v) => acc + v, 0)
    : null;
  for (const t of list) {
    const tokens = t?.tokens ?? {};
    for (const field of TOKEN_FIELDS) {
      if (typeof tokens[field] === "number") agg.tokens[field] += tokens[field];
    }
  }
  // Cost is measured only when EVERY task of the arm reports a numeric cost.
  const costs = list.map((t) => t?.cost);
  agg.costMeasured = list.length > 0 && costs.every((v) => typeof v === "number");
  agg.cost = agg.costMeasured ? roundCost(costs.reduce((acc, v) => acc + v, 0)) : null;
  return agg;
}

/**
 * The frozen keep/discard/early-stop decision over a computed report.
 *
 * @param {object} report — computeTrialReport output.
 * @returns {"early-stop"|"discard"|"keep"|"insufficient-evidence"}
 */
export function decisionStatus(report) {
  return buildDecision(report).status;
}

/** The decision plus the human-readable reasons behind it. */
function buildDecision(report) {
  const reasons = [];
  if (report.earlyStop.seatReachedRepoState || report.earlyStop.hostOnlyExit) {
    const flags = [];
    if (report.earlyStop.seatReachedRepoState) flags.push("a Codex seat reached repo state");
    if (report.earlyStop.hostOnlyExit) flags.push("a host-only exit was observed");
    reasons.push(`early-stop: ${flags.join(" and ")}`);
    return { status: "early-stop", reasons };
  }

  if (report.missionCount < 20) {
    reasons.push(
      `insufficient-evidence: ${report.missionCount} mission(s) — the trial needs 20 missions before keep/discard criteria apply`,
    );
    return { status: "insufficient-evidence", reasons };
  }

  // A required overhead measurement that is absent (or uncomputable) forces
  // insufficient-evidence: the keep threshold (combined overhead < 40%) is
  // meaningless without both arms' measured latency/cost, and an absent
  // value must never act as zero in KEEP/DISCARD arithmetic (kusabi #532
  // adjudication finding 4).
  const missing = report.missingMeasurements ?? {};
  if (missing.latency || missing.cost) {
    const parts = [];
    if (missing.latency) parts.push("latency");
    if (missing.cost) parts.push("cost");
    reasons.push(
      `insufficient-evidence: required measurement(s) missing — ${parts.join(", ")} overhead cannot be computed`,
    );
    return { status: "insufficient-evidence", reasons };
  }

  if (
    report.totals.reversals === 0 && report.totals.falsePositives >= 3
  ) {
    reasons.push(`discard: 0 reversals with ${report.totals.falsePositives} false positives`);
    return { status: "discard", reasons };
  }
  if (report.totals.coordinatorRescues / report.missionCount > 0.30) {
    reasons.push(
      `discard: coordinator rescues ${report.totals.coordinatorRescues}/${report.missionCount} exceed 30% of missions`,
    );
    return { status: "discard", reasons };
  }
  if (report.totals.failClosedBlocks / report.missionCount > 0.20) {
    reasons.push(
      `discard: fail-closed blocks ${report.totals.failClosedBlocks}/${report.missionCount} exceed 20% of missions`,
    );
    return { status: "discard", reasons };
  }

  const keepCriteria = [
    report.totals.reversals >= 2,
    report.totals.falsePositives <= 1,
    report.coordinatorErrorsTrendDown,
    report.combinedOverhead !== null && report.combinedOverhead < 0.40,
  ];
  if (keepCriteria.every(Boolean)) {
    reasons.push(
      `keep: ${report.totals.reversals} reversals, ${report.totals.falsePositives} false positives, ` +
        `coordinator errors trend down, combined overhead ${report.combinedOverhead}`,
    );
    return { status: "keep", reasons };
  }

  reasons.push(
    `insufficient-evidence: keep criteria not met (reversals=${report.totals.reversals}, ` +
      `falsePositives=${report.totals.falsePositives}, trendDown=${report.coordinatorErrorsTrendDown}, ` +
      `combinedOverhead=${report.combinedOverhead}) and no discard criterion fired`,
  );
  return { status: "insufficient-evidence", reasons };
}

/**
 * Compute the trial evaluation report over a manifest's explicit facts.
 *
 * Totals describe the trial unit (the mission arm); perArm splits every
 * aggregate by arm.  Latency/cost overheads compare the luna arm against the
 * current-chain arm; coordinatorErrorsTrendDown compares the per-mission
 * coordinator-error average of the second half of missions (ordered by
 * startedAt) with the first half's — a measured trend, never a guess.
 *
 * @param {*} manifest
 * @returns {object} the report (status + reasons, never a model ranking).
 */
export function computeTrialReport(manifest) {
  const tasks = Array.isArray(manifest?.tasks) ? manifest.tasks : [];
  const lunaTasks = tasks.filter((t) => t && t.arm === "luna");
  const chainTasks = tasks.filter((t) => t && t.arm === "current-chain");

  const perArm = {
    luna: { count: lunaTasks.length, ...aggregate(lunaTasks) },
    "current-chain": { count: chainTasks.length, ...aggregate(chainTasks) },
  };

  const chainLatency = perArm["current-chain"].latencySeconds;
  const chainCost = perArm["current-chain"].cost;
  // Latency/cost overhead is computed ONLY when both arms measured the value
  // and the chain denominator is non-zero.  An absent measurement stays null
  // (never 0, never -1) and is exposed via missingMeasurements so the
  // decision never lets it contribute to KEEP/DISCARD arithmetic (kusabi
  // #532 adjudication finding 4).
  const latencyComputable =
    perArm.luna.latencyMeasured &&
    perArm["current-chain"].latencyMeasured &&
    chainLatency !== 0;
  const latencyOverhead = latencyComputable
    ? (perArm.luna.latencySeconds - chainLatency) / chainLatency
    : null;
  const costComputable =
    perArm.luna.costMeasured &&
    perArm["current-chain"].costMeasured &&
    chainCost !== 0;
  const costOverhead = costComputable
    ? roundCost((perArm.luna.cost - chainCost) / chainCost)
    : null;
  const combinedOverhead =
    latencyOverhead !== null && costOverhead !== null
      ? latencyOverhead + costOverhead
      : null;
  const missingMeasurements = {
    latency: !latencyComputable,
    cost: !costComputable,
  };

  // Trend: the per-mission coordinator-error average of the second half of
  // missions (ordered by startedAt) is <= the first half's.
  const missionsByStart = [...lunaTasks].sort((a, b) =>
    String(a.startedAt).localeCompare(String(b.startedAt)),
  );
  const half = Math.floor(missionsByStart.length / 2);
  const avgErrors = (list) =>
    list.length === 0
      ? 0
      : list.reduce((acc, t) => acc + (typeof t.coordinatorErrors === "number" ? t.coordinatorErrors : 0), 0) / list.length;
  const coordinatorErrorsTrendDown =
    avgErrors(missionsByStart.slice(half)) <= avgErrors(missionsByStart.slice(0, half));

  const report = {
    title: manifest?.title ?? null,
    startedAt: manifest?.startedAt ?? null,
    pairCount: lunaTasks.length,
    missionCount: lunaTasks.length,
    chainCount: chainTasks.length,
    totals: aggregate(lunaTasks),
    perArm,
    latencyOverhead,
    costOverhead,
    combinedOverhead,
    // Which required overhead measurement is absent (or uncomputable) — the
    // decision forces insufficient-evidence and never lets it read as zero.
    missingMeasurements,
    coordinatorErrorsTrendDown,
    earlyStop: {
      seatReachedRepoState: tasks.some((t) => t?.seatReachedRepoState === true),
      hostOnlyExit: tasks.some((t) => t?.hostOnlyExit === true),
    },
  };
  const { status, reasons } = buildDecision(report);
  report.status = status;
  report.reasons = reasons;
  return report;
}