import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import {
  newestChainDir,
  PHASE_AGENTS,
  loadConfig,
  readBriefFile,
  __testProbeBindings,
  publishWarningForBrief,
} from "./kusabi-companion.mjs";
import {
  parseOrchestratorSignature,
} from "./brief-parsing.mjs";

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
