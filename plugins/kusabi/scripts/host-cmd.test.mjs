import { describe, it, beforeEach, afterEach } from "node:test";
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

describe("cmdInstallAgents", () => {
  let tmpRoot;
  let tmpHome;
  let tmpStateDir;
  let origEnv;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-install-agents-test-"));
    tmpHome = path.join(tmpRoot, "home");
    tmpStateDir = path.join(tmpRoot, "state");
    fs.mkdirSync(tmpHome, { recursive: true });
    fs.mkdirSync(tmpStateDir, { recursive: true });
    origEnv = {
      HOME: process.env.HOME,
      KUSABI_STATE_DIR: process.env.KUSABI_STATE_DIR,
      KUSABI_OPENCODE_CONFIG_HOME: process.env.KUSABI_OPENCODE_CONFIG_HOME,
      OPENCODE_AGENT_DIR: process.env.OPENCODE_AGENT_DIR,
      OPENCODE_SKILL_DIR: process.env.OPENCODE_SKILL_DIR,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    };
    process.env.HOME = tmpHome;
    process.env.KUSABI_STATE_DIR = tmpStateDir;
    delete process.env.KUSABI_OPENCODE_CONFIG_HOME;
    delete process.env.OPENCODE_AGENT_DIR;
    delete process.env.OPENCODE_SKILL_DIR;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(origEnv)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("installs agents and skills under kusabi dir and seeds opencode.jsonc", () => {
    const msg = cmdInstallAgents();
    const kusabiConfigDir = path.join(tmpStateDir, "opencode-config", "opencode");
    assert.ok(fs.existsSync(path.join(kusabiConfigDir, "agent", "kusabi-implement.md")), "agent installed in kusabi dir");
    assert.ok(fs.existsSync(path.join(kusabiConfigDir, "skills", "kusabi-rust-cross-target-checks", "SKILL.md")), "skill installed in kusabi dir");
    assert.ok(fs.existsSync(path.join(kusabiConfigDir, "opencode.jsonc")), "opencode.jsonc seeded in kusabi dir");
    assert.match(msg, /seeded .*opencode\.jsonc from template/);
    assert.ok(!fs.existsSync(path.join(tmpHome, ".config", "opencode", "agent", "kusabi-implement.md")), "nothing installed in personal dir");
  });

  it("keeps an edited opencode.jsonc on a second run without overwriting", () => {
    cmdInstallAgents();
    const configFile = path.join(tmpStateDir, "opencode-config", "opencode", "opencode.jsonc");
    fs.appendFileSync(configFile, "\n// operator-custom-comment\n", "utf8");
    const secondMsg = cmdInstallAgents();
    assert.match(secondMsg, /kept existing .*opencode\.jsonc/);
    const content = fs.readFileSync(configFile, "utf8");
    assert.ok(content.includes("// operator-custom-comment"), "custom comment preserved");
  });

  it("honours OPENCODE_AGENT_DIR override while keeping opencode.jsonc under kusabi dir", () => {
    const customAgentDir = path.join(tmpRoot, "custom-agents");
    process.env.OPENCODE_AGENT_DIR = customAgentDir;
    const msg = cmdInstallAgents();
    assert.ok(msg.includes(customAgentDir), "reports custom agent destination");
    assert.ok(fs.existsSync(path.join(customAgentDir, "kusabi-implement.md")), "agent installed to custom OPENCODE_AGENT_DIR");
    const kusabiConfigDir = path.join(tmpStateDir, "opencode-config", "opencode");
    assert.ok(fs.existsSync(path.join(kusabiConfigDir, "opencode.jsonc")), "opencode.jsonc still seeded in kusabi dir");
    assert.ok(!fs.existsSync(path.join(kusabiConfigDir, "agent", "kusabi-implement.md")), "not installed to default agent dir");
  });

  it("reports leftover kusabi-*.md in personal dir and leaves them in place", () => {
    const personalAgentDir = path.join(tmpHome, ".config", "opencode", "agent");
    fs.mkdirSync(personalAgentDir, { recursive: true });
    fs.writeFileSync(path.join(personalAgentDir, "kusabi-implement.md"), "# old agent\n");
    fs.writeFileSync(path.join(personalAgentDir, "kusabi-review.md"), "# old agent 2\n");
    const msg = cmdInstallAgents();
    assert.match(msg, /found 2 leftover kusabi agent definition\(s\) in/);
    assert.match(msg, /they are no longer read by kusabi's serve and may be removed by hand/);
    assert.ok(fs.existsSync(path.join(personalAgentDir, "kusabi-implement.md")), "personal file not deleted");
    assert.ok(fs.existsSync(path.join(personalAgentDir, "kusabi-review.md")), "personal file 2 not deleted");
  });
});

