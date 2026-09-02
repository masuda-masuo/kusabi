import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  cmdChainStats,
  cmdMetricsIngest,
  cmdMetricsReport,
  dashboardPortFlag,
  cmdDashboard,
} from "./metrics-cmd.mjs";
import { stateDirFor } from "./state-paths.mjs";

describe("metrics-cmd extraction invariants (kusabi #443)", () => {
  it("kusabi-companion.mjs does not define or re-export moved commands", () => {
    const companionSource = fs.readFileSync(
      path.join(import.meta.dirname, "kusabi-companion.mjs"),
      "utf8",
    );
    const forbiddenPatterns = [
      "function cmdChainStats(",
      "function cmdMetricsIngest(",
      "function cmdMetricsReport(",
      "function dashboardPortFlag(",
      "async function cmdDashboard(",
      "export { cmdChainStats",
      "export { cmdMetricsIngest",
      "export { cmdMetricsReport",
      "export { cmdDashboard",
    ];
    for (const pat of forbiddenPatterns) {
      assert.ok(
        !companionSource.includes(pat),
        `kusabi-companion.mjs must not contain '${pat}'`,
      );
    }
  });

  it("metrics-cmd.mjs does not import companion or chain modules", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "metrics-cmd.mjs"),
      "utf8",
    );
    assert.ok(
      !source.includes('from "./kusabi-companion.mjs"'),
      "metrics-cmd.mjs must not import kusabi-companion.mjs",
    );
    assert.ok(
      !source.includes('from "./chain-driver.mjs"'),
      "metrics-cmd.mjs must not import chain-driver.mjs",
    );
    assert.ok(
      !source.includes('from "./chain-cmd.mjs"'),
      "metrics-cmd.mjs must not import chain-cmd.mjs",
    );
    assert.ok(
      !source.includes('from "./chain-ops.mjs"'),
      "metrics-cmd.mjs must not import chain-ops.mjs",
    );
    assert.ok(
      !source.includes('from "./task-cmd.mjs"'),
      "metrics-cmd.mjs must not import task-cmd.mjs",
    );
    assert.ok(
      !source.includes('from "./chain-phases.mjs"'),
      "metrics-cmd.mjs must not import chain-phases.mjs",
    );
    assert.ok(
      !source.includes('from "./chain-review.mjs"'),
      "metrics-cmd.mjs must not import chain-review.mjs",
    );
  });

  it("chain modules do not import metrics-cmd.mjs", () => {
    const modules = [
      "chain-driver.mjs",
      "chain-cmd.mjs",
      "chain-ops.mjs",
      "task-cmd.mjs",
      "chain-phases.mjs",
      "chain-review.mjs",
    ];
    for (const mod of modules) {
      const source = fs.readFileSync(
        path.join(import.meta.dirname, mod),
        "utf8",
      );
      assert.ok(
        !source.includes('from "./metrics-cmd.mjs"'),
        `${mod} must not import metrics-cmd.mjs`,
      );
    }
  });
});

describe("metrics-cmd exports", () => {
  it("exports all expected command functions and helpers", () => {
    assert.equal(typeof cmdChainStats, "function");
    assert.equal(typeof cmdMetricsIngest, "function");
    assert.equal(typeof cmdMetricsReport, "function");
    assert.equal(typeof dashboardPortFlag, "function");
    assert.equal(typeof cmdDashboard, "function");
  });
});

describe("dashboardPortFlag", () => {
  it("returns fallback when port is undefined", () => {
    assert.equal(dashboardPortFlag({}), 8752);
    assert.equal(dashboardPortFlag({}, 9000), 9000);
  });

  it("parses valid port numbers and numeric strings", () => {
    assert.equal(dashboardPortFlag({ port: 8080 }), 8080);
    assert.equal(dashboardPortFlag({ port: "3000" }), 3000);
    assert.equal(dashboardPortFlag({ port: 0 }), 0);
    assert.equal(dashboardPortFlag({ port: 65535 }), 65535);
  });

  it("rejects invalid port values", () => {
    assert.throws(
      () => dashboardPortFlag({ port: -1 }),
      /--port expects a TCP port number, got: -1/,
    );
    assert.throws(
      () => dashboardPortFlag({ port: 65536 }),
      /--port expects a TCP port number, got: 65536/,
    );
    assert.throws(
      () => dashboardPortFlag({ port: 80.5 }),
      /--port expects a TCP port number, got: 80.5/,
    );
    assert.throws(
      () => dashboardPortFlag({ port: "abc" }),
      /--port expects a TCP port number, got: abc/,
    );
  });
});

describe("cmdMetricsReport", () => {
  it("rejects --compare flag loudly", () => {
    assert.throws(
      () => cmdMetricsReport("/workspace", { flags: { compare: "2026-01-01" } }),
      /--compare is not supported by metrics-report/,
    );
  });

  it("handles missing store gracefully", () => {
    const nonExistentDb = path.join(os.tmpdir(), "kusabi-test-missing-db-443.db");
    const textOutput = cmdMetricsReport("/workspace", {
      flags: { db: nonExistentDb },
    });
    assert.ok(textOutput.includes("Metrics store not found"));

    const jsonOutput = cmdMetricsReport("/workspace", {
      flags: { db: nonExistentDb, json: true },
    });
    const parsed = JSON.parse(jsonOutput);
    assert.equal(parsed.status, "missing");
    assert.equal(parsed.freshness.dbPath, nonExistentDb);
  });
});

describe("cmdChainStats", () => {
  it("rejects --compare combined with --since or --until", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-ws-compare-"));
    const stateDir = stateDirFor(tmpDir);
    try {
      const chainDir = path.join(stateDir, "chains", "chain-001");
      fs.mkdirSync(chainDir, { recursive: true });
      fs.writeFileSync(
        path.join(chainDir, "chain.json"),
        JSON.stringify({ chainId: "chain-001", rounds: [] }),
      );

      assert.throws(
        () =>
          cmdChainStats(tmpDir, {
            flags: { compare: "2026-01-01", since: "2025-12-01" },
          }),
        /--compare is incompatible with --since\/--until/,
      );
      assert.throws(
        () =>
          cmdChainStats(tmpDir, {
            flags: { compare: "2026-01-01", until: "2026-02-01" },
          }),
        /--compare is incompatible with --since\/--until/,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("throws when no chain records found in empty directory", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-empty-ws-"));
    try {
      assert.throws(
        () => cmdChainStats(tmpDir, { flags: {} }),
        /no chain records found for this workspace/,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("cmdMetricsIngest", () => {
  it("supports --dry-run without creating db", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-dryrun-"));
    const dbPath = path.join(tmpDir, "test.db");
    try {
      const output = cmdMetricsIngest("/workspace", {
        flags: {
          dryRun: true,
          db: dbPath,
          "transcript-dir": path.join(tmpDir, "transcripts"),
          "cursor-usage-dir": path.join(tmpDir, "cursor"),
          "state-root": tmpDir,
        },
      });
      assert.ok(output.includes("Metrics ingest (dry run — nothing written)"));
      assert.ok(output.includes("db: (discarded, in-memory)"));
      assert.ok(!fs.existsSync(dbPath), "dry run must not create db file");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
