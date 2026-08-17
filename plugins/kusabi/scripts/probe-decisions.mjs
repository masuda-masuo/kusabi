// Probe decision pure functions — deterministic verdict logic for
// deliverables and smoke probes.  No I/O, no imports from kusabi-companion.mjs.

/**
 * Pure function: determine the P3 (deliverables) probe outcome from declared
 * deliverables and the actual changed paths.
 *
 * @param {string[]} deliverables  Declared deliverable paths (parseDeliverables output).
 * @param {string[]} changedPaths  Actual changed paths from git status --porcelain.
 * @param {boolean}  [headingPresent=false]  True when the ## Deliverables heading
 *                      was found in the brief, even if zero entries were parseable.
 * @returns {{ probe: string, passed: boolean, detail: string }}
 */
export function checkDeliverablesProbe(deliverables, changedPaths, headingPresent = false) {
  const probe = "P3: deliverables";
  // Defensive: ensure array inputs
  const delArr = Array.isArray(deliverables) ? deliverables : [];
  const chArr = Array.isArray(changedPaths) ? changedPaths : [];
  // No deliverables declared
  if (delArr.length === 0) {
    if (headingPresent) {
      return { probe, passed: false, detail: "## Deliverables heading present but no entries parsed; check brief syntax" };
    }
    return { probe, passed: true, detail: "no Deliverables declared; check skipped" };
  }
  // Change set empty
  if (chArr.length === 0) {
    return {
      probe,
      passed: false,
      detail: "work set is empty; declared deliverables: " + delArr.join(", "),
    };
  }
  // Check if at least one declared path is touched
  const touched = delArr.some(function (d) {
    return chArr.some(function (cp) {
      // Equal path, or changed path is inside a declared directory
      return cp === d || cp.startsWith(d + "/") || d.startsWith(cp + "/");
    });
  });
  if (touched) {
    return { probe, passed: true, detail: "touches declared deliverables" };
  }
  const delStr = delArr.join(", ");
  const chStr = chArr.join(", ");
  return {
    probe,
    passed: false,
    detail: "no declared deliverable touched; deliverables: [" + delStr + "]; changed: [" + chStr + "]",
  };
}

/**
 * Pure function: determine the P4 (smoke probe) outcome from declared smoke
 * entries and their observed exit codes.
 *
 * @param {Array<{command: string, expectedExit: number}>} entries
 *   Declared smoke entries (parseSmoke output).
 * @param {Array<{command: string, observed: number|string}>} observed
 *   Observed results.  Use the string "timeout" for timed-out commands,
 *   the string "unobservable" when the exit code could not be determined,
 *   or the numeric exit code for executed commands.
 * @param {boolean}  [headingPresent=false]  True when the ## Smoke heading
 *                      was found in the brief, even if zero entries were parseable.
 * @returns {{ probe: string, passed: boolean, detail: string }}
 */
export function checkSmokeProbe(entries, observed, headingPresent = false) {
  const probe = "P4: smoke";
  const entriesArr = Array.isArray(entries) ? entries : [];
  const observedArr = Array.isArray(observed) ? observed : [];

  // No entries
  if (entriesArr.length === 0) {
    if (headingPresent) {
      return { probe, passed: false, detail: "## Smoke heading present but no entries parsed; check brief syntax" };
    }
    return { probe, passed: true, detail: "no Smoke declared; check skipped" };
  }

  const details = [];
  let allPassed = true;

  for (const entry of entriesArr) {
    const obs = observedArr.find(function (o) { return o.command === entry.command; });
    if (!obs) {
      details.push(entry.command + ": not executed");
      allPassed = false;
      continue;
    }
    if (obs.observed === "timeout") {
      let msg = entry.command + ": expected exit " + entry.expectedExit + ", observed timeout";
      if (obs.diagnostic) {
        msg += "\n  ── output tail ──\n" + obs.diagnostic;
      }
      details.push(msg);
      allPassed = false;
      continue;
    }
    if (obs.observed === "unobservable") {
      let msg = entry.command + ": exit code could not be observed";
      if (obs.diagnostic) {
        msg += "\n  ── output tail ──\n" + obs.diagnostic;
      }
      details.push(msg);
      allPassed = false;
      continue;
    }
    if (obs.observed !== entry.expectedExit) {
      let msg = entry.command + ": expected exit " + entry.expectedExit + ", observed exit " + obs.observed;
      if (obs.diagnostic) {
        msg += "\n  ── output tail ──\n" + obs.diagnostic;
      }
      details.push(msg);
      allPassed = false;
      continue;
    }
    details.push(entry.command + ": exit " + obs.observed + " OK");
  }

  if (allPassed) {
    const detail = entriesArr.length === 1
      ? "all smoke command(s) passed"
      : "all " + entriesArr.length + " smoke commands passed";
    return { probe, passed: true, detail: detail };
  }

  return { probe, passed: false, detail: "smoke check failed: " + details.join("; ") };
}

// =========================================================================
// Qualifying refusal (kusabi #293)
// =========================================================================
//
// A worker that finds the brief genuinely self-contradictory and stops with
// zero edits is doing the right thing.  Before this, the machinery could not
// tell that apart from a lazy empty round: the empty change set went to
// `shouldSkipReview` -> verdict `discard` -> escalate, and the only thing
// separating the two was report prose no machine reads.  That is structural
// pressure toward "comply with the nearest satisfiable reading" (weakened
// tests, distorted implementations), which is the measured failure mode of
// cheap workers.
//
// So the refusal gets a machine-readable form.  The functions below are
// PURE -- report text in, verdict out -- and are re-derivable from the round
// record; nothing here holds state.
//
// Parsing is deliberately SHAPE-ONLY (see `verifyRefusalAnchors` below for
// why shape alone is not enough): `parseRefusalBlock` accepts any anchor
// line that LOOKS like a named item, and existence is verified later, at
// classification time, where the brief text and the worktree are in scope.
//
// The block format favours parse robustness over beauty.  A fenced block
// with a fixed info string, two mandatory `anchor:` lines and one `why:`
// line:
//
//     ```kusabi-refusal
//     anchor: ## Frozen tests
//     anchor: plugins/kusabi/scripts/chain-phases.test.mjs
//     why: the frozen section requires every existing test to pass unchanged,
//     while the spec requires the opposite output for the input that test pins.
//     ```
//
// `kusabi-implement.md` teaches exactly this shape.

// A repo path: at least one `/`, no whitespace, optional `:line` suffix.
const ANCHOR_PATH_RE = /^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)+(?::\d+(?:-\d+)?)?$/;
// A bare filename carrying an extension (`chain-phases.test.mjs`).  Must
// start with something other than a dot and end the extension in an
// alphanumeric, so a prose token like `e.g.` or `brief.` never matches.
const ANCHOR_FILE_RE = /^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*\.[A-Za-z0-9]+(?::\d+(?:-\d+)?)?$/;

/**
 * Classify one `anchor:` value as a NAMED item or as free prose.
 *
 * Named means one of exactly two things, because those are the two a machine
 * can check and a human can follow back to a source:
 *   - a brief section heading, written with its markdown marker (`## Frozen
 *     tests`, `### 3.5`); or
 *   - a repo path (`plugins/kusabi/scripts/foo.test.mjs`, `docs/DESIGN.md`),
 *     optionally with a `:line` suffix and optionally followed by a gloss.
 *
 * Free prose ("the brief says the tests must pass") is deliberately NOT an
 * anchor: it is exactly the unfalsifiable claim the named-item requirement
 * exists to keep out, since a spurious refusal is the abuse case here.
 *
 * NAMED here is SHAPE-level only: `## No Such Section` and `src/nonexistent.mjs`
 * pass this function.  Whether the named item actually EXISTS -- a heading
 * the brief really has, a path the worktree really contains -- is verified
 * later, at classification time, by `verifyRefusalAnchors`; a non-existent
 * item counts as unnamed there and cannot qualify a block.
 *
 * @param {string} value  the raw text after `anchor:`
 * @returns {{kind: "brief-section"|"repo-path", name: string, text: string}|null}
 */
export function classifyRefusalAnchor(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;
  // Tolerate the decorations a model reaches for: backticks and quotes.
  const bare = text.replace(/^[`"'*]+/, "").trim();
  if (bare === "") return null;
  if (/^[#§]/.test(bare)) {
    return { kind: "brief-section", name: bare.replace(/[`"'*]+$/, "").trim(), text };
  }
  // A path anchor may carry a gloss after it ("docs/DESIGN.md §7, the ...").
  const token = bare.split(/\s/)[0].replace(/[`"'*,;]+$/, "");
  if (ANCHOR_PATH_RE.test(token) || ANCHOR_FILE_RE.test(token)) {
    return { kind: "repo-path", name: token, text };
  }
  return null;
}

/**
 * Pure function: read a worker report and return what its refusal block says.
 *
 * @param {string} reportText  the implement job's final report.
 * @returns {null|{
 *   qualifies: boolean,
 *   anchors: Array<{kind: string, name: string, text: string}>,
 *   unnamedAnchors: string[],
 *   why: string,
 *   disqualification: string|null,
 * }}
 *   `null` when the report carries no refusal block at all -- the ordinary
 *   case, and the one that must stay byte-for-byte as it was.  Otherwise a
 *   descriptor whose `qualifies` says whether the block met the contract;
 *   a non-qualifying block still comes back (with `disqualification` naming
 *   what was missing) so the orchestrator can see a refusal was ATTEMPTED
 *   rather than reading the round as an ordinary empty one.
 */
export function parseRefusalBlock(reportText) {
  if (typeof reportText !== "string" || reportText === "") return null;
  const lines = reportText.split(/\r?\n/);

  // ---- locate the block ----
  let start = -1;
  let fenceChar = null;
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^[ \t]*(`{3,}|~{3,})[ \t]*kusabi-refusal[ \t]*$/i.exec(lines[i]);
    if (m) {
      start = i;
      fenceChar = m[1][0];
      fenceLen = m[1].length;
      break;
    }
  }
  if (start === -1) return null;

  // An UNTERMINATED block reads to the end of the report on purpose: a report
  // cut short mid-block still named its contradiction, and dropping it would
  // convert a truncation into a discard.
  let end = lines.length;
  const closeRe = new RegExp("^[ \\t]*[" + fenceChar + "]{" + fenceLen + ",}[ \\t]*$");
  for (let i = start + 1; i < lines.length; i++) {
    if (closeRe.test(lines[i])) { end = i; break; }
  }

  // ---- read the fields ----
  const anchorValues = [];
  const whyParts = [];
  const prose = [];
  let lastField = null;
  for (const raw of lines.slice(start + 1, end)) {
    const m = /^[ \t]*[-*]?[ \t]*(anchor|why)[ \t]*:[ \t]*(.*)$/i.exec(raw);
    if (m) {
      lastField = m[1].toLowerCase();
      const value = m[2].trim();
      if (lastField === "anchor") anchorValues.push(value);
      else if (value) whyParts.push(value);
      continue;
    }
    const text = raw.trim();
    if (!text) continue;
    // A wrapped `why:` line continues it; anything else is loose prose, kept
    // only as the fallback explanation below.
    if (lastField === "why") whyParts.push(text);
    else prose.push(text);
  }

  const anchors = [];
  const unnamedAnchors = [];
  for (const value of anchorValues) {
    const anchor = classifyRefusalAnchor(value);
    if (!anchor) {
      if (value) unnamedAnchors.push(value);
      continue;
    }
    // Two spellings of the same item name one thing, not a contradiction.
    if (!anchors.some(function (a) { return a.name === anchor.name; })) anchors.push(anchor);
  }

  // `why:` is the contract, but a block that explained itself without the
  // label still explained itself -- read the loose prose rather than turn an
  // honest refusal into a discard over a missing five-letter key.
  const why = (whyParts.join(" ").trim() || prose.join(" ").trim());

  let disqualification = null;
  if (anchors.length < 2) {
    disqualification = anchors.length === 0
      ? "no named anchors: name each contradicting item with a brief section heading (## ...) or a repo path"
      : "only 1 named anchor (" + anchors[0].name + "): a contradiction needs two named items";
    if (unnamedAnchors.length > 0) {
      disqualification += "; unnamed anchor(s): " + unnamedAnchors.join(" | ");
    }
  } else if (why === "") {
    disqualification = "no `why:` line: state in one line why the two named items cannot both hold";
  }

  return {
    qualifies: disqualification === null,
    anchors,
    unnamedAnchors,
    why,
    disqualification,
  };
}

// =========================================================================
// Anchor existence verification -- shape-only is forgeable
// =========================================================================
//
// `parseRefusalBlock` is deliberately shape-only, and that is a gap: the
// design doc's abuse bound ("the block only qualifies when it names two
// items a human can look up") holds for the TEXT of the anchors but not
// their referents.  `src/nonexistent.mjs` and `## No Such Section` parse as
// named anchors, so a lazy worker that wants an UNCHARGED exit can forge the
// whole block from invented items.  The named-item requirement as shape-only
// keeps out only prose, not invented items.
//
// Existence is therefore verified at CLASSIFICATION time, where the brief
// text and the worktree are both in scope (finishRound in chain-driver.mjs):
//   - a brief-section anchor must match a heading the brief really has; and
//   - a repo-path anchor must be a file or directory the worktree really
//     contains (the driver passes an `fs.existsSync`-based predicate).
// A non-existent item counts as UNNAMED -- disqualifying, with the miss
// recorded -- so a qualifying refusal must name two real, findable items.
// Pure: brief text and an existence predicate in, descriptor out, so the
// fresh path and the resume path derive the same verdict.

/**
 * All `#`-marked heading lines of a brief, marker-stripped and trimmed.
 * Marker depth is dropped (`## Frozen tests` and `#### Frozen tests` both
 * yield `Frozen tests`): an anchor names a section by its text.  Lines
 * inside fenced blocks are not headings, whatever they look like.
 *
 * @param {string} brief  the brief text the round ran under
 * @returns {string[]} heading texts, in order of appearance; `[]` when the
 *   brief is missing or empty.
 */
export function extractBriefHeadings(brief) {
  if (typeof brief !== "string" || brief === "") return [];
  const headings = [];
  let inFence = false;
  let fenceChar = "";
  for (const line of brief.split(/\r?\n/)) {
    const fence = /^[ \t]*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceChar = fence[1][0];
      } else if (line.trim().startsWith(fenceChar.repeat(3))) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const m = /^#{1,6}[ \t]+(.*?)[ \t]*$/.exec(line);
    if (m) {
      // ATX headings may close with trailing `#`s (`## Foo ##`); the text
      // is the part before them.
      const text = m[1].replace(/[ \t]+#+[ \t]*$/, "").trim();
      if (text !== "") headings.push(text);
    }
  }
  return headings;
}

// The anchor's heading text without its markdown marker: `## Frozen tests`
// -> `Frozen tests`, `§3.5` -> `3.5`.  Marker depth does not matter -- the
// item is the section, not the marker.  ATX closing hashes (`## Frozen tests ##`)
// are stripped the same way `extractBriefHeadings` strips them from the brief
// side, so a worker copying a heading verbatim still anchors the same section.
function headingTextOf(name) {
  return String(name)
    .replace(/^[#\u00a7]+[ \t]*/, "")
    .replace(/[ \t]+#+[ \t]*$/, "")
    .trim();
}

// The repo path without its `:line` suffix (`src/foo.mjs:42-44` -> the file
// `src/foo.mjs`): the suffix names a location INSIDE the file, and
// existence is a property of the file.
function repoPathOf(name) {
  return String(name).replace(/:\d+(?:-\d+)?$/, "");
}

// A repo path is usable only when it stays inside the worktree and names a
// repo artifact: no absolute path, no `..` escape, no `.git` plumbing, no
// empty segments.
function isUsableRepoPath(p) {
  return p !== "" && !p.startsWith("/")
    && p.split("/").every((seg) => seg !== "" && seg !== ".." && seg !== ".git");
}

/**
 * Verify that every anchor in a parsed refusal block NAMES A REAL ITEM.
 *
 * Shape-only parsing accepts `src/nonexistent.mjs` and `## No Such Section`;
 * a forged refusal is exactly the abuse case this gate exists to keep out.
 * Before the block may qualify, each anchor must check out against the two
 * things that are in scope at classification time:
 *
 *   - brief-section anchors must match a heading the brief really has
 *     (exact text, or the anchor as an abbreviation of a longer heading --
 *     `§3.5` matches `3.5 Dispositions`, `## Frozen` matches
 *     `## Frozen tests`); and
 *   - repo-path anchors must be a file or directory the worktree really
 *     contains, with the `:line` suffix stripped and `..` / `.git` paths
 *     rejected outright.
 *
 * A non-existent item is treated as UNNAMED: it is appended to
 * `unnamedAnchors` with the reason, and the block qualifies only if at
 * least two verified named items remain (the `why` was checked at parse
 * time).  The `anchors` array is left as parsed -- the round record must
 * show what the worker wrote -- but `qualifies` / `disqualification` are
 * recomputed on the VERIFIED count, so a shape-qualifying block whose items
 * do not exist is downgraded to a non-qualifying one, with the miss
 * recorded in both fields.
 *
 * Pure: brief text and an existence predicate in, descriptor out.  The
 * driver (finishRound) supplies both -- the chain's own brief, and
 * `fs.existsSync` against the worktree -- so the fresh path and the
 * review-resume path derive the same verdict.  A block whose anchors all
 * check out, and a block without an anchor list, come back unchanged.
 *
 * @param {object|null} block  `parseRefusalBlock` output
 * @param {object} [opts]
 * @param {string} [opts.brief]  the brief text; `extractBriefHeadings` is
 *   applied to it.  Missing/empty -> every brief-section anchor is unnamed
 *   (nothing to verify against; the gate errs on the strict side).
 * @param {function(string): boolean} [opts.pathExists]  predicate deciding
 *   whether a repo path exists in the worktree.  Missing -> every
 *   repo-path anchor is unnamed (same strict side).
 * @returns {object|null} the descriptor, possibly downgraded; `null` for
 *   `null` in.
 */
export function verifyRefusalAnchors(block, { brief, pathExists } = {}) {
  if (!block || typeof block !== "object" || !Array.isArray(block.anchors)) return block;
  const headings = extractBriefHeadings(brief);

  // Each missing entry records WHICH anchor failed and WHY, so the
  // orchestrator reads the miss without having to re-derive it.
  const missing = [];
  for (const anchor of block.anchors) {
    if (anchor.kind === "brief-section") {
      const want = headingTextOf(anchor.name);
      const found = headings.some((h) => h === want
        || (h.length > want.length && h.startsWith(want) && /\s/.test(h[want.length])));
      if (!found) missing.push(anchor.name + " (no such heading in the brief)");
    } else if (anchor.kind === "repo-path") {
      const p = repoPathOf(anchor.name);
      const found = isUsableRepoPath(p)
        && typeof pathExists === "function"
        && pathExists(p);
      if (!found) missing.push(anchor.name + " (no such file or directory in the repo)");
    }
  }
  if (missing.length === 0) return block;

  const unnamedAnchors = (Array.isArray(block.unnamedAnchors) ? block.unnamedAnchors : []).concat(missing);
  const namedCount = block.anchors.length - missing.length;

  // Recompute the verdict on the VERIFIED count.  The message shapes mirror
  // parseRefusalBlock's, so the routing reads are unchanged; the misses are
  // appended so the shortfall is self-explanatory.
  let disqualification = null;
  if (namedCount < 2) {
    const named = namedCount === 0
      ? null
      : block.anchors.find((a) => !missing.some((m) => m.startsWith(a.name)));
    disqualification = named
      ? "only 1 named anchor (" + named.name + "): a contradiction needs two named items"
      : "no named anchors: name each contradicting item with a brief section heading (## ...) or a repo path";
  } else if (block.why === "") {
    disqualification = "no `why:` line: state in one line why the two named items cannot both hold";
  }
  if (disqualification !== null) {
    disqualification += "; anchor(s) not found: " + missing.join(" | ");
  }

  return {
    ...block,
    unnamedAnchors,
    qualifies: disqualification === null,
    disqualification,
  };
}

/**
 * Pure function: what a finished implement round's change set plus its
 * refusal block (if any) mean for the round outcome.
 *
 * Three distinctions, and only three:
 *
 *   - empty change set + qualifying block -> `"refusal"`.  The chain
 *     terminates into the orchestrator's hands as a BRIEF defect; the worker
 *     did not fail, so no rework is bought and no discard is charged to the
 *     seat.
 *   - empty change set, no qualifying block (absent, or fewer than two named
 *     anchors) -> `"discard"`, routed exactly as before this existed.
 *   - the round did not stop empty -> `"changed"`, whatever the report says.
 *     A refusal accompanied by edits is not a refusal; the normal routes
 *     apply and the stray block is surfaced on the round record so the
 *     inconsistency reaches the orchestrator instead of vanishing.
 *
 * @param {object} opts
 * @param {boolean} opts.changeSetEmpty  the round changed nothing.  Callers
 *   pass the same signal `shouldSkipReview` decides the discard on, so the
 *   discard branch here cannot drift from the one it divides -- and so the
 *   decision is reached BEFORE a review seat is bought.  (That signal also
 *   requires a non-empty `## Deliverables`, which the dispatch-time brief
 *   lint makes mandatory for every chain, so the two coincide in practice.)
 * @param {object|null} [opts.refusal]  `parseRefusalBlock` output.
 * @returns {{outcome: "refusal"|"discard"|"changed", refusal: object|null,
 *            strayRefusal: object|null, detail: string|null}}
 */
export function classifyRefusalOutcome({ changeSetEmpty, refusal }) {
  const block = refusal && typeof refusal === "object" ? refusal : null;

  if (!changeSetEmpty) {
    return {
      outcome: "changed",
      refusal: null,
      strayRefusal: block,
      detail: block
        ? "refusal block present, but the round did not stop with an empty change set; " +
          "a refusal accompanied by edits is not a refusal"
        : null,
    };
  }

  if (block && block.qualifies) {
    const named = block.anchors.slice(0, 2).map(function (a) { return a.name; }).join(" vs ");
    return {
      outcome: "refusal",
      refusal: block,
      strayRefusal: null,
      detail: named + (block.why ? " — " + block.why : ""),
    };
  }

  return {
    outcome: "discard",
    refusal: null,
    strayRefusal: null,
    detail: block ? "refusal block did not qualify: " + block.disqualification : null,
  };
}
