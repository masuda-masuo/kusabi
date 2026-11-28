// chain-notify.mjs — host-side, fail-soft terminal inbox notification.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { codexMcpServerDefinitions } from "./codex-mcp.mjs";

const clientPath = fileURLToPath(new URL("./chain-inbox-client.mjs", import.meta.url));

// The kaiba inbox operations kusabi uses: append a terminal event, and
// acknowledge the open entries of a chain once the orchestrator closed it.
export const KAIBA_INBOX_TOOLS = ["inbox_append", "inbox_ack_subject"];

/**
 * Derive the state directory from a chain directory.
 * chainDir = stateDir / chains / chain-{id}
 */
export function stateDirForChain(chainDir) {
  return path.resolve(chainDir, "..", "..");
}

/**
 * The kaiba inbox subject for a chain.
 *
 * A chain id is unique only inside one kusabi state directory: `--chain-id` is
 * caller-supplied, so two repositories can mint the same id. Kaiba matches
 * acknowledgements on producer+subject, so the subject must carry the state
 * directory's hash name as well (e.g. `9a8d0269177e:chain-abc`).
 *
 * @param {string} stateDir
 * @param {string} chainId
 * @returns {string}
 */
export function inboxSubject(stateDir, chainId) {
  return `${path.basename(path.resolve(stateDir))}:${chainId}`;
}

/** Derive the chain id from a chain directory path. */
export function chainIdFromDir(chainDir) {
  return path.basename(chainDir);
}

function writeInboxFile(inboxDir, chainId, info) {
  fs.mkdirSync(inboxDir, { recursive: true });
  const inboxPath = path.join(inboxDir, `${chainId}.md`);
  const body = `# Chain ${chainId} — terminal\n\n` +
    `- **status**: ${info.status}\n` +
    `- **disposition**: ${info.disposition ?? "none"}\n` +
    `- **container**: ${info.container ?? "none"}\n` +
    (info.errorReason ? `- **reason**: ${info.errorReason}\n` : "") +
    (info.artifactsSurvive ? `- **implement artifacts survive**: yes${info.artifactReference ? ` (job ${info.artifactReference})` : ""}\n` : "") +
    `- **inbox**: ${info.inboxPath}\n\n` +
    `## Next steps\n\n` +
    `Run \`kusabi-companion chain-show ${chainId}\` then inspect the review record and adjudicate / publish / record.\n`;
  fs.writeFileSync(inboxPath, body, "utf8");
  return inboxPath;
}

/**
 * Best-effort local kaiba inbox append using the operator-owned MCP definition.
 * This function is intentionally synchronous because terminal notification is
 * part of the chain finalization path.
 */
function appendKaibaInbox(configFile, event, env, timeoutMs) {
  try {
    const definitions = codexMcpServerDefinitions({ kaiba: KAIBA_INBOX_TOOLS }, configFile);
    const definition = definitions.kaiba;
    if (!definition?.command || definition.url) return { delivered: false, duplicate: false };

    const configuredEnv = definition.env ?? {};
    if (Object.values(configuredEnv).some((value) => typeof value !== "string")) {
      return { delivered: false, duplicate: false };
    }

    const result = spawnSync(process.execPath, [clientPath], {
      input: JSON.stringify({ command: definition.command, args: definition.args ?? [], env: configuredEnv, event, timeoutMs }),
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    if (result.error || result.status !== 0) return { delivered: false, duplicate: false };
    const response = JSON.parse(result.stdout);
    if (response?.ok !== true || typeof response.duplicate !== "boolean") {
      return { delivered: false, duplicate: false };
    }
    return { delivered: true, duplicate: response.duplicate };
  } catch {
    return { delivered: false, duplicate: false };
  }
}

// One kaiba session's cost is startup, not per-subject calls, so the whole ack
// attempt uses the same bound as an append regardless of how many chains a
// close run acknowledges.
const ACK_TIMEOUT_MS = 2000;

export function ackTimeoutFor(requestedTimeout) {
  return Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.min(requestedTimeout, ACK_TIMEOUT_MS)
    : ACK_TIMEOUT_MS;
}

function ackFailureReason(error) {
  return error && typeof error === "object" && "message" in error
    ? String(error.message)
    : String(error);
}

/**
 * Format a single stdout summary line for one chain's inbox ack outcome.
 *
 * @param {string} label - `<chainId>` for archive, `<state-dir-hash>/<chainId>` for historical close.
 * @param {{ acknowledged?: number, error?: string, skipped?: boolean } | undefined} row
 * @param {{ skipped?: boolean }} [opts]
 * @returns {string}
 */
export function formatInboxAckLine(label, row, { skipped = false } = {}) {
  if (skipped || row?.skipped) {
    return `Inbox ack skipped for ${label}: KUSABI_CHAIN_NOTIFY=0`;
  }
  if (row && typeof row.error !== "string" && Number.isInteger(row.acknowledged)) {
    const noun = row.acknowledged === 1 ? "entry" : "entries";
    return `Acknowledged ${row.acknowledged} inbox ${noun} for ${label}.`;
  }
  const reason = row?.error ?? "kaiba ack client returned no result";
  return `Inbox ack failed for ${label}: ${reason}`;
}

function logAckFailure(subject, reason) {
  console.error(`[chain-notify] inbox ack failed for ${subject}: ${reason}`);
}

/**
 * Best-effort acknowledgement of a chain's open kaiba inbox entries.
 *
 * One spawned kaiba session acknowledges every subject, so a historical close
 * of many records costs one spawn. Producer-and-subject scoped by kaiba, so it
 * acknowledges every entry kusabi appended for that chain (including rework and
 * rearm occurrences). Never throws; failures are logged to stderr naming the
 * chain id.
 *
 * @param {object} [opts]
 * @param {Array<{ stateDir: string, chainId: string }>} [opts.chains]
 * @param {NodeJS.ProcessEnv} [opts.env=process.env]
 * @param {string} [opts.mcpConfigFile]
 * @param {number} [opts.timeoutMs]
 * @returns {{ skipped?: boolean, results: Array<{ chainId: string, subject: string, acknowledged?: number, error?: string, skipped?: boolean }> }}
 */
export function acknowledgeChainInbox({ chains = [], env = process.env, mcpConfigFile, timeoutMs } = {}) {
  const entries = [];
  const seen = new Set();
  for (const chain of Array.isArray(chains) ? chains : []) {
    if (!chain || typeof chain.stateDir !== "string" || chain.stateDir.length === 0) continue;
    if (typeof chain.chainId !== "string" || chain.chainId.length === 0) continue;
    const subject = inboxSubject(chain.stateDir, chain.chainId);
    if (seen.has(subject)) continue;
    seen.add(subject);
    entries.push({ chainId: chain.chainId, subject });
  }
  if (entries.length === 0) return { results: [] };
  if (env.KUSABI_CHAIN_NOTIFY === "0") {
    return { skipped: true, results: entries.map(({ chainId, subject }) => ({ chainId, subject, skipped: true })) };
  }

  const boundMs = ackTimeoutFor(timeoutMs);
  const failAll = (reason) => {
    for (const { subject } of entries) logAckFailure(subject, reason);
    return { results: entries.map(({ chainId, subject }) => ({ chainId, subject, error: reason })) };
  };

  let definition;
  try {
    definition = codexMcpServerDefinitions({ kaiba: KAIBA_INBOX_TOOLS }, mcpConfigFile).kaiba;
  } catch (error) {
    return failAll(ackFailureReason(error));
  }
  if (!definition?.command || definition.url) {
    return failAll(definition?.url
      ? "kaiba definition is remote"
      : "kaiba definition has no local command");
  }
  const configuredEnv = definition.env ?? {};
  if (Object.values(configuredEnv).some((value) => typeof value !== "string")) {
    return failAll("kaiba definition has a non-string environment value");
  }

  let response;
  try {
    const result = spawnSync(process.execPath, [clientPath], {
      input: JSON.stringify({
        operation: "ack",
        command: definition.command,
        args: definition.args ?? [],
        env: configuredEnv,
        subjects: entries.map(({ subject }) => subject),
        timeoutMs: boundMs,
      }),
      encoding: "utf8",
      timeout: boundMs,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    if (result.error || result.status !== 0) {
      return failAll(result.error
        ? ackFailureReason(result.error)
        : `kaiba ack client exited ${result.status}`);
    }
    response = JSON.parse(result.stdout);
  } catch (error) {
    return failAll(ackFailureReason(error));
  }
  if (response?.ok !== true || !Array.isArray(response.results)) {
    return failAll("kaiba ack client returned an invalid response");
  }

  const bySubject = new Map();
  for (const row of response.results) {
    if (row && typeof row === "object" && typeof row.subject === "string") bySubject.set(row.subject, row);
  }
  return {
    results: entries.map(({ chainId, subject }) => {
      const row = bySubject.get(subject);
      if (!row) {
        logAckFailure(subject, "kaiba ack client returned no result");
        return { chainId, subject, error: "kaiba ack client returned no result" };
      }
      if (typeof row.error === "string") {
        logAckFailure(subject, row.error);
        return { chainId, subject, error: row.error };
      }
      if (!Number.isInteger(row.acknowledged) || row.acknowledged < 0) {
        logAckFailure(subject, "kaiba ack client returned an invalid acknowledged count");
        return { chainId, subject, error: "kaiba ack client returned an invalid acknowledged count" };
      }
      return { chainId, subject, acknowledged: row.acknowledged };
    }),
  };
}

/**
 * Notify on chain terminal disposition.
 *
 * @param {object} opts
 * @param {string} opts.stateDir
 * @param {string} opts.chainId
 * @param {string} opts.status
 * @param {string|null} [opts.disposition]
 * @param {string|null} [opts.container]
 * @param {string} [opts.cwdLabel]
 * @param {NodeJS.ProcessEnv} [opts.env=process.env]
 * @param {string} [opts.occurrenceId]
 * @param {string} [opts.mcpConfigFile]
 * @param {number} [opts.timeoutMs]
 * @returns {{ skipped?: boolean, inboxPath?: string, inboxDelivered?: boolean, duplicate?: boolean }}
 */
export function notifyChainTerminal(opts) {
  const {
    stateDir,
    chainId,
    status,
    disposition = null,
    container = null,
    cwdLabel = "",
    errorReason,
    artifactsSurvive,
    artifactReference,
    env = process.env,
    occurrenceId,
    mcpConfigFile,
    timeoutMs: requestedTimeout = 2000,
  } = opts;

  if (env.KUSABI_CHAIN_NOTIFY === "0") return { skipped: true };

  const inboxDir = path.join(stateDir, "inbox");
  const inboxPath = path.resolve(inboxDir, `${chainId}.md`);
  try {
    writeInboxFile(inboxDir, chainId, {
      status, disposition, container, inboxPath, errorReason, artifactsSurvive, artifactReference,
    });
  } catch (err) {
    const msg = err && typeof err === "object" && "message" in err ? err.message : String(err);
    console.error(`[chain-notify] inbox write failed for ${chainId}: ${msg}`);
  }

  if (typeof occurrenceId !== "string" || occurrenceId.length === 0) {
    return { inboxPath, inboxDelivered: false };
  }

  const parsedTimeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.min(requestedTimeout, 2000)
    : 2000;
  const title = typeof cwdLabel === "string" && cwdLabel.trim()
    ? cwdLabel
    : chainId;
  const event = {
    event_key: `chain-terminal:${chainId}:${occurrenceId}`,
    event_type: "chain_terminal",
    subject: inboxSubject(stateDir, chainId),
    title,
    metadata: {
      status,
      disposition,
      container,
      inbox_path: inboxPath,
      cwd_label: cwdLabel,
      ...(errorReason !== undefined ? { error_reason: errorReason } : {}),
      ...(artifactsSurvive !== undefined ? { artifacts_survive: artifactsSurvive } : {}),
      ...(artifactReference !== undefined ? { artifact_reference: artifactReference } : {}),
    },
  };
  const result = appendKaibaInbox(mcpConfigFile, event, env, parsedTimeout);
  return {
    inboxPath,
    inboxDelivered: result.delivered,
    ...(result.delivered ? { duplicate: result.duplicate } : {}),
  };
}
