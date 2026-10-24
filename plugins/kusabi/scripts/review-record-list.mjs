// review-record-list.mjs — list review records awaiting adjudication
import fs from "node:fs";
import path from "node:path";
import { stateRoot } from "./state-paths.mjs";
import { isUnadjudicatedRecord } from "./review-record-scan.mjs";
import { unfilledAdjudicationLines } from "./review-record-table.mjs";
import {
  finishedTimestamp,
  hasHistoricalMark,
  listRecords,
  validateBefore,
} from "./review-record-close.mjs";

export const USAGE = "Usage: kusabi-companion review-record-list [--all] [--before <ISO>] [--state-root <dir>]";

function extractFinishedDate(content) {
  if (finishedTimestamp(content) === null) return "-";
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/\bfinished:\s*(\S+)/i);
    if (!match) continue;
    return match[1];
  }
  return "-";
}

function recordStatus(content) {
  if (hasHistoricalMark(content)) return "historical";
  if (isUnadjudicatedRecord(content)) return "unadjudicated";
  return "adjudicated";
}

export function listReviewRecords({ before, all = false, stateRootDir = stateRoot(), raw = false } = {}) {
  if (before !== undefined) {
    validateBefore(before);
  }
  const cutoff = before !== undefined ? Date.parse(before) : null;

  const records = [];
  for (const recordPath of listRecords(stateRootDir)) {
    let content;
    try {
      content = fs.readFileSync(recordPath, "utf8");
    } catch {
      continue;
    }

    const status = recordStatus(content);
    if (!all && status !== "unadjudicated") {
      continue;
    }

    const finished = finishedTimestamp(content);
    if (before !== undefined) {
      if (finished === null || finished >= cutoff) {
        continue;
      }
    }

    const unfilled = unfilledAdjudicationLines(content).unfilled.length;
    const created = extractFinishedDate(content);
    const chainId = path.basename(path.dirname(recordPath));

    records.push({
      status,
      chainId,
      created,
      unfilled,
      path: recordPath,
    });
  }

  records.sort((a, b) => a.path.localeCompare(b.path));

  if (raw) {
    return records;
  }

  if (records.length === 0) {
    return all ? "No review records." : "No unadjudicated review records.";
  }

  return records
    .map((record) => {
      if (all) {
        return `${record.status}\t${record.chainId}\t${record.created}\t${record.unfilled}\t${record.path}`;
      }
      return `${record.chainId}\t${record.created}\t${record.unfilled}\t${record.path}`;
    })
    .join("\n");
}

function parseArgs(argv) {
  const options = { all: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--all") {
      options.all = true;
    } else if (arg === "--before" || arg === "--state-root") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    } else {
      throw new Error(`unknown flag: ${arg}`);
    }
  }
  if (options.before !== undefined) {
    validateBefore(options.before);
  }
  return options;
}

export function cmdReviewRecordList(argv) {
  const options = parseArgs(argv);
  const stateRootDir = options.stateRoot ?? stateRoot();
  return listReviewRecords({ ...options, stateRootDir });
}
