import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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

// The SHA the fake's `git rev-parse HEAD` reports.  Exported so a test that
// wants to model a HEAD-moving command can say which SHA HEAD moved AWAY from.
export const FAKE_HEAD_SHA = "1f0e3dad99908345f7439f8ffabdffc4";

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

    // HEAD read.  The baseline smoke's guard (kusabi #292) captures HEAD
    // beside `git status --porcelain` before and after the run, and treats an
    // unreadable HEAD as a failed measurement, so the fake must answer this
    // like a working container: the same SHA both times, i.e. a smoke that
    // left HEAD where it found it.
    if (cmd === "git rev-parse HEAD") {
      return { output: FAKE_HEAD_SHA + "\n" };
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

/**
 * Stub seams for the pre-mission investigation step (kusabi #591).
 * Supplies deterministic completed investigationDispatch and baseline seams
 * for testing without hitting sunaba-rpc or external model dispatches.
 *
 * @param {object} [overrides]
 * @returns {{ investigationDispatch: Function, baseline: Function }}
 */
export function stubInvestigationSeams(overrides = {}) {
  const jobId = overrides.jobId ?? "job-investigation-stub";
  const requestedModel = overrides.requestedModel ?? "opencode/deepseek-v4-flash-free";
  const actualModel = overrides.actualModel ?? "opencode/deepseek-v4-flash-free";
  const body = overrides.body ?? "## Fact sheet\n- Candidate deliverables: `plugins/kusabi/scripts/luna-driver.mjs`";
  const collected = overrides.collected !== undefined ? overrides.collected : 4342;
  const gates = overrides.gates !== undefined ? overrides.gates : { gate_passed: true, lint: 0, types: 0 };

  const investigationDispatch = overrides.investigationDispatch ?? (async () => ({
    jobId,
    requestedModel,
    actualModel,
    body,
  }));
  investigationDispatch._isStub = true;

  return {
    investigationDispatch,
    baseline: overrides.baseline ?? (async () => ({
      collected,
      gates,
    })),
  };
}

/**
 * Error class thrown by onToolCall to emit a JSON-RPC error response from startMcpStub.
 */
export class McpRpcError extends Error {
  constructor(message) {
    super(message);
    this.name = "McpRpcError";
  }
}

/**
 * Start a lightweight MCP HTTP+SSE stub server for testing.
 *
 * Implements the minimal handshake and SSE response expected by MCP clients:
 * - Emits mcp-session-id: stub-session header
 * - Answers non-tools/call with protocolVersion: "2024-11-05" and kusabi-stub serverInfo
 * - Answers tools/call by invoking onToolCall(params) and returning result.content[0].text
 * - Resolves with toolsCallCount() reporting the number of tools/call requests
 * - Emits a JSON-RPC error (no id) when onToolCall throws an McpRpcError
 * - Listens on 127.0.0.1 port 0
 *
 * @param {object} [opts]
 * @param {(params: any) => any} [opts.onToolCall]
 * @returns {Promise<{ server: import("node:http").Server, url: string, toolsCallCount: () => number }>}
 */
export function startMcpStub({ onToolCall } = {}) {
  let toolsCall = 0;
  const server = http.createServer((req, res) => {
    res.on("error", () => {});
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let payload = null;
      try {
        payload = JSON.parse(body);
      } catch {
        // not JSON — still answer the handshake
      }
      if (payload?.method === "tools/call") toolsCall += 1;
      res.setHeader("mcp-session-id", "stub-session");
      res.writeHead(200, { "content-type": "text/event-stream" });
      let envelope;
      if (payload?.method === "tools/call") {
        let toolResult;
        try {
          toolResult = onToolCall ? onToolCall(payload.params) : { output: "" };
        } catch (err) {
          // Only a deliberate McpRpcError becomes a JSON-RPC error answer; any
          // other exception is a bug in the test's onToolCall and stays loud.
          if (!(err instanceof McpRpcError)) throw err;
          res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: err.message } })}\n\n`);
          return;
        }
        envelope = {
          jsonrpc: "2.0",
          id: payload.id ?? 1,
          result: { content: [{ type: "text", text: JSON.stringify(toolResult) }] },
        };
      } else {
        envelope = {
          jsonrpc: "2.0",
          id: payload?.id ?? 1,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            serverInfo: { name: "kusabi-stub", version: "0.0.0" },
          },
        };
      }
      res.end(`data: ${JSON.stringify(envelope)}\n\n`);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${port}/mcp`,
        toolsCallCount: () => toolsCall,
      });
    });
  });
}

/**
 * Start a sunaba MCP stub server that answers tools/call with the given toolResultText.
 *
 * @param {object} [opts]
 * @param {any} [opts.toolResultText]
 * @returns {Promise<{ server: import("node:http").Server, url: string }>}
 */
export function startSunabaStub({ toolResultText } = {}) {
  return startMcpStub({
    onToolCall: () => toolResultText,
  });
}

/**
 * Start a detach smoke-baseline stub server (kusabi #513).
 * Answers git rev-parse HEAD with deadbeefcafe, commands containing SMOKE_EXIT= with SMOKE_EXIT=0,
 * and anything else with empty output.
 *
 * @returns {Promise<{ server: import("node:http").Server, url: string }>}
 */
export function startDetachStub() {
  return startMcpStub({
    onToolCall: (params) => {
      const args = params?.arguments ?? {};
      const cmd = (args.commands ?? [])[0] ?? "";
      if (cmd === "git rev-parse HEAD") return { output: "deadbeefcafe\n" };
      if (cmd.includes("SMOKE_EXIT=")) return { output: "SMOKE_EXIT=0\n" };
      return { output: "" };
    },
  });
}

/**
 * Run a Node script asynchronously with a kill timer, returning exit code, stdout, and stderr.
 *
 * @param {string} script
 * @param {string[]} [args]
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {number} [opts.killAfterMs=15000]
 * @returns {Promise<{ status: number | null, stdout: string, stderr: string }>}
 */
export function runNodeAsync(script, args = [], { cwd, env, killAfterMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGTERM"), killAfterMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

/**
 * Write a file with utf8 encoding and chmod 0o755.
 *
 * @param {string} file
 * @param {string} source
 */
export function writeExecutable(file, source) {
  fs.writeFileSync(file, source, "utf8");
  fs.chmodSync(file, 0o755);
}

/**
 * Snapshot environment variables, apply the provided patches (deleting undefined values),
 * and return a restore function. Calling restore() twice is harmless.
 *
 * @param {Record<string, string | undefined>} vars
 * @returns {() => void}
 */
export function patchEnv(vars) {
  const saved = {};
  for (const [key, val] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = String(val);
    }
  }
  let restored = false;
  return function restore() {
    if (restored) return;
    restored = true;
    for (const [key, val] of Object.entries(saved)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  };
}

/**
 * Install a fake claude CLI binary and MCP configuration in a directory, setting
 * the CLAUDE_BIN, FAKE_CLAUDE_ARGS_LOG, and KUSABI_CLAUDE_MCP_SOURCE environment variables.
 *
 * @param {string} dir
 * @returns {{ claudeArgsLog: string, restore: () => void }}
 */
export function installFakeClaude(dir) {
  const claudeArgsLog = path.join(dir, "claude-args.ndjson");
  fs.writeFileSync(claudeArgsLog, "", "utf8");
  const claudeBinPath = path.join(dir, "fake-claude.mjs");
  writeExecutable(
    claudeBinPath,
    "#!/usr/bin/env node\n" +
    "import fs from \"node:fs\";\n" +
    "fs.appendFileSync(process.env.FAKE_CLAUDE_ARGS_LOG, JSON.stringify(process.argv.slice(2)) + \"\\n\");\n" +
    "process.stdout.write(JSON.stringify({ type: \"result\", is_error: false, result: \"ok\", session_id: \"claude-uuid-resume\" }));\n",
  );

  const mcpSource = path.join(dir, "claude.json");
  fs.writeFileSync(mcpSource, JSON.stringify({ mcpServers: { sunaba: { command: "npx" } } }), "utf8");

  const restore = patchEnv({
    CLAUDE_BIN: claudeBinPath,
    FAKE_CLAUDE_ARGS_LOG: claudeArgsLog,
    KUSABI_CLAUDE_MCP_SOURCE: mcpSource,
  });

  return { claudeArgsLog, restore };
}
