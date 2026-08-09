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

  // Backend-aware header/session lines (kusabi #184 Job B): a missing
  // `backend` field predates the backend split and means opencode, so the
  // opencode output stays byte-identical.  A claude job shows the claude
  // continuation shape (`claude -p --resume <id>`); the session id is the
  // one recorded on the job (a UUID for claude, ses_* for opencode).
  const isClaude = job.backend === "claude";

  return [
    `${isClaude ? "claude" : "opencode"} ${job.kind} ${job.id} — ${job.status} (${durationS(job)}s)`,
    isClaude
      ? `session: ${job.sessionID} (continue in claude: \`claude -p --resume ${job.sessionID}\`)`
      : `session: ${job.sessionID} (continue in opencode: \`opencode -s ${job.sessionID}\`)`,
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

const DIFF_BUDGET = 30000;
const PRIOR_FINDINGS_BUDGET = 8000;

export function renderBaseFacts({ baseSha, baseLog, statusOutput, diffContent, untrackedFiles } = {}) {
  const parts = [];
  parts.push("### Base change-set context (machine-recorded)");
  parts.push("");
  if (baseSha) {
    parts.push("- Base commit: `" + baseSha + "`");
  } else {
    parts.push("- Base commit: (unavailable)");
  }
  parts.push("");
  parts.push("Recent base history (top 5):");
  parts.push("```");
  parts.push(baseLog || "(unavailable)");
  parts.push("```");
  parts.push("");
  parts.push("Actual change set (`git status --porcelain`):");
  parts.push("```");
  parts.push(statusOutput || "(empty change set)");
  parts.push("```");
  parts.push("");

  // Diff content (with character budget)
  if (diffContent && diffContent.trim()) {
    const truncated = diffContent.length > DIFF_BUDGET;
    const content = truncated ? diffContent.slice(0, DIFF_BUDGET) : diffContent;
    const budgetNote = truncated
      ? " (truncated to " + DIFF_BUDGET + " characters)"
      : "";
    parts.push("Diff content" + budgetNote + ":");
    parts.push("```diff");
    parts.push(content);
    parts.push("```");
    parts.push("");
    if (truncated) {
      parts.push("**Diff truncated.** Use `diff_in_container` to see the full diff.");
      parts.push("");
    }
  } else {
    parts.push("Diff content: (unavailable)");
    parts.push("");
  }

  // Untracked files
  if (untrackedFiles && untrackedFiles.trim()) {
    const untrackedList = untrackedFiles.split("\n").filter(function (l) { return l.trim(); }).map(function (l) { return l.trim(); });
    if (untrackedList.length > 0) {
      parts.push("New (untracked) files:");
      for (const f of untrackedList) {
        parts.push("- `" + f + "`");
      }
      parts.push("");
      parts.push("Use `read_file_range` to inspect these new files.");
      parts.push("");
    }
  }

  parts.push("Review ONLY this change set. Code that is already part of the base (see the log above) is NOT scope creep and must not be flagged as such.");
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
    return `escalated at round ${lastRound.round} (${lastRound.disposition.reason || "unknown"})`;
  }
  return null;
}

function resolveChainStatus(control, rounds) {
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

export function renderChainShow(chain, rounds, unreadable = [], control = null) {
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

    // Verdict
    if (round.verdict) {
      const parseableNote = round.reviewParseable === false ? " (unparseable)" : "";
      lines.push(`  verdict: ${round.verdict}${parseableNote}`);
    }

    // Disposition + reason
    if (round.disposition) {
      const disp = round.disposition.disposition || "unknown";
      const reason = round.disposition.reason ? ` (${round.disposition.reason})` : "";
      lines.push(`  disposition: ${disp}${reason}`);
    }

    // Worktree change status (baseline-aware)
    // null and undefined both mean "unknown" — null happens when the per-round
    // capture failed; undefined means the record predates the baseline feature.
    if (round.worktreeChanged === undefined || round.worktreeChanged === null) {
      lines.push(`  changed: unknown`);
    } else {
      const wc = round.worktreeChanged ? "yes" : "NO";
      lines.push(`  changed: ${wc}`);
    }

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
export function renderReviewRecord(record) {
  const rec = record ?? {};
  const chainId = rec.chainId || "(unknown)";
  const lines = [];

  // ---- header ----
  lines.push(`# [review-record] ${rec.label || "(unknown)"} ${chainId} — ${reviewRecordBriefFirstLine(rec.brief)}`);
  lines.push("");
  lines.push(`Orchestrator: ${reviewRecordOrchestratorLine(rec)} | finished: ${reviewRecordFinishedAt(rec)}`);
  lines.push(`Model chain: ${reviewRecordModelChain(rec)} | container: ${rec.container || "(unknown)"}`);
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
    const changed = (round.worktreeChanged === undefined || round.worktreeChanged === null)
      ? "unknown" : round.worktreeChanged ? "yes" : "no";
    lines.push(`Round ${roundNo} — model: ${model}, verdict: ${verdict} (${verdictSource}), disposition: ${roundDisposition}, changed: ${changed}`);
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
    lines.push("_No findings were produced by this chain — nothing to adjudicate._");
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
