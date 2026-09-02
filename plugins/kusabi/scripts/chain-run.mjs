// chain-run.mjs — Implement dispatch and probe orchestration for the chain.
//
// Extracted from chain-phases.mjs (kusabi #447).
//
// Leaf module for running an implement round and probe orchestration:
// owns prompt assembly (withContainerWorkspace / buildImplementText),
// the implement dispatch (runImplementPhase), and the P1–P6 deterministic
// probe orchestration (runProbePhase).
//
// Does not import kusabi-companion.mjs, chain-driver.mjs, chain-finish.mjs,
// or chain-cmd.mjs.

import {
  implementDenyTools,
  backendSupportsResume,
} from "./cli.mjs";
import {
  renderPriorFindings,
} from "./render.mjs";
import {
  hasSectionHeading,
  parseDeliverables,
  parseFrozenTests,
  parseSmoke,
} from "./brief-parsing.mjs";
import {
  parseRefusalBlock,
} from "./probe-decisions.mjs";
import { dispatchWithFallback } from "./prompt-execution.mjs";
import { deriveStopReason } from "./stop-reason.mjs";
import {
  runHeadCleanProbe,
  runVerifyProbe,
  runDeliverablesProbe,
  runSmokeProbe,
  runFrozenProbe,
  runCollectedProbe,
  summariseOracleViolations,
} from "./chain-probes.mjs";
import {
  collectChangeScope,
  collectContainerBaseContext,
  classifyDispatchQuotaExhaustion,
} from "./chain-phases.mjs";

/**
 * Prepend the workspace header naming the exact container ID, or return the
 * text unchanged when there is no container.
 *
 * Extracted from buildImplementText (kusabi #289) because the single-shot
 * `task --container <cid>` path needs the SAME sentence: the chain injected
 * the id into its implement prompt while `task` only recorded it on the job,
 * so a worker dispatched by `task --phase implement --container <cid>` with a
 * brief that carried no `## Workplace` section had nothing to read the id out
 * of — one such job guessed ten `sandbox_attach` names, all failed, and
 * finished 171s with zero edits.  One function, one wording: a brief that
 * also names its workplace is then a harmless duplicate, and a stale id in a
 * brief loses to the fresh `--container` value stated first.
 *
 * @param {string} text                     The prompt text to prefix.
 * @param {string|null|undefined} container  The container ID, if any.
 * @returns {string}
 */
export function withContainerWorkspace(text, container) {
  if (!container) return text;
  return "The workspace lives inside container `" + container + "`. Pass this exact ID as `container_id` to every sunaba tool call. Do not guess container names or call sandbox_attach.\n\n" + text;
}

/**
 * Build the implement prompt text for a chain round.
 *
 * When `container` is given, a header naming the exact container ID is
 * prepended to the returned text for every round (mirroring the review-prompt
 * injection). Without `container` the output is byte-for-byte what this
 * function produced before.
 *
 * `reworkScope` (kusabi #60 step 2) is the resolved scope for this round — the
 * result of `resolveReworkScope(previousRecord)` — decided by the caller so
 * the round loop's budget accounting and the prompt text can never disagree.
 * When absent, or when its `scope` is \"full\", the output is byte-identical to
 * the pre-scheduling text.  For a scoped round the prior-findings block is
 * replaced by the scope sentence + the FULL per-finding rendering of the
 * scoped subset (`renderPriorFindings` over a record-shaped subset — bodies,
 * recommendations and the same budget bound as the full-scope path), keeping
 * the rest of the prompt structure (instruction / strategist / acceptance
 * criteria) unchanged.
 */
export function buildImplementText({ round, brief, previousRecord, container, reworkScope }) {
  let text;
  if (round === 1) {
    text = brief;
  } else if (previousRecord) {
    let strategistSection = "";
    if (previousRecord.strategistRecommendation) {
      strategistSection = "\n\n## Strategist recommendation (structural change for this rework)\n" + previousRecord.strategistRecommendation + "\n";
    }
    const scope = reworkScope || { scope: "full", findings: [] };
    let priorFindingsText;
    if (scope.scope === "full") {
      // Byte-identical to the pre-scheduling text (kusabi #60 step 2).
      priorFindingsText = renderPriorFindings(previousRecord);
    } else {
      const scopeSentence = scope.scope === "mechanical"
        ? "This round resolves ONLY the following mechanical checklist; other known findings are deliberately out of scope this round."
        : "This round resolves ONLY the following design finding; other known findings are deliberately out of scope this round.";
      // Followup: a scoped round renders its subset with the FULL per-finding
      // renderer (bodies + recommendations, same budget bound as the full
      // path) - a scoped round must give its finding the same deliberate
      // treatment the full path gives the whole set, not a one-line summary.
      priorFindingsText = scopeSentence + "\n\n" + renderPriorFindings({ findings: scope.findings });
    }
    text = "## Prior findings\n" + priorFindingsText + "\n\n## Instruction\nResolve each prior finding in this round. If a finding cannot be fully resolved, you must explain why and report what remains." + strategistSection + "\n\n## Acceptance criteria\n" + brief;
  } else {
    text = brief;
  }
  return withContainerWorkspace(text, container);
}

/**
 * Run the implement phase: dispatch the implement job via dispatchWithFallback
 * and return the initial round record with implement-related fields.
 *
 * The returned roundRecord is a partial record; subsequent phases add more
 * fields (probes, review, disposition).
 */
export async function runImplementPhase({
  cwd, chainId, round, isFirstRound, implementText, modelChain, tierIndex,
  useNewSession, session, sessionProvenance, previousRecord, resumeMethod, flagsModel,
  backend = "opencode",
  _dispatchWithFallback: _dispatch = dispatchWithFallback,
}) {
  // Session lineage guard (kusabi #199 shape, #316 resume): a session is
  // carried into a backend only when the backend can resume one AND the
  // session's provenance is established.  For agy both halves matter: the
  // dispatch itself refuses a bare UUID without the caller's provenance
  // signal (assertNoAgySession), so a chain that forwarded an unproven
  // session would throw at dispatch instead of running — this seam must
  // either prove the session (from the previous round's record, below) or
  // pass through the caller's proof (chain-resume's initialSession
  // provenance, established at command start where the job store is in
  // hand).  claude and opencode ignore the signal; the forwarding is
  // byte-identical for them.
  let resolvedSession = backendSupportsResume(backend) ? session : undefined;
  let resolvedSessionProvenance = null;
  if (resolvedSession) {
    // The injected session (chain-resume's `initialSession` / the driver's
    // cross-round carry) is proven when the caller says so; when it IS the
    // previous round's session, the record itself is the proof.
    resolvedSessionProvenance =
      previousRecord && previousRecord.sessionID === resolvedSession
        ? (previousRecord.backend ?? "opencode")
        : (sessionProvenance ?? null);
  }
  if (!resolvedSession && !isFirstRound && previousRecord?.sessionID && backendSupportsResume(backend)) {
    // Session lineage guard, part 2 (kusabi #192 invariant 5): a rework
    // implement round may only continue a session created by the implement
    // backend; a session attributable to a record of the OTHER backend is
    // dropped and the round starts fresh.  Records without a `backend` field
    // predate the backend split and count as \"opencode\" (readers' convention).
    if (!useNewSession && (previousRecord.backend ?? "opencode") === backend) {
      resolvedSession = previousRecord.sessionID;
      resolvedSessionProvenance = previousRecord.backend ?? "opencode";
    }
  }

  const { job, resultText } = await _dispatch({
    cwd,
    kind: "task",
    title: "chain: " + chainId + " round " + round + " implement",
    promptText: implementText,
    agent: "kusabi-implement",
    phase: "implement",
    session: useNewSession ? undefined : resolvedSession,
    sessionProvenance: useNewSession ? undefined : resolvedSessionProvenance,
    tools: implementDenyTools(),
    timeoutS: 3600,
    watchdogS: 900,
    tiers: modelChain,
    tierIndex, // decoupled from round counter (B1)
    round,
    explicitModel: isFirstRound ? flagsModel : null,
  });

  // The report text is read for exactly one thing (kusabi #293): the
  // structured refusal block a worker writes when it stops without editing
  // because the brief contradicts itself.  Only the PARSED descriptor leaves
  // this function -- the report itself can carry a whole git diff, and the
  // round record must not grow one.  Gated on `completed` for the same reason
  // the review retry is: a failed job's text is empty or garbage, and a
  // refusal must never be inferred from a job that died.
  //
  // The descriptor is stamped onto the round record AT PARSE TIME because the
  // driver has a designed interruption point between this phase and
  // finishRound (the stop-check after the probes, kusabi #153①): the
  // partial round is persisted as-is at that stop, and the review-resume path
  // must route the refusal that round carried -- without the stamp, a resumed
  // refusal round would classify as a worker discard.  Stamped here, the
  // record is the single source of truth for both the fresh path (which
  // passes the same descriptor to finishRound) and the resume path (which
  // reads it back); no second measurement exists.
  const implementRefusal = job.status === "completed" ? parseRefusalBlock(resultText) : null;

  // ---- report the session this round's dispatch used or created ----
  // The returned session is the next round's carry, and the invariant is
  // that it is one round N's dispatch USED or CREATED -- observed beats
  // told.  The job records the id the dispatch actually got back
  // (`job.sessionID`); whenever that exists we report it, whether the round
  // resumed or ran fresh.  The candidate this round was TOLD to resume
  // (`resolvedSession`, from the carry or the previous-record fallback) is
  // reported ONLY as a dead-round fallback: a resuming round whose job died
  // before any id was observed -- the next round then still has a
  // conversation worth trying.  A fresh round with a null `job.sessionID`
  // reports null exactly as before.
  //
  // Why observed beats told (kusabi #324): measured 2026-08-21, a real agy
  // record (chain-msxhipgq1cef round 2, continue_session) was passed the
  // candidate `a784b853-…` yet the job stamped `2a177486-…` -- agy can mint
  // a NEW conversation id on resume (its `job.sessionID` is stamped from the
  // stream init event's `conversation_id`, agy-dispatch.mjs), so the
  // candidate and the observed id CAN diverge.  opencode held 16/16 same-
  // backend `continue_session` rounds and a claude n=1 probe held the id, so
  // this is real divergence, not a constant rewrite.  Reporting the candidate
  // there would be the old kusabi #320 defect's mirror: round N+1 would
  // resume a conversation round N's dispatch never used.  Fresh-round
  // behaviour is unchanged (kusabi #320/#323 semantics intact).
  //
  // Provenance follows the session: the owner of an observed id is the
  // backend this round dispatched on (it created or re-bound the
  // conversation); the owner of the fallback candidate is
  // `resolvedSessionProvenance` (the previous record or the caller's proof);
  // null when nothing is reported.
  //
  // Failure path: the dead-round fallback above is the resuming case.  A
  // fresh round whose job died before any session id was observed
  // (dispatchWithFallback's no-route error job, a backend job that never
  // returned an id) leaves `job.sessionID` null with no candidate to fall
  // back to: the carry is null and the next round starts fresh -- a dead
  // fresh round resumes nothing, by construction.
  const isResumingRound = !useNewSession && !!resolvedSession;
  const reportedSession = job.sessionID ?? (isResumingRound ? resolvedSession : null);
  const reportedProvenance = job.sessionID ? backend : (isResumingRound ? resolvedSessionProvenance : null);

  return {
    roundRecord: {
      round,
      resumeMethod,
      startedAt: new Date().toISOString(),
      verdict: null,
      probesGreen: false,
      modelEntry: job.modelEntry || null,
      modelVariant: job.modelVariant || null,
      fallbacks: job.fallbacks || null,
      implementJobId: job.id,
      sessionID: job.sessionID,
      implementUsage: job.usage || null,
      // Failure TEXT on the round record (kusabi #373): a job that ended in
      // status error must be distinguishable without opening job.json.  Written
      // only when present so a healthy round's record is unchanged.
      ...(job.error ? { implementJobError: job.error } : {}),
      // The parsed refusal descriptor, stamped at parse time (see above);
      // null when the report carried no block -- the ordinary case.  The
      // caller still decides what it means: whether a refusal is genuine
      // depends on the change set, which this phase has not measured yet.
      implementRefusal,
      // Closed terminal reason (kusabi #380): at this point the implement job
      // is folded into the round record but the chain layer has not yet
      // measured substance (worktreeChanged is unmeasured here, so a
      // completed job records \"completed\").  finishRound re-derives this with
      // the measured substance signal so empty rounds land as infra-death /
      // empty-completion.
      stopReason: deriveStopReason({
        status: job.status,
        stats: job.stats,
        worktreeChanged: null,
      }),
    },
    implementJobStatus: job.status,
    implementJobSteps: (job.stats && typeof job.stats.steps === "number") ? job.stats.steps : 0,
    implementJobError: job.error || null,
    // Structured terminal-failure classification (kusabi #215): null for
    // generic failures; { kind: \"quota-exhaustion\", ... } when the dispatch
    // classified the terminal payload.  The chain's provider-exhaustion
    // renderer uses it to show the classification instead of the generic
    // capacity advice.
    implementJobFailure: job.failure || classifyDispatchQuotaExhaustion(job.error) || null,
    // The parsed refusal block (kusabi #293), or null when the report carried
    // none -- the ordinary case.  The caller decides what it means; whether a
    // refusal is genuine depends on the change set, which this phase has not
    // measured yet.
    implementRefusal,
    session: reportedSession,
    sessionProvenance: reportedProvenance,
  };
}

/**
 * Run deterministic probes P1–P6 via sunaba-rpc.
 *
 * Returns probe results and side data needed by the review phase, plus
 * `oracleViolation` — the P5/P6 marker that routes the round to `escalate`
 * (kusabi #197).  It is `false` when no oracle probe was violated, and a
 * string naming every violation when one was.
 */
export async function runProbePhase({ baseSha, container, brief, callTool, worktreeBaseline, verifyBaseline }) {
  const chainDeliverables = parseDeliverables(brief);
  let probesGreen = false;
  const probeResults = [];
  let chainChangedPaths = [];
  let chainNewlyChanged = [];
  let worktreeChanged = null;
  let chainStatusObserved = false;
  let chainStatusOutput = "";
  let chainStatusTruncation = null;
  let changeScope = null;

  try {
    if (baseSha) {
      changeScope = await collectChangeScope({
        callTool,
        container,
        base: baseSha,
        head: "HEAD",
      });
    }

    const p1Result = await runHeadCleanProbe({ baseSha, callTool, container, sourceLabel: "chain" });
    probeResults.push(p1Result);

    const p2Result = await runVerifyProbe({ callTool, container, baseline: verifyBaseline });
    probeResults.push(p2Result);

    const p3Result = await runDeliverablesProbe({
      deliverables: chainDeliverables,
      headingPresent: hasSectionHeading(brief, "Deliverables"),
      callTool,
      container,
      baseline: worktreeBaseline,
    });
    chainChangedPaths = p3Result.changedPaths;
    // `newlyChangedPaths` is null when the comparison could not be made — the
    // chain-start baseline is missing, or this round's capture failed.  Either
    // way the answer is \"unknown\", and unknown must not be read as \"nothing
    // changed\": that would discard a round because the measurement broke.  Fall
    // back to the full changed set, which is what the probe used before
    // baselines existed.
    chainNewlyChanged = p3Result.newlyChangedPaths ?? chainChangedPaths;
    worktreeChanged = p3Result.worktreeChanged;
    chainStatusOutput = p3Result.statusOutput;
    chainStatusTruncation = p3Result.statusTruncation ?? null;
    chainStatusObserved = true;
    probeResults.push(p3Result);

    const chainSmokeEntries = parseSmoke(brief);
    const chainSmokeHeadingPresent = hasSectionHeading(brief, "Smoke");
    const p4Result = await runSmokeProbe({
      entries: chainSmokeEntries,
      callTool,
      container,
      headingPresent: chainSmokeHeadingPresent,
    });
    probeResults.push(p4Result);

    // ---- P5: frozen (kusabi #197) ----
    // Reuses the round's newly-changed set exactly as computed above,
    // fallback rule included: there is one change-collection mechanism in the
    // chain and this is not a second one.
    const p5Result = runFrozenProbe({
      frozen: parseFrozenTests(brief),
      headingPresent: hasSectionHeading(brief, "Frozen Tests"),
      changedPaths: chainNewlyChanged,
    });
    probeResults.push(p5Result);

    // ---- P6: collected (kusabi #197) ----
    // Reads P2's count.  No second verify_in_container call is issued: the
    // round already paid for that run.
    const p6Result = runCollectedProbe({
      collected: p2Result.collected ?? null,
      baselineCollected: verifyBaseline?.captured === true
        ? (verifyBaseline.collected ?? null)
        : null,
    });
    probeResults.push(p6Result);

    probesGreen = probeResults.every(function (p) { return p.passed; });
  } catch (probeErr) {
    probeResults.push({ probe: "sunaba-rpc", passed: false, detail: String(probeErr) });
    probesGreen = false;
  }

  // Base log + untracked for review context (read-only; failures yield
  // empty strings, never errors).
  const baseCtx = await collectContainerBaseContext(callTool, container);

  return {
    probesGreen, probeResults, chainChangedPaths, chainNewlyChanged,
    chainStatusObserved, chainStatusOutput,
    chainBaseLog: baseCtx.chainBaseLog, chainDeliverables,
    chainUntracked: baseCtx.chainUntracked,
    chainTruncation: { ...baseCtx.chainTruncation, status: chainStatusTruncation },
    worktreeChanged,
    // A probe-phase exception is not an oracle violation: it means the round
    // could not be measured, which probesGreen=false already routes.  Only a
    // P5/P6 result that actually fired sets this.
    oracleViolation: summariseOracleViolations(probeResults),
    changeScope,
  };
}
