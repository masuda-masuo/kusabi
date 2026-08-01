// Brief parsing — pure functions for extracting structured data from
// orchestration brief text.  No I/O, no imports from kusabi-companion.mjs.

// ---------------------------------------------------------------------------
// parseSectionItems — shared section-item walker used by both
// parseDeliverables and parseSmoke.  Exported only for internal module use.
// ---------------------------------------------------------------------------

/**
 * Parse an optional named `## ` section from a brief text, returning every
 * recognised item line together with a heading-found flag.
 *
 * Item recognition (shared):
 *  - Unordered bullet: `-`, `*`, `+`  (leading indentation ignored)
 *  - Ordered item: `1.`, `1)`, any number (leading indentation ignored)
 *  - Lines inside a fenced code block (`` ``` `` … `` ``` ``) within the
 *    section — one item per non-blank line, `source: "code-block"`.
 *
 * A `## ` heading ends the section.  Blank and prose lines are skipped.
 *
 * @param {string|null|undefined} briefText  The full brief text.
 * @param {string}                headingName  e.g. "Deliverables" or "Smoke".
 * @returns {{ items: Array<{content: string, source: "bullet"|"code-block"}>,
 *             headingFound: boolean }}
 */
function parseSectionItems(briefText, headingName) {
  if (!briefText || typeof briefText !== "string") return { items: [], headingFound: false };

  const lines = briefText.split("\n");
  let inSection = false;
  let headingFound = false;
  let inCodeBlock = false;
  const items = [];

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const trimmed = line.trim();

    // Code-block fences are tracked across the whole document, before the
    // heading check, so a `## ` line inside a fence neither opens a section
    // nor terminates the one being collected.
    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    // Section boundary: ## heading
    if (!inCodeBlock && trimmed.startsWith("## ")) {
      const heading = trimmed.slice(3).trim();
      if (heading === headingName) {
        inSection = true;
        headingFound = true;
        continue;
      }
      if (inSection) break; // next heading ends the section
      continue;
    }

    if (!inSection) continue;

    // Inside a code block: every non-blank line is an item.  Stored trimmed:
    // consumers take the first whitespace-delimited token, so a raw indented
    // line would yield an empty token and be dropped silently.
    if (inCodeBlock) {
      if (trimmed !== "") {
        items.push({ content: trimmed, source: "code-block" });
      }
      continue;
    }

    // Unordered bullet: -, *, +
    let bulletMatch = trimmed.match(/^[-*+]\s+(.*)/);
    if (bulletMatch) {
      const content = bulletMatch[1].trim();
      if (content) items.push({ content, source: "bullet" });
      continue;
    }

    // Ordered item: 1., 1), any number
    bulletMatch = trimmed.match(/^\d+[.)]\s+(.*)/);
    if (bulletMatch) {
      const content = bulletMatch[1].trim();
      if (content) items.push({ content, source: "bullet" });
      continue;
    }

    // Non-item lines are ignored
  }

  return { items, headingFound };
}

/**
 * Check whether a brief text contains a `## headingName` section at all
 * (whether or not any entries are parseable from it).
 *
 * @param {string|null|undefined} briefText
 * @param {string}                headingName
 * @returns {boolean}
 */
export function hasSectionHeading(briefText, headingName) {
  const { headingFound } = parseSectionItems(briefText, headingName);
  return headingFound;
}

// ---------------------------------------------------------------------------
// parseDeliverables — pure function parsing ## Deliverables section from a
// brief text.
// ---------------------------------------------------------------------------

/**
 * Parse an optional `## Deliverables` section from a brief text.
 *
 * Uses the shared section walker (parseSectionItems).  From each item,
 * extract the file path: the first backtick-quoted token if present, else
 * the first whitespace-delimited token.  Strip trailing punctuation AND
 * trailing slashes (fixes #79).
 *
 * @param {string|null|undefined} briefText  The full brief text.
 * @returns {string[]}  Repo-relative path strings; [] when section absent or empty.
 *                      Never throws.
 */
export function parseDeliverables(briefText) {
  const { items } = parseSectionItems(briefText, "Deliverables");
  const deliverables = [];
  for (const item of items) {
    const content = item.content;
    // First backtick-quoted token, else first whitespace-delimited token
    let path = null;
    const backtickMatch = content.match(/`([^`]+)`/);
    if (backtickMatch) {
      path = backtickMatch[1];
    } else {
      const tokens = content.split(/\s+/);
      path = tokens[0];
    }
    if (!path) continue;

    // Strip trailing punctuation, then trailing slashes (fixes #79)
    path = path.replace(/[,;.:!?]+$/, "").replace(/\/+$/, "").trim();
    if (path) deliverables.push(path);
  }
  return deliverables;
}

// ---------------------------------------------------------------------------
// parseChangedPaths — pure function parsing git status --porcelain output
// into a list of changed paths.
// ---------------------------------------------------------------------------

/**
 * Parse paths from `git status --porcelain` output.
 * For rename entries both old and new paths are returned.
 *
 * @param {string} output  Raw stdout from `git status --porcelain`.
 * @returns {string[]}  Array of changed path strings.
 */
export function parseChangedPaths(output) {
  if (!output || typeof output !== "string") return [];
  const paths = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // Skip the first 3 characters (XY status chars + space), rest is the path.
    const rest = line.length > 3 ? line.substring(3).trim() : "";
    if (!rest) continue;
    // Handle rename: "oldpath -> newpath"
    const arrowIdx = rest.indexOf(" -> ");
    if (arrowIdx >= 0) {
      const oldPath = rest.substring(0, arrowIdx).trim().replace(/\/+$/, "");
      const newPath = rest.substring(arrowIdx + 4).trim().replace(/\/+$/, "");
      if (oldPath) paths.push(oldPath);
      if (newPath) paths.push(newPath);
    } else {
      // Untracked directories appear as "dir/"; strip the trailing slash so
      // prefix matching against declared deliverables works.
      const cleaned = rest.replace(/\/+$/, "");
      if (cleaned) paths.push(cleaned);
    }
  }
  return paths;
}

// ---------------------------------------------------------------------------
// parseSmoke — pure function parsing ## Smoke section from a brief text.
// ---------------------------------------------------------------------------

/**
 * Parse an optional `## Smoke` section from a brief text.
 *
 * Uses the shared section walker (parseSectionItems).  For bullet items a
 * backtick-quoted command is REQUIRED (bullets without backticks are
 * ignored); an optional `exit <N>` annotation after the closing backtick
 * declares the expected exit code (default 0).  For code-block items each
 * non-blank line becomes a command with exit 0 (no annotation possible).
 *
 * @param {string|null|undefined} briefText  The full brief text.
 * @returns {Array<{command: string, expectedExit: number}>}
 *   Parsed smoke entries; [] when absent/empty.  Never throws.
 */
export function parseSmoke(briefText) {
  const { items } = parseSectionItems(briefText, "Smoke");
  const entries = [];
  for (const item of items) {
    const content = item.content;
    if (item.source === "code-block") {
      // Code block: the line itself is the command, exit 0
      const cmd = content.trim();
      if (cmd) entries.push({ command: cmd, expectedExit: 0 });
      continue;
    }

    // Bullet: first backtick-quoted token is REQUIRED; skip without
    const backtickMatch = content.match(/`([^`]+)`/);
    if (!backtickMatch) continue;
    const command = backtickMatch[1];

    // Optional expected exit code — search only after the closing backtick so
    // an "exit N" inside the command itself cannot be misread as the annotation.
    let expectedExit = 0;
    const afterCommand = content.slice(content.indexOf(backtickMatch[0]) + backtickMatch[0].length);
    const exitMatch = afterCommand.match(/exit\s+(\d+)/);
    if (exitMatch) {
      expectedExit = parseInt(exitMatch[1], 10);
    }

    if (command) {
      entries.push({ command, expectedExit });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// briefRequestsPublish — detect a brief that asks the worker to publish
// ---------------------------------------------------------------------------

// Requirement keywords that make a "publish" mention read as a demand rather
// than as background explanation.  Deliberately simple and over-eager: the
// cost of a false positive is one warning line; the cost of a false negative
// is the orchestrator misreading "the worker skipped publish" (kusabi #153).
const PUBLISH_DEMAND_KEYWORDS = /\b(must|mandatory|required|essential)\b|(?:必須|必要)/i;

/**
 * Heuristic: does this brief appear to demand that the worker publish?
 *
 * True when (per line):
 *  - a markdown heading (## ...) mentions "publish", or
 *  - "publish" and a demand keyword (must / mandatory / required / 必須…)
 *    appear on the same line.
 *
 * Over-detection is acceptable — the caller only emits a single warning line
 * and never changes behaviour.  "publish is orchestrator-exclusive" style
 * explanatory sentences do NOT match (no demand keyword on the line).
 *
 * @param {string|null|undefined} briefText
 * @returns {boolean}
 */
export function briefRequestsPublish(briefText) {
  if (!briefText || typeof briefText !== "string") return false;
  for (const line of briefText.split("\n")) {
    const trimmed = line.trim();
    if (!/\bpublish\b/i.test(trimmed)) continue;
    if (/^#{1,6}\s+/.test(trimmed)) return true;
    if (PUBLISH_DEMAND_KEYWORDS.test(trimmed)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// parseOrchestratorSignature
// ---------------------------------------------------------------------------

/**
 * Parse an optional orchestrator signature line from a brief text.
 * Scans the first 5 lines for a line starting with "Orchestrator:"
 * and extracts model, session, and date fields.
 *
 * @param {string} briefText  - The full brief text.
 * @returns {{ model: string|null, session: string|null, date: string|null } | null}
 *   Parsed fields (null for missing parts) or null when no signature exists.
 *   Never throws on malformed input.
 */
export function parseOrchestratorSignature(briefText) {
  if (!briefText || typeof briefText !== "string") return null;
  const lines = briefText.split("\n");
  const maxLines = Math.min(lines.length, 5);
  for (let i = 0; i < maxLines; i++) {
    const line = lines[i];
    if (typeof line !== "string") continue;
    const trimmed = line.trim();
    if (trimmed.startsWith("Orchestrator:")) {
      const remainder = trimmed.slice("Orchestrator:".length).trim();
      // Split on |, trim each part
      const parts = remainder.split("|").map((s) => s.trim());
      const model = parts[0] || null;
      let session = parts[1] || null;
      // Strip optional "session " prefix
      if (session && session.startsWith("session ")) {
        session = session.slice("session ".length).trim();
        if (session === "") session = null;
      }
      const date = parts[2] || null;
      return { model, session, date };
    }
  }
  return null;
}
