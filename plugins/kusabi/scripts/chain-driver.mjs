// chain-driver: the `chain` and `chain-resume` command surfaces and the round
// loop they share.
//
// Extracted from kusabi-companion.mjs unchanged (kusabi #264 PR 2/2): same
// output strings, same exit codes, same persisted records.  The companion
// keeps only the CLI dispatch for these two subcommands; the small read-only
// chain commands (chain-cancel / chain-show / chain-stats) stayed there.
//
// IMPORT DIRECTION.  This module imports from kusabi-companion.mjs, and the
// companion imports cmdChain / cmdChainResume back -- a deliberate cycle, not
// an oversight.  The helpers crossing it (readBriefFile,
// resolveOrchestratorRecord, loadConfig, resolveDispatchBackend,
// liveRunningJobs, cmdServeStop) are used by the companion's own non-chain
// commands as well, and the two alternatives -- duplicating them, or leaving a
// compatibility re-export behind -- are both forbidden by kusabi #264.  The
// cycle is safe because every name crossing it is a hoisted function
// declaration and nothing here runs at module-evaluation time: the companion
// is the process entry point, so it is evaluated last, after this module's
// definitions exist.
//
// The backend table (backendDispatch / backendPinsModel / phaseDispatchFor) is
// imported from the companion rather than moved, even though only this module
// calls it today.  It is one cohesive row-per-backend table together with
// resolveBackend / resolveDispatchBackend / assertSessionBackendCompatible,
// which must stay behind for `task` and `review`; splitting three rows out of
// it would leave the table describing backends in two files.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { renderFollowupDraft } from "./render.mjs";
import {
  hasSectionHeading,
  parseDeliverables,
  parseFrozenTests,
  parseSmoke,
  briefRequestsPublish,
  briefSyntaxDefectSummary,
  findSmokeViolations,
  SMOKE_VIOLATION_NO_ENTRIES,
} from "./brief-parsing.mjs";
import { checkSmokeProbe, classifyRefusalOutcome, verifyRefusalAnchors } from "./probe-decisions.mjs";
import { deriveDisposition } from "./disposition.mjs";
import { stateRoot, stateDirFor, readJson, writeJson } from "./state-paths.mjs";
import {
  readChainControl,
  writeChainControl,
  createChainControl,
  shouldStopNow,
  updateChainControlRound,
  finalizeChainControl,
  rearmChainControl,
  chainIdForJob,
} from "./chain-control.mjs";
import { listJobs, latestJob } from "./job-store.mjs";
import { dispatchWithFallback, resetFailedRoutes } from "./prompt-execution.mjs";
import {
  createChainDir,
  captureBaseSha,
  captureVerifyBaseline,
  resolveRoundResume,
  buildImplementText,
  resolveReworkScope,
  runImplementPhase,
  runProbePhase,
  runReviewPhase,
  computeChainTotals,
  persistChainState,
  writeReviewRecord,
  runStrategizePhase,
  renderAcceptOutcome,
  renderAcceptWithFollowupOutcome,
  renderEscalateOutcome,
  renderRefusalOutcome,
  renderBriefSyntaxDefectOutcome,
  renderMaxRoundsOutcome,
  handleProviderExhaustion,
  recordReworkEscalation,
  resolveChainResume,
  shouldSkipReview,
  archiveFailedReviewSeat,
  collectReviewContext,
  runSmokeProbe,
  runSmokeEntries,
  captureGitStatusPorcelain,
  runVerifyProbe,
  runDeliverablesProbe,
  runFrozenProbe,
  runCollectedProbe,
  summariseOracleViolations,
} from "./chain-phases.mjs";
import { captureWorktreeState } from "./worktree-baseline.mjs";
import { roundDiscardReason } from "./render.mjs";

// The companion side of the cycle documented above.
import {
  readBriefFile,
  briefLintReport,
  resolveOrchestratorRecord,
  loadConfig,
  resolveDispatchBackend,
  backendDispatch,
  backendPinsModel,
  phaseDispatchFor,
  liveRunningJobs,
  cmdServeStop,
} from "./kusabi-companion.mjs";

// ---------------------------------------------------------------------------
// brief guards — evaluated before any chain state or job exists
// ---------------------------------------------------------------------------

// The one-line orchestrator warning emitted at chain start when the brief
// appears to demand publish (kusabi #153).  Exported so the exact chain
// output text is fixed by tests; cmdChain prints it verbatim (plus a
// newline) before any job is dispatched.  publish is orchestrator-exclusive:
// the worker's toolset has no publish, so a brief demanding it must be
// surfaced to the orchestrator, never silently dropped.
export function publishWarningForBrief(brief) {
  if (!briefRequestsPublish(brief)) return null;
  return (
    "brief が publish を要求しているが、ワーカーは publish できない(オーケストレーター専権)。" +
    "受理後にオーケストレーターが publish を行う。"
  );
}

/**
 * The chain-start refusal text for a brief whose `## Smoke` section the
 * machine would read differently from what it says (kusabi #250), or null
 * when the section is clean.
 *
 * Unlike the publish warning above this is a REFUSAL, not a note: a smoke
 * command truncated at a nested backtick reaches the runner as an unclosed
 * fragment, every round reports P4 red ("exit code could not be observed"),
 * and no worker can fix it from inside the chain — kusabi #246 burned six
 * rounds that way.  A `## Smoke` heading with no parseable entry is the same
 * failure seen from the other side: the declared check silently never runs.
 * Both are detectable at parse time with no I/O, so the cheap moment to stop
 * is before any job exists.  The report quotes the brief's own line next to
 * the command the machine read out of it, because the gap between those two
 * IS the bug.
 *
 * @param {string|null|undefined} brief
 * @returns {string|null}
 */
export function smokeViolationReport(brief) {
  const violations = findSmokeViolations(brief);
  if (violations.length === 0) return null;
  const lines = [
    `brief rejected before dispatch: the ## Smoke section has ${violations.length} ` +
    `problem${violations.length === 1 ? "" : "s"} the runner cannot recover from (kusabi #250). ` +
    "Nothing was started; fix the brief and re-run.",
  ];
  for (const v of violations) {
    if (v.kind === SMOKE_VIOLATION_NO_ENTRIES) {
      lines.push(
        "  - `## Smoke` heading present but no smoke entry parsed: the declared smoke check would never run. " +
        "Write each command as a bullet with a backtick-quoted command, or inside a fenced code block — or " +
        "delete the heading entirely: an empty section must omit its heading (kusabi #302)."
      );
      continue;
    }
    lines.push(`  - line ${v.lineNumber}: ${v.line}`);
    lines.push(`    machine reads the command as: \`${v.command}\``);
    lines.push(`    dropped by the first backtick pair: ${v.lost}`);
    lines.push(
      "    a backtick inside the command truncates it. Rewrite the command without nested " +
      "backticks, or put it in a fenced code block (the whole line is the command there)."
    );
  }
  return lines.join("\n");
}

// The first line of the smoke-baseline refusal for a command that RAN and did
// not meet its expectation (kusabi #292).  Shared by the renderer and its
// caller so the two cannot word the same refusal differently.
const SMOKE_BASELINE_HEADER =
  "dispatch refused: the declared ## Smoke is already red on the checkout as handed to the " +
  "worker, before any worker change (kusabi #292). Nothing was dispatched: no job and no round " +
  "state exist. Fix the brief's smoke command, or the baseline it measures, then re-run.";

// The same refusal when nothing was ever measured: the RPC call throwing, or
// an exit code that never came back.  Telling the author to fix the brief's
// smoke command there is a wrong accusation (kusabi #292 follow-up) — the
// command was never seen to complete, so nothing at all was learned about it,
// and the brief is exactly as likely to be correct as before.  What failed is
// the measurement, and the measurement runs in the container.
const SMOKE_BASELINE_UNMEASURED_HEADER =
  "dispatch refused: the declared ## Smoke could not be measured on the checkout as handed to " +
  "the worker (kusabi #292). The command was never seen to complete, so the baseline is " +
  "unknown, not red: this is a container or infrastructure failure, not a fault in the brief. " +
  "Nothing was dispatched: no job and no round state exist. Check the container, then re-run.";

// The first line of the refusal for a `baseline-red` entry that already
// PASSES on the checkout as handed to the worker (kusabi #315).  Shared by
// the renderer and its caller so the two cannot word the same refusal
// differently.  Deliberately NOT the SMOKE_BASELINE_HEADER wording: there the
// smoke is red and the author's remedy is to fix the command or the baseline
// it measures, while here the smoke is green and the ANNOTATION is the stale
// part — the remedy is to drop the annotation or fix the brief, and telling
// the author their smoke is "already red" would send them hunting for a
// failure that does not exist.
const SMOKE_BASELINE_GREEN_ANNOTATION_HEADER =
  "dispatch refused: a declared `baseline-red` ## Smoke entry already passes on the checkout " +
  "as handed to the worker, before any worker change (kusabi #315). The annotation declares " +
  "the entry targets something that does not exist yet; an annotated entry that is already " +
  "green means the brief is stale or the deliverable is already present. Nothing was " +
  "dispatched: no job and no round state exist. Drop the annotation, or fix the brief, then " +
  "re-run.";

// Whether an observation means the command RAN — a numeric exit code, or a
// timeout (the command was executed and simply never finished, which is a
// fact about the command, not about the measurement).  Everything else — a
// thrown call error, an exit code that never came back, no observation at all
// — means the baseline is unknown rather than red, and takes the header that
// says so.
function baselineObservationRan(obs) {
  if (!obs) return false;
  return typeof obs.observed === "number" || obs.observed === "timeout";
}

// How one observed smoke result reads in the refusal.  The numeric case names
// the actual exit code next to the expected one; the other cases must NOT read
// like an exit-code mismatch, because no exit code was seen at all.
function describeBaselineObservation(obs) {
  if (!obs) return "not executed";
  if (obs.observed === "timeout") return "timed out with no exit code";
  if (obs.observed === "unobservable") return "exit code could not be observed";
  if (typeof obs.observed === "number") return `observed exit ${obs.observed}`;
  return `could not be run: ${obs.observed}`;
}

/**
 * Render the smoke-baseline refusal from the declared entries and what the
 * executor observed, or null when every entry met its expectation.
 *
 * Pure: the caller does the running.  Each failing entry is named with its
 * own command, its expected exit code and the actual observation, because the
 * author of the brief has to be able to tell WHICH declared line is the
 * problem without re-running anything by hand.  The captured output tail rides
 * along when the executor collected one, exactly as the post-round probe's
 * detail carries it.
 *
 * A `baseline-red` entry (kusabi #315) is expected to fail on the pristine
 * checkout, so a MEASURED numeric mismatch is the annotation doing its job —
 * no refusal here (a matching exit code passes the ordinary check above, and
 * the green-at-base case is the other renderer's refusal).  An annotated
 * entry whose observation is not a number — timed out, unobservable, never
 * executed — falls through to the ordinary handling and is refused, because
 * the annotation licenses a measured mismatch and nothing else; such lines
 * carry a suffix saying so.
 *
 * The header depends on WHAT failed (kusabi #292 follow-up).  A command that
 * ran and exited wrong is the brief's or the baseline's to fix, and says so.
 * A command that was never seen to complete — the call threw, the exit code
 * never came back — taught nothing about the brief, so it must not tell the
 * author to go and fix a smoke line that may be perfectly correct; that
 * refusal names the failed measurement and points at the container.  When
 * both kinds are present the fix-the-brief header stands: a genuinely red
 * command IS there, and the per-entry lines still name the unmeasured ones.
 *
 * @param {{entries: Array<{command: string, expectedExit: number, baselineRed?: true}>,
 *          observed: Array<{command: string, observed: number|string, diagnostic?: string}>}} opts
 * @returns {string|null}
 */
export function renderSmokeBaselineReport({ entries, observed }) {
  const entriesArr = Array.isArray(entries) ? entries : [];
  const observedArr = Array.isArray(observed) ? observed : [];
  const lines = [];
  let anyRan = false;
  for (const entry of entriesArr) {
    const obs = observedArr.find(function (o) { return o.command === entry.command; });
    if (obs && obs.observed === entry.expectedExit) continue;
    // kusabi #315: a `baseline-red` entry is expected to fail at base — a
    // measured numeric mismatch is the annotation doing its job, so it is not
    // a failure of any kind.  (A matching exit code was already continued
    // past above; an unmeasured observation falls through, because the
    // annotation covers a measured mismatch and nothing else.)
    if (entry.baselineRed && obs && typeof obs.observed === "number") continue;
    if (baselineObservationRan(obs)) anyRan = true;
    lines.push(
      `  - \`${entry.command}\`: expected exit ${entry.expectedExit}, ` +
      describeBaselineObservation(obs) +
      (entry.baselineRed
        ? " (declared baseline-red: the annotation covers a measured exit-code mismatch, not an unmeasurable run)"
        : "")
    );
    if (obs?.diagnostic) {
      lines.push("    ── output tail ──");
      lines.push(obs.diagnostic);
    }
  }
  if (lines.length === 0) return null;
  return [anyRan ? SMOKE_BASELINE_HEADER : SMOKE_BASELINE_UNMEASURED_HEADER, ...lines].join("\n");
}

/**
 * Render the refusal for `baseline-red` entries that PASSED on the checkout
 * as handed to the worker, or null when no annotated entry was green at base.
 *
 * The annotation licenses exactly one baseline outcome: a measured exit code
 * that misses the expectation.  Its mirror image — an annotated entry that
 * already meets its expectation — is the one outcome the annotation must not
 * be allowed to hide: it means the brief is stale or the deliverable already
 * exists, and the dispatch-time baseline is the only place that is cheap to
 * catch.  Each such entry is named with its own command.
 *
 * A `baseline-red` entry whose observation is not a number (timed out,
 * unobservable, never executed) is not this renderer's business: it falls to
 * renderSmokeBaselineReport, which refuses it the ordinary way, because the
 * annotation covers a measured mismatch and nothing else.
 *
 * Pure: the caller does the running.
 *
 * @param {{entries: Array<{command: string, expectedExit: number, baselineRed?: true}>,
 *          observed: Array<{command: string, observed: number|string, diagnostic?: string}>}} opts
 * @returns {string|null}
 */
export function renderSmokeWrongAnnotationReport({ entries, observed }) {
  const entriesArr = Array.isArray(entries) ? entries : [];
  const observedArr = Array.isArray(observed) ? observed : [];
  const lines = [];
  for (const entry of entriesArr) {
    if (!entry.baselineRed) continue;
    const obs = observedArr.find(function (o) { return o.command === entry.command; });
    // Unmeasured (including never executed): the other renderer's refusal.
    if (!obs || typeof obs.observed !== "number") continue;
    // Red at base as declared: the annotation's job, done — no refusal.
    if (obs.observed !== entry.expectedExit) continue;
    lines.push(`  - \`${entry.command}\`: declared baseline-red but already passes with exit ${obs.observed}`);
  }
  if (lines.length === 0) return null;
  return [SMOKE_BASELINE_GREEN_ANNOTATION_HEADER, ...lines].join("\n");
}

// The first line of the worktree-dirt refusal (kusabi #292 follow-up): the
// declared smoke PASSED, but running it wrote to the worktree in the very
// container the worker would then be handed.  The worker must start from the
// checkout the baseline measured; a smoke with write side effects would land
// its artifacts and mutations in the round's diff and review as the worker's
// work -- the same wrongful-conviction class the baseline refusal exists for,
// now entered through the baseline's own execution.  Shared by the renderer
// and its caller so the two cannot word the same refusal differently.
const SMOKE_DIRT_HEADER =
  "dispatch refused: the declared ## Smoke passed, but running it modified the worktree in the " +
  "container the worker would have been handed (kusabi #292). The worker must start from the " +
  "checkout the baseline measured: smoke with write side effects -- coverage output, build " +
  "artifacts, lockfile regeneration, --fix formatters, snapshot updates -- would land in the " +
  "round's diff and review as the worker's work. Nothing was dispatched: no job and no round " +
  "state exist. Make the smoke command read-only, or prepare a container it cannot dirty, then " +
  "re-run.";

// The refusal for a baseline smoke that moved HEAD (kusabi #292 follow-up).
// `git status --porcelain` cannot see this: a smoke that commits, or checks
// out another SHA, leaves a listing identical to the one taken before it ran,
// so the dirt guard passes it.  It is the worse of the two failures, because
// captureBaseSha runs AFTER the baseline: the smoke-moved HEAD is recorded as
// the chain's base, and from then on P1's HEAD check, the deliverables probe
// and the review's diff-vs-base all measure the round against a tree nobody
// chose.  Nothing about that surfaces as an error — it just quietly measures
// the wrong thing, which is exactly the wrongful-conviction class this whole
// guard exists for.  Shared by the renderer and its caller so the two cannot
// word the same refusal differently.
const SMOKE_HEAD_MOVE_HEADER =
  "dispatch refused: running the declared ## Smoke moved HEAD in the container the worker " +
  "would have been handed (kusabi #292). The chain's base SHA is captured after the baseline, " +
  "so the smoke-moved HEAD would be recorded as the base every later measurement compares " +
  "against: the HEAD-clean probe, the deliverables probe and the review's diff-vs-base would " +
  "all measure the round against the wrong tree, with nothing reported as wrong. Nothing was " +
  "dispatched: no job and no round state exist. Make the smoke command leave HEAD alone — no " +
  "commit, no checkout, no reset — or prepare a container it cannot move, then re-run.";

// The same refusal when the guard cannot see: the smoke passed, but whether it
// left the worktree and HEAD unchanged could not be verified.  Refusing on an
// unverifiable measurement, not silently passing, is the fail-closed stance the
// smoke probe itself takes (an unobservable exit code is a red baseline, not a
// skipped one).
const SMOKE_DIRT_UNVERIFIABLE_HEADER =
  "dispatch refused: the declared ## Smoke passed, but whether it left the worktree and HEAD " +
  "unchanged could not be verified (kusabi #292). Nothing was dispatched: no job and no round " +
  "state exist. The worktree and HEAD must be proven unchanged before the worker is handed the " +
  "container; check the container by hand and re-run.";

/**
 * Render the refusal for a baseline smoke that CHANGED the container it ran
 * in -- a dirtied worktree, a moved HEAD, or both -- from the captures taken
 * immediately before and after the run; null when the smoke demonstrably left
 * both unchanged.
 *
 * Pure: the caller does the running.  The worktree comparison is the DELTA --
 * lines in the after-capture that were not in the before-capture -- because
 * the guard is about what THIS smoke added to the tree the worker is handed,
 * not about whatever pre-existing dirt the prepared container may already
 * carry.  Only the delta lines are named, so the author sees exactly what the
 * command wrote.  HEAD is compared as a whole instead: there is no "pre-
 * existing" HEAD move to forgive, and the porcelain listing cannot show one
 * at all (kusabi #292 follow-up) -- a smoke that commits leaves a listing
 * identical to the one before it ran.  Both are reported when both happened;
 * neither hides the other, because each is separately the author's to fix.
 *
 * When either capture is a failure record (call error, truncated listing,
 * unreadable HEAD), no comparison can be computed: the verdict "left
 * unchanged" cannot be built from a listing that could have dropped the dirt,
 * so the refusal says the verification itself failed rather than claiming a
 * clean bill.
 *
 * @param {object} opts
 * @param {{ok: true, lines: string[], head?: string}|{ok: false, reason: string}|null|undefined} opts.before
 * @param {{ok: true, lines: string[], head?: string}|{ok: false, reason: string}|null|undefined} opts.after
 * @returns {string|null}
 */
export function renderSmokeDirtReport({ before, after }) {
  const problems = [];
  if (!before || before.ok !== true) {
    problems.push(before?.reason ?? "the pre-run git status capture failed");
  }
  if (!after || after.ok !== true) {
    problems.push(after?.reason ?? "the post-run git status capture failed");
  }
  if (problems.length > 0) {
    return [SMOKE_DIRT_UNVERIFIABLE_HEADER, ...problems.map((p) => `  - ${p}`)].join("\n");
  }
  const reports = [];
  if (before.head !== after.head) {
    reports.push([
      SMOKE_HEAD_MOVE_HEADER,
      `  HEAD before the smoke: ${before.head}`,
      `  HEAD after the smoke:  ${after.head}`,
    ].join("\n"));
  }
  const beforeLines = new Set(Array.isArray(before.lines) ? before.lines : []);
  const afterLines = Array.isArray(after.lines) ? after.lines : [];
  const delta = afterLines.filter((line) => !beforeLines.has(line));
  if (delta.length > 0) {
    reports.push([
      SMOKE_DIRT_HEADER,
      "  Worktree entries the smoke added:",
      ...delta.map((line) => `    - ${line}`),
    ].join("\n"));
  }
  if (reports.length === 0) return null;
  return reports.join("\n\n");
}

/**
 * The dispatch refusal text for a brief whose declared `## Smoke` is ALREADY
 * red before the worker touches anything (kusabi #292), or whose declared
 * `baseline-red` entry already PASSES at base (kusabi #315), or whose
 * declared smoke, while green, changed the container it was run in (wrote to
 * the worktree, or moved HEAD); null when the baseline is green AND left the
 * container as it found it.
 *
 * The P4 probe runs AFTER a round, against the worker's changes.  When the
 * declared smoke cannot pass on the checkout the worker was handed — pre-
 * existing debt in the target files, or an orchestrator-authored command that
 * cannot pass in the probe shell — that red is not the worker's, but it
 * surfaces a full round later and reads exactly like a failed round.  Both
 * variants happened live, each costing a round plus a manual baseline
 * re-measurement at inspection.  Measuring it here converts that into a
 * refusal the author can act on immediately: the brief or the baseline is at
 * fault, and neither is fixable from inside the round.
 *
 * The run uses runSmokeEntries and checkSmokeProbe — the post-round probe's
 * own executor and its own exit-code comparison — so a baseline green can
 * never mean something different from a P4 green.  The `baseline-red`
 * annotation (kusabi #315) is the one deliberate exception, and it lives in
 * the brief, not in the comparison: an entry so annotated is EXPECTED to
 * mismatch at base (its smoke targets a deliverable that does not exist
 * yet), so the probe's mismatch-is-fail rule would refuse exactly the case
 * the annotation licenses.  The probe therefore judges only the unannotated
 * entries; each annotated entry's verdict comes from the renderers — a
 * measured mismatch passes, a measured MATCH refuses with its own message
 * (the annotation must be wrong in one direction or it rots), and an
 * unmeasurable run falls through to the ordinary refusal, fail-closed.  The
 * annotation changes nothing after the round: the post-round P4 treats every
 * entry the same way it always has.
 *
 * The baseline executes in the very container the worker is then handed, so
 * `git status --porcelain`
 * AND `git rev-parse HEAD` are captured immediately before and after the run
 * (captureGitStatusPorcelain + renderSmokeDirtReport): a PASSING smoke that
 * writes — coverage output, build artifacts, a regenerated lockfile, --fix,
 * snapshot updates — would otherwise hand the worker a dirtied tree whose
 * artifacts and mutations land in the round's diff and review as the worker's
 * work, and a PASSING smoke that commits or checks out would hand it a moved
 * HEAD that the captureBaseSha call below then records as the chain's base
 * (kusabi #292 follow-up) — poisoning every later comparison against a base
 * nobody chose, with nothing reported as wrong.  A baseline that dirties or
 * moves HEAD is refused with what it changed, never dispatched.  Neither the
 * annotation nor a red-at-base verdict licenses any of that: the dirt and
 * HEAD guards apply to every smoke, annotated or not.
 *
 * No declared smoke means no execution at all: an undeclared `## Smoke`
 * dispatches exactly as before, with not a single container call spent.
 *
 * @param {object} opts
 * @param {string|null|undefined} opts.brief
 * @param {Function} opts.callTool   The RPC callTool function (injectable).
 * @param {string}   opts.container  Container the worker will be handed.
 * @returns {Promise<string|null>}
 */
export async function smokeBaselineReport({ brief, callTool, container }) {
  const entries = parseSmoke(brief ?? "");
  if (entries.length === 0) return null;

  const before = await captureGitStatusPorcelain(callTool, container);
  const observed = await runSmokeEntries({ entries, callTool, container });
  const after = await captureGitStatusPorcelain(callTool, container);

  // The probe judges only the entries the annotation does not cover (kusabi
  // #315): a `baseline-red` entry is EXPECTED to mismatch at base, so the
  // probe's mismatch-is-fail rule would refuse exactly the case the
  // annotation licenses.  (When every entry is annotated the probe sees an
  // empty list and passes trivially; the renderers below carry the whole
  // verdict for those entries.)  An unmeasurable annotated entry is refused
  // by the ordinary renderer, fail-closed: the annotation licenses a measured
  // mismatch and nothing else.
  const unannotated = entries.filter((entry) => !entry.baselineRed);
  const probe = checkSmokeProbe(unannotated, observed, unannotated.length > 0);

  // The renderer names the entries that missed their expectation — it runs
  // whenever it has anything to say, because with an all-annotated brief the
  // probe passes trivially while an annotated entry's unmeasurable run still
  // has to be refused.  Should the probe ever go red for something the
  // per-entry walk cannot see, the probe's own detail carries the failure
  // rather than nothing.
  const smokeReport = renderSmokeBaselineReport({ entries, observed })
    ?? (probe.passed ? null : `${SMOKE_BASELINE_HEADER}\n  - ${probe.detail}`);
  // An annotated entry that PASSED at base is the annotation's claim gone
  // stale — a refusal with its own message, never the already-red one, whose
  // remedy (fix the command or the baseline) is the opposite of the right
  // one here (drop the annotation, or fix the brief).
  const wrongAnnotationReport = renderSmokeWrongAnnotationReport({ entries, observed });
  const dirtReport = renderSmokeDirtReport({ before, after });

  // A red smoke, a wrongly-annotated entry AND a dirtied tree are all the
  // author's to fix: all are reported, never one hiding the other.
  if (!smokeReport && !wrongAnnotationReport && !dirtReport) return null;
  return [smokeReport, wrongAnnotationReport, dirtReport].filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------------------
// chain
// ---------------------------------------------------------------------------

// Ladder accounting is backend-aware (kusabi #192 follow-up): a chain on a
// model-pinning backend never walks its tiers — that backend's dispatch pins
// every phase to the command-start model — so everywhere a tier count feeds
// ACCOUNTING (the chain-start banner, the recordReworkEscalation clamp) such
// a chain has an effective tier count of min(1, length).  Dispatch behaviour
// is untouched; this only makes printed/recorded numbers match the ladder the
// backend actually climbs.  opencode chains keep their full length.  Keyed on
// `backendPinsModel`, so the agy backend (kusabi #199 — also one model per
// phase) reports its real ladder without a second branch here.
export function effectiveTierCount(chain, backend) {
  if (!chain) return 0;
  if (backendPinsModel(backend)) return Math.min(1, chain.length);
  return chain.length;
}

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

// Re-validation probe phase (kusabi #262): a review-resumed round's accept
// re-measures the RECORDED probe truth on the current worktree before
// finalising.  This phase is deliberately NOT runProbePhase: that phase's P1
// auto-resets a moved HEAD (`git reset --mixed <baseSha>`) — the right
// fix-up for a round whose own implement moved the worktree, but a MUTATION
// of the very state this re-run exists to measure (kusabi #262 follow-up).
// A measurement must not change what it measures: the operator must find
// the worktree exactly as it was, and the red P1 alone must carry the
// verdict.  P2–P6 are the shared probes; the assembly mirrors
// runProbePhase's so the two phases cannot drift.
//
// P5/P6 (kusabi #197) ARE re-run here (kusabi #197 follow-up).  The recorded
// marker only covers violations measured BEFORE the stop/escalate, and this
// phase exists precisely because the worktree can move in the gap — P5's
// subject (the change set) and P6's subject (the collected count) are exactly
// the truths that move.  A frozen-path edit landed in the gap is invisible to
// P1–P4 (HEAD unchanged → P1 green, tests still pass → P2 green), so an accept
// could finalise with no violation recorded at all.  Detection must never
// depend on per-round attention (kusabi #197), so the fresh marker — derived
// from the FRESH results, not the recorded one — is what finishRound re-derives
// the disposition with.
async function runRevalidationProbePhase({ baseSha, container, brief, callTool, verifyBaseline }) {
  const probeResults = [];
  let worktreeChanged = null;
  try {
    probeResults.push(await runHeadCompareProbe({ baseSha, callTool, container }));

    // P2 keeps the chain-start verify baseline (kusabi #173): re-capturing
    // it here would measure the round's own changes as the baseline.
    const p2Result = await runVerifyProbe({ callTool, container, baseline: verifyBaseline });
    probeResults.push(p2Result);

    const p3Result = await runDeliverablesProbe({
      deliverables: parseDeliverables(brief),
      headingPresent: hasSectionHeading(brief, "Deliverables"),
      callTool,
      container,
      // null for the same reason the recorded run passes null: the resumed
      // round's changes ARE the subject, and a baseline captured at resume
      // time would measure them as "changed".  No baseline means P3 cannot
      // measure worktreeChanged; the caller preserves the recorded value
      // instead of overwriting it with null.
      baseline: null,
    });
    worktreeChanged = p3Result.worktreeChanged;
    probeResults.push(p3Result);

    probeResults.push(await runSmokeProbe({
      entries: parseSmoke(brief),
      callTool,
      container,
      headingPresent: hasSectionHeading(brief, "Smoke"),
    }));

    // ---- P5: frozen (kusabi #197) ----
    // The same probe function and the same fallback rule as the normal round
    // (runProbePhase): the fresh change set is this run's newly-changed paths,
    // falling back to the full changed set when the comparison could not be
    // made.  Here that fallback is the ONLY case — P3 above runs with no
    // worktree baseline (the resumed round's changes ARE the subject), so
    // `newlyChangedPaths` is null and P5 is evaluated against the full set.
    // No second collection: there is one change-collection mechanism.
    probeResults.push(runFrozenProbe({
      frozen: parseFrozenTests(brief),
      headingPresent: hasSectionHeading(brief, "Frozen Tests"),
      changedPaths: p3Result.newlyChangedPaths ?? p3Result.changedPaths,
    }));

    // ---- P6: collected (kusabi #197) ----
    // Reads the FRESH P2's count against the chain-start baseline recorded on
    // chain.json — never a re-captured one (kusabi #173), so the resumed round
    // is compared against the same base as round 1.  Null-tolerant on either
    // side, exactly as in the round: an unknown is not a decrease.
    probeResults.push(runCollectedProbe({
      collected: p2Result.collected ?? null,
      baselineCollected: verifyBaseline?.captured === true
        ? (verifyBaseline.collected ?? null)
        : null,
    }));
  } catch (probeErr) {
    probeResults.push({ probe: "sunaba-rpc", passed: false, detail: String(probeErr) });
  }
  return {
    probesGreen: probeResults.every(function (p) { return p.passed; }),
    probeResults,
    worktreeChanged,
    // Measured on the CURRENT worktree, so it supersedes the recorded marker
    // in the re-derivation (kusabi #197 follow-up).  A probe-phase exception
    // is not a violation — only a P5/P6 result that actually fired sets this,
    // exactly as in runProbePhase.
    oracleViolation: summariseOracleViolations(probeResults),
  };
}

// P1 in re-validation mode (kusabi #262 follow-up): COMPARE HEAD against the
// recorded baseSha and report red on mismatch — never reset.  Detail strings
// mirror the shared P1 (chain-phases runHeadCleanProbe) so the records read
// alike; the mismatch wording names both SHAs so the operator sees exactly
// what moved.
async function runHeadCompareProbe({ baseSha, callTool, container }) {
  let passed = false;
  let detail = "";
  if (baseSha) {
    const gitRev = await callTool("sandbox_exec", {
      container_id: container,
      commands: ["git rev-parse HEAD"],
    });
    const headSha = (gitRev?.output ?? "").trim();
    if (headSha !== baseSha) {
      detail = "HEAD " + headSha + " != base " + baseSha + " (compare-only)";
    } else {
      passed = true;
      detail = "HEAD matches base " + baseSha;
    }
  } else {
    detail = "baseSha not recorded at chain start; cannot check HEAD";
  }
  return { probe: "P1: HEAD clean", passed, detail };
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
  // the id to `--conversation`.
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

// ---------------------------------------------------------------------------
// chain driver — shared by `chain` and `chain-resume` (kusabi #153①)
// ---------------------------------------------------------------------------

/**
 * Resolve the review phase's dispatch for runChainDriver.
 *
 * An explicit `injectedReviewDispatch` wins.  Otherwise the implement
 * dispatch is reused ONLY when the review backend equals the implement
 * backend — the pre-#192 single-dispatch contract (one dispatch threaded
 * through every phase).  Under per-phase mixing the implement dispatch
 * belongs to the OTHER backend, so reusing it for review would silently run
 * the review job on the wrong backend while the round record claims
 * `reviewBackend` — the chain-resume bug this resolves (kusabi #192):
 * cmdChainResume used to pass an undefined review seam for an opencode
 * review, and the driver fell back to the claude implement dispatch.  The
 * fallback for a differing backend is the CANONICAL dispatch of the review
 * backend (`backendDispatch`), so a review routed to any backend — including
 * the agy one (kusabi #199) — reaches that backend's own dispatch.
 *
 * @param {object} opts
 * @param {Function|null|undefined} [opts.injectedReviewDispatch] — explicit
 *        review seam (always given by cmdChain; cmdChainResume passes one
 *        too, so this fallback mainly serves legacy single-dispatch callers).
 * @param {Function} [opts.injectedDispatch] — the implement dispatch.
 * @param {"opencode"|"claude"|"agy"} opts.backend — implement backend.
 * @param {"opencode"|"claude"|"agy"} opts.reviewBackend — review backend.
 * @returns {Function} The dispatch the review phase will use.
 */
export function resolveReviewDispatch({ injectedReviewDispatch, injectedDispatch, backend, reviewBackend }) {
  if (injectedReviewDispatch) return injectedReviewDispatch;
  if (reviewBackend === backend) return injectedDispatch ?? dispatchWithFallback;
  return backendDispatch(reviewBackend);
}

/**
 * Resolve the implement and review dispatch seams for chain-resume.
 *
 * The implement seam mirrors the pre-#192 shape (clamped claude dispatch for
 * a claude chain, undefined \u2192 the driver's real dispatchWithFallback for
 * opencode).  The review seam is ALWAYS explicit: an undefined seam would
 * make runChainDriver fall back to the implement dispatch, which belongs to
 * the OTHER backend on a mixed chain \u2014 the review job would silently run on
 * the wrong backend (claude CLI with the implement's model) while the round
 * record claims the recorded reviewBackend (kusabi #192 finding).  An
 * opencode review gets the plain opencode dispatch; a claude review gets the
 * clamped claude dispatch pinned to the recorded review model.
 *
 * @param {object} opts
 * @param {"opencode"|"claude"} opts.resumeBackend       \u2014 implement backend
 *        (last record's `backend`).
 * @param {"opencode"|"claude"} opts.resumeReviewBackend \u2014 review backend
 *        (last record's `reviewBackend`, falling back to its `backend`).
 * @param {string|null} [opts.model]        \u2014 recorded implement model.
 * @param {string|null} [opts.reviewModel]  \u2014 recorded review model.
 * @returns {{ dispatchWithFallback: Function|undefined,
 *             reviewDispatchWithFallback: Function }}
 */
/**
 * Resolve the per-phase review dispatch context for chain-resume from the
 * persisted chain.json (kusabi #192).  Exported for testing.
 *
 * A #192-era chain.json carries `reviewModel` / `reviewModelChain` \u2014 possibly
 * null on a mixed chain whose review runs on opencode.  That persisted null
 * must stay null: the opencode review dispatch ignores it, and substituting
 * the implement chain would re-dispatch the review with the OTHER backend's
 * chain (a later chain-resume would fall back `reviewModelChain ?? modelChain`
 * and re-run the review on the implement's claude chain).  A pre-#192
 * chain.json has NO such keys: key ABSENCE is the legacy marker \u2014 fall back
 * to the implement model/chain (pre-#192 clamped the whole chain to
 * `chainJson.model`).
 *
 * @param {object} chainJson \u2014 the persisted chain record.
 * @returns {{ reviewModel: string|object|null, reviewModelChain: Array|null }}
 */
export function resolveResumeReviewContext(chainJson) {
  return {
    reviewModel: ("reviewModel" in chainJson) ? chainJson.reviewModel : (chainJson.model ?? null),
    reviewModelChain: ("reviewModelChain" in chainJson) ? chainJson.reviewModelChain : (chainJson.modelChain ?? null),
  };
}

/**
 * Resolve the per-round REWORK dispatch context for chain-resume from the
 * persisted chain.json (kusabi #192 axis 2) \u2014 the rework mirror of
 * resolveResumeReviewContext, with the same key-absence-is-legacy rule.
 *
 * An axis-2 chain.json carries `reworkModel` / `reworkModelChain` /
 * `reworkBackend` \u2014 null when no models.phases.rework key was configured
 * at chain start (rework rounds then continue on the implement resolution,
 * which the driver derives from the nulls).  A pre-axis-2 chain.json has NO
 * such keys: key ABSENCE is the legacy marker \u2014 fall back to the implement
 * model/chain exactly like the review context does, so legacy chains resume
 * byte-identically.  `reworkBackend` has no implement-side value to fall
 * back to here; the caller resolves null \u2192 the implement backend (the
 * same `?? backend` rule the driver uses for a fresh chain).
 *
 * @param {object} chainJson \u2014 the persisted chain record.
 * @returns {{ reworkModel: string|object|null, reworkModelChain: Array|null,
 *             reworkBackend: "opencode"|"claude"|null }}
 */
export function resolveResumeReworkContext(chainJson) {
  return {
    reworkModel: ("reworkModel" in chainJson) ? chainJson.reworkModel : (chainJson.model ?? null),
    reworkModelChain: ("reworkModelChain" in chainJson) ? chainJson.reworkModelChain : (chainJson.modelChain ?? null),
    reworkBackend: ("reworkBackend" in chainJson) ? chainJson.reworkBackend : null,
  };
}

export function resolveResumeDispatches({ resumeBackend, resumeReviewBackend, model, reviewModel }) {
  return {
    // The implement seam keeps its pre-#192 shape: `undefined` for opencode
    // so the driver uses its own real dispatchWithFallback, and the
    // backend's own dispatch — clamped to the recorded model — for a
    // model-pinning backend (claude, agy).
    dispatchWithFallback: backendPinsModel(resumeBackend)
      ? phaseDispatchFor(resumeBackend, backendDispatch(resumeBackend), model)
      : undefined,
    // The review seam is ALWAYS explicit (see the doc above): an undefined
    // seam would let the driver fall back to the implement dispatch, which
    // on a mixed chain belongs to the other backend.
    reviewDispatchWithFallback: phaseDispatchFor(
      resumeReviewBackend, backendDispatch(resumeReviewBackend), reviewModel),
  };
}

/**
 * Run the chain round loop.  Shared by cmdChain (fresh chain) and
 * cmdChainResume (resumed chain); `resume` carries the position resolved by
 * resolveChainResume, or null for a fresh chain.
 *
 * Exported so tests can drive the loop with fake callTool / dispatch; the
 * CLI wrappers install signal handlers and (for resume) validate the
 * container before calling this.
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} opts.stateDir
 * @param {string} opts.chainDir
 * @param {string} opts.chainId
 * @param {string} opts.container
 * @param {string|null} opts.model
 * @param {Array} opts.modelChain
 * @param {number} opts.maxRounds
 * @param {string} opts.brief
 * @param {object|null} opts.orchestrator
 * @param {string|null} opts.baseSha        — null → captured from the container.
 * @param {object|null} opts.worktreeBaseline — null → captured from the container.
 * @param {object|null} opts.verifyBaseline — chain-start verify baseline
 *        (kusabi #173).  Fresh chains: captured by cmdChain on the pristine
 *        base.  Resumed chains: read from chain.json by cmdChainResume.  Never
 *        re-captured here — a resumed worktree is modified, so a fresh capture
 *        would measure the round's changes, not the base.
 * @param {Function} opts.callTool
 * @param {Function} [opts.dispatchWithFallback] — injection seam for the
 *        IMPLEMENT phase and the strategist (defaults to the real
 *        dispatchWithFallback; phase functions receive it as their own
 *        _dispatchWithFallback seam).  claudeDispatch when the chain's
 *        implement phase runs on the claude backend (kusabi #184).
 * @param {Function} [opts.reviewDispatchWithFallback] — injection seam for
 *        the REVIEW phase; when not given, resolveReviewDispatch picks it
 *        from the backends: the implement dispatch for a same-backend review
 *        (single-backend chains behave exactly as before), else the canonical
 *        dispatch of the review backend — never the other backend's dispatch
 *        (kusabi #192).  Resolved per phase from models.phases.review.
 * @param {"opencode"|"claude"} [opts.backend] — implement dispatch backend,
 *        recorded on every round record; readers treat a missing field as
 *        "opencode".  Default "opencode".
 * @param {"opencode"|"claude"} [opts.reviewBackend] — review dispatch
 *        backend, recorded as `reviewBackend` on every round record (always
 *        set; readers treat a missing field as the record's implement
 *        backend).  Defaults to the implement backend (legacy
 *        single-dispatch callers run the whole chain on one backend).
 * @param {Array} [opts.reviewModelChain] — the review phase's route chain
 *        (defaults to modelChain for single-chain chains).  Persisted to
 *        chain.json so chain-resume re-dispatches review on the same route.
 * @param {string|object|null} [opts.reviewModel] — the review phase's
 *        command-start resolved model (claude string, or opencode parseModel
 *        object); persisted for chain-resume.
 * @param {Array} [opts.reworkModelChain] — the rework phase's route chain
 *        (kusabi #192 axis 2).  Implement rounds AFTER round 1 (rework
 *        rounds) dispatch from it, and the tier ladder climbs over it; null
 *        (no models.phases.rework key) keeps rework rounds on the implement
 *        chain and ladder — byte-identical to today.  Persisted to
 *        chain.json so chain-resume re-dispatches rework rounds on the same
 *        route.
 * @param {string|object|null} [opts.reworkModel] — the rework phase's
 *        command-start resolved model; persisted for chain-resume.
 * @param {"opencode"|"claude"|null} [opts.reworkBackend] — the rework
 *        phase's dispatch backend; null/absent means rework rounds keep the
 *        implement backend.  Recorded on every rework round record's
 *        `backend` field; persisted to chain.json for chain-resume.
 * @param {Function} [opts.reworkDispatchWithFallback] — injection seam for
 *        REWORK implement rounds (rounds after round 1); when not given the
 *        implement dispatch is used (no rework key configured).  claude
 *        rework rounds get the clamped claude dispatch pinned to the rework
 *        model (kusabi #184 finding 1 applies per phase).
 * @param {string} [opts.initialSession]
 * @param {string|null} [opts.sessionProvenance] — the backend the caller
 *        established (from the job store) as the creator of `initialSession`
 *        (and of the resumed `resume.session`, which is the same value).
 *        The agy dispatch's resume gate: a bare UUID reaches
 *        `--conversation` only with `"agy"` here.
 * @param {string|null} [opts.flagsModel]
 * @param {Function} [opts.signalReceived]  — getter: has SIGTERM/SIGINT fired?
 * @param {boolean} [opts.keepServe]
 * @param {object|null} [opts.resume]       — resolveChainResume position or null.
 * @returns {Promise<string>} Outcome text for the operator.
 */
export async function runChainDriver({
  cwd, stateDir, chainDir, chainId, container, model, modelChain, maxRounds,
  brief, orchestrator, baseSha, worktreeBaseline, verifyBaseline, callTool,
  dispatchWithFallback: injectedDispatch = dispatchWithFallback,
  backend = "opencode",
  reviewDispatchWithFallback: injectedReviewDispatch = null,
  // Default reviewBackend to the implement backend: a caller that threads a
  // single dispatch (every pre-#192 caller) runs the whole chain on one
  // backend, so its records should claim that backend for review too.
  reviewBackend = backend,
  reviewModelChain = null,
  reviewModel = null,
  // Rework context (kusabi #192 axis 2): defaults collapse to the implement
  // resolution, so callers without a models.phases.rework key (and every
  // pre-axis-2 caller) get byte-identical behaviour.
  reworkModelChain = null,
  reworkModel = null,
  reworkBackend = null,
  reworkDispatchWithFallback = null,
  initialSession, flagsModel = null, signalReceived = () => false,
  keepServe = false, resume = null, sessionProvenance = null,
}) {
  // Per-phase dispatch (kusabi #192): the review phase dispatches through its
  // own backend-specific dispatch unless the caller threads a single one
  // (single-backend chains — and every pre-#192 caller — stay identical).
  // The fallback is backend-aware: the implement dispatch is reused only for
  // a same-backend review; under mixing the review phase gets the canonical
  // dispatch of ITS backend, never the other backend's dispatch (kusabi #192
  // finding — chain-resume used to route review through the claude implement
  // dispatch while recording reviewBackend=opencode).
  const reviewDispatch = resolveReviewDispatch({
    injectedReviewDispatch,
    injectedDispatch,
    backend,
    reviewBackend,
  });
  // The review phase's route chain: its own when per-phase config resolved
  // one, else the implement chain (pre-#192 behaviour).
  const effectiveReviewChain = reviewModelChain ?? modelChain;
  // The REWORK phase's effective resolution (kusabi #192 axis 2): its own
  // chain / backend / dispatch when a models.phases.rework key resolved one,
  // else the implement resolution — the `??` collapses exactly to it, so
  // chains without the key (and every pre-axis-2 caller) are byte-identical.
  const effectiveReworkChain = reworkModelChain ?? modelChain;
  const effectiveReworkBackend = reworkBackend ?? backend;
  const effectiveReworkDispatch = reworkDispatchWithFallback ?? injectedDispatch;
  // baseSha: a resume keeps the ORIGINAL chain base — the resumed round's diff
  // is measured against it (P1 auto-resets HEAD to it); a fresh chain captures
  // it from the container.
  const effectiveBaseSha = baseSha ?? await captureBaseSha(callTool, container);
  // worktreeBaseline: captured once per run.  A resumed chain re-captures at
  // resume time — the pre-cancel baseline is not persisted, and the resumed
  // run measures what IT changes from here on.  The interrupted round's
  // review-resume path deliberately bypasses it (see collectReviewContext).
  const effectiveBaseline = worktreeBaseline ?? await captureWorktreeState(callTool, container);
  // verifyBaseline (kusabi #173): NEVER re-captured here.  Fresh chains get it
  // from cmdChain (pristine base); resumed chains reuse the value recorded in
  // chain.json — the worktree is modified by resume time, so a re-capture
  // would measure the round's changes and silently ratchet the baseline.
  const effectiveVerifyBaseline = verifyBaseline ?? null;

  // ---- round loop state (cross-round) ----
  const records = resume ? resume.records : [];
  let strategized = resume ? resume.strategized : false;
  let session = resume ? resume.session : initialSession;
  let provenance = session ? sessionProvenance : null;
  let reworkCount = resume ? resume.reworkCount : 0;
  let currentTierIndex = resume ? resume.currentTierIndex : 0;
  const startRound = resume ? resume.round : 1;

  // ---- terminal finalisation: write the postable review record and append
  // its path to the outcome text.  Every terminal disposition funnels
  // through here (accept / accept-with-followup / escalate / max-rounds), so
  // `chain` and `chain-resume` cannot diverge.  Cancelled and failed chains
  // never reach it (kusabi #52).  The record is a convenience artifact: a
  // write failure must not take the already-decided chain outcome down with
  // it, so it degrades to a visible note instead of throwing.
  function finaliseChain(text, disposition, round) {
    let recordPath = null;
    let writeError = null;
    try {
      recordPath = writeReviewRecord({
        chainDir, chainId, container, modelChain, maxRounds, brief, orchestrator,
        records, chainTotals: computeChainTotals(records),
        disposition, round,
        label: path.basename(cwd) || null,
      });
    } catch (err) {
      // Best-effort — the outcome text stays intact, but the failure must be
      // observable or renderer defects hide behind a silently absent record.
      writeError = err;
    }
    return recordPath
      ? text + "\n\n" + "review record: " + recordPath
      : text + "\n\n" + "review record: (write failed: " + (writeError?.message || "unknown error") + " — chain state dir " + chainDir + ")";
  }

  // Existence predicate for refusal anchors (kusabi #293): the worktree is
  // `cwd`, and the driver process runs inside the container that holds it.
  // `verifyRefusalAnchors` rejects `..` and `.git` paths before asking, so
  // the join cannot escape the worktree; a miss is `false`, never a throw.
  function repoPathExists(name) {
    try {
      return fs.existsSync(path.join(cwd, name));
    } catch {
      return false;
    }
  }

  // Phases 5–13 (review → disposition → persistence → strategize), shared by
  // fresh rounds and review-resumes.  Mutates the cross-round state above in
  // place; returns { done: true, text } when the chain ended.
  async function finishRound({ round, roundRecord, previousRecord, probeCtx, implementRefusal = null }) {
    const {
      chainChangedPaths, chainNewlyChanged, chainStatusObserved,
      chainStatusOutput, chainBaseLog, chainDeliverables, chainUntracked, chainTruncation,
    } = probeCtx;
    // NOT const: an accept finalising on RECORDED probe truth re-measures it
    // first (kusabi #262), and everything downstream of the disposition —
    // the re-derivation itself, recordReworkEscalation's evidence — must see
    // the fresh value, never the recorded one.
    let probesGreen = probeCtx.probesGreen;

    // ---- phase 5: review (or skip when change set empty) ----
    // Single conduit (kusabi #100): runReviewPhase writes everything that
    // belongs on the record onto roundRecord and returns only what is not
    // record state; the values the disposition phase needs that ARE record
    // state (verdict, findingsText) are read back from roundRecord here.
    const {
      chainParsedReview, chainRepeatedAreas, skipReview,
      reviewJobStatus, reviewJobError,
    } = await runReviewPhase({
      container, brief, modelChain: effectiveReviewChain, chainId, cwd, previousRecord, baseSha: effectiveBaseSha,
      chainStatusOutput, chainBaseLog, chainUntracked, chainTruncation, roundRecord,
      chainChangedPaths, chainNewlyChanged, chainStatusObserved, chainDeliverables,
      flagsModel, _dispatchWithFallback: reviewDispatch,
    });
    // ---- phase 5b: qualifying refusal (kusabi #293) ----
    // `skipReview` is the empty-change-set signal the discard has always been
    // decided on, so routing here can only ever DIVIDE that population --
    // a round that changed files takes the same path it did before, and an
    // empty round whose report carries no qualifying block still discards
    // byte for byte.
    //
    // The parse is shape-only; the NAMED items must exist before the block
    // may qualify (phase-chain.md §3.5.4a): a brief-section anchor must be a
    // heading the brief really has, and a repo-path anchor must be a file or
    // directory the worktree really contains -- a forged `src/nonexistent.mjs`
    // or an invented heading counts as unnamed, disqualifying unless two real
    // items remain.  Both inputs are in scope here: the chain's own brief
    // text, and the worktree at `cwd`.  The fresh path and the review-resume
    // path (which also lands here, descriptor read back off the record)
    // therefore derive the same verdict.  The verified descriptor replaces
    // the parse-time stamp on the record, so the record never keeps a
    // shape-only verdict that classification has already rejected.
    const verifiedRefusal = implementRefusal
      ? verifyRefusalAnchors(implementRefusal, {
          brief,
          pathExists: repoPathExists,
        })
      : null;
    if (implementRefusal) roundRecord.implementRefusal = verifiedRefusal;
    const refusalOutcome = classifyRefusalOutcome({
      changeSetEmpty: skipReview,
      refusal: verifiedRefusal,
    });
    if (refusalOutcome.outcome === "refusal") {
      // The round's outcome is a refusal, NOT a discard: seat metrics count
      // `verdict`, and leaving `discard` there would charge the worker for
      // reading the brief correctly -- the pressure this whole path exists to
      // remove.  `verdictSource` stays "probe" (no reviewer decided this).
      roundRecord.roundOutcome = "refusal";
      roundRecord.refusal = refusalOutcome.refusal;
      roundRecord.verdict = "refusal";
      roundRecord.verdictSource = "probe";
      roundRecord.findingsText = "(no review — the worker refused the brief as self-contradictory)";
    } else if (refusalOutcome.strayRefusal) {
      // The worker wrote a refusal block AND edited files.  That is not a
      // refusal, so nothing about the routing changes -- but the
      // inconsistency is the orchestrator's to see, not the record's to
      // swallow.
      roundRecord.strayRefusalBlock = {
        anchors: refusalOutcome.strayRefusal.anchors,
        why: refusalOutcome.strayRefusal.why,
        note: refusalOutcome.detail,
      };
    } else if (refusalOutcome.detail) {
      // Empty round, refusal ATTEMPTED but the block did not qualify.  The
      // routing is the pre-existing discard; recording why it fell short
      // keeps the orchestrator from reading the round as a lazy empty one.
      roundRecord.refusalRejected = refusalOutcome.detail;
    }

    // ---- phase 5c: brief-syntax defect (kusabi #303) ----
    // A zero-entry `## Deliverables` / `## Smoke` / `## Frozen Tests` section
    // fails P3/P4/P5 on syntax, and the input those probes read is the BRIEF
    // -- the worker cannot edit it, so no rework is winnable and the chain
    // must terminate at the FIRST occurrence rather than spend the budget on
    // reworks that cannot succeed (the chain-msvwhslx6e60 incident).
    //
    // Derived from the brief text with the probes' own parsers, not from the
    // probe results: heading-present-and-zero-entries is exactly the
    // condition those probes fail on, so the two cannot disagree, and the
    // value is identical on every path that reaches here -- a fresh round, a
    // review-resume reading recorded probe truth, and the accept
    // re-validation (kusabi #262), which re-measures the worktree but never
    // the brief.
    //
    // The dispatch-time lint (kusabi #302) refuses these briefs before a
    // chain exists, using the same parsers; this row is defense in depth for
    // a chain that started before the lint or bypassed it.
    const briefSyntaxDefect = briefSyntaxDefectSummary(brief);
    if (briefSyntaxDefect) {
      roundRecord.briefSyntaxDefect = briefSyntaxDefect;
      // The round's outcome names WHOSE defect this is.  `verdict` is left as
      // measured -- it is a true statement about the work the round did, and
      // the attribution lives here and in the disposition reason.  A worker
      // refusal is the more specific statement and keeps its own outcome.
      if (roundRecord.roundOutcome !== "refusal") {
        roundRecord.roundOutcome = "brief-syntax-defect";
      }
    }

    const chainVerdict = roundRecord.verdict;
    const chainFindingsText = roundRecord.findingsText;
    // ---- stop on review provider exhaustion ----
    if (reviewJobStatus === "provider-error") {
      const { chainState, outcome } = handleProviderExhaustion({
        records, roundRecord,
        currentTierIndex, phase: "review", jobError: reviewJobError,
        jobFailure: roundRecord.reviewJobFailure || null,
        chainId, round, container, model, modelChain,
        reviewModel, reviewModelChain,
        reworkModel, reworkModelChain, reworkBackend,
        maxRounds, brief, orchestrator, baseSha: effectiveBaseSha,
        strategized, chainFollowupDraft: null,
        verifyBaseline: effectiveVerifyBaseline,
      });
      writeJson(path.join(chainDir, "round-" + round + ".json"), roundRecord);
      writeJson(path.join(chainDir, "chain.json"), chainState);
      finalizeChainControl({ chainDir, status: "failed", round });
      return { done: true, text: outcome };
    }

    // ---- phase 6: derive disposition ----
    // Malformed-review guard (kusabi #153): `findings` may be a non-array.
    const findingSeverities = Array.isArray(chainParsedReview?.findings)
      ? chainParsedReview.findings.map(function (f) { return f.severity; })
      : undefined;

    // Budget-adjusted round (kusabi #60 step 2): maxRounds buys design/full
    // rounds only; mechanical rounds are free.  The `round` handed to
    // deriveDisposition is the current round's ordinal WITHIN the budget (a
    // mechanical round does not advance it), so the `round >= maxRounds`
    // terminal fires on budget, not raw round count.  The count comes from
    // the records alone (budget is never persisted); a review-resumed round
    // is already in `records`, so it is excluded before counting.
    const budgetUsedBefore = records.filter(function (r) {
      return r !== roundRecord && r.reworkScope !== "mechanical";
    }).length;
    const budgetRound = budgetUsedBefore + (roundRecord.reworkScope !== "mechanical" ? 1 : 0);

    // The derivation is a closure because it runs twice on the re-validation
    // path below (kusabi #262): once on the truth this round arrived with,
    // once on the truth re-measured for an accept.  Every input except the
    // two the probes measure — probesGreen and the oracle marker — is
    // identical between the two calls, so they cannot drift.
    //
    // The P5/P6 oracle marker (kusabi #197) is probe truth like probesGreen,
    // so it moves with it: the recorded marker decides the first derivation,
    // and the one re-measured on the current worktree decides the second
    // (kusabi #197 follow-up).  A frozen-path edit or a collected-count drop
    // that landed AFTER the stop/escalate is invisible to the recorded marker
    // — it is exactly what the re-validation exists to catch.
    const recordedOracleViolation = probeCtx.oracleViolation ?? false;
    const deriveWith = function (green, oracleViolation) {
      return deriveDisposition({
        verdict: chainVerdict || "needs-attention",
        probesGreen: green,
        round: budgetRound,
        maxRounds,
        repeatedAreas: chainRepeatedAreas,
        findingSeverities,
        strategizeEligible: !strategized,
        oracleViolation,
        // A qualifying refusal (kusabi #293) is fixed for the round: it is
        // measured from the change set and the report, neither of which the
        // re-validation below re-measures, so both derivations see the same
        // value.  The named items travel in the string so the terminal line
        // carries them.
        refusal: refusalOutcome.outcome === "refusal" ? refusalOutcome.detail : null,
        // Fixed for the round for the same reason (kusabi #303): it is a
        // function of the brief alone, and the re-validation below re-measures
        // the worktree, never the brief.
        briefSyntaxDefect,
        partialDiagnosis: roundRecord.reviewPartialDiagnosis ?? chainParsedReview?.partialDiagnosis,
      });
    };
    let disposition = deriveWith(probesGreen, recordedOracleViolation);

    // ---- lazy re-validation of RECORDED probe truth (kusabi #262) ----
    // A review-resumed round (the #153 interrupted round, or the #248
    // replacement review seat) carries probe truth measured BEFORE the
    // stop/escalate.  The container worktree can have moved since then
    // (operator hand-edits, another job, a partial restore), so an accept
    // derived from that record would finalise on an estimate while the
    // authoritative check is one probe run away.  Re-measure and re-derive.
    //
    // Only the accept family triggers it, deliberately: a rework buys a next
    // round whose own probes re-measure everything anyway, so re-running here
    // would pay for truth that round produces regardless.  Only an accept
    // CONSUMES the recorded truth, so only an accept must re-measure it.
    //
    // At most once per round: `probesRevalidated` is the guard, so a
    // re-derived rework/strategize cannot re-trigger it.  Non-resumed rounds
    // never set `probesFromRecord` and are untouched — their probe truth was
    // measured in-round, minutes ago, on this worktree.
    if (
      probeCtx.probesFromRecord
      && !roundRecord.probesRevalidated
      && (disposition.disposition === "accept" || disposition.disposition === "accept-with-followup")
    ) {
      const fresh = await runRevalidationProbePhase({
        baseSha: effectiveBaseSha, container, brief, callTool,
        verifyBaseline: effectiveVerifyBaseline,
      });
      // Preserve the recorded truth the way #248 preserves a dead seat: the
      // record must keep saying "recorded green, then re-validated", never
      // silently swap one measurement for the other.
      roundRecord.probesRevalidated = {
        reason: "accept finalisation after a review-resume (kusabi #262)",
        at: new Date().toISOString(),
        recordedDisposition: disposition,
        probesGreen,
        probeResults: roundRecord.probeResults ?? null,
        worktreeChanged: roundRecord.worktreeChanged ?? null,
        // The recorded P5/P6 marker is preserved for the same reason as the
        // recorded probe results (kusabi #197 follow-up): the live field now
        // carries the freshly measured one.
        oracleViolation: recordedOracleViolation,
      };
      probesGreen = fresh.probesGreen;
      roundRecord.probesGreen = fresh.probesGreen;
      roundRecord.probeResults = fresh.probeResults;
      // The live marker is the fresh measurement, so a later reader (a second
      // review-resume of this round) reads what the current worktree said.
      roundRecord.oracleViolation = fresh.oracleViolation;
      // Overwrite a live record field only with an actually measured value.
      // This run carries no worktree baseline (see runRevalidationProbePhase),
      // so P3 cannot measure worktreeChanged — it is null.  A recorded true
      // must stay true, not degrade to unknown (kusabi #262 follow-up).
      if (fresh.worktreeChanged !== null && fresh.worktreeChanged !== undefined) {
        roundRecord.worktreeChanged = fresh.worktreeChanged;
      }
      // Fresh green → the accept stands unchanged.  Fresh red → this is the
      // disposition of a round with red probes, exactly as a normal round
      // would derive it; the accept never finalises.  A fresh P5/P6 violation
      // escalates the resumed round the same way it escalates a normal one
      // (kusabi #197 follow-up), so the marker handed over is the fresh one.
      disposition = deriveWith(probesGreen, fresh.oracleViolation);
    }
    roundRecord.disposition = disposition;

    // ---- phase 7: record keeping + persistence ----
    // Idempotent push: a review-resumed round is already in `records` (its
    // partial state was persisted at stop time).
    if (!records.includes(roundRecord)) records.push(roundRecord);

    // Compute totals across all rounds so far
    const chainTotals = computeChainTotals(records);

    // When review was skipped, ensure findingsText is set
    if (skipReview && !roundRecord.findingsText) {
      roundRecord.findingsText = "(no review — change set was empty)";
    }

    // Followup draft for accept-with-followup
    let chainFollowupDraft = null;
    if (disposition.disposition === "accept-with-followup" && chainParsedReview?.findings) {
      const briefTitle = brief ? brief.split("\n")[0].trim() : "";
      chainFollowupDraft = renderFollowupDraft({
        chainId,
        briefTitle,
        findings: chainParsedReview.findings,
      });
      roundRecord.followupIssueDraft = chainFollowupDraft;
    }

    // ---- Compute rework strategy for the NEXT round (if rework needed) ----
    let pendingReworkStrategy = null;
    if (disposition.disposition === "rework") {
      // Tier escalation is clamped to the modelChain range (kusabi #153):
      // selectRoutes already keeps dispatch at the top tier, so the
      // recorded tier must match the model actually used — never "0 → 1"
      // on a single-tier chain.  The clamp fields (tierClamped /
      // tierClampReason) land on the round record here.
      // The tier ladder climbs over the chain the NEXT round dispatches on
      // (kusabi #192 axis 2): a rework round addresses the REWORK chain, so
      // the escalation clamps against its tier count — the implement chain's
      // count when no rework chain is configured (unchanged behaviour).
      // The count is backend-aware (kusabi #192 follow-up): a claude-native
      // ladder has an effective tier count of min(1, length), so tierAfter
      // can never exceed 0 on a claude ladder — the model never changes
      // there, and a recorded 0 → 1 would contradict the pinned model.
      const escalation = recordReworkEscalation({
        roundRecord,
        currentTierIndex,
        reworkCount,
        strategized,
        tierCount: effectiveTierCount(effectiveReworkChain, effectiveReworkBackend),
        // Anchoring-override evidence (#62): verdict, probes and the
        // cross-round repeated-areas signal from the finished round.
        chainVerdict,
        chainRepeatedAreas,
        probesGreen,
      });

      // Update cross-round state for the next iteration
      pendingReworkStrategy = escalation.strategy;
      reworkCount += 1;
      currentTierIndex = escalation.currentTierIndex;
    } else if (disposition.disposition === "strategize") {
      // Strategize doesn't consume a rework count, but it sets strategized=true
      // which affects the next rework strategy.
    }

    // Record the pending rework strategy on the round record so the next
    // round can read it, and so chain-show can display what levers were pulled.
    roundRecord.pendingReworkStrategy = pendingReworkStrategy;
    roundRecord.tierAfter = currentTierIndex;

    persistChainState({
      chainDir, round, roundRecord, chainId, container, model, modelChain,
      reviewModel, reviewModelChain,
      reworkModel, reworkModelChain, reworkBackend,
      maxRounds, brief, orchestrator, records, baseSha: effectiveBaseSha,
      chainTotals, strategized, chainFollowupDraft,
      verifyBaseline: effectiveVerifyBaseline,
    });

    // Update the chain control round counter
    updateChainControlRound({ chainDir, round });

    // ---- phase 8: disposition handling ----
    // A qualifying refusal is terminal and lands in the orchestrator's hands
    // (kusabi #293).  `completed` like every other decided chain: the chain
    // ran correctly and produced a decision -- what is defective is the
    // brief, which the outcome text says in as many words.
    if (disposition.disposition === "refused-brief-defect") {
      finalizeChainControl({ chainDir, status: "completed", round });
      // Two ways into this terminal, and they hand over different evidence:
      // the worker named the contradiction itself (kusabi #293), or a probe
      // could not read a brief section (kusabi #303).  The renderer follows
      // the round's own outcome, which phases 5b/5c stamped -- a worker
      // refusal is the more specific statement and wins when both hold.
      const refusalRendered = roundRecord.roundOutcome === "refusal"
        ? renderRefusalOutcome({ chainId, round, disposition, orchestrator, roundRecord, records })
        : renderBriefSyntaxDefectOutcome({ chainId, round, disposition, orchestrator, roundRecord, records });
      return { done: true, text: finaliseChain(
        refusalRendered,
        { disposition: "refused-brief-defect", round, reason: disposition.reason || null },
        round,
      ) };
    }

    if (disposition.disposition === "accept") {
      finalizeChainControl({ chainDir, status: "completed", round });
      return { done: true, text: finaliseChain(
        renderAcceptOutcome({ chainId, round, chainParsedReview, chainFindingsText }),
        { disposition: "accepted", round },
        round,
      ) };
    }

    if (disposition.disposition === "accept-with-followup") {
      finalizeChainControl({ chainDir, status: "completed", round });
      return { done: true, text: finaliseChain(
        renderAcceptWithFollowupOutcome({ chainId, round, chainParsedReview, chainFindingsText, chainFollowupDraft, brief }),
        { disposition: "accepted-with-followup", round },
        round,
      ) };
    }

    if (disposition.disposition === "escalate") {
      finalizeChainControl({ chainDir, status: "completed", round });
      return { done: true, text: finaliseChain(
        renderEscalateOutcome({ chainId, round, disposition, orchestrator, roundRecord, records }),
        // The persisted final record's reason must not read "reviewer
        // discarded the work" for a round no reviewer ever saw (kusabi #299):
        // a probe-sourced discard substitutes the probe wording, exactly as
        // the outcome text does.  Reviewer-verdict discards keep the recorded
        // reason.  roundDiscardReason owns the condition.
        { disposition: "escalated", round, reason: roundDiscardReason(roundRecord, disposition.reason || null) },
        round,
      ) };
    }

    // ---- phase 9: strategize (structural re-diagnosis before next rework) ----
    if (disposition.disposition === "strategize") {
      const { strategistJobStatus, strategistJobError, strategistJobFailure } = await runStrategizePhase({
        cwd, chainId, round, brief, previousRecord, roundRecord, modelChain,
        _dispatchWithFallback: injectedDispatch,
      });

      // ---- stop on strategize provider exhaustion ----
      if (strategistJobStatus === "provider-error") {
        // roundRecord was already pushed onto records during phase 7;
        // handleProviderExhaustion detects that and does not push again.
        const { chainState, outcome } = handleProviderExhaustion({
          records, roundRecord,
          currentTierIndex, phase: "strategize", jobError: strategistJobError,
          jobFailure: strategistJobFailure,
          chainId, round, container, model, modelChain,
          reviewModel, reviewModelChain,
          reworkModel, reworkModelChain, reworkBackend,
          maxRounds, brief, orchestrator, baseSha: effectiveBaseSha,
          strategized, chainFollowupDraft,
          verifyBaseline: effectiveVerifyBaseline,
        });
        writeJson(path.join(chainDir, "round-" + round + ".json"), roundRecord);
        writeJson(path.join(chainDir, "chain.json"), chainState);
        finalizeChainControl({ chainDir, status: "failed", round });
        return { done: true, text: outcome };
      }

      strategized = true;

      // The next round must use a fresh session to break anchoring
      // (docs/design/phase-chain.md §3.4).
      // Set a pendingReworkStrategy so the loop picks it up at phase 1.
      roundRecord.pendingReworkStrategy = {
        tierDelta: 0,
        newSession: true,
        reason: "strategized: new session (anchoring break per docs/design/phase-chain.md §3.4)",
      };

      // Re-persist after strategize updates roundRecord and strategized flag
      const updatedTotals = computeChainTotals(records);
      persistChainState({
        chainDir, round, roundRecord, chainId, container, model, modelChain,
        reviewModel, reviewModelChain,
        reworkModel, reworkModelChain, reworkBackend,
        maxRounds, brief, orchestrator, records, baseSha: effectiveBaseSha,
        chainTotals: updatedTotals, strategized: true, chainFollowupDraft,
        verifyBaseline: effectiveVerifyBaseline,
      });
    }
    return { done: false };
  }

  try {
    // Round loop (kusabi #60 step 2).  The for-condition is the HARD CAP:
    // total rounds never exceed 2 × maxRounds (every mechanical round is
    // bought by the design/full round that preceded it), so a chain can never
    // run unbounded.  The budget check inside the body stops the loop when
    // maxRounds design/full rounds are spent.
    for (let round = startRound; round <= 2 * maxRounds; round++) {
      // ---- stop check: honour file-based stop request or signal ----
      if (shouldStopNow({ chainDir, signalReceived: signalReceived() })) {
        finalizeChainControl({ chainDir, status: "cancelled", round: round - 1 });
        return `Chain ${chainId} cancelled at round ${round} (stop requested).`;
      }

      const isFirstRound = !resume && round === 1;
      const hasPreviousRound = round > 1 && records.length > 0;
      const previousRecord = hasPreviousRound ? records[records.length - 1] : null;

      // ---- review-resume: continue this round from its review phase ----
      // Two ways in: the round was INTERRUPTED before review ran (#153①), or
      // its review seat died and the chain escalated on it, so the resume
      // buys a replacement seat for the same round (#248).  Both continue the
      // persisted record in place and dispatch review, never implement.
      if (resume && resume.phase === "review" && round === resume.round) {
        const roundRecord = resume.roundRecord;
        roundRecord.resumed = true;
        const reviewCtx = await collectReviewContext({
          container, brief, callTool,
          // The interrupted round's changes ARE the review target.  A baseline
          // captured now would read as "nothing changed since baseline" and
          // skip the review (shouldSkipReview discards an empty change set);
          // use the full changed set instead.
          worktreeBaseline: null,
        });
        // ---- replacement review seat (kusabi #248) ----
        // This round already ran a review; the SEAT died mid-stream and the
        // chain escalated on it.  Archive that seat before the replacement
        // review writes over the record's review fields, so the record keeps
        // saying a first seat failed instead of silently claiming the
        // replacement's verdict was the only one.  The round record itself is
        // continued in place (no second record, no second round row).
        if (resume.reviewSeatReplacement) {
          // ---- loud refusal on an empty change set (kusabi #248 follow-up) ----
          // A replacement review reviews the CHANGES this round made.  When
          // the collected change set is empty, the container no longer holds
          // the round's changes (fresh clone, reset worktree): the review/skip
          // machinery would skip the review and hand the user a silent
          // discard-escalate.  Refuse loudly instead.  Nothing is persisted on
          // this path, so the chain record stays exactly as the escalate left
          // it -- it never claims a review happened -- and the user is told to
          // re-run the chain.  Only the seat-replacement entry refuses: an
          // interrupted round (#153) legitimately reviews whatever the
          // worktree holds -- its escalate-on-empty is pre-existing behaviour.
          if (shouldSkipReview({
            chainStatusObserved: reviewCtx.chainStatusObserved,
            chainChangedPaths: reviewCtx.chainChangedPaths,
            chainNewlyChanged: reviewCtx.chainNewlyChanged,
            chainDeliverables: reviewCtx.chainDeliverables,
          })) {
            throw new Error(
              `cannot resume chain ${chainId} with a replacement review seat: the container no longer holds ` +
              `round ${round}'s changes (the collected change set is empty -- fresh clone or reset worktree), ` +
              `so a replacement review has nothing to review.  Re-run the chain instead; the chain record was ` +
              `left untouched (no review was dispatched, nothing was escalated).`
            );
          }
          archiveFailedReviewSeat(roundRecord);
        }
        const probeCtx = {
          probesGreen: roundRecord.probesGreen ?? false,
          // The probe truth here is RECORDED — measured before the stop or
          // the seat escalate, on a worktree that may have moved since.  It
          // is good enough to buy a rework (whose own round re-measures), but
          // an accept must re-measure before finalising on it (kusabi #262);
          // this flag is what tells finishRound the truth is second-hand.
          probesFromRecord: true,
          // The oracle marker is recorded truth too (kusabi #197): a round
          // that escalated on a frozen-path edit must still escalate when a
          // replacement review seat approves it.  Old records have no field;
          // absent reads as "no violation recorded", which is what it was.
          oracleViolation: roundRecord.oracleViolation ?? false,
          chainChangedPaths: reviewCtx.chainChangedPaths,
          chainNewlyChanged: reviewCtx.chainNewlyChanged,
          chainStatusObserved: reviewCtx.chainStatusObserved,
          chainStatusOutput: reviewCtx.chainStatusOutput,
          chainBaseLog: reviewCtx.chainBaseLog,
          chainDeliverables: reviewCtx.chainDeliverables,
          chainUntracked: reviewCtx.chainUntracked,
          chainTruncation: reviewCtx.chainTruncation,
          worktreeChanged: reviewCtx.worktreeChanged,
        };
        const result = await finishRound({
          round,
          roundRecord,
          // The interrupted round is the last record in `records`; the
          // previous COMPLETE round is the one before it.
          previousRecord: records.length >= 2 ? records[records.length - 2] : null,
          probeCtx,
          // No implement job runs on this path, so the refusal is READ from
          // the persisted record (kusabi #293): runImplementPhase stamps the
          // parsed descriptor at parse time, and the interrupted round was
          // persisted with it -- a stop between implement and finishRound
          // (kusabi #153①) must not convert an honest refusal into a worker
          // discard on resume.  Records predating the stamp read as null and
          // route exactly as they did before refusals existed.
          implementRefusal: roundRecord.implementRefusal ?? null,
        });
        if (result.done) return result.text;
        continue;
      }

      // ---- budget check (kusaba #60 step 2) ----
      // maxRounds buys design/full rounds only; mechanical rounds are free.
      // Budget is DERIVED from the records (never persisted), so a resumed
      // chain recomputes it from records alone.  Placed after the
      // review-resume branch: a resumed interrupted round already spent its
      // budget slot and must be allowed to finish its review.
      const budgetUsed = records.filter(function (r) {
        return r.reworkScope !== "mechanical";
      }).length;
      if (budgetUsed >= maxRounds) break;

      // ---- rework scope for this round (kusabi #60 step 2) ----
      // Single decision point: resolveReworkScope maps the previous round's
      // findings to "full" | "mechanical" | "design" plus the scoped subset.
      // The result feeds both the implement brief and the budget accounting;
      // the round record stores the scope it was RUN with.
      const scopeResolution = resolveReworkScope(previousRecord);

      // ---- phase 1: resume strategy (B2: derive rework levers when rework) ----
      let useNewSession = false;
      let reworkStrategyReason = null;
      let reworkStrategy = null;

      if (isFirstRound) {
        // First round: no session to continue from.
        useNewSession = false;
      } else if (previousRecord?.pendingReworkStrategy) {
        // Use the rework strategy computed at the end of the previous round.
        reworkStrategy = previousRecord.pendingReworkStrategy;
        useNewSession = reworkStrategy.newSession;
        reworkStrategyReason = reworkStrategy.reason;
      }

      const { resumeMethod } = resolveRoundResume({ useNewSession });

      // ---- phase 2: round model selection ----
      // Use currentTierIndex (never round) so tier is decoupled from the round counter.
      // For review, the reviewer stays on tier 0 (round 1) — that's handled in
      // runReviewPhase which passes round=1 to dispatchWithFallback.

      // ---- per-round implement dispatch context (kusabi #192 axis 2) ----
      // Round 1 dispatches from the implement resolution; every LATER round
      // is a rework round and dispatches from the rework resolution when
      // models.phases.rework is configured (absent key \u2192 the implement
      // resolution \u2014 byte-identical to today).  The tier ladder climbs over
      // the same chain the round dispatches on: currentTierIndex addresses
      // the implement chain during round 1 and the rework chain from
      // round 2 on (the first rework starts at the rework chain's tier 0).
      const isReworkRound = !isFirstRound;
      const roundModelChain = isReworkRound ? effectiveReworkChain : modelChain;
      const roundBackend = isReworkRound ? effectiveReworkBackend : backend;
      const roundDispatch = isReworkRound ? effectiveReworkDispatch : injectedDispatch;

      // ---- session lineage guard (kusabi #192 invariant 5) ----
      // A session never crosses backends: a rework implement round may only
      // continue a session created by the backend THIS round dispatches on
      // (the rework backend on rework rounds); otherwise it starts fresh.
      // The cross-round `session` is the implement job's session, so when it
      // traces to a record of the OTHER backend (only possible across a
      // chain-resume or a round-1/rework backend switch) it is dropped here,
      // and the same guard inside runImplementPhase covers its
      // previousRecord.sessionID fallback.  Its provenance is dropped with
      // it — an agy dispatch must never see a claude-attributed id.
      if (session && !isFirstRound && previousRecord && (previousRecord.backend ?? "opencode") !== roundBackend) {
        session = null;
        provenance = null;
      }

      // ---- phase 3: implement text + dispatch ----
      const implementText = buildImplementText({ round, brief, previousRecord, container, reworkScope: scopeResolution });
      const {
        roundRecord,
        session: resolvedSession,
        sessionProvenance,
        implementJobStatus,
        implementJobError,
        implementJobFailure,
        implementRefusal,
      } = await runImplementPhase({
        cwd, chainId, round, isFirstRound, implementText, modelChain: roundModelChain,
        tierIndex: currentTierIndex,
        useNewSession, session, sessionProvenance: provenance, previousRecord, resumeMethod, flagsModel,
        backend: roundBackend,
        _dispatchWithFallback: roundDispatch,
      });
      session = resolvedSession;
      // The provenance follows the session: the next round's dispatch needs
      // it when (and only when) it cannot re-derive it from the round record
      // (runImplementPhase falls back to this for a session that is not the
      // previous record's — a chain-resume's initialSession whose recorded
      // job returned a different id, say).
      provenance = sessionProvenance ?? null;

      // No compensation here (kusabi #323): runImplementPhase now reports the
      // session its dispatch actually used or created — for a useNewSession
      // round that is the conversation the fresh dispatch CREATED, never the
      // one it was told to walk away from — so the carry is already the right
      // hand-off for round N+1.  (kusabi #320 cleared it here; that
      // compensation was removed when the seam started reporting the truth.)
      // The carry still crosses no backend: the lineage guard above and
      // runImplementPhase's previousRecord fallback refuse foreign sessions.

      // The chain record carries the dispatch backends (kusabi #184 / #192);
      // the phase functions stay backend-blind, so they are stamped here.
      // Round records persist them via persistChainState (round-N.json and
      // the records array in chain.json); readers treat a missing `backend`
      // field as "opencode" and a missing `reviewBackend` as the record's
      // implement backend.  `reviewBackend` is always set.  Each round's
      // `backend` is the backend its implement job ACTUALLY used \u2014 round 1
      // the implement backend, rework rounds the rework backend (axis 2).
      roundRecord.backend = roundBackend;
      roundRecord.reviewBackend = reviewBackend;

      // Record lever info on the round record (B8)
      roundRecord.tierBefore = currentTierIndex;
      roundRecord.reworkStrategyReason = reworkStrategyReason;
      roundRecord.reworkCount = reworkCount;

      // The scope this round was RUN with (kusabi #60 step 2): "full" when
      // not a scoped rework.  Stored verbatim like every other record field;
      // budget is never persisted — it is derived by counting records whose
      // reworkScope is not "mechanical".
      roundRecord.reworkScope = scopeResolution.scope;

      // Resume trace: this round was (re)started by chain-resume.
      if (resume && resume.phase === "implement" && round === resume.round) {
        roundRecord.resumed = true;
      }

      // ---- stop on implement provider exhaustion ----
      if (implementJobStatus === "provider-error") {
        const { chainState, outcome } = handleProviderExhaustion({
          records, roundRecord,
          currentTierIndex, phase: "implement", jobError: implementJobError,
          jobFailure: implementJobFailure,
          chainId, round, container, model, modelChain,
          reviewModel, reviewModelChain,
          reworkModel, reworkModelChain, reworkBackend,
          maxRounds, brief, orchestrator, baseSha: effectiveBaseSha,
          strategized, chainFollowupDraft: null,
          verifyBaseline: effectiveVerifyBaseline,
        });
        writeJson(path.join(chainDir, "round-" + round + ".json"), roundRecord);
        writeJson(path.join(chainDir, "chain.json"), chainState);
        finalizeChainControl({ chainDir, status: "failed", round });
        return outcome;
      }

      // ---- phase 4: deterministic probes (P1–P6) ----
      const probeResult = await runProbePhase({
        baseSha: effectiveBaseSha, container, brief, callTool,
        worktreeBaseline: effectiveBaseline, verifyBaseline: effectiveVerifyBaseline,
      });
      roundRecord.probesGreen = probeResult.probesGreen;
      roundRecord.probeResults = probeResult.probeResults;
      roundRecord.worktreeChanged = probeResult.worktreeChanged;
      // The P5/P6 oracle marker (kusabi #197) is persisted like any other
      // probe truth: a review-resume of this round reads it back, so a frozen
      // edit cannot be forgotten by the round that carried it.
      roundRecord.oracleViolation = probeResult.oracleViolation;

      // ---- stop check: a stop requested during implement must not buy a
      // review job, and must not leave the container busy while the
      // orchestrator inspects it.  Placed after the probes rather than
      // before them so the worktree is left in the canonical post-P1 state
      // (HEAD == base, changes unstaged) that the orchestrator publishes from.
      // The partial round (implement + probes done) is PERSISTED so the chain
      // is resumable (kusabi #153①) and control round matches actual progress.
      if (shouldStopNow({ chainDir, signalReceived: signalReceived() })) {
        const partialTotals = computeChainTotals([...records, roundRecord]);
        persistChainState({
          chainDir, round, roundRecord, chainId, container, model, modelChain,
          reviewModel, reviewModelChain,
          reworkModel, reworkModelChain, reworkBackend,
          maxRounds, brief, orchestrator, records, baseSha: effectiveBaseSha,
          chainTotals: partialTotals, strategized, chainFollowupDraft: null,
          interrupted: true,
          verifyBaseline: effectiveVerifyBaseline,
        });
        finalizeChainControl({ chainDir, status: "cancelled", round });
        return `Chain ${chainId} cancelled during round ${round} (stop requested after probes, before review). Progress preserved — resume with chain-resume ${chainId}.`;
      }

      const result = await finishRound({
        round,
        roundRecord,
        previousRecord,
        probeCtx: probeResult,
        implementRefusal,
      });
      if (result.done) return result.text;
    }

    // ---- max rounds reached without acceptance ----
    // The budget/hard-cap terminal can fire after more than maxRounds RAW
    // rounds (mechanical rounds are free), so the recorded round is the
    // actual number of completed rounds — never the nominal maxRounds —
    // keeping control.round and the review record consistent with the
    // persisted round-N.json files (kusabi #60 step 2 review).
    const actualRounds = records.length;
    finalizeChainControl({ chainDir, status: "completed", round: actualRounds });
    return finaliseChain(
      renderMaxRoundsOutcome({ chainId, maxRounds, records, orchestrator }),
      { disposition: "max-rounds", round: actualRounds },
      actualRounds,
    );
  } catch (err) {
    // Exception thrown mid-round — record failure and rethrow
    finalizeChainControl({ chainDir, status: "failed", round: records.length });
    throw err;
  } finally {
    // Stop the serve for this cwd unless --keep-serve or another job is running
    if (!keepServe) {
      try {
        // liveRunningJobs applies the same fossil rule as cmdServeStop: a
        // `running` record whose driver died (no activity for 6+ hours) does
        // not count as a live job and must not pin the serve (kusabi #175).
        const hasRunning = liveRunningJobs(stateDir).length > 0;
        if (!hasRunning) {
          cmdServeStop(cwd);
        }
      } catch { /* best-effort */ }
    }
  }
}

// ---------------------------------------------------------------------------
// chain-resume (kusabi #153①)
// ---------------------------------------------------------------------------

export async function cmdChainResume(cwd, { flags, text }) {
  // Resumption context comes entirely from the saved chain state (chain.json
  // brief, records, ladder; control.json container).  Accepting another flag
  // and ignoring it would answer a different question than the one asked.
  const unsupported = Object.keys(flags).filter(function (k) { return k !== "keepServe"; });
  if (unsupported.length > 0) {
    throw new Error(
      `chain-resume does not support --${unsupported[0]}: resumption context comes from the saved chain state (chain.json / control.json)`
    );
  }

  const stateDir = stateDirFor(cwd);
  const chainId = text.split(/\s+/).filter(Boolean)[0];
  if (!chainId) throw new Error("chain-resume requires a chain id. Usage: chain-resume <chainId>");

  const chainDir = path.join(stateDir, "chains", chainId);
  if (!fs.existsSync(chainDir)) {
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

  // ---- resume-position decision, from the records alone ----
  const resolution = resolveChainResume({ control, chainJson });
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
  // The backends are not flags here: resumption context comes from the saved
  // chain state, and the chain record's backend fields are part of it.  The
  // implement backend is the last record's `backend`; the review backend is
  // the last record's `reviewBackend`, falling back to the record's
  // implement backend on records predating the per-phase split.  A missing
  // `backend` field means the chain predates the backend split → opencode.
  const lastResumeRecord = chainJson.records?.[chainJson.records.length - 1] ?? null;
  const resumeBackend = lastResumeRecord?.backend || "opencode";
  const resumeReviewBackend = lastResumeRecord?.reviewBackend ?? resumeBackend;

  // The dispatch seams for the resumed run.  The REVIEW seam is always
  // explicit (resolveResumeDispatches): an opencode review gets the plain
  // opencode dispatch, so a mixed chain (implement claude / review opencode)
  // resumes review on opencode — never on the claude implement dispatch
  // (kusabi #192 finding).  Each claude phase clamps to ITS OWN recorded
  // model — no tier ladder, no mid-chain model switch (kusabi #184 finding 1).
  // Per-phase review dispatch context (kusabi #192): a #192-era chain.json
  // persists reviewModel/reviewModelChain \u2014 persisted null on a mixed chain
  // (opencode review) must stay null, never silently borrow the implement
  // chain; a pre-#192 chain.json has neither key, and key ABSENCE is the
  // legacy marker \u2014 fall back to the implement model/chain (pre-#192
  // clamped the whole chain to chainJson.model).
  const { reviewModel: resumeReviewModel, reviewModelChain: resumeReviewModelChain } =
    resolveResumeReviewContext(chainJson);
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
      signalReceived: () => signalReceived,
      keepServe: !!flags.keepServe,
      resume: position,
    });
  } finally {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  }
}
