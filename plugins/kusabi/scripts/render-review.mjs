// Review response parsing and display.

export function extractJson(text) {
  // Path 1: the whole text is the JSON.
  try {
    return JSON.parse(text);
  } catch {
    // Path 2: content of a properly closed fenced code block
    // (``` or ```json), with or without surrounding prose.
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        // fall through to the recovery paths below
      }
    }
  }

  // Path 3a: unclosed fence — the model opened a ```json fence and never
  // closed it (kusabi #170 round-2 shape).  Parse the text after the last
  // unclosed opener, tolerating trailing non-JSON lines (e.g. a VERDICT:).
  const afterOpener = textAfterUnclosedFence(text);
  if (afterOpener !== null) {
    const parsed = jsonParseToleratingTrailingLines(afterOpener);
    if (isReviewShaped(parsed)) return parsed;
  }

  // Path 3b: bare JSON embedded in prose with no fence at all (kusabi #170
  // round-1 shape) — the substring from the first { to the last }.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      return isReviewShaped(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

const REVIEW_VERDICTS = ["approve", "approve-partial", "needs-attention", "discard"];

/**
 * Guard for the recovery paths (3a/3b): unlike paths 1 and 2, recovery scans
 * arbitrary prose, so any quoted JSON — a probe result, an example object —
 * would otherwise be returned as "the review" and override a correctly
 * recovered VERDICT token (and suppress the #147 unparseable retry).  Only an
 * object carrying a schema-valid verdict is accepted as a recovered review.
 */
function isReviewShaped(parsed) {
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    && REVIEW_VERDICTS.includes(parsed.verdict);
}

/**
 * Locate the text after the last fence opener (``` or ```json) that is not
 * closed by a later ```.  Returns null when the text has no unclosed opener
 * (a properly closed fence is handled by path 2 above).
 */
function textAfterUnclosedFence(text) {
  const openers = [];
  const openerRe = /```(?:json)?/g;
  let m;
  while ((m = openerRe.exec(text)) !== null) openers.push(m);
  for (let i = openers.length - 1; i >= 0; i--) {
    const rest = text.slice(openers[i].index + openers[i][0].length);
    if (!rest.includes("```")) return rest;
  }
  return null;
}

/**
 * JSON.parse a candidate while tolerating trailing non-JSON lines — e.g. a
 * "VERDICT: …" token on its own line after the JSON (kusabi #107: the token
 * can survive the caller's stripping, so recovery must not depend on the
 * strip having worked).  Trailing lines are dropped one at a time until the
 * remainder parses.
 */
function jsonParseToleratingTrailingLines(candidate) {
  const lines = candidate.trim().split("\n");
  for (let i = lines.length; i > 0; i--) {
    const attempt = lines.slice(0, i).join("\n").trim();
    if (attempt === "") return null;
    try {
      return JSON.parse(attempt);
    } catch {
      // drop the next trailing line and retry
    }
  }
  return null;
}

/**
 * Attempt to recover a verdict from the raw review text by finding a
 * VERDICT: token anywhere in the text (including inside a JSON fence).
 *
 * Returns null when no token is found.
 * Exported for sharing between the chain's parsing path and renderReview.
 *
 * @param {string} rawText
 * @returns {{ verdict: string }|null}
 */
export function recoverVerdictFromText(rawText) {
  // First try: trailing token after a JSON fence (token is on its own line)
  const lines = rawText.split("\n").filter((l) => l.trim() !== "");
  const lastLine = lines.length > 0 ? lines[lines.length - 1].trim() : "";
  let tokenMatch = lastLine.match(/^VERDICT:\s*(approve-partial|approve|needs-attention|discard)\s*$/i);
  if (tokenMatch) {
    return { verdict: tokenMatch[1].toLowerCase() };
  }

  // Second try: token anywhere in the text (inside JSON fence, mid-text, etc.)
  const anyMatch = rawText.match(/VERDICT:\s*(approve-partial|approve|needs-attention|discard)/i);
  if (anyMatch) {
    return { verdict: anyMatch[1].toLowerCase() };
  }

  return null;
}

export function renderReview(parsed, rawText) {
  if (!parsed) {
    const recovered = recoverVerdictFromText(rawText);
    if (recovered) {
      return `**Verdict: ${recovered.verdict}** (recovered from terminal token; JSON malformed)\n\n${rawText}`;
    }
    return `(review output was not valid JSON; raw output below)\n\n${rawText}`;
  }
  const lines = [`**Verdict: ${parsed.verdict}**`, "", parsed.summary, ""];
  // Malformed-review guard (kusabi #153): a model that responds to a broken
  // review input can emit `findings` as a string or object instead of an
  // array.  Normalise to an array and say so — never surface an internal
  // "findings.forEach is not a function" TypeError to the user.
  const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
  if (parsed.findings !== undefined && parsed.findings !== null && !Array.isArray(parsed.findings)) {
    lines.push(`> malformed review: "findings" was not an array (${typeof parsed.findings}); treated as none.`);
    lines.push("");
  }
  if (findings.length === 0) {
    lines.push("No material findings.");
  }
  findings.forEach((f, i) => {
    lines.push(
      `### ${i + 1}. [${f.severity}] ${f.title}`,
      `- ${f.file}:${f.line_start}-${f.line_end} (confidence ${f.confidence})`,
      "",
      f.body,
      "",
      `**Recommendation:** ${f.recommendation}`,
      "",
    );
  });
  const next = Array.isArray(parsed.next_steps) ? parsed.next_steps : [];
  if (next.length) {
    lines.push("**Next steps:**");
    next.forEach((s) => lines.push(`- ${s}`));
  }
  const unverified = Array.isArray(parsed.unverified) ? parsed.unverified : [];
  if (unverified.length) {
    lines.push("", "**Unverified:**");
    unverified.forEach((s) => lines.push(`- ${s}`));
  }
  return lines.join("\n");
}

