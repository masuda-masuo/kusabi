// luna-post-chain-evidence.test.mjs — Luna Sol gates must see post-chain evidence (kusabi #568)
//
// Acceptance criteria:
// 1. End-to-end runLunaMission with realistic chain records, diff_in_container returning raw_diff,
//    and coordinator run_chain then finish recommend-accept. Pre-accept gate envelope has base_sha
//    equal to chain baseSha, change_scope equal to round changeScope, diff item, and evidence
//    contents / files contain DIFF-MARKER and P1:
// 2. missionEvidenceItems emits diff and chain-probes items for attempts with postChain, and is
//    unchanged for attempts without it.
// 3. diff_in_container receives container_id = mission container and base = chain baseSha.
// 4. When chain directory is absent: no diff_in_container call, mission outcome unchanged, evidence
//    contains explicit "unavailable". When diff throws: outcome unchanged, diff item states failure.
// 5. Large diff is truncated through truncateEvidenceText and truncation is recorded.
// 6. Pre-accept rework records error naming real gate id, never "undefined".

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  runLunaMission,
  collectPostChainEvidence,
  DEFAULT_BUDGET,
} from "./luna-driver.mjs";

const DEFAULT_SEATS = {
  coordinator: { provider: "codex", model: "gpt-5.6-luna" },
  auditor: { provider: "codex", model: "gpt-5.6-sol" },
};
import {
  missionEvidenceItems,
  evidenceFingerprint,
  resolveLastPostChain,
} from "./luna-sol-gate.mjs";
import { renderEvidenceContents } from "./luna-prompt.mjs";
import { stateDirFor, readJson, writeJson } from "./state-paths.mjs";

const MISSION_BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-post-chain-test | 2026-09-24",
  "",
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/luna-driver.mjs`",
  "",
  "## Smoke",
  "",
  "- `node --test plugins/kusabi/scripts/luna-post-chain-evidence.test.mjs`",
].join("\n");

const VALID_RUN_CHAIN_BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-inner | 2026-09-24",
  "",
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/luna-driver.mjs`",
  "",
  "## Workplace",
  "",
  "- Container: `test-cid`",
  "",
  "## Smoke",
  "",
  "- `node --test plugins/kusabi/scripts/luna-post-chain-evidence.test.mjs`",
].join("\n");

function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

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

describe("luna post-chain evidence (kusabi #568)", () => {
  let root;
  let cwd;
  let stateDir;
  let previousStateDir;
  let missionFile;

  beforeEach(() => {
    root = makeTemp("kusabi-post-chain-");
    cwd = path.join(root, "work");
    fs.mkdirSync(cwd, { recursive: true });
    missionFile = path.join(root, "mission.md");
    fs.writeFileSync(missionFile, MISSION_BRIEF, "utf8");
    previousStateDir = process.env.KUSABI_STATE_DIR;
    process.env.KUSABI_STATE_DIR = path.join(root, "state");
    stateDir = stateDirFor(cwd);
  });

  afterEach(() => {
    if (previousStateDir === undefined) delete process.env.KUSABI_STATE_DIR;
    else process.env.KUSABI_STATE_DIR = previousStateDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function readMission() {
    const missionsDir = path.join(stateDir, "missions");
    const ids = fs.existsSync(missionsDir)
      ? fs.readdirSync(missionsDir).filter((n) => n.startsWith("mission-"))
      : [];
    assert.equal(ids.length, 1, `exactly one mission dir expected in ${missionsDir}`);
    const missionDir = path.join(missionsDir, ids[0]);
    return {
      missionId: ids[0],
      missionDir,
      record: readJson(path.join(missionDir, "mission.json")),
    };
  }

  describe("missionEvidenceItems and evidenceFingerprint (criterion 2 & 4, spec 4)", () => {
    it("criterion 2: emits diff and probe_raw items for attempts with postChain", () => {
      const record = {
        attempts: [
          {
            index: 1,
            kind: "run_chain",
            chainId: "chain-abc1",
            output: "chain completed",
            postChain: {
              chainId: "chain-abc1",
              baseSha: "sha-123",
              probeResults: [{ probe: "P1: HEAD clean", passed: true, detail: "clean" }],
              changeScope: { paths: { unstaged: ["src/index.js"] } },
              diff: "diff --git a/src/index.js b/src/index.js\n+NEW-LINE-MARKER\n",
            },
          },
        ],
      };

      const items = missionEvidenceItems({ brief: "test brief", record });
      const diffItem = items.find((i) => i.role === "diff");
      assert.ok(diffItem, "envelope items must include diff item");
      assert.equal(diffItem.source, "chain-chain-abc1-diff");
      assert.equal(diffItem.path, "evidence/chain-diff-0.txt");
      assert.ok(diffItem.content.includes("NEW-LINE-MARKER"));

      const probeItem = items.find((i) => i.role === "probe_raw" && i.source === "chain-chain-abc1-probes");
      assert.ok(probeItem, "envelope items must include chain-probes probe_raw item");
      assert.equal(probeItem.path, "evidence/chain-probes-0.txt");
      assert.ok(probeItem.content.includes("P1: HEAD clean"));
      assert.ok(probeItem.content.includes("sha-123"));
      assert.ok(!diffItem.content.includes("truncated"), "an uncapped diff carries no truncation note");
    });

    it("criterion 5: a capped diff states the omission at the top of the diff item", () => {
      const record = {
        attempts: [
          {
            index: 1,
            kind: "run_chain",
            chainId: "chain-abc1",
            output: "chain completed",
            postChain: {
              chainId: "chain-abc1",
              baseSha: "sha-123",
              probeResults: [],
              changeScope: {},
              diff: "HEAD-PART\nTAIL-PART\n",
              diffTruncated: true,
              diffOmittedBytes: 4321,
            },
          },
        ],
      };
      const diffItem = missionEvidenceItems({ brief: "b", record }).find((i) => i.role === "diff");
      assert.ok(
        diffItem.content.startsWith("[post-chain diff truncated: 4321 bytes omitted from the middle]\n"),
        diffItem.content,
      );
      assert.ok(diffItem.content.includes("HEAD-PART\nTAIL-PART"));
    });

    it("criterion 2: legacy attempts without postChain produce unchanged items", () => {
      const legacyRecord = {
        attempts: [
          {
            index: 1,
            kind: "run_chain",
            chainId: "chain-legacy",
            output: "legacy output",
          },
        ],
      };

      const items = missionEvidenceItems({ brief: "b", record: legacyRecord });
      assert.equal(items.filter((i) => i.role === "diff").length, 0);
      assert.equal(items.filter((i) => i.source === "chain-legacy-probes").length, 0);
      assert.equal(items.length, 3); // brief, worker_report, ledger
    });

    it("criterion 4: attempt with unavailable postChain emits explicit unavailable statement", () => {
      const record = {
        attempts: [
          {
            index: 1,
            kind: "run_chain",
            chainId: "chain-unavail",
            output: "out",
            postChain: {
              chainId: "chain-unavail",
              unavailable: "chain.json missing or unreadable",
            },
          },
        ],
      };

      const items = missionEvidenceItems({ brief: "b", record });
      const diffItem = items.find((i) => i.role === "diff");
      assert.ok(diffItem);
      assert.ok(diffItem.content.includes("post-chain diff unavailable: chain.json missing or unreadable"));

      const probeItem = items.find((i) => i.source === "chain-chain-unavail-probes");
      assert.ok(probeItem);
      assert.ok(probeItem.content.includes("post-chain probes unavailable: chain.json missing or unreadable"));
    });

    it("criterion 4: attempt with diffUnavailable postChain emits failure in diff item and keeps probe results", () => {
      const record = {
        attempts: [
          {
            index: 1,
            kind: "run_chain",
            chainId: "chain-difffail",
            output: "out",
            postChain: {
              chainId: "chain-difffail",
              baseSha: "sha-foo",
              probeResults: [{ probe: "P1: HEAD clean", passed: true }],
              changeScope: { paths: { unstaged: [] } },
              diffUnavailable: "container stopped",
            },
          },
        ],
      };

      const items = missionEvidenceItems({ brief: "b", record });
      const diffItem = items.find((i) => i.role === "diff");
      assert.ok(diffItem);
      assert.ok(diffItem.content.includes("post-chain diff unavailable: container stopped"));

      const probeItem = items.find((i) => i.source === "chain-chain-difffail-probes");
      assert.ok(probeItem);
      assert.ok(probeItem.content.includes("P1: HEAD clean"));
      assert.ok(probeItem.content.includes("sha-foo"));
    });

    it("spec 4: evidenceFingerprint is unchanged without postChain, and changes when postChain differs", () => {
      const recordWithoutPostChain = {
        attempts: [
          {
            index: 1,
            kind: "run_chain",
            chainId: "chain-1",
            output: "done",
          },
        ],
      };
      const fp1 = evidenceFingerprint({ brief: "b", record: recordWithoutPostChain });

      const recordWithPostChain = {
        attempts: [
          {
            index: 1,
            kind: "run_chain",
            chainId: "chain-1",
            output: "done",
            postChain: {
              chainId: "chain-1",
              baseSha: "sha-1",
              diff: "diff 1",
            },
          },
        ],
      };
      const fp2 = evidenceFingerprint({ brief: "b", record: recordWithPostChain });
      assert.notEqual(fp1, fp2, "fingerprint must change when postChain is added");

      const recordWithDifferentPostChain = {
        attempts: [
          {
            index: 1,
            kind: "run_chain",
            chainId: "chain-1",
            output: "done",
            postChain: {
              chainId: "chain-1",
              baseSha: "sha-2",
              diff: "diff 2",
            },
          },
        ],
      };
      const fp3 = evidenceFingerprint({ brief: "b", record: recordWithDifferentPostChain });
      assert.notEqual(fp2, fp3, "fingerprint must change when postChain content changes");
    });
  });

  describe("collectPostChainEvidence (criteria 1, 3, 4, 5)", () => {
    it("criteria 1 & 3: collects baseSha, probeResults, changeScope and calls diff_in_container with base and container_id", async () => {
      const chainId = "chain-test1";
      const chainDir = path.join(stateDir, "chains", chainId);
      writeJson(path.join(chainDir, "chain.json"), {
        baseSha: "base-sha-12345",
        records: [{ round: 1 }],
      });
      writeJson(path.join(chainDir, "round-1.json"), {
        round: 1,
        probeResults: [{ probe: "P1: HEAD clean", passed: true, detail: "clean" }],
        changeScope: { paths: { unstaged: ["file.js"] } },
      });

      const toolCalls = [];
      const callTool = async (name, args) => {
        toolCalls.push({ name, args });
        return { status: "ok", raw_diff: "diff --git a/file.js b/file.js\n+NEW" };
      };

      const pc = await collectPostChainEvidence({
        stateDir,
        chainId,
        container: "container-cid",
        callTool,
      });

      assert.equal(pc.chainId, chainId);
      assert.equal(pc.baseSha, "base-sha-12345");
      assert.deepEqual(pc.probeResults, [{ probe: "P1: HEAD clean", passed: true, detail: "clean" }]);
      assert.deepEqual(pc.changeScope, { paths: { unstaged: ["file.js"] } });
      assert.equal(pc.diff, "diff --git a/file.js b/file.js\n+NEW");
      assert.equal(pc.diffTruncated, false);
      assert.equal(pc.diffOmittedBytes, 0);

      // Check tool call arguments (Criterion 3)
      assert.equal(toolCalls.length, 1);
      assert.equal(toolCalls[0].name, "diff_in_container");
      assert.equal(toolCalls[0].args.container_id, "container-cid");
      assert.equal(toolCalls[0].args.base, "base-sha-12345");
      assert.equal(toolCalls[0].args.raw, true);
    });

    it("criterion 4: when chain.json is missing, does not call diff_in_container and returns unavailable", async () => {
      const toolCalls = [];
      const callTool = async (name, args) => {
        toolCalls.push({ name, args });
        return { status: "ok", raw_diff: "diff" };
      };

      const pc = await collectPostChainEvidence({
        stateDir,
        chainId: "chain-nonexistent",
        container: "cid",
        callTool,
      });

      assert.equal(toolCalls.length, 0, "must not call diff_in_container");
      assert.equal(pc.chainId, "chain-nonexistent");
      assert.ok(typeof pc.unavailable === "string");
      assert.ok(pc.unavailable.includes("chain.json"));
    });

    it("criterion 4: when baseSha is missing from chain.json, does not call diff_in_container", async () => {
      const chainId = "chain-no-basesha";
      const chainDir = path.join(stateDir, "chains", chainId);
      writeJson(path.join(chainDir, "chain.json"), {
        records: [{ round: 1 }],
      });
      writeJson(path.join(chainDir, "round-1.json"), { round: 1, probeResults: [] });

      const toolCalls = [];
      const callTool = async (name, args) => {
        toolCalls.push({ name, args });
      };

      const pc = await collectPostChainEvidence({
        stateDir,
        chainId,
        container: "cid",
        callTool,
      });

      assert.equal(toolCalls.length, 0, "must not call diff_in_container");
      assert.ok(pc.unavailable.includes("baseSha"));
    });

    it("criterion 4: when diff_in_container throws, keeps baseSha/probes/changeScope and sets diffUnavailable", async () => {
      const chainId = "chain-diff-throws";
      const chainDir = path.join(stateDir, "chains", chainId);
      writeJson(path.join(chainDir, "chain.json"), {
        baseSha: "base-sha-err",
        records: [{ round: 1 }],
      });
      writeJson(path.join(chainDir, "round-1.json"), {
        round: 1,
        probeResults: [{ probe: "P1: HEAD clean", passed: true }],
        changeScope: { paths: { unstaged: [] } },
      });

      const callTool = async () => {
        throw new Error("container died during diff");
      };

      const pc = await collectPostChainEvidence({
        stateDir,
        chainId,
        container: "cid",
        callTool,
      });

      assert.equal(pc.baseSha, "base-sha-err");
      assert.deepEqual(pc.probeResults, [{ probe: "P1: HEAD clean", passed: true }]);
      assert.ok(pc.diffUnavailable.includes("container died during diff"));
      assert.equal(pc.diff, undefined);
    });

    it("criterion 4: when diff_in_container returns error status, sets diffUnavailable", async () => {
      const chainId = "chain-diff-status-err";
      const chainDir = path.join(stateDir, "chains", chainId);
      writeJson(path.join(chainDir, "chain.json"), {
        baseSha: "base-sha-err2",
        records: [{ round: 1 }],
      });
      writeJson(path.join(chainDir, "round-1.json"), {
        round: 1,
        probeResults: [{ probe: "P1: HEAD clean", passed: true }],
      });

      const callTool = async () => ({
        status: "error",
        error: "git diff failed with exit code 128",
      });

      const pc = await collectPostChainEvidence({
        stateDir,
        chainId,
        container: "cid",
        callTool,
      });

      assert.equal(pc.baseSha, "base-sha-err2");
      assert.ok(pc.diffUnavailable.includes("git diff failed"));
    });

    it("criterion 5: large diff exceeding maxBytes is truncated and diffTruncated/diffOmittedBytes are recorded", async () => {
      const chainId = "chain-diff-large";
      const chainDir = path.join(stateDir, "chains", chainId);
      writeJson(path.join(chainDir, "chain.json"), {
        baseSha: "base-sha-lg",
        records: [{ round: 1 }],
      });
      writeJson(path.join(chainDir, "round-1.json"), {
        round: 1,
        probeResults: [],
      });

      const largeDiff = "A".repeat(10000);
      const callTool = async () => ({
        status: "ok",
        raw_diff: largeDiff,
      });

      const pc = await collectPostChainEvidence({
        stateDir,
        chainId,
        container: "cid",
        callTool,
        maxBytes: 1000,
      });

      assert.equal(pc.diffTruncated, true);
      assert.ok(pc.diffOmittedBytes > 0);
      assert.ok(Buffer.byteLength(pc.diff, "utf8") <= 1000);
    });
  });

  describe("resolveLastPostChain (spec 3)", () => {
    it("resolves the last attempt with usable postChain", () => {
      const record = {
        attempts: [
          {
            index: 1,
            postChain: {
              chainId: "c1",
              baseSha: "sha-1",
              changeScope: { paths: { committed: ["a"] } },
            },
          },
          {
            index: 2,
            postChain: {
              chainId: "c2",
              unavailable: "missing round",
            },
          },
          {
            index: 3,
            postChain: {
              chainId: "c3",
              baseSha: "sha-3",
              changeScope: { paths: { committed: ["b"] } },
            },
          },
        ],
      };

      const resolved = resolveLastPostChain(record);
      assert.ok(resolved);
      assert.equal(resolved.chainId, "c3");
      assert.equal(resolved.baseSha, "sha-3");
    });

    it("returns null if no attempts have usable postChain", () => {
      assert.equal(resolveLastPostChain({ attempts: [] }), null);
      assert.equal(
        resolveLastPostChain({
          attempts: [{ index: 1, postChain: { chainId: "c1", unavailable: "error" } }],
        }),
        null,
      );
    });
  });

  describe("end-to-end runLunaMission with Sol gate (criteria 1, 3, 4, 6)", () => {
    it("criterion 1 & 3: pre-accept gate envelope receives chain baseSha, changeScope, and diff/probe evidence", async () => {
      const fakeBaseSha = "abc-sha-999";
      const fakeChangeScope = {
        formatVersion: 1,
        repositoryRoot: "/workspace",
        input: { base: fakeBaseSha },
        resolved: { baseSha: fakeBaseSha, headSha: "head-111", mergeBaseSha: fakeBaseSha },
        paths: { committed: [], staged: [], unstaged: ["modified-file.mjs"], untracked: [] },
      };
      const fakeProbes = [
        { probe: "P1: HEAD clean", passed: true, detail: "clean" },
        { probe: "P2: branch exists", passed: true, detail: "main" },
        { probe: "P3: build succeeds", passed: true, detail: "build ok" },
        { probe: "P4: tests pass", passed: true, detail: "all pass" },
        { probe: "P5: gates pass", passed: true, detail: "gates ok" },
        { probe: "P6: working tree clean", passed: true, detail: "clean" },
      ];

      let innerChainId;
      const fakeRunChain = async (_cwd, input) => {
        innerChainId = input?.flags?.["chain-id"];
        const chainDir = path.join(stateDir, "chains", innerChainId);
        writeJson(path.join(chainDir, "chain.json"), {
          baseSha: fakeBaseSha,
          records: [{ round: 1 }],
        });
        writeJson(path.join(chainDir, "round-1.json"), {
          round: 1,
          probeResults: fakeProbes,
          changeScope: fakeChangeScope,
        });
        return `Chain ${innerChainId} completed successfully`;
      };

      const toolCalls = [];
      const fakeCallTool = async (name, args) => {
        toolCalls.push({ name, args });
        if (name === "diff_in_container") {
          return { raw_diff: "diff --git a/modified-file.mjs b/modified-file.mjs\n+NEW-DIFF-MARKER\n" };
        }
        return { status: "ok", output: "ok" };
      };

      const solEnvelopes = [];
      const fakeSolDispatch = async (input) => {
        solEnvelopes.push({
          envelope: input.envelope,
          gate: input.gate,
          missionDir: input.missionDir,
        });
        return JSON.stringify({
          type: "verdict",
          schema_version: 1,
          gate_id: input.envelope.gate_id,
          envelope_sha256: input.envelope.envelope_sha256,
          verdict: "clear",
          summary: "sol:clear",
        });
      };

      const coordStreams = [
        (input) => stream(line("run_chain", input.envelope.envelope_sha256, { brief: VALID_RUN_CHAIN_BRIEF })),
        (input) => stream(line("finish", input.envelope.envelope_sha256, { recommendation: "recommend-accept" })),
      ];
      const coord = makeCoordinator(coordStreams);

      const missionInput = {
        cwd,
        missionFile,
        brief: MISSION_BRIEF,
        container: "target-container-id",
        ...DEFAULT_SEATS,
        budget: DEFAULT_BUDGET,
        inject: {
          coordinatorDispatch: coord.dispatch,
          runChainLifecycle: fakeRunChain,
          callTool: fakeCallTool,
          solDispatch: fakeSolDispatch,
        },
      };

      const result = await runLunaMission(missionInput);
      assert.match(result, /disposition=recommend-accept/);
      const mission = readMission();
      assert.equal(mission.record.disposition, "recommend-accept");

      // Verify diff_in_container was called with container_id and base (Criterion 3)
      const diffCall = toolCalls.find((c) => c.name === "diff_in_container");
      assert.ok(diffCall, "diff_in_container must be called");
      assert.equal(diffCall.args.container_id, "target-container-id");
      assert.equal(diffCall.args.base, fakeBaseSha);
      assert.equal(diffCall.args.raw, true);

      // Verify the Sol envelopes (Criterion 1)
      // Gates: 1 = post-chain, 2 = pre-accept
      const preAcceptSol = solEnvelopes.find((e) => e.gate.phase === "pre-accept");
      assert.ok(preAcceptSol, "pre-accept Sol gate must be dispatched");
      const envelope = preAcceptSol.envelope;

      // 1. base_sha equals chain's baseSha
      assert.equal(envelope.base_sha, fakeBaseSha);

      // 2. change_scope equals round's changeScope
      assert.deepEqual(envelope.change_scope, fakeChangeScope);

      // 3. has item with role "diff"
      const diffItem = envelope.items.find((i) => i.role === "diff");
      assert.ok(diffItem, "envelope must contain diff item");

      // 4. rendered evidence contents and materialized files contain DIFF-MARKER and P1:
      const diffFilePath = path.join(preAcceptSol.missionDir, diffItem.path);
      assert.ok(fs.existsSync(diffFilePath), `diff file ${diffFilePath} must exist`);
      const diffFileText = fs.readFileSync(diffFilePath, "utf8");
      assert.ok(diffFileText.includes("NEW-DIFF-MARKER"), "diff file must contain DIFF-MARKER");

      const probeItem = envelope.items.find(
        (i) => i.role === "probe_raw" && i.source.includes("probes"),
      );
      assert.ok(probeItem, "envelope must contain chain probes item");
      const probeFilePath = path.join(preAcceptSol.missionDir, probeItem.path);
      assert.ok(fs.existsSync(probeFilePath), `probes file ${probeFilePath} must exist`);
      const probeFileText = fs.readFileSync(probeFilePath, "utf8");
      assert.ok(probeFileText.includes("P1: HEAD clean"), "probes file must contain P1:");

      const renderedEvidence = renderEvidenceContents(envelope, preAcceptSol.missionDir);
      assert.ok(renderedEvidence.includes("NEW-DIFF-MARKER"), "rendered evidence must contain DIFF-MARKER");
      assert.ok(renderedEvidence.includes("P1: HEAD clean"), "rendered evidence must contain P1:");
    });

    it("criterion 4: when chain directory is absent, no diff_in_container is called and evidence contains unavailable", async () => {
      // Fake chain that does NOT write chain.json (the legacy fake)
      const fakeRunChain = async (_cwd, input) => {
        const id = input?.flags?.["chain-id"];
        return `Chain ${id} completed`;
      };

      const toolCalls = [];
      const fakeCallTool = async (name, args) => {
        toolCalls.push({ name, args });
        return { status: "ok", output: "canned" };
      };

      const solEnvelopes = [];
      const fakeSolDispatch = async (input) => {
        solEnvelopes.push(input);
        return JSON.stringify({
          type: "verdict",
          schema_version: 1,
          gate_id: input.envelope.gate_id,
          envelope_sha256: input.envelope.envelope_sha256,
          verdict: "clear",
          summary: "sol:clear",
        });
      };

      const coordStreams = [
        (input) => stream(line("run_chain", input.envelope.envelope_sha256, { brief: VALID_RUN_CHAIN_BRIEF })),
        (input) => stream(line("finish", input.envelope.envelope_sha256, { recommendation: "recommend-accept" })),
      ];
      const coord = makeCoordinator(coordStreams);

      const result = await runLunaMission({
        cwd,
        missionFile,
        brief: MISSION_BRIEF,
        container: "cid-legacy",
        ...DEFAULT_SEATS,
        budget: DEFAULT_BUDGET,
        inject: {
          coordinatorDispatch: coord.dispatch,
          runChainLifecycle: fakeRunChain,
          callTool: fakeCallTool,
          solDispatch: fakeSolDispatch,
        },
      });

      assert.match(result, /disposition=recommend-accept/);
      const mission = readMission();
      assert.equal(mission.record.disposition, "recommend-accept");
      const diffCalls = toolCalls.filter((c) => c.name === "diff_in_container");
      assert.equal(diffCalls.length, 0, "no diff_in_container call must be made when chain files absent");

      const preAcceptSol = solEnvelopes.find((e) => e.gate.phase === "pre-accept");
      assert.ok(preAcceptSol);
      const diffItem = preAcceptSol.envelope.items.find((i) => i.role === "diff");
      assert.ok(diffItem);
      const diffText = fs.readFileSync(path.join(preAcceptSol.missionDir, diffItem.path), "utf8");
      assert.ok(diffText.includes("unavailable"), "diff item must explicitly state unavailable");
    });

    it("criterion 4: when diff_in_container throws, mission outcome is unchanged and diff item states failure", async () => {
      const fakeRunChain = async (_cwd, input) => {
        const id = input?.flags?.["chain-id"];
        const chainDir = path.join(stateDir, "chains", id);
        writeJson(path.join(chainDir, "chain.json"), {
          baseSha: "base-sha-failing-diff",
          records: [{ round: 1 }],
        });
        writeJson(path.join(chainDir, "round-1.json"), {
          round: 1,
          probeResults: [{ probe: "P1: HEAD clean", passed: true }],
          changeScope: {},
        });
        return `Chain ${id} completed`;
      };

      const fakeCallTool = async (name) => {
        if (name === "diff_in_container") {
          throw new Error("simulated tool failure in diff");
        }
        return { status: "ok" };
      };

      const solEnvelopes = [];
      const fakeSolDispatch = async (input) => {
        solEnvelopes.push(input);
        return JSON.stringify({
          type: "verdict",
          schema_version: 1,
          gate_id: input.envelope.gate_id,
          envelope_sha256: input.envelope.envelope_sha256,
          verdict: "clear",
          summary: "sol:clear",
        });
      };

      const coordStreams = [
        (input) => stream(line("run_chain", input.envelope.envelope_sha256, { brief: VALID_RUN_CHAIN_BRIEF })),
        (input) => stream(line("finish", input.envelope.envelope_sha256, { recommendation: "recommend-accept" })),
      ];
      const coord = makeCoordinator(coordStreams);

      const result = await runLunaMission({
        cwd,
        missionFile,
        brief: MISSION_BRIEF,
        container: "cid-faildiff",
        ...DEFAULT_SEATS,
        budget: DEFAULT_BUDGET,
        inject: {
          coordinatorDispatch: coord.dispatch,
          runChainLifecycle: fakeRunChain,
          callTool: fakeCallTool,
          solDispatch: fakeSolDispatch,
        },
      });

      assert.match(result, /disposition=recommend-accept/);
      const mission = readMission();
      assert.equal(mission.record.disposition, "recommend-accept");
      const preAcceptSol = solEnvelopes.find((e) => e.gate.phase === "pre-accept");
      assert.ok(preAcceptSol);
      const diffItem = preAcceptSol.envelope.items.find((i) => i.role === "diff");
      assert.ok(diffItem);
      const diffText = fs.readFileSync(path.join(preAcceptSol.missionDir, diffItem.path), "utf8");
      assert.ok(
        diffText.includes("post-chain diff unavailable: diff_in_container call threw: simulated tool failure"),
        "diff item must state failure",
      );
    });

    it("criterion 6: pre-accept rework records error naming real gate id, never undefined", async () => {
      const fakeRunChain = async (_cwd, input) => {
        const id = input?.flags?.["chain-id"];
        return `Chain ${id} completed`;
      };

      const fakeSolDispatch = async (input) => {
        const isPreAccept = input.gate.phase === "pre-accept";
        return JSON.stringify({
          type: "verdict",
          schema_version: 1,
          gate_id: input.envelope.gate_id,
          envelope_sha256: input.envelope.envelope_sha256,
          verdict: isPreAccept ? "rework" : "clear",
          summary: isPreAccept ? "sol:rework" : "sol:clear",
        });
      };

      // Turn 1: run_chain
      // Turn 2: finish recommend-accept -> Sol returns rework -> coordinator error recorded
      // Turn 3: escalate_to_host
      const coordStreams = [
        (input) => stream(line("run_chain", input.envelope.envelope_sha256, { brief: VALID_RUN_CHAIN_BRIEF })),
        (input) => stream(line("finish", input.envelope.envelope_sha256, { recommendation: "recommend-accept" })),
        (input) => stream(line("escalate_to_host", input.envelope.envelope_sha256, { reason: "rework required" })),
      ];
      const coord = makeCoordinator(coordStreams);

      const result = await runLunaMission({
        cwd,
        missionFile,
        brief: MISSION_BRIEF,
        container: "cid-rework",
        ...DEFAULT_SEATS,
        budget: DEFAULT_BUDGET,
        inject: {
          coordinatorDispatch: coord.dispatch,
          runChainLifecycle: fakeRunChain,
          callTool: async () => ({ status: "ok" }),
          solDispatch: fakeSolDispatch,
        },
      });

      assert.match(result, /disposition=host-handoff/);
      const mission = readMission();
      assert.equal(mission.record.disposition, "host-handoff");

      const reworkError = mission.record.coordinatorErrorsDetails.find((e) =>
        e.detail.includes("finish recommend-accept refused: pre-accept Sol gate"),
      );
      assert.ok(reworkError, "must record error for pre-accept rework");
      assert.match(
        reworkError.detail,
        /finish recommend-accept refused: pre-accept Sol gate gate-\d+ returned rework/,
      );
      assert.ok(!reworkError.detail.includes("undefined"), "error must name the real gate id, never undefined");
    });
  });
});
