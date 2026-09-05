// Review and follow-up prompt construction.

// Character budget for every captured block the review input carries.  Named
// for the diff it was introduced for; the diff body is no longer inlined
// (kusabi #208), but the budget and its truncation vocabulary still bound the
// lists that are.
const DIFF_BUDGET = 30000;
const PRIOR_FINDINGS_BUDGET = 8000;

/**
 * Lines actually present in a rendered block.  A trailing newline is not a
 * line: "a\nb\n" is two lines and "" is none.
 *
 * @param {string|null|undefined} text
 * @returns {number}
 */
function countRenderedLines(text) {
  if (!text) return 0;
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body === "" ? 0 : body.split("\n").length;
}

/**
 * The "this was cut" label for one captured block, or null when nothing was
 * cut.
 *
 * Two independent things can cut a capture short and both are labelled here:
 * sunaba's own paging (`truncated` / `has_more` on the sandbox_exec response,
 * with `total_lines` for the denominator) and this renderer's character
 * budget.  WHETHER a capture was cut is taken from what the server reports
 * about itself, never inferred from a line count -- "exactly 50 lines" is
 * indistinguishable from a genuinely 50-line output, which is how a one-page
 * capture reached the reviewer looking complete (kusabi #208).
 *
 * The numerator, by contrast, is counted HERE, from the block that was just
 * rendered.  Two reasons, in order:
 *
 *   - The response's own `shown` cannot be used: measured against the live
 *     server it equals `total_lines` even when the output was cut, so it
 *     rendered "truncated (showing 61 of 61 lines)" -- a label that announces
 *     a cut and then prints numbers saying nothing was withheld, which is the
 *     "fragment that looks complete" failure all over again.
 *   - Of the two honest sources (the lines in the returned text, and
 *     `next_offset`), only a count taken here survives this renderer's own
 *     character budget slicing the body further.  `next_offset` describes the
 *     server's page; this describes the block the reviewer is looking at,
 *     which is what the label claims to describe.
 *
 * The count can understate by one against `total_lines`, which counts the
 * trailing newline as a line where this does not.  That direction is the safe
 * one: it can only overstate how much was withheld, never claim the block
 * holds more than it does.
 *
 * @param {string} label
 * @param {{truncated?: boolean, total?: number}|null|undefined} truncation
 * @param {boolean} overBudget
 * @param {string} [hint]        Sentence appended after the label.
 * @param {number} [shownLines]  Lines in the block actually rendered.
 * @returns {string|null}
 */
function captureCutNote(label, truncation, overBudget, hint, shownLines) {
  const paged = truncation?.truncated === true;
  if (!paged && !overBudget) return null;
  // Counts are printed only when they say something is missing.  A numerator
  // that is not strictly below the denominator would restate the very
  // contradiction this label exists to remove, so the label goes out bare
  // instead: "truncated" alone is honest, "showing 61 of 61" is not.
  const total = Number.isInteger(truncation?.total) ? truncation.total : null;
  const counts = paged && total !== null && Number.isInteger(shownLines) && shownLines < total
    ? " (showing " + shownLines + " of " + total + " lines)"
    : "";
  return "**" + label + " truncated" + counts + ".**" + (hint || "");
}

/**
 * Push one captured command output as a fenced block, labelled when it was
 * cut short.
 */
function pushCapture(parts, { title, label, text, placeholder, truncation, hint }) {
  const raw = text || "";
  const overBudget = raw.length > DIFF_BUDGET;
  const body = overBudget ? raw.slice(0, DIFF_BUDGET) : raw;
  parts.push(title + (overBudget ? " (truncated to " + DIFF_BUDGET + " characters)" : "") + ":");
  parts.push("```");
  parts.push(body || placeholder);
  parts.push("```");
  parts.push("");
  // `body` -- not `raw` -- is what the fence holds, so it is what the count
  // describes.  The placeholder is not content: an empty capture shows zero
  // lines.
  const note = captureCutNote(label, truncation, overBudget, hint, countRenderedLines(body));
  if (note) {
    parts.push(note);
    parts.push("");
  }
}

/**
 * The base change-set context of a container review input.
 *
 * What the reviewer is handed is the REFERENCE POINT (base commit, base
 * history) and the SHAPE of the change (which files changed, which are new) --
 * never the diff body.  The reviewer already has `diff_in_container`, which is
 * paginated and purpose-built; inlining a second, cruder copy of it here only
 * added a copy that silently stopped at one page while looking complete
 * (kusabi #208).  What the reviewer genuinely cannot work out for itself is
 * which ref to diff against, so that -- and whose job the fetch is -- is what
 * this block states.
 *
 * @param {object} [opts]
 * @param {string} [opts.baseSha]         Commit the change set is measured against.
 * @param {string} [opts.baseLog]         `git log --oneline -5` output.
 * @param {string} [opts.statusOutput]    `git status --porcelain` output.
 * @param {string} [opts.untrackedFiles]  Newline-separated untracked paths.
 * @param {object} [opts.truncation]      What sandbox_exec reported about its
 *        own paging for each capture: `baseLog`, `status`, `untracked`, each
 *        `{ truncated, total }` (absent = nothing was cut).  The shown-count
 *        is not carried here -- it is counted off the rendered block; see
 *        `captureCutNote`.
 * @returns {string}
 */
export function renderBaseFacts({ baseSha, baseLog, statusOutput, untrackedFiles, truncation, changeScope } = {}) {
  const parts = [];
  parts.push("### Base change-set context (machine-recorded)");
  parts.push("");
  const effectiveBaseSha = changeScope?.resolved?.baseSha ?? baseSha;
  if (effectiveBaseSha) {
    parts.push("- Base commit: `" + effectiveBaseSha + "`");
  } else {
    parts.push("- Base commit: (unavailable)");
  }
  parts.push("");
  pushCapture(parts, {
    title: "Recent base history (top 5)",
    label: "Base history",
    text: baseLog,
    placeholder: "(unavailable)",
    truncation: truncation?.baseLog,
  });

  if (changeScope) {
    parts.push("Authoritative change set (`change-scope`):");
    parts.push("```json");
    parts.push(JSON.stringify(changeScope, null, 2));
    parts.push("```");
    parts.push("");
    parts.push("This machine-resolved change set is authoritative (porcelain is not the range). Review ONLY the paths listed in `paths.*` above: do not interpret a path outside `paths.*` as this round's change; do not flag base-history files as scope creep.");
    parts.push("");
  } else {
    pushCapture(parts, {
      title: "Actual change set (`git status --porcelain`)",
      label: "Change set",
      text: statusOutput,
      placeholder: "(empty change set)",
      truncation: truncation?.status,
      hint: " More files changed than are listed above; `diff_in_container` reports the complete file list.",
    });
  }

  // The diff body is deliberately absent, so the input says so in the words a
  // reviewer cannot misread as "the file list is the change".
  parts.push("**The diff itself is NOT included in this input.** The change set above names WHICH files changed, not WHAT changed inside them -- do not review the file list as if it were the change.");
  parts.push("");
  if (effectiveBaseSha) {
    parts.push("Fetching the diff is YOUR job: call `diff_in_container` with `base` set to `" + effectiveBaseSha + "` (that covers committed AND uncommitted work since that commit), and page through it with `offset` / `limit` until `has_more` is false.");
  } else {
    parts.push("Fetching the diff is YOUR job: call `diff_in_container` -- the base commit could not be read here, so pass `worktree: true` for the uncommitted change set -- and page through it with `offset` / `limit` until `has_more` is false.");
  }
  parts.push("");

  // Untracked files (only when changeScope is absent; changeScope includes paths.untracked)
  if (!changeScope && untrackedFiles && untrackedFiles.trim()) {
    const overBudget = untrackedFiles.length > DIFF_BUDGET;
    const body = overBudget ? untrackedFiles.slice(0, DIFF_BUDGET) : untrackedFiles;
    const untrackedList = body.split("\n").filter(function (l) { return l.trim(); }).map(function (l) { return l.trim(); });
    if (untrackedList.length > 0) {
      parts.push("New (untracked) files" + (overBudget ? " (truncated to " + DIFF_BUDGET + " characters)" : "") + ":");
      for (const f of untrackedList) {
        parts.push("- `" + f + "`");
      }
      parts.push("");
      // The rendered block is the bullet list, so its length is the count.
      const note = captureCutNote("Untracked list", truncation?.untracked, overBudget, " More untracked files exist than are listed above.", untrackedList.length);
      if (note) {
        parts.push(note);
        parts.push("");
      }
      parts.push("Use `read_file_range` to inspect these new files.");
      parts.push("");
    }
  }

  parts.push("Review ONLY this change set. Code that is already part of the base (see the log above) is NOT scope creep and must not be flagged as such.");
  return parts.join("\n");
}

/**
 * The reviewer's input for a CONTAINER review: the review-target block (which
 * container holds the artifact, and the read-side sunaba tools that reach it)
 * followed by `renderBaseFacts` (base commit, base log, change set, the
 * instruction to fetch the diff, untracked files).
 *
 * Single source of the container-flavoured review input (kusabi #204).  Both
 * routes that review a container render it from here:
 *
 *   - the chain's review phase (`runReviewPhase`, chain-review.mjs), and
 *   - `task --phase review --container <cid>` (cmdTask, task-cmd.mjs).
 *
 * The block used to inline the diff body as well.  It was captured with one
 * default-paged `sandbox_exec` call, so across 91 review prompts on the live
 * installation not one carried more than 50 diff lines -- a truncated copy of
 * a diff the reviewer was fetching itself anyway (91% of review jobs called
 * `diff_in_container`).  What the reviewer could NOT determine was the base,
 * so #208 removed the body and kept the reference point (kusabi #208).
 *
 * @param {object} opts
 * @param {string} opts.container        Container ID holding the artifact.
 * @param {string} [opts.baseSha]        Commit the change set is measured against.
 * @param {string} [opts.baseLog]        `git log --oneline -5` output.
 * @param {string} [opts.statusOutput]   `git status --porcelain` output.
 * @param {string} [opts.untrackedFiles] Newline-separated untracked paths.
 * @param {object} [opts.truncation]     Per-capture paging facts; see renderBaseFacts.
 * @param {object} [opts.changeScope]    Parsed change-scope JSON (formatVersion: 1).
 * @returns {string}
 */
export function renderContainerReviewInput({ container, baseSha, baseLog, statusOutput, untrackedFiles, truncation, changeScope } = {}) {
  const parts = [
    "## Review target",
    "",
    "The artifact under review lives inside container `" + container + "`.",
    "You may use the following Sunaba read/verify tools to inspect it:",
    "- `read_file_range` - read file contents from the container",
    "- `search_in_container` - grep/search within the container",
    "- `diff_in_container` - fetch the diff itself; it is NOT inlined below",
    "- `verify_in_container` / `lint_in_container` / `type_check_in_container` - re-run the project's gates in the container",
    "",
    "Do NOT rely on host cwd git state; the actual changes are in the container.",
  ];
  parts.push("", renderBaseFacts({ baseSha, baseLog, statusOutput, untrackedFiles, truncation, changeScope }));
  return parts.join("\n");
}

const FINDING_DESIGN_HEADING = "## Design findings (require deliberate individual treatment)";
const FINDING_MECHANICAL_HEADING = "## Mechanical findings (checklist)";

/**
 * Split findings into design / mechanical groups by their `kind` tag
 * (kusabi #60 step 1).
 *
 * A missing or invalid `kind` is treated as `"design"` — the safe side: a
 * lone design-judgment item must never be silently filed under mechanical.
 * This is a consumption-point default; stored records are never rewritten.
 *
 * @param {Array|undefined|null} findings
 * @returns {{ design: Array, mechanical: Array }}
 */
export function groupFindingsByKind(findings) {
  const design = [];
  const mechanical = [];
  if (Array.isArray(findings)) {
    for (const f of findings) {
      if (!f || typeof f !== "object") continue;
      if (f.kind === "mechanical") {
        mechanical.push(f);
      } else {
        // missing / invalid kind → design (safe side)
        design.push(f);
      }
    }
  }
  return { design, mechanical };
}

/**
 * Render findings as grouped one-line rows ("[severity] title (file:line)")
 * for the `findingsText` field: design findings first under a labelled
 * section, mechanical findings after as a checklist.  When every finding is
 * one kind, a single section is emitted (no empty headings).
 *
 * @param {Array|undefined|null} findings
 * @returns {string} "(no structured findings)" when there is nothing to render.
 */
export function renderGroupedFindingsText(findings) {
  if (!Array.isArray(findings) || findings.length === 0) {
    return "(no structured findings)";
  }
  const { design, mechanical } = groupFindingsByKind(findings);
  const sections = [];
  if (design.length > 0) {
    sections.push(FINDING_DESIGN_HEADING);
    sections.push(design.map(oneLineFinding).join("\n"));
  }
  if (mechanical.length > 0) {
    sections.push(FINDING_MECHANICAL_HEADING);
    sections.push(mechanical.map(oneLineFinding).join("\n"));
  }
  return sections.join("\n\n");
}

function oneLineFinding(f) {
  return "[" + f.severity + "] " + f.title + " (" + f.file + ":" + f.line_start + ")";
}

/**
 * Render the prior-findings block for a rework round's implement prompt.
 *
 * When the previous round record carries a structured `findings` array
 * (severity, title, body, recommendation etc.), each finding is rendered
 * in full, grouped under two labelled sections by `kind` (kusabi #60 step 1):
 * design findings FIRST, explicitly flagged as requiring deliberate
 * individual treatment, mechanical findings after, as a checklist.  When
 * every finding is one kind, a single section is emitted.  The block is
 * bounded by `PRIOR_FINDINGS_BUDGET` characters; when exceeded, a
 * truncation note is appended.
 *
 * Old records without the `findings` array degrade gracefully to the
 * current one-line `findingsText` format.
 *
 * @param {object|null|undefined} previousRecord
 * @returns {string}
 */
export function renderPriorFindings(previousRecord) {
  if (!previousRecord) {
    return "(none)";
  }

  const findings = previousRecord.findings;
  if (!findings || !Array.isArray(findings) || findings.length === 0) {
    return previousRecord.findingsText || "(none)";
  }

  const { design, mechanical } = groupFindingsByKind(findings);
  const sections = [];
  for (const group of [
    { heading: FINDING_DESIGN_HEADING, items: design },
    { heading: FINDING_MECHANICAL_HEADING, items: mechanical },
  ]) {
    if (group.items.length === 0) continue;
    const block = [];
    block.push(group.heading);
    block.push("");
    for (const f of group.items) {
      const severity = f.severity || "unknown";
      const title = f.title || "(untitled)";
      const file = f.file || "?";
      const lineStart = f.line_start !== undefined ? f.line_start : "?";

      block.push(`### [${severity}] ${title} (${file}:${lineStart})`);
      block.push("");
      if (f.body) {
        block.push(f.body);
        block.push("");
      }
      if (f.recommendation) {
        block.push(`**Recommendation:** ${f.recommendation}`);
        block.push("");
      }
    }
    sections.push(block.join("\n").replace(/\n+$/, ""));
  }

  let text = sections.join("\n\n");

  if (text.length > PRIOR_FINDINGS_BUDGET) {
    text = text.slice(0, PRIOR_FINDINGS_BUDGET);
    // No tool can fetch the remainder: prior findings live in the chain record
    // on the host, not in the container.  Say what is actually true and what to
    // do about it, rather than pointing at a file that does not exist.
    text += `\n\n**(Prior findings truncated to ${PRIOR_FINDINGS_BUDGET} characters. The remaining findings are not retrievable from inside the container — resolve the ones shown above and report in your final report that the list was truncated.)**`;
  }

  return text;
}

// kusabi #336: when a chain ends in `escalate`, the orchestrator must be
// handed the DECISIONS, not a one-line task list. The reviewer already records
// each finding's body and its recommendation (which for design findings
// typically states two alternatives); this renderer surfaces that material so
// the human answers one item per finding instead of re-reading the raw
// round-<N>.json. The reader here is the host-side orchestrator, who CAN open
// the round record, so the truncation note points there (the opposite of
// renderPriorFindings, whose reader lives inside the container and cannot).
const ESCALATION_DECISIONS_BUDGET = 6000;

const ESCALATION_SEVERITY_ORDER = ["critical", "high", "medium", "low", "unknown"];

function escalationSeverityRank(severity) {
  const idx = ESCALATION_SEVERITY_ORDER.indexOf(severity || "unknown");
  return idx === -1 ? ESCALATION_SEVERITY_ORDER.length - 1 : idx;
}

// Truncate a single oversized entry (the first/most severe finding) at a line
// boundary so the decision text never ends mid-line and never leaves a dangling
// `###` header with nothing under it. `text` is already `intro` + separator +
// the single entry; we cut at the last newline at or before `budget`, and if
// that leaves a `###` header as the final line we drop that header line too.
function truncateEntryAtLineBoundary(text, budget) {
  if (text.length <= budget) return text;
  const cut = text.lastIndexOf("\n", budget - 1);
  if (cut <= 0) {
    // No line boundary before the budget: nothing safe to keep.
    return "";
  }
  let result = text.slice(0, cut);
  const lastNl = result.lastIndexOf("\n");
  const lastLine = lastNl === -1 ? result : result.slice(lastNl + 1);
  if (lastLine.startsWith("### ")) {
    const prevNl = lastNl === -1 ? -1 : result.lastIndexOf("\n", lastNl - 1);
    result = prevNl === -1 ? "" : result.slice(0, prevNl);
  }
  return result;
}

/**
 * Render the decision block for an escalated terminal round.
 *
 * Each structured finding is presented as a decision the orchestrator answers:
 * severity (and kind when present), title, `file:line`, the finding `body`, and
 * its `recommendation` rendered in full — the recommendation is the part that
 * holds the alternatives, so it is never truncated per entry. Findings are
 * ordered by severity (critical → high → medium → low → unknown), stable within
 * a severity. The block opens with an explicit instruction that each item needs
 * one decided outcome and that a one-line answer per item is enough.
 *
 * The block is bounded by `ESCALATION_DECISIONS_BUDGET` characters; on
 * truncation a note says where the rest lives — the host-side round record,
 * which the orchestrator can open — never that it is unretrievable.
 *
 * Degrades like `renderPriorFindings`: an empty/missing `findings` array yields
 * a single plain line, so a renderer never presents an empty list as a fact.
 *
 * @param {Array|null|undefined} findings
 * @param {{ roundNumber?: number }} [opts]
 * @returns {string}
 */
export function renderEscalationDecisions(findings, opts = {}) {
  // Keep only entries that are actually structured findings; a renderer must
  // never present an empty list as a fact, so a degenerate (missing, empty, or
  // all-junk) array yields a single plain line.
  const ranked = Array.isArray(findings)
    ? findings.filter((f) => f && typeof f === "object")
    : [];
  if (ranked.length === 0) {
    return "(no structured findings to decide)";
  }

  // Severity-ordered; items of equal severity keep their input order.
  const ordered = ranked
    .map((f, i) => ({ f, i }))
    .sort((a, b) => {
      const ra = escalationSeverityRank(a.f.severity);
      const rb = escalationSeverityRank(b.f.severity);
      return ra !== rb ? ra - rb : a.i - b.i;
    })
    .map((x) => x.f);

  const intro =
    "Decisions for the orchestrator (answer each; a one-line answer per item " +
    "is enough — the material to decide is here, no re-investigation needed):";

  const items = [];
  for (const f of ordered) {
    const severity = f.severity || "unknown";
    const kind = f.kind ? ` [${f.kind}]` : "";
    const title = f.title || "(untitled)";
    const file = f.file || "?";
    const lineStart = f.line_start !== undefined ? f.line_start : "?";
    const block = [];
    block.push(`### [${severity}]${kind} ${title} (${file}:${lineStart})`);
    block.push("");
    if (f.body) {
      block.push(f.body);
      block.push("");
    }
    if (f.recommendation) {
      block.push(`**Recommendation:** ${f.recommendation}`);
      block.push("");
    }
    items.push(block.join("\n").replace(/\n+$/, ""));
  }

  // Assemble within the budget at whole-finding boundaries: keep the intro,
  // then append findings (already severity-ordered) only while the assembled
  // text stays within ESCALATION_DECISIONS_BUDGET; drop whole entries from the
  // end rather than cutting one mid-body or mid-recommendation.
  const joinSep = "\n\n";
  let text = intro;
  let shown = 0;
  let truncatedEntry = false;

  for (let i = 0; i < items.length; i++) {
    const candidate = text + joinSep + items[i];
    if (candidate.length <= ESCALATION_DECISIONS_BUDGET) {
      text = candidate;
      shown++;
      continue;
    }
    // This entry does not fit. If nothing has been shown yet it is the most
    // severe finding and is itself oversized: truncate that one entry at a
    // line boundary (never mid-line, never a dangling ### header). Remaining
    // entries are dropped whole.
    if (shown === 0) {
      text = truncateEntryAtLineBoundary(candidate, ESCALATION_DECISIONS_BUDGET);
      shown = 1;
      truncatedEntry = true;
    }
    break;
  }

  // Emit the note only when something was dropped or truncated, and state how
  // many of how many findings are shown, keeping the pointer to the host-side
  // round record the orchestrator can open.
  if (truncatedEntry || shown < items.length) {
    const where =
      opts && opts.roundNumber !== undefined
        ? `the chain's round-${opts.roundNumber}.json on the host`
        : "the chain's round record on the host";
    text +=
      `\n\n**(Decisions truncated: ${shown} of ${items.length} findings shown ` +
      `(budget ${ESCALATION_DECISIONS_BUDGET} characters). ` +
      `The remaining findings are in ${where} — open that record to decide the rest.)**`;
  }

  return text;
}

export function renderStrategistPrompt({ brief, rounds } = {}) {
  const lines = [];

  lines.push("## Acceptance criteria");
  lines.push("");
  lines.push(brief || "(not provided)");
  lines.push("");

  const safeRounds = Array.isArray(rounds) ? rounds : [];
  for (const rnd of safeRounds) {
    lines.push("## Findings from round " + (rnd.round || "?"));
    lines.push("");
    lines.push(rnd.findingsText || "(none)");
    lines.push("");
  }

  lines.push("## Instruction");
  lines.push("");
  lines.push("The same file area has been flagged for two consecutive rounds — the current approach is stalled.");
  lines.push("Recommend exactly ONE structural change: keep WHAT (the acceptance criteria) fixed, change HOW.");
  lines.push("Reply with a short recommendation (goal-level, not a patch). Return it in your final report; you cannot post to issues in this mode.");
  lines.push("");

  return lines.join("\n");
}

export function renderFollowupDraft({ chainId, briefTitle, findings } = {}) {
  const lines = [];
  lines.push("## Follow-up issue draft (not posted — orchestrator judgement required)");
  lines.push("");
  lines.push("### Completed scope");
  lines.push("");
  lines.push("- Chain: " + (chainId || "(unknown)"));
  if (briefTitle) {
    lines.push("- Brief: " + briefTitle);
  }
  lines.push("");
  lines.push("### Remaining findings");
  lines.push("");
  if (Array.isArray(findings) && findings.length > 0) {
    for (var i = 0; i < findings.length; i++) {
      var f = findings[i];
      var severity = f.severity || "unknown";
      var title = f.title || "(untitled)";
      var file = f.file || "unknown";
      var lineStart = f.line_start !== undefined && f.line_start !== null ? f.line_start : "?";
      lines.push("- [" + severity + "] " + title + " (" + file + ":" + lineStart + ")");
    }
  } else {
    lines.push("(none)");
  }
  lines.push("");
  lines.push("These findings were deferred by the accept-with-followup economic cutoff. The orchestrator should review and decide whether to handle them.");
  return lines.join("\n");
}

