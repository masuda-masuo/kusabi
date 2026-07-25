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
