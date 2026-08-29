// Code grader for adversarial review-quality evaluation.
//
// This module grades schema-valid review findings against a small set of
// in-tree "planted bug" gold targets. It is a pure module: it holds no
// retained state and never dispatches a review. CI uses it to grade canned
// JSON only — no live LLM reviews are run.
//
// The single location where a finding is judged a hit or a miss is
// isFindingHit(finding, gold):
//   - Hit iff the normalized finding.file equals gold.file, AND the inclusive
//     line range [line_start, line_end] overlaps the gold range (after any
//     reversed range is swapped to [min, max]).
//   - Location-only. gold.kind documents the planted bug class and is NOT
//     required to match finding.kind: reviewers omit or mis-tag the optional
//     kind, so scoring is on file + line overlap alone.
//
// Headline metric: pass^k — every trial hit. Companion pass@k reports whether
// any trial hit. passK / passAtK take an array of per-trial booleans (each one
// the `hit` value produced by gradeReview).

// Only the known container cwd is stripped. Arbitrary absolute prefixes
// (e.g. /home/x/bug.js) are NOT normalized away — they simply will not match
// repo-relative gold paths.
const WORKSPACE_PREFIX = "/workspace/";

function normalizeFile(file) {
  if (typeof file !== "string" || file.length === 0) return null;
  if (file.startsWith(WORKSPACE_PREFIX)) {
    return file.slice(WORKSPACE_PREFIX.length);
  }
  return file;
}

// Returns [min, max] for the finding/gold line range, or null when the range
// is unusable (missing or non-numeric line numbers).
function toRange(obj) {
  const start = obj?.line_start;
  const end = obj?.line_end;
  if (typeof start !== "number" || typeof end !== "number") return null;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return [Math.min(start, end), Math.max(start, end)];
}

function rangesOverlap(a, b) {
  return a[0] <= b[1] && b[0] <= a[1];
}

/**
 * Decide whether a single finding is a hit against the gold target.
 * This is the ONLY place that decides hit vs miss for a finding.
 *
 * @param {{file?:string, line_start?:number, line_end?:number, kind?:string}} finding
 * @param {{file:string, line_start:number, line_end:number, kind?:string}} gold
 * @returns {boolean}
 */
export function isFindingHit(finding, gold) {
  const file = normalizeFile(finding?.file);
  if (file === null) return false;
  if (typeof gold?.file !== "string" || gold.file.length === 0) return false;
  if (file !== gold.file) return false;

  const fRange = toRange(finding);
  const gRange = toRange(gold);
  if (fRange === null || gRange === null) return false;

  return rangesOverlap(fRange, gRange);
}

/**
 * Grade an entire review's findings against a gold target.
 *
 * @param {Array} findings  The review's findings array.
 * @param {object} gold     The gold target {file, line_start, line_end, kind?}.
 * @returns {{hit: boolean, noise: number, total: number}}
 *   hit   — true if any finding hits.
 *   noise — count of findings that are NOT hits.
 *   total — findings.length.
 */
export function gradeReview(findings, gold) {
  const list = Array.isArray(findings) ? findings : [];
  let hit = false;
  let noise = 0;
  for (const f of list) {
    if (isFindingHit(f, gold)) {
      hit = true;
    } else {
      noise += 1;
    }
  }
  return { hit, noise, total: list.length };
}

// Coerce a trial entry (a boolean, or a gradeReview result carrying a boolean
// `hit`) to a boolean hit flag. Anything else is rejected: scoring trials must
// be explicit booleans, never truthy objects.
function asHit(trial) {
  if (typeof trial === "boolean") return trial;
  if (
    trial !== null &&
    typeof trial === "object" &&
    !Array.isArray(trial) &&
    "hit" in trial &&
    typeof trial.hit === "boolean"
  ) {
    return trial.hit;
  }
  throw new TypeError(
    "passK/passAtK require booleans or {hit: boolean} entries, got: " +
      typeof trial
  );
}

/**
 * pass^k headline: every trial hit.
 * An empty trial set is not a pass (there is nothing to pass on).
 *
 * @param {Array<boolean|{hit:boolean}>} trials
 * @returns {boolean}
 */
export function passK(trials) {
  if (!Array.isArray(trials) || trials.length === 0) return false;
  return trials.every((t) => asHit(t) === true);
}

/**
 * pass@k: any trial hit.
 * An empty trial set is not a pass (there is nothing to pass on).
 *
 * @param {Array<boolean|{hit:boolean}>} trials
 * @returns {boolean}
 */
export function passAtK(trials) {
  if (!Array.isArray(trials) || trials.length === 0) return false;
  return trials.some((t) => asHit(t) === true);
}
