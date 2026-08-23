// Rendering functions — no I/O, no imports from kusabi-companion.mjs.
// Imports from chain-control.mjs for liveness checks (process.kill with sig 0
// is a pure observation, not a mutation).

import { effectiveStatus } from "./chain-control.mjs";

export function durationS(job) {
  if (!job.startedAt) return "?";
  const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
  return Math.round((end - Date.parse(job.startedAt)) / 1000);
}

export function renderHeader(job) {
  const usageLine = (() => {
    const u = job.usage;
    if (!u || !u.available) return [];
    const parts = [`${u.input} in / ${u.output} out`];
    if (u.reasoning) parts.push(`${u.reasoning} reasoning`);
    return [`tokens: ${parts.join(", ")}`];
  })();

  // Model route + variant line (always shown when available).
  const routeLine = [];
  if (job.modelEntry) {
    routeLine.push(`route: ${job.modelEntry}`);
  } else if (job.stats?.models?.length) {
    routeLine.push(`model: ${job.stats.models.join(" → ")}`);
  }

  // Provider-error: show error details first.
  const errorLines = [];
  if (job.status === "provider-error") {
    errorLines.push(`provider-error: ${job.error || "unknown provider error"}`);
    if (job.retry) {
      const r = job.retry;
      errorLines.push(`  reason: ${r.reason || "unknown"}, attempt: ${r.attempt}, terminal: ${r.terminal || false}`);
      if (r.message) errorLines.push(`  provider message: ${r.message}`);
    }
  }

  // Fallbacks: show every fallback step.
  const fallbackLines = [];
  if (job.fallbacks && job.fallbacks.length > 0) {
    for (const fb of job.fallbacks) {
      let fbLine = `  fallback: ${fb.from} → ${fb.to || "(none)"} (${fb.reason || "retry"} at attempt ${fb.attempt})`;
      if (fb.message) fbLine += `: ${fb.message}`;
      fallbackLines.push(fbLine);
    }
  }

  // Backend-aware header/session lines (kusabi #184 Job B, third backend
  // kusabi #199, agy resume #316): a missing `backend` field predates the
  // backend split and means opencode, so the opencode output stays
  // byte-identical.  A claude job shows the claude continuation shape
  // (`claude -p --resume <id>`); the session id is the one recorded on the
  // job (a UUID for claude and agy, ses_* for opencode).
  //
  // The agy line shows the CLI's own continuation shape (`agy --conversation
  // <id>`): the recorded conversation_id is exactly what the CLI resumes
  // with, so the header advertises a command the backend honours (v1
  // printed "resume is not supported" — #316 removed that limit).
  const isClaude = job.backend === "claude";
  const isAgy = job.backend === "agy";
  const backendLabel = isClaude ? "claude" : (isAgy ? "agy" : "opencode");

  let sessionLine;
  if (isAgy) {
    sessionLine = `session: ${job.sessionID} (continue in agy: \`agy --conversation ${job.sessionID}\`)`;
  } else if (isClaude) {
    sessionLine = `session: ${job.sessionID} (continue in claude: \`claude -p --resume ${job.sessionID}\`)`;
  } else {
    sessionLine = `session: ${job.sessionID} (continue in opencode: \`opencode -s ${job.sessionID}\`)`;
  }

  return [
    `${backendLabel} ${job.kind} ${job.id} — ${job.status} (${durationS(job)}s)`,
    sessionLine,
    ...(job.phase ? [`phase: ${job.phase}`] : []),
    ...(routeLine.length ? routeLine : []),
    ...usageLine,
    ...errorLines,
    ...fallbackLines,
    "",
  ].join("\n");
}

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
export function renderBaseFacts({ baseSha, baseLog, statusOutput, untrackedFiles, truncation } = {}) {
  const parts = [];
  parts.push("### Base change-set context (machine-recorded)");
  parts.push("");
  if (baseSha) {
    parts.push("- Base commit: `" + baseSha + "`");
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
  pushCapture(parts, {
    title: "Actual change set (`git status --porcelain`)",
    label: "Change set",
    text: statusOutput,
    placeholder: "(empty change set)",
    truncation: truncation?.status,
    hint: " More files changed than are listed above; `diff_in_container` reports the complete file list.",
  });

  // The diff body is deliberately absent, so the input says so in the words a
  // reviewer cannot misread as "the file list is the change".
  parts.push("**The diff itself is NOT included in this input.** The change set above names WHICH files changed, not WHAT changed inside them -- do not review the file list as if it were the change.");
  parts.push("");
  if (baseSha) {
    parts.push("Fetching the diff is YOUR job: call `diff_in_container` with `base` set to `" + baseSha + "` (that covers committed AND uncommitted work since that commit), and page through it with `offset` / `limit` until `has_more` is false.");
  } else {
    parts.push("Fetching the diff is YOUR job: call `diff_in_container` -- the base commit could not be read here, so pass `worktree: true` for the uncommitted change set -- and page through it with `offset` / `limit` until `has_more` is false.");
  }
  parts.push("");

  // Untracked files
  if (untrackedFiles && untrackedFiles.trim()) {
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
 *   - the chain's review phase (`runReviewPhase`, chain-phases.mjs), and
 *   - `task --phase review --container <cid>` (cmdTask, kusabi-companion.mjs).
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
 * @returns {string}
 */
export function renderContainerReviewInput({ container, baseSha, baseLog, statusOutput, untrackedFiles, truncation } = {}) {
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
  parts.push("", renderBaseFacts({ baseSha, baseLog, statusOutput, untrackedFiles, truncation }));
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

export function renderJobLine(job) {
  const orch = job.orchestrator?.model ? ` orch=${job.orchestrator.model}` : "";
  return `${job.id}  ${job.kind.padEnd(6)}  ${job.status.padEnd(9)}  ${durationS(job)}s${orch}  ${job.title ?? ""}`;
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

/**
 * The discard reason to show for a probe-sourced discard (kusabi #299).
 *
 * A round P3 skipped because it added nothing since the baseline carries the
 * verdict `discard` with `verdictSource: "probe"` — no reviewer ever saw it.
 * Its recorded disposition reason is deriveDisposition's generic "reviewer
 * discarded the work", which is the wrong thing to tell an operator: the
 * motivating incident (chain-msvthdq26fdc, 2026-08-16) escalated reading that
 * over a worktree whose earlier rounds were intact and eventually shipped.
 * So every surface that would surface the discard reason is re-keyed on
 * verdictSource "probe" through the shared describers below, with the
 * dirty-vs-base fact in the wording; reviewer-verdict discards (verdictSource
 * not "probe") keep the recorded reason unchanged.  Three states, never a
 * guess: records predating the field render "not recorded".
 *
 * @param {object} round
 * @returns {string}
 */
function probeDiscardReason(round) {
  if (round.worktreeDirtyVsBase === true) {
    return "empty round discarded by probe; worktree still DIRTY vs the chain base";
  }
  if (round.worktreeDirtyVsBase === false) {
    return "empty round discarded by probe; worktree CLEAN vs the chain base";
  }
  return "empty round discarded by probe; dirty-vs-base not recorded";
}

/**
 * The discard reason to SHOW for a round's disposition (kusabi #299).
 *
 * Shared by every surface that renders a round's disposition reason — the
 * chain-show status headline, the chain-show disposition line, the terminal
 * escalate outcome's first line, and the reason persisted on the finalised
 * chain record.  A probe-sourced discard substitutes the probe wording (see
 * probeDiscardReason) for the recorded reason, because deriveDisposition's
 * generic "reviewer discarded the work" is the wrong thing to read over a
 * worktree whose earlier rounds are intact; any other round — including a
 * reviewer-verdict discard — renders the recorded reason (the fallback)
 * unchanged.  No renderer keeps its own copy of the probe-discard condition.
 *
 * @param {object}  round          — the round record being described.
 * @param {string}  fallbackReason — the recorded reason for non-probe rounds.
 * @returns {string}
 */
export function roundDiscardReason(round, fallbackReason) {
  if (round && round.verdict === "discard" && round.verdictSource === "probe") {
    return probeDiscardReason(round);
  }
  return fallbackReason;
}

/**
 * The `changed=` column value for a round (kusabi #299).
 *
 * Shared by every surface that renders a round's changed flag — the
 * chain-show `changed:` line, the terminal outcome round summaries (escalate,
 * max-rounds, refusal, provider-exhausted) and the postable review record's
 * round line.  Folds the probe-discard case into the column itself: such a
 * round's `worktreeChanged` is false BY CONSTRUCTION (it added nothing since
 * the baseline), so a bare "NO" would read as "nothing is in the worktree" —
 * the opposite of the recorded `worktreeDirtyVsBase` fact — and the column
 * states that fact instead.  No renderer keeps its own copy of the rule.
 *
 * @param {object} round
 * @returns {string} "unknown" | "yes" | "NO" | "NO (worktree DIRTY/CLEAN vs
 *                   the chain base)" | "NO (dirty-vs-base not recorded)"
 */
export function roundChangedColumn(round) {
  if (round && round.verdict === "discard" && round.verdictSource === "probe") {
    if (round.worktreeDirtyVsBase === true) {
      return "NO (worktree DIRTY vs chain base)";
    }
    if (round.worktreeDirtyVsBase === false) {
      return "NO (worktree CLEAN vs chain base)";
    }
    return "NO (dirty-vs-base not recorded)";
  }
  if (round.worktreeChanged === undefined || round.worktreeChanged === null) {
    return "unknown";
  }
  return round.worktreeChanged ? "yes" : "NO";
}

/**
 * Resolve the status label for a chain by combining the control record
 * (explicit lifecycle status) with the round-derived disposition when the
 * control record is absent (old chains from before stop-lever).
 *
 * @param {object|null} control
 * @param {Array}       rounds
 * @returns {string}
 */
function roundDerivedStatus(rounds) {
  const safeRounds = rounds ?? [];
  const lastRound = safeRounds.length > 0 ? safeRounds[safeRounds.length - 1] : null;
  if (lastRound?.disposition?.disposition === "accept") {
    return `accepted at round ${lastRound.round}`;
  } else if (lastRound?.disposition?.disposition === "accept-with-followup") {
    return `accepted-with-followup at round ${lastRound.round} (${lastRound.disposition.reason || "economic cutoff"})`;
  } else if (lastRound?.disposition?.disposition === "escalate") {
    // A probe-sourced discard's recorded reason ("reviewer discarded the
    // work") is the wrong headline for a round no reviewer ever saw: say the
    // round was empty and whether the worktree still holds the prior rounds'
    // work (kusabi #299).  Reviewer-verdict discards render unchanged.
    // roundDiscardReason owns the probe-discard condition — no renderer keeps
    // its own copy of the rule.
    const reason = roundDiscardReason(lastRound, lastRound.disposition.reason || "unknown");
    return `escalated at round ${lastRound.round} (${reason})`;
  } else if (lastRound?.disposition?.disposition === "refused-brief-defect") {
    // kusabi #293.  Named as a BRIEF defect on the status line itself: the
    // reader's first question about a chain that produced nothing is whose
    // fault it was, and this is the one outcome where the answer is "the
    // brief's".
    return `refused at round ${lastRound.round} — brief defect (${lastRound.disposition.reason || "worker refused"})`;
  }
  return null;
}

export function resolveChainStatus(control, rounds) {
  // The control record is authoritative about the chain's *lifecycle* —
  // whether the process is alive, stopping, gone (stale), cancelled or failed.
  // effectiveStatus detects stale records (running status with dead pid) and
  // reports them as "stale" rather than "running".
  //
  // "completed" is the one lifecycle status that says nothing about the
  // outcome, so it defers to the round-derived disposition: "accepted at
  // round 2" is what the reader needs, and it is the label chain-show
  // printed before the control record existed.
  if (control) {
    const { status } = effectiveStatus(control);
    if (status !== "completed") return status;
    return roundDerivedStatus(rounds) || "completed";
  }

  // No control file (chains from before the stop lever): round-derived only.
  return roundDerivedStatus(rounds) || "incomplete";
}

export function renderChainShow(chain, rounds, unreadable = [], control = null, opts = {}) {
  const lines = [];
  // Tolerate null/undefined rounds — treat as empty
  const safeRounds = rounds ?? [];
  const chainId = chain?.chainId || "(unknown)";

  // Header
  lines.push(`chain: ${chainId}`);
  // Corrupt round records must be surfaced, never silently omitted —
  // a digest that hides evidence defeats its purpose.
  if (unreadable.length > 0) {
    lines.push(`!! unreadable round records (excluded below): ${unreadable.join(", ")}`);
  }

  // Status/outcome — from control record when present, else round-derived.
  const statusLabel = resolveChainStatus(control, safeRounds);
  lines.push(`status: ${statusLabel}`);

  // Orchestrator model when present
  if (chain?.orchestrator?.model) {
    lines.push(`orchestrator: ${chain.orchestrator.model}`);
  }

  // Brief first line only (the full brief can be read from chain.json)
  if (chain?.brief) {
    const briefLine = chain.brief.split("\n")[0].trim();
    lines.push(`brief: ${briefLine.slice(0, 80)}${briefLine.length > 80 ? "..." : ""}`);
  }

  // Container if recorded
  if (chain?.container) {
    lines.push(`container: ${chain.container}`);
  }

  const unfilled = typeof opts?.unfilledCount === "number" ? opts.unfilledCount : 0;
  if (unfilled > 0) {
    lines.push(`unadjudicated review records: ${unfilled}`);
  }

  lines.push("");

  // Per round
  for (const round of safeRounds) {
    lines.push(`Round ${round.round}`);

    // Partial round persisted at stop time (kusabi #153①) and rounds resumed
    // by chain-resume — visible traces of the interruption/recovery so the
    // digest never reads as a plain completed round.
    if (round.interrupted) {
      const after = round.interruptedAfter ? ` (after ${round.interruptedAfter})` : "";
      lines.push(`  interrupted: yes${after}`);
    }
    if (round.resumed) {
      lines.push(`  resumed: yes`);
    }

    // Model entry(+variant)
    if (round.modelEntry) {
      lines.push(`  model: ${round.modelEntry}`);
    }

    // Fallbacks that occurred during this round's dispatches
    if (round.fallbacks && round.fallbacks.length > 0) {
      lines.push(`  fallbacks:`);
      for (const fb of round.fallbacks) {
        let fbLine = `    ${fb.from} → ${fb.to || "(none)"} (${fb.reason || "retry"} at attempt ${fb.attempt})`;
        if (fb.message) fbLine += `: ${fb.message}`;
        lines.push(fbLine);
      }
    }

    // Review seats that died mid-stream and were replaced by chain-resume
    // (kusabi #248).  Rendered BEFORE the verdict, in the order they were
    // bought, so the round reads chronologically: each failed seat with the
    // escalate it caused, then the verdict the replacement seat produced.
    // Without this the round would show only the replacement's verdict and
    // read as a clean single review.
    const seatFailures = Array.isArray(round.reviewSeatFailures) ? round.reviewSeatFailures : [];
    for (const seat of seatFailures) {
      if (!seat || typeof seat !== "object") continue;
      const seatNo = seat.seat ?? "?";
      const seatDisp = seat.disposition?.disposition
        ? `, disposition: ${seat.disposition.disposition}`
        : "";
      lines.push(`  review seat ${seatNo}: FAILED (verdict: ${seat.verdict ?? "?"}${seatDisp}) — replaced by chain-resume`);
    }

    // Verdict
    if (round.verdict) {
      const salvagedNote = round.salvagedVerdict === true ? " (salvaged)" : "";
      const parseableNote = round.reviewParseable === false ? " (unparseable)" : "";
      // Name the seat the verdict came from, so a replacement verdict is
      // never mistaken for the round's first and only review.
      const seatNote = seatFailures.length > 0 ? ` (replacement seat ${seatFailures.length + 1})` : "";
      lines.push(`  verdict: ${round.verdict}${salvagedNote}${parseableNote}${seatNote}`);
    }

    // A probe-sourced discard is NOT a reviewer's discard (kusabi #299): no
    // reviewer ever saw this round, it was skipped because the round added
    // nothing since the baseline.  Whether the WORKTREE is still dirty
    // against the chain base is the fact that decides where an inspection
    // starts, so say it here rather than leaving the digest reading "the work
    // is gone" over an intact tree.  Reviewer-verdict discards render
    // unchanged — this block is keyed on verdictSource "probe".
    if (round.verdict === "discard" && round.verdictSource === "probe") {
      if (round.worktreeDirtyVsBase === true) {
        lines.push(`  empty round discarded (no reviewer ran); worktree still DIRTY vs the chain base — prior rounds' work is intact, inspect the container`);
      } else if (round.worktreeDirtyVsBase === false) {
        lines.push(`  empty round discarded (no reviewer ran); worktree CLEAN vs the chain base — nothing is left in the container`);
      } else {
        // Records written before the fact was recorded, and the resumed-review
        // path that never runs this branch.  Unknown is stated, never guessed.
        lines.push(`  empty round discarded (no reviewer ran); dirty-vs-base not recorded`);
      }
    }

    // Disposition + reason
    if (round.disposition) {
      const disp = round.disposition.disposition || "unknown";
      // A probe-sourced discard's recorded reason is deriveDisposition's
      // generic "reviewer discarded the work" — the wrong wording for a round
      // no reviewer ever saw.  Say it was empty and whether the worktree
      // still holds the prior rounds' work instead (kusabi #299).
      // Reviewer-verdict discards render the recorded reason unchanged.
      // roundDiscardReason owns the probe-discard condition — no renderer
      // keeps its own copy of the rule.
      const reason = roundDiscardReason(round, round.disposition.reason || "");
      const reasonNote = reason ? ` (${reason})` : "";
      lines.push(`  disposition: ${disp}${reasonNote}`);
    }

    // Quota exhaustion is a job fact, not an unreadable verdict (kusabi #373).
    // chain-show must name the empty pool without opening job.json.
    if (round.reviewJobFailure && round.reviewJobFailure.kind === "quota-exhaustion") {
      const failure = round.reviewJobFailure;
      const pool = failure.quota === "free-tier"
        ? "free-tier pool"
        : failure.quota === "individual"
          ? "individual pool"
          : failure.quota
            ? failure.quota + " pool"
            : "pool";
      const reset = failure.reset
        ? (/^\d/.test(String(failure.reset)) ? "; resets in " + failure.reset : "; resets " + failure.reset)
        : "";
      lines.push(`  quota: ${failure.backend || "provider"} ${pool} exhausted${reset}`);
    }
    if (round.reviewJobError) {
      lines.push(`  review job error: ${round.reviewJobError}`);
    }

    // Refusal (kusabi #293): the disposition line above says a refusal
    // happened; these lines say WHAT was refused.  The two named items and
    // the one-line why are the whole payload the orchestrator acts on, so
    // they are rendered verbatim and never truncated.
    if (round.refusal && Array.isArray(round.refusal.anchors)) {
      lines.push(`  refusal: contradicting items named by the worker`);
      for (const anchor of round.refusal.anchors) {
        if (!anchor || typeof anchor !== "object") continue;
        lines.push(`    - ${anchor.text || anchor.name || "(unnamed)"} [${anchor.kind || "?"}]`);
      }
      lines.push(`    why: ${round.refusal.why || "(not recorded)"}`);
    }
    // A refusal block in a round that DID change files is not a refusal, and
    // the routing ignored it.  Surfacing the inconsistency is the point: the
    // worker said one thing and did another.
    if (round.strayRefusalBlock) {
      lines.push(`  !! stray refusal block: ${round.strayRefusalBlock.note || "refusal block present in a round that did not stop empty"}`);
    }
    // A refusal that was attempted and did not qualify: the round was a
    // discard, and this says why it was not read as a refusal.
    if (round.refusalRejected) {
      lines.push(`  !! refusal not qualifying: ${round.refusalRejected}`);
    }

    // Worktree change status (baseline-aware).  The probe-discard fold lives
    // in roundChangedColumn (kusabi #299): such a round's worktreeChanged is
    // false by construction, so the column states the recorded
    // worktreeDirtyVsBase fact instead of a bare NO that reads as "nothing is
    // in the worktree".
    lines.push(`  changed: ${roundChangedColumn(round)}`);

    // Tier info (B8: which levers were pulled)
    if (round.tierBefore !== undefined) {
      const tierAfter = round.tierAfter !== undefined ? round.tierAfter : round.tierBefore;
      const tierArrow = round.tierBefore !== tierAfter ? ` ${round.tierBefore} \u2192 ${tierAfter}` : ` ${round.tierBefore}`;
      let tierLine = `  tier:${tierArrow}`;
      // Escalation beyond the modelChain's top tier is clamped at the driver
      // (kusabi #153): the recorded tier must match the model actually used.
      // When clamping happened, say why instead of letting "0 → 1" mislead
      // the orchestrator into thinking a stronger model was dispatched.
      if (round.tierClamped) {
        tierLine += ` (escalation clamped: ${round.tierClampReason || "modelChain top tier"})`;
      }
      lines.push(tierLine);
    }

    // Rework strategy reason (B8: why these levers were pulled)
    if (round.reworkStrategyReason) {
      lines.push(`  rework strategy: ${round.reworkStrategyReason}`);
    }

    // Rework scope (kusabi #60 step 2): a round deliberately narrowed to a
    // subset of the previous findings records the scope NAME only — the
    // scoped subset is not persisted, so re-deriving the partition here
    // would duplicate resolveReworkScope's branch table.  Only a narrowed
    // scope is worth printing: "full" is the default for every round
    // (including round 1) and records written before the field existed have
    // no scope at all — both stay silent so old digests stay byte-identical.
    if (round.reworkScope === "mechanical" || round.reworkScope === "design") {
      lines.push(`  rework scope: ${round.reworkScope}`);
    }

    if (round.reworkCount !== undefined) {
      lines.push(`  rework count: ${round.reworkCount}`);
    }

    // Resume method
    if (round.resumeMethod) {
      const resumeType = round.resumeMethod.type || "unknown";
      const resumeDetail = round.resumeMethod.detail ? `: ${round.resumeMethod.detail}` : "";
      lines.push(`  resume: ${resumeType}${resumeDetail}`);
    }

    // Probe results
    const probes = round.probeResults || [];
    if (probes.length > 0) {
      for (const probe of probes) {
        const status = probe.passed ? "PASS" : "FAIL";
        let detailSuffix = "";
        if (probe.detail) {
          let parsed = null;
          try { parsed = JSON.parse(probe.detail); } catch { /* plain text */ }
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            // JSON detail: extract structured fields
            const parts = [];
            if (parsed.gate_passed !== undefined) {
              parts.push(`gate_passed=${parsed.gate_passed}`);
            }
            if (parsed.diff_summary && typeof parsed.diff_summary === "object") {
              const ds = parsed.diff_summary;
              const countParts = [];
              if (ds.changed_files !== undefined) countParts.push(`changed=${ds.changed_files}`);
              if (ds.untracked !== undefined) countParts.push(`untracked=${ds.untracked}`);
              if (countParts.length > 0) parts.push(countParts.join(", "));
            }
            if (parts.length > 0) {
              detailSuffix = ` (${parts.join(", ")})`;
            }
          } else {
            // Plain text: show as-is, truncated for long strings
            const text = String(probe.detail);
            const truncated = text.length > 150 ? text.slice(0, 150) + "..." : text;
            detailSuffix = ` (${truncated})`;
          }
        }
        lines.push(`    ${probe.probe || "probe"} — ${status}${detailSuffix}`);
      }
    }

    // findingsText verbatim, untruncated
    if (round.findingsText) {
      lines.push(`  findings:`);
      const findingLines = round.findingsText.split("\n");
      for (const fl of findingLines) {
        // Indent each finding line with two spaces
        lines.push(`  ${fl}`);
      }
    }

    // Implement usage
    if (round.implementUsage?.available) {
      const u = round.implementUsage;
      const parts = [`implement: ${u.input || 0} in / ${u.output || 0} out`];
      if (u.reasoning) parts.push(`${u.reasoning} reasoning`);
      if (u.cost !== undefined) parts.push(`cost=$${u.cost}`);
      lines.push(`  ${parts.join(", ")}`);
    }

    // Review usage
    if (round.reviewUsage?.available) {
      const u = round.reviewUsage;
      const parts = [`review: ${u.input || 0} in / ${u.output || 0} out`];
      if (u.reasoning) parts.push(`${u.reasoning} reasoning`);
      if (u.cost !== undefined) parts.push(`cost=$${u.cost}`);
      lines.push(`  ${parts.join(", ")}`);
    }

    // Strategist data (Decision 4)
    if (round.strategistUsage?.available) {
      const u = round.strategistUsage;
      const parts = [`strategist: ${u.input || 0} in / ${u.output || 0} out`];
      if (u.reasoning) parts.push(`${u.reasoning} reasoning`);
      if (u.cost !== undefined) parts.push(`cost=$${u.cost}`);
      if (u.model) parts.push(`model=${u.model}`);
      lines.push(`  ${parts.join(", ")}`);
    }
    if (round.strategistRecommendation) {
      lines.push(`  strategist recommendation:`);
      const recLines = round.strategistRecommendation.split("\n");
      for (const rl of recLines) {
        lines.push(`  ${rl}`);
      }
    }

    lines.push("");
  }

  // kusabi #336: an escalated terminal round carries the decisions, not just
  // the one-line findingsText rendered per round above. Surface the structured
  // findings (severity-ordered, budget-bounded) so the orchestrator answers
  // one item per finding instead of re-reading the round record. Old records
  // without a structured `findings` array render only the per-round findings
  // already shown, and a round with no findings states that plainly.
  const terminalRound = safeRounds.length > 0 ? safeRounds[safeRounds.length - 1] : null;
  const terminalDisposition = terminalRound?.disposition?.disposition;
  if (terminalDisposition === "escalate") {
    const terminalFindings = Array.isArray(terminalRound.findings) ? terminalRound.findings : [];
    const terminalFindingsText = terminalRound.findingsText;
    if (terminalFindings.length > 0) {
      lines.push("");
      lines.push("Escalation decisions (structured findings):");
      lines.push("");
      lines.push(renderEscalationDecisions(terminalFindings, { roundNumber: terminalRound.round }));
    } else if (typeof terminalFindingsText !== "string" || terminalFindingsText.trim() === "") {
      // Neither a structured findings array nor a non-empty findingsText:
      // state the fact plainly, identically to renderEscalateOutcome.
      lines.push("");
      lines.push("Escalation decisions (structured findings):");
      lines.push("");
      lines.push("(no findings recorded for this round)");
    }
    // Old records with a non-empty findingsText keep the per-round findings
    // lines already rendered above; nothing extra is added here.
  }

  // Chain-wide totals
  if (chain?.chainTotals) {
    const t = chain.chainTotals;
    const parts = [`totals: ${t.input || 0} in / ${t.output || 0} out`];
    if (t.reasoning) parts.push(`${t.reasoning} reasoning`);
    if (t.cacheRead !== undefined || t.cacheWrite !== undefined) {
      parts.push(`cacheRead=${t.cacheRead || 0} cacheWrite=${t.cacheWrite || 0}`);
    }
    if (t.cost !== undefined) parts.push(`cost=$${t.cost}`);
    lines.push(parts.join(", "));
  }

  // Follow-up issue draft (Decision 5 accept-with-followup)
  if (chain?.followupIssueDraft) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("Follow-up issue draft:");
    // Split on lines and include each verbatim, preserving the markdown structure
    var draftLines = chain.followupIssueDraft.split("\n");
    for (var dl = 0; dl < draftLines.length; dl++) {
      lines.push(draftLines[dl]);
    }
  }

  return lines.join("\n");
}

// =========================================================================
// Review record rendering (kusabi #52)
//
// The postable markdown record generated when a chain reaches a terminal
// disposition.  Pure: no I/O, no imports from kusabi-companion.mjs.  Same
// tolerance discipline as renderChainShow — partial or minimal records render
// with placeholders/omissions, never throw.
// =========================================================================

const REVIEW_RECORD_BRIEF_TRUNCATE = 80;

/**
 * First line of the brief, truncated for the record title line.
 *
 * @param {string|undefined} brief
 * @returns {string}
 */
function reviewRecordBriefFirstLine(brief) {
  if (!brief || typeof brief !== "string") return "(no brief)";
  const first = brief.split("\n")[0].trim();
  if (first.length > REVIEW_RECORD_BRIEF_TRUNCATE) {
    return first.slice(0, REVIEW_RECORD_BRIEF_TRUNCATE) + "...";
  }
  return first;
}

/**
 * The "Orchestrator:" signature line from the brief (scanned in the first 5
 * lines, mirroring parseOrchestratorSignature), falling back to the parsed
 * orchestrator object when the brief has no line.
 *
 * @param {object} record
 * @returns {string}
 */
function reviewRecordOrchestratorLine(record) {
  const brief = record.brief;
  if (typeof brief === "string") {
    const lines = brief.split("\n");
    const maxLines = Math.min(lines.length, 5);
    for (let i = 0; i < maxLines; i++) {
      const t = (lines[i] || "").trim();
      if (t.startsWith("Orchestrator:")) {
        return t.slice("Orchestrator:".length).trim() || "(none)";
      }
    }
  }
  const o = record.orchestrator;
  if (o && typeof o === "object") {
    const parts = [];
    if (o.model) parts.push(o.model);
    if (o.session) parts.push("session " + o.session);
    if (o.date) parts.push(o.date);
    if (parts.length > 0) return parts.join(" | ");
  }
  return "(none)";
}

/**
 * Model-chain label: the configured ladder (tiers joined with " → ", routes
 * within a tier with ", "), falling back to the models actually used per
 * round when no ladder was recorded.
 *
 * @param {object} record
 * @returns {string}
 */
function reviewRecordModelChain(record) {
  if (Array.isArray(record.modelChain) && record.modelChain.length > 0) {
    return record.modelChain.map(function (tier) {
      return Array.isArray(tier) ? tier.map(String).join(", ") : String(tier);
    }).join(" → ");
  }
  const seen = [];
  const rounds = Array.isArray(record.records) ? record.records : [];
  for (const r of rounds) {
    const m = r?.modelEntry || r?.model;
    if (m && !seen.includes(m)) seen.push(m);
  }
  return seen.join(" → ") || "(unknown)";
}

/**
 * finished: timestamp — the record's own when present and parseable, else
 * the current instant.
 *
 * @param {object} record
 * @returns {string} ISO 8601 string.
 */
function reviewRecordFinishedAt(record) {
  if (record.finishedAt) {
    const d = new Date(record.finishedAt);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

/**
 * One-line probe summary for the record: "P1: HEAD clean — PASS (detail)".
 * Structured JSON details (verify gate) are compacted to their salient
 * fields, like renderChainShow does; plain-text details are truncated.
 *
 * @param {object|null|undefined} probe
 * @returns {string}
 */
function reviewRecordProbeLine(probe) {
  if (!probe || typeof probe !== "object") return "? — unknown";
  const name = probe.probe || "probe";
  const status = probe.passed ? "PASS" : "FAIL";
  let detail = "";
  if (probe.detail) {
    let parsed = null;
    try { parsed = JSON.parse(probe.detail); } catch { /* plain text */ }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const parts = [];
      if (parsed.gate_passed !== undefined) parts.push("gate_passed=" + parsed.gate_passed);
      if (parsed.diff_summary && typeof parsed.diff_summary === "object") {
        const ds = parsed.diff_summary;
        const counts = [];
        if (ds.changed_files !== undefined) counts.push("changed=" + ds.changed_files);
        if (ds.untracked !== undefined) counts.push("untracked=" + ds.untracked);
        if (counts.length > 0) parts.push(counts.join(", "));
      }
      detail = parts.join(", ");
    } else {
      const text = String(probe.detail).replace(/\s+/g, " ").trim();
      detail = text.length > 100 ? text.slice(0, 100) + "..." : text;
    }
  }
  return `${name} — ${status}${detail ? " (" + detail + ")" : ""}`;
}

/**
 * Structured findings of one round: `{severity, text}` rows.
 *
 * Prefers the structured `findings` array; falls back to parsing the
 * machine-generated one-line findingsText ("[severity] title (file:line)").
 * Marker strings like "(no structured findings)" are not findings and are
 * skipped.  Rounds without findings data yield an empty array.
 *
 * @param {object} round
 * @returns {Array<{severity: string, text: string}>}
 */
function reviewRecordRoundFindings(round) {
  const structured = Array.isArray(round.findings)
    ? round.findings.filter(function (f) { return f && typeof f === "object"; })
    : [];
  if (structured.length > 0) {
    return structured.map(function (f) {
      const loc = f.file ? ` (${f.file}${f.line_start !== undefined ? ":" + f.line_start : ""})` : "";
      return { severity: f.severity || "unknown", text: (f.title || "(untitled)") + loc };
    });
  }
  if (typeof round.findingsText === "string" && round.findingsText.trim() !== "") {
    const rows = [];
    for (const raw of round.findingsText.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(/^\[([^\]]+)\]\s*(.+)$/);
      if (!m) continue;
      rows.push({ severity: m[1], text: m[2] });
    }
    return rows;
  }
  return [];
}

/**
 * Render the postable review record for a finished chain (kusabi #52).
 *
 * The record is generated when the chain reaches a terminal disposition
 * (accepted, or terminated by escalate / max-rounds) and is later posted to
 * the archive repository by the orchestrator — the companion never posts.
 * The two "fill at inspection" sections (findings adjudication and precedent)
 * are deliberately left blank for the orchestrator to fill by hand before
 * posting; they are always present, even when the chain produced no findings.
 *
 * Never throws: missing fields render as placeholders/omissions.
 *
 * @param {object|null|undefined} record
 *   - chainId, label (repo/cwd), brief, orchestrator, modelChain, container
 *   - maxRounds, records (round records), chainTotals
 *   - disposition: { disposition, round, reason? } — the FINAL disposition
 *   - finishedAt (ISO, optional; defaults to now)
 * @returns {string} The rendered markdown.
 */
function isReviewUndelivered(r) {
  if (!r || typeof r !== "object") return false;
  if (r.verdictSource === "probe") return false;
  if (Array.isArray(r.probeResults) && r.probeResults.length > 0 && !r.verdict) return true;
  if (r.reviewParseable === false) return true;
  if (r.verdict === "unparseable") return true;
  if (r.verdictSource === "recovered-from-token") return true;
  if (Boolean(r.reviewJobFailure)) return true;
  return false;
}

export function renderReviewRecord(record) {
  const rec = record ?? {};
  const chainId = rec.chainId || "(unknown)";
  const lines = [];

  // ---- header ----
  lines.push(`# [review-record] ${rec.label || "(unknown)"} ${chainId} — ${reviewRecordBriefFirstLine(rec.brief)}`);
  lines.push("");
  lines.push(`Orchestrator: ${reviewRecordOrchestratorLine(rec)} | finished: ${reviewRecordFinishedAt(rec)}`);
  lines.push(`Model chain: ${reviewRecordModelChain(rec)} | container: ${rec.container || "(unknown)"}`);
  if (rec.provisional) {
    lines.push("Note: PROVISIONAL RECORD — chain did not reach a disposition and may be superseded by chain-resume.");
  }
  const disp = rec.disposition || {};
  lines.push(`Final disposition: ${disp.disposition || "unknown"} at round ${disp.round ?? "?"} of ${rec.maxRounds ?? "?"}`);
  lines.push("");

  // ---- rounds ----
  lines.push("## Rounds");
  lines.push("");
  const rounds = Array.isArray(rec.records) ? rec.records : [];
  if (rounds.length === 0) {
    lines.push("(no round records)");
    lines.push("");
  }
  rounds.forEach(function (r, idx) {
    const round = r ?? {};
    const roundNo = round.round ?? idx + 1;
    const model = round.modelEntry || round.model || "?";
    const verdict = round.verdict || "?";
    const verdictSource = round.verdictSource || "parsed";
    const roundDisposition = round.disposition?.disposition ?? "?";
    // The shared changed-column describer (kusabi #299) folds the
    // probe-discard case in; this record's style is lowercase "no" for an
    // ordinary no-change round, so the plain NO value is mapped down (a
    // probe-discard round's value carries the dirty-vs-base wording and is
    // passed through as-is).
    const changedCol = roundChangedColumn(round);
    const changed = changedCol === "NO" ? "no" : changedCol;
    lines.push(`Round ${roundNo} — model: ${model}, verdict: ${verdict} (${verdictSource}), disposition: ${roundDisposition}, changed: ${changed}`);
    // Replacement review seats (kusabi #248): the verdict above came from the
    // LAST seat this round bought.  A seat that died mid-stream is named here
    // so the postable record cannot read as a single clean review.
    for (const seat of (Array.isArray(round.reviewSeatFailures) ? round.reviewSeatFailures : [])) {
      if (!seat || typeof seat !== "object") continue;
      lines.push(`  review seat ${seat.seat ?? "?"}: FAILED (verdict: ${seat.verdict ?? "?"}) — replaced by chain-resume`);
    }
    const probes = Array.isArray(round.probeResults) ? round.probeResults : [];
    for (const probe of probes) {
      lines.push("  " + reviewRecordProbeLine(probe));
    }
    const findings = reviewRecordRoundFindings(round);
    if (findings.length > 0) {
      lines.push("  findings:");
      for (const f of findings) {
        lines.push(`  - [${f.severity}] ${f.text}`);
      }
    }
    lines.push("");
  });

  // ---- findings adjudication (fill at inspection) ----
  lines.push("## Findings adjudication (fill at inspection)");
  lines.push("");
  const allFindings = [];
  for (const r of rounds) {
    allFindings.push(...reviewRecordRoundFindings(r ?? {}));
  }
  if (allFindings.length === 0) {
    const hasUndeliveredReview = rounds.length > 0 && rounds.some(isReviewUndelivered);
    if (hasUndeliveredReview) {
      lines.push("_No review verdict was delivered for this chain — implementation remains unadjudicated._");
      lines.push("");
      lines.push("| # | severity | finding | 採否 | 理由 |");
      lines.push("|---|---|---|---|---|");
      lines.push("| 1 | unknown | _No review verdict delivered — unadjudicated implementation_ | _fill_ | _fill_ |");
    } else {
      lines.push("_No findings were produced by this chain — nothing to adjudicate._");
    }
  } else {
    lines.push("| # | severity | finding | 採否 | 理由 |");
    lines.push("|---|---|---|---|---|");
    allFindings.forEach(function (f, i) {
      lines.push(`| ${i + 1} | ${f.severity} | ${f.text} | _fill_ | _fill_ |`);
    });
  }
  lines.push("");

  // ---- precedent (fill at inspection) ----
  lines.push("## 判例として (fill at inspection)");
  lines.push("");
  lines.push("_fill: reusable precedent, if any_");
  lines.push("");

  // ---- usage (from the chain's chainTotals, never recomputed) ----
  lines.push("## Usage");
  lines.push("");
  const t = rec.chainTotals ?? {};
  const num = function (v) { return Number.isFinite(v) ? v : 0; };
  lines.push(`input=${num(t.input)} output=${num(t.output)} reasoning=${num(t.reasoning)} cacheRead=${num(t.cacheRead)} cacheWrite=${num(t.cacheWrite)} cost=$${num(t.cost)}`);

  return lines.join("\n");
}
