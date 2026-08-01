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
  upsertSourceFile,
  isSourceFileUnchanged,
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

  const chainRow = {
    chainId,
    workspaceSlug: ctx.workspaceSlug ?? null,
    // Stratification keys (hazard 5) — stored verbatim, never collapsed.
    orchModel: orchestrator && typeof orchestrator.model === "string" ? orchestrator.model : null,
    orchSession: orchestrator && typeof orchestrator.session === "string" ? orchestrator.session : null,
    orchDate: orchestrator && typeof orchestrator.date === "string" ? orchestrator.date : null,
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

  const records = Array.isArray(chainJson.records) ? chainJson.records : [];
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
      modelEntry: typeof rec.modelEntry === "string" ? rec.modelEntry : null,
      tierBefore: typeof rec.tierBefore === "number" ? rec.tierBefore : null,
      tierAfter: typeof rec.tierAfter === "number" ? rec.tierAfter : null,
      verdict: typeof rec.verdict === "string" ? rec.verdict : null,
      probesGreen: toBoolInt(rec.probesGreen),
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
