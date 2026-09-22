// render-mission.test.mjs — acceptance tests for the kusabi #532 mission
// rendering surface (issue #532 criterion 3; frozen for the implementation
// chain).
//
// Frozen contract:
//
//   - Old plain-chain rendering is BYTE-IDENTICAL: the mission rendering
//     surface renders a plain chain exactly as the existing renderChainShow
//     (render-chain.mjs) does today — same bytes, same line order, no added
//     or reflowed content.
//
//   - Old mission fixtures retain their existing lines: the legacy mission
//     digest (the lines the existing renderMissionShow in luna-cmd.mjs
//     produces) must appear in the new renderMissionDigest output as a
//     byte-identical, contiguous prefix.  The #532 renderer only APPENDS the
//     provenance banner; it never rewrites or reflows the existing lines.
//
//   - The mission renderer adds a stable provenance banner that
//     distinguishes requested vs actual vs substituted seats for BOTH the
//     coordinator and the auditor, and names each seat's reasoning effort.
//
//   - The banner is deterministic: identical records produce identical
//     banner text.
//
// Public surface frozen here:
//
//   renderMissionDigest(snapshot) -> string
//     The legacy mission-digest lines followed by the provenance banner.
//     `snapshot` is the readMissionSnapshot shape ({ missionId, status,
//     control, record, ... }) the existing luna surfaces already produce.
//
//   renderMissionProvenanceBanner(record) -> string
//     The stable banner alone (no trailing newline): one line per seat with
//     provider/model, requested, actual, substituted and reasoning effort.
//
//   renderMissionChain(chain, rounds, control = null, opts = {}) -> string
//     A plain chain rendered through the mission surface; must be
//     byte-identical to renderChainShow(chain, rounds, [], control, opts).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderChainShow } from "./render-chain.mjs";
import { renderMissionShow } from "./luna-cmd.mjs";
import {
  renderMissionDigest,
  renderMissionProvenanceBanner,
  renderMissionChain,
} from "./render-mission.mjs";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const PLAIN_CHAIN = {
  chainId: "chain-1",
  container: "cid-1",
  orchestrator: { model: "claude-opus-5", session: "abc12345", date: "2026-09-01" },
  brief: "Orchestrator: gpt-5 | session abc12345 | 2026-09-01\n\n## Deliverables\n\n- x\n",
  records: [
    {
      round: 1,
      modelEntry: "opencode-go/deepseek-v4-flash",
      verdict: "approve",
      disposition: { disposition: "accept" },
      worktreeChanged: true,
      probeResults: [{ probe: "P1: HEAD clean", passed: true, detail: "ok" }],
    },
  ],
};

const MISSION_RECORD = {
  missionId: "mission-abc",
  container: "cid-1",
  status: "completed",
  disposition: "recommend-accept",
  recommendation: "recommend-accept",
  coordinator: {
    provider: "codex",
    model: "gpt-5.6-luna",
    requested: "gpt-5.6-luna",
    actual: "gpt-5.6-luna",
    substituted: false,
    reasoningEffort: "high",
  },
  auditor: {
    provider: "codex",
    model: "gpt-5.6-sol",
    requested: "gpt-5.6-sol",
    actual: "gpt-5.6-sol",
    substituted: false,
    reasoningEffort: "high",
  },
  chains: ["chain-inner-1"],
  attempts: [{ index: 1, action: "run_chain", chainId: "chain-inner-1" }],
  coordinatorErrors: 0,
  consults: [],
  auditGates: [],
};

const SNAPSHOT = {
  missionId: "mission-abc",
  status: "completed",
  disposition: "recommend-accept",
  control: { missionId: "mission-abc", status: "completed" },
  record: MISSION_RECORD,
};

describe("render-mission (kusabi #532 criterion 3)", () => {
  it("surface: exports the frozen render functions", () => {
    assert.equal(typeof renderMissionDigest, "function");
    assert.equal(typeof renderMissionProvenanceBanner, "function");
    assert.equal(typeof renderMissionChain, "function");
  });

  it("old plain-chain rendering is byte-identical through the mission surface", () => {
    const legacy = renderChainShow(PLAIN_CHAIN, PLAIN_CHAIN.records, [], null);
    const viaMission = renderMissionChain(PLAIN_CHAIN, PLAIN_CHAIN.records);
    assert.equal(viaMission, legacy, "a plain chain must render byte-identically");
  });

  it("old mission fixtures retain their existing lines as a byte-identical contiguous prefix", () => {
    const legacyDigest = renderMissionShow(SNAPSHOT);
    const full = renderMissionDigest(SNAPSHOT);
    const legacyLines = legacyDigest.split("\n");
    const fullLines = full.split("\n");
    assert.ok(
      fullLines.length >= legacyLines.length,
      "the new digest must contain the legacy lines plus the banner",
    );
    assert.deepEqual(
      fullLines.slice(0, legacyLines.length),
      legacyLines,
      "the legacy mission lines must appear first, byte-for-byte, without reflow",
    );
  });

  it("adds a stable provenance banner that distinguishes requested/actual/substituted seats", () => {
    const banner = renderMissionProvenanceBanner(MISSION_RECORD);
    assert.match(banner, /coordinator/);
    assert.match(banner, /codex\/gpt-5\.6-luna/);
    assert.match(banner, /requested: gpt-5\.6-luna/);
    assert.match(banner, /actual: gpt-5\.6-luna/);
    assert.match(banner, /substituted: false/);
    assert.match(banner, /reasoning effort: high/);
    assert.match(banner, /auditor/);
    assert.match(banner, /codex\/gpt-5\.6-sol/);

    const digest = renderMissionDigest(SNAPSHOT);
    assert.match(digest, /coordinator/);
    assert.match(digest, /substituted: false/);
  });

  it("a substituted seat is loud: requested and actual differ in the banner", () => {
    const record = {
      ...MISSION_RECORD,
      coordinator: {
        provider: "codex",
        model: "gpt-5.6-luna-alternate",
        requested: "gpt-5.6-luna",
        actual: "gpt-5.6-luna-alternate",
        substituted: true,
        reasoningEffort: "high",
      },
    };
    const banner = renderMissionProvenanceBanner(record);
    assert.match(banner, /requested: gpt-5\.6-luna/);
    assert.match(banner, /actual: gpt-5\.6-luna-alternate/);
    assert.match(banner, /substituted: true/);
  });

  it("the banner is deterministic: identical records produce identical bytes", () => {
    const first = renderMissionProvenanceBanner(MISSION_RECORD);
    const second = renderMissionProvenanceBanner(MISSION_RECORD);
    assert.equal(first, second);
  });

  it("a legacy record without reasoning effort degrades the banner, never fabricates one", () => {
    const record = { ...MISSION_RECORD };
    delete record.coordinator.reasoningEffort;
    const banner = renderMissionProvenanceBanner(record);
    assert.doesNotMatch(banner, /reasoning effort: high/);
  });
});