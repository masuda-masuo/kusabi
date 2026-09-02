// chain-probes.mjs — Deterministic probe helpers for the chain.
//
// Leaf module: does not import chain-phases.mjs, chain-driver.mjs,
// chain-cmd.mjs, chain-finish.mjs, or kusabi-companion.mjs.
//
// Extracted from chain-phases.mjs (kusabi #425 Job 4) — same
// definitions, same semantics.  runProbePhase lives in chain-run.mjs
// (kusabi #447) and imports individual probes from here.

import { parseChangedPaths } from "./brief-parsing.mjs";
import { checkSmokeProbe } from "./probe-decisions.mjs";
import {
  captureWorktreeState,
  computeNewlyChanged,
  resolveWorktreeChanged,
  checkDeliverablesSinceBaseline,
} from "./worktree-baseline.mjs";

/**
 * Read one `sandbox_exec` result into its text plus what the server said about
 * its own paging.
 *
 * sandbox_exec pages at `limit` (default 50) and reports the cut in
 * `truncated` / `has_more`.  Call sites that read only `.output` cannot tell a
 * complete capture from page one of many -- which is exactly how a 50-line
 * slice of a diff reached the reviewer looking whole (kusabi #208).  A line
 * count cannot substitute for the flags: "exactly 50 lines" is
 * indistinguishable from a genuinely 50-line output.
 *
 * Only ONE count is taken from the response: `total_lines`, the denominator.
 * `shown` is deliberately not read -- measured against the live server it
 * equals `total_lines` even on a response that WAS cut (`seq 1 100` at
 * limit=10 returns 10 lines and reports shown=101, total_lines=101), so
 * rendering it produced "truncated (showing 101 of 101 lines)": a label that
 * announces a cut and then prints numbers saying nothing was withheld.  The
 * numerator is derived where the block is rendered, from the lines that block
 * actually holds (`captureCutNote`, render.mjs).
 *
 * @param {object|null|undefined} result  A sandbox_exec result envelope.
 * @returns {{ text: string, truncation: { truncated: boolean, total: number|null } }}
 */
export function readExecCapture(result) {
  return {
    text: result?.output ?? "",
    truncation: {
      // The OR is load-bearing, not redundant: summary truncation and paging
      // are independent layers, and the server can report a cut capture with
      // `truncated: false, has_more: true` (measured: `seq 1 60` at limit=25
      // returns 25 lines with truncated=false, has_more=true).  Either flag
      // means this text is not the whole output; do not simplify this to
      // `truncated` alone.
      truncated: result?.truncated === true || result?.has_more === true,
      total: Number.isInteger(result?.total_lines) ? result.total_lines : null,
    },
  };
}

// =========================================================================
// Deterministic probes — P1, P2, P3, P4 (P5/P6 are further down, beside
// runDeliverablesProbe, because they consume what P2/P3 produce)
//
// These are also used by cmdTask so they are exported from this module and
// re-exported from kusabi-companion.mjs for backward-compatible test imports.
// =========================================================================

/**
 * Read a bounded tail of a smoke command's captured output for diagnostics.
 */
async function readSmokeOutputTail(callTool, container, outfile) {
  try {
    const result = await callTool("sandbox_exec", {
      container_id: container,
      commands: [
        `if [ -f "${outfile}" ]; then tail -n 40 "${outfile}" | tail -c 2000; else echo '(no output)'; fi`,
      ],
    });
    const output = ((result?.output ?? "") + (result?.stderr ?? "")).trim();
    return output || "(empty)";
  } catch {
    return "(diagnostics unavailable)";
  }
}

/**
 * Run a single smoke command entry and observe its exit code.
 *
 * The command's stdout/stderr is redirected to a file inside the container so
 * that the **only** text returned by sandbox_exec is the `SMOKE_EXIT=N` marker
 * line — never subject to pagination truncation regardless of how much output
 * the command produces.
 *
 * @param {object}   opts
 * @param {{command: string, expectedExit: number}} opts.entry
 * @param {Function} opts.callTool    The RPC callTool function (injectable).
 * @param {string}   opts.container   Container ID.
 * @param {number}   opts.entryIndex  Index within the entries array (for unique filename).
 * @returns {Promise<{command: string, observed: number|string, diagnostic?: string}>}
 */
export async function runSmokeEntry({ entry, callTool, container, entryIndex }) {
  const outfile = `/tmp/kusabi-smoke-${Date.now()}-${entryIndex}.log`;
  const wrappedCommand = `( ${entry.command} ) >${outfile} 2>&1; echo SMOKE_EXIT=$?`;

  try {
    const smokeResult = await callTool("sandbox_exec", {
      container_id: container,
      commands: [wrappedCommand],
      timeout: 300,
    });

    if (smokeResult?.status === "timeout") {
      const diagnostic = await readSmokeOutputTail(callTool, container, outfile);
      return { command: entry.command, observed: "timeout", diagnostic };
    }

    const smokeOutput = (smokeResult?.output ?? "") + (smokeResult?.stderr ?? "");
    const exitMatches = [...smokeOutput.matchAll(/SMOKE_EXIT=(\d+)/g)];
    const lastMatch = exitMatches.length > 0 ? exitMatches[exitMatches.length - 1] : null;

    if (!lastMatch) {
      const diagnostic = await readSmokeOutputTail(callTool, container, outfile);
      return { command: entry.command, observed: "unobservable", diagnostic };
    }

    const exitCode = parseInt(lastMatch[1], 10);

    if (exitCode !== entry.expectedExit) {
      const diagnostic = await readSmokeOutputTail(callTool, container, outfile);
      return { command: entry.command, observed: exitCode, diagnostic };
    }

    return { command: entry.command, observed: exitCode };
  } catch (smokeErr) {
    const isTimeout = String(smokeErr).includes("timeout");
    const diagnostic = isTimeout
      ? await readSmokeOutputTail(callTool, container, outfile).catch(() => "")
      : undefined;
    return {
      command: entry.command,
      observed: isTimeout ? "timeout" : String(smokeErr),
      diagnostic,
    };
  }
}

/**
 * Run every declared smoke entry and return the raw observations.
 *
 * The executor half of the smoke probe, split out of runSmokeProbe unchanged
 * so the pre-dispatch baseline run (kusabi #292) shares this exact loop: a
 * second executor would drift from the one the post-round probe uses, and the
 * whole point of the baseline is that it measures the same thing at a
 * different moment.  The verdict half stays in checkSmokeProbe; runSmokeProbe
 * below is the two composed.
 */
export async function runSmokeEntries({ entries, callTool, container }) {
  const entriesArr = Array.isArray(entries) ? entries : [];
  const observed = [];
  for (let i = 0; i < entriesArr.length; i++) {
    const result = await runSmokeEntry({ entry: entriesArr[i], callTool, container, entryIndex: i });
    observed.push(result);
  }
  return observed;
}

// A listing this big cannot be a realistic `git status --porcelain` page; the
// point of the explicit window is to defeat sandbox_exec's two independent
// truncation layers (summary head-50/tail-50 and paging), exactly as
// captureWorktreeState does.  A cut capture must never stand in for the whole
// listing here: the guard's verdict is "the smoke left no dirt", and that
// verdict cannot be built from a view that could have dropped the dirt.
const STATUS_CAPTURE_PAGE_LIMIT = 1000000;

/**
 * Read HEAD for the baseline smoke's guard.
 *
 * Deliberately NOT captureBaseSha: that one degrades an unreadable HEAD to
 * null because its caller (the chain's base record) has a per-round probe to
 * catch the consequences.  This caller has none — it is the guard itself —
 * so an unreadable HEAD is a failure record here, in the same shape as the
 * porcelain capture's.  An empty output is such a failure: a working
 * `git rev-parse HEAD` always prints a SHA, so "nothing came back" means the
 * measurement failed, not that HEAD is empty.
 *
 * @param {Function} callTool   The RPC callTool function (injectable).
 * @param {string}   container  Container ID.
 * @returns {Promise<{ok: true, sha: string} | {ok: false, reason: string}>}
 */
async function captureHeadForGuard(callTool, container) {
  let result;
  try {
    result = await callTool("sandbox_exec", {
      container_id: container,
      commands: ["git rev-parse HEAD"],
    });
  } catch (err) {
    return { ok: false, reason: `git rev-parse HEAD could not be run: ${err?.message ?? String(err)}` };
  }
  if (result === null || result === undefined) {
    return { ok: false, reason: "git rev-parse HEAD returned no result" };
  }
  const sha = readExecCapture(result).text.trim().split("\n")[0].trim();
  if (sha.length === 0) {
    return { ok: false, reason: "git rev-parse HEAD returned no SHA (HEAD could not be read)" };
  }
  return { ok: true, sha };
}

/**
 * Capture what the baseline smoke must not change: the `git status --porcelain`
 * listing AND the HEAD SHA, both read from inside the container.
 *
 * The read-only measurement the baseline smoke's worktree guard (kusabi #292
 * follow-up) is built on: the baseline runs the declared smoke in the very
 * container the worker is then handed, so a PASSING smoke with write side
 * effects (coverage output, build artifacts, lockfile regeneration, --fix
 * formatters, snapshot updates) would leave the worker a dirtied tree whose
 * untracked artifacts and tracked-file mutations land in the round's diff and
 * review as the worker's work.  Comparing a capture taken immediately before
 * the run with one taken immediately after isolates exactly what the smoke
 * itself added.
 *
 * HEAD rides in the same capture because the porcelain listing CANNOT see it:
 * a smoke that commits, or checks out another SHA, leaves a listing identical
 * to the one before it ran (kusabi #292 follow-up).  That blind spot is worse
 * than dirt — captureBaseSha runs AFTER the baseline, so a smoke-moved HEAD
 * would be recorded as the chain's base and silently become the thing P1, the
 * deliverables probe and the review's diff-vs-base all measure against.  Two
 * numbers from one moment: taking them together is what makes "the smoke
 * changed nothing" a claim about the container rather than about one listing.
 *
 * The capture is requested with truncation defeated (verbose "full" + a
 * page-limit far beyond any real listing) because the verdict depends on the
 * listing being COMPLETE.  When the call throws or the server still reports
 * the output cut, the capture is a failure record, never a partial listing:
 * a guard that is supposed to prove the smoke left no dirt cannot stand on a
 * view that could have dropped the very entry that dirtied the tree.  An
 * unreadable HEAD is the same kind of failure record, for the same reason.
 *
 * @param {Function} callTool   The RPC callTool function (injectable).
 * @param {string}   container  Container ID.
 * @returns {Promise<{ok: true, lines: string[], head: string} | {ok: false, reason: string}>}
 */
export async function captureGitStatusPorcelain(callTool, container) {
  let result;
  try {
    result = await callTool("sandbox_exec", {
      container_id: container,
      commands: ["git status --porcelain"],
      verbose: "full",
      limit: STATUS_CAPTURE_PAGE_LIMIT,
    });
  } catch (err) {
    return { ok: false, reason: `git status could not be run: ${err?.message ?? String(err)}` };
  }
  if (result === null || result === undefined) {
    return { ok: false, reason: "git status returned no result" };
  }
  const capture = readExecCapture(result);
  if (capture.truncation.truncated) {
    return { ok: false, reason: "git status output was truncated (the listing is not complete)" };
  }
  const lines = capture.text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const head = await captureHeadForGuard(callTool, container);
  if (head.ok !== true) return { ok: false, reason: head.reason };
  return { ok: true, lines, head: head.sha };
}

/**
 * Run all smoke entries and return the P4 probe result.
 */
export async function runSmokeProbe({ entries, callTool, container, headingPresent }) {
  const entriesArr = Array.isArray(entries) ? entries : [];
  const hdgPresent = !!headingPresent;

  if (entriesArr.length === 0) {
    return checkSmokeProbe([], [], hdgPresent);
  }

  const observed = await runSmokeEntries({ entries: entriesArr, callTool, container });

  return checkSmokeProbe(entriesArr, observed, true);
}

/**
 * P1: Check that HEAD matches the recorded base SHA.
 * When HEAD differs, auto-reset via git reset --mixed.
 */
export async function runHeadCleanProbe({ baseSha, callTool, container, sourceLabel = "task" }) {
  let passed = false;
  let detail = "";
  if (baseSha) {
    const gitRev = await callTool("sandbox_exec", {
      container_id: container,
      commands: ["git rev-parse HEAD"],
    });
    const headSha = (gitRev?.output ?? "").trim();
    if (headSha !== baseSha) {
      detail = "HEAD " + headSha + " != base " + baseSha + "; auto reset";
      try {
        await callTool("sandbox_exec", {
          container_id: container,
          commands: ["git reset --mixed " + baseSha],
        });
        passed = true;
        detail += " - reset OK";
      } catch (resetErr) {
        detail += " - reset FAILED: " + String(resetErr);
      }
    } else {
      passed = true;
      detail = "HEAD matches base " + baseSha;
    }
  } else {
    detail = "baseSha not recorded at " + sourceLabel + " start; cannot check HEAD";
  }
  return { probe: "P1: HEAD clean", passed, detail };
}

/**
 * Count the violations reported for one gate in a verify result.
 *
 * Counting authority (kusabi #173): the `lint` / `types` arrays in the
 * verify result are complete — one element per violation (verified against
 * live sunaba output 2026-08-08).  Array length is therefore the
 * authoritative count.  When the array is absent (older responses, or the
 * gate never ran) the gate's own summary line in `gate_fail_reasons` is the
 * fallback, matching sunaba gate.py's real formats: "lint (<tool>): <N>
 * violation(s)" and "type_check (<tool>): <N> error(s)".  When neither
 * yields a number the count is null, and callers must treat null as "no reliable
 * count" (the probe records the limitation and keeps today's strict
 * behaviour instead of passing blind).
 *
 * @param {object|null} verifyResult  — the verify_in_container result.
 * @param {"lint"|"types"} gate       — which gate to count.
 * @returns {number|null} Violation count, or null when not countable.
 */
export function countVerifyViolations(verifyResult, gate) {
  if (!verifyResult || typeof verifyResult !== "object") return null;
  const arr = verifyResult[gate];
  if (Array.isArray(arr)) return arr.length;
  const reasons = Array.isArray(verifyResult.gate_fail_reasons)
    ? verifyResult.gate_fail_reasons
    : [];
  // Real sunaba gate.py summary formats (verified against gate.py source and
  // live output 2026-08-08): lint → "lint (<tool>): <N> violation(s)",
  // types → "type_check (<tool>): <N> error(s)".
  const re = gate === "types"
    ? /^type_check\b[^:]*:\s*(\d+)\s+error/i
    : /^lint\b[^:]*:\s*(\d+)\s+violation/i;
  for (const reason of reasons) {
    const m = String(reason).match(re);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Count the tests a verify result actually RAN (kusabi #197, the P6 oracle).
 *
 * "Verify green" means "the tests that ran passed", not "the tests still
 * exist": a dependency drift once made 273 of 607 tests uncollectable (an
 * import failure makes tests stop existing rather than fail) while verify
 * stayed green.  The number below is what makes that visible.
 *
 * Counting authority: the STRUCTURED fields of the verify result, never a
 * substring match on free text.  `tests.full.total` is the count of tests the
 * full run collected (verified against live sunaba output on this repo,
 * 2026-08-15: `{"tests": {"full": {"status": "ok", "duration": 25.1,
 * "passed": 2033, "total": 2033}}}`).  When `total` is absent but the run
 * reported passed/failed counts, their sum is the number that ran.  When
 * neither is derivable the count is null — never a guess: a fabricated count
 * would either mask a real decrease or invent one.
 *
 * `tests.full` is absent whenever the tests did not run at all (the lint/type
 * precondition failed, `tests.status === "skipped"`), which is null for the
 * same reason: no tests ran, so no count was measured.
 *
 * @param {object|null} verifyResult  — a verify_in_container result.
 * @returns {number|null} Tests collected by the full run, or null when not countable.
 */
export function countVerifyCollected(verifyResult) {
  const full = verifyResult?.tests?.full;
  if (!full || typeof full !== "object") return null;
  if (Number.isInteger(full.total)) return full.total;
  const passed = Number.isInteger(full.passed) ? full.passed : null;
  const failed = Number.isInteger(full.failed) ? full.failed : null;
  if (passed === null && failed === null) return null;
  return (passed ?? 0) + (failed ?? 0);
}

/**
 * Build the chain-start verify baseline record from a verify result.
 *
 * @param {object|null} verifyResult
 * @returns {{ captured: true, gate_passed: boolean, lint: number|null, types: number|null,
 *             collected: number|null, raw: object }}
 */
export function buildVerifyBaseline(verifyResult) {
  return {
    captured: true,
    gate_passed: verifyResult?.gate_passed === true,
    lint: countVerifyViolations(verifyResult, "lint"),
    types: countVerifyViolations(verifyResult, "types"),
    // The count of tests the base itself runs (kusabi #197).  Recorded at
    // chain start beside the lint/type counts and reused by every round —
    // chain-resume included, which never re-captures on a modified worktree.
    collected: countVerifyCollected(verifyResult),
    raw: verifyResult ?? null,
  };
}

/**
 * P2: Run the verify gate (verify_in_container) with no skip flags.
 *
 * Gate passed → PASS, byte-identical to the pre-#173 behaviour.  Gate failed
 * with test failures → FAIL, unchanged.  Gate failed on the lint/type
 * precondition (tests never ran) → the chain-start verify baseline decides:
 * current violation counts ≤ baseline for every gate that failed → re-run
 * verify with the tolerated gates skipped (so tests actually execute) and
 * pass iff that run's tests are green; any count above baseline → FAIL naming
 * the increment.  Without a baseline (or without a reliable count) the probe
 * records the limitation and keeps today's strict FAIL rather than guessing.
 *
 * @param {object}   opts
 * @param {Function} opts.callTool
 * @param {string}   opts.container
 * @param {object|null} [opts.baseline] — chain-start verify baseline
 *        (`captureVerifyBaseline` output), or null for strict behaviour.
 * @returns {Promise<object>} { probe, passed, detail, collected }
 *   `collected` is the number of tests the run that actually executed tests
 *   collected (null when no run got that far) — P6 reads it off this result
 *   instead of issuing a verify call of its own.
 */
export async function runVerifyProbe({ callTool, container, baseline }) {
  // P6 (kusabi #197) must not run verify a second time per round: P2 already
  // ran it, so the collected-test count is stamped onto EVERY return path of
  // the gate below by this wrapper.  `collected` follows the run whose tests
  // actually executed — the tolerated re-run when there was one, otherwise
  // the first call (null when the tests never ran at all).
  const counted = { collected: null };
  const result = await runVerifyGate(counted, { callTool, container, baseline });
  result.collected = counted.collected;
  return result;
}

/**
 * The P2 gate itself.  Split out only so `runVerifyProbe` can stamp the
 * collected count on every return path without threading it through nine
 * return statements (a field a future branch could silently forget).
 *
 * @param {{collected: number|null}} counted  — out-parameter for the count.
 * @param {object} opts  — as runVerifyProbe.
 * @returns {Promise<object>} { probe, passed, detail }
 */
async function runVerifyGate(counted, { callTool, container, baseline }) {
  const verifyResult = await callTool("verify_in_container", {
    container_id: container,
    path: ".",
  });
  counted.collected = countVerifyCollected(verifyResult);

  // Fast path: gate green → PASS (byte-identical to today).
  if (verifyResult?.gate_passed === true) {
    return { probe: "P2: verify gate", passed: true, detail: JSON.stringify(verifyResult) };
  }

  // Gate failed.  Distinguish "tests ran and failed" from "lint/type
  // precondition failed (tests never ran)".  sunaba runs the lint/type gates
  // as a precondition: when they fail, `tests` reports `status: "skipped"`
  // and the test phase never ran.  When tests did run (`tests.full` exists),
  // their verdict is authoritative — the baseline must never skip it.
  const tests = verifyResult?.tests;
  const testsRan = !!(tests && typeof tests === "object" && tests.full);
  if (testsRan) {
    return { probe: "P2: verify gate", passed: false, detail: JSON.stringify(verifyResult) };
  }

  // Precondition failure: only the baseline path can make this a PASS.
  if (!baseline || baseline.captured !== true) {
    return {
      probe: "P2: verify gate",
      passed: false,
      detail: JSON.stringify(verifyResult),
      limitation: "verify failed on the lint/type precondition but no chain-start baseline is recorded; P2 stayed strict",
    };
  }

  const lintCount = countVerifyViolations(verifyResult, "lint");
  const typesCount = countVerifyViolations(verifyResult, "types");
  const tolerances = [];
  const skips = {};

  // A gate "failed" when it reports violations (count > 0).  For each failed
  // gate, current ≤ baseline → tolerated (skip it on the re-run); current >
  // baseline → FAIL naming the increment.
  if (lintCount !== null && lintCount > 0) {
    if (typeof baseline.lint !== "number") {
      return {
        probe: "P2: verify gate",
        passed: false,
        detail: JSON.stringify(verifyResult),
        limitation: "lint gate failed but the baseline has no reliable lint count; P2 stayed strict",
      };
    }
    if (lintCount > baseline.lint) {
      return {
        probe: "P2: verify gate",
        passed: false,
        detail: `lint ${lintCount} > baseline ${baseline.lint}`,
      };
    }
    tolerances.push(`lint ${lintCount} (baseline ${baseline.lint}, tolerated)`);
    skips.skip_lint_gate = true;
  }
  if (typesCount !== null && typesCount > 0) {
    if (typeof baseline.types !== "number") {
      return {
        probe: "P2: verify gate",
        passed: false,
        detail: JSON.stringify(verifyResult),
        limitation: "types gate failed but the baseline has no reliable types count; P2 stayed strict",
      };
    }
    if (typesCount > baseline.types) {
      return {
        probe: "P2: verify gate",
        passed: false,
        detail: `types ${typesCount} > baseline ${baseline.types}`,
      };
    }
    tolerances.push(`types ${typesCount} (baseline ${baseline.types}, tolerated)`);
    skips.skip_type_gate = true;
  }

  // A gate failed (tests were skipped) but neither gate reports violations we
  // can count → the failure is not a tolerable lint/type delta.  Record the
  // limitation and keep strict behaviour rather than passing blind.
  if (Object.keys(skips).length === 0) {
    return {
      probe: "P2: verify gate",
      passed: false,
      detail: JSON.stringify(verifyResult),
      limitation: "verify failed on the lint/type precondition but no violation counts are reportable; P2 stayed strict",
    };
  }

  // All failed gates are at or under their baseline → re-run with the
  // tolerated gates skipped so the tests actually execute.
  const retryResult = await callTool("verify_in_container", {
    container_id: container,
    path: ".",
    ...skips,
  });
  // This is the run whose tests actually executed, so its count is the round's
  // collected count (kusabi #197).  The first call's tests were skipped by the
  // precondition, so it measured nothing; `??` keeps that null rather than
  // letting an unmeasurable re-run overwrite a count with one.
  counted.collected = countVerifyCollected(retryResult) ?? counted.collected;
  const testsGreen = retryResult?.gate_passed === true;
  // On a failed retry, distinguish "tests ran and failed" from "still blocked
  // before tests" (an untolerated precondition gate — e.g. patch_targets — or
  // an error envelope): claiming "tests not ok" when tests never ran is the
  // exact mislabel this baseline path exists to fix.
  let outcome;
  if (testsGreen) {
    outcome = "tests ok";
  } else if (retryResult?.tests && typeof retryResult.tests === "object" && retryResult.tests.full) {
    outcome = "tests not ok";
  } else {
    const reasons = Array.isArray(retryResult?.gate_fail_reasons) && retryResult.gate_fail_reasons.length > 0
      ? retryResult.gate_fail_reasons.join("; ")
      : "no gate_fail_reasons reported";
    outcome = `still blocked before tests (${reasons})`;
  }
  return {
    probe: "P2: verify gate",
    passed: testsGreen,
    detail: `${tolerances.join(", ")}; ${outcome}`,
  };
}

/**
 * P3: Check that changed files touch declared deliverables.
 *
 * Returns the probe result with `changedPaths`, `statusOutput` and
 * `statusTruncation` (what sandbox_exec reported about the status capture's
 * own paging) attached for the chain call site.
 */
export async function runDeliverablesProbe({ deliverables, headingPresent, callTool, container, baseline }) {
  const statusResult = await callTool("sandbox_exec", {
    container_id: container,
    commands: ["git status --porcelain"],
  });
  // The status capture is paged like any other sandbox_exec call, and a change
  // set can exceed a page.  What the server says about the cut is carried out
  // with the text so the review input can label a partial list as partial
  // (kusabi #208) instead of presenting page one as the whole change set.
  const statusCapture = readExecCapture(statusResult);
  const statusOutput = statusCapture.text;
  const changedPaths = parseChangedPaths(statusOutput);

  // When a baseline is provided, restrict the probe to paths newly changed
  // since that baseline.  Captures current worktree state via GIT_INDEX_FILE
  // temp index — does not modify the real index.
  let effectiveChangedPaths = changedPaths;
  let worktreeChanged = null;
  // null = the since-baseline comparison could not be made.  It must NOT start
  // as [], because [] asserts "nothing changed since the baseline" and callers
  // discard a round on that: an unmeasurable round would be thrown away.  It
  // becomes an array only when the comparison actually ran.
  let newlyChangedPaths = null;

  if (baseline) {
    const currentState = await captureWorktreeState(callTool, container);
    if (currentState) {
      newlyChangedPaths = computeNewlyChanged(baseline, currentState);
      worktreeChanged = resolveWorktreeChanged(baseline, currentState);
      // computeNewlyChanged itself returns null when it cannot compare; only
      // narrow the probe to the newly-changed set when it produced one.
      if (newlyChangedPaths) effectiveChangedPaths = newlyChangedPaths;
    }
    // When currentState is null (per-round capture failed), effectiveChangedPaths
    // stays as changedPaths — a graceful fallback that avoids falsely reporting
    // an empty change set when we simply couldn't measure.
  }

  const probeResult = checkDeliverablesSinceBaseline(deliverables, effectiveChangedPaths, headingPresent);
  probeResult.changedPaths = changedPaths;
  probeResult.newlyChangedPaths = newlyChangedPaths;
  probeResult.statusOutput = statusOutput;
  probeResult.statusTruncation = statusCapture.truncation;
  probeResult.worktreeChanged = worktreeChanged;
  return probeResult;
}

// =========================================================================
// P5 / P6 — the deterministic oracle probes (kusabi #197)
// =========================================================================
//
// Both are PURE: P5 reads the change set P3 already computed, P6 reads the
// count P2 already measured.  Neither adds a container call, and neither
// re-derives evidence another probe owns.
//
// A failure of either carries `oracleViolation: true`.  That marker is the
// whole point of the pair: it routes the round to `escalate`, never to an
// automatic rework, because the correct resolution may be "this deletion is
// legitimate, the human approves it" — a judgement no worker can make and no
// rework round can reach.  Escalate IS the exit (kusabi #173: a deterministic
// check with no exit dead-ends chains).

/**
 * P5: frozen — the round's change set must not touch a declared frozen path.
 *
 * The frozen declaration is the brief's `## Frozen Tests` section; recognition
 * and item syntax are exactly the Deliverables set (`parseFrozenTests`).  The
 * change set is the one P3 already computed — the round's NEWLY changed paths
 * with `runProbePhase`'s fallback applied, so an unmeasurable round is
 * compared against the full changed set rather than against "nothing".
 *
 * Matching is prefix-based in BOTH directions, the same rule P3 uses: a frozen
 * entry naming a directory matches every changed path inside it, and a changed
 * path naming a directory (an untracked `dir/` in `git status --porcelain`)
 * matches a frozen entry inside it.  The second direction over-reports rather
 * than under-reports, which is the right bias for a detector whose failure
 * mode is a human being asked one unnecessary question.
 *
 * @param {object} opts
 * @param {string[]} opts.frozen          — declared frozen paths.
 * @param {boolean}  opts.headingPresent  — a `## Frozen Tests` heading exists.
 * @param {string[]} opts.changedPaths    — the round's changed paths.
 * @returns {{ probe: string, passed: boolean, detail: string, oracleViolation?: true }}
 */
export function runFrozenProbe({ frozen, headingPresent, changedPaths }) {
  const probe = "P5: frozen";
  const frozenArr = Array.isArray(frozen) ? frozen : [];
  const changedArr = Array.isArray(changedPaths) ? changedPaths : [];

  if (frozenArr.length === 0) {
    // Heading present but nothing parsed: the declared check would silently
    // not run.  Same author-facing rule as P3/P4 — tell the author to fix the
    // brief syntax rather than let them believe the oracle ran.  No
    // `oracleViolation` marker: nothing was violated, the declaration is
    // unreadable, and that is a brief defect the normal disposition table
    // already routes (exactly as it routes a zero-entry P3/P4).
    if (headingPresent) {
      return {
        probe,
        passed: false,
        detail: "## Frozen Tests heading present but no entries parsed; check brief syntax",
      };
    }
    return { probe, passed: true, detail: "no Frozen Tests declared; check skipped" };
  }

  const touched = [];
  for (const cp of changedArr) {
    const hit = frozenArr.some(function (f) {
      return cp === f || cp.startsWith(f + "/") || f.startsWith(cp + "/");
    });
    if (hit && !touched.includes(cp)) touched.push(cp);
  }

  if (touched.length === 0) {
    return {
      probe,
      passed: true,
      detail: "no frozen path changed; frozen: [" + frozenArr.join(", ") + "]",
    };
  }

  return {
    probe,
    passed: false,
    detail:
      "frozen path(s) changed: [" + touched.join(", ") + "]; " +
      "frozen: [" + frozenArr.join(", ") + "]",
    oracleViolation: true,
  };
}

/**
 * P6: collected — the round's verify must not run fewer tests than the base.
 *
 * Both numbers come from `countVerifyCollected`: the baseline's from the
 * chain-start capture recorded on `chain.json` (never re-captured, so
 * chain-resume compares against the same base as round 1), the round's from
 * P2's own verify run.
 *
 * Either side missing → PASS: an unknown is not a decrease, and failing on it
 * would fail every chain whose verify shape we cannot count.  But the gap is
 * stated in the detail, never left silent — a probe that says nothing reads as
 * "checked, fine", which is the exact confusion this pair exists to remove.
 *
 * @param {object} opts
 * @param {number|null} opts.collected          — tests this round ran.
 * @param {number|null} opts.baselineCollected  — tests the chain-start base ran.
 * @returns {{ probe: string, passed: boolean, detail: string,
 *             limitation?: string, oracleViolation?: true }}
 */
export function runCollectedProbe({ collected, baselineCollected }) {
  const probe = "P6: collected";
  const roundOk = Number.isInteger(collected);
  const baseOk = Number.isInteger(baselineCollected);

  if (!roundOk || !baseOk) {
    const detail =
      "collected count unavailable (baseline " +
      (baseOk ? String(baselineCollected) : "unavailable") +
      ", round " + (roundOk ? String(collected) : "unavailable") +
      "); P6 could not compare, so this round's test count is UNCHECKED";
    return { probe, passed: true, detail, limitation: detail };
  }

  if (collected >= baselineCollected) {
    return {
      probe,
      passed: true,
      detail: "collected " + collected + " >= baseline " + baselineCollected,
    };
  }

  return {
    probe,
    passed: false,
    detail: "collected " + collected + " < baseline " + baselineCollected,
    oracleViolation: true,
  };
}

/**
 * Summarise the round's oracle violations into the single input
 * `deriveDisposition` routes on.
 *
 * One function owns the question "did an oracle probe fail this round?", and
 * it answers from the probe results themselves — no second list of probe
 * names to keep in step with the first.
 *
 * @param {Array<object>|null|undefined} probeResults
 * @returns {string|false} A human-readable summary naming every violation
 *   (so the escalate line names it), or false when there is none.
 */
export function summariseOracleViolations(probeResults) {
  const violated = (Array.isArray(probeResults) ? probeResults : [])
    .filter(function (p) { return p && p.oracleViolation === true; });
  if (violated.length === 0) return false;
  return violated.map(function (p) {
    return (p.probe || "(unnamed probe)") + ": " + (p.detail || "(no detail)");
  }).join("; ");
}

// =========================================================================
// Tier escalation clamping
// =========================================================================

