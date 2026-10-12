// chain-notify.mjs — host-side, fail-soft terminal inbox notification.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { codexMcpServerDefinitions } from "./codex-mcp.mjs";

const clientPath = fileURLToPath(new URL("./chain-inbox-client.mjs", import.meta.url));

/**
 * Derive the state directory from a chain directory.
 * chainDir = stateDir / chains / chain-{id}
 */
export function stateDirForChain(chainDir) {
  return path.resolve(chainDir, "..", "..");
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
    const definitions = codexMcpServerDefinitions({ kaiba: ["inbox_append"] }, configFile);
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
    env = process.env,
    occurrenceId,
    mcpConfigFile,
    timeoutMs: requestedTimeout = 2000,
  } = opts;

  if (env.KUSABI_CHAIN_NOTIFY === "0") return { skipped: true };

  const inboxDir = path.join(stateDir, "inbox");
  const inboxPath = path.resolve(inboxDir, `${chainId}.md`);
  try {
    writeInboxFile(inboxDir, chainId, { status, disposition, container, inboxPath });
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
    subject: chainId,
    title,
    metadata: {
      status,
      disposition,
      container,
      inbox_path: inboxPath,
      cwd_label: cwdLabel,
    },
  };
  const result = appendKaibaInbox(mcpConfigFile, event, env, parsedTimeout);
  return {
    inboxPath,
    inboxDelivered: result.delivered,
    ...(result.delivered ? { duplicate: result.duplicate } : {}),
  };
}
