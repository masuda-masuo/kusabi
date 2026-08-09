// chain-ingest.mjs — parse kusabi chain.json records into chain/round/finding
// rows, and a directory walker that feeds them into the metrics store.
//
// Split the same way as transcript-ingest.mjs: `parseChainRecord` is a pure
// function (an already-JSON.parse'd chain.json object in, row shapes out),
// unit-testable with inline fixtures.  `ingestChainDirectory` is the only
// piece that touches the filesystem or the database, and it never opens a
// database itself — `db` is always passed in by the caller (metrics-ingest
// command), which is what keeps this module testable against `:memory:`.
//
// ---------------------------------------------------------------------------
// Hazard 3 — generational gaps.  Chain records span several kusabi versions:
// the oldest have neither `findings` nor `findingFiles` (only free-text
// `findingsText`); a middle generation (post-#119) has `findingFiles` only
// (file paths, no severity/title); the newest (post-#123) has full
// `findings` objects.  `hasStructuredFindings` on the return value tells the
// caller which generation a chain belongged to so the ingest summary can
// report real coverage instead of silently letting a follow-up PR compute a
// rate over a fraction of the data while looking like it covers all of it.
//
// Each `finding` row now also carries `source` ('findings' | 'finding_files')
// so a row synthesised from the file-paths-only generation is never
// indistinguishable from a real structured finding with severity/title —
// both leave severity/title NULL, and `source` is the only column that
// tells them apart.
//
// Hazard 5 — orch_model / orch_date are stored verbatim as first-class,
// indexed columns (see metrics-db.mjs).  They are stratification keys, not
// incidental metadata: this repo's own history shows orchestrator model
// perfectly confounded with calendar date (and both confounded with
// kusabi's own maturity at the time).  This module does not compute rates,
// coverage, or any other statistic from them — ingest + store only.
//
// Hazard 6 — `orchestrator.session` is a PREFIX of a transcript sessionId,
// not an equal value (most are 8 hex chars, some 12).  It is stored exactly
// as recorded, with no truncation or normalisation, so a future join can
// still do prefix matching correctly.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { hasSectionHeading, parseDeliverables, parseSmoke } from "./brief-parsing.mjs";
import {
  upsertChain,
  upsertRound,
  upsertFinding,
  upsertJob,
  upsertSourceFile,
  isSourceFileUnchanged,
  getSourceFile,
} from "./metrics-db.mjs";

function toBoolInt(v) {
  if (v === true) return 1;
  if (v === false) return 0;
  return null;
}

/**
 * Sum one usage field across the final and first review attempts.  Each side
 * contributes only when its usage object is usable (available === true,
 * checked by the caller) and the field is a number \u2014 the same guard style as
 * the pre-retry columns.  When neither side contributes the result is null
 * (the old single-attempt value), so a round without a retry is
 * byte-for-byte identical to before.
 */
function usageFieldSum(usage, firstUsage, field) {
  const value = usage && typeof usage[field] === "number" ? usage[field] : null;
  const firstValue = firstUsage && typeof firstUsage[field] === "number" ? firstUsage[field] : null;
  if (value === null && firstValue === null) return null;
  return (value === null ? 0 : value) + (firstValue === null ? 0 : firstValue);
}

/**
 * Render a chain.json `model` object ({providerID, modelID, variant?}) as
 * the same "provider/model[:variant]" route-string convention used
 * elsewhere in this codebase (cli.mjs `parseModel` / `selectRoutes`).
 *
 * @param {*} model
 * @returns {string|null}
 */
function modelRouteString(model) {
  if (!model || typeof model !== "object") return null;
  if (typeof model.providerID !== "string" || typeof model.modelID !== "string") return null;
  const variant = typeof model.variant === "string" && model.variant ? `:${model.variant}` : "";
  return `${model.providerID}/${model.modelID}${variant}`;
}

/**
 * Count brief lines that look like a list item (bullet or ordered).  A
 * light heuristic distinct from brief-parsing.mjs's section-scoped
 * `parseSectionItems` — this counts across the WHOLE brief, not one named
 * section, so it is not something the existing exports compute.
 *
 * @param {string} text
 * @returns {number}
 */
function countBullets(text) {
  let count = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (/^[-*+]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed)) count += 1;
  }
  return count;
}

/**
 * Parse one already-`JSON.parse`d chain.json object into row shapes.
 *
 * Pure — no I/O.  Returns `null` when the record is not recognisable as a
 * chain record at all (no usable `chainId`); the caller counts that as a
 * parse failure.  Everything else degrades field-by-field: an absent or
 * malformed sub-field becomes `null` on the row rather than throwing or
 * silently becoming 0.
 *
 * @param {*} chainJson
 * @param {{ workspaceSlug?: string }} [ctx]
 * @returns {{
 *   chainRow: object,
 *   roundRows: object[],
 *   findingRows: object[],
 *   hasStructuredFindings: boolean,
 * } | null}
 */
export function parseChainRecord(chainJson, ctx = {}) {
  if (!chainJson || typeof chainJson !== "object") return null;
  const chainId = chainJson.chainId;
  if (typeof chainId !== "string" || !chainId) return null;

  const briefText = typeof chainJson.brief === "string" ? chainJson.brief : null;
  const orchestrator = (chainJson.orchestrator && typeof chainJson.orchestrator === "object")
    ? chainJson.orchestrator
    : null;
  const totals = (chainJson.chainTotals && typeof chainJson.chainTotals === "object")
    ? chainJson.chainTotals
    : {};
  const records = Array.isArray(chainJson.records) ? chainJson.records : [];

  // The chain record itself has no top-level `backend` (kusabi #184): the
  // backend is stamped per round record — `backend` (the implement phase's)
  // and `reviewBackend` (the review phase's, since kusabi #192) — and the
  // chain's backend is the UNION of every KNOWN phase backend across the
  // records (kusabi #195).  The chain-resume convention (read the LAST
  // record) and this union agree for every chain that never changed
  // backend; they part company exactly where a single chain-level value
  // stops describing the chain, and #195 resolves that by labelling:
  //
  //   - nothing known          -> NULL (readers apply the "opencode" read)
  //   - every known value same -> that value, stored verbatim
  //   - known values differ    -> "mixed" (its own bucket)
  //
  // "mixed" covers BOTH shapes: one round whose implement and review ran on
  // different backends (the #192 per-phase shape), and a chain that
  // switched backends between rounds.  No single chain-level value can
  // describe either; filing such a chain under whichever backend happened
  // to run last puts its whole spend and outcome on the wrong side of the
  // by-backend split.  Only KNOWN values participate: an absent field
  // contributes nothing, so a chain whose records carry no backend fields
  // at all still stores NULL here, never "opencode".
  const knownBackends = new Set();
  for (const rec of records) {
    if (!rec || typeof rec !== "object") continue;
    if (typeof rec.backend === "string") knownBackends.add(rec.backend);
    if (typeof rec.reviewBackend === "string") knownBackends.add(rec.reviewBackend);
  }
  let chainBackend = null;
  if (knownBackends.size === 1) chainBackend = [...knownBackends][0];
  else if (knownBackends.size > 1) chainBackend = "mixed";

  const chainRow = {
    chainId,
    workspaceSlug: ctx.workspaceSlug ?? null,
    // Stratification keys (hazard 5) — stored verbatim, never collapsed.
    orchModel: orchestrator && typeof orchestrator.model === "string" ? orchestrator.model : null,
    orchSession: orchestrator && typeof orchestrator.session === "string" ? orchestrator.session : null,
    orchDate: orchestrator && typeof orchestrator.date === "string" ? orchestrator.date : null,
    backend: chainBackend,
    baseSha: typeof chainJson.baseSha === "string" ? chainJson.baseSha : null,
    model: modelRouteString(chainJson.model),
    modelChainJson: Array.isArray(chainJson.modelChain) ? JSON.stringify(chainJson.modelChain) : null,
    maxRounds: typeof chainJson.maxRounds === "number" ? chainJson.maxRounds : null,
    strategized: toBoolInt(chainJson.strategized),
    totalsInput: typeof totals.input === "number" ? totals.input : null,
    totalsOutput: typeof totals.output === "number" ? totals.output : null,
    totalsReasoning: typeof totals.reasoning === "number" ? totals.reasoning : null,
    totalsCacheRead: typeof totals.cacheRead === "number" ? totals.cacheRead : null,
    totalsCacheWrite: typeof totals.cacheWrite === "number" ? totals.cacheWrite : null,
    totalsCost: typeof totals.cost === "number" ? totals.cost : null,
    briefText,
    briefChars: briefText !== null ? briefText.length : null,
    briefLines: briefText !== null ? briefText.split("\n").length : null,
    briefBullets: briefText !== null ? countBullets(briefText) : null,
    // `## Deliverables` has zero discriminating power in the recorded
    // history (44/44 briefs have it) but is still recorded field-by-field
    // in case a future brief omits it — it is not treated as a signal here.
    briefHasDeliverables: briefText !== null ? (hasSectionHeading(briefText, "Deliverables") ? 1 : 0) : null,
    briefDeliverableCount: briefText !== null ? parseDeliverables(briefText).length : null,
    briefHasSmoke: briefText !== null ? (hasSectionHeading(briefText, "Smoke") ? 1 : 0) : null,
    briefSmokeCount: briefText !== null ? parseSmoke(briefText).length : null,
  };

  const roundRows = [];
  const findingRows = [];
  let hasStructuredFindings = false;

  for (const rec of records) {
    if (!rec || typeof rec !== "object" || typeof rec.round !== "number") continue;

    const implementUsage = (rec.implementUsage && rec.implementUsage.available === true) ? rec.implementUsage : null;
    const reviewUsage = (rec.reviewUsage && rec.reviewUsage.available === true) ? rec.reviewUsage : null;
    // First review attempt, recorded when the unparseable-output retry fired
    // (runReviewPhase in chain-phases.mjs).  Its spend folds into the same
    // columns as the final attempt's, so the round row reports the round's
    // total review spend without any schema change.
    const reviewFirstUsage = (rec.reviewFirstUsage && rec.reviewFirstUsage.available === true) ? rec.reviewFirstUsage : null;

    let startedMs = null;
    if (typeof rec.startedAt === "string") {
      const parsed = Date.parse(rec.startedAt);
      startedMs = Number.isFinite(parsed) ? parsed : null;
    }

    roundRows.push({
      chainId,
      round: rec.round,
      startedAt: typeof rec.startedAt === "string" ? rec.startedAt : null,
      startedMs,
      // Dispatch backend (kusabi #184), stored verbatim per record — NULL
      // when the record predates the split, never a default.  `backend` is
      // the backend the round's IMPLEMENT job actually used (round 1 the
      // implement backend, a rework round the rework backend), so it is
      // already truthful for rework; `reviewBackend` (kusabi #192) is the
      // separate fact the round row was missing until #195.  A record from
      // before #192 has no `reviewBackend` at all: NULL, not a copy of
      // `backend` — "unknown" must stay distinguishable from "the same".
      backend: typeof rec.backend === "string" ? rec.backend : null,
      reviewBackend: typeof rec.reviewBackend === "string" ? rec.reviewBackend : null,
      modelEntry: typeof rec.modelEntry === "string" ? rec.modelEntry : null,
      tierBefore: typeof rec.tierBefore === "number" ? rec.tierBefore : null,
      tierAfter: typeof rec.tierAfter === "number" ? rec.tierAfter : null,
      verdict: typeof rec.verdict === "string" ? rec.verdict : null,
      probesGreen: toBoolInt(rec.probesGreen),
      // Three-valued (kusabi #165): 1 = worker changed the worktree,
      // 0 = measured no change, NULL = never measured (old record or a
      // round that died before probes).  The escalate substantive/no-work
      // split needs the absent case kept distinct — NULL is "unknown",
      // never "no-work".
      worktreeChanged: toBoolInt(rec.worktreeChanged),
      disposition: (rec.disposition && typeof rec.disposition.disposition === "string")
        ? rec.disposition.disposition
        : null,
      reworkCount: typeof rec.reworkCount === "number" ? rec.reworkCount : null,
      findingsText: typeof rec.findingsText === "string" ? rec.findingsText : null,
      implementIn: implementUsage && typeof implementUsage.input === "number" ? implementUsage.input : null,
      implementOut: implementUsage && typeof implementUsage.output === "number" ? implementUsage.output : null,
      implementCost: implementUsage && typeof implementUsage.cost === "number" ? implementUsage.cost : null,
      reviewIn: usageFieldSum(reviewUsage, reviewFirstUsage, "input"),
      reviewOut: usageFieldSum(reviewUsage, reviewFirstUsage, "output"),
      reviewCost: usageFieldSum(reviewUsage, reviewFirstUsage, "cost"),
    });

    // Generational gap (hazard 3): prefer full `findings` objects
    // (severity/title/file) when present; fall back to `findingFiles`
    // (file paths only, no severity/title) for the middle generation;
    // older records have neither and contribute no finding rows at all.
    //
    // hasStructuredFindings is set from rows ACTUALLY PUSHED, not from the
    // raw array's presence/length — a `findings` array containing only
    // non-object entries (all filtered out below) must not be reported as
    // "this chain has structured findings" when zero rows resulted.
    if (Array.isArray(rec.findings) && rec.findings.length > 0) {
      const before = findingRows.length;
      rec.findings.forEach((f, idx) => {
        if (!f || typeof f !== "object") return;
        findingRows.push({
          chainId,
          round: rec.round,
          idx,
          severity: typeof f.severity === "string" ? f.severity : null,
          title: typeof f.title === "string" ? f.title : null,
          file: typeof f.file === "string" ? f.file : null,
          source: "findings",
        });
      });
      if (findingRows.length > before) hasStructuredFindings = true;
    } else if (Array.isArray(rec.findingFiles) && rec.findingFiles.length > 0) {
      const before = findingRows.length;
      rec.findingFiles.forEach((file, idx) => {
        findingRows.push({
          chainId,
          round: rec.round,
          idx,
          severity: null,
          title: null,
          file: typeof file === "string" ? file : null,
          source: "finding_files",
        });
      });
      if (findingRows.length > before) hasStructuredFindings = true;
    }
  }

  return { chainRow, roundRows, findingRows, hasStructuredFindings };
}

/**
 * Walk `stateRoot` (the kusabi state root, e.g. `~/.kusabi`) for chain
 * records at `<stateRoot>/<workspace-hash>/chains/chain-<id>/chain.json`,
 * parse each with `parseChainRecord`, and upsert chain/round/finding rows
 * into `db`.
 *
 * A chain directory with no `chain.json` (a chain that died before it ever
 * persisted one) is silently skipped — not an error, just nothing to
 * ingest.
 *
 * Two distinct problem counters, kept separate deliberately (mirroring
 * transcript-ingest.mjs): `ioFailures` counts a whole `chain.json` that
 * could not be stat'd or read (one increment == one entire chain's data
 * missing); `parseFailures` counts a `chain.json` that WAS read but failed
 * `JSON.parse`, or parsed to something with no usable `chainId`.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} stateRoot
 * @returns {{
 *   workspacesScanned: number,
 *   filesScanned: number, filesSkippedUnchanged: number, ioFailures: number,
 *   chainsIngested: number, chainsWithStructuredFindings: number,
 *   roundsIngested: number, findingsIngested: number,
 *   parseFailures: number,
 * }}
 */
export function ingestChainDirectory(db, stateRoot) {
  const summary = {
    workspacesScanned: 0,
    filesScanned: 0,
    filesSkippedUnchanged: 0,
    ioFailures: 0,
    chainsIngested: 0,
    chainsWithStructuredFindings: 0,
    roundsIngested: 0,
    findingsIngested: 0,
    parseFailures: 0,
  };

  if (!fs.existsSync(stateRoot)) return summary;

  let workspaceDirs;
  try {
    workspaceDirs = fs.readdirSync(stateRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return summary;
  }

  for (const wdirent of workspaceDirs) {
    const workspaceSlug = wdirent.name;
    const chainsDir = path.join(stateRoot, workspaceSlug, "chains");
    if (!fs.existsSync(chainsDir)) continue;
    summary.workspacesScanned += 1;

    let chainDirs;
    try {
      chainDirs = fs.readdirSync(chainsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      continue;
    }

    for (const cdirent of chainDirs) {
      if (!cdirent.name.startsWith("chain-")) continue;
      const chainJsonPath = path.join(chainsDir, cdirent.name, "chain.json");
      if (!fs.existsSync(chainJsonPath)) continue; // died before persisting — not a failure

      summary.filesScanned += 1;

      let stat;
      try {
        stat = fs.statSync(chainJsonPath);
      } catch {
        summary.ioFailures += 1;
        continue;
      }

      if (isSourceFileUnchanged(db, chainJsonPath, stat.size, stat.mtimeMs)) {
        summary.filesSkippedUnchanged += 1;
        continue;
      }

      let raw;
      try {
        raw = fs.readFileSync(chainJsonPath, "utf8");
      } catch {
        summary.ioFailures += 1;
        continue;
      }

      let chainJson;
      try {
        chainJson = JSON.parse(raw);
      } catch {
        summary.parseFailures += 1;
        continue;
      }

      const parsed = parseChainRecord(chainJson, { workspaceSlug });
      if (!parsed) {
        summary.parseFailures += 1;
        continue;
      }

      summary.chainsIngested += 1;
      if (parsed.hasStructuredFindings) summary.chainsWithStructuredFindings += 1;
      summary.roundsIngested += parsed.roundRows.length;
      summary.findingsIngested += parsed.findingRows.length;

      upsertChain(db, parsed.chainRow);
      for (const r of parsed.roundRows) upsertRound(db, r);
      for (const f of parsed.findingRows) upsertFinding(db, f);
      upsertSourceFile(db, {
        path: chainJsonPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ingestedAt: new Date().toISOString(),
      });
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Delegated single-shot jobs (#154) — `task` / `review` delegations write
// `<stateRoot>/<slug>/jobs/job-<id>/{job.json,usage.json}` and create no
// chain record, so until this existed they never entered the store at all.
//
// A job is TWO files written at different times: `job.json` exists from the
// moment the job starts (and is re-saved as events arrive); `usage.json`
// appears only when the job ends.  The skip-if-unchanged source key is
// therefore the PAIR:
//   - `job.json`'s size+mtime (a `source_file` row), AND
//   - `usage.json`'s size+mtime when it exists, or its recorded ABSENCE
//     (no `source_file` row for its path) when it does not.
// Keying on `job.json` alone would mean a job ingested while running is
// never re-read once its usage lands (nothing forces job.json to change at
// that exact moment); keying on `usage.json` alone would mean a job that
// died before writing usage is never ingested at all.  With the pair, a
// running job ingests immediately (usage columns NULL, distinguishable from
// measured zero), the later appearance of `usage.json` makes the pair
// "changed" and forces a re-read, and a fully-ingested job with both files
// unchanged is skipped like any unchanged chain file.
// ---------------------------------------------------------------------------

/**
 * Parse one job's already-`JSON.parse`d `job.json` (+ optional `usage.json`)
 * into a `job` row shape.
 *
 * Pure — no I/O.  Returns `null` when the record has no usable `id` (the
 * caller counts that as a parse failure).  Everything else degrades
 * field-by-field to `null`, with two deliberate exceptions:
 *
 * - `usageAvailable` is three-valued: `null` when `usageJson` is null (no
 *   usage.json on disk — the job died before writing it), `0` when the file
 *   exists but says `available: false`, `1` when it carries measured
 *   numbers.  Absent usage and measured-zero usage must never collapse.
 * - `usageCost` 0 is a real measurement (free tier) and is preserved as 0.
 *
 * `status` is copied verbatim — no enum. `backend` (kusabi #184) is copied
 * verbatim too — a job record without the field stores NULL, never a
 * default; readers treat NULL as "opencode". `durationSeconds` prefers the
 * value usage.json recorded; when that is absent it is derived from
 * startedAt/finishedAt when both parse, else `null`.
 *
 * @param {*} jobJson
 * @param {*} usageJson  Parsed usage.json, or null when the file does not exist.
 * @param {{ workspaceSlug?: string }} [ctx]
 * @returns {{ jobRow: object } | null}
 */
export function parseJobRecord(jobJson, usageJson, ctx = {}) {
  if (!jobJson || typeof jobJson !== "object") return null;
  const jobId = jobJson.id;
  if (typeof jobId !== "string" || !jobId) return null;

  const parseMs = (iso) => {
    if (typeof iso !== "string") return null;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
  };

  const startedAt = typeof jobJson.startedAt === "string" ? jobJson.startedAt : null;
  const finishedAt = typeof jobJson.finishedAt === "string" ? jobJson.finishedAt : null;
  const startedMs = parseMs(startedAt);
  const finishedMs = parseMs(finishedAt);

  const stats = (jobJson.stats && typeof jobJson.stats === "object") ? jobJson.stats : {};

  let usageAvailable = null;
  let usageModel = null;
  let usageInput = null;
  let usageOutput = null;
  let usageReasoning = null;
  let usageCacheRead = null;
  let usageCacheWrite = null;
  let usageCost = null;
  let durationSeconds = null;

  if (usageJson && typeof usageJson === "object") {
    usageAvailable = usageJson.available === true ? 1 : 0;
    // durationSeconds is written alongside `available`, not gated by it
    // (see runPrompt in prompt-execution.mjs), so it is read either way.
    if (typeof usageJson.durationSeconds === "number") durationSeconds = usageJson.durationSeconds;
    if (usageJson.available === true) {
      // usage.json carries `available: true|false`; the numeric fields are
      // NOT guaranteed present even when available — every one is guarded.
      usageModel = typeof usageJson.model === "string" ? usageJson.model : null;
      usageInput = typeof usageJson.input === "number" ? usageJson.input : null;
      usageOutput = typeof usageJson.output === "number" ? usageJson.output : null;
      usageReasoning = typeof usageJson.reasoning === "number" ? usageJson.reasoning : null;
      usageCacheRead = typeof usageJson.cacheRead === "number" ? usageJson.cacheRead : null;
      usageCacheWrite = typeof usageJson.cacheWrite === "number" ? usageJson.cacheWrite : null;
      usageCost = typeof usageJson.cost === "number" ? usageJson.cost : null; // 0 is real
    }
  }

  if (durationSeconds === null && startedMs !== null && finishedMs !== null) {
    durationSeconds = (finishedMs - startedMs) / 1000;
  }

  return {
    jobRow: {
      jobId,
      workspaceSlug: ctx.workspaceSlug ?? null,
      kind: typeof jobJson.kind === "string" ? jobJson.kind : null,
      title: typeof jobJson.title === "string" ? jobJson.title : null,
      status: typeof jobJson.status === "string" ? jobJson.status : null,
      phase: typeof jobJson.phase === "string" ? jobJson.phase : null,
      // Dispatch backend (kusabi #184), stored verbatim — NULL when the job
      // record predates the split; readers treat NULL as "opencode".
      backend: typeof jobJson.backend === "string" ? jobJson.backend : null,
      modelEntry: typeof jobJson.modelEntry === "string" ? jobJson.modelEntry : null,
      startedAt,
      startedMs,
      finishedAt,
      finishedMs,
      durationSeconds,
      steps: typeof stats.steps === "number" ? stats.steps : null,
      error: typeof jobJson.error === "string" ? jobJson.error : null,
      usageAvailable,
      usageModel,
      usageInput,
      usageOutput,
      usageReasoning,
      usageCacheRead,
      usageCacheWrite,
      usageCost,
    },
  };
}

/**
 * Walk `stateRoot` for delegated-job records at
 * `<stateRoot>/<workspace-hash>/jobs/job-<id>/{job.json,usage.json}` and
 * upsert `job` rows into `db`.  Same shape as `ingestChainDirectory`, one
 * level over (`jobs/` instead of `chains/`).
 *
 * Counters are per JOB (a job is up to two files), hence `jobsScanned` /
 * `jobsSkippedUnchanged` rather than the chain walker's file-based names.
 * `ioFailures` / `parseFailures` keep the same split as the other walkers:
 * whole-file-unreadable vs read-but-malformed (or no usable `id`).  A
 * failure on EITHER of a job's two files skips the whole job without
 * recording anything — ingesting job.json while silently dropping an
 * existing-but-broken usage.json would record a false "died before writing
 * usage"; nothing is written to `source_file` either, so the job is retried
 * on the next run.
 *
 * A job directory with no `job.json` (nothing usable was ever persisted) is
 * silently skipped, mirroring the chain walker's no-chain.json case.
 * `jobsMissingUsage` counts jobs ingested WITHOUT a usage.json — the
 * job-side analogue of "chains that died without writing chain.json": a job
 * that failed early is exactly the one worth seeing.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} stateRoot
 * @returns {{
 *   workspacesScanned: number,
 *   jobsScanned: number, jobsSkippedUnchanged: number,
 *   ioFailures: number, parseFailures: number,
 *   jobsIngested: number, jobsMissingUsage: number,
 * }}
 */
export function ingestJobDirectory(db, stateRoot) {
  const summary = {
    workspacesScanned: 0,
    jobsScanned: 0,
    jobsSkippedUnchanged: 0,
    ioFailures: 0,
    parseFailures: 0,
    jobsIngested: 0,
    jobsMissingUsage: 0,
  };

  if (!fs.existsSync(stateRoot)) return summary;

  let workspaceDirs;
  try {
    workspaceDirs = fs.readdirSync(stateRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return summary;
  }

  for (const wdirent of workspaceDirs) {
    const workspaceSlug = wdirent.name;
    const jobsDir = path.join(stateRoot, workspaceSlug, "jobs");
    if (!fs.existsSync(jobsDir)) continue;
    summary.workspacesScanned += 1;

    let jobDirs;
    try {
      jobDirs = fs.readdirSync(jobsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      continue;
    }

    for (const jdirent of jobDirs) {
      if (!jdirent.name.startsWith("job-")) continue;
      const jobJsonPath = path.join(jobsDir, jdirent.name, "job.json");
      const usageJsonPath = path.join(jobsDir, jdirent.name, "usage.json");
      if (!fs.existsSync(jobJsonPath)) continue; // nothing usable persisted — not a failure

      summary.jobsScanned += 1;

      let jobStat;
      try {
        jobStat = fs.statSync(jobJsonPath);
      } catch {
        summary.ioFailures += 1;
        continue;
      }

      let usageStat = null;
      if (fs.existsSync(usageJsonPath)) {
        try {
          usageStat = fs.statSync(usageJsonPath);
        } catch {
          summary.ioFailures += 1;
          continue;
        }
      }

      // Composite skip key (see the header comment): job.json unchanged AND
      // usage.json unchanged-or-consistently-absent.  When usage.json does
      // not exist, "unchanged" means no source_file row for it either — a
      // usage.json that appears (or vanishes) since the last run always
      // forces a re-read.
      const jobUnchanged = isSourceFileUnchanged(db, jobJsonPath, jobStat.size, jobStat.mtimeMs);
      const usageUnchanged = usageStat
        ? isSourceFileUnchanged(db, usageJsonPath, usageStat.size, usageStat.mtimeMs)
        : getSourceFile(db, usageJsonPath) === undefined;
      if (jobUnchanged && usageUnchanged) {
        summary.jobsSkippedUnchanged += 1;
        continue;
      }

      let jobJson;
      try {
        jobJson = JSON.parse(fs.readFileSync(jobJsonPath, "utf8"));
      } catch (err) {
        if (err instanceof SyntaxError) summary.parseFailures += 1;
        else summary.ioFailures += 1;
        continue;
      }

      let usageJson = null;
      if (usageStat) {
        try {
          usageJson = JSON.parse(fs.readFileSync(usageJsonPath, "utf8"));
        } catch (err) {
          if (err instanceof SyntaxError) summary.parseFailures += 1;
          else summary.ioFailures += 1;
          continue;
        }
      }

      const parsed = parseJobRecord(jobJson, usageJson, { workspaceSlug });
      if (!parsed) {
        summary.parseFailures += 1;
        continue;
      }

      summary.jobsIngested += 1;
      if (usageJson === null) summary.jobsMissingUsage += 1;

      upsertJob(db, parsed.jobRow);
      const ingestedAt = new Date().toISOString();
      upsertSourceFile(db, {
        path: jobJsonPath,
        size: jobStat.size,
        mtimeMs: jobStat.mtimeMs,
        ingestedAt,
      });
      if (usageStat) {
        upsertSourceFile(db, {
          path: usageJsonPath,
          size: usageStat.size,
          mtimeMs: usageStat.mtimeMs,
          ingestedAt,
        });
      }
    }
  }

  return summary;
}
