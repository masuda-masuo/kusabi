// review-record-close.mjs — mark old unfilled review records as historical
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { stateRoot } from "./state-paths.mjs";
import { isUnadjudicatedRecord } from "./review-record-scan.mjs";
import { readChainControl, withControlWriteLock } from "./chain-control.mjs";
import { acknowledgeChainInbox, inboxSubject, stateDirForChain } from "./chain-notify.mjs";

export const FINDINGS_HEADER = "## Findings adjudication (fill at inspection)";
const FINDINGS_HEADER_PATTERN = /^[ \t]*## Findings adjudication \(fill at inspection\)[ \t]*(\r?\n|$)/m;
export const HISTORICAL_MARK_PREFIX = "<!-- historical: not adjudicated; closed by review-record-close before ";
export const USAGE = "Usage: kusabi-companion review-record-close --historical --before <ISO> [--apply] [--state-root <dir>]";
const TERMINAL_CHAIN_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function finishedTimestamp(content) {
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/\bfinished:\s*(\S+)/i);
    if (!match) continue;
    const value = match[1];
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return null;
    return timestamp;
  }
  return null;
}

export function hasHistoricalMark(content) {
  let inFindings = false;
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*#+\s+/.test(line)) {
      if (/^\s*##\s+Findings adjudication\b/i.test(line)) {
        inFindings = true;
        continue;
      }
      if (inFindings) inFindings = false;
    }
    if (inFindings && line.trim().startsWith(HISTORICAL_MARK_PREFIX)) return true;
  }
  return false;
}

function listChainDirectories(root) {
  const dirs = [];
  let workspaces;
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return dirs;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const chainsDir = path.join(root, workspace.name, "chains");
    let chains;
    try {
      chains = fs.readdirSync(chainsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const chain of chains) {
      if (!chain.isDirectory()) continue;
      dirs.push(path.join(chainsDir, chain.name));
    }
  }
  return dirs.sort();
}

export function listRecords(root) {
  const records = [];
  for (const chainDir of listChainDirectories(root)) {
    const recordPath = path.join(chainDir, "review-record.md");
    try {
      if (fs.statSync(recordPath).isFile()) records.push(recordPath);
    } catch {
      // Missing or unreadable record: it cannot be a target.
    }
  }
  return records.sort();
}

export function validateBefore(before) {
  if (typeof before !== "string" || !Number.isFinite(Date.parse(before))) {
    throw new Error(`--before must be a parseable date: ${before}`);
  }
  if (/[\r\n]/.test(before) || before.includes("-->") || before.includes("--") || /[<>]/.test(before)) {
    throw new Error(`--before contains invalid characters: ${before}`);
  }
}

export function scanReviewRecords({ before, stateRootDir = stateRoot() }) {
  validateBefore(before);
  const cutoff = Date.parse(before);
  if (!Number.isFinite(cutoff)) throw new Error(`--before must be a parseable date: ${before}`);

  const targets = [];
  const skipped = [];
  for (const recordPath of listRecords(stateRootDir)) {
    let content;
    try {
      content = fs.readFileSync(recordPath, "utf8");
    } catch {
      continue;
    }
    if (!isUnadjudicatedRecord(content) || hasHistoricalMark(content)) continue;
    if (!FINDINGS_HEADER_PATTERN.test(content)) {
      skipped.push({ path: recordPath, reason: "no adjudication heading" });
      continue;
    }
    const finished = finishedTimestamp(content);
    if (finished === null) {
      skipped.push({ path: recordPath, reason: "no finished time" });
    } else if (finished < cutoff) {
      targets.push({ path: recordPath, content });
    }
  }
  return { targets, skipped };
}

function hasReviewRecordEntry(chainDir) {
  try {
    fs.lstatSync(path.join(chainDir, "review-record.md"));
    return true;
  } catch (error) {
    return error?.code !== "ENOENT";
  }
}

function evaluateRecordlessChain(chainDir, cutoff) {
  if (hasReviewRecordEntry(chainDir)) return null;
  const control = readChainControl(chainDir);
  if (!control || typeof control !== "object" || Array.isArray(control)) return null;
  if (typeof control.status !== "string" || !TERMINAL_CHAIN_STATUSES.has(control.status)) return null;
  if (typeof control.finishedAt !== "string") return null;
  const finished = Date.parse(control.finishedAt);
  if (!Number.isFinite(finished) || finished >= cutoff) return null;
  if (typeof control.terminalOccurrenceId !== "string" || control.terminalOccurrenceId.trim().length === 0) {
    return null;
  }
  return {
    stateDir: stateDirForChain(chainDir),
    chainId: path.basename(chainDir),
    status: control.status,
    finishedAt: control.finishedAt,
  };
}

function chainDirForRecordless(entry) {
  return path.join(entry.stateDir, "chains", entry.chainId);
}

export function scanRecordlessChains({ before, stateRootDir = stateRoot() }) {
  validateBefore(before);
  const cutoff = Date.parse(before);
  if (!Number.isFinite(cutoff)) throw new Error(`--before must be a parseable date: ${before}`);

  const recordless = [];
  for (const chainDir of listChainDirectories(stateRootDir)) {
    const entry = evaluateRecordlessChain(chainDir, cutoff);
    if (entry) recordless.push(entry);
  }
  return recordless;
}

function insertHistoricalMark(content, before) {
  validateBefore(before);
  const header = content.match(/^[ \t]*## Findings adjudication \(fill at inspection\)[ \t]*(\r?\n|$)/m);
  if (!header) throw new Error(`Findings adjudication heading not found`);
  const insertionIndex = header.index + header[0].length;
  const newline = header[1] || (content.includes("\r\n") ? "\r\n" : "\n");
  const mark = `${HISTORICAL_MARK_PREFIX}${before} -->`;
  const prefix = header[1] ? mark + newline : newline + mark;
  return content.slice(0, insertionIndex) + prefix + content.slice(insertionIndex);
}

function withAllControlWriteLocks(dirs, fn) {
  function acquire(index) {
    if (index >= dirs.length) {
      return fn();
    }
    return withControlWriteLock(dirs[index], () => acquire(index + 1));
  }
  return acquire(0);
}

export function closeReviewRecords({
  before,
  stateRootDir = stateRoot(),
  apply = false,
  env = process.env,
  mcpConfigFile,
  notifyTimeoutMs,
}) {
  validateBefore(before);
  const cutoff = Date.parse(before);
  const { targets, skipped } = scanReviewRecords({ before, stateRootDir });
  const recordless = scanRecordlessChains({ before, stateRootDir });
  if (apply && (targets.length > 0 || recordless.length > 0)) {
    const sortedTargets = [...targets].sort((a, b) => a.path.localeCompare(b.path));
    const sortedRecordless = [...recordless].sort((a, b) =>
      chainDirForRecordless(a).localeCompare(chainDirForRecordless(b)),
    );
    const dirs = [...new Set([
      ...sortedTargets.map((target) => path.dirname(target.path)),
      ...sortedRecordless.map(chainDirForRecordless),
    ])].sort();

    const closed = withAllControlWriteLocks(dirs, () => {
      const planned = [];
      for (const target of sortedTargets) {
        let currentContent;
        try {
          currentContent = fs.readFileSync(target.path, "utf8");
        } catch {
          skipped.push({ path: target.path, reason: "changed since scan" });
          continue;
        }
        if (!isUnadjudicatedRecord(currentContent) || hasHistoricalMark(currentContent)) {
          skipped.push({ path: target.path, reason: "changed since scan" });
          continue;
        }
        let realPath;
        let stat;
        let newContent;
        try {
          realPath = fs.realpathSync(target.path);
          stat = fs.statSync(realPath);
          newContent = insertHistoricalMark(currentContent, before);
        } catch {
          skipped.push({ path: target.path, reason: "changed since scan" });
          continue;
        }
        const temporaryPath = path.join(
          path.dirname(realPath),
          `.${path.basename(realPath)}.${process.pid}.${randomUUID()}.tmp`,
        );
        planned.push({
          targetPath: target.path,
          realPath,
          mode: stat.mode,
          originalContent: currentContent,
          newContent,
          temporaryPath,
          writtenTemp: false,
          renamed: false,
        });
      }

      try {
        for (const item of planned) {
          fs.writeFileSync(item.temporaryPath, item.newContent, { flag: "wx", mode: item.mode });
          fs.chmodSync(item.temporaryPath, item.mode);
          item.writtenTemp = true;
        }
        for (const item of planned) {
          fs.renameSync(item.temporaryPath, item.realPath);
          item.renamed = true;
        }
      } catch (error) {
        for (const item of planned) {
          if (item.writtenTemp && !item.renamed) {
            try { fs.unlinkSync(item.temporaryPath); } catch { /* best-effort cleanup */ }
          }
        }
        for (const item of planned) {
          if (item.renamed) {
            try {
              fs.writeFileSync(item.realPath, item.originalContent, { mode: item.mode });
              fs.chmodSync(item.realPath, item.mode);
            } catch { /* best-effort restore */ }
          }
        }
        throw error;
      }

      const confirmedRecordless = [];
      for (const entry of sortedRecordless) {
        const chainDir = chainDirForRecordless(entry);
        const rechecked = evaluateRecordlessChain(chainDir, cutoff);
        if (!rechecked) {
          skipped.push({ path: chainDir, reason: "changed since scan" });
          continue;
        }
        confirmedRecordless.push(rechecked);
      }

      return {
        targets: planned.map(({ targetPath }) => targetPath),
        skipped,
        written: planned.length,
        recordless: confirmedRecordless,
      };
    });

    const ackItems = [];
    const seenSubjects = new Set();
    for (const targetPath of closed.targets) {
      const chainDir = path.dirname(targetPath);
      const stateDir = stateDirForChain(chainDir);
      const chainId = path.basename(chainDir);
      const subject = inboxSubject(stateDir, chainId);
      if (seenSubjects.has(subject)) continue;
      seenSubjects.add(subject);
      ackItems.push({ stateDir, chainId, isRecordless: false });
    }
    for (const entry of closed.recordless) {
      const subject = inboxSubject(entry.stateDir, entry.chainId);
      if (seenSubjects.has(subject)) continue;
      seenSubjects.add(subject);
      ackItems.push({ stateDir: entry.stateDir, chainId: entry.chainId, subject, isRecordless: true });
    }

    // Best-effort, after the control locks are released so a slow or hung
    // kaiba never holds them: the marks are written either way and a failed
    // ack only logs. The chain directory is <stateDir>/chains/<chainId>, so
    // it yields both the chain id and the state directory whose hash prefixes
    // the ack subject.
    const ackResult = acknowledgeChainInbox({
      chains: ackItems.map(({ stateDir, chainId }) => ({ stateDir, chainId })),
      env,
      mcpConfigFile,
      timeoutMs: notifyTimeoutMs,
    });
    // Match results by subject, not by position, so a change in how
    // acknowledgeChainInbox orders or filters its results cannot shift the
    // counts. recordlessAcknowledged counts chains whose ack call succeeded;
    // recordlessEntriesAcknowledged counts the inbox entries kaiba actually
    // acknowledged for them (0 when nothing was open).
    const resultBySubject = new Map();
    if (!ackResult?.skipped && Array.isArray(ackResult?.results)) {
      for (const row of ackResult.results) {
        if (row && typeof row.subject === "string") resultBySubject.set(row.subject, row);
      }
    }
    let recordlessAcknowledged = 0;
    let recordlessEntriesAcknowledged = 0;
    for (const item of ackItems) {
      if (!item.isRecordless) continue;
      const row = resultBySubject.get(item.subject);
      if (!row || row.error || row.skipped || !Number.isInteger(row.acknowledged)) continue;
      recordlessAcknowledged += 1;
      recordlessEntriesAcknowledged += row.acknowledged;
    }
    return { ...closed, recordlessAcknowledged, recordlessEntriesAcknowledged };
  }
  return {
    targets: targets.map(({ path: recordPath }) => recordPath),
    skipped,
    written: 0,
    recordless,
    recordlessAcknowledged: 0,
    recordlessEntriesAcknowledged: 0,
  };
}

function parseArgs(argv) {
  const options = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--historical") options.historical = true;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--before" || arg === "--state-root") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    } else {
      throw new Error(`unknown flag: ${arg}`);
    }
  }
  if (!options.historical) throw new Error(USAGE);
  if (!options.before) throw new Error(`${USAGE}\n--before is required`);
  if (!Number.isFinite(Date.parse(options.before))) throw new Error(`--before must be a parseable date: ${options.before}`);
  validateBefore(options.before);
  return options;
}

export function cmdReviewRecordClose(argv, { env, mcpConfigFile, notifyTimeoutMs } = {}) {
  const options = parseArgs(argv);
  const stateRootDir = options.stateRoot ?? stateRoot();
  const result = closeReviewRecords({
    ...options,
    stateRootDir,
    ...(env !== undefined ? { env } : {}),
    ...(mcpConfigFile !== undefined ? { mcpConfigFile } : {}),
    ...(notifyTimeoutMs !== undefined ? { notifyTimeoutMs } : {}),
  });
  const lines = options.apply
    ? [
        `Wrote ${result.written} historical mark(s).`,
        `Acknowledged ${result.recordlessEntriesAcknowledged} inbox entr${result.recordlessEntriesAcknowledged === 1 ? "y" : "ies"} for ${result.recordlessAcknowledged} record-less chain(s).`,
      ]
    : [`Targets: ${result.targets.length}`, ...result.targets.map((recordPath) => `target: ${recordPath}`)];
  lines.push(`Skipped: ${result.skipped.length}`);
  lines.push(...result.skipped.map(({ path: recordPath, reason }) => `skipped: ${reason}: ${recordPath}`));
  if (!options.apply && result.recordless.length > 0) {
    lines.push(`Record-less chains: ${result.recordless.length}`);
    for (const entry of result.recordless) {
      lines.push(`record-less: ${path.basename(entry.stateDir)}/${entry.chainId} ${entry.status} ${entry.finishedAt}`);
    }
  }
  return lines.join("\n");
}
