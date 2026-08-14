import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import {
  newestChainDir,
  PHASE_AGENTS,
  loadConfig,
  readBriefFile,
  __testProbeBindings,
  publishWarningForBrief,
  runChainDriver,
  effectiveTierCount,
  renderChainBanner,
  resolveResumeLastSession,
  resolveReviewDispatch,
  resolveResumeDispatches,
  resolveResumeReviewContext,
  resolveResumeReworkContext,
  buildTaskReviewInput,
  resolveOrchestratorRecord,
  ORCH_SESSION_ENV,
} from "./kusabi-companion.mjs";
import { dispatchWithFallback } from "./prompt-execution.mjs";
import { claudeDispatch } from "./claude-dispatch.mjs";
import {
  parseOrchestratorSignature,
} from "./brief-parsing.mjs";
import {
  readChainControl,
  writeChainControl,
  rearmChainControl,
} from "./chain-control.mjs";
import {
  resolveChainResume,
  computeChainTotals,
} from "./chain-phases.mjs";
import { readJson, writeJson, stateDirFor } from "./state-paths.mjs";

// newestChainDir — chain directory selection by mtime
// ---------------------------------------------------------------------------

describe("newestChainDir", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-chaindir-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the newest chain dir by mtime", () => {
    const oldDir = path.join(tmpDir, "chain-old");
    const newDir = path.join(tmpDir, "chain-new");
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(newDir, { recursive: true });
    const oldTime = new Date("2020-01-01").getTime();
    fs.utimesSync(oldDir, oldTime / 1000, oldTime / 1000);
    const result = newestChainDir(tmpDir);
    assert.equal(result, "chain-new");
  });

  it("returns null when chainsDir does not exist", () => {
    const result = newestChainDir(path.join(tmpDir, "nonexistent"));
    assert.equal(result, null);
  });

  it("returns null when no chain-* directories exist", () => {
    fs.mkdirSync(path.join(tmpDir, "some-other-dir"), { recursive: true });
    const result = newestChainDir(tmpDir);
    assert.equal(result, null);
  });

  it("returns null for empty directory", () => {
    const result = newestChainDir(tmpDir);
    assert.equal(result, null);
  });

  it("only matches chain-* directories", () => {
    fs.mkdirSync(path.join(tmpDir, "not_a_chain_dir"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "chain-real"), { recursive: true });
    const result = newestChainDir(tmpDir);
    assert.equal(result, "chain-real");
  });

  it("picks newest among multiple chain dirs", () => {
    const c1 = path.join(tmpDir, "chain-001");
    const c2 = path.join(tmpDir, "chain-002");
    const c3 = path.join(tmpDir, "chain-003");
    fs.mkdirSync(c1, { recursive: true });
    fs.mkdirSync(c2, { recursive: true });
    fs.mkdirSync(c3, { recursive: true });
    const t1 = new Date("2020-06-01").getTime();
    const t2 = new Date("2020-06-02").getTime();
    const t3 = new Date("2020-06-03").getTime();
    fs.utimesSync(c1, t1 / 1000, t1 / 1000);
    fs.utimesSync(c2, t2 / 1000, t2 / 1000);
    fs.utimesSync(c3, t3 / 1000, t3 / 1000);
    const result = newestChainDir(tmpDir);
    assert.equal(result, "chain-003");
  });

  it("uses lexicographic tiebreaker when mtimes are identical", () => {
    const cA = path.join(tmpDir, "chain-aaa");
    const cB = path.join(tmpDir, "chain-bbb");
    fs.mkdirSync(cA, { recursive: true });
    fs.mkdirSync(cB, { recursive: true });
    const sameTime = new Date("2020-01-01").getTime();
    fs.utimesSync(cA, sameTime / 1000, sameTime / 1000);
    fs.utimesSync(cB, sameTime / 1000, sameTime / 1000);
    const result = newestChainDir(tmpDir);
    // Both have same mtime, "chain-aaa" sorts before "chain-bbb" lexicographically
    assert.equal(result, "chain-aaa");
  });
});

// loadConfig — config file loading
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  /** @type {string} */
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-loadConfig-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no config file exists", () => {
    const result = loadConfig(tmpDir);
    assert.equal(result, null);
  });

  it("returns parsed config when valid JSON with models.chain exists", () => {
    const config = {
      models: {
        chain: ["opencode-go/deepseek-v4-flash", "opencode-go/deepseek-v4-pro"],
      },
    };
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify(config), "utf8");
    const result = loadConfig(tmpDir);
    assert.deepEqual(result, config);
  });

  it("returns parsed config when valid JSON with models.phases exists", () => {
    const config = {
      models: {
        phases: { implement: ["opencode-go/deepseek-v4-flash"] },
      },
    };
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify(config), "utf8");
    const result = loadConfig(tmpDir);
    assert.deepEqual(result, config);
  });

  it("returns parsed config when models key is absent", () => {
    const config = { unrelated: true };
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify(config), "utf8");
    const result = loadConfig(tmpDir);
    assert.deepEqual(result, config);
  });

  it("throws on malformed JSON (unparseable)", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), "not json at all", "utf8");
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes(path.join(tmpDir, "config.json")), "error must mention file path");
        assert.ok(err.message.includes("not valid JSON"), "error must mention invalid JSON");
        return true;
      },
    );
  });

  it("throws on null JSON value", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), "null", "utf8");
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes("must contain a JSON object"));
        return true;
      },
    );
  });

  it("throws on array JSON value", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), "[]", "utf8");
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes("must contain a JSON object"));
        return true;
      },
    );
  });

  it("throws when models is not an object", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({ models: "string" }), "utf8");
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes('"models" must be a JSON object'));
        return true;
      },
    );
  });

  it("throws when models.chain is not an array of strings", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({ models: { chain: "not-array" } }), "utf8");
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes('"models.chain" must be an array'));
        return true;
      },
    );
  });

  it("throws when models.chain is an empty array (must not silently drop built-in defaults)", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({ models: { chain: [] } }), "utf8");
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes('"models.chain" must not be empty'));
        return true;
      },
    );
  });

  it("throws when a models.phases entry is an empty array", () => {
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({ models: { phases: { implement: [] } } }),
      "utf8",
    );
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes('"models.phases.implement" must not be empty'));
        return true;
      },
    );
  });

  it("throws when models.phases.phase is not an array of strings", () => {
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({ models: { phases: { implement: "not-array" } } }),
      "utf8",
    );
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes('"models.phases.implement" must be an array'));
        return true;
      },
    );
  });

  it("throws when models.phases is not an object", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({ models: { phases: "string" } }), "utf8");
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes('"models.phases" must be a JSON object'));
        return true;
      },
    );
  });
});

// readBriefFile — brief-file runtime error paths
// ---------------------------------------------------------------------------

describe("readBriefFile", () => {
  it("returns inline text when no --brief-file flag", () => {
    const result = readBriefFile({}, "hello world");
    assert.equal(result, "hello world");
  });

  it("throws when --brief-file and inline text are both provided", () => {
    assert.throws(
      () => readBriefFile({ "brief-file": "/tmp/x.md" }, "inline text"),
      /--brief-file and inline text are mutually exclusive/,
    );
  });

  it("throws when --brief-file points to a missing file", () => {
    assert.throws(
      () => readBriefFile({ "brief-file": "/nonexistent/path/brief.md" }, ""),
      (err) => {
        assert.ok(err.message.includes("--brief-file: cannot read"));
        assert.ok(err.message.includes("/nonexistent/path/brief.md"));
        return true;
      },
    );
  });

  it("returns file content when --brief-file points to a valid file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-brief-"));
    try {
      const filePath = path.join(tmpDir, "brief.md");
      fs.writeFileSync(filePath, "file content here", "utf8");
      const result = readBriefFile({ "brief-file": filePath }, "");
      assert.equal(result, "file content here");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// orchestrator recording (acceptance criteria 1 & 2)
// ---------------------------------------------------------------------------

describe("orchestrator recording", () => {
  it("produces orchestrator data when brief has a signature (criterion 1)", () => {
    const brief = "Orchestrator: claude-fable-5 | session dfbdc7dc | 2026-07-22\n\nImplement the feature.";
    const text = readBriefFile({}, brief);
    const orchestrator = parseOrchestratorSignature(text);
    // Simulate what cmdTask does: store orchestrator on the job record
    const job = {
      id: "job-123",
      kind: "task",
      title: text.slice(0, 80),
      status: "completed",
      orchestrator: orchestrator,
    };
    assert.deepEqual(job.orchestrator, {
      model: "claude-fable-5",
      session: "dfbdc7dc",
      date: "2026-07-22",
    });
  });

  it("produces null orchestrator when brief has no signature (criterion 2)", () => {
    const brief = "Just a normal brief with no orchestrator line.\n\nDo the work.";
    const text = readBriefFile({}, brief);
    const orchestrator = parseOrchestratorSignature(text);
    // Simulate what cmdTask does: orchestrator is null, job has no field or null
    const job = {
      id: "job-456",
      kind: "task",
      title: text.slice(0, 80),
      status: "completed",
      orchestrator: orchestrator,
    };
    assert.equal(job.orchestrator, null);
  });

  it("readBriefFile with --brief-file flag is not needed for inline briefs", () => {
    const brief = "Orchestrator: gpt-4 | session abc123 | 2026-01-01\n\nTask description";
    const text = readBriefFile({}, brief);
    const orchestrator = parseOrchestratorSignature(text);
    assert.deepEqual(orchestrator, {
      model: "gpt-4",
      session: "abc123",
      date: "2026-01-01",
    });
  });
});

// orchestrator session from the environment (kusabi #227)
// ---------------------------------------------------------------------------
// The session recorded on job/chain records must come from
// CLAUDE_CODE_SESSION_ID when the companion runs inside an orchestrator
// session: metrics-report joins chain.orch_session as a PREFIX of transcript
// session ids, and a hand-typed label can never join.  The signature line
// keeps supplying model/date, and supplies session only as the fallback.

describe("resolveOrchestratorRecord (kusabi #227)", () => {
  const SIGNED = "Orchestrator: claude-fable-5 | session cc-20260811-215 | 2026-08-12\n\nDo the work.";
  const UNSIGNED = "Just a normal brief with no orchestrator line.\n\nDo the work.";
  const ENV_UUID = "edafbf9f-03ae-4bce-ba2e-8d2d07af5f58";

  it("env session beats the hand-typed signature session; model/date still come from the line", () => {
    const record = resolveOrchestratorRecord(SIGNED, { [ORCH_SESSION_ENV]: ENV_UUID });
    assert.deepEqual(record, {
      model: "claude-fable-5",
      session: ENV_UUID,
      date: "2026-08-12",
      sessionSource: "env",
    });
  });

  it("without the env var the signature session is recorded, exactly as before", () => {
    const record = resolveOrchestratorRecord(SIGNED, {});
    assert.deepEqual(record, {
      model: "claude-fable-5",
      session: "cc-20260811-215",
      date: "2026-08-12",
    });
    // The provenance marker must not appear on this path: its absence is what
    // every record written before #227 means.
    assert.deepEqual(record, parseOrchestratorSignature(SIGNED));
    assert.ok(!("sessionSource" in record));
  });

  it("an empty or whitespace-only env var is treated as absent", () => {
    for (const value of ["", "   ", "\n"]) {
      assert.deepEqual(resolveOrchestratorRecord(SIGNED, { [ORCH_SESSION_ENV]: value }),
        parseOrchestratorSignature(SIGNED));
    }
  });

  it("no signature and no env var still records nothing (null), as today", () => {
    assert.equal(resolveOrchestratorRecord(UNSIGNED, {}), null);
    assert.equal(resolveOrchestratorRecord(UNSIGNED, { [ORCH_SESSION_ENV]: "  " }), null);
    assert.equal(resolveOrchestratorRecord("", {}), null);
    assert.equal(resolveOrchestratorRecord(null, {}), null);
  });

  it("env var with no signature line at all persists a record carrying the env session", () => {
    const record = resolveOrchestratorRecord(UNSIGNED, { [ORCH_SESSION_ENV]: ENV_UUID });
    assert.deepEqual(record, {
      model: null,
      session: ENV_UUID,
      date: null,
      sessionSource: "env",
    });
  });

  it("a signature line without a session field takes the env session", () => {
    const brief = "Orchestrator: claude-fable-5\n\nDo the work.";
    const record = resolveOrchestratorRecord(brief, { [ORCH_SESSION_ENV]: ENV_UUID });
    assert.equal(record.model, "claude-fable-5");
    assert.equal(record.session, ENV_UUID);
    assert.equal(record.sessionSource, "env");
  });

  it("the env var is trimmed before it is recorded", () => {
    const record = resolveOrchestratorRecord(SIGNED, { [ORCH_SESSION_ENV]: `  ${ENV_UUID}\n` });
    assert.equal(record.session, ENV_UUID);
  });

  it("provenance is machine-readable: sessionSource === 'env' vs absent for the signature", () => {
    const fromEnv = resolveOrchestratorRecord(SIGNED, { [ORCH_SESSION_ENV]: ENV_UUID });
    const fromSignature = resolveOrchestratorRecord(SIGNED, {});
    assert.equal(fromEnv.sessionSource, "env");
    assert.equal(fromSignature.sessionSource, undefined);
  });

  it("keeps the reader contract: model/session/date are the same fields chain-ingest reads", () => {
    // chain-ingest.mjs stores orchestrator.model / .session / .date when each
    // is a string; nothing there (or in metrics-report.mjs) had to change.
    const record = resolveOrchestratorRecord(SIGNED, { [ORCH_SESSION_ENV]: ENV_UUID });
    assert.equal(typeof record.model, "string");
    assert.equal(typeof record.session, "string");
    assert.equal(typeof record.date, "string");
  });

  it("reads process.env when no env object is passed", () => {
    const saved = process.env[ORCH_SESSION_ENV];
    // With the env var deleted, the 1-arg call falls through to the cursor
    // usage dir — on a dev host that dir can hold a REAL session whose cwd
    // matches this repo (container-green, host-red).  Pin it to a
    // nonexistent dir so the signature assertion stays hermetic.
    const savedDir = process.env.KUSABI_CURSOR_USAGE_DIR;
    try {
      process.env.KUSABI_CURSOR_USAGE_DIR = path.join(import.meta.dirname, "no-such-cursor-usage-dir");
      process.env[ORCH_SESSION_ENV] = ENV_UUID;
      assert.equal(resolveOrchestratorRecord(SIGNED).session, ENV_UUID);
      delete process.env[ORCH_SESSION_ENV];
      assert.equal(resolveOrchestratorRecord(SIGNED).session, "cc-20260811-215");
    } finally {
      if (saved === undefined) delete process.env[ORCH_SESSION_ENV];
      else process.env[ORCH_SESSION_ENV] = saved;
      if (savedDir === undefined) delete process.env.KUSABI_CURSOR_USAGE_DIR;
      else process.env.KUSABI_CURSOR_USAGE_DIR = savedDir;
    }
  });

  it("both dispatch sites resolve through it, not through the bare parser (source guard)", () => {
    // cmdTask / cmdChain are not exported; this pins the wiring.
    const source = fs.readFileSync(path.join(import.meta.dirname, "kusabi-companion.mjs"), "utf8");
    const cmdTaskSource = source.slice(source.indexOf("async function cmdTask("), source.indexOf("async function cmdReview("));
    const cmdChainSource = source.slice(source.indexOf("async function cmdChain("));
    assert.ok(cmdTaskSource.includes("const orchestrator = resolveOrchestratorRecord(text);"));
    assert.ok(cmdChainSource.includes("const orchestrator = resolveOrchestratorRecord(text);"));
    // No dispatch site may bypass the resolution by parsing the brief itself.
    assert.ok(!cmdTaskSource.includes("parseOrchestratorSignature("));
    assert.ok(!cmdChainSource.includes("parseOrchestratorSignature("));
  });
});

describe("resolveOrchestratorRecord cursor-statusline fallback (kusabi #237)", () => {
  const SIGNED = "Orchestrator: claude-fable-5 | session cc-20260811-215 | 2026-08-12\n\nDo the work.";
  const UNSIGNED = "Just a normal brief with no orchestrator line.\n\nDo the work.";
  const ENV_UUID = "edafbf9f-03ae-4bce-ba2e-8d2d07af5f58";
  const CURSOR_UUID = "d73008ab-aaaa-bbbb-cccc-ddddeeeeffff";
  const CWD = "/home/masuda/dev/projects/claude";
  const NOW = Date.parse("2026-08-14T12:00:00.000Z");

  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-orch-cursor-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeUsage(id, rec) {
    fs.writeFileSync(path.join(tmpDir, `${id}.jsonl`), `${JSON.stringify(rec)}\n`);
  }

  function freshCursor(overrides = {}) {
    writeUsage(CURSOR_UUID, {
      ts: "2026-08-14T11:50:00.000Z",
      session_id: CURSOR_UUID,
      cwd: CWD,
      model: { id: "default", display_name: "Auto" },
      context_window: null,
      ...overrides,
    });
  }

  const cursorOpts = () => ({ dir: tmpDir, cwd: CWD, now: NOW });

  it("env still wins even when a matching cursor session exists (byte-identical to #227)", () => {
    freshCursor();
    const record = resolveOrchestratorRecord(
      SIGNED,
      { [ORCH_SESSION_ENV]: ENV_UUID, KUSABI_CURSOR_USAGE_DIR: tmpDir },
      cursorOpts(),
    );
    assert.deepEqual(record, {
      model: "claude-fable-5",
      session: ENV_UUID,
      date: "2026-08-12",
      sessionSource: "env",
    });
  });

  it("without env and without cursor state the signature record is unchanged", () => {
    const record = resolveOrchestratorRecord(SIGNED, {});
    assert.deepEqual(record, parseOrchestratorSignature(SIGNED));
    assert.ok(!("sessionSource" in record));
  });

  it("without env and without cursor state an unsigned brief is still null", () => {
    assert.equal(resolveOrchestratorRecord(UNSIGNED, {}), null);
  });

  it("no env + cwd-matching fresh session records sessionSource cursor-statusline", () => {
    freshCursor();
    const record = resolveOrchestratorRecord(SIGNED, {}, cursorOpts());
    assert.deepEqual(record, {
      model: "claude-fable-5",
      session: CURSOR_UUID,
      date: "2026-08-12",
      sessionSource: "cursor-statusline",
    });
  });

  it("unsigned brief still persists a cursor session with null model/date", () => {
    freshCursor();
    const record = resolveOrchestratorRecord(UNSIGNED, {}, cursorOpts());
    assert.deepEqual(record, {
      model: null,
      session: CURSOR_UUID,
      date: null,
      sessionSource: "cursor-statusline",
    });
  });

  it("does not fire when the only sessions have a different cwd", () => {
    freshCursor({ cwd: "/some/other/project" });
    const record = resolveOrchestratorRecord(SIGNED, {}, cursorOpts());
    assert.deepEqual(record, parseOrchestratorSignature(SIGNED));
    assert.ok(!("sessionSource" in record));
  });

  it("does not fire when the matching session's last-line ts is older than 24h", () => {
    freshCursor({ ts: "2026-08-13T11:00:00.000Z" });
    const record = resolveOrchestratorRecord(SIGNED, {}, cursorOpts());
    assert.deepEqual(record, parseOrchestratorSignature(SIGNED));
  });

  it("picks the newest of several cwd-matching sessions", () => {
    writeUsage("older", {
      ts: "2026-08-14T10:00:00.000Z",
      session_id: "older",
      cwd: CWD,
    });
    writeUsage("newer", {
      ts: "2026-08-14T11:40:00.000Z",
      session_id: "newer",
      cwd: CWD,
    });
    writeUsage("neighbour", {
      ts: "2026-08-14T11:59:00.000Z",
      session_id: "neighbour",
      cwd: "/elsewhere",
    });
    const record = resolveOrchestratorRecord(SIGNED, {}, cursorOpts());
    assert.equal(record.session, "newer");
    assert.equal(record.sessionSource, "cursor-statusline");
  });

  it("resolves the usage dir from KUSABI_CURSOR_USAGE_DIR on the injected env", () => {
    freshCursor();
    const record = resolveOrchestratorRecord(
      SIGNED,
      { KUSABI_CURSOR_USAGE_DIR: tmpDir },
      { cwd: CWD, now: NOW },
    );
    assert.equal(record.session, CURSOR_UUID);
    assert.equal(record.sessionSource, "cursor-statusline");
  });

  it("a whitespace-only env var falls through to the cursor branch", () => {
    freshCursor();
    const record = resolveOrchestratorRecord(
      SIGNED,
      { [ORCH_SESSION_ENV]: "  ", KUSABI_CURSOR_USAGE_DIR: tmpDir },
      { cwd: CWD, now: NOW },
    );
    assert.equal(record.sessionSource, "cursor-statusline");
    assert.equal(record.session, CURSOR_UUID);
  });

  it("missing usage dir is treated as no cursor state, not an exception", () => {
    const record = resolveOrchestratorRecord(
      SIGNED,
      {},
      { dir: path.join(tmpDir, "absent"), cwd: CWD, now: NOW },
    );
    assert.deepEqual(record, parseOrchestratorSignature(SIGNED));
  });
});

// cmdTask probe binding regression test
// ---------------------------------------------------------------------------
// Verifies that the probe functions are locally bound in kusabi-companion.mjs
// so cmdTask (internal function, not exported) can call them without
// ReferenceError.  Before the fix, they were only re-exported via
// `export { X } from "..."` which creates NO local binding.

describe("probe function local bindings", () => {
  it("returns 'function' for all four probe bindings (regression: would have been 'undefined' before fix)", () => {
    const bindings = __testProbeBindings();
    assert.equal(bindings.runSmokeProbe, "function");
    assert.equal(bindings.runHeadCleanProbe, "function");
    assert.equal(bindings.runVerifyProbe, "function");
    assert.equal(bindings.runDeliverablesProbe, "function");
  });
});

// PHASE_AGENTS — maps phase names to agent definition filenames
// ---------------------------------------------------------------------------

describe("PHASE_AGENTS", () => {
  it("contains 7 entries", () => {
    assert.equal(Object.keys(PHASE_AGENTS).length, 7);
  });

  it("maps gofer to kusabi-gofer", () => {
    assert.equal(PHASE_AGENTS.gofer, "kusabi-gofer");
  });

  it("maps all known phases", () => {
    assert.equal(PHASE_AGENTS.draft, "kusabi-draft");
    assert.equal(PHASE_AGENTS.investigate, "kusabi-investigate");
    assert.equal(PHASE_AGENTS.implement, "kusabi-implement");
    assert.equal(PHASE_AGENTS.review, "kusabi-review");
    assert.equal(PHASE_AGENTS.respond, "kusabi-respond");
    assert.equal(PHASE_AGENTS.salvage, "kusabi-salvage");
  });

  it("every phase value ends with a .md file in opencode-agents directory", () => {
    const agentsDir = path.resolve(import.meta.dirname, "..", "opencode-agents");
    for (const [, agentName] of Object.entries(PHASE_AGENTS)) {
      const filePath = path.join(agentsDir, `${agentName}.md`);
      assert.ok(fs.existsSync(filePath), `agent file missing: ${filePath}`);
    }
  });
});

// resolveResumeLastSession — the --resume-last SELECTION seam (kusabi #184
// Job B).  Both backends share one job store, so the previous job must be of
// the SAME backend as the current dispatch; a missing `backend` field
// predates the backend split and counts as "opencode".
// ---------------------------------------------------------------------------

describe("resolveResumeLastSession", () => {
  let tmpDir;
  let stateDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-resume-last-"));
    stateDir = path.join(tmpDir, "state");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function addJob(id, job) {
    const dir = path.join(stateDir, "jobs", id);
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, "job.json"), {
      id,
      kind: "task",
      status: "completed",
      startedAt: "2026-08-01T00:00:00.000Z",
      ...job,
    });
  }

  it("claude picks the last claude job, skipping a newer opencode job", () => {
    addJob("job-newer-opencode", { sessionID: "ses_opencode_latest", startedAt: "2026-08-02T00:00:00.000Z" });
    addJob("job-older-claude", { backend: "claude", sessionID: "claude-uuid-1", startedAt: "2026-08-01T00:00:00.000Z" });
    assert.equal(resolveResumeLastSession(stateDir, { backend: "claude" }), "claude-uuid-1");
  });

  it("opencode picks the last opencode job, skipping a newer claude job", () => {
    addJob("job-newer-claude", { backend: "claude", sessionID: "claude-uuid-2", startedAt: "2026-08-02T00:00:00.000Z" });
    addJob("job-older-opencode", { sessionID: "ses_opencode_1", startedAt: "2026-08-01T00:00:00.000Z" });
    assert.equal(resolveResumeLastSession(stateDir, { backend: "opencode" }), "ses_opencode_1");
  });

  it("a missing backend field counts as opencode (both directions)", () => {
    addJob("job-no-backend", { sessionID: "ses_opencode_legacy", startedAt: "2026-08-02T00:00:00.000Z" });
    addJob("job-claude", { backend: "claude", sessionID: "claude-uuid-3", startedAt: "2026-08-01T00:00:00.000Z" });
    assert.equal(resolveResumeLastSession(stateDir, { backend: "opencode" }), "ses_opencode_legacy");
    assert.equal(resolveResumeLastSession(stateDir, { backend: "claude" }), "claude-uuid-3");
  });

  it("honors the phase filter (task jobs of that phase only)", () => {
    addJob("job-review-phase", { phase: "review", sessionID: "ses_review", startedAt: "2026-08-01T00:00:00.000Z" });
    addJob("job-implement-phase", { phase: "implement", sessionID: "ses_implement", startedAt: "2026-08-02T00:00:00.000Z" });
    assert.equal(resolveResumeLastSession(stateDir, { phase: "implement", backend: "opencode" }), "ses_implement");
    assert.equal(resolveResumeLastSession(stateDir, { phase: "review", backend: "opencode" }), "ses_review");
    // Without a phase: the newest task job of the backend wins.
    assert.equal(resolveResumeLastSession(stateDir, { backend: "opencode" }), "ses_implement");
  });

  it("ignores non-task jobs", () => {
    addJob("job-review", { kind: "review", sessionID: "ses_review", startedAt: "2026-08-02T00:00:00.000Z" });
    addJob("job-task", { sessionID: "ses_task", startedAt: "2026-08-01T00:00:00.000Z" });
    assert.equal(resolveResumeLastSession(stateDir, { backend: "opencode" }), "ses_task");
  });

  it("returns null when no same-backend job exists (the caller errors naming the backend)", () => {
    addJob("job-claude-only", { backend: "claude", sessionID: "claude-uuid-4", startedAt: "2026-08-02T00:00:00.000Z" });
    assert.equal(resolveResumeLastSession(stateDir, { backend: "opencode" }), null);
    assert.equal(resolveResumeLastSession(stateDir, { backend: "claude" }), "claude-uuid-4");
  });
});

// worker-context guard (kusabi #136 fix 3) — job-creating subcommands must
// be refused when KUSABI_WORKER_CONTEXT is set, before any server contact.
// These tests spawn the CLI as a real subprocess (execFile-style, via
// spawnSync) since the guard lives in main()'s dispatch, not in an exported
// function — it fires on process.env before parseArgs/dispatch even run, so
// no live opencode serve is needed.
// ---------------------------------------------------------------------------

describe("worker-context guard (KUSABI_WORKER_CONTEXT)", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");

  function runCompanion(args, { workerContext = false } = {}) {
    const env = { ...process.env };
    if (workerContext) env.KUSABI_WORKER_CONTEXT = "1";
    else delete env.KUSABI_WORKER_CONTEXT;
    return spawnSync(process.execPath, [COMPANION_SCRIPT, ...args], {
      encoding: "utf8",
      env,
      timeout: 10_000,
    });
  }

  it("refuses task with a message stating both the reason and the alternative", () => {
    const result = runCompanion(["task", "q"], { workerContext: true });
    assert.match(result.stdout, /KUSABI_WORKER_CONTEXT/);
    assert.match(result.stdout, /final answer|orchestrator decide/i);
  });

  it("refuses task under the marker with a non-zero exit", () => {
    const result = runCompanion(["task", "q"], { workerContext: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /worker context/i);
  });

  it("refuses review under the marker with a non-zero exit", () => {
    const result = runCompanion(["review", "q"], { workerContext: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /worker context/i);
  });

  it("refuses salvage under the marker with a non-zero exit", () => {
    const result = runCompanion(["salvage", "job-does-not-exist"], { workerContext: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /worker context/i);
  });

  it("refuses chain under the marker with a non-zero exit", () => {
    const result = runCompanion(["chain", "q"], { workerContext: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /worker context/i);
  });

  it("status still exits 0 under the marker (read-only subcommands stay allowed)", () => {
    const result = runCompanion(["status"], { workerContext: true });
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /worker context/i);
  });

  it("does not fire without the marker: task fails on its own arg validation, not the guard", () => {
    // `task` with no description errors out before any server contact, so this
    // proves the guard stays quiet when KUSABI_WORKER_CONTEXT is absent — a
    // guard that fired unconditionally would print the worker-context refusal
    // here instead of the arg error.
    const result = runCompanion(["task"], { workerContext: false });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /task requires a task description/);
    assert.doesNotMatch(result.stdout, /worker context/i);
  });
});

// metrics-ingest / metrics-report — delegated jobs end to end (#154).
// Spawns the CLI as a real subprocess against fixture directories: a state
// root containing one workspace with two jobs (one complete with usage.json,
// one that died before writing usage), and an empty transcript dir.  Proves
// the wiring in cmdMetricsIngest / cmdMetricsReport, not just the modules.
// ---------------------------------------------------------------------------

describe("metrics-ingest / metrics-report — delegated jobs (#154)", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");
  let tmpDir;
  let stateRoot;
  let transcriptDir;
  let cursorUsageDir;
  let dbPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-metrics-jobs-"));
    stateRoot = path.join(tmpDir, "state");
    transcriptDir = path.join(tmpDir, "transcripts");
    cursorUsageDir = path.join(tmpDir, "cursor-usage");
    dbPath = path.join(tmpDir, "metrics.db");
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.mkdirSync(cursorUsageDir, { recursive: true });

    const jobsDir = path.join(stateRoot, "ws-hash-1", "jobs");
    const completeDir = path.join(jobsDir, "job-complete01");
    fs.mkdirSync(completeDir, { recursive: true });
    fs.writeFileSync(path.join(completeDir, "job.json"), JSON.stringify({
      id: "job-complete01",
      kind: "task",
      status: "completed",
      startedAt: "2026-08-01T10:00:00.000Z",
      finishedAt: "2026-08-01T10:26:15.000Z",
      stats: { steps: 152 },
    }), "utf8");
    fs.writeFileSync(path.join(completeDir, "usage.json"), JSON.stringify({
      available: true,
      input: 5000,
      output: 82419,
      reasoning: 102005,
      cost: 0,
      durationSeconds: 1575,
    }), "utf8");

    const deadDir = path.join(jobsDir, "job-diedearly02");
    fs.mkdirSync(deadDir, { recursive: true });
    fs.writeFileSync(path.join(deadDir, "job.json"), JSON.stringify({
      id: "job-diedearly02",
      kind: "task",
      status: "error",
      startedAt: "2026-08-01T11:00:00.000Z",
      error: "boom",
      stats: { steps: 3 },
    }), "utf8");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runCompanion(args) {
    return spawnSync(process.execPath, [COMPANION_SCRIPT, ...args], {
      encoding: "utf8",
      timeout: 30_000,
    });
  }

  it("metrics-ingest reports the job counters and metrics-report shows the delegated jobs section", () => {
    const ingest = runCompanion([
      "metrics-ingest",
      "--state-root", stateRoot,
      "--transcript-dir", transcriptDir,
      "--cursor-usage-dir", cursorUsageDir,
      "--db", dbPath,
    ]);
    assert.equal(ingest.status, 0, `ingest failed: ${ingest.stdout} ${ingest.stderr}`);
    assert.match(ingest.stdout, /Jobs \(delegated single-shot task\/review jobs\):/);
    assert.match(ingest.stdout, /jobs scanned:\s+2/);
    assert.match(ingest.stdout, /jobs ingested:\s+2/);
    assert.match(ingest.stdout, /jobs without usage\.json \(ended before usage was written\): 1/);

    const report = runCompanion(["metrics-report", "--db", dbPath]);
    assert.equal(report.status, 0, `report failed: ${report.stdout} ${report.stderr}`);
    assert.match(report.stdout, /Delegated jobs/);
    assert.match(report.stdout, /job-complete01/);
    assert.match(report.stdout, /job-diedearly02/);
    assert.match(report.stdout, /cost 0\.00/); // free-tier zero is a measurement
    assert.match(report.stdout, /usage\.json never written/);
    assert.match(report.stdout, /jobs: 2/);

    // Windowed out: --since past every fixture start leaves the section
    // present but explicitly empty.
    const windowed = runCompanion(["metrics-report", "--db", dbPath, "--since", "2099-01-01T00:00:00Z"]);
    assert.equal(windowed.status, 0);
    assert.match(windowed.stdout, /Delegated jobs/);
    assert.match(windowed.stdout, /\(no data in window\)/);
  });

  it("re-running metrics-ingest skips both jobs as unchanged (idempotent and cheap)", () => {
    const first = runCompanion([
      "metrics-ingest", "--state-root", stateRoot, "--transcript-dir", transcriptDir, "--cursor-usage-dir", cursorUsageDir, "--db", dbPath,
    ]);
    assert.equal(first.status, 0);
    const second = runCompanion([
      "metrics-ingest", "--state-root", stateRoot, "--transcript-dir", transcriptDir, "--cursor-usage-dir", cursorUsageDir, "--db", dbPath,
    ]);
    assert.equal(second.status, 0);
    assert.match(second.stdout, /jobs skipped \(unchanged\):\s+2/);
    assert.match(second.stdout, /jobs ingested:\s+0/);
  });

  it("a state root with no jobs at all still prints the Jobs block with zeros (visible, not silent)", () => {
    const emptyRoot = path.join(tmpDir, "empty-state");
    fs.mkdirSync(emptyRoot, { recursive: true });
    const result = runCompanion([
      "metrics-ingest", "--state-root", emptyRoot, "--transcript-dir", transcriptDir, "--cursor-usage-dir", cursorUsageDir, "--dry-run",
    ]);
    assert.equal(result.status, 0, `dry-run failed: ${result.stdout} ${result.stderr}`);
    assert.match(result.stdout, /Jobs \(delegated single-shot task\/review jobs\):/);
    assert.match(result.stdout, /jobs scanned:\s+0/);
    assert.match(result.stdout, /jobs ingested:\s+0/);
  });
});

// metrics-ingest — cursor-usage jsonl + missing-dir warnings (#237)
// ---------------------------------------------------------------------------

describe("metrics-ingest — cursor-usage and missing-dir warnings (#237)", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-metrics-cursor-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runCompanion(args) {
    return spawnSync(process.execPath, [COMPANION_SCRIPT, ...args], {
      encoding: "utf8",
      timeout: 30_000,
    });
  }

  it("--help lists --cursor-usage-dir", () => {
    const result = runCompanion(["--help"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--cursor-usage-dir <path> \(metrics-ingest: default ~\/\.kusabi\/cursor-usage\)/);
  });

  it("warns when transcript-dir and cursor-usage-dir do not exist, and reports cursor files/sessions/turns", () => {
    const missingTranscript = path.join(tmpDir, "no-claude");
    const cursorDir = path.join(tmpDir, "cu237");
    const emptyState = path.join(tmpDir, "state");
    const dbPath = path.join(tmpDir, "m237.db");
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.mkdirSync(emptyState, { recursive: true });

    const sessionId = "d73008ab-1111-2222-3333-444444444444";
    const rec = (ts, usage) => JSON.stringify({
      ts,
      session_id: sessionId,
      model: { id: "default", display_name: "Auto" },
      cwd: "/workspace",
      context_window: usage === null
        ? { current_usage: null }
        : { current_usage: {
          input_tokens: usage.input,
          output_tokens: usage.output,
          cache_read_input_tokens: usage.cacheRead,
          cache_creation_input_tokens: usage.cacheWrite,
        } },
    });
    fs.writeFileSync(path.join(cursorDir, `${sessionId}.jsonl`), [
      rec("2026-08-14T10:00:00.000Z", null),
      rec("2026-08-14T10:00:05.000Z", null),
      rec("2026-08-14T10:00:10.000Z", { input: 10, output: 2, cacheRead: 3, cacheWrite: 4 }),
      rec("2026-08-14T10:00:20.000Z", { input: 11, output: 5, cacheRead: 6, cacheWrite: 7 }),
    ].join("\n") + "\n", "utf8");

    const ingest = runCompanion([
      "metrics-ingest",
      "--state-root", emptyState,
      "--transcript-dir", missingTranscript,
      "--cursor-usage-dir", cursorDir,
      "--db", dbPath,
    ]);
    assert.equal(ingest.status, 0, `ingest failed: ${ingest.stdout} ${ingest.stderr}`);
    assert.match(ingest.stdout, new RegExp(`warning: transcript dir not found: ${missingTranscript.replace(/\\/g, "\\\\")}`));
    assert.doesNotMatch(ingest.stdout, /warning: cursor-usage dir not found/);
    assert.match(ingest.stdout, /Cursor usage:/);
    assert.match(ingest.stdout, /files scanned:\s+1/);
    assert.match(ingest.stdout, /sessions:\s+1/);
    assert.match(ingest.stdout, /turns:\s+2/);

    const second = runCompanion([
      "metrics-ingest",
      "--state-root", emptyState,
      "--transcript-dir", missingTranscript,
      "--cursor-usage-dir", cursorDir,
      "--db", dbPath,
    ]);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /files skipped \(unchanged\):\s+1/);
    assert.match(second.stdout, /turns:\s+0/);
  });

  it("warns when cursor-usage-dir is missing and does not warn when the dir exists but is empty", () => {
    const transcriptDir = path.join(tmpDir, "transcripts");
    const missingCursor = path.join(tmpDir, "no-cursor");
    const emptyCursor = path.join(tmpDir, "empty-cursor");
    const emptyState = path.join(tmpDir, "state");
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.mkdirSync(emptyCursor, { recursive: true });
    fs.mkdirSync(emptyState, { recursive: true });

    const missing = runCompanion([
      "metrics-ingest",
      "--state-root", emptyState,
      "--transcript-dir", transcriptDir,
      "--cursor-usage-dir", missingCursor,
      "--dry-run",
    ]);
    assert.equal(missing.status, 0, missing.stderr);
    assert.match(missing.stdout, new RegExp(`warning: cursor-usage dir not found: ${missingCursor.replace(/\\/g, "\\\\")}`));
    assert.doesNotMatch(missing.stdout, /warning: transcript dir not found/);

    const empty = runCompanion([
      "metrics-ingest",
      "--state-root", emptyState,
      "--transcript-dir", transcriptDir,
      "--cursor-usage-dir", emptyCursor,
      "--dry-run",
    ]);
    assert.equal(empty.status, 0, empty.stderr);
    assert.doesNotMatch(empty.stdout, /warning: transcript dir not found/);
    assert.doesNotMatch(empty.stdout, /warning: cursor-usage dir not found/);
    assert.match(empty.stdout, /Cursor usage:/);
    assert.match(empty.stdout, /files scanned:\s+0/);
  });
});

// publishWarningForBrief — chain-start publish guard (kusabi #153)
// ---------------------------------------------------------------------------
// publish is orchestrator-exclusive; a brief that demands it cannot be
// executed by the worker.  The chain prints this warning verbatim at start.
// The exact text is fixed here so the runtime output cannot drift.

describe("publishWarningForBrief", () => {
  it("returns the warning for a brief that demands publish", () => {
    const warning = publishWarningForBrief("## PUBLISH (mandatory)\n\nDo the work.");
    assert.ok(warning, "warning must be non-null");
    assert.match(warning, /publish を要求している/);
    assert.match(warning, /ワーカーは publish できない/);
    assert.match(warning, /オーケストレーター専権/);
  });

  it("returns the warning for inline 'PUBLISH must ...' style demands", () => {
    const warning = publishWarningForBrief("Fix the bug. PUBLISH must happen after the gate.");
    assert.ok(warning);
    assert.match(warning, /オーケストレーター専権/);
  });

  it("returns null when the brief does not demand publish", () => {
    assert.equal(publishWarningForBrief("Implement the feature and verify."), null);
    assert.equal(publishWarningForBrief("publish is orchestrator-exclusive; workers cannot call it."), null);
    assert.equal(publishWarningForBrief(""), null);
  });

  it("is exactly one line (no embedded newlines)", () => {
    const warning = publishWarningForBrief("## PUBLISH (mandatory)");
    assert.equal(warning.split("\n").length, 1);
  });
});

// standalone review — --container rejection (kusabi #153 #2)
// ---------------------------------------------------------------------------
// `review --container <cid>` used to silently ignore the flag, read the HOST
// worktree's git state, fail on the container-only --base, and crash with
// "findings.forEach is not a function".  The flag must now be rejected early
// with guidance to the sanctioned container-review route.  Spawned as a real
// subprocess: the rejection fires before any server contact, so no opencode
// serve or sunaba endpoint is needed.

describe("review --container rejection", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");

  function runCompanion(args, cwd) {
    const env = { ...process.env };
    delete env.KUSABI_WORKER_CONTEXT;
    return spawnSync(process.execPath, [COMPANION_SCRIPT, ...args], {
      encoding: "utf8",
      cwd,
      env,
      timeout: 15_000,
    });
  }

  it("rejects --container early with guidance and no forEach crash", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-review-cid-"));
    try {
      const result = runCompanion(
        ["review", "--container", "deadbeef123456", "--base", "e1ed885", "review focus text"],
        tmpDir,
      );
      assert.notEqual(result.status, 0, `expected failure, got: ${result.stdout}`);
      assert.match(result.stdout, /review does not support --container/);
      assert.match(result.stdout, /task --phase review --container deadbeef123456/);
      assert.match(result.stdout, /--brief-file/);
      assert.doesNotMatch(result.stdout, /forEach is not a function/);
      assert.doesNotMatch(result.stdout, /worker context/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects --container before touching git (no repo needed)", () => {
    // The failure mode being fixed was git failing FIRST (silent flag ignore).
    // The rejection must fire before any git call, so a non-git cwd proves it.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-review-cid2-"));
    try {
      const result = runCompanion(["review", "--container", "abc", "text"], tmpDir);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /review does not support --container/);
      assert.doesNotMatch(result.stdout, /git diff/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// --backend is a task/chain dispatch decision (kusabi #184): on any other
// subcommand it must be rejected out loud instead of silently ignored, and
// an unknown backend value must be a clear error with a nonzero exit.
describe("--backend flag guard", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");

  function runCompanion(args, cwd) {
    const env = { ...process.env };
    delete env.KUSABI_WORKER_CONTEXT;
    return spawnSync(process.execPath, [COMPANION_SCRIPT, ...args], {
      encoding: "utf8",
      cwd,
      env,
      timeout: 15_000,
    });
  }

  it("rejects --backend on a non-task/chain subcommand with guidance", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-backend-guard-"));
    try {
      const result = runCompanion(["review", "--backend", "claude", "focus"], tmpDir);
      assert.notEqual(result.status, 0, `expected failure, got: ${result.stdout}`);
      assert.match(result.stdout, /--backend is only supported by task and chain/);
      assert.doesNotMatch(result.stdout, /worker context/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown backend value for task with a clear error", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-backend-guard2-"));
    try {
      const result = runCompanion(["task", "--backend", "bogus", "do it"], tmpDir);
      assert.notEqual(result.status, 0, `expected failure, got: ${result.stdout}`);
      assert.match(result.stdout, /unknown backend: bogus/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// standalone review — git failure produces a clear error, not a forEach crash
// (kusabi #153 #2)
// ---------------------------------------------------------------------------
// A host-worktree git failure used to be swallowed into an error string that
// went into the review prompt; the model answered garbage and the user saw
// "findings.forEach is not a function".  Now the failure aborts the review
// with the real cause before any dispatch.

describe("review git failure", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");

  function makeEmptyRepo() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-review-git-"));
    const repoDir = path.join(tmpDir, "repo");
    fs.mkdirSync(repoDir);
    const init = spawnSync("git", ["init", "-q"], { cwd: repoDir, encoding: "utf8" });
    assert.equal(init.status, 0, `git init failed: ${init.stderr}`);
    return tmpDir;
  }

  function runCompanion(args, cwd) {
    const env = { ...process.env };
    delete env.KUSABI_WORKER_CONTEXT;
    return spawnSync(process.execPath, [COMPANION_SCRIPT, ...args], {
      encoding: "utf8",
      cwd,
      env,
      timeout: 15_000,
    });
  }

  it("fails with a clear git error when --base is not a revision in the host worktree", () => {
    const tmpDir = makeEmptyRepo();
    try {
      const result = runCompanion(["review", "--base", "e1ed885", "focus"], path.join(tmpDir, "repo"));
      assert.notEqual(result.status, 0, `expected failure, got: ${result.stdout}`);
      assert.match(result.stdout, /git diff .* failed/);
      assert.match(result.stdout, /host worktree/);
      assert.doesNotMatch(result.stdout, /forEach is not a function/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("fails with a clear git error in an empty repo (git diff HEAD fails)", () => {
    const tmpDir = makeEmptyRepo();
    try {
      const result = runCompanion(["review", "focus"], path.join(tmpDir, "repo"));
      assert.notEqual(result.status, 0, `expected failure, got: ${result.stdout}`);
      assert.match(result.stdout, /git diff failed/);
      assert.doesNotMatch(result.stdout, /forEach is not a function/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// chain — publish-demand warning at start (kusabi #153 #3)
// ---------------------------------------------------------------------------
// The chain prints the one-line orchestrator warning before any dispatch
// when the brief looks publish-demanding.  OPENCODE_BIN points at a
// nonexistent binary so the chain dies fast after printing the warning; the
// assertion is only on the warning line being the first thing in stdout.

describe("chain publish-demand warning", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");

  it("prints the orchestrator warning line for a publish-demanding brief", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-chain-warn-"));
    try {
      const env = { ...process.env };
      delete env.KUSABI_WORKER_CONTEXT;
      env.KUSABI_STATE_DIR = path.join(tmpDir, "state");
      env.OPENCODE_BIN = path.join(tmpDir, "no-such-opencode-bin");
      const result = spawnSync(
        process.execPath,
        [COMPANION_SCRIPT, "chain", "--container", "fake-cid", "## PUBLISH (mandatory)\n\nImplement it."],
        { encoding: "utf8", cwd: tmpDir, env, timeout: 20_000 },
      );
      assert.match(result.stdout, /brief が publish を要求しているが、ワーカーは publish できない/);
      assert.match(result.stdout, /オーケストレーター専権/);
      // The warning is the FIRST line of the chain output, before anything else.
      assert.ok(result.stdout.startsWith("brief が publish を要求している"), `warning not first: ${result.stdout.slice(0, 120)}`);
      assert.doesNotMatch(result.stdout, /worker context/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("prints no warning for a brief that does not demand publish", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-chain-warn2-"));
    try {
      const env = { ...process.env };
      delete env.KUSABI_WORKER_CONTEXT;
      env.KUSABI_STATE_DIR = path.join(tmpDir, "state");
      env.OPENCODE_BIN = path.join(tmpDir, "no-such-opencode-bin");
      const result = spawnSync(
        process.execPath,
        [COMPANION_SCRIPT, "chain", "--container", "fake-cid", "Implement it and verify."],
        { encoding: "utf8", cwd: tmpDir, env, timeout: 20_000 },
      );
      assert.doesNotMatch(result.stdout, /publish を要求/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// =========================================================================
// runChainDriver — resume paths (kusabi #153①)
// -------------------------------------------------------------------------
// Drives the shared chain loop with fake callTool / dispatch, exactly as
// cmdChainResume wires it: resolveChainResume → rearmChainControl →
// runChainDriver(resume: position).
// =========================================================================

describe("runChainDriver resume", () => {
  const BRIEF = "Implement X.\n\n## Deliverables\n- src/foo.js\n";

  function fakeResumeCallTool({ statusOutput = " M src/foo.js\n" } = {}) {
    return async (toolName, params) => {
      if (toolName === "verify_in_container") {
        return { gate_passed: true };
      }
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands[0];
      // captureWorktreeState: capture failure → baseline null (graceful)
      if (cmd.startsWith("cd /workspace &&") && cmd.includes("TMPIDX=")) {
        return { output: "ERROR_NO_INDEX\n" };
      }
      if (cmd === "git rev-parse HEAD") return { output: "abc123\n" };
      if (cmd === "git status --porcelain") return { output: statusOutput };
      if (cmd === "git log --oneline -5") return { output: "abc123 latest change\n" };
      if (cmd === "git diff") return { output: "diff --git a/src/foo.js b/src/foo.js\n" };
      if (cmd === "git ls-files --others --exclude-standard") return { output: "untracked.txt\n" };
      return { output: "" };
    };
  }

  function makeFakeDispatch({
    reviewResult = JSON.stringify({ verdict: "approve", findings: [], summary: "ok" }),
    implementStatus = "completed",
    implementFailure = null,
  } = {}) {
    const dispatch = async (opts) => {
      if (opts.kind === "review") {
        return {
          job: {
            id: "job-rev-1", status: "completed", modelEntry: "fake/review", modelVariant: null,
            fallbacks: null, sessionID: "sess-rev",
            usage: { available: true, input: 2, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            error: null,
          },
          resultText: reviewResult,
        };
      }
      if (opts.kind === "task") {
        return {
          job: {
            id: "job-imp-" + (opts.round ?? 1), status: implementStatus,
            modelEntry: "fake/model", modelVariant: null, fallbacks: null,
            sessionID: "sess-imp-" + (opts.round ?? 1),
            usage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            error: implementStatus === "provider-error"
              ? (implementFailure
                  // The classified error the claude dispatch actually writes
                  // (renderClaudeQuotaError); the chain surface must show it.
                  ? "claude dispatch failed: You've hit your session limit · resets 1:20am (Asia/Tokyo) — " +
                    "session limit exhausted (resets 1:20am (Asia/Tokyo)): the whole claude backend is " +
                    "blocked, including your own Claude Code session (same account window). Switch the " +
                    "phase to the opencode backend (--model <provider>/<model>); do not retry claude."
                  : "All routes exhausted: fake/model — retry at attempt 3")
              : null,
            failure: implementFailure,
          },
          resultText: "implemented",
        };
      }
      if (opts.kind === "strategist") {
        return {
          job: {
            id: "job-strat-1", status: "completed", modelEntry: "fake/strat", modelVariant: null,
            fallbacks: null, sessionID: "sess-strat",
            usage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            error: null,
          },
          resultText: "restructure the module",
        };
      }
      throw new Error("unexpected dispatch kind: " + opts.kind);
    };
    dispatch.calls = [];
    const wrapped = async (opts) => {
      dispatch.calls.push(opts);
      return dispatch(opts);
    };
    wrapped.calls = dispatch.calls;
    return wrapped;
  }

  function makeChainState({ records, controlOverrides = {}, chainId = "chain-test" } = {}) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-resume-"));
    const chainDir = path.join(tmp, "chains", chainId);
    fs.mkdirSync(chainDir, { recursive: true });
    writeJson(path.join(chainDir, "chain.json"), {
      chainId, container: "cid-1", model: "fake/model",
      modelChain: [["fake/model"], ["fake/pro"]], maxRounds: 4,
      brief: BRIEF, orchestrator: null, records,
      baseSha: "abc123",
      chainTotals: computeChainTotals(records),
      strategized: false, followupIssueDraft: null,
    });
    writeChainControl(chainDir, {
      chainId, container: "cid-1", pid: 0,
      status: "cancelled", round: 3,
      stopRequestedAt: "2026-08-01T00:00:00.000Z", stopRequestedBy: "cli",
      finishedAt: "2026-08-01T00:00:00.000Z",
      ...controlOverrides,
    });
    return { tmp, chainDir };
  }

  // Mirrors cmdChainResume: resolve the position, re-arm the control, run.
  async function resumeChain({ chainDir, dispatch, statusOutput, callTool }) {
    const resolution = resolveChainResume({
      control: readChainControl(chainDir),
      chainJson: readJson(path.join(chainDir, "chain.json")),
    });
    assert.equal(resolution.ok, true);
    rearmChainControl({
      chainDir,
      round: resolution.position.phase === "review" ? resolution.position.round : resolution.position.round - 1,
    });
    const tmp = path.dirname(path.dirname(chainDir));
    const chainJson = readJson(path.join(chainDir, "chain.json"));
    return runChainDriver({
      cwd: tmp, stateDir: path.dirname(path.dirname(chainDir)), chainDir,
      chainId: "chain-test", container: "cid-1",
      model: "fake/model", modelChain: [["fake/model"], ["fake/pro"]], maxRounds: 4,
      brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      // Mirror cmdChainResume: reuse the verify baseline recorded in
      // chain.json; never re-capture on the modified worktree (kusabi #173).
      verifyBaseline: chainJson.verifyBaseline ?? null,
      callTool: callTool ?? fakeResumeCallTool({ statusOutput }),
      dispatchWithFallback: dispatch,
      keepServe: true,
      signalReceived: () => false,
      resume: resolution.position,
    });
  }

  it("resumes an interrupted round at review and completes it (implement done, review not run)", async () => {
    const partial = {
      round: 3,
      resumeMethod: { type: "continue_session" },
      startedAt: "2026-08-01T00:00:00.000Z",
      verdict: null,
      probesGreen: true,
      modelEntry: "fake/model",
      modelVariant: null,
      fallbacks: null,
      implementJobId: "job-imp-3",
      sessionID: "sess-3",
      implementUsage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
      tierBefore: 0,
      reworkStrategyReason: null,
      reworkCount: 2,
      probeResults: [{ probe: "P1: HEAD clean", passed: true, detail: "ok" }],
      worktreeChanged: true,
      interrupted: true,
      interruptedAfter: "probes",
    };
    const { chainDir } = makeChainState({ records: [partial] });
    const dispatch = makeFakeDispatch(); // review approves

    const text = await resumeChain({ chainDir, dispatch });

    assert.match(text, /accepted at round 3/);
    // The resumed review actually dispatched (kind review, round 3)
    assert.ok(dispatch.calls.some((c) => c.kind === "review"), "review must be dispatched");

    // Terminal disposition => the postable review record exists and its path
    // is printed in the terminal output (kusabi #52).  The resumed path goes
    // through the same finalisation point as a fresh chain.
    const recordPath = path.join(chainDir, "review-record.md");
    assert.ok(fs.existsSync(recordPath), "review-record.md must exist after a terminal disposition");
    assert.match(text, /review record: .*review-record\.md/);
    const recordText = fs.readFileSync(recordPath, "utf8");
    assert.match(recordText, /# \[review-record\] .* chain-test — Implement X\./);
    assert.match(recordText, /Final disposition: accepted at round 3 of 4/);
    assert.match(recordText, /## Findings adjudication \(fill at inspection\)/);
    assert.match(recordText, /## 判例として \(fill at inspection\)/);

    const control = readChainControl(chainDir);
    assert.equal(control.status, "completed");
    assert.equal(control.round, 3);

    const round3 = readJson(path.join(chainDir, "round-3.json"));
    assert.equal(round3.reviewJobId, "job-rev-1");
    assert.equal(round3.verdict, "approve");
    assert.equal(round3.disposition.disposition, "accept");
    assert.equal(round3.resumed, true);
    // A completed round is no longer "interrupted" — that flag means "still
    // partial" (#153① review).  The history moves to wasInterrupted.
    assert.equal(round3.interrupted, undefined);
    assert.equal(round3.interruptedAfter, undefined);
    assert.equal(round3.wasInterrupted, true);

    const chainJson = readJson(path.join(chainDir, "chain.json"));
    assert.equal(chainJson.records.length, 1); // no duplicate push
  });

  it("carries tier/reworkCount into the next round after a resumed review that reworks", async () => {
    const partial = {
      round: 3,
      resumeMethod: { type: "continue_session" },
      startedAt: "2026-08-01T00:00:00.000Z",
      verdict: null,
      probesGreen: true,
      modelEntry: "fake/model",
      modelVariant: null,
      fallbacks: null,
      implementJobId: "job-imp-3",
      sessionID: "sess-3",
      implementUsage: null,
      tierBefore: 0,
      reworkStrategyReason: null,
      reworkCount: 1,
      probeResults: [],
      worktreeChanged: true,
      interrupted: true,
      interruptedAfter: "probes",
    };
    const { chainDir } = makeChainState({ records: [partial] });
    // Review finds problems → rework; the next round's implement hits provider
    // exhaustion so the test can observe the carried tier/reworkCount.
    const dispatch = makeFakeDispatch({
      reviewResult: JSON.stringify({ verdict: "needs-attention", findings: [] }),
      implementStatus: "provider-error",
    });

    const text = await resumeChain({ chainDir, dispatch });

    assert.match(text, /implement provider exhausted/);

    // Cross-round context derived at resume (position) — the ladder continues
    const round3 = readJson(path.join(chainDir, "round-3.json"));
    assert.equal(round3.disposition.disposition, "rework");
    assert.equal(round3.tierAfter, 1); // 0 + 1 (2nd rework escalates), 2-tier chain, not clamped

    const round4 = readJson(path.join(chainDir, "round-4.json"));
    assert.equal(round4.tierBefore, 1);   // carried currentTierIndex
    assert.equal(round4.reworkCount, 2);  // 1 + the consumed rework
    // round 4 is a NEW round after the resumed one — only the resumed round
    // itself carries the resumed trace
    assert.equal(round4.resumed, undefined);

    const control = readChainControl(chainDir);
    assert.equal(control.status, "failed");
    assert.equal(control.round, 4);
  });

  it("resumes a rework chain at the next round's implement, keeping prior-findings context", async () => {
    const complete = {
      round: 2,
      resumeMethod: { type: "fresh_session" },
      startedAt: "2026-08-01T00:00:00.000Z",
      verdict: "needs-attention",
      probesGreen: false,
      modelEntry: "fake/model",
      modelVariant: null,
      fallbacks: null,
      implementJobId: "job-imp-2",
      reviewJobId: "job-rev-2",
      sessionID: "sess-2",
      implementUsage: null,
      reviewUsage: null,
      tierBefore: 0,
      tierAfter: 1,
      reworkCount: 1,
      pendingReworkStrategy: { tierDelta: 1, newSession: true, reason: "2nd rework: escalate tier, new session, keep artifacts" },
      disposition: { disposition: "rework", reason: "needs-attention" },
      findingsText: "fix the parser",
    };
    const { chainDir } = makeChainState({ records: [complete], controlOverrides: { round: 2 } });
    const dispatch = makeFakeDispatch({ implementStatus: "provider-error" });

    const text = await resumeChain({ chainDir, dispatch });

    assert.match(text, /implement provider exhausted/);

    // The resumed round's implement ran with the previous round's findings
    const impCall = dispatch.calls.find((c) => c.kind === "task");
    assert.ok(impCall, "implement must be dispatched");
    assert.equal(impCall.round, 3);
    assert.match(impCall.promptText, /Prior findings/);
    assert.match(impCall.promptText, /fix the parser/);

    const round3 = readJson(path.join(chainDir, "round-3.json"));
    assert.equal(round3.tierBefore, 1);   // carried from round 2 tierAfter
    assert.equal(round3.reworkCount, 2);  // 1 + the consumed rework
    assert.equal(round3.resumed, true);

    const control = readChainControl(chainDir);
    assert.equal(control.status, "failed");
    assert.equal(control.round, 3);
  });

  it("dies a quota-classified implement failure with the classification, not the generic retry advice (kusabi #215)", async () => {
    // The implement dispatch returns the REAL 2026-08-11 session-limit
    // classification (status provider-error + structured `failure`), as the
    // claude backend now produces.  The failed-round surface — what the
    // operator sees when the round dies — must show the classification
    // instead of the generic error text, and must NOT contradict it with
    // "Retry when provider is available".
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-quota-chain-"));
    const chainDir = path.join(tmp, "chains", "chain-test");
    fs.mkdirSync(chainDir, { recursive: true });
    writeChainControl(chainDir, {
      chainId: "chain-test", container: "cid-1", pid: process.pid,
      status: "running", round: 0, startedAt: new Date().toISOString(),
    });

    const dispatch = makeFakeDispatch({
      implementStatus: "provider-error",
      implementFailure: {
        kind: "quota-exhaustion",
        quota: "session",
        backendBlocked: true,
        reset: "1:20am (Asia/Tokyo)",
      },
    });

    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
      model: "fake/model", modelChain: [["fake/model"], ["fake/pro"]], maxRounds: 4,
      brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      callTool: fakeResumeCallTool(),
      dispatchWithFallback: dispatch,
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });

    // The chain stops at implement provider exhaustion and the surface
    // carries the classified message.
    assert.match(text, /implement provider exhausted/);
    assert.match(text, /whole claude backend is blocked/);
    assert.match(text, /Switch the phase to the opencode backend/);
    assert.match(text, /do not retry claude/);
    assert.ok(!text.includes("Retry when provider is available"),
      "the generic capacity footer must not contradict a session-limit classification");

    const control = readChainControl(chainDir);
    assert.equal(control.status, "failed");

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("persists the interrupted round when stopped after probes (stop-accept path)", async () => {
    // Fresh chain (resume: null).  The implement dispatch writes a stop
    // request into control.json as a side effect; the driver's after-probes
    // stop check must persist the partial round and finalise round N.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-resume-stop-"));
    const chainDir = path.join(tmp, "chains", "chain-test");
    fs.mkdirSync(chainDir, { recursive: true });
    writeChainControl(chainDir, {
      chainId: "chain-test", container: "cid-1", pid: process.pid,
      status: "running", round: 0, startedAt: new Date().toISOString(),
    });

    const dispatch = makeFakeDispatch();
    const dispatchWithStop = async (opts) => {
      const result = await dispatch(opts);
      if (opts.kind === "task") {
        // The stop arrives while the round is in flight — exactly what
        // chain-cancel does via requestChainStop.
        writeChainControl(chainDir, {
          ...readChainControl(chainDir),
          stopRequestedAt: new Date().toISOString(),
          stopRequestedBy: "test",
        });
      }
      return result;
    };

    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
      model: "fake/model", modelChain: [["fake/model"], ["fake/pro"]], maxRounds: 4,
      brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      callTool: fakeResumeCallTool(),
      dispatchWithFallback: dispatchWithStop,
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });

    assert.match(text, /cancelled during round 1/);
    assert.match(text, /Progress preserved/);
    assert.match(text, /chain-resume chain-test/);

    const control = readChainControl(chainDir);
    assert.equal(control.status, "cancelled");
    assert.equal(control.round, 1); // control round matches actual progress

    const round1 = readJson(path.join(chainDir, "round-1.json"));
    assert.equal(round1.implementJobId, "job-imp-1");
    assert.equal(round1.interrupted, true);
    assert.equal(round1.interruptedAfter, "probes");
    assert.ok(round1.probeResults.length > 0);
    assert.equal(round1.reviewJobId, undefined); // no review was bought

    const chainJson = readJson(path.join(chainDir, "chain.json"));
    assert.equal(chainJson.records.length, 1);
    assert.equal(chainJson.records[0].interrupted, true);

    // A cancelled chain produces no review record (kusabi #52) — the record
    // exists only when a terminal disposition is reached.
    assert.equal(fs.existsSync(path.join(chainDir, "review-record.md")), false);
    assert.doesNotMatch(text, /review record:/);

    // The persisted partial record is resumable
    const resolution = resolveChainResume({
      control: readChainControl(chainDir),
      chainJson: readJson(path.join(chainDir, "chain.json")),
    });
    assert.equal(resolution.ok, true);
    assert.equal(resolution.position.phase, "review");
    assert.equal(resolution.position.round, 1);
  });

  it("reuses the chain-start verify baseline on resume and never re-captures on the modified worktree (kusabi #173)", async () => {
    // Round 1 reworked (probes red on a dirty base).  chain.json carries the
    // baseline recorded at chain start: lint 190, types 0.  The resumed round
    // 2 keeps the same 190 lint violations (worker added none) and green tests
    // after the tolerated re-run → P2 must PASS because the RESUME path reused
    // the recorded baseline.  If resume re-captured the baseline from the
    // modified worktree, captureVerifyBaseline would fire an extra
    // verify_in_container call before round 2's probes — the call log below
    // asserts that never happens.
    const complete = {
      round: 1,
      resumeMethod: { type: "fresh_session" },
      startedAt: "2026-08-01T00:00:00.000Z",
      verdict: "needs-attention",
      probesGreen: false,
      modelEntry: "fake/model",
      modelVariant: null,
      fallbacks: null,
      implementJobId: "job-imp-1",
      reviewJobId: "job-rev-1",
      sessionID: "sess-1",
      implementUsage: null,
      reviewUsage: null,
      tierBefore: 0,
      tierAfter: 1,
      reworkCount: 1,
      pendingReworkStrategy: { tierDelta: 1, newSession: true, reason: "2nd rework: escalate tier" },
      disposition: { disposition: "rework", reason: "needs-attention" },
      findingsText: "fix it",
    };
    const verifyBaseline = {
      captured: true,
      gate_passed: false,
      lint: 190,
      types: 0,
      raw: { gate_passed: false },
    };

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-resume-baseline-"));
    const chainDir = path.join(tmp, "chains", "chain-test");
    fs.mkdirSync(chainDir, { recursive: true });
    writeJson(path.join(chainDir, "chain.json"), {
      chainId: "chain-test", container: "cid-1", model: "fake/model",
      modelChain: [["fake/model"], ["fake/pro"]], maxRounds: 4,
      brief: BRIEF, orchestrator: null, records: [complete],
      baseSha: "abc123",
      chainTotals: computeChainTotals([complete]),
      strategized: false, followupIssueDraft: null,
      verifyBaseline,
    });
    writeChainControl(chainDir, {
      chainId: "chain-test", container: "cid-1", pid: 0,
      status: "cancelled", round: 1,
      stopRequestedAt: "2026-08-01T00:00:00.000Z", stopRequestedBy: "cli",
      finishedAt: "2026-08-01T00:00:00.000Z",
    });

    // Call log: verify_in_container calls plus the sandbox_exec commands.
    const verifyCalls = [];
    const lint190 = [];
    for (let i = 0; i < 190; i++) {
      lint190.push({ rule: "no-unused-vars", file: "/workspace/src/f" + i + ".py", line: 1, message: "x", severity: "error" });
    }
    const callTool = async (toolName, params) => {
      if (toolName === "verify_in_container") {
        verifyCalls.push(params);
        if (verifyCalls.length === 1) {
          // Round 2's P2: same 190 lint violations as the base, tests skipped.
          return {
            gate_passed: false,
            lint: lint190,
            types: [],
            tests: { status: "skipped", message: "precondition gate failed; tests not run" },
            gate_fail_reasons: ["lint (eslint): 190 violation(s)"],
          };
        }
        // Tolerated re-run (skip_lint_gate): tests green.
        return { gate_passed: true, lint: [], types: [], tests: { full: { status: "ok", passed: 1, total: 1 } } };
      }
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands[0];
      if (cmd.startsWith("cd /workspace &&") && cmd.includes("TMPIDX=")) {
        return { output: "ERROR_NO_INDEX\n" };
      }
      if (cmd === "git rev-parse HEAD") return { output: "abc123\n" };
      if (cmd === "git status --porcelain") return { output: " M src/foo.js\n" };
      if (cmd === "git log --oneline -5") return { output: "abc123 latest change\n" };
      if (cmd === "git diff") return { output: "diff --git a/src/foo.js b/src/foo.js\n" };
      if (cmd === "git ls-files --others --exclude-standard") return { output: "untracked.txt\n" };
      return { output: "" };
    };

    const dispatch = makeFakeDispatch(); // review approves
    const text = await resumeChain({ chainDir, dispatch, callTool });

    assert.match(text, /accepted at round 2/);
    // Exactly the round's P2 + tolerated re-run — NO extra baseline capture at
    // resume time.
    assert.equal(verifyCalls.length, 2, "resume must not re-capture the baseline");
    assert.equal(verifyCalls[1].skip_lint_gate, true);

    const round2 = readJson(path.join(chainDir, "round-2.json"));
    const p2 = round2.probeResults.find((p) => p.probe === "P2: verify gate");
    assert.equal(p2.passed, true);
    assert.match(p2.detail, /lint 190 \(baseline 190, tolerated\)/);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // The chain driver records the dispatch backend on the round record and
  // threads the backend-specific dispatch through every phase (kusabi #184).
  // A backend:"claude" chain must dispatch through the injected dispatch
  // (claudeDispatch in production) and persist backend on round-N.json and
  // chain.json records, with modelEntry/modelVariant taken from the job
  // result, not from flags.
  it("records backend claude on the round and persists it in chain state", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-chain-backend-"));
    const chainDir = path.join(tmp, "chains", "chain-test");
    fs.mkdirSync(chainDir, { recursive: true });
    writeChainControl(chainDir, {
      chainId: "chain-test", container: "cid-1", pid: process.pid,
      status: "running", round: 0, startedAt: new Date().toISOString(),
    });

    const dispatch = makeFakeDispatch();
    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
      model: "fake/model", modelChain: [["fake/model"]], maxRounds: 1,
      brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      callTool: fakeResumeCallTool(),
      dispatchWithFallback: dispatch,
      backend: "claude",
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });

    assert.match(text, /accepted at round 1/);
    // The chain actually dispatched through the injected (backend-specific)
    // dispatch — implement + review both fired.
    assert.equal(dispatch.calls.length, 2);
    assert.ok(dispatch.calls.every((c) => c.kind === "task" || c.kind === "review"));

    const round1 = readJson(path.join(chainDir, "round-1.json"));
    assert.equal(round1.backend, "claude");
    assert.equal(round1.modelEntry, "fake/model");
    assert.equal(round1.modelVariant, null);

    const chainJson = readJson(path.join(chainDir, "chain.json"));
    assert.equal(chainJson.records.length, 1);
    assert.equal(chainJson.records[0].backend, "claude");
    assert.equal(chainJson.records[0].modelEntry, "fake/model");

    const control = readChainControl(chainDir);
    assert.equal(control.status, "completed");
    assert.equal(control.round, 1);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// =========================================================================
// runChainDriver — per-phase backend mixing (kusabi #192)
// -------------------------------------------------------------------------
// The driver threads TWO backend-specific dispatches: one for the implement
// phase (and the strategist, which follows the implement resolution) and one
// for the review phase.  Round records carry `backend` (implement) and
// `reviewBackend` (review, always set).  Session lineage never crosses
// backends: a rework implement round only continues a session created by the
// implement backend.
// =========================================================================

describe("runChainDriver per-phase backends (kusabi #192)", () => {
  const BRIEF = "Implement X.\n\n## Deliverables\n- src/foo.js\n";
  const APPROVE = JSON.stringify({ verdict: "approve", findings: [], summary: "ok" });
  const REWORK = JSON.stringify({
    verdict: "needs-attention",
    findings: [{ severity: "high", file: "src/foo.js", description: "fix the parser" }],
  });

  function fakeCallTool({ statusOutput = " M src/foo.js\n" } = {}) {
    return async (toolName, params) => {
      if (toolName === "verify_in_container") {
        return { gate_passed: true };
      }
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands[0];
      if (cmd.startsWith("cd /workspace &&") && cmd.includes("TMPIDX=")) {
        return { output: "ERROR_NO_INDEX\n" };
      }
      if (cmd === "git rev-parse HEAD") return { output: "abc123\n" };
      if (cmd === "git status --porcelain") return { output: statusOutput };
      if (cmd === "git log --oneline -5") return { output: "abc123 latest change\n" };
      if (cmd === "git diff") return { output: "diff --git a/src/foo.js b/src/foo.js\n" };
      if (cmd === "git ls-files --others --exclude-standard") return { output: "untracked.txt\n" };
      return { output: "" };
    };
  }

  // The implement-side fake: claude-shaped (bare-alias modelEntry, UUID
  // session ids).  Records every dispatch options object.
  function makeImplementDispatch() {
    const calls = [];
    const dispatch = async (opts) => {
      calls.push(opts);
      if (opts.kind === "task") {
        return {
          job: {
            id: "job-imp-" + (opts.round ?? 1), status: "completed",
            modelEntry: "opus", modelVariant: null, fallbacks: null,
            sessionID: "claude-uuid-" + (opts.round ?? 1),
            usage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            error: null,
          },
          resultText: "implemented",
        };
      }
      if (opts.kind === "strategist") {
        return {
          job: {
            id: "job-strat-1", status: "completed",
            modelEntry: "opus", modelVariant: null, fallbacks: null,
            sessionID: "claude-uuid-strat",
            usage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            error: null,
          },
          resultText: "restructure the module",
        };
      }
      throw new Error("unexpected implement dispatch kind: " + opts.kind);
    };
    return { dispatch, calls };
  }

  // The review-side fake: opencode-shaped (provider/model modelEntry, ses_*
  // session ids).  Records every dispatch options object.  `reviewResult`
  // may be a value or a function (opts) => string, so tests can switch the
  // verdict between rounds.
  function makeReviewDispatch({ reviewResult = APPROVE } = {}) {
    const calls = [];
    const dispatch = async (opts) => {
      calls.push(opts);
      if (opts.kind === "review") {
        return {
          job: {
            id: "job-rev-" + (opts.round ?? 1), status: "completed",
            modelEntry: "opencode/deepseek-v4-flash-free", modelVariant: "max",
            fallbacks: null, sessionID: "ses_review_" + (opts.round ?? 1),
            usage: { available: true, input: 2, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            error: null,
          },
          resultText: typeof reviewResult === "function" ? reviewResult(opts) : reviewResult,
        };
      }
      throw new Error("unexpected review dispatch kind: " + opts.kind);
    };
    return { dispatch, calls };
  }

  function makeChainDir() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-phase-backend-"));
    const chainDir = path.join(tmp, "chains", "chain-test");
    fs.mkdirSync(chainDir, { recursive: true });
    writeChainControl(chainDir, {
      chainId: "chain-test", container: "cid-1", pid: process.pid,
      status: "running", round: 0, startedAt: new Date().toISOString(),
    });
    return { tmp, chainDir };
  }

  it("dispatches implement on claude and review on opencode, recording both backends and per-phase models/agents", async () => {
    const { tmp, chainDir } = makeChainDir();
    const implement = makeImplementDispatch();
    const review = makeReviewDispatch();

    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
      model: "opus", modelChain: [["opus"]],
      reviewModel: { providerID: "opencode", modelID: "deepseek-v4-flash-free", variant: "max" },
      reviewModelChain: [["opencode/deepseek-v4-flash-free:max"]],
      maxRounds: 1,
      brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      callTool: fakeCallTool(),
      backend: "claude", reviewBackend: "opencode",
      dispatchWithFallback: implement.dispatch,
      reviewDispatchWithFallback: review.dispatch,
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });

    assert.match(text, /accepted at round 1/);

    // The implement dispatch ran on the claude-shaped fake: one task call
    // with the claude model chain and the implement agent.
    assert.equal(implement.calls.length, 1);
    assert.equal(implement.calls[0].kind, "task");
    assert.equal(implement.calls[0].agent, "kusabi-implement");
    assert.deepEqual(implement.calls[0].tiers, [["opus"]]);

    // The review dispatch ran on the opencode-shaped fake: one review call
    // with the review route chain and the review agent.
    assert.equal(review.calls.length, 1);
    assert.equal(review.calls[0].kind, "review");
    assert.equal(review.calls[0].agent, "kusabi-review");
    assert.deepEqual(review.calls[0].tiers, [["opencode/deepseek-v4-flash-free:max"]]);

    // Round record: backend = implement backend, reviewBackend = review
    // backend (always set), reviewModelEntry from the review job.
    const round1 = readJson(path.join(chainDir, "round-1.json"));
    assert.equal(round1.backend, "claude");
    assert.equal(round1.reviewBackend, "opencode");
    assert.equal(round1.reviewModelEntry, "opencode/deepseek-v4-flash-free");

    const chainJson = readJson(path.join(chainDir, "chain.json"));
    assert.equal(chainJson.records[0].backend, "claude");
    assert.equal(chainJson.records[0].reviewBackend, "opencode");
    // The review-phase context is persisted for chain-resume.
    assert.deepEqual(chainJson.reviewModelChain, [["opencode/deepseek-v4-flash-free:max"]]);

    const control = readChainControl(chainDir);
    assert.equal(control.status, "completed");

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("session lineage stays within the implement backend across rework rounds (never the review backend's session)", async () => {
    const { tmp, chainDir } = makeChainDir();
    const implement = makeImplementDispatch();
    // Review finds problems in round 1 (rework); the review dispatch then
    // switches to approve so round 2 accepts.
    let reviewCount = 0;
    const reviewInner = makeReviewDispatch({
      reviewResult: () => (++reviewCount === 1 ? REWORK : APPROVE),
    });
    const review = reviewInner.dispatch;
    review.calls = reviewInner.calls;

    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
      model: "opus", modelChain: [["opus"]],
      reviewModelChain: [["opencode/deepseek-v4-flash-free:max"]],
      maxRounds: 2,
      brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      callTool: fakeCallTool(),
      backend: "claude", reviewBackend: "opencode",
      dispatchWithFallback: implement.dispatch,
      reviewDispatchWithFallback: review,
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });

    assert.match(text, /accepted at round 2/);

    // Two implement rounds: round 1 starts fresh, round 2 (rework) continues
    // round 1's implement session — never the review backend's ses_* id.
    const implementCalls = implement.calls.filter((c) => c.kind === "task");
    assert.equal(implementCalls.length, 2);
    assert.equal(implementCalls[0].session, undefined);
    assert.equal(implementCalls[1].session, "claude-uuid-1");
    for (const c of implementCalls) {
      assert.ok(c.session === undefined || c.session.startsWith("claude-uuid-"),
        "implement must never receive the review backend's session");
    }

    // The review backend's session ids never entered the record lineage.
    const round1 = readJson(path.join(chainDir, "round-1.json"));
    assert.equal(round1.sessionID, "claude-uuid-1");
    const round2 = readJson(path.join(chainDir, "round-2.json"));
    assert.equal(round2.sessionID, "claude-uuid-2");
    assert.equal(round2.backend, "claude");
    assert.equal(round2.reviewBackend, "opencode");

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("resume drops a session created by the other backend: the rework implement round starts fresh", async () => {
    // Adversarial seam test for invariant 5: the resume position carries a
    // session whose record ran on the OTHER backend (an opencode ses_* id
    // being resumed on a claude implement — and the reverse).  The driver
    // must drop it, and runImplementPhase's previousRecord fallback must
    // also refuse it, so the round starts fresh.
    const previousOpencode = {
      round: 1, resumeMethod: { type: "continue_session" },
      startedAt: "2026-08-01T00:00:00.000Z",
      verdict: "needs-attention", probesGreen: false,
      modelEntry: "fake/model", modelVariant: null, fallbacks: null,
      implementJobId: "job-imp-1", reviewJobId: "job-rev-1",
      sessionID: "ses_opencode_1", implementUsage: null, reviewUsage: null,
      tierBefore: 0, tierAfter: 1, reworkCount: 1,
      pendingReworkStrategy: { tierDelta: 1, newSession: false, reason: "rework" },
      disposition: { disposition: "rework", reason: "needs-attention" },
      findingsText: "fix the parser",
      backend: "opencode",
    };
    const previousClaude = {
      ...previousOpencode,
      sessionID: "claude-uuid-1",
      backend: "claude",
    };

    async function driveResume({ previous, driverBackend }) {
      const { tmp, chainDir } = makeChainDir();
      writeJson(path.join(chainDir, "chain.json"), {
        chainId: "chain-test", container: "cid-1", model: "opus",
        modelChain: [["opus"]], maxRounds: 4,
        brief: BRIEF, orchestrator: null, records: [previous],
        baseSha: "abc123", chainTotals: computeChainTotals([previous]),
        strategized: false, followupIssueDraft: null,
      });
      const implement = makeImplementDispatch();
      const review = makeReviewDispatch();
      const text = await runChainDriver({
        cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
        model: "opus", modelChain: [["opus"]], maxRounds: 4,
        brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
        callTool: fakeCallTool(),
        backend: driverBackend, reviewBackend: "opencode",
        dispatchWithFallback: implement.dispatch,
        reviewDispatchWithFallback: review.dispatch,
        keepServe: true,
        signalReceived: () => false,
        resume: {
          phase: "implement", round: 2, roundRecord: null, records: [previous],
          reworkCount: 1, currentTierIndex: 0, strategized: false,
          session: previous.sessionID, baseSha: "abc123",
        },
      });
      const impRound2 = implement.calls.find((c) => c.kind === "task" && c.round === 2);
      fs.rmSync(tmp, { recursive: true, force: true });
      return { text, impRound2 };
    }

    // claude implement must not continue an opencode session.
    const a = await driveResume({ previous: previousOpencode, driverBackend: "claude" });
    assert.ok(a.impRound2, "round-2 implement must be dispatched");
    assert.ok(a.impRound2.session == null, "foreign opencode session must be dropped (fresh start)");
    assert.match(a.text, /accepted at round 2/);

    // opencode implement must not continue a claude session (the direction
    // the existing ses_* guard in claudeDispatch does not cover).
    const b = await driveResume({ previous: previousClaude, driverBackend: "opencode" });
    assert.ok(b.impRound2, "round-2 implement must be dispatched");
    assert.ok(b.impRound2.session == null, "foreign claude session must be dropped (fresh start)");
    assert.match(b.text, /accepted at round 2/);
  });
});

// =========================================================================
// runChainDriver — per-round rework tiering (kusabi #192 axis 2)
// -------------------------------------------------------------------------
// models.phases.rework: implement rounds AFTER round 1 dispatch from the
// rework resolution — own chain, own backend, own dispatch — while the
// tier ladder climbs over the REWORK chain (first rework at its tier 0).
// Absent key → rework rounds keep the implement resolution byte-identically.
// Round records stamp the backend each round's implement job ACTUALLY used.
// =========================================================================

describe("runChainDriver per-round rework tiering (kusabi #192 axis 2)", () => {
  const BRIEF = "Implement X.\n\n## Deliverables\n- src/foo.js\n";
  const APPROVE = JSON.stringify({ verdict: "approve", findings: [], summary: "ok" });
  const REWORK = JSON.stringify({
    verdict: "needs-attention",
    findings: [{ severity: "high", file: "src/foo.js", description: "fix the parser" }],
  });

  function fakeCallTool({ statusOutput = " M src/foo.js\n" } = {}) {
    return async (toolName, params) => {
      if (toolName === "verify_in_container") {
        return { gate_passed: true };
      }
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands[0];
      if (cmd.startsWith("cd /workspace &&") && cmd.includes("TMPIDX=")) {
        return { output: "ERROR_NO_INDEX\n" };
      }
      if (cmd === "git rev-parse HEAD") return { output: "abc123\n" };
      if (cmd === "git status --porcelain") return { output: statusOutput };
      if (cmd === "git log --oneline -5") return { output: "abc123 latest change\n" };
      if (cmd === "git diff") return { output: "diff --git a/src/foo.js b/src/foo.js\n" };
      if (cmd === "git ls-files --others --exclude-standard") return { output: "untracked.txt\n" };
      return { output: "" };
    };
  }

  // One dispatch fake per phase seam.  `kind` gates the accepted phase
  // (task = implement, review = review); `sessionPrefix` gives ids of the
  // shape that phase's backend would produce (claude-uuid-* for the claude
  // fake, ses_* for the opencode fakes) so session lineage assertions can
  // tell the fakes apart.
  function makePhaseDispatch({ kind, modelEntry, sessionPrefix, resultText }) {
    const calls = [];
    const dispatch = async (opts) => {
      calls.push(opts);
      // The strategist runs on the IMPLEMENT seam (runStrategizePhase threads
      // the implement dispatch); a task fake must answer it so a strategize
      // disposition in a fixture does not crash the chain.
      if (opts.kind === "strategist" && kind === "task") {
        return {
          job: {
            id: "strategist-job-" + (opts.round ?? 1), status: "completed",
            modelEntry, modelVariant: null, fallbacks: null,
            sessionID: sessionPrefix + "-strat",
            usage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            error: null,
          },
          resultText: "restructure the module",
        };
      }
      if (opts.kind !== kind) {
        throw new Error("unexpected dispatch kind: " + opts.kind + " on the " + kind + " seam");
      }
      return {
        job: {
          id: kind + "-job-" + (opts.round ?? 1), status: "completed",
          modelEntry, modelVariant: null, fallbacks: null,
          sessionID: sessionPrefix + (opts.round ?? 1),
          usage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
          error: null,
        },
        resultText,
      };
    };
    return { dispatch, calls };
  }

  function makeReviewDispatch({ reviewResults }) {
    const calls = [];
    let idx = 0;
    const dispatch = async (opts) => {
      calls.push(opts);
      if (opts.kind !== "review") {
        throw new Error("unexpected dispatch kind on the review seam: " + opts.kind);
      }
      const resultText = reviewResults[Math.min(idx, reviewResults.length - 1)];
      idx += 1;
      return {
        job: {
          id: "review-job-" + (opts.round ?? 1), status: "completed",
          modelEntry: "opencode-go/deepseek-v4-flash", modelVariant: null, fallbacks: null,
          sessionID: "ses_review_" + (opts.round ?? 1),
          usage: { available: true, input: 2, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
          error: null,
        },
        resultText,
      };
    };
    return { dispatch, calls };
  }

  function makeChainDir() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-rework-tier-"));
    const chainDir = path.join(tmp, "chains", "chain-test");
    fs.mkdirSync(chainDir, { recursive: true });
    writeChainControl(chainDir, {
      chainId: "chain-test", container: "cid-1", pid: process.pid,
      status: "running", round: 0, startedAt: new Date().toISOString(),
    });
    return { tmp, chainDir };
  }

  it("mixed backends: round 1 dispatches claude/opus, a rework round dispatches the opencode flash route with a FRESH session, and records carry each round's true backend", async () => {
    const { tmp, chainDir } = makeChainDir();
    const implement = makePhaseDispatch({ kind: "task", modelEntry: "opus", sessionPrefix: "claude-uuid-", resultText: "implemented" });
    const rework = makePhaseDispatch({ kind: "task", modelEntry: "opencode-go/deepseek-v4-flash", sessionPrefix: "ses_rework_", resultText: "implemented" });
    const review = makeReviewDispatch({ reviewResults: [REWORK, APPROVE] });

    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
      model: "opus", modelChain: [["opus"]],
      reworkModel: "deepseek-v4-flash", reworkModelChain: [["opencode-go/deepseek-v4-flash"]],
      reworkBackend: "opencode",
      reviewModelChain: [["opencode-go/deepseek-v4-flash"]],
      maxRounds: 2,
      brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      callTool: fakeCallTool(),
      backend: "claude", reviewBackend: "opencode",
      dispatchWithFallback: implement.dispatch,
      reworkDispatchWithFallback: rework.dispatch,
      reviewDispatchWithFallback: review.dispatch,
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });

    assert.match(text, /accepted at round 2/);

    // Round 1 implement: the claude fake, implement chain, no session.
    assert.equal(implement.calls.length, 1);
    assert.equal(implement.calls[0].round, 1);
    assert.deepEqual(implement.calls[0].tiers, [["opus"]]);
    assert.ok(implement.calls[0].session == null);

    // Round 2 (rework): the opencode rework fake, REWORK chain, FRESH
    // session — the claude round's session id never crosses backends.
    assert.equal(rework.calls.length, 1);
    assert.equal(rework.calls[0].round, 2);
    assert.deepEqual(rework.calls[0].tiers, [["opencode-go/deepseek-v4-flash"]]);
    assert.ok(rework.calls[0].session == null, "rework round must start fresh across backends");

    // Round records: backend reflects the route each round ACTUALLY used.
    const round1 = readJson(path.join(chainDir, "round-1.json"));
    assert.equal(round1.backend, "claude");
    assert.equal(round1.modelEntry, "opus");
    assert.equal(round1.sessionID, "claude-uuid-1");
    const round2 = readJson(path.join(chainDir, "round-2.json"));
    assert.equal(round2.backend, "opencode");
    assert.equal(round2.modelEntry, "opencode-go/deepseek-v4-flash");
    assert.equal(round2.sessionID, "ses_rework_2");

    // chain.json persists the rework dispatch context for chain-resume.
    const chainJson = readJson(path.join(chainDir, "chain.json"));
    assert.deepEqual(chainJson.reworkModelChain, [["opencode-go/deepseek-v4-flash"]]);
    assert.equal(chainJson.reworkModel, "deepseek-v4-flash");
    assert.equal(chainJson.reworkBackend, "opencode");

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("same-backend tiering: a rework round continues the session and dispatches the rework chain's route", async () => {
    const { tmp, chainDir } = makeChainDir();
    const implement = makePhaseDispatch({ kind: "task", modelEntry: "opencode-go/deepseek-v4-pro", sessionPrefix: "ses_imp_", resultText: "implemented" });
    const rework = makePhaseDispatch({ kind: "task", modelEntry: "opencode-go/deepseek-v4-flash", sessionPrefix: "ses_rework_", resultText: "implemented" });
    const review = makeReviewDispatch({ reviewResults: [REWORK, APPROVE] });

    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
      model: { providerID: "opencode-go", modelID: "deepseek-v4-pro" },
      modelChain: [["opencode-go/deepseek-v4-pro"]],
      reworkModel: "deepseek-v4-flash", reworkModelChain: [["opencode-go/deepseek-v4-flash"]],
      reworkBackend: "opencode",
      reviewModelChain: [["opencode-go/deepseek-v4-flash"]],
      maxRounds: 2,
      brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      callTool: fakeCallTool(),
      backend: "opencode", reviewBackend: "opencode",
      dispatchWithFallback: implement.dispatch,
      reworkDispatchWithFallback: rework.dispatch,
      reviewDispatchWithFallback: review.dispatch,
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });

    assert.match(text, /accepted at round 2/);

    // Round 1 on the implement seam with the implement chain.
    assert.equal(implement.calls.length, 1);
    assert.deepEqual(implement.calls[0].tiers, [["opencode-go/deepseek-v4-pro"]]);
    // Round 2 (rework) on the rework seam with the flash route, session
    // CONTINUED — the lineage guard passes on a same-backend rework.
    assert.equal(rework.calls.length, 1);
    assert.deepEqual(rework.calls[0].tiers, [["opencode-go/deepseek-v4-flash"]]);
    assert.equal(rework.calls[0].session, "ses_imp_1", "same-backend rework continues the implement session");

    const round1 = readJson(path.join(chainDir, "round-1.json"));
    const round2 = readJson(path.join(chainDir, "round-2.json"));
    assert.equal(round1.backend, "opencode");
    assert.equal(round2.backend, "opencode");
    assert.equal(round2.sessionID, "ses_rework_2");

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("the tier ladder climbs over the REWORK chain: first rework at its tier 0, next rework at its tier 1", async () => {
    const { tmp, chainDir } = makeChainDir();
    const implement = makePhaseDispatch({ kind: "task", modelEntry: "opencode-go/deepseek-v4-pro", sessionPrefix: "ses_imp_", resultText: "implemented" });
    const rework = makePhaseDispatch({ kind: "task", modelEntry: "opencode-go/deepseek-v4-flash", sessionPrefix: "ses_rework_", resultText: "implemented" });
    // Distinct finding files per round: same-file repeats would trigger the
    // strategize lever instead of the plain rework this test exercises.
    const reworkA = JSON.stringify({
      verdict: "needs-attention",
      findings: [{ severity: "high", file: "src/a.js", description: "fix the parser" }],
    });
    const reworkB = JSON.stringify({
      verdict: "needs-attention",
      findings: [{ severity: "high", file: "src/b.js", description: "fix the parser" }],
    });
    const review = makeReviewDispatch({ reviewResults: [reworkA, reworkB, APPROVE] });

    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
      model: "deepseek-v4-pro", modelChain: [["opencode-go/deepseek-v4-pro"]],
      reworkModel: "deepseek-v4-flash",
      reworkModelChain: [["opencode-go/deepseek-v4-flash"], ["opencode-go/deepseek-v4-pro"]],
      reworkBackend: "opencode",
      reviewModelChain: [["opencode-go/deepseek-v4-flash"]],
      maxRounds: 3,
      brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      callTool: fakeCallTool(),
      backend: "opencode", reviewBackend: "opencode",
      dispatchWithFallback: implement.dispatch,
      reworkDispatchWithFallback: rework.dispatch,
      reviewDispatchWithFallback: review.dispatch,
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });

    assert.match(text, /accepted at round 3/);

    // Both rework rounds went to the rework seam with the REWORK chain; the
    // tier index climbed 0 → 1 within it.
    const reworkCalls = rework.calls.filter((c) => c.round >= 2);
    assert.equal(reworkCalls.length, 2);
    assert.equal(reworkCalls[0].round, 2);
    assert.equal(reworkCalls[0].tierIndex, 0, "first rework starts at the rework chain's tier 0");
    assert.equal(reworkCalls[1].round, 3);
    assert.equal(reworkCalls[1].tierIndex, 1, "second rework escalates within the rework chain");
    for (const c of reworkCalls) {
      assert.deepEqual(c.tiers, [["opencode-go/deepseek-v4-flash"], ["opencode-go/deepseek-v4-pro"]],
        "rework rounds address the rework chain");
    }

    const round2 = readJson(path.join(chainDir, "round-2.json"));
    assert.equal(round2.tierBefore, 0);
    const round3 = readJson(path.join(chainDir, "round-3.json"));
    assert.equal(round3.tierBefore, 1);
    assert.equal(round3.tierAfter, 1);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("a single-tier rework chain clamps the escalation exactly as today, over the rework chain", async () => {
    const { tmp, chainDir } = makeChainDir();
    const implement = makePhaseDispatch({ kind: "task", modelEntry: "opencode-go/deepseek-v4-pro", sessionPrefix: "ses_imp_", resultText: "implemented" });
    const rework = makePhaseDispatch({ kind: "task", modelEntry: "opencode-go/deepseek-v4-flash", sessionPrefix: "ses_rework_", resultText: "implemented" });
    const reworkA = JSON.stringify({
      verdict: "needs-attention",
      findings: [{ severity: "high", file: "src/a.js", description: "fix the parser" }],
    });
    const reworkB = JSON.stringify({
      verdict: "needs-attention",
      findings: [{ severity: "high", file: "src/b.js", description: "fix the parser" }],
    });
    const review = makeReviewDispatch({ reviewResults: [reworkA, reworkB, APPROVE] });

    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
      model: "deepseek-v4-pro", modelChain: [["opencode-go/deepseek-v4-pro"]],
      reworkModel: "deepseek-v4-flash", reworkModelChain: [["opencode-go/deepseek-v4-flash"]],
      reworkBackend: "opencode",
      reviewModelChain: [["opencode-go/deepseek-v4-flash"]],
      maxRounds: 3,
      brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      callTool: fakeCallTool(),
      backend: "opencode", reviewBackend: "opencode",
      dispatchWithFallback: implement.dispatch,
      reworkDispatchWithFallback: rework.dispatch,
      reviewDispatchWithFallback: review.dispatch,
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });

    assert.match(text, /accepted at round 3/);

    const reworkCalls = rework.calls.filter((c) => c.round >= 2);
    assert.equal(reworkCalls.length, 2);
    assert.equal(reworkCalls[1].tierIndex, 0, "escalation clamps at the single-tier rework chain's top");
    const round2 = readJson(path.join(chainDir, "round-2.json"));
    assert.equal(round2.tierClamped, true);
    assert.match(round2.tierClampReason, /single-tier chain/);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("chain-resume with the key re-dispatches the rework round on the rework backend/model; a legacy chain.json resumes on the implement resolution", async () => {
    function previousRecord({ backend, sessionID }) {
      return {
        round: 1, resumeMethod: { type: "continue_session" },
        startedAt: "2026-08-01T00:00:00.000Z",
        verdict: "needs-attention", probesGreen: true,
        modelEntry: backend === "claude" ? "opus" : "opencode-go/deepseek-v4-pro",
        modelVariant: null, fallbacks: null,
        implementJobId: "job-imp-1", reviewJobId: "job-rev-1",
        sessionID, implementUsage: null, reviewUsage: null,
        tierBefore: 0, tierAfter: 0, reworkCount: 0,
        pendingReworkStrategy: { tierDelta: 0, newSession: false, reason: "rework" },
        disposition: { disposition: "rework", reason: "needs-attention" },
        findingsText: "fix the parser",
        backend,
      };
    }

    async function driveResume({ previous, reworkCtx, reworkBackend }) {
      const { tmp, chainDir } = makeChainDir();
      writeJson(path.join(chainDir, "chain.json"), {
        chainId: "chain-test", container: "cid-1", model: "opus",
        modelChain: [["opus"]], maxRounds: 2,
        brief: BRIEF, orchestrator: null, records: [previous],
        baseSha: "abc123", chainTotals: computeChainTotals([previous]),
        strategized: false, followupIssueDraft: null,
        ...reworkCtx,
      });
      const implement = makePhaseDispatch({ kind: "task", modelEntry: "opencode-go/deepseek-v4-pro", sessionPrefix: "ses_imp_", resultText: "implemented" });
      const rework = makePhaseDispatch({ kind: "task", modelEntry: "opencode-go/deepseek-v4-flash", sessionPrefix: "ses_rework_", resultText: "implemented" });
      const review = makeReviewDispatch({ reviewResults: [APPROVE] });
      const text = await runChainDriver({
        cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
        model: "opus", modelChain: [["opus"]],
        reworkModel: reworkCtx.reworkModel ?? null,
        reworkModelChain: reworkCtx.reworkModelChain ?? null,
        reworkBackend,
        maxRounds: 2,
        brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
        callTool: fakeCallTool(),
        backend: "opencode", reviewBackend: "opencode",
        dispatchWithFallback: implement.dispatch,
        // A rework seam only exists when the chain.json carried rework keys
        // (legacy: null → the driver falls back to the implement dispatch).
        reworkDispatchWithFallback: reworkCtx.reworkModelChain ? rework.dispatch : null,
        reviewDispatchWithFallback: review.dispatch,
        keepServe: true,
        signalReceived: () => false,
        resume: {
          phase: "implement", round: 2, roundRecord: null, records: [previous],
          reworkCount: 1, currentTierIndex: 0, strategized: false,
          session: previous.sessionID, baseSha: "abc123",
        },
      });
      const round2 = readJson(path.join(chainDir, "round-2.json"));
      fs.rmSync(tmp, { recursive: true, force: true });
      return { text, round2, implementCalls: implement.calls, reworkCalls: rework.calls };
    }

    // Axis-2 chain.json (rework key present): the rework round re-dispatches
    // on the rework seam with the rework chain; same-backend session lineage
    // continues the implement session.
    const axis2 = await driveResume({
      previous: previousRecord({ backend: "opencode", sessionID: "ses_imp_1" }),
      reworkCtx: {
        reworkModel: "deepseek-v4-flash",
        reworkModelChain: [["opencode-go/deepseek-v4-flash"]],
        reworkBackend: "opencode",
      },
      reworkBackend: "opencode",
    });
    assert.match(axis2.text, /accepted at round 2/);
    assert.equal(axis2.implementCalls.length, 0, "round 2 must NOT dispatch on the implement seam");
    assert.equal(axis2.reworkCalls.length, 1);
    assert.deepEqual(axis2.reworkCalls[0].tiers, [["opencode-go/deepseek-v4-flash"]]);
    assert.equal(axis2.reworkCalls[0].session, "ses_imp_1", "same-backend rework continues the session");
    assert.equal(axis2.round2.backend, "opencode");

    // Axis-2 chain.json, cross-backend: the claude round's session must not
    // reach the opencode rework dispatch (fresh start), and the rework round
    // still uses the rework chain.
    const cross = await driveResume({
      previous: previousRecord({ backend: "claude", sessionID: "claude-uuid-1" }),
      reworkCtx: {
        reworkModel: "deepseek-v4-flash",
        reworkModelChain: [["opencode-go/deepseek-v4-flash"]],
        reworkBackend: "opencode",
      },
      reworkBackend: "opencode",
    });
    assert.match(cross.text, /accepted at round 2/);
    assert.equal(cross.reworkCalls.length, 1);
    assert.ok(cross.reworkCalls[0].session == null, "foreign claude session dropped on the opencode rework round");
    assert.equal(cross.round2.backend, "opencode");

    // Legacy chain.json (NO rework keys): rework rounds keep the implement
    // resolution — the implement seam dispatches round 2 with the
    // implement chain, byte-identical to today.
    const legacy = await driveResume({
      previous: previousRecord({ backend: "opencode", sessionID: "ses_imp_1" }),
      reworkCtx: {},
      reworkBackend: null,
    });
    assert.match(legacy.text, /accepted at round 2/);
    assert.equal(legacy.reworkCalls.length, 0, "no rework seam on a legacy chain.json");
    assert.equal(legacy.implementCalls.length, 1);
    assert.equal(legacy.implementCalls[0].round, 2);
    assert.deepEqual(legacy.implementCalls[0].tiers, [["opus"]], "legacy rework round uses the implement chain");
    assert.equal(legacy.implementCalls[0].session, "ses_imp_1", "legacy rework round continues the session");
    assert.equal(legacy.round2.backend, "opencode");
  });

  it("a multi-entry claude REWORK ladder never records tierAfter > 0 (backend-aware clamp, kusabi #192 follow-up)", async () => {
    const { tmp, chainDir } = makeChainDir();
    const implement = makePhaseDispatch({ kind: "task", modelEntry: "opus", sessionPrefix: "claude-uuid-", resultText: "implemented" });
    const rework = makePhaseDispatch({ kind: "task", modelEntry: "sonnet", sessionPrefix: "claude-uuid-rw-", resultText: "implemented" });
    const reworkA = JSON.stringify({
      verdict: "needs-attention",
      findings: [{ severity: "high", file: "src/a.js", description: "fix the parser" }],
    });
    const reworkB = JSON.stringify({
      verdict: "needs-attention",
      findings: [{ severity: "high", file: "src/b.js", description: "fix the parser" }],
    });
    const review = makeReviewDispatch({ reviewResults: [reworkA, reworkB, APPROVE] });

    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
      model: "opus", modelChain: [["opus"]],
      reworkModel: "sonnet",
      // Multi-entry claude chain — legal config (kusabi #184), but the
      // claude backend never walks its tiers: the model is pinned to the
      // rework command-start model on every rework round.
      reworkModelChain: [["opus"], ["sonnet"]],
      reworkBackend: "claude",
      reviewModelChain: [["opencode-go/deepseek-v4-flash"]],
      maxRounds: 3,
      brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      callTool: fakeCallTool(),
      backend: "claude", reviewBackend: "opencode",
      dispatchWithFallback: implement.dispatch,
      reworkDispatchWithFallback: rework.dispatch,
      reviewDispatchWithFallback: review.dispatch,
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });

    assert.match(text, /accepted at round 3/);

    // Both rework rounds dispatch at tier 0 — the clamp pins the tier index
    // to the claude ladder's single effective tier.
    const reworkCalls = rework.calls.filter((c) => c.round >= 2);
    assert.equal(reworkCalls.length, 2);
    assert.equal(reworkCalls[0].tierIndex, 0, "first rework at the claude ladder's only tier");
    assert.equal(reworkCalls[1].tierIndex, 0, "second rework stays clamped at tier 0");

    // Records: tierAfter never exceeds 0 on a claude ladder — kusabi #153's
    // recorded-tier-vs-actual-model contradiction must not return through
    // the claude rework surface (the modelEntry never changes: "sonnet" on
    // every rework round while the raw chain length would claim 0 → 1).
    const round2 = readJson(path.join(chainDir, "round-2.json"));
    assert.equal(round2.tierBefore, 0);
    assert.equal(round2.tierAfter, 0, "claude ladder: tierAfter must never exceed 0");
    assert.equal(round2.tierClamped, true);
    assert.match(round2.tierClampReason, /single-tier chain/);
    assert.equal(round2.modelEntry, "sonnet");
    const round3 = readJson(path.join(chainDir, "round-3.json"));
    assert.equal(round3.tierBefore, 0);
    assert.equal(round3.tierAfter, 0, "claude ladder: tierAfter must never exceed 0");

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("a multi-entry claude IMPLEMENT ladder (no rework key) also clamps: tierAfter stays 0 (pre-existing base surface, kusabi #192 follow-up)", async () => {
    const { tmp, chainDir } = makeChainDir();
    const implement = makePhaseDispatch({ kind: "task", modelEntry: "opus", sessionPrefix: "claude-uuid-", resultText: "implemented" });
    const reworkA = JSON.stringify({
      verdict: "needs-attention",
      findings: [{ severity: "high", file: "src/a.js", description: "fix the parser" }],
    });
    const reworkB = JSON.stringify({
      verdict: "needs-attention",
      findings: [{ severity: "high", file: "src/b.js", description: "fix the parser" }],
    });
    const review = makeReviewDispatch({ reviewResults: [reworkA, reworkB, APPROVE] });

    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
      model: "opus",
      // Multi-entry claude IMPLEMENT chain, no models.phases.rework key:
      // rework rounds keep the implement resolution (effectiveReworkChain is
      // the implement chain) — the base surface the follow-up also fixes.
      modelChain: [["opus"], ["sonnet"]],
      reviewModelChain: [["opencode-go/deepseek-v4-flash"]],
      maxRounds: 3,
      brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      callTool: fakeCallTool(),
      backend: "claude", reviewBackend: "opencode",
      dispatchWithFallback: implement.dispatch,
      reworkDispatchWithFallback: null,
      reviewDispatchWithFallback: review.dispatch,
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });

    assert.match(text, /accepted at round 3/);

    // Rework rounds run on the implement seam (no rework key) at tier 0.
    const implementCalls = implement.calls.filter((c) => c.round >= 2);
    assert.equal(implementCalls.length, 2);
    assert.equal(implementCalls[0].tierIndex, 0);
    assert.equal(implementCalls[1].tierIndex, 0, "claude implement ladder never escalates");

    const round2 = readJson(path.join(chainDir, "round-2.json"));
    assert.equal(round2.tierBefore, 0);
    assert.equal(round2.tierAfter, 0, "claude implement ladder: tierAfter must never exceed 0");
    assert.equal(round2.tierClamped, true);
    assert.match(round2.tierClampReason, /single-tier chain/);
    const round3 = readJson(path.join(chainDir, "round-3.json"));
    assert.equal(round3.tierAfter, 0);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// =========================================================================
// chain-start banner (kusabi #192 follow-up) — backend-aware tier counts
// -------------------------------------------------------------------------
// The banner line (B7) had zero coverage before this block.  A claude-native
// chain has an effective tier count of min(1, length): claudeDispatch pins
// every phase to the command-start model, so its ladder never climbs and the
// banner must not claim tiers it cannot walk (reworkTiers=2 on a claude
// rework chain of 2 was a false "can reach top tier" claim at maxRounds >= 3).
// =========================================================================

describe("chain-start banner (kusabi #192 follow-up)", () => {
  const OPENCODE_IMPLEMENT_1 = [["opencode-go/deepseek-v4-pro"]];
  const OPENCODE_REWORK_2 = [["opencode-go/deepseek-v4-flash"], ["opencode-go/deepseek-v4-pro"]];
  const CLAUDE_IMPLEMENT_1 = [["claude/opus"]];
  const CLAUDE_REWORK_2 = [["claude/opus"], ["claude/sonnet-4-5"]];

  it("opencode rework chain of 2: unchanged semantics — can reach top with maxRounds >= 3", () => {
    const tierCount = effectiveTierCount(OPENCODE_IMPLEMENT_1, "opencode");
    const reworkTierCount = effectiveTierCount(OPENCODE_REWORK_2, "opencode");
    assert.equal(tierCount, 1);
    assert.equal(reworkTierCount, 2, "opencode chains keep their full length");
    // roundsToTopTier = 1 + 2 = 3: the top tier needs three rounds.
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount, reworkKeyConfigured: true, maxRounds: 3 }),
      "Chain c1: tiers=1, reworkTiers=2, maxRounds=3 (can reach top tier)\n");
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount, reworkKeyConfigured: true, maxRounds: 2 }),
      "Chain c1: tiers=1, reworkTiers=2, maxRounds=2 (maxRounds insufficient to reach top tier)\n");
  });

  it("claude-native rework chain of 2: effective tier count is 1 — the claim never exceeds ladderTierCount 1", () => {
    const tierCount = effectiveTierCount(CLAUDE_IMPLEMENT_1, "claude");
    const reworkTierCount = effectiveTierCount(CLAUDE_REWORK_2, "claude");
    assert.equal(tierCount, 1);
    assert.equal(reworkTierCount, 1, "a claude chain counts as one tier");
    // roundsToTopTier = 1 + 1 = 2: maxRounds 2 already reaches the (only)
    // top tier.  The pre-fix code computed roundsToTopTier = 3 from the raw
    // length 2 and falsely claimed the top was unreachable at maxRounds 2.
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount, reworkKeyConfigured: true, maxRounds: 2 }),
      "Chain c1: tiers=1, reworkTiers=1, maxRounds=2 (can reach top tier)\n");
    // At maxRounds 3 the pre-fix banner printed reworkTiers=2 and claimed
    // can-reach-top from a 2-tier ladder the claude backend never walks.
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount, reworkKeyConfigured: true, maxRounds: 3 }),
      "Chain c1: tiers=1, reworkTiers=1, maxRounds=3 (can reach top tier)\n");
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount, reworkKeyConfigured: true, maxRounds: 1 }),
      "Chain c1: tiers=1, reworkTiers=1, maxRounds=1 (maxRounds insufficient to reach top tier)\n");
  });

  it("no rework key: today's banner byte-identical (opencode implement chain of 2)", () => {
    const tierCount = effectiveTierCount(OPENCODE_REWORK_2, "opencode");
    assert.equal(tierCount, 2);
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount: 0, reworkKeyConfigured: false, maxRounds: 3 }),
      "Chain c1: tiers=2, maxRounds=3 (can reach top tier)\n");
  });

  it("no rework key, claude implement chain of 2: the implement surface clamps to one tier too", () => {
    const tierCount = effectiveTierCount(CLAUDE_REWORK_2, "claude");
    assert.equal(tierCount, 1);
    // Pre-fix: tiers=2 with roundsToTopTier=3 — a false claim at maxRounds 2.
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount: 0, reworkKeyConfigured: false, maxRounds: 2 }),
      "Chain c1: tiers=1, maxRounds=2 (can reach top tier)\n");
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount: 0, reworkKeyConfigured: false, maxRounds: 3 }),
      "Chain c1: tiers=1, maxRounds=3 (can reach top tier)\n");
  });

  it("no implement chain: no banner line (the caller skips the write)", () => {
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount: 0, reworkTierCount: 0, reworkKeyConfigured: false, maxRounds: 4 }),
      null);
  });
});

// =========================================================================
// per-phase backend config validation at command start (kusabi #192)
// -------------------------------------------------------------------------
// A phase array mixing claude/ and opencode entries, and a claude/<model>
// :variant entry, each fail at command start (before createChainDir, before
// any dispatch) with a clear message and a nonzero exit — the same fail-loud
// principle as kusabi #184 finding 1.
// =========================================================================

describe("chain per-phase config validation (kusabi #192)", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");

  function runCompanion(args, cwd, stateDir) {
    const env = { ...process.env, KUSABI_STATE_DIR: stateDir };
    delete env.KUSABI_WORKER_CONTEXT;
    return spawnSync(process.execPath, [COMPANION_SCRIPT, ...args], {
      encoding: "utf8",
      cwd,
      env,
      timeout: 15_000,
    });
  }

  function makeState(config) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-phase-config-"));
    const stateDir = path.join(tmp, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "config.json"), JSON.stringify(config));
    return { tmp, stateDir };
  }

  it("a phase array mixing backends fails before chain-dir creation with a nonzero exit", () => {
    const { tmp, stateDir } = makeState({
      models: { phases: { implement: ["claude/opus", "opencode/x:max"] } },
    });
    try {
      const result = runCompanion(["chain", "--container", "abc123", "brief text"], tmp, stateDir);
      assert.notEqual(result.status, 0, `expected failure, got: ${result.stdout}`);
      assert.match(result.stdout, /mixes backends/);
      assert.match(result.stdout, /single-backend/);
      // Failed at command start: no chain directory was created.
      const hash = crypto.createHash("sha256").update(tmp).digest("hex").slice(0, 12);
      assert.equal(fs.existsSync(path.join(stateDir, hash, "chains")), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a mixed models.chain fails task --phase review at command start too", () => {
    const { tmp, stateDir } = makeState({
      models: { chain: ["claude/opus", "opencode/x:max"] },
    });
    try {
      const result = runCompanion(["task", "--phase", "review", "do the review"], tmp, stateDir);
      assert.notEqual(result.status, 0, `expected failure, got: ${result.stdout}`);
      assert.match(result.stdout, /mixes backends/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a claude/<model>:variant entry fails at command start with a nonzero exit", () => {
    const { tmp, stateDir } = makeState({
      models: { phases: { implement: ["claude/opus:max"] } },
    });
    try {
      const result = runCompanion(["chain", "--container", "abc123", "brief text"], tmp, stateDir);
      assert.notEqual(result.status, 0, `expected failure, got: ${result.stdout}`);
      assert.match(result.stdout, /:variant suffix in model "opus:max"/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("explicit --backend opencode with a claude-native phase chain fails at command start naming the flag, the phase and the config key", () => {
    const { tmp, stateDir } = makeState({
      models: { phases: { implement: ["claude/opus"] } },
    });
    try {
      const result = runCompanion(["chain", "--backend", "opencode", "--container", "abc123", "brief text"], tmp, stateDir);
      assert.notEqual(result.status, 0, `expected failure, got: ${result.stdout}`);
      assert.match(result.stdout, /--backend opencode/);
      assert.match(result.stdout, /implement/);
      assert.match(result.stdout, /models\.phases\.implement/);
      // Failed at command start: no chain directory was created.
      const hash = crypto.createHash("sha256").update(tmp).digest("hex").slice(0, 12);
      assert.equal(fs.existsSync(path.join(stateDir, hash, "chains")), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("explicit --backend opencode with a claude-native models.chain fails task --phase review too, naming models.chain", () => {
    const { tmp, stateDir } = makeState({
      models: { chain: ["claude/opus"] },
    });
    try {
      const result = runCompanion(["task", "--phase", "review", "--backend", "opencode", "do the review"], tmp, stateDir);
      assert.notEqual(result.status, 0, `expected failure, got: ${result.stdout}`);
      assert.match(result.stdout, /--backend opencode/);
      assert.match(result.stdout, /models\.chain/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("no --backend flag: a claude-native phase chain still auto-selects claude (entries decide, unchanged)", () => {
    const { tmp, stateDir } = makeState({
      models: { phases: { implement: ["claude/opus"] } },
    });
    try {
      // chain without --backend and without --container: resolution passes
      // (both phases resolve at command start), so the failure is the
      // container requirement — NOT a backend conflict.
      const result = runCompanion(["chain", "brief text"], tmp, stateDir);
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stdout, /--backend opencode/);
      assert.doesNotMatch(result.stdout, /conflicts with the claude-native chain/);
      assert.match(result.stdout, /chain requires --container/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("backward compat: an opencode-only config passes command-start resolution", () => {
    const { tmp, stateDir } = makeState({
      models: { phases: { implement: ["opencode/deepseek-v4-flash-free:max"] } },
    });
    try {
      // chain with no container fails on the container requirement — NOT on
      // the config: proves the config was accepted at command start.
      const result = runCompanion(["chain", "brief text"], tmp, stateDir);
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stdout, /mixes backends/);
      assert.match(result.stdout, /chain requires --container/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---- models.phases.rework (kusabi #192 axis 2) — same fail-loud rules ----

  it("a mixed-backend rework array fails before chain-dir creation naming models.phases.rework", () => {
    const { tmp, stateDir } = makeState({
      models: {
        phases: {
          implement: ["claude/opus"],
          rework: ["claude/opus", "opencode/x:max"],
        },
      },
    });
    try {
      const result = runCompanion(["chain", "--container", "abc123", "brief text"], tmp, stateDir);
      assert.notEqual(result.status, 0, `expected failure, got: ${result.stdout}`);
      assert.match(result.stdout, /mixes backends/);
      assert.match(result.stdout, /single-backend/);
      assert.match(result.stdout, /models\.phases\.rework/, "the error must name the offending config key");
      // Failed at command start: no chain directory was created.
      const hash = crypto.createHash("sha256").update(tmp).digest("hex").slice(0, 12);
      assert.equal(fs.existsSync(path.join(stateDir, hash, "chains")), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a claude/<model>:variant entry in the rework chain fails at command start naming models.phases.rework", () => {
    const { tmp, stateDir } = makeState({
      models: { phases: { rework: ["claude/opus:max"] } },
    });
    try {
      const result = runCompanion(["chain", "--container", "abc123", "brief text"], tmp, stateDir);
      assert.notEqual(result.status, 0, `expected failure, got: ${result.stdout}`);
      assert.match(result.stdout, /:variant suffix in model "opus:max"/);
      assert.match(result.stdout, /models\.phases\.rework/, "the error must name the offending config key");
      const hash = crypto.createHash("sha256").update(tmp).digest("hex").slice(0, 12);
      assert.equal(fs.existsSync(path.join(stateDir, hash, "chains")), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("explicit --backend opencode with a claude-native rework chain fails at command start naming the flag and models.phases.rework", () => {
    const { tmp, stateDir } = makeState({
      models: { phases: { rework: ["claude/opus"] } },
    });
    try {
      const result = runCompanion(["chain", "--backend", "opencode", "--container", "abc123", "brief text"], tmp, stateDir);
      assert.notEqual(result.status, 0, `expected failure, got: ${result.stdout}`);
      assert.match(result.stdout, /--backend opencode/);
      assert.match(result.stdout, /models\.phases\.rework/);
      // Failed at command start: no chain directory was created.
      const hash = crypto.createHash("sha256").update(tmp).digest("hex").slice(0, 12);
      assert.equal(fs.existsSync(path.join(stateDir, hash, "chains")), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a valid three-phase config (implement claude / rework opencode / review opencode) passes command-start resolution", () => {
    const { tmp, stateDir } = makeState({
      models: {
        phases: {
          implement: ["claude/opus"],
          rework: ["opencode-go/deepseek-v4-flash"],
          review: ["opencode-go/deepseek-v4-flash"],
        },
      },
    });
    try {
      // chain with no container fails on the container requirement — NOT on
      // the config: proves implement + rework + review all resolved.
      const result = runCompanion(["chain", "brief text"], tmp, stateDir);
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stdout, /mixes backends/);
      assert.doesNotMatch(result.stdout, /--backend opencode/);
      assert.doesNotMatch(result.stdout, /models\.phases\.rework/);
      assert.match(result.stdout, /chain requires --container/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("task --phase rework stays invalid even with a models.phases.rework key (no rework agent exists)", () => {
    const { tmp, stateDir } = makeState({
      models: { phases: { rework: ["opencode-go/deepseek-v4-flash"] } },
    });
    try {
      const result = runCompanion(["task", "--phase", "rework", "do it"], tmp, stateDir);
      assert.notEqual(result.status, 0, `expected failure, got: ${result.stdout}`);
      assert.match(result.stdout, /unknown phase: rework/);
      assert.doesNotMatch(result.stdout, /mixes backends/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---- --model carries its backend (kusabi #210) ----

  it("a backend-naming --model resolves a claude-pinned phase onto ITS backend at command start, with no config edit", () => {
    const { tmp, stateDir } = makeState({
      models: { phases: { implement: ["claude/opus"] } },
    });
    try {
      // The incident: the operator hands over an identifier the config
      // format itself defines, naming a reachable opencode model, for a
      // phase pinned to claude/opus.  chain with no container must now fail
      // on the container requirement — NOT on the :variant rejection and NOT
      // on the --backend conflict: resolution accepted the identifier.
      const result = runCompanion(
        ["chain", "--model", "opencode-go/deepseek-v4-pro:max", "brief text"],
        tmp, stateDir,
      );
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stdout, /:variant/);
      assert.doesNotMatch(result.stdout, /conflicts with the claude-native chain/);
      assert.match(result.stdout, /chain requires --container/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--backend disagreeing with a backend-naming --model fails at command start, naming both", () => {
    const { tmp, stateDir } = makeState({
      models: { phases: { implement: ["claude/opus"] } },
    });
    try {
      const result = runCompanion(
        ["chain", "--backend", "opencode", "--model", "claude/opus", "--container", "abc123", "brief text"],
        tmp, stateDir,
      );
      assert.notEqual(result.status, 0, `expected failure, got: ${result.stdout}`);
      assert.match(result.stdout, /--backend opencode/);
      assert.match(result.stdout, /--model claude\/opus/);
      // Failed at command start: no chain directory was created.
      const hash = crypto.createHash("sha256").update(tmp).digest("hex").slice(0, 12);
      assert.equal(fs.existsSync(path.join(stateDir, hash, "chains")), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// =========================================================================
// chain-resume review dispatch fallback (kusabi #192 finding)
// -------------------------------------------------------------------------
// cmdChainResume used to pass an UNDEFINED review seam for an opencode
// review on a mixed chain (implement claude / review opencode).  runChainDriver
// then fell back to the implement dispatch — the CLAUDE dispatch — so the
// review job silently ran on the claude CLI with the implement's model while
// the round record claimed reviewBackend=opencode.  The driver fallback is
// now backend-aware (resolveReviewDispatch) and the resume wiring always
// passes an explicit review seam (resolveResumeDispatches).
// =========================================================================

describe("chain-resume review dispatch fallback (kusabi #192 finding)", () => {
  const BRIEF = "Implement X.\n\n## Deliverables\n- src/foo.js\n";

  function fakeCallTool() {
    return async (toolName, params) => {
      if (toolName === "verify_in_container") {
        return { gate_passed: true };
      }
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands[0];
      if (cmd.startsWith("cd /workspace &&") && cmd.includes("TMPIDX=")) {
        return { output: "ERROR_NO_INDEX\n" };
      }
      if (cmd === "git rev-parse HEAD") return { output: "abc123\n" };
      if (cmd === "git status --porcelain") return { output: " M src/foo.js\n" };
      if (cmd === "git log --oneline -5") return { output: "abc123 latest change\n" };
      if (cmd === "git diff") return { output: "diff --git a/src/foo.js b/src/foo.js\n" };
      if (cmd === "git ls-files --others --exclude-standard") return { output: "untracked.txt\n" };
      return { output: "" };
    };
  }

  it("resolveReviewDispatch: an undefined review seam on a mixed chain never yields the claude implement dispatch", () => {
    const claudeFake = async () => { throw new Error("review must not reach the claude dispatch"); };
    // The prescribed scenario: undefined review seam + claude implement
    // dispatch + reviewBackend opencode.
    const r = resolveReviewDispatch({
      injectedReviewDispatch: null,
      injectedDispatch: claudeFake,
      backend: "claude",
      reviewBackend: "opencode",
    });
    assert.equal(r, dispatchWithFallback);
    assert.notEqual(r, claudeFake);
  });

  it("resolveReviewDispatch: same-backend chains keep the single dispatch (pre-#192 contract)", () => {
    const fake = async () => {};
    assert.equal(
      resolveReviewDispatch({ injectedReviewDispatch: null, injectedDispatch: fake, backend: "claude", reviewBackend: "claude" }),
      fake,
    );
    assert.equal(
      resolveReviewDispatch({ injectedReviewDispatch: null, injectedDispatch: fake, backend: "opencode", reviewBackend: "opencode" }),
      fake,
    );
  });

  it("resolveReviewDispatch: an explicit review seam wins; reverse mixing falls back to claudeDispatch", () => {
    const fake = async () => {};
    const seam = async () => {};
    assert.equal(
      resolveReviewDispatch({ injectedReviewDispatch: seam, injectedDispatch: fake, backend: "claude", reviewBackend: "opencode" }),
      seam,
    );
    assert.equal(
      resolveReviewDispatch({ injectedReviewDispatch: null, injectedDispatch: fake, backend: "opencode", reviewBackend: "claude" }),
      claudeDispatch,
    );
  });

  it("resolveResumeDispatches: a mixed chain resumes review on the opencode dispatch, never undefined", () => {
    const d = resolveResumeDispatches({
      resumeBackend: "claude",
      resumeReviewBackend: "opencode",
      model: "opus",
      reviewModel: null,
    });
    assert.equal(d.reviewDispatchWithFallback, dispatchWithFallback);
    // The implement seam stays the clamped claude dispatch.
    assert.equal(typeof d.dispatchWithFallback, "function");
    assert.notEqual(d.dispatchWithFallback, dispatchWithFallback);
    assert.notEqual(d.dispatchWithFallback, claudeDispatch);
  });

  it("resolveResumeDispatches: a claude review resumes on the clamped claude dispatch; legacy opencode chains keep today's seams", () => {
    const claude = resolveResumeDispatches({
      resumeBackend: "claude",
      resumeReviewBackend: "claude",
      model: "opus",
      reviewModel: "sonnet",
    });
    assert.equal(typeof claude.reviewDispatchWithFallback, "function");
    assert.notEqual(claude.reviewDispatchWithFallback, dispatchWithFallback);
    assert.notEqual(claude.reviewDispatchWithFallback, claudeDispatch);
    // clampModelDispatch pins the recorded review model (semantics covered by
    // the clampModelDispatch tests; here the wrapper shape is asserted).
    assert.equal(typeof claude.dispatchWithFallback, "function");

    // Pre-#192 chains (no reviewBackend recorded -> falls back to backend):
    // opencode resume keeps the pre-#192 seams — implement seam undefined
    // (driver default dispatchWithFallback), review seam now explicit but
    // identical in effect.
    const legacy = resolveResumeDispatches({
      resumeBackend: "opencode",
      resumeReviewBackend: "opencode",
      model: null,
      reviewModel: null,
    });
    assert.equal(legacy.dispatchWithFallback, undefined);
    assert.equal(legacy.reviewDispatchWithFallback, dispatchWithFallback);
  });

  it("runChainDriver with the buggy seam values (undefined review seam, claude implement, reviewBackend opencode) never sends the review job to the claude dispatch", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-fallback-fix-"));
    const chainDir = path.join(tmp, "chains", "chain-test");
    fs.mkdirSync(chainDir, { recursive: true });
    writeChainControl(chainDir, {
      chainId: "chain-test", container: "cid-1", pid: process.pid,
      status: "running", round: 0, startedAt: new Date().toISOString(),
    });

    let claudeCalls = 0;
    const claudeImplement = async (opts) => {
      claudeCalls += 1;
      if (opts.kind === "task") {
        return {
          job: {
            id: "job-imp-1", status: "completed", modelEntry: "opus",
            modelVariant: null, fallbacks: null, sessionID: "claude-uuid-1",
            usage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            error: null,
          },
          resultText: "implemented",
        };
      }
      throw new Error("review must not reach the claude dispatch");
    };

    const text = await runChainDriver({
      cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
      model: "opus", modelChain: [["opus"]],
      // Empty review chain: the REAL opencode dispatch (dispatchWithFallback)
      // fails fast with a "No available routes" provider-error job — no
      // serve spawn, no hang — while still proving WHICH dispatch the review
      // phase used: the opencode one, never the claude fake.
      reviewModelChain: [],
      maxRounds: 1,
      brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      callTool: fakeCallTool(),
      backend: "claude", reviewBackend: "opencode",
      dispatchWithFallback: claudeImplement,
      reviewDispatchWithFallback: undefined, // the buggy cmdChainResume seam value
      keepServe: true,
      signalReceived: () => false,
      resume: null,
    });

    // The chain stops at review provider exhaustion (the opencode dispatch's
    // empty-chain job), and the claude dispatch was called exactly once: the
    // implement round.  The review job never reached it.
    assert.match(text, /review provider exhausted/);
    assert.match(text, /No available routes/);
    assert.equal(claudeCalls, 1, "the claude dispatch must serve implement only");

    // Records stay truthful: implement claude, review opencode — and the
    // review job id is the opencode dispatch's provider-error job.
    const round1 = readJson(path.join(chainDir, "round-1.json"));
    assert.equal(round1.backend, "claude");
    assert.equal(round1.reviewBackend, "opencode");
    assert.match(round1.reviewJobId, /^no-route-/);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// =========================================================================
// resolveResumeReviewContext — legacy chain.json review-model fallback
// -------------------------------------------------------------------------
// cmdChainResume feeds chain.json's review dispatch context into
// resolveResumeDispatches.  A pre-#192 chain.json has NO reviewModel /
// reviewModelChain keys: key absence is the legacy marker, and the review
// clamp must fall back to the implement model/chain (pre-#192 clamped the
// whole chain to chainJson.model).  A #192-era chain.json may persist null
// on a mixed chain (opencode review) — that null must stay null and never
// silently borrow the implement values.
// =========================================================================
describe("resolveResumeReviewContext (kusabi #192 legacy fallback)", () => {
  it("legacy chain.json (no reviewModel key): the review clamp receives the implement model", () => {
    const legacy = {
      model: "sonnet",
      modelChain: [["opus"]],
    };
    const ctx = resolveResumeReviewContext(legacy);
    assert.equal(ctx.reviewModel, "sonnet", "key absence falls back to the implement model");
    assert.deepEqual(ctx.reviewModelChain, [["opus"]], "key absence falls back to the implement chain");
  });

  it("legacy chain.json with a missing model too: falls back to null, never undefined", () => {
    const ctx = resolveResumeReviewContext({ modelChain: [["opus"]] });
    assert.equal(ctx.reviewModel, null);
    assert.deepEqual(ctx.reviewModelChain, [["opus"]]);
  });

  it("a NEW chain.json persisting reviewModel: null / reviewModelChain: null keeps null (no borrowing from the implement chain)", () => {
    const mixed = {
      model: "opus",
      modelChain: [["opus"]],
      reviewModel: null,
      reviewModelChain: null,
    };
    const ctx = resolveResumeReviewContext(mixed);
    assert.equal(ctx.reviewModel, null, "persisted null must stay null");
    assert.equal(ctx.reviewModelChain, null, "persisted null must stay null");
  });

  it("a NEW chain.json with recorded review values returns them verbatim", () => {
    const mixed = {
      model: "opus",
      modelChain: [["opus"]],
      reviewModel: "deepseek/x",
      reviewModelChain: [["deepseek/x"]],
    };
    const ctx = resolveResumeReviewContext(mixed);
    assert.equal(ctx.reviewModel, "deepseek/x");
    assert.deepEqual(ctx.reviewModelChain, [["deepseek/x"]]);
  });

  it("composition: the legacy fallback feeds resolveResumeDispatches, so a claude review resumes clamped to the implement model", () => {
    const legacy = { model: "sonnet", modelChain: [["opus"]] };
    const ctx = resolveResumeReviewContext(legacy);
    const d = resolveResumeDispatches({
      resumeBackend: "claude",
      resumeReviewBackend: "claude",
      model: legacy.model ?? null,
      reviewModel: ctx.reviewModel,
    });
    // Clamped claude wrapper: neither the raw claude dispatch nor the
    // opencode dispatch — the review pins the recorded (implement) model.
    assert.equal(typeof d.reviewDispatchWithFallback, "function");
    assert.notEqual(d.reviewDispatchWithFallback, claudeDispatch);
    assert.notEqual(d.reviewDispatchWithFallback, dispatchWithFallback);
  });
});

// =========================================================================
// resolveResumeReworkContext — legacy chain.json rework-model fallback
// -------------------------------------------------------------------------
// The rework mirror of resolveResumeReviewContext (kusabi #192 axis 2): a
// pre-axis-2 chain.json has NO reworkModel / reworkModelChain /
// reworkBackend keys — key absence is the legacy marker, and the rework
// rounds continue on the implement model/chain.  A NEW chain.json persists
// the keys (null when no models.phases.rework key was configured), and a
// persisted null must stay null — never silently borrow the implement
// chain.
// =========================================================================

describe("resolveResumeReworkContext (kusabi #192 axis 2 legacy fallback)", () => {
  it("a legacy chain.json (no rework keys) falls back to the implement model and chain", () => {
    const legacy = { model: "sonnet", modelChain: [["opus"], ["claude-sonnet-4-5"]] };
    const ctx = resolveResumeReworkContext(legacy);
    assert.equal(ctx.reworkModel, "sonnet", "key absence falls back to the implement model");
    assert.deepEqual(ctx.reworkModelChain, [["opus"], ["claude-sonnet-4-5"]],
      "key absence falls back to the implement chain");
    assert.equal(ctx.reworkBackend, null, "no implement-side backend to fall back to; caller resolves null → implement backend");
  });

  it("a legacy chain.json without even a model still yields nulls, not undefined", () => {
    const ctx = resolveResumeReworkContext({ modelChain: [["opus"]] });
    assert.equal(ctx.reworkModel, null);
    assert.deepEqual(ctx.reworkModelChain, [["opus"]]);
  });

  it("a NEW chain.json persisting nulls keeps them (no borrowing from the implement chain)", () => {
    const mixed = {
      model: "opus",
      modelChain: [["opus"]],
      reworkModel: null,
      reworkModelChain: null,
      reworkBackend: null,
    };
    const ctx = resolveResumeReworkContext(mixed);
    assert.equal(ctx.reworkModel, null, "persisted null must stay null");
    assert.equal(ctx.reworkModelChain, null, "persisted null must stay null");
    assert.equal(ctx.reworkBackend, null, "persisted null must stay null");
  });

  it("an axis-2 chain.json carries the rework context verbatim", () => {
    const mixed = {
      model: "opus",
      modelChain: [["opus"]],
      reworkModel: "deepseek-v4-flash",
      reworkModelChain: [["opencode-go/deepseek-v4-flash"]],
      reworkBackend: "opencode",
    };
    const ctx = resolveResumeReworkContext(mixed);
    assert.equal(ctx.reworkModel, "deepseek-v4-flash");
    assert.deepEqual(ctx.reworkModelChain, [["opencode-go/deepseek-v4-flash"]]);
    assert.equal(ctx.reworkBackend, "opencode");
  });
});

// =========================================================================
// runChainDriver — rework scheduling by finding kind (kusabi #60 step 2)
// -------------------------------------------------------------------------
// maxRounds buys design/full rounds only; mechanical rounds are free.  The
// round loop derives the budget from the records alone (never persisted),
// stops at the 2 × maxRounds hard cap, and hands deriveDisposition the
// budget-adjusted round ordinal so its max-rounds terminal fires on budget.
// =========================================================================

describe("runChainDriver rework scheduling", () => {
  const BRIEF = "Implement X.\n\n## Deliverables\n- src/foo.js\n";
  const MECH_SENTENCE = "This round resolves ONLY the following mechanical checklist; other known findings are deliberately out of scope this round.";
  const DESIGN_SENTENCE = "This round resolves ONLY the following design finding; other known findings are deliberately out of scope this round.";

  function designFinding(n, file) {
    return { severity: "high", title: "Design decision " + n, file, line_start: 1, kind: "design", body: "b", recommendation: "r" };
  }
  function mechFinding(n, file) {
    return { severity: "medium", title: "Mechanical fix " + n, file, line_start: 10, kind: "mechanical", body: "b", recommendation: "r" };
  }
  function reviewResult(verdict, findings) {
    return JSON.stringify({ verdict, findings, summary: "s" });
  }

  function makeCallTool() {
    return async (toolName, params) => {
      if (toolName === "verify_in_container") return { gate_passed: true };
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands[0];
      if (cmd.startsWith("cd /workspace &&") && cmd.includes("TMPIDX=")) return { output: "ERROR_NO_INDEX\n" };
      if (cmd === "git rev-parse HEAD") return { output: "abc123\n" };
      if (cmd === "git status --porcelain") return { output: " M src/foo.js\n" };
      if (cmd === "git log --oneline -5") return { output: "abc123 latest change\n" };
      if (cmd === "git diff") return { output: "diff --git a/src/foo.js b/src/foo.js\n" };
      if (cmd === "git ls-files --others --exclude-standard") return { output: "untracked.txt\n" };
      return { output: "" };
    };
  }

  // Review results are consumed per review dispatch, in order; implement
  // dispatches always complete.  `calls` records every dispatch option so
  // tests can inspect the implement prompts.
  function makeQueueDispatch(reviewResults) {
    const calls = [];
    let reviewIdx = 0;
    const dispatch = async (opts) => {
      calls.push(opts);
      if (opts.kind === "review") {
        const resultText = reviewResults[Math.min(reviewIdx, reviewResults.length - 1)];
        reviewIdx += 1;
        return {
          job: {
            id: "job-rev-" + reviewIdx, status: "completed", modelEntry: "fake/review",
            modelVariant: null, fallbacks: null, sessionID: "sess-rev-" + reviewIdx,
            usage: { available: true, input: 2, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            error: null,
          },
          resultText,
        };
      }
      if (opts.kind === "task") {
        return {
          job: {
            id: "job-imp-" + (opts.round ?? 1), status: "completed", modelEntry: "fake/model",
            modelVariant: null, fallbacks: null, sessionID: "sess-imp-" + (opts.round ?? 1),
            usage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            error: null,
          },
          resultText: "implemented",
        };
      }
      throw new Error("unexpected dispatch kind: " + opts.kind);
    };
    return { dispatch, calls };
  }

  function runFresh({ maxRounds, reviewResults }) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-sched-"));
    const chainDir = path.join(tmp, "chains", "chain-test");
    fs.mkdirSync(chainDir, { recursive: true });
    writeChainControl(chainDir, {
      chainId: "chain-test", container: "cid-1", pid: process.pid,
      status: "running", round: 0, startedAt: new Date().toISOString(),
    });
    const { dispatch, calls } = makeQueueDispatch(reviewResults);
    return {
      tmp, chainDir, calls,
      run() {
        return runChainDriver({
          cwd: tmp, stateDir: tmp, chainDir, chainId: "chain-test", container: "cid-1",
          model: "fake/model", modelChain: [["fake/model"]], maxRounds,
          brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
          callTool: makeCallTool(), dispatchWithFallback: dispatch,
          keepServe: true, signalReceived: () => false, resume: null,
        });
      },
    };
  }

  function makeChainState({ records, maxRounds }) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-sched-resume-"));
    const chainDir = path.join(tmp, "chains", "chain-test");
    fs.mkdirSync(chainDir, { recursive: true });
    writeJson(path.join(chainDir, "chain.json"), {
      chainId: "chain-test", container: "cid-1", model: "fake/model",
      modelChain: [["fake/model"]], maxRounds,
      brief: BRIEF, orchestrator: null, records,
      baseSha: "abc123",
      chainTotals: computeChainTotals(records),
      strategized: false, followupIssueDraft: null,
    });
    writeChainControl(chainDir, {
      chainId: "chain-test", container: "cid-1", pid: 0,
      status: "cancelled", round: records.length,
      stopRequestedAt: "2026-08-01T00:00:00.000Z", stopRequestedBy: "cli",
      finishedAt: "2026-08-01T00:00:00.000Z",
    });
    return { tmp, chainDir };
  }

  async function runResume({ chainDir, maxRounds, reviewResults }) {
    const resolution = resolveChainResume({
      control: readChainControl(chainDir),
      chainJson: readJson(path.join(chainDir, "chain.json")),
    });
    assert.equal(resolution.ok, true);
    rearmChainControl({
      chainDir,
      round: resolution.position.phase === "review" ? resolution.position.round : resolution.position.round - 1,
    });
    const { dispatch, calls } = makeQueueDispatch(reviewResults);
    const stateDir = path.dirname(path.dirname(chainDir));
    const text = await runChainDriver({
      cwd: stateDir, stateDir, chainDir,
      chainId: "chain-test", container: "cid-1",
      model: "fake/model", modelChain: [["fake/model"]], maxRounds,
      brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
      callTool: makeCallTool(), dispatchWithFallback: dispatch,
      keepServe: true, signalReceived: () => false,
      resume: resolution.position,
    });
    return { text, calls };
  }

  it("runs a mechanical scope round after mixed findings without consuming the design budget", async () => {
    const fx = runFresh({
      maxRounds: 2,
      reviewResults: [
        reviewResult("needs-attention", [designFinding(1, "src/a.js"), mechFinding(1, "src/b.js")]),
        reviewResult("needs-attention", [{ ...mechFinding(2, "src/c.js"), severity: "high" }]),
        reviewResult("approve", []),
      ],
    });
    try {
      const text = await fx.run();
      assert.match(text, /accepted at round 3/);

      const round1 = readJson(path.join(fx.chainDir, "round-1.json"));
      assert.equal(round1.reworkScope, "full");
      const round2 = readJson(path.join(fx.chainDir, "round-2.json"));
      assert.equal(round2.reworkScope, "mechanical");
      // Round 2 is a free round: it sits at budget position 1 (not 2), so
      // needs-attention reworks instead of hitting the max-rounds terminal.
      assert.equal(round2.disposition.disposition, "rework");
      const round3 = readJson(path.join(fx.chainDir, "round-3.json"));
      assert.equal(round3.reworkScope, "mechanical");
      assert.equal(round3.disposition.disposition, "accept");

      // Round 2's implement brief is the scoped mechanical checklist: the
      // design finding is deliberately held back.
      const imp2 = fx.calls.find((c) => c.kind === "task" && c.round === 2);
      assert.ok(imp2, "round 2 implement must be dispatched");
      assert.ok(imp2.promptText.includes(MECH_SENTENCE));
      assert.ok(imp2.promptText.includes("Mechanical fix 1"));
      assert.ok(!imp2.promptText.includes("Design decision 1"));

      const control = readChainControl(fx.chainDir);
      assert.equal(control.status, "completed");
      assert.equal(control.round, 3);
    } finally {
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("repeated mixed reviews alternate mechanical/design (never two mechanical in a row) and the design round consumes budget", async () => {
    // Followup: after a mechanical round, a mixed set schedules the design
    // finding instead of a second mechanical batch.  With maxRounds=2 the
    // chain must run full -> mechanical -> design and then escalate when the
    // design round exhausts the budget at round 3 — never a 4-round
    // mechanical tail ending on the 2 x maxRounds hard cap.
    const fx = runFresh({
      maxRounds: 2,
      reviewResults: [
        reviewResult("needs-attention", [designFinding(1, "src/a.js"), mechFinding(1, "src/b.js")]),
        reviewResult("needs-attention", [designFinding(2, "src/c.js"), mechFinding(2, "src/d.js")]),
        reviewResult("needs-attention", [designFinding(3, "src/e.js"), mechFinding(3, "src/f.js")]),
        reviewResult("needs-attention", [designFinding(4, "src/g.js"), mechFinding(4, "src/h.js")]),
      ],
    });
    try {
      const text = await fx.run();
      // Round 3 is the design round at budget position 2 of 2, so the
      // max-rounds terminal fires there.
      assert.match(text, /escalated at round 3: max rounds \(2\) reached without acceptance/);

      const round1 = readJson(path.join(fx.chainDir, "round-1.json"));
      assert.equal(round1.reworkScope, "full");
      assert.equal(round1.disposition.disposition, "rework");
      const round2 = readJson(path.join(fx.chainDir, "round-2.json"));
      assert.equal(round2.reworkScope, "mechanical");
      assert.equal(round2.disposition.disposition, "rework");
      const round3 = readJson(path.join(fx.chainDir, "round-3.json"));
      assert.equal(round3.reworkScope, "design");
      // The design round consumed the last budget slot: escalate, not rework.
      assert.equal(round3.disposition.disposition, "escalate");
      // No second mechanical round after round 2, no round 4 at all.
      assert.equal(fs.existsSync(path.join(fx.chainDir, "round-4.json")), false);
      assert.equal(fx.calls.filter((c) => c.kind === "task").length, 3);

      // Round 3's brief is the design scope over round 2's findings (the
      // previous record) with the FULL per-finding rendering (followup):
      // heading with severity/location, not the one-line
      // "[high] Design decision 2 (src/c.js:1)" row.
      const imp3 = fx.calls.find((c) => c.kind === "task" && c.round === 3);
      assert.ok(imp3, "round 3 implement must be dispatched");
      assert.ok(imp3.promptText.includes(DESIGN_SENTENCE));
      assert.ok(imp3.promptText.includes("### [high] Design decision 2 (src/c.js:1)"));
      assert.ok(imp3.promptText.includes("Design decision 2"));
      assert.ok(!imp3.promptText.includes("Mechanical fix 2"));

      const control = readChainControl(fx.chainDir);
      assert.equal(control.status, "completed");
      assert.equal(control.round, 3);
    } finally {
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("repeated mixed reviews keep alternating across several rounds and stop inside the 2 x maxRounds hard cap", async () => {
    // maxRounds=3: the chain must alternate full, mechanical, design,
    // mechanical, design and escalate at round 5 when the second design
    // round exhausts the budget (position 3 of 3) — inside the hard cap of
    // 6, with round 6 never started.
    const fx = runFresh({
      maxRounds: 3,
      reviewResults: [
        reviewResult("needs-attention", [designFinding(1, "src/a.js"), mechFinding(1, "src/b.js")]),
        reviewResult("needs-attention", [designFinding(2, "src/c.js"), mechFinding(2, "src/d.js")]),
        reviewResult("needs-attention", [designFinding(3, "src/e.js"), mechFinding(3, "src/f.js")]),
        reviewResult("needs-attention", [designFinding(4, "src/g.js"), mechFinding(4, "src/h.js")]),
        reviewResult("needs-attention", [designFinding(5, "src/i.js"), mechFinding(5, "src/j.js")]),
        reviewResult("approve", []),
      ],
    });
    try {
      const text = await fx.run();
      assert.match(text, /escalated at round 5: max rounds \(3\) reached without acceptance/);

      const scopes = [];
      for (let r = 1; r <= 5; r++) {
        const rec = readJson(path.join(fx.chainDir, "round-" + r + ".json"));
        scopes.push(rec.reworkScope);
      }
      // full, mechanical, design, mechanical, design — never two mechanical
      // in a row across five rounds of mixed reviews.
      assert.deepEqual(scopes, ["full", "mechanical", "design", "mechanical", "design"]);
      // Hard cap (2 x maxRounds = 6) respected: the budget exhausted first.
      assert.equal(fs.existsSync(path.join(fx.chainDir, "round-6.json")), false);
      assert.equal(fx.calls.filter((c) => c.kind === "task").length, 5);

      const control = readChainControl(fx.chainDir);
      assert.equal(control.status, "completed");
      assert.equal(control.round, 5);
    } finally {
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("a chain of only full rounds behaves exactly as today (same rounds, same disposition)", async () => {
    const fx = runFresh({
      maxRounds: 4,
      reviewResults: [
        reviewResult("needs-attention", []),
        reviewResult("needs-attention", []),
        reviewResult("needs-attention", []),
        reviewResult("needs-attention", []),
      ],
    });
    try {
      const text = await fx.run();
      // Round 4 hits the max-rounds terminal inside deriveDisposition and
      // escalates — the same terminal and wording as the pre-scheduling loop.
      assert.match(text, /escalated at round 4: max rounds \(4\) reached without acceptance/);

      for (let r = 1; r <= 4; r++) {
        const rec = readJson(path.join(fx.chainDir, "round-" + r + ".json"));
        assert.equal(rec.reworkScope, "full");
        if (r < 4) {
          assert.equal(rec.disposition.disposition, "rework");
        } else {
          // The max-rounds terminal fires on BUDGET at the final full round,
          // exactly as the pre-scheduling loop did on the raw round number.
          assert.equal(rec.disposition.disposition, "escalate");
          assert.match(rec.disposition.reason, /max rounds \(4\) reached without acceptance/);
        }
      }
      // No extra mechanical rounds: every round consumed budget, so the loop
      // stopped after maxRounds rounds exactly like today.
      assert.equal(fx.calls.filter((c) => c.kind === "task").length, 4);
      assert.equal(fs.existsSync(path.join(fx.chainDir, "round-5.json")), false);

      const control = readChainControl(fx.chainDir);
      assert.equal(control.status, "completed");
      assert.equal(control.round, 4);
    } finally {
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("the 2 × maxRounds hard cap terminates a mechanical-only tail via the max-rounds path", async () => {
    const fx = runFresh({
      maxRounds: 2,
      reviewResults: [
        reviewResult("needs-attention", [designFinding(1, "src/a.js"), mechFinding(1, "src/b.js")]),
        reviewResult("needs-attention", [{ ...mechFinding(2, "src/c.js"), severity: "high" }]),
        reviewResult("needs-attention", [{ ...mechFinding(3, "src/d.js"), severity: "high" }]),
        reviewResult("needs-attention", [{ ...mechFinding(4, "src/e.js"), severity: "high" }]),
      ],
    });
    try {
      const text = await fx.run();
      assert.match(text, /reached max rounds \(2\) without acceptance/);

      // Four rounds ran with maxRounds=2 (1 full + 3 free mechanical rounds);
      // the 2 × maxRounds hard cap stopped the loop, not the budget.
      assert.equal(fx.calls.filter((c) => c.kind === "task").length, 4);
      assert.equal(fs.existsSync(path.join(fx.chainDir, "round-5.json")), false);

      const round1 = readJson(path.join(fx.chainDir, "round-1.json"));
      assert.equal(round1.reworkScope, "full");
      assert.equal(round1.disposition.disposition, "rework");
      for (let r = 2; r <= 4; r++) {
        const rec = readJson(path.join(fx.chainDir, "round-" + r + ".json"));
        assert.equal(rec.reworkScope, "mechanical");
        // Still at budget position 1 — never escalates on budget.
        assert.equal(rec.disposition.disposition, "rework");
      }

      const control = readChainControl(fx.chainDir);
      assert.equal(control.status, "completed");
      // The max-rounds terminal records the ACTUAL last round (4), never the
      // nominal maxRounds (2) — control.round and the review record must
      // agree with the persisted round-N.json files (kusabi #60 step 2 review).
      assert.equal(control.round, 4);
      const recordText = fs.readFileSync(path.join(fx.chainDir, "review-record.md"), "utf8");
      assert.match(recordText, /Final disposition: max-rounds at round 4 of 2/);
    } finally {
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("a resumed chain recomputes the budget from records alone (no new persisted state)", async () => {
    const r1 = {
      round: 1, reworkScope: "full", resumeMethod: { type: "fresh_session" },
      startedAt: "2026-08-01T00:00:00.000Z", verdict: "needs-attention", probesGreen: true,
      modelEntry: "fake/model", modelVariant: null, fallbacks: null,
      implementJobId: "job-imp-1", reviewJobId: "job-rev-1", sessionID: "sess-1",
      implementUsage: null, reviewUsage: null, tierBefore: 0, tierAfter: 0, reworkCount: 0,
      pendingReworkStrategy: { tierDelta: 0, newSession: false, reason: "1st rework: same tier, continue session, keep artifacts" },
      disposition: { disposition: "rework", reason: "needs-attention" },
      findings: [designFinding(1, "src/a.js"), mechFinding(1, "src/b.js")],
      findingFiles: ["src/a.js", "src/b.js"],
      findingsText: "mixed findings",
    };
    const r2 = {
      round: 2, reworkScope: "mechanical", resumeMethod: { type: "continue_session" },
      startedAt: "2026-08-01T00:00:00.000Z", verdict: "needs-attention", probesGreen: true,
      modelEntry: "fake/model", modelVariant: null, fallbacks: null,
      implementJobId: "job-imp-2", reviewJobId: "job-rev-2", sessionID: "sess-2",
      implementUsage: null, reviewUsage: null, tierBefore: 0, tierAfter: 0, reworkCount: 1,
      pendingReworkStrategy: { tierDelta: 0, newSession: false, reason: "1st rework: same tier, continue session, keep artifacts" },
      disposition: { disposition: "rework", reason: "needs-attention" },
      findings: [mechFinding(2, "src/c.js")],
      findingFiles: ["src/c.js"],
      findingsText: "mechanical findings",
    };
    const { tmp, chainDir } = makeChainState({ records: [r1, r2], maxRounds: 4 });
    try {
      const { text, calls } = await runResume({ chainDir, maxRounds: 4, reviewResults: [reviewResult("approve", [])] });
      assert.match(text, /accepted at round 3/);

      // The resumed round's scope is re-derived from round 2's
      // mechanical-only findings — no persisted budget state is consulted.
      const round3 = readJson(path.join(chainDir, "round-3.json"));
      assert.equal(round3.reworkScope, "mechanical");
      assert.equal(round3.disposition.disposition, "accept");

      const imp3 = calls.find((c) => c.kind === "task" && c.round === 3);
      assert.ok(imp3, "round 3 implement must be dispatched");
      assert.ok(imp3.promptText.includes(MECH_SENTENCE));
      assert.ok(!imp3.promptText.includes("Design decision 1"));

      const chainJson = readJson(path.join(chainDir, "chain.json"));
      assert.equal(chainJson.records.length, 3);
      // Budget is derived by counting records, never persisted.
      assert.equal(chainJson.budgetUsed, undefined);

      const control = readChainControl(chainDir);
      assert.equal(control.status, "completed");
      assert.equal(control.round, 3);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("resumes a mechanical-tail chain whose raw round count exceeds maxRounds while budget remains", async () => {
    // maxRounds=2; round 1 full (mixed findings), round 2 mechanical
    // (mechanical-only findings), both rework — chain cancelled after round 2.
    // Budget used = 1 < 2, so the RESUME GATE (kusabi #60 step 2 review) must
    // admit the chain even though nextRound 3 > maxRounds 2, and the driver
    // must run rounds 3-4 (the 2 × maxRounds hard cap).
    const r1 = {
      round: 1, reworkScope: "full", resumeMethod: { type: "fresh_session" },
      startedAt: "2026-08-01T00:00:00.000Z", verdict: "needs-attention", probesGreen: true,
      modelEntry: "fake/model", modelVariant: null, fallbacks: null,
      implementJobId: "job-imp-1", reviewJobId: "job-rev-1", sessionID: "sess-1",
      implementUsage: null, reviewUsage: null, tierBefore: 0, tierAfter: 0, reworkCount: 0,
      pendingReworkStrategy: { tierDelta: 0, newSession: false, reason: "1st rework: same tier, continue session, keep artifacts" },
      disposition: { disposition: "rework", reason: "needs-attention" },
      findings: [designFinding(1, "src/a.js"), mechFinding(1, "src/b.js")],
      findingFiles: ["src/a.js", "src/b.js"],
      findingsText: "mixed findings",
    };
    const r2 = {
      round: 2, reworkScope: "mechanical", resumeMethod: { type: "continue_session" },
      startedAt: "2026-08-01T00:00:00.000Z", verdict: "needs-attention", probesGreen: true,
      modelEntry: "fake/model", modelVariant: null, fallbacks: null,
      implementJobId: "job-imp-2", reviewJobId: "job-rev-2", sessionID: "sess-2",
      implementUsage: null, reviewUsage: null, tierBefore: 0, tierAfter: 0, reworkCount: 1,
      pendingReworkStrategy: { tierDelta: 0, newSession: false, reason: "1st rework: same tier, continue session, keep artifacts" },
      disposition: { disposition: "rework", reason: "needs-attention" },
      findings: [{ ...mechFinding(2, "src/c.js"), severity: "high" }],
      findingFiles: ["src/c.js"],
      findingsText: "mechanical findings",
    };
    const { tmp, chainDir } = makeChainState({ records: [r1, r2], maxRounds: 2 });
    try {
      const { text, calls } = await runResume({
        chainDir, maxRounds: 2,
        reviewResults: [
          reviewResult("needs-attention", [{ ...mechFinding(3, "src/d.js"), severity: "high" }]),
          reviewResult("approve", []),
        ],
      });
      assert.match(text, /accepted at round 4/);

      // The resumed run continued to raw round 4 with budget 1 of 2, then the
      // 2 × maxRounds hard cap ended the loop (round 5 never ran).
      const round3 = readJson(path.join(chainDir, "round-3.json"));
      assert.equal(round3.reworkScope, "mechanical");
      assert.equal(round3.disposition.disposition, "rework");
      const round4 = readJson(path.join(chainDir, "round-4.json"));
      assert.equal(round4.reworkScope, "mechanical");
      assert.equal(round4.disposition.disposition, "accept");
      assert.equal(fs.existsSync(path.join(chainDir, "round-5.json")), false);

      // Round 3's implement brief is the scoped mechanical checklist.
      const imp3 = calls.find((c) => c.kind === "task" && c.round === 3);
      assert.ok(imp3, "round 3 implement must be dispatched");
      assert.ok(imp3.promptText.includes(MECH_SENTENCE));

      const chainJson = readJson(path.join(chainDir, "chain.json"));
      assert.equal(chainJson.records.length, 4);
      const control = readChainControl(chainDir);
      assert.equal(control.status, "completed");
      assert.equal(control.round, 4);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a review-resume completes the interrupted round even when it spent the last budget slot", async () => {
    const complete = (round) => ({
      round, reworkScope: "full", resumeMethod: { type: "fresh_session" },
      startedAt: "2026-08-01T00:00:00.000Z", verdict: "needs-attention", probesGreen: true,
      modelEntry: "fake/model", modelVariant: null, fallbacks: null,
      implementJobId: "job-imp-" + round, reviewJobId: "job-rev-" + round, sessionID: "sess-" + round,
      implementUsage: null, reviewUsage: null, tierBefore: 0, tierAfter: 0, reworkCount: round - 1,
      pendingReworkStrategy: { tierDelta: 0, newSession: false, reason: "1st rework: same tier" },
      disposition: { disposition: "rework", reason: "needs-attention" },
      findings: [], findingFiles: [], findingsText: "(no structured findings)",
    });
    const partial = {
      round: 4, reworkScope: "full", resumeMethod: { type: "continue_session" },
      startedAt: "2026-08-01T00:00:00.000Z", verdict: null, probesGreen: true,
      modelEntry: "fake/model", modelVariant: null, fallbacks: null,
      implementJobId: "job-imp-4", sessionID: "sess-4", implementUsage: null,
      tierBefore: 0, reworkCount: 3,
      probeResults: [{ probe: "P1: HEAD clean", passed: true, detail: "ok" }],
      worktreeChanged: true, interrupted: true, interruptedAfter: "probes",
    };
    const { tmp, chainDir } = makeChainState({ records: [complete(1), complete(2), complete(3), partial], maxRounds: 4 });
    try {
      const { text } = await runResume({ chainDir, maxRounds: 4, reviewResults: [reviewResult("approve", [])] });
      assert.match(text, /accepted at round 4/);

      const round4 = readJson(path.join(chainDir, "round-4.json"));
      assert.equal(round4.disposition.disposition, "accept");
      assert.equal(round4.resumed, true);
      assert.equal(round4.reworkScope, "full");

      const control = readChainControl(chainDir);
      assert.equal(control.status, "completed");
      assert.equal(control.round, 4);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// =========================================================================
// chain-resume CLI — subprocess error paths (kusabi #153①)
// =========================================================================

describe("chain-resume CLI", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");

  // The subprocess resolves its workspace state dir via stateDirFor(cwd),
  // which hashes the cwd under the state root — replicate that here so the
  // fixture chain lands where the subprocess looks for it.
  function hashedWorkspaceDir(stateRootDir, cwd) {
    const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12);
    return path.join(stateRootDir, hash);
  }

  // The container-reachability guard must not depend on whatever happens to
  // be listening on the default endpoint in the ambient environment: every
  // subprocess gets an explicit endpoint here (a dead port by default;
  // tests that need a live answer pass their own KUSABI_SUNABA_URL).
  function resumeEnv(stateDir, extraEnv) {
    const env = { ...process.env };
    delete env.KUSABI_WORKER_CONTEXT;
    env.KUSABI_STATE_DIR = stateDir;
    env.KUSABI_SUNABA_URL = extraEnv?.KUSABI_SUNABA_URL ?? "http://127.0.0.1:9/mcp";
    return env;
  }

  function runResume(args, { stateDir, cwd, env: extraEnv } = {}) {
    return spawnSync(process.execPath, [COMPANION_SCRIPT, "chain-resume", ...args], {
      encoding: "utf8",
      cwd,
      env: resumeEnv(stateDir, extraEnv),
      timeout: 15_000,
    });
  }

  // Async variant for tests that serve a stub endpoint: spawnSync would block
  // this process's event loop, so the stub could never answer the child.
  function runResumeAsync(args, { stateDir, cwd, env: extraEnv } = {}) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [COMPANION_SCRIPT, "chain-resume", ...args], {
        cwd,
        env: resumeEnv(stateDir, extraEnv),
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => child.kill("SIGTERM"), 15_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ status: code, stdout, stderr });
      });
    });
  }

  // A minimal sunaba MCP endpoint for the reachability tests. callTool does
  // three POSTs to the same URL: initialize (must answer with the
  // mcp-session-id response header), notifications/initialized, then
  // tools/call (parsed as SSE, unwrapped from result.content[0].text as JSON).
  // We answer every request with the session-id header, a 200, and one SSE
  // data: line; tools/call carries the given tool result. Bound to port 0 so
  // parallel runs do not collide.
  function startSunabaStub({ toolResultText }) {
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
        res.setHeader("mcp-session-id", "stub-session");
        res.writeHead(200, { "content-type": "text/event-stream" });
        let envelope;
        if (payload?.method === "tools/call") {
          envelope = {
            jsonrpc: "2.0",
            id: payload.id ?? 1,
            result: { content: [{ type: "text", text: JSON.stringify(toolResultText) }] },
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
        resolve({ server, url: `http://127.0.0.1:${port}/mcp` });
      });
    });
  }

  function makeChain(stateDir, chainId, { control, chainJson } = {}) {
    const chainDir = path.join(stateDir, "chains", chainId);
    fs.mkdirSync(chainDir, { recursive: true });
    if (chainJson) writeJson(path.join(chainDir, "chain.json"), chainJson);
    if (control) writeChainControl(chainDir, control);
    return chainDir;
  }

  function validChainJson() {
    return {
      chainId: "chain-x",
      container: "cid-1",
      model: "fake/model",
      modelChain: [["fake/model"]],
      maxRounds: 4,
      brief: "Implement X.",
      orchestrator: null,
      records: [{
        round: 1,
        implementJobId: "job-1",
        verdict: null,
        probesGreen: true,
        tierBefore: 0,
        reworkCount: 0,
        interrupted: true,
        interruptedAfter: "probes",
      }],
      baseSha: "abc123",
      chainTotals: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      strategized: false,
      followupIssueDraft: null,
    };
  }

  it("requires a chain id", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-resume-cli-"));
    try {
      const result = runResume([], { stateDir: path.join(tmp, "state"), cwd: tmp });
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /chain-resume requires a chain id/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("errors for an unknown chain id", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-resume-cli-"));
    try {
      const result = runResume(["chain-nope"], { stateDir: path.join(tmp, "state"), cwd: tmp });
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /chain not found: chain-nope/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects unsupported flags explicitly instead of silently ignoring them", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-resume-cli-"));
    try {
      const result = runResume(["--model", "x/y", "chain-x"], { stateDir: path.join(tmp, "state"), cwd: tmp });
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /does not support --model/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses a running chain (live pid) before any container contact", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-resume-cli-"));
    try {
      const stateDir = hashedWorkspaceDir(path.join(tmp, "state"), tmp);
      makeChain(stateDir, "chain-running", {
        control: {
          chainId: "chain-running", container: "cid-1", pid: process.pid, // alive
          status: "running", round: 2, startedAt: new Date().toISOString(),
        },
        chainJson: validChainJson(),
      });
      const result = runResume(["chain-running"], { stateDir: path.join(tmp, "state"), cwd: tmp });
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /still running/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses a completed chain", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-resume-cli-"));
    try {
      const stateDir = hashedWorkspaceDir(path.join(tmp, "state"), tmp);
      makeChain(stateDir, "chain-done", {
        control: {
          chainId: "chain-done", container: "cid-1", pid: 0,
          status: "completed", round: 2, finishedAt: new Date().toISOString(),
        },
        chainJson: validChainJson(),
      });
      const result = runResume(["chain-done"], { stateDir: path.join(tmp, "state"), cwd: tmp });
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /already finished/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses to resume while a job of this chain is still recorded as running (#153①)", () => {
    // A dead driver (stale pid) can leave a phase job mid-flight with no
    // phase boundary in the records; resuming would re-dispatch that phase
    // as a duplicate job against the same container worktree.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-resume-cli-"));
    try {
      const stateDir = hashedWorkspaceDir(path.join(tmp, "state"), tmp);
      makeChain(stateDir, "chain-x", {
        control: {
          chainId: "chain-x", container: "cid-1", pid: 0, // dead pid — abnormal stop
          status: "running", round: 1, startedAt: new Date().toISOString(),
        },
        chainJson: validChainJson(),
      });
      const jobDir = path.join(stateDir, "jobs", "job-mid");
      fs.mkdirSync(jobDir, { recursive: true });
      writeJson(path.join(jobDir, "job.json"), {
        id: "job-mid",
        status: "running",
        title: "chain: chain-x round 1 review",
        startedAt: new Date().toISOString(),
      });
      const result = runResume(["chain-x"], { stateDir: path.join(tmp, "state"), cwd: tmp });
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /still recorded as running/);
      assert.match(result.stdout, /cancel job-mid/);
      // The guard fires before any container contact / control re-arm.
      const control = readChainControl(path.join(stateDir, "chains", "chain-x"));
      assert.equal(control.resumedAt, undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ignores running jobs of OTHER chains when resuming", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-resume-cli-"));
    try {
      const stateDir = hashedWorkspaceDir(path.join(tmp, "state"), tmp);
      makeChain(stateDir, "chain-x", {
        control: {
          chainId: "chain-x", container: "fake-cid", pid: 0,
          status: "running", round: 1, startedAt: new Date().toISOString(),
        },
        chainJson: validChainJson(),
      });
      const jobDir = path.join(stateDir, "jobs", "job-other");
      fs.mkdirSync(jobDir, { recursive: true });
      writeJson(path.join(jobDir, "job.json"), {
        id: "job-other",
        status: "running",
        title: "chain: chain-unrelated round 2 implement",
        startedAt: new Date().toISOString(),
      });
      const result = runResume(["chain-x"], {
        stateDir: path.join(tmp, "state"),
        cwd: tmp,
        // Falls past the in-flight guard to the container-reachability check:
        // nothing is listening on this explicit endpoint (connection refused).
        env: { KUSABI_SUNABA_URL: "http://127.0.0.1:9/mcp" },
      });
      // Falls through the guard to the container-reachability check.
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /not reachable/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports an unreachable container for a resumable stale chain (nothing listening on the endpoint)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-resume-cli-"));
    try {
      const stateDir = hashedWorkspaceDir(path.join(tmp, "state"), tmp);
      makeChain(stateDir, "chain-stale", {
        control: {
          chainId: "chain-stale", container: "fake-cid", pid: 0, // dead pid → abnormal stop
          status: "running", round: 1, startedAt: new Date().toISOString(),
        },
        chainJson: validChainJson(),
      });
      const result = runResume(["chain-stale"], {
        stateDir: path.join(tmp, "state"),
        cwd: tmp,
        // Nothing is listening on this explicit endpoint (connection refused).
        env: { KUSABI_SUNABA_URL: "http://127.0.0.1:9/mcp" },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /not reachable/);
      // The control record must NOT have been re-armed past the failure
      const control = readChainControl(path.join(stateDir, "chains", "chain-stale"));
      assert.equal(control.status, "running");
      assert.equal(control.resumedAt, undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses to resume when the sunaba server answers that the container is missing (error-shaped result)", async () => {
    // callTool resolves (does not throw) with { status: "error", error:
    // "Container … not found" } when the container is gone — the guard must
    // treat that as unreachable, not let the resume sail through.
    const { server, url } = await startSunabaStub({
      toolResultText: {
        status: "error",
        error: "Container fake-cid not found",
        recommended_next_action: "sandbox_list_containers to find running containers, or sandbox_initialize to start one",
      },
    });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-resume-cli-"));
    try {
      const stateDir = hashedWorkspaceDir(path.join(tmp, "state"), tmp);
      makeChain(stateDir, "chain-stale", {
        control: {
          chainId: "chain-stale", container: "fake-cid", pid: 0, // dead pid → abnormal stop
          status: "running", round: 1, startedAt: new Date().toISOString(),
        },
        chainJson: validChainJson(),
      });
      const result = await runResumeAsync(["chain-stale"], {
        stateDir: path.join(tmp, "state"),
        cwd: tmp,
        env: { KUSABI_SUNABA_URL: url },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /not reachable/);
      assert.match(result.stdout, /Container fake-cid not found/);
      // The control record must NOT have been re-armed past the failure
      const control = readChainControl(path.join(stateDir, "chains", "chain-stale"));
      assert.equal(control.status, "running");
      assert.equal(control.resumedAt, undefined);
    } finally {
      server.close();
      server.closeAllConnections?.();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("claude backend: the same DATA-shaped container absence refusal, and no claude dispatch ever starts", async () => {
    // The known trap, exercised for the claude path: the container-liveness
    // guard receives container absence as DATA — callTool RESOLVES with a
    // JSON payload ({ status: "error", error: "Container ... not found" }),
    // not a rejection.  The recorded backend (claude) changes nothing about
    // the guard: the resume must be refused with the same "not reachable"
    // error, the control record must not be re-armed, and the claude
    // dispatch must never be invoked past the guard.
    const { server, url } = await startSunabaStub({
      toolResultText: {
        status: "error",
        error: "Container fake-cid not found",
        recommended_next_action: "sandbox_list_containers to find running containers, or sandbox_initialize to start one",
      },
    });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-resume-cli-"));
    // A fake claude that would record an invocation — its log must stay
    // empty, proving the guard fires before any dispatch.
    const claudeArgsLog = path.join(tmp, "claude-args.ndjson");
    fs.writeFileSync(claudeArgsLog, "", "utf8");
    const claudeBinPath = path.join(tmp, "fake-claude.mjs");
    fs.writeFileSync(
      claudeBinPath,
      "#!/usr/bin/env node\n" +
      "import fs from \"node:fs\";\n" +
      "fs.appendFileSync(process.env.FAKE_CLAUDE_ARGS_LOG, JSON.stringify(process.argv.slice(2)) + \"\\n\");\n" +
      "process.stdout.write(JSON.stringify({ type: \"result\", is_error: false, result: \"ok\", session_id: \"claude-uuid-resume\" }));\n",
      "utf8",
    );
    fs.chmodSync(claudeBinPath, 0o755);
    const savedClaudeBin = process.env.CLAUDE_BIN;
    const savedArgsLog = process.env.FAKE_CLAUDE_ARGS_LOG;
    const savedMcpSource = process.env.KUSABI_CLAUDE_MCP_SOURCE;
    process.env.CLAUDE_BIN = claudeBinPath;
    process.env.FAKE_CLAUDE_ARGS_LOG = claudeArgsLog;
    const mcpSource = path.join(tmp, "claude.json");
    fs.writeFileSync(mcpSource, JSON.stringify({ mcpServers: { sunaba: { command: "npx" } } }), "utf8");
    process.env.KUSABI_CLAUDE_MCP_SOURCE = mcpSource;
    try {
      const stateDir = hashedWorkspaceDir(path.join(tmp, "state"), tmp);
      const chainJson = validChainJson();
      // The chain ran on the claude backend: the record carries the backend
      // and a claude-shaped model.
      chainJson.records[0].backend = "claude";
      chainJson.model = "sonnet";
      chainJson.modelChain = [["sonnet"]];
      makeChain(stateDir, "chain-claude", {
        control: {
          chainId: "chain-claude", container: "fake-cid", pid: 0, // dead pid → abnormal stop
          status: "running", round: 1, startedAt: new Date().toISOString(),
        },
        chainJson,
      });
      const result = await runResumeAsync(["chain-claude"], {
        stateDir: path.join(tmp, "state"),
        cwd: tmp,
        env: { KUSABI_SUNABA_URL: url },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /not reachable/);
      assert.match(result.stdout, /Container fake-cid not found/);
      // The claude path never dispatched past the guard.
      assert.equal(fs.readFileSync(claudeArgsLog, "utf8").trim(), "");
      // The control record must NOT have been re-armed past the failure.
      const control = readChainControl(path.join(stateDir, "chains", "chain-claude"));
      assert.equal(control.status, "running");
      assert.equal(control.resumedAt, undefined);
    } finally {
      if (savedClaudeBin === undefined) delete process.env.CLAUDE_BIN;
      else process.env.CLAUDE_BIN = savedClaudeBin;
      if (savedArgsLog === undefined) delete process.env.FAKE_CLAUDE_ARGS_LOG;
      else process.env.FAKE_CLAUDE_ARGS_LOG = savedArgsLog;
      if (savedMcpSource === undefined) delete process.env.KUSABI_CLAUDE_MCP_SOURCE;
      else process.env.KUSABI_CLAUDE_MCP_SOURCE = savedMcpSource;
      server.close();
      server.closeAllConnections?.();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("legacy claude chain.json (no reviewModel key): the resumed review clamps to the pinned implement model", async () => {
    // Pre-#192 chain.json: the record carries backend claude (kusabi #184)
    // but chain.json has NO reviewModel / reviewModelChain keys.  chain-resume
    // must treat key absence as legacy and clamp the resumed review to the
    // implement model: the review dispatches `claude -p --model <pinned>` —
    // never the chain's first route, which may differ from the pinned
    // --model (the legacy bug re-derived the review from the first route).
    const { server, url } = await startSunabaStub({
      toolResultText: { output: " M src/foo.js\n" },
    });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-resume-legacy-claude-"));
    const claudeArgsLog = path.join(tmp, "claude-args.ndjson");
    fs.writeFileSync(claudeArgsLog, "", "utf8");
    const claudeBinPath = path.join(tmp, "fake-claude.mjs");
    fs.writeFileSync(
      claudeBinPath,
      "#!/usr/bin/env node\n" +
      "import fs from \"node:fs\";\n" +
      "fs.appendFileSync(process.env.FAKE_CLAUDE_ARGS_LOG, JSON.stringify(process.argv.slice(2)) + \"\\n\");\n" +
      "process.stdout.write(JSON.stringify({ type: \"result\", is_error: false, result: \"ok\", session_id: \"claude-uuid-resume\" }));\n",
      "utf8",
    );
    fs.chmodSync(claudeBinPath, 0o755);
    const savedClaudeBin = process.env.CLAUDE_BIN;
    const savedArgsLog = process.env.FAKE_CLAUDE_ARGS_LOG;
    const savedMcpSource = process.env.KUSABI_CLAUDE_MCP_SOURCE;
    process.env.CLAUDE_BIN = claudeBinPath;
    process.env.FAKE_CLAUDE_ARGS_LOG = claudeArgsLog;
    const mcpSource = path.join(tmp, "claude.json");
    fs.writeFileSync(mcpSource, JSON.stringify({ mcpServers: { sunaba: { command: "npx" } } }), "utf8");
    process.env.KUSABI_CLAUDE_MCP_SOURCE = mcpSource;
    try {
      const stateDir = hashedWorkspaceDir(path.join(tmp, "state"), tmp);
      const chainJson = validChainJson();
      // Legacy claude chain: backend on the record, pinned model whose value
      // DIFFERS from the chain's first route — the legacy bug would re-derive
      // the review from the first route ("opus") instead of the pinned
      // implement model ("sonnet").
      chainJson.records[0].backend = "claude";
      chainJson.model = "sonnet";
      chainJson.modelChain = [["opus"]];
      makeChain(stateDir, "chain-legacy", {
        control: {
          chainId: "chain-legacy", container: "cid-1", pid: 0, // dead pid → abnormal stop
          status: "running", round: 1, startedAt: new Date().toISOString(),
        },
        chainJson,
      });
      const result = await runResumeAsync(["chain-legacy"], {
        stateDir: path.join(tmp, "state"),
        cwd: tmp,
        env: { KUSABI_SUNABA_URL: url },
      });
      // The resumed review ran on the fake claude binary (an unparseable
      // review result is retried once, so up to two dispatch lines).  EVERY
      // line must pin the recorded implement model — never the chain's first
      // route.
      const lines = fs.readFileSync(claudeArgsLog, "utf8").trim().split("\n").filter(Boolean);
      assert.ok(lines.length >= 1,
        `review dispatch never reached the claude binary: ${result.stdout} ${result.stderr}`);
      for (const line of lines) {
        assert.match(line, /--model","sonnet"/,
          `resumed review must clamp to the pinned implement model, got: ${line}`);
        assert.doesNotMatch(line, /--model","opus"/,
          "resumed review must not re-derive from the chain's first route");
      }
    } finally {
      if (savedClaudeBin === undefined) delete process.env.CLAUDE_BIN;
      else process.env.CLAUDE_BIN = savedClaudeBin;
      if (savedArgsLog === undefined) delete process.env.FAKE_CLAUDE_ARGS_LOG;
      else process.env.FAKE_CLAUDE_ARGS_LOG = savedArgsLog;
      if (savedMcpSource === undefined) delete process.env.KUSABI_CLAUDE_MCP_SOURCE;
      else process.env.KUSABI_CLAUDE_MCP_SOURCE = savedMcpSource;
      server.close();
      server.closeAllConnections?.();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("axis 2: a chain.json with rework keys resumes the rework round on the rework backend/model (claude, pinned rework model, fresh session)", async () => {
    // The round-1 record ran implement on OPENCODE (backend field + an
    // opencode ses_* session) with disposition rework, so the resume lands
    // at round 2's IMPLEMENT phase.  chain.json carries the rework context
    // (reworkBackend claude / reworkModel sonnet) — the resumed rework round
    // must dispatch on the clamped claude dispatch pinned to sonnet, NEVER
    // on the implement resolution (opus), and must NOT carry the opencode
    // round's session across the backend switch.
    const { server, url } = await startSunabaStub({
      toolResultText: { output: " M src/foo.js\n" },
    });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-resume-rework-cli-"));
    const claudeArgsLog = path.join(tmp, "claude-args.ndjson");
    fs.writeFileSync(claudeArgsLog, "", "utf8");
    const claudeBinPath = path.join(tmp, "fake-claude.mjs");
    fs.writeFileSync(
      claudeBinPath,
      "#!/usr/bin/env node\n" +
      "import fs from \"node:fs\";\n" +
      "fs.appendFileSync(process.env.FAKE_CLAUDE_ARGS_LOG, JSON.stringify(process.argv.slice(2)) + \"\\n\");\n" +
      "process.stdout.write(JSON.stringify({ type: \"result\", is_error: false, result: \"ok\", session_id: \"claude-uuid-resume\" }));\n",
      "utf8",
    );
    fs.chmodSync(claudeBinPath, 0o755);
    const savedClaudeBin = process.env.CLAUDE_BIN;
    const savedArgsLog = process.env.FAKE_CLAUDE_ARGS_LOG;
    const savedMcpSource = process.env.KUSABI_CLAUDE_MCP_SOURCE;
    process.env.CLAUDE_BIN = claudeBinPath;
    process.env.FAKE_CLAUDE_ARGS_LOG = claudeArgsLog;
    const mcpSource = path.join(tmp, "claude.json");
    fs.writeFileSync(mcpSource, JSON.stringify({ mcpServers: { sunaba: { command: "npx" } } }), "utf8");
    process.env.KUSABI_CLAUDE_MCP_SOURCE = mcpSource;
    try {
      const stateDir = hashedWorkspaceDir(path.join(tmp, "state"), tmp);
      const chainJson = {
        chainId: "chain-rework",
        container: "cid-1",
        model: "opus",
        modelChain: [["opus"]],
        // Per-phase review context: review runs on claude with haiku.
        reviewModel: "haiku",
        reviewModelChain: [["haiku"]],
        // Per-round rework context (kusabi #192 axis 2): rework rounds run
        // on claude with sonnet — a different backend than round 1.
        reworkModel: "sonnet",
        reworkModelChain: [["sonnet"]],
        reworkBackend: "claude",
        maxRounds: 4,
        brief: "Implement X.",
        orchestrator: null,
        records: [{
          round: 1,
          resumeMethod: { type: "continue_session" },
          implementJobId: "job-imp-1",
          reviewJobId: "job-rev-1",
          verdict: "needs-attention",
          probesGreen: false,
          modelEntry: "opencode-go/deepseek-v4-pro",
          modelVariant: null, fallbacks: null,
          sessionID: "ses_opencode_1",
          implementUsage: null, reviewUsage: null,
          tierBefore: 0, tierAfter: 0, reworkCount: 0,
          pendingReworkStrategy: { tierDelta: 0, newSession: false, reason: "1st rework: same tier, continue session, keep artifacts" },
          disposition: { disposition: "rework", reason: "needs-attention" },
          findingsText: "fix the parser",
          backend: "opencode",
          reviewBackend: "claude",
        }],
        baseSha: "abc123",
        chainTotals: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        strategized: false,
        followupIssueDraft: null,
      };
      makeChain(stateDir, "chain-rework", {
        control: {
          chainId: "chain-rework", container: "cid-1", pid: 0, // dead pid → abnormal stop
          status: "running", round: 1, startedAt: new Date().toISOString(),
        },
        chainJson,
      });
      const result = await runResumeAsync(["chain-rework"], {
        stateDir: path.join(tmp, "state"),
        cwd: tmp,
        env: { KUSABI_SUNABA_URL: url },
      });
      const lines = fs.readFileSync(claudeArgsLog, "utf8").trim().split("\n").filter(Boolean);
      assert.ok(lines.length >= 1,
        `rework dispatch never reached the claude binary: ${result.stdout} ${result.stderr}`);
      // The prompt (with the round title) goes to stdin, not argv — the
      // pinned --model distinguishes the phases: sonnet = rework implement
      // (rework resolution), haiku = review (review resolution).
      const reworkImplementLines = lines.filter((l) => l.includes("--model\",\"sonnet\""));
      assert.ok(reworkImplementLines.length >= 1,
        `no rework implement dispatch found in: ${lines.join("\n")}`);
      for (const line of lines) {
        assert.doesNotMatch(line, /--model\",\"opus\"/,
          "resumed rework implement must not fall back to the implement model");
        assert.doesNotMatch(line, /ses_opencode_1/,
          "the opencode round's session must not cross into the claude rework round (fresh start)");
        assert.match(line, /--model\",\"(sonnet|haiku)\"/,
          `every resumed claude dispatch must pin its own phase's model, got: ${line}`);
      }
      assert.equal(result.status, 0, `resumed chain should complete: ${result.stdout} ${result.stderr}`);
    } finally {
      if (savedClaudeBin === undefined) delete process.env.CLAUDE_BIN;
      else process.env.CLAUDE_BIN = savedClaudeBin;
      if (savedArgsLog === undefined) delete process.env.FAKE_CLAUDE_ARGS_LOG;
      else process.env.FAKE_CLAUDE_ARGS_LOG = savedArgsLog;
      if (savedMcpSource === undefined) delete process.env.KUSABI_CLAUDE_MCP_SOURCE;
      else process.env.KUSABI_CLAUDE_MCP_SOURCE = savedMcpSource;
      server.close();
      server.closeAllConnections?.();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// Spawn a fake long-lived serve: the marker env buildServeEnv() stamps into
// every real serve (KUSABI_WORKER_CONTEXT=1 plus KUSABI_SERVE_STATE_DIR) and
// a bare "serve" argv token, so the recorded pid passes the isOurServe()
// identity gate every kill site now uses (kusabi #181).  A marker-less pid
// recorded in server.json is refused everywhere now (record deleted, nothing
// killed); the refusal paths are covered in serve-lifecycle.test.mjs.
function spawnServeShapedSleeper(stateDir) {
  const env = {
    ...process.env,
    KUSABI_WORKER_CONTEXT: "1",
    KUSABI_SERVE_STATE_DIR: stateDir,
  };
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "serve"], { env, stdio: "ignore" });
}

// serve-stop — fossil `running` records must not block stopping (kusabi #162
// follow-up).  The companion runs as a real subprocess against a temp state
// root; the recorded serve is a fake long-lived process the test spawns and
// kills itself.  The startup reaper hook runs inside the subprocess too: the
// fixture's fresh file mtimes keep reapIdleServes from reaping, and the
// fixture carries the marker env with the recorded pid named in server.json,
// so the orphan sweep spares it.  The fake is serve-shaped (marker env +
// bare "serve" argv) because every kill site now refuses a recorded pid that
// fails the isOurServe() identity gate (kusabi #181) — the decline itself is
// covered by the identity-gate tests in serve-lifecycle.test.mjs.
// ---------------------------------------------------------------------------

describe("serve-stop fossil running records", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");

  function serveStopFixture({ lastActivityAgeMs }) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-servestop-"));
    const stateRootDir = path.join(tmp, "state");
    const cwd = path.join(tmp, "ws");
    fs.mkdirSync(cwd, { recursive: true });
    const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12);
    const stateDir = path.join(stateRootDir, hash);
    const jobsDir = path.join(stateDir, "jobs", "job-fossil");
    fs.mkdirSync(jobsDir, { recursive: true });
    const sleeper = spawnServeShapedSleeper(stateDir);
    const job = {
      id: "job-fossil",
      status: "running",
      startedAt: new Date(Date.now() - lastActivityAgeMs).toISOString(),
      stats: { lastActivity: new Date(Date.now() - lastActivityAgeMs).toISOString() },
    };
    fs.writeFileSync(path.join(jobsDir, "job.json"), JSON.stringify(job), "utf8");
    const serverFile = path.join(stateDir, "server.json");
    fs.writeFileSync(serverFile, JSON.stringify({ pid: sleeper.pid, port: 0, password: "x", cwd }), "utf8");
    return {
      tmp,
      stateRootDir,
      cwd,
      serverFile,
      sleeper,
      run(args = []) {
        const env = { ...process.env, KUSABI_STATE_DIR: stateRootDir };
        return spawnSync(process.execPath, [COMPANION_SCRIPT, "serve-stop", ...args], {
          cwd,
          encoding: "utf8",
          env,
          timeout: 15_000,
        });
      },
      cleanup() {
        try { process.kill(sleeper.pid, "SIGKILL"); } catch { /* already gone */ }
        fs.rmSync(tmp, { recursive: true, force: true });
      },
    };
  }

  function pidAlive(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  async function waitPidDead(pid, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!pidAlive(pid)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
  }

  it("stops the serve without --force when the only running records are fossils", async () => {
    const fx = serveStopFixture({ lastActivityAgeMs: 7 * 24 * 3600 * 1000 });
    try {
      const result = fx.run();
      assert.equal(result.status, 0, `serve-stop failed: ${result.stdout} ${result.stderr}`);
      assert.match(result.stdout, /stopped opencode server \(pid \d+\)/);
      await waitPidDead(fx.sleeper.pid);
      assert.ok(!fs.existsSync(fx.serverFile), "server.json must be removed by serve-stop");
    } finally {
      fx.cleanup();
    }
  });

  it("declines with the existing message when a running record is recent (1 hour ago)", async () => {
    const fx = serveStopFixture({ lastActivityAgeMs: 3600 * 1000 });
    try {
      const result = fx.run();
      assert.equal(result.status, 0, `serve-stop errored: ${result.stdout} ${result.stderr}`);
      assert.match(result.stdout, /job\(s\) still running/);
      assert.match(result.stdout, /job-fossil/);
      assert.match(result.stdout, /serve-stop does not stop a running chain/);
      assert.doesNotMatch(result.stdout, /stopped opencode server/);
      assert.ok(pidAlive(fx.sleeper.pid), "the serve must survive a declined serve-stop");
      assert.ok(fs.existsSync(fx.serverFile), "server.json must survive a declined serve-stop");
    } finally {
      fx.cleanup();
    }
  });

  it("--force still stops the serve when a recent running record exists", async () => {
    const fx = serveStopFixture({ lastActivityAgeMs: 3600 * 1000 });
    try {
      const result = fx.run(["--force"]);
      assert.equal(result.status, 0, `serve-stop --force failed: ${result.stdout} ${result.stderr}`);
      assert.match(result.stdout, /stopped opencode server \(pid \d+\)/);
      await waitPidDead(fx.sleeper.pid);
    } finally {
      fx.cleanup();
    }
  });
});

// serve-stop identity gate — the real CLI flow (kusabi #181 follow-up)
// ---------------------------------------------------------------------------
// The startup reaper runs before the subcommand switch; on a serve-stop
// invocation it must leave identity-failed records in place so cmdServeStop
// itself adjudicates them and the reason-bearing decline message reaches the
// user in the actual invocation path — not just via a direct function call.
// The recorded pid is a marker-less live process (the incident shape); the
// sweep's reapOrphanedServes cannot touch it (no marker), reapIdleServes
// leaves it (keepIdentityFailed), and cmdServeStop declines with the reason.

describe("serve-stop identity gate (CLI subprocess)", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");

  function identityDeclineFixture() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-servestop-idcli-"));
    const stateRootDir = path.join(tmp, "state");
    const cwd = path.join(tmp, "ws");
    fs.mkdirSync(cwd, { recursive: true });
    const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12);
    const stateDir = path.join(stateRootDir, hash);
    fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
    // A marker-less live process — the incident shape: the record holds a
    // pid that is not one of our serves.
    const stranger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const serverFile = path.join(stateDir, "server.json");
    fs.writeFileSync(serverFile, JSON.stringify({ pid: stranger.pid, port: 0, password: "x", cwd }), "utf8");
    return {
      tmp,
      stateRootDir,
      cwd,
      serverFile,
      stranger,
      run(args = []) {
        const env = { ...process.env, KUSABI_STATE_DIR: stateRootDir };
        return spawnSync(process.execPath, [COMPANION_SCRIPT, "serve-stop", ...args], {
          cwd,
          encoding: "utf8",
          env,
          timeout: 15_000,
        });
      },
      cleanup() {
        try { process.kill(stranger.pid, "SIGKILL"); } catch { /* already gone */ }
        fs.rmSync(tmp, { recursive: true, force: true });
      },
    };
  }

  function pidAlive(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  it("declines with the reason in the real CLI flow for a marker-less live recorded pid", async () => {
    const fx = identityDeclineFixture();
    try {
      const result = fx.run();
      assert.equal(result.status, 0, `serve-stop failed: ${result.stdout} ${result.stderr}`);
      assert.match(result.stdout, /declined to stop pid \d+/);
      assert.match(result.stdout, /KUSABI_WORKER_CONTEXT/);
      assert.ok(pidAlive(fx.stranger.pid), "a marker-less recorded pid must never be signalled");
      assert.ok(!fs.existsSync(fx.serverFile), "the invalid record must be removed by cmdServeStop");
    } finally {
      fx.cleanup();
    }
  });

  it("declines with the reason for a recorded stranger's thread TID (the incident shape)", async () => {
    const fx = identityDeclineFixture();
    // Re-point the record at a non-main thread of the stranger: the whole
    // process must survive the CLI invocation.
    const tidSleeper = path.join(fx.tmp, "tid-sleeper.mjs");
    fs.writeFileSync(tidSleeper, `import { Worker } from "node:worker_threads";
import fs from "node:fs";
const tidFile = process.env.KUSABI_TEST_TID_FILE;
const mainTid = Number(process.pid);
const worker = new Worker(
  "const { parentPort } = require('node:worker_threads'); setInterval(() => {}, 1000);",
  { eval: true }
);
worker.on("online", () => {
  const deadline = Date.now() + 5000;
  const poll = () => {
    let tids = [];
    try { tids = fs.readdirSync("/proc/self/task").map(Number); } catch { /* not ready yet */ }
    const workerTids = tids.filter((t) => t !== mainTid);
    if (workerTids.length > 0) {
      fs.writeFileSync(tidFile, JSON.stringify({ mainPid: process.pid, mainTid, workerTids }));
      return;
    }
    if (Date.now() < deadline) setTimeout(poll, 25);
    else fs.writeFileSync(tidFile, JSON.stringify({ mainPid: process.pid, mainTid, workerTids: [] }));
  };
  poll();
});
setInterval(() => {}, 1000);
`, "utf8");
    const tidFile = path.join(fx.tmp, "tids.json");
    const env = { ...process.env, KUSABI_TEST_TID_FILE: tidFile };
    delete env.KUSABI_WORKER_CONTEXT;
    const threaded = spawn(process.execPath, [tidSleeper], { env, stdio: "ignore" });
    try {
      const deadline = Date.now() + 5000;
      let workerTid = null;
      while (Date.now() < deadline && workerTid === null) {
        try {
          const data = JSON.parse(fs.readFileSync(tidFile, "utf8"));
          workerTid = data.workerTids[0] ?? null;
        } catch { /* not written yet */ }
        if (workerTid === null) await new Promise((r) => setTimeout(r, 25));
      }
      assert.ok(workerTid !== null, "threaded stranger never reported a worker TID");
      fs.writeFileSync(fx.serverFile, JSON.stringify({ pid: workerTid, port: 0, password: "x", cwd: fx.cwd }), "utf8");
      const result = fx.run();
      assert.equal(result.status, 0, `serve-stop failed: ${result.stdout} ${result.stderr}`);
      assert.match(result.stdout, /declined to stop pid \d+/);
      assert.ok(pidAlive(threaded.pid), "the whole process must survive the CLI invocation");
      assert.ok(!fs.existsSync(fx.serverFile), "the invalid record must be removed by cmdServeStop");
    } finally {
      try { process.kill(threaded.pid, "SIGKILL"); } catch { /* already gone */ }
      fx.cleanup();
    }
  });
});

// chain finally — fossil `running` records must not block the chain's serve
// stop (kusabi #175).  The chain driver's finally block stops the serve for
// the cwd unless another GENUINELY running job exists, using the same
// staleness rule as serve-stop: a fossil record (last activity older than
// RUNNING_STALE_MS) must not pin the serve.  The driver runs in-process with
// a fake dispatch/callTool; the recorded serve is a fake long-lived process.
// ---------------------------------------------------------------------------

describe("chain finally serve-stop fossil guard", () => {
  const BRIEF = "Implement X.\n\n## Deliverables\n- src/foo.js\n";

  // Accept at round 1: implement completes, review approves, probes are green
  // (P1/P2/P3/P4 all pass against the fake callTool below).
  function makeDispatch() {
    return async (opts) => {
      if (opts.kind === "review") {
        return {
          job: {
            id: "job-rev-1", status: "completed", modelEntry: "fake/review", modelVariant: null,
            fallbacks: null, sessionID: "sess-rev",
            usage: { available: true, input: 2, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            error: null,
          },
          resultText: JSON.stringify({ verdict: "approve", findings: [], summary: "ok" }),
        };
      }
      if (opts.kind === "task") {
        return {
          job: {
            id: "job-imp-1", status: "completed", modelEntry: "fake/model", modelVariant: null,
            fallbacks: null, sessionID: "sess-imp-1",
            usage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            error: null,
          },
          resultText: "implemented",
        };
      }
      throw new Error("unexpected dispatch kind: " + opts.kind);
    };
  }

  function makeCallTool() {
    return async (toolName, params) => {
      if (toolName === "verify_in_container") return { gate_passed: true };
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands[0];
      if (cmd.startsWith("cd /workspace &&") && cmd.includes("TMPIDX=")) return { output: "ERROR_NO_INDEX\n" };
      if (cmd === "git rev-parse HEAD") return { output: "abc123\n" };
      if (cmd === "git status --porcelain") return { output: " M src/foo.js\n" };
      if (cmd === "git log --oneline -5") return { output: "abc123 latest change\n" };
      if (cmd === "git diff") return { output: "diff --git a/src/foo.js b/src/foo.js\n" };
      if (cmd === "git ls-files --others --exclude-standard") return { output: "untracked.txt\n" };
      return { output: "" };
    };
  }

  // State dir is resolved from cwd the same way the finally block's
  // cmdServeStop(cwd) resolves it (KUSABI_STATE_DIR + sha256 hash), so the
  // planted server.json / job record are exactly what the guard sees.
  function chainFinallyFixture({ jobAgeMs }) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-chainstop-"));
    const cwd = path.join(tmp, "ws");
    fs.mkdirSync(cwd, { recursive: true });
    const prevStateEnv = process.env.KUSABI_STATE_DIR;
    process.env.KUSABI_STATE_DIR = path.join(tmp, "state");
    const stateDir = stateDirFor(cwd);
    const serverFile = path.join(stateDir, "server.json");
    const sleeper = spawnServeShapedSleeper(stateDir);
    fs.writeFileSync(serverFile, JSON.stringify({ pid: sleeper.pid, port: 0, password: "x", cwd }), "utf8");

    // A non-chain job record: fossil (jobAgeMs old) or genuinely running.
    if (jobAgeMs !== null) {
      const jobsDir = path.join(stateDir, "jobs", "job-other");
      fs.mkdirSync(jobsDir, { recursive: true });
      const job = {
        id: "job-other",
        status: "running",
        startedAt: new Date(Date.now() - jobAgeMs).toISOString(),
        stats: { lastActivity: new Date(Date.now() - jobAgeMs).toISOString() },
      };
      fs.writeFileSync(path.join(jobsDir, "job.json"), JSON.stringify(job), "utf8");
    }

    const chainDir = path.join(stateDir, "chains", "chain-test");
    fs.mkdirSync(chainDir, { recursive: true });
    writeChainControl(chainDir, {
      chainId: "chain-test", container: "cid-1", pid: process.pid,
      status: "running", round: 0, startedAt: new Date().toISOString(),
    });

    function run() {
      return runChainDriver({
        cwd, stateDir, chainDir, chainId: "chain-test", container: "cid-1",
        model: "fake/model", modelChain: [["fake/model"]], maxRounds: 1,
        brief: BRIEF, orchestrator: null, baseSha: "abc123", worktreeBaseline: null,
        callTool: makeCallTool(), dispatchWithFallback: makeDispatch(),
        keepServe: false, signalReceived: () => false, resume: null,
      });
    }

    return {
      tmp, cwd, stateDir, chainDir, serverFile, sleeper, run,
      cleanup() {
        if (prevStateEnv === undefined) delete process.env.KUSABI_STATE_DIR;
        else process.env.KUSABI_STATE_DIR = prevStateEnv;
        try { process.kill(sleeper.pid, "SIGKILL"); } catch { /* already gone */ }
        fs.rmSync(tmp, { recursive: true, force: true });
      },
    };
  }

  function pidAlive(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  async function waitPidDead(pid, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!pidAlive(pid)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
  }

  it("stops the serve on completion when the only running record is a fossil", async () => {
    const fx = chainFinallyFixture({ jobAgeMs: 7 * 24 * 3600 * 1000 });
    try {
      const text = await fx.run();
      assert.match(text, /accepted at round 1/);
      // The finally block stopped the serve despite the fossil job record.
      await waitPidDead(fx.sleeper.pid);
      assert.ok(!fs.existsSync(fx.serverFile), "server.json must be removed by the chain finally stop");
      const control = readChainControl(fx.chainDir);
      assert.equal(control.status, "completed");
    } finally {
      fx.cleanup();
    }
  });

  it("keeps the serve alive on completion when a genuinely running job exists", async () => {
    const fx = chainFinallyFixture({ jobAgeMs: 3600 * 1000 });
    try {
      const text = await fx.run();
      assert.match(text, /accepted at round 1/);
      // The finally guard must still see the fresh running record and skip
      // the serve stop, exactly as before the fossil fix.
      assert.ok(pidAlive(fx.sleeper.pid), "the serve must survive while a live job is running");
      assert.ok(fs.existsSync(fx.serverFile), "server.json must survive while a live job is running");
      const control = readChainControl(fx.chainDir);
      assert.equal(control.status, "completed");
    } finally {
      fx.cleanup();
    }
  });
});

// install-agents: skills distribution
// ---------------------------------------------------------------------------
// kusabi ships opencode Agent Skills under opencode-skills/; install-agents
// copies them (whole directory, own name) to OPENCODE_SKILL_DIR — copy and
// overwrite only, never delete (the destination is shared with user-installed
// skills and there is no kusabi-owned name registry to make deletion safe).

/** Parse the YAML frontmatter of a SKILL.md into { name, description }. */
function parseSkillFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, "SKILL.md must start with a YAML frontmatter block");
  const yaml = m[1];
  const name = yaml.match(/^name:\s*(.+?)\s*$/m)?.[1]?.replace(/^["']|["']$/g, "");
  const description = yaml.match(/^description:\s*(.+?)\s*$/m)?.[1]?.replace(/^["']|["']$/g, "");
  return { name, description };
}

/**
 * Parse the permission: block of an agent definition into a nested map
 * (2-space tool entries, 4-space pattern -> action entries under a tool).
 * Returns e.g. { "*": "deny", "skill": { "kusabi-*": "allow" } }.
 */
function parsePermissionBlock(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, "agent definition must start with a YAML frontmatter block");
  const permission = {};
  let inPermission = false;
  let nestedKey = null;
  for (const line of m[1].split("\n")) {
    const indent = line.match(/^\s*/)[0].length;
    const text = line.trim();
    if (!text) continue;
    if (!inPermission) {
      inPermission = text === "permission:";
      continue;
    }
    if (indent === 0) break; // left the permission block
    const entry = text.match(/^(.+?):\s*(.*)$/);
    if (!entry) continue;
    const key = entry[1].replace(/^["']|["']$/g, "").trim();
    const value = entry[2].trim().replace(/^["']|["']$/g, "");
    if (indent === 2) {
      nestedKey = value === "" ? key : null;
      permission[key] = value === "" ? {} : value;
    } else if (indent === 4 && nestedKey) {
      permission[nestedKey][key] = value;
    }
  }
  return permission;
}

describe("install-agents skills distribution", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");
  const SKILLS_SRC = path.resolve(import.meta.dirname, "..", "opencode-skills");

  function runInstallAgents(env) {
    return spawnSync(process.execPath, [COMPANION_SCRIPT, "install-agents"], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: 10_000,
    });
  }

  function expectedSkillCount() {
    return fs.readdirSync(SKILLS_SRC, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  }

  it("installs both agents and skills, honouring OPENCODE_SKILL_DIR", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-install-agent-"));
    const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-install-skill-"));
    try {
      const result = runInstallAgents({ OPENCODE_AGENT_DIR: agentDir, OPENCODE_SKILL_DIR: skillDir });
      assert.equal(result.status, 0, result.stdout + result.stderr);

      // Agents still land in OPENCODE_AGENT_DIR ...
      const agentFile = path.join(agentDir, "kusabi-implement.md");
      assert.ok(fs.existsSync(agentFile), `agent not installed: ${agentFile}`);

      // ... and the skill lands whole (own directory name) in OPENCODE_SKILL_DIR.
      const installed = path.join(skillDir, "kusabi-rust-cross-target-checks", "SKILL.md");
      assert.ok(fs.existsSync(installed), `skill not installed: ${installed}`);
      assert.match(fs.readFileSync(installed, "utf8"), /^name: kusabi-rust-cross-target-checks$/m);

      // Success message reports skill count and destination alongside agent counts.
      const expected = expectedSkillCount();
      assert.match(result.stdout, /installed \d+ phase agents to .*\(removed \d+ stale legacy names\)/);
      assert.ok(result.stdout.includes(`installed ${expected} skills to ${skillDir}`), result.stdout);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
      fs.rmSync(skillDir, { recursive: true, force: true });
    }
  });

  it("leaves pre-existing unrelated content at the destination untouched", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-install-agent-"));
    const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-install-skill-"));
    try {
      // Content a user installed themselves — a custom skill dir and a loose file.
      const userSkillDir = path.join(skillDir, "user-custom-skill");
      fs.mkdirSync(userSkillDir, { recursive: true });
      fs.writeFileSync(path.join(userSkillDir, "SKILL.md"), "# user's own skill\n");
      const looseFile = path.join(skillDir, "notes.txt");
      fs.writeFileSync(looseFile, "keep me\n");

      const result = runInstallAgents({ OPENCODE_AGENT_DIR: agentDir, OPENCODE_SKILL_DIR: skillDir });
      assert.equal(result.status, 0, result.stdout + result.stderr);

      assert.equal(fs.readFileSync(path.join(userSkillDir, "SKILL.md"), "utf8"), "# user's own skill\n");
      assert.equal(fs.readFileSync(looseFile, "utf8"), "keep me\n");
      // The kusabi skill was still installed alongside them.
      assert.ok(fs.existsSync(path.join(skillDir, "kusabi-rust-cross-target-checks", "SKILL.md")));
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
      fs.rmSync(skillDir, { recursive: true, force: true });
    }
  });

  it("skips a skill whose destination name is blocked by a file, leaving it untouched", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-install-agent-"));
    const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-install-skill-"));
    try {
      // A user file squatting on the skill's directory name (no-delete rule:
      // the destination is user-controlled, so the install must not crash on
      // it — skip with a warning and leave it alone).
      const blocker = path.join(skillDir, "kusabi-rust-cross-target-checks");
      fs.writeFileSync(blocker, "user file in the way\n");

      const result = runInstallAgents({ OPENCODE_AGENT_DIR: agentDir, OPENCODE_SKILL_DIR: skillDir });
      assert.equal(result.status, 0, result.stdout + result.stderr);

      // Collision left untouched; agents and the rest of the install still done.
      assert.equal(fs.readFileSync(blocker, "utf8"), "user file in the way\n");
      assert.ok(fs.existsSync(path.join(agentDir, "kusabi-implement.md")), "agents must still be installed");
      // The warning names the skipped skill and the reason.
      assert.match(result.stdout, /skipped 1 skill\(s\): kusabi-rust-cross-target-checks/);
      assert.match(result.stdout, /not a directory/);
      // The reported count is the successfully installed number.
      assert.ok(result.stdout.includes(`installed ${expectedSkillCount() - 1} skills to`), result.stdout);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
      fs.rmSync(skillDir, { recursive: true, force: true });
    }
  });

  it("fails before any mutation when the skills destination root is a file", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-install-agent-"));
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-install-skillparent-"));
    const skillDirFile = path.join(parentDir, "skill-dest");
    fs.writeFileSync(skillDirFile, "not a directory\n");
    try {
      const result = runInstallAgents({ OPENCODE_AGENT_DIR: agentDir, OPENCODE_SKILL_DIR: skillDirFile });
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /is not a usable directory \(not-a-directory\)/);
      // Preflight runs before the agent copy: nothing was written anywhere.
      assert.deepEqual(fs.readdirSync(agentDir), [], "no mutation before the failure");
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
      fs.rmSync(parentDir, { recursive: true, force: true });
    }
  });

  // A dangling symlink is the case a plain statSync gets wrong: stat throws, so
  // the path reads as "absent" and the failure moves to the mkdirSync further
  // down -- after the agents were already copied. The preflight must classify
  // it from lstat and refuse before touching anything.
  it("fails before any mutation when the skills destination is a broken symlink", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-install-agent-"));
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-install-skillparent-"));
    const skillDirLink = path.join(parentDir, "skill-dest");
    fs.symlinkSync(path.join(parentDir, "no-such-target"), skillDirLink);
    try {
      const result = runInstallAgents({ OPENCODE_AGENT_DIR: agentDir, OPENCODE_SKILL_DIR: skillDirLink });
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /is not a usable directory \(broken-symlink\)/);
      assert.deepEqual(fs.readdirSync(agentDir), [], "no mutation before the failure");
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
      fs.rmSync(parentDir, { recursive: true, force: true });
    }
  });

  // The defaults must land inside opencode's own config dir, which is
  // relocatable via XDG_CONFIG_HOME. Hardcoding ~/.config would put the files
  // outside opencode's scan on a relocated host -- installed but never found.
  it("defaults to opencode's config dir and follows XDG_CONFIG_HOME", () => {
    const xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-install-xdg-"));
    try {
      const result = runInstallAgents({
        XDG_CONFIG_HOME: xdgDir,
        OPENCODE_AGENT_DIR: "",
        OPENCODE_SKILL_DIR: "",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(
        fs.existsSync(path.join(xdgDir, "opencode", "agent", "kusabi-implement.md")),
        "agents land under $XDG_CONFIG_HOME/opencode/agent",
      );
      for (const d of fs.readdirSync(SKILLS_SRC, { withFileTypes: true }).filter((e) => e.isDirectory())) {
        assert.ok(
          fs.existsSync(path.join(xdgDir, "opencode", "skills", d.name, "SKILL.md")),
          `skill ${d.name} lands under $XDG_CONFIG_HOME/opencode/skills`,
        );
      }
    } finally {
      fs.rmSync(xdgDir, { recursive: true, force: true });
    }
  });

  it("every skill directory has a SKILL.md whose name matches its directory and a non-empty description", () => {
    const dirs = fs.readdirSync(SKILLS_SRC, { withFileTypes: true }).filter((e) => e.isDirectory());
    assert.ok(dirs.length > 0, `no skill directories found under ${SKILLS_SRC}`);
    for (const d of dirs) {
      const skillFile = path.join(SKILLS_SRC, d.name, "SKILL.md");
      assert.ok(fs.existsSync(skillFile), `missing SKILL.md in ${path.join(SKILLS_SRC, d.name)}`);
      const fm = parseSkillFrontmatter(fs.readFileSync(skillFile, "utf8"));
      assert.equal(fm.name, d.name, `frontmatter name in ${skillFile} must equal its directory name`);
      assert.ok(fm.description && fm.description.length > 0, `non-empty description required in ${skillFile}`);
    }
  });

  it("skills never grant tools — no permission: key under opencode-skills", () => {
    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(SKILLS_SRC);
    assert.ok(files.length > 0, `no files under ${SKILLS_SRC}`);
    for (const f of files) {
      const content = fs.readFileSync(f, "utf8");
      assert.ok(
        !/^\s*permission\s*:/m.test(content),
        `a skill is a document, not a tool grant — permission: key must not appear (${f})`,
      );
    }
  });

  it("kusabi-implement still denies all first and grants only kusabi-* skills", () => {
    const file = path.resolve(import.meta.dirname, "..", "opencode-agents", "kusabi-implement.md");
    const permission = parsePermissionBlock(fs.readFileSync(file, "utf8"));
    const entries = Object.entries(permission);
    assert.equal(entries[0][0], "*");
    assert.equal(entries[0][1], "deny");
    assert.deepEqual(permission.skill, { "kusabi-*": "allow" });
  });
});

// ---------------------------------------------------------------------------
// buildTaskReviewInput — `task --phase review --container` gets an input (#204)
// ---------------------------------------------------------------------------
// The task path built no review input at all: the reviewer was told the diff
// was inlined, found none, and rebuilt the change by hand.  This is the seam
// cmdTask calls, so it is where the behaviour is pinned — including the two
// dispatches that must be untouched (another phase, and review without a
// container) and the --base decision.
//
// The input no longer inlines the diff body (kusabi #208): what --base selects
// is the base commit the input names as the ref to fetch against, so that is
// what these assert instead of a captured `git diff <ref>`.

describe("buildTaskReviewInput", () => {
  function containerTool(overrides = {}) {
    const commands = [];
    const callTool = async (tool, params) => {
      const cmd = params.commands?.[0] ?? "";
      commands.push(cmd);
      if (Object.prototype.hasOwnProperty.call(overrides, cmd)) return { output: overrides[cmd] };
      if (cmd === "git rev-parse HEAD") return { output: "deadbeefcafe\n" };
      if (cmd === "git status --porcelain") return { output: " M src/foo.js\n" };
      if (cmd === "git log --oneline -5") return { output: "deadbee latest\n" };
      if (cmd.startsWith("git rev-parse --verify")) return { output: "c355fa61a7fee5402ed7ba999bd2fe2eeb46a842\n" };
      return { output: "" };
    };
    return { commands, callTool };
  }

  it("builds the container review input for --phase review --container", async () => {
    const { commands, callTool } = containerTool();
    const input = await buildTaskReviewInput({
      phase: "review",
      flags: { container: "cid123" },
      callTool,
    });
    assert.ok(input, "a container review must carry a review input");
    assert.ok(input.includes("## Review target"));
    assert.ok(input.includes("container `cid123`"));
    assert.ok(input.includes("`diff_in_container`"));
    assert.ok(input.includes("### Base change-set context (machine-recorded)"));
    // Content, not length: the base and the fetch instruction must be there,
    // and the diff body must not.
    assert.ok(input.includes("- Base commit: `deadbeefcafe`"));
    assert.ok(input.includes("Fetching the diff is YOUR job"));
    assert.ok(!input.includes("diff --git"));
    assert.ok(
      !commands.some((c) => c.startsWith("git diff")),
      `no git diff may be captured, got: ${JSON.stringify(commands)}`,
    );
  });

  it("reflects --base in the input it builds", async () => {
    const { commands, callTool } = containerTool();
    const input = await buildTaskReviewInput({
      phase: "review",
      flags: { container: "cid123", base: "c355fa6" },
      callTool,
    });
    assert.ok(commands.some((c) => c.startsWith("git rev-parse --verify --quiet 'c355fa6^{commit}'")));
    assert.ok(input.includes("- Base commit: `c355fa61a7fee5402ed7ba999bd2fe2eeb46a842`"));
    assert.ok(input.includes("`base` set to `c355fa61a7fee5402ed7ba999bd2fe2eeb46a842`"));
    assert.ok(!commands.some((c) => c.startsWith("git diff")));
  });

  it("rejects --base loudly when it cannot take effect (implement phase)", async () => {
    const { commands, callTool } = containerTool();
    await assert.rejects(
      () => buildTaskReviewInput({ phase: "implement", flags: { container: "cid123", base: "c355fa6" }, callTool }),
      /task --base applies only to a container review/,
    );
    // Nothing was read from the container: the flag is refused, not half-honoured.
    assert.deepEqual(commands, []);
  });

  it("rejects --base loudly for a review without a container", async () => {
    const { callTool } = containerTool();
    await assert.rejects(
      () => buildTaskReviewInput({ phase: "review", flags: { base: "c355fa6" }, callTool }),
      /task --base applies only to a container review/,
    );
  });

  it("rejects a --base that does not resolve in the container", async () => {
    const { callTool } = containerTool({ "git rev-parse --verify --quiet 'nosuchref^{commit}' || echo __KUSABI_BASE_UNRESOLVED__": "__KUSABI_BASE_UNRESOLVED__\n" });
    await assert.rejects(
      () => buildTaskReviewInput({ phase: "review", flags: { container: "cid123", base: "nosuchref" }, callTool }),
      /--base nosuchref is not a valid revision in container cid123/,
    );
  });

  it("leaves --phase implement --container exactly as it was (no review input)", async () => {
    const { commands, callTool } = containerTool();
    const input = await buildTaskReviewInput({
      phase: "implement",
      flags: { container: "cid123" },
      callTool,
    });
    assert.equal(input, null);
    assert.deepEqual(commands, [], "a non-review phase must not read the container here");
  });

  it("leaves review without --container exactly as it was (no review input)", async () => {
    const { commands, callTool } = containerTool();
    const input = await buildTaskReviewInput({ phase: "review", flags: {}, callTool });
    assert.equal(input, null);
    assert.deepEqual(commands, []);
  });

  it("returns null for a task with no phase at all", async () => {
    const { callTool } = containerTool();
    assert.equal(await buildTaskReviewInput({ phase: null, flags: { container: "cid123" }, callTool }), null);
  });

  it("is what cmdTask appends to the task prompt (source guard)", async () => {
    // cmdTask is not exported; this pins the wiring — the review input is
    // built before dispatch and concatenated onto the prompt that is sent.
    const source = fs.readFileSync(path.join(import.meta.dirname, "kusabi-companion.mjs"), "utf8");
    const cmdTaskSource = source.slice(source.indexOf("async function cmdTask("), source.indexOf("async function cmdReview("));
    assert.ok(cmdTaskSource.includes("await buildTaskReviewInput({ phase, flags })"));
    assert.ok(cmdTaskSource.includes("promptText: taskPromptText"));
    assert.ok(cmdTaskSource.includes("${taskReviewInput}"));
  });
});


// install-cli: PATH-independent companion shim
// ---------------------------------------------------------------------------
// Path resolution lives in the CLI itself (import.meta.url). Commands invoke
// `kusabi-companion <sub>` once the shim is on PATH. Tests inject
// KUSABI_BIN_DIR / HOME so they never touch the real ~/.local/bin.

describe("install-cli shim", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");
  let tmpHome;
  let binDir;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-install-cli-home-"));
    binDir = path.join(tmpHome, "bin");
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function run(args, extraEnv = {}) {
    const env = {
      ...process.env,
      HOME: tmpHome,
      KUSABI_BIN_DIR: binDir,
      OPENCODE_BIN: "/nonexistent-opencode-bin",
      ...extraEnv,
    };
    if (Object.prototype.hasOwnProperty.call(extraEnv, "KUSABI_BIN_DIR") && extraEnv.KUSABI_BIN_DIR === undefined) {
      delete env.KUSABI_BIN_DIR;
    }
    return spawnSync(process.execPath, [COMPANION_SCRIPT, ...args], {
      encoding: "utf8",
      env,
      timeout: 10_000,
    });
  }

  function expectedShim(target = COMPANION_SCRIPT) {
    return `#!/bin/sh\nexec node ${JSON.stringify(target)} "$@"\n`;
  }

  it("--help lists install-cli", () => {
    const result = run(["--help"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^ {2}install-cli  /m);
  });

  it("creates a 0755 shim under KUSABI_BIN_DIR (created)", () => {
    const result = run(["install-cli"]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const shim = path.join(binDir, "kusabi-companion");
    assert.match(result.stdout, /^created: /m);
    assert.ok(result.stdout.includes(shim), result.stdout);
    assert.equal(fs.readFileSync(shim, "utf8"), expectedShim());
    assert.equal(fs.statSync(shim).mode & 0o777, 0o755);
    const execLine = fs.readFileSync(shim, "utf8").split("\n").find((l) => l.startsWith("exec node "));
    assert.equal(execLine, `exec node ${JSON.stringify(COMPANION_SCRIPT)} "$@"`);
    assert.ok(path.isAbsolute(JSON.parse(execLine.match(/^exec node (.+) "\$@"$/)[1])));
  });

  it("is a no-op when the shim already matches (current)", () => {
    const first = run(["install-cli"]);
    assert.match(first.stdout, /^created: /m);
    const shim = path.join(binDir, "kusabi-companion");
    const before = fs.readFileSync(shim, "utf8");
    const mtime = fs.statSync(shim).mtimeMs;
    const second = run(["install-cli"]);
    assert.equal(second.status, 0, second.stderr + second.stdout);
    assert.match(second.stdout, /^current: /m);
    assert.equal(fs.readFileSync(shim, "utf8"), before);
    assert.equal(fs.statSync(shim).mtimeMs, mtime);
  });

  it("overwrites a shim that points elsewhere (updated)", () => {
    fs.mkdirSync(binDir, { recursive: true });
    const shim = path.join(binDir, "kusabi-companion");
    const other = "/tmp/other-kusabi-companion.mjs";
    fs.writeFileSync(shim, expectedShim(other), { mode: 0o755 });
    const result = run(["install-cli"]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /^updated: /m);
    assert.equal(fs.readFileSync(shim, "utf8"), expectedShim());
    assert.ok(!fs.readFileSync(shim, "utf8").includes(other));
  });

  it("creates the destination directory when it does not exist", () => {
    const nested = path.join(tmpHome, "nested", "bin");
    const result = run(["install-cli"], { KUSABI_BIN_DIR: nested });
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /^created: /m);
    assert.ok(fs.existsSync(path.join(nested, "kusabi-companion")));
  });

  it("defaults to ~/.local/bin when KUSABI_BIN_DIR is unset", () => {
    const result = run(["install-cli"], { KUSABI_BIN_DIR: undefined });
    assert.equal(result.status, 0, result.stdout);
    const shim = path.join(tmpHome, ".local", "bin", "kusabi-companion");
    assert.match(result.stdout, /^created: /m);
    assert.ok(result.stdout.includes(shim), result.stdout);
    assert.equal(fs.readFileSync(shim, "utf8"), expectedShim());
  });

  it("warns when the destination is not on PATH", () => {
    const result = run(["install-cli"], { PATH: "/usr/bin" });
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /warning: .* is not on PATH/);
    assert.ok(result.stdout.includes(binDir), result.stdout);
  });

  it("does not warn when the destination is on PATH", () => {
    const result = run(["install-cli"], { PATH: `${binDir}${path.delimiter}/usr/bin` });
    assert.equal(result.status, 0, result.stdout);
    assert.doesNotMatch(result.stdout, /warning: .* is not on PATH/);
  });

  it("shim --help matches node companion --help and forwards exit codes", () => {
    const installed = run(["install-cli"], { PATH: `${binDir}${path.delimiter}${process.env.PATH}` });
    assert.equal(installed.status, 0, installed.stdout);
    const shim = path.join(binDir, "kusabi-companion");
    const viaShim = spawnSync(shim, ["--help"], { encoding: "utf8", timeout: 10_000 });
    const viaNode = spawnSync(process.execPath, [COMPANION_SCRIPT, "--help"], { encoding: "utf8", timeout: 10_000 });
    assert.equal(viaShim.status, 0);
    assert.equal(viaShim.stdout, viaNode.stdout);
    const shimUnknown = spawnSync(shim, ["not-a-subcommand"], { encoding: "utf8", timeout: 10_000 });
    const nodeUnknown = spawnSync(process.execPath, [COMPANION_SCRIPT, "not-a-subcommand"], { encoding: "utf8", timeout: 10_000 });
    assert.equal(shimUnknown.status, nodeUnknown.status);
    assert.equal(shimUnknown.stdout, nodeUnknown.stdout);
    assert.notEqual(shimUnknown.status, 0);
  });
});

describe("setup companion-shim diagnosis", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");
  let tmpHome;
  let binDir;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-setup-shim-home-"));
    binDir = path.join(tmpHome, "bin");
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function run(args, extraEnv = {}) {
    return spawnSync(process.execPath, [COMPANION_SCRIPT, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: tmpHome,
        KUSABI_BIN_DIR: binDir,
        OPENCODE_BIN: "/nonexistent-opencode-bin",
        ...extraEnv,
      },
      timeout: 10_000,
    });
  }

  it("reports missing and still exits 0, prompting install-cli", () => {
    const result = run(["setup"]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /companion shim: missing/);
    assert.match(result.stdout, /kusabi-companion install-cli/);
    assert.match(result.stdout, /opencode CLI not found/);
  });

  it("reports ok after install-cli", () => {
    const installed = run(["install-cli"]);
    assert.equal(installed.status, 0, installed.stdout);
    const result = run(["setup"]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /companion shim: ok \(/);
    assert.doesNotMatch(result.stdout, /companion shim: missing/);
    assert.doesNotMatch(result.stdout, /companion shim: stale/);
  });

  it("reports stale when the shim points at another path, without failing", () => {
    fs.mkdirSync(binDir, { recursive: true });
    const other = "/tmp/other-kusabi-companion.mjs";
    fs.writeFileSync(
      path.join(binDir, "kusabi-companion"),
      `#!/bin/sh\nexec node ${JSON.stringify(other)} "$@"\n`,
      { mode: 0o755 },
    );
    const result = run(["setup"]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /companion shim: stale/);
    assert.ok(result.stdout.includes(other), result.stdout);
    assert.match(result.stdout, /kusabi-companion install-cli/);
  });

  it("cmdSetup appends the shim diagnosis (source guard)", () => {
    const source = fs.readFileSync(COMPANION_SCRIPT, "utf8");
    const cmdSetupSource = source.slice(source.indexOf("async function cmdSetup("), source.indexOf("async function cmdTask("));
    assert.ok(cmdSetupSource.includes("formatShimSetupLine"));
    assert.ok(cmdSetupSource.includes("shimLine"));
  });
});

// flushAndExit — piped stdout must survive process.exit (kusabi #243).
// Truncation only reproduces when the consumer is slower than the writer:
// a delayed pipe (`pause` then `resume` after 1s), not a file redirect.
// ---------------------------------------------------------------------------

describe("flushAndExit (kusabi #243)", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");
  const LARGE = 150_000;

  function spawnFlushChild({ bytes, exitCode, leftoverTimer = false }) {
    const lines = [`import { flushAndExit } from ${JSON.stringify(COMPANION_SCRIPT)};`];
    if (leftoverTimer) lines.push("setInterval(() => {}, 60_000);");
    if (bytes > 0) lines.push(`process.stdout.write("x".repeat(${bytes}));`);
    lines.push(`flushAndExit(${exitCode});`);
    return spawn(process.execPath, ["--input-type=module", "-e", lines.join("\n")], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  function collectDelayedPipe(child, { delayMs = 1000, timeoutMs = 15_000 } = {}) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let stderr = "";
      let code = null;
      let signal = null;
      let stdoutEnded = false;
      let closed = false;
      let reading = false;

      const tryResolve = () => {
        if (!closed || !stdoutEnded) return;
        clearTimeout(timer);
        resolve({ code, signal, stdout: Buffer.concat(chunks), stderr });
      };

      const beginRead = () => {
        if (reading) return;
        reading = true;
        clearTimeout(startRead);
        child.stdout.on("data", (c) => { chunks.push(c); });
        child.stdout.on("end", () => { stdoutEnded = true; tryResolve(); });
        child.stdout.resume();
      };

      child.stderr.on("data", (c) => { stderr += c; });
      child.stdout.pause();
      const startRead = setTimeout(beginRead, delayMs);

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`timed out after ${timeoutMs}ms; got ${Buffer.concat(chunks).length} bytes; stderr=${stderr}`));
      }, timeoutMs);

      child.on("error", (err) => {
        clearTimeout(timer);
        clearTimeout(startRead);
        reject(err);
      });
      child.on("close", (c, s) => {
        code = c;
        signal = s;
        closed = true;
        beginRead();
        tryResolve();
      });
    });
  }

  it("delivers 150KiB through a delayed pipe and exits 0", async () => {
    const child = spawnFlushChild({ bytes: LARGE, exitCode: 0 });
    const result = await collectDelayedPipe(child);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.length, LARGE);
    assert.equal(result.stdout.toString("utf8"), "x".repeat(LARGE));
  });

  it("preserves a non-zero exit code after draining a large pipe", async () => {
    const child = spawnFlushChild({ bytes: LARGE, exitCode: 7 });
    const result = await collectDelayedPipe(child);
    assert.equal(result.code, 7, result.stderr);
    assert.equal(result.stdout.length, LARGE);
  });

  it("exits even when a leftover timer handle remains", async () => {
    const child = spawnFlushChild({ bytes: 0, exitCode: 0, leftoverTimer: true });
    const result = await collectDelayedPipe(child, { delayMs: 0, timeoutMs: 5_000 });
    assert.equal(result.code, 0, result.stderr);
  });

  it("companion --help still exits 0", () => {
    const result = spawnSync(process.execPath, [COMPANION_SCRIPT, "--help"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /Usage: kusabi-companion/);
  });

  it("companion unknown subcommand still exits 1", () => {
    const result = spawnSync(process.execPath, [COMPANION_SCRIPT, "definitely-not-a-subcommand"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.match(result.stdout, /kusabi-companion error: unknown subcommand/);
  });

  it("CLI entry drains via flushAndExit rather than a bare process.exit", () => {
    const source = fs.readFileSync(COMPANION_SCRIPT, "utf8");
    const cli = source.slice(source.indexOf("if (process.argv[1] === fileURLToPath"));
    assert.match(cli, /flushAndExit\(exitCode\)/);
    assert.match(cli, /flushAndExit\(1\)/);
    assert.equal([...cli.matchAll(/process\.exit\(/g)].length, 0);
  });
});
