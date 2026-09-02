// chain-review.mjs — Review phase orchestration and parsing for cmdChain and cmdReview.
//
// Extracted from chain-phases.mjs (kusabi #435).
//
// Functions in this module handle review payload parsing (JSONL and legacy single JSON),
// skip-review decision, schema-repair prompt formatting, probe report rendering,
// scope-aware prior findings rendering, and runReviewPhase orchestration.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  reviewDenyTools,
} from "./cli.mjs";
import {
  renderContainerReviewInput,
  renderPriorFindings,
  renderGroupedFindingsText,
  extractJson,
  recoverVerdictFromText,
} from "./render.mjs";
import { parseReviewJsonl } from "./review-jsonl.mjs";
import { validateReview } from "./review-validate.mjs";
import { stateDirFor } from "./state-paths.mjs";
import { appendEvent } from "./job-store.mjs";
import { dispatchWithFallback } from "./prompt-execution.mjs";
import {
  normalizeFilePath,
  hasRepeatedAreas,
  inScopeFindingFiles,
  resolveReworkScope,
} from "./chain-phases.mjs";
import {
  classifyDispatchQuotaExhaustion,
} from "./chain-quota.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");

/**
 * Render the {{PRIOR_FINDINGS}} slot of the review prompt for a round
 * (kusabi #334).
 *
 * The review seam receives the round's resolved scope the same way
 * buildImplementText does, and this renderer partitions the previous round's
 * findings from that ONE value.  A full-scope round (or no reworkScope at
 * all) renders byte-for-byte what the pre-scoping review prompt rendered:
 * previousRecord.findingsText verbatim, or the first-review marker when
 * there is no previous record.  A scoped round renders a partition instead:
 * the in-scope findings in full (the same per-finding renderer the implement
 * prompt uses for its scoped subset) followed by the deliberately-held
 * findings as one-line rows, marked still open and NOT a failure of this
 * round.
 *
 * Held findings are identified by identity: reworkScope.findings is a subset
 * of previousRecord.findings produced by resolveReworkScope, so an element
 * of the previous list that is not in the subset is held.  Held findings
 * KEEP being re-reported — they are open, they just were not in this round's
 * scope — because the re-reporting is the only thing that keeps a mechanical
 * round from approving and ending the chain with its design findings
 * unfixed.  The prompt never tells the reviewer to drop them.
 *
 * @param {object|null|undefined} previousRecord
 * @param {{scope: string, findings: Array}|undefined|null} reworkScope
 * @returns {string}
 */
export function renderReviewPriorFindings(previousRecord, reworkScope) {
  if (!reworkScope || reworkScope.scope === "full") {
    // Byte-identical to the pre-scoping text (kusabi #334): the reviewer
    // sees the whole prior list, exactly as today.
    return previousRecord?.findingsText || "(none -- first review round)";
  }
  const previousFindings = Array.isArray(previousRecord?.findings) ? previousRecord.findings : [];
  const inScope = Array.isArray(reworkScope.findings) ? reworkScope.findings : [];
  const held = previousFindings.filter((f) => !inScope.includes(f));
  const scopeWord = reworkScope.scope === "mechanical" ? "mechanical" : "design";
  const lines = [];
  lines.push(
    "This round was scoped to " + scopeWord + " findings.  The prior findings the round was asked to resolve are:"
  );
  lines.push("");
  lines.push(renderPriorFindings({ findings: inScope }));
  lines.push("");
  if (held.length > 0) {
    lines.push(
      "The following prior findings were known and DELIBERATELY HELD OUT of this round's scope. " +
      "They are still open — this round was not asked to resolve them. " +
      "Re-report each one you can confirm is still unfixed, described as still open and outside " +
      "this round's scope — never as work this round failed to do:"
    );
    lines.push("");
    lines.push(held.map(reviewFindingRow).join("\n"));
  } else {
    lines.push(
      "No prior findings were held out of this round's scope: every known finding was in scope."
    );
  }
  return lines.join("\n");
}

/**
 * One-line row for a held finding in the scoped review prompt — the same
 * "[severity] title (file:line)" shape renderGroupedFindingsText uses, so
 * the reviewer recognises the held items from the previous round's report.
 * Kept local: render.mjs is shared with the task route and this shape is
 * only used by the chain review seam.
 *
 * @param {object|undefined} f
 * @returns {string}
 */
function reviewFindingRow(f) {
  const severity = f && f.severity ? f.severity : "unknown";
  const title = f && f.title ? f.title : "(untitled)";
  const file = f && f.file ? f.file : "?";
  const lineStart = f && f.line_start !== undefined ? f.line_start : "?";
  return "[" + severity + "] " + title + " (" + file + ":" + lineStart + ")";
}

/**
 * Parse the reviewer's raw output into the chain's in-memory review shape.
 *
 * Two input formats, in this order (kusabi #202):
 *
 *  1. JSONL — one self-delimiting record per line, written as each piece is
 *     decided (`review-jsonl.mjs`).  Non-JSON lines between records are
 *     ignored, so the reviewer may narrate.  A stream that carried findings
 *     but no `verdict` line is a PARTIAL review: `chainVerdict` is
 *     `"partial"`, a state of its own.  It is not an approval and does not
 *     buy a rework round — it escalates (see deriveDisposition) with the
 *     findings recorded and rendered like any other findings.  It is
 *     `reviewParseable: true`, which is what keeps it out of the
 *     docs/design/phase-chain.md §3.5 unparseable retry: we READ this
 *     output fine, the model ran out of room, and re-dispatching spends
 *     the budget that just proved insufficient.
 *
 *  2. A single JSON object, via `extractJson` + VERDICT-token recovery —
 *     unchanged, byte for byte, for every historical record and every
 *     reviewer not yet emitting JSONL.
 *
 * @param {string} reviewResultText
 * @returns {{ chainParsedReview: object|null, chainVerdict: string,
 *             chainFindingsText: string, reviewParseable: boolean,
 *             reviewPartial: boolean, reviewFindingCount: number }}
 */
export function parseReviewResult(reviewResultText) {
  // ---- JSONL first (kusabi #202, #392) ----
  // Returns null for anything that is not JSONL (including an empty stream),
  // which falls through to the single-object path below untouched.
  const jsonl = parseReviewJsonl(reviewResultText);
  if (jsonl) {
    // Partial review (no closing verdict): skip schema validation (verdict "partial"
    // is not in the schema enum). Retain findings and mark partial.
    if (jsonl.partial && !jsonl.review?.salvagedVerdict) {
      return {
        chainParsedReview: jsonl.review,
        chainVerdict: "partial",
        chainFindingsText: renderGroupedFindingsText(jsonl.review.findings),
        reviewParseable: true,
        reviewPartial: true,
        reviewFindingCount: jsonl.findingCount,
        partialDiagnosis: jsonl.partialDiagnosis || null,
        salvagedVerdict: false,
        schemaErrors: [],
      };
    }

    // Salvaged review (#312): validate all fields except schema_version;
    // salvagedVerdict annotation is stripped during validation.
    const isSalvaged = jsonl.review?.salvagedVerdict === true;
    const validation = validateReview(jsonl.review, { salvaged: isSalvaged });
    if (validation.valid) {
      return {
        chainParsedReview: jsonl.review,
        chainVerdict: jsonl.review.verdict,
        chainFindingsText: renderGroupedFindingsText(jsonl.review.findings),
        reviewParseable: true,
        reviewPartial: false,
        reviewFindingCount: jsonl.findingCount,
        partialDiagnosis: null,
        salvagedVerdict: isSalvaged,
        schemaErrors: [],
      };
    }

    return {
      chainParsedReview: null,
      chainVerdict: "unparseable",
      chainFindingsText: "(review output could not be parsed)",
      reviewParseable: false,
      reviewPartial: false,
      reviewFindingCount: 0,
      partialDiagnosis: null,
      salvagedVerdict: false,
      schemaErrors: validation.errors,
    };
  }

  // ---- parse single JSON object (legacy path, kusabi #392 strict validate) ----
  const trailingStripped = reviewResultText.replace(/\s*VERDICT:\s*(approve-partial|approve|needs-attention|discard)\s*$/i, "");
  let parsed = extractJson(trailingStripped);

  if (!parsed) {
    const recovered = recoverVerdictFromText(reviewResultText);
    if (recovered) {
      const anywhereStripped = reviewResultText.replace(/\s*VERDICT:\s*(approve-partial|approve|needs-attention|discard)\s*/gi, "");
      parsed = extractJson(anywhereStripped);
    }
  }

  if (parsed !== null) {
    const validation = validateReview(parsed);
    if (validation.valid) {
      const findingsArray = Array.isArray(parsed.findings) ? parsed.findings : [];
      const chainFindingsText = renderGroupedFindingsText(findingsArray);
      return {
        chainParsedReview: parsed,
        chainVerdict: parsed.verdict,
        chainFindingsText,
        reviewParseable: true,
        reviewPartial: false,
        reviewFindingCount: findingsArray.length,
        partialDiagnosis: null,
        salvagedVerdict: false,
        schemaErrors: [],
      };
    }
    return {
      chainParsedReview: null,
      chainVerdict: "unparseable",
      chainFindingsText: "(review output could not be parsed)",
      reviewParseable: false,
      reviewPartial: false,
      reviewFindingCount: 0,
      partialDiagnosis: null,
      salvagedVerdict: false,
      schemaErrors: validation.errors,
    };
  }

  // Unparseable review: no JSON object found. Recover verdict token if present.
  const recoveredV = recoverVerdictFromText(reviewResultText);
  const chainVerdict = recoveredV ? recoveredV.verdict : "unparseable";
  const chainFindingsText = "(review output could not be parsed)";
  return {
    chainParsedReview: null,
    chainVerdict,
    chainFindingsText,
    reviewParseable: false,
    reviewPartial: false,
    reviewFindingCount: 0,
    partialDiagnosis: null,
    salvagedVerdict: false,
    schemaErrors: [],
  };
}

/**
 * Build the short repair prompt to correct schema-invalid review output (kusabi #395).
 *
 * When `hasSession` is true, the reviewer session already holds the review context
 * and diff, so only the machine-readable errors and instruction are needed.
 * When `hasSession` is false (no sessionID available), a truncated copy of the
 * original output is appended so a fresh worker has context to correct.
 *
 * @param {object} opts
 * @param {Array<{path: string, expected: string, actual: any}>} opts.schemaErrors
 * @param {string|null} [opts.originalOutput]
 * @param {boolean} [opts.hasSession=true]
 * @returns {string}
 */
export function buildReviewRepairPrompt({ schemaErrors, originalOutput = null, hasSession = true } = {}) {
  const errorsJson = JSON.stringify(schemaErrors || [], null, 2);
  let prompt =
    "The previous review output failed schema validation against plugins/kusabi/schemas/review-output.schema.json.\n\n" +
    "Schema validation errors:\n```json\n" +
    errorsJson +
    "\n```\n\n";

  if (!hasSession && originalOutput) {
    const truncated = originalOutput.length > 4000
      ? originalOutput.slice(0, 4000) + "\n...(truncated)"
      : originalOutput;
    prompt += "Previous review output:\n```\n" + truncated + "\n```\n\n";
  }

  prompt +=
    "Please emit ONE corrected JSON object that satisfies plugins/kusabi/schemas/review-output.schema.json " +
    "(schema_version: 1, required keys: schema_version, verdict, summary, findings, next_steps, and no extra properties).";

  return prompt;
}

/**
 * Determine whether the review should be skipped (probe-driven discard).
 */
export function shouldSkipReview({ chainStatusObserved, chainChangedPaths, chainNewlyChanged, chainDeliverables }) {
  // Null means the since-baseline comparison could not be made.  Fall back to
  // the full changed set rather than treating "unknown" as "nothing changed" —
  // skipping review here turns a failed measurement into a discarded round.
  const effectivePaths = chainNewlyChanged ?? chainChangedPaths;
  return chainStatusObserved && effectivePaths.length === 0 && chainDeliverables.length > 0;
}

/**
 * Render the round's deterministic probe results (P1–P6) into the review
 * prompt (kusabi #236).
 *
 * One line per probe: name, pass state, one-line detail.  The detail is
 * normalised to a single line (internal whitespace collapsed) so the block
 * is always exactly one line per probe — never a wall of captured output
 * that eats the reviewer's budget.  A missing or empty probe set must
 * render an explicit absence marker — never an empty string, which would
 * read as "all fine" and hand the reviewer false confidence.
 *
 * @param {Array<{probe: string, passed: boolean, detail: string}>|undefined} probeResults
 * @returns {string}
 */
export function renderProbeReport(probeResults) {
  if (!Array.isArray(probeResults) || probeResults.length === 0) {
    return "(no probe results recorded)";
  }
  return probeResults.map(function (p) {
    const name = p && typeof p.probe === "string" && p.probe ? p.probe : "(unnamed probe)";
    const state = p && p.passed === true ? "passed" : "failed";
    const detail = String((p && p.detail) || "").replace(/\s+/g, " ").trim();
    return "- " + name + " — " + state + (detail ? " — " + detail : "");
  }).join("\n");
}

/**
 * Run the review phase (or mark skip when the change set is empty).
 *
 * Single result conduit (kusabi #100): everything that belongs on the
 * persisted round record — review-job fields (reviewJobId / reviewUsage /
 * reviewModelEntry / reviewModelVariant / reviewFallbacks), verdict,
 * verdictSource, reviewParseable, findingsText, findings, findingFiles and
 * the unparseable-retry trace fields — is written onto `roundRecord` and is
 * NOT returned.  The return value carries only what is genuinely not record
 * state: the parsed review object, the cross-round repeated-areas signal,
 * whether review was skipped, and the job status/error needed by the
 * caller's provider-exhaustion branch.
 */
export async function runReviewPhase({
  container, brief, modelChain, chainId, cwd, previousRecord, baseSha,
  chainStatusOutput, chainBaseLog, chainUntracked, chainTruncation, roundRecord,
  chainChangedPaths, chainNewlyChanged, chainStatusObserved, chainDeliverables, flagsModel,
  reworkScope, changeScope,
  _dispatchWithFallback: _dispatch = dispatchWithFallback,
} = {}) {
  const skipReview = shouldSkipReview({ chainStatusObserved, chainChangedPaths, chainNewlyChanged, chainDeliverables });

  // ---- P3 empty-change: set probe-sourced discard verdict before review ----
  if (skipReview) {
    roundRecord.verdict = "discard";
    roundRecord.verdictSource = "probe";
    roundRecord.reviewParseable = false;
    // What this discard does NOT mean (kusabi #299).  The round added nothing
    // SINCE THE BASELINE, which is why the review was skipped — it says
    // nothing about whether earlier rounds' work is still in the worktree.
    // In the motivating incident (chain-msvthdq26fdc, 2026-08-16) it was: the
    // empty round was discarded, the chain escalated reading "reviewer
    // discarded the work", and the intact rounds-1–2 worktree it was sitting
    // on eventually shipped.  So record the other fact too, straight from the
    // change set P3 already captured (`git status --porcelain` against the
    // chain base, which P1 leaves HEAD parked at) — no second collection
    // mechanism, and no container call of its own.  Distinct from
    // `worktreeChanged`, which is measured against the RUN's baseline and is
    // false on exactly this path.
    roundRecord.worktreeDirtyVsBase = Array.isArray(chainChangedPaths) && chainChangedPaths.length > 0;
  }

  let chainVerdict = roundRecord.verdict; // may already be set by probe skip above
  let chainFindingsText = null;
  let chainParsedReview = null;
  let chainRepeatedAreas = false;
  let reviewJobStatus = undefined;
  let reviewJobError = null;
  let reviewParseable = false;

  if (!skipReview) {
    const promptTemplate = fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", "adversarial-review.md"), "utf8");
    const schemaJson = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json"), "utf8"));
    // The review input (the review-target block naming this container and the
    // read-side tools -- `read_file_range`, `search_in_container`,
    // `diff_in_container`, the verify gates -- followed by the base facts and
    // the instruction to fetch the diff against the base) is rendered by
    // renderContainerReviewInput in render.mjs.  It used to be built inline
    // here; `task --phase review --container` sent no review input at all, so
    // the extraction gives both routes the same block from one place
    // (kusabi #204).  The diff body it used to carry is gone: it was one
    // default-paged capture, so it was page one of the diff and nothing else
    // (kusabi #208).
    const effectiveChangeScope = changeScope ?? roundRecord?.changeScope ?? null;
    const reviewInput = renderContainerReviewInput({
      container,
      baseSha,
      baseLog: chainBaseLog,
      statusOutput: chainStatusOutput,
      untrackedFiles: chainUntracked,
      truncation: chainTruncation,
      changeScope: effectiveChangeScope,
    });
    // Single decision point (kusabi #334): the review seam reads the round's
    // scope from the SAME resolveReworkScope decision the driver made — the
    // driver carries its scopeResolution here, the way buildImplementText
    // already receives it.  When the value is absent (older callers, tests)
    // the same function is re-invoked on the same previousRecord; it is
    // deterministic, so the review-resume path — which has no fresh-round
    // block to carry a scopeResolution from — derives the same answer the
    // fresh path derived.  Old records without scope information resolve to
    // "full" and degrade to today's behaviour rather than throwing.
    const reviewScope = reworkScope || resolveReworkScope(previousRecord);
    const priorFindings = renderReviewPriorFindings(previousRecord, reviewScope);

    const reviewPromptText = promptTemplate
      .replaceAll("{{TARGET_LABEL}}", "container " + container + " changes")
      .replaceAll("{{USER_FOCUS}}", brief)
      .replaceAll("{{OUTPUT_SCHEMA}}", JSON.stringify(schemaJson))
      .replaceAll("{{REVIEW_INPUT}}", reviewInput)
      .replaceAll("{{PRIOR_FINDINGS}}", priorFindings)
      // kusabi #236: the round's deterministic probe results (P1–P6) reach
      // the reviewer as {{PROBE_REPORT}}, so the reviewer does not spend
      // findings re-litigating what the probes already measured.  A round
      // with no recorded probes renders the explicit absence marker, never an
      // empty string that reads as "all fine".
      .replaceAll("{{PROBE_REPORT}}", renderProbeReport(roundRecord.probeResults));

    // The reviewer's route does not follow the round ladder: it stays on the
    // same route for every round, which is what the pre-fallback code did
    // (`--model` when given, otherwise the chain's first entry).  Round 1 is
    // passed so selectRoutes offers tier 1 onwards, and `explicitModel` keeps
    // `--model` in force for reviews of every round.
    // dispatchWithFallback handles capacity fallback transparently.
    // These options are reused verbatim for the unparseable-output retry
    // below — same prompt, tiers, agent, tools, and timeouts.
    const reviewDispatchOptions = {
      cwd,
      kind: "review",
      title: "chain: " + chainId + " round " + roundRecord.round + " review",
      promptText: reviewPromptText,
      agent: "kusabi-review",
      tools: reviewDenyTools(),
      timeoutS: 1800,
      watchdogS: 900,
      tiers: modelChain,
      round: 1,
      explicitModel: flagsModel || null,
    };

    let reviewJob;
    let reviewResultText;
    ({ job: reviewJob, resultText: reviewResultText } = await _dispatch(reviewDispatchOptions));

    // ---- parse review result ----
    let {
      chainParsedReview: _parsed, chainVerdict: _verdict,
      chainFindingsText: _findings, reviewParseable: _parseable,
      reviewPartial: _partial, reviewFindingCount: _findingCount,
      partialDiagnosis: _partialDiagnosis, salvagedVerdict: _salvagedVerdict,
      schemaErrors: _schemaErrors,
    } = parseReviewResult(reviewResultText);

    if (_schemaErrors && _schemaErrors.length > 0 && cwd && reviewJob?.id) {
      appendEvent(stateDirFor(cwd), reviewJob.id, {
        type: "companion.review.schema_invalid",
        errors: _schemaErrors,
      });
    }

    // ---- schema-invalid repair loop (kusabi #395) ----
    // If the review output failed schema validation but the job completed,
    // repair once by injecting the machine-readable schema errors into the
    // same worker session (or fresh with truncated output if sessionID is missing).
    // This is distinct from the unparseable identical-prompt garbage retry.
    if (_schemaErrors && _schemaErrors.length > 0 && reviewJob.status === "completed") {
      if (cwd && reviewJob?.id) {
        appendEvent(stateDirFor(cwd), reviewJob.id, {
          type: "companion.review.schema_repair",
          attempt: 1,
          errors: _schemaErrors,
        });
      }
      roundRecord.reviewSchemaRepaired = true;
      roundRecord.reviewFirstJobId = reviewJob.id;
      // First-attempt spend and fallback trail, so retried/repaired rounds report
      // their true cost in chain totals (same shapes as the final-attempt
      // reviewUsage / reviewFallbacks fields recorded below).
      roundRecord.reviewFirstUsage = reviewJob.usage || null;
      roundRecord.reviewFirstFallbacks = reviewJob.fallbacks || null;

      const hasSession = Boolean(reviewJob.sessionID);
      const repairPromptText = buildReviewRepairPrompt({
        schemaErrors: _schemaErrors,
        originalOutput: reviewResultText,
        hasSession,
      });

      const repairDispatchOptions = {
        ...reviewDispatchOptions,
        promptText: repairPromptText,
        ...(hasSession ? { session: reviewJob.sessionID } : {}),
      };

      ({ job: reviewJob, resultText: reviewResultText } = await _dispatch(repairDispatchOptions));
      ({ chainParsedReview: _parsed, chainVerdict: _verdict,
         chainFindingsText: _findings, reviewParseable: _parseable,
         reviewPartial: _partial, reviewFindingCount: _findingCount,
         partialDiagnosis: _partialDiagnosis, salvagedVerdict: _salvagedVerdict,
         schemaErrors: _schemaErrors } = parseReviewResult(reviewResultText));
      if (_schemaErrors && _schemaErrors.length > 0 && cwd && reviewJob?.id) {
        appendEvent(stateDirFor(cwd), reviewJob.id, {
          type: "companion.review.schema_invalid",
          errors: _schemaErrors,
        });
      }
    } else if (!_parseable && _verdict === "unparseable" && reviewJob.status === "completed") {
      // ---- retry once on unparseable output (issue #145) ----
      // A job that completes with garbage — no JSON and no recoverable
      // VERDICT token (and empty schemaErrors) — is usually a transient provider hiccup
      // rather than a genuine verdict (real incident: a 132-token broken review response
      // that re-dispatched cleanly).  Re-dispatch exactly once within this
      // round with identical options and treat the second attempt as final;
      // two consecutive unparseable results escalate exactly as before.  The
      // retry lives entirely inside this phase and never consumes a round.
      //
      // The retry is gated on the first job having COMPLETED: a job that
      // failed outright (serve-dead / stalled / timeout / error) returns
      // empty or garbage resultText, and re-dispatching would double
      // worst-case latency (2 × watchdog 900s / timeout 1800s) in exactly the
      // degraded environments where it is known-futile.  Only a completed job
      // whose output was garbage gets a second attempt; a hard failure
      // escalates after a single attempt, exactly as before the retry existed.
      //
      // A PARTIAL review (kusabi #202) is deliberately NOT a retry case: the
      // JSONL stream was read fine (`_parseable` is true and `_verdict` is
      // "partial", so both guards below already exclude it), the model simply
      // ran out of room.  Re-dispatching spends the budget that just proved
      // insufficient; the partial review escalates with its findings instead.
      roundRecord.reviewUnparseableRetried = true;
      roundRecord.reviewFirstJobId = reviewJob.id;
      // First-attempt spend and fallback trail, so retried rounds report
      // their true cost in chain totals (same shapes as the final-attempt
      // reviewUsage / reviewFallbacks fields recorded below).
      roundRecord.reviewFirstUsage = reviewJob.usage || null;
      roundRecord.reviewFirstFallbacks = reviewJob.fallbacks || null;
      ({ job: reviewJob, resultText: reviewResultText } = await _dispatch(reviewDispatchOptions));
      ({ chainParsedReview: _parsed, chainVerdict: _verdict,
         chainFindingsText: _findings, reviewParseable: _parseable,
         reviewPartial: _partial, reviewFindingCount: _findingCount,
         partialDiagnosis: _partialDiagnosis, salvagedVerdict: _salvagedVerdict,
         schemaErrors: _schemaErrors } = parseReviewResult(reviewResultText));
      if (_schemaErrors && _schemaErrors.length > 0 && cwd && reviewJob?.id) {
        appendEvent(stateDirFor(cwd), reviewJob.id, {
          type: "companion.review.schema_invalid",
          errors: _schemaErrors,
        });
      }
    }

    roundRecord.reviewJobId = reviewJob.id;
    roundRecord.reviewUsage = reviewJob.usage || null;
    roundRecord.reviewModelEntry = reviewJob.modelEntry || null;
    roundRecord.reviewModelVariant = reviewJob.modelVariant || null;
    roundRecord.reviewFallbacks = reviewJob.fallbacks || null;
    reviewJobStatus = reviewJob.status;
    reviewJobError = reviewJob.error || null;
    // Structured terminal-failure classification (kusabi #215 / #373), carried
    // on the record (single conduit).  Adapter-supplied `job.failure` wins;
    // when the adapter left it null (agy v1, opencode), classify from the
    // observed quota phrases in the error text so a no-payload job is not
    // recorded as `reviewJobFailure: null`.
    roundRecord.reviewJobFailure = reviewJob.failure
      || classifyDispatchQuotaExhaustion(reviewJob.error)
      || null;
    // Failure TEXT, distinct from the structured classification: a job that
    // produced no payload at all must be readable from the round record.
    // Written only when present so a healthy review's record is unchanged.
    if (reviewJob.error) roundRecord.reviewJobError = reviewJob.error;

    chainParsedReview = _parsed;
    chainVerdict = _verdict;
    chainFindingsText = _findings;
    reviewParseable = _parseable;
    roundRecord.reviewParseable = reviewParseable;
    roundRecord.verdict = chainVerdict;
    if (!reviewParseable) {
      roundRecord.verdictSource = "recovered-from-token";
    }
    if (_salvagedVerdict) {
      roundRecord.salvagedVerdict = true;
    }
    // Partial review (kusabi #202): the record must make it visible that the
    // review was incomplete, and how many findings it did carry.  Written
    // only when partial, so records for complete reviews are unchanged.
    if (_partial) {
      roundRecord.reviewPartial = true;
      roundRecord.reviewFindingCount = _findingCount;
      if (_partialDiagnosis) {
        roundRecord.reviewPartialDiagnosis = _partialDiagnosis;
      }
    }
    roundRecord.findingsText = chainFindingsText;

    // ---- store file paths for cross-round comparison ----
    // Stores the raw finding file paths from the parsed review.
    // Comparison uses path-segment suffix matching in hasRepeatedAreas,
    // so absolute vs relative path differences are handled transparently.
    // Malformed-review guard (kusabi #153): normalise a non-array `findings`
    // to [] so nothing downstream calls .map / .forEach on a string.
    const reviewFindingsArray = Array.isArray(chainParsedReview?.findings) ? chainParsedReview.findings : [];
    roundRecord.findingFiles = reviewFindingsArray.map(function (f) { return normalizeFilePath(f.file); });
    roundRecord.findings = reviewFindingsArray;

    // ---- determine repeated areas using hasRepeatedAreas ----
    // Uses the stored findingFiles array instead of re-parsing the
    // human-readable findingsText, which was fragile: it broke on
    // finding titles containing parentheses and on path-form mismatches.
    // Kusabi #334: the detector's semantics are shared with chain-stats, so
    // what is narrowed here is the INPUT — previousFindingFiles is reduced to
    // the previous round's findings that were in THIS round's scope.  Held
    // findings (deliberately left for a later round) are not evidence of a
    // stall; in-scope repeats still fire exactly as before.
    chainRepeatedAreas = hasRepeatedAreas(inScopeFindingFiles(previousRecord, reviewScope), chainParsedReview?.findings);
  }

  // Single conduit: record state stays on roundRecord; the return carries
  // only what is not record state (see the docstring above).
  return { chainParsedReview, chainRepeatedAreas, skipReview, reviewJobStatus, reviewJobError };
}
