import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { KNOWN_TOOLS, extractToolStats, normalizeToolStats, listToolStats } from "./tool-stats.mjs";
import {
  openMetricsDb,
  upsertJob,
  replaceToolStatsForJob,
  countRows,
  getSourceFile,
} from "./metrics-db.mjs";
import { ingestJobDirectory } from "./chain-ingest.mjs";
import { computeReport, renderReportText, renderReportJson } from "./metrics-report.mjs";

function toolPart(id, tool, status) {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id,
        type: "tool",
        tool,
        state: { status },
      },
    },
  };
}

function line(obj) {
  return JSON.stringify(obj);
}

describe("extractToolStats — fold per part.id", () => {
  it("pending → running → completed of one call yields count=1 success=1 failure=0", () => {
    const stats = extractToolStats([
      line(toolPart("prt_1", "sunaba_read_file_range", "pending")),
      line(toolPart("prt_1", "sunaba_read_file_range", "running")),
      line(toolPart("prt_1", "sunaba_read_file_range", "completed")),
    ]);
    assert.deepEqual(stats["sunaba_read_file_range"], { count: 1, success: 1, failure: 0 });
    assert.equal(Object.keys(stats).length, 1);
  });

  it("a part with no terminal state by end of stream counts as failure", () => {
    const stats = extractToolStats([
      line(toolPart("prt_hang", "sunaba_sandbox_exec", "pending")),
      line(toolPart("prt_hang", "sunaba_sandbox_exec", "running")),
    ]);
    assert.deepEqual(stats["sunaba_sandbox_exec"], { count: 1, success: 0, failure: 1 });
  });

  it("a terminal error status is failure, not success", () => {
    const stats = extractToolStats([
      line(toolPart("prt_e", "bash", "pending")),
      line(toolPart("prt_e", "bash", "error")),
    ]);
    assert.deepEqual(stats.bash, { count: 1, success: 0, failure: 1 });
  });

  it("two distinct part ids of the same tool are two calls", () => {
    const stats = extractToolStats([
      line(toolPart("prt_a", "sunaba_edit_file", "completed")),
      line(toolPart("prt_b", "sunaba_edit_file", "error")),
    ]);
    assert.deepEqual(stats["sunaba_edit_file"], { count: 2, success: 1, failure: 1 });
  });

  it("ignores non-tool parts and malformed lines", () => {
    const stats = extractToolStats([
      line({ type: "session.idle" }),
      "{not json",
      "",
      line({
        type: "message.part.updated",
        properties: { part: { id: "prt_t", type: "text", text: "hello" } },
      }),
      line(toolPart("prt_ok", "write", "completed")),
    ]);
    assert.deepEqual(stats.write, { count: 1, success: 1, failure: 0 });
    assert.equal(Object.keys(stats).length, 1);
  });

  it("accepts already-parsed objects and a generator", () => {
    function* events() {
      yield toolPart("prt_1", "skill", "completed");
    }
    const stats = extractToolStats(events());
    assert.deepEqual(stats.skill, { count: 1, success: 1, failure: 0 });
  });

  it("accepts a whole NDJSON string", () => {
    const raw = [
      line(toolPart("prt_1", "task", "pending")),
      line(toolPart("prt_1", "task", "completed")),
    ].join("\n");
    const stats = extractToolStats(raw);
    assert.deepEqual(stats.task, { count: 1, success: 1, failure: 0 });
  });

  it("null / undefined input yields an empty object, not a throw", () => {
    assert.deepEqual(extractToolStats(null), {});
    assert.deepEqual(extractToolStats(undefined), {});
  });
});

describe("normalizeToolStats / listToolStats", () => {
  it("always contains every KNOWN_TOOLS member, zero-filled when unused", () => {
    const normalized = normalizeToolStats({});
    for (const tool of KNOWN_TOOLS) {
      assert.deepEqual(normalized[tool], { count: 0, success: 0, failure: 0 }, tool);
    }
    assert.equal(Object.keys(normalized).length, KNOWN_TOOLS.length);
  });

  it("preserves observed unknown tools under their observed name", () => {
    const normalized = normalizeToolStats({
      sunaba_read_file_range: { count: 2, success: 2, failure: 0 },
      some_future_tool: { count: 1, success: 0, failure: 1 },
    });
    assert.deepEqual(normalized["sunaba_read_file_range"], { count: 2, success: 2, failure: 0 });
    assert.deepEqual(normalized.some_future_tool, { count: 1, success: 0, failure: 1 });
    assert.deepEqual(normalized.bash, { count: 0, success: 0, failure: 0 });
  });

  it("lists known tools first, then unknown-but-observed names sorted", () => {
    const rows = listToolStats({
      zz_unknown: { count: 1, success: 1, failure: 0 },
      aa_unknown: { count: 1, success: 0, failure: 1 },
    });
    assert.equal(rows[0].tool, KNOWN_TOOLS[0]);
    assert.equal(rows[KNOWN_TOOLS.length - 1].tool, KNOWN_TOOLS[KNOWN_TOOLS.length - 1]);
    assert.equal(rows[KNOWN_TOOLS.length].tool, "aa_unknown");
    assert.equal(rows[KNOWN_TOOLS.length + 1].tool, "zz_unknown");
  });

  it("KNOWN_TOOLS is frozen", () => {
    assert.ok(Object.isFrozen(KNOWN_TOOLS));
  });
});

function makeTempStateRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-tool-stats-"));
}

function writeJob(stateRoot, workspaceSlug, job) {
  const dir = path.join(stateRoot, workspaceSlug, "jobs", job.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(job), "utf8");
  return dir;
}

function completedJob(id, extra = {}) {
  return {
    id,
    kind: "task",
    title: "t",
    status: "completed",
    startedAt: "2026-08-01T10:00:00.000Z",
    finishedAt: "2026-08-01T10:01:00.000Z",
    stats: { steps: 1 },
    stopReason: "completed",
    ...extra,
  };
}

describe("ingest — tool_stat table", () => {
  it("openMetricsDb creates tool_stat and is safe to call twice", () => {
    const db = openMetricsDb(":memory:");
    assert.equal(countRows(db, "tool_stat"), 0);
    assert.doesNotThrow(() => openMetricsDb(":memory:"));
  });

  it("replaceToolStatsForJob is idempotent: same job twice leaves identical rows", () => {
    const db = openMetricsDb(":memory:");
    const stats = { bash: { count: 2, success: 1, failure: 1 } };
    replaceToolStatsForJob(db, "job-a", stats);
    replaceToolStatsForJob(db, "job-a", stats);
    const rows = db.prepare("SELECT job_id, tool, count, success, failure FROM tool_stat ORDER BY tool").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].job_id, "job-a");
    assert.equal(rows[0].tool, "bash");
    assert.equal(rows[0].count, 2);
    assert.equal(rows[0].success, 1);
    assert.equal(rows[0].failure, 1);
  });

  it("ingesting the same job twice leaves identical tool_stat rows", () => {
    const stateRoot = makeTempStateRoot();
    const dir = writeJob(stateRoot, "ws1", completedJob("job-fold"));
    const events = [
      line(toolPart("prt_1", "sunaba_read_file_range", "pending")),
      line(toolPart("prt_1", "sunaba_read_file_range", "running")),
      line(toolPart("prt_1", "sunaba_read_file_range", "completed")),
      line(toolPart("prt_2", "bash", "error")),
    ].join("\n") + "\n";
    fs.writeFileSync(path.join(dir, "events.ndjson"), events, "utf8");

    const db = openMetricsDb(":memory:");
    const first = ingestJobDirectory(db, stateRoot);
    assert.equal(first.jobsIngested, 1);
    const snapshot = db.prepare(
      "SELECT job_id, tool, count, success, failure FROM tool_stat ORDER BY tool",
    ).all();
    assert.equal(snapshot.length, 2);

    // Force a re-read even if skip-cache would fire: bump job.json mtime by rewrite.
    const jobPath = path.join(dir, "job.json");
    const body = fs.readFileSync(jobPath, "utf8");
    fs.writeFileSync(jobPath, body, "utf8");
    const second = ingestJobDirectory(db, stateRoot);
    assert.ok(second.jobsIngested + second.jobsSkippedUnchanged >= 1);
    const again = db.prepare(
      "SELECT job_id, tool, count, success, failure FROM tool_stat ORDER BY tool",
    ).all();
    assert.deepEqual(again, snapshot);

    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  it("a job without events.ndjson does not abort the ingest run", () => {
    const stateRoot = makeTempStateRoot();
    writeJob(stateRoot, "ws1", completedJob("job-noevents"));
    const db = openMetricsDb(":memory:");
    const result = ingestJobDirectory(db, stateRoot);
    assert.equal(result.jobsIngested, 1);
    assert.equal(countRows(db, "job"), 1);
    assert.equal(countRows(db, "tool_stat"), 0);
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  it("an unreadable events.ndjson does not abort the ingest run", () => {
    const stateRoot = makeTempStateRoot();
    const dir = writeJob(stateRoot, "ws1", completedJob("job-bad-events"));
    // Directory named events.ndjson makes readFileSync throw EISDIR.
    fs.mkdirSync(path.join(dir, "events.ndjson"));
    const db = openMetricsDb(":memory:");
    const result = ingestJobDirectory(db, stateRoot);
    assert.equal(result.jobsIngested, 1, `ingest aborted: ${JSON.stringify(result)}`);
    assert.equal(countRows(db, "job"), 1);
    assert.equal(countRows(db, "tool_stat"), 0);
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  it("re-ingest after events.ndjson vanishes clears tool_stat and skip-cache converges", () => {
    const stateRoot = makeTempStateRoot();
    const dir = writeJob(stateRoot, "ws1", completedJob("job-vanish"));
    const eventsPath = path.join(dir, "events.ndjson");
    fs.writeFileSync(eventsPath, line(toolPart("prt_1", "bash", "completed")) + "\n", "utf8");

    const db = openMetricsDb(":memory:");
    const first = ingestJobDirectory(db, stateRoot);
    assert.equal(first.jobsIngested, 1);
    assert.equal(countRows(db, "tool_stat"), 1);
    assert.ok(getSourceFile(db, eventsPath));

    fs.unlinkSync(eventsPath);

    const second = ingestJobDirectory(db, stateRoot);
    assert.equal(second.jobsSkippedUnchanged, 0, "vanished events must force a re-read");
    assert.equal(second.jobsIngested, 1);
    assert.equal(countRows(db, "tool_stat"), 0, "stale tool_stat rows must be deleted");
    assert.equal(getSourceFile(db, eventsPath), undefined, "skip-cache row must be dropped");

    const third = ingestJobDirectory(db, stateRoot);
    assert.equal(third.jobsSkippedUnchanged, 1, "skip-cache must converge after the vanish is recorded");
    assert.equal(third.jobsIngested, 0);
    assert.equal(countRows(db, "tool_stat"), 0);

    fs.rmSync(stateRoot, { recursive: true, force: true });
  });
});

describe("report — per-tool section and failed-jobs breakdown", () => {
  function seedJob(db, row) {
    upsertJob(db, row);
  }

  it("zero-fills KNOWN_TOOLS in both all-jobs and failed-jobs maps", () => {
    const db = openMetricsDb(":memory:");
    seedJob(db, {
      jobId: "job-ok",
      status: "completed",
      stopReason: "completed",
      startedAt: "2026-08-01T10:00:00.000Z",
      startedMs: Date.parse("2026-08-01T10:00:00.000Z"),
    });
    replaceToolStatsForJob(db, "job-ok", {
      sunaba_read_file_range: { count: 1, success: 1, failure: 0 },
      mystery_tool: { count: 1, success: 0, failure: 1 },
    });
    const report = computeReport(db, { dbPath: ":memory:" });
    for (const tool of KNOWN_TOOLS) {
      assert.ok(report.toolStats.all[tool], `missing known tool in all: ${tool}`);
      assert.ok(report.toolStats.failedJobs[tool], `missing known tool in failedJobs: ${tool}`);
    }
    assert.equal(report.toolStats.all["sunaba_read_file_range"].count, 1);
    assert.equal(report.toolStats.all.mystery_tool.count, 1);
    assert.equal(report.toolStats.all.mystery_tool.failure, 1);
    // completed job is not in the failed breakdown
    assert.equal(report.toolStats.failedJobs["sunaba_read_file_range"].count, 0);
    assert.equal(report.toolStats.failedJobs.mystery_tool?.count ?? 0, 0);
  });

  it("failed-jobs breakdown excludes NULL stop_reason and does not count unknown as success", () => {
    const db = openMetricsDb(":memory:");
    // Legacy: NULL stop_reason, wrapper error — excluded from failed breakdown.
    seedJob(db, {
      jobId: "job-legacy",
      status: "error",
      startedAt: "2026-08-01T10:00:00.000Z",
      startedMs: Date.parse("2026-08-01T10:00:00.000Z"),
    });
    replaceToolStatsForJob(db, "job-legacy", {
      bash: { count: 3, success: 3, failure: 0 },
    });
    // Failed: stop_reason unknown.
    seedJob(db, {
      jobId: "job-unknown",
      status: "error",
      stopReason: "unknown",
      startedAt: "2026-08-01T11:00:00.000Z",
      startedMs: Date.parse("2026-08-01T11:00:00.000Z"),
    });
    replaceToolStatsForJob(db, "job-unknown", {
      bash: { count: 2, success: 1, failure: 1 },
    });
    // Success: stop_reason completed.
    seedJob(db, {
      jobId: "job-ok",
      status: "completed",
      stopReason: "completed",
      startedAt: "2026-08-01T12:00:00.000Z",
      startedMs: Date.parse("2026-08-01T12:00:00.000Z"),
    });
    replaceToolStatsForJob(db, "job-ok", {
      bash: { count: 5, success: 5, failure: 0 },
    });

    const report = computeReport(db, { dbPath: ":memory:" });
    // All jobs: 3+2+5 = 10
    assert.equal(report.toolStats.all.bash.count, 10);
    assert.equal(report.toolStats.all.bash.success, 9);
    assert.equal(report.toolStats.all.bash.failure, 1);
    // Failed only: job-unknown's 2. Legacy excluded. completed excluded.
    assert.equal(report.toolStats.failedJobs.bash.count, 2);
    assert.equal(report.toolStats.failedJobs.bash.success, 1);
    assert.equal(report.toolStats.failedJobs.bash.failure, 1);
    // unknown stop_reason is not treated as a successful job (its tools
    // appear in failedJobs, not omitted).
    assert.ok(report.toolStats.failedJobs.bash.count > 0);

    const text = renderReportText(report);
    assert.match(text, /Tool usage \(all jobs in window\)/);
    assert.match(text, /Tool usage \(failed jobs only\)/);
    const json = JSON.parse(renderReportJson(report));
    assert.equal(json.toolStats.failedJobs.bash.count, 2);
  });

  it("wrapper status non-completed with stop_reason completed still counts as failed", () => {
    const db = openMetricsDb(":memory:");
    seedJob(db, {
      jobId: "job-mismatch",
      status: "error",
      stopReason: "completed",
      startedAt: "2026-08-01T10:00:00.000Z",
      startedMs: Date.parse("2026-08-01T10:00:00.000Z"),
    });
    replaceToolStatsForJob(db, "job-mismatch", {
      edit: { count: 1, success: 1, failure: 0 },
    });
    const report = computeReport(db, { dbPath: ":memory:" });
    assert.equal(report.toolStats.failedJobs.edit.count, 1);
  });

  it("empty store still carries a zero-filled toolStats object for a stable schema", () => {
    const db = openMetricsDb(":memory:");
    const report = computeReport(db, { dbPath: ":memory:" });
    assert.equal(report.status, "empty");
    assert.ok(report.toolStats);
    for (const tool of KNOWN_TOOLS) {
      assert.deepEqual(report.toolStats.all[tool], { count: 0, success: 0, failure: 0 });
      assert.deepEqual(report.toolStats.failedJobs[tool], { count: 0, success: 0, failure: 0 });
    }
  });
});
