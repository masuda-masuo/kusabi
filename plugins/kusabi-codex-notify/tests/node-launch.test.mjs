// node-launch.test.mjs — kusabi #790: env-node shebang launches under a PATH
// that has no `node` (systemd user services, cron, non-login shells).
//
// An absolute path to a `#!/usr/bin/env node` script does not pin the
// interpreter; `env` searches the child's PATH and exits 127 when node is
// absent.  These tests reproduce that failure with a control spawn, then
// check that the watcher's launch resolution starts the same script through
// the running Node, for codex queue AND the companion wait, on both the chain
// and the task path.  No real Codex call happens; the stand-ins only write a
// local log file.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import process from "node:process";
import { spawnSync } from "node:child_process";

import {
  OUTCOME_DELIVERED,
  OUTCOME_ALREADY_DELIVERED,
  OUTCOME_QUEUE_FAILURE,
  parseEnvNodeShebang,
  resolveCommandPath,
  resolveNodeLaunch,
  runProcess,
  runResolvedProcess,
  watchChain,
  watchTask,
} from "../scripts/watch-chain.mjs";
import { launchAndWatch, launchTaskAndWatch } from "../scripts/register-watch.mjs";

function writeScript(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

describe("parseEnvNodeShebang", () => {
  it("recognizes the modeled env-node forms and returns the exact program name", () => {
    assert.deepEqual(parseEnvNodeShebang("#!/usr/bin/env node"), { envNode: true, program: "node", assignments: {}, extraArgs: [] });
    assert.deepEqual(parseEnvNodeShebang("#! /usr/bin/env nodejs"), { envNode: true, program: "nodejs", assignments: {}, extraArgs: [] });
    assert.deepEqual(
      parseEnvNodeShebang("#!/usr/bin/env -S node --no-warnings"),
      { envNode: true, program: "node", assignments: {}, extraArgs: ["--no-warnings"] },
    );
    assert.deepEqual(
      parseEnvNodeShebang("#!/usr/bin/env -S A=1 B=two nodejs --x"),
      { envNode: true, program: "nodejs", assignments: { A: "1", B: "two" }, extraArgs: ["--x"] },
    );
  });

  it("rejects non-env-node lines", () => {
    for (const line of ["#!/bin/sh", "#!/usr/bin/node", "#!/usr/bin/env python3", "#!/usr/bin/env", "\u007fELF", "", null]) {
      assert.equal(parseEnvNodeShebang(line).envNode, false, String(line));
    }
  });

  it("leaves env forms it does not model to the normal launch", () => {
    for (const line of [
      "#!/usr/bin/env -i node",
      "#!/usr/bin/env -u HOME node",
      "#!/usr/bin/env -C /tmp node",
      "#!/usr/bin/env -S -i node",
      "#!/usr/bin/env -S -u HOME node",
      "#!/usr/bin/env -S -C /tmp node",
      "#!/usr/bin/env -- node",
      "#!/usr/bin/env node --flag", // without -S the kernel passes one argument
      "#!/usr/bin/env A=1 node", // without -S: same
      "#!/usr/bin/env -S A='x y' node",
      "#!/usr/bin/env -S A=${HOME} node",
      "#!/usr/bin/env -S /opt/node/bin/node", // a path: env does not search PATH
    ]) {
      assert.equal(parseEnvNodeShebang(line).envNode, false, line);
    }
  });
});

describe("node-shebang launch resolution (#790)", () => {
  let tmpRoot;
  let noNodeBin; // a PATH directory that holds nothing — node is unreachable
  let envNodeScript;
  let marker;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kcn-790-"));
    noNodeBin = path.join(tmpRoot, "empty-bin");
    fs.mkdirSync(noNodeBin);
    marker = path.join(tmpRoot, "marker.json");
    envNodeScript = writeScript(
      path.join(tmpRoot, "env-node-tool"),
      `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ argv: process.argv.slice(2), path: process.env.PATH }));
`,
    );
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("control: a direct spawn of the env-node script with node off PATH exits 127", () => {
    const r = spawnSync(envNodeScript, ["--version"], { env: { PATH: noNodeBin }, encoding: "utf8" });
    assert.equal(r.status, 127, `stderr: ${r.stderr}`);
    assert.match(r.stderr, /node/);
    assert.equal(fs.existsSync(marker), false);

    // The watcher's own plain runProcess reproduces the same failure.
    return runProcess(envNodeScript, ["--version"], { cwd: tmpRoot, env: { PATH: noNodeBin } }).then((res) => {
      assert.equal(res.exitCode, 127);
    });
  });

  it("runs the script through the current Node and appends its bin dir to PATH", async () => {
    const env = { PATH: noNodeBin, KEEP: "1" };
    const launch = resolveNodeLaunch(envNodeScript, ["queue", "--thread", "t"], { cwd: tmpRoot, env });
    assert.equal(launch.viaNode, true);
    assert.equal(launch.command, process.execPath);
    assert.deepEqual(launch.args, [envNodeScript, "queue", "--thread", "t"]);
    assert.equal(launch.env.PATH, `${noNodeBin}${path.delimiter}${path.dirname(process.execPath)}`);
    assert.equal(launch.env.KEEP, "1");
    assert.equal(env.PATH, noNodeBin, "caller env must not be mutated");

    const res = await runResolvedProcess(envNodeScript, ["queue", "--thread", "t"], { cwd: tmpRoot, env });
    assert.equal(res.exitCode, 0, res.stderr);
    const seen = JSON.parse(fs.readFileSync(marker, "utf8"));
    assert.deepEqual(seen.argv, ["queue", "--thread", "t"]);
    assert.ok(seen.path.split(path.delimiter).includes(path.dirname(process.execPath)));
  });

  it("passes env -S interpreter flags before the script", () => {
    const s = writeScript(path.join(tmpRoot, "flagged"), "#!/usr/bin/env -S node --no-warnings\n");
    const launch = resolveNodeLaunch(s, ["a"], { cwd: tmpRoot, env: { PATH: noNodeBin } });
    assert.equal(launch.viaNode, true);
    assert.deepEqual(launch.args, ["--no-warnings", s, "a"]);
  });

  for (const [wanted, provided] of [["node", "nodejs"], ["nodejs", "node"]]) {
    it(`checks the exact name env asks for: \`env ${wanted}\` with only \`${provided}\` on PATH`, async () => {
      const onlyOther = path.join(tmpRoot, `only-${provided}`);
      fs.mkdirSync(onlyOther);
      fs.symlinkSync(process.execPath, path.join(onlyOther, provided));
      const s = writeScript(
        path.join(tmpRoot, `wants-${wanted}`),
        `#!/usr/bin/env ${wanted}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
      );
      const env = { PATH: onlyOther };

      // Control: the plain launch really fails for this PATH.
      const plain = await runProcess(s, [], { cwd: tmpRoot, env });
      assert.equal(plain.exitCode, 127, plain.stderr);
      assert.match(plain.stderr, new RegExp(`'${wanted}'`));

      const launch = resolveNodeLaunch(s, [], { cwd: tmpRoot, env });
      assert.equal(launch.viaNode, true);
      const res = await runResolvedProcess(s, [], { cwd: tmpRoot, env });
      assert.equal(res.exitCode, 0, res.stderr);
      assert.equal(fs.readFileSync(marker, "utf8"), "ran");
    });
  }

  it("keeps -S assignments in the fallback launch, matching a normal launch", async () => {
    const nodeBin = path.join(tmpRoot, "node-bin-assign");
    fs.mkdirSync(nodeBin);
    fs.symlinkSync(process.execPath, path.join(nodeBin, "node"));
    const s = writeScript(
      path.join(tmpRoot, "assigns"),
      `#!/usr/bin/env -S KCN_TEST_VAR=set node\nprocess.stdout.write(String(process.env.KCN_TEST_VAR));\n`,
    );

    const normal = await runProcess(s, [], { cwd: tmpRoot, env: { PATH: nodeBin } });
    assert.equal(normal.exitCode, 0, normal.stderr);
    assert.equal(normal.stdout, "set");

    const fallback = await runResolvedProcess(s, [], { cwd: tmpRoot, env: { PATH: noNodeBin } });
    assert.equal(fallback.exitCode, 0, fallback.stderr);
    assert.equal(fallback.stdout, "set");
  });

  it("searches the PATH assigned by -S, as env does", () => {
    const nodeBin = path.join(tmpRoot, "node-bin-assigned-path");
    fs.mkdirSync(nodeBin);
    fs.symlinkSync(process.execPath, path.join(nodeBin, "node"));
    const s1 = writeScript(path.join(tmpRoot, "assigned-ok"), `#!/usr/bin/env -S PATH=${nodeBin} node\n`);
    assert.equal(resolveNodeLaunch(s1, [], { cwd: tmpRoot, env: { PATH: noNodeBin } }).viaNode, false);

    const s2 = writeScript(path.join(tmpRoot, "assigned-missing"), `#!/usr/bin/env -S PATH=${noNodeBin} node\n`);
    const launch = resolveNodeLaunch(s2, [], { cwd: tmpRoot, env: { PATH: nodeBin } });
    assert.equal(launch.viaNode, true);
    assert.equal(launch.env.PATH, `${noNodeBin}${path.delimiter}${path.dirname(process.execPath)}`);
  });

  it("leaves unmodeled env options unchanged even with node off PATH", () => {
    for (const line of ["#!/usr/bin/env -S -i node", "#!/usr/bin/env -S -u HOME node", "#!/usr/bin/env -S -C /tmp node"]) {
      const s = writeScript(path.join(tmpRoot, `opt-${Math.random().toString(36).slice(2)}`), `${line}\n`);
      const launch = resolveNodeLaunch(s, ["a"], { cwd: tmpRoot, env: { PATH: noNodeBin } });
      assert.equal(launch.viaNode, false, line);
      assert.equal(launch.command, s);
    }
  });

  it("leaves the launch unchanged when PATH already resolves node", () => {
    const nodeBin = path.join(tmpRoot, "node-bin");
    fs.mkdirSync(nodeBin);
    fs.symlinkSync(process.execPath, path.join(nodeBin, "node"));
    const env = { PATH: nodeBin };
    const launch = resolveNodeLaunch(envNodeScript, ["x"], { cwd: tmpRoot, env });
    assert.equal(launch.viaNode, false);
    assert.equal(launch.command, envNodeScript);
    assert.deepEqual(launch.args, ["x"]);
    assert.equal(launch.env, env);
    assert.equal(launch.resolvedPath, envNodeScript);
  });

  it("leaves native binaries and absolute-interpreter scripts unchanged", () => {
    const native = path.join(tmpRoot, "native");
    fs.writeFileSync(native, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]), { mode: 0o755 });
    const sh = writeScript(path.join(tmpRoot, "sh-tool"), "#!/bin/sh\nexit 0\n");
    const abs = writeScript(path.join(tmpRoot, "abs-node"), `#!${process.execPath}\n`);
    for (const f of [native, sh, abs]) {
      const launch = resolveNodeLaunch(f, ["y"], { cwd: tmpRoot, env: { PATH: noNodeBin } });
      assert.equal(launch.viaNode, false, f);
      assert.equal(launch.command, f);
    }
  });

  it("resolves bare names on the child PATH and leaves unresolvable commands to spawn", async () => {
    const bin = path.join(tmpRoot, "tools");
    fs.mkdirSync(bin);
    fs.copyFileSync(envNodeScript, path.join(bin, "codex"));
    fs.chmodSync(path.join(bin, "codex"), 0o755);
    const env = { PATH: `${noNodeBin}${path.delimiter}${bin}` };
    assert.equal(resolveCommandPath("codex", { cwd: tmpRoot, env }), path.join(bin, "codex"));
    const launch = resolveNodeLaunch("codex", [], { cwd: tmpRoot, env });
    assert.equal(launch.viaNode, true);
    assert.equal(launch.args[0], path.join(bin, "codex"));

    const missing = resolveNodeLaunch("no-such-codex", ["z"], { cwd: tmpRoot, env });
    assert.equal(missing.viaNode, false);
    assert.equal(missing.command, "no-such-codex");
    const res = await runResolvedProcess("no-such-codex", [], { cwd: tmpRoot, env });
    assert.notEqual(res.exitCode, 0);
  });
});

describe("watchers deliver with node off PATH (#790)", () => {
  let tmpRoot, stateDir, kusabiStateDir, workspaceDir, queueLogDir, noNodeBin;
  let companion, codex;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kcn-790w-"));
    stateDir = path.join(tmpRoot, "notify-state");
    kusabiStateDir = path.join(tmpRoot, "kusabi-state");
    workspaceDir = path.join(tmpRoot, "workspace");
    queueLogDir = path.join(tmpRoot, "queue-logs");
    noNodeBin = path.join(tmpRoot, "empty-bin");
    for (const d of [stateDir, kusabiStateDir, workspaceDir, queueLogDir, noNodeBin]) fs.mkdirSync(d, { recursive: true });

    companion = writeScript(
      path.join(tmpRoot, "mock-companion.mjs"),
      `#!/usr/bin/env node
const [sub, id] = process.argv.slice(2);
if (sub === "chain-wait") {
  process.stdout.write(\`chain \${id}: status=completed disposition=accept rounds=1 waited=1s container=c790\\n\`);
} else if (sub === "task-wait") {
  process.stdout.write(\`task \${id}: status=completed phase=implement waited=1s\\n\`);
} else {
  process.exitCode = 1;
}
`,
    );
    codex = writeScript(
      path.join(tmpRoot, "mock-codex.mjs"),
      `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const dir = process.env.TEST_QUEUE_LOG_DIR;
fs.writeFileSync(path.join(dir, \`\${process.pid}-\${Date.now()}.json\`), JSON.stringify(process.argv.slice(2)));
if (process.env.TEST_CODEX_FAIL === "generic") { process.stderr.write("Error: codex queue command failed\\n"); process.exitCode = 1; }
`,
    );
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function minimalEnv(extra = {}) {
    // systemd-like: no inherited PATH entry that provides node.
    return { PATH: noNodeBin, HOME: tmpRoot, KUSABI_STATE_DIR: kusabiStateDir, TEST_QUEUE_LOG_DIR: queueLogDir, ...extra };
  }

  function wsHash() {
    return crypto.createHash("sha256").update(path.resolve(workspaceDir)).digest("hex").slice(0, 12);
  }

  function setupChain(chainId) {
    const chainDir = path.join(kusabiStateDir, wsHash(), "chains", chainId);
    fs.mkdirSync(chainDir, { recursive: true });
    fs.writeFileSync(path.join(chainDir, "control.json"), JSON.stringify({ status: "completed", round: 1, container: "c790" }));
    fs.writeFileSync(path.join(chainDir, "chain.json"), JSON.stringify({ chainId, records: [{ round: 1, disposition: { disposition: "accept" } }] }));
  }

  function setupJob(jobId) {
    const jobDir = path.join(kusabiStateDir, wsHash(), "jobs", jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(path.join(jobDir, "job.json"), JSON.stringify({
      id: jobId, kind: "task", status: "completed", phase: "implement", backend: "opencode",
      modelEntry: "opencode-go/deepseek-v4-flash:max", startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(), cwd: path.resolve(workspaceDir),
    }));
  }

  const queueCount = () => fs.readdirSync(queueLogDir).length;

  it("chain: delivers once, records the node launch, and stays at-most-once", async () => {
    const chainId = "chain-790";
    setupChain(chainId);
    const opts = { chainId, threadId: "thread-790", cwd: workspaceDir, stateDir, companionBin: companion, codexBin: codex, env: minimalEnv() };

    const res = await watchChain(opts);
    assert.equal(res.outcome, OUTCOME_DELIVERED, JSON.stringify(res.record?.error));
    assert.equal(res.record.chainState.container, "c790");
    assert.equal(res.record.queueLaunch.viaNode, true);
    assert.equal(res.record.queueLaunch.requested, codex);
    assert.equal(res.record.queueLaunch.resolvedPath, codex);
    assert.equal(res.record.queueLaunch.command, process.execPath);
    assert.equal(queueCount(), 1);

    const again = await watchChain(opts);
    assert.equal(again.outcome, OUTCOME_ALREADY_DELIVERED);
    assert.equal(queueCount(), 1);
  });

  it("task: delivers once with node off PATH", async () => {
    const jobId = "task-790";
    setupJob(jobId);
    const res = await watchTask({ jobId, threadId: "thread-790t", cwd: workspaceDir, stateDir, companionBin: companion, codexBin: codex, env: minimalEnv() });
    assert.equal(res.outcome, OUTCOME_DELIVERED, JSON.stringify(res.record?.error));
    assert.equal(res.record.queueLaunch.viaNode, true);
    assert.equal(queueCount(), 1);
  });

  it("a real queue failure under the node launch is still recorded as retryable queue failure", async () => {
    const chainId = "chain-790-fail";
    setupChain(chainId);
    const res = await watchChain({ chainId, threadId: "thread-790f", cwd: workspaceDir, stateDir, companionBin: companion, codexBin: codex, env: minimalEnv({ TEST_CODEX_FAIL: "generic" }) });
    assert.equal(res.outcome, OUTCOME_QUEUE_FAILURE);
    assert.equal(res.record.retryable, true);
    assert.equal(res.record.queue.exitCode, 1);
    assert.equal(res.record.queueLaunch.viaNode, true);
    assert.equal(queueCount(), 1);
  });
});

describe("register-watch launch dispatch with node off PATH (#790)", () => {
  let tmpRoot, noNodeBin, workspaceDir, stateDir, marker, companion;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kcn-790l-"));
    noNodeBin = path.join(tmpRoot, "empty-bin");
    workspaceDir = path.join(tmpRoot, "workspace");
    stateDir = path.join(tmpRoot, "notify-state");
    for (const d of [noNodeBin, workspaceDir, stateDir]) fs.mkdirSync(d, { recursive: true });
    marker = path.join(tmpRoot, "dispatch.json");
    // The stand-in records that it actually ran, then refuses the dispatch so
    // the wrapper stops before registering anything.
    companion = writeScript(
      path.join(tmpRoot, "mock-companion.mjs"),
      `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));
process.stderr.write("dispatch refused: test stand-in\\n");
process.exitCode = 1;
`,
    );
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  for (const [name, fn, sub] of [
    ["--launch (chain-detach)", () => launchAndWatch, "chain-detach"],
    ["--launch-task (task-detach)", () => launchTaskAndWatch, "task-detach"],
  ]) {
    it(`${name} reaches the companion instead of exiting 127`, async () => {
      const res = await fn()({
        companionBin: companion,
        codexBin: path.join(tmpRoot, "unused-codex"),
        args: ["--container", "c790"],
        threadId: "thread-790l",
        cwd: workspaceDir,
        stateDir,
        env: { PATH: noNodeBin, HOME: tmpRoot },
        timeoutMs: 100,
      });
      assert.equal(res.success, false);
      assert.equal(res.failureKind, "dispatch");
      assert.equal(res.exitCode, 1, res.stderr);
      assert.match(res.stderr, /dispatch refused/);
      assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")), [sub, "--container", "c790"]);
    });
  }
});
