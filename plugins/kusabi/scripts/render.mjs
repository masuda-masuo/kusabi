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

  return [
    `opencode ${job.kind} ${job.id} — ${job.status} (${durationS(job)}s)`,
    `session: ${job.sessionID} (continue in opencode: \`opencode -s ${job.sessionID}\`)`,
    ...(job.phase ? [`phase: ${job.phase}`] : []),
    ...(routeLine.length ? routeLine : []),
    ...usageLine,
    ...errorLines,
    ...fallbackLines,
    "",
  ].join("\n");
}

export function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        return null;
      }
    }
    return null;
  }
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
  const findings = parsed.findings ?? [];
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
  const next = parsed.next_steps ?? [];
  if (next.length) {
    lines.push("**Next steps:**");
    next.forEach((s) => lines.push(`- ${s}`));
  }
  const unverified = parsed.unverified ?? [];
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

/**
 * Render the prior-findings block for a rework round's implement prompt.
 *
 * When the previous round record carries a structured `findings` array
 * (severity, title, body, recommendation etc.), each finding is rendered
 * in full.  The block is bounded by `PRIOR_FINDINGS_BUDGET` characters;
 * when exceeded, a truncation note is appended.
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

  const parts = [];
  for (const f of findings) {
    const severity = f.severity || "unknown";
    const title = f.title || "(untitled)";
    const file = f.file || "?";
    const lineStart = f.line_start !== undefined ? f.line_start : "?";

    parts.push(`### [${severity}] ${title} (${file}:${lineStart})`);
    parts.push("");
    if (f.body) {
      parts.push(f.body);
      parts.push("");
    }
    if (f.recommendation) {
      parts.push(`**Recommendation:** ${f.recommendation}`);
      parts.push("");
    }
  }

  let text = parts.join("\n");

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
      lines.push(`  tier:${tierArrow}`);
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
