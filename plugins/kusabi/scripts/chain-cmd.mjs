// chain-cmd: the `chain` and `chain-resume` command surfaces (kusabi #422).
//
// Extracted from chain-driver.mjs (Job 2): the two CLI entry points and
// their banner / session-provenance / quota-reroute helpers that exist only
// to serve them.  This module is NOT a leaf: it imports from both
// kusabi-companion.mjs and chain-driver.mjs, forming the companion cycle
// that the driver header used to document.
//
// IMPORT DIRECTION.  This module imports from kusabi-companion.mjs, and the
// companion imports cmdChain / cmdChainResume / sessionProvenanceRefusal
// back -- a deliberate cycle, not an oversight.  The helpers crossing it
// (readBriefFile, resolveOrchestratorRecord, loadConfig, resolveDispatchBackend,
// liveRunningJobs, cmdServeStop) are used by the companion's own non-chain
// commands as well, and the two alternatives -- duplicating them, or leaving
// a compatibility re-export behind -- are both forbidden by kusabi #264.
// The cycle is safe because every name crossing it is a hoisted function
// declaration and nothing here runs at module-evaluation time: the companion
// is the process entry point, so it is evaluated last, after this module's
// definitions exist.
//
// This module also imports from chain-driver.mjs (effectiveTierCount,
// runChainDriver, resolveResumeReviewContext, resolveResumeReworkContext,
// resolveResumeDispatches).  chain-driver.mjs does NOT import from this
// module -- the import is one-directional: cmd -> driver.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { stateRoot, stateDirFor, readJson } from "./state-paths.mjs";
import { latestJob, listJobs } from "./job-store.mjs";
import { resetFailedRoutes } from "./prompt-execution.mjs";
import {
  createChainDir,
  captureBaseSha,
  captureVerifyBaseline,
  resolveChainResume,
  recordQuotaExhaustion,
  explicitRouteDiffersFromRecord,
} from "./chain-phases.mjs";
import { captureWorktreeState } from "./worktree-baseline.mjs";
import {
  readChainControl,
  writeChainControl,
  createChainControl,
  rearmChainControl,
  chainIdForJob,
} from "./chain-control.mjs";
import { resolveModelBackend, BUILTIN_DEFAULT_CHAIN } from "./cli.mjs";
import { CLAUDE_DEFAULT_CHAIN } from "./claude-dispatch.mjs";
import { AGY_DEFAULT_CHAIN } from "./agy-dispatch.mjs";
import { CURSOR_DEFAULT_CHAIN, DEFAULT_CURSOR_MODEL } from "./cursor-dispatch.mjs";

// The companion side of the cycle documented above.
import {
  readBriefFile,
  briefLintReport,
  resolveOrchestratorRecord,
  loadConfig,
  resolveDispatchBackend,
  backendDispatch,
  phaseDispatchFor,
  BACKENDS,
} from "./kusabi-companion.mjs";

import {
  publishWarningForBrief,
  smokeViolationReport,
  smokeBaselineReport,
} from "./chain-brief-guards.mjs";

// From chain-driver.mjs (one-directional: cmd -> driver).
import {
  effectiveTierCount,
  runChainDriver,
  resolveResumeReviewContext,
  resolveResumeReworkContext,
  resolveResumeDispatches,
} from "./chain-driver.mjs";

// The chain-start banner line (B7).  Returns null when there is no ladder to
// describe (no implement chain); the caller skips the write.  The
// can-reach-top claim is computed against the chain the ladder ACTUALLY
// climbs: the REWORK chain's effective tier count when a models.phases.rework
// key is configured, the implement chain's otherwise (kusabi #192 axis 2).
export function renderChainBanner({ chainId, tierCount, reworkTierCount, reworkKeyConfigured, maxRounds }) {
  if (tierCount <= 0) return null;
  const ladderTierCount = reworkKeyConfigured ? reworkTierCount : tierCount;
  // The ladder can climb to tier (ladderTierCount - 1). With the default
  // ladder, the 1st rework uses tier 0 (same), 2nd uses tier 1 (+1), 3rd
  // uses tier 2 (+1).  The top tier is reached at round:
  // 1 (initial) + (ladderTierCount) reworks.
  const roundsToTopTier = 1 + ladderTierCount; // initial + one rework per tier beyond 0
  const canReachTop = maxRounds >= roundsToTopTier;
  return "Chain " + chainId + ": tiers=" + tierCount +
    (reworkKeyConfigured ? ", reworkTiers=" + reworkTierCount : "") +
    ", maxRounds=" + maxRounds +
    (canReachTop ? " (can reach top tier)" : " (maxRounds insufficient to reach top tier)") +
    "\n";
}


/**
 * The chain-start refusal for a `--session` whose provenance cannot be
 * established on the agy backend (kusabi #321), or null when the chain may
 * proceed.
 *
 * A REFUSAL, not a note, and a property-shaped gate, not a flag-shaped one:
 * it fires on "this id's provenance is not provably agy", never on "the
 * operator typed --session".  The provenance is computed at command start,
 * where the job store is in hand: the owner record of the session names its
 * backend, and no owner means the id's provenance is unknown.  Without this
 * gate an unprovable id sailed through the whole of setup — chain
 * directory, verify baseline, smoke baseline, container work — and only
 * then failed inside agyDispatch, leaving a chain record that cannot be
 * resumed: the expensive half ran first, and the thing it was waiting to
 * discover was knowable before any of it started.
 *
 * The property shape needs no flag-shaped branch: an id the caller
 * resolved FROM the job store arrives with its owner record and is
 * provable by construction, so the gate never fires on it — no special case
 * and no exemption exist.  An id whose owner record names a DIFFERENT
 * backend is the same class of problem as an id with no owner at all: it is
 * the operator's input, it is knowable now, and running the chain cannot
 * make it correct — both refuse here.  The module-level backstop in
 * agy-dispatch.mjs (assertNoAgySession) stays exactly as it is; this is the
 * early, friendly refusal in front of it, not a replacement.
 *
 * @param {object} opts
 * @param {string|null|undefined} [opts.session] — the --session flag value.
 * @param {"opencode"|"claude"|"agy"|null|undefined} [opts.provenance] — the
 *        backend the job store established as the session's owner, or null
 *        when no owner record exists.
 * @param {"opencode"|"claude"|"agy"} opts.implementBackend — the resolved
 *        implement backend of the chain about to start.
 * @returns {string|null}
 */
export function sessionProvenanceRefusal({ session, provenance, implementBackend }) {
  if (!session) return null;
  if (implementBackend !== "agy") return null;
  if (provenance === "agy") return null;
  if (!provenance) {
    return (
      "dispatch refused: --session " + session + " — no owner record for it exists in the job store, so its " +
      "provenance cannot be established (kusabi #321). An agy conversation_id and a claude session id are " +
      "both bare UUIDs, so an agy chain passes an id to `--conversation` only when an agy job recorded it. " +
      "Nothing was started: no chain state, no job and no round state exist. " +
      "Drop --session, or pass an id that a recorded job on this directory used."
    );
  }
  return (
    "dispatch refused: --session " + session + " belongs to the " + provenance + " backend, but this chain's " +
    "implement phase resolves to the agy backend (kusabi #321). A session id is backend-specific, and the " +
    "agy dispatch would resume it only on positive provenance. Nothing was started: no chain state, no job " +
    "and no round state exist. Run the chain on the " + provenance + " backend, or drop --session."
  );
}

export async function cmdChain(cwd, { flags, text }) {
  // ---- brief-file resolution ----
  text = readBriefFile(flags, text);
  if (!text) throw new Error("chain requires a brief description (inline or via --brief-file)");
  // Signature line for model/date; CLAUDE_CODE_SESSION_ID for the session
  // when this companion runs inside an orchestrator session (kusabi #227).
  const orchestrator = resolveOrchestratorRecord(text);

  // ---- runtime publish guard (kusabi #153) ----
  // publish is structurally absent from the worker toolset (orchestrator-
  // exclusive network exit).  A brief that demands PUBLISH cannot be
  // executed by the worker — warn the orchestrator in the chain output
  // instead of letting it read "the worker skipped publish" after the fact.
  // One line only; behaviour is unchanged.  Over-detection is acceptable.
  const publishWarning = publishWarningForBrief(text);
  if (publishWarning) {
    process.stdout.write(publishWarning + "\n");
  }

  // ---- lossy-smoke refusal (kusabi #250) ----
  // A smoke command the parser truncates (nested backtick), or a `## Smoke`
  // heading it can read nothing out of, dooms every round of the chain and
  // cannot be repaired by the worker.  Refuse here — the same stage as the
  // :variant rejection below, and before createChainDir, so no chain state
  // and no job exist when this fires.  A brief problem is reported whatever
  // the model config says, hence the check sits ahead of backend resolution.
  const smokeRejection = smokeViolationReport(text);
  if (smokeRejection) throw new Error(smokeRejection);

  // ---- setup ----
  const stateDir = stateDirFor(cwd);
  const config = loadConfig(stateRoot());
  // The agy dispatch resumes a session only on positive provenance
  // (assertNoAgySession in agy-dispatch.mjs), established where the job
  // store is in hand — here, exactly as cmdTask does: the owner record of
  // the session names its backend.  No owner means the id's provenance is
  // unknown and an agy chain fails closed at dispatch rather than passing
  // the id to `--conversation`.  sessionProvenanceRefusal below gates it at
  // command start (kusabi #321), before any setup runs.
  const initialSessionOwner = flags.session
    ? latestJob(stateDir, (j) => j.sessionID === flags.session)
    : null;
  const sessionProvenance = initialSessionOwner
    ? (initialSessionOwner.backend ?? "opencode")
    : null;
  // Backend resolves PER PHASE at command start (kusabi #192): the
  // implement route-chain and the review route-chain resolve independently,
  // each from models.phases.<phase> with fallback to models.chain, then the
  // built-in default.  A `claude/<model>` entry prefix selects the claude
  // backend for that phase; `--backend` forces every phase onto one backend
  // (flag wins).  The strategist follows the implement resolution.  The
  // :variant rejection for the claude backend and the single-backend-per-
  // phase invariant also happen here, so a bad config fails with a clear
  // error and a nonzero exit before createChainDir / before any job is
  // dispatched.
  //
  // Rework rounds (implement rounds after round 1) resolve from
  // models.phases.rework with the exact same machinery (kusabi #192 axis 2):
  // entry prefixes, single-backend invariant, :variant rejection, and the
  // explicit --backend flag forcing it like every other phase.  Key absence
  // must mean "byte-identical to today": rework rounds keep the implement
  // resolution (its chain AND its ladder) \u2014 never models.chain directly.
  const implementDispatch = resolveDispatchBackend({ flags, phase: "implement", config });
  const reworkKeyConfigured = !!config?.models?.phases?.rework;
  const reworkDispatch = reworkKeyConfigured
    ? resolveDispatchBackend({ flags, phase: "rework", config })
    : implementDispatch;
  const reviewDispatch = resolveDispatchBackend({ flags, phase: "review", config });
  // ---- session-provenance refusal (kusabi #321) ----
  // The provenance computed above is the agy dispatch's resume gate, but it
  // was never gated HERE: an id with no owner record (or one owned by a
  // different backend) sailed through the whole of setup — chain directory,
  // verify baseline, smoke baseline, container work — and only then failed
  // inside agyDispatch, leaving a chain record that cannot be resumed.
  // Refuse at the same stage as the #250 / #292 refusals — before
  // createChainDir and before any baseline measurement, so no chain state
  // and no container work exist when this fires.  The gate is on the
  // PROPERTY (an agy implement phase + a session whose provenance is not
  // provably agy), not on the --session flag: an id the caller resolved
  // FROM the job store arrives with its owner record and is provable by
  // construction, so this gate never fires on it.
  const sessionRejection = sessionProvenanceRefusal({
    session: flags.session,
    provenance: sessionProvenance,
    implementBackend: implementDispatch.backend,
  });
  if (sessionRejection) throw new Error(sessionRejection);
  // Both checked BEFORE createChainDir (kusabi #289): a refusal must leave no
  // chain state behind, and the container requirement used to fire one line
  // after the directory it orphaned.  The message is unchanged, and it stays
  // ahead of the lint so `chain` without --container keeps naming the flag
  // rather than reporting a missing container SOURCE.
  const container = flags.container;
  if (!container) throw new Error("chain requires --container <cid>");

  // ---- dispatch-time brief lint (kusabi #289) ----
  // A chain being started is an implement dispatch, so it carries the
  // implement requirements: `## Deliverables` (the probe reads it every
  // round) and the signature line.  Same stage as the smoke refusal above and
  // as the :variant rejection: nothing has been created yet.
  const lintRejection = briefLintReport({ brief: text, container, chain: true });
  if (lintRejection) throw new Error(lintRejection);

  // ---- import callTool once for every phase that needs it ----
  // Hoisted above createChainDir for the baseline smoke run below: that run
  // has to happen while a refusal can still leave nothing behind.
  const { callTool } = await import("./sunaba-rpc.mjs");

  // ---- smoke baseline refusal (kusabi #292) ----
  // Run the declared smoke against the unmodified checkout, before the
  // container is handed to the worker.  The post-round P4 measures the same
  // commands against the worker's changes, so a smoke line that was already
  // red convicts an innocent worker a full round later.  Refuse at the same
  // stage as the #250 parse refusal above — before createChainDir, so no
  // chain state, no job and no round state exist when this fires.
  const baselineRejection = await smokeBaselineReport({
    brief: text,
    callTool,
    container,
  });
  if (baselineRejection) throw new Error(baselineRejection);

  const { chainId, chainDir } = createChainDir(stateDir);
  const maxRounds = Number(flags["max-rounds"] ?? 4); // B6: default maxRounds is 4
  const brief = text;

  // ---- initialise chain control record (file-based stop lever) ----
  writeChainControl(chainDir, createChainControl({
    chainId,
    container,
    pid: process.pid,
  }));

  // ---- SIGTERM/SIGINT handler feeds the same predicate as the file-based stop ----
  let signalReceived = false;
  const onSignal = () => { signalReceived = true; };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  // ---- reset failed-route memo for a fresh chain run ----
  resetFailedRoutes();

  // ---- chain initialisation: record base SHA + worktree baseline ----
  const baseSha = await captureBaseSha(callTool, container);
  const worktreeBaseline = await captureWorktreeState(callTool, container);

  // ---- verify baseline (kusabi #173) ----
  // The only moment the container worktree is guaranteed to be the pristine
  // base is right here, BEFORE the round-1 implement dispatch.  Run the
  // verify gate once and record the base's lint/type violation counts (and
  // the raw verify JSON) on chain.json, so P2 can distinguish "the worker
  // added lint/type debt" from "the repo already had it".  chain-resume
  // reuses this recorded baseline and never re-captures on a modified
  // worktree.
  const verifyBaseline = await captureVerifyBaseline(callTool, container);

  // ---- chain-start output: state tiers, maxRounds, and ladder info (B7) ----
  // The ladder claim must not lie when a rework chain is configured (kusabi
  // #192 axis 2): the implement chain serves round 1 only — the ladder that
  // climbs across rework rounds is the REWORK chain's.  Print both tier
  // counts so the claim is explicit; the can-reach-top claim is computed
  // against the chain the ladder actually climbs (rework when configured,
  // implement otherwise).
  // The counts are backend-aware (kusabi #192 follow-up): a claude-native
  // chain has an effective tier count of min(1, length) — claudeDispatch
  // pins every phase to the command-start model, so its ladder never climbs
  // and the banner must not claim a multi-tier ladder that cannot be walked.
  const tierCount = effectiveTierCount(implementDispatch.chain, implementDispatch.backend);
  const reworkTierCount = reworkKeyConfigured
    ? effectiveTierCount(reworkDispatch.chain, reworkDispatch.backend)
    : 0;
  const bannerLine = renderChainBanner({
    chainId, tierCount, reworkTierCount, reworkKeyConfigured, maxRounds,
  });
  if (bannerLine != null) process.stdout.write(bannerLine);

  try {
    return await runChainDriver({
      cwd, stateDir, chainDir, chainId, container, model: implementDispatch.model,
      modelChain: implementDispatch.chain, reviewModel: reviewDispatch.model,
      reviewModelChain: reviewDispatch.chain, maxRounds,
      brief, orchestrator, baseSha, worktreeBaseline, verifyBaseline, callTool,
      backend: implementDispatch.backend,
      reviewBackend: reviewDispatch.backend,
      // Rework rounds (implement rounds after round 1) dispatch from the
      // rework resolution when models.phases.rework is configured; absent
      // key → reworkDispatch IS the implement dispatch and the driver's
      // effective values collapse to the implement resolution (byte-identical
      // to today).  Round records stamp each round's own backend, so a
      // mixed chain (round 1 claude, rework opencode) stays truthful.
      reworkModel: reworkDispatch.model,
      reworkModelChain: reworkDispatch.chain,
      reworkBackend: reworkDispatch.backend,
      // A model-pinning backend (claude, agy) clamps later phases (rework
      // implement, review, strategist) to the phase's command-start model —
      // neither has a tier ladder, so the model never changes mid-chain
      // (kusabi #184 finding 1).  Each phase clamps to ITS OWN resolved
      // model, so implement and review can run on different backends with
      // different models (kusabi #192).
      dispatchWithFallback: phaseDispatchFor(
        implementDispatch.backend, implementDispatch.dispatch, implementDispatch.model),
      reviewDispatchWithFallback: phaseDispatchFor(
        reviewDispatch.backend, reviewDispatch.dispatch, reviewDispatch.model),
      reworkDispatchWithFallback: phaseDispatchFor(
        reworkDispatch.backend, reworkDispatch.dispatch, reworkDispatch.model),
      initialSession: flags.session,
      // The provenance of `initialSession` (null when no session, or when
      // the store has no record for it) — the agy dispatch's resume gate.
      sessionProvenance,
      // The --model value in the SPELLING of the backend the resolution
      // chose, never the raw flag string (kusabi #210): a backend-naming
      // --model pins every phase onto ITS backend, so all three phase
      // resolutions carry the same spelling, and a claude dispatch must
      // receive `opus`, not `claude/opus`.
      flagsModel: implementDispatch.explicitModel,
      signalReceived: () => signalReceived,
      keepServe: !!flags.keepServe,
      resume: null,
    });
  } finally {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  }
}

/**
 * Default review model/chain for a backend when the operator named only
 * `--backend` to leave a quota-exhausted pool (kusabi #373).
 *
 * @param {string} backend
 * @returns {{ model: string|null, chain: Array }}
 */
function defaultReviewResolution(backend) {
  if (backend === "cursor") {
    return { model: DEFAULT_CURSOR_MODEL, chain: CURSOR_DEFAULT_CHAIN };
  }
  if (backend === "claude") {
    return { model: CLAUDE_DEFAULT_CHAIN[0][0], chain: CLAUDE_DEFAULT_CHAIN };
  }
  if (backend === "agy") {
    return { model: AGY_DEFAULT_CHAIN[0][0], chain: AGY_DEFAULT_CHAIN };
  }
  return { model: null, chain: BUILTIN_DEFAULT_CHAIN };
}

/**
 * Review-seat route for a quota-exhausted replacement that the operator
 * explicitly sent elsewhere.  Implement stays on the recorded backend.
 *
 * @param {object} record
 * @param {{ backend?: string|null, model?: string|null }} explicitRoute
 * @returns {{ backend: string, model: string|null, chain: Array, flagsModel: string|null }}
 */
function resolveQuotaReviewReroute(record, explicitRoute) {
  let backend = explicitRoute.backend || (record.reviewBackend ?? record.backend ?? "opencode");
  let model = null;
  let chain = null;
  let flagsModel = null;
  if (explicitRoute.model) {
    let spec;
    try {
      spec = resolveModelBackend(explicitRoute.model);
    } catch {
      spec = null;
    }
    if (spec?.backend) backend = spec.backend;
    model = spec?.model ?? explicitRoute.model;
    chain = [[explicitRoute.model]];
    flagsModel = model;
  } else {
    const fallback = defaultReviewResolution(backend);
    model = fallback.model;
    chain = fallback.chain;
  }
  return { backend, model, chain, flagsModel };
}

export async function cmdChainResume(cwd, { flags, text }) {
  // Resumption context comes entirely from the saved chain state (chain.json
  // brief, records, ladder; control.json container).  Accepting another flag
  // and ignoring it would answer a different question than the one asked.
  // kusabi #373: `--backend` / `--model` are the one exception — they name a
  // DIFFERENT review seat after quota exhaustion, and are still refused on
  // every other chain (including an unknown id, so the existing unsupported-
  // flag error keeps its wording).
  const unsupported = Object.keys(flags).filter(function (k) {
    return k !== "keepServe" && k !== "backend" && k !== "model";
  });
  if (unsupported.length > 0) {
    throw new Error(
      `chain-resume does not support --${unsupported[0]}: resumption context comes from the saved chain state (chain.json / control.json)`
    );
  }
  const routeFlag = flags.model ? "model" : flags.backend ? "backend" : null;

  const stateDir = stateDirFor(cwd);
  const chainId = text.split(/\s+/).filter(Boolean)[0];
  if (!chainId) throw new Error("chain-resume requires a chain id. Usage: chain-resume <chainId>");

  const chainDir = path.join(stateDir, "chains", chainId);
  if (!fs.existsSync(chainDir)) {
    if (routeFlag) {
      throw new Error(
        `chain-resume does not support --${routeFlag}: resumption context comes from the saved chain state (chain.json / control.json)`
      );
    }
    throw new Error(`chain not found: ${chainId}`);
  }

  const control = readChainControl(chainDir);
  const chainJson = readJson(path.join(chainDir, "chain.json"));
  if (!chainJson) {
    throw new Error(`chain.json not found for ${chainId} — the chain never persisted state to resume from`);
  }

  // ---- lossy-smoke refusal (kusabi #250) ----
  // chain-resume DOES re-read the brief: chain.json's `brief` is handed to
  // runChainDriver below, so every remaining round would run the same
  // misread smoke section.  Refuse before rearmChainControl, i.e. before any
  // state is touched.  Chains predating the `brief` field resume with "",
  // which has no Smoke section and never trips this.
  const resumeSmokeRejection = smokeViolationReport(chainJson.brief ?? "");
  if (resumeSmokeRejection) {
    throw new Error(`cannot resume chain ${chainId}: ${resumeSmokeRejection}`);
  }

  const lastResumeRecord = chainJson.records?.[chainJson.records.length - 1] ?? null;
  const quota = recordQuotaExhaustion(lastResumeRecord);
  if (routeFlag && !quota) {
    throw new Error(
      `chain-resume does not support --${routeFlag}: resumption context comes from the saved chain state (chain.json / control.json)`
    );
  }
  if (flags.backend && !BACKENDS.includes(flags.backend)) {
    throw new Error(`unknown backend: ${flags.backend}. Use --backend ${BACKENDS.join("|")}`);
  }
  const explicitRoute = (flags.backend || flags.model)
    ? { backend: flags.backend || null, model: flags.model || null }
    : null;

  // ---- resume-position decision, from the records alone ----
  const resolution = resolveChainResume({ control, chainJson, explicitRoute });
  if (!resolution.ok) {
    throw new Error(`cannot resume chain ${chainId}: ${resolution.error}`);
  }
  const position = resolution.position;

  // ---- resumed-session provenance (kusabi #316) ----
  // The resumed run carries `position.session` (the interrupted chain's
  // implement session) into the next implement round.  The agy dispatch
  // resumes only on positive provenance, established where the job store is
  // in hand — here: the session was recorded by a kusabi job, so the store
  // names its backend.  No owner (an unusual state — the session was
  // persisted from a kusabi job) means unknown provenance and the agy
  // dispatch fails closed rather than passing the id to `--conversation`.
  const resumedSessionOwner = position.session
    ? latestJob(stateDir, (j) => j.sessionID === position.session)
    : null;
  const sessionProvenance = resumedSessionOwner
    ? (resumedSessionOwner.backend ?? "opencode")
    : null;

  // ---- mid-flight job guard (#153① review) ----
  // A dead driver (stale pid) may have left a phase job dispatched but not
  // finished; the record then has no phase boundary for it, and resuming
  // would re-dispatch the phase — a duplicate job working the same
  // container worktree.  Any job of this chain still recorded as running
  // blocks the resume: wait for it to finish, or cancel it first.
  const inflight = listJobs(stateDir).filter(function (j) {
    return j.status === "running" && chainIdForJob(j) === chainId;
  });
  if (inflight.length > 0) {
    throw new Error(
      `cannot resume chain ${chainId}: job ${inflight[0].id} is still recorded as running ` +
      `("${inflight[0].title}") — it may be mid-flight from the previous driver. ` +
      `Wait for it to finish (kusabi-companion status ${inflight[0].id}), or cancel it ` +
      `(kusabi-companion cancel ${inflight[0].id}), then retry chain-resume`
    );
  }

  const container = control?.container || chainJson.container;
  if (!container) {
    throw new Error(`cannot resume chain ${chainId}: no container recorded in control.json / chain.json`);
  }

  // ---- container must exist: the chain's work lives in it ----
  // `callTool` throws when sunaba itself is unreachable, but it RESOLVES with
  // an error-shaped result ({ status: "error", error: "Container … not
  // found" }) when the container is missing — treat both as unreachable so
  // the driver never starts against a container that does not exist.
  const { callTool } = await import("./sunaba-rpc.mjs");
  let probe;
  try {
    probe = await callTool("sandbox_exec", {
      container_id: container,
      commands: ["echo kusabi-chain-resume-check"],
    });
  } catch (err) {
    probe = { status: "error", error: err?.message ?? String(err) };
  }
  if (probe?.status === "error") {
    throw new Error(
      `cannot resume chain ${chainId}: container ${container} is not reachable (${probe.error}) — ` +
      `the chain's work lives in that container and it must exist before resuming`
    );
  }

  // ---- re-arm the control record: running again, resume trace kept ----
  // The stop-request fields are cleared: shouldStopNow() keys off
  // stopRequestedAt, and a fresh stop must be requested for the resumed run.
  // `round` reflects actual progress: the interrupted round for a
  // review-resume, the last completed round otherwise.
  rearmChainControl({
    chainDir,
    round: position.phase === "review" ? position.round : position.round - 1,
  });

  // ---- SIGTERM/SIGINT handler feeds the same predicate as the file-based stop ----
  let signalReceived = false;
  const onSignal = () => { signalReceived = true; };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  // ---- dispatch backends (kusabi #184 / #192) ----
  // The backends are not flags here except the kusabi #373 quota reroute:
  // resumption context comes from the saved chain state, and the chain
  // record's backend fields are part of it.  The implement backend is the
  // last record's `backend`; the review backend is the last record's
  // `reviewBackend`, falling back to the record's implement backend on
  // records predating the per-phase split.  A missing `backend` field means
  // the chain predates the backend split → opencode.
  const resumeBackend = lastResumeRecord?.backend || "opencode";
  let resumeReviewBackend = lastResumeRecord?.reviewBackend ?? resumeBackend;

  // The dispatch seams for the resumed run.  The REVIEW seam is always
  // explicit (resolveResumeDispatches): an opencode review gets the plain
  // opencode dispatch, so a mixed chain (implement claude / review opencode)
  // resumes review on opencode — never on the claude implement dispatch
  // (kusabi #192 finding).  Each claude phase clamps to ITS OWN recorded
  // model — no tier ladder, no mid-chain model switch (kusabi #184 finding 1).
  // Per-phase review dispatch context (kusabi #192): a #192-era chain.json
  // persists reviewModel/reviewModelChain — persisted null on a mixed chain
  // (opencode review) must stay null, never silently borrow the implement
  // chain; a pre-#192 chain.json has neither key, and key ABSENCE is the
  // legacy marker — fall back to the implement model/chain (pre-#192
  // clamped the whole chain to chainJson.model).
  let { reviewModel: resumeReviewModel, reviewModelChain: resumeReviewModelChain } =
    resolveResumeReviewContext(chainJson);
  let resumeReviewFlagsModel = null;
  // Quota-exhausted seat + an operator-named different route: do not reuse
  // the dead pool's review backend/chain.  Implement stays on the recorded
  // backend; only the replacement REVIEW seat is rerouted.
  if (quota && explicitRouteDiffersFromRecord(lastResumeRecord, explicitRoute)) {
    const reroute = resolveQuotaReviewReroute(lastResumeRecord, explicitRoute);
    resumeReviewBackend = reroute.backend;
    resumeReviewModel = reroute.model;
    resumeReviewModelChain = reroute.chain;
    resumeReviewFlagsModel = reroute.flagsModel;
  }
  const resumeDispatches = resolveResumeDispatches({
    resumeBackend,
    resumeReviewBackend,
    model: chainJson.model ?? null,
    reviewModel: resumeReviewModel,
  });

  // Per-round rework dispatch context (kusabi #192 axis 2): an axis-2
  // chain.json persists reworkModel/reworkModelChain/reworkBackend (null on
  // chains without the models.phases.rework key, in which case rework rounds
  // keep the implement resolution — byte-identical); key ABSENCE is the
  // legacy marker, falling back to the implement values exactly like the
  // review context above.  The rework seam follows the same rule as the
  // review seam: a claude rework backend resumes on the clamped claude
  // dispatch pinned to the recorded rework model, an opencode rework backend
  // on the plain opencode dispatch — never on the implement dispatch of the
  // other backend (mirror of the kusabi #192 review finding).
  const {
    reworkModel: resumeReworkModel,
    reworkModelChain: resumeReworkModelChain,
    reworkBackend: resumeReworkBackend,
  } = resolveResumeReworkContext(chainJson);
  // A null rework backend (no rework key: new chain or legacy chain.json)
  // means rework rounds keep the implement backend — the same `?? backend`
  // rule the fresh-chain driver applies.
  const reworkBackendForResume = resumeReworkBackend ?? resumeBackend;

  try {
    return await runChainDriver({
      cwd, stateDir, chainDir, chainId, container,
      model: chainJson.model ?? null,
      modelChain: chainJson.modelChain,
      reviewModel: resumeReviewModel,
      reviewModelChain: resumeReviewModelChain,
      reworkModel: resumeReworkModel,
      reworkModelChain: resumeReworkModelChain,
      reworkBackend: reworkBackendForResume,
      maxRounds: chainJson.maxRounds ?? 4,
      brief: chainJson.brief ?? "",
      orchestrator: chainJson.orchestrator ?? null,
      baseSha: chainJson.baseSha ?? null,
      worktreeBaseline: null,
      // verifyBaseline (kusabi #173): reuse the baseline recorded in
      // chain.json at chain start — NEVER re-capture on a modified worktree.
      verifyBaseline: chainJson.verifyBaseline ?? null,
      callTool,
      backend: resumeBackend,
      reviewBackend: resumeReviewBackend,
      dispatchWithFallback: resumeDispatches.dispatchWithFallback,
      reviewDispatchWithFallback: resumeDispatches.reviewDispatchWithFallback,
      reworkDispatchWithFallback: phaseDispatchFor(
        reworkBackendForResume, backendDispatch(reworkBackendForResume), resumeReworkModel),
      initialSession: position.session,
      // The provenance of the resumed session (null when no session or no
      // owning record) — the agy dispatch's resume gate.
      sessionProvenance,
      flagsModel: null,
      reviewFlagsModel: resumeReviewFlagsModel,
      signalReceived: () => signalReceived,
      keepServe: !!flags.keepServe,
      resume: position,
    });
  } finally {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  }
}
