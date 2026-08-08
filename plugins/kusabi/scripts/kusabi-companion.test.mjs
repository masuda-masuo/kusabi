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
} from "./kusabi-companion.mjs";
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
import { readJson, writeJson } from "./state-paths.mjs";

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
  let dbPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-metrics-jobs-"));
    stateRoot = path.join(tmpDir, "state");
    transcriptDir = path.join(tmpDir, "transcripts");
    dbPath = path.join(tmpDir, "metrics.db");
    fs.mkdirSync(transcriptDir, { recursive: true });

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
      "metrics-ingest", "--state-root", stateRoot, "--transcript-dir", transcriptDir, "--db", dbPath,
    ]);
    assert.equal(first.status, 0);
    const second = runCompanion([
      "metrics-ingest", "--state-root", stateRoot, "--transcript-dir", transcriptDir, "--db", dbPath,
    ]);
    assert.equal(second.status, 0);
    assert.match(second.stdout, /jobs skipped \(unchanged\):\s+2/);
    assert.match(second.stdout, /jobs ingested:\s+0/);
  });

  it("a state root with no jobs at all still prints the Jobs block with zeros (visible, not silent)", () => {
    const emptyRoot = path.join(tmpDir, "empty-state");
    fs.mkdirSync(emptyRoot, { recursive: true });
    const result = runCompanion([
      "metrics-ingest", "--state-root", emptyRoot, "--transcript-dir", transcriptDir, "--dry-run",
    ]);
    assert.equal(result.status, 0, `dry-run failed: ${result.stdout} ${result.stderr}`);
    assert.match(result.stdout, /Jobs \(delegated single-shot task\/review jobs\):/);
    assert.match(result.stdout, /jobs scanned:\s+0/);
    assert.match(result.stdout, /jobs ingested:\s+0/);
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
            error: implementStatus === "provider-error" ? "All routes exhausted: fake/model — retry at attempt 3" : null,
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
});

// serve-stop — fossil `running` records must not block stopping (kusabi #162
// follow-up).  The companion runs as a real subprocess against a temp state
// root; the recorded serve is a fake long-lived process the test spawns and
// kills itself.  The startup reaper hook runs inside the subprocess too: the
// fixture's fresh file mtimes keep reapIdleServes from reaping, and the fake
// carries no kusabi marker env, so the orphan sweep cannot touch it.
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
    const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
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
