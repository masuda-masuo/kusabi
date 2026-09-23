// luna-evidence-inline.test.mjs — Luna/Sol seats see evidence CONTENT, not just envelope metadata
//
// Acceptance criteria:
// 1. renderEvidenceContents output contains each item's text and its path (Smoke line 1).
// 2. A missing file or sha mismatch throws, and the thrown message names the path (Smoke line 2).
// 3. End-to-end runLunaMission with fake codex harness: fake callTool returns an OBJECT
//    and first dispatch requests read_probe. Next coordinator prompt contains PROBE-MARKER
//    and not [object Object]. Sol-side assertion: prompt contains evidence item content.
// 4. missionEvidenceItems with a probe whose output is an object yields content that is
//    valid JSON of that object (Smoke line 3); string outputs are unchanged.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { stateDirFor, readJson } from "./state-paths.mjs";
import { renderEvidenceContents } from "./luna-prompt.mjs";
import { probeEvidenceText, missionEvidenceItems, realSolDispatch } from "./luna-sol-gate.mjs";
import { runLunaMission } from "./luna-driver.mjs";

const MISSION_BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-evidence-test | 2026-09-23",
  "",
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/luna-wait.mjs` — the #530 wait surface.",
  "",
  "## Smoke",
  "",
  "- `node --test plugins/kusabi/scripts/luna-wait.test.mjs`",
].join("\n");

const DEFAULT_SEATS = {
  coordinator: { provider: "codex", model: "gpt-5.6-luna" },
  auditor: { provider: "codex", model: "gpt-5.6-sol" },
};

const DEFAULT_BUDGET = { maxChains: 3, maxAttempts: 2, maxProbes: 5, maxConsults: 3, maxRework: 1 };

const FAKE_CODEX_TEMPLATE = `#!/usr/bin/env node
import fs from "node:fs";
const emit = (obj) => fs.writeSync(1, JSON.stringify(obj) + "\\n");
const stdinText = fs.readFileSync(0, "utf8");
const firstHash = (stdinText.match(/[0-9a-f]{64}/) || [])[0] || "f".repeat(64);

if (stdinText.includes("Sol auditor seat")) {
  const gateMatch = stdinText.match(/audit gate ([^ ,]+)/);
  const gateId = gateMatch ? gateMatch[1] : "gate-1";
  const verdictText = JSON.stringify({
    type: "verdict",
    schema_version: 1,
    gate_id: gateId,
    envelope_sha256: firstHash,
    verdict: "clear",
    summary: "sol:clear",
  });
  emit({ type: "thread.started", thread_id: "__THREAD__" });
  emit({ type: "item.completed", item: { type: "agent_message", text: verdictText } });
  emit({ type: "turn.completed", usage: {} });
  process.exit(0);
}

const counterFile = process.env.FAKE_CODEX_COUNTER_FILE;
let n = 1;
try { n = Number(fs.readFileSync(counterFile, "utf8")) + 1; } catch (err) {}
fs.writeFileSync(counterFile, String(n), "utf8");

const probeRequest = JSON.stringify({
  action: "read_probe",
  envelope_sha256: firstHash,
  tool: "read_file_range",
  path: "probe-target.txt",
});
const escalate = JSON.stringify({
  action: "escalate_to_host",
  envelope_sha256: firstHash,
  reason: "evidence checked",
});

const text = n === 1 ? probeRequest : escalate;
emit({ type: "thread.started", thread_id: "__THREAD__" });
emit({ type: "item.completed", item: { type: "agent_message", text } });
emit({ type: "turn.completed", usage: {} });
process.exit(0);
`;

function fakeCodexContext() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-luna-evidence-inline-codex-"));
  const binPath = path.join(tmp, "fake-codex.mjs");
  fs.writeFileSync(binPath, FAKE_CODEX_TEMPLATE, "utf8");
  fs.chmodSync(binPath, 0o755);
  const counterFile = path.join(tmp, "codex-counter");
  const saved = {
    CODEX_BIN: process.env.CODEX_BIN,
    KUSABI_STATE_DIR: process.env.KUSABI_STATE_DIR,
    FAKE_CODEX_COUNTER_FILE: process.env.FAKE_CODEX_COUNTER_FILE,
    HOME: process.env.HOME,
    CODEX_HOME: process.env.CODEX_HOME,
  };
  process.env.CODEX_BIN = binPath;
  process.env.FAKE_CODEX_COUNTER_FILE = counterFile;
  process.env.KUSABI_STATE_DIR = path.join(tmp, "state");
  process.env.HOME = path.join(tmp, "home");
  process.env.CODEX_HOME = path.join(tmp, "operator-codex-home");
  fs.mkdirSync(process.env.HOME, { recursive: true });
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  const cwd = path.join(tmp, "work");
  fs.mkdirSync(cwd, { recursive: true });
  return {
    tmp,
    cwd,
    stateDir: stateDirFor(cwd),
    counterFile,
    restore() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

describe("criterion 1: renderEvidenceContents output contains each item's text and its path", () => {
  it("inlines evidence items with paths and backtick fencing (Smoke line 1)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ev-inline-c1-"));
    const evDir = path.join(tmp, "evidence");
    fs.mkdirSync(evDir, { recursive: true });
    const text1 = "Chain chain-x accepted at round 1.\n";
    const text2 = "```js\nconst x = 1;\n```\n";
    fs.writeFileSync(path.join(evDir, "worker-report-0.txt"), text1, "utf8");
    fs.writeFileSync(path.join(evDir, "code-sample.txt"), text2, "utf8");

    const sha1 = createHash("sha256").update(text1).digest("hex");
    const sha2 = createHash("sha256").update(text2).digest("hex");

    const envelope = {
      envelope_sha256: "0".repeat(64),
      items: [
        {
          role: "worker_report",
          source: "attempt-1",
          sha256: sha1,
          bytes: Buffer.byteLength(text1),
          path: "evidence/worker-report-0.txt",
        },
        {
          role: "probe_raw",
          source: "probe-0",
          sha256: sha2,
          bytes: Buffer.byteLength(text2),
          path: "evidence/code-sample.txt",
        },
      ],
    };

    const out = renderEvidenceContents(envelope, tmp);
    assert.equal(typeof out, "string");
    assert.ok(out.includes("accepted at round 1"));
    assert.ok(out.includes("evidence/worker-report-0.txt"));
    assert.ok(out.includes("evidence/code-sample.txt"));
    assert.ok(out.includes("role: worker_report"));
    assert.ok(out.includes("source: attempt-1"));
    // Ensure fence for code-sample with ``` is at least 4 backticks
    assert.ok(out.includes("````"));
  });

  it("includes truncation metadata in header when item is truncated", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ev-inline-trunc-"));
    const evDir = path.join(tmp, "evidence");
    fs.mkdirSync(evDir, { recursive: true });
    const text = "partial text";
    fs.writeFileSync(path.join(evDir, "trunc-report.txt"), text, "utf8");
    const sha = createHash("sha256").update(text).digest("hex");

    const envelope = {
      envelope_sha256: "0".repeat(64),
      items: [
        {
          role: "worker_report",
          source: "attempt-2",
          sha256: sha,
          bytes: Buffer.byteLength(text),
          path: "evidence/trunc-report.txt",
          truncated: true,
          omitted_bytes: 500,
        },
      ],
    };

    const out = renderEvidenceContents(envelope, tmp);
    assert.ok(out.includes("truncated, 500 bytes omitted"));
    assert.ok(out.includes("partial text"));
  });

  it("returns empty string when envelope has no items", () => {
    assert.equal(renderEvidenceContents({ items: [] }, "/tmp"), "");
    assert.equal(renderEvidenceContents({}, "/tmp"), "");
    assert.equal(renderEvidenceContents(null, "/tmp"), "");
  });
});

describe("criterion 2: fail-closed on missing file or sha mismatch", () => {
  it("throws with path when evidence file is missing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ev-inline-missing-"));
    const envelope = {
      envelope_sha256: "0".repeat(64),
      items: [
        {
          role: "probe_raw",
          source: "probe-0",
          sha256: "a".repeat(64),
          bytes: 10,
          path: "evidence/missing-file.txt",
        },
      ],
    };
    assert.throws(
      () => renderEvidenceContents(envelope, tmp),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("evidence/missing-file.txt"));
        return true;
      },
    );
  });

  it("throws with path when sha mismatch occurs (Smoke line 2)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ev-inline-tampered-"));
    const evDir = path.join(tmp, "evidence");
    fs.mkdirSync(evDir, { recursive: true });
    fs.writeFileSync(path.join(evDir, "tampered.txt"), "tampered content", "utf8");
    const envelope = {
      envelope_sha256: "0".repeat(64),
      items: [
        {
          role: "probe_raw",
          source: "probe-0",
          sha256: "f".repeat(64),
          bytes: 16,
          path: "evidence/tampered.txt",
        },
      ],
    };
    assert.throws(
      () => renderEvidenceContents(envelope, tmp),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("evidence/tampered.txt"));
        return true;
      },
    );
  });
});

describe("criterion 4: probe serialization helper and missionEvidenceItems", () => {
  it("probeEvidenceText returns string unchanged, empty string for null/undefined, and JSON for objects", () => {
    assert.equal(probeEvidenceText("raw string output"), "raw string output");
    assert.equal(probeEvidenceText(null), "");
    assert.equal(probeEvidenceText(undefined), "");

    const obj = { content: "probe result", total_lines: 5, ok: true };
    const serialized = probeEvidenceText(obj);
    assert.equal(serialized, JSON.stringify(obj, null, 2));
    assert.deepEqual(JSON.parse(serialized), obj);
  });

  it("missionEvidenceItems serializes object probe outputs as valid JSON and leaves string probes unchanged (Smoke line 3)", () => {
    const probeObj = { content: "line one", total_lines: 1 };
    const items = missionEvidenceItems({
      brief: "mission brief text",
      record: {
        probes: [
          { output: probeObj },
          { output: "string probe output" },
        ],
      },
    });

    const probeRaw0 = items.find((i) => i.path === "evidence/probe-0.txt");
    assert.ok(probeRaw0);
    assert.ok(!probeRaw0.content.includes("[object Object]"));
    assert.ok(probeRaw0.content.includes("line one"));
    assert.deepEqual(JSON.parse(probeRaw0.content), probeObj);

    const probeRaw1 = items.find((i) => i.path === "evidence/probe-1.txt");
    assert.ok(probeRaw1);
    assert.equal(probeRaw1.content, "string probe output");
  });
});

describe("criterion 3: end-to-end runLunaMission with inlined evidence content and Sol-side verification", () => {
  let ctx;
  beforeEach(() => {
    ctx = fakeCodexContext();
  });
  afterEach(() => {
    ctx.restore();
  });

  function readMission() {
    const missionsDir = path.join(ctx.stateDir, "missions");
    const ids = fs.existsSync(missionsDir)
      ? fs.readdirSync(missionsDir).filter((n) => n.startsWith("mission-"))
      : [];
    assert.equal(ids.length, 1, `exactly one mission dir expected in ${missionsDir}, got ${ids.join(",")}`);
    const missionDir = path.join(missionsDir, ids[0]);
    return { missionId: ids[0], missionDir, record: readJson(path.join(missionDir, "mission.json")) };
  }

  function codexJobRecords() {
    const jobsDir = path.join(ctx.stateDir, "jobs");
    if (!fs.existsSync(jobsDir)) return [];
    return fs
      .readdirSync(jobsDir)
      .filter((n) => n.startsWith("job-"))
      .map((id) => ({ id, job: readJson(path.join(jobsDir, id, "job.json")) }));
  }

  function jobPrompt(jobId) {
    return fs.readFileSync(path.join(ctx.stateDir, "jobs", jobId, "prompt.md"), "utf8");
  }

  it("coordinator sees probe object as inlined JSON (contains PROBE-MARKER, no [object Object]) and Sol sees inlined evidence", async () => {
    const missionFile = path.join(ctx.cwd, "MISSION.md");
    fs.writeFileSync(missionFile, MISSION_BRIEF, "utf8");

    const chain = { calls: [], run: async (cw, input) => { chain.calls.push({ cw, input }); return "chain"; } };
    const notifications = [];

    const result = await runLunaMission({
      cwd: ctx.cwd,
      missionFile,
      brief: MISSION_BRIEF,
      container: "test-cid",
      ...DEFAULT_SEATS,
      allowSubstitute: false,
      budget: DEFAULT_BUDGET,
      inject: {
        runChainLifecycle: chain.run,
        callTool: async () => ({ content: "PROBE-MARKER", total_lines: 1 }),
        notifyMissionTerminal: async (info) => { notifications.push(info); },
        guardedServeStop: async () => {},
      },
    });

    const mission = readMission();
    assert.match(result, /disposition=host-handoff/);
    assert.equal(mission.record.disposition, "host-handoff");

    const jobs = codexJobRecords();
    assert.equal(jobs.length, 2, "exactly two coordinator dispatch jobs");

    // The first job requested the probe
    const prompt1 = jobPrompt(jobs[0].id);
    assert.ok(prompt1.includes("Evidence contents (bound by the envelope hash above):"));

    // The second job prompt must contain PROBE-MARKER and must NOT contain [object Object]
    const prompt2 = jobPrompt(jobs[1].id);
    assert.ok(
      prompt2.includes("PROBE-MARKER"),
      "the NEXT coordinator dispatch prompt must contain PROBE-MARKER",
    );
    assert.ok(
      !prompt2.includes("[object Object]"),
      "the NEXT coordinator dispatch prompt must NOT contain [object Object]",
    );
    assert.ok(
      prompt2.includes("Evidence contents (bound by the envelope hash above):"),
      "the NEXT coordinator dispatch prompt must contain the evidence contents section",
    );

    // Sol-side assertion: prompt passed to realSolDispatch contains content of at least one evidence item
    const envelope2 = readJson(path.join(mission.missionDir, "evidence", "envelope-2.json"));
    const solResult = await realSolDispatch({
      cwd: ctx.cwd,
      missionId: mission.missionId,
      missionDir: mission.missionDir,
      envelope: envelope2,
      gate: { gateId: "gate-sol-test", phase: "post-chain" },
      auditor: DEFAULT_SEATS.auditor,
    });
    assert.equal(typeof solResult, "string");

    const allJobs = codexJobRecords();
    const solJobs = allJobs.filter((j) => j.job.phase === "luna-audit");
    assert.equal(solJobs.length, 1, "exactly one Sol dispatch job");
    const solPrompt = jobPrompt(solJobs[0].id);

    assert.ok(
      solPrompt.includes("PROBE-MARKER"),
      "the Sol dispatch prompt must contain the probe evidence content",
    );
    assert.ok(
      solPrompt.includes("Evidence contents (bound by the envelope hash above):"),
      "the Sol dispatch prompt must contain the evidence contents section",
    );
    assert.ok(
      !solPrompt.includes("[object Object]"),
      "the Sol dispatch prompt must NOT contain [object Object]",
    );
  });
});
