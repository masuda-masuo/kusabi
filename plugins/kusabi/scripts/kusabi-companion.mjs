#!/usr/bin/env node
// kusabi-companion: bridge between Claude Code slash commands and an
// on-demand `opencode serve` instance.
//
// Context firewall: every opencode event is persisted under the state dir;
// stdout only ever carries the rendered final result, so the calling Claude
// session never sees intermediate narration, tool logs, or raw events.

import { parseArgs } from "./cli.mjs";
import { formatCodexSupportedModels } from "./codex-dispatch.mjs";
import { renderJobLine, renderHeader } from "./render.mjs";
import { cmdInstallCli, diagnoseCompanionShim, formatShimSetupLine } from "./install-cli.mjs";
// Exit path only (kusabi #243); its own module since kusabi #277 so that the
// test children exercising it do not import everything above.
import { flushAndExit } from "./flush-and-exit.mjs";
// chain-cmd (kusabi #422 Job 2): the `chain` and `chain-resume` command
// surfaces.  chain-cmd.mjs imports helpers back from this module; see its
// header for why that cycle is safe and why nothing moved is re-exported
// from here.
import { cmdChain, cmdChainResume } from "./chain-cmd.mjs";
// chain-ops (kusabi #427): chain-adjacent subcommands (show, wait, cancel,
// detach, baseline).
import {
  cmdChainCancel,
  cmdBaseline,
  cmdChainShow,
  cmdChainWait,
  cmdChainDetach,
  cmdTaskWait,
} from "./chain-ops.mjs";
// task-cmd (kusabi #437): the `task` and `review` single-shot phase commands.
import { cmdTask, cmdReview, cmdTaskDetach } from "./task-cmd.mjs";
// luna-cmd (kusabi #530/#531): the opt-in luna mission surfaces (luna,
// luna-detach, luna-wait, luna-show, luna-cancel, luna-resume).  luna-cmd.mjs
// is NOT on a cycle with companion: it imports only leaf modules (the mission
// driver reaches the chain lifecycle seam through a lazy import).
import {
  cmdLuna,
  cmdLunaDetach,
  cmdLunaWait,
  cmdLunaShow,
  cmdLunaCancel,
  cmdLunaResume,
  DEFAULT_COORDINATOR_SEAT,
  DEFAULT_AUDITOR_SEAT,
} from "./luna-cmd.mjs";
// metrics-cmd (kusabi #443): the look-at-recorded-work command surfaces
// (chain-stats, metrics-ingest, metrics-report). Unlike chain-cmd,
// chain-ops, and task-cmd, metrics-cmd.mjs is NOT on a cycle with companion:
// it does not import companion.
import {
  cmdChainStats,
  cmdMetricsIngest,
  cmdMetricsReport,
} from "./metrics-cmd.mjs";
// host-cmd (kusabi #445): host maintenance command surfaces (install-agents).
// Unlike chain-cmd, chain-ops, and task-cmd, host-cmd.mjs is NOT on
// a cycle with companion: it does not import companion.
import { cmdInstallAgents } from "./host-cmd.mjs";
// job-control-cmd (split): the cancel / serve-stop command surfaces.
import { cmdCancel, cmdServeStop } from "./job-control-cmd.mjs";
// eval-cmd (split): the read-only `evaluation` replay surface.
import { cmdEvaluation } from "./eval-cmd.mjs";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { stateRoot, stateDirFor } from "./state-paths.mjs";
import { chainIdForJob, collectChainStatuses } from "./chain-control.mjs";
import { jobDir, loadJob, listJobs, latestJob } from "./job-store.mjs";
import { opencodeBin, ensureServer, reapIdleServes, reapOrphanedServes } from "./serve-lifecycle.mjs";
import { renderJobProgress } from "./kaiba-progress-watch.mjs";

// Re-export so external consumers (tests) that import these functions
// from kusabi-companion.mjs continue to resolve correctly.
export {
  runSmokeProbe,
  runHeadCleanProbe,
  runVerifyProbe,
  runDeliverablesProbe,
  runFrozenProbe,
  runCollectedProbe,
} from "./chain-probes.mjs";


const COMPANION_SCRIPT = fileURLToPath(import.meta.url);


// ---------------------------------------------------------------------------
// subcommands
// ---------------------------------------------------------------------------

async function cmdSetup(cwd) {
  const shimLine = formatShimSetupLine(diagnoseCompanionShim({ selfPath: COMPANION_SCRIPT }));
  let version;
  try {
    version = execFileSync(opencodeBin(), ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return `opencode CLI not found. Install it first: https://opencode.ai (or set OPENCODE_BIN).\n${shimLine}`;
  }
  const server = await ensureServer(cwd);
  return [
    `opencode ${version} — OK`,
    `server: http://127.0.0.1:${server.port} (pid ${server.pid}, password-protected)`,
    `state dir: ${server.stateDir}`,
    cmdInstallAgents(),
    shimLine,
  ].join("\n");
}



function cmdStatus(cwd, { text }) {
  const stateDir = stateDirFor(cwd);
  const jobId = text.split(/\s+/).filter(Boolean)[0];
  if (jobId) {
    const job = loadJob(stateDir, jobId);
    if (!job) return `no such job: ${jobId}`;
    // Check chain ownership for this job
    const s = job.stats ?? {};
    // A stats object marked `instrumented: false` carries STRUCTURAL
    // counters, never measured ones — presenting them as `events: 0,
    // steps: 0, …` would report structural zeros as measured (kusabi
    // #215).  The marker is the signal; `backend` is never consulted.
    // Since kusabi #215 Job B the claude backend streams real events and
    // marks every new dispatch `instrumented: true`; this marker now
    // identifies only legacy/pre-#215 records already on disk.  Records
    // without the marker (opencode and instrumented claude) render the
    // counters as before.
    const statsLines = s.instrumented === false
      ? ["stats: not instrumented (legacy record, no event stream)"]
      : [
          `events: ${s.events ?? 0}, steps: ${s.steps ?? 0}, last tool: ${s.lastTool ?? "-"}`,
          `permissions: ${s.permissionsAllowed ?? 0} allowed, ${s.permissionsRejected ?? 0} rejected`,
          `last activity: ${s.lastActivity ?? "-"}`,
        ];
    const progressLines = renderJobProgress(stateDir, job.id);
    const lines = [
      renderHeader(job).trimEnd(),
      ...statsLines,
      ...progressLines,
      ...(job.error ? [`error: ${job.error}`] : []),
    ];
    const jobChain = chainIdForJob(job);
    if (jobChain) {
      lines.push(`chain: ${jobChain} (stop with: kusabi-companion chain-cancel ${jobChain})`);
    }
    return lines.join("\n");
  }
  const jobs = listJobs(stateDir).slice(0, 10);
  const lines = [];

  // Job listing
  if (jobs.length === 0) {
    lines.push("no opencode jobs for this directory yet.");
  } else {
    lines.push(...jobs.map((j) => renderJobLine(j)));
  }

  // Chain ownership — show running chains
  const chainStatuses = collectChainStatuses(stateDir);
  const runningOrStale = chainStatuses.filter(function (s) {
    return s.status === "running" || s.status === "stale" || s.status === "stopping";
  });
  if (runningOrStale.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("chains:");
    for (const cs of runningOrStale) {
      const containerField = cs.container ? ` container=${cs.container}` : "";
      let line = `  ${cs.chainId} round=${cs.round} status=${cs.status}${containerField}`;
      if (cs.stale) {
        line += " (process gone — record is stale)";
      }
      if (cs.status === "stopping") {
        line += ` (stop requested, stopping…)`;
      }
      lines.push(line);
    }
  }

  return lines.join("\n");
}

function cmdResult(cwd, { flags, text }) {
  const stateDir = stateDirFor(cwd);
  const jobId = text.split(/\s+/).filter(Boolean)[0];
  const job = jobId ? loadJob(stateDir, jobId) : latestJob(stateDir, (j) => j.status === "completed");
  if (!job) return jobId ? `no such job: ${jobId}` : "no completed jobs for this directory yet.";
  const resultFile = path.join(jobDir(stateDir, job.id), "result.md");
  const body = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, "utf8") : "(no stored result)";

  // --full: restore the original behaviour — header + full result.md body.
  if (flags?.full) {
    return `${renderHeader(job)}${body}`;
  }

  // Default: compact output.
  const header = renderHeader(job);
  const chainId = chainIdForJob(job);
  if (chainId) {
    // Chain job: point at chain-show instead of dumping the full result.
    return `${header}Chain: ${chainId}\nRun: kusabi-companion chain-show ${chainId}\n`;
  }

  // Non-chain job: compact summary — extract verdict/summary from JSONL if
  // present, otherwise a short truncated preview (≤40 lines or ≤2 KiB).
  if (body === "(no stored result)") {
    return `${header}(no stored result)\n`;
  }
  // Try to extract a verdict or summary line from JSONL.
  const lines = body.split("\n");
  let verdictLine = null;
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj?.type === "verdict") {
        const parts = [];
        if (obj.verdict) parts.push(`verdict: ${obj.verdict}`);
        if (obj.summary) parts.push(`summary: ${obj.summary}`);
        if (parts.length) { verdictLine = parts.join(" | "); break; }
      }
    } catch { /* not JSONL — skip */ }
  }
  if (verdictLine) {
    return `${header}${verdictLine}\n`;
  }
  // Truncated preview: ≤40 lines, hard-capped at 2 KiB.
  const PREVIEW_MAX_LINES = 40;
  const PREVIEW_MAX_BYTES = 2048;
  const preview = lines.slice(0, PREVIEW_MAX_LINES).join("\n");
  const truncated = preview.length > PREVIEW_MAX_BYTES ? preview.slice(0, PREVIEW_MAX_BYTES) + "…" : preview;
  const skipped = lines.length - Math.min(lines.length, PREVIEW_MAX_LINES);
  const suffix = skipped > 0 ? `\n… (${skipped} more lines — use --full for the full result)` : "";
  return `${header}${truncated}${suffix}\n`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function usage() {
  return [
    "Usage: kusabi-companion <subcommand> [flags] [text]",
    "",
    "Subcommands:",
    "  setup      Start or verify the opencode server for this directory",
    "  task       Run an opencode task",
    "  review     Run an adversarial review of working-tree changes (host worktree only; --container is rejected \u2014 use task --phase review for container reviews)",
    "  chain      Run implement→review→rework chain until acceptance or escalate",
    "  chain-detach Launch a chain in a detached background process and print a runnable chain-wait command line (no LLM in launcher)",
    "  chain-resume  Resume a cancelled chain from its last recorded phase boundary, or buy a replacement review seat for a chain that escalated on a dead review seat over green probes (reads chain.json / control.json; same chain lifecycle as chain)",
    "  chain-show Print a compact plain-text digest of a chain (read-only, no LLM)",
    "  chain-wait Block until a chain reaches a terminal state, print a one-line digest, exit 0 (read-only, no LLM, no serve; safe to SIGTERM at any moment). Non-zero means the WAIT itself failed — a chain that never appeared (or a malformed id), nothing appeared under --next, or the chain stalled — never a disposition you dislike",
    "  chain-stats Aggregate every chain record and print a summary (read-only, no LLM)",
    "  task-detach Launch a task in a detached background process and print a runnable task-wait command line (no LLM in launcher)",
    "  task-wait  Block until a task reaches a terminal state, print a one-line digest, exit 0 (read-only, no LLM; safe to SIGTERM at any moment). Non-zero means the WAIT itself failed — unknown job id, nothing appeared under --next, or the task stalled",
    `  luna       Run an opt-in luna mission: the ${DEFAULT_COORDINATOR_SEAT.model} coordinator proposes bounded actions, and the deterministic driver validates and executes only the frozen enum (read_probe, run_chain, rework_chain, consult_sol, escalate_to_host, finish) against an immutable evidence envelope. The mission never accepts, publishes, merges, creates issues or creates containers — its terminal result is a host-facing recommendation`,
    "  luna-detach Launch a luna mission in a detached background process and print a runnable luna-wait command line (no LLM in launcher)",
    "  luna-wait  Block until a NAMED luna mission reaches a terminal state, print a one-line digest, exit 0 (read-only, no LLM, no serve; safe to SIGTERM at any moment). Non-zero means the WAIT itself failed — a mission that never appeared, a malformed mission id, or a stalled mission — never a disposition you dislike",
    "  luna-show  Print a compact plain-text digest of a luna mission: exact seat provenance/substitution, attempts and inner chain ids, errors/consults, state and recommendation (read-only, no LLM)",
    "  luna-cancel Record a stop request on a luna mission: no coordinator, auditor, or inner-chain seat is dispatched after it (the stop propagates to a live inner chain; a stale inner chain finalises through the existing chain stop lever)",
    "  luna-resume Resume a luna mission from its persisted state: refuses while the mission process or a recorded Luna/Sol job is genuinely live, settles stale chains/jobs deterministically, and only a matching human audit override (--audit-override <gateId> --audit-override-reason <reason> --audit-override-by <actor>) lets a sol-blocked mission proceed",
    "  evaluation Replay a named luna mission or plain chain from durable records alone and report the replayed audit-gate results (read-only, no LLM, no dispatch): mission-* -> mission replay, chain-* -> plain-chain replay",
    "  metrics-ingest  Ingest transcripts + Codex usage + chain records + delegated-job records into a durable SQLite store (read-only source, no LLM)",
    "  metrics-report  Query/report over the SQLite metrics store (read-only, no LLM, never ingests)",
    "  chain-cancel  Request a running chain to stop (file-based, works across processes)",
    "  status     List recent jobs or show one by ID",
    "  result     Show completed job result (latest, or by ID; --full for the full body)",
    "  cancel     Cancel a running job",
    "  serve-stop Stop the background opencode server and remove its state file",
    "  install-agents  Copy phase agent definitions and skills to kusabi's opencode config dir (<state root>/opencode-config/opencode), or OPENCODE_AGENT_DIR / OPENCODE_SKILL_DIR",
    "  install-cli  Write a kusabi-companion shim to $KUSABI_BIN_DIR (default ~/.local/bin), and symlink the delegate / kusabi-result-handling skills into $KUSABI_CODEX_DIR/skills (default ~/.codex/skills) when that directory exists",
    "  baseline   Report collected test count, gate states, and optional smoke baseline for a container (read-only, no LLM)",
    "  help       Show this help message",
    "",
    "Flags:",
    "  --read-only, --resume-last",
    "  --base <ref> (review: branch diff base; task: diff base for --phase review --container, rejected elsewhere), --agent <id>, --phase <name> (investigate|implement|review|respond|gofer|test-author|plan)",
    "  --backend opencode|claude|agy|codex (task/chain: force EVERY phase onto that backend; default opencode. Redundant when --model names a backend — a --backend that disagrees with such a --model is a contradiction and is rejected, naming both. With neither, the config chain entries decide: models.phases.<phase> (or models.chain) entries may carry a claude/, agy/, or codex/ prefix for per-phase backend mixing; one phase's chain must be single-backend. agy resumes via --conversation: --session/--resume-last are accepted when the job store proves the id an agy conversation, and --read-only/--deny are rejected on it. codex runs every invocation in a fixed read-only sandbox with reasoning effort high: --read-only is accepted, --deny is rejected, and the model must be one of the exact seat ids (" + formatCodexSupportedModels("or") + "). chain-resume accepts --backend/--model only to route a quota-exhausted review seat onto a different backend or model)",
    "  --session <id>, --timeout <s>, --watchdog <s>, --deny <tools>",
    "  --brief-file <path> (task / chain: read the brief from a file; exclusive with inline text)",
    "  --container <cid> (chain/task: container to run deterministic probes in; NOT supported by review)",
    "  --keep-serve (chain / chain-resume: keep the serve alive after the chain finishes)",
    "  --full (result: show the full stored result body instead of the compact default)",
    "  --force (serve-stop: force kill the serve even when jobs are running)",
    "  --prior <text> (review: prior findings for anti-ratchet)",
    "  --max-rounds <N> (chain: max rounds, default 4)",
    "  --chain-id <id> (chain / chain-detach: run the chain under this id instead of minting one — caller-owned: must be unique per concurrent dispatch. The id becomes a path segment under chains/, so it must match chain-[a-z0-9]+ and its directory must not already exist \u2014 a malformed id is refused before any filesystem write. chain-detach hands the SAME id back: the emitted wait line is `chain-wait <id>`, which waits for the chain by name \u2014 no --next, no --since, and no recency race with another orchestrator working the same repo)",
    "  --mission-file <path> (luna / luna-detach: the mission brief file; required. The mission brief is the outer brief — inner chains get their own brief from the coordinator's run_chain request)",
    "  --mission-id <id> (luna / luna-detach: run the mission under this id instead of minting one. The id becomes a path segment under missions/, so it must match mission-[a-z0-9]+. luna-detach hands the SAME id back: the emitted wait line is `luna-wait <id>`, which waits for the mission by name — no recency selection)",
    `  --coordinator-model <provider/model> (luna / luna-detach: the coordinator seat, default ${DEFAULT_COORDINATOR_SEAT.provider}/${DEFAULT_COORDINATOR_SEAT.model}; the luna mode never leaves the codex seats, and a non-default model is refused unless --allow-substitute authorizes it)`,
    `  --auditor-model <provider/model> (luna / luna-detach: the auditor seat, default ${DEFAULT_AUDITOR_SEAT.provider}/${DEFAULT_AUDITOR_SEAT.model}; same substitution rule as --coordinator-model)`,
    "  --allow-substitute (luna / luna-detach: explicitly authorize a non-default coordinator/auditor seat. Substitution is loud in mission records and show/wait output — requested and actual models are both recorded)",
    "  --audit-override <gateId> (luna-resume: the blocking gate a human override resolves. Required together with --audit-override-reason and --audit-override-by; the original verdict is embedded byte-for-byte and only a sol-blocked mission can be overridden)",
    "  --audit-override-reason <reason> (luna-resume: the human's reason for the override, persisted verbatim. Required; refused when empty)",
    "  --audit-override-by <actor> (luna-resume: the human identifier authorising the override. Required; refused when empty)",
    "  --next (chain-wait: wait for a chain to APPEAR and then wait on it, instead of naming one; selects the newest chain that is new since the wait started OR was already there and has not reached a terminal state, so a chain the dispatch created in the moment before the wait started still counts and a chain that finished earlier never does; a preexisting empty directory with no control record and older than --appear-timeout is debris from a dispatch that died before it wrote anything, and is skipped with a stderr note; while the selected chain is still recordless, a newer or same-stamped chain that appears wins instead of the wait stalling on the empty dir (a dir once traded away is never revisited); a dispatch that dies before creating a chain directory exits non-zero here instead of looking finished)",
    "  --since <ISO> (chain-wait --next: only a chain created at or after this stamp counts as the one to wait for, terminal or not — the precise tool, with an explicit chain id, when several chains run in one workspace at once and the default newest-unfinished selection would be ambiguous; while the selected chain has no control record yet, a newer or same-stamped in-window chain that appears wins, same as the default selection)",
    "  --poll-interval <s> (chain-wait: state poll interval, default 2)",
    "  --appear-timeout <s> (chain-wait: bound on --next, on a named chain whose directory has not appeared yet, and on a chain directory that never gets a control record, default 120)",
    "  --progress-timeout <s> (chain-wait: give up on a chain whose state has not moved for this long even though its process is alive, default 7200)",
    "  --since <ISO> (chain-stats: start of time range, inclusive)",
    "  --until <ISO> (chain-stats: end of time range, exclusive)",
    "  --compare <ISO> (chain-stats: show before/after comparison at cutoff)",
    "  --transcript-dir <path> (metrics-ingest: default ~/.claude/projects)",
    "  --codex-usage-dir <path> (metrics-ingest: default $CODEX_HOME/sessions or ~/.codex/sessions)",
    "  --state-root <path> (metrics-ingest: default the kusabi state root, ~/.kusabi)",
    "  --db <path> (metrics-ingest: default <state-root>/metrics.db)",
    "  --dry-run (metrics-ingest: parse and report counts, write nothing)",
    "  --db <path> (metrics-report: default <state-root>/metrics.db)",
    "  --state-root <path> (metrics-report: default the kusabi state root)",
    "  --since <ISO> (metrics-report: window start, inclusive)",
    "  --until <ISO> (metrics-report: window end, exclusive)",
    "  --json (metrics-report: emit the report as one JSON document instead of text)",
    "  --sample-rate <0..1> (evaluation: deterministic T12 sampling rate for the replay; recorded policyInput.sampling always wins)",
    "  --salt <string> (evaluation: sampling salt for the replay, default v1)",
    "  -h, --help",
    "",
    "Unknown flags cause an error. Use -- to treat subsequent tokens as literal text.",
    "",
    "Serve lifecycle:",
    "  - chain stops its serve on completion unless --keep-serve is passed.",
    "  - serve-stop kills the serve and removes its server.json.",
    "  - serve-stop with running jobs declines and points at chain-cancel unless --force is passed.",
    "  - Idle serves without running jobs are reaped on next invocation after",
    "    KUSABI_SERVE_TTL_MS (default 30 min).",
  ].join("\n");
}

// Subcommands that create a job — they reach runPrompt() or dispatchWithFallback()
// (which itself calls runPrompt()) directly, or start a chain (which dispatches
// rounds through the same path), or run a luna mission (which dispatches the
// coordinator through the codex backend and runs inner chains through the
// chain lifecycle). Enumerated from the switch in main() below; every other
// subcommand only reads or stops existing state.
//   task         -> dispatchWithFallback (cmdTask)
//   review       -> runPrompt            (cmdReview)
//   chain        -> dispatchWithFallback via runImplementPhase, per round (cmdChain)
//   chain-resume -> same as chain, from a saved position (cmdChainResume)
//   luna         -> runLunaMission (cmdLuna)
//   luna-detach  -> spawns a detached luna child (cmdLunaDetach)
//   luna-resume  -> resumes a mission's driver from saved state (cmdLunaResume)
const JOB_CREATING_SUBCOMMANDS = new Set(["task", "review", "chain", "chain-resume", "chainResume", "chain-detach", "chainDetach", "task-detach", "taskDetach", "luna", "luna-detach", "lunaDetach", "luna-resume", "lunaResume"]);

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  const cwd = process.cwd();

  // Fix 3 (kusabi #136): refuse to spawn a job when running inside a kusabi
  // worker's own tool process. ensureServer() stamps KUSABI_WORKER_CONTEXT=1
  // into the opencode serve's env; every tool process a worker session runs
  // (bash included) is a descendant of that serve and inherits the marker.
  // Without this, a worker that regains dispatch access (a quoted command,
  // a bug in a deny list, a future tool) can re-invoke the companion and
  // start a chain reaction — this is exactly how the #136 fork bomb spread.
  // Read-only / stop subcommands stay allowed: the guard is against
  // *spawning*, not against reading or stopping. The orchestrator's own
  // (host) invocations are unaffected because nothing sets the marker there.
  if (process.env.KUSABI_WORKER_CONTEXT && JOB_CREATING_SUBCOMMANDS.has(subcommand)) {
    throw new Error(
      "refusing to dispatch from inside a kusabi worker context (KUSABI_WORKER_CONTEXT is set). " +
      "Workers must not spawn jobs — put your findings in your final answer and let the orchestrator decide."
    );
  }

  // Startup reaper: reap idle serves whose last activity is older than TTL,
  // and reap orphaned serve processes that no server.json names (the marker
  // env buildServeEnv() stamps makes them recognisable). Best-effort; a
  // failure here must never crash the invoking command.
  try {
    const raw = process.env.KUSABI_SERVE_TTL_MS;
    const ttlMs = parseFloat(raw);
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 30 * 60 * 1000;
    const root = stateRoot();
    // On a serve-stop invocation the sweep leaves identity-failed records in
    // place: cmdServeStop adjudicates them itself and must say why it
    // declined — if the reaper deleted the record first, the user would only
    // ever see "no server recorded" (kusabi #181 follow-up).
    reapIdleServes(root, ttl, { keepIdentityFailed: subcommand === "serve-stop" });
    reapOrphanedServes(root);
  } catch { /* best-effort */ }

  // Claude Code passes "$ARGUMENTS" as a single string; re-split it.
  const flat = argv.length === 1 && argv[0]?.includes(" ") ? argv[0].split(/\s+/).filter(Boolean) : argv;

  // --help / -h before any literal "--", or the help subcommand -> usage, exit 0
  const sepIdx = flat.indexOf("--");
  const preLiteral = flat.slice(0, sepIdx >= 0 ? sepIdx : flat.length);
  if (
    subcommand === "help" || subcommand === "--help" || subcommand === "-h" ||
    preLiteral.includes("--help") || preLiteral.includes("-h")
  ) {
    return usage();
  }

  const parsed = parseArgs(flat);

  // --backend is a task/chain dispatch decision (kusabi #184); on any other
  // subcommand it would be silently ignored — reject it out loud instead.
  if (parsed.flags.backend && subcommand !== "task" && subcommand !== "task-detach" && subcommand !== "taskDetach" && subcommand !== "chain" && subcommand !== "chain-detach" && subcommand !== "chainDetach" && subcommand !== "chain-resume" && subcommand !== "chainResume") {
    throw new Error(`--backend is only supported by task and chain (got subcommand ${subcommand ?? "(none)"})`);
  }

  // The chain-wait bounds are wait decisions; on any other subcommand they
  // would be silently ignored, and a wait flag that did nothing is exactly
  // the silent-failure class chain-wait exists to remove.  (--since is shared
  // with chain-stats / metrics, so it is checked inside cmdChainWait instead.)
  const waitSubcommands = new Set([
    "chain-wait", "chainWait",
    "chain-detach", "chainDetach",
    "task-wait", "taskWait",
    "task-detach", "taskDetach",
    "luna-wait", "lunaWait",
  ]);
  if (!waitSubcommands.has(subcommand)) {
    for (const flag of ["next", "poll-interval", "appear-timeout", "progress-timeout"]) {
      if (parsed.flags[flag] !== undefined) {
        throw new Error(`--${flag} is only supported by chain-wait, chain-detach, task-wait, task-detach and luna-wait (got subcommand ${subcommand ?? "(none)"})`);
      }
    }
  }

  // The luna mission flags (kusabi #530) are mission-creation decisions; on
  // any other subcommand they would be silently ignored — reject them out
  // loud, exactly like --backend above.  The value flags are
  // stored under their kebab keys, but the boolean --allow-substitute is
  // stored under the camelCase key parseArgs derives, so it is checked
  // separately.
  const lunaCreating = new Set(["luna", "luna-detach", "lunaDetach"]);
  for (const flag of ["mission-file", "mission-id", "coordinator-model", "auditor-model"]) {
    if (parsed.flags[flag] !== undefined && !lunaCreating.has(subcommand)) {
      throw new Error(`--${flag} is only supported by luna and luna-detach (got subcommand ${subcommand ?? "(none)"})`);
    }
  }
  if (parsed.flags.allowSubstitute === true && !lunaCreating.has(subcommand)) {
    throw new Error(`--allow-substitute is only supported by luna and luna-detach (got subcommand ${subcommand ?? "(none)"})`);
  }
  // luna-wait is a NAMED wait only: the --next/--since selectors belong to
  // chain-wait / task-wait and would be silently ignored by the luna wait
  // loop (its handler only reads the shared bounds).  Reject them out loud.
  if (
    (subcommand === "luna-wait" || subcommand === "lunaWait") &&
    (parsed.flags.next !== undefined || parsed.flags.since !== undefined)
  ) {
    const flag = parsed.flags.next !== undefined ? "next" : "since";
    throw new Error(
      `--${flag} is only supported by chain-wait and task-wait — luna-wait waits for a ` +
      `named mission id only (got subcommand ${subcommand ?? "(none)"})`,
    );
  }
  // --container on the read-only luna surfaces would be silently ignored —
  // wait/show never start a mission, so a container flag there is a mistake.
  // The steering surfaces (luna-cancel / luna-resume) act on recorded state,
  // so a container flag is equally meaningless there.  The read-only
  // `evaluation` surface (kusabi #532) never names a container either.
  if (
    (subcommand === "luna-wait" || subcommand === "lunaWait" ||
     subcommand === "luna-show" || subcommand === "lunaShow" ||
     subcommand === "luna-cancel" || subcommand === "lunaCancel" ||
     subcommand === "luna-resume" || subcommand === "lunaResume" ||
     subcommand === "evaluation") &&
    parsed.flags.container !== undefined
  ) {
    throw new Error(`--container is only supported by luna and luna-detach (got subcommand ${subcommand ?? "(none)"})`);
  }

  // The evaluation sampling flags (kusabi #532) are replay parameters; on any
  // other subcommand they would be silently ignored — reject them out loud,
  // exactly like the mission flags above.
  if (parsed.flags["sample-rate"] !== undefined && subcommand !== "evaluation") {
    throw new Error(`--sample-rate is only supported by evaluation (got subcommand ${subcommand ?? "(none)"})`);
  }
  if (parsed.flags.salt !== undefined && subcommand !== "evaluation") {
    throw new Error(`--salt is only supported by evaluation (got subcommand ${subcommand ?? "(none)"})`);
  }

  // The luna-resume audit-override flags (kusabi #531) are human-override
  // decisions; on any other subcommand they would be silently ignored —
  // reject them out loud, exactly like --backend above.
  if (
    subcommand !== "luna-resume" && subcommand !== "lunaResume" &&
    (parsed.flags["audit-override"] !== undefined ||
     parsed.flags["audit-override-reason"] !== undefined ||
     parsed.flags["audit-override-by"] !== undefined)
  ) {
    throw new Error(`--audit-override* is only supported by luna-resume (got subcommand ${subcommand ?? "(none)"})`);
  }

  if (parsed.flags["state-root"] !== undefined) {
    const stateRootOk = new Set([
      "metrics-ingest", "metricsIngest", "metrics-report", "metricsReport",
    ]);
    if (!stateRootOk.has(subcommand)) {
      throw new Error(`--state-root is only supported by metrics-ingest and metrics-report (got subcommand ${subcommand ?? "(none)"})`);
    }
  }

  switch (subcommand) {
    case "setup":
      return cmdSetup(cwd);
    case "task":
      return cmdTask(cwd, parsed);
    case "review":
      return cmdReview(cwd, parsed);
    case "status":
      return cmdStatus(cwd, parsed);
    case "result":
      return cmdResult(cwd, parsed);
    case "cancel":
      return cmdCancel(cwd, parsed);
    case "serve-stop":
      return cmdServeStop(cwd, parsed);
    case "chain-cancel":
    case "chainCancel":
      return cmdChainCancel(cwd, parsed);
    case "install-agents":
      return cmdInstallAgents();
    case "install-cli":
      return cmdInstallCli({ selfPath: COMPANION_SCRIPT });
    case "baseline":
      return cmdBaseline(cwd, parsed);
    case "chain":
      return cmdChain(cwd, parsed);
    case "chain-detach":
    case "chainDetach":
      return cmdChainDetach(cwd, parsed);
    case "task-detach":
    case "taskDetach":
      return cmdTaskDetach(cwd, parsed);
    case "chain-resume":
    case "chainResume":
      return cmdChainResume(cwd, parsed);
    case "chain-show":
    case "chainShow":
      return cmdChainShow(cwd, parsed);
    case "chain-wait":
    case "chainWait":
      return cmdChainWait(cwd, parsed);
    case "task-wait":
    case "taskWait":
      return cmdTaskWait(cwd, parsed);
    case "luna":
      return cmdLuna(cwd, parsed);
    case "luna-detach":
    case "lunaDetach":
      return cmdLunaDetach(cwd, parsed);
    case "luna-wait":
    case "lunaWait":
      return cmdLunaWait(cwd, parsed);
    case "luna-show":
    case "lunaShow":
      return cmdLunaShow(cwd, parsed);
    case "luna-cancel":
    case "lunaCancel":
      return cmdLunaCancel(cwd, parsed);
    case "luna-resume":
    case "lunaResume":
      return cmdLunaResume(cwd, parsed);
    case "evaluation":
      return cmdEvaluation(cwd, parsed);
    case "chain-stats":
    case "chainStats":
      return cmdChainStats(cwd, parsed);
    case "metrics-ingest":
    case "metricsIngest":
      return cmdMetricsIngest(cwd, parsed);
    case "metrics-report":
    case "metricsReport":
      return cmdMetricsReport(cwd, parsed);
    default:
      throw new Error(`unknown subcommand: ${subcommand ?? "(none)"}. Use setup|task|review|chain|baseline|chain-detach|task-detach|task-wait|chain-resume|chain-show|chain-wait|chain-stats|metrics-ingest|metrics-report|chain-cancel|status|result|cancel|serve-stop|install-agents|install-cli|luna|luna-detach|luna-wait|luna-show|luna-cancel|luna-resume|evaluation`);
  }
}

/**
 * Normalise what a subcommand returned into the two things the shell sees.
 *
 * A subcommand returns either the text to print, or `{ text, exitCode }`
 * when its OUTCOME must reach the exit code too.  Printing a failure and
 * still exiting 0 is exactly the false confirmation `cancel` now guards
 * against (kusabi #209): a caller that checks `$?` would read the
 * could-not-stop path as a successful cancel.
 *
 * @param {string|{text?: string, exitCode?: number}|null|undefined} output
 * @returns {{text: string, exitCode: number}}
 */
export function commandOutcome(output) {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    return {
      text: typeof output.text === "string" ? output.text : "",
      exitCode: Number.isInteger(output.exitCode) ? output.exitCode : 0,
    };
  }
  return { text: typeof output === "string" ? output : "", exitCode: 0 };
}

// flushAndExit (kusabi #243) lives in ./flush-and-exit.mjs since kusabi #277.
// Its behaviour is unchanged and this file is still one of its callers — the
// move is about what a *child process* pays to import it.  The #243 tests
// spawn a node child that imports flushAndExit, writes 150KiB and exits, all
// inside one wall-clock budget; when the import was of this module, a large
// share of that budget was this module's import graph rather than the drain
// under test.  See the header of flush-and-exit.mjs.

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then((output) => {
      const { text, exitCode } = commandOutcome(output);
      if (text) process.stdout.write(`${text}\n`);
      flushAndExit(exitCode);
    })
    .catch((err) => {
      process.stdout.write(`kusabi-companion error: ${err.message}\n`);
      flushAndExit(1);
    });
}
