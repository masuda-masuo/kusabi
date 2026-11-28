// Acceptance tests for acknowledging a closed chain's kaiba inbox entries.
// The stdio child below is a protocol fixture that substitutes for kaiba; it
// never touches a real kaiba server or the operator's config.

import { after, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { archiveReviewRecord } from "./review-record-archive.mjs";
import { closeReviewRecords, cmdReviewRecordClose } from "./review-record-close.mjs";
import { rearmChainControl } from "./chain-control.mjs";
import {
  KAIBA_INBOX_TOOLS,
  acknowledgeChainInbox,
  ackTimeoutFor,
  notifyChainTerminal,
} from "./chain-notify.mjs";

const CWD = path.join(os.tmpdir(), "kusabi-chain-inbox-ack-workspace");
const BEFORE = "2022-01-01T00:00:00.000Z";

const fixtureServerSource = String.raw`
import fs from "node:fs";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

const [mode, logPath, statePath, descendantPidPath, markerPath] = process.argv.slice(2);
const log = (row) => { fs.appendFileSync(logPath, JSON.stringify(row) + "\n"); };
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");

let child;
if (mode === "hang") {
  child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(descendantPidPath, String(child.pid));
}
const stop = () => {
  if (child && child.exitCode === null) {
    child.once("exit", () => process.exit(0));
    child.kill("SIGTERM");
    return;
  }
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

const ackTools = () => {
  if (mode === "missing-tool") return [];
  const subjectSchema = mode === "schema-mismatch" ? { type: "number" } : { type: "string" };
  return [{
    name: "inbox_ack_subject",
    description: "Acknowledge the open inbox entries for a subject.",
    inputSchema: {
      type: "object",
      properties: { subject: subjectSchema },
      required: ["subject"]
    }
  }];
};

const readState = () => fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { acked: [] };

for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try { request = JSON.parse(line.toString()); } catch { continue; }
  log({
    request,
    markerExists: markerPath ? fs.existsSync(markerPath) : null,
    env: {
      producer: process.env.KAIBA_INBOX_PRODUCER,
      readonly: process.env.KAIBA_READONLY,
      configured: process.env.FIXTURE_CONFIGURED_ENV
    }
  });
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "kaiba-ack-fixture", version: "1.0.0" }
    } });
  } else if (request.method === "notifications/initialized") {
    // Notification: no response.
  } else if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools: ackTools() } });
  } else if (request.method === "tools/call") {
    if (mode === "hang") continue;
    if (mode === "rpc-error") {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "fixture ack failure" } });
      continue;
    }
    if (mode === "error-result") {
      send({ jsonrpc: "2.0", id: request.id, result: {
        content: [{ type: "text", text: "fixture ack failure" }],
        structuredContent: { error: "fixture ack failure" }
      } });
      continue;
    }
    const subject = request.params.arguments && request.params.arguments.subject;
    const state = readState();
    const acknowledged = state.acked.includes(subject) ? [] : [{ id: "entry-" + subject }];
    if (!state.acked.includes(subject)) {
      state.acked.push(subject);
      fs.writeFileSync(statePath, JSON.stringify(state));
    }
    send({ jsonrpc: "2.0", id: request.id, result: {
      content: [{ type: "text", text: JSON.stringify({ acknowledged }) }],
      structuredContent: { acknowledged }
    } });
  }
}
`;

// Stateful protocol fixture: it stores appended entries and implements
// inbox_ack_subject by exact producer+subject match on the still-open entries.
// That is the property the isolation test needs, and it is the same rule kaiba
// applies. It never touches a real kaiba server.
const statefulFixtureServerSource = String.raw`
import fs from "node:fs";
import { createInterface } from "node:readline";

const [statePath] = process.argv.slice(2);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const readState = () => fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, "utf8"))
  : { entries: [] };
const writeState = (state) => fs.writeFileSync(statePath, JSON.stringify(state));

const tools = [
  {
    name: "inbox_append",
    description: "Append a terminal event.",
    inputSchema: {
      type: "object",
      properties: {
        event_key: { type: "string" },
        event_type: { type: "string" },
        subject: { type: "string" },
        title: { type: "string" },
        metadata: { type: "object" }
      },
      required: ["event_key", "event_type", "subject", "title"]
    }
  },
  {
    name: "inbox_ack_subject",
    description: "Acknowledge the open inbox entries for a subject.",
    inputSchema: {
      type: "object",
      properties: { subject: { type: "string" } },
      required: ["subject"]
    }
  }
];

for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try { request = JSON.parse(line.toString()); } catch { continue; }
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "kaiba-stateful-fixture", version: "1.0.0" }
    } });
  } else if (request.method === "notifications/initialized") {
    // Notification: no response.
  } else if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools } });
  } else if (request.method === "tools/call") {
    const state = readState();
    const args = request.params.arguments ?? {};
    if (request.params.name === "inbox_append") {
      const existing = state.entries.find((entry) => entry.event_key === args.event_key);
      if (existing) {
        send({ jsonrpc: "2.0", id: request.id, result: {
          structuredContent: { entry: { id: existing.id }, duplicate: true }
        } });
        continue;
      }
      const entry = {
        id: "entry-" + (state.entries.length + 1),
        producer: process.env.KAIBA_INBOX_PRODUCER ?? null,
        event_key: args.event_key,
        subject: args.subject,
        open: true
      };
      state.entries.push(entry);
      writeState(state);
      send({ jsonrpc: "2.0", id: request.id, result: {
        structuredContent: { entry: { id: entry.id }, duplicate: false }
      } });
    } else if (request.params.name === "inbox_ack_subject") {
      const producer = process.env.KAIBA_INBOX_PRODUCER ?? null;
      const acknowledged = state.entries
        .filter((entry) => entry.open && entry.producer === producer && entry.subject === args.subject)
        .map((entry) => entry.id);
      for (const entry of state.entries) {
        if (acknowledged.includes(entry.id)) entry.open = false;
      }
      writeState(state);
      send({ jsonrpc: "2.0", id: request.id, result: {
        structuredContent: { acknowledged }
      } });
    } else {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "unknown tool" } });
    }
  }
}
`;

function makeStatefulFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-chain-inbox-stateful-"));
  tempDirs.add(dir);
  const serverPath = path.join(dir, "stateful-fixture.mjs");
  const configPath = path.join(dir, "opencode.jsonc");
  const statePath = path.join(dir, "stateful-state.json");
  fs.writeFileSync(serverPath, statefulFixtureServerSource);
  const config = {
    mcp: {
      kaiba: {
        type: "local",
        command: [process.execPath, serverPath, statePath],
        environment: {},
        enabled: true,
      },
    },
  };
  fs.writeFileSync(configPath, "// Test-only stateful fixture config.\n" + JSON.stringify(config, null, 2));
  return { dir, configPath, statePath };
}

function readStatefulState(fixture) {
  return fs.existsSync(fixture.statePath)
    ? JSON.parse(fs.readFileSync(fixture.statePath, "utf8"))
    : { entries: [] };
}

const tempDirs = new Set();
const leakedPids = new Set();

after(() => {
  for (const pid of leakedPids) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function workspaceHash() {
  return crypto.createHash("sha256").update(CWD).digest("hex").slice(0, 12);
}

function makeAckFixture(mode = "success", { markerPath = "" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-chain-inbox-ack-"));
  tempDirs.add(dir);
  const serverPath = path.join(dir, "ack-fixture.mjs");
  const configPath = path.join(dir, "opencode.jsonc");
  const logPath = path.join(dir, "requests.jsonl");
  const statePath = path.join(dir, "ack-state.json");
  const descendantPidPath = path.join(dir, "descendant.pid");
  fs.writeFileSync(serverPath, fixtureServerSource);
  const config = {
    mcp: {
      kaiba: {
        type: "local",
        command: [process.execPath, serverPath, mode, logPath, statePath, descendantPidPath, ...(markerPath ? [markerPath] : [])],
        environment: { FIXTURE_CONFIGURED_ENV: "preserved" },
        enabled: true,
      },
    },
  };
  fs.writeFileSync(configPath, "// Test-only fixture config.\n" + JSON.stringify(config, null, 2));
  return { dir, configPath, logPath, statePath, descendantPidPath, markerPath };
}

function requestRows(fixture) {
  if (!fs.existsSync(fixture.logPath)) return [];
  return fs.readFileSync(fixture.logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function ackCalls(fixture) {
  return requestRows(fixture).filter(({ request }) => request.method === "tools/call");
}

function spawnCount(fixture) {
  return requestRows(fixture).filter(({ request }) => request.method === "initialize").length;
}

function withStderr(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.map(String).join(" ")); };
  try {
    return { result: fn(), lines };
  } finally {
    console.error = original;
  }
}

function assertDescendantGone(fixture) {
  const pid = Number(fs.readFileSync(fixture.descendantPidPath, "utf8"));
  leakedPids.add(pid);
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false, `fixture descendant ${pid} should be terminated`);
}

function makeArchiveFixture({ chainId = "chain-test", record, repo = "owner/repo", brief = "A short brief" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-ack-archive-"));
  tempDirs.add(root);
  const chainDir = path.join(root, workspaceHash(), "chains", chainId);
  const clone = path.join(root, "kairanban");
  fs.mkdirSync(chainDir, { recursive: true });
  fs.mkdirSync(path.join(clone, ".git"), { recursive: true });
  const content = record ?? [
    "# [review-record] repo " + chainId,
    "## Findings adjudication (fill at inspection)",
    "",
    "| # | severity | finding | verdict | reason |",
    "|---|---|---|---|---|",
    "| 1 | low | finding | 採用 | passed |",
    "",
    "## Usage",
    "input=0",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(chainDir, "review-record.md"), content);
  fs.writeFileSync(path.join(chainDir, "chain.json"), JSON.stringify({ repo, brief }));
  const targetDir = path.join(clone, "records", repo.split("/")[1], chainId);
  return { root, chainDir, clone, targetDir, targetRecordPath: path.join(targetDir, "review-record.md") };
}

function archive(f, overrides = {}) {
  return archiveReviewRecord({
    chainId: "chain-test",
    kairanbanDir: f.clone,
    stateRootDir: f.root,
    cwd: CWD,
    ...overrides,
  });
}

function makeCloseRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-ack-close-"));
  tempDirs.add(root);
  return root;
}

function writeRecord(root, chain, finished = "2021-01-01T00:00:00.000Z", hash = "workspace-hash") {
  const recordPath = path.join(root, hash, "chains", chain, "review-record.md");
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  const finishedHeader = finished === null ? "" : `Orchestrator: test | finished: ${finished}\n`;
  const content = `# [review-record] repo ${chain}\n${finishedHeader}## Findings adjudication (fill at inspection)\n| # | severity | finding | 採否 | 理由 |\n|---|---|---|---|---|\n| 1 | low | old finding | _fill_ | _fill_ |\n## 判例として (fill at inspection)\n_fill: reusable precedent, if any_\n`;
  fs.writeFileSync(recordPath, content);
  return recordPath;
}

describe("archive acknowledges a closed chain", () => {
  it("acks exactly once with the chain id after the files exist, and stdout matches the opt-out", () => {
    const f = makeArchiveFixture();
    const fixture = makeAckFixture("success", { markerPath: f.targetRecordPath });
    const { result: output, lines } = withStderr(() => archive(f, {
      mcpConfigFile: fixture.configPath,
      env: { KUSABI_CHAIN_NOTIFY: "1" },
    }));

    assert.match(output, /wrote records\/repo\/chain-test\/review-record\.md/);
    assert.deepEqual(lines, []);
    assert.equal(fs.existsSync(f.targetRecordPath), true);

    const rows = requestRows(fixture);
    assert.equal(spawnCount(fixture), 1, "one kaiba spawn");
    const calls = ackCalls(fixture);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].request.params.name, "inbox_ack_subject");
    assert.deepEqual(calls[0].request.params.arguments, { subject: `${workspaceHash()}:chain-test` });
    assert.equal(calls[0].markerExists, true, "the archive files existed before the ack call");
    assert.ok(rows.every(({ env }) => env.producer === "kusabi" && env.readonly === "1"));
    assert.ok(rows.every(({ env }) => env.configured === "preserved"));

    // Same paths, same input, notifier opted out: byte-identical stdout.
    fs.rmSync(f.targetDir, { recursive: true, force: true });
    const { result: optedOut } = withStderr(() => archive(f, {
      mcpConfigFile: fixture.configPath,
      env: { KUSABI_CHAIN_NOTIFY: "0" },
    }));
    assert.equal(optedOut, output);
    assert.equal(ackCalls(fixture).length, 1, "the opt-out spawned nothing");
  });

  it("acks again when the record is unchanged (kaiba keeps the ack idempotent)", () => {
    const f = makeArchiveFixture();
    const fixture = makeAckFixture("success");

    const first = archive(f, { mcpConfigFile: fixture.configPath, env: { KUSABI_CHAIN_NOTIFY: "1" } });
    const second = archive(f, { mcpConfigFile: fixture.configPath, env: { KUSABI_CHAIN_NOTIFY: "1" } });

    assert.match(first, /^wrote/m);
    assert.match(second, /^unchanged/m);
    assert.equal(spawnCount(fixture), 2, "one spawn per archive call");
    assert.deepEqual(ackCalls(fixture).map(({ request }) => request.params.arguments), [
      { subject: `${workspaceHash()}:chain-test` },
      { subject: `${workspaceHash()}:chain-test` },
    ]);
  });

  it("makes no ack call when the archive throws", () => {
    const unfilled = makeArchiveFixture({ record: [
      "# record",
      "## Findings adjudication (fill at inspection)",
      "| 1 | low | finding | _fill_ | _fill_ |",
    ].join("\n") });
    const unfilledFixture = makeAckFixture("success");
    assert.throws(() => archive(unfilled, {
      mcpConfigFile: unfilledFixture.configPath,
      env: { KUSABI_CHAIN_NOTIFY: "1" },
    }), /unfilled rows: 1/);
    assert.deepEqual(requestRows(unfilledFixture), []);

    const missing = makeArchiveFixture();
    fs.rmSync(path.join(missing.chainDir, "review-record.md"));
    const missingFixture = makeAckFixture("success");
    assert.throws(() => archive(missing, {
      mcpConfigFile: missingFixture.configPath,
      env: { KUSABI_CHAIN_NOTIFY: "1" },
    }), /review record not found/);
    assert.deepEqual(requestRows(missingFixture), []);

    const differs = makeArchiveFixture();
    const differsFixture = makeAckFixture("success");
    archive(differs, { mcpConfigFile: differsFixture.configPath, env: { KUSABI_CHAIN_NOTIFY: "0" } });
    fs.writeFileSync(path.join(differs.targetDir, "brief.md"), "old\n");
    assert.throws(() => archive(differs, {
      mcpConfigFile: differsFixture.configPath,
      env: { KUSABI_CHAIN_NOTIFY: "1" },
    }), /target differs/);
    assert.deepEqual(requestRows(differsFixture), []);
  });
});

describe("historical close acknowledges the chains it wrote", () => {
  it("makes one spawn and one ack call per written record and acknowledges nothing on a dry run", () => {
    const root = makeCloseRoot();
    const fixture = makeAckFixture("success");
    const written = [
      writeRecord(root, "chain-a"),
      writeRecord(root, "chain-b"),
      writeRecord(root, "chain-c"),
    ];
    writeRecord(root, "chain-skipped", null);
    writeRecord(root, "chain-future", "2023-01-01T00:00:00.000Z");

    const result = closeReviewRecords({
      before: BEFORE,
      stateRootDir: root,
      apply: true,
      mcpConfigFile: fixture.configPath,
      env: { KUSABI_CHAIN_NOTIFY: "1" },
    });

    assert.equal(result.written, 3);
    assert.deepEqual(result.targets, written);
    assert.equal(spawnCount(fixture), 1, "one kaiba spawn for the whole close run");
    const subjects = ackCalls(fixture).map(({ request }) => request.params.arguments.subject);
    assert.deepEqual([...subjects].sort(), [
      "workspace-hash:chain-a",
      "workspace-hash:chain-b",
      "workspace-hash:chain-c",
    ]);

    const dryRoot = makeCloseRoot();
    writeRecord(dryRoot, "chain-dry");
    const dryFixture = makeAckFixture("success");
    const dry = closeReviewRecords({
      before: BEFORE,
      stateRootDir: dryRoot,
      apply: false,
      mcpConfigFile: dryFixture.configPath,
      env: { KUSABI_CHAIN_NOTIFY: "1" },
    });
    assert.equal(dry.written, 0);
    assert.deepEqual(requestRows(dryFixture), []);
  });
});

describe("ack failures are fail-soft and observable", () => {
  for (const mode of ["missing-tool", "schema-mismatch", "error-result", "hang"]) {
    it(`archive stays successful and logs the chain id when kaiba is ${mode}`, () => {
      const f = makeArchiveFixture();
      const fixture = makeAckFixture(mode);
      const started = Date.now();
      const { result: output, lines } = withStderr(() => archive(f, {
        mcpConfigFile: fixture.configPath,
        env: { KUSABI_CHAIN_NOTIFY: "1" },
      }));

      assert.match(output, /wrote/);
      assert.ok(lines.some((line) => line.startsWith("[chain-notify]") && line.includes("chain-test")),
        `expected a [chain-notify] line naming the chain, got: ${lines.join(" | ")}`);
      if (mode === "hang") {
        assert.ok(Date.now() - started < 5000, "bounded by the stated ack bound");
        assertDescendantGone(fixture);
      }
    });

    it(`historical close stays successful and logs the chain id when kaiba is ${mode}`, () => {
      const root = makeCloseRoot();
      const recordPath = writeRecord(root, "chain-mode");
      const fixture = makeAckFixture(mode);
      const started = Date.now();
      const { result, lines } = withStderr(() => closeReviewRecords({
        before: BEFORE,
        stateRootDir: root,
        apply: true,
        mcpConfigFile: fixture.configPath,
        env: { KUSABI_CHAIN_NOTIFY: "1" },
      }));

      assert.equal(result.written, 1);
      assert.deepEqual(result.targets, [recordPath]);
      assert.ok(lines.some((line) => line.startsWith("[chain-notify]") && line.includes("chain-mode")),
        `expected a [chain-notify] line naming the chain, got: ${lines.join(" | ")}`);
      if (mode === "hang") {
        assert.ok(Date.now() - started < 5000, "bounded by the stated ack bound");
        assertDescendantGone(fixture);
      }
    });
  }

  it("archive and close stay successful and log when the kaiba definition is absent", () => {
    const f = makeArchiveFixture();
    const absentConfig = path.join(f.root, "no-such-config.jsonc");
    const { result: archiveOutput, lines: archiveLines } = withStderr(() => archive(f, {
      mcpConfigFile: absentConfig,
      env: { KUSABI_CHAIN_NOTIFY: "1" },
    }));
    assert.match(archiveOutput, /wrote/);
    assert.ok(archiveLines.some((line) => line.startsWith("[chain-notify]") && line.includes("chain-test")),
      `expected a [chain-notify] line naming the chain, got: ${archiveLines.join(" | ")}`);

    const root = makeCloseRoot();
    writeRecord(root, "chain-absent");
    const { result, lines } = withStderr(() => closeReviewRecords({
      before: BEFORE,
      stateRootDir: root,
      apply: true,
      mcpConfigFile: absentConfig,
      env: { KUSABI_CHAIN_NOTIFY: "1" },
    }));
    assert.equal(result.written, 1);
    assert.ok(lines.some((line) => line.startsWith("[chain-notify]") && line.includes("chain-absent")),
      `expected a [chain-notify] line naming the chain, got: ${lines.join(" | ")}`);
  });
});

describe("opt-out and the ack bound", () => {
  it("KUSABI_CHAIN_NOTIFY=0 spawns no kaiba for archive or close", () => {
    const f = makeArchiveFixture();
    const fixture = makeAckFixture("success");
    const output = archive(f, { mcpConfigFile: fixture.configPath, env: { KUSABI_CHAIN_NOTIFY: "0" } });
    assert.match(output, /wrote/);
    assert.deepEqual(requestRows(fixture), []);

    const root = makeCloseRoot();
    writeRecord(root, "chain-optout");
    const closeFixture = makeAckFixture("success");
    const result = closeReviewRecords({
      before: BEFORE,
      stateRootDir: root,
      apply: true,
      mcpConfigFile: closeFixture.configPath,
      env: { KUSABI_CHAIN_NOTIFY: "0" },
    });
    assert.equal(result.written, 1);
    assert.deepEqual(requestRows(closeFixture), []);
  });

  it("bounds every ack attempt to 2 s regardless of the subject count", () => {
    assert.equal(ackTimeoutFor(), 2000);
    assert.equal(ackTimeoutFor(10_000), 2000);
    assert.equal(ackTimeoutFor(500), 500);
  });

  it("acknowledgeChainInbox skips without spawning when opted out", () => {
    const fixture = makeAckFixture("success");
    const result = acknowledgeChainInbox({
      chains: [
        { stateDir: path.join(fixture.dir, "state-a"), chainId: "chain-a" },
        { stateDir: path.join(fixture.dir, "state-b"), chainId: "chain-b" },
      ],
      env: { KUSABI_CHAIN_NOTIFY: "0" },
      mcpConfigFile: fixture.configPath,
    });
    assert.equal(result.skipped, true);
    assert.deepEqual(requestRows(fixture), []);
  });
});


describe("ack isolation across different state directories", () => {
  it("acknowledges only the closing state directory's entries when different state directories share a chain id", () => {
    const rootA = makeCloseRoot();
    const rootB = makeCloseRoot();
    const hashA = "aaaaaaaaaaaa";
    const hashB = "bbbbbbbbbbbb";
    const chainId = "chain-same";
    writeRecord(rootA, chainId, "2021-01-01T00:00:00.000Z", hashA);
    writeRecord(rootB, chainId, "2021-01-01T00:00:00.000Z", hashB);

    const fixture = makeStatefulFixture();
    const notify = (root, hash, occurrenceId) => notifyChainTerminal({
      stateDir: path.join(root, hash),
      chainId,
      status: "completed",
      disposition: "accept",
      occurrenceId,
      mcpConfigFile: fixture.configPath,
      env: { KUSABI_CHAIN_NOTIFY: "1" },
    });

    assert.equal(notify(rootA, hashA, "occ-1").inboxDelivered, true);
    assert.equal(notify(rootA, hashA, "occ-2").inboxDelivered, true);
    assert.equal(notify(rootB, hashB, "occ-b1").inboxDelivered, true);

    const { result, lines } = withStderr(() => closeReviewRecords({
      before: BEFORE,
      stateRootDir: rootA,
      apply: true,
      mcpConfigFile: fixture.configPath,
      env: { KUSABI_CHAIN_NOTIFY: "1" },
    }));
    assert.equal(result.written, 1);
    assert.deepEqual(lines, []);

    const state = readStatefulState(fixture);
    const closed = state.entries.filter((entry) => entry.subject === `${hashA}:${chainId}`);
    const other = state.entries.filter((entry) => entry.subject === `${hashB}:${chainId}`);
    assert.equal(closed.length, 2, "two occurrences in the closed state directory");
    assert.deepEqual(closed.map((entry) => entry.open), [false, false],
      "every occurrence in the closed state directory is acknowledged");
    assert.equal(other.length, 1, "the same chain id in the other state directory is a distinct entry");
    assert.equal(other[0].open, true,
      "the other state directory's entry stays open");
  });
});

describe("the ack bound does not scale with the number of chains", () => {
  it("finishes a hanging close of many chain ids within the append bound and reaps the fixture", () => {
    const root = makeCloseRoot();
    const chainIds = Array.from({ length: 30 }, (_, index) => `chain-many-${index}`);
    for (const chainId of chainIds) writeRecord(root, chainId);

    const fixture = makeAckFixture("hang");
    const started = Date.now();
    const { result, lines } = withStderr(() => closeReviewRecords({
      before: BEFORE,
      stateRootDir: root,
      apply: true,
      mcpConfigFile: fixture.configPath,
      env: { KUSABI_CHAIN_NOTIFY: "1" },
    }));
    const elapsed = Date.now() - started;

    assert.equal(result.written, chainIds.length);
    assert.equal(spawnCount(fixture), 1, "one kaiba spawn for the whole close run");
    assert.ok(elapsed < 4000, `expected ~2 s + cleanup grace, took ${elapsed} ms`);
    assert.ok(lines.length > 0 && lines.every((line) => line.startsWith("[chain-notify]")),
      `expected only [chain-notify] lines, got: ${lines.join(" | ")}`);
    assertDescendantGone(fixture);
  });
});

describe("shared kaiba tool list", () => {
  it("declares both inbox operations used by the append and ack lookups", () => {
    assert.deepEqual(KAIBA_INBOX_TOOLS, ["inbox_append", "inbox_ack_subject"]);
  });
});

function writeControl(root, chain, control, hash = "workspace-hash") {
  const chainDir = path.join(root, hash, "chains", chain);
  fs.mkdirSync(chainDir, { recursive: true });
  if (control !== null) {
    fs.writeFileSync(path.join(chainDir, "control.json"), JSON.stringify(control, null, 2));
  }
  return chainDir;
}

function snapshotTree(root) {
  const entries = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      entries.push(`${path.relative(root, fullPath)}${entry.isDirectory() ? "/" : ""}`);
      if (entry.isDirectory()) walk(fullPath);
    }
  }
  walk(root);
  return entries.sort();
}

describe("historical close acknowledges record-less terminal chains", () => {
  it("acknowledges record-less failed and cancelled chains before --before via stateful fixture without creating any files", () => {
    const root = makeCloseRoot();
    const hash = "aaaaaaaaaaaa";
    writeControl(root, "chain-failed", {
      chainId: "chain-failed",
      status: "failed",
      finishedAt: "2021-06-01T00:00:00.000Z",
      terminalOccurrenceId: "occ-fail-1",
    }, hash);
    writeControl(root, "chain-cancelled", {
      chainId: "chain-cancelled",
      status: "cancelled",
      finishedAt: "2021-07-01T00:00:00.000Z",
      terminalOccurrenceId: "occ-cancel-1",
    }, hash);
    writeControl(root, "chain-completed", {
      chainId: "chain-completed",
      status: "completed",
      finishedAt: "2021-08-01T00:00:00.000Z",
      terminalOccurrenceId: "occ-done-1",
    }, hash);

    const fixture = makeStatefulFixture();
    const stateDir = path.join(root, hash);
    for (const [chainId, status, occurrenceId] of [
      ["chain-failed", "failed", "occ-fail-1"],
      ["chain-cancelled", "cancelled", "occ-cancel-1"],
      ["chain-completed", "completed", "occ-done-1"],
    ]) {
      assert.equal(notifyChainTerminal({
        stateDir,
        chainId,
        status,
        disposition: null,
        occurrenceId,
        mcpConfigFile: fixture.configPath,
        env: { KUSABI_CHAIN_NOTIFY: "1" },
      }).inboxDelivered, true);
    }

    const beforeTree = snapshotTree(root);
    const { result: output, lines } = withStderr(() => cmdReviewRecordClose(
      ["--historical", "--before", BEFORE, "--apply", "--state-root", root],
      { mcpConfigFile: fixture.configPath, env: { KUSABI_CHAIN_NOTIFY: "1" } },
    ));

    assert.deepEqual(lines, []);
    assert.deepEqual(snapshotTree(root), beforeTree, "no file or directory created under state root");
    assert.match(output, /^Wrote 0 historical mark\(s\)\.$/m);
    assert.match(output, /^Acknowledged 3 record-less chain\(s\)\.$/m);

    const state = readStatefulState(fixture);
    assert.equal(state.entries.length, 3);
    assert.deepEqual(state.entries.map((entry) => entry.open), [false, false, false]);
  });

  it("excludes non-qualifying record-less chains and chains without terminalOccurrenceId", () => {
    const root = makeCloseRoot();
    const hash = "bbbbbbbbbbbb";
    writeControl(root, "chain-future", {
      chainId: "chain-future",
      status: "failed",
      finishedAt: "2023-01-01T00:00:00.000Z",
      terminalOccurrenceId: "occ-future",
    }, hash);
    writeControl(root, "chain-running", {
      chainId: "chain-running",
      status: "running",
      finishedAt: "2021-01-01T00:00:00.000Z",
      terminalOccurrenceId: "occ-running",
    }, hash);
    writeControl(root, "chain-stopping", {
      chainId: "chain-stopping",
      status: "stopping",
      finishedAt: "2021-01-01T00:00:00.000Z",
      terminalOccurrenceId: "occ-stopping",
    }, hash);
    writeControl(root, "chain-no-control", null, hash);
    writeControl(root, "chain-no-finished", {
      chainId: "chain-no-finished",
      status: "failed",
      terminalOccurrenceId: "occ-no-finished",
    }, hash);
    writeControl(root, "chain-bad-finished", {
      chainId: "chain-bad-finished",
      status: "cancelled",
      finishedAt: "not-a-date",
      terminalOccurrenceId: "occ-bad-finished",
    }, hash);
    writeControl(root, "chain-no-occurrence", {
      chainId: "chain-no-occurrence",
      status: "failed",
      finishedAt: "2021-01-01T00:00:00.000Z",
    }, hash);
    writeControl(root, "chain-empty-occurrence", {
      chainId: "chain-empty-occurrence",
      status: "cancelled",
      finishedAt: "2021-01-01T00:00:00.000Z",
      terminalOccurrenceId: "",
    }, hash);
    // chain.json finishedAt/status must not override control.json.
    const chainJsonOnlyDir = writeControl(root, "chain-json-only", {
      chainId: "chain-json-only",
      status: "running",
      terminalOccurrenceId: "occ-json-only",
    }, hash);
    fs.writeFileSync(path.join(chainJsonOnlyDir, "chain.json"), JSON.stringify({
      chainId: "chain-json-only",
      status: "failed",
      finishedAt: "2020-01-01T00:00:00.000Z",
    }));
    // A chain with a review-record.md must follow only the record path even if control.json looks record-less.
    writeRecord(root, "chain-has-record", "2023-01-01T00:00:00.000Z", hash);
    writeControl(root, "chain-has-record", {
      chainId: "chain-has-record",
      status: "failed",
      finishedAt: "2020-01-01T00:00:00.000Z",
      terminalOccurrenceId: "occ-has-record",
    }, hash);

    const fixture = makeAckFixture("success");
    const dryOutput = cmdReviewRecordClose(
      ["--historical", "--before", BEFORE, "--state-root", root],
      { mcpConfigFile: fixture.configPath, env: { KUSABI_CHAIN_NOTIFY: "1" } },
    );
    assert.equal(dryOutput, "Targets: 0\nSkipped: 0");
    assert.deepEqual(requestRows(fixture), []);

    const applyResult = closeReviewRecords({
      before: BEFORE,
      stateRootDir: root,
      apply: true,
      mcpConfigFile: fixture.configPath,
      env: { KUSABI_CHAIN_NOTIFY: "1" },
    });
    assert.equal(applyResult.written, 0);
    assert.deepEqual(applyResult.recordless, []);
    assert.equal(applyResult.recordlessAcknowledged, 0);
    assert.deepEqual(requestRows(fixture), []);
  });

  it("lists record-less chains in their own dry-run block without writing or spawning kaiba", () => {
    const root = makeCloseRoot();
    const hash = "cccccccccccc";
    const recordPath = writeRecord(root, "chain-rec", "2021-01-01T00:00:00.000Z", hash);
    writeControl(root, "chain-rl-b", {
      chainId: "chain-rl-b",
      status: "cancelled",
      finishedAt: "2021-03-01T00:00:00.000Z",
      terminalOccurrenceId: "occ-b",
    }, hash);
    writeControl(root, "chain-rl-a", {
      chainId: "chain-rl-a",
      status: "failed",
      finishedAt: "2021-02-01T00:00:00.000Z",
      terminalOccurrenceId: "occ-a",
    }, hash);
    writeControl(root, "chain-rl-no-occ", {
      chainId: "chain-rl-no-occ",
      status: "failed",
      finishedAt: "2021-01-01T00:00:00.000Z",
    }, hash);

    const fixture = makeAckFixture("success");
    const beforeRecord = fs.readFileSync(recordPath, "utf8");
    const beforeTree = snapshotTree(root);

    const result = closeReviewRecords({
      before: BEFORE,
      stateRootDir: root,
      apply: false,
      mcpConfigFile: fixture.configPath,
      env: { KUSABI_CHAIN_NOTIFY: "1" },
    });
    assert.equal(result.written, 0);
    assert.deepEqual(result.targets, [recordPath]);
    assert.deepEqual(result.recordless, [
      {
        stateDir: path.join(root, hash),
        chainId: "chain-rl-a",
        status: "failed",
        finishedAt: "2021-02-01T00:00:00.000Z",
      },
      {
        stateDir: path.join(root, hash),
        chainId: "chain-rl-b",
        status: "cancelled",
        finishedAt: "2021-03-01T00:00:00.000Z",
      },
    ]);

    const output = cmdReviewRecordClose(
      ["--historical", "--before", BEFORE, "--state-root", root],
      { mcpConfigFile: fixture.configPath, env: { KUSABI_CHAIN_NOTIFY: "1" } },
    );
    assert.equal(output, [
      "Targets: 1",
      `target: ${recordPath}`,
      "Skipped: 0",
      "Record-less chains: 2",
      `record-less: ${hash}/chain-rl-a failed 2021-02-01T00:00:00.000Z`,
      `record-less: ${hash}/chain-rl-b cancelled 2021-03-01T00:00:00.000Z`,
    ].join("\n"));
    assert.equal(fs.readFileSync(recordPath, "utf8"), beforeRecord);
    assert.deepEqual(snapshotTree(root), beforeTree);
    assert.deepEqual(requestRows(fixture), []);
  });

  it("acknowledges written records and record-less chains in one kaiba spawn", () => {
    const root = makeCloseRoot();
    const hash = "dddddddddddd";
    const recordPath = writeRecord(root, "chain-record", "2021-01-01T00:00:00.000Z", hash);
    writeRecord(root, "chain-record-future", "2023-01-01T00:00:00.000Z", hash);
    writeControl(root, "chain-recordless", {
      chainId: "chain-recordless",
      status: "failed",
      finishedAt: "2021-04-01T00:00:00.000Z",
      terminalOccurrenceId: "occ-rl",
    }, hash);

    const fixture = makeAckFixture("success");
    const output = cmdReviewRecordClose(
      ["--historical", "--before", BEFORE, "--apply", "--state-root", root],
      { mcpConfigFile: fixture.configPath, env: { KUSABI_CHAIN_NOTIFY: "1" } },
    );
    assert.match(output, /^Wrote 1 historical mark\(s\)\.$/m);
    assert.match(output, /^Acknowledged 1 record-less chain\(s\)\.$/m);
    assert.ok(fs.readFileSync(recordPath, "utf8").includes("<!-- historical:"));

    assert.equal(spawnCount(fixture), 1, "records and record-less chains share one kaiba spawn");
    const subjects = ackCalls(fixture).map(({ request }) => request.params.arguments.subject);
    assert.deepEqual([...subjects].sort(), [
      `${hash}:chain-record`,
      `${hash}:chain-recordless`,
    ]);
  });

  it("reports 0 record-less acknowledged and spawns nothing when KUSABI_CHAIN_NOTIFY=0 or ack fails", () => {
    const root = makeCloseRoot();
    const hash = "eeeeeeeeeeee";
    writeControl(root, "chain-optout", {
      chainId: "chain-optout",
      status: "cancelled",
      finishedAt: "2021-04-01T00:00:00.000Z",
      terminalOccurrenceId: "occ-optout",
    }, hash);

    const successFixture = makeAckFixture("success");
    const optOutOutput = cmdReviewRecordClose(
      ["--historical", "--before", BEFORE, "--apply", "--state-root", root],
      { mcpConfigFile: successFixture.configPath, env: { KUSABI_CHAIN_NOTIFY: "0" } },
    );
    assert.match(optOutOutput, /^Acknowledged 0 record-less chain\(s\)\.$/m);
    assert.deepEqual(requestRows(successFixture), []);

    const errorFixture = makeAckFixture("error-result");
    const { result: errorOutput, lines } = withStderr(() => cmdReviewRecordClose(
      ["--historical", "--before", BEFORE, "--apply", "--state-root", root],
      { mcpConfigFile: errorFixture.configPath, env: { KUSABI_CHAIN_NOTIFY: "1" } },
    ));
    assert.match(errorOutput, /^Acknowledged 0 record-less chain\(s\)\.$/m);
    assert.ok(lines.some((line) => line.startsWith("[chain-notify]") && line.includes("chain-optout")));
  });

  it("acknowledges only the qualifying state directory when two state directories share a record-less chain id", () => {
    const root = makeCloseRoot();
    const hashA = "111111111111";
    const hashB = "222222222222";
    const chainId = "chain-shared";
    writeControl(root, chainId, {
      chainId,
      status: "failed",
      finishedAt: "2021-01-01T00:00:00.000Z",
      terminalOccurrenceId: "occ-a",
    }, hashA);
    writeControl(root, chainId, {
      chainId,
      status: "failed",
      finishedAt: "2023-01-01T00:00:00.000Z",
      terminalOccurrenceId: "occ-b",
    }, hashB);

    const fixture = makeStatefulFixture();
    assert.equal(notifyChainTerminal({
      stateDir: path.join(root, hashA),
      chainId,
      status: "failed",
      disposition: null,
      occurrenceId: "occ-a",
      mcpConfigFile: fixture.configPath,
      env: { KUSABI_CHAIN_NOTIFY: "1" },
    }).inboxDelivered, true);
    assert.equal(notifyChainTerminal({
      stateDir: path.join(root, hashB),
      chainId,
      status: "failed",
      disposition: null,
      occurrenceId: "occ-b",
      mcpConfigFile: fixture.configPath,
      env: { KUSABI_CHAIN_NOTIFY: "1" },
    }).inboxDelivered, true);

    const result = closeReviewRecords({
      before: BEFORE,
      stateRootDir: root,
      apply: true,
      mcpConfigFile: fixture.configPath,
      env: { KUSABI_CHAIN_NOTIFY: "1" },
    });
    assert.equal(result.recordless.length, 1);
    assert.equal(result.recordlessAcknowledged, 1);

    const state = readStatefulState(fixture);
    const entryA = state.entries.find((entry) => entry.subject === `${hashA}:${chainId}`);
    const entryB = state.entries.find((entry) => entry.subject === `${hashB}:${chainId}`);
    assert.equal(entryA.open, false);
    assert.equal(entryB.open, true);
  });

  it("drops a record-less chain rearmed or given a record between scan and lock", () => {
    const root = makeCloseRoot();
    const hash = "ffffffffffff";
    const rearmedDir = writeControl(root, "chain-rearmed", {
      chainId: "chain-rearmed",
      status: "failed",
      finishedAt: "2021-01-01T00:00:00.000Z",
      terminalOccurrenceId: "occ-rearm",
    }, hash);
    const recordAddedDir = writeControl(root, "chain-record-added", {
      chainId: "chain-record-added",
      status: "cancelled",
      finishedAt: "2021-01-01T00:00:00.000Z",
      terminalOccurrenceId: "occ-added",
    }, hash);
    writeControl(root, "chain-still-valid", {
      chainId: "chain-still-valid",
      status: "failed",
      finishedAt: "2021-01-01T00:00:00.000Z",
      terminalOccurrenceId: "occ-valid",
    }, hash);

    let mutated = false;
    const originalMkdirSync = fs.mkdirSync;
    const lockOrder = [];
    const mkdirSpy = mock.method(fs, "mkdirSync", function(dirPath, options) {
      if (typeof dirPath === "string" && dirPath.endsWith(".control-write.lock")) {
        lockOrder.push(path.basename(path.dirname(dirPath)));
      }
      const res = originalMkdirSync.call(this, dirPath, options);
      if (!mutated && typeof dirPath === "string" && dirPath.endsWith(".control-write.lock")) {
        mutated = true;
        // Simulate rearm and record creation before the re-check inside the lock.
        fs.writeFileSync(path.join(recordAddedDir, "review-record.md"), "# late record\n");
        const control = JSON.parse(fs.readFileSync(path.join(rearmedDir, "control.json"), "utf8"));
        fs.writeFileSync(path.join(rearmedDir, "control.json"), JSON.stringify({
          ...control,
          status: "running",
          finishedAt: undefined,
          terminalOccurrenceId: undefined,
        }));
      }
      return res;
    });

    const fixture = makeAckFixture("success");
    try {
      const result = closeReviewRecords({
        before: BEFORE,
        stateRootDir: root,
        apply: true,
        mcpConfigFile: fixture.configPath,
        env: { KUSABI_CHAIN_NOTIFY: "1" },
      });
      assert.deepEqual(lockOrder, ["chain-rearmed", "chain-record-added", "chain-still-valid"]);
      assert.deepEqual(result.skipped, [
        { path: rearmedDir, reason: "changed since scan" },
        { path: recordAddedDir, reason: "changed since scan" },
      ]);
      assert.equal(result.recordless.length, 1);
      assert.equal(result.recordless[0].chainId, "chain-still-valid");
      assert.equal(result.recordlessAcknowledged, 1);
      assert.deepEqual(
        ackCalls(fixture).map(({ request }) => request.params.arguments.subject),
        [`${hash}:chain-still-valid`],
      );
    } finally {
      mkdirSpy.mock.restore();
    }
    // Also confirm real rearmChainControl clears finishedAt / terminalOccurrenceId so rearmed chains do not qualify.
    const rearmedCheck = writeControl(root, "chain-rearm-api", {
      chainId: "chain-rearm-api",
      status: "failed",
      finishedAt: "2021-01-01T00:00:00.000Z",
      terminalOccurrenceId: "occ-api",
    }, hash);
    rearmChainControl({ chainDir: rearmedCheck, round: 1 });
    const afterRearm = closeReviewRecords({
      before: BEFORE,
      stateRootDir: root,
      apply: false,
      mcpConfigFile: fixture.configPath,
      env: { KUSABI_CHAIN_NOTIFY: "1" },
    });
    assert.equal(afterRearm.recordless.some((entry) => entry.chainId === "chain-rearm-api"), false);
  });
});
