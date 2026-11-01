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
 * A line is low-information when it carries fewer than four Unicode letters or
 * digits. Generic fragments such as `}`, `});`, `);` or `end` occur almost
 * anywhere in a file, so finding one elsewhere proves nothing about whether the
 * reviewer's quote came from the cited line. Counting with `/[\p{L}\p{N}]/gu`
 * keeps the rule script-agnostic instead of assuming ASCII.
 *
 * @param {string} text  already trimmed line or candidate
 * @returns {boolean}
 */
function isLowInformation(text) {
  const count = (text.match(/[\p{L}\p{N}]/gu) || []).length;
  return count < 4;
}

/**
 * Classify a quote against the reviewed file lines.
 *
 * A quote is `matched` only when a candidate equals the trimmed line at
 * `lineStart`. Displacement is looked for over informative lines only: a
 * low-information line can never make a quote `displaced`, and the scan
 * continues past such lines so a nearby generic fragment cannot hide a farther
 * informative match. Low-information quotes are still allowed to match at
 * `lineStart` itself, where the quote is a full-line quote of the cited line.
 *
 * @param {string[]} candidates
 * @param {string[]} fileLines
 * @param {number} lineStart 1-based line number
 * @returns {{ status: "matched" } | { status: "displaced", foundAt: number, distance: number } | { status: "mismatched" }}
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

  // Check displacement across all informative lines. Low-information lines are
  // skipped rather than treated as a match, so the search continues past them.
  let foundAt = null;
  let minDistance = Infinity;
  for (let L = 1; L <= fileLines.length; L++) {
    const lineContent = fileLines[L - 1];
    const trimmed = typeof lineContent === "string" ? lineContent.trim() : "";
    if (trimmed.length === 0) continue; // A blank file line never matches
    if (isLowInformation(trimmed)) continue; // A generic line proves nothing elsewhere
    if (candidates.includes(trimmed)) {
      const dist = Math.abs(L - lineStart);
      if (dist < minDistance) {
        minDistance = dist;
        foundAt = L;
      }
    }
  }

  if (foundAt !== null) {
    return { status: "displaced", foundAt, distance: minDistance };
  }

  return { status: "mismatched" };
}
