// review-record-adjudicate.mjs — fill one findings verdict or the reusable precedent.
// Cell input escapes pipes as \| and refuses newlines for reasons and evidence.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chainStateDirFor, stateRoot } from "./state-paths.mjs";
import { formatAdjudicationRow, parseAdjudicationRow, replaceAdjudicationRow } from "./review-record-table.mjs";
import { withControlWriteLock } from "./chain-control.mjs";

export const USAGE = "Usage: review-record-adjudicate <chainId> --row <n> --verdict accept|reject|open-unverified --reason \"<text>\" [--evidence \"<text>\"] [--force] [--state-root <dir>] OR review-record-adjudicate <chainId> --precedent \"<text>\" [--force] [--state-root <dir>] OR review-record-adjudicate <chainId> --repair-row <n> [--state-root <dir>]";

const FINDINGS_HEADING = "## Findings adjudication (fill at inspection)";
const PRECEDENT_HEADING = "## 判例として (fill at inspection)";
const VERDICTS = new Map([
  ["accept", "採用"],
  ["reject", "棄却"],
  ["open-unverified", "保留（未検証）"],
]);

function parseArgs(argv) {
  const options = { force: false };
  let chainId = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--force") options.force = true;
    else if (["--row", "--verdict", "--reason", "--evidence", "--precedent", "--repair-row", "--state-root"].includes(arg)) {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      if (options[key] !== undefined) throw new Error(`duplicate flag: ${arg}`);
      options[key] = value;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag: ${arg}`);
    } else if (chainId === null) {
      chainId = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  if (!chainId) throw new Error(USAGE);
  if (!/^chain-[a-z0-9]+$/.test(chainId)) throw new Error(`invalid chain id: ${chainId}`);
  const rowMode = options.row !== undefined;
  const precedentMode = options.precedent !== undefined;
  const repairMode = options.repairRow !== undefined;
  if (rowMode && precedentMode) throw new Error("--row and --precedent cannot be used together");
  if (repairMode && (rowMode || precedentMode)) throw new Error("--repair-row cannot be combined with --row or --precedent");
  if (!rowMode && !precedentMode && !repairMode) throw new Error("choose exactly one of --row, --precedent, or --repair-row");
  if (repairMode) {
    if (!/^\d+$/.test(options.repairRow) || Number(options.repairRow) < 1) throw new Error("--repair-row must be a positive integer");
    if (options.verdict !== undefined || options.reason !== undefined || options.evidence !== undefined || options.force) {
      throw new Error("--repair-row cannot be combined with verdict, reason, evidence, or force options");
    }
  } else if (rowMode) {
    if (!/^\d+$/.test(options.row) || Number(options.row) < 1) throw new Error("--row must be a positive integer");
    if (!VERDICTS.has(options.verdict)) throw new Error("--verdict must be accept, reject, or open-unverified");
    if (typeof options.reason !== "string" || options.reason.length === 0) throw new Error("--reason is required");
    if (options.precedent !== undefined) throw new Error("--row and --precedent cannot be used together");
    for (const [name, value] of [["reason", options.reason], ["evidence", options.evidence]]) {
      if (typeof value === "string" && /[\r\n\\]/.test(value)) throw new Error(`--${name} cannot contain newlines or backslashes`);
    }
  } else if (options.verdict !== undefined || options.reason !== undefined || options.evidence !== undefined || options.row !== undefined) {
    throw new Error("--precedent cannot be combined with row verdict options");
  } else {
    if (options.precedent.trim().length === 0) throw new Error("--precedent cannot be empty or whitespace-only");
    if (/^\s*#/m.test(options.precedent)) throw new Error("--precedent cannot contain a line starting with #");
  }
  return { chainId, ...options };
}

function sectionBounds(content, heading) {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) throw new Error(`heading not found: ${heading}`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*#+\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { lines, start, end };
}

function adjudicationRows(lines, start, end) {
  const rows = [];
  for (let index = start + 1; index < end; index += 1) {
    const parsed = parseAdjudicationRow(lines[index]);
    if (!parsed || !/^\d+$/.test(parsed.cells[0])) continue;
    rows.push({ lineIndex: index, cells: parsed.cells });
  }
  return rows;
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

export function adjudicateReviewRecord({ chainId, argv, stateRootDir = stateRoot(), cwd = process.cwd() }) {
  const options = parseArgs([chainId, ...argv]);
  const recordDir = chainStateDirFor(options.chainId, cwd, stateRootDir);
  const recordPath = path.join(recordDir, "review-record.md");
  if (!fs.existsSync(recordPath)) throw new Error(`review record not found for chain ${chainId}`);

  return withControlWriteLock(recordDir, () => {
    const original = fs.readFileSync(recordPath, "utf8");
    const { lines, start, end } = sectionBounds(original, FINDINGS_HEADING);

    if (options.repairRow !== undefined) {
      const rows = adjudicationRows(lines, start, end);
      const row = Number(options.repairRow);
      if (row > rows.length) throw new Error(`row ${row} is outside the adjudication table (1-${rows.length})`);
      const target = rows[row - 1];
      if (target.cells[0] !== String(row)) throw new Error(`row ${row} is not present in the adjudication table`);
      if (target.cells.length >= 5) {
        throw new Error(`row ${row} already has 5 or more cells; no repair needed`);
      }
      const number = target.cells[0];
      const severity = target.cells[1] || "unspecified";
      const finding = target.cells.length >= 3 && target.cells[2] !== "_fill_" ? target.cells[2] : (target.cells[2] || "");
      const verdict = "_fill_";
      const reason = "repaired: padded to 5 cells";
      const beforeLine = lines[target.lineIndex];
      const afterLine = formatAdjudicationRow([number, severity, finding, verdict, reason]);
      lines[target.lineIndex] = afterLine;
      writeAtomically(recordPath, lines.join(original.includes("\r\n") ? "\r\n" : "\n"));
      return ["- " + beforeLine, "+ " + afterLine].join(String.fromCharCode(10));
    }

    if (options.row !== undefined) {
      const rows = adjudicationRows(lines, start, end);
      const row = Number(options.row);
      if (row > rows.length) throw new Error(`row ${row} is outside the adjudication table (1-${rows.length})`);
      const target = rows[row - 1];
      if (target.cells[0] !== String(row)) throw new Error(`row ${row} is not present in the adjudication table`);
      if (target.cells.length < 5) {
        throw new Error(`row ${row} has fewer than 5 cells; it cannot be adjudicated`);
      }
      if (target.cells[3] !== "_fill_" && !options.force) throw new Error(`row ${row} already has a verdict; pass --force to overwrite`);
      let reason = options.reason;
      if (options.evidence !== undefined) reason += `（根拠: ${options.evidence}）`;
      const beforeLine = lines[target.lineIndex];
      const afterLine = replaceAdjudicationRow(beforeLine, VERDICTS.get(options.verdict), reason);
      lines[target.lineIndex] = afterLine;
      writeAtomically(recordPath, lines.join(original.includes("\r\n") ? "\r\n" : "\n"));
      return ["- " + beforeLine, "+ " + afterLine].join(String.fromCharCode(10));
    }

    const { lines: allLines, start: precedentStart, end: precedentEnd } = sectionBounds(original, PRECEDENT_HEADING);
    const contentLines = allLines.slice(precedentStart + 1, precedentEnd);
    const meaningful = contentLines.filter((line) => line.trim() !== "");
    const placeholder = meaningful.length === 1 && meaningful[0].trim() === "_fill: reusable precedent, if any_";
    if (meaningful.length > 0 && !placeholder && !options.force) {
      throw new Error("precedent already has content; pass --force to overwrite");
    }
    const beforeLines = allLines.slice(precedentStart + 1, precedentEnd);
    const afterLines = [...allLines.slice(0, precedentStart + 1), options.precedent, ...allLines.slice(precedentEnd)];
    const output = afterLines.join(original.includes("\r\n") ? "\r\n" : "\n");
    writeAtomically(recordPath, output);
    return ["- " + beforeLines.join(String.fromCharCode(10)), "+ " + options.precedent].join(String.fromCharCode(10));
  });
}

export function cmdReviewRecordAdjudicate(argv, { cwd = process.cwd() } = {}) {
  if (argv.length < 1) throw new Error(USAGE);
  const [chainId, ...args] = argv;
  const stateRootDir = (() => {
    const index = args.indexOf("--state-root");
    return index >= 0 ? args[index + 1] : stateRoot();
  })();
  return adjudicateReviewRecord({ chainId, argv: args, stateRootDir, cwd });
}
