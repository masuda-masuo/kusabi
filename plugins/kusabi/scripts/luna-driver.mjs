// luna-driver.mjs — kusabi #530: the deterministic luna mission driver.
//
// A luna mission is an opt-in dispatch surface: the gpt-5.6-luna coordinator
// seat proposes bounded actions as line-oriented JSON records, and THIS
// driver is the only authority that validates and executes them.  The
// contract, frozen by luna-driver.test.mjs:
//
//   - the coordinator's output is parsed ONLY through parseCoordinatorOutput
//     (the frozen #529 parser) against the CURRENT immutable evidence
//     envelope hash; if any record is malformed, incomplete, unknown, or
//     bound to another envelope, NOTHING in that stream executes;
//   - only the frozen action enum executes: read_probe, run_chain,
//     rework_chain, consult_sol, escalate_to_host, finish;
//   - requests execute sequentially, bounded by an explicit mission budget
//     (maxChains / maxAttempts / maxProbes); a budget breach terminates the
//     mission `budget-exhausted` and never creates another chain;
//   - run_chain / rework_chain go through the runChainLifecycle seam (never
//     runChainDriver directly) with a driver-minted chain id and
//     keepServe: true — the mission is the single outer serve owner;
//   - read_probe is driver-mediated through an allow-listed tool set and is
//     recorded; Luna itself has no tool or job-spawn authority;
//   - consult_sol is RECORDED as a requested consultation/handoff input only
//     (no Sol gate execution — that is #531);
//   - the mission never accepts, publishes, merges, creates issues or
//     creates containers; its terminal result is a host-facing
//     recommendation (finish) or a host handoff (escalate_to_host);
//   - seat substitution fails before mission creation unless explicitly
//     authorized, and authorized substitution is loud in the records;
//   - the evidence envelope is refreshed after every observable action, so
//     the next coordinator request is bound to current evidence and prior
//     outcomes.
//
// The driver receives injected coordinator/chain/tool seams in tests and real
// adapters in production (the real coordinator dispatch runs the exact
// gpt-5.6-luna seat through the codex backend).

import fs from "node:fs";
import path from "node:path";
import { stateDirFor, writeJson } from "./state-paths.mjs";
import { parseCoordinatorOutput } from "./coordinator-parse.mjs";
import { buildAuditEnvelope, truncateEvidenceText } from "./audit-envelope.mjs";
import { hasSectionHeading, parseDeliverables } from "./brief-parsing.mjs";
import { mintChainId } from "./chain-phases.mjs";
import {
  mintMissionId,
  assertMissionIdShape,
  createMission,
  readMissionRecord,
  saveMissionRecord,
  finalizeMissionControl,
} from "./mission-store.mjs";

/** The exact default seats of #530: coordinator codex/gpt-5.6-luna, auditor codex/gpt-5.6-sol. */
export const DEFAULT_COORDINATOR_SEAT = { provider: "codex", model: "gpt-5.6-luna" };
export const DEFAULT_AUDITOR_SEAT = { provider: "codex", model: "gpt-5.6-sol" };

/**
 * The explicit mission budget: bounded chains, attempts, probes and consults.
 * `maxConsults` bounds `consult_sol` requests (the coordination loop a
 * consult-only coordinator could otherwise run forever) — a conservative
 * default, overridable per mission like every other bound.
 */
export const DEFAULT_BUDGET = { maxChains: 3, maxAttempts: 2, maxProbes: 5, maxConsults: 3 };

/**
 * Documented byte limit for a probe result's serialized payload persisted to
 * mission.json.  Independent of the evidence envelope's own budget: raw
 * mission persistence must be bounded on its own (capProbeOutput).
 */
export const PROBE_OUTPUT_MAX_BYTES = 8192;

/**
 * The small closed vocabulary a `finish` recommendation is validated against.
 * `accept` (the chain verb) is deliberately not here — the mission's terminal
 * result is a recommendation, never an acceptance.
 */
export const RECOMMENDATION_VOCABULARY = new Set(["recommend-accept", "recommend-escalate"]);

/**
 * The allow-listed read-only probe tools the driver mediates `read_probe`
 * through.  Nothing here can spawn a job, write a file, or run an arbitrary
 * command — the coordinator has no tool or job-spawn authority.
 */
export const PROBE_TOOL_ALLOWLIST = new Set(["read_file_range", "search_in_container", "list_files"]);

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
  return { provider, model, requested: def.model, actual: model, substituted };
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

/**
 * The mission ledger, persisted as evidence so the next envelope hash changes
 * after any observable action (attempts, probes, consults, errors).
 */
function missionLedgerText(record) {
  return JSON.stringify({
    attempts: Array.isArray(record.attempts) ? record.attempts.length : 0,
    chains: Array.isArray(record.chains) ? record.chains : [],
    probes: Array.isArray(record.probes) ? record.probes.length : 0,
    consults: Array.isArray(record.consults) ? record.consults.length : 0,
    coordinatorErrors: record.coordinatorErrors ?? 0,
  });
}

/**
 * Build the immutable evidence envelope the NEXT coordinator dispatch is
 * bound to.  The envelope binds the mission brief, every worker report
 * (chain attempt output), every probe raw, and the mission ledger — so any
 * observable action changes the envelope hash.
 */
function buildEvidenceEnvelope({ missionId, missionDir, brief, container, coordinator, allowSubstitute, record, dispatchIndex }) {
  const items = [
    { role: "luna_brief", source: "mission-file", content: brief ?? "", path: "evidence/mission-brief.txt" },
  ];
  const attempts = Array.isArray(record?.attempts) ? record.attempts : [];
  attempts.forEach((attempt, i) => {
    items.push({
      role: "worker_report",
      source: `attempt-${attempt.index}`,
      content: String(attempt.output ?? attempt.brief ?? ""),
      path: `evidence/worker-report-${i}.txt`,
    });
  });
  const probes = Array.isArray(record?.probes) ? record.probes : [];
  probes.forEach((probe, i) => {
    items.push({
      role: "probe_raw",
      source: `probe-${i}`,
      content: String(probe.output ?? ""),
      path: `evidence/probe-${i}.txt`,
    });
  });
  items.push({
    role: "worker_report",
    source: "mission-ledger",
    content: missionLedgerText(record ?? {}),
    path: "evidence/mission-ledger.txt",
  });
  return buildAuditEnvelope({
    gateId: `mission-${missionId}-dispatch-${dispatchIndex}`,
    missionId,
    chainId: null,
    policyVersion: 1,
    seat: coordinator,
    triggers: [],
    container,
    baseSha: null,
    changeScope: {},
    items,
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
 */
function probeArgsFor(tool, container, req) {
  if (tool === "read_file_range") return { container_id: container, file_path: req.path };
  if (tool === "search_in_container") return { container_id: container, pattern: req.pattern ?? "", path: req.path ?? "" };
  if (tool === "list_files") return { container_id: container, path: req.path ?? "/workspace" };
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
 * The real coordinator dispatch (production): run the exact gpt-5.6-luna seat
 * through the codex backend with the mission brief and the current envelope
 * as framing, and return its raw output text (the JSONL request stream).  The
 * kusabi-coordinate agent grants zero tools; the envelope is the only
 * evidence path.
 */
async function realCoordinatorDispatch({ cwd, missionId, brief, envelope, coordinator }) {
  const { codexDispatch } = await import("./codex-dispatch.mjs");
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
    `Answer with line-oriented JSON request records, one per line, each with ` +
      `action and envelope_sha256 set to ${envelope.envelope_sha256}.`,
  ].join("\n");
  const { resultText } = await codexDispatch({
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
  return resultText;
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
 * Write the host-facing recommendation artifact for a terminal mission.
 * `finish` writes the recommendation; `escalate_to_host` writes the handoff
 * reason; the failure dispositions write their disposition and, when present,
 * a reason (e.g. the budget bound that was exhausted).
 */
function writeRecommendationFile(missionDir, { missionId, disposition, recommendation, reason }) {
  const lines = [
    "# Mission recommendation",
    "",
    `mission: ${missionId}`,
    `disposition: ${disposition}`,
    recommendation ? `recommendation: ${recommendation}` : null,
    reason ? `reason: ${reason}` : null,
  ].filter((line) => line !== null);
  fs.writeFileSync(path.join(missionDir, "recommendation.md"), lines.join("\n") + "\n", "utf8");
}

/**
 * Run a luna mission to a terminal host-facing outcome.
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
 * @param {object} [input.budget] — {maxChains, maxAttempts, maxProbes}.
 * @param {object} [input.inject] — test-only seams.
 * @param {Function} [input.inject.coordinatorDispatch]
 * @param {Function} [input.inject.runChainLifecycle]
 * @param {Function} [input.inject.callTool]
 * @param {Function} [input.inject.guardedServeStop] — the one-time outer serve
 *        cleanup seam (default: the guarded liveRunningJobs + cmdServeStop
 *        semantics of chain-driver.mjs).
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
  // The one-time outer serve cleanup the mission owns because it passes
  // keepServe: true to inner chains (finding: the mission must stop the
  // shared serve exactly once after inner work, guarded against live jobs).
  const guardedServeStop = inject.guardedServeStop ?? defaultGuardedServeStop;

  // ---- exact seat resolution (refused BEFORE mission creation) ----
  const coordinator = resolveMissionSeat(input.coordinator, DEFAULT_COORDINATOR_SEAT, "coordinator", input.allowSubstitute);
  const auditor = resolveMissionSeat(input.auditor, DEFAULT_AUDITOR_SEAT, "auditor", input.allowSubstitute);

  // ---- mission identity (refused before any filesystem write) ----
  const missionId = input.missionId ?? mintMissionId();
  assertMissionIdShape(missionId);

  const budget = { ...DEFAULT_BUDGET, ...(input.budget ?? {}) };
  const stateDir = stateDirFor(cwd);
  const { missionDir } = createMission(stateDir, {
    missionId,
    container,
    missionFile,
    pid: process.pid,
    coordinator,
    auditor,
  });

  let record = readMissionRecord(missionDir);
  // Persist the effective budget on the record so show/wait can explain a
  // budget-exhausted termination (the bound and the counts that hit it).
  record = { ...record, budget: { ...budget } };
  saveMissionRecord(missionDir, record);
  // The coordinator error cap reuses the attempts budget: a coordinator that
  // cannot produce an executable stream within the mission's bounded attempts
  // budget fails closed as `coordinator-failed`.
  const coordinatorErrorCap = Math.max(1, budget.maxAttempts);

  let dispatchIndex = 0;
  let outcome = null; // { disposition, recommendation, handoffReason }
  // True once the seam was invoked for a run_chain / rework_chain request —
  // the mission then owns the outer serve (keepServe: true) and must stop it
  // once.  A chain that failed inside the seam still touched the serve, so it
  // still counts; a mission that never invoked a chain has nothing to clean.
  let invokedInnerChain = false;

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
  const recordAttempt = ({ index, kind, chainId, brief: attemptBrief, output }) => {
    record = {
      ...record,
      attempts: [
        ...(Array.isArray(record.attempts) ? record.attempts : []),
        { index, kind, chainId, brief: attemptBrief, status: "completed", output, at: new Date().toISOString() },
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

  mainLoop: for (;;) {
    if (outcome !== null) break;

    // A coordinator that burns the bounded error budget fails closed.
    if ((record.coordinatorErrors ?? 0) >= coordinatorErrorCap) {
      outcome = { disposition: "coordinator-failed", recommendation: null, handoffReason: null };
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
      recordError(`evidence envelope build failed: ${err.message}`);
      outcome = { disposition: "coordinator-failed", recommendation: null, handoffReason: null };
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
      recordError(`coordinator dispatch failed: ${err.message}`);
      outcome = { disposition: "coordinator-failed", recommendation: null, handoffReason: null };
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
      recordError(
        `coordinator stream invalid: ${parsed.incomplete ? "incomplete" : ""} ` +
        `${parsed.rejectedCount} rejected, ${parsed.malformedCount} malformed record(s)`,
      );
      continue;
    }

    for (const req of parsed.requests) {
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
          if (!validChainBrief(req.brief)) {
            recordError(`${req.action} refused: the inner chain brief fails deterministic validation`);
            continue;
          }
          const chainId = mintChainId();
          invokedInnerChain = true;
          let chainOutput;
          try {
            chainOutput = await runChainLifecycle(
              cwd,
              {
                flags: { container, "chain-id": chainId, keepServe: true },
                text: req.brief,
                orchestrator: null,
              },
              {},
            );
          } catch (err) {
            recordError(`${req.action} execution failed for chain ${chainId}: ${err.message}`);
            continue;
          }
          recordAttempt({
            index: (Array.isArray(record.attempts) ? record.attempts.length : 0) + 1,
            kind: req.action,
            chainId,
            brief: req.brief,
            output: String(chainOutput ?? ""),
          });
          continue;
        }
        case "consult_sol": {
          // Recorded as a requested consultation/handoff input only — no Sol
          // gate execution in this slice (#531 owns it).  A consult-only
          // coordinator consumes no chain/probe budget, so this bound is what
          // stops it: each accepted consult consumes one slot, and the request
          // that would exceed the bound terminates `budget-exhausted` with no
          // further coordinator dispatch.
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
          recordConsult(req);
          continue;
        }
        case "escalate_to_host": {
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
  record = {
    ...record,
    status: "completed",
    disposition: outcome.disposition,
    recommendation: outcome.recommendation,
    terminationReason,
  };
  saveMissionRecord(missionDir, record);
  finalizeMissionControl(missionDir, "completed");
  writeRecommendationFile(missionDir, {
    missionId,
    disposition: outcome.disposition,
    recommendation: outcome.recommendation,
    reason: terminationReason,
  });

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
    ` (recommendation: ${path.join(missionDir, "recommendation.md")})`
  );
}