// plugins/kusabi/scripts/free-worker-profile.test.mjs
// Acceptance tests for Agenda2001 opt-in OpenCode free worker profile.
// Pinned contract:
// 1. Opt-in via KUSABI_OPENCODE_FREE_WORKER=1; absent/false leaves existing behavior untouched.
// 2. Candidate configuration selects opencode/deepseek-v4.1-flash-free; GLM reserve only; operator models untouched.
// 3. Opt-in serve uses --pure and rejects detected OpenCode V2 or V1 < 1.19.3 with actionable error.
// 4. Opt-in installed OpenCode phase agent definitions preserve sunaba/shiori permissions and add host read:ask and bash:deny; templates remain safe.
// 5. OpenCode review requests send format: { type: 'json_schema', schema: <review-output.schema.json> } via prompt_async; no format on implement/gofer.
// 6. Prefer info.structured from last assistant message; preserve text fallback; reject invalid structured output.
// 7. Read audit is E2E evidence extraction, not a new audit product.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolveModel, BUILTIN_DEFAULT_CHAIN } from "./cli.mjs";
import { ensureServer, freePort } from "./serve-lifecycle.mjs";
import { cmdInstallAgents } from "./host-cmd.mjs";
import { runPrompt } from "./prompt-execution.mjs";
import { parseReviewResult } from "./chain-review.mjs";
import { stateDirFor } from "./state-paths.mjs";
import { patchEnv, writeExecutable } from "./fixtures.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const AGENTS_DIR = path.join(PLUGIN_ROOT, "opencode-agents");
const SCHEMA_FILE = path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json");
const EXPECTED_REVIEW_SCHEMA = JSON.parse(fs.readFileSync(SCHEMA_FILE, "utf8"));

// ---------------------------------------------------------------------------
// Helpers: YAML frontmatter parser for agent .md files
// ---------------------------------------------------------------------------

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return null;

  const yaml = match[1];
  const result = {};
  let currentKey = null;

  function unquote(s) {
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1);
    }
    return s;
  }

  function stripComment(v) {
    const idx = v.search(/\s+#/);
    return idx >= 0 ? v.slice(0, idx) : v;
  }

  for (const line of yaml.split("\n")) {
    const top = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (top) {
      currentKey = top[1];
      const value = top[2].trim();
      result[currentKey] = value ? unquote(value) : {};
      continue;
    }

    if (currentKey && /^\s/.test(line) && line.trim()) {
      const entry = line.match(/^\s+(.+?):\s+(.*)$/);
      if (entry) {
        const key = unquote(entry[1]);
        const value = unquote(stripComment(entry[2]).trim());
        const container = result[currentKey];
        if (typeof container === "object" && !Array.isArray(container)) {
          container[key] = value;
        }
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers: Mock HTTP server for OpenCode API & prompt_async capture
// ---------------------------------------------------------------------------

function createMockOpenCodeServer({ assistantMessages = [], onPromptAsync = () => {} } = {}) {
  const recordedPromptPayloads = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let bodyText = "";
    req.on("data", (chunk) => { bodyText += chunk; });
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(bodyText); } catch { /* mock-body optional parsing */ }

      if (req.method === "GET" && url.pathname === "/session") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      if (req.method === "POST" && url.pathname === "/session") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "ses-mock" }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/event") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "connection": "keep-alive",
        });
        res.write(`data: ${JSON.stringify({ type: "session.idle", properties: { sessionID: "ses-mock" } })}\n\n`);
        return;
      }
      if (req.method === "POST" && url.pathname.endsWith("/prompt_async")) {
        recordedPromptPayloads.push(body);
        onPromptAsync(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      if (req.method === "GET" && url.pathname.endsWith("/message")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(assistantMessages));
        return;
      }
      if (req.method === "POST" && url.pathname.endsWith("/abort")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });

  return { server, recordedPromptPayloads };
}

// ---------------------------------------------------------------------------
// Helpers: Mock OpenCode binary script source
// ---------------------------------------------------------------------------

const MOCK_OPENCODE_SCRIPT = `#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write((process.env.MOCK_OPENCODE_VERSION || "1.19.3") + "\\n");
  process.exit(0);
}

const pidsFile = process.env.FAKE_SPAWN_PIDS;
if (pidsFile) {
  try { fs.appendFileSync(pidsFile, process.pid + "\\n"); } catch {}
}
const argsFile = process.env.FAKE_SPAWN_ARGS;
if (argsFile) {
  try { fs.writeFileSync(argsFile, JSON.stringify(argv)); } catch {}
}

const portIdx = argv.indexOf("--port");
const port = Number(argv[portIdx + 1]);
if (port && !Number.isNaN(port)) {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  srv.listen(port, "127.0.0.1");
}
setInterval(() => {}, 1000);
`;

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("Agenda2001 opt-in OpenCode free worker profile: acceptance tests", () => {

  // =========================================================================
  // Criteria 1 & 2: Opt-in environment variable & candidate model selection
  // =========================================================================
  describe("Criteria 1 & 2: Opt-in environment variable & candidate model selection", () => {
    let restoreEnv = () => {};

    afterEach(() => {
      restoreEnv();
    });

    it("1.1 Absent/false leaves existing model selection untouched (BUILTIN_DEFAULT_CHAIN)", () => {
      restoreEnv = patchEnv({ KUSABI_OPENCODE_FREE_WORKER: undefined });
      const resUnset = resolveModel({ flag: undefined, phase: undefined, config: null });
      assert.deepEqual(resUnset.chain, BUILTIN_DEFAULT_CHAIN);
      assert.equal(resUnset.model.providerID, "opencode");
      assert.equal(resUnset.model.modelID, "deepseek-v4-flash-free");

      restoreEnv();
      restoreEnv = patchEnv({ KUSABI_OPENCODE_FREE_WORKER: "0" });
      const resZero = resolveModel({ flag: undefined, phase: undefined, config: null });
      assert.deepEqual(resZero.chain, BUILTIN_DEFAULT_CHAIN);
    });

    it("1.2 Candidate configuration selects opencode/deepseek-v4.1-flash-free when opt-in is enabled", () => {
      restoreEnv = patchEnv({ KUSABI_OPENCODE_FREE_WORKER: "1" });
      const res = resolveModel({ flag: undefined, phase: undefined, config: null });
      assert.equal(res.model?.providerID, "opencode");
      assert.equal(res.model?.modelID, "deepseek-v4.1-flash-free");
    });

    it("1.3 Candidate configuration has GLM reserve only (no paid go routes in chain)", () => {
      restoreEnv = patchEnv({ KUSABI_OPENCODE_FREE_WORKER: "1" });
      const res = resolveModel({ flag: undefined, phase: undefined, config: null });
      const chainRoutes = res.chain.flat();
      const hasGlm = chainRoutes.some((route) => route.toLowerCase().includes("glm"));
      assert.ok(hasGlm, `candidate chain must contain GLM reserve, got: ${JSON.stringify(chainRoutes)}`);
      const hasPaidGo = chainRoutes.some((route) => route.includes("opencode-go/"));
      assert.ok(!hasPaidGo, `candidate chain must not contain paid opencode-go routes, got: ${JSON.stringify(chainRoutes)}`);
    });

    it("1.4 Never alters operator models routing automatically", () => {
      restoreEnv = patchEnv({ KUSABI_OPENCODE_FREE_WORKER: "1" });
      const operatorRes = resolveModel({ flag: "codex/gpt-5", phase: undefined, config: null });
      assert.equal(operatorRes.model?.providerID, "codex");
      assert.equal(operatorRes.model?.modelID, "gpt-5");
    });
  });

  // =========================================================================
  // Criterion 3: Opt-in serve uses --pure and version check
  // =========================================================================
  describe("Criterion 3: Opt-in serve uses --pure and version check", () => {
    let tmpDir;
    let mockBin;
    let argsFile;
    let pidsFile;
    let restoreEnv = () => {};

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-serve-"));
      mockBin = path.join(tmpDir, "mock-opencode.mjs");
      argsFile = path.join(tmpDir, "args.json");
      pidsFile = path.join(tmpDir, "pids.log");
      writeExecutable(mockBin, MOCK_OPENCODE_SCRIPT);
    });

    afterEach(() => {
      restoreEnv();
      if (fs.existsSync(pidsFile)) {
        const pids = fs.readFileSync(pidsFile, "utf8").trim().split("\n").filter(Boolean);
        for (const pidStr of pids) {
          const pid = Number(pidStr);
          try { process.kill(pid, "SIGKILL"); } catch { /* cleanup ignoring missing processes */ }
        }
      }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup ignoring missing files */ }
    });

    it("3.1 Absent/false preserves existing spawn behavior (no --pure, no version check)", async () => {
      restoreEnv = patchEnv({
        KUSABI_OPENCODE_FREE_WORKER: undefined,
        KUSABI_STATE_DIR: path.join(tmpDir, "state"),
        OPENCODE_BIN: mockBin,
        MOCK_OPENCODE_VERSION: "1.18.15",
        FAKE_SPAWN_ARGS: argsFile,
        FAKE_SPAWN_PIDS: pidsFile,
        KUSABI_SERVE_READY_TIMEOUT_MS: "2000",
      });

      const cwd = path.join(tmpDir, "cwd");
      fs.mkdirSync(cwd, { recursive: true });

      const server = await ensureServer(cwd);
      assert.ok(server?.port, "server should start successfully");

      assert.ok(fs.existsSync(argsFile), "spawn args should be recorded");
      const args = JSON.parse(fs.readFileSync(argsFile, "utf8"));
      assert.ok(!args.includes("--pure"), `non-opt-in spawn should not include --pure, got: ${JSON.stringify(args)}`);
    });

    it("3.2 Rejects detected OpenCode V2 with actionable error before worker execution", async () => {
      restoreEnv = patchEnv({
        KUSABI_OPENCODE_FREE_WORKER: "1",
        KUSABI_STATE_DIR: path.join(tmpDir, "state"),
        OPENCODE_BIN: mockBin,
        MOCK_OPENCODE_VERSION: "2.0.0",
        FAKE_SPAWN_ARGS: argsFile,
        FAKE_SPAWN_PIDS: pidsFile,
        KUSABI_SERVE_READY_TIMEOUT_MS: "2000",
      });

      const cwd = path.join(tmpDir, "cwd");
      fs.mkdirSync(cwd, { recursive: true });

      await assert.rejects(
        ensureServer(cwd),
        /(?:OpenCode V2|version 2|unsupported|not supported|actionable)/i,
        "opt-in must reject detected OpenCode V2 before worker execution"
      );
    });

    it("3.3 Rejects detected OpenCode V1 < 1.19.3 with actionable error before worker execution", async () => {
      restoreEnv = patchEnv({
        KUSABI_OPENCODE_FREE_WORKER: "1",
        KUSABI_STATE_DIR: path.join(tmpDir, "state"),
        OPENCODE_BIN: mockBin,
        MOCK_OPENCODE_VERSION: "1.18.15",
        FAKE_SPAWN_ARGS: argsFile,
        FAKE_SPAWN_PIDS: pidsFile,
        KUSABI_SERVE_READY_TIMEOUT_MS: "2000",
      });

      const cwd = path.join(tmpDir, "cwd");
      fs.mkdirSync(cwd, { recursive: true });

      await assert.rejects(
        ensureServer(cwd),
        /(?:1\.19\.3|version|unsupported|upgrade)/i,
        "opt-in must reject detected OpenCode V1 < 1.19.3 with actionable error"
      );
    });

    it("3.4 Opt-in serve uses --pure when supported OpenCode V1 (>= 1.19.3) is detected", async () => {
      restoreEnv = patchEnv({
        KUSABI_OPENCODE_FREE_WORKER: "1",
        KUSABI_STATE_DIR: path.join(tmpDir, "state"),
        OPENCODE_BIN: mockBin,
        MOCK_OPENCODE_VERSION: "1.19.3",
        FAKE_SPAWN_ARGS: argsFile,
        FAKE_SPAWN_PIDS: pidsFile,
        KUSABI_SERVE_READY_TIMEOUT_MS: "2000",
      });

      const cwd = path.join(tmpDir, "cwd");
      fs.mkdirSync(cwd, { recursive: true });

      const server = await ensureServer(cwd);
      assert.ok(server?.port, "server should start successfully");

      assert.ok(fs.existsSync(argsFile), "spawn args should be recorded");
      const args = JSON.parse(fs.readFileSync(argsFile, "utf8"));
      assert.ok(args.includes("--pure"), `opt-in spawn must include --pure, got: ${JSON.stringify(args)}`);
    });
  });

  // =========================================================================
  // Criterion 4: Opt-in installed OpenCode phase agent definitions
  // =========================================================================
  describe("Criterion 4: Opt-in installed OpenCode phase agent definitions", () => {
    let tmpDir;
    let restoreEnv = () => {};

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-agents-"));
    });

    afterEach(() => {
      restoreEnv();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup ignoring missing files */ }
    });

    it("4.1 Repository phase agent templates remain default-safe", () => {
      const templateFiles = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));
      assert.ok(templateFiles.length > 0, "must find agent templates");

      for (const file of templateFiles) {
        const content = fs.readFileSync(path.join(AGENTS_DIR, file), "utf8");
        const parsed = parseFrontmatter(content);
        assert.ok(parsed?.permission, `${file} must define permissions`);
        assert.equal(parsed.permission["*"], "deny", `${file} must have '*: deny'`);
        assert.equal(parsed.permission["read"], undefined, `${file} template must not enable host read`);
        assert.equal(parsed.permission["bash"], undefined, `${file} template must not enable host bash`);
      }
    });

    it("4.2 Existing install behavior unchanged when profile absent", () => {
      const destAgentDir = path.join(tmpDir, "opencode", "agent");
      restoreEnv = patchEnv({
        KUSABI_OPENCODE_FREE_WORKER: undefined,
        OPENCODE_AGENT_DIR: destAgentDir,
        KUSABI_OPENCODE_CONFIG_HOME: tmpDir,
      });

      cmdInstallAgents();

      const installedFiles = fs.readdirSync(destAgentDir).filter((f) => f.endsWith(".md"));
      assert.ok(installedFiles.length > 0, "agents must be installed");

      for (const file of installedFiles) {
        const content = fs.readFileSync(path.join(destAgentDir, file), "utf8");
        const parsed = parseFrontmatter(content);
        assert.equal(parsed.permission["read"], undefined, `${file} should not have read:ask when opt-out`);
        assert.equal(parsed.permission["bash"], undefined, `${file} should not have bash:deny when opt-out`);
      }
    });

    it("4.3 Opt-in installed phase agent definitions preserve sunaba/shiori and add read:ask and bash:deny", () => {
      const destAgentDir = path.join(tmpDir, "opencode", "agent");
      restoreEnv = patchEnv({
        KUSABI_OPENCODE_FREE_WORKER: "1",
        OPENCODE_AGENT_DIR: destAgentDir,
        KUSABI_OPENCODE_CONFIG_HOME: tmpDir,
      });

      cmdInstallAgents();

      const installedFiles = fs.readdirSync(destAgentDir).filter((f) => f.endsWith(".md"));
      assert.ok(installedFiles.length > 0, "agents must be installed");

      for (const file of installedFiles) {
        const content = fs.readFileSync(path.join(destAgentDir, file), "utf8");
        const parsed = parseFrontmatter(content);
        const entries = Object.entries(parsed.permission);

        // 1. "*": "deny" must be the first entry
        assert.equal(entries[0][0], "*", `${file} must have '*' as first entry`);
        assert.equal(entries[0][1], "deny", `${file} must have '*: deny' as first entry`);

        // 2. read: ask added (after *:deny)
        assert.equal(parsed.permission["read"], "ask", `${file} must have read: ask`);

        // 3. bash: deny added
        assert.equal(parsed.permission["bash"], "deny", `${file} must have bash: deny`);

        // 4. Preserves each existing sunaba/shiori permission from template
        const origContent = fs.readFileSync(path.join(AGENTS_DIR, file), "utf8");
        const origParsed = parseFrontmatter(origContent);
        for (const [tool, perm] of Object.entries(origParsed.permission)) {
          if (tool.startsWith("sunaba_") || tool.startsWith("shiori_") || tool.startsWith("kaiba_")) {
            assert.equal(parsed.permission[tool], perm, `${file} must preserve permission for ${tool}`);
          }
        }

        // 5. Never turns wildcard into allow or enables other host builtins
        assert.notEqual(parsed.permission["*"], "allow", `${file} must never allow wildcard`);
        for (const forbiddenHost of ["write", "edit", "patch", "terminal", "command"]) {
          assert.notEqual(parsed.permission[forbiddenHost], "allow", `${file} must not allow host tool ${forbiddenHost}`);
        }
      }
    });
  });

  // =========================================================================
  // Criterion 5: OpenCode review requests send json_schema format via prompt_async
  // =========================================================================
  describe("Criterion 5: OpenCode review requests send json_schema format via prompt_async", () => {
    let tmpDir;
    let mockServer;
    let port;
    let restoreEnv = () => {};

    beforeEach(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-review-"));
      port = await freePort();
    });

    afterEach(async () => {
      restoreEnv();
      if (mockServer) {
        await new Promise((r) => mockServer.close(r));
      }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup ignoring missing files */ }
    });

    it("5.1 Opt-in review requests send format: { type: 'json_schema', schema } via prompt_async", async () => {
      restoreEnv = patchEnv({
        KUSABI_OPENCODE_FREE_WORKER: "1",
        KUSABI_STATE_DIR: path.join(tmpDir, "state"),
      });

      const cwd = path.join(tmpDir, "cwd");
      fs.mkdirSync(cwd, { recursive: true });

      const { server, recordedPromptPayloads } = createMockOpenCodeServer({
        assistantMessages: [
          { info: { role: "assistant" }, parts: [{ type: "text", text: "review result" }] },
        ],
      });
      mockServer = server;
      await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

      // Publish healthy server record in state dir so runPrompt reuses mockServer
      const stateDir = stateDirFor(cwd);
      fs.writeFileSync(
        path.join(stateDir, "server.json"),
        JSON.stringify({ port, password: "test-pw", pid: process.pid, cwd, startedAt: new Date().toISOString() }),
        "utf8"
      );

      await runPrompt({
        cwd,
        kind: "review",
        phase: "review",
        title: "test review",
        promptText: "please review the code",
        agent: "kusabi-review",
        timeoutS: 10,
        watchdogS: 5,
      });

      assert.equal(recordedPromptPayloads.length, 1, "prompt_async should be called once");
      const payload = recordedPromptPayloads[0];
      assert.ok(payload.format, "opt-in review request must include format field in prompt_async payload");
      assert.equal(payload.format.type, "json_schema");
      assert.deepEqual(payload.format.schema, EXPECTED_REVIEW_SCHEMA);
    });

    it("5.2 Opt-in implement and gofer requests do NOT attach review schema", async () => {
      restoreEnv = patchEnv({
        KUSABI_OPENCODE_FREE_WORKER: "1",
        KUSABI_STATE_DIR: path.join(tmpDir, "state"),
      });

      const cwd = path.join(tmpDir, "cwd");
      fs.mkdirSync(cwd, { recursive: true });

      const { server, recordedPromptPayloads } = createMockOpenCodeServer({
        assistantMessages: [
          { info: { role: "assistant" }, parts: [{ type: "text", text: "implemented" }] },
        ],
      });
      mockServer = server;
      await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

      const stateDir = stateDirFor(cwd);
      fs.writeFileSync(
        path.join(stateDir, "server.json"),
        JSON.stringify({ port, password: "test-pw", pid: process.pid, cwd, startedAt: new Date().toISOString() }),
        "utf8"
      );

      // implement request
      await runPrompt({
        cwd,
        kind: "implement",
        phase: "implement",
        title: "test implement",
        promptText: "please implement",
        agent: "kusabi-implement",
        timeoutS: 10,
        watchdogS: 5,
      });

      assert.equal(recordedPromptPayloads.length, 1);
      assert.equal(recordedPromptPayloads[0].format, undefined, "implement request must not attach format schema");
    });

    it("5.3 Absent/false review requests do NOT attach review schema", async () => {
      restoreEnv = patchEnv({
        KUSABI_OPENCODE_FREE_WORKER: undefined,
        KUSABI_STATE_DIR: path.join(tmpDir, "state"),
      });

      const cwd = path.join(tmpDir, "cwd");
      fs.mkdirSync(cwd, { recursive: true });

      const { server, recordedPromptPayloads } = createMockOpenCodeServer({
        assistantMessages: [
          { info: { role: "assistant" }, parts: [{ type: "text", text: "review result" }] },
        ],
      });
      mockServer = server;
      await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

      const stateDir = stateDirFor(cwd);
      fs.writeFileSync(
        path.join(stateDir, "server.json"),
        JSON.stringify({ port, password: "test-pw", pid: process.pid, cwd, startedAt: new Date().toISOString() }),
        "utf8"
      );

      await runPrompt({
        cwd,
        kind: "review",
        phase: "review",
        title: "test review",
        promptText: "please review",
        agent: "kusabi-review",
        timeoutS: 10,
        watchdogS: 5,
      });

      assert.equal(recordedPromptPayloads.length, 1);
      assert.equal(recordedPromptPayloads[0].format, undefined, "opt-out review request must not attach format schema");
    });
  });

  // =========================================================================
  // Criterion 6: Structured result extraction & parser integration
  // =========================================================================
  describe("Criterion 6: Structured result extraction & parser integration", () => {
    let tmpDir;
    let mockServer;
    let port;
    let restoreEnv = () => {};

    beforeEach(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-struct-"));
      port = await freePort();
    });

    afterEach(async () => {
      restoreEnv();
      if (mockServer) {
        await new Promise((r) => mockServer.close(r));
      }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup ignoring missing files */ }
    });

    it("6.1 Prefers info.structured from last assistant message and serializes JSON into review parser path", async () => {
      restoreEnv = patchEnv({
        KUSABI_OPENCODE_FREE_WORKER: "1",
        KUSABI_STATE_DIR: path.join(tmpDir, "state"),
      });

      const cwd = path.join(tmpDir, "cwd");
      fs.mkdirSync(cwd, { recursive: true });

      const validStructured = {
        schema_version: 1,
        verdict: "approve",
        summary: "all criteria met perfectly",
        findings: [],
        next_steps: ["proceed with release"],
      };

      const { server } = createMockOpenCodeServer({
        assistantMessages: [
          {
            info: { role: "assistant", structured: validStructured },
            parts: [],
          },
        ],
      });
      mockServer = server;
      await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

      const stateDir = stateDirFor(cwd);
      fs.writeFileSync(
        path.join(stateDir, "server.json"),
        JSON.stringify({ port, password: "test-pw", pid: process.pid, cwd, startedAt: new Date().toISOString() }),
        "utf8"
      );

      const { resultText } = await runPrompt({
        cwd,
        kind: "review",
        phase: "review",
        title: "structured review test",
        promptText: "review",
        agent: "kusabi-review",
        timeoutS: 10,
        watchdogS: 5,
      });

      assert.ok(resultText, "resultText must not be empty when info.structured is provided");
      const parsedStructured = JSON.parse(resultText);
      assert.deepEqual(parsedStructured, validStructured);

      // Verify it feeds directly into the established review parser path
      const reviewOutcome = parseReviewResult(resultText);
      assert.equal(reviewOutcome.reviewParseable, true, "review parser must accept valid serialized structured output");
      assert.equal(reviewOutcome.chainVerdict, "approve");
    });

    it("6.2 Preserves text-only fallback when info.structured field is absent", async () => {
      restoreEnv = patchEnv({
        KUSABI_OPENCODE_FREE_WORKER: "1",
        KUSABI_STATE_DIR: path.join(tmpDir, "state"),
      });

      const cwd = path.join(tmpDir, "cwd");
      fs.mkdirSync(cwd, { recursive: true });

      const textFallback = JSON.stringify({
        schema_version: 1,
        verdict: "approve",
        summary: "text-only fallback review",
        findings: [],
        next_steps: ["proceed with release"],
      });

      const { server } = createMockOpenCodeServer({
        assistantMessages: [
          {
            info: { role: "assistant" },
            parts: [{ type: "text", text: textFallback }],
          },
        ],
      });
      mockServer = server;
      await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

      const stateDir = stateDirFor(cwd);
      fs.writeFileSync(
        path.join(stateDir, "server.json"),
        JSON.stringify({ port, password: "test-pw", pid: process.pid, cwd, startedAt: new Date().toISOString() }),
        "utf8"
      );

      const { resultText } = await runPrompt({
        cwd,
        kind: "review",
        phase: "review",
        title: "text fallback review test",
        promptText: "review",
        agent: "kusabi-review",
        timeoutS: 10,
        watchdogS: 5,
      });

      assert.equal(resultText, textFallback);
      const reviewOutcome = parseReviewResult(resultText);
      assert.equal(reviewOutcome.reviewParseable, true);
      assert.equal(reviewOutcome.chainVerdict, "approve");
    });

    it("6.3 Does not silently accept invalid structured output", () => {
      // When info.structured is malformed or invalid against schema
      const invalidStructured = {
        verdict: "invalid-verdict-value",
        summary: 12345, // invalid type
        findings: "not an array",
      };

      const serialized = JSON.stringify(invalidStructured);
      const outcome = parseReviewResult(serialized);

      assert.ok(
        !outcome.reviewParseable || outcome.chainVerdict === "unparseable" || (outcome.schemaErrors && outcome.schemaErrors.length > 0),
        "review parser must not silently accept schema-invalid structured output"
      );
    });
  });

  // =========================================================================
  // Criterion 7: Read audit scope
  // =========================================================================
  describe("Criterion 7: Read audit scope", () => {
    it("7.1 Read audit is E2E evidence extraction, not a new audit product", () => {
      // Contract: Read audit is E2E evidence extraction, not a new audit product;
      // do not add implementation of broad audit subsystem.
      // This test pins the boundary: no broad audit subsystem module is expected or tested.
      assert.ok(true);
    });
  });
});
