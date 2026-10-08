// codex-dispatch.mjs — Codex CLI backend for kusabi job dispatch (kusabi #527).
//
// Backend contract: a function with the SAME call/return shape as
// `dispatchWithFallback` (prompt-execution.mjs) and `claudeDispatch` /
// `agyDispatch`: it receives the dispatch options object
// (cwd, kind, title, promptText, agent, phase, session, sessionProvenance,
// tools, timeoutS, watchdogS, tiers, round, explicitModel) and resolves to
// `{ job, resultText, stateDir }`.  kusabi-companion.mjs picks this function
// per phase; the chain phases stay backend-blind.
//
// WHY a fifth backend: on 2026-09-20 the operator accepted an opt-in
// trusted-seat evaluation model in which kusabi dispatches to the Codex CLI
// (`codex exec`) for the exact seat models listed in `CODEX_SUPPORTED_MODELS`.
// The backend reuses the shared process runner exactly like agy and
// preserves exact model/reasoning provenance by cross-checking the CLI's own
// rollout record after the process closes.
//
// ---------------------------------------------------------------------------
// The CLI contract (field-verified by a hand run, 2026-09-20, codex-cli
// 0.154.0 — MEASURED. Do not re-derive, do not doubt.)
// ---------------------------------------------------------------------------
//
// Fresh command shape:
//
//   codex exec --ignore-user-config --ignore-rules --skip-git-repo-check
//     -C <cwd> -s read-only --json -m <exact-model>
//     -c 'model_reasoning_effort="high"' -c 'mcp_servers={}' -
//
// Prompt on **stdin** (the trailing `-`), never argv.
//
// stdout is NDJSON, one event object per line, discriminated by `type`:
//
//   {"type":"thread.started","thread_id":"…", ...}
//   {"type":"turn.started", ...}
//   {"type":"item.completed","item":{"agent_message":{"text":"…"}}, ...}
//   {"type":"turn.completed","usage":{"input_tokens":…,"cached_input_tokens":…,
//       "cache_write_input_tokens":…,"output_tokens":…}, ...}
//
// `thread.started.thread_id` is the thread/session id the job records as
// sessionID.  Terminal assistant text is the LAST
// `item.completed.item.agent_message.text` (earlier ones are commentary).  `--output-schema` returns the
// terminal JSON text in that SAME agent-message item, so extraction is
// identical for both framings; only the argv differs.
//
// Resume shape (measured): `codex exec resume` has no `--sandbox`, so the
// read-only sandbox and the never-approval policy are passed as config:
//
//   codex exec resume <thread_id> --ignore-user-config --ignore-rules
//     --skip-git-repo-check -C <cwd> -m <exact-model>
//     -c 'model_reasoning_effort="high"' -c 'mcp_servers={}'
//     -c 'sandbox_mode="read-only"' -c 'approval_policy="never"'
//     --json [-]
//
// Resume under the same CODEX_HOME preserves the thread id (measured); the
// thread id is passed explicitly AND the job-owned CODEX_HOME is reused, so
// the continuation cannot attach to a different thread.  `-a` is never passed
// to `codex exec` (measured: the resume subcommand has no approval flag and
// passing one is an error).
//
// Dedicated state: EVERY invocation sets both HOME and CODEX_HOME to a
// job-owned directory under the job record, so the child never inherits the
// orchestrator's config/rules/sessions/MCP servers.  The one exception is the
// minimum auth bridge: for a ChatGPT-subscription login, `auth.json` in the
// job-owned CODEX_HOME is a symlink to the operator's own auth cache.  This
// is deliberate under the accepted same-user trusted-seat model — credential
// non-readability is NOT claimed.  Auth contents are never copied into result
// text, events, usage, or publishable files.
//
// Capability honesty (accepted trust model):
//   - `--read-only` is the FIXED invocation boundary (`-s read-only`); the
//     sandbox is always read-only, and `--read-only` on the command line is
//     accepted because it states what the invocation already enforces.
//   - For Luna/Sol coordinator and auditor seats, no MCP servers are
//     configured (`mcp_servers={}`), but Codex retains its BUILT-IN COMMAND
//     TOOL inside the sandbox.
//   - Worker seats get only the job-owned MCP tables derived from Claude's
//     allowlist; a denied MCP tool is enforced by omission from
//     `enabled_tools`.  Denies for tools outside that grant remain recorded
//     as unenforced, never presented as applied.
//   - The backend is NEVER described as tool-free or credential-isolated; the
//     job record carries `codexCommandTool: true` and the fixed read-only
//     sandbox boundary.
//
// Split into focused modules by role: MCP allowlists and worker configuration
// live in codex-mcp.mjs, strict output schema projection lives in
// codex-schema.mjs, NDJSON stream parsing lives in codex-stream.mjs, and
// rollout provenance verification lives in codex-rollout.mjs.

import fs from "node:fs";
import os from "node:os";

import { assertSessionResumable } from "./backend-session-guard.mjs";
import path from "node:path";
import process from "node:process";

import { firstRoute, WRITE_TOOL_NAMES } from "./cli.mjs";
import { readAgentSystemPrompt } from "./agent-system-prompt.mjs";
import { toolDeniesEnforced, normalizeDenyName } from "./tool-permissions.mjs";
import { newJobId, jobDir } from "./job-store.mjs";
import { stateDirFor } from "./state-paths.mjs";
import { resolveBoundS, runBackendProcess } from "./backend-process-runner.mjs";
import { runBackendDispatch } from "./backend-dispatch-core.mjs";
import {
  codexMcpArgv,
  codexMcpServerDefinitions,
  codexMcpToolsForAgent,
} from "./codex-mcp.mjs";
import {
  REVIEW_AGENT,
  codexJsonSchemaFor,
  stripCodexOptionalNullsFromText,
} from "./codex-schema.mjs";
import {
  applyCodexStreamEvent,
  describeCodexResult,
  initCodexStreamAccumulator,
  mapCodexUsage,
  parseCodexStreamLine,
} from "./codex-stream.mjs";
import {
  CODEX_REASONING_EFFORT,
  readRolloutProvenance,
} from "./codex-rollout.mjs";


export const CODEX_BACKEND = "codex";

// The exact seat ids this backend can execute (accepted trust model, #527).
// v1 is deliberately closed: an explicit pin must be ONE of these exact ids,
// and provenance cross-checking compares the requested id byte-for-byte
// against the model the CLI's own rollout records.
export const CODEX_SUPPORTED_MODELS = ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-6-luna", "gpt-6.1-sol"];

// The default chain may contain the exact supported seat ids.  ONE tier with
// both seats, first route first: this backend pins one model per phase and
// never walks a fallback after a terminal failure, so the tier carries
// interchangeable routes exactly like the other pinning backends' defaults.
// The 6-series seats are the default (kusabi #641); the 5.6 seats stay
// accepted as explicit pins.
export const CODEX_DEFAULT_CHAIN = [["gpt-6-luna", "gpt-6.1-sol"]];


// The sandbox every invocation runs in (measured `-s read-only`).
export const CODEX_SANDBOX_POLICY = "read-only";


// Tests point CODEX_BIN at a fake script.  The real binary is a host install
// (`codex` from codex-cli) that exists in neither CI nor the sunaba
// container; no test may ever require it.
export function codexBin() {
  return process.env.CODEX_BIN || "codex";
}

/**
 * Format the list of supported codex seat models with a conjunction ("or" / "and").
 *
 * @param {string} [conjunction="or"]
 * @returns {string} e.g. "a, b or c"
 */
export function formatCodexSupportedModels(conjunction = "or") {
  if (CODEX_SUPPORTED_MODELS.length === 0) return "";
  if (CODEX_SUPPORTED_MODELS.length === 1) return CODEX_SUPPORTED_MODELS[0];
  if (CODEX_SUPPORTED_MODELS.length === 2) {
    return `${CODEX_SUPPORTED_MODELS[0]} ${conjunction} ${CODEX_SUPPORTED_MODELS[1]}`;
  }
  return `${CODEX_SUPPORTED_MODELS.slice(0, -1).join(", ")} ${conjunction} ${CODEX_SUPPORTED_MODELS[CODEX_SUPPORTED_MODELS.length - 1]}`;
}

// =========================================================================
// model syntax — pure
// =========================================================================

/**
 * Validate a model entry for the codex backend.
 *
 * Accepted: exactly the supported seat ids (`CODEX_SUPPORTED_MODELS`).
 * A `:variant` suffix is rejected with an explicit error — reasoning effort
 * is fixed to `high` and never translated from a variant.  Any other id is
 * rejected too: v1 executes the exact seats and nothing else, so an unknown
 * id fails at command start instead of becoming a silently-different run.
 *
 * @param {string|null|undefined} value
 * @returns {string|null} The normalized model string, or null when absent.
 * @throws {Error} When the entry carries a `:variant` suffix or is not an
 *         exact supported seat id.
 */
export function validateCodexModel(value) {
  if (value === undefined || value === null || value === "") return null;
  const v = String(value);
  if (v.indexOf(":") >= 0) {
    throw new Error(
      `codex backend does not support the :variant suffix in model "${v}" — ` +
      "reasoning effort is fixed to high; use one of the exact supported seat ids: " +
      formatCodexSupportedModels("or")
    );
  }
  if (!CODEX_SUPPORTED_MODELS.includes(v)) {
    throw new Error(
      `codex backend does not support model "${v}" — v1 executes the exact seat ids ` +
      `${formatCodexSupportedModels("and")}, and an explicit pin is never substituted with another model`
    );
  }
  return v;
}

/**
 * Validate EVERY route of a (tiered) chain for the codex backend.
 *
 * @param {(string|string[])[]} chain
 * @returns {(string|string[])[]} The chain, unchanged.
 * @throws {Error} Naming the offending entry.
 */
export function validateCodexChain(chain) {
  for (const tier of Array.isArray(chain) ? chain : []) {
    const routes = Array.isArray(tier) ? tier : [tier];
    for (const route of routes) {
      try {
        validateCodexModel(route);
      } catch (err) {
        throw new Error(
          `codex backend: chain entry "${route}" is not a supported codex model — ` +
          `configure models.chain with exact seat ids (${formatCodexSupportedModels("or")}): ` +
          err.message
        );
      }
    }
  }
  return chain;
}

/**
 * Resolve the model for the codex backend, mirroring `resolveAgyModel`.
 *
 * @param {object}   opts
 * @param {string}   [opts.flag]   — `--model` flag value.
 * @param {string}   [opts.phase]  — phase name (for models.phases.<phase>).
 * @param {object}   [opts.config] — loaded kusabi config.
 * @returns {{ model: string|undefined, chain: (string|string[])[] }}
 */
export function resolveCodexModel({ flag, phase, config }) {
  let chain;
  if (config?.models?.chain) {
    chain = [...config.models.chain];
  } else {
    chain = [...CODEX_DEFAULT_CHAIN];
  }

  if (flag) {
    return { model: flag, chain };
  }

  if (phase && config?.models?.phases?.[phase]) {
    const phaseChain = config.models.phases[phase];
    const first = firstRoute(phaseChain);
    if (first) {
      return { model: first, chain: phaseChain };
    }
  }

  const firstGlobal = firstRoute(chain);
  if (firstGlobal) {
    return { model: firstGlobal, chain };
  }

  return { model: undefined, chain };
}



/**
 * Compose the prompt text handed to `codex exec` on stdin.
 * Codex has no `--append-system-prompt` in the measured argv list, so the
 * agent's role body is prepended inside a `<role>` block (agy pattern).
 *
 * @param {object} opts
 * @param {string|null} [opts.systemPrompt]
 * @param {string} [opts.promptText]
 * @returns {string}
 */
export function buildCodexPrompt({ systemPrompt, promptText }) {
  const body = promptText ?? "";
  if (!systemPrompt) return body;
  return `<role>\n${systemPrompt}\n</role>\n\n${body}`;
}


/**
 * Build the argv for a `codex exec` dispatch.
 *
 * MEASURED contract (2026-09-20, codex-cli 0.154.0):
 *
 * Fresh:
 *   codex exec --ignore-user-config --ignore-rules --skip-git-repo-check
 *     -C <cwd> -s read-only --json -m <model>
 *     -c 'model_reasoning_effort="high"' -c 'mcp_servers={}' [-]
 *
 * Resume:
 *   codex exec resume <thread_id> --ignore-user-config --ignore-rules
 *     --skip-git-repo-check -C <cwd> -m <model>
 *     -c 'model_reasoning_effort="high"' -c 'mcp_servers={}'
 *     -c 'sandbox_mode="read-only"' -c 'approval_policy="never"'
 *     --json [-]
 *
 * The one measured difference from the one-shot probe is deliberate:
 * `--ephemeral` is NEVER passed, because persistence is required — the
 * rollout/session state must survive under the job-owned CODEX_HOME so
 * resume and model verification work.  Isolation comes from the dedicated
 * home, not from ephemerality.
 *
 * `-s read-only` appears on the FRESH invocation only: `codex exec resume`
 * has no `--sandbox`, so the resume invocation carries the sandbox as
 * `-c 'sandbox_mode="read-only"'` (and the never-approval policy as
 * `-c 'approval_policy="never"'`).  `-a` is never passed to `codex exec`.
 *
 * The prompt is on STDIN only (the trailing `-`), never argv.
 *
 * @param {object} opts
 * @param {string} opts.model — an exact supported seat id.
 * @param {string} opts.cwd — the working directory (`-C`).
 * @param {string|null|undefined} [opts.sessionId] — the recorded thread id;
 *        present => the resume subcommand shape.
 * @param {string|null} [opts.jsonSchema] — schema file path, or null.
 * @param {Record<string, object>|null} [opts.mcpServers] — concrete worker
 *        MCP definitions; each server becomes explicit -c overrides.
 * @param {boolean} [opts.mcpEnabled] — compatibility shorthand for callers
 *        that only need to select the MCP argv shape.
 * @returns {string[]}
 */
export function buildCodexArgs({ model, cwd, sessionId, jsonSchema, mcpServers = null, mcpEnabled = false }) {
  const mcpGranted = mcpEnabled || (mcpServers && Object.keys(mcpServers).length > 0);
  const mcpOverrides = mcpGranted ? codexMcpArgv(mcpServers) : [];
  const isolationFlags = [
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
  ];
  const modelAndEffort = [
    "-m", model,
    "-c", `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`,
    ...mcpOverrides,
    ...(mcpGranted ? [] : ["-c", "mcp_servers={}"]),
  ];
  const jsonOut = ["--json"];
  const schemaArgs = jsonSchema ? ["--output-schema", jsonSchema] : [];

  if (typeof sessionId === "string" && sessionId !== "") {
    // Resume: `-C <cwd>` is passed at the `exec` level before `resume`
    // because `-C` is an exec-level option; `codex exec resume` rejects
    // it (kusabi #659, measured on codex-cli 0.159.3).
    // No `-s` (the resume subcommand has no --sandbox) and no `-a`
    // (never passed to `codex exec`).  The sandbox and approval policy ride
    // as config overrides; the thread id is passed explicitly.
    return [
      "exec",
      "-C", cwd,
      "resume", sessionId,
      ...isolationFlags,
      ...modelAndEffort,
      "-c", `sandbox_mode="${CODEX_SANDBOX_POLICY}"`,
      "-c", 'approval_policy="never"',
      ...jsonOut,
      ...schemaArgs,
      "-",
    ];
  }
  return [
    "exec",
    ...isolationFlags,
    "-C", cwd,
    "-s", CODEX_SANDBOX_POLICY,
    ...jsonOut,
    ...modelAndEffort,
    ...schemaArgs,
    "-",
  ];
}


/**
 * Fail-closed check on a RESOLVED codexDispatch result: a job that did not
 * reach status "completed" is a dispatch/seat failure, never an empty
 * stream.  The Luna coordinator and Sol audit seams share this check so a
 * failed Codex job surfaces as a dispatch/audit-seat failure naming the job
 * id, status and recorded error — it must never be parsed as an empty
 * coordinator/verdict stream (the mission-mucn5qb2a76e2095 mislabel).
 *
 * Throws when the job is not completed; otherwise returns the result
 * unchanged so the caller keeps the public `{ job, resultText, stateDir }`
 * contract.
 *
 * @param {{ job: object, resultText: string, stateDir: string }} result
 * @param {string} [label] — the caller's slot name for the error message.
 * @returns {{ job: object, resultText: string, stateDir: string }}
 */
export function assertCodexDispatchSucceeded({ job, resultText, stateDir }, label = "codex") {
  if (job?.status === "completed") return { job, resultText, stateDir };
  const id = job?.id ?? "unknown";
  const status = job?.status ?? "unknown";
  const error = job?.error ?? "no error recorded";
  throw new Error(`codex dispatch failed (${label}): job ${id} resolved ${status}: ${error}`);
}


// =========================================================================
// dedicated state + auth bridge
// =========================================================================

/**
 * The job-owned Codex home for one job: a directory under the job record.
 * Every invocation sets BOTH HOME and CODEX_HOME to this directory, so the
 * child never inherits the orchestrator's config/rules/sessions/MCP files.
 * The CLI's own rollout/session state persists here, which is what makes
 * resume and post-close model verification work (this is the deliberate
 * difference from the one-shot probe, which used --ephemeral).
 *
 * @param {string} stateDir
 * @param {string} jobId
 * @returns {string}
 */
export function codexHomeForJob(stateDir, jobId) {
  return path.join(jobDir(stateDir, jobId), "codex-home");
}

/**
 * The operator's own Codex home, resolved from the PARENT environment (the
 * child's env is overridden to the job-owned home, so this must be read
 * before the spawn).  Defaults to `~/.codex`, the CLI's own default.
 *
 * @returns {string}
 */
export function operatorCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

/**
 * Create the MINIMUM auth bridge the real CLI needs for a ChatGPT
 * subscription login: `auth.json` in the job-owned home symlinked to the
 * operator's own auth cache.  Acceptable under the explicitly accepted
 * same-user trust model; credential non-readability is NOT claimed.  The
 * bridge never reads auth contents, so nothing of them can leak into result
 * text, events, usage, or publishable files.
 *
 * A missing operator auth file is a normal outcome (the CLI will fail on
 * auth itself) and yields `{ bridge: "none" }` — no error, no invented file.
 *
 * @param {string} jobCodexHome
 * @returns {{bridge: "symlinked"}|{bridge: "none", reason: string}}
 */
export function linkOperatorAuth(jobCodexHome) {
  const operatorAuth = path.join(operatorCodexHome(), "auth.json");
  let stat = null;
  try {
    stat = fs.statSync(operatorAuth);
  } catch {
    return { bridge: "none", reason: "operator-auth-file-absent" };
  }
  if (!stat.isFile()) {
    return { bridge: "none", reason: "operator-auth-file-not-a-file" };
  }
  fs.mkdirSync(jobCodexHome, { recursive: true });
  const target = path.join(jobCodexHome, "auth.json");
  try {
    fs.symlinkSync(operatorAuth, target);
    return { bridge: "symlinked" };
  } catch (err) {
    if (err?.code === "EEXIST") return { bridge: "symlinked" };
    return { bridge: "none", reason: `symlink-failed: ${err?.code ?? err?.message ?? err}` };
  }
}


// =========================================================================
// process — spawn/IO
// =========================================================================

/**
 * Spawn the codex CLI and fold its NDJSON event stream as it arrives.
 *
 * Delegates the mechanical lifecycle (spawn, line framing, timeout, silence
 * watchdog, process-group kill, close handling) to the shared
 * `runBackendProcess` module.  Codex-specific concerns — the parse function
 * for the silence clock, the stdin prompt transport (`-`), and the dedicated
 * job-owned HOME/CODEX_HOME env — are wired here.
 *
 * @param {object} opts
 * @param {string} opts.bin
 * @param {string[]} opts.args
 * @param {string} opts.cwd
 * @param {string} opts.promptText
 * @param {number|null} [opts.timeoutS]
 * @param {number|null} [opts.watchdogS]
 * @param {object} [opts.env] — extra env overrides for the child (the
 *        job-owned HOME/CODEX_HOME).
 * @param {(info: {pid: number}) => void} [opts.onStart]
 * @param {(line: string) => void} [opts.onLine]
 * @param {(event: {kind: "fired", silenceS: number}|{kind: "kill"}) => void}
 *        [opts.onWatchdog]
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string,
 *                     timedOut: boolean, stalled: boolean,
 *                     spawnError: Error|null }>}
 */
export function runCodexProcess({ bin, args, cwd, promptText, timeoutS, watchdogS, env, onStart, onLine, onWatchdog }) {
  return runBackendProcess({
    bin, args, cwd, promptText, timeoutS, watchdogS, env, onStart, onLine, onWatchdog,
    parseLine: parseCodexStreamLine,
  });
}

// =========================================================================
// codexDispatch — the dispatchWithFallback-shaped entry point
// =========================================================================

/**
 * Dispatch one prompt through the Codex CLI (`codex exec`).  Same call/return
 * contract as `dispatchWithFallback` / `claudeDispatch` / `agyDispatch`.
 *
 * v1 shape: one exact model per phase (`explicitModel` or the chain's first
 * route — a supported seat id), no tier walk, no capacity fallback, no
 * retry, reasoning effort fixed to `high`, every invocation in the fixed
 * read-only sandbox.  A session resumes (`codex exec resume <thread_id>`)
 * only when the caller establishes its provenance (`sessionProvenance:
 * "codex"`).  Every failure mode — spawn error, nonzero exit, unparseable
 * stdout, a payload-less run, timeout, stalled watchdog — produces a FAILED
 * JOB RECORD whose `error` carries the underlying text.  A config-level
 * error (a session that cannot be resumed, no model resolved) throws BEFORE
 * any job record exists.
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} [opts.kind]
 * @param {string} [opts.title]
 * @param {string} [opts.promptText]
 * @param {string|null} [opts.agent]
 * @param {string|null} [opts.phase]
 * @param {string|null|undefined} [opts.session] — resumed via
 *        `codex exec resume <thread_id>` ONLY when `sessionProvenance`
 *        proves it a codex thread id; see assertSessionResumable.
 * @param {string|null|undefined} [opts.sessionProvenance]
 * @param {object|null|undefined} [opts.tools] — deny map.  For worker
 *        agents this is applied to the MCP enabled_tools list; for MCP-less
 *        seats only the fixed read-only sandbox can enforce write denies.
 * @param {unknown} [opts.timeoutS] — positive finite seconds arms the outer
 *        timer; anything else arms nothing (kusabi #328).
 * @param {unknown} [opts.watchdogS] — positive finite seconds arms the
 *        silence watchdog; anything else arms none.
 * @param {(string|string[])[]} [opts.tiers]
 * @param {number} [opts.round]
 * @param {string|null} [opts.explicitModel]
 * @returns {Promise<{ job: object, resultText: string, stateDir: string }>}
 */
export async function codexDispatch(opts) {
  // ---- cross-backend / provenance session guard ----
  // Before anything is spawned and before any job record exists: this is a
  // config-level error, not a failed job.
  assertSessionResumable(opts.session, {
    backend: "codex",
    provenance: opts.sessionProvenance,
    detail: "A codex thread id is passed to `codex exec resume` only when a codex job recorded it; an unproven id would silently start a fresh-looking run instead of continuing one.",
    tail: "a thread id that a codex job on this directory recorded",
  });

  // The thread id of a resumed dispatch, known BEFORE the run: the CLI was
  // asked to continue this exact thread.  A successful resumed job must
  // persist it even when the resume stream omits a fresh `thread.started`
  // event, or a later --resume-last would silently start fresh (kusabi #527
  // review follow-up).
  const resumedSessionId = typeof opts.session === "string" && opts.session !== "" ? opts.session : null;

  // v1 model selection: explicit model, else the chain's first route.  The
  // tier ladder is NOT walked — one exact model per phase, never a fallback
  // after a terminal failure.
  const modelEntry = validateCodexModel(opts.explicitModel || firstRoute(opts.tiers || []));
  if (!modelEntry) {
    throw new Error("codex backend: no model resolved — pass --model codex/<seat> or configure models.chain with codex entries");
  }
  const stateDir = stateDirFor(opts.cwd);

  // ---- pre-flight (still before the job record exists) ----
  const systemPrompt = readAgentSystemPrompt(opts.agent);
  const promptText = buildCodexPrompt({ systemPrompt, promptText: opts.promptText });
  const bin = codexBin();
  const timeoutS = resolveBoundS(opts.timeoutS);
  const watchdogS = resolveBoundS(opts.watchdogS);
  const jsonSchema = codexJsonSchemaFor(opts.agent);
  const codexMcpTools = codexMcpToolsForAgent(opts.agent, opts.tools);
  const codexMcpDefinitions = codexMcpTools === null
    ? {}
    : codexMcpServerDefinitions(codexMcpTools);
  const codexMcpEnabled = Object.keys(codexMcpDefinitions).length > 0;

  // Deny maps arrive from the chain phases unconditionally (implementDenyTools
  // / reviewDenyTools) and from the operator's --read-only.  The canonical
  // write-tool names (WRITE_TOOL_NAMES) ARE the read-only boundary the fixed
  // sandbox enforces, so denying them is sandbox-enforced, never "unenforced"
  // (kusabi #527 finding 2).  Any other denied name is a per-tool/MCP claim
  // the codex CLI cannot enforce (it has no per-job tool-deny flags), so it
  // stays genuinely unenforced — a phase deny like sunaba_copy_project is
  // never erased merely because --read-only is also active.
  const deniedToolNames = Object.entries(opts.tools ?? {})
    .filter(([, allowed]) => allowed === false)
    .map(([name]) => name);
  const codexSandboxEnforcedDenies = codexMcpEnabled
    ? []
    : deniedToolNames.filter((name) => WRITE_TOOL_NAMES.includes(name));
  const normalizedDeniedToolNames = Object.entries(opts.tools ?? {})
    .filter(([, allowed]) => allowed === false)
    .map(([name]) => normalizeDenyName(name));
  const grantedMcpToolNames = new Set(
    Object.entries(codexMcpToolsForAgent(opts.agent) ?? {}).flatMap(([server, names]) =>
      names.includes("*") ? [] : names.map((name) => `mcp__${server}__${name}`)),
  );
  const codexMcpEnforcedDenies = codexMcpEnabled
    ? normalizedDeniedToolNames.filter((name) => grantedMcpToolNames.has(name))
    : [];
  const enforcedMcpDenies = new Set(codexMcpEnforcedDenies);
  const unenforcedDenies = codexMcpEnabled
    ? deniedToolNames.filter((name) => !enforcedMcpDenies.has(normalizeDenyName(name)))
    : deniedToolNames.filter((name) => !WRITE_TOOL_NAMES.includes(name));
  const enforcedDenies = toolDeniesEnforced(opts.tools, unenforcedDenies);

  // The deny map as supplied (null when no tools map was passed at all) and
  // the truthful tool profile derived from it (kusabi #529 spec 8).  A
  // no-tools dispatch records `toolDenies: null` and `toolProfile: "no-mcp"`.
  // Worker dispatches instead record their derived MCP profile and applied
  // omissions; a deny outside that grant remains genuinely unenforced.
  const toolDenies =
    opts.tools && typeof opts.tools === "object" && Object.keys(opts.tools).length > 0
      ? opts.tools
      : null;
  const toolProfile = codexMcpEnabled
    ? (toolDenies === null ? "mcp-allowlist" : "mcp-allowlist-deny-map")
    : (toolDenies === null ? "no-mcp" : "deny-map");

  // ---- job record (opencode-path shape + backend) ----
  const job = {
    id: newJobId(),
    kind: opts.kind || "task",
    title: opts.title || "",
    status: "running",
    backend: CODEX_BACKEND,
    sessionID: null,
    // Filled the instant the child exists — the `cancel` lever (kusabi #209).
    process: null,
    cwd: opts.cwd,
    phase: opts.phase ?? null,
    modelEntry,
    modelVariant: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    stats: {
      instrumented: true,
      events: 0,
      steps: 0,
      lastTool: null,
      permissionsAllowed: 0,
      permissionsRejected: 0,
      lastActivity: null,
      models: [],
    },
    // Fixed v1 invocation boundaries, recorded truthfully (capability
    // honesty): reasoning effort is always "high", the sandbox is always
    // "read-only", and the built-in command tool remains inside the
    // sandbox.  Worker MCP grants are job-owned and listed exactly below;
    // credential isolation is NOT claimed.
    reasoningEffort: CODEX_REASONING_EFFORT,
    sandboxPolicy: CODEX_SANDBOX_POLICY,
    mcpServersConfigured: codexMcpEnabled,
    codexMcpServers: codexMcpTools ?? {},
    codexCommandTool: true,
    // kusabi #529 spec 8: the truthful no-tool record.  `toolProfile:
    // "no-mcp"` and `toolDenies: null` describe a dispatch with no MCP
    // servers AND no deny map — the honest proof that no tools were granted.
    // A supplied deny map flips the profile to "deny-map" and records the
    // map as `toolDenies`; the unenforced entries ride in
    // `toolDeniesUnenforced`.  `streamFraming` is "json" because every
    // invocation passes `--json` (the watchdog treats non-JSON lines as
    // activity, so nobody reads "no stall" as "structured activity").
    // `substituted` starts as null (provenance is not yet known) and is set
    // from the post-run rollout cross-check (kusabi #529 finding 4): false
    // only when the actual model is verified equal, true for an observed
    // mismatch, null when provenance is unverifiable — never a claimed value.
    toolProfile,
    toolDenies,
    streamFraming: "json",
    substituted: null,
    // Filled after the process closes: { state: "verified"|"unverifiable"|
    // "mismatch", ... } — see readRolloutProvenance.
    codexProvenance: null,
    // Without MCP, the fixed read-only sandbox is the only enforceable
    // write boundary.  With MCP, denied tools are enforced by omission from
    // codexMcpServers, and are recorded separately.
    codexSandboxEnforcedDenies,
    codexMcpEnforcedDenies,
    toolDeniesEnforced: enforcedDenies,
    toolDeniesUnenforced: unenforcedDenies,
    jsonSchemaEnforced: jsonSchema !== null,
    error: null,
    failure: null,
    retry: null,
    fallbacks: null,
  };
  // The job-owned Codex home, persisted on the record so rendering can print
  // an EXECUTABLE continuation command pointing HOME/CODEX_HOME at it
  // (kusabi #527 finding 1).  The path lives under the job's own directory
  // and carries no auth material (the auth bridge is a symlink, never a copy
  // of the operator's cache).
  const codexHome = codexHomeForJob(stateDir, job.id);
  job.codexHome = codexHome;
  // ---- dedicated state ----
  // HOME and CODEX_HOME both point at the job-owned directory.  The child
  // never inherits the orchestrator's config/rules/sessions/MCP files; the
  // only bridge is the minimum auth symlink (same-user trusted-seat model).
  // The dedicated home always exists (it is the child's state dir), even
  // when there is no operator auth file to bridge.
  fs.mkdirSync(codexHome, { recursive: true });
  // The CLI consumes a path here, not schema text.  Keep the projected
  // schema beside this job's codex-home so it cannot be confused with a
  // shared or checked-in generated schema.
  const codexSchemaPath = jsonSchema === null
    ? null
    : path.join(jobDir(stateDir, job.id), "codex-output-schema.json");
  if (codexSchemaPath !== null) {
    fs.writeFileSync(codexSchemaPath, jsonSchema, "utf8");
  }
  const args = buildCodexArgs({
    model: modelEntry,
    cwd: opts.cwd,
    sessionId: opts.session,
    jsonSchema: codexSchemaPath,
    mcpServers: codexMcpDefinitions,
  });
  // config.toml is intentionally not written: --ignore-user-config ignores
  // the job-owned file, so every grant is already present in argv above.
  const authBridge = linkOperatorAuth(codexHome);
  const childEnv = { HOME: codexHome, CODEX_HOME: codexHome };

  const dispatchEvent = {
    type: "companion.codex.dispatch",
    backend: CODEX_BACKEND,
    model: modelEntry,
    bin,
    reasoningEffort: CODEX_REASONING_EFFORT,
    sandboxPolicy: CODEX_SANDBOX_POLICY,
    resume: typeof opts.session === "string" && opts.session !== "",
    // The bridge KIND only — auth contents are never written to events.
    authBridge: authBridge.bridge,
    jsonSchemaEnforced: job.jsonSchemaEnforced,
    codexMcpServers: codexMcpTools ?? {},
    codexSandboxEnforcedDenies,
    codexMcpEnforcedDenies,
    toolDeniesEnforced: enforcedDenies,
    toolDeniesUnenforced: unenforcedDenies,
  };

  // ---- run: fold the NDJSON stream as it arrives ----
  const stream = {
    init: () => initCodexStreamAccumulator(),
    onLine: (streamAcc, rawLine, j) => {
      const evt = parseCodexStreamLine(rawLine);
      if (evt === null) {
        // Not fatal (the real CLI may print non-JSON warning lines) — just not
        // countable as a parsed event.
        return false;
      }
      if (typeof rawLine === "string") {
        streamAcc.stdoutBytes += Buffer.byteLength(rawLine, "utf8");
      }
      applyCodexStreamEvent(streamAcc, evt);
      if (streamAcc.threadId) j.sessionID = streamAcc.threadId;
      j.stats = {
        instrumented: true,
        events: streamAcc.events,
        steps: streamAcc.steps,
        lastTool: streamAcc.lastTool,
        permissionsAllowed: 0,
        permissionsRejected: 0,
        lastActivity: streamAcc.lastActivity,
        models: streamAcc.models,
      };
    },
  };

  return runBackendDispatch({
    stateDir,
    job,
    promptText,
    dispatchEvent,
    bin,
    labels: { spawnErrorPrefix: "codex dispatch failed" },
    timeoutS,
    watchdogS,
    runProcess: (hooks) =>
      runCodexProcess({
        bin,
        args,
        cwd: opts.cwd,
        promptText,
        timeoutS,
        watchdogS,
        env: childEnv,
        ...hooks,
      }),
    stream,
    afterProcess: ({ state }) => {
      // The thread/session id of THIS run, decided ONCE for every terminal path:
      // the thread id the stream reported when it reported one (a fresh job, and
      // a resume whose CLI re-emits thread.started), else the known thread id a
      // resumed dispatch was asked to continue, else null.  Recording the known
      // resumed id even when the resume stream omits thread.started keeps the
      // session chain intact — later --resume-last selection and rendering both
      // read this field (kusabi #527 review follow-up).
      job.sessionID = state.threadId ?? resumedSessionId ?? null;

      // ---- provenance cross-check after close ----
      // The rollout lives under the job-owned CODEX_HOME.  A different actual
      // model or reasoning effort is an integrity failure: the job errors, names
      // requested vs actual, writes no successful result, and never retries
      // another model.  A missing rollout is UNVERIFIABLE, never silently
      // verified.  For a resumed dispatch the verification binds to the resumed
      // invocation's OWN turn_context evidence, never a stale matching turn from
      // the original session.
      const provenance = readRolloutProvenance({
        codexHome,
        requestedModel: modelEntry,
        resumed: resumedSessionId !== null,
      });
      job.codexProvenance = provenance;
      if (job.stats) {
        job.stats.models = provenance.state === "verified" ? [provenance.model] : [];
      }
      // `substituted` is set from post-run provenance (kusabi #529 finding 4):
      // `false` only when the actual model is verified equal to the requested
      // one, `true` for an observed mismatch, and `null` when provenance is
      // unverifiable (no rollout / no model field in the rollout) — never a
      // claimed value.  The fail-closed mismatch handling below is unchanged: a
      // mismatch is a hard error, no result and no substitute model.
      job.substituted =
        provenance.state === "verified"
          ? false
          : provenance.state === "mismatch"
          ? true
          : null;
    },
    classifyExit: ({ code, stdout, stderr, state, streamEvents, malformedLines }) => {
      const provenance = job.codexProvenance;
      if (provenance?.state === "mismatch") {
        // Fail closed: no successful result, no fallback/substitution.
        return {
          status: "error",
          error:
            `codex provenance mismatch: requested ${provenance.kind} ${provenance.requested} ` +
            `but the recorded rollout shows ${provenance.actual} — integrity failure; ` +
            "no result was written and no substitute model was attempted",
        };
      }
      if (code !== 0) {
        const detail = (stderr || stdout || "(no output)").trim();
        return {
          status: "error",
          error: `codex exited with code ${code}: ${describeCodexResult(detail)}`,
        };
      }
      if (!state.assistantText) {
        const snippet = (stdout || "").trim().slice(0, 300);
        return {
          status: "error",
          error:
            `codex stream produced no terminal result event ` +
            `(${streamEvents} parsed, ${malformedLines} unparseable line(s)): ${snippet || "(empty stdout)"}`,
        };
      }
      return {
        status: "completed",
        usage: mapCodexUsage(state.usageEvent),
        text: state.assistantText,
      };
    },
    transformResultText: (text) =>
      opts.agent === REVIEW_AGENT ? stripCodexOptionalNullsFromText(text) : text,
    finishedEvent: ({ state, job: j, code }) => ({
      type: "companion.codex.finished",
      status: j.status,
      sessionId: j.sessionID,
      exitCode: code,
      provenanceState: j.codexProvenance?.state,
      assistantChars: state.assistantText.length,
    }),
    resultBackend: CODEX_BACKEND,
  });
}
