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
 * Heading match is a word-boundary prefix match (kusabi #167): a `## `
 * heading opens the named section when its text equals headingName, or
 * starts with headingName and the character right after is not alphanumeric
 * or underscore.  Annotations such as `## Deliverables (…)` are therefore
 * recognised, while `## Deliverables2` / `## Smoketest` are not.  Matching
 * is case-sensitive.
 *
 * Every item also carries the source line it came from (`raw`, exactly as
 * written, and 1-indexed `lineNumber`) so a caller can quote the brief back
 * at its author.  Consumers that only want the content ignore these.
 *
 * @param {string|null|undefined} briefText  The full brief text.
 * @param {string}                headingName  e.g. "Deliverables" or "Smoke".
 * @returns {{ items: Array<{content: string, source: "bullet"|"code-block",
 *                           raw: string, lineNumber: number}>,
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
      // Word-boundary prefix match (kusabi #167): the heading matches when it
      // equals headingName, or starts with it and the character immediately
      // after is not alphanumeric or underscore — so trailing annotations
      // like "## Deliverables (…)" are recognised while look-alike headings
      // like "## Deliverables2" or "## Smoketest" are not.  Case-sensitive.
      const isHeading =
        heading === headingName ||
        (heading.startsWith(headingName) && !/[A-Za-z0-9_]/.test(heading[headingName.length]));
      if (isHeading) {
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
        items.push({ content: trimmed, source: "code-block", raw: line, lineNumber: li + 1 });
      }
      continue;
    }

    // Unordered bullet: -, *, +
    let bulletMatch = trimmed.match(/^[-*+]\s+(.*)/);
    if (bulletMatch) {
      const content = bulletMatch[1].trim();
      if (content) items.push({ content, source: "bullet", raw: line, lineNumber: li + 1 });
      continue;
    }

    // Ordered item: 1., 1), any number
    bulletMatch = trimmed.match(/^\d+[.)]\s+(.*)/);
    if (bulletMatch) {
      const content = bulletMatch[1].trim();
      if (content) items.push({ content, source: "bullet", raw: line, lineNumber: li + 1 });
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
// parsePathSection — shared path-item extractor behind parseDeliverables and
// parseFrozenTests.
// ---------------------------------------------------------------------------

/**
 * Parse a `## ` section whose items are repo-relative paths.
 *
 * Uses the shared section walker (parseSectionItems), so heading recognition
 * is identical for every path section: word-boundary prefix match,
 * case-sensitive (kusabi #167).  From each item, extract the file path: the
 * first backtick-quoted token if present, else the first whitespace-delimited
 * token.  Strip trailing punctuation AND trailing slashes (fixes #79).
 *
 * @param {string|null|undefined} briefText   The full brief text.
 * @param {string}                headingName e.g. "Deliverables".
 * @returns {string[]}  Repo-relative path strings; [] when section absent or empty.
 *                      Never throws.
 */
function parsePathSection(briefText, headingName) {
  const { items } = parseSectionItems(briefText, headingName);
  const paths = [];
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
    if (path) paths.push(path);
  }
  return paths;
}

// ---------------------------------------------------------------------------
// parseDeliverables — pure function parsing ## Deliverables section from a
// brief text.
// ---------------------------------------------------------------------------

/**
 * Parse an optional `## Deliverables` section from a brief text.
 *
 * @param {string|null|undefined} briefText  The full brief text.
 * @returns {string[]}  Repo-relative path strings; [] when section absent or empty.
 *                      Never throws.
 */
export function parseDeliverables(briefText) {
  return parsePathSection(briefText, "Deliverables");
}

// ---------------------------------------------------------------------------
// parseFrozenTests — pure function parsing ## Frozen Tests section from a
// brief text (kusabi #197, the P5 oracle).
// ---------------------------------------------------------------------------

/**
 * Parse an optional `## Frozen Tests` section from a brief text.
 *
 * `Frozen Tests` is the canonical heading spelling (the investigate agent
 * writes it, `plugins/kusabi/opencode-agents/kusabi-investigate.md`).  Item
 * syntax and path extraction are EXACTLY the Deliverables set — both go
 * through parsePathSection — so a brief author has one rule to learn, and
 * the annotated heading `## Frozen Tests (do not touch)` is recognised for
 * the same reason `## Deliverables (files that must change)` is.
 *
 * Each entry is a repo-relative path; an entry naming a directory is matched
 * by prefix at the consumption point (the P5 probe), not here.
 *
 * @param {string|null|undefined} briefText  The full brief text.
 * @returns {string[]}  Repo-relative path strings; [] when section absent or empty.
 *                      Never throws.
 */
export function parseFrozenTests(briefText) {
  return parsePathSection(briefText, "Frozen Tests");
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
 * declares the expected exit code (default 0).  An optional `baseline-red`
 * annotation in the same position declares the entry is expected to fail on
 * the unmodified checkout — the smoke targets a deliverable that does not
 * exist yet (kusabi #315): the dispatch-time baseline treats a measured
 * mismatch on such an entry as the annotation doing its job.  The two
 * annotations are independent and compose in either order.  For code-block
 * items each non-blank line becomes a command with exit 0 (no annotation
 * possible).
 *
 * @param {string|null|undefined} briefText  The full brief text.
 * @returns {Array<{command: string, expectedExit: number, baselineRed?: true}>}
 *   Parsed smoke entries; [] when absent/empty.  `baselineRed` is present
 *   only on entries carrying the annotation (its absence reads as false), so
 *   unannotated entries keep their exact historical shape.  Never throws.
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

    // Optional annotations — searched only after the closing backtick so an
    // "exit N" or "baseline-red" inside the command itself cannot be misread
    // as an annotation.  `exit <N>` (P4's expectation) and `baseline-red`
    // (the dispatch-time baseline's licence, kusabi #315) are independent and
    // compose in either order.  The baseline-red match is word-boundary
    // anchored, like the exit match, so an occurrence glued to another token
    // ("xbaseline-red", "baseline-redx") is not the annotation.
    let expectedExit = 0;
    let baselineRed = false;
    const afterCommand = content.slice(content.indexOf(backtickMatch[0]) + backtickMatch[0].length);
    const exitMatch = afterCommand.match(/exit\s+(\d+)/);
    if (exitMatch) {
      expectedExit = parseInt(exitMatch[1], 10);
    }
    if (/\bbaseline-red\b/.test(afterCommand)) {
      baselineRed = true;
    }

    if (command) {
      // The field is emitted only when set: unannotated entries keep their
      // exact historical shape (callers and deepEqual assertions rely on it).
      entries.push(baselineRed ? { command, expectedExit, baselineRed } : { command, expectedExit });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// findSmokeViolations — smoke entries the machine would read differently from
// what the brief says (kusabi #250)
// ---------------------------------------------------------------------------

/** A bullet whose command was truncated at a nested backtick. */
export const SMOKE_VIOLATION_LOSSY = "lossy-command";
/** A `## Smoke` heading from which parseSmoke extracts nothing. */
export const SMOKE_VIOLATION_NO_ENTRIES = "no-entries";

/**
 * Find `## Smoke` entries whose written form and machine-read form disagree.
 *
 * parseSmoke takes the FIRST backtick pair of a bullet as the command, so a
 * command that itself contains a backtick is silently cut at that backtick
 * and handed on as a legal-looking entry (kusabi #246 ran six rounds on
 * `` ! grep -F 'Check ` `` — an unclosed quote no worker could fix).  The
 * loss is visible here, at parse time, with no I/O.  Two classes:
 *
 *  1. `lossy-command` — a bullet where, after removing the first backtick
 *     pair, what is left still contains a backtick and is not merely an
 *     `exit <N>` annotation.  Fenced code-block entries take the whole line
 *     as the command and therefore cannot lose anything; they are never
 *     flagged.
 *  2. `no-entries` — a `## Smoke` heading (hasSectionHeading semantics) from
 *     which parseSmoke extracts nothing at all, i.e. the declared smoke
 *     check would silently not run.
 *
 * This is purely additive: parseSmoke's accepted grammar is untouched, and a
 * brief with no violations parses exactly as before.
 *
 * @param {string|null|undefined} briefText
 * @returns {Array<{kind: string, line: string|null, lineNumber: number|null,
 *                  command: string|null, lost: string|null}>}
 *   One entry per violation, in brief order; [] when clean.  Never throws.
 */
export function findSmokeViolations(briefText) {
  const violations = [];
  const { items, headingFound } = parseSectionItems(briefText, "Smoke");

  for (const item of items) {
    // Code-block entries take the whole line — nothing can be cut off.
    if (item.source !== "code-block") {
      const backtickMatch = item.content.match(/`([^`]+)`/);
      // No backtick pair at all: parseSmoke skips the bullet outright, which
      // is the documented way to write a non-command bullet.  Not a loss.
      if (backtickMatch) {
        const start = item.content.indexOf(backtickMatch[0]);
        const lost = item.content.slice(0, start) +
          item.content.slice(start + backtickMatch[0].length);
        // A remainder holding a backtick is text the machine dropped; it is
        // non-empty by construction.  The one benign remainder that can
        // carry backticks is a quoted `exit <N>` annotation.
        if (lost.includes("`") && !/^exit\s+\d+$/i.test(lost.replace(/`/g, "").trim())) {
          violations.push({
            kind: SMOKE_VIOLATION_LOSSY,
            line: item.raw,
            lineNumber: item.lineNumber,
            command: backtickMatch[1],
            lost: lost.trim(),
          });
        }
      }
    }
  }

  if (headingFound && parseSmoke(briefText).length === 0) {
    violations.push({
      kind: SMOKE_VIOLATION_NO_ENTRIES,
      line: null,
      lineNumber: null,
      command: null,
      lost: null,
    });
  }

  return violations;
}

// ---------------------------------------------------------------------------
// findFrozenQualifierItems — Frozen Tests bullets whose path is followed by
// leftover prose the frozen oracle cannot enforce (kusabi #386)
// ---------------------------------------------------------------------------

/**
 * Frozen Tests bullets/items whose path token is followed by leftover text.
 *
 * `parsePathSection` (behind `parseFrozenTests`) takes only the path token —
 * first backtick-quoted token, else first whitespace-delimited token, then a
 * trailing-punctuation and trailing-slash strip — and drops everything after
 * it.  So any words the brief author writes AFTER the path (`you may append`,
 * `do not weaken`, a Japanese 但し書き) never reach P5, which freezes by path
 * and would flag a worker that obeys that prose (e.g. appending) as an oracle
 * violation.  The worker cannot win because the probe's input is the brief
 * (henshusha chain-mtaa2btyd78c, 2026-08-27).
 *
 * This helper re-derives the SAME path token `parsePathSection` would take,
 * then inspects whatever remains of the item.  The item qualifies when the
 * remainder — after trimming whitespace and lone punctuation — still holds a
 * non-punctuation character: a keyword list would miss `do not weaken` with no
 * word "append", and Japanese 但し書き, so the rule is purely structural.
 *
 *   - A path-only bullet (`` - `tests/test_style.py` ``) has an empty remainder
 *     → not returned.
 *   - A bullet with prose (`` - `tests/test_style.py` tests that already exist
 *     (you may append; do not weaken) ``) → returned with that remainder.
 *   - A code-block line is the path alone → not returned; a code-block line
 *     with path + extra words → returned (the spec treats the two alike).
 *   - A `## Frozen Tests (do not touch)` HEADING is unaffected — heading
 *     annotations are a different layer (kusabi #167); this walks items, not
 *     the heading line.
 *
 * Purely additive: `parseFrozenTests` is untouched, so P5 still sees only the
 * path array.  Returns `[]` when the `## Frozen Tests` heading is absent.
 *
 * @param {string|null|undefined} briefText
 * @returns {Array<{path: string, remainder: string, line: string,
 *                  lineNumber: number}>}
 *   One entry per qualifying item, in brief order; `[]` when clean. Never throws.
 */
export function findFrozenQualifierItems(briefText) {
  const { items, headingFound } = parseSectionItems(briefText, "Frozen Tests");
  if (!headingFound) return [];

  const qualifiers = [];
  for (const item of items) {
    const content = item.content;
    // Re-derive the path token EXACTLY as parsePathSection does.
    let path = null;
    let remainder = "";
    const backtickMatch = content.match(/`([^`]+)`/);
    if (backtickMatch) {
      path = backtickMatch[1];
      // Everything after the closing backtick is what P5 would drop.
      remainder = content.slice(content.indexOf(backtickMatch[0]) + backtickMatch[0].length);
    } else {
      const tokens = content.split(/\s+/);
      path = tokens[0];
      // Everything after the first whitespace-delimited token.
      remainder = content.slice(content.indexOf(tokens[0]) + tokens[0].length);
    }
    if (!path) continue;

    // Same trailing-punctuation / trailing-slash strip as parsePathSection, so
    // the path this reports is byte-for-byte the one P5 reads.
    path = path.replace(/[,;.:!?]+$/, "").replace(/\/+$/, "").trim();
    if (!path) continue; // the item carries no usable path at all

    const trimmed = remainder.trim();
    if (trimmed === "") continue; // path alone — no contract P5 cannot see
    // Lone punctuation (a trailing "." or "---") is not a contract either;
    // anything left after stripping punctuation+whitespace is prose.
    const hasContent = trimmed.replace(/[\s\p{P}]+/gu, "") !== "";
    if (!hasContent) continue;

    qualifiers.push({ path, remainder: trimmed, line: item.raw, lineNumber: item.lineNumber });
  }
  return qualifiers;
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

// ---------------------------------------------------------------------------
// zero-entry sections — the brief-syntax defect no worker can fix
// (kusabi #302 / #303)
// ---------------------------------------------------------------------------

/**
 * The `## ` sections a probe MACHINE-READS, each paired with the parser that
 * reads it and the probe that fails when the reading comes back empty.
 *
 * One table, because the two consumers must not drift: the dispatch-time
 * lint (`briefLintReport`, kusabi #302) refuses a heading that parses to
 * zero entries, and the round-time routing (kusabi #303) terminates a chain
 * that meets one anyway.  Both call the parsers listed here — the same
 * functions the probes call — so "the lint accepted it" and "the probe can
 * read it" are the same statement rather than two implementations that agree
 * until one is edited.
 *
 * @type {Array<{heading: string, label: string, probe: string,
 *               parse: function(string|null|undefined): Array<any>}>}
 */
export const PARSED_BRIEF_SECTIONS = [
  { heading: "Deliverables", label: "## Deliverables", probe: "P3: deliverables", parse: parseDeliverables },
  { heading: "Smoke", label: "## Smoke", probe: "P4: smoke", parse: parseSmoke },
  { heading: "Frozen Tests", label: "## Frozen Tests", probe: "P5: frozen", parse: parseFrozenTests },
];

/**
 * Every machine-read section whose heading is PRESENT but whose parser yields
 * nothing.
 *
 * Absence is not emptiness: a brief with no `## Smoke` heading declares no
 * smoke check and its probe trivially passes, while a heading followed by
 * prose (`(none frozen by name — …)`) declares a check that can never run.
 * Only the second is reported here, which is exactly the population both
 * consumers act on.
 *
 * @param {string|null|undefined} briefText
 * @returns {Array<{heading: string, label: string, probe: string}>}
 *   In table order; `[]` when every present section parses.  Never throws.
 */
export function zeroEntrySections(briefText) {
  return PARSED_BRIEF_SECTIONS
    .filter(function (s) {
      return hasSectionHeading(briefText, s.heading) && s.parse(briefText).length === 0;
    })
    .map(function (s) {
      return { heading: s.heading, label: s.label, probe: s.probe };
    });
}

/**
 * The round-routing marker for a brief-syntax defect (kusabi #303).
 *
 * Shaped like `summariseOracleViolations`: `false` when the brief carries no
 * zero-entry section, otherwise one string naming every offending section and
 * the probe that reads it.  A truthy value routes the round to the terminal
 * `refused-brief-defect` disposition, because the probe's input is the BRIEF,
 * which the worker cannot edit — no rework is winnable by construction.
 *
 * The wording mirrors the probes' own detail lines ("## X heading present but
 * no entries parsed") so the terminal reason and the probe result read alike.
 *
 * @param {string|null|undefined} briefText
 * @returns {string|false}
 */
export function briefSyntaxDefectSummary(briefText) {
  const zero = zeroEntrySections(briefText);
  if (zero.length === 0) return false;
  return zero.map(function (s) {
    return s.probe + ": " + s.label + " heading present but no entries parsed";
  }).join("; ");
}
