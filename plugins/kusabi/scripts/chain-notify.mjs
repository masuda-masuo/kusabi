// chain-notify.mjs — host-side, surface-agnostic terminal notification.
//
// On every terminal chain disposition this writes a durable inbox file under
// the workspace state dir and best-effort appends one kaiba agenda row.
// This is NOT a Cursor hook — it fires from finalizeChainControl() so it
// covers every terminal path (completed / cancelled / failed) regardless of
// whether chain-wait or any session-bound watcher is armed.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

/**
 * Resolve the kaiba database path.
 * Honours KAIBA_DB environment variable, falling back to ~/.kaiba/kaiba.db.
 * (Copied from kaiba-progress-watch.mjs — fail-soft path resolution style.)
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string}
 */
export function resolveKaibaDbPath(env = process.env) {
  if (typeof env.KAIBA_DB === "string" && env.KAIBA_DB.trim() !== "") {
    return env.KAIBA_DB.trim();
  }
  return path.join(os.homedir(), ".kaiba", "kaiba.db");
}

/**
 * Derive the state directory from a chain directory.
 * chainDir = stateDir / chains / chain-{id}
 *
 * @param {string} chainDir
 * @returns {string}
 */
export function stateDirForChain(chainDir) {
  return path.resolve(chainDir, "..", "..");
}

/**
 * Derive the chain id from a chain directory path.
 *
 * @param {string} chainDir
 * @returns {string}
 */
export function chainIdFromDir(chainDir) {
  return path.basename(chainDir);
}

/**
 * Write the inbox file for a terminal chain.
 *
 * @param {string} inboxDir — the inbox directory
 * @param {string} chainId
 * @param {object} info
 * @param {string} info.status
 * @param {string|null} info.disposition
 * @param {string|null} info.container
 * @param {string} info.inboxPath — absolute path of the written file
 * @returns {string} absolute path of the written file
 */
function writeInboxFile(inboxDir, chainId, info) {
  fs.mkdirSync(inboxDir, { recursive: true });
  const inboxPath = path.join(inboxDir, `${chainId}.md`);
  const disposition = info.disposition ?? "none";
  const container = info.container ?? "none";
  const body = `# Chain ${chainId} — terminal\n\n` +
    `- **status**: ${info.status}\n` +
    `- **disposition**: ${disposition}\n` +
    `- **container**: ${container}\n` +
    `- **inbox**: ${info.inboxPath}\n\n` +
    `## Next steps\n\n` +
    `Run \`kusabi-companion chain-show ${chainId}\` then inspect the review record and adjudicate / publish / record.\n`;
  fs.writeFileSync(inboxPath, body, "utf8");
  return inboxPath;
}

/**
 * Best-effort insert into kaiba actions table.
 * Must NOT throw on any failure.
 *
 * @param {string} dbPath
 * @param {object} info
 * @param {string} info.chainId
 * @param {string} info.status
 * @param {string|null} info.disposition
 * @param {string|null} info.container
 * @param {string} info.cwdLabel
 * @param {string} info.inboxPath
 * @param {string} info.author
 * @param {string} now — ISO timestamp
 */
function insertKaibaAgenda(dbPath, info, now) {
  let db;
  try {
    db = new DatabaseSync(dbPath, { open: true, write: true });
  } catch {
    // DB file missing or unreadable — fail-soft
    return false;
  }

  try {
    // Check if actions table exists
    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='actions'"
    );
    const row = tableCheck.get();
    if (!row) return false;

    // Dedup: if any open row (done_at IS NULL) already mentions this chainId, skip
    const dedup = db.prepare(
      "SELECT id FROM actions WHERE done_at IS NULL AND content LIKE ?"
    );
    const existing = dedup.get(`%${info.chainId}%`);
    if (existing) return false;

    // Find the next position: max position of open rows + 1.0, or 1.0 if none
    const posRow = db.prepare(
      "SELECT MAX(position) AS max_pos FROM actions WHERE done_at IS NULL"
    ).get();
    const position = (posRow && posRow.max_pos != null) ? posRow.max_pos + 1.0 : 1.0;

    const disposition = info.disposition ?? "none";
    const container = info.container ?? "none";
    const cwdLabel = info.cwdLabel || "unknown";
    const content =
      `Inspect ${cwdLabel} ${info.chainId} (status=${info.status}, disposition=${disposition}) ` +
      `container=${container} — chain-show then adjudicate/publish/record. inbox=${info.inboxPath}`;

    const insert = db.prepare(
      "INSERT INTO actions (content, position, author, created_at) VALUES (?, ?, ?, ?)"
    );
    insert.run(content, position, info.author, now);
    return true;
  } catch {
    // Any SQL error — fail-soft
    return false;
  } finally {
    try { db.close(); } catch { /* best-effort */ }
  }
}

/**
 * Notify on chain terminal disposition.
 *
 * 1. If KUSABI_CHAIN_NOTIFY=0, skip silently.
 * 2. Write inbox file at {stateDir}/inbox/{chainId}.md (idempotent overwrite).
 * 3. Best-effort kaiba agenda row (deduped, fail-soft).
 *
 * @param {object} opts
 * @param {string} opts.stateDir   — workspace state root (e.g. ~/.kusabi/<hash>)
 * @param {string} opts.chainId
 * @param {string} opts.status     — completed / cancelled / failed
 * @param {string|null} [opts.disposition] — from chain.json, or null
 * @param {string|null} [opts.container]
 * @param {string} [opts.cwdLabel] — repo/cwd basename for agenda content
 * @param {NodeJS.ProcessEnv} [opts.env=process.env]
 * @param {string} [opts.now]      — ISO timestamp, defaults to now
 * @returns {{ skipped?: boolean, inboxPath?: string, agendaInserted?: boolean }}
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
    now = new Date().toISOString(),
  } = opts;

  // Opt-out
  if (env.KUSABI_CHAIN_NOTIFY === "0") {
    return { skipped: true };
  }

  const inboxDir = path.join(stateDir, "inbox");
  const inboxPath = path.join(inboxDir, `${chainId}.md`);

  // 1. Write inbox file — log on failure; still attempt agenda with the intended path
  try {
    writeInboxFile(inboxDir, chainId, {
      status,
      disposition,
      container,
      inboxPath,
    });
  } catch (err) {
    const msg = err && typeof err === "object" && "message" in err ? err.message : String(err);
    console.error(`[chain-notify] inbox write failed for ${chainId}: ${msg}`);
  }

  // 2. Best-effort kaiba agenda
  const author = env.KUSABI_AGENDA_AUTHOR || "kusabi";
  const dbPath = resolveKaibaDbPath(env);
  const agendaInserted = insertKaibaAgenda(dbPath, {
    chainId,
    status,
    disposition,
    container,
    cwdLabel,
    inboxPath,
    author,
  }, now) === true;

  return { inboxPath, agendaInserted };
}

/**
 * Format an optional notification reason: collapse whitespace to a single line,
 * and truncate to 300 characters with a trailing ellipsis if longer.
 *
 * @param {string|null|undefined} reason
 * @returns {string|null}
 */
export function formatNotificationReason(reason) {
  if (typeof reason !== "string") return null;
  const collapsed = reason.replace(/\r?\n|\r/g, " ").replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  if (collapsed.length > 300) {
    return collapsed.slice(0, 300) + "…";
  }
  return collapsed;
}

/**
 * Mission variant of the kaiba agenda insert (kusabi #531): one deduplicated
 * row per terminal MISSION, keyed on the mission id.  Fail-soft like the
 * chain variant - a missing/unreadable DB or a missing actions table is a
 * silent no-op, and an existing open row mentioning the mission id skips the
 * insert.
 *
 * @param {string} dbPath
 * @param {object} info
 * @param {string} info.missionId
 * @param {string} info.status
 * @param {string|null} info.disposition
 * @param {string|null} info.container
 * @param {string} info.cwdLabel
 * @param {string} info.inboxPath
 * @param {string} info.author
 * @param {string} now - ISO timestamp
 * @returns {boolean}
 */
function insertMissionKaibaAgenda(dbPath, info, now) {
  let db;
  try {
    db = new DatabaseSync(dbPath, { open: true, write: true });
  } catch {
    return false;
  }
  try {
    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='actions'"
    );
    const row = tableCheck.get();
    if (!row) return false;

    const dedup = db.prepare(
      "SELECT id FROM actions WHERE done_at IS NULL AND content LIKE ?"
    );
    const existing = dedup.get(`%${info.missionId}%`);
    if (existing) return false;

    const posRow = db.prepare(
      "SELECT MAX(position) AS max_pos FROM actions WHERE done_at IS NULL"
    ).get();
    const position = (posRow && posRow.max_pos != null) ? posRow.max_pos + 1.0 : 1.0;

    const disposition = info.disposition ?? "none";
    const container = info.container ?? "none";
    const cwdLabel = info.cwdLabel || "unknown";
    const reasonPart = info.reason ? ` reason=${info.reason}` : "";
    const content =
      `Inspect ${cwdLabel} ${info.missionId} (status=${info.status}, disposition=${disposition})${reasonPart} ` +
      `container=${container} - luna-show then adjudicate. inbox=${info.inboxPath}`;

    const insert = db.prepare(
      "INSERT INTO actions (content, position, author, created_at) VALUES (?, ?, ?, ?)"
    );
    insert.run(content, position, info.author, now);
    return true;
  } catch {
    return false;
  } finally {
    try { db.close(); } catch { /* best-effort */ }
  }
}

/**
 * Write the inbox file for a terminal mission (kusabi #531).  The file name
 * is `<missionId>.md`, so repeated finalisation idempotently overwrites the
 * same single inbox record - a terminal mission never produces more than one.
 *
 * @param {string} inboxDir
 * @param {string} missionId
 * @param {object} info
 * @param {string} info.status
 * @param {string|null} info.disposition
 * @param {string|null} info.container
 * @param {string} info.inboxPath
 * @returns {string} the absolute inbox path.
 */
function writeMissionInboxFile(inboxDir, missionId, info) {
  fs.mkdirSync(inboxDir, { recursive: true });
  const inboxPath = path.join(inboxDir, `${missionId}.md`);
  const disposition = info.disposition ?? "none";
  const container = info.container ?? "none";
  const reasonLine = info.reason ? `- **reason**: ${info.reason}\n` : "";
  const body = `# Mission ${missionId} - terminal\n\n` +
    `- **status**: ${info.status}\n` +
    `- **disposition**: ${disposition}\n` +
    reasonLine +
    `- **container**: ${container}\n` +
    `- **inbox**: ${info.inboxPath}\n\n` +
    `## Next steps\n\n` +
    `Run \`kusabi-companion luna-show ${missionId}\` then inspect the recommendation and adjudicate.\n`;
  fs.writeFileSync(inboxPath, body, "utf8");
  return inboxPath;
}

/**
 * Notify on a terminal MISSION (kusabi #531), the idempotent mission-terminal
 * path that preserves chain notification behavior byte-for-byte.
 *
 * 1. If KUSABI_CHAIN_NOTIFY=0, skip silently (same opt-out surface).
 * 2. Write one inbox file at {stateDir}/inbox/{missionId}.md (idempotent
 *    overwrite - a terminal mission emits exactly one inbox record).
 * 3. Best-effort kaiba agenda row (deduplicated on the mission id, fail-soft)
 *    - a terminal mission emits exactly one open agenda row.
 *
 * @param {object} opts
 * @param {string} opts.stateDir
 * @param {string} opts.missionId
 * @param {string} opts.disposition - the terminal mission disposition.
 * @param {string|null} [opts.container]
 * @param {string} [opts.cwdLabel]
 * @param {NodeJS.ProcessEnv} [opts.env=process.env]
 * @param {string} [opts.now]
 * @returns {{ skipped?: boolean, inboxPath?: string, agendaInserted?: boolean }}
 */
export function notifyMissionTerminal(opts) {
  const {
    stateDir,
    missionId,
    disposition,
    container = null,
    cwdLabel = "",
    env = process.env,
    now = new Date().toISOString(),
    reason = null,
  } = opts;

  // Opt-out (same surface as chain notification)
  if (env.KUSABI_CHAIN_NOTIFY === "0") {
    return { skipped: true };
  }

  const formattedReason = formatNotificationReason(reason);

  const inboxDir = path.join(stateDir, "inbox");
  const inboxPath = path.join(inboxDir, `${missionId}.md`);

  try {
    writeMissionInboxFile(inboxDir, missionId, {
      status: "completed",
      disposition,
      container,
      inboxPath,
      reason: formattedReason,
    });
  } catch (err) {
    const msg = err && typeof err === "object" && "message" in err ? err.message : String(err);
    console.error(`[chain-notify] mission inbox write failed for ${missionId}: ${msg}`);
  }

  const author = env.KUSABI_AGENDA_AUTHOR || "kusabi";
  const dbPath = resolveKaibaDbPath(env);
  const agendaInserted = insertMissionKaibaAgenda(dbPath, {
    missionId,
    status: "completed",
    disposition,
    container,
    cwdLabel,
    inboxPath,
    author,
    reason: formattedReason,
  }, now) === true;

  return { inboxPath, agendaInserted };
}
