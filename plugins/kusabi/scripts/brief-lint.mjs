// brief-lint: the dispatch-time brief checks moved out of kusabi-companion.mjs
// verbatim (pure move refactor): readBriefFile and the kusabi #289 dispatch-time
// brief lint report.  No behaviour change.

import {
  hasSectionHeading,
  parseDeliverables,
  parseFrozenTests,
  parseOrchestratorSignature,
  zeroEntrySections,
  findFrozenQualifierItems,
  parsePremises,
  presentHeadings,
  sectionText,
  parseSmoke,
} from "./brief-parsing.mjs";
import fs from "node:fs";

/**
 * Read the brief text from a file or return the inline text.
 * Throws a clear error when `--brief-file` and inline text are both provided,
 * or when the file cannot be read.
 *
 * @param {object} flags  - Parsed flags from parseArgs (may contain "brief-file")
 * @param {string} text   - Inline text (may be empty)
 * @returns {string} The resolved brief text.
 */
export function readBriefFile(flags, text) {
  if (flags["brief-file"]) {
    if (text) throw new Error("--brief-file and inline text are mutually exclusive");
    try {
      return fs.readFileSync(flags["brief-file"], "utf8").trim();
    } catch (err) {
      throw new Error(`--brief-file: cannot read ${flags["brief-file"]}: ${err.message}`);
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// dispatch-time brief lint (kusabi #289)
// ---------------------------------------------------------------------------

/**
 * The dispatch-time refusal text for a brief that is missing something the
 * companion MACHINE-READS, or null when nothing required is missing.
 *
 * This is a REFUSAL in the shape of the lossy-smoke check (kusabi #250,
 * `smokeViolationReport`): same stage (before any job directory or chain
 * state exists), same self-explaining tone, and every line names both the
 * offending part and the remedy — a denial without the remedy just pushes the
 * author onto a worse path.
 *
 * The gap it closes is that absence was SILENT.  The companion parses the
 * signature line, `## Deliverables` and `## Smoke`, but a brief missing one of
 * them dispatched anyway: the deliverables probe then discards a round whose
 * section never existed, an unsigned brief cannot be attributed back to who
 * wrote it, and an implement worker with neither `--container` nor a
 * `## Workplace` section has nowhere to read its container id from (the
 * kusabi #289 incident).  All three are decidable from the brief text and the
 * flags, with no I/O, so the cheap moment to stop is before dispatch.
 *
 * Scope, deliberately narrow (kusabi #289 non-goals): nothing here changes
 * what a section MEANS or how it parses — only whether absence refuses.  The
 * deliverables and container-source rules apply to the implement phase and to
 * a chain being started (an implement chain); other phases keep exactly the
 * brief requirements they had, plus the signature line.  An ad-hoc `task`
 * with no `--phase` at all is not a phase dispatch and is left alone: it is
 * the `/kusabi:task <free text>` surface, not an orchestrator's brief.
 *
 * The container-source rule never fires for a chain: `chain` refuses without
 * `--container` on its own, ahead of this call, with a message that already
 * names the flag.
 *
 * kusabi #302 extends the SAME zero-entries rule to the other two sections a
 * probe machine-reads, `## Smoke` and `## Frozen Tests`: a heading that parses
 * to nothing declares a check that cannot run, and its probe (P4/P5) reads the
 * BRIEF, so the failure repeats every round and no worker edit can fix it.
 * For `## Frozen Tests`, absence still refuses nothing (the section stays
 * optional).  For `## Smoke`, absence refuses when chain || phase === "implement"
 * (kusabi #662); other phases keep Smoke optional.  Membership test for zero-entry
 * headings comes from `zeroEntrySections`, i.e. the probes' own parsers, so a
 * brief this lint accepts cannot fail P3/P4/P5 on that rule.
 *
 * kusabi #662 also refuses Deliverables entries whose unquoted first token is a
 * bare word without `/` or `.` (e.g. `Update`, `Ensure`).
 *
 * @param {object} opts
 * @param {string|null|undefined} opts.brief      The brief text.
 * @param {string|null} [opts.phase]              The resolved --phase, or null.
 * @param {string|null} [opts.container]          The --container value, or null.
 * @param {boolean} [opts.chain=false]            True when a chain is starting.
 * @returns {string|null}
 */
function extractSectionItems(text) {
  if (!text) return [];
  const lines = text.split("\n");
  const items = [];
  let inCodeBlock = false;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      if (trimmed !== "") {
        items.push({ content: trimmed, source: "code-block", raw: line, lineNumber: li + 1 });
      }
      continue;
    }
    let bulletMatch = trimmed.match(/^[-*+]\s+(.*)/);
    if (bulletMatch) {
      const content = bulletMatch[1].trim();
      if (content) items.push({ content, source: "bullet", raw: line, lineNumber: li + 1 });
      continue;
    }
    bulletMatch = trimmed.match(/^\d+[.)]\s+(.*)/);
    if (bulletMatch) {
      const content = bulletMatch[1].trim();
      if (content) items.push({ content, source: "bullet", raw: line, lineNumber: li + 1 });
      continue;
    }
  }
  return items;
}

export function briefLintReport({ brief, phase = null, container = null, chain = false }) {
  const isImplement = chain || phase === "implement";
  const problems = [];

  if (isImplement && parseDeliverables(brief).length === 0) {
    problems.push(
      "  - `## Deliverables` is absent or parses to zero entries: the deliverables probe reads that " +
      "section, and a round that changes none of the files it names is discarded. Add the section " +
      "and list the files that must change, one per bullet, each path backtick-quoted."
    );
  }

  // ---- bare-word Deliverables entry (kusabi #662) ----
  if (isImplement) {
    const deliverablesItems = extractSectionItems(sectionText(brief, "Deliverables"));
    for (const item of deliverablesItems) {
      const content = item.content.trim();
      const backtickMatch = content.match(/^`([^`]+)`/);
      let isQuoted = false;
      let pathToken = null;
      if (backtickMatch) {
        isQuoted = true;
        pathToken = backtickMatch[1];
      } else {
        const tokens = content.split(/\s+/);
        pathToken = tokens[0];
      }
      if (!pathToken) continue;
      pathToken = pathToken.replace(/[,;.:!?]+$/, "").trim();
      const isPathLike = pathToken.includes("/") || pathToken.includes(".");
      pathToken = pathToken.replace(/\/+$/, "");

      if (!isQuoted && !isPathLike) {
        const rawLine = item.raw ? item.raw.trim() : item.content;
        const formattedLine = rawLine.length > 120 ? `${rawLine.slice(0, 120)}…` : rawLine;
        problems.push(
          "  - `## Deliverables` entry has a bare word as its path: \"" + formattedLine + "\". " +
          "The deliverables probe reads the first token as a file path, so a bare word causes every round to fail P3. " +
          "Deliverables entries must start with a file path; backtick-quote bare root names like `Dockerfile`. " +
          "Accepted shape: `- path/to/file.ext — what changes`."
        );
      }
    }
  }

  // ---- Smoke required for implement (kusabi #662) ----
  if (isImplement && !hasSectionHeading(brief, "Smoke")) {
    problems.push(
      "  - `## Smoke` is absent: the smoke probe reads that section to verify behaviour before " +
      "accepting a round. Add a `## Smoke` section with at least one cheap deterministic command " +
      "that exercises the changed behaviour, as a bullet with a backtick-quoted command and " +
      "optional `exit <N>`, or a fenced code block; mark a line that is red on the untouched " +
      "checkout (new file, new test) with `baseline-red`."
    );
  }

  if (isImplement && !container && !hasSectionHeading(brief, "Workplace")) {
    problems.push(
      "  - no container source for the implement phase: neither `--container <cid>` on the command " +
      "line nor a `## Workplace` section in the brief. The worker cannot guess a container name " +
      "(kusabi #289: ten failed sandbox_attach guesses, 171s, zero edits). Pass `--container <cid>`, " +
      "or name the container in a `## Workplace` section of the brief."
    );
  }

  // ---- zero-entry `## Smoke` / `## Frozen Tests` (kusabi #302) ----
  // The same rule the `## Deliverables` line above applies to its own
  // section, applied to the other two sections a probe machine-reads.  A
  // heading followed by prose (`(none frozen by name — …)`) declares a check
  // that CANNOT run: P4/P5 fail on "heading present but no entries parsed"
  // every round, and the input they read is the brief, which no worker can
  // edit — the incident (chain-msvwhslx6e60, 2026-08-17) spent a whole
  // 4-round budget on reworks that were unwinnable by construction.  The
  // decision needs nothing but the brief text, so the cheap moment to stop is
  // before dispatch.
  //
  // Absence is NOT emptiness: both sections stay optional, and a brief with
  // no such heading is untouched here.  The entries come from
  // `zeroEntrySections`, which calls the probes' own parsers — so a brief this
  // lint accepts cannot fail P3/P4/P5 on the zero-entries rule.  Deliverables
  // is skipped: its own line above already refuses that case, and doubling it
  // would report one defect twice.
  if (chain || phase) {
    for (const section of zeroEntrySections(brief)) {
      if (section.heading === "Deliverables") continue;
      const firstLine = section.firstLine ? section.firstLine.trim() : null;
      const formattedLine = firstLine
        ? (firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine)
        : null;
      const quotePart = formattedLine
        ? `Its lines were not recognised as entries (first line: "${formattedLine}"). `
        : "";
      problems.push(
        "  - `" + section.label + "` is present but parses to zero entries: the " + section.probe +
        " probe reads that section from the BRIEF, so it would fail on syntax every round and no " +
        "worker edit could turn it green (kusabi #302). " +
        quotePart +
        "Write entries as " + section.syntax + "; or delete the heading entirely " +
        "— an empty section must omit its heading."
      );
    }
  }

  // ---- Frozen Tests qualifier (kusabi #386) ----
  // A `## Frozen Tests` bullet whose path token is surrounded by leftover prose
  // outside the backtick pair — before (`do not weaken`), after (`you may
  // append; do not weaken`), or both — is a contract P5 cannot enforce.  P5 freezes by PATH and discards the brief
  // author's own words, so a worker that obeys the prose (append-only) is
  // flagged as an oracle violation and the chain escalates — the worker cannot
  // win because the probe's input is the brief (henshusha chain-mtaa2btyd78c,
  // 2026-08-27).  The fix is dispatch-time, like #302: refuse the brief and
  // name both remedies.  P5 itself stays path-intersection; we do NOT teach the
  // probe to read diffs and add no `append-ok` annotation — the new check is
  // lint, not a change to the path parser.  `parseFrozenTests` is untouched, so
  // a qualifying bullet still parses to the same path array as today, and a
  // clean Frozen section (path-only bullets / code-block) returns nothing here.
  // Ad-hoc `/kusabi:task` text (no --phase, no chain: true) stays untouched,
  // matching #302.
  if (chain || phase) {
    for (const q of findFrozenQualifierItems(brief)) {
      problems.push(
        "  - `## Frozen Tests` entry `" + q.path + "` carries leftover text the frozen-oracle " +
        "cannot see: \"" + q.remainder + "\". P5 freezes by path and drops that text, so a worker " +
        "that obeys it (for example by appending) is flagged as an oracle violation and the chain " +
        "escalates — neither the worker nor the probe can fix it (kusabi #386, henshusha " +
        "chain-mtaa2btyd78c). Two remedies: if append is allowed, do not freeze that path — put " +
        "\"do not weaken existing tests\" in the Acceptance criteria and put new tests in a " +
        "different file if they must be frozen; if the path must stay frozen, the entry is the " +
        "path alone, with no 但し書き."
      );
    }
  }

  // ---- Deliverables / Frozen Tests overlap ----
  if (chain || phase) {
    const stripDotSlash = (p) => (p.startsWith("./") ? p.slice(2) : p);
    const deliverables = parseDeliverables(brief);
    const frozenTests = parseFrozenTests(brief);
    if (deliverables.length > 0 && frozenTests.length > 0) {
      const frozenNorm = new Set(frozenTests.map(stripDotSlash));
      const seen = new Set();
      for (const d of deliverables) {
        const norm = stripDotSlash(d);
        if (frozenNorm.has(norm) && !seen.has(norm)) {
          seen.add(norm);
          problems.push(
            `  - \`${d}\` is listed under both \`## Deliverables\` and \`## Frozen Tests\`: ` +
            "the deliverables probe needs it changed while P5 fails any change to it so no worker can win. " +
            "Frozen Tests lists only existing tests the worker must not modify; a test file the worker is " +
            "expected to write or edit belongs in Deliverables only."
          );
        }
      }
    }
  }

  // ---- Premises shape and guard (kusabi #536) ----
  if (chain || phase) {
    if (hasSectionHeading(brief, "Premises")) {
      const premises = parsePremises(brief);
      if (premises.length === 0) {
        problems.push(
          "  - `## Premises` is present but parses to zero entries: heading present but no entries; " +
          "delete the heading if there are no premises (kusabi #536)."
        );
      } else {
        const headings = presentHeadings(brief)
          .map((h) => h.replace(/\s*\(.*?\)$/, "").trim())
          .filter((h) => h.toLowerCase() !== "premises" && h.length > 0);

        for (const item of premises) {
          const itemFlaws = [];
          if (!item.measured) {
            itemFlaws.push("no `measured:` field (a premise with no number hides its sample size)");
          } else if (!/\d/.test(item.measured)) {
            itemFlaws.push("`measured:` contains no digit (a premise must carry its sample size / count; a premise with no number hides its sample size)");
          }
          if (!item.guard) {
            itemFlaws.push("no `guard:` field (a premise with no guard is a bet on the whole round)");
          } else {
            const hasMatchingHeading = headings.some((h) => item.guard.toLowerCase().includes(h.toLowerCase()));
            if (!hasMatchingHeading) {
              itemFlaws.push("`guard:` does not name any `## ` heading that exists in the brief (a premise with no guard is a bet on the whole round)");
            }
          }
          if (itemFlaws.length > 0) {
            problems.push(
              `  - \`## Premises\` item on line ${item.lineNumber} ("${item.claim}"): ${itemFlaws.join("; ")} (kusabi #536).`
            );
          }
        }
      }
    }
  }

  // ---- /tmp evidence must be read by Smoke (kusabi #536) ----
  if (chain || phase) {
    const workplaceText = sectionText(brief, "Workplace");
    if (workplaceText) {
      const rawMatches = workplaceText.match(/\/tmp\/[^\s`'"\),]+/g) || [];
      const distinctPaths = new Set();
      for (const m of rawMatches) {
        const cleaned = m.replace(/[.\/]$/, "");
        if (cleaned) {
          distinctPaths.add(cleaned);
        }
      }
      const smokeEntries = parseSmoke(brief);
      for (const evidencePath of distinctPaths) {
        const covered = smokeEntries.some((e) => e.command && e.command.includes(evidencePath));
        if (!covered) {
          problems.push(
            `  - evidence path \`${evidencePath}\` named in \`## Workplace\` has no reading \`## Smoke\` entry: ` +
            "evidence shipped into the container must prove itself through a Smoke line that reads it " +
            "(e.g. a non-empty check), so the dispatch-time baseline refuses unusable evidence " +
            "(kusabi #536; the empty-SQLite incident)."
          );
        }
      }
    }
  }

  if ((chain || phase) && !parseOrchestratorSignature(brief)) {
    problems.push(
      "  - the orchestrator signature line is absent: add " +
      "`Orchestrator: <model-id> | session <id> | <date>` among the FIRST 5 lines of the brief. " +
      "Without it the job/chain record carries no orchestrator, and discard/rework rates cannot be " +
      "attributed back to who wrote the brief."
    );
  }

  if (problems.length === 0) return null;
  return [
    `brief rejected before dispatch: ${problems.length} problem` +
    `${problems.length === 1 ? "" : "s"} found (kusabi #289). ` +
    "Nothing was started; fix the brief and re-run.",
    ...problems,
  ].join("\n");
}
