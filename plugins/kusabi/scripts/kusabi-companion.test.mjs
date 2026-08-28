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
  resolveResumeLastSession,
  buildTaskReviewInput,
  resolveOrchestratorRecord,
  ORCH_SESSION_ENV,
  briefLintReport,
  cmdChainDetach,
  extractChainAndWaitArgs,
} from "./kusabi-companion.mjs";
// The container header the chain injects into its implement prompt, and the
// builder that injects it: the #289 suite at the end of this file asserts the
// task path now sends the very same text (one wording, two paths).
import { withContainerWorkspace, buildImplementText } from "./chain-phases.mjs";
// Two suites below straddle the kusabi #264 PR 2/2 split and stayed here on
// purpose (see the banner above each): the chain-finally serve-stop guard,
// which shares the serve fixture of the two serve-stop suites around it, and
// the #250 smoke refusal, whose unit tests share their brief constants with
// CLI-through-the-binary tests.  Both reach the driver by import, never
// through a compatibility re-export from kusabi-companion.mjs.
import { runChainDriver, smokeViolationReport } from "./chain-driver.mjs";
import {
  parseOrchestratorSignature,
  parseFrozenTests,
  findFrozenQualifierItems,
} from "./brief-parsing.mjs";
import {
  readChainControl,
  writeChainControl,
} from "./chain-control.mjs";
import { writeJson, stateDirFor } from "./state-paths.mjs";

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
    // cmdTask is not exported; this pins the wiring.  cmdChain lives in
    // chain-driver.mjs since kusabi #264 PR 2/2, so its half of the guard
    // reads that file — the wiring being pinned is the same wiring.
    const source = fs.readFileSync(path.join(import.meta.dirname, "kusabi-companion.mjs"), "utf8");
    const driverSource = fs.readFileSync(path.join(import.meta.dirname, "chain-driver.mjs"), "utf8");
    const cmdTaskSource = source.slice(source.indexOf("async function cmdTask("), source.indexOf("async function cmdReview("));
    const cmdChainSource = driverSource.slice(driverSource.indexOf("async function cmdChain("));
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

  it("--help enumerates all four backends including cursor", () => {
    const result = runCompanion(["--help"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--backend opencode\|claude\|agy\|cursor/);
    assert.match(result.stdout, /cursor\/ prefix/);
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

  function quotaExhaustedChainJson() {
    return {
      ...validChainJson(),
      records: [{
        round: 1,
        implementJobId: "job-imp-1",
        reviewJobId: "job-rev-1",
        probesGreen: true,
        probeResults: [
          { probe: "P1: HEAD clean", passed: true, detail: "ok" },
          { probe: "P2: verify gate", passed: true, detail: "{}" },
          { probe: "P3: deliverables", passed: true, detail: "ok" },
          { probe: "P4: smoke", passed: true, detail: "ok" },
        ],
        verdict: "unparseable",
        reviewParseable: false,
        backend: "agy",
        reviewBackend: "agy",
        reviewJobError: "agy dispatch failed: Individual quota reached. Resets in 1h1m21s.",
        reviewJobFailure: {
          kind: "quota-exhaustion",
          backend: "agy",
          quota: "individual",
          backendBlocked: true,
          reset: "1h1m21s",
        },
        disposition: {
          disposition: "escalate",
          reason: "quota exhausted (agy individual pool); resets in 1h1m21s",
        },
      }],
    };
  }

  it("refuses a replacement seat when the recorded failure was quota exhaustion", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-resume-quota-"));
    try {
      const stateDir = hashedWorkspaceDir(path.join(tmp, "state"), tmp);
      makeChain(stateDir, "chain-quota", {
        control: {
          chainId: "chain-quota", container: "cid-1", pid: 0,
          status: "completed", round: 1, finishedAt: new Date().toISOString(),
        },
        chainJson: quotaExhaustedChainJson(),
      });
      const result = runResume(["chain-quota"], { stateDir: path.join(tmp, "state"), cwd: tmp });
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /quota exhaustion/);
      assert.match(result.stdout, /--backend opencode\|claude\|agy\|cursor/);
      assert.doesNotMatch(result.stdout, /does not support --backend/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses the same-backend replacement and lets an explicit different backend past the quota gate", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-resume-quota-route-"));
    try {
      const stateDir = hashedWorkspaceDir(path.join(tmp, "state"), tmp);
      makeChain(stateDir, "chain-quota", {
        control: {
          chainId: "chain-quota", container: "cid-1", pid: 0,
          status: "completed", round: 1, finishedAt: new Date().toISOString(),
        },
        chainJson: quotaExhaustedChainJson(),
      });
      const same = runResume(["--backend", "agy", "chain-quota"], {
        stateDir: path.join(tmp, "state"), cwd: tmp,
      });
      assert.notEqual(same.status, 0);
      assert.match(same.stdout, /quota exhaustion/);

      const reroute = runResume(["--backend", "cursor", "chain-quota"], {
        stateDir: path.join(tmp, "state"), cwd: tmp,
      });
      assert.notEqual(reroute.status, 0);
      assert.match(reroute.stdout, /not reachable/);
      assert.doesNotMatch(reroute.stdout, /quota exhaustion/);
      assert.doesNotMatch(reroute.stdout, /does not support --backend/);
    } finally {
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

// chain-cancel on a chain directory that never got a control record (kusabi
// #298): a dispatch killed before it wrote anything leaves a permanent empty
// dir that every later bare `chain-wait --next` would lock onto.  Healing is
// explicit — chain-cancel must succeed and persist a terminal record, so the
// workspace is healed without shell-deleting state dirs.  CLI subprocess, the
// same shape the user runs.
// ---------------------------------------------------------------------------

describe("chain-cancel heals a recordless chain dir (kusabi #298)", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");

  function fixture() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-chain-cancel-"));
    const stateRootDir = path.join(tmp, "state");
    const cwd = path.join(tmp, "ws");
    fs.mkdirSync(cwd, { recursive: true });
    const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12);
    const stateDir = path.join(stateRootDir, hash);
    fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
    const chainsDir = path.join(stateDir, "chains");
    fs.mkdirSync(chainsDir, { recursive: true });
    const env = { ...process.env, KUSABI_STATE_DIR: stateRootDir };
    delete env.KUSABI_WORKER_CONTEXT;
    return {
      tmp, cwd, chainsDir, env,
      run(args) {
        return spawnSync(process.execPath, [COMPANION_SCRIPT, ...args], {
          cwd, encoding: "utf8", env, timeout: 30_000,
        });
      },
    };
  }

  it("finalises a recordless dir to cancelled; the wait then resolves instantly and --next never selects it", () => {
    const fx = fixture();
    try {
      fs.mkdirSync(path.join(fx.chainsDir, "chain-debris"), { recursive: true });

      const cancel = fx.run(["chain-cancel", "chain-debris"]);
      assert.equal(cancel.status, 0, cancel.stdout + cancel.stderr);
      assert.match(cancel.stdout, /chain-debris had no control record/);
      assert.match(cancel.stdout, /finalised to cancelled/);

      // A terminal record was persisted — not just a message.
      const control = readChainControl(path.join(fx.chainsDir, "chain-debris"));
      assert.equal(control.status, "cancelled");
      assert.equal(control.chainId, "chain-debris");
      assert.equal(control.round, 0);

      // chain-wait on the healed id exits immediately with a terminal digest.
      const wait = fx.run(["chain-wait", "chain-debris"]);
      assert.equal(wait.status, 0, wait.stdout + wait.stderr);
      assert.match(wait.stdout, /chain chain-debris: status=cancelled disposition=none rounds=0/);

      // A bare --next must never select the cancelled dir: with nothing else
      // around it reports that nothing appeared instead of "completing" on
      // the debris.
      const next = fx.run(["chain-wait", "--next", "--appear-timeout", "1", "--poll-interval", "1"]);
      assert.equal(next.status, 1, next.stdout);
      assert.match(next.stdout, /no chain appeared within 1s/);
      assert.doesNotMatch(next.stdout, /chain-debris/);
    } finally {
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });
});

// chain finally — fossil `running` records must not block the chain's serve
// stop (kusabi #175).  The chain driver's finally block stops the serve for
// the cwd unless another GENUINELY running job exists, using the same
// staleness rule as serve-stop: a fossil record (last activity older than
// RUNNING_STALE_MS) must not pin the serve.  The driver runs in-process with
// a fake dispatch/callTool; the recorded serve is a fake long-lived process.
//
// Stayed here through the kusabi #264 PR 2/2 driver split: what it pins is the
// companion's own staleness rule (liveRunningJobs / cmdServeStop), and it
// shares spawnServeShapedSleeper with the two serve-stop suites above.  Moving
// it would have meant a second copy of that fixture; runChainDriver is
// imported from chain-driver.mjs instead.
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
          resultText: JSON.stringify({ schema_version: 1, verdict: "approve", findings: [], summary: "ok", next_steps: [] }),
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
      const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
      if (cmd.includes("change-scope.mjs")) {
        return {
          output: JSON.stringify({
            formatVersion: 1,
            repositoryRoot: "/workspace",
            input: { base: "abc123", head: "HEAD" },
            resolved: { baseSha: "abc123", headSha: "abc123", mergeBaseSha: "abc123" },
            paths: { committed: [], staged: [], unstaged: ["src/foo.js"], untracked: [] },
          }),
        };
      }
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

  it("kusabi-gofer still denies all first, allows run_python, and keeps the exit boundary closed (#216)", () => {
    const file = path.resolve(import.meta.dirname, "..", "opencode-agents", "kusabi-gofer.md");
    const permission = parsePermissionBlock(fs.readFileSync(file, "utf8"));
    const entries = Object.entries(permission);
    assert.equal(entries[0][0], "*");
    assert.equal(entries[0][1], "deny");
    assert.equal(permission.sunaba_run_python, "allow");
    // The exit-point boundary is out of scope for #216: no write, publish or
    // issue/PR tools may ever be granted here.
    for (const key of Object.keys(permission)) {
      assert.doesNotMatch(
        key,
        /publish|issue_write|pr_review_write|write_file|edit_file|transform_file|checkpoint_restore|sandbox_initialize/,
        `gofer must not be granted a write/exit tool: ${key}`,
      );
    }
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
      const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
      commands.push(cmd);
      if (cmd.includes("change-scope.mjs")) {
        const base = cmd.includes("c355fa61a7fee5402ed7ba999bd2fe2eeb46a842")
          ? "c355fa61a7fee5402ed7ba999bd2fe2eeb46a842"
          : "deadbeefcafe";
        return {
          output: JSON.stringify({
            formatVersion: 1,
            repositoryRoot: "/workspace",
            input: { base, head: "HEAD" },
            resolved: { baseSha: base, headSha: "deadbeefcafe", mergeBaseSha: base },
            paths: { committed: [], staged: [], unstaged: ["src/foo.js"], untracked: [] },
          }),
        };
      }
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

// install-cli: Cursor user-level skill discovery (kusabi #247)
// ---------------------------------------------------------------------------
// Cursor finds user skills at <cursorDir>/skills/<name>/SKILL.md and rules at
// <cursorDir>/rules/*.mdc -- neither comes from the plugin manifest, so a
// default `cursor-agent` launch sees nothing without this wiring. Tests point
// HOME and KUSABI_CURSOR_DIR at tmp dirs; the real ~/.cursor is never touched.

describe("install-cli cursor skill wiring", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");
  const PLUGIN_DIR = path.dirname(import.meta.dirname);
  const SKILLS = ["delegate", "kusabi-result-handling"];
  let tmpHome;
  let binDir;
  let cursorDir;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-install-cursor-home-"));
    binDir = path.join(tmpHome, "bin");
    cursorDir = path.join(tmpHome, "cursor");
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function run(args = [], extraEnv = {}) {
    const env = {
      ...process.env,
      HOME: tmpHome,
      KUSABI_BIN_DIR: binDir,
      KUSABI_CURSOR_DIR: cursorDir,
      OPENCODE_BIN: "/nonexistent-opencode-bin",
      ...extraEnv,
    };
    for (const key of Object.keys(extraEnv)) {
      if (extraEnv[key] === undefined) delete env[key];
    }
    return spawnSync(process.execPath, [COMPANION_SCRIPT, "install-cli", ...args], {
      encoding: "utf8",
      env,
      timeout: 10_000,
    });
  }

  // Paths land in the output verbatim; escape them before building a matcher.
  const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const skillSrc = (name) => path.join(PLUGIN_DIR, "skills", name);
  const skillLink = (name) => path.join(cursorDir, "skills", name);

  it("creates both skill symlinks and reports one line per artifact", () => {
    const result = run();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    for (const name of SKILLS) {
      const link = skillLink(name);
      assert.ok(fs.lstatSync(link).isSymbolicLink(), `${link} is not a symlink`);
      assert.equal(fs.realpathSync(link), fs.realpathSync(skillSrc(name)));
      assert.ok(fs.existsSync(path.join(link, "SKILL.md")), `${link}/SKILL.md not reachable`);
      assert.match(result.stdout, new RegExp(`^created: ${rx(link)} -> ${rx(skillSrc(name))}$`, "m"));
    }
  });

  it("reports current and changes nothing on a re-run (idempotent)", () => {
    assert.equal(run().status, 0);
    const before = SKILLS.map((name) => fs.readlinkSync(skillLink(name)));
    const second = run();
    assert.equal(second.status, 0, second.stderr + second.stdout);
    SKILLS.forEach((name, i) => {
      assert.match(second.stdout, new RegExp(`^current: ${rx(skillLink(name))} -> `, "m"));
      assert.equal(fs.readlinkSync(skillLink(name)), before[i]);
    });
    assert.doesNotMatch(second.stdout, /^(created|updated|conflict|error):/m);
  });

  it("wires ~/.cursor when it exists and KUSABI_CURSOR_DIR is unset", () => {
    const homeCursor = path.join(tmpHome, ".cursor");
    fs.mkdirSync(homeCursor, { recursive: true });
    const result = run([], { KUSABI_CURSOR_DIR: undefined });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    for (const name of SKILLS) {
      const link = path.join(homeCursor, "skills", name);
      assert.equal(fs.realpathSync(link), fs.realpathSync(skillSrc(name)));
      assert.match(result.stdout, new RegExp(`^created: ${rx(link)} -> `, "m"));
    }
  });

  it("skips with one informational line when there is no cursor directory", () => {
    const result = run([], { KUSABI_CURSOR_DIR: undefined });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const skips = result.stdout.split("\n").filter((l) => l.startsWith("cursor skills: skipped"));
    assert.equal(skips.length, 1, result.stdout);
    assert.ok(skips[0].includes(path.join(tmpHome, ".cursor")), skips[0]);
    assert.ok(!fs.existsSync(path.join(tmpHome, ".cursor")), "skip must not create ~/.cursor");
    // A machine without Cursor is information, not a warning or an error.
    // (The one warning that may appear is the pre-existing PATH one.)
    assert.doesNotMatch(result.stdout, /^(error|conflict):/m);
    assert.doesNotMatch(result.stdout, /^warning:.*\.cursor/m);
  });

  it("wires KUSABI_CURSOR_DIR (creating it) and leaves HOME untouched", () => {
    const result = run();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.ok(fs.lstatSync(skillLink("delegate")).isSymbolicLink());
    assert.ok(!fs.existsSync(path.join(tmpHome, ".cursor")), "HOME must not be touched");
  });

  it("leaves a real directory at the target untouched and reports conflict", () => {
    const link = skillLink("delegate");
    fs.mkdirSync(link, { recursive: true });
    fs.writeFileSync(path.join(link, "SKILL.md"), "mine\n");
    const result = run();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, new RegExp(`^conflict: ${rx(link)} `, "m"));
    assert.ok(!fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(link, "SKILL.md"), "utf8"), "mine\n");
    // The conflict does not stop the other artifact.
    assert.match(result.stdout, new RegExp(`^created: ${rx(skillLink("kusabi-result-handling"))} -> `, "m"));
  });

  it("replaces a symlink pointing elsewhere and names the old target (updated)", () => {
    const other = path.join(tmpHome, "elsewhere");
    fs.mkdirSync(other, { recursive: true });
    fs.mkdirSync(path.join(cursorDir, "skills"), { recursive: true });
    const link = skillLink("delegate");
    fs.symlinkSync(other, link);
    const result = run();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(
      result.stdout,
      new RegExp(`^updated: ${rx(link)} -> ${rx(skillSrc("delegate"))} \\(was ${rx(other)}\\)$`, "m"),
    );
    assert.equal(fs.realpathSync(link), fs.realpathSync(skillSrc("delegate")));
  });

  it("treats a relative symlink to the same target as current", () => {
    const skillsDir = path.join(cursorDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    const link = skillLink("delegate");
    fs.symlinkSync(path.relative(skillsDir, skillSrc("delegate")), link);
    const result = run();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, new RegExp(`^current: ${rx(link)} -> `, "m"));
  });

  it("reports a per-artifact error, continues, and exits non-zero (kusabi #258)", () => {
    // A regular file where skills/ should be: every symlink under it fails.
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.writeFileSync(path.join(cursorDir, "skills"), "not a directory\n");
    const result = run();
    // Any rendered error line — destination-side failure here — must drive
    // the exit code (kusabi #258), just like a missing source does.
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    const errors = result.stdout.split("\n").filter((l) => l.startsWith("error: "));
    assert.equal(errors.length, SKILLS.length, result.stdout);
    assert.match(result.stdout, /^created: .*kusabi-companion$/m);
  });

  it("installs the alwaysApply rule only with --cursor-rule", () => {
    const link = path.join(cursorDir, "rules", "kusabi-delegate.mdc");
    const plain = run();
    assert.equal(plain.status, 0, plain.stderr + plain.stdout);
    assert.ok(!fs.existsSync(path.join(cursorDir, "rules")), "no rules dir without the flag");
    assert.doesNotMatch(plain.stdout, /kusabi-delegate\.mdc/);

    const withRule = run(["--cursor-rule"]);
    assert.equal(withRule.status, 0, withRule.stderr + withRule.stdout);
    assert.match(withRule.stdout, new RegExp(`^created: ${rx(link)} -> `, "m"));
    assert.equal(
      fs.realpathSync(link),
      fs.realpathSync(path.join(PLUGIN_DIR, "rules", "kusabi-delegate.mdc")),
    );
  });

  it("rejects --cursor-rule on other subcommands", () => {
    const result = spawnSync(process.execPath, [COMPANION_SCRIPT, "status", "--cursor-rule"], {
      encoding: "utf8",
      env: { ...process.env, HOME: tmpHome, OPENCODE_BIN: "/nonexistent-opencode-bin" },
      timeout: 10_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /--cursor-rule is only supported by install-cli/);
  });

  it("the plugin rule is frontmatter + body with alwaysApply and no absolute paths", () => {
    const raw = fs.readFileSync(path.join(PLUGIN_DIR, "rules", "kusabi-delegate.mdc"), "utf8");
    const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    assert.ok(m, "rule does not parse as frontmatter + body");
    const [, front, body] = m;
    assert.match(front, /^description: \S/m);
    assert.match(front, /^alwaysApply: true$/m);
    const bodyLines = body.trim().split("\n");
    assert.ok(bodyLines.length > 0 && body.trim().length > 0, "rule body is empty");
    assert.ok(bodyLines.length <= 15, `rule body is ${bodyLines.length} lines, want <= 15`);
    // Machine-independence: no absolute path and no environment-overlay refs.
    assert.doesNotMatch(raw, /(^|\s)~?\/[A-Za-z0-9_.-]/m, "rule contains an absolute filesystem path");
    assert.doesNotMatch(raw, /MEMORY\.md|kairanban/);
  });

  it("--help documents --cursor-rule and the extended install-cli behaviour", () => {
    const result = spawnSync(process.execPath, [COMPANION_SCRIPT, "--help"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^ {2}--cursor-rule /m);
    assert.match(result.stdout, /^ {2}install-cli .*\.cursor\/skills/m);
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
//
// kusabi #277: this suite timed out three times in two days in CI, across
// both large-payload variants, always as `timed out after 15000ms; got 0
// bytes; stderr=`.  The defect was in the collector, not in flushAndExit.
// `stdio: "pipe"` is a Unix socketpair, whose send buffer (~208KiB on Linux)
// can accept the whole 150,000-byte payload in one go; when it does, the
// child drains and exits within milliseconds — long before a reader that
// waits a second.  The old collector attached its `data`/`end` listeners at
// resume time, so that child's stdout had already ended before anything was
// listening: no data, no `end`, promise pending, bound reached, zero bytes
// reported for a payload that had in fact been delivered in full.  Whether
// the socket swallows the payload whole is a race, which is why the failure
// was intermittent and why a re-run on the same commit went green.
//
// Three things keep it fixed and keep the next failure readable:
//
//   1. the collector listens from the start and uses pause/resume purely for
//      flow control, so no exit can outrun the reader (regression test:
//      "delivers a payload from a child that exits before the reader
//      resumes");
//   2. the children import ./flush-and-exit.mjs, whose import graph is node
//      builtins only.  Importing kusabi-companion.mjs put its whole graph of
//      cold `import` inside the measured window — noise that both widened
//      the race above and, from the parent, is indistinguishable from a hang;
//   3. every child announces itself on stderr before its first stdout byte,
//      and the collector budgets the two phases separately: spawn→marker gets
//      a generous bound of its own (startup, which CI contention can stretch
//      arbitrarily and which proves nothing about #243), and the drain bound
//      starts at the marker.  A timeout now names its phase and carries the
//      marker state, bytes read and elapsed ms.
//
// The 15s total is unchanged; it is split, not raised.
// ---------------------------------------------------------------------------

describe("flushAndExit (kusabi #243)", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");
  const FLUSH_MODULE = path.join(import.meta.dirname, "flush-and-exit.mjs");
  const LARGE = 150_000;
  // Comfortably past the stdio socket's send buffer (~208KiB on Linux), so the
  // kernel cannot swallow the payload whole before flushAndExit runs.
  const OVERSIZED = 1_000_000;
  const READY = "flush-child-ready\n";
  const FLUSHING = "flush-child-flushing\n";

  const IMPORT_FLUSH = `import { flushAndExit } from ${JSON.stringify(FLUSH_MODULE)};`;
  const WRITE_READY = `process.stderr.write(${JSON.stringify(READY)});`;

  function spawnSource(lines) {
    return spawn(process.execPath, ["--input-type=module", "-e", lines.join("\n")], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  // Marker first, payload second: everything the child spends on startup is
  // then outside the bound that guards the drain.
  function spawnFlushChild({ bytes, exitCode, leftoverTimer = false }) {
    const lines = [IMPORT_FLUSH];
    if (leftoverTimer) lines.push("setInterval(() => {}, 60_000);");
    lines.push(WRITE_READY);
    if (bytes > 0) lines.push(`process.stdout.write("x".repeat(${bytes}));`);
    lines.push(`flushAndExit(${exitCode});`);
    return spawnSource(lines);
  }

  /**
   * Read a child's stdout through a deliberately slow consumer.
   *
   * The reader stays paused until `delayMs` after the ready marker (or until
   * `resumeOn` appears on stderr), which is what fills the pipe and makes a
   * dropped buffer visible.  Basing that delay on the marker rather than on
   * spawn also means a slow-starting child still meets a genuinely paused
   * reader instead of one that has already given up and drained.
   */
  function collectDelayedPipe(
    child,
    { delayMs = 1000, startTimeoutMs = 10_000, drainTimeoutMs = 5_000, resumeOn = null } = {},
  ) {
    return new Promise((resolve, reject) => {
      const spawnedAt = Date.now();
      const chunks = [];
      let stderr = "";
      let markerAt = null;
      let code = null;
      let signal = null;
      let stdoutEnded = false;
      let closed = false;
      let reading = false;
      let startTimer = null;
      let drainTimer = null;
      let readTimer = null;

      const bytes = () => chunks.reduce((n, c) => n + c.length, 0);
      const elapsed = () => Date.now() - spawnedAt;
      const clearAll = () => {
        clearTimeout(startTimer);
        clearTimeout(drainTimer);
        clearTimeout(readTimer);
      };

      const fail = (message) => {
        clearAll();
        child.kill("SIGKILL");
        reject(new Error(message));
      };

      const tryResolve = () => {
        if (!closed || !stdoutEnded) return;
        clearAll();
        resolve({
          code,
          signal,
          stdout: Buffer.concat(chunks),
          stderr,
          markerSeen: markerAt !== null,
          msToMarker: markerAt === null ? null : markerAt - spawnedAt,
        });
      };

      // Listeners go on now, before anything can arrive, and pause() is the
      // only thing holding the data back.  Attaching them at resume time was
      // the kusabi #277 flake: a child that finished before the reader
      // resumed had already ended its stdout, so a listener added afterwards
      // saw neither `data` nor `end` and the promise ran to its bound
      // reporting zero bytes — with the child's payload sitting unread.
      child.stdout.on("data", (c) => { chunks.push(c); });
      child.stdout.on("end", () => { stdoutEnded = true; tryResolve(); });
      child.stdout.pause();

      const beginRead = () => {
        if (reading) return;
        reading = true;
        clearTimeout(readTimer);
        child.stdout.resume();
      };

      const onMarker = () => {
        if (markerAt !== null) return;
        markerAt = Date.now();
        clearTimeout(startTimer);
        if (resumeOn === null) readTimer = setTimeout(beginRead, delayMs);
        drainTimer = setTimeout(() => fail(
          `flush child stalled after start: marker seen ${markerAt - spawnedAt}ms after spawn, ` +
          `then no exit within ${drainTimeoutMs}ms of it; ${bytes()} bytes of stdout read ` +
          `(reader resumed: ${reading ? "yes" : "no"}); ${elapsed()}ms elapsed; ` +
          `stderr=${JSON.stringify(stderr)}`,
        ), drainTimeoutMs);
      };

      child.stderr.on("data", (c) => {
        stderr += c;
        if (stderr.includes(READY)) onMarker();
        if (resumeOn !== null && stderr.includes(resumeOn)) beginRead();
      });

      startTimer = setTimeout(() => fail(
        `flush child never started: marker not seen within ${startTimeoutMs}ms of spawn; ` +
        `${bytes()} bytes of stdout read; ${elapsed()}ms elapsed; stderr=${JSON.stringify(stderr)}`,
      ), startTimeoutMs);

      child.on("error", (err) => {
        clearAll();
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
    const result = await collectDelayedPipe(child, { delayMs: 0, drainTimeoutMs: 5_000 });
    assert.equal(result.code, 0, result.stderr);
  });

  // kusabi #277 candidate B: "the non-zero path deadlocks when stdout is a
  // full, paused pipe".  Refuted, and pinned here so it stays refuted.  The
  // reader holds the pipe shut until the child reports the entire payload
  // still sitting in its stream buffer — an event, not a sleep, so the child
  // is provably inside flushAndExit with nothing flushed when reading starts.
  // Both codes then deliver every byte, which is what "code reaches only
  // process.exitCode and the process.exit argument" predicts.
  it("drains an oversized, full pipe identically for exit 0 and exit 7 (kusabi #277)", async () => {
    for (const exitCode of [0, 7]) {
      const child = spawnSource([
        IMPORT_FLUSH,
        WRITE_READY,
        `process.stdout.write("z".repeat(${OVERSIZED}));`,
        `process.stderr.write("queued=" + process.stdout.writableLength + "\\n");`,
        `process.stderr.write(${JSON.stringify(FLUSHING)});`,
        `flushAndExit(${exitCode});`,
      ]);
      const result = await collectDelayedPipe(child, { resumeOn: FLUSHING });
      const queued = Number(/queued=(\d+)/.exec(result.stderr)?.[1] ?? -1);
      assert.ok(queued > 65_536, `expected a full pipe at flush time, queued=${queued}`);
      assert.equal(result.code, exitCode, result.stderr);
      assert.equal(result.stdout.length, OVERSIZED, `exit ${exitCode}: ${result.stderr}`);
      assert.equal(result.stdout.toString("utf8"), "z".repeat(OVERSIZED));
    }
  });

  // The kusabi #277 flake itself, reduced to something deterministic: a
  // payload small enough that the stdio socket takes it whole means the child
  // is finished and reaped before the delayed reader ever resumes.  Against
  // the old collector this hung 10/10 and reported `got 0 bytes` — the exact
  // CI signature, for a child that had in fact delivered every byte.
  it("delivers a payload from a child that exits before the reader resumes (kusabi #277)", async () => {
    const SMALL = 4_096;
    const child = spawnFlushChild({ bytes: SMALL, exitCode: 0 });
    const result = await collectDelayedPipe(child);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.length, SMALL);
    assert.equal(result.stdout.toString("utf8"), "x".repeat(SMALL));
  });

  it("a timeout before the marker names the spawn phase (kusabi #277)", async () => {
    const child = spawnSource(["setInterval(() => {}, 60_000);"]);
    await assert.rejects(
      () => collectDelayedPipe(child, { startTimeoutMs: 300 }),
      (err) => {
        assert.match(err.message, /never started/);
        assert.match(err.message, /marker not seen within 300ms/);
        assert.match(err.message, /0 bytes of stdout read/);
        assert.match(err.message, /\d+ms elapsed/);
        return true;
      },
    );
  });

  it("a timeout after the marker names the drain phase (kusabi #277)", async () => {
    const child = spawnSource([
      WRITE_READY,
      `process.stdout.write("y".repeat(1024));`,
      "setInterval(() => {}, 60_000);",
    ]);
    await assert.rejects(
      () => collectDelayedPipe(child, { delayMs: 0, drainTimeoutMs: 1_500 }),
      (err) => {
        assert.match(err.message, /stalled after start/);
        assert.match(err.message, /marker seen \d+ms after spawn/);
        assert.match(err.message, /1024 bytes of stdout read \(reader resumed: yes\)/);
        assert.match(err.message, /\d+ms elapsed/);
        return true;
      },
    );
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

  // One definition, no copy: the children above would happily pass against a
  // duplicate that the companion never calls (kusabi #277).
  it("the companion imports flushAndExit instead of defining its own", () => {
    const source = fs.readFileSync(COMPANION_SCRIPT, "utf8");
    assert.match(source, /^import \{ flushAndExit \} from "\.\/flush-and-exit\.mjs";$/m);
    assert.equal([...source.matchAll(/function flushAndExit\s*\(/g)].length, 0);
  });

  // The child's import cost is the measured window's noise floor; keep it at
  // node builtins (kusabi #277).
  it("flush-and-exit.mjs imports node builtins only", () => {
    const source = fs.readFileSync(FLUSH_MODULE, "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const specifiers = [...code.matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(specifiers.length > 0, "expected flush-and-exit.mjs to import something");
    for (const specifier of specifiers) {
      assert.ok(specifier.startsWith("node:"), `flush-and-exit.mjs must not import ${specifier}`);
    }
    assert.equal([...code.matchAll(/\bimport\s*\(/g)].length, 0, "no dynamic import");
    assert.equal([...code.matchAll(/\brequire\s*\(/g)].length, 0, "no require");
  });
});

// Failure next-action names the companion CLI, not a slash command (kusabi #246)
// ---------------------------------------------------------------------------
// Cursor CLI has no `/kusabi:status`, and companion stdout is transferred
// verbatim by whatever orchestrator ran it — so the line a failed task/review
// renders must name the executable surface. cmdTask / cmdReview are not
// exported; the rendered literal is pinned in their source.

describe("failed task/review next-action (kusabi #246)", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");

  function commandSource(startMarker, endMarker) {
    const source = fs.readFileSync(COMPANION_SCRIPT, "utf8");
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker);
    assert.ok(start >= 0 && end > start, `could not slice ${startMarker}`);
    return source.slice(start, end);
  }

  it("cmdTask points at kusabi-companion status, never a slash command", () => {
    const cmdTaskSource = commandSource("async function cmdTask(", "async function cmdReview(");
    assert.ok(cmdTaskSource.includes("Run kusabi-companion status ${job.id} for details."));
    assert.ok(!cmdTaskSource.includes("/kusabi:"), "no slash command in cmdTask output");
  });

  it("cmdReview points at kusabi-companion status, never a slash command", () => {
    const cmdReviewSource = commandSource("async function cmdReview(", "function cmdStatus(");
    assert.ok(cmdReviewSource.includes("Run kusabi-companion status ${job.id} for details."));
    assert.ok(!cmdReviewSource.includes("/kusabi:"), "no slash command in cmdReview output");
  });
});

// Lossy smoke briefs are refused before the chain starts (kusabi #250)
// ---------------------------------------------------------------------------
// A smoke command containing a backtick is truncated by parseSmoke into an
// entry no shell can run; the chain then burns every round with P4 red and
// the worker cannot fix it from the inside (kusabi #246, chain-mst2adbf5fd5).
// The refusal happens at parse time, before any chain state exists.
//
// smokeViolationReport moved to chain-driver.mjs with its two callers (kusabi
// #264 PR 2/2), but this suite stayed: two of its three inner suites drive the
// refusal through the spawned binary, and all three share the incident's brief
// constants.  The unit suite imports the function from its new home.

describe("smoke-brief refusal (kusabi #250)", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");
  // Verbatim from the incident, and what parseSmoke reads out of it.
  const NESTED = "- `! grep -F 'Check `/kusabi:status`' plugins/kusabi/commands/task.md …`";
  const TRUNCATED = "! grep -F 'Check ";
  const LOSSY_BRIEF = ["# Task", "", "## Smoke", "", NESTED, ""].join("\n");

  describe("smokeViolationReport", () => {
    it("names the source line and the command the machine read", () => {
      const report = smokeViolationReport(LOSSY_BRIEF);
      assert.ok(report, "a lossy brief must produce a report");
      assert.ok(report.includes(NESTED), report);
      assert.ok(report.includes("`" + TRUNCATED + "`"), report);
    });

    it("reports a `## Smoke` heading with no entries", () => {
      const report = smokeViolationReport("## Smoke\n\nRun the usual checks.\n");
      assert.ok(report);
      assert.match(report, /no smoke entry parsed/);
    });

    it("returns null for a clean brief and for no brief at all", () => {
      assert.equal(smokeViolationReport("## Smoke\n- `npm test`\n"), null);
      assert.equal(smokeViolationReport(""), null);
      assert.equal(smokeViolationReport(null), null);
    });
  });

  describe("chain CLI", () => {
    function runChain(briefText, tmp) {
      const briefPath = path.join(tmp, "brief.md");
      fs.writeFileSync(briefPath, briefText);
      const env = { ...process.env };
      delete env.KUSABI_WORKER_CONTEXT;
      env.KUSABI_STATE_DIR = path.join(tmp, "state");
      env.KUSABI_SUNABA_URL = "http://127.0.0.1:9/mcp";
      return spawnSync(
        process.execPath,
        [COMPANION_SCRIPT, "chain", "--container", "cid-1", "--brief-file", briefPath],
        { encoding: "utf8", cwd: tmp, env, timeout: 15_000 },
      );
    }

    it("refuses the #250 nested-backtick brief, showing line and command", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-smoke-chain-"));
      try {
        const result = runChain(LOSSY_BRIEF, tmp);
        assert.notEqual(result.status, 0, result.stdout);
        assert.ok(result.stdout.includes(NESTED), result.stdout);
        assert.ok(result.stdout.includes("`" + TRUNCATED + "`"), result.stdout);
        // Nothing may have been created: the refusal is upstream of any state.
        assert.ok(!fs.existsSync(path.join(tmp, "state")), "no state dir may be created");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("refuses a `## Smoke` heading with no entries", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-smoke-chain-"));
      try {
        const result = runChain("# Task\n\n## Smoke\n\nRun the usual checks.\n", tmp);
        assert.notEqual(result.status, 0, result.stdout);
        assert.match(result.stdout, /no smoke entry parsed/);
        assert.ok(!fs.existsSync(path.join(tmp, "state")), "no state dir may be created");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("lets a clean smoke brief through the check (fails later, on dispatch)", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-smoke-chain-"));
      try {
        // The brief also carries the signature line and `## Deliverables`:
        // both became dispatch-time requirements for a chain in kusabi #289,
        // and this test asserts that NO refusal fires — so the brief has to be
        // one the whole dispatch boundary accepts, not just the #250 smoke
        // check.  Nothing else about the test changed.
        const result = runChain(
          "# Task\n\nOrchestrator: test-model | session s-1 | 2026-08-16\n\n"
          + "## Deliverables\n\n- `plugins/kusabi/scripts/x.mjs`\n\n"
          + "## Smoke\n\n- `npm test`\n",
          tmp,
        );
        // The dispatch itself cannot succeed here (dead sunaba endpoint); what
        // matters is that the failure is NOT the smoke refusal.
        assert.doesNotMatch(result.stdout, /brief rejected before dispatch/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("chain-resume CLI", () => {
    // chain-resume re-reads the brief from chain.json, so the same refusal
    // applies there — and must land before the control record is re-armed.
    function hashedWorkspaceDir(stateRootDir, cwd) {
      const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12);
      return path.join(stateRootDir, hash);
    }

    it("refuses to resume a chain whose saved brief is lossy", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-smoke-resume-"));
      try {
        const stateRootDir = path.join(tmp, "state");
        const stateDir = hashedWorkspaceDir(stateRootDir, tmp);
        const chainDir = path.join(stateDir, "chains", "chain-lossy");
        fs.mkdirSync(chainDir, { recursive: true });
        writeJson(path.join(chainDir, "chain.json"), {
          chainId: "chain-lossy",
          container: "cid-1",
          model: "fake/model",
          modelChain: [["fake/model"]],
          maxRounds: 4,
          brief: LOSSY_BRIEF,
          records: [{ round: 1, implementJobId: "job-1", interrupted: true }],
        });
        writeChainControl(chainDir, {
          chainId: "chain-lossy", container: "cid-1", pid: 999999,
          status: "running", round: 1, startedAt: new Date().toISOString(),
        });

        const env = { ...process.env };
        delete env.KUSABI_WORKER_CONTEXT;
        env.KUSABI_STATE_DIR = stateRootDir;
        env.KUSABI_SUNABA_URL = "http://127.0.0.1:9/mcp";
        const result = spawnSync(
          process.execPath, [COMPANION_SCRIPT, "chain-resume", "chain-lossy"],
          { encoding: "utf8", cwd: tmp, env, timeout: 15_000 },
        );
        assert.notEqual(result.status, 0, result.stdout);
        assert.match(result.stdout, /cannot resume chain chain-lossy/);
        assert.ok(result.stdout.includes("`" + TRUNCATED + "`"), result.stdout);
        // Refused before rearmChainControl touched anything.
        assert.equal(readChainControl(chainDir).status, "running");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});

// install-cli surfaces a broken plugin checkout (kusabi #256)
// ---------------------------------------------------------------------------
// The skill sources are resolved from the companion script's own location, so
// a fixture checkout is built around a copy of the script with no skills/ in
// it. The copy must be real: Node resolves the ENTRY through realpath, so a
// symlinked companion would report the true plugin root and test nothing.
// The sibling modules can be symlinks for the same reason.

describe("install-cli with a missing skill source (kusabi #256)", () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-broken-checkout-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function brokenCheckoutScript() {
    const realScripts = import.meta.dirname;
    const scripts = path.join(tmp, "plugins", "kusabi", "scripts");
    fs.mkdirSync(scripts, { recursive: true });
    for (const entry of fs.readdirSync(realScripts)) {
      if (!entry.endsWith(".mjs")) continue;
      const from = path.join(realScripts, entry);
      const to = path.join(scripts, entry);
      if (entry === "kusabi-companion.mjs") fs.copyFileSync(from, to);
      else fs.symlinkSync(from, to);
    }
    return path.join(scripts, "kusabi-companion.mjs");
  }

  it("reports an error line per skill, creates no link, and exits non-zero", () => {
    const script = brokenCheckoutScript();
    const cursorDir = path.join(tmp, "cursor");
    const result = spawnSync(process.execPath, [script, "install-cli"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: tmp,
        KUSABI_BIN_DIR: path.join(tmp, "bin"),
        KUSABI_CURSOR_DIR: cursorDir,
        OPENCODE_BIN: "/nonexistent-opencode-bin",
      },
      timeout: 15_000,
    });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    const errors = result.stdout.split("\n").filter((l) => l.startsWith("error: "));
    assert.equal(errors.length, 2, result.stdout);
    for (const line of errors) {
      assert.match(line, /symlink source does not exist/);
    }
    assert.ok(!fs.existsSync(path.join(cursorDir, "skills")), "no dangling link may be created");
    // The shim — install-cli's primary job — is still written and reported.
    assert.match(result.stdout, /^created: .*kusabi-companion$/m);
  });

  it("exits non-zero when the destination refuses the links (kusabi #258)", () => {
    // Full checkout (sources exist): the failure is destination-side.  A
    // regular file where `skills/` must be a directory makes every
    // mkdirSync/symlinkSync in the wiring throw, so each artifact reports
    // `error` — and a rendered error line must drive the exit code just like
    // a missing source does.
    const script = path.join(import.meta.dirname, "kusabi-companion.mjs");
    const cursorDir = path.join(tmp, "cursor");
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.writeFileSync(path.join(cursorDir, "skills"), "a file, not a directory");
    const result = spawnSync(process.execPath, [script, "install-cli"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: tmp,
        KUSABI_BIN_DIR: path.join(tmp, "bin"),
        KUSABI_CURSOR_DIR: cursorDir,
        OPENCODE_BIN: "/nonexistent-opencode-bin",
      },
      timeout: 15_000,
    });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    const errors = result.stdout.split("\n").filter((l) => l.startsWith("error: "));
    assert.equal(errors.length, 2, result.stdout);
    for (const line of errors) {
      assert.ok(line.includes(cursorDir), line);
    }
    // The shim — install-cli's primary job — is still written and reported.
    assert.match(result.stdout, /^created: .*kusabi-companion$/m);
  });
});

// =========================================================================
// the dispatch boundary delivers the container and refuses a broken brief
// (kusabi #289)
// -------------------------------------------------------------------------
// Two gaps, both hit live on 2026-08-16.  (1) `task --phase implement
// --container <cid>` recorded the id on the job and ran its probes with it,
// but never told the WORKER: the chain injects the id into its implement
// prompt, the task path did not, and a worker whose brief carried no
// `## Workplace` section guessed ten `sandbox_attach` names, all failed, and
// finished 171s with zero edits.  (2) The companion machine-reads the
// signature line and `## Deliverables`, but absence was silent -- the brief
// dispatched anyway and the gap surfaced a round later.  The refusal follows
// the #250 lossy-smoke shape: before any state exists, naming the missing
// item AND the remedy.
// =========================================================================

describe("brief lint and container delivery (kusabi #289)", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");
  const SIGNATURE = "Orchestrator: claude-fable-5 | session wsl-test-1 | 2026-08-16";
  const DELIVERABLES = "## Deliverables\n\n- `plugins/kusabi/scripts/kusabi-companion.mjs`\n";
  // The shape of the brief in the live incident: signed, with deliverables,
  // and with nothing anywhere that names a container.
  const NO_WORKPLACE = `# Task\n\n${SIGNATURE}\n\n${DELIVERABLES}`;

  describe("briefLintReport", () => {
    it("passes an implement brief whose container comes from --container", () => {
      assert.equal(
        briefLintReport({ brief: NO_WORKPLACE, phase: "implement", container: "cid-1" }),
        null,
      );
    });

    it("passes an implement brief whose container comes from ## Workplace", () => {
      const brief = `${NO_WORKPLACE}\n## Workplace\n\nContainer \`cid-1\` (kusabi main).\n`;
      assert.equal(briefLintReport({ brief, phase: "implement", container: null }), null);
    });

    it("refuses an implement dispatch with neither source, naming both remedies", () => {
      const report = briefLintReport({ brief: NO_WORKPLACE, phase: "implement", container: null });
      assert.ok(report, "the incident brief must be refused");
      assert.match(report, /brief rejected before dispatch/);
      assert.match(report, /no container source/);
      assert.match(report, /--container <cid>/);
      assert.match(report, /## Workplace/);
    });

    it("refuses an implement dispatch whose ## Deliverables is absent, naming the section", () => {
      const report = briefLintReport({
        brief: `# Task\n\n${SIGNATURE}\n`,
        phase: "implement",
        container: "cid-1",
      });
      assert.ok(report);
      assert.match(report, /## Deliverables/);
    });

    it("refuses a ## Deliverables heading that parses to zero entries", () => {
      const report = briefLintReport({
        brief: `# Task\n\n${SIGNATURE}\n\n## Deliverables\n\nTo be decided by the worker.\n`,
        phase: "implement",
        container: "cid-1",
      });
      assert.ok(report, "a heading with no parseable entry is the same failure as no heading");
      assert.match(report, /## Deliverables/);
    });

    it("refuses a brief with no signature line, for every phase", () => {
      const brief = `# Task\n\n${DELIVERABLES}\n## Workplace\n\nContainer \`cid-1\`.\n`;
      for (const phase of ["draft", "investigate", "implement", "review", "respond", "salvage", "gofer"]) {
        const report = briefLintReport({ brief, phase, container: "cid-1" });
        assert.ok(report, `${phase} must be refused`);
        assert.ok(
          report.includes("Orchestrator: <model-id> | session <id> | <date>"),
          `${phase}: the refusal must show the line to add, got: ${report}`,
        );
      }
    });

    it("adds nothing but the signature line to the non-implement phases", () => {
      // Non-goal of #289: investigate/review/... keep the brief requirements
      // they already had.  No Deliverables, no Workplace, no container.
      for (const phase of ["draft", "investigate", "review", "respond", "salvage", "gofer"]) {
        assert.equal(
          briefLintReport({ brief: `# Task\n\n${SIGNATURE}\n\nLook into it.\n`, phase, container: null }),
          null,
          phase,
        );
      }
    });

    it("leaves an ad-hoc task with no --phase alone", () => {
      // `/kusabi:task <free text>` is not an orchestrator's brief; the lint
      // covers phase dispatches and chains.
      assert.equal(briefLintReport({ brief: "look at the flaky test in x.mjs" }), null);
    });

    it("requires deliverables and a signature when a chain starts, listing every miss at once", () => {
      const report = briefLintReport({ brief: "# Task\n\nImplement it.\n", container: "cid-1", chain: true });
      assert.ok(report);
      assert.match(report, /2 required brief items are missing/);
      assert.match(report, /## Deliverables/);
      assert.ok(report.includes("Orchestrator: <model-id>"));
      // `chain` refuses a missing --container on its own, before this call:
      // the container-source line must not double up on that message.
      assert.doesNotMatch(report, /no container source/);
    });

    // ---- zero-entry `## Smoke` / `## Frozen Tests` (kusabi #302) ----
    // The live brief of chain-msvwhslx6e60 (2026-08-17) carried a
    // `## Frozen Tests` heading whose body was the prose `(none frozen by
    // name — …)`.  P5 correctly failed all four rounds on "heading present but
    // no entries parsed", and every one of those rounds was unwinnable: the
    // probe's input is the brief, which no worker can edit.  The refusal has
    // to happen where the brief is still editable — at dispatch.
    it("refuses a ## Frozen Tests heading that parses to zero entries, naming the section and the remedy", () => {
      const report = briefLintReport({
        brief: `# Task\n\n${SIGNATURE}\n\n${DELIVERABLES}\n## Frozen Tests\n\n(none frozen by name — use judgement.)\n`,
        phase: "implement",
        container: "cid-1",
      });
      assert.ok(report, "a Frozen Tests heading with no parseable entry must be refused");
      assert.match(report, /brief rejected before dispatch/);
      assert.match(report, /## Frozen Tests/);
      assert.match(report, /P5: frozen/);
      // The remedy, verbatim: a denial without it just pushes the author onto
      // a worse path (writing `- (none)` as an entry).
      assert.ok(
        report.includes("Add entries, or delete the heading entirely — an empty section must omit its heading."),
        `the refusal must state the remedy, got: ${report}`,
      );
    });

    it("refuses a ## Smoke heading that parses to zero entries, naming the section and the remedy", () => {
      const report = briefLintReport({
        brief: `# Task\n\n${SIGNATURE}\n\n${DELIVERABLES}\n## Smoke\n\nRun whatever seems sensible.\n`,
        phase: "implement",
        container: "cid-1",
      });
      assert.ok(report, "a Smoke heading with no parseable entry must be refused");
      assert.match(report, /## Smoke/);
      assert.match(report, /P4: smoke/);
      assert.ok(report.includes("an empty section must omit its heading"));
    });

    it("refuses a zero-entry section on a chain dispatch too", () => {
      const report = briefLintReport({
        brief: `# Task\n\n${SIGNATURE}\n\n${DELIVERABLES}\n## Frozen Tests\n\n(none)\n`,
        container: "cid-1",
        chain: true,
      });
      assert.ok(report, "the chain path runs the same lint");
      assert.match(report, /## Frozen Tests/);
    });

    it("does NOT refuse a brief whose Smoke / Frozen Tests headings are ABSENT", () => {
      // Absence is not emptiness: both sections stay optional (a #302
      // non-goal), and their probes trivially pass when nothing is declared.
      const brief = `# Task\n\n${SIGNATURE}\n\n${DELIVERABLES}`;
      assert.equal(briefLintReport({ brief, phase: "implement", container: "cid-1" }), null);
      assert.equal(briefLintReport({ brief, container: "cid-1", chain: true }), null);
      for (const phase of ["draft", "investigate", "review", "respond", "salvage", "gofer"]) {
        assert.equal(
          briefLintReport({ brief: `# Task\n\n${SIGNATURE}\n\nLook into it.\n`, phase, container: null }),
          null,
          phase,
        );
      }
    });

    it("accepts a brief whose Smoke and Frozen Tests sections do parse", () => {
      const brief = [
        "# Task", "", SIGNATURE, "", DELIVERABLES,
        "## Smoke", "", "- `node --check plugins/kusabi/scripts/kusabi-companion.mjs`", "",
        "## Frozen Tests", "", "- `plugins/kusabi/scripts/chain-phases.test.mjs`", "",
      ].join("\n");
      assert.equal(briefLintReport({ brief, phase: "implement", container: "cid-1" }), null);
    });

    it("reports a zero-entry ## Deliverables exactly once (its own rule owns that case)", () => {
      // Parity, not duplication: the pre-existing deliverables line already
      // refuses absent-or-zero-entries, so the new loop must not add a second
      // line for the same defect.
      const report = briefLintReport({
        brief: `# Task\n\n${SIGNATURE}\n\n## Deliverables\n\nTo be decided by the worker.\n`,
        phase: "implement",
        container: "cid-1",
      });
      assert.match(report, /1 required brief item is missing/);
      assert.equal(report.match(/## Deliverables/g).length, 1);
      assert.doesNotMatch(report, /P3: deliverables/);
    });

    it("leaves an ad-hoc task with no --phase alone, zero-entry section and all", () => {
      // `/kusabi:task <free text>` is not an orchestrator's brief; the lint
      // covers phase dispatches and chains, and #302 does not widen that.
      assert.equal(
        briefLintReport({ brief: "look at it\n\n## Smoke\n\nwhatever works\n" }),
        null,
      );
    });

    it("counts one problem in the singular", () => {
      const report = briefLintReport({
        brief: `# Task\n\n${DELIVERABLES}`,
        phase: "implement",
        container: "cid-1",
      });
      assert.match(report, /1 required brief item is missing/);
    });

    // ---- Frozen Tests qualifier: leftover prose outside the path token (kusabi #386) ----
    // The live incident (henshusha chain-mtaa2btyd78c, 2026-08-27) wrote a
    // `## Frozen Tests` bullet with `you may append; do not weaken`.  parsePathSection
    // keeps only the path token and drops everything outside it, so P5 froze
    // `tests/test_style.py` and escalated when the worker obeyed the prose
    // (append-only).  The defence is dispatch-time: refuse and name both remedies.
    // P5 stays path-intersection; no append-ok.
    it("refuses the live-incident Frozen line, naming the section, path, leftover, and both remedies", () => {
      const brief = [
        "# Task", "", SIGNATURE, "", DELIVERABLES,
        "## Frozen Tests", "",
        "- `tests/test_style.py` tests that already exist (you may append; do not weaken)", "",
      ].join("\n");
      const report = briefLintReport({ brief, phase: "implement", container: "cid-1" });
      assert.ok(report, "the live incident brief must be refused");
      assert.match(report, /brief rejected before dispatch/);
      assert.match(report, /## Frozen Tests/);
      assert.match(report, /tests\/test_style\.py/);
      // The leftover the machine dropped must be quoted back at the author.
      assert.ok(
        report.includes("tests that already exist (you may append; do not weaken)"),
        `the refusal must quote the leftover text, got: ${report}`,
      );
      // Both remedies, verbatim voice from the issue:
      assert.ok(report.includes("do not freeze that path"), "remedy 1: do not freeze the path");
      assert.ok(report.includes("do not weaken existing tests"), "remedy 1: move to Acceptance criteria");
      assert.ok(report.includes("different file"), "remedy 1: new tests in a different file");
      assert.ok(report.includes("the entry is the path alone"), "remedy 2: path alone");
      assert.ok(report.includes("但し書き"), "remedy 2: names the 但し書き");
      // Nothing in the report blames a worker — it is the brief's defect.
      assert.doesNotMatch(report, /worker failure|escalated the chain because the worker|violated the oracle because the worker/i);
    });

    it("refuses a pre-path Frozen line (prose before the path token), naming both remedies", () => {
      const brief = [
        "# Task", "", SIGNATURE, "", DELIVERABLES,
        "## Frozen Tests", "",
        "- do not weaken `tests/test_style.py`", "",
      ].join("\n");
      const report = briefLintReport({ brief, phase: "implement", container: "cid-1" });
      assert.ok(report, "a pre-path qualifier must be refused");
      assert.match(report, /brief rejected before dispatch/);
      assert.match(report, /## Frozen Tests/);
      assert.match(report, /tests\/test_style\.py/);
      assert.ok(
        report.includes("do not weaken"),
        `the refusal must quote the leftover text, got: ${report}`,
      );
      assert.ok(report.includes("do not weaken existing tests"), "remedy 1: move to Acceptance criteria");
      assert.ok(report.includes("the entry is the path alone"), "remedy 2: path alone");
    });

    it("returns null for the same bullet reduced to a path alone", () => {
      const brief = [
        "# Task", "", SIGNATURE, "", DELIVERABLES,
        "## Frozen Tests", "",
        "- `tests/test_style.py`", "",
      ].join("\n");
      assert.equal(
        briefLintReport({ brief, phase: "implement", container: "cid-1" }),
        null,
        "a path-only Frozen bullet is exactly what P5 can enforce",
      );
    });

    it("returns null for an annotated heading `## Frozen Tests (do not touch)` with a path-only bullet", () => {
      // Heading annotations stay legal (kusabi #167); the qualifier rule walks
      // ITEMS, not the heading line.
      const brief = [
        "# Task", "", SIGNATURE, "", DELIVERABLES,
        "## Frozen Tests (do not touch)", "",
        "- `tests/test_style.py`", "",
      ].join("\n");
      assert.equal(briefLintReport({ brief, phase: "implement", container: "cid-1" }), null);
    });

    it("does NOT refuse a qualifying Frozen line that lives in an ABSENT section", () => {
      // Absence is not emptiness: with no `## Frozen Tests` heading at all there
      // is nothing to qualify, so the rule is silent (#302 non-goal).
      const brief = `# Task\n\n${SIGNATURE}\n\n${DELIVERABLES}`;
      assert.equal(briefLintReport({ brief, phase: "implement", container: "cid-1" }), null);
    });

    it("does NOT refuse a Deliverables bullet whose path is followed by prose", () => {
      // Descriptions after the path are NORMAL in Deliverables; the qualifier
      // rule is scoped to `## Frozen Tests` only.
      const brief = [
        "# Task", "", SIGNATURE, "",
        "## Deliverables", "",
        "- `src/foo.js` the store layer", "",
      ].join("\n");
      assert.equal(
        briefLintReport({ brief, phase: "implement", container: "cid-1" }),
        null,
        "Deliverables prose must not trigger the Frozen qualifier rule",
      );
    });

    it("leaves an ad-hoc task (no --phase, no chain) with a qualifying Frozen line alone", () => {
      // Matches #302: the lint covers phase dispatches and chains, not the
      // `/kusabi:task <free text>` surface.
      const brief = "fix the flaky test\n\n## Frozen Tests\n\n- `tests/test_style.py` you may append; do not weaken\n";
      assert.equal(briefLintReport({ brief }), null);
    });

    it("refuses the qualifier on a chain dispatch too", () => {
      const brief = [
        "# Task", "", SIGNATURE, "", DELIVERABLES,
        "## Frozen Tests", "",
        "- `tests/test_style.py` you may append; do not weaken", "",
      ].join("\n");
      const report = briefLintReport({ brief, container: "cid-1", chain: true });
      assert.ok(report, "the chain path runs the same lint");
      assert.match(report, /## Frozen Tests/);
      assert.match(report, /tests\/test_style\.py/);
      assert.ok(report.includes("you may append; do not weaken"));
    });

    it("does not change what parseFrozenTests / P5 read for a qualifying bullet", () => {
      // The new check is lint, not a change to the path parser's return value.
      const brief = [
        "# Task", "", SIGNATURE, "", DELIVERABLES,
        "## Frozen Tests", "",
        "- `tests/test_style.py` tests that already exist (you may append; do not weaken)", "",
      ].join("\n");
      assert.deepEqual(parseFrozenTests(brief), ["tests/test_style.py"]);
      const qual = findFrozenQualifierItems(brief);
      assert.equal(qual.length, 1);
      assert.equal(qual[0].path, "tests/test_style.py");
      assert.equal(qual[0].remainder, "tests that already exist (you may append; do not weaken)");
    });

    it("treats a code-block Frozen line with path + extra words as a qualifier", () => {
      const brief = [
        "# Task", "", SIGNATURE, "", DELIVERABLES,
        "## Frozen Tests", "",
        "```",
        "tests/test_style.py you may append new tests here",
        "```", "",
      ].join("\n");
      const report = briefLintReport({ brief, phase: "implement", container: "cid-1" });
      assert.ok(report, "a code-block path+prose line qualifies");
      assert.match(report, /tests\/test_style\.py/);
      assert.ok(report.includes("you may append new tests here"));
    });

    it("does NOT qualify a code-block line that is the path alone", () => {
      const brief = [
        "# Task", "", SIGNATURE, "", DELIVERABLES,
        "## Frozen Tests", "",
        "```",
        "tests/test_style.py",
        "```", "",
      ].join("\n");
      assert.equal(briefLintReport({ brief, phase: "implement", container: "cid-1" }), null);
    });
  });

  describe("withContainerWorkspace", () => {
    it("names the exact container id and forbids guessing", () => {
      const out = withContainerWorkspace("BODY", "25d03f038ba3");
      assert.match(out, /^The workspace lives inside container `25d03f038ba3`\./);
      assert.match(out, /Do not guess container names or call sandbox_attach\./);
      assert.ok(out.endsWith("\n\nBODY"));
    });

    it("is a no-op without a container", () => {
      assert.equal(withContainerWorkspace("BODY", null), "BODY");
      assert.equal(withContainerWorkspace("BODY", undefined), "BODY");
      assert.equal(withContainerWorkspace("BODY", ""), "BODY");
    });

    it("is the very text the chain's implement prompt carries (one wording, two paths)", () => {
      const brief = "# Task\n\ndo it";
      assert.equal(
        buildImplementText({ round: 1, brief, container: "cid-1" }),
        withContainerWorkspace(brief, "cid-1"),
      );
    });
  });

  describe("wiring (source guards)", () => {
    // cmdTask is not exported; these pin the two orderings the change is
    // about, the way the #204 review-input wiring test does.
    const companionSource = fs.readFileSync(COMPANION_SCRIPT, "utf8");
    const cmdTaskSource = companionSource.slice(
      companionSource.indexOf("async function cmdTask("),
      companionSource.indexOf("async function cmdReview("),
    );

    it("cmdTask prefixes the dispatched prompt with the container workspace header", () => {
      assert.ok(cmdTaskSource.includes("withContainerWorkspace(taskPromptText, flags.container)"));
      assert.ok(cmdTaskSource.includes("promptText: taskPromptText"));
    });

    it("cmdTask lints before it reads the container and before it dispatches", () => {
      const lintAt = cmdTaskSource.indexOf("briefLintReport(");
      assert.ok(lintAt > 0, "cmdTask must call the lint");
      assert.ok(lintAt < cmdTaskSource.indexOf("let taskBaseSha"), "the lint precedes the container read");
      assert.ok(lintAt < cmdTaskSource.indexOf("await dispatch({"), "the lint precedes the dispatch");
    });

    it("cmdChain lints before any chain state exists", () => {
      const driverSource = fs.readFileSync(path.join(import.meta.dirname, "chain-driver.mjs"), "utf8");
      const cmdChainSource = driverSource.slice(driverSource.indexOf("export async function cmdChain("));
      const lintAt = cmdChainSource.indexOf("briefLintReport(");
      assert.ok(lintAt > 0, "cmdChain must call the lint");
      assert.ok(lintAt < cmdChainSource.indexOf("createChainDir(stateDir)"), "the lint precedes createChainDir");
    });
  });

  describe("CLI", () => {
    function briefFile(tmp, text) {
      const file = path.join(tmp, "brief.md");
      fs.writeFileSync(file, text, "utf8");
      return file;
    }

    function workspaceStateDir(tmp) {
      const hash = crypto.createHash("sha256").update(tmp).digest("hex").slice(0, 12);
      return path.join(tmp, "state", hash);
    }

    function run(args, tmp) {
      const env = { ...process.env };
      delete env.KUSABI_WORKER_CONTEXT;
      env.KUSABI_STATE_DIR = path.join(tmp, "state");
      env.KUSABI_SUNABA_URL = "http://127.0.0.1:9/mcp";
      env.OPENCODE_BIN = path.join(tmp, "no-such-opencode-bin");
      return spawnSync(process.execPath, [COMPANION_SCRIPT, ...args], {
        encoding: "utf8", cwd: tmp, env, timeout: 20_000,
      });
    }

    it("refuses task --phase implement with no container source, before any job exists", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-289-task-"));
      try {
        const result = run(["task", "--phase", "implement", "--brief-file", briefFile(tmp, NO_WORKPLACE)], tmp);
        assert.notEqual(result.status, 0, result.stdout);
        assert.match(result.stdout, /brief rejected before dispatch/);
        assert.match(result.stdout, /no container source/);
        assert.match(result.stdout, /## Workplace/);
        assert.deepEqual(fs.readdirSync(path.join(workspaceStateDir(tmp), "jobs")), [], "no job may be created");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("refuses an unsigned brief on a phase with no other requirement", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-289-sig-"));
      try {
        const result = run(
          ["task", "--phase", "review", "--brief-file", briefFile(tmp, "# Task\n\nReview the diff.\n")],
          tmp,
        );
        assert.notEqual(result.status, 0, result.stdout);
        assert.match(result.stdout, /brief rejected before dispatch/);
        assert.ok(result.stdout.includes("Orchestrator: <model-id> | session <id> | <date>"), result.stdout);
        assert.deepEqual(fs.readdirSync(path.join(workspaceStateDir(tmp), "jobs")), [], "no job may be created");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("refuses a chain whose brief has no ## Deliverables, before the chain dir exists", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-289-chain-"));
      try {
        const result = run(
          ["chain", "--container", "cid-1", "--brief-file", briefFile(tmp, `# Task\n\n${SIGNATURE}\n\nImplement it.\n`)],
          tmp,
        );
        assert.notEqual(result.status, 0, result.stdout);
        assert.match(result.stdout, /brief rejected before dispatch/);
        assert.match(result.stdout, /## Deliverables/);
        assert.equal(
          fs.existsSync(path.join(workspaceStateDir(tmp), "chains")),
          false,
          "no chain state may be created",
        );
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    // The live incident, end to end: the worker prompt that actually reaches
    // the spawned CLI must name the container.  The claude backend is used
    // because its prompt travels on stdin, where a fake binary can record it.
    const FAKE_CLAUDE = [
      "#!/usr/bin/env node",
      "import fs from \"node:fs\";",
      "fs.appendFileSync(process.env.FAKE_CLAUDE_STDIN_LOG, fs.readFileSync(0, \"utf8\"));",
      "process.stdout.write(JSON.stringify({",
      "  type: \"result\", is_error: false, result: \"done\", session_id: \"claude-289\",",
      "  usage: {}, total_cost_usd: 0, duration_ms: 5, num_turns: 1,",
      "}));",
      "",
    ].join("\n");

    it("delivers the container id into the worker prompt of task --phase implement --container", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-289-deliver-"));
      try {
        const binPath = path.join(tmp, "fake-claude.mjs");
        fs.writeFileSync(binPath, FAKE_CLAUDE, "utf8");
        fs.chmodSync(binPath, 0o755);
        const stdinLog = path.join(tmp, "stdin.txt");
        fs.writeFileSync(stdinLog, "", "utf8");
        const mcpSource = path.join(tmp, "claude.json");
        fs.writeFileSync(mcpSource, JSON.stringify({
          mcpServers: { sunaba: { command: "npx", args: ["-y", "@sunaba/mcp-server"] } },
        }), "utf8");
        const stateDir = path.join(tmp, "state");
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(
          path.join(stateDir, "config.json"),
          JSON.stringify({ models: { phases: { implement: ["claude/sonnet"] } } }),
          "utf8",
        );

        const env = { ...process.env };
        delete env.KUSABI_WORKER_CONTEXT;
        env.KUSABI_STATE_DIR = stateDir;
        env.KUSABI_SUNABA_URL = "http://127.0.0.1:9/mcp";
        env.CLAUDE_BIN = binPath;
        env.KUSABI_CLAUDE_MCP_SOURCE = mcpSource;
        env.FAKE_CLAUDE_STDIN_LOG = stdinLog;

        const result = spawnSync(
          process.execPath,
          [
            COMPANION_SCRIPT, "task", "--phase", "implement", "--container", "cid-289",
            "--brief-file", briefFile(tmp, NO_WORKPLACE),
          ],
          { encoding: "utf8", cwd: tmp, env, timeout: 30_000 },
        );

        const prompt = fs.readFileSync(stdinLog, "utf8");
        assert.ok(
          prompt.includes("The workspace lives inside container `cid-289`"),
          `the worker prompt must name the container; got stdout=${result.stdout} stderr=${result.stderr} prompt=${prompt.slice(0, 400)}`,
        );
        // The brief itself still travels, unchanged, in the task block.
        assert.match(prompt, /<task>/);
        assert.ok(prompt.includes(SIGNATURE), prompt.slice(0, 400));
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("cmdBaseline subcommand", () => {
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
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          resolve({ server, url: `http://127.0.0.1:${addr.port}/mcp` });
        });
      });
    }

    function run(args, tmp) {
      const env = { ...process.env };
      delete env.KUSABI_WORKER_CONTEXT;
      env.KUSABI_STATE_DIR = path.join(tmp, "state");
      env.KUSABI_SUNABA_URL = "http://127.0.0.1:9/mcp";
      return spawnSync(process.execPath, [COMPANION_SCRIPT, ...args], {
        encoding: "utf8", cwd: tmp, env, timeout: 20_000,
      });
    }

    function runBaselineAsync(args, tmp, extraEnv = {}) {
      return new Promise((resolve) => {
        const env = { ...process.env, ...extraEnv };
        delete env.KUSABI_WORKER_CONTEXT;
        env.KUSABI_STATE_DIR = path.join(tmp, "state");
        if (!extraEnv.KUSABI_SUNABA_URL) {
          env.KUSABI_SUNABA_URL = "http://127.0.0.1:9/mcp";
        }
        const child = spawn(process.execPath, [COMPANION_SCRIPT, "baseline", ...args], {
          cwd: tmp,
          env,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        const timer = setTimeout(() => child.kill("SIGTERM"), 10_000);
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ status: code, stdout, stderr });
        });
      });
    }

    it("lists baseline in --help", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-baseline-help-"));
      try {
        const result = run(["--help"], tmp);
        assert.equal(result.status, 0);
        assert.match(result.stdout, /baseline\s+Report collected test count/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("requires a container id", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-baseline-nocid-"));
      try {
        const result = run(["baseline"], tmp);
        assert.notEqual(result.status, 0);
        assert.match(result.stdout, /baseline requires a container id/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("rejects unsupported flags passed to baseline", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-baseline-flags-"));
      try {
        const resultPort = run(["baseline", "cid-1", "--port", "8080"], tmp);
        assert.notEqual(resultPort.status, 0);
        assert.match(resultPort.stdout, /--port is only supported by dashboard/);

        const resultBackend = run(["baseline", "cid-1", "--backend", "claude"], tmp);
        assert.notEqual(resultBackend.status, 0);
        assert.match(resultBackend.stdout, /--backend is only supported by task and chain/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("handles unreachable container with readable error line and non-zero exit code (no stack trace)", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-baseline-unreachable-"));
      try {
        const result = run(["baseline", "unreachable-container-id"], tmp);
        assert.equal(result.status, 1);
        assert.match(result.stdout, /^baseline error:/);
        assert.doesNotMatch(result.stdout, /at Object\./);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("runs brief ## Smoke entries with baseline --container <cid> <brief-path>", async () => {
      const { server, url } = await startSunabaStub({
        toolResultText: {
          captured: true,
          collected: 2547,
          gate_passed: true,
          lint: 0,
          types: 0,
          status: "ok",
          output: "ok 1 - test\n",
          exit_code: 0,
        },
      });
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-baseline-smoke-1-"));
      try {
        const briefPath = path.join(tmp, "brief.md");
        fs.writeFileSync(briefPath, "## Smoke\n\n- `node -v`\n", "utf8");
        const result = await runBaselineAsync(["--container", "cid-123", briefPath], tmp, { KUSABI_SUNABA_URL: url });
        assert.equal(result.status, 0);
        assert.match(result.stdout, /Baseline for container cid-123:/);
        assert.match(result.stdout, /Smoke baseline:/);
      } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("behaves identically with baseline <cid> <brief-path> and baseline --container <cid> <brief-path>", async () => {
      const { server, url } = await startSunabaStub({
        toolResultText: {
          captured: true,
          collected: 2547,
          gate_passed: true,
          lint: 0,
          types: 0,
          status: "ok",
          output: "ok 1 - test\n",
          exit_code: 0,
        },
      });
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-baseline-smoke-2-"));
      try {
        const briefPath = path.join(tmp, "brief.md");
        fs.writeFileSync(briefPath, "## Smoke\n\n- `node -v`\n", "utf8");
        const res1 = await runBaselineAsync(["--container", "cid-123", briefPath], tmp, { KUSABI_SUNABA_URL: url });
        const res2 = await runBaselineAsync(["cid-123", briefPath], tmp, { KUSABI_SUNABA_URL: url });
        assert.equal(res1.status, 0);
        assert.equal(res2.status, 0);
        assert.equal(res1.stdout, res2.stdout);
      } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("runs brief ## Smoke entries with --brief-file <path> for both container forms", async () => {
      const { server, url } = await startSunabaStub({
        toolResultText: {
          captured: true,
          collected: 2547,
          gate_passed: true,
          lint: 0,
          types: 0,
          status: "ok",
          output: "ok 1 - test\n",
          exit_code: 0,
        },
      });
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-baseline-smoke-3-"));
      try {
        const flagBrief = path.join(tmp, "flag-brief.md");
        fs.writeFileSync(flagBrief, "## Smoke\n\n- `echo flag`\n", "utf8");

        const res1 = await runBaselineAsync(["--container", "cid-123", "--brief-file", flagBrief], tmp, { KUSABI_SUNABA_URL: url });
        const res2 = await runBaselineAsync(["cid-123", "--brief-file", flagBrief], tmp, { KUSABI_SUNABA_URL: url });
        assert.equal(res1.status, 0);
        assert.equal(res2.status, 0);
        assert.equal(res1.stdout, res2.stdout);
        assert.match(res1.stdout, /Smoke baseline:/);
      } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("rejects stray positional argument with --container <cid> and --brief-file <path> (Criterion 1)", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-baseline-reject-c1-"));
      try {
        const briefPath = path.join(tmp, "brief.md");
        fs.writeFileSync(briefPath, "## Smoke\n\n- `echo test`\n", "utf8");

        const res = run(["baseline", "--container", "cid-123", "--brief-file", briefPath, "STRAYTOKEN"], tmp);
        assert.notEqual(res.status, 0);
        assert.match(res.stdout, /unexpected positional argument: STRAYTOKEN/);
        assert.doesNotMatch(res.stdout, /^baseline error:/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("rejects stray positional argument with positional <cid> and --brief-file <path> (Criterion 2)", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-baseline-reject-c2-"));
      try {
        const briefPath = path.join(tmp, "brief.md");
        fs.writeFileSync(briefPath, "## Smoke\n\n- `echo test`\n", "utf8");

        const res = run(["baseline", "cid-123", "--brief-file", briefPath, "STRAYTOKEN"], tmp);
        assert.notEqual(res.status, 0);
        assert.match(res.stdout, /unexpected positional argument: STRAYTOKEN/);
        assert.doesNotMatch(res.stdout, /^baseline error:/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("rejects positional argument that can be neither container nor brief with non-zero exit", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-baseline-reject-"));
      try {
        const briefPath = path.join(tmp, "brief.md");
        fs.writeFileSync(briefPath, "## Smoke\n\n- `echo test`\n", "utf8");

        const res1 = run(["baseline", "cid-123", briefPath, "extra-token"], tmp);
        assert.notEqual(res1.status, 0);
        assert.match(res1.stdout, /unexpected positional argument: extra-token/);

        const res2 = run(["baseline", "--container", "cid-123", briefPath, "extra-token"], tmp);
        assert.notEqual(res2.status, 0);
        assert.match(res2.stdout, /unexpected positional argument: extra-token/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("baseline <cid> with no brief omits smoke section", async () => {
      const { server, url } = await startSunabaStub({
        toolResultText: {
          captured: true,
          collected: 2547,
          gate_passed: true,
          lint: 0,
          types: 0,
        },
      });
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-baseline-nobrief-"));
      try {
        const res = await runBaselineAsync(["cid-123"], tmp, { KUSABI_SUNABA_URL: url });
        assert.equal(res.status, 0);
        assert.match(res.stdout, /Baseline for container cid-123:/);
        assert.doesNotMatch(res.stdout, /Smoke baseline:/);
      } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
describe("help flags validation (kusabi #360)", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");

  function getCompanionCodeAndUsage() {
    const companionSource = fs.readFileSync(COMPANION_SCRIPT, "utf8");

    const usageStart = companionSource.indexOf("function usage()");
    assert.ok(usageStart >= 0, "usage function found");
    const usageEnd = companionSource.indexOf("\n}\n", usageStart);
    assert.ok(usageEnd > usageStart, "usage function end found");
    const usageText = companionSource.slice(usageStart, usageEnd);

    const scriptDir = import.meta.dirname;
    let allCode = companionSource.slice(0, usageStart) + companionSource.slice(usageEnd);
    for (const file of fs.readdirSync(scriptDir)) {
      if (file.endsWith(".mjs") && !file.endsWith(".test.mjs") && file !== "kusabi-companion.mjs") {
        allCode += "\n" + fs.readFileSync(path.join(scriptDir, file), "utf8");
      }
    }
    return { usageText, allCode };
  }

  function extractAdvertisedFlags(flagsText) {
    const rawFlags = [];
    for (const line of flagsText.split("\n")) {
      const matches = line.matchAll(/(?:^\s*"*\s*|,\s*)--([a-z0-9-]+)/g);
      for (const m of matches) {
        rawFlags.push(m[1]);
      }
    }
    return [...new Set(rawFlags)].filter((f) => f !== "help" && f !== "h");
  }

  function findUnconsumedFlags(advertisedFlags, allCode) {
    const unconsumed = [];
    for (const flag of advertisedFlags) {
      const kebab = flag;
      const camel = flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

      // Check property access on flags, parsed.flags, or opts.flags (e.g., flags.readOnly, parsed.flags.base)
      const hasPropAccess =
        new RegExp(`\\b(?:parsed\\??\\.|opts\\??\\.)?flags\\??\\.(?:${camel}|${kebab})\\b`).test(allCode);

      // Check bracket indexing on flags, parsed.flags, or opts.flags with string literal (e.g., flags["brief-file"], parsed.flags["max-rounds"])
      const hasBracketAccess =
        new RegExp(`\\b(?:parsed\\??\\.|opts\\??\\.)?flags\\??\\[\\s*["'](?:${kebab}|${camel})["']\\s*\\]`).test(allCode);

      // Check helper indexing passing string literal to waitDurationFlag (e.g., waitDurationFlag(flags, "poll-interval", ...))
      const hasWaitDurationAccess =
        new RegExp(`\\bwaitDurationFlag\\(\\s*flags\\s*,\\s*["'](?:${kebab}|${camel})["']`).test(allCode);

      if (!hasPropAccess && !hasBracketAccess && !hasWaitDurationAccess) {
        unconsumed.push(`--${flag}`);
      }
    }
    return unconsumed;
  }

  it("every flag advertised in --help is consumed in the companion source", () => {
    const { usageText, allCode } = getCompanionCodeAndUsage();

    const flagsSectionMatch = usageText.match(/Flags:([\s\S]*?)(?:Unknown flags|Serve lifecycle|$)/);
    assert.ok(flagsSectionMatch, "Flags section found in usage()");
    const flagsText = flagsSectionMatch[1];

    const advertisedFlags = extractAdvertisedFlags(flagsText);
    assert.ok(advertisedFlags.length > 0, "advertised flags extracted");

    const unconsumed = findUnconsumedFlags(advertisedFlags, allCode);
    assert.deepStrictEqual(
      unconsumed,
      [],
      `Advertised flags [${unconsumed.join(", ")}] are listed in --help but not consumed in companion source`
    );
  });

  it("rejects help text with flags that exist in code as non-flag string literals (--review, --salvage)", () => {
    const { allCode } = getCompanionCodeAndUsage();
    const syntheticFlagsText = "\n  --read-only, --resume-last, --review, --salvage\n";
    const advertisedFlags = extractAdvertisedFlags(syntheticFlagsText);

    const unconsumed = findUnconsumedFlags(advertisedFlags, allCode);
    assert.deepStrictEqual(
      unconsumed,
      ["--review", "--salvage"],
      "expected --review and --salvage to be detected as unconsumed flags"
    );
  });

  it("rejects help text with flags whose name appears nowhere in the codebase", () => {
    const { allCode } = getCompanionCodeAndUsage();
    const syntheticFlagsText = "\n  --nonexistent-flag-xyz\n";
    const advertisedFlags = extractAdvertisedFlags(syntheticFlagsText);

    const unconsumed = findUnconsumedFlags(advertisedFlags, allCode);
    assert.deepStrictEqual(
      unconsumed,
      ["--nonexistent-flag-xyz"],
      "expected --nonexistent-flag-xyz to be detected as unconsumed flag"
    );
  });
});

describe("chain-detach CLI", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");

  const VALID_BRIEF =
    "# Task\n\nOrchestrator: test-model | session s-1 | 2026-08-23\n\n" +
    "## Deliverables\n\n- `plugins/kusabi/scripts/x.mjs`\n\n" +
    "## Smoke\n\n- `npm test`\n";

  it("extractChainAndWaitArgs separates wait flags from chain flags", () => {
    assert.equal(typeof cmdChainDetach, "function");
    const flags = {
      "brief-file": "brief.md",
      container: "cid-1",
      model: "claude/opus",
      keepServe: true,
      "appear-timeout": "180",
      "poll-interval": "5",
    };
    const { chainArgs, waitFlags } = extractChainAndWaitArgs(flags, "");
    assert.deepStrictEqual(chainArgs, [
      "--brief-file",
      "brief.md",
      "--container",
      "cid-1",
      "--model",
      "claude/opus",
      "--keep-serve",
    ]);
    assert.deepStrictEqual(waitFlags, {
      "appear-timeout": "180",
      "poll-interval": "5",
    });
  });

  it("refuses to launch when pre-flight checks fail (missing container, invalid brief)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-detach-refuse-"));
    try {
      const briefPath = path.join(tmp, "brief.md");
      fs.writeFileSync(briefPath, "Invalid brief with no deliverables");
      const env = { ...process.env };
      delete env.KUSABI_WORKER_CONTEXT;
      env.KUSABI_STATE_DIR = path.join(tmp, "state");

      // 1. Missing container
      const resNoContainer = spawnSync(
        process.execPath,
        [COMPANION_SCRIPT, "chain-detach", "--brief-file", briefPath],
        { encoding: "utf8", cwd: tmp, env },
      );
      assert.notEqual(resNoContainer.status, 0);
      assert.match(resNoContainer.stdout, /chain requires --container/);
      assert.doesNotMatch(resNoContainer.stdout, /chain-wait/);

      // 2. Invalid brief (missing deliverables)
      const resBadBrief = spawnSync(
        process.execPath,
        [COMPANION_SCRIPT, "chain-detach", "--container", "cid-1", "--brief-file", briefPath],
        { encoding: "utf8", cwd: tmp, env },
      );
      assert.notEqual(resBadBrief.status, 0);
      assert.match(resBadBrief.stdout, /brief rejected before dispatch/);
      assert.doesNotMatch(resBadBrief.stdout, /chain-wait/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses dispatch when KUSABI_WORKER_CONTEXT is set", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-detach-worker-"));
    try {
      const briefPath = path.join(tmp, "brief.md");
      fs.writeFileSync(briefPath, VALID_BRIEF);
      const env = { ...process.env, KUSABI_WORKER_CONTEXT: "1" };
      const res = spawnSync(
        process.execPath,
        [COMPANION_SCRIPT, "chain-detach", "--container", "cid-1", "--brief-file", briefPath],
        { encoding: "utf8", cwd: tmp, env },
      );
      assert.notEqual(res.status, 0);
      assert.match(res.stdout, /refusing to dispatch from inside a kusabi worker context/);
      assert.doesNotMatch(res.stdout, /chain-wait/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("launches a detached chain stand-in, prints log path and runnable chain-wait command line", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-detach-success-"));
    try {
      const briefPath = path.join(tmp, "brief.md");
      fs.writeFileSync(briefPath, VALID_BRIEF);
      const stateRootDir = path.join(tmp, "state");

      const standinScript = path.join(tmp, "standin.mjs");
      fs.writeFileSync(
        standinScript,
        `import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const stateDir = process.env.KUSABI_TEST_STATE_DIR;
const chainId = "chain-" + Date.now().toString(36) + crypto.randomBytes(2).toString("hex");
const chainDir = path.join(stateDir, "chains", chainId);
fs.mkdirSync(chainDir, { recursive: true });

fs.writeFileSync(path.join(chainDir, "control.json"), JSON.stringify({
  chainId, container: "cid-1", pid: process.pid, status: "running", round: 1
}));

setTimeout(() => {
  fs.writeFileSync(path.join(chainDir, "chain.json"), JSON.stringify({
    chainId, container: "cid-1", records: [{ round: 1, disposition: "accept" }]
  }));
  fs.writeFileSync(path.join(chainDir, "control.json"), JSON.stringify({
    chainId, container: "cid-1", pid: process.pid, status: "completed", round: 1
  }));
}, 200);
`,
        "utf8",
      );

      const env = { ...process.env };
      delete env.KUSABI_WORKER_CONTEXT;
      env.KUSABI_STATE_DIR = stateRootDir;

      const hash = crypto.createHash("sha256").update(tmp).digest("hex").slice(0, 12);
      const workspaceStateDir = path.join(stateRootDir, hash);
      env.KUSABI_TEST_STATE_DIR = workspaceStateDir;
      env.KUSABI_TEST_CHAIN_STANDIN = standinScript;

      const res = spawnSync(
        process.execPath,
        [COMPANION_SCRIPT, "chain-detach", "--container", "cid-1", "--brief-file", briefPath, "--appear-timeout", "10"],
        { encoding: "utf8", cwd: tmp, env },
      );

      assert.equal(res.status, 0, res.stdout);
      assert.match(res.stdout, /Detached chain launched \(pid \d+\)/);
      assert.match(res.stdout, /Log: .*chain-detach-\d+\.log/);
      assert.match(res.stdout, /kusabi-companion chain-wait --next --since \d{4}-\d{2}-\d{2}T.* --appear-timeout 10/);

      const waitCmdMatch = res.stdout.match(/kusabi-companion (chain-wait --next --since \S+ --appear-timeout \d+)/);
      assert.ok(waitCmdMatch, "wait command found in stdout");
      const waitArgs = waitCmdMatch[1].split(/\s+/);

      const waitRes = spawnSync(
        process.execPath,
        [COMPANION_SCRIPT, ...waitArgs],
        { encoding: "utf8", cwd: tmp, env, timeout: 5000 },
      );

      assert.equal(waitRes.status, 0, waitRes.stdout);
      assert.match(waitRes.stdout, /^chain chain-[a-z0-9]+: status=completed disposition=accept/m);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("unambiguously selects the new chain when another chain pre-exists in the same workspace", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-detach-concurrent-"));
    try {
      const briefPath = path.join(tmp, "brief.md");
      fs.writeFileSync(briefPath, VALID_BRIEF);
      const stateRootDir = path.join(tmp, "state");
      const hash = crypto.createHash("sha256").update(tmp).digest("hex").slice(0, 12);
      const workspaceStateDir = path.join(stateRootDir, hash);

      const olderChainDir = path.join(workspaceStateDir, "chains", "chain-older-001");
      fs.mkdirSync(olderChainDir, { recursive: true });
      fs.writeFileSync(path.join(olderChainDir, "control.json"), JSON.stringify({
        chainId: "chain-older-001", container: "cid-1", pid: 99999, status: "running", round: 1
      }));

      const oldTime = new Date(Date.now() - 60000);
      fs.utimesSync(olderChainDir, oldTime, oldTime);

      const standinScript = path.join(tmp, "standin2.mjs");
      fs.writeFileSync(
        standinScript,
        `import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const stateDir = process.env.KUSABI_TEST_STATE_DIR;
const chainId = "chain-newer-002";
const chainDir = path.join(stateDir, "chains", chainId);
fs.mkdirSync(chainDir, { recursive: true });

fs.writeFileSync(path.join(chainDir, "control.json"), JSON.stringify({
  chainId, container: "cid-1", pid: process.pid, status: "running", round: 1
}));

setTimeout(() => {
  fs.writeFileSync(path.join(chainDir, "chain.json"), JSON.stringify({
    chainId, container: "cid-1", records: [{ round: 1, disposition: "accept" }]
  }));
  fs.writeFileSync(path.join(chainDir, "control.json"), JSON.stringify({
    chainId, container: "cid-1", pid: process.pid, status: "completed", round: 1
  }));
}, 200);
`,
        "utf8",
      );

      const env = { ...process.env };
      delete env.KUSABI_WORKER_CONTEXT;
      env.KUSABI_STATE_DIR = stateRootDir;
      env.KUSABI_TEST_STATE_DIR = workspaceStateDir;
      env.KUSABI_TEST_CHAIN_STANDIN = standinScript;

      const res = spawnSync(
        process.execPath,
        [COMPANION_SCRIPT, "chain-detach", "--container", "cid-1", "--brief-file", briefPath, "--appear-timeout", "10"],
        { encoding: "utf8", cwd: tmp, env },
      );

      assert.equal(res.status, 0, res.stdout);
      assert.match(res.stdout, /kusabi-companion chain-wait --next --since/);

      const waitCmdMatch = res.stdout.match(/kusabi-companion (chain-wait --next --since \S+ --appear-timeout \d+)/);
      assert.ok(waitCmdMatch);
      const waitArgs = waitCmdMatch[1].split(/\s+/);

      const waitRes = spawnSync(
        process.execPath,
        [COMPANION_SCRIPT, ...waitArgs],
        { encoding: "utf8", cwd: tmp, env, timeout: 5000 },
      );

      assert.equal(waitRes.status, 0, waitRes.stdout);
      assert.match(waitRes.stdout, /^chain chain-newer-002: status=completed/m);
      assert.doesNotMatch(waitRes.stdout, /chain-older-001/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// =========================================================================
// status command with kaiba progress (kusabi #391)
// =========================================================================

describe("status command kaiba progress rendering (kusabi #391)", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");
  let tmpDir;
  let stateRootDir;
  let workspaceStateDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-status-progress-"));
    stateRootDir = path.join(tmpDir, "state");
    const hash = crypto.createHash("sha256").update(tmpDir).digest("hex").slice(0, 12);
    workspaceStateDir = path.join(stateRootDir, hash);
    fs.mkdirSync(workspaceStateDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runCompanion(args) {
    const env = { ...process.env };
    delete env.KUSABI_WORKER_CONTEXT;
    env.KUSABI_STATE_DIR = stateRootDir;
    return spawnSync(process.execPath, [COMPANION_SCRIPT, ...args], {
      encoding: "utf8",
      cwd: tmpDir,
      env,
      timeout: 15_000,
    });
  }

  it("status without progress events matches expected shape without progress section", () => {
    const jobId = "job-no-progress";
    const jobDir = path.join(workspaceStateDir, "jobs", jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(
      path.join(jobDir, "job.json"),
      JSON.stringify({
        id: jobId,
        kind: "task",
        status: "completed",
        startedAt: "2026-08-29T00:00:00.000Z",
        finishedAt: "2026-08-29T00:05:00.000Z",
        stats: { events: 10, steps: 5, lastTool: "verify", permissionsAllowed: 0, permissionsRejected: 0, lastActivity: "2026-08-29T00:05:00.000Z" },
      }),
      "utf8",
    );

    const res = runCompanion(["status", jobId]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /events: 10, steps: 5, last tool: verify/);
    assert.doesNotMatch(res.stdout, /progress:/);
  });

  it("status with progress events in events.ndjson renders progress block", () => {
    const jobId = "job-with-progress";
    const jobDir = path.join(workspaceStateDir, "jobs", jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(
      path.join(jobDir, "job.json"),
      JSON.stringify({
        id: jobId,
        kind: "task",
        status: "running",
        startedAt: "2026-08-29T00:00:00.000Z",
        stats: { events: 12, steps: 6, lastTool: "edit", permissionsAllowed: 0, permissionsRejected: 0, lastActivity: "2026-08-29T00:02:00.000Z" },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(jobDir, "events.ndjson"),
      [
        JSON.stringify({
          type: "companion.kaiba.progress",
          id: 1,
          created_at: "2026-08-29T00:01:00Z",
          agent: "worker",
          job: jobId,
          content: "analyzing problem statement",
        }),
        JSON.stringify({
          type: "companion.kaiba.progress",
          id: 2,
          created_at: "2026-08-29T00:02:00Z",
          agent: "worker",
          job: jobId,
          content: "editing implementation files",
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const res = runCompanion(["status", jobId]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /events: 12, steps: 6, last tool: edit/);
    assert.match(res.stdout, /progress:\n\s+- analyzing problem statement\n\s+- editing implementation files/);
  });
});

