// review-record-scan.mjs — Scan state directory for unadjudicated review records
import fs from "node:fs";
import path from "node:path";
import { stateRoot } from "./state-paths.mjs";

const UNADJUDICATED_ROW_PATTERN = /\|\s*_fill_\s*\|\s*_fill_\s*\|/;
const FINDINGS_SECTION_HEADER_PATTERN = /^\s*##\s+Findings adjudication\b/i;
const ANY_HEADER_PATTERN = /^\s*#+\s+/;

/**
 * Check if a review record's content has an unadjudicated table row
 * inside its findings adjudication section.
 *
 * @param {string} content
 * @returns {boolean}
 */
export function isUnadjudicatedRecord(content) {
  if (!content || typeof content !== "string") return false;

  const lines = content.split(/\r?\n/);
  let inFindingsSection = false;

  for (const line of lines) {
    if (ANY_HEADER_PATTERN.test(line)) {
      if (FINDINGS_SECTION_HEADER_PATTERN.test(line)) {
        inFindingsSection = true;
        continue;
      } else if (inFindingsSection) {
        inFindingsSection = false;
      }
    }

    if (inFindingsSection) {
      const trimmed = line.trim();
      if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
        if (UNADJUDICATED_ROW_PATTERN.test(trimmed)) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Scan review records under the state root and count those that had findings
 * and still carry the unadjudicated placeholder (`| _fill_ | _fill_ |`).
 *
 * Records whose chain produced no findings are not counted.
 * Records that cannot be read are not counted.
 * Missing/unreadable directories degrade silently to 0 (no exceptions thrown).
 *
 * @param {string} [stateRootDir] - optional override for state root directory
 * @returns {number} Count of unfilled review records
 */
export function countUnfilledReviewRecords(stateRootDir) {
  let root = stateRootDir;
  if (!root) {
    try {
      root = stateRoot();
    } catch {
      return 0;
    }
  }
  if (!root || typeof root !== "string") return 0;

  let count = 0;
  try {
    if (!fs.existsSync(root)) return 0;
    const wsEntries = fs.readdirSync(root, { withFileTypes: true });
    for (const wsEntry of wsEntries) {
      if (!wsEntry.isDirectory()) continue;
      const chainsDir = path.join(root, wsEntry.name, "chains");
      try {
        if (!fs.existsSync(chainsDir)) continue;
        const chainEntries = fs.readdirSync(chainsDir, { withFileTypes: true });
        for (const chainEntry of chainEntries) {
          if (!chainEntry.isDirectory()) continue;
          const recordPath = path.join(chainsDir, chainEntry.name, "review-record.md");
          try {
            if (!fs.existsSync(recordPath)) continue;
            const content = fs.readFileSync(recordPath, "utf8");
            if (isUnadjudicatedRecord(content)) {
              count++;
            }
          } catch {
            // Unreadable individual file: ignore (do not count)
          }
        }
      } catch {
        // Unreadable chains dir: ignore
      }
    }
  } catch {
    // Unreadable state root or filesystem error: return 0
    return 0;
  }
  return count;
}
