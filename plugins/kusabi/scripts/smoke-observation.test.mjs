import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  summarizeSmokeObservation,
  renderSmokeNoObservationWarning,
  measureSmokeBaseline,
  smokeBaselineReport,
} from "./chain-brief-guards.mjs";
import { runChainLifecycle } from "./chain-cmd.mjs";
import { persistChainState } from "./chain-persist.mjs";
import { cmdTaskDetach } from "./task-cmd.mjs";
import { parseChainRecord } from "./chain-ingest.mjs";
import { openMetricsDb, upsertChain, upsertRound } from "./metrics-db.mjs";
import { computeReport } from "./metrics-report.mjs";
import { renderReportText, renderReportJson } from "./metrics-render.mjs";

describe("A. Pure summary and warning renderer", () => {
  it("summarizeSmokeObservation with empty entries returns zero lines and null observesChange", () => {
    const res = summarizeSmokeObservation({ entries: [], observed: [] });
    assert.deepEqual(res, { lines: 0, baselineRed: 0, observesChange: null });

    const resEmpty = summarizeSmokeObservation();
    assert.deepEqual(resEmpty, { lines: 0, baselineRed: 0, observesChange: null });
  });

  it("summarizeSmokeObservation with all unannotated lines that pass returns baselineRed: 0 and observesChange: false", () => {
    const entries = [
      { command: "npm test", expectedExit: 0 },
      { command: "npm run lint", expectedExit: 0 },
    ];
    const observed = [
      { command: "npm test", observed: 0 },
      { command: "npm run lint", observed: 0 },
    ];
    const res = summarizeSmokeObservation({ entries, observed });
    assert.deepEqual(res, { lines: 2, baselineRed: 0, observesChange: false });
  });

  it("summarizeSmokeObservation with measured baseline-red entry returns baselineRed: 1 and observesChange: true", () => {
    const entries = [
      { command: "npm test", expectedExit: 0 },
      { command: "test-red", expectedExit: 0, baselineRed: true },
    ];
    const observed = [
      { command: "npm test", observed: 0 },
      { command: "test-red", observed: 1 },
    ];
    const res = summarizeSmokeObservation({ entries, observed });
    assert.deepEqual(res, { lines: 2, baselineRed: 1, observesChange: true });
  });

  it("summarizeSmokeObservation does not count stale or unmeasured baseline-red annotations", () => {
    // 1. Stale annotation (declared baseline-red but passed with 0)
    const entriesStale = [
      { command: "test-cmd", expectedExit: 0, baselineRed: true },
    ];
    const observedStale = [
      { command: "test-cmd", observed: 0 },
    ];
    assert.deepEqual(summarizeSmokeObservation({ entries: entriesStale, observed: observedStale }), {
      lines: 1, baselineRed: 0, observesChange: false,
    });

    // 2. Unmeasured observation (timed out, non-numeric)
    const observedUnmeasured = [
      { command: "test-cmd", observed: "timed out" },
    ];
    assert.deepEqual(summarizeSmokeObservation({ entries: entriesStale, observed: observedUnmeasured }), {
      lines: 1, baselineRed: 0, observesChange: false,
    });
  });

  it("renderSmokeNoObservationWarning renders warning when lines > 0 && baselineRed === 0", () => {
    const warn1 = renderSmokeNoObservationWarning({ lines: 1, baselineRed: 0, observesChange: false });
    assert.ok(warn1 !== null);
    assert.match(warn1, /^warning: no `## Smoke` line can observe this change/);
    assert.match(warn1, /all 1 line already pass/);

    const warn2 = renderSmokeNoObservationWarning({ lines: 2, baselineRed: 0, observesChange: false });
    assert.ok(warn2 !== null);
    assert.match(warn2, /all 2 lines already pass/);
  });

  it("renderSmokeNoObservationWarning returns null when baselineRed > 0 or lines === 0 or falsy", () => {
    assert.equal(renderSmokeNoObservationWarning({ lines: 2, baselineRed: 1, observesChange: true }), null);
    assert.equal(renderSmokeNoObservationWarning({ lines: 0, baselineRed: 0, observesChange: null }), null);
    assert.equal(renderSmokeNoObservationWarning(null), null);
    assert.equal(renderSmokeNoObservationWarning(undefined), null);
  });
});

describe("B. measureSmokeBaseline and smokeBaselineReport wrapper", () => {
  it("measureSmokeBaseline with no smoke returns report: null and zero summary without container calls", async () => {
    let called = false;
    const callTool = async () => { called = true; return {}; };
    const res = await measureSmokeBaseline({ brief: "# Brief\n\nNo smoke section", callTool, container: "c1" });
    assert.equal(called, false);
    assert.equal(res.report, null);
    assert.deepEqual(res.summary, { lines: 0, baselineRed: 0, observesChange: null });
  });

  it("measureSmokeBaseline measures once and returns both report and summary", async () => {
    const callCount = { sandbox_exec: 0, git: 0 };
    const callTool = async (tool, params) => {
      const cmd = params?.commands?.[0] || "";
      if (cmd === "git rev-parse HEAD") {
        callCount.git++;
        return { output: "0123456789abcdef0123456789abcdef01234567\n" };
      }
      if (cmd.startsWith("git ") || cmd.includes("git status")) {
        callCount.git++;
        return { output: "" };
      }
      if (tool === "sandbox_exec") {
        callCount.sandbox_exec++;
        return { output: "SMOKE_EXIT=0\n" };
      }
      return { output: "" };
    };
    const brief = "# Brief\n\n## Smoke\n\n- `cmd-1`\n- `cmd-2`\n";
    const res = await measureSmokeBaseline({ brief, callTool, container: "c1" });
    assert.equal(res.report, null);
    assert.deepEqual(res.summary, { lines: 2, baselineRed: 0, observesChange: false });
    assert.equal(callCount.sandbox_exec, 2);
  });

  it("smokeBaselineReport is a thin wrapper returning report only", async () => {
    const callTool = async () => ({ output: "SMOKE_EXIT=0\n" });
    const brief = "# Brief\n\n## Smoke\n\n- `cmd-1`\n";
    const report = await smokeBaselineReport({ brief, callTool, container: "c1" });
    assert.equal(report, null);
  });
});

describe("C. Chain dispatch warning and record persistence", () => {
  function makeHarness() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-smoke-test-"));
    const cwd = path.join(tmp, "ws");
    fs.mkdirSync(cwd, { recursive: true });
    const prevStateEnv = process.env.KUSABI_STATE_DIR;
    process.env.KUSABI_STATE_DIR = path.join(tmp, "state");
    const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12);
    const stateDir = path.join(tmp, "state", hash);
    const chainDir = path.join(stateDir, "chains", "chain-test");

    const APPROVE = JSON.stringify({
      schema_version: 1, verdict: "approve", findings: [], summary: "ok", next_steps: [],
    });

    const fakeDispatch = async (opts) => {
      if (opts.kind === "review") {
        return {
          job: {
            id: "job-rev-1", status: "completed", modelEntry: "opencode/fake-review", modelVariant: null,
            fallbacks: null, sessionID: "ses_rev_1",
            usage: { available: true, input: 2, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            error: null,
          },
          resultText: APPROVE,
        };
      }
      return {
        job: {
          id: "job-imp-1", status: "completed", modelEntry: "opencode/fake-model", modelVariant: null,
          fallbacks: null, sessionID: "ses_imp_1",
          usage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
          error: null,
        },
        resultText: "implemented",
      };
    };

    const makeFakeCallTool = (smokeExit = 0) => async (toolName, params) => {
      if (toolName === "verify_in_container") return { gate_passed: true };
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params?.commands?.[0] ?? params?.argv?.join(" ") ?? "";
      if (cmd.includes("change-scope.mjs")) {
        return {
          output: JSON.stringify({
            formatVersion: 1,
            repositoryRoot: "/workspace",
            input: { base: "abc123", head: "HEAD" },
            resolved: { baseSha: "abc123", headSha: "abc123", mergeBaseSha: "abc123" },
            paths: { committed: [], staged: [], unstaged: [], untracked: [] },
          }),
        };
      }
      if (cmd.startsWith("cd /workspace &&") && cmd.includes("TMPIDX=")) {
        return { output: "ERROR_NO_INDEX\n" };
      }
      if (cmd.includes("SMOKE_EXIT=")) return { output: `SMOKE_EXIT=${smokeExit}\n` };
      if (cmd === "git rev-parse HEAD") return { output: "abc123\n" };
      if (cmd === "git status --porcelain") return { output: "" };
      if (cmd === "git log --oneline -5") return { output: "abc123 latest change\n" };
      if (cmd === "git diff") return { output: "diff --git a/src/foo.js b/src/foo.js\n" };
      if (cmd === "git ls-files --others --exclude-standard") return { output: "" };
      return { output: "" };
    };

    function captureStdout() {
      const chunks = [];
      const orig = process.stdout.write;
      process.stdout.write = (chunk) => {
        chunks.push(String(chunk));
        return true;
      };
      return {
        text() { return chunks.join(""); },
        restore() { process.stdout.write = orig; },
      };
    }

    return {
      tmp, cwd, stateDir, chainDir,
      makeFakeCallTool,
      fakeDispatch,
      captureStdout,
      cleanup() {
        if (prevStateEnv === undefined) delete process.env.KUSABI_STATE_DIR;
        else process.env.KUSABI_STATE_DIR = prevStateEnv;
        fs.rmSync(tmp, { recursive: true, force: true });
      },
    };
  }

  it("chain dispatch with all-green smoke prints warning and persists smokeObservation with observesChange: false", async () => {
    const h = makeHarness();
    const stdout = h.captureStdout();
    try {
      const brief =
        "# Task\n\nOrchestrator: test-model | session s-1 | 2026-08-23\n\n" +
        "## Deliverables\n\n- `src/foo.js`\n\n" +
        "## Smoke\n\n- `npm test`\n";
      const flags = { container: "cid-1", "chain-id": "chain-test", keepServe: true };
      const callTool = h.makeFakeCallTool(0);

      await runChainLifecycle(h.cwd, { flags, text: brief, orchestrator: null }, {
        inject: {
          callTool,
          dispatchWithFallback: h.fakeDispatch,
          reviewDispatchWithFallback: h.fakeDispatch,
          reworkDispatchWithFallback: h.fakeDispatch,
        },
      });

      assert.match(stdout.text(), /warning: no `## Smoke` line can observe this change/);

      const chainJson = JSON.parse(fs.readFileSync(path.join(h.chainDir, "chain.json"), "utf8"));
      assert.deepEqual(chainJson.smokeObservation, {
        lines: 1,
        baselineRed: 0,
        observesChange: false,
      });
    } finally {
      stdout.restore();
      h.cleanup();
    }
  });

  it("chain dispatch with one measured baseline-red line prints no warning and persists observesChange: true", async () => {
    const h = makeHarness();
    const stdout = h.captureStdout();
    try {
      const brief =
        "# Task\n\nOrchestrator: test-model | session s-1 | 2026-08-23\n\n" +
        "## Deliverables\n\n- `src/foo.js`\n\n" +
        "## Smoke\n\n- `npm test` baseline-red\n";
      const flags = { container: "cid-1", "chain-id": "chain-test", keepServe: true };
      const callTool = h.makeFakeCallTool(1);

      await runChainLifecycle(h.cwd, { flags, text: brief, orchestrator: null }, {
        inject: {
          callTool,
          dispatchWithFallback: h.fakeDispatch,
          reviewDispatchWithFallback: h.fakeDispatch,
          reworkDispatchWithFallback: h.fakeDispatch,
        },
      });

      assert.doesNotMatch(stdout.text(), /warning: no `## Smoke` line can observe this change/);

      const chainJson = JSON.parse(fs.readFileSync(path.join(h.chainDir, "chain.json"), "utf8"));
      assert.deepEqual(chainJson.smokeObservation, {
        lines: 1,
        baselineRed: 1,
        observesChange: true,
      });
    } finally {
      stdout.restore();
      h.cleanup();
    }
  });

  it("persistChainState records smokeObservation: null when not provided or null", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-persist-test-"));
    const chainDir = path.join(tmp, "chain-test");
    fs.mkdirSync(chainDir, { recursive: true });
    try {
      persistChainState({
        chainDir,
        round: 1,
        roundRecord: {},
        records: [],
        chainId: "chain-test",
        container: "cid-1",
        brief: "# Brief",
        smokeObservation: null,
      });
      const chainJson = JSON.parse(fs.readFileSync(path.join(chainDir, "chain.json"), "utf8"));
      assert.equal(chainJson.smokeObservation, null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("chain-resume passes through recorded smokeObservation without re-measuring baseline", () => {
    const chainCmdSource = fs.readFileSync(path.join(import.meta.dirname, "chain-cmd.mjs"), "utf8");
    const resumeFn = chainCmdSource.slice(
      chainCmdSource.indexOf("export async function cmdChainResume("),
    );
    assert.ok(!resumeFn.includes("measureSmokeBaseline("), "resume must not call measureSmokeBaseline");
    assert.ok(resumeFn.includes("smokeObservation: chainJson.smokeObservation ?? null"), "resume passes through recorded smokeObservation");
  });
});

describe("D. task-detach warning on/off", () => {
  function taskDetachHarness() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-taskdetach-"));
    const cwd = path.join(tmp, "ws");
    fs.mkdirSync(cwd, { recursive: true });
    const prevStateEnv = process.env.KUSABI_STATE_DIR;
    process.env.KUSABI_STATE_DIR = path.join(tmp, "state");
    const fakeSpawn = () => ({ pid: 12345, unref() {} });

    function captureStdout() {
      const chunks = [];
      const orig = process.stdout.write;
      process.stdout.write = (chunk) => {
        chunks.push(String(chunk));
        return true;
      };
      return {
        text() { return chunks.join(""); },
        restore() { process.stdout.write = orig; },
      };
    }

    return {
      tmp, cwd, fakeSpawn, captureStdout,
      cleanup() {
        if (prevStateEnv === undefined) delete process.env.KUSABI_STATE_DIR;
        else process.env.KUSABI_STATE_DIR = prevStateEnv;
        fs.rmSync(tmp, { recursive: true, force: true });
      },
    };
  }

  it("task-detach --phase implement prints warning when smoke passes with no baselineRed", async () => {
    const h = taskDetachHarness();
    const stdout = h.captureStdout();
    try {
      const brief =
        "# Task\n\nOrchestrator: test-model | session s-1 | 2026-08-23\n\n" +
        "## Deliverables\n\n- `src/foo.js`\n\n" +
        "## Smoke\n\n- `npm test`\n";
      const callTool = async () => ({ output: "SMOKE_EXIT=0\n" });
      await cmdTaskDetach(h.cwd, {
        flags: { container: "cid-1", phase: "implement" },
        text: brief,
      }, {
        spawn: h.fakeSpawn,
        callTool,
        stateRoot: path.join(h.tmp, "state"),
      });
      assert.match(stdout.text(), /warning: no `## Smoke` line can observe this change/);
    } finally {
      stdout.restore();
      h.cleanup();
    }
  });

  it("task-detach with other phase (--phase review) prints NO warning", async () => {
    const h = taskDetachHarness();
    const stdout = h.captureStdout();
    try {
      const brief =
        "# Task\n\nOrchestrator: test-model | session s-1 | 2026-08-23\n\n" +
        "## Smoke\n\n- `npm test`\n";
      const callTool = async () => ({ output: "SMOKE_EXIT=0\n" });
      await cmdTaskDetach(h.cwd, {
        flags: { container: "cid-1", phase: "review" },
        text: brief,
      }, {
        spawn: h.fakeSpawn,
        callTool,
        stateRoot: path.join(h.tmp, "state"),
      });
      assert.doesNotMatch(stdout.text(), /warning: no `## Smoke` line can observe this change/);
    } finally {
      stdout.restore();
      h.cleanup();
    }
  });
});

describe("E. Metrics ingest, database migration, and report line", () => {
  it("chain-ingest extracts smokeLines, smokeBaselineRed, smokeObservesChange from smokeObservation", () => {
    const chainJsonWithSmoke = {
      chainId: "chain-smoke-1",
      brief: "# Task\n\n## Smoke\n\n- `npm test`\n",
      records: [],
      smokeObservation: {
        lines: 3,
        baselineRed: 1,
        observesChange: true,
      },
    };
    const parsedWith = parseChainRecord(chainJsonWithSmoke);
    assert.equal(parsedWith.chainRow.smokeLines, 3);
    assert.equal(parsedWith.chainRow.smokeBaselineRed, 1);
    assert.equal(parsedWith.chainRow.smokeObservesChange, 1);

    const chainJsonNoSmoke = {
      chainId: "chain-smoke-2",
      brief: "# Task\n\n",
      records: [],
      smokeObservation: null,
    };
    const parsedNo = parseChainRecord(chainJsonNoSmoke);
    assert.equal(parsedNo.chainRow.smokeLines, null);
    assert.equal(parsedNo.chainRow.smokeBaselineRed, null);
    assert.equal(parsedNo.chainRow.smokeObservesChange, null);

    const chainJsonLegacy = {
      chainId: "chain-smoke-3",
      brief: "# Task\n\n",
      records: [],
    };
    const parsedLegacy = parseChainRecord(chainJsonLegacy);
    assert.equal(parsedLegacy.chainRow.smokeLines, null);
    assert.equal(parsedLegacy.chainRow.smokeBaselineRed, null);
    assert.equal(parsedLegacy.chainRow.smokeObservesChange, null);
  });

  it("migrates a pre-existing metrics.db on open, adding smoke columns with NULL defaults", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-db-test-"));
    const dbPath = path.join(tmp, "metrics.db");
    try {
      const metricsDbSource = fs.readFileSync(path.join(import.meta.dirname, "metrics-db.mjs"), "utf8");
      const schemaMatch = metricsDbSource.match(/const SCHEMA = `([\s\S]*?)`;/);
      const legacySchema = schemaMatch[1]
        .replace("  smoke_lines INTEGER,\n", "")
        .replace("  smoke_baseline_red INTEGER,\n", "")
        .replace("  smoke_observes_change INTEGER,\n", "");

      const legacyDb = new DatabaseSync(dbPath);
      legacyDb.exec(legacySchema);
      legacyDb.prepare("INSERT INTO chain (chain_id, orch_model, orch_date) VALUES (?, ?, ?)")
        .run("chain-old", "claude-opus-5", "2026-08-01");
      if (typeof legacyDb.close === "function") legacyDb.close();

      const db = openMetricsDb(dbPath);
      const row = db.prepare("SELECT * FROM chain WHERE chain_id = ?").get("chain-old");
      assert.equal(row.smoke_lines, null);
      assert.equal(row.smoke_baseline_red, null);
      assert.equal(row.smoke_observes_change, null);

      upsertChain(db, {
        chainId: "chain-new",
        orchModel: "claude-opus-5",
        smokeLines: 2,
        smokeBaselineRed: 1,
        smokeObservesChange: 1,
      });
      const newRow = db.prepare("SELECT smoke_lines, smoke_baseline_red, smoke_observes_change FROM chain WHERE chain_id = ?")
        .get("chain-new");
      assert.equal(newRow.smoke_lines, 2);
      assert.equal(newRow.smoke_baseline_red, 1);
      assert.equal(newRow.smoke_observes_change, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("metrics-report shows the smoke_observes_change line split by yes / no / unknown", () => {
    const db = openMetricsDb(":memory:");

    // chain 1: yes (observes change) -> accept
    upsertChain(db, {
      chainId: "c-yes",
      orchModel: "claude-opus-5",
      orchDate: "2026-08-01",
      briefChars: 100,
      briefHasDeliverables: 1,
      smokeLines: 2,
      smokeBaselineRed: 1,
      smokeObservesChange: 1,
    });
    upsertRound(db, {
      chainId: "c-yes",
      round: 1,
      startedAt: "2026-08-01T10:00:00.000Z",
      startedMs: Date.parse("2026-08-01T10:00:00.000Z"),
      disposition: "accept",
    });

    // chain 2: no (does not observe change) -> escalate
    upsertChain(db, {
      chainId: "c-no",
      orchModel: "claude-opus-5",
      orchDate: "2026-08-01",
      briefChars: 100,
      briefHasDeliverables: 1,
      smokeLines: 2,
      smokeBaselineRed: 0,
      smokeObservesChange: 0,
    });
    upsertRound(db, {
      chainId: "c-no",
      round: 1,
      startedAt: "2026-08-01T11:00:00.000Z",
      startedMs: Date.parse("2026-08-01T11:00:00.000Z"),
      disposition: "escalate",
    });

    // chain 3: unknown (legacy or no smoke) -> accept
    upsertChain(db, {
      chainId: "c-unk",
      orchModel: "claude-opus-5",
      orchDate: "2026-08-01",
      briefChars: 100,
      briefHasDeliverables: 1,
      smokeLines: null,
      smokeBaselineRed: null,
      smokeObservesChange: null,
    });
    upsertRound(db, {
      chainId: "c-unk",
      round: 1,
      startedAt: "2026-08-01T12:00:00.000Z",
      startedMs: Date.parse("2026-08-01T12:00:00.000Z"),
      disposition: "accept",
    });

    const report = computeReport(db, { dbPath: ":memory:" });
    const block = report.briefOutcome.find((b) => b.orchModel === "claude-opus-5");
    assert.ok(block);
    assert.ok(block.smokeObservesChange);
    assert.equal(block.smokeObservesChange.yes.total, 1);
    assert.equal(block.smokeObservesChange.yes.byDisp.accept, 1);
    assert.equal(block.smokeObservesChange.no.total, 1);
    assert.equal(block.smokeObservesChange.no.byDisp.escalate, 1);
    assert.equal(block.smokeObservesChange.unknown.total, 1);
    assert.equal(block.smokeObservesChange.unknown.byDisp.accept, 1);

    const text = renderReportText(report);
    assert.match(text, /smoke_observes_change:\s+yes 1 \(accept 1\),\s+no 1 \(escalate 1\),\s+unknown 1 \(accept 1\)/);

    const json = JSON.parse(renderReportJson(report));
    const jsonBlock = json.briefOutcome.find((b) => b.orchModel === "claude-opus-5");
    assert.deepEqual(jsonBlock.smokeObservesChange, block.smokeObservesChange);
  });
});
