// review-record-close.mjs — mark old unfilled review records as historical
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { stateRoot } from "./state-paths.mjs";
import { isUnadjudicatedRecord } from "./review-record-scan.mjs";

export const FINDINGS_HEADER = "## Findings adjudication (fill at inspection)";
const FINDINGS_HEADER_PATTERN = /^[ \t]*## Findings adjudication \(fill at inspection\)[ \t]*(\r?\n|$)/m;
export const HISTORICAL_MARK_PREFIX = "<!-- historical: not adjudicated; closed by review-record-close before ";
export const USAGE = "Usage: kusabi-companion review-record-close --historical --before <ISO> [--apply] [--state-root <dir>]";

function finishedTimestamp(content) {
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

function hasHistoricalMark(content) {
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

function listRecords(root) {
  const records = [];
  let workspaces;
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return records;
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
      const recordPath = path.join(chainsDir, chain.name, "review-record.md");
      try {
        if (fs.statSync(recordPath).isFile()) records.push(recordPath);
      } catch {
        // Missing or unreadable record: it cannot be a target.
      }
    }
  }
  return records.sort();
}

export function scanReviewRecords({ before, stateRootDir = stateRoot() }) {
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

function insertHistoricalMark(content, before) {
  const header = content.match(/^[ \t]*## Findings adjudication \(fill at inspection\)[ \t]*(\r?\n|$)/m);
  if (!header) throw new Error(`Findings adjudication heading not found`);
  const insertionIndex = header.index + header[0].length;
  const newline = header[1] || (content.includes("\r\n") ? "\r\n" : "\n");
  const mark = `${HISTORICAL_MARK_PREFIX}${before} -->`;
  const prefix = header[1] ? mark + newline : newline + mark;
  return content.slice(0, insertionIndex) + prefix + content.slice(insertionIndex);
}

function writeAtomically(filePath, content) {
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporaryPath, content, { flag: "wx" });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

export function closeReviewRecords({ before, stateRootDir = stateRoot(), apply = false }) {
  const { targets, skipped } = scanReviewRecords({ before, stateRootDir });
  if (apply) {
    for (const target of targets) {
      writeAtomically(target.path, insertHistoricalMark(target.content, before));
    }
  }
  return { targets: targets.map(({ path: recordPath }) => recordPath), skipped, written: apply ? targets.length : 0 };
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
  return options;
}

export function cmdReviewRecordClose(argv) {
  const options = parseArgs(argv);
  const stateRootDir = options.stateRoot ?? stateRoot();
  const result = closeReviewRecords({ ...options, stateRootDir });
  const lines = options.apply
    ? [`Wrote ${result.written} historical mark(s).`]
    : [`Targets: ${result.targets.length}`, ...result.targets.map((recordPath) => `target: ${recordPath}`)];
  lines.push(`Skipped: ${result.skipped.length}`);
  lines.push(...result.skipped.map(({ path: recordPath, reason }) => `skipped: ${reason}: ${recordPath}`));
  return lines.join("\n");
}
