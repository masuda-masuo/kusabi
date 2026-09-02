import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  cmdInstallAgents,
  cmdSalvage,
} from "./host-cmd.mjs";

describe("host-cmd extraction invariants (kusabi #445)", () => {
  it("kusabi-companion.mjs does not define or re-export moved commands", () => {
    const companionSource = fs.readFileSync(
      path.join(import.meta.dirname, "kusabi-companion.mjs"),
      "utf8",
    );
    const forbiddenPatterns = [
      "function copyDirTree(",
      "function opencodeConfigDir(",
      "function destDirState(",
      "function cmdInstallAgents(",
      "async function cmdSalvage(",
      "export { cmdInstallAgents",
      "export { cmdSalvage",
    ];
    for (const pat of forbiddenPatterns) {
      assert.ok(
        !companionSource.includes(pat),
        `kusabi-companion.mjs must not contain '${pat}'`,
      );
    }
  });

  it("host-cmd.mjs does not import companion or chain modules", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "host-cmd.mjs"),
      "utf8",
    );
    assert.ok(
      !source.includes('from "./kusabi-companion.mjs"'),
      "host-cmd.mjs must not import kusabi-companion.mjs",
    );
    assert.ok(
      !source.includes('from "./chain-driver.mjs"'),
      "host-cmd.mjs must not import chain-driver.mjs",
    );
    assert.ok(
      !source.includes('from "./chain-cmd.mjs"'),
      "host-cmd.mjs must not import chain-cmd.mjs",
    );
    assert.ok(
      !source.includes('from "./chain-ops.mjs"'),
      "host-cmd.mjs must not import chain-ops.mjs",
    );
    assert.ok(
      !source.includes('from "./task-cmd.mjs"'),
      "host-cmd.mjs must not import task-cmd.mjs",
    );
    assert.ok(
      !source.includes('from "./metrics-cmd.mjs"'),
      "host-cmd.mjs must not import metrics-cmd.mjs",
    );
    assert.ok(
      !source.includes('from "./chain-phases.mjs"'),
      "host-cmd.mjs must not import chain-phases.mjs",
    );
    assert.ok(
      !source.includes('from "./chain-review.mjs"'),
      "host-cmd.mjs must not import chain-review.mjs",
    );
  });

  it("chain modules and metrics-cmd do not import host-cmd.mjs", () => {
    const modules = [
      "chain-driver.mjs",
      "chain-cmd.mjs",
      "chain-ops.mjs",
      "task-cmd.mjs",
      "metrics-cmd.mjs",
      "chain-phases.mjs",
      "chain-review.mjs",
    ];
    for (const mod of modules) {
      const source = fs.readFileSync(
        path.join(import.meta.dirname, mod),
        "utf8",
      );
      assert.ok(
        !source.includes('from "./host-cmd.mjs"'),
        `${mod} must not import host-cmd.mjs`,
      );
    }
  });
});

describe("host-cmd exports", () => {
  it("exports all expected command functions", () => {
    assert.equal(typeof cmdInstallAgents, "function");
    assert.equal(typeof cmdSalvage, "function");
  });
});

describe("cmdSalvage validation", () => {
  it("requires dead job ID", async () => {
    await assert.rejects(
      () => cmdSalvage("/workspace", { flags: {}, text: "" }),
      /salvage requires a dead job ID/,
    );
    await assert.rejects(
      () => cmdSalvage("/workspace", { flags: {}, text: "   " }),
      /salvage requires a dead job ID/,
    );
  });

  it("throws when job is not found", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-salvage-test-"));
    try {
      await assert.rejects(
        () => cmdSalvage(tmpDir, { flags: {}, text: "non-existent-job-123" }),
        /no such job: non-existent-job-123/,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
