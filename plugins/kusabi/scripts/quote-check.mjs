// quote-check.mjs — Quote candidate extraction and classification for review verification.

/**
 * Extract quote candidate strings from a `Quote: ` line.
 * For the first backtick and each later backtick, extracts the slice between them,
 * trimmed; drops empty strings. Ordered longest first.
 *
 * @param {string} quoteLine
 * @returns {string[]}
 */
export function quoteCandidates(quoteLine) {
  if (typeof quoteLine !== "string") return [];
  const ticks = [];
  for (let i = 0; i < quoteLine.length; i++) {
    if (quoteLine[i] === "`") {
      ticks.push(i);
    }
  }
  if (ticks.length < 2) return [];
  const firstTick = ticks[0];
  const candidates = [];
  for (let i = 1; i < ticks.length; i++) {
    const slice = quoteLine.slice(firstTick + 1, ticks[i]).trim();
    if (slice.length > 0) {
      candidates.push(slice);
    }
  }
  const unique = [];
  for (const c of candidates) {
    if (!unique.includes(c)) {
      unique.push(c);
    }
  }
  unique.sort((a, b) => b.length - a.length);
  return unique;
}

/**
 * Classify a quote against the reviewed file lines.
 *
 * @param {string[]} candidates
 * @param {string[]} fileLines
 * @param {number} lineStart 1-based line number
 * @returns {{ status: "matched" } | { status: "displaced", foundAt: number } | { status: "mismatched" }}
 */
export function classifyQuote(candidates, fileLines, lineStart) {
  if (!Array.isArray(candidates) || candidates.length === 0 || !Array.isArray(fileLines)) {
    return { status: "mismatched" };
  }

  // 1-based lineStart check
  if (Number.isInteger(lineStart) && lineStart >= 1 && lineStart <= fileLines.length) {
    const targetLine = fileLines[lineStart - 1];
    const trimmedTarget = typeof targetLine === "string" ? targetLine.trim() : "";
    if (trimmedTarget.length > 0 && candidates.includes(trimmedTarget)) {
      return { status: "matched" };
    }
  }

  // Check displacement across all lines
  let foundAt = null;
  let minDistance = Infinity;
  for (let L = 1; L <= fileLines.length; L++) {
    const lineContent = fileLines[L - 1];
    const trimmed = typeof lineContent === "string" ? lineContent.trim() : "";
    if (trimmed.length === 0) continue; // A blank file line never matches
    if (candidates.includes(trimmed)) {
      const dist = Math.abs(L - lineStart);
      if (dist < minDistance) {
        minDistance = dist;
        foundAt = L;
      }
    }
  }

  if (foundAt !== null) {
    return { status: "displaced", foundAt };
  }

  return { status: "mismatched" };
}
