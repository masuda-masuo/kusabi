// luna-brief-corrections-clean-prompt.test.mjs — dev regression pin for the
// review finding on the bounded brief-correction feedback (kusabi #553
// follow-up): `realCoordinatorDispatch` spread an empty corrections section
// for clean missions and still added an unconditional trailing blank line,
// changing the clean prompt bytes despite the contract that a clean mission's
// prompt stays byte-identical to the pre-change prompt.
//
// This file is scaffolding (NOT a frozen acceptance test): it pins the
// reported regression — the exact blank-line structure around the
// conditional corrections section in the REAL coordinator prompt — without
// touching the frozen luna-brief-corrections(-seam).test.mjs contract.
//
//   - clean mission: the budget block is followed by EXACTLY ONE blank line
//     and then the contract heading (the pre-change shape); an extra blank
//     line from a re-introduced unconditional separator fails the regex;
//   - corrected mission: the section is framed by a blank line on EACH side
//     (budget -> blank -> header -> blank -> validator detail -> blank ->
//     contract heading).
//
// The prompt is read from the persisted job record (prompt.md) of a REAL
// coordinator dispatch through a fake `codex` binary behind CODEX_BIN — the
// same observable-seam pattern the frozen seam tests use.  Nothing calls the
// real Codex CLI or touches a real state root.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { stateDirFor, readJson } from "./state-paths.mjs";

// The mission brief stays clean of "correction" and of the validator markers
// so a false positive can never come from the embedded brief.
const MISSION_BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-clean-prompt | 2026-09-23",
  "",
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/luna-wait.mjs` \u2014 the #530 wait surface.",
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

// The fake answers the FIRST dispatch with a run_chain carrying an invalid
// inner brief (missing `## Deliverables`), and every later dispatch with a
// valid escalate_to_host — so the driver records one correction and the NEXT
// real prompt is the corrected-mission artifact.  A counter file (per test)
// keys the two behaviors; the fake never touches the real CLI.
const FAKE_CODEX_TEMPLATE = `#!/usr/bin/env node
import fs from "node:fs";
const emit = (obj) => fs.writeSync(1, JSON.stringify(obj) + "\\n");
const stdinText = fs.readFileSync(0, "utf8");
const firstHash = (stdinText.match(/[0-9a-f]{64}/) || [])[0] || "f".repeat(64);
const counterFile = process.env.FAKE_CODEX_COUNTER_FILE;
let n = 1;
try { n = Number(fs.readFileSync(counterFile, "utf8")) + 1; } catch (err) {}
fs.writeFileSync(counterFile, String(n), "utf8");
const briefLines = [
  "Orchestrator: gpt-5.6-luna | session inner | 2026-09-23",
  "",
  "## Smoke",
  "",
  "- node --test plugins/kusabi/scripts/luna-wait.test.mjs",
].join("\\n");
const invalidRunChain = JSON.stringify({ action: "run_chain", envelope_sha256: firstHash, brief: briefLines });
const escalate = JSON.stringify({ action: "escalate_to_host", envelope_sha256: firstHash, reason: "clean prompt handoff" });
const text = n === 1 ? invalidRunChain : escalate;
emit({ type: "thread.started", thread_id: "__THREAD__" });
emit({ type: "item.completed", item: { type: "agent_message", text } });
emit({ type: "turn.completed", usage: {} });
process.exit(0);
`;

function fakeCodexContext() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-luna-clean-prompt-codex-"));
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
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

describe("the real coordinator prompt keeps the clean-mission byte structure (review regression pin)", () => {
  let ctx;
  let cwd;
  let stateDir;
  let missionFile;

  beforeEach(() => {
    ctx = fakeCodexContext();
    cwd = ctx.cwd;
    stateDir = ctx.stateDir;
    missionFile = path.join(ctx.tmp, "mission.md");
    fs.writeFileSync(missionFile, MISSION_BRIEF, "utf8");
  });

  afterEach(() => {
    ctx.restore();
  });

  function readMission() {
    const missionsDir = path.join(stateDir, "missions");
    const ids = fs.existsSync(missionsDir)
      ? fs.readdirSync(missionsDir).filter((n) => n.startsWith("mission-"))
      : [];
    assert.equal(ids.length, 1, `exactly one mission dir expected in ${missionsDir}, got ${ids.join(",")}`);
    const missionDir = path.join(missionsDir, ids[0]);
    return { missionId: ids[0], missionDir, record: readJson(path.join(missionDir, "mission.json")) };
  }

  function codexJobRecords() {
    const jobsDir = path.join(stateDir, "jobs");
    if (!fs.existsSync(jobsDir)) return [];
    return fs
      .readdirSync(jobsDir)
      .filter((n) => n.startsWith("job-"))
      .map((id) => ({ id, job: readJson(path.join(jobsDir, id, "job.json")) }));
  }

  function jobPrompt(jobId) {
    return fs.readFileSync(path.join(stateDir, "jobs", jobId, "prompt.md"), "utf8");
  }

  async function runRealCoordinatorMission() {
    const { runLunaMission } = await import("./luna-driver.mjs");
    const chain = { calls: [], run: async (cw, input) => { chain.calls.push({ cw, input }); return "chain"; } };
    const notifications = [];
    const result = await runLunaMission({
      cwd,
      missionFile,
      brief: MISSION_BRIEF,
      container: "test-cid",
      ...DEFAULT_SEATS,
      allowSubstitute: false,
      budget: DEFAULT_BUDGET,
      inject: {
        runChainLifecycle: chain.run,
        callTool: async () => ({ status: "ok", output: "canned\n" }),
        solDispatch: async (input) =>
          JSON.stringify({
            type: "verdict",
            schema_version: 1,
            gate_id: input.envelope.gate_id,
            envelope_sha256: input.envelope.envelope_sha256,
            verdict: "clear",
            summary: "sol:clear",
          }),
        notifyMissionTerminal: async (info) => { notifications.push(info); },
        guardedServeStop: async () => {},
      },
    });
    return { result, chain, notifications, mission: readMission(), jobs: codexJobRecords() };
  }

  it("clean mission: the prompt carries EXACTLY ONE blank line between the budget block and the contract heading (pre-change shape)", async () => {
    // The counter-based fake answers the FIRST dispatch with an invalid
    // run_chain — so for a clean-mission run, pre-seed the counter at 1 (the
    // next invocation reads n=2 -> escalate).
    fs.writeFileSync(ctx.counterFile, "1", "utf8");
    const { mission, jobs } = await runRealCoordinatorMission();
    assert.equal(mission.record.disposition, "host-handoff");
    assert.equal(jobs.length, 1, "exactly one coordinator dispatch job");
    const prompt = jobPrompt(jobs[0].id);
    // The regression pin: the budget block must be followed by the contract
    // heading with exactly one blank line (the pre-change prompt).  A
    // re-introduced unconditional trailing blank line turns this into
    // `...consults: 3\n\n\n## Coordinator request contract` and fails.
    assert.match(
      prompt,
      /- remaining consults: 3\n\n## Coordinator request contract/,
      "a clean prompt must keep exactly one blank line between the budget block and the contract heading",
    );
    assert.doesNotMatch(prompt, /correction/i, "a clean mission prompt must carry no correction text at all");
    assert.ok(!prompt.includes("fails deterministic validation"), "a clean prompt must not carry the validator detail");
  });

  it("corrected mission: the section is framed by a blank line on EACH side, and the pre-correction prompt keeps the clean shape", async () => {
    const { mission, jobs } = await runRealCoordinatorMission();
    assert.equal(mission.record.disposition, "host-handoff");
    assert.equal(jobs.length, 2, "exactly two coordinator dispatch jobs (refusal, then handoff)");
    const envelope1 = readJson(path.join(mission.missionDir, "evidence", "envelope-1.json"));
    const envelope2 = readJson(path.join(mission.missionDir, "evidence", "envelope-2.json"));
    const prompt1 = jobPrompt(jobs.find(({ job }) => jobPrompt(job.id).includes(envelope1.envelope_sha256)).id);
    const prompt2 = jobPrompt(jobs.find(({ job }) => jobPrompt(job.id).includes(envelope2.envelope_sha256)).id);

    // The pre-correction prompt (dispatch 1) must keep the clean shape.
    assert.match(
      prompt1,
      /- remaining consults: 3\n\n## Coordinator request contract/,
      "the pre-correction prompt must keep exactly one blank line between the budget block and the contract heading",
    );
    assert.ok(!prompt1.includes("fails deterministic validation"), "the pre-correction prompt must not carry the correction");

    // The correction-bearing prompt (dispatch 2) frames the section with a
    // blank line on each side: budget -> blank -> header -> blank -> detail
    // -> blank -> contract heading.
    assert.match(
      prompt2,
      /- remaining consults: 3\n\nBrief corrections from the previous dispatch:\n\n[\s\S]*is absent or parses to zero entries[\s\S]*\n\n## Coordinator request contract/,
      "the corrected prompt must frame the section with exactly one blank line before and after it",
    );
  });
});