// task-cmd: the `task` and `review` single-shot command surfaces (kusabi #437).
//
// Extracted from kusabi-companion.mjs: the single-shot phase dispatch
// commands (cmdTask, cmdReview) and their review input builders (buildReviewInput,
// buildTaskReviewInput).
//
// IMPORT DIRECTION. This module imports from kusabi-companion.mjs (readBriefFile,
// resolveOrchestratorRecord, loadConfig, resolveDispatchBackend,
// assertSessionBackendCompatible, resolveResumeLastSession, briefLintReport,
// PHASE_AGENTS), and companion imports cmdTask / cmdReview back -- a deliberate
// cycle, same as chain-cmd.mjs and chain-ops.mjs. The cycle is safe because every
// name crossing it is a hoisted function declaration (or constant) and nothing
// here runs at module-evaluation time: companion is evaluated after this module's
// definitions exist.
//
// This module does NOT import chain-driver.mjs or chain-cmd.mjs.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  parseModel,
  reviewDenyTools,
  WRITE_TOOL_NAMES,
  backendSupportsResume,
} from "./cli.mjs";
import { renderReview, renderHeader } from "./render.mjs";
import {
  hasSectionHeading,
  parseDeliverables,
  parseFrozenTests,
  parseSmoke,
} from "./brief-parsing.mjs";
import { stateRoot, stateDirFor } from "./state-paths.mjs";
import { jobDir, saveJob, latestJob, appendEvent } from "./job-store.mjs";
import { runPrompt } from "./prompt-execution.mjs";
import { translateDenyTools } from "./claude-dispatch.mjs";
import { AGY_BACKEND } from "./agy-dispatch.mjs";
import { CURSOR_BACKEND } from "./cursor-dispatch.mjs";
import {
  parseReviewResult,
  buildReviewRepairPrompt,
} from "./chain-review.mjs";
import {
  collectContainerReviewInput,
  withContainerWorkspace,
} from "./chain-phases.mjs";
import {
  runSmokeProbe,
  runHeadCleanProbe,
  runVerifyProbe,
  runDeliverablesProbe,
  runFrozenProbe,
  runCollectedProbe,
} from "./chain-probes.mjs";
import { smokeBaselineReport } from "./chain-brief-guards.mjs";
import {
  readBriefFile,
  resolveOrchestratorRecord,
  loadConfig,
  resolveDispatchBackend,
  assertSessionBackendCompatible,
  resolveResumeLastSession,
  briefLintReport,
  PHASE_AGENTS,
} from "./kusabi-companion.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const DEFAULT_TASK_TIMEOUT_S = 3600;
const DEFAULT_REVIEW_TIMEOUT_S = 1800;
const DEFAULT_WATCHDOG_S = 900; // must be > opencode mcp_timeout (600s) so inner timeout trips first
const REVIEW_DIFF_LIMIT = 200_000;

/**
 * INTERNAL — exported for regression testing only.
 * Verifies that the probe functions are locally bound in this module,
 * so cmdTask can call them without ReferenceError.
 */
export function __testProbeBindings() {
  return {
    runSmokeProbe: typeof runSmokeProbe,
    runHeadCleanProbe: typeof runHeadCleanProbe,
    runVerifyProbe: typeof runVerifyProbe,
    runDeliverablesProbe: typeof runDeliverablesProbe,
    runFrozenProbe: typeof runFrozenProbe,
    runCollectedProbe: typeof runCollectedProbe,
  };
}

function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;
  }
}

// Standalone `review` reads the HOST worktree via git.  A git failure used to
// be swallowed into an error string that then went into the review prompt —
// the model answered garbage, and the crash the user actually saw was
// "findings.forEach is not a function" downstream (kusabi #153).  Fail loud
// and early instead: a review of a diff that could not be produced is not a
// review, and the error must name the real cause, not an internal TypeError.
const HOST_REVIEW_GIT_HINT =
  "review reads the host worktree; for a container review use: task --phase review --container <cid> --brief-file <path>";

function buildReviewInput(cwd, base) {
  let label;
  let diff;
  if (base) {
    label = `branch diff against ${base}`;
    diff = git(cwd, ["diff", `${base}...HEAD`]);
    if (diff === null) {
      throw new Error(`git diff ${base}...HEAD failed: ${base} is not a valid revision in this worktree (${HOST_REVIEW_GIT_HINT})`);
    }
  } else {
    label = "uncommitted working tree changes";
    const headDiff = git(cwd, ["diff", "HEAD"]);
    const cachedDiff = git(cwd, ["diff", "--cached"]);
    if (headDiff === null || cachedDiff === null) {
      throw new Error(`git diff failed in this worktree (${headDiff === null ? "git diff HEAD" : "git diff --cached"}) (${HOST_REVIEW_GIT_HINT})`);
    }
    diff = headDiff + cachedDiff;
  }
  const status = git(cwd, ["status", "--short", "--untracked-files=all"]);
  if (status === null) {
    throw new Error(`git status failed in this worktree (${HOST_REVIEW_GIT_HINT})`);
  }
  let truncated = "";
  if (diff.length > REVIEW_DIFF_LIMIT) {
    diff = diff.slice(0, REVIEW_DIFF_LIMIT);
    truncated = "\n(diff truncated; use the read tools to inspect files directly)";
  }
  const input = `## git status\n${status}\n## diff (${label})\n${diff}${truncated}`;
  return { label, input };
}

/**
 * The review input `task` inlines into its prompt, and the home of the
 * `--base` decision for that command (kusabi #204).
 *
 * `task --phase review --container <cid>` dispatches the same reviewer the
 * chain does -- but the task path built no review input at all, so the
 * reviewer rebuilt the change by hand (147 tool calls / 876s in one measured
 * job, twice running out of budget before it could review anything).  It now
 * sends the container-flavoured review input the chain sends, from the same
 * renderer.  That input names the base and tells the reviewer to fetch the
 * diff itself; it does not inline the diff body (kusabi #208).
 *
 * `--base` was accepted and silently dropped on this path.  It is now:
 *   - honoured on the container review, where it is the base commit the input
 *     names as the ref to diff against, and
 *   - rejected loudly anywhere else on `task`, following the precedent
 *     `review --container` set in kusabi #153: a flag that cannot take effect
 *     must say so rather than pretend.
 *
 * Everything else about `task` is untouched: another phase, or `review`
 * without `--container`, returns null and the prompt is what it was.
 *
 * @param {object}  opts
 * @param {string|null} opts.phase          The resolved --phase, or null.
 * @param {object}  opts.flags              Parsed CLI flags.
 * @param {Function} [opts.callTool=null]   RPC callTool (injectable; loaded
 *        from sunaba-rpc.mjs on demand so non-container tasks never touch it).
 * @returns {Promise<string|null>} The review input, or null when this dispatch
 *          is not a container review.
 * @throws {Error} on --base outside the container review, an unusable --base,
 *          or a --base that does not resolve inside the container.
 */
export async function buildTaskReviewInput({ phase, flags, callTool = null }) {
  const base = flags.base || null;
  const isContainerReview = phase === "review" && !!flags.container;
  if (base && !isContainerReview) {
    throw new Error(
      "task --base applies only to a container review; it has no effect here. " +
      "Use: task --phase review --container <cid> --base " + base,
    );
  }
  if (!isContainerReview) return null;
  const call = callTool ?? (await import("./sunaba-rpc.mjs")).callTool;
  return collectContainerReviewInput({ container: flags.container, callTool: call, base });
}

export async function cmdTask(cwd, { flags, text }) {
  // ---- brief-file resolution ----
  text = readBriefFile(flags, text);
  if (!text) throw new Error("task requires a task description (inline or via --brief-file)");
  // Signature line for model/date; CLAUDE_CODE_SESSION_ID for the session
  // when this companion runs inside an orchestrator session (kusabi #227).
  const orchestrator = resolveOrchestratorRecord(text);
  let agent = flags.agent;
  let phase = null;
  if (flags.phase) {
    phase = flags.phase;
    if (!PHASE_AGENTS[phase]) {
      throw new Error(`unknown phase: ${phase}. Use draft|investigate|implement|review|respond|salvage|gofer|test-author|plan`);
    }
    if (flags.agent) {
      throw new Error("--phase and --agent are mutually exclusive");
    }
    agent = PHASE_AGENTS[phase];
  }
  const stateDir = stateDirFor(cwd);
  const config = loadConfig(stateRoot());
  // Backend resolved ONCE at command start: it picks the dispatch function
  // AND the model syntax (claude: bare alias / full id; opencode:
  // provider/model).
  // `explicitModel` is the --model value in the SPELLING of the backend the
  // same resolution chose (kusabi #210): `claude/opus` reaches a claude
  // dispatch as `opus`, an opencode route reaches the ladder verbatim.  The
  // raw flag string must never be handed to a dispatch — a claude CLI given
  // `--model claude/opus` would take the prefix for part of the model id.
  const { dispatch, backend, chain: modelChain, explicitModel } = resolveDispatchBackend({ flags, phase, config });

  // An explicitly named `--session` is checked against the backend it would
  // run on BEFORE anything else, so the error the operator gets names both
  // backends rather than the weaker "this backend does not resume".
  if (flags.session) {
    assertSessionBackendCompatible({
      session: flags.session,
      backend,
      owner: latestJob(stateDir, (j) => j.sessionID === flags.session),
    });
  }

  // A backend that cannot continue a session must SAY so when one is asked
  // for; every current backend CAN (kusabi #316 lifted agy's v1
  // fresh-dispatch-only limit), so this guard has no firing row today.  It
  // stays as the table-driven backstop for a backend added later without a
  // resume row: quietly starting a blank run for an operator who typed
  // `--session` / `--resume-last` would hand them a job that looks like a
  // continuation and is not.  agy's extra gate is PROVENANCE, applied here
  // where the job store is in hand (assertSessionBackendCompatible above,
  // and the sessionProvenance signal passed to the dispatch below): a bare
  // UUID is ambiguous between agy and claude, so the agy dispatch resumes
  // only what the store proves an agy job recorded.
  if ((flags.session || flags.resumeLast) && !backendSupportsResume(backend)) {
    const asked = flags.session ? `--session ${flags.session}` : "--resume-last";
    throw new Error(
      `${asked} is not supported on the ${backend} backend — it cannot continue a session: ` +
      `drop ${flags.session ? "--session" : "--resume-last"}, or run the phase on a backend that resumes.`
    );
  }

  let session = flags.session;
  if (!session && flags.resumeLast) {
    // --resume-last selects the previous job of the SAME backend as this
    // dispatch: every backend shares one job store, and a session id is
    // backend-specific (a claude UUID cannot be resumed on opencode; an
    // opencode ses_* id is rejected by the claude backend's guard).  Records
    // without the backend field predate the backend split -> opencode.
    session = resolveResumeLastSession(stateDir, { phase, backend });
    if (!session) {
      throw new Error(phase
        ? `--resume-last: no previous ${phase} ${backend} session found for this directory`
        : `--resume-last: no previous ${backend} task session found for this directory`);
    }
  }
  // The dispatch-level agy backstop resumes a session only on POSITIVE
  // provenance (assertNoAgySession in agy-dispatch.mjs): an agy
  // conversation_id and a claude session id are both bare UUIDs, so the
  // distinguishing evidence is the job store, which is in hand HERE, not in
  // the dispatch.  The owner record of the session names its backend
  // (records without the backend field predate the split -> opencode); no
  // owner means the id's provenance is unknown, and the agy dispatch fails
  // closed rather than passing an unproven id to `--conversation`.  claude
  // and opencode dispatches ignore the signal.
  let sessionProvenance = null;
  if (session) {
    const owner = latestJob(stateDir, (j) => j.sessionID === session);
    sessionProvenance = owner ? (owner.backend ?? "opencode") : null;
  }
  if (session && phase) {
    const owner = latestJob(stateDir, (j) => j.sessionID === session);
    if (owner && owner.phase && owner.phase !== phase) {
      throw new Error(`cross-phase session reuse is forbidden: session belongs to phase '${owner.phase}', requested '${phase}'`);
    }
  }
  let tools = flags.readOnly ? Object.fromEntries(WRITE_TOOL_NAMES.map((t) => [t, false])) : undefined;
  if (flags.deny) {
    tools = { ...(tools ?? {}) };
    for (const name of flags.deny.split(",").filter(Boolean)) tools[name] = false;
  }
  // The user-facing deny map speaks the opencode vocabulary (bash, edit,
  // write, ...); on the claude backend the tools that exist are the sunaba_*
  // ones, so --read-only / --deny must be translated or they would silently
  // no-op while the write tools stay granted (kusabi #184 finding 2).
  // Phase-level deny maps (implementDenyTools / reviewDenyTools) are passed
  // inside the chain phases and are intentionally NOT translated.
  if (tools && backend === "claude") tools = translateDenyTools(tools);
  // The agy CLI takes no allow/deny flags at all (kusabi #199), so there is
  // nothing to translate the map INTO: a restriction the operator typed
  // cannot be applied.  Reject it rather than run unrestricted while the
  // command line says otherwise — the same "never silently no-op a deny"
  // rule as the claude translation above, with the only honest answer this
  // backend can give.  Phase-level maps from the chain are a different case
  // (nobody typed them, and refusing them would break every chain that
  // routes a phase here): agyDispatch records those on the job as
  // `toolDeniesUnenforced` so the record cannot be mistaken for one where
  // they applied.
  if (tools && backend === AGY_BACKEND) {
    throw new Error(
      `${flags.readOnly ? "--read-only" : "--deny"} is not supported on the agy backend — ` +
      "the agy CLI has no per-job tool permission flags, so the restriction cannot be applied. " +
      "Run the task on the opencode or claude backend, which enforce it."
    );
  }
  if (tools && backend === CURSOR_BACKEND) {
    throw new Error(
      `${flags.readOnly ? "--read-only" : "--deny"} is not supported on the cursor backend — ` +
      "the Cursor CLI has no per-job tool permission flags, so the restriction cannot be applied. " +
      "Run the task on the opencode or claude backend, which enforce it."
    );
  }
  // ---- dispatch-time brief lint (kusabi #289) ----
  // A brief missing a machine-read section used to dispatch anyway and the
  // gap surfaced a round later.  Refuse here: the last point before anything
  // outside this process happens — no job record, no container read, no
  // dispatch.  It sits AFTER the command-start config/session guards above on
  // purpose: those describe a broken invocation rather than a broken brief,
  // and their messages are the more specific answer when both are wrong.
  const lintRejection = briefLintReport({ brief: text, phase, container: flags.container ?? null });
  if (lintRejection) throw new Error(lintRejection);

  // ---- record baseSha before dispatching the job if --container (for probe comparison) ----
  let taskBaseSha = null;
  if (flags.container) {
    try {
      const { callTool } = await import("./sunaba-rpc.mjs");
      const gitRev = await callTool("sandbox_exec", {
        container_id: flags.container,
        commands: ["git rev-parse HEAD"],
      });
      taskBaseSha = (gitRev?.output ?? "").trim() || null;
    } catch { /* probe will handle missing baseSha */ }
  }

  // ---- smoke baseline refusal (kusabi #292) ----
  // Same guard as the chain's first round, for the single-shot dispatch: the
  // P4 below runs AFTER the worker has changed things, so a `## Smoke` line
  // that could not pass on the checkout as handed over would be reported as
  // the worker's failure.  Measured here with the probe's own executor, and
  // refused before any job record exists.  A task with no declared smoke (or
  // no --container to run it in) executes nothing extra and dispatches
  // exactly as before.
  if (flags.container) {
    const { callTool } = await import("./sunaba-rpc.mjs");
    const baselineRejection = await smokeBaselineReport({
      brief: text,
      callTool,
      container: flags.container,
    });
    if (baselineRejection) throw new Error(baselineRejection);
  }

  // ---- review input (container review only) ----
  // Runs before dispatch: a container review must carry the diff into the
  // prompt, and a --base that cannot be honoured must abort before a job is
  // created rather than after (kusabi #204).
  const taskReviewInput = await buildTaskReviewInput({ phase, flags });

  const guardrails = fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", "task-guardrails.md"), "utf8").trim();
  let taskPromptText = taskReviewInput
    ? `${guardrails}\n\n<task>\n${text}\n</task>\n\n${taskReviewInput}`
    : `${guardrails}\n\n<task>\n${text}\n</task>`;
  // kusabi #289: `--container` was recorded on the job and used for the
  // probes, but never DELIVERED to the worker — the chain injects it into the
  // implement prompt, the task path did not.  Same helper, so the wording
  // cannot drift and a brief that also names its workplace is a harmless
  // duplicate; a no-op when `--container` was not given.
  taskPromptText = withContainerWorkspace(taskPromptText, flags.container);
  const { job, resultText } = await dispatch({
    cwd,
    kind: "task",
    title: text.slice(0, 80),
    promptText: taskPromptText,
    agent,
    phase,
    session,
    sessionProvenance,
    tools,
    timeoutS: Number(flags.timeout ?? DEFAULT_TASK_TIMEOUT_S),
    watchdogS: Number(flags.watchdog ?? DEFAULT_WATCHDOG_S),
    tiers: modelChain,
    round: 1,
    explicitModel,
  });

  // Store the resolved model chain, orchestrator, and backend on the job
  // record (claudeDispatch already stamps backend:"claude"; this makes the
  // opencode path record it too).
  job.modelChain = modelChain;
  job.orchestrator = orchestrator;
  job.backend = backend;

  // ---- deterministic probes (when --container given) ----
  if (flags.container) {
    try {
      const { callTool } = await import("./sunaba-rpc.mjs");
      const container = flags.container;
      const probeResults = [];

      const p1Result = await runHeadCleanProbe({ baseSha: taskBaseSha, callTool, container, sourceLabel: "task" });
      probeResults.push(p1Result);

      const p2Result = await runVerifyProbe({ callTool, container });
      probeResults.push(p2Result);

      const p3Result = await runDeliverablesProbe({
        deliverables: parseDeliverables(text),
        headingPresent: hasSectionHeading(text, "Deliverables"),
        callTool,
        container,
      });
      probeResults.push(p3Result);

      // P4: smoke probe
      const smokeEntries = parseSmoke(text);
      const smokeHeadingPresent = hasSectionHeading(text, "Smoke");
      const p4Result = await runSmokeProbe({
        entries: smokeEntries,
        callTool,
        container,
        headingPresent: smokeHeadingPresent,
      });
      probeResults.push(p4Result);

      // P5: frozen (kusabi #197).  The probes are shared with the chain, so a
      // single `task --container` gets the oracle for free — on this path the
      // change set is the full `git status --porcelain` one (no worktree
      // baseline is captured for a standalone task).
      const p5Result = runFrozenProbe({
        frozen: parseFrozenTests(text),
        headingPresent: hasSectionHeading(text, "Frozen Tests"),
        changedPaths: p3Result.newlyChangedPaths ?? p3Result.changedPaths,
      });
      probeResults.push(p5Result);

      // P6: collected (kusabi #197).  A standalone task has no chain-start
      // verify baseline, so there is nothing to compare against; the probe
      // passes and says so rather than staying silent.
      const p6Result = runCollectedProbe({
        collected: p2Result.collected ?? null,
        baselineCollected: null,
      });
      probeResults.push(p6Result);

      job.probeResults = probeResults;
      job.probesGreen = probeResults.every(function (p) { return p.passed; });
    } catch (probeErr) {
      job.probeResults = [{ probe: "task probes", passed: false, detail: String(probeErr) }];
      job.probesGreen = false;
    }
  }
  saveJob(stateDir, job);

  let taskOutput;
  if (job.status !== "completed") {
    taskOutput = `${renderHeader(job)}${job.error ?? ""}\nRun kusabi-companion status ${job.id} for details.`;
  } else {
    taskOutput = `${renderHeader(job)}${resultText || "(empty result)"}`;
  }

  // Append probe summary when --container
  if (job.probeResults && job.probeResults.length > 0) {
    taskOutput += "\n\nProbes:";
    for (const p of job.probeResults) {
      let detail = p.detail || "";
      if (detail.length > 300) detail = detail.slice(0, 300) + "...";
      taskOutput += "\n  " + p.probe + " — " + (p.passed ? "PASS" : "FAIL");
      if (detail) taskOutput += " (" + detail + ")";
    }
  }

  return taskOutput;
}

export async function cmdReview(cwd, { flags, text, _runPrompt = runPrompt } = {}) {
  // kusabi #153: `review --container <cid>` was silently ignored — the review
  // read the HOST worktree's git state, failed on the container-only --base,
  // and then crashed with "findings.forEach is not a function".  The
  // standalone review has no container path; the sanctioned container review
  // route is `task --phase review --container <cid>`.  Reject early and
  // loudly instead of pretending the flag works (silent ignore is forbidden).
  if (flags?.container) {
    throw new Error(
      "review does not support --container (it inspects the host worktree via git). " +
      "For a container review use: task --phase review --container " + flags.container + " --brief-file <path>"
    );
  }
  const promptTemplate = fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", "adversarial-review.md"), "utf8");
  const schema = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json"), "utf8"));
  const { label, input } = buildReviewInput(cwd, flags?.base);
  const promptText = promptTemplate
    .replaceAll("{{TARGET_LABEL}}", label)
    .replaceAll("{{USER_FOCUS}}", text || "(none — general adversarial review)")
    .replaceAll("{{OUTPUT_SCHEMA}}", JSON.stringify(schema))
    .replaceAll("{{REVIEW_INPUT}}", input)
    .replaceAll("{{PRIOR_FINDINGS}}", flags?.prior || "(none — first review round)")
    // kusabi #236: the standalone review route never runs the chain probes,
    // so {{PROBE_REPORT}} renders the explicit absence marker rather than
    // leaking the raw placeholder into the prompt.
    .replaceAll("{{PROBE_REPORT}}", "(no probe results recorded)");
  const doPrompt = _runPrompt || runPrompt;
  let { job, resultText } = await doPrompt({
    cwd,
    kind: "review",
    title: `review: ${label}`,
    promptText,
    model: parseModel(flags?.model),
    agent: flags?.agent,
    tools: reviewDenyTools(),
    // NOTE: opencode's `format: json_schema` is not used — some providers 400
    // on it, and sessions created with it break GET /session/:id/message in
    // opencode 1.17.x. The schema is embedded in the prompt instead.
    timeoutS: Number(flags?.timeout ?? DEFAULT_REVIEW_TIMEOUT_S),
    watchdogS: Number(flags?.watchdog ?? DEFAULT_WATCHDOG_S),
  });
  if (job.status !== "completed") {
    return `${renderHeader(job)}${job.error ?? ""}\nRun kusabi-companion status ${job.id} for details.`;
  }
  // Same two input formats and strict validation as the chain (kusabi #202, #392):
  // JSONL first, then single JSON object. If validation fails, log schema_invalid event
  // and attempt schema repair (kusabi #395).
  let parsedResult = parseReviewResult(resultText);
  if (parsedResult.schemaErrors && parsedResult.schemaErrors.length > 0) {
    appendEvent(stateDirFor(cwd), job.id, {
      type: "companion.review.schema_invalid",
      errors: parsedResult.schemaErrors,
    });
  }

  // Schema-invalid repair loop (kusabi #395) or unparseable retry
  if (parsedResult.schemaErrors && parsedResult.schemaErrors.length > 0 && job.status === "completed") {
    appendEvent(stateDirFor(cwd), job.id, {
      type: "companion.review.schema_repair",
      attempt: 1,
      errors: parsedResult.schemaErrors,
    });
    const hasSession = Boolean(job.sessionID);
    const repairPromptText = buildReviewRepairPrompt({
      schemaErrors: parsedResult.schemaErrors,
      originalOutput: resultText,
      hasSession,
    });
    const repairResult = await doPrompt({
      cwd,
      kind: "review",
      title: `review: ${label}`,
      promptText: repairPromptText,
      model: parseModel(flags?.model),
      agent: flags?.agent,
      tools: reviewDenyTools(),
      timeoutS: Number(flags?.timeout ?? DEFAULT_REVIEW_TIMEOUT_S),
      watchdogS: Number(flags?.watchdog ?? DEFAULT_WATCHDOG_S),
      ...(hasSession ? { session: job.sessionID } : {}),
    });
    job = repairResult.job;
    resultText = repairResult.resultText;
    if (job.status !== "completed") {
      return `${renderHeader(job)}${job.error ?? ""}\nRun kusabi-companion status ${job.id} for details.`;
    }
    parsedResult = parseReviewResult(resultText);
    if (parsedResult.schemaErrors && parsedResult.schemaErrors.length > 0) {
      appendEvent(stateDirFor(cwd), job.id, {
        type: "companion.review.schema_invalid",
        errors: parsedResult.schemaErrors,
      });
    }
  } else if (!parsedResult.reviewParseable && parsedResult.chainVerdict === "unparseable" && job.status === "completed") {
    const retryResult = await doPrompt({
      cwd,
      kind: "review",
      title: `review: ${label}`,
      promptText,
      model: parseModel(flags?.model),
      agent: flags?.agent,
      tools: reviewDenyTools(),
      timeoutS: Number(flags?.timeout ?? DEFAULT_REVIEW_TIMEOUT_S),
      watchdogS: Number(flags?.watchdog ?? DEFAULT_WATCHDOG_S),
    });
    job = retryResult.job;
    resultText = retryResult.resultText;
    if (job.status !== "completed") {
      return `${renderHeader(job)}${job.error ?? ""}\nRun kusabi-companion status ${job.id} for details.`;
    }
    parsedResult = parseReviewResult(resultText);
    if (parsedResult.schemaErrors && parsedResult.schemaErrors.length > 0) {
      appendEvent(stateDirFor(cwd), job.id, {
        type: "companion.review.schema_invalid",
        errors: parsedResult.schemaErrors,
      });
    }
  }

  const rendered = renderReview(parsedResult.chainParsedReview, resultText);
  fs.writeFileSync(path.join(jobDir(stateDirFor(cwd), job.id), "result.md"), rendered, "utf8");
  return `${renderHeader(job)}${rendered}`;
}
