// Shared test fixtures for kusabi-companion modules.
// NOT a test file - imported by *.test.mjs files.
// This file is not discovered by node --test.

export const sampleParsed = {
  verdict: "approve",
  summary: "The code looks good.",
  findings: [
    {
      severity: "low",
      title: "Minor style issue",
      file: "src/foo.js",
      line_start: 10,
      line_end: 12,
      confidence: 0.9,
      body: "Consider adding a blank line.",
      recommendation: "Add a blank line after the import block.",
    },
  ],
  next_steps: ["Run the linter before merging."],
};

export const makeRecord = (type, blocks) => ({
  type,
  message: { content: blocks },
});

export const textBlock = (text) => ({ type: "text", text });
export const toolUseBlock = (name, input) => ({ type: "tool_use", name, input });
export const toolResultBlock = (text) => ({ type: "tool_result", text });
export const thinkingBlock = (text) => ({ type: "thinking", text });


/**
 * Build a fake callTool function for testing runSmokeProbe.
 *
 * The fake decides what the command emits to stdout from the command string
 * itself — a redirected command emits only the marker, an unredirected one
 * emits its own output first — and then truncates to one page, exactly as
 * sunaba's sandbox_exec does.  Truncation is therefore reproduced, not
 * assumed away: run the pre-fix wrapping through this fake and the marker is
 * lost, which is the bug #91 recorded.
 *
 * For diagnostic reads (tail of the output file), it returns the supplied
 * capturedOutput.
 *
 * @param {number}   [exitCode]        Simulated exit code.
 * @param {string}   [capturedOutput]  Simulated captured output content.
 * @param {boolean}  [simulateTimeout] If true, the smoke execution call throws.
 * @param {boolean}  [timeoutAsData]   If true, it returns {status:"timeout"} —
 *                                     how a real command timeout arrives.
 * @param {boolean}  [omitMarker]      If true, the marker is never emitted.
 * @param {number}   [rawOutputLines]  Lines an unredirected command would emit.
 * @returns {Function} A fake callTool(async (toolName, params) => ...).
 */
// sunaba's sandbox_exec paginates by default (verbose="summary", limit=50):
// only the first page of the command's stdout is returned.  This is the exact
// mechanism that broke the probe, so the fake reproduces it rather than
// assuming it away.
export const FAKE_PAGE_LIMIT = 50;

// Matches the wrapping runSmokeEntry applies: the whole declared command in a
// subshell, with stdout+stderr redirected to a file, marker echoed after.
export const REDIRECT_RE = /^\( [\s\S]* \) >\/tmp\/kusabi-smoke-\d+-\d+\.log 2>&1; echo SMOKE_EXIT=\$\?$/;

export function createFakeCallTool({
  exitCode = 0,
  capturedOutput = "",
  simulateTimeout = false,
  timeoutAsData = false,
  omitMarker = false,
  rawOutputLines = 2025,
} = {}) {
  return async (toolName, params) => {
    if (toolName !== "sandbox_exec") return { output: "" };
    const cmd = params.commands[0];

    // Smoke execution call — wrapped in "( ... ) >/tmp/kusabi-smoke-*.log 2>&1; echo SMOKE_EXIT=$?"
    if (cmd.includes("SMOKE_EXIT=")) {
      if (simulateTimeout) {
        const err = new Error("timeout: operation timed out");
        err.name = "TimeoutError";
        throw err;
      }
      // A real command timeout arrives as data, not as a thrown error: the
      // shell is killed before the marker can be echoed.
      if (timeoutAsData) {
        return { status: "timeout", output: "", exit_code: 124 };
      }

      // Model what actually reaches sandbox_exec's stdout.  A redirected
      // command emits only the marker; an unredirected one (the pre-fix
      // wrapping) emits its own output first and the marker last.
      const emitted = [];
      if (!REDIRECT_RE.test(cmd)) {
        for (let i = 0; i < rawOutputLines; i++) {
          emitted.push("ok " + (i + 1) + " - simulated TAP line");
        }
      }
      if (!omitMarker) {
        emitted.push("SMOKE_EXIT=" + exitCode);
      } else {
        emitted.push("some unrelated output");
      }

      // Truncate to the first page, exactly as sunaba does.
      return {
        output: emitted.slice(0, FAKE_PAGE_LIMIT).join("\n") + "\n",
        truncated: emitted.length > FAKE_PAGE_LIMIT,
      };
    }

    // Diagnostic read call (tail of the output file)
    if (cmd.includes("tail ") || cmd.includes("tail -c") || cmd.includes("cat ")) {
      return { output: capturedOutput };
    }

    return { output: "" };
  };
}

/**
 * Build a fake callTool function for testing runHeadCleanProbe.
 * Simulates sandbox_exec responses for git rev-parse and git reset.
 *
 * @param {object}   opts
 * @param {string}   [opts.headSha]   SHA that git rev-parse HEAD returns.
 * @param {boolean}  [opts.resetOk]   Whether git reset succeeds.
 * @returns {Function} A fake callTool(async (toolName, params) => ...).
 */
export function fakeCallToolForP1({ headSha, resetOk = true } = {}) {
  return async (toolName, params) => {
    if (toolName !== "sandbox_exec") return { output: "" };
    const cmd = params.commands[0];
    if (cmd === "git rev-parse HEAD") {
      return { output: (headSha ?? "abc123") + "\n" };
    }
    if (cmd.startsWith("git reset --mixed ")) {
      if (resetOk) return { output: "" };
      throw new Error("reset failed: path not clean");
    }
    return { output: "" };
  };
}

/**
 * Build a fake callTool function for testing runVerifyProbe.
 *
 * @param {object}   opts
 * @param {boolean}  [opts.gatePassed]  Whether gate_passed is true.
 * @returns {Function} A fake callTool(async (toolName) => ...).
 */
export function fakeCallToolForP2({ gatePassed = true } = {}) {
  return async (toolName) => {
    if (toolName !== "verify_in_container") return { output: "" };
    const result = { gate_passed: gatePassed, output: "(mock output)" };
    if (gatePassed) {
      result.lint = [];
      result.types = [];
    }
    return result;
  };
}

/**
 * Build a fake callTool function for testing runDeliverablesProbe.
 *
 * @param {object}   opts
 * @param {string}   [opts.statusOutput]  Output from git status --porcelain.
 * @returns {Function} A fake callTool(async (toolName, params) => ...).
 */
export function fakeCallToolForP3({ statusOutput = "" } = {}) {
  return async (toolName, params) => {
    if (toolName !== "sandbox_exec") return { output: "" };
    if (params.commands[0] === "git status --porcelain") {
      return { output: statusOutput };
    }
    return { output: "" };
  };
}


/**
 * Build a fake callTool for testing runDeliverablesProbe with a baseline.
 *
 * Stubs both `git status --porcelain` and the `captureWorktreeState` shell
 * command (detected by the "TMPIDX=" pattern).  The fake manifest content is
 * driven by the `currentManifest` parameter so the test can control whether
 * newlyChanged paths are found or not.
 *
 * @param {object}   opts
 * @param {string}   [opts.statusOutput=""]         — Output from git status --porcelain.
 * @param {object}   [opts.currentManifest=null]     — The current-state manifest to
 *        return on capture.  When null, the call returns a string that makes
 *        captureWorktreeState return null (simulating a capture failure).
 * @returns {Function}
 */
export function fakeCallToolForP3WithBaseline({
  statusOutput = "",
  currentManifest = null,
} = {}) {
  const captureOutput = currentManifest
    ? buildCaptureOutput(currentManifest)
    : "ERROR_NO_INDEX\n";

  return async (toolName, params) => {
    if (toolName !== "sandbox_exec") return { output: "" };
    const cmd = params.commands[0];

    if (cmd === "git status --porcelain") {
      return { output: statusOutput };
    }

    if (cmd.startsWith("cd /workspace &&") && cmd.includes("TMPIDX=")) {
      return { output: captureOutput };
    }

    return { output: "" };
  };
}

/**
 * Format a manifest object into the text output that captureWorktreeState
 * parses from the sandbox_exec stdout.
 *
 * @param {{ treeHash: string, files: Record<string,string> }} manifest
 * @returns {string}
 */
export function buildCaptureOutput(manifest) {
  if (!manifest) return "";
  const lines = [];
  lines.push("TREE_HASH=" + manifest.treeHash);
  const files = manifest.files ?? {};
  const entries = Object.entries(files);
  entries.sort(function (a, b) { return a[0].localeCompare(b[0]); });
  for (const [filePath, hash] of entries) {
    lines.push(hash + "|" + filePath);
  }
  // captureWorktreeState requires the COUNT marker (same pipeline data) to
  // verify the listing arrived complete; the fake must emit it too.
  lines.push("COUNT=" + entries.length);
  return lines.join("\n");
}
