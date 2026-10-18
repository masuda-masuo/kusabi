// Shared parsing and formatting for review-record adjudication rows.
export function parseAdjudicationRow(line) {
  if (typeof line !== "string") return null;
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;

  const inner = trimmed.slice(1, -1);
  const separators = pipePositions(inner);
  const rawFields = [];
  let start = 0;
  for (const position of separators) {
    rawFields.push(inner.slice(start, position));
    start = position + 1;
  }
  rawFields.push(inner.slice(start));
  const fields = rawFields.map((cell) => cell.trim());
  if (fields.length < 5) return { cells: fields };

  const decodeCell = (value) => value.replace(/\\\|/g, "|").replace(/\\\\/g, "\\");
  const finding = decodeCell(rawFields.slice(2, -2).join("|").trim());
  const reason = decodeCell(fields.at(-1));
  return {
    cells: [fields[0], fields[1], finding, fields.at(-2), reason],
  };
}

export function escapedCell(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

export function formatAdjudicationRow(parts) {
  const cells = Array.isArray(parts) ? parts : parts?.cells;
  if (!Array.isArray(cells) || cells.length !== 5) {
    throw new TypeError("formatAdjudicationRow requires five adjudication cells");
  }
  const [number, severity, finding, verdict, reason] = cells;
  return `| ${number} | ${severity} | ${escapedCell(finding)} | ${verdict} | ${escapedCell(reason)} |`;
}

function pipePositions(line) {
  const positions = [];
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== "|") continue;
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor -= 1) slashes += 1;
    if (slashes % 2 === 0) positions.push(index);
  }
  return positions;
}

function replaceCellContents(line, leftPipe, rightPipe, value) {
  const cell = line.slice(leftPipe + 1, rightPipe);
  const leading = cell.match(/^\s*/)[0];
  const trailing = cell.match(/\s*$/)[0];
  return leading + escapedCell(value) + trailing;
}

// Replace only the verdict and reason cell contents, preserving the finding
// bytes verbatim even when it contains unescaped table separators.
export function replaceAdjudicationRow(line, verdict, reason) {
  if (typeof line !== "string") throw new TypeError("replaceAdjudicationRow requires a table row");
  const pipes = pipePositions(line);
  if (pipes.length < 6) throw new Error("adjudication row has fewer than 5 cells");
  const verdictLeft = pipes.at(-3);
  const reasonLeft = pipes.at(-2);
  const rowEnd = pipes.at(-1);
  const verdictCell = replaceCellContents(line, verdictLeft, reasonLeft, verdict);
  const reasonCell = replaceCellContents(line, reasonLeft, rowEnd, reason);
  return line.slice(0, verdictLeft + 1) + verdictCell + line.slice(reasonLeft, reasonLeft + 1) + reasonCell + line.slice(rowEnd);
}
const HISTORICAL_MARK_PATTERN = /^<!-- historical: not adjudicated; closed by review-record-close before .+ -->$/;

export function unfilledAdjudicationLines(content) {
  if (typeof content !== "string") throw new TypeError("unfilledAdjudicationLines requires record content");

  const lines = content.split(/\r?\n/);
  const unfilled = [];
  let sectionFound = false;
  let inFindingsSection = false;
  let historical = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*#+\s+/.test(line)) {
      if (/^\s*##\s+Findings adjudication\b/i.test(line)) {
        sectionFound = true;
        inFindingsSection = true;
        historical = false;
        continue;
      }
      if (inFindingsSection) inFindingsSection = false;
    }

    if (!inFindingsSection) continue;
    if (HISTORICAL_MARK_PATTERN.test(line)) {
      historical = true;
      continue;
    }
    if (historical) continue;
    const parsedRow = parseAdjudicationRow(line);
    const isCompleteTableRow = parsedRow?.cells?.length >= 5;
    const hasUnfilledCell = isCompleteTableRow
      ? parsedRow.cells.slice(-2).some((cell) => cell.includes("_fill_"))
      : line.includes("_fill_");
    if (!hasUnfilledCell) continue;

    const numberedRow = line.match(/^\s*\|?\s*(\d+)\b/);
    unfilled.push({
      line: index + 1,
      row: numberedRow ? numberedRow[1] : String(index + 1),
    });
  }

  return { sectionFound, unfilled };
}
