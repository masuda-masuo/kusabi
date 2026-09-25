// luna-driver.mjs — kusabi #530 + #531: the deterministic luna mission driver.
//
// A luna mission is an opt-in dispatch surface: the gpt-5.6-luna coordinator
// seat proposes bounded actions as line-oriented JSON records, and THIS
// driver is the only authority that validates and executes them.  The
// contract, frozen by luna-driver.test.mjs (+ #531's luna-sol-gate /
// luna-cancel-resume / luna-reconcile acceptance tests):
//
//   - the coordinator's output is parsed ONLY through parseCoordinatorOutput
//     (the frozen #529 parser) against the CURRENT immutable evidence
//     envelope hash; if any record is malformed, incomplete, unknown, or
//     bound to another envelope, NOTHING in that stream executes;
//   - only the frozen action enum executes: read_probe, run_chain,
//     rework_chain, consult_sol, escalate_to_host, finish;
//   - requests execute sequentially, bounded by an explicit mission budget
//     (maxChains / maxAttempts / maxProbes / maxConsults / maxRework); a
//     budget breach terminates the mission `budget-exhausted` and never
//     creates another chain;
//   - run_chain / rework_chain go through the runChainLifecycle seam (never
//     runChainDriver directly) with a driver-minted chain id and
//     keepServe: true — the mission is the single outer serve owner;
//   - read_probe is driver-mediated through an allow-listed tool set and is
//     recorded; Luna itself has no tool or job-spawn authority;
//   - consult_sol opens an ADDITIVE Sol gate (it can never suppress, remove,
//     downgrade, or satisfy a separately mandatory gate) and is recorded;
//   - Sol audit gates (#531) are evaluated by the deterministic driver at the
//     three frozen lifecycle points — pre-dispatch (before executing a
//     run_chain / rework_chain request), post-chain (after each inner-chain
//     terminal result) and pre-accept (immediately before finalising a
//     `finish recommend-accept` terminal recommendation, the T11 gate) — plus
//     an additive gate for an accepted consult_sol.  A Sol seat is bought at
//     a point ONLY when policy marks the gate required, deterministic
//     sampling selects it, or Luna requested the consult.  `clear` proceeds;
//     `rework` permits only bounded rework_chain (consecutive rework beyond
//     budget.maxRework fails closed); `block` terminates `sol-blocked` and
//     Luna never gets another dispatch to clear it.  At a MANDATORY gate,
//     missing / unavailable / empty / malformed / ambiguous /
//     evidence-mismatched results fail closed to `sol-blocked`; only
//     sample-only seat unavailability records `audit-sample-skipped` and may
//     proceed.  Verdict authority binds gate id + exact envelope SHA-256;
//     evidence changes ARCHIVE the stale verdict (reason `evidence-changed`)
//     and exclude it from the next envelope's prior_verdicts;
//   - the terminal mandatory gate applies to approval-shaped
//     `recommend-accept` (T11); `escalate_to_host` and `recommend-escalate`
//     are not gated;
//   - cancellation (#531): the driver checks the recorded stop request
//     (control.json stopRequestedAt, written by `luna-cancel`) immediately
//     before every coordinator, Sol, and inner-chain dispatch and again after
//     an inner chain returns.  After stopRequestedAt no coordinator, auditor,
//     inner-chain, retry, rework, or replacement seat is dispatched; the
//     mission finalises `cancelled`, cleans the outer serve once (when inner
//     chain work was invoked), and notifies once;
//   - resumability (#531): given an existing mission directory, the driver
//     continues from the persisted record instead of refusing "mission id
//     already exists" — evidence numbering, gate numbering, and recorded
//     attempts/chains/probes/consults/verdicts all continue; nothing recorded
//     is re-executed, and the terminal notification fires exactly once;
//   - a terminal mission emits EXACTLY ONE terminal notification (one inbox
//     record, one deduplicated kaiba agenda row) and the host-facing
//     recommendation (`recommendation.md`);
//   - the mission never accepts, publishes, merges, creates issues or
//     creates containers; its terminal result is a host-facing
//     recommendation (finish), a host handoff (escalate_to_host), a Sol
//     block (sol-blocked), or a cancellation (cancelled);
//   - seat substitution fails before mission creation unless explicitly
//     authorized, and authorized substitution is loud in the records;
//   - the evidence envelope is refreshed after every observable action, so
//     the next coordinator request is bound to current evidence and prior
//     outcomes.
//
// The driver receives injected coordinator/chain/tool/Sol/notify seams in
// tests and real adapters in production (the real coordinator dispatch runs
// the exact gpt-5.6-luna seat through the codex backend, the real Sol
// dispatch runs the exact gpt-5.6-sol seat through it).

import fs from "node:fs";
import path from "node:path";
import { stateDirFor, readJson, writeJson } from "./state-paths.mjs";
import { parseCoordinatorOutput } from "./coordinator-parse.mjs";
import { buildAuditEnvelope, truncateEvidenceText } from "./audit-envelope.mjs";
import { hasSectionHeading, parseDeliverables, stampInnerBriefSignature, parseOrchestratorSignature } from "./brief-parsing.mjs";
import { mintChainId } from "./chain-phases.mjs";
import {
  loadCoordinatorSchema,
  renderCoordinatorContract,
  renderRemainingBudget,
  renderBriefCorrections,
  sanitizeBriefCorrectionDetail,
  renderEvidenceContents,
} from "./luna-prompt.mjs";
import {
  mintMissionId,
  assertMissionIdShape,
  createMission,
  readMissionRecord,
  saveMissionRecord,
  finalizeMissionControl,
  missionStopRequested,
  rearmMissionControl,
  TERMINAL_MISSION_DISPOSITIONS,
} from "./mission-store.mjs";
import {
  evaluateMissionGate,
  realSolDispatch,
  probeEvidenceText,
  missionEvidenceItems,
  resolveLastPostChain,
} from "./luna-sol-gate.mjs";
import { oneLine } from "./one-line.mjs";

/** The exact default seats of #530: coordinator codex/gpt-5.6-luna, auditor codex/gpt-5.6-sol. */
export const DEFAULT_COORDINATOR_SEAT = { provider: "codex", model: "gpt-5.6-luna" };
export const DEFAULT_AUDITOR_SEAT = { provider: "codex", model: "gpt-5.6-sol" };

/**
 * The explicit mission budget: bounded chains, attempts, probes, consults and
 * (kusabi #531) consecutive Sol rework verdicts.  `maxConsults` bounds
 * `consult_sol` requests (the coordination loop a consult-only coordinator
 * could otherwise run forever); `maxRework` bounds consecutive `rework`
 * verdicts (a rework demand beyond it fails closed sol-blocked) — both
 * conservative defaults, overridable per mission like every other bound.
 */
export const DEFAULT_BUDGET = { maxChains: 3, maxAttempts: 2, maxProbes: 5, maxConsults: 3, maxRework: 1, maxBriefCorrections: 3 };

/**
 * Documented byte limit for a probe result's serialized payload persisted to
 * mission.json.  Independent of the evidence envelope's own budget: raw
 * mission persistence must be bounded on its own (capProbeOutput).
 */
export const PROBE_OUTPUT_MAX_BYTES = 8192;
/**
 * The post-chain diff cap (kusabi #568).  Larger than the probe cap: the diff
 * is the one item Sol audits the change from, and at most maxAttempts diffs
 * share the DEFAULT_ENVELOPE_MAX_BYTES envelope budget.
 */
export const DIFF_OUTPUT_MAX_BYTES = 65536;

/**
 * The small closed vocabulary a `finish` recommendation is validated against.
 * `accept` (the chain verb) is deliberately not here — the mission's terminal
 * result is a recommendation, never an acceptance.
 *
 * Derived from the canonical `properties.recommendation.enum` of
 * schemas/coordinator-output.schema.json (the same enum the prompt renderer
 * states), so the driver, the schema, and the rendered prompt can never
 * drift apart (frozen by the schema/driver drift tests).
 */
export const RECOMMENDATION_VOCABULARY = new Set(loadCoordinatorSchema().properties.recommendation.enum);

/**
 * The allow-listed read-only probe tools the driver mediates `read_probe`
 * through.  Nothing here can spawn a job, write a file, or run an arbitrary
 * command — the coordinator has no tool or job-spawn authority.
 *
 * Derived from the canonical `properties.tool.enum` of
 * schemas/coordinator-output.schema.json (the same enum the prompt renderer
 * states), so the driver, the schema, and the rendered prompt can never
 * drift apart (frozen by the schema/driver drift tests).
 */
export const PROBE_TOOL_ALLOWLIST = new Set(loadCoordinatorSchema().properties.tool.enum);

/**
 * The per-tool TOP-LEVEL request fields the driver REQUIRES before any probe
 * tool call, derived from the canonical schema's `probe_tools.<tool>.required`
 * (the same entries the prompt renderer states per tool).  Deriving keeps
 * schema, driver, and rendered prompt from drifting apart (frozen by the
 * probe_tools drift tests).
 */
export const PROBE_REQUIRED_FIELDS = Object.fromEntries(
  Object.entries(loadCoordinatorSchema().probe_tools.properties).map(([tool, entry]) => [
    tool,
    [...entry.required],
  ]),
);

/**
 * The required top-level request fields of `req.tool` that the request fails
 * to carry.  A required field must be a non-empty string — whitespace-only
 * content counts as empty, so a search without a real `pattern` fails closed
 * at the driver boundary BEFORE any tool call (the driver never fabricates a
 * value, and `probeArgsFor` never receives a request that failed this check).
 *
 * Returns [] for a valid request and for an unknown tool (the allow-list
 * check runs first, so an unlisted tool is refused before this is consulted).
 *
 * @param {object} req — the parsed read_probe request body.
 * @returns {string[]} the required fields that are missing, empty, or
 *         whitespace-only.
 */
export function probeRequestMissingFields(req) {
  const tool = req?.tool;
  const required = PROBE_REQUIRED_FIELDS[tool] ?? [];
  return required.filter((field) => {
    const value = req[field];
    return typeof value !== "string" || value.trim() === "";
  });
}

/**
 * Resolve a requested seat against its default, refusing substitution unless
 * explicitly authorized and refusing any non-codex provider outright (the
 * luna mode never leaves the codex seats).
 *
 * @param {object|null|undefined} requested — {provider, model} or undefined.
 * @param {object} def — the exact default seat.
 * @param {string} role — "coordinator" | "auditor" (for messages).
 * @param {boolean} allowSubstitute
 * @returns {{ provider: string, model: string, requested: string, actual: string, substituted: boolean }}
 */
export function resolveMissionSeat(requested, def, role, allowSubstitute) {
  const provider = requested?.provider ?? def.provider;
  const model = requested?.model ?? def.model;
  if (provider !== "codex") {
    throw new Error(
      `luna mission requires a codex backend seat for the ${role}; got provider "${provider}" — ` +
      `the luna mode never leaves the codex seats`,
    );
  }
  const substituted = model !== def.model;
  if (substituted && allowSubstitute !== true) {
    throw new Error(
      `${role} seat substitution refused: requested model "${model}" is not the exact seat ` +
      `${def.model}. Pass --allow-substitute to authorize it explicitly — substitution is ` +
      `loud in mission records and output.`,
    );
  }
  // kusabi #532: exact seat provenance carries the reasoning effort (the
  // codex seat's configured effort, defaulting to "high" for the luna mode);
  // an explicit input value is preserved verbatim, never overwritten.
  return {
    provider,
    model,
    requested: def.model,
    actual: model,
    substituted,
    reasoningEffort: requested?.reasoningEffort ?? "high",
  };
}

/**
 * Deterministic pre-flight for a chain brief: an inner chain is an implement
 * dispatch, so it must carry a non-empty `## Deliverables` section (the same
 * requirement briefLintReport enforces inside the seam).  A brief that fails
 * this is refused BEFORE the seam is invoked.
 *
 * @param {string|undefined|null} brief
 * @returns {boolean}
 */
export function validChainBrief(brief) {
  if (typeof brief !== "string" || brief === "") return false;
  return hasSectionHeading(brief, "Deliverables") && parseDeliverables(brief).length > 0;
}

// The cheap downstream brief validators the pre-seam refusal reuses — the
// SAME functions the chain dispatch runs before any job or chain state
// exists (kusabi #289/#302/#386 lint and kusabi #250/#302 smoke), so a brief
// the mission refuses could never have dispatched downstream either.  Both
// modules are heavy command modules; they are loaded lazily like every other
// command surface this driver reaches (codex-dispatch, chain-cmd, ...), so
// the mission driver itself never pays their static import cost.
let _briefValidators = null;
async function briefValidators() {
  if (_briefValidators === null) {
    const [companion, guards] = await Promise.all([
      import("./kusabi-companion.mjs"),
      import("./chain-brief-guards.mjs"),
    ]);
    _briefValidators = {
      briefLintReport: companion.briefLintReport,
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
async function innerBriefValidationReport(brief, container) {
  const { briefLintReport, smokeViolationReport } = await briefValidators();
  const lint = briefLintReport({ brief, phase: null, container, chain: true });
  const smoke = smokeViolationReport(brief);
  if (lint === null && smoke === null) return null;
  return [lint, smoke].filter(Boolean).join("\n");
}

/**
 * Build the immutable evidence envelope the NEXT coordinator dispatch is
 * bound to.  The envelope binds the mission brief, every worker report
 * (chain attempt output), every probe raw, and the mission ledger — so any
 * observable action changes the envelope hash.
 */
function buildEvidenceEnvelope({ missionId, missionDir, brief, container, coordinator, allowSubstitute, record, dispatchIndex }) {
  const lastPostChain = resolveLastPostChain(record);
  return buildAuditEnvelope({
    gateId: `mission-${missionId}-dispatch-${dispatchIndex}`,
    missionId,
    chainId: null,
    policyVersion: 1,
    seat: coordinator,
    triggers: [],
    container,
    baseSha: lastPostChain?.baseSha ?? null,
    changeScope: lastPostChain?.changeScope ?? {},
    items: missionEvidenceItems({ brief, record, includeRemaining: true }),
    priorVerdicts: [],
    allowSubstitute: allowSubstitute === true || coordinator?.substituted !== true,
    writeFile: (p, content) => {
      const target = path.join(missionDir, p);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, "utf8");
    },
  });
}

/**
 * The probe args handed to the callTool seam for a mediated read_probe.
 * The container id is always supplied by the driver — Luna never names it.
 *
 * The caller must have validated the request first (probeRequestMissingFields
 * against PROBE_REQUIRED_FIELDS), so no value is fabricated here: a required
 * top-level request field maps straight to its schema-declared call argument
 * (the per-tool mapping is pinned by the probe_tools drift tests against
 * `probe_tools.<tool>.call_args`).  The fallback branch is unreachable
 * defensive code (the tool allow-list check runs before this is ever called).
 *
 * @param {string} tool
 * @param {string} container
 * @param {object} req — the validated read_probe request body.
 * @returns {object} the callTool arguments.
 */
export function probeArgsFor(tool, container, req) {
  if (tool === "read_file_range") return { container_id: container, file_path: req.path };
  if (tool === "search_in_container") return { container_id: container, pattern: req.pattern, path: req.path };
  if (tool === "list_files") return { container_id: container, path: req.path };
  return { container_id: container, ...req };
}

/**
 * Deterministically cap a probe result's SERIALIZED payload before it is
 * persisted to mission.json (finding: probe output was persisted without
 * bound).  A payload that fits the documented limit (PROBE_OUTPUT_MAX_BYTES)
 * is stored unchanged; a larger payload is reduced to a deterministic head+tail
 * splice — the same truncation the evidence envelope applies — with the exact
 * omitted byte count and truncation metadata recorded.  Truncation is never
 * silent.
 *
 * @param {unknown} output — the raw callTool result.
 * @returns {{ output: unknown, outputBytes: number, truncated: boolean,
 *             omittedBytes: number, truncation?: string|null }}
 */
export function capProbeOutput(output) {
  const serialized = JSON.stringify(output ?? null) ?? "";
  const serializedBytes = Buffer.byteLength(serialized, "utf8");
  if (serializedBytes <= PROBE_OUTPUT_MAX_BYTES) {
    return { output, outputBytes: serializedBytes, truncated: false, omittedBytes: 0, truncation: null };
  }
  const truncated = truncateEvidenceText(serialized, { maxBytes: PROBE_OUTPUT_MAX_BYTES });
  return {
    output: truncated.text,
    outputBytes: serializedBytes,
    truncated: true,
    omittedBytes: truncated.omitted_bytes,
    truncation: truncated.truncation,
  };
}

/**
 * Format an untracked file's contents as a git new-file diff block (kusabi #572).
 *
 * @param {string} filePath - Repo-relative file path.
 * @param {string} [fileContent] - Full file content string (if read succeeded).
 * @param {object} [opts]
 * @param {string|null} [opts.readError] - Error description if read failed.
 * @param {boolean} [opts.hasMore] - Whether read_file_range reported has_more.
 * @returns {string} The formatted diff block with trailing newline.
 */
export function formatUntrackedFileDiff(filePath, fileContent = "", { readError = null, hasMore = false } = {}) {
  let block =
    `diff --git a/${filePath} b/${filePath}\n` +
    `new file (untracked; content read with read_file_range)\n` +
    `--- /dev/null\n` +
    `+++ b/${filePath}\n`;

  if (readError != null) {
    block += `[content unavailable: ${readError}]\n`;
  } else {
    if (fileContent !== "") {
      const stripped = fileContent.endsWith("\n") ? fileContent.slice(0, -1) : fileContent;
      const lines = stripped.split("\n");
      for (const line of lines) {
        block += `+${line}\n`;
      }
    }
    if (hasMore) {
      block += `[content incomplete: read_file_range reported has_more]\n`;
    }
  }
  return block;
}

/**
 * Collect post-chain evidence (baseSha, probeResults, changeScope, and raw diff)
 * for a completed inner chain (kusabi #568).
 *
 * @param {object} opts
 * @param {string} opts.stateDir
 * @param {string} opts.chainId
 * @param {string} opts.container
 * @param {Function} opts.callTool
 * @param {number} [opts.maxBytes]
 * @returns {Promise<object>} the postChain object.
 */
export async function collectPostChainEvidence({
  stateDir,
  chainId,
  container,
  callTool,
  maxBytes = DIFF_OUTPUT_MAX_BYTES,
}) {
  try {
    const chainDir = path.join(stateDir, "chains", chainId);
    let chainJson;
    try {
      chainJson = readJson(path.join(chainDir, "chain.json"));
    } catch (err) {
      return { chainId, unavailable: `chain.json unreadable: ${err.message}` };
    }
    if (!chainJson || typeof chainJson !== "object") {
      return { chainId, unavailable: "chain.json missing or invalid" };
    }
    const baseSha = chainJson.baseSha;
    if (typeof baseSha !== "string" || !baseSha) {
      return { chainId, unavailable: "chain.json has no baseSha" };
    }
    const records = Array.isArray(chainJson.records) ? chainJson.records : [];
    const terminal = records[records.length - 1];
    if (!terminal || typeof terminal !== "object" || typeof terminal.round !== "number") {
      return { chainId, unavailable: "chain records empty or missing round" };
    }
    let roundRecord;
    try {
      roundRecord = readJson(path.join(chainDir, `round-${terminal.round}.json`));
    } catch (err) {
      return { chainId, unavailable: `round-${terminal.round}.json unreadable: ${err.message}` };
    }
    if (!roundRecord || typeof roundRecord !== "object") {
      return { chainId, unavailable: `round-${terminal.round}.json missing or invalid` };
    }

    const probeResults = Array.isArray(roundRecord.probeResults)
      ? roundRecord.probeResults
      : (roundRecord.probeResults ?? []);
    const changeScope =
      roundRecord.changeScope && typeof roundRecord.changeScope === "object"
        ? roundRecord.changeScope
        : {};

    const postChain = {
      chainId,
      baseSha,
      probeResults,
      changeScope,
    };

    if (typeof callTool !== "function") {
      postChain.diffUnavailable = "callTool seam is not available";
      return postChain;
    }

    let diffResult;
    try {
      diffResult = await callTool("diff_in_container", {
        container_id: container,
        base: baseSha,
        raw: true,
      });
    } catch (err) {
      postChain.diffUnavailable = err?.message ? `diff_in_container call threw: ${err.message}` : String(err);
      return postChain;
    }

    if (!diffResult || diffResult.status === "error" || diffResult.error) {
      const reason = diffResult?.error || diffResult?.message || "diff_in_container returned error status";
      postChain.diffUnavailable = String(reason);
      return postChain;
    }

    const rawDiffText =
      typeof diffResult.raw_diff === "string"
        ? diffResult.raw_diff
        : probeEvidenceText(diffResult);

    let untrackedText = "";
    if (Array.isArray(diffResult.untracked) && diffResult.untracked.length > 0) {
      postChain.untrackedIncluded = [...diffResult.untracked];
      for (const filePath of diffResult.untracked) {
        let fileContent = "";
        let readError = null;
        let hasMore = false;
        try {
          const readResult = await callTool("read_file_range", {
            container_id: container,
            file_path: filePath,
            limit: -1,
          });
          if (!readResult || readResult.status === "error" || readResult.error != null) {
            const rawErr = readResult?.error ?? readResult?.message ?? "read_file_range returned error status";
            readError = typeof rawErr === "object" && rawErr?.message ? rawErr.message : String(rawErr);
          } else if (typeof readResult.content !== "string") {
            readError = "read_file_range returned no content";
          } else {
            fileContent = readResult.content;
            hasMore = Boolean(readResult.has_more);
          }
        } catch (err) {
          readError = err?.message ? err.message : String(err);
        }
        untrackedText += formatUntrackedFileDiff(filePath, fileContent, {
          readError,
          hasMore,
        });
      }
    }

    let combinedDiffText = rawDiffText;
    if (untrackedText) {
      if (combinedDiffText && !combinedDiffText.endsWith("\n")) {
        combinedDiffText += "\n";
      }
      combinedDiffText += untrackedText;
    }

    const truncated = truncateEvidenceText(combinedDiffText, { maxBytes });
    postChain.diff = truncated.text;
    postChain.diffTruncated = truncated.truncated;
    postChain.diffOmittedBytes = truncated.omitted_bytes;

    return postChain;
  } catch (err) {
    return { chainId, unavailable: `unexpected error collecting post-chain evidence: ${err.message}` };
  }
}

/**
 * The real coordinator dispatch (production): run the exact gpt-5.6-luna seat
 * through the codex backend with the mission brief and the current envelope
 * as framing, and return its raw output text (the JSONL request stream).  The
 * kusabi-coordinate agent grants zero tools; the envelope is the only
 * evidence path.
 */
async function realCoordinatorDispatch({ cwd, missionId, missionDir, brief, envelope, coordinator, record }) {
  const { codexDispatch, assertCodexDispatchSucceeded } = await import("./codex-dispatch.mjs");
  const evidenceContents = renderEvidenceContents(envelope, missionDir);
  // The bounded inner-brief correction feedback (kusabi #553 follow-up): the
  // deterministic validator detail for every previously refused inner brief
  // (last <=3 unique details, C0-sanitized, <=1200 UTF-8 bytes each),
  // rendered ONLY when a correction exists — a clean mission's prompt stays
  // byte-identical to today.  The rendered text is driver-generated validator
  // output only: arbitrary coordinator error text, probe output, tool output
  // and exception messages never reach the seat.
  const correctionsText = renderBriefCorrections(record ?? {});
  // The whole section — including its TRAILING blank line — is conditional:
  // a clean mission (no corrections) spreads nothing, so its prompt stays
  // BYTE-IDENTICAL to the pre-change prompt (the review finding); a
  // corrected mission gets the section framed by a blank line on each side.
  const correctionsSection =
    correctionsText !== ""
      ? [`Brief corrections from the previous dispatch:`, ``, correctionsText, ``]
      : [];
  const prompt = [
    `You are the Luna coordinator seat for kusabi mission ${missionId}.`,
    `The current immutable evidence envelope hash is ${envelope.envelope_sha256}.`,
    ``,
    `Mission brief:`,
    brief ?? "",
    ``,
    `Current evidence envelope:`,
    JSON.stringify(envelope, null, 2),
    ``,
    `Evidence contents (bound by the envelope hash above):`,
    evidenceContents,
    ``,
    // The current REMAINING deterministic budget (decision 6): computed from
    // the persisted mission record plus its canonical effective budget on
    // every dispatch/resume — the seat can see exactly how many probes /
    // attempts / chains / consults its next batch may still consume, so it
    // can produce an affordable batch (an oversized batch is refused
    // atomically by the driver preflight).
    renderRemainingBudget(record ?? {}),
    ``,
    // The bounded inner-brief correction feedback (kusabi #553 follow-up):
    // the deterministic validator detail for every previously refused inner
    // brief (last <=3 unique details, C0-sanitized, <=1200 UTF-8 bytes each),
    // rendered ONLY when a correction exists — a clean mission's prompt stays
    // byte-identical to the pre-change prompt.  The rendered text is
    // driver-generated validator output only: arbitrary coordinator error
    // text, probe output, tool output and exception messages never reach the
    // seat.
    ...correctionsSection,
    // The runtime-rendered request contract (derived from
    // schemas/coordinator-output.schema.json): the exact per-action body
    // fields, the probe tool enum and per-tool arguments, the inner-chain
    // brief requirement, the finish recommendation vocabulary, the
    // one-record-per-line framing, and the envelope hash binding.  This is
    // the same contract the deterministic driver enforces — the seat can
    // only ever see the contract, never a hand-written copy.
    renderCoordinatorContract(),
    ``,
    `Answer with line-oriented JSON request records, one per line, each with ` +
      `action and envelope_sha256 set to ${envelope.envelope_sha256}.`,
  ].join("\n");
  const result = await codexDispatch({
    cwd,
    kind: "luna-mission",
    title: `luna mission ${missionId}: coordinator dispatch`,
    promptText: prompt,
    agent: "kusabi-coordinate",
    phase: "luna-coordinator",
    explicitModel: coordinator.model,
    tiers: [[coordinator.model]],
    session: null,
    tools: {},
    timeoutS: null,
    watchdogS: null,
  });
  // Fail closed: a resolved FAILED codex job is a dispatch failure, never an
  // empty stream.  The driver catch records it as a coordinator dispatch
  // failure naming job id/status/error; it must never be routed through
  // parseCoordinatorOutput (which would emit the misleading "incomplete 0
  // rejected, 0 malformed" empty-stream label from the incident).
  assertCodexDispatchSucceeded(result, "coordinator");
  return result.resultText;
}

/**
 * The mission's one-time outer serve cleanup, using the same guarded
 * semantics the chain driver applies to its own serve-stop: stop the shared
 * serve only when no live jobs remain (liveRunningJobs applies the same
 * fossil rule as cmdServeStop).  The mission passes `keepServe: true` to
 * inner chains, so the chains never stop the serve themselves — the mission
 * is the single outer serve owner and must stop it exactly once, after all
 * inner work, when it actually invoked inner chain work.
 *
 * Best-effort by contract: a cleanup failure must never mask the mission's
 * terminal result (the caller wraps this).
 *
 * @param {string} cwd
 * @param {string} stateDir
 */
async function defaultGuardedServeStop(cwd, stateDir) {
  const { liveRunningJobs, cmdServeStop } = await import("./kusabi-companion.mjs");
  const hasRunning = liveRunningJobs(stateDir).length > 0;
  if (!hasRunning) {
    cmdServeStop(cwd);
  }
}

/**
 * Evaluate the deterministic brief correction outcome against the no-progress
 * rule (two consecutive identical correction details) and the maxBriefCorrections
 * budget (kusabi #578, #579).
 *
 * Shared by both the pre-seam brief validation and the post-seam chain brief
 * refusal so their budget and no-progress semantics cannot drift.
 *
 * @param {object} record Current mission record (with briefCorrectionsDetails).
 * @param {object} budget Current mission budget (with maxBriefCorrections).
 * @returns {object|null} Terminal outcome object if exhausted, or null to proceed.
 */
function evaluateBriefCorrectionOutcome(record, budget) {
  const details = record.briefCorrectionsDetails ?? [];
  const lastCorrection = details[details.length - 1];
  const prevCorrection = details.length >= 2 ? details[details.length - 2] : null;

  if (prevCorrection && lastCorrection && prevCorrection.detail === lastCorrection.detail) {
    const reason = "no progress: the same brief correction was repeated";
    return {
      disposition: "brief-correction-exhausted",
      recommendation: null,
      handoffReason: null,
      reason,
      lastCorrectionDetail: lastCorrection.detail,
    };
  }

  const maxCorrections = budget.maxBriefCorrections ?? DEFAULT_BUDGET.maxBriefCorrections;
  if ((record.briefCorrections ?? 0) >= maxCorrections) {
    const reason = `brief correction budget exhausted (${record.briefCorrections}/${maxCorrections})`;
    return {
      disposition: "brief-correction-exhausted",
      recommendation: null,
      handoffReason: null,
      reason,
      lastCorrectionDetail: lastCorrection?.detail ?? null,
    };
  }

  return null;
}

/**
 * Write the host-facing recommendation artifact for a terminal mission.
 * `finish` writes the recommendation; `escalate_to_host` writes the handoff
 * reason; the failure dispositions write their disposition and, when present,
 * a reason (e.g. the budget bound that was exhausted, or the fail-closed
 * cause of a sol-blocked gate).
 */
function writeRecommendationFile(missionDir, {
  missionId,
  disposition,
  recommendation,
  reason,
  gate,
  lastCorrectionDetail,
  lastCoordinatorErrorDetail,
}) {
  const lines = [
    "# Mission recommendation",
    "",
    `mission: ${missionId}`,
    `disposition: ${disposition}`,
    recommendation ? `recommendation: ${recommendation}` : null,
    reason ? `reason: ${oneLine(reason)}` : null,
  ].filter((line) => line !== null);

  if (disposition === "sol-blocked") {
    if (gate && typeof gate === "object") {
      const phase = typeof gate.phase === "string" ? gate.phase : "?";
      const verdict = typeof gate.verdict === "string" ? gate.verdict : "none";
      lines.push(`gate: ${gate.gateId} (phase: ${phase}, verdict: ${verdict})`);
      if (gate.verdictRecord && typeof gate.verdictRecord === "object") {
        if (typeof gate.verdictRecord.summary === "string" && gate.verdictRecord.summary.trim() !== "") {
          lines.push(`summary: ${oneLine(gate.verdictRecord.summary)}`);
        }
        if (typeof gate.verdictRecord.block_reason === "string" && gate.verdictRecord.block_reason.trim() !== "") {
          lines.push(`block_reason: ${oneLine(gate.verdictRecord.block_reason)}`);
        }
      }
      lines.push("");
      lines.push("## Next actions");
      lines.push("");
      lines.push("1. amend the mission brief (resolve what `block_reason`/`summary` names) and start a new mission");
      lines.push(`2. kusabi-companion luna-resume ${missionId} --audit-override ${gate.gateId} --audit-override-reason <reason> --audit-override-by <actor>`);
    } else {
      lines.push("");
      lines.push("## Next actions");
      lines.push("");
      lines.push("1. amend the mission brief (resolve what `block_reason`/`summary` names) and start a new mission");
    }
  } else if (disposition === "brief-correction-exhausted") {
    if (lastCorrectionDetail) {
      lines.push("");
      lines.push("## Last brief correction");
      lines.push("");
      lines.push(String(lastCorrectionDetail).trimEnd());
    }
  } else if (disposition === "coordinator-failed") {
    if (lastCoordinatorErrorDetail) {
      lines.push("");
      lines.push("## Last coordinator error");
      lines.push("");
      lines.push(String(lastCoordinatorErrorDetail).trimEnd());
    }
  }

  fs.writeFileSync(path.join(missionDir, "recommendation.md"), lines.join("\n") + "\n", "utf8");
}

/**
 * The default terminal mission notification (kusabi #531): one inbox record,
 * one deduplicated kaiba agenda row.  See chain-notify.notifyMissionTerminal.
 */
async function defaultMissionNotify({ missionId, disposition, container, cwdLabel, stateDir, reason }) {
  const { notifyMissionTerminal } = await import("./chain-notify.mjs");
  return notifyMissionTerminal({
    stateDir,
    missionId,
    disposition,
    container,
    cwdLabel,
    reason,
  });
}

/**
 * Preflight a whole valid parsed action batch against ALL remaining
 * deterministic budgets BEFORE any action executes (the atomic batch
 * contract, decision 1-5).  `read_probe` demands probe budget;
 * `run_chain` / `rework_chain` jointly demand both attempt and chain
 * budgets; `consult_sol` demands consult budget; `finish` /
 * `escalate_to_host` demand none; `maxRework` stays Sol-gate-owned.
 *
 * The check is against the REMAINING budget (persisted usage included), not
 * the caps, and the dimension evaluation order is FIXED (probes, chains,
 * attempts, consults) so an identical input always reports the same single
 * breached dimension.  The function is pure and deterministic: the caller
 * refuses the batch atomically (zero side effects, terminal
 * `budget-exhausted`, precise reason, no retry, no coordinator-error
 * increment) when it returns `ok: false`.
 *
 * @param {object[]} requests — the valid parsed action batch.
 * @param {object} record — the persisted mission record (usage counts).
 * @param {object} budget — the merged effective budget (maxProbes, maxChains,
 *        maxAttempts, maxConsults).
 * @returns {{ok: true} | {ok: false, dimension: string, reason: string}}
 */
export function preflightBatchBudget(requests, record, budget) {
  const used = {
    probes: Array.isArray(record?.probes) ? record.probes.length : 0,
    attempts: Array.isArray(record?.attempts) ? record.attempts.length : 0,
    chains: Array.isArray(record?.chains) ? record.chains.length : 0,
    consults: Array.isArray(record?.consults) ? record.consults.length : 0,
  };
  const demand = { probes: 0, attempts: 0, chains: 0, consults: 0 };
  for (const req of requests ?? []) {
    if (req?.action === "read_probe") {
      demand.probes += 1;
    } else if (req?.action === "run_chain" || req?.action === "rework_chain") {
      // run_chain / rework_chain jointly consume the attempt AND chain
      // budgets (decision 4): one action, two bounded dimensions.
      demand.attempts += 1;
      demand.chains += 1;
    } else if (req?.action === "consult_sol") {
      demand.consults += 1;
    }
    // finish / escalate_to_host consume none; maxRework stays Sol-gate-owned.
  }
  // FIXED evaluation order (probes, chains, attempts, consults): an input
  // breaching several dimensions always reports the same one.  Chains are
  // judged before attempts so a run_chain batch that breaches both bounds
  // names the chain dimension (the frozen driver contract).
  const checks = [
    {
      dimension: "probe",
      label: "maxProbes",
      max: budget?.maxProbes ?? DEFAULT_BUDGET.maxProbes,
      used: used.probes,
      demand: demand.probes,
      noun: "read_probe",
      unit: "probe",
      reasonPrefix: "budget preflight refused:",
    },
    {
      dimension: "chain",
      label: "maxChains",
      max: budget?.maxChains ?? DEFAULT_BUDGET.maxChains,
      used: used.chains,
      demand: demand.chains,
      noun: "run_chain/rework_chain",
      unit: "chain",
      reasonPrefix: "budget preflight refused:",
    },
    {
      dimension: "attempt",
      label: "maxAttempts",
      max: budget?.maxAttempts ?? DEFAULT_BUDGET.maxAttempts,
      used: used.attempts,
      demand: demand.attempts,
      noun: "run_chain/rework_chain",
      unit: "attempt",
      reasonPrefix: "budget preflight refused:",
    },
    {
      dimension: "consult",
      label: "maxConsults",
      max: budget?.maxConsults ?? DEFAULT_BUDGET.maxConsults,
      used: used.consults,
      demand: demand.consults,
      noun: "consult_sol",
      unit: "consultation",
      // The frozen consult contract pins this exact leading phrase (the
      // legacy per-request reason was "consult_sol budget exhausted: ..."),
      // so the atomic preflight keeps it and appends the remaining-budget
      // detail the atomic contract demands.
      reasonPrefix: "consult_sol budget exhausted:",
    },
  ];
  for (const check of checks) {
    const remaining = Math.max(0, check.max - check.used);
    if (check.demand > remaining) {
      return {
        ok: false,
        dimension: check.dimension,
        reason:
          `${check.reasonPrefix} the batch requests ${check.demand} ${check.noun} action(s), ` +
          `only ${remaining} ${check.unit}(s) remain (${check.label} ${check.max}, ${check.used} recorded)`,
      };
    }
  }
  return { ok: true };
}

/**
 * Run a luna mission to a terminal host-facing outcome.
 *
 * The driver is re-entrant: with `input.missionId` naming an EXISTING mission
 * directory it resumes from the persisted record (continuing evidence and
 * gate numbering, never re-executing recorded work, notifying exactly once);
 * with no mission directory it creates one.
 *
 * @param {object} input
 * @param {string} input.cwd
 * @param {string} input.missionFile
 * @param {string} input.brief — the resolved mission brief text.
 * @param {string} input.container
 * @param {string} [input.missionId] — driver-minted when absent.
 * @param {object} [input.coordinator] — {provider, model}; default codex/gpt-5.6-luna.
 * @param {object} [input.auditor] — {provider, model}; default codex/gpt-5.6-sol.
 * @param {boolean} [input.allowSubstitute] — authorizes a non-default seat.
 * @param {object} [input.budget] — {maxChains, maxAttempts, maxProbes, maxConsults, maxRework}.
 * @param {object} [input.sampling] — {rate, salt}; folded into every
 *        evaluateAuditGate call (missionId = the mission id); absent = no
 *        sampling (T12 never fires).
 * @param {object} [input.inject] — test-only seams.
 * @param {Function} [input.inject.coordinatorDispatch]
 * @param {Function} [input.inject.runChainLifecycle]
 * @param {Function} [input.inject.callTool]
 * @param {Function} [input.inject.guardedServeStop] — the one-time outer serve
 *        cleanup seam (default: the guarded liveRunningJobs + cmdServeStop
 *        semantics of chain-driver.mjs).
 * @param {Function} [input.inject.solDispatch] — async
 *        ({ cwd, missionId, missionDir, envelope, gate, record, auditor }) =>
 *        string; default: the real gpt-5.6-sol codex dispatch.
 * @param {Function} [input.inject.notifyMissionTerminal] — called exactly once
 *        per terminal mission with { missionId, disposition, ... }; default:
 *        one inbox record + one deduplicated kaiba agenda row.
 * @returns {Promise<string>} a terminal summary line.
 */
export async function runLunaMission(input) {
  const { cwd, missionFile, brief, container } = input;
  const inject = input.inject ?? {};
  const coordinatorDispatch =
    inject.coordinatorDispatch ??
    ((args) => realCoordinatorDispatch(args));
  const runChainLifecycle =
    inject.runChainLifecycle ??
    (await import("./chain-cmd.mjs")).runChainLifecycle;
  const callTool = inject.callTool ?? (await import("./sunaba-rpc.mjs")).callTool;
  const guardedServeStop = inject.guardedServeStop ?? defaultGuardedServeStop;
  const solDispatch = inject.solDispatch ?? realSolDispatch;
  const notifyMissionTerminal = inject.notifyMissionTerminal ?? defaultMissionNotify;

  // ---- exact seat resolution (refused BEFORE mission creation) ----
  const coordinator = resolveMissionSeat(input.coordinator, DEFAULT_COORDINATOR_SEAT, "coordinator", input.allowSubstitute);
  const auditor = resolveMissionSeat(input.auditor, DEFAULT_AUDITOR_SEAT, "auditor", input.allowSubstitute);

  // ---- mission identity (refused before any filesystem write) ----
  const missionId = input.missionId ?? mintMissionId();
  assertMissionIdShape(missionId);

  const budget = { ...DEFAULT_BUDGET, ...(input.budget ?? {}) };
  const stateDir = stateDirFor(cwd);
  const missionDir = path.join(stateDir, "missions", missionId);
  const resuming = fs.existsSync(missionDir);

  if (!resuming) {
    createMission(stateDir, {
      missionId,
      container,
      missionFile,
      pid: process.pid,
      coordinator,
      auditor,
    });
  }
  let record = readMissionRecord(missionDir);
  if (!record || typeof record !== "object") {
    throw new Error(`mission record missing or unreadable for ${missionId} (${missionDir}/mission.json)`);
  }

  if (resuming) {
    // A mission that already reached a terminal disposition has already
    // notified and must never dispatch again (luna-resume refuses terminal
    // missions; this guard covers direct driver calls).  The one exception is
    // a sol-blocked mission reopened by a recorded human override —
    // cmdLunaResume clears the terminal disposition in that case BEFORE the
    // driver runs, so a terminal disposition here means "already finished".
    if (
      typeof record.disposition === "string" &&
      TERMINAL_MISSION_DISPOSITIONS.has(record.disposition)
    ) {
      return (
        `mission ${missionId}: disposition=${record.disposition} ` +
        `(already terminal; nothing dispatched)`
      );
    }
    rearmMissionControl(missionDir);
  }

  // Persist the effective budget on the record so show/wait can explain a
  // budget-exhausted termination (the bound and the counts that hit it).
  record = { ...record, budget: { ...budget } };
  saveMissionRecord(missionDir, record);
  // The coordinator error cap reuses the attempts budget: a coordinator that
  // cannot produce an executable stream within the mission's bounded attempts
  // budget fails closed as `coordinator-failed`.
  const coordinatorErrorCap = Math.max(1, budget.maxAttempts);

  // The next dispatch continues the persisted evidence numbering (resume):
  // envelope files are named envelope-<N>.json, so the count of existing ones
  // is the deterministic continuation point.
  const evidenceDir = path.join(missionDir, "evidence");
  let dispatchIndex = fs.existsSync(evidenceDir)
    ? fs.readdirSync(evidenceDir).filter((f) => /^envelope-\d+\.json$/.test(f)).length
    : 0;

  let outcome = null; // { disposition, recommendation, handoffReason, reason }
  // True once the seam was invoked for a run_chain / rework_chain request —
  // the mission then owns the outer serve (keepServe: true) and must stop it
  // once.  A chain that failed inside the seam still touched the serve, so it
  // still counts; a mission that never invoked a chain has nothing to clean.
  let invokedInnerChain = false;

  // The stop predicate keys off the recorded stop request (control.json
  // stopRequestedAt).  It is checked immediately before every coordinator,
  // Sol, and inner-chain dispatch and again after an inner chain returns.
  const stopRequested = () => missionStopRequested(missionDir);

  const recordError = (detail) => {
    record = {
      ...record,
      coordinatorErrors: (record.coordinatorErrors ?? 0) + 1,
      coordinatorErrorsDetails: [
        ...(Array.isArray(record.coordinatorErrorsDetails) ? record.coordinatorErrorsDetails : []),
        { at: new Date().toISOString(), detail },
      ],
    };
    saveMissionRecord(missionDir, record);
  };
  // A deterministic pre-flight refusal of a Luna-authored brief is BOTH a
  // coordinator error and a brief correction (kusabi #532 criterion 2): the
  // counters agree by construction — one refusal, one of each — so a
  // pure-brief-correction mission never double-counts elsewhere.  The
  // correction is ALSO persisted as a structured `briefCorrectionsDetails`
  // entry carrying the timestamp, the ORIGINAL coordinator action and the
  // deterministic validator detail (sanitized + bounded by the shared
  // luna-prompt transform, so the persisted record and the rendered feedback
  // can never disagree), which the bounded renderer exposes to the next
  // coordinator turn (kusabi #553 follow-up).
  const recordBriefCorrection = (action, detail) => {
    const sanitized = sanitizeBriefCorrectionDetail(detail);
    const at = new Date().toISOString();
    record = {
      ...record,
      briefCorrections: (record.briefCorrections ?? 0) + 1,
      briefCorrectionsDetails: [
        ...(Array.isArray(record.briefCorrectionsDetails) ? record.briefCorrectionsDetails : []),
        { at, action, detail: sanitized },
      ],
    };
    saveMissionRecord(missionDir, record);
  };
  // Only interventions the system can OBSERVE are recorded (kusabi #532
  // criterion 2): escalate_to_host, overrides, and explicit manifest entries.
  // Manual container work is never inferred.
  const recordHostIntervention = (detail) => {
    record = {
      ...record,
      hostInterventions: (record.hostInterventions ?? 0) + 1,
      hostInterventionDetails: [
        ...(Array.isArray(record.hostInterventionDetails) ? record.hostInterventionDetails : []),
        { at: new Date().toISOString(), detail },
      ],
    };
    saveMissionRecord(missionDir, record);
  };
  const recordProbe = (req, output) => {
    const capped = capProbeOutput(output);
    record = {
      ...record,
      probes: [
        ...(Array.isArray(record.probes) ? record.probes : []),
        {
          action: "read_probe",
          tool: req.tool,
          path: req.path,
          output: capped.output,
          outputBytes: capped.outputBytes,
          truncated: capped.truncated,
          omittedBytes: capped.omittedBytes,
          truncation: capped.truncation,
          at: new Date().toISOString(),
        },
      ],
    };
    saveMissionRecord(missionDir, record);
  };
  const recordAttempt = ({ index, kind, chainId, brief: attemptBrief, output, postChain }) => {
    const attemptRecord = {
      index,
      kind,
      chainId,
      brief: attemptBrief,
      status: "completed",
      output,
      ...(postChain ? { postChain } : {}),
      at: new Date().toISOString(),
    };
    record = {
      ...record,
      attempts: [
        ...(Array.isArray(record.attempts) ? record.attempts : []),
        attemptRecord,
      ],
      chains: [...(Array.isArray(record.chains) ? record.chains : []), chainId],
    };
    saveMissionRecord(missionDir, record);
    const attemptFile = path.join(missionDir, "attempts", `attempt-${index}.json`);
    fs.mkdirSync(path.dirname(attemptFile), { recursive: true });
    writeJson(attemptFile, record.attempts[record.attempts.length - 1]);
  };
  const recordConsult = (req) => {
    record = {
      ...record,
      consults: [
        ...(Array.isArray(record.consults) ? record.consults : []),
        { action: "consult_sol", reason: req.reason ?? "", at: new Date().toISOString() },
      ],
    };
    saveMissionRecord(missionDir, record);
  };
  // Persist a freshly evaluated gate set (archival + the new gate record)
  // BEFORE any further observable dispatch, so resume continues from a
  // durable boundary.
  const recordGates = (gates) => {
    record = { ...record, auditGates: gates };
    saveMissionRecord(missionDir, record);
  };

  /**
   * Mirror a fired post-chain gate's audit columns onto the durable inner
   * chain round the gate judged (kusabi #532 adjudication finding 5).  The
   * round record lives in TWO durable mirrors \u2014 `round-<N>.json` and the
   * terminal entry of `chain.json`'s `records` array (the array the metrics
   * ingest reads) \u2014 and both are updated through the existing safe
   * read/update/write boundary (readJson / atomic writeJson).  The mission
   * gate record stays authoritative; this is a best-effort mirror that never
   * changes the gate decision.
   *
   * Only when the target round is POSITIVELY identified: the chain's
   * terminal record must be an object with a numeric `round`, and both
   * `chain.json` and the `round-<N>.json` file must exist and parse.
   * Absent or unreadable legacy records are left untouched.
   */
  const persistRoundAuditColumns = ({ chainId, gate, outcome }) => {
    if (!gate || typeof gate !== "object") return;
    const chainDir = path.join(stateDir, "chains", chainId);
    const chainJson = readJson(path.join(chainDir, "chain.json"));
    if (!chainJson || typeof chainJson !== "object") return;
    const records = Array.isArray(chainJson.records) ? chainJson.records : [];
    const terminal = records[records.length - 1];
    if (!terminal || typeof terminal !== "object" || typeof terminal.round !== "number") return;
    const roundRecord = readJson(path.join(chainDir, `round-${terminal.round}.json`));
    if (!roundRecord || typeof roundRecord !== "object") return;

    const auditColumns = {
      auditVerdict: typeof gate.verdict === "string" ? gate.verdict : null,
      auditBlocked: outcome === "sol-blocked" || outcome === "block",
      auditShadowDisposition:
        typeof gate.shadowDisposition === "string" ? gate.shadowDisposition : null,
    };
    writeJson(path.join(chainDir, `round-${terminal.round}.json`), {
      ...roundRecord,
      ...auditColumns,
    });
    writeJson(path.join(chainDir, "chain.json"), {
      ...chainJson,
      records: records.map((r, i) =>
        i === records.length - 1 ? { ...r, ...auditColumns } : r,
      ),
    });
  };

  /**
   * The single gate-evaluation helper: runs evaluateMissionGate, persists the
   * gate records, and returns the outcome.  A "cancelled" outcome means a
   * stop request landed before the Sol dispatch.
   */
  const runGate = async ({ phase, reason }) => {
    const result = await evaluateMissionGate({
      cwd,
      missionId,
      missionDir,
      brief,
      container,
      auditor,
      allowSubstitute: input.allowSubstitute,
      sampling: input.sampling,
      phase,
      reason: reason ?? null,
      record,
      solDispatch,
      stopRequested,
      maxRework: budget.maxRework ?? DEFAULT_BUDGET.maxRework,
    });
    if (result.fired) recordGates(result.gates);
    return result;
  };

  mainLoop: for (;;) {
    if (outcome !== null) break;

    // The stop request is honored at the top of every loop iteration:
    // cancellation before any seat — no coordinator dispatch at all.
    if (stopRequested()) {
      outcome = { disposition: "cancelled", recommendation: null, handoffReason: null, reason: "stop requested" };
      break;
    }

    // A coordinator that burns the bounded error budget fails closed.
    if ((record.coordinatorErrors ?? 0) >= coordinatorErrorCap) {
      outcome = {
        disposition: "coordinator-failed",
        recommendation: null,
        handoffReason: null,
        reason: `coordinator error budget exhausted (${record.coordinatorErrors ?? 0}/${coordinatorErrorCap})`,
      };
      break;
    }

    dispatchIndex += 1;
    // The envelope is rebuilt for EVERY dispatch from the current record, so
    // the next coordinator request is bound to current evidence and prior
    // outcomes (refreshed after every observable action).
    let envelope;
    try {
      envelope = buildEvidenceEnvelope({
        missionId,
        missionDir,
        brief,
        container,
        coordinator,
        auditor,
        allowSubstitute: input.allowSubstitute,
        record,
        dispatchIndex,
      });
    } catch (err) {
      const detail = `evidence envelope build failed: ${err.message}`;
      recordError(detail);
      const firstLine = detail.split(/\r?\n/)[0];
      outcome = {
        disposition: "coordinator-failed",
        recommendation: null,
        handoffReason: null,
        reason: `coordinator error: ${firstLine}`,
        lastCoordinatorErrorDetail: detail,
      };
      break;
    }
    writeJson(path.join(missionDir, "evidence", `envelope-${dispatchIndex}.json`), envelope);

    // A thrown dispatch must not leave the mission/control permanently
    // running: it is recorded as a coordinator error and terminates the
    // mission `coordinator-failed` through the SAME finalisation path as any
    // other terminal outcome (records + recommendation/handoff + cleanup).
    let rawOutput;
    try {
      rawOutput = await coordinatorDispatch({
        cwd,
        missionId,
        missionDir,
        missionFile,
        brief,
        container,
        envelope,
        record: { ...record },
        coordinator,
        auditor,
      });
    } catch (err) {
      const detail = `coordinator dispatch failed: ${err.message}`;
      recordError(detail);
      const firstLine = detail.split(/\r?\n/)[0];
      outcome = {
        disposition: "coordinator-failed",
        recommendation: null,
        handoffReason: null,
        reason: `coordinator error: ${firstLine}`,
        lastCoordinatorErrorDetail: detail,
      };
      break;
    }
    fs.mkdirSync(path.join(missionDir, "evidence"), { recursive: true });
    fs.writeFileSync(path.join(missionDir, "evidence", `coordinator-output-${dispatchIndex}.txt`), String(rawOutput ?? ""), "utf8");

    const parsed = parseCoordinatorOutput(String(rawOutput ?? ""), { envelopeSha256: envelope.envelope_sha256 });
    if (!parsed.valid) {
      // Fail closed: a stream with any malformed / rejected / incomplete
      // record executes NOTHING.  The counts are recorded as coordinator
      // errors (the rejected action NAMES are deliberately not persisted —
      // an unknown verb like "publish" must never appear in mission state).
      // The first error's reason code and line are named (never its detail:
      // an unknown-action detail is the rejected verb itself).  Without them
      // "incomplete 0 rejected, 0 malformed" hid a truncated-record at the
      // `}{` join of concatenated codex messages (mission-mudmmnaub60f0b20).
      const first = parsed.errors[0];
      recordError(
        `coordinator stream invalid: ${parsed.incomplete ? "incomplete" : ""} ` +
        `${parsed.rejectedCount} rejected, ${parsed.malformedCount} malformed record(s)` +
        (first ? `; first: ${first.reason} at line ${first.line}` : "; no records"),
      );
      continue;
    }

    // Whole-batch budget preflight (atomic batch semantics, decision 1-5):
    // the ENTIRE valid parsed action batch is checked against ALL remaining
    // deterministic budgets BEFORE any action executes.  An oversized batch
    // is refused atomically — zero tool / chain / Sol / host side effects,
    // terminal `budget-exhausted`, a precise persisted reason, no retry and
    // no coordinator-error increment.  Whole-batch atomicity wins even when a
    // terminal action (finish / escalate_to_host) leads or trails the
    // over-budget actions.  The per-request budget checks below remain as
    // defense-in-depth.
    if (stopRequested()) {
      outcome = { disposition: "cancelled", recommendation: null, handoffReason: null, reason: "stop requested" };
      break mainLoop;
    }
    const preflight = preflightBatchBudget(parsed.requests, record, budget);
    if (!preflight.ok) {
      outcome = {
        disposition: "budget-exhausted",
        recommendation: null,
        handoffReason: null,
        reason: preflight.reason,
      };
      break mainLoop;
    }

    for (const req of parsed.requests) {
      // Stop check before EVERY request execution: no coordinator, auditor,
      // inner-chain, retry, rework, or replacement seat may be dispatched
      // after the stop request, including at inner-chain return boundaries.
      if (stopRequested()) {
        outcome = { disposition: "cancelled", recommendation: null, handoffReason: null, reason: "stop requested" };
        break mainLoop;
      }
      switch (req.action) {
        case "read_probe": {
          const probeCount = Array.isArray(record.probes) ? record.probes.length : 0;
          if (probeCount >= budget.maxProbes) {
            outcome = { disposition: "budget-exhausted", recommendation: null, handoffReason: null };
            break mainLoop;
          }
          if (!PROBE_TOOL_ALLOWLIST.has(req.tool)) {
            recordError(`read_probe refused: tool "${req.tool}" is not on the driver allow-list`);
            continue;
          }
          // Per-tool required-field enforcement AT THE DRIVER BOUNDARY, before
          // any tool call: a probe missing a required top-level field — in
          // particular a search without a non-empty, non-whitespace `pattern`
          // — is refused fail-closed and never reaches the seam.  The driver
          // never fabricates a missing value.
          const missingFields = probeRequestMissingFields(req);
          if (missingFields.length > 0) {
            recordError(
              `read_probe refused: ${req.tool} requires ${missingFields.map((f) => `a non-empty \`${f}\``).join(" and ")}`,
            );
            continue;
          }
          let output;
          try {
            output = await callTool(req.tool, probeArgsFor(req.tool, container, req));
          } catch (err) {
            recordError(`read_probe failed: ${err.message}`);
            continue;
          }
          recordProbe(req, output);
          continue;
        }
        case "run_chain":
        case "rework_chain": {
          const attemptCount = Array.isArray(record.attempts) ? record.attempts.length : 0;
          const chainCount = Array.isArray(record.chains) ? record.chains.length : 0;
          // A budget breach terminates the mission and never creates another
          // chain.
          if (attemptCount >= budget.maxAttempts || chainCount >= budget.maxChains) {
            outcome = { disposition: "budget-exhausted", recommendation: null, handoffReason: null };
            break mainLoop;
          }
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
          const stampModel = record?.coordinator?.actual ?? coordinator.actual;
          const stampNow =
            typeof inject.now === "function" ? inject.now() : new Date();
          const stampDate = new Date(stampNow).toISOString().slice(0, 10);
          const stampedBrief = stampInnerBriefSignature(req.brief ?? "", {
            model: stampModel,
            session: missionId,
            date: stampDate,
          });
          if (!validChainBrief(stampedBrief) || (await innerBriefValidationReport(stampedBrief, container)) !== null) {
            // Decision 5: the pre-seam refusal is a BRIEF CORRECTION \u2014 one
            // precise defect named (never a generic message), no chain state
            // and no seam call.  The stamping above is metadata enrichment
            // only and never repairs the semantic defect (decision 6).
            const report = await innerBriefValidationReport(stampedBrief, container);
            const detail =
              report === null
                ? `${req.action} refused: the inner chain brief fails deterministic validation`
                : `${req.action} refused: the inner chain brief fails deterministic validation\n${report}`;
            recordBriefCorrection(req.action, detail);
            const correctionOutcome = evaluateBriefCorrectionOutcome(record, budget);
            if (correctionOutcome) {
              outcome = correctionOutcome;
              break mainLoop;
            }

            continue;
          }
          // PRE-DISPATCH GATE: the deterministic driver, never Luna, decides
          // whether the Sol seat must judge this dispatch.
          const pre = await runGate({ phase: "pre-dispatch", reason: null });
          if (pre.outcome === "cancelled") {
            outcome = { disposition: "cancelled", recommendation: null, handoffReason: null, reason: "stop requested" };
            break mainLoop;
          }
          if (pre.outcome === "sol-blocked" || pre.outcome === "block") {
            outcome = {
              disposition: "sol-blocked",
              recommendation: null,
              handoffReason: null,
              reason: "Sol audit gate blocked this dispatch",
              gate: pre.gate ?? null,
            };
            break mainLoop;
          }
          if (pre.outcome === "rework") {
            // The audit demands rework before a fresh chain: the request is
            // refused (counted as a coordinator error, so a coordinator that
            // keeps proposing chains instead of a rework_chain fails closed).
            recordError(`${req.action} refused: pre-dispatch Sol gate ${pre.gate.gateId} returned rework`);
            continue;
          }
          // Stop check immediately before the inner-chain dispatch (a stop
          // that landed between the gate and the seam).
          if (stopRequested()) {
            outcome = { disposition: "cancelled", recommendation: null, handoffReason: null, reason: "stop requested" };
            break mainLoop;
          }
          const chainId = mintChainId();
          invokedInnerChain = true;
          let chainOutput;
          try {
            chainOutput = await runChainLifecycle(
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
          } catch (err) {
            const { BRIEF_REFUSED_CODE } = await briefValidators();
            if (err?.code === BRIEF_REFUSED_CODE) {
              const detail = `${req.action} refused by the chain seam: ${err.message}`;
              recordBriefCorrection(req.action, detail);
              const correctionOutcome = evaluateBriefCorrectionOutcome(record, budget);
              if (correctionOutcome) {
                outcome = correctionOutcome;
                break mainLoop;
              }
              continue;
            }
            recordError(`${req.action} execution failed for chain ${chainId}: ${err.message}`);
            continue;
          }
          const postChain = await collectPostChainEvidence({
            stateDir,
            chainId,
            container,
            callTool,
          });
          recordAttempt({
            index: (Array.isArray(record.attempts) ? record.attempts.length : 0) + 1,
            kind: req.action,
            chainId,
            brief: req.brief,
            output: String(chainOutput ?? ""),
            postChain,
          });
          // Stop check again AFTER the inner chain returns: cancellation
          // during an inner chain must stop before any post-chain seat.
          if (stopRequested()) {
            outcome = { disposition: "cancelled", recommendation: null, handoffReason: null, reason: "stop requested" };
            break mainLoop;
          }
          // POST-CHAIN GATE: after each inner-chain terminal result.
          const post = await runGate({ phase: "post-chain", reason: null });
          // The gate judged THIS inner chain: mirror its audit columns onto
          // the durable round the chain just completed (best-effort \u2014 a
          // missing/unreadable legacy round stays untouched; the mission gate
          // record remains authoritative).  Runs before any outcome branch so
          // clear / rework / block / fail-closed all leave the same trace.
          persistRoundAuditColumns({ chainId, gate: post.gate, outcome: post.outcome });
          if (post.outcome === "cancelled") {
            outcome = { disposition: "cancelled", recommendation: null, handoffReason: null, reason: "stop requested" };
            break mainLoop;
          }
          if (post.outcome === "sol-blocked" || post.outcome === "block") {
            outcome = {
              disposition: "sol-blocked",
              recommendation: null,
              handoffReason: null,
              reason: "Sol audit gate blocked the chain outcome",
              gate: post.gate ?? null,
            };
            break mainLoop;
          }
          // A post-chain `rework` (within the bound) is recorded and the loop
          // continues: the coordinator's next request (a rework_chain) is
          // itself gated and bounded.
          continue;
        }
        case "consult_sol": {
          // An accepted consult_sol opens an ADDITIVE Sol gate: it can never
          // suppress, remove, downgrade, or satisfy a separately mandatory
          // gate (the pre-accept T11 gate still fires independently).  A
          // consult-only coordinator consumes no chain/probe budget, so the
          // consult bound is what stops it.
          const consultCount = Array.isArray(record.consults) ? record.consults.length : 0;
          if (consultCount >= budget.maxConsults) {
            outcome = {
              disposition: "budget-exhausted",
              recommendation: null,
              handoffReason: null,
              reason:
                `consult_sol budget exhausted: ${consultCount} accepted consultation(s) ` +
                `reached maxConsults ${budget.maxConsults}`,
            };
            break mainLoop;
          }
          const consult = await runGate({ phase: "consult", reason: req.reason ?? "" });
          if (consult.outcome === "cancelled") {
            outcome = { disposition: "cancelled", recommendation: null, handoffReason: null, reason: "stop requested" };
            break mainLoop;
          }
          if (consult.outcome === "sol-blocked" || consult.outcome === "block") {
            outcome = {
              disposition: "sol-blocked",
              recommendation: null,
              handoffReason: null,
              reason: "Sol audit gate blocked the requested consultation",
              gate: consult.gate ?? null,
            };
            break mainLoop;
          }
          recordConsult(req);
          continue;
        }
        case "escalate_to_host": {
          // A host escalation is NOT approval-shaped — it is never held
          // behind an approval gate (escalate_to_host must always be able to
          // write the host recommendation).  The handoff IS an observed host
          // intervention and is recorded explicitly (kusabi #532 criterion 2).
          recordHostIntervention(
            `escalate_to_host: ${req.reason ?? "host judgement required"}`,
          );
          outcome = {
            disposition: "host-handoff",
            recommendation: null,
            handoffReason: req.reason ?? "",
          };
          break mainLoop;
        }
        case "finish": {
          if (!RECOMMENDATION_VOCABULARY.has(req.recommendation)) {
            recordError(`finish refused: recommendation "${req.recommendation}" is outside the closed vocabulary`);
            continue;
          }
          // The terminal mandatory gate (T11) applies to approval-shaped
          // `recommend-accept` only; recommend-escalate is not gated.
          if (req.recommendation === "recommend-accept") {
            const acceptGate = await runGate({ phase: "pre-accept", reason: null });
            if (acceptGate.outcome === "cancelled") {
              outcome = { disposition: "cancelled", recommendation: null, handoffReason: null, reason: "stop requested" };
              break mainLoop;
            }
            if (acceptGate.outcome === "sol-blocked" || acceptGate.outcome === "block") {
              outcome = {
                disposition: "sol-blocked",
                recommendation: null,
                handoffReason: null,
                reason: "Sol audit gate blocked the accept recommendation",
                gate: acceptGate.gate ?? null,
              };
              break mainLoop;
            }
            if (acceptGate.outcome === "rework") {
              // The audit demands rework before the recommendation is trusted:
              // the finish is refused and the coordinator gets another chance
              // to propose a bounded rework_chain (or the rework bound fails
              // the mission closed).
              recordError(`finish recommend-accept refused: pre-accept Sol gate ${acceptGate.gate?.gateId} returned rework`);
              continue;
            }
          }
          outcome = {
            disposition: req.recommendation,
            recommendation: req.recommendation,
            handoffReason: null,
          };
          break mainLoop;
        }
        default:
          // Unreachable: the frozen parser only accepts the six verbs.  A
          // defensive fail-closed path — the mission must never execute a
          // verb the driver does not know.
          recordError(`request action "${req.action}" is outside the driver's execution set`);
          continue;
      }
    }
  }

  // ---- terminal finalisation (sticky by construction: it happens once) ----
  const terminationReason = outcome.handoffReason ?? outcome.reason ?? null;
  // Terminal wall-clock timing (kusabi #532 criterion 2): finishedAt is set
  // on terminal completion, and latencySeconds is the recorded wall clock
  // (finishedAt − startedAt); only when the durable startedAt is parseable
  // — a record without one gets finishedAt but never a fabricated latency.
  const finishedAt = new Date().toISOString();
  let latencySeconds;
  if (typeof record.startedAt === "string" && record.startedAt) {
    const startedMs = Date.parse(record.startedAt);
    if (Number.isFinite(startedMs)) {
      latencySeconds = (Date.parse(finishedAt) - startedMs) / 1000;
    }
  }
  record = {
    ...record,
    status: "completed",
    disposition: outcome.disposition,
    recommendation: outcome.recommendation,
    terminationReason,
    finishedAt,
    ...(latencySeconds !== undefined ? { latencySeconds } : {}),
  };
  saveMissionRecord(missionDir, record);
  finalizeMissionControl(missionDir, outcome.disposition === "cancelled" ? "cancelled" : "completed");
  const lastCoordinatorErrorDetail =
    outcome.lastCoordinatorErrorDetail ??
    (Array.isArray(record.coordinatorErrorsDetails) && record.coordinatorErrorsDetails.length > 0
      ? record.coordinatorErrorsDetails[record.coordinatorErrorsDetails.length - 1]?.detail
      : null);
  writeRecommendationFile(missionDir, {
    missionId,
    disposition: outcome.disposition,
    recommendation: outcome.recommendation,
    reason: terminationReason,
    gate: outcome.gate,
    lastCorrectionDetail: outcome.lastCorrectionDetail,
    lastCoordinatorErrorDetail,
  });

  // ---- exactly one terminal notification per terminal mission ----
  const notifyReason =
    outcome.disposition === "sol-blocked" && outcome.gate
      ? (() => {
          const g = outcome.gate;
          const vr = g?.verdictRecord;
          const text =
            (typeof vr?.block_reason === "string" && vr.block_reason.trim()) ||
            (typeof vr?.summary === "string" && vr.summary.trim()) ||
            terminationReason ||
            "";
          const verdict = typeof g?.verdict === "string" ? g.verdict : "none";
          return g?.gateId ? `${g.gateId} ${verdict}: ${text}`.trim() : terminationReason;
        })()
      : terminationReason;

  try {
    await notifyMissionTerminal({
      missionId,
      disposition: outcome.disposition,
      missionDir,
      recommendation: outcome.recommendation,
      container,
      cwdLabel: path.basename(cwd),
      stateDir,
      reason: notifyReason ?? undefined,
    });
  } catch { /* best-effort — the terminal record is already durable */ }

  // ---- one-time outer serve cleanup (the mission owns the serve because it
  // passes keepServe: true to inner chains) ----
  // Runs on every terminal path — including coordinator failures and chain
  // failures — but only when inner chain work was actually invoked: a mission
  // with no inner chain never invents cleanup work.  Best-effort: a cleanup
  // failure must never mask the primary terminal result.
  if (invokedInnerChain) {
    try {
      await guardedServeStop(cwd, stateDir);
    } catch { /* best-effort — never mask the terminal result */ }
  }

  return (
    `mission ${missionId}: disposition=${outcome.disposition}` +
    (outcome.recommendation ? ` recommendation=${outcome.recommendation}` : "") +
    (outcome.disposition === "cancelled" ? ` (cancelled)` : "") +
    (outcome.disposition === "sol-blocked" ? ` (${terminationReason ?? "sol-blocked"})` : "") +
    ` (recommendation: ${path.join(missionDir, "recommendation.md")})`
  );
}