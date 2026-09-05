// Chain status and round display.

import { effectiveStatus } from "./chain-control.mjs";
import { renderEscalationDecisions } from "./render-prompt.mjs";

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

