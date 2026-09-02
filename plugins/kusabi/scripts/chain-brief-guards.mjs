// chain-brief-guards: dispatch-time brief guards evaluated before any chain
// state or job exists.
//
// Leaf module: must not import chain-driver.mjs or kusabi-companion.mjs.
// Extracted from chain-driver.mjs (kusabi #422 Job 1) — same output strings,
// same exit codes.  Callers import from here; chain-driver.mjs and
// kusabi-companion.mjs no longer re-export these names.

import {
  briefRequestsPublish,
  findSmokeViolations,
  SMOKE_VIOLATION_NO_ENTRIES,
  parseSmoke,
} from "./brief-parsing.mjs";
import { checkSmokeProbe } from "./probe-decisions.mjs";
import { runSmokeEntries, captureGitStatusPorcelain } from "./chain-phases.mjs";

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
    "受後にオーケストレーターが publish を行う。"
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
      lines.push("    \u2500\u2500 output tail \u2500\u2500");
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
// work — the same wrongful-conviction class the baseline refusal exists for,
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
 * in — a dirtied worktree, a moved HEAD, or both — from the captures taken
 * immediately before and after the run; null when the smoke demonstrably left
 * both unchanged.
 *
 * Pure: the caller does the running.  The worktree comparison is the DELTA —
 * lines in the after-capture that were not in the before-capture — because
 * the guard is about what THIS smoke added to the tree the worker is handed,
 * not about whatever pre-existing dirt the prepared container may already
 * carry.  Only the delta lines are named, so the author sees exactly what the
 * command wrote.  HEAD is compared as a whole instead: there is no "pre-
 * existing" HEAD move to forgive, and the porcelain listing cannot show one
 * at all (kusabi #292 follow-up) — a smoke that commits leaves a listing
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
