// worktree-baseline.mjs — Content-sensitive worktree fingerprint for
// measuring what a chain round changed, not what the tree happens to contain.
//
// Every function here is either a pure function or takes an injected callTool
// for container interaction.  No I/O module imports from this module.
//
// The baseline captures the content state (SHA hashes via git hash-object)
// of every file in the worktree that differs from HEAD — both modified
// tracked files and untracked files.  At probe time a fresh capture is
// compared against the baseline; only files whose content hash differs are
// counted as "changed by this round".
//
// Taking the measurement uses GIT_INDEX_FILE pointing at a temporary file
// so the real index is never modified.

/**
 * Capture the current worktree content state from inside the container.
 *
 * Uses a temporary index (GIT_INDEX_FILE) so the real index is untouched.
 * The worktree and HEAD are not modified either.  Note that `git add` does
 * write blob objects (and `write-tree` a tree object) into the repository's
 * object store; those are unreferenced and collected by `git gc`.  The claim
 * is "does not change what the orchestrator would publish", not "writes
 * nothing at all".
 * Returns a manifest with a tree hash (SHA of the logical tree) and a
 * per-file path → hash map.
 *
 * @param {Function} callTool   The RPC callTool function (injectable).
 * @param {string}   container  Container ID.
 * @returns {Promise<Object|null>} Manifest with:
 *   - treeHash {string} — combined tree hash representing the entire worktree
 *   - files   {Object<string,string>} — relative-path → content-SHA mapping
 *   Returns null when the capture fails.
 */
export async function captureWorktreeState(callTool, container) {
  // Single shell command: copy the real index to a temp file, use it for
  // git add -A + git write-tree, list all entries with content hashes,
  // then clean up.  The real index, the worktree and HEAD are never touched.
  //
  // The temp index is removed by an EXIT trap rather than by a trailing
  // command: an &&-chained cleanup is skipped exactly when an earlier step
  // fails, which is when a stale copy of the index would be left behind.
  const commands = [
    "cd /workspace && " +
    'TMPIDX=$(mktemp /tmp/kb-XXXXXX.idx 2>/dev/null) && ' +
    'trap \'rm -f "$TMPIDX"\' EXIT && ' +
    'cp .git/index "$TMPIDX" 2>/dev/null || { echo "ERROR_NO_INDEX"; exit 1; } && ' +
    'GIT_INDEX_FILE="$TMPIDX" git add -A 2>/dev/null && ' +
    'TREE=$(GIT_INDEX_FILE="$TMPIDX" git write-tree 2>/dev/null) && ' +
    'echo "TREE_HASH=$TREE" && ' +
    "GIT_INDEX_FILE=\"$TMPIDX\" git ls-files --stage 2>/dev/null | " +
    "awk -F'\\t' '{n=split($1,a,\" \"); print a[2] \"|\" $2}'",
  ];

  let result;
  try {
    result = await callTool("sandbox_exec", {
      container_id: container,
      commands,
    });
  } catch {
    return null;
  }

  const output = (result?.output ?? "").trim();
  if (!output || output.includes("ERROR_NO_INDEX")) return null;

  const lines = output.split("\n").filter(Boolean);
  const files = {};
  let treeHash = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("TREE_HASH=")) {
      treeHash = trimmed.slice("TREE_HASH=".length).trim();
    } else if (trimmed.includes("|")) {
      const pipeIdx = trimmed.indexOf("|");
      const hash = trimmed.slice(0, pipeIdx).trim();
      const filePath = trimmed.slice(pipeIdx + 1).trim();
      if (hash && filePath) {
        files[filePath] = hash;
      }
    }
  }

  if (!treeHash) return null;

  return { treeHash, files };
}

/**
 * Pure function: given two manifests, return the set of paths whose content
 * hash differs between them.
 *
 * @param {Object|null|undefined} baseline  Earlier manifest.
 * @param {Object|null|undefined} current   Later manifest.
 * @returns {string[]|null} Paths with different content hashes, or `null` when
 *   either manifest is missing.  `null` means "could not be determined" and is
 *   deliberately not `[]`: an empty array asserts that nothing changed, and a
 *   caller that skips review on "nothing changed" would then discard a round
 *   purely because the measurement failed.
 */
export function computeNewlyChanged(baseline, current) {
  if (!baseline || !current) return null;

  const baselineFiles = baseline.files || {};
  const currentFiles = current.files || {};

  // Collect the union of all keys
  const allPaths = new Set([
    ...Object.keys(baselineFiles),
    ...Object.keys(currentFiles),
  ]);

  const changed = [];
  for (const p of allPaths) {
    if (baselineFiles[p] !== currentFiles[p]) {
      changed.push(p);
    }
  }

  return changed;
}

/**
 * Pure function: determine whether the worktree is byte-identical to the
 * baseline.
 *
 * @param {Object|null|undefined} baseline
 * @param {Object|null|undefined} current
 * @returns {boolean} True when both exist and have the same treeHash.
 *   Returns false when either input is missing.
 */
export function isWorktreeUnchanged(baseline, current) {
  if (!baseline || !current) return false;
  return baseline.treeHash === current.treeHash;
}

/**
 * Pure function: determine the P3 (deliverables) probe outcome from declared
 * deliverables and the set of paths that are NEWLY changed since the baseline.
 *
 * Exactly the same contract as checkDeliverablesProbe in probe-decisions.mjs
 * but feeds in only the paths the current round actually touched.
 *
 * @param {string[]}           deliverables  Declared deliverables.
 * @param {string[]}           newlyChanged  Paths changed since baseline.
 * @param {boolean}            [headingPresent=false]
 * @returns {{ probe: string, passed: boolean, detail: string }}
 */
export function checkDeliverablesSinceBaseline(
  deliverables,
  newlyChanged,
  headingPresent = false,
) {
  const probe = "P3: deliverables";
  const delArr = Array.isArray(deliverables) ? deliverables : [];
  const chArr = Array.isArray(newlyChanged) ? newlyChanged : [];

  // No deliverables declared
  if (delArr.length === 0) {
    if (headingPresent) {
      return {
        probe,
        passed: false,
        detail:
          "## Deliverables heading present but no entries parsed; check brief syntax",
      };
    }
    return { probe, passed: true, detail: "no Deliverables declared; check skipped" };
  }

  // Round changed nothing at all — different from "changed something but not
  // the deliverables"
  if (chArr.length === 0) {
    return {
      probe,
      passed: false,
      detail:
        "no paths changed since baseline; declared deliverables: " +
        delArr.join(", "),
    };
  }

  // Check if at least one declared path is among the newly changed files
  const touched = delArr.some(function (d) {
    return chArr.some(function (cp) {
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
    detail:
      "no declared deliverable touched; deliverables: [" +
      delStr +
      "]; changed: [" +
      chStr +
      "]",
  };
}

/**
 * Pure function: resolve the "changed nothing" flag for a round record.
 *
 * When baseline and current show the worktree is unchanged, the round
 * accomplished nothing — independent of what any probe says.
 *
 * @param {Object|null|undefined} baseline  Chain-start baseline (may be null
 *        for old records where no baseline was recorded).
 * @param {Object|null|undefined} current   Current worktree state.
 * @returns {boolean|null} True if worktree is unchanged from baseline.
 *   False if something changed.  NULL when baseline is absent (old records).
 */
export function resolveWorktreeChanged(baseline, current) {
  if (!baseline) return null; // unknown (old record)
  if (!current) return null;  // capture failed
  return !isWorktreeUnchanged(baseline, current);
}
