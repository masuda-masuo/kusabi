import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

import {
  DEFAULT_BUDGET,
  DEFAULT_COORDINATOR_SEAT,
  DEFAULT_AUDITOR_SEAT,
  runLunaMission,
} from "./luna-driver.mjs";
import { notifyMissionTerminal, formatNotificationReason } from "./chain-notify.mjs";
import { renderGateOrigins } from "./render-mission.mjs";
import { TERMINAL_MISSION_DISPOSITIONS } from "./mission-store.mjs";

const j = (obj) => JSON.stringify(obj);
const line = (action, hash, body = {}) => j({ action, envelope_sha256: hash, ...body });
const stream = (...lines) => lines.join("\n");

function makeCoordinator(streams) {
  const calls = [];
  return {
    calls,
    dispatch: async (input) => {
      const idx = calls.length;
      calls.push(input);
      const entry = streams[Math.min(idx, streams.length - 1)];
      return typeof entry === "function" ? entry(input) : entry;
    },
  };
}

const runChainStream = (brief) => (input) =>
  stream(line("run_chain", input.envelope.envelope_sha256, { brief }));

const consultStream = (reason) => (input) =>
  stream(line("consult_sol", input.envelope.envelope_sha256, { reason }));

const finishStream = (recommendation) => (input) =>
  stream(line("finish", input.envelope.envelope_sha256, { recommendation }));

const MISSING_DELIVERABLES_BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-inner | 2026-09-23",
  "",
  "## Smoke",
  "",
  "- `node --test plugins/kusabi/scripts/luna-wait.test.mjs`",
].join("\n");

const EMPTY_FROZEN_TESTS_BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-inner | 2026-09-23",
  "",
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/luna-wait.mjs`",
  "",
  "## Frozen Tests",
  "",
  "(none frozen by name)",
  "",
  "## Smoke",
  "",
  "- `node --test plugins/kusabi/scripts/luna-wait.test.mjs`",
].join("\n");

const INVALID_SMOKE_BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-inner | 2026-09-23",
  "",
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/luna-wait.mjs`",
  "",
  "## Smoke",
  "",
  "The smoke check runs in the container and must stay green.",
].join("\n");

function createKaibaDb(dir) {
  const dbPath = path.join(dir, "kaiba.db");
  const db = new DatabaseSync(dbPath, { open: true, write: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS actions (\n      id INTEGER PRIMARY KEY AUTOINCREMENT,\n      content TEXT NOT NULL,\n      position REAL NOT NULL,\n      author TEXT NOT NULL DEFAULT 'kusabi',\n      created_at TEXT NOT NULL,\n      done_at TEXT\n    );\n  `);
  db.close();
  return dbPath;
}

describe("luna terminal handoff: sol-blocked handoff and brief correction budget (#574 + #577)", () => {
  let root;
  let cwd;
  let stateDir;
  let previousStateDir;
  let missionFile;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-handoff-test-"));
    cwd = path.join(root, "work");
    fs.mkdirSync(cwd, { recursive: true });
    missionFile = path.join(root, "mission.md");
    fs.writeFileSync(missionFile, "mission brief", "utf8");
    previousStateDir = process.env.KUSABI_STATE_DIR;
    process.env.KUSABI_STATE_DIR = path.join(root, "state");
    stateDir = process.env.KUSABI_STATE_DIR;
  });

  afterEach(() => {
    if (previousStateDir === undefined) delete process.env.KUSABI_STATE_DIR;
    else process.env.KUSABI_STATE_DIR = previousStateDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function readMissionRecord() {
    const dir = path.join(stateDir, "0aeef9b3385f", "missions");
    const mdirs = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    if (mdirs.length === 0) {
      // try scanning all dirs under stateDir
      const scan = (d) => {
        const entries = fs.readdirSync(d, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory()) {
            if (e.name.startsWith("mission-") && fs.existsSync(path.join(d, e.name, "mission.json"))) {
              return path.join(d, e.name);
            }
            const found = scan(path.join(d, e.name));
            if (found) return found;
          }
        }
        return null;
      };
      const foundDir = scan(stateDir);
      if (foundDir) {
        return {
          missionDir: foundDir,
          missionId: path.basename(foundDir),
          record: JSON.parse(fs.readFileSync(path.join(foundDir, "mission.json"), "utf8")),
        };
      }
      throw new Error("no mission directory found");
    }
    const missionDir = path.join(dir, mdirs[0]);
    return {
      missionDir,
      missionId: mdirs[0],
      record: JSON.parse(fs.readFileSync(path.join(missionDir, "mission.json"), "utf8")),
    };
  }

  // -------------------------------------------------------------------------
  // Part A — #574: sol-blocked is a host handoff
  // -------------------------------------------------------------------------

  it("A1 & A3: sol-blocked consult gate writes blocking gate, summary, block_reason, next actions with override command, and notifies with reason", async () => {
    const notifications = [];
    const solCalls = [];
    const coord = makeCoordinator([
      consultStream("coordinator requests architectural check"),
      finishStream("recommend-accept"),
    ]);

    const solDispatch = async (input) => {
      solCalls.push(input);
      return JSON.stringify({
        type: "verdict",
        schema_version: 1,
        gate_id: input.envelope.gate_id,
        envelope_sha256: input.envelope.envelope_sha256,
        verdict: "block",
        summary: "S-text architectural risk detected",
        block_reason: "B-text unvetted external dependency introduced",
        acknowledgement_required: true,
      });
    };

    await runLunaMission({
      cwd,
      missionFile,
      brief: "test brief",
      container: "test-cid",
      coordinator: DEFAULT_COORDINATOR_SEAT,
      auditor: DEFAULT_AUDITOR_SEAT,
      allowSubstitute: false,
      budget: DEFAULT_BUDGET,
      inject: {
        coordinatorDispatch: coord.dispatch,
        runChainLifecycle: async () => {},
        callTool: async () => ({ status: "ok", output: "" }),
        solDispatch,
        notifyMissionTerminal: async (info) => { notifications.push(info); },
        guardedServeStop: async () => {},
      },
    });

    const { missionDir, missionId, record } = readMissionRecord();
    assert.equal(record.disposition, "sol-blocked");

    const recPath = path.join(missionDir, "recommendation.md");
    assert.ok(fs.existsSync(recPath), "recommendation.md must exist");
    const recText = fs.readFileSync(recPath, "utf8");

    // A1 assertions:
    assert.match(recText, /S-text architectural risk detected/);
    assert.match(recText, /B-text unvetted external dependency introduced/);
    assert.match(recText, /gate: \S+ \(phase: consult, verdict: block\)/);
    assert.match(recText, /## Next actions/);
    assert.match(recText, /1\. amend the mission brief \(resolve what `block_reason`\/`summary` names\) and start a new mission/);
    assert.match(recText, new RegExp(`2\\. kusabi-companion luna-resume ${missionId} --audit-override \\S+ --audit-override-reason <reason> --audit-override-by <actor>`));

    // A3 assertions:
    assert.equal(notifications.length, 1, "exactly one terminal notification");
    assert.equal(notifications[0].disposition, "sol-blocked");
    assert.ok(notifications[0].reason, "notification must carry reason");
    assert.ok(notifications[0].reason.includes("B-text"), `notification reason must contain B-text: got ${notifications[0].reason}`);
  });

  it("A3 unit: notifyMissionTerminal writes reason to inbox and agenda; without reason byte-identical to legacy", () => {
    const kaibaDbPath = createKaibaDb(root);
    const fakeEnv = {
      ...process.env,
      KUSABI_CHAIN_NOTIFY: "1",
      KAIBA_DB: kaibaDbPath,
    };

    // 1. With reason
    const withReason = notifyMissionTerminal({
      stateDir,
      missionId: "mission-test-with-reason",
      disposition: "sol-blocked",
      container: "cid-123",
      cwdLabel: "my-work",
      env: fakeEnv,
      now: "2026-09-26T00:00:00.000Z",
      reason: "gate-1 block: critical security flaw found\nwith multi-line explanation",
    });

    assert.ok(fs.existsSync(withReason.inboxPath));
    const inboxWithReason = fs.readFileSync(withReason.inboxPath, "utf8");
    assert.match(inboxWithReason, /- \*\*disposition\*\*: sol-blocked\n- \*\*reason\*\*: gate-1 block: critical security flaw found with multi-line explanation\n/);

    const db = new DatabaseSync(kaibaDbPath, { open: true });
    const rowWithReason = db.prepare("SELECT content FROM actions WHERE content LIKE '%mission-test-with-reason%'").get();
    assert.ok(rowWithReason);
    assert.match(rowWithReason.content, /\(status=completed, disposition=sol-blocked\) reason=gate-1 block: critical security flaw found with multi-line explanation container=cid-123/);

    // 2. Without reason (must have no reason line in inbox and no reason= in agenda)
    const withoutReason = notifyMissionTerminal({
      stateDir,
      missionId: "mission-test-no-reason",
      disposition: "recommend-accept",
      container: "cid-456",
      cwdLabel: "my-work",
      env: fakeEnv,
      now: "2026-09-26T00:00:01.000Z",
    });

    const inboxNoReason = fs.readFileSync(withoutReason.inboxPath, "utf8");
    assert.doesNotMatch(inboxNoReason, /- \*\*reason\*\*:/);
    const expectedInboxLegacy =
      `# Mission mission-test-no-reason - terminal\n\n` +
      `- **status**: completed\n` +
      `- **disposition**: recommend-accept\n` +
      `- **container**: cid-456\n` +
      `- **inbox**: ${withoutReason.inboxPath}\n\n` +
      `## Next steps\n\n` +
      `Run \`kusabi-companion luna-show mission-test-no-reason\` then inspect the recommendation and adjudicate.\n`;
    assert.equal(inboxNoReason, expectedInboxLegacy);

    const rowNoReason = db.prepare("SELECT content FROM actions WHERE content LIKE '%mission-test-no-reason%'").get();
    assert.ok(rowNoReason);
    assert.doesNotMatch(rowNoReason.content, /reason=/);
    const expectedContentLegacy =
      `Inspect my-work mission-test-no-reason (status=completed, disposition=recommend-accept) ` +
      `container=cid-456 - luna-show then adjudicate. inbox=${withoutReason.inboxPath}`;
    assert.equal(rowNoReason.content, expectedContentLegacy);

    db.close();
  });

  it("A3 unit: formatNotificationReason truncates to 300 characters with ellipsis and collapses whitespace", () => {
    const multiline = "line 1\n  line 2\r\nline 3   line 4";
    assert.equal(formatNotificationReason(multiline), "line 1 line 2 line 3 line 4");

    const longReason = "A".repeat(350);
    const formatted = formatNotificationReason(longReason);
    assert.equal(formatted.length, 301); // 300 + '…'
    assert.equal(formatted.slice(0, 300), "A".repeat(300));
    assert.ok(formatted.endsWith("…"));

    assert.equal(formatNotificationReason(null), null);
    assert.equal(formatNotificationReason(""), null);
    assert.equal(formatNotificationReason("   \n\t  "), null);
  });

  it("A4: renderGateOrigins formats summary and block_reason for block/rework gates, clears render unchanged", () => {
    const record = {
      auditGates: [
        {
          gateId: "gate-1",
          phase: "pre-dispatch",
          origin: "policy-mandated",
          verdict: "clear",
          shadowDisposition: "not recorded",
          verdictRecord: { summary: "looks good" },
        },
        {
          gateId: "gate-2",
          phase: "consult",
          origin: "consult-requested",
          verdict: "block",
          shadowDisposition: "not recorded",
          verdictRecord: {
            summary: "summary line 1\n  summary line 2",
            block_reason: "block reason 1\n  block reason 2",
          },
        },
        {
          gateId: "gate-3",
          phase: "post-chain",
          origin: "policy-mandated",
          verdict: "rework",
          shadowDisposition: "not recorded",
          verdictRecord: {
            summary: "rework needed",
          },
        },
      ],
    };

    const lines = renderGateOrigins(record);
    assert.equal(lines[0], "audit gates:");
    // gate-1 (clear) must have no indented summary
    assert.equal(lines[1], "  gate-1 (pre-dispatch, origin: policy-mandated, verdict: clear, shadow disposition: not recorded)");
    // gate-2 (block) must have indented summary and block_reason
    assert.equal(lines[2], "  gate-2 (consult, origin: consult-requested, verdict: block, shadow disposition: not recorded)");
    assert.equal(lines[3], "    summary: summary line 1 summary line 2");
    assert.equal(lines[4], "    block_reason: block reason 1 block reason 2");
    // gate-3 (rework) must have indented summary
    assert.equal(lines[5], "  gate-3 (post-chain, origin: policy-mandated, verdict: rework, shadow disposition: not recorded)");
    assert.equal(lines[6], "    summary: rework needed");
  });

  // -------------------------------------------------------------------------
  // Part B — #577: brief corrections have their own budget
  // -------------------------------------------------------------------------

  it("B1: two distinct refused briefs followed by valid finish do NOT end coordinator-failed (coordinatorErrors=0, briefCorrections=2)", async () => {
    const coord = makeCoordinator([
      runChainStream(MISSING_DELIVERABLES_BRIEF),
      runChainStream(EMPTY_FROZEN_TESTS_BRIEF),
      finishStream("recommend-escalate"),
    ]);

    await runLunaMission({
      cwd,
      missionFile,
      brief: "test brief",
      container: "test-cid",
      coordinator: DEFAULT_COORDINATOR_SEAT,
      auditor: DEFAULT_AUDITOR_SEAT,
      allowSubstitute: false,
      budget: DEFAULT_BUDGET,
      inject: {
        coordinatorDispatch: coord.dispatch,
        runChainLifecycle: async () => {},
        callTool: async () => ({ status: "ok", output: "" }),
        solDispatch: async () => JSON.stringify({ type: "verdict", verdict: "clear" }),
        notifyMissionTerminal: async () => {},
        guardedServeStop: async () => {},
      },
    });

    const { record } = readMissionRecord();
    assert.equal(coord.calls.length, 3, "dispatched 3 times");
    assert.equal(record.coordinatorErrors, 0, "corrections do not count as coordinator errors");
    assert.equal(record.briefCorrections, 2, "both corrections recorded");
    assert.equal(record.disposition, "recommend-escalate", "finished normally");
  });

  it("B3/B4 no-progress: two consecutive refusals with identical details end brief-correction-exhausted immediately", async () => {
    const notifications = [];
    const coord = makeCoordinator([
      runChainStream(MISSING_DELIVERABLES_BRIEF),
      runChainStream(MISSING_DELIVERABLES_BRIEF),
    ]);

    await runLunaMission({
      cwd,
      missionFile,
      brief: "test brief",
      container: "test-cid",
      coordinator: DEFAULT_COORDINATOR_SEAT,
      auditor: DEFAULT_AUDITOR_SEAT,
      allowSubstitute: false,
      budget: DEFAULT_BUDGET,
      inject: {
        coordinatorDispatch: coord.dispatch,
        runChainLifecycle: async () => {},
        callTool: async () => ({ status: "ok", output: "" }),
        solDispatch: async () => JSON.stringify({ type: "verdict", verdict: "clear" }),
        notifyMissionTerminal: async (info) => { notifications.push(info); },
        guardedServeStop: async () => {},
      },
    });

    const { missionDir, record } = readMissionRecord();
    assert.equal(coord.calls.length, 2, "dispatched exactly twice");
    assert.equal(record.coordinatorErrors, 0);
    assert.equal(record.briefCorrections, 2);
    assert.equal(record.disposition, "brief-correction-exhausted");
    assert.equal(record.terminationReason, "no progress: the same brief correction was repeated");

    // recommendation.md checks
    const recPath = path.join(missionDir, "recommendation.md");
    const recText = fs.readFileSync(recPath, "utf8");
    assert.match(recText, /disposition: brief-correction-exhausted/);
    assert.match(recText, /reason: no progress: the same brief correction was repeated/);
    assert.match(recText, /## Last brief correction/);
    assert.match(recText, /Deliverables/);

    // notification reason check
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].disposition, "brief-correction-exhausted");
    assert.equal(notifications[0].reason, "no progress: the same brief correction was repeated");
  });

  it("B3/B4 budget: three refusals with pairwise different details end brief-correction-exhausted after the third", async () => {
    const notifications = [];
    const coord = makeCoordinator([
      runChainStream(MISSING_DELIVERABLES_BRIEF),
      runChainStream(EMPTY_FROZEN_TESTS_BRIEF),
      runChainStream(INVALID_SMOKE_BRIEF),
    ]);

    await runLunaMission({
      cwd,
      missionFile,
      brief: "test brief",
      container: "test-cid",
      coordinator: DEFAULT_COORDINATOR_SEAT,
      auditor: DEFAULT_AUDITOR_SEAT,
      allowSubstitute: false,
      budget: DEFAULT_BUDGET, // maxBriefCorrections: 3
      inject: {
        coordinatorDispatch: coord.dispatch,
        runChainLifecycle: async () => {},
        callTool: async () => ({ status: "ok", output: "" }),
        solDispatch: async () => JSON.stringify({ type: "verdict", verdict: "clear" }),
        notifyMissionTerminal: async (info) => { notifications.push(info); },
        guardedServeStop: async () => {},
      },
    });

    const { missionDir, record } = readMissionRecord();
    assert.equal(coord.calls.length, 3, "dispatched exactly 3 times");
    assert.equal(record.coordinatorErrors, 0);
    assert.equal(record.briefCorrections, 3);
    assert.equal(record.disposition, "brief-correction-exhausted");
    assert.equal(record.terminationReason, "brief correction budget exhausted (3/3)");

    const recPath = path.join(missionDir, "recommendation.md");
    const recText = fs.readFileSync(recPath, "utf8");
    assert.match(recText, /reason: brief correction budget exhausted \(3\/3\)/);
    assert.match(recText, /## Last brief correction/);
    assert.match(recText, /Smoke/);

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].reason, "brief correction budget exhausted (3/3)");
  });

  it("TERMINAL_MISSION_DISPOSITIONS contains brief-correction-exhausted", () => {
    assert.ok(TERMINAL_MISSION_DISPOSITIONS.has("brief-correction-exhausted"));
  });
});
