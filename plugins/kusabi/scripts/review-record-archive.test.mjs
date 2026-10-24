import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, mock } from "node:test";
import { archiveReviewRecord, cmdReviewRecordArchive } from "./review-record-archive.mjs";
import { countUnfilledReviewRecords } from "./review-record-scan.mjs";

const CWD = path.join(os.tmpdir(), "kusabi-review-record-archive-workspace");
const HASH = crypto.createHash("sha256").update(CWD).digest("hex").slice(0, 12);

function fixture({ repo = "owner/repo", brief = "A short brief", record = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-review-record-archive-"));
  const chainDir = path.join(root, HASH, "chains", "chain-test");
  const clone = path.join(root, "kairanban");
  fs.mkdirSync(chainDir, { recursive: true });
  fs.mkdirSync(path.join(clone, ".git"), { recursive: true });
  const content = record ?? [
    "# [review-record] repo chain-test",
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
  return { root, chainDir, clone, record: content };
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

describe("review-record-archive", () => {
  it("copies the review record byte-for-byte and writes a brief with one trailing newline", () => {
    const f = fixture({ brief: "line one\nline two\n\n" });
    try {
      const output = archive(f);
      const target = path.join(f.clone, "records", "repo", "chain-test");
      assert.deepEqual(fs.readFileSync(path.join(target, "review-record.md")), fs.readFileSync(path.join(f.chainDir, "review-record.md")));
      assert.equal(fs.readFileSync(path.join(target, "brief.md"), "utf8"), "line one\nline two\n");
      assert.match(output, /git -C .* add records[\\/]repo[\\/]chain-test/);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("uses the cwd basename when chain.json has no repo and reports the fallback", () => {
    const f = fixture({ repo: null });
    try {
      const output = archive(f);
      assert.match(output, /repo was not in chain\.json; using label kusabi-review-record-archive-workspace/);
      assert.ok(fs.existsSync(path.join(f.clone, "records", "kusabi-review-record-archive-workspace", "chain-test", "brief.md")));
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("refuses invalid chain ids and repository path segments", () => {
    const f = fixture({ repo: "owner/.." });
    try {
      assert.throws(() => archive(f), /invalid repo name/);
      for (const repoName of [".", "..", ".hidden"]) {
        const namedFixture = fixture({ repo: `owner/${repoName}` });
        try {
          assert.throws(() => archive(namedFixture), /invalid repo name/);
        } finally {
          fs.rmSync(namedFixture.root, { recursive: true, force: true });
        }
      }
      assert.throws(() => archive(f, { chainId: "../bad" }), /invalid chain id/);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("refuses a record with no findings adjudication heading", () => {
    const f = fixture({ record: "# record\n\n## Usage\ninput=0\n" });
    try {
      assert.throws(() => archive(f), /missing the findings adjudication heading/);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("accepts a finished row whose finding contains _fill_", () => {
    const f = fixture({ record: [
      "# record",
      "## Findings adjudication (fill at inspection)",
      "| # | severity | finding | verdict | reason |",
      "|---|---|---|---|---|",
      "| 1 | medium | archive does not refuse rows still marked _fill_ | 採用 | 修正済み |",
      "## Usage",
    ].join("\n") });
    try {
      assert.match(archive(f), /wrote/); assert.doesNotMatch(archive(f), /\bstaged\b/);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("refuses unfilled rows and includes all row numbers", () => {
    const f = fixture({ record: [
      "# record",
      "## Findings adjudication (fill at inspection)",
      "| # | severity | finding | verdict | reason |",
      "|---|---|---|---|---|",
      "| 2 | low | finding | _fill_ | _fill_ |",
      "| 7 | high | finding | _fill_ | _fill_ |",
      "## Usage",
    ].join("\n") });
    try {
      assert.throws(() => archive(f), /unfilled rows: 2, 7/);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("refuses an unfilled numbered row without outer pipes and includes its row number", () => {
    const f = fixture({ record: [
      "# record",
      "## Findings adjudication (fill at inspection)",
      "1 | low | x | _fill_ | _fill_",
      "## Usage",
    ].join("\n") });
    try {
      assert.throws(() => archive(f), /unfilled rows: 1/);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("refuses a numbered row with only a trailing pipe and an unfilled verdict", () => {
    const f = fixture({ record: [
      "# record",
      "## Findings adjudication (fill at inspection)",
      "1 | low | x | _fill_ | ok |",
      "## Usage",
    ].join("\n") });
    try {
      assert.throws(() => archive(f), /unfilled rows: 1/);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("ignores non-table lines without an unfilled marker", () => {
    const f = fixture({ record: [
      "# record",
      "## Findings adjudication (fill at inspection)",
      "notes about row 1 are complete",
      "## Usage",
    ].join("\n") });
    try {
      assert.match(archive(f), /wrote/); assert.doesNotMatch(archive(f), /\bstaged\b/);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("detects an unfilled row with a pipe in its finding and includes its row number", () => {
    const f = fixture({ record: [
      "# record",
      "## Findings adjudication (fill at inspection)",
      "| # | severity | finding | verdict | reason |",
      "|---|---|---|---|---|",
      "| 4 | low | left | middle | _fill_ | right |",
      "## Usage",
    ].join("\n") });
    try {
      assert.throws(() => archive(f), /unfilled rows: 4/);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("refuses a short numbered row with an unfilled verdict or reason", () => {
    const f = fixture({ record: [
      "# record",
      "## Findings adjudication (fill at inspection)",
      "| 9 | medium | finding | _fill_ |",
      "## Usage",
    ].join("\n") });
    try {
      assert.throws(() => archive(f), /unfilled rows: 9/);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("agrees with scan on an unfilled row in a later adjudication section", () => {
    const record = [
      "# record",
      "## Findings adjudication (fill at inspection)",
      "| # | severity | finding | verdict | reason |",
      "|---|---|---|---|---|",
      "| 1 | low | complete | accept | resolved |",
      "## Usage",
      "notes",
      "## Findings adjudication (fill at inspection)",
      "| # | severity | finding | verdict | reason |",
      "|---|---|---|---|---|",
      "| 4 | low | left | middle | _fill_ | right |",
    ].join("\n");
    const f = fixture({ record });
    try {
      assert.equal(countUnfilledReviewRecords(f.root), 1);
      assert.throws(() => archive(f), /unfilled rows: 4/);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("does not treat a historical mark with trailing text as a full-line mark", () => {
    const f = fixture({ record: [
      "# record",
      "## Findings adjudication (fill at inspection)",
      "<!-- historical: not adjudicated; closed by review-record-close before 2026-10-18 --> trailing",
      "| # | severity | finding | verdict | reason |",
      "|---|---|---|---|---|",
      "| 1 | low | old finding | _fill_ | _fill_ |",
    ].join("\n") });
    try {
      assert.equal(countUnfilledReviewRecords(f.root), 1);
      assert.throws(() => archive(f), /unfilled rows: 1/);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("allows unfilled rows when the findings section has a historical mark", () => {
    const f = fixture({ record: [
      "# record",
      "## Findings adjudication (fill at inspection)",
      "<!-- historical: not adjudicated; closed by review-record-close before 2026-10-18 -->",
      "| 1 | low | finding | _fill_ | _fill_ |",
      "## Usage",
    ].join("\n") });
    try {
      assert.match(archive(f), /wrote/); assert.doesNotMatch(archive(f), /\bstaged\b/);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("is idempotent for identical content, refuses differences unless forced, and overwrites with force", () => {
    const f = fixture();
    try {
      archive(f);
      assert.match(archive(f), /^unchanged/m);
      fs.writeFileSync(path.join(f.clone, "records", "repo", "chain-test", "brief.md"), "old\n");
      assert.throws(() => archive(f), /target differs/);
      archive(f, { force: true });
      assert.equal(fs.readFileSync(path.join(f.clone, "records", "repo", "chain-test", "brief.md"), "utf8"), "A short brief\n");
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("requires the kairanban directory and its .git marker", () => {
    const f = fixture();
    try {
      assert.throws(() => archive(f, { kairanbanDir: path.join(f.root, "missing") }), /clone not found/);
      const other = path.join(f.root, "not-a-clone");
      fs.mkdirSync(other);
      assert.throws(() => archive(f, { kairanbanDir: other }), /missing \.git/);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("cleans up a newly created first target when the second rename fails", () => {
    const f = fixture();
    const targetDir = path.join(f.clone, "records", "repo", "chain-test");
    const originalRename = fs.renameSync;
    let renameCalls = 0;
    const renameSpy = mock.method(fs, "renameSync", (from, to) => {
      renameCalls += 1;
      if (renameCalls === 2) throw new Error("second rename failed");
      return originalRename(from, to);
    });
    try {
      assert.throws(() => archive(f), /second rename failed/);
      assert.equal(renameCalls, 2);
      assert.equal(fs.existsSync(path.join(targetDir, "review-record.md")), false);
      assert.equal(fs.existsSync(path.join(targetDir, "brief.md")), false);
      assert.deepEqual(fs.readdirSync(targetDir), []);
    } finally {
      renameSpy.mock.restore();
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("does not spawn child processes", () => {
    const f = fixture();
    const moduleSource = fs.readFileSync(new URL("./review-record-archive.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(moduleSource, /\b(?:node:)?child_process\b/);
    let calls = 0;
    const spies = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"].map((name) =>
      mock.method(childProcess, name, () => {
        calls += 1;
        throw new Error("child process was spawned");
      }),
    );
    try {
      archive(f);
      assert.equal(calls, 0);
    } finally {
      for (const spy of spies) spy.mock.restore();
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("parses CLI flags and rejects invalid arguments", () => {
    const f = fixture();
    try {
      const output = cmdReviewRecordArchive(["chain-test", "--kairanban", f.clone, "--state-root", f.root], { cwd: CWD });
      assert.match(output, /wrote/); assert.doesNotMatch(output, /\bstaged\b/);
      assert.throws(() => cmdReviewRecordArchive(["chain-test", "--force"], { cwd: CWD }), /--kairanban is required/);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });
});
