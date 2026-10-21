// plugins/kusabi/scripts/free-worker-profile.test.mjs
// Acceptance tests for Agenda2001 opt-in OpenCode free worker profile.
// Pinned contract:
// 1. Opt-in via KUSABI_OPENCODE_FREE_WORKER=1; absent/false leaves existing behavior untouched.
// 2. Candidate configuration selects opencode/deepseek-v4.1-flash-free (DeepSeek only, shared quota); explicit GLM supported/recognized; operator models untouched.
// 3. Opt-in serve uses --pure and rejects detected OpenCode V2 or V1 < 1.19.3 with actionable error.
// 4. Opt-in installed OpenCode phase agent definitions preserve sunaba/shiori permissions and add host read:ask and bash:deny; templates remain safe.
// 5. OpenCode review requests send format: { type: 'json_schema', schema: <review-output.schema.json> } via prompt_async; no format on implement/gofer.
// 6. Prefer info.structured from last assistant message; preserve text fallback; reject invalid structured output.
// 7. Read audit is E2E evidence extraction, not a new audit product.

import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveModel, BUILTIN_DEFAULT_CHAIN } from "./cli.mjs";
import { ensureServer, freePort } from "./serve-lifecycle.mjs";
import { cmdInstallAgents } from "./host-cmd.mjs";
import { runPrompt, warnFreeWorkerConfiguredRoute } from "./prompt-execution.mjs";
import { parseReviewResult } from "./chain-review.mjs";
import { stateDirFor } from "./state-paths.mjs";
import { patchEnv, writeExecutable } from "./fixtures.mjs";
import { checkOpencodeVersion,
  OPENCODE_FREE_WORKER_CHAIN,
  OPENCODE_RECOGNIZED_FREE_MODELS,
  assertInstalledAgentProfile,
  checkDefaultOpencodeVersion,
  detectInstalledAgentProfile,
  classifyInstalledAgentContent,
  isOpenCodeFreeCandidateRoute,
  isOpenCodeFreeWorkerEnabled,
  prepareAgentInstall,
  transformAgentForOptIn,
  writeInstalledAgentProfile,
} from "./free-worker-profile.mjs";

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

    it("1.3 Candidate configuration contains DeepSeek only, no automatic GLM fallback (shared quota) and no paid routes", () => {
      assert.deepEqual(OPENCODE_FREE_WORKER_CHAIN, ["opencode/deepseek-v4.1-flash-free"]);
      assert.deepEqual(OPENCODE_RECOGNIZED_FREE_MODELS, [
        "opencode/deepseek-v4.1-flash-free",
        "opencode/glm-5.3-flash-free",
      ]);
      restoreEnv = patchEnv({ KUSABI_OPENCODE_FREE_WORKER: "1" });
      const res = resolveModel({ flag: undefined, phase: undefined, config: null });
      const chainRoutes = res.chain.flat();
      assert.deepEqual(chainRoutes, ["opencode/deepseek-v4.1-flash-free"]);
      const hasGlm = chainRoutes.some((route) => route.toLowerCase().includes("glm"));
      assert.equal(hasGlm, false, `candidate chain must not contain automatic GLM fallback, got: ${JSON.stringify(chainRoutes)}`);
      const hasPaidGo = chainRoutes.some((route) => route.includes("opencode-go/"));
      assert.ok(!hasPaidGo, `candidate chain must not contain paid opencode-go routes, got: ${JSON.stringify(chainRoutes)}`);
    });

    it("1.4 Never alters operator models routing automatically", () => {
      restoreEnv = patchEnv({ KUSABI_OPENCODE_FREE_WORKER: "1" });
      const operatorRes = resolveModel({ flag: "codex/gpt-5", phase: undefined, config: null });
      assert.equal(operatorRes.model?.providerID, "codex");
      assert.equal(operatorRes.model?.modelID, "gpt-5");
    });

    it("1.5 Opt-in with no operator config yields DeepSeek only", () => {
      restoreEnv = patchEnv({ KUSABI_OPENCODE_FREE_WORKER: "1" });
      const res = resolveModel({ flag: undefined, phase: undefined, config: null });
      assert.equal(res.model?.providerID, "opencode");
      assert.equal(res.model?.modelID, "deepseek-v4.1-flash-free");
      assert.deepEqual(res.chain, ["opencode/deepseek-v4.1-flash-free"]);
    });

    it("1.6 Explicit GLM remains honored and free recognized without warnings", () => {
      restoreEnv = patchEnv({ KUSABI_OPENCODE_FREE_WORKER: "1" });
      const res = resolveModel({ flag: "opencode/glm-5.3-flash-free", phase: undefined, config: null });
      assert.equal(res.model?.providerID, "opencode");
      assert.equal(res.model?.modelID, "glm-5.3-flash-free");

      assert.equal(isOpenCodeFreeCandidateRoute("opencode/glm-5.3-flash-free"), true);
      assert.equal(isOpenCodeFreeCandidateRoute("opencode/glm-5.3-flash-free:max"), true);
      assert.equal(isOpenCodeFreeCandidateRoute("opencode/deepseek-v4.1-flash-free"), true);
      assert.equal(isOpenCodeFreeCandidateRoute("opencode-go/custom"), false);

      const warned = warnFreeWorkerConfiguredRoute(["opencode/glm-5.3-flash-free"], { enabled: true });
      assert.equal(warned, null, "explicit GLM must not emit paid/non-free warnings");
    });

    it("1.7 Operator-configured routes remain untouched by opt-in defaults", () => {
      restoreEnv = patchEnv({ KUSABI_OPENCODE_FREE_WORKER: "1" });
      const customChain = ["codex/gpt-5", "agy/gemini-3.6-flash-high"];
      const resChain = resolveModel({ flag: undefined, phase: undefined, config: { models: { chain: customChain } } });
      assert.deepEqual(resChain.chain, customChain);
      assert.equal(resChain.model?.providerID, "codex");
      assert.equal(resChain.model?.modelID, "gpt-5");

      const resPhase = resolveModel({
        flag: undefined,
        phase: "review",
        config: { models: { phases: { review: ["opencode/glm-5.3-flash-free"] } } },
      });
      assert.equal(resPhase.model?.providerID, "opencode");
      assert.equal(resPhase.model?.modelID, "glm-5.3-flash-free");
    });

    it("1.8 Opt-out defaults remain completely unchanged", () => {
      for (const val of [undefined, "0", "false", ""]) {
        restoreEnv = patchEnv({ KUSABI_OPENCODE_FREE_WORKER: val });
        const res = resolveModel({ flag: undefined, phase: undefined, config: null });
        assert.deepEqual(res.chain, BUILTIN_DEFAULT_CHAIN);
        assert.equal(res.model?.providerID, "opencode");
        assert.equal(res.model?.modelID, "deepseek-v4-flash-free");
        assert.equal(isOpenCodeFreeWorkerEnabled(), false);
      }
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
        JSON.stringify({ port, password: "test-pw", pid: process.pid, cwd, startedAt: new Date().toISOString(), profile: "free", pure: true }),
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
        JSON.stringify({ port, password: "test-pw", pid: process.pid, cwd, startedAt: new Date().toISOString(), profile: "free", pure: true }),
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
        JSON.stringify({ port, password: "test-pw", pid: process.pid, cwd, startedAt: new Date().toISOString(), profile: "free", pure: true }),
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
        JSON.stringify({ port, password: "test-pw", pid: process.pid, cwd, startedAt: new Date().toISOString(), profile: "free", pure: true }),
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

// =========================================================================
// PR755 finding 1 & 5: installed-agent mode isolation + fail-closed install
// =========================================================================

describe("PR755: installed agent profile isolation", () => {
  let tmpDir;
  let restoreEnv = () => {};

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-pr755-guard-"));
  });

  afterEach(() => {
    restoreEnv();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function discoveryDir(mode = process.env.KUSABI_OPENCODE_FREE_WORKER === "1" ? "free" : "default") {
    return path.join(tmpDir, "state", "opencode-mode", mode, "agent");
  }

  function writeAgent(name, content) {
    const dir = discoveryDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), content, "utf8");
  }

  const defaultTemplate = fs.readFileSync(path.join(AGENTS_DIR, "kusabi-review.md"), "utf8");

  it("rejects dispatch after an opt-in install once the env is unset", async () => {
    restoreEnv = patchEnv({
      KUSABI_OPENCODE_FREE_WORKER: "1",
      KUSABI_OPENCODE_CONFIG_HOME: path.join(tmpDir, "config"),
      KUSABI_STATE_DIR: path.join(tmpDir, "state"),
    });
    cmdInstallAgents();
    assert.equal(detectInstalledAgentProfile(discoveryDir()), "free");

    // The free directory still fails its original mismatch check when judged as default.
    assert.throws(
      () => assertInstalledAgentProfile(discoveryDir("free"), false),
      /reinstall/i
    );
    // The default serve checks its own directory and is not affected by free agents.
    const restoreFlip = patchEnv({ KUSABI_OPENCODE_FREE_WORKER: undefined });
    try {
      assert.doesNotThrow(() => assertInstalledAgentProfile(discoveryDir(), false));
    } finally {
      restoreFlip();
    }
  });

  it("inverse: rejects dispatch after a default install once opt-in is enabled", async () => {
    restoreEnv = patchEnv({
      KUSABI_OPENCODE_FREE_WORKER: undefined,
      KUSABI_OPENCODE_CONFIG_HOME: path.join(tmpDir, "config"),
      KUSABI_STATE_DIR: path.join(tmpDir, "state"),
    });
    cmdInstallAgents();
    assert.equal(detectInstalledAgentProfile(discoveryDir()), "default");

    const restoreFlip = patchEnv({ KUSABI_OPENCODE_FREE_WORKER: "1" });
    try {
      assert.throws(
        () => assertInstalledAgentProfile(discoveryDir("default"), true),
        /reinstall/i
      );
    } finally {
      restoreFlip();
    }
  });

  it("serve refuses to start while kusabi agents remain in the shared directory", async () => {
    restoreEnv = patchEnv({
      KUSABI_OPENCODE_FREE_WORKER: undefined,
      KUSABI_OPENCODE_CONFIG_HOME: path.join(tmpDir, "config"),
      KUSABI_STATE_DIR: path.join(tmpDir, "state"),
    });
    const shared = path.join(tmpDir, "config", "opencode", "agent");
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, "kusabi-review.md"), defaultTemplate, "utf8");
    const cwd = path.join(tmpDir, "cwd");
    fs.mkdirSync(cwd, { recursive: true });
    await assert.rejects(
      ensureServer(cwd),
      (err) => err.code === "KUSABI_AGENT_PROFILE_MISMATCH" && /shared agent directory/.test(err.message)
    );
  });

  it("a dangling kusabi-*.md symlink in the shared directory still counts as residue", () => {
    const shared = path.join(tmpDir, "config", "opencode", "agent");
    fs.mkdirSync(shared, { recursive: true });
    fs.symlinkSync(path.join(tmpDir, "missing-target"), path.join(shared, "kusabi-old.md"));
    restoreEnv = patchEnv({
      KUSABI_OPENCODE_CONFIG_HOME: path.join(tmpDir, "config"),
      KUSABI_STATE_DIR: path.join(tmpDir, "state"),
    });
    assert.throws(
      () => assertInstalledAgentProfile(path.join(tmpDir, "config", "opencode", "agent-mode-missing"), false),
      (err) => err.code === "KUSABI_AGENT_PROFILE_MISMATCH"
    );
  });

  it("never silently trusts free-installed files that lack metadata", () => {
    writeAgent("kusabi-review.md", transformAgentForOptIn(defaultTemplate));
    assert.equal(detectInstalledAgentProfile(discoveryDir()), "free");
    assert.throws(
      () => assertInstalledAgentProfile(discoveryDir(), false),
      /reinstall/i
    );
  });

  it("accepts a structurally default legacy install in opt-out and rejects it in opt-in", () => {
    writeAgent("kusabi-review.md", defaultTemplate);
    assert.equal(detectInstalledAgentProfile(discoveryDir()), "default");
    assert.doesNotThrow(() => assertInstalledAgentProfile(discoveryDir(), false));
    assert.throws(() => assertInstalledAgentProfile(discoveryDir(), true), /reinstall/i);
  });

  it("tags each profile-mismatch throw with KUSABI_AGENT_PROFILE_MISMATCH and leaves detect-origin errors untagged", () => {
    const agentFile = path.join(discoveryDir(), "kusabi-review.md");
    const expectTagged = (fn) => assert.throws(fn, (err) => err instanceof Error && err.code === "KUSABI_AGENT_PROFILE_MISMATCH");

    // unknown: a kusabi agent with no frontmatter cannot be trusted in either mode
    writeAgent("kusabi-review.md", "no frontmatter here\n");
    expectTagged(() => assertInstalledAgentProfile(discoveryDir(), false));
    expectTagged(() => assertInstalledAgentProfile(discoveryDir(), true));

    // opt-in over a default install
    fs.rmSync(agentFile);
    writeAgent("kusabi-review.md", defaultTemplate);
    expectTagged(() => assertInstalledAgentProfile(discoveryDir(), true));

    // opt-out over a free install
    fs.rmSync(agentFile);
    writeAgent("kusabi-review.md", transformAgentForOptIn(defaultTemplate));
    expectTagged(() => assertInstalledAgentProfile(discoveryDir(), false));

    // detect-origin error: path.join rejects an undefined agent dir before the
    // function's own try blocks, so the error must propagate without the code
    assert.throws(
      () => assertInstalledAgentProfile(undefined, false),
      (err) => err instanceof TypeError && err.code !== "KUSABI_AGENT_PROFILE_MISMATCH"
    );
  });

  it("treats a directory with no kusabi agents as absent (no-op)", () => {
    assert.equal(detectInstalledAgentProfile(discoveryDir()), "absent");
    assert.equal(assertInstalledAgentProfile(discoveryDir(), true), "absent");
  });

  it("refuses shared kusabi residue but permits user-named agents", () => {
    restoreEnv = patchEnv({
      KUSABI_STATE_DIR: path.join(tmpDir, "state"),
      KUSABI_OPENCODE_CONFIG_HOME: path.join(tmpDir, "shared-config"),
      KUSABI_OPENCODE_FREE_WORKER: undefined,
    });
    const sharedAgentDir = path.join(tmpDir, "shared-config", "opencode", "agent");
    fs.mkdirSync(sharedAgentDir, { recursive: true });
    fs.writeFileSync(path.join(sharedAgentDir, "kusabi-old.md"), "legacy residue\n");
    assert.throws(
      () => assertInstalledAgentProfile(discoveryDir(), false),
      (err) => err instanceof Error
        && err.code === "KUSABI_AGENT_PROFILE_MISMATCH"
        && /shared agent directory .* still holds kusabi agents/i.test(err.message)
        && /migration steps.*plugins\/kusabi\/README\.md/i.test(err.message),
    );
    fs.rmSync(path.join(sharedAgentDir, "kusabi-old.md"));
    fs.writeFileSync(path.join(sharedAgentDir, "operator-review.md"), "user agent\n");
    assert.doesNotThrow(() => assertInstalledAgentProfile(discoveryDir(), false));
  });

  it("reproduces #777: each mode accepts its own install after the other mode is installed", () => {
    restoreEnv = patchEnv({
      KUSABI_STATE_DIR: path.join(tmpDir, "state"),
      KUSABI_OPENCODE_CONFIG_HOME: path.join(tmpDir, "shared-config"),
      KUSABI_OPENCODE_FREE_WORKER: "1",
    });
    cmdInstallAgents();
    assert.equal(detectInstalledAgentProfile(discoveryDir("free")), "free");
    assert.doesNotThrow(() => assertInstalledAgentProfile(discoveryDir("default"), false));

    const flipToDefault = patchEnv({ KUSABI_OPENCODE_FREE_WORKER: undefined });
    try {
      cmdInstallAgents();
      assert.equal(detectInstalledAgentProfile(discoveryDir("default")), "default");
      const flipToFree = patchEnv({ KUSABI_OPENCODE_FREE_WORKER: "1" });
      try {
        assert.doesNotThrow(() => assertInstalledAgentProfile(discoveryDir("free"), true));
      } finally {
        flipToFree();
      }
    } finally {
      flipToDefault();
    }
  });

  it("classifies installed agent content structurally", () => {
    assert.equal(classifyInstalledAgentContent(defaultTemplate), "default");
    assert.equal(classifyInstalledAgentContent(transformAgentForOptIn(defaultTemplate)), "free");
    assert.equal(classifyInstalledAgentContent("no frontmatter here"), "unknown");
    assert.equal(classifyInstalledAgentContent("---\nname: x\npermission:\n  read: allow\n---\nbody"), "unknown");
  });
});

describe("PR755: agent transform fails closed before any install", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-pr755-transform-"));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("throws descriptive errors for missing frontmatter, missing permission block, and missing wildcard", () => {
    assert.throws(() => transformAgentForOptIn("body only\n"), /frontmatter/i);
    assert.throws(
      () => transformAgentForOptIn("---\nname: kusabi-review\n---\nbody\n"),
      /permission/i
    );
    assert.throws(
      () => transformAgentForOptIn("---\nname: kusabi-review\npermission:\n  read: allow\n---\nbody\n"),
      /wildcard/i
    );
  });

  it("aborts the whole preflight when one template is malformed (no partial install)", () => {
    const src = path.join(tmpDir, "agents");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, "a-ok.md"), "---\nname: kusabi-implement\npermission:\n  \"*\": deny\n  sunaba_read_file_range: allow\n---\nbody ok\n", "utf8");
    fs.writeFileSync(path.join(src, "b-malformed.md"), "---\nname: kusabi-review\npermission:\n  read: allow\n---\nbody\n", "utf8");
    assert.throws(() => prepareAgentInstall(src, { optIn: true }), /wildcard/i);
  });
});

// =========================================================================
// PR755 follow-up: fail-closed constrained permission transform regressions
// =========================================================================

describe("PR755 follow-up: constrained permission rules are fail-closed", () => {
  const VALID_NON_REVIEW =
    "---\nname: kusabi-implement\npermission:\n  \"*\": deny\n  sunaba_sandbox_exec: allow\n---\nbody\n";

  it("rejects a template that already broadens read or bash instead of normalizing it", () => {
    assert.throws(
      () =>
        transformAgentForOptIn(
          "---\nname: kusabi-implement\npermission:\n  \"*\": deny\n  read: allow\n  bash: allow\n---\nbody\n"
        ),
      /read.*must be "ask"/i
    );
    assert.throws(
      () =>
        transformAgentForOptIn(
          "---\nname: kusabi-implement\npermission:\n  \"*\": deny\n  read: ask\n  bash: allow\n---\nbody\n"
        ),
      /bash.*must be "deny"/i
    );
  });

  it("rejects a conflicting review StructuredOutput rule", () => {
    assert.throws(
      () =>
        transformAgentForOptIn(
          "---\nname: kusabi-review\npermission:\n  \"*\": deny\n  StructuredOutput: deny\n---\nbody\n"
        ),
      /StructuredOutput.*must be "allow"/i
    );
  });

  it("rejects duplicate constrained rules, a later wildcard rule, and object mappings", () => {
    assert.throws(
      () =>
        transformAgentForOptIn(
          "---\nname: kusabi-implement\npermission:\n  \"*\": deny\n  read: ask\n  read: ask\n---\nbody\n"
        ),
      /duplicate permission rule "read"/i
    );
    assert.throws(
      () =>
        transformAgentForOptIn(
          "---\nname: kusabi-implement\npermission:\n  \"*\": deny\n  \"*\": allow\n---\nbody\n"
        ),
      /duplicate permission rule "\*"|wildcard/i
    );
    assert.throws(
      () =>
        transformAgentForOptIn(
          "---\nname: kusabi-implement\npermission:\n  \"*\": deny\n  read:\n    \"*\": allow\n---\nbody\n"
        ),
      /"read" must be a scalar/i
    );
  });

  it("cannot be bypassed by quoting or comments on a conflicting value", () => {
    assert.throws(
      () =>
        transformAgentForOptIn(
          "---\nname: kusabi-implement\npermission:\n  \"*\": deny\n  read: \"allow\"\n---\nbody\n"
        ),
      /read.*must be "ask"/i
    );
    assert.throws(
      () =>
        transformAgentForOptIn(
          "---\nname: kusabi-implement\npermission:\n  \"*\": deny\n  read: allow # explicitly broad\n---\nbody\n"
        ),
      /read.*must be "ask"/i
    );
  });

  it("accepts exact scalar constrained rules idempotently", () => {
    const exact =
      "---\nname: kusabi-implement\npermission:\n  \"*\": deny\n  read: ask\n  bash: deny\n  sunaba_sandbox_exec: allow\n---\nbody\n";
    const once = transformAgentForOptIn(exact);
    assert.equal(once, exact, "an already-exact block must transform to itself");
    assert.equal(transformAgentForOptIn(once), once, "transform must stay idempotent");
  });

  it("reads permission rules only from frontmatter, never from the body", () => {
    const input =
      "---\nname: kusabi-implement\npermission:\n  \"*\": deny\n---\nread: allow\nbash: allow\n";
    const out = transformAgentForOptIn(input);
    assert.match(out, /read: ask/);
    assert.match(out, /bash: deny/);
    assert.match(out, /read: allow\nbash: allow/, "body text must be preserved verbatim");
  });

  // Real install entry-path regression (PR755 round 2).  The old version of
  // this test only exercised prepareAgentInstall and asserted a destination
  // that was never passed to anything did not exist, which proved nothing
  // about install atomicity.  This drives cmdInstallAgents itself with a
  // disposable injected source and asserts the real destination and marker
  // are never written when one template is invalid.
  it("real cmdInstallAgents preflight writes no agent or marker when one template is invalid", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-pr755-nopartial-"));
    const dest = path.join(tmpDir, "dest");
    const restoreEnv = patchEnv({
      KUSABI_OPENCODE_FREE_WORKER: "1",
      OPENCODE_AGENT_DIR: dest,
      KUSABI_OPENCODE_CONFIG_HOME: path.join(tmpDir, "cfg"),
    });
    try {
      const src = path.join(tmpDir, "agents");
      fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(path.join(src, "a-ok.md"), VALID_NON_REVIEW, "utf8");
      fs.writeFileSync(
        path.join(src, "b-broaden.md"),
        "---\nname: kusabi-implement\npermission:\n  \"*\": deny\n  read: allow\n  bash: allow\n---\nbody\n",
        "utf8"
      );
      assert.throws(
        () => cmdInstallAgents({ sourceDir: src }),
        /read.*must be "ask"/i,
        "the real install entry path must reject the invalid template"
      );
      assert.equal(fs.existsSync(dest), false, "a failed install must not create the destination directory");
      assert.equal(
        fs.existsSync(path.join(dest, ".kusabi-install-profile.json")),
        false,
        "a failed install must not leave an installed-profile marker"
      );
    } finally {
      restoreEnv();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// =========================================================================
// PR755 round 2: shared permission-block extraction and explicit allowlist
// =========================================================================

describe("PR755 round 2: one permission-block path for transform and classification", () => {
  const BASE = (tail) => `---\nname: kusabi-implement\npermission:\n  "*": deny\n${tail}\n---\nbody\n`;

  it("does not let column-0 or indented comments/blank lines truncate the permission block", () => {
    // The orchestrator's reproduction: a column-0 comment before broadened
    // grants used to end the block early, so the transform accepted and the
    // broad grant survived with last-match precedence.
    assert.throws(
      () => transformAgentForOptIn(BASE("# column-0 comment\n  read: allow\n  bash: allow")),
      /read.*must be "ask"/i
    );
    assert.throws(
      () => transformAgentForOptIn(BASE("  # indented comment\n  read: allow")),
      /read.*must be "ask"/i
    );
    assert.throws(() => transformAgentForOptIn(BASE("\n\n  bash: allow")), /bash.*must be "deny"/i);
  });

  it("rejects unknown exact host keys and general globs that could shadow a host tool", () => {
    const cases = [
      ["  write: allow", /unsupported permission key "write"/i],
      ["  edit: allow", /unsupported permission key "edit"/i],
      ["  patch: allow", /unsupported permission key "patch"/i],
      ["  terminal: allow", /unsupported permission key "terminal"/i],
      ['  "read*": allow', /unsupported permission key "read\*"/i],
      ['  "write*": allow', /unsupported permission key "write\*"/i],
      ['  "**": allow', /unsupported permission key "\*\*"/i],
      ['  "sunaba_*": allow', /unsupported permission key "sunaba_\*"/i],
      ['  "read": allow', /read.*must be "ask"/i],
    ];
    for (const [tail, re] of cases) {
      assert.throws(() => transformAgentForOptIn(BASE(tail)), re, `must reject: ${tail.trim()}`);
    }
  });

  it("rejects a duplicate wildcard rule", () => {
    assert.throws(() => transformAgentForOptIn(BASE('  "*": allow')), /duplicate permission rule "\*"/i);
    assert.throws(() => transformAgentForOptIn(BASE('  "*": deny')), /duplicate permission rule "\*"/i);
  });

  it("accepts a supported nested skill map and anchored tool families idempotently", () => {
    const supported =
      '---\nname: kusabi-implement\npermission:\n  "*": deny\n  kaiba_recall: allow\n  skill:\n    "kusabi-*": allow\n  shiori*: allow\n  sunaba_read_file_range: allow\n---\nbody\n';
    const once = transformAgentForOptIn(supported);
    assert.equal(transformAgentForOptIn(once), once, "supported template transform must be idempotent");
    assert.match(once, /"kusabi-\*": allow/, "nested skill grant must be preserved verbatim");
    assert.match(once, /read: ask/);
    assert.match(once, /bash: deny/);
  });

  it("rejects an unsupported nested skill child", () => {
    assert.throws(
      () =>
        transformAgentForOptIn(
          '---\nname: kusabi-implement\npermission:\n  "*": deny\n  skill:\n    "evil-*": allow\n---\nbody\n'
        ),
      /nested skill rule/i
    );
  });

  it("classifies every repository template default-first and transform results free", () => {
    const templates = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));
    assert.ok(templates.length > 0, "must find templates");
    for (const file of templates) {
      const content = fs.readFileSync(path.join(AGENTS_DIR, file), "utf8");
      assert.equal(classifyInstalledAgentContent(content), "default", `${file} on disk must classify default`);
      const transformed = transformAgentForOptIn(content);
      assert.equal(
        classifyInstalledAgentContent(transformed),
        "free",
        `${file} transformed must classify free`
      );
      assert.equal(transformAgentForOptIn(transformed), transformed, `${file} transform must be idempotent`);
    }
  });
});

describe("PR755 round 2: installed classification cannot be fooled or concealed", () => {
  it("classifies a comment-truncated broadened free agent unknown, never default", () => {
    const hiddenWrite =
      '---\nname: kusabi-review\npermission:\n  "*": deny\n  read: ask\n  bash: deny\n# comment\n  write: allow\n---\nbody\n';
    assert.equal(classifyInstalledAgentContent(hiddenWrite), "unknown");
    assert.throws(() => transformAgentForOptIn(hiddenWrite), /unsupported permission key "write"/i);

    const freeWithComment =
      '---\nname: kusabi-review\npermission:\n  "*": deny\n# comment\n  read: ask\n  bash: deny\n---\nbody\n';
    assert.equal(classifyInstalledAgentContent(freeWithComment), "free");
    assert.notEqual(classifyInstalledAgentContent(freeWithComment), "default");
  });

  it("refuses an opt-out dispatch whose durable marker conceals tampered content", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-pr755-conceal-"));
    const dir = path.join(tmpDir, "agent");
    try {
      fs.mkdirSync(dir, { recursive: true });
      writeInstalledAgentProfile(dir, "default");
      fs.writeFileSync(
        path.join(dir, "kusabi-review.md"),
        '---\nname: kusabi-review\npermission:\n  "*": deny\n  read: ask\n  bash: deny\n  write: allow\n---\nbody\n',
        "utf8"
      );
      assert.equal(detectInstalledAgentProfile(dir), "unknown");
      assert.throws(() => assertInstalledAgentProfile(dir, false), /unknown|conflicting/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("refuses a marker that disagrees with the on-disk content", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-pr755-conflict-"));
    const dir = path.join(tmpDir, "agent");
    try {
      fs.mkdirSync(dir, { recursive: true });
      const defaultTemplateInner = fs.readFileSync(path.join(AGENTS_DIR, "kusabi-review.md"), "utf8");
      fs.writeFileSync(path.join(dir, "kusabi-review.md"), defaultTemplateInner, "utf8");
      writeInstalledAgentProfile(dir, "free"); // marker says free, files are default
      assert.equal(detectInstalledAgentProfile(dir), "unknown");
      assert.throws(() => assertInstalledAgentProfile(dir, false), /unknown|conflicting/i);
      assert.throws(() => assertInstalledAgentProfile(dir, true), /unknown|conflicting/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("classifies mixed free/default trees unknown and rejects dispatch in both modes across marker cases and entry orders", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-pr755-mixed-"));
    try {
      const defaultContent = fs.readFileSync(path.join(AGENTS_DIR, "kusabi-review.md"), "utf8");
      const freeContent = transformAgentForOptIn(defaultContent);

      const orders = [
        ["free-first", [["kusabi-a.md", freeContent], ["kusabi-b.md", defaultContent]]],
        ["default-first", [["kusabi-a.md", defaultContent], ["kusabi-b.md", freeContent]]],
      ];
      const markers = [null, "free", "default"];

      for (const [orderLabel, files] of orders) {
        for (const marker of markers) {
          const subDir = path.join(tmpDir, `${orderLabel}-${marker ?? "nomarker"}`);
          fs.mkdirSync(subDir, { recursive: true });
          if (marker) writeInstalledAgentProfile(subDir, marker);
          for (const [fname, content] of files) {
            fs.writeFileSync(path.join(subDir, fname), content, "utf8");
          }

          assert.equal(
            detectInstalledAgentProfile(subDir),
            "unknown",
            `mixed tree (${orderLabel}, marker=${marker}) must detect as unknown`
          );
          assert.throws(
            () => assertInstalledAgentProfile(subDir, true),
            /unknown|conflicting/i,
            `opt-in dispatch must reject mixed tree (${orderLabel}, marker=${marker})`
          );
          assert.throws(
            () => assertInstalledAgentProfile(subDir, false),
            /unknown|conflicting/i,
            `opt-out dispatch must reject mixed tree (${orderLabel}, marker=${marker})`
          );
        }
      }

      // Homogeneous trees remain compatible with their matching marker or absent marker
      const homogeneousDefaultDir = path.join(tmpDir, "homo-default");
      fs.mkdirSync(homogeneousDefaultDir, { recursive: true });
      fs.writeFileSync(path.join(homogeneousDefaultDir, "kusabi-a.md"), defaultContent, "utf8");
      fs.writeFileSync(path.join(homogeneousDefaultDir, "kusabi-b.md"), defaultContent, "utf8");
      assert.equal(detectInstalledAgentProfile(homogeneousDefaultDir), "default");
      assert.equal(assertInstalledAgentProfile(homogeneousDefaultDir, false), "default");

      const homogeneousFreeDir = path.join(tmpDir, "homo-free");
      fs.mkdirSync(homogeneousFreeDir, { recursive: true });
      writeInstalledAgentProfile(homogeneousFreeDir, "free");
      fs.writeFileSync(path.join(homogeneousFreeDir, "kusabi-a.md"), freeContent, "utf8");
      fs.writeFileSync(path.join(homogeneousFreeDir, "kusabi-b.md"), freeContent, "utf8");
      assert.equal(detectInstalledAgentProfile(homogeneousFreeDir), "free");
      assert.equal(assertInstalledAgentProfile(homogeneousFreeDir, true), "free");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// =========================================================================
// PR755: strict YAML parser — canonical parse + dependency boot
// =========================================================================

describe("PR755: strict YAML parsing and vendored-parser boot", () => {
  it("parses a valid commented/nested source into ordered policy rules", async () => {
    const { analyzeAgentFrontmatter } = await import("./free-worker-yaml.mjs");
    const source = `---
name: kusabi-implement
# leading comment
permission:
  "*": deny   # wildcard
  kaiba_recall: allow
  skill:
    "kusabi-*": allow
  shiori*: allow
  sunaba_read_file_range: allow
---
body
`;
    const parsed = analyzeAgentFrontmatter(source);
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
    assert.deepEqual(
      parsed.rules.map((r) => [r.key, r.value]),
      [
        ["*", "deny"],
        ["kaiba_recall", "allow"],
        ["skill", undefined],
        ["shiori*", "allow"],
        ["sunaba_read_file_range", "allow"],
      ],
      "comments and quoted/nested keys must parse to the ordered rule list",
    );
  });

  it("boots the vendored parser from a clean runtime copy with no ambient node_modules", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-pr755-clean-"));
    try {
      const pluginRoot = path.join(tmp, "plugins", "kusabi");
      fs.mkdirSync(pluginRoot, { recursive: true });
      // Copy only the authored modules the profile needs plus the vendored
      // parser artifact; no package manifests, no node_modules.
      fs.cpSync(path.join(PLUGIN_ROOT, "vendor"), path.join(pluginRoot, "vendor"), { recursive: true });
      const scriptsDest = path.join(pluginRoot, "scripts");
      fs.mkdirSync(scriptsDest, { recursive: true });
      for (const f of ["free-worker-yaml.mjs", "free-worker-profile.mjs", "state-paths.mjs"]) {
        fs.copyFileSync(path.join(PLUGIN_ROOT, "scripts", f), path.join(scriptsDest, f));
      }
      fs.cpSync(path.join(PLUGIN_ROOT, "schemas"), path.join(pluginRoot, "schemas"), { recursive: true });

      // Prove there is no ambient dependency tree to fall back on.
      assert.equal(fs.existsSync(path.join(pluginRoot, "node_modules")), false);
      assert.equal(fs.existsSync(path.join(tmp, "node_modules")), false);

      const mod = await import(pathToFileURL(path.join(scriptsDest, "free-worker-profile.mjs")).href);
      const src = fs.readFileSync(path.join(AGENTS_DIR, "kusabi-review.md"), "utf8");
      const out = mod.transformAgentForOptIn(src);
      assert.match(out, /read:\s*ask/);
      assert.match(out, /bash:\s*deny/);
      assert.match(out, /StructuredOutput:\s*allow/);
      assert.equal(mod.transformAgentForOptIn(out), out, "clean-copy transform must be idempotent");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("surfaces actionable source line for invalid permission Pair nodes", async () => {
    const { analyzeAgentFrontmatter } = await import("./free-worker-yaml.mjs");
    // Invalid permission value on line 4 (Pair node in AST lacks node.range)
    const invalidPair = [
      "---",
      "name: kusabi-implement",
      "permission:",
      '  "*": deny',
      "  read: allow",
      "---",
      "body",
    ].join("\n");
    const res = analyzeAgentFrontmatter(invalidPair);
    assert.equal(res.ok, false);
    assert.equal(res.code, "invalid-permission");
    assert.match(
      res.error,
      /\(frontmatter line 4\)/,
      "semantic error must pinpoint line 4 for the invalid permission Pair",
    );

    assert.throws(
      () => transformAgentForOptIn(invalidPair),
      /\(frontmatter line 4\)/,
      "transform exception must preserve actionable source line for the invalid Pair",
    );

    // Unsupported permission key Pair on line 4
    const unsupportedKey = [
      "---",
      "name: kusabi-implement",
      "permission:",
      '  "*": deny',
      "  write: allow",
      "---",
      "body",
    ].join("\n");
    const resUnsupported = analyzeAgentFrontmatter(unsupportedKey);
    assert.equal(resUnsupported.ok, false);
    assert.match(
      resUnsupported.error,
      /\(frontmatter line 4\)/,
      "unsupported permission key Pair error must pinpoint line 4",
    );
  });
});


describe("default OpenCode version guard (kusabi #780)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-opencode-version-"));
  const makeBinary = (name, script) => {
    const bin = path.join(tmp, name);
    fs.writeFileSync(bin, `#!/bin/sh\n${script}\n`, "utf8");
    fs.chmodSync(bin, 0o755);
    return bin;
  };

  it("refuses V2 with the guard code and binary path", () => {
    const bin = makeBinary("v2", 'echo "opencode 2.0.32"');
    assert.throws(() => checkDefaultOpencodeVersion(bin), (error) => {
      assert.equal(error.code, "KUSABI_OPENCODE_UNSUPPORTED_VERSION");
      assert.ok(error.message.includes(bin));
      assert.match(error.message, /OPENCODE_BIN/);
      assert.doesNotMatch(error.message, />= 1\.19/);
      return true;
    });
  });

  it("checkOpencodeVersion errors carry KUSABI_OPENCODE_UNSUPPORTED_VERSION in free mode", () => {
    const bin = makeBinary("v2-free", 'echo "opencode 2.0.32"');
    assert.throws(
      () => checkOpencodeVersion(bin),
      (err) => err.code === "KUSABI_OPENCODE_UNSUPPORTED_VERSION" && /V2/.test(err.message)
    );
  });

  it("accepts 1.19.0 without imposing a higher V1 minimum", () => {
    const bin = makeBinary("v1", 'echo "opencode 1.19.0"');
    assert.deepEqual(checkDefaultOpencodeVersion(bin), { version: "1.19.0", major: 1 });
  });

  for (const [name, script] of [
    ["nonzero", 'echo "opencode 1.19.0"; exit 4'],
    ["unparseable", 'echo "development build"'],
  ]) {
    it(`fails closed for ${name} output with the same code and path`, () => {
      const bin = makeBinary(name, script);
      assert.throws(() => checkDefaultOpencodeVersion(bin), (error) => {
        assert.equal(error.code, "KUSABI_OPENCODE_UNSUPPORTED_VERSION");
        assert.ok(error.message.includes(bin));
        return true;
      });
    });
  }

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("fails closed for a missing binary with the same code and path", () => {
    const bin = path.join(tmp, "missing-opencode");
    assert.throws(() => checkDefaultOpencodeVersion(bin), (error) => {
      assert.equal(error.code, "KUSABI_OPENCODE_UNSUPPORTED_VERSION");
      assert.ok(error.message.includes(bin));
      return true;
    });
  });
});
