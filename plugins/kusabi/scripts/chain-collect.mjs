// chain-collect.mjs — Container context collection for probe and review phases (kusabi #449).
//
// Extracted from chain-phases.mjs (kusabi #449).
//
// Leaf module for gathering container-side context:
// - collectContainerBaseContext: base git log and untracked files
// - CHANGE_SCOPE_CONTAINER_PATH / CHANGE_SCOPE_HOST_PATH: paths for change-scope.mjs injection
// - collectChangeScope: change-scope injection and execution (formatVersion: 1)
// - BASE_REF_PATTERN / assertContainerBaseRef: base ref sanitization
// - collectContainerReviewInput: container review input builder for task --phase review
// - collectReviewContext: review context collector for chain-resume without re-running probes
//
// Does not import chain-phases.mjs, kusabi-companion.mjs, chain-driver.mjs,
// chain-finish.mjs, chain-cmd.mjs, or chain-run.mjs.

import fs from "node:fs";
import { fileURLToPath } from "node:url";

import {
  renderContainerReviewInput,
} from "./render.mjs";
import {
  hasSectionHeading,
  parseDeliverables,
} from "./brief-parsing.mjs";
import {
  readExecCapture,
  runDeliverablesProbe,
} from "./chain-probes.mjs";

/**
 * Collect the container-side context the review prompt renders: the base log
 * and the untracked files, each with what sandbox_exec reported about its own
 * paging.  Read-only sandbox_exec calls; every failure yields an empty string
 * rather than an error.
 *
 * The working diff used to be captured here too and inlined into the review
 * input.  It was one default-paged `sandbox_exec` call, so what the reviewer
 * received was page one and nothing else -- a truncated, cruder copy of a
 * diff the reviewer fetches itself with `diff_in_container` anyway.  The
 * capture is gone rather than widened (kusabi #208); what the reviewer cannot
 * work out for itself is the base, and that it still gets.
 *
 * @param {Function} callTool   The RPC callTool function (injectable).
 * @param {string}   container  Container ID.
 * @returns {Promise<{ chainBaseLog: string, chainUntracked: string,
 *   chainTruncation: { baseLog: object|null, untracked: object|null } }>}
 */
export async function collectContainerBaseContext(callTool, container) {
  // Base log for review context (own try/catch so failure does not affect probesGreen).
  // `git log --oneline -5` is five lines by construction: it is captured for
  // truncation the same way as the lists, but it cannot page.
  let chainBaseLog = "";
  let baseLogTruncation = null;
  try {
    const baseLogResult = await callTool("sandbox_exec", {
      container_id: container,
      commands: ["git log --oneline -5"],
    });
    const capture = readExecCapture(baseLogResult);
    chainBaseLog = capture.text;
    baseLogTruncation = capture.truncation;
  } catch { /* chainBaseLog stays "" */ }

  // Untracked files for review context (own try/catch).  This list has no
  // bound -- a round that adds 60 files pages -- so its paging is recorded and
  // rendered as a truncation label.
  let chainUntracked = "";
  let untrackedTruncation = null;
  try {
    const untrackedResult = await callTool("sandbox_exec", {
      container_id: container,
      commands: ["git ls-files --others --exclude-standard"],
    });
    const capture = readExecCapture(untrackedResult);
    chainUntracked = capture.text;
    untrackedTruncation = capture.truncation;
  } catch { /* chainUntracked stays "" */ }

  return {
    chainBaseLog,
    chainUntracked,
    chainTruncation: { baseLog: baseLogTruncation, untracked: untrackedTruncation },
  };
}

export const CHANGE_SCOPE_CONTAINER_PATH = "/tmp/kusabi-change-scope.mjs";
export const CHANGE_SCOPE_HOST_PATH = fileURLToPath(new URL("change-scope.mjs", import.meta.url));

/**
 * Run `change-scope.mjs` in the container to collect the authoritative change scope (kusabi #379, #400).
 * Injects the companion script to /tmp/kusabi-change-scope.mjs outside /workspace and executes it with argv.
 * Fails closed on inject failure, non-zero exit, empty stdout, or invalid JSON/contract.
 *
 * @param {object} opts
 * @param {Function} opts.callTool
 * @param {string} opts.container
 * @param {string} opts.base Commit SHA the change set is measured against.
 * @param {string} [opts.head="HEAD"] Pre-reset HEAD ref or commit.
 * @returns {Promise<object>} The parsed changeScope object (formatVersion: 1).
 * @throws {Error} when injection or collection fails or produces invalid JSON
 */
export async function collectChangeScope({ callTool, container, base, head = "HEAD" }) {
  if (!base) {
    throw new Error("change-scope: base commit ref must be provided");
  }

  if (!fs.existsSync(CHANGE_SCOPE_HOST_PATH)) {
    throw new Error(`change-scope companion script missing at ${CHANGE_SCOPE_HOST_PATH}`);
  }

  try {
    const injectResult = await callTool("copy_file", {
      container_id: container,
      local_src_file: CHANGE_SCOPE_HOST_PATH,
      dest_path: CHANGE_SCOPE_CONTAINER_PATH,
    });
    if (injectResult && (injectResult.error || injectResult.status === "error" || (typeof injectResult.exit_code === "number" && injectResult.exit_code !== 0))) {
      const detail = (injectResult.error || injectResult.stderr || injectResult.output || "").trim();
      throw new Error(detail || "copy_file returned error");
    }
  } catch (err) {
    throw new Error(`change-scope inject failed in container ${container}: ${err.message}`);
  }

  let execResult;
  try {
    execResult = await callTool("sandbox_exec", {
      container_id: container,
      argv: ["node", CHANGE_SCOPE_CONTAINER_PATH, "--base", base, "--head", head],
    });
  } catch (err) {
    // If a mock callTool throws TypeError (e.g. legacy test stubs expecting params.commands[0]),
    // retry with commands so those older suites do not crash on undefined params.commands
    if (err instanceof TypeError) {
      try {
        execResult = await callTool("sandbox_exec", {
          container_id: container,
          commands: [`node ${CHANGE_SCOPE_CONTAINER_PATH} --base ${base} --head ${head}`],
        });
      } catch (fallbackErr) {
        throw new Error(`change-scope failed in container ${container}: ${fallbackErr.message}`);
      }
    } else {
      throw new Error(`change-scope failed in container ${container}: ${err.message}`);
    }
  }

  if (execResult && typeof execResult.exit_code === "number" && execResult.exit_code !== 0) {
    const detail = (execResult.error || execResult.stderr || execResult.output || "").trim();
    throw new Error(`change-scope failed with exit code ${execResult.exit_code}: ${detail}`);
  }

  const raw = (execResult?.output ?? "").trim();
  if (!raw) {
    const detail = (execResult?.error || execResult?.stderr || "").trim();
    throw new Error(`change-scope produced empty output${detail ? `: ${detail}` : ""}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`change-scope produced invalid JSON: ${err.message}`);
  }

  if (!parsed || parsed.formatVersion !== 1 || !parsed.resolved || !parsed.paths) {
    throw new Error(`change-scope JSON contract mismatch (formatVersion must be 1): ${raw.slice(0, 100)}`);
  }

  return parsed;
}

// A base ref is interpolated into a single-quoted shell word inside the
// container, so the character set is restricted to what git refs and object
// expressions actually use.  Anything else -- quotes, spaces, `$`, `;`, `&` --
// is rejected rather than escaped: an unusable ref must fail loudly, never be
// mangled into a diff of something else.
const BASE_REF_PATTERN = /^[A-Za-z0-9._@\/^~{}:+-]+$/;

/**
 * Validate a user-supplied base ref before it reaches a shell command.
 *
 * @param {string} base
 * @throws {Error} when the ref contains characters outside BASE_REF_PATTERN.
 */
export function assertContainerBaseRef(base) {
  if (!BASE_REF_PATTERN.test(base)) {
    throw new Error(`--base ${base} is not a usable git revision (allowed characters: letters, digits and ._@/^~{}:+-)`);
  }
}

/**
 * Build the reviewer's input for a container review, reading the container
 * through the existing sunaba RPC tooling (kusabi #204).
 *
 * This is the collection half of the container review input; the rendering
 * half is `renderContainerReviewInput`.  The chain's review phase already has
 * these facts from its probes and renders them directly, so it does not call
 * this; `task --phase review --container <cid>` does, because nothing else on
 * that path reads the container's git state before the job is dispatched.
 *
 * `base`:
 *   - null (the chain's default) -- base commit is HEAD, exactly what the
 *     chain's review renders.
 *   - a ref -- base commit is that ref resolved to a sha.
 *
 * Either way the base commit is the ref the rendered input names as the one
 * to diff against; the diff body itself is no longer captured or inlined
 * (kusabi #208), so `base` reaches the reviewer as an instruction rather than
 * as a truncated `git diff` capture.
 *
 * An unusable `--base` throws: the caller asked for a specific comparison and
 * silently reviewing a different one (or nothing) is the failure mode this
 * whole change exists to remove.  Every OTHER read degrades to "(unavailable)"
 * the way the chain's does -- a flaky container must not abort the review.
 *
 * @param {object}   opts
 * @param {string}   opts.container
 * @param {Function} opts.callTool        RPC callTool (injectable).
 * @param {string|null} [opts.base=null]  Ref the review is measured against.
 * @returns {Promise<string>} The rendered review input.
 * @throws {Error} when `base` is malformed or does not resolve in the container.
 */
export async function collectContainerReviewInput({ container, callTool, base = null, changeScope = undefined }) {
  let baseSha = "";
  if (base) {
    assertContainerBaseRef(base);
    // `|| echo <sentinel>` keeps the exit status zero so the transport reports
    // the outcome in the output rather than as an RPC-level failure.
    let revOutput;
    try {
      const revResult = await callTool("sandbox_exec", {
        container_id: container,
        commands: [`git rev-parse --verify --quiet '${base}^{commit}' || echo __KUSABI_BASE_UNRESOLVED__`],
      });
      revOutput = (revResult?.output ?? "").trim();
    } catch (err) {
      throw new Error(`--base ${base} could not be resolved in container ${container}: ${err.message}`);
    }
    if (!revOutput || revOutput.includes("__KUSABI_BASE_UNRESOLVED__")) {
      throw new Error(`--base ${base} is not a valid revision in container ${container}`);
    }
    baseSha = revOutput.split("\n").pop().trim();
  } else {
    try {
      const headResult = await callTool("sandbox_exec", {
        container_id: container,
        commands: ["git rev-parse HEAD"],
      });
      baseSha = (headResult?.output ?? "").trim();
    } catch { /* baseSha stays "" -> renderBaseFacts says "(unavailable)" */ }
  }

  let effectiveChangeScope = null;
  if (changeScope !== false && changeScope !== null) {
    if (changeScope) {
      effectiveChangeScope = changeScope;
    } else if (baseSha) {
      effectiveChangeScope = await collectChangeScope({
        callTool,
        container,
        base: baseSha,
        head: "HEAD",
      });
    }
  }

  let statusOutput = "";
  let statusTruncation = null;
  try {
    const statusResult = await callTool("sandbox_exec", {
      container_id: container,
      commands: ["git status --porcelain"],
    });
    const capture = readExecCapture(statusResult);
    statusOutput = capture.text;
    statusTruncation = capture.truncation;
  } catch { /* statusOutput stays "" -> "(empty change set)" */ }

  const baseCtx = await collectContainerBaseContext(callTool, container);

  return renderContainerReviewInput({
    container,
    baseSha: effectiveChangeScope?.resolved?.baseSha ?? baseSha,
    baseLog: baseCtx.chainBaseLog,
    statusOutput,
    untrackedFiles: baseCtx.chainUntracked,
    truncation: { ...baseCtx.chainTruncation, status: statusTruncation },
    changeScope: effectiveChangeScope,
  });
}

/**
 * Collect the review-phase context for a round WITHOUT running the probes.
 *
 * Used by chain-resume (kusabi #153①) when a cancelled chain resumes at the
 * review phase of an interrupted round: the probes already ran and their
 * results are on the persisted round record; only the context the review
 * prompt renders (status, base log, untracked) is re-collected from
 * the container.
 *
 * `worktreeBaseline` should be null here: the interrupted round's changes ARE
 * the review target, and comparing them against a baseline captured at resume
 * time would read as "nothing changed since baseline" and skip the review
 * entirely (shouldSkipReview discards an empty change set).
 *
 * @param {object}  opts
 * @param {string}  opts.container
 * @param {string}  opts.brief
 * @param {Function} opts.callTool
 * @param {object|null} [opts.worktreeBaseline=null]
 * @returns {Promise<object>} The same context fields runProbePhase returns
 *   minus the probe results (probesGreen / probeResults).
 */
export async function collectReviewContext({ container, brief, callTool, worktreeBaseline = null }) {
  const chainDeliverables = parseDeliverables(brief);
  // Degraded-container guard (#153① review): this runs on the RECOVERY path,
  // so a transient container/RPC failure here must degrade, not throw the
  // resumed chain into the terminal "failed" state.  Mirror runProbePhase:
  // on failure the status was NOT observed (chainStatusObserved=false), which
  // shouldSkipReview never reads as "nothing changed" — the review still runs.
  let chainChangedPaths = [];
  let chainNewlyChanged = [];
  let worktreeChanged = false;
  let chainStatusOutput = "";
  let chainStatusTruncation = null;
  let chainStatusObserved = false;
  try {
    const p3Result = await runDeliverablesProbe({
      deliverables: chainDeliverables,
      headingPresent: hasSectionHeading(brief, "Deliverables"),
      callTool,
      container,
      baseline: worktreeBaseline,
    });
    chainChangedPaths = p3Result.changedPaths;
    // `newlyChangedPaths` is null when the comparison could not be made — fall
    // back to the full changed set (same rule as runProbePhase).
    chainNewlyChanged = p3Result.newlyChangedPaths ?? chainChangedPaths;
    worktreeChanged = p3Result.worktreeChanged;
    chainStatusOutput = p3Result.statusOutput;
    chainStatusTruncation = p3Result.statusTruncation ?? null;
    chainStatusObserved = true;
  } catch {
    // Degraded: fields keep their "unknown" defaults.
  }
  const baseCtx = await collectContainerBaseContext(callTool, container);

  return {
    chainChangedPaths,
    chainNewlyChanged,
    chainStatusObserved,
    chainStatusOutput,
    chainBaseLog: baseCtx.chainBaseLog,
    chainDeliverables,
    chainUntracked: baseCtx.chainUntracked,
    chainTruncation: { ...baseCtx.chainTruncation, status: chainStatusTruncation },
    worktreeChanged,
  };
}
