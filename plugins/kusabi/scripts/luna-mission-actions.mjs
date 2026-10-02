// Execution mechanics and refusal classification; lifecycle decisions stay in the driver.
import { stampInnerBriefSignature, parseOrchestratorSignature } from "./brief-parsing.mjs";
import { CODEX_SUPPORTED_MODELS } from "./codex-dispatch.mjs";
import {
  replaceRecord, recordHostIntervention, recordConsult, persistInvestigationArtifact,
} from "./luna-mission-ledger.mjs";

// The cheap downstream brief validators the pre-seam refusal reuses — the
// SAME functions the chain dispatch runs before any job or chain state
// exists (kusabi #289/#302/#386 lint and kusabi #250/#302 smoke), so a brief
// the mission refuses could never have dispatched downstream either.  Both
// modules are heavy command modules; they are loaded lazily like every other
// command surface this driver reaches (codex-dispatch, chain-cmd, ...), so
// the mission driver itself never pays their static import cost.
let _briefValidators = null;
export async function briefValidators() {
  if (_briefValidators === null) {
    const [briefLint, guards] = await Promise.all([
      import("./brief-lint.mjs"),
      import("./chain-brief-guards.mjs"),
    ]);
    _briefValidators = {
      briefLintReport: briefLint.briefLintReport,
      smokeViolationReport: guards.smokeViolationReport,
      BRIEF_REFUSED_CODE: guards.BRIEF_REFUSED_CODE,
    };
  }
  return _briefValidators;
}

/**
 * The precise refusal detail for a STAMPED inner-chain brief that fails the
 * deterministic pre-seam validation, or null when it is clean.
 *
 * Decision 5: before any chain state or seam call, the driver reuses the
 * same cheap downstream parse/lint/smoke validators — briefLintReport (the
 * #289/#302/#386 dispatch lint: a non-empty `## Deliverables`, zero-entry
 * `## Smoke` / `## Frozen Tests` headings, and Frozen Tests path-only
 * entries) and smokeViolationReport (the #250 lossy-command / no-entries
 * smoke violations).  The container is passed so the implement-phase
 * container-source rule cannot fire — the mission already resolved the
 * container the inner chain runs in, so that rule is the outer dispatch's to
 * enforce, not the inner brief's.  The signature rule cannot fire either:
 * this runs on the STAMPED brief, which by construction carries the
 * canonical line 1.
 *
 * Purely a read of the brief text: no smoke command is pre-run and
 * smokeBaselineReport is never duplicated (the downstream baseline keeps its
 * own execution at dispatch).
 *
 * @param {string} brief       The STAMPED inner-chain brief text.
 * @param {string} container   The mission's container id.
 * @returns {Promise<string|null>}
 */
export async function innerBriefValidationReport(brief, container) {
  const { briefLintReport, smokeViolationReport } = await briefValidators();
  const lint = briefLintReport({ brief, phase: null, container, chain: true });
  const smoke = smokeViolationReport(brief);
  if (lint === null && smoke === null) return null;
  return [lint, smoke].filter(Boolean).join("\n");
}

/**
 * Render the investigation fact sheet artifact (kusabi #591).
 *
 * @param {object} input
 * @param {string|null} input.jobId
 * @param {string|null} input.actualModel
 * @param {object|string|null} input.baseline
 * @param {string} input.body
 * @returns {string}
 */
export function renderFactSheet({ jobId, actualModel, baseline, body }) {
  let baselineText = "";
  if (typeof baseline === "string") {
    baselineText = baseline;
  } else if (baseline && typeof baseline === "object") {
    const lines = [];
    if (baseline.collected !== undefined) {
      lines.push(`Collected tests: ${baseline.collected ?? "unavailable"}`);
    }
    if (baseline.gates && typeof baseline.gates === "object") {
      if (baseline.gates.gate_passed !== undefined) {
        lines.push(`Verify gate: ${baseline.gates.gate_passed ? "passed" : "failed"}`);
      }
      if (baseline.gates.lint !== undefined) {
        lines.push(`Lint violations: ${baseline.gates.lint ?? "unavailable"}`);
      }
      if (baseline.gates.types !== undefined) {
        lines.push(`Type violations: ${baseline.gates.types ?? "unavailable"}`);
      }
    } else if (baseline.gates !== undefined) {
      lines.push(`Gates: ${typeof baseline.gates === "string" ? baseline.gates : JSON.stringify(baseline.gates)}`);
    }
    baselineText = lines.join("\n");
  }

  return [
    `# Investigation fact sheet`,
    ``,
    `job: ${jobId ?? "unknown"}`,
    `seat: ${actualModel ?? "unknown"}`,
    ``,
    `## Baseline`,
    baselineText,
    ``,
    `## Report`,
    body ?? "",
  ].join("\n");
}

/**
 * Default investigation dispatch: routes through the plan phase's configured
 * model chain against the mission container, using agent kusabi-plan (kusabi #591).
 * Never defaults to a codex seat (any id in `CODEX_SUPPORTED_MODELS`).
 *
 * @param {object} input
 * @param {string} input.cwd
 * @param {string} input.missionId
 * @param {string} input.missionDir
 * @param {string} input.brief
 * @param {string} input.container
 * @param {Function} [input._dispatch]
 * @returns {Promise<{ jobId: string, requestedModel: string, actualModel: string, body: string }>}
 */
export async function defaultInvestigationDispatch({
  cwd,
  brief,
  container,
  _dispatch = null,
}) {
  const instruction =
    "Produce a fact sheet for this task: relevant code locations as file:line, risks, and candidate deliverables (paths).";
  const prompt = `${(brief ?? "").trim()}\n\n${instruction}`;
  const flags = { phase: "plan", container };

  const { dispatchTaskJob } = await import("./task-cmd.mjs");
  const { job, resultText } = await dispatchTaskJob(
    cwd,
    { flags, text: prompt, _dispatch },
    {
      excludedBackends: ["codex"],
      exclusionErrorPrefix: "investigation has no non-codex seat available",
      excludedRouteReason: "codex backend excluded before investigation dispatch",
    },
  );

  if (job.status !== "completed") {
    throw new Error(job.error || `investigation job ${job.id} failed with status ${job.status}`);
  }

  const body = (resultText ?? "").trim();
  if (!body) {
    throw new Error(`investigation job ${job.id} returned empty report body`);
  }

  const firstTier = Array.isArray(job.modelChain?.[0]) ? job.modelChain[0][0] : job.modelChain?.[0];
  const requestedModel = firstTier ?? job.modelEntry ?? "unknown";
  const actualModel = job.modelEntry ?? requestedModel;

  if (
    CODEX_SUPPORTED_MODELS.some((seat) => actualModel.includes(seat)) ||
    job.backend === "codex"
  ) {
    throw new Error(`investigation cannot route to a codex seat (${actualModel})`);
  }

  return {
    jobId: job.id,
    requestedModel,
    actualModel,
    body: resultText,
  };
}

export async function defaultBaseline({ container, callTool }) {
  const { measureBaseline } = await import("./chain-ops.mjs");
  return measureBaseline({ callTool, container });
}

export async function runInvestigation(ctx) {
  const { cwd, container, missionId, missionDir, brief,
    baselineSeam, investigationDispatchSeam } = ctx;
  let failure = null;
  const startedAt = new Date().toISOString();
  const failInvestigation = (cause, partial = {}) => {
    const finishedAt = new Date().toISOString();
    replaceRecord(ctx, {
      investigation: {
        status: "failed",
        jobId: partial.jobId ?? null,
        phase: "plan",
        requestedModel: partial.requestedModel ?? null,
        actualModel: partial.actualModel ?? null,
        startedAt,
        finishedAt,
        factSheetPath: null,
        baseline: partial.baseline ?? null,
        error: cause,
      },
    });
    recordHostIntervention(ctx, `investigation failed: ${cause}`);
    failure = {
      handoffReason: `investigation failed: ${cause}`,
    };
  };

  let baselineRes = null;
  try {
    baselineRes = await baselineSeam({ cwd, container });
    if (!baselineRes || typeof baselineRes !== "object") {
      throw new Error("baseline measurement returned empty or invalid result");
    }
  } catch (err) {
    const cause = err?.message ?? String(err);
    failInvestigation(cause);
  }

  if (failure === null) {
    let dispatchRes = null;
    if (!investigationDispatchSeam?._isStub) {
      ctx.invokedInvestigation = true;
    }
    try {
      dispatchRes = await investigationDispatchSeam({
        cwd,
        missionId,
        missionDir,
        brief,
        container,
      });
      if (!dispatchRes || typeof dispatchRes !== "object") {
        throw new Error("investigation dispatch returned invalid or empty result");
      }
      if (typeof dispatchRes.body !== "string" || dispatchRes.body.trim() === "") {
        throw new Error("investigation returned empty report body");
      }
    } catch (err) {
      const cause = err?.message ?? String(err);
      failInvestigation(cause, {
        jobId: dispatchRes?.jobId,
        requestedModel: dispatchRes?.requestedModel,
        actualModel: dispatchRes?.actualModel,
        baseline: baselineRes,
      });
    }

    if (failure === null) {
      const finishedAt = new Date().toISOString();
      const factSheetRelative = "evidence/fact-sheet.md";
      const factSheetContent = renderFactSheet({
        jobId: dispatchRes.jobId,
        actualModel: dispatchRes.actualModel,
        baseline: baselineRes,
        body: dispatchRes.body,
      });
      persistInvestigationArtifact(ctx, factSheetRelative, factSheetContent);

      replaceRecord(ctx, {
        investigation: {
          status: "completed",
          jobId: dispatchRes.jobId,
          phase: "plan",
          requestedModel: dispatchRes.requestedModel,
          actualModel: dispatchRes.actualModel,
          startedAt,
          finishedAt,
          factSheetPath: factSheetRelative,
          baseline: baselineRes,
        },
      });
    }
  }
  return failure;
}

export function prepareStampedBrief(ctx, req) {
  const { coordinator, inject, missionId } = ctx;
  // Deterministic inner-brief signature (decisions 1-3): before every
  // run_chain / rework_chain the driver owns the metadata — it strips
  // any `Orchestrator:` line in the first five lines of the inner
  // brief and prepends exactly one canonical line 1.  The canonical
  // values are resolved here, never computed by the stamper: model =
  // the ACTUAL coordinator seat (the persisted record's on resume,
  // never the requested/default spelling), session = this mission id,
  // date = the UTC YYYY-MM-DD of THIS dispatch (inject.now when
  // provided, the current clock by default).  The stamped text is
  // what the seam receives and what the parsed `orchestrator`
  // attribution is read back from.
  const stampModel = ctx.record?.coordinator?.actual ?? coordinator.actual;
  const stampNow =
    typeof inject.now === "function" ? inject.now() : new Date();
  const stampDate = new Date(stampNow).toISOString().slice(0, 10);
  return stampInnerBriefSignature(req.brief ?? "", {
    model: stampModel,
    session: missionId,
    date: stampDate,
  });
}

export function dispatchInnerChain(ctx, stampedBrief, chainId) {
  const { cwd, container, missionId, runChainLifecycle } = ctx;
  return runChainLifecycle(
    cwd,
    {
      // The inner chain is linked to the mission (kusabi #532
      // criterion 11): missionId is emitted on chain.json only in
      // Luna mode — plain chains never carry the key.
      flags: { container, "chain-id": chainId, keepServe: true, missionId },
      // Decision 3: the seam receives the STAMPED brief (canonical
      // line 1, never the raw Luna-authored text) and the parsed
      // canonical signature as a non-null `orchestrator`
      // attribution, so inner-chain attribution matches the
      // stamped brief exactly.
      text: stampedBrief,
      orchestrator: parseOrchestratorSignature(stampedBrief),
    },
    {},
  );
}

export function recordEscalation(ctx, req) {
  recordHostIntervention(ctx,
    `escalate_to_host: ${req.reason ?? "host judgement required"}`,
  );
}

export function executeReadProbe(ctx, req, probeArgsFor) {
  const { callTool, container } = ctx;
  return callTool(req.tool, probeArgsFor(req.tool, container, req));
}

export function completeConsult(ctx, req) {
  recordConsult(ctx, req);
}

export function finishRefusal(req, vocabulary) {
  if (!vocabulary.has(req.recommendation)) {
    return `finish refused: recommendation "${req.recommendation}" is outside the closed vocabulary`;
  }
  return null;
}
