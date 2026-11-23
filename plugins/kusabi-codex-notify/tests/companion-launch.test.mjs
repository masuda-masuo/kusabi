// companion-launch.test.mjs — kusabi #792: start the kusabi companion under a
// minimal PATH without a hand-made shim.
//
// `watch-chain.mjs` (task-wait / chain-wait) and `register-watch.mjs`
// (--launch / --launch-task dispatch) spawn the companion through
// `runResolvedProcess`.  Under systemd/cron the child PATH is `/usr/bin:/bin`
// and cannot resolve `node`, so the three companion forms that exist on a real
// host fail before the companion ever runs:
//
//   (A) a non-executable `.mjs` given by path       -> spawn EACCES
//   (B) the install-cli `#!/bin/sh` / `exec node "<target>" "$@"` shim
//       found on PATH under the bare name, or by absolute path
//                                                   -> exit 127 (node not found)
//   (C) the default bare `kusabi-companion` when nothing on PATH provides it
//                                                   -> spawn ENOENT
//
// Every child PATH below is built from temp dirs (never the host's PATH or
// ~/.local/bin), and the companions/codex are local stand-ins: no real Codex
// call happens and no real kusabi state is touched.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  OUTCOME_DELIVERED,
  OUTCOME_TASK_WAIT_FAILURE,
  parseCompanionShim,
  resolveNodeLaunch,
  runResolvedProcess,
  watchChain,
  watchTask,
} from "../scripts/watch-chain.mjs";
import { launchAndWatch, launchTaskAndWatch } from "../scripts/register-watch.mjs";
import { renderCompanionShim } from "../../kusabi/scripts/install-cli.mjs";

const SELF_WATCH_CHAIN = fileURLToPath(new URL("../scripts/watch-chain.mjs", import.meta.url));
const SELF_REGISTER_WATCH = fileURLToPath(new URL("../scripts/register-watch.mjs", import.meta.url));

function writeFile(file, body, mode = 0o644) {
  fs.writeFileSync(file, body, { mode });
  fs.chmodSync(file, mode); // writeFileSync's mode is filtered by the umask
  return file;
}

// A stand-in companion: records argv/PATH, prints the digest the watcher
// parses for wait subcommands, and refuses a detach dispatch (so the launch
// wrapper stops before registering anything).
function companionBody(marker) {
  return `import fs from "node:fs";
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ argv, path: process.env.PATH }));
const [sub, id] = argv;
if (sub === "chain-wait") {
  process.stdout.write(\`chain \${id}: status=completed disposition=accept rounds=1 waited=1s container=c792\\n\`);
} else if (sub === "task-wait") {
  process.stdout.write(\`task \${id}: status=completed phase=implement waited=1s\\n\`);
} else {
  process.stderr.write("dispatch refused: test stand-in\\n");
  process.exitCode = 1;
}
`;
}

function codexBody(logDir) {
  return `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
fs.writeFileSync(path.join(${JSON.stringify(logDir)}, \`\${process.pid}-\${Date.now()}.json\`), JSON.stringify(process.argv.slice(2)));
`;
}

describe("kusabi #792 companion launch under a minimal PATH", () => {
  let tmpRoot, extraRoots, noNodeBin, nodeBin, stateDir, kusabiStateDir, workspaceDir, queueLogDir;
  let marker, companionPath, codexPath;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kcn-792-"));
    extraRoots = [];
    noNodeBin = path.join(tmpRoot, "empty-bin");
    nodeBin = path.join(tmpRoot, "node-bin");
    stateDir = path.join(tmpRoot, "notify-state");
    kusabiStateDir = path.join(tmpRoot, "kusabi-state");
    workspaceDir = path.join(tmpRoot, "workspace");
    queueLogDir = path.join(tmpRoot, "queue-logs");
    for (const d of [noNodeBin, nodeBin, stateDir, kusabiStateDir, workspaceDir, queueLogDir]) {
      fs.mkdirSync(d, { recursive: true });
    }
    // A temp "node on PATH" directory: no host PATH is ever consulted.
    fs.symlinkSync(process.execPath, path.join(nodeBin, "node"));
    marker = path.join(tmpRoot, "marker.json");
    companionPath = writeFile(path.join(tmpRoot, "mock-companion.mjs"), companionBody(marker), 0o644);
    codexPath = writeFile(path.join(tmpRoot, "mock-codex.mjs"), codexBody(queueLogDir), 0o755);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    for (const root of extraRoots) fs.rmSync(root, { recursive: true, force: true });
  });

  function minimalEnv(extra = {}) {
    // systemd-like: no inherited PATH entry that provides node.
    return { PATH: noNodeBin, HOME: tmpRoot, KUSABI_STATE_DIR: kusabiStateDir, ...extra };
  }

  function wsHash() {
    return crypto.createHash("sha256").update(path.resolve(workspaceDir)).digest("hex").slice(0, 12);
  }

  function setupChain(chainId) {
    const chainDir = path.join(kusabiStateDir, wsHash(), "chains", chainId);
    fs.mkdirSync(chainDir, { recursive: true });
    fs.writeFileSync(path.join(chainDir, "control.json"), JSON.stringify({ status: "completed", round: 1, container: "c792" }));
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

  // Stand-in companion that succeeds on chain-detach / task-detach, writes
  // durable state for the --since selector, and completes chain-wait / task-wait.
  function launchingCompanionBody({ logFile, kusabiStateDir: stateRoot, cwd, chainId = "chain-792rw", jobId = "job-792rw" }) {
    return `import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
fs.appendFileSync(
  ${JSON.stringify(logFile)},
  JSON.stringify({ argv, path: process.env.PATH, script: fileURLToPath(import.meta.url) }) + "\\n",
);
const [sub, id] = argv;
const hash = crypto.createHash("sha256").update(path.resolve(${JSON.stringify(cwd)})).digest("hex").slice(0, 12);
const since = new Date(Date.now() - 5000).toISOString();

if (sub === "chain-detach") {
  const chainDir = path.join(${JSON.stringify(stateRoot)}, hash, "chains", ${JSON.stringify(chainId)});
  fs.mkdirSync(chainDir, { recursive: true });
  fs.writeFileSync(
    path.join(chainDir, "control.json"),
    JSON.stringify({ status: "completed", round: 1, container: "c792", createdAt: new Date().toISOString() }),
  );
  fs.writeFileSync(
    path.join(chainDir, "chain.json"),
    JSON.stringify({ chainId: ${JSON.stringify(chainId)}, records: [{ round: 1, disposition: { disposition: "accept" } }] }),
  );
  process.stdout.write(\`Detached chain launched (pid \${process.pid}).\\nTo wait for completion, run:\\n  kusabi-companion chain-wait --next --since \${since}\\n\`);
} else if (sub === "task-detach") {
  const jobDir = path.join(${JSON.stringify(stateRoot)}, hash, "jobs", ${JSON.stringify(jobId)});
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(
    path.join(jobDir, "job.json"),
    JSON.stringify({
      id: ${JSON.stringify(jobId)}, kind: "task", status: "completed", phase: "implement",
      backend: "opencode", modelEntry: "opencode-go/deepseek-v4-flash:max",
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      cwd: path.resolve(${JSON.stringify(cwd)}),
    }),
  );
  process.stdout.write(\`Detached task launched (pid \${process.pid}).\\nTo wait for completion, run:\\n  kusabi-companion task-wait --next --since \${since}\\n\`);
} else if (sub === "chain-wait") {
  process.stdout.write(\`chain \${id}: status=completed disposition=accept rounds=1 waited=1s container=c792\\n\`);
} else if (sub === "task-wait") {
  process.stdout.write(\`task \${id}: status=completed phase=implement waited=1s\\n\`);
} else {
  process.stderr.write(\`unexpected subcommand: \${sub}\\n\`);
  process.exitCode = 1;
}
`;
  }

  function readJsonLines(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  async function waitForTerminalRecord(recordPath, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      if (fs.existsSync(recordPath)) {
        try {
          last = JSON.parse(fs.readFileSync(recordPath, "utf8"));
          if (last.status && last.status !== "waiting") {
            if (last.pid) {
              const pidDeadline = Date.now() + 1000;
              while (Date.now() < pidDeadline) {
                try {
                  process.kill(last.pid, 0);
                  await new Promise((r) => setTimeout(r, 20));
                } catch {
                  break;
                }
              }
            }
            return last;
          }
        } catch {
          // retry if mid-rename
        }
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`Timed out waiting for terminal record at ${recordPath}; last=${JSON.stringify(last)}`);
  }

  function runRegisterWatchCli(scriptPath, args, env) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [scriptPath, ...args], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("error", reject);
      child.on("close", (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
    });
  }

  // Copy watch-chain.mjs + register-watch.mjs into a throwaway checkout so
  // `import.meta.url` derives the sibling companion inside a temp tree we control.
  async function makeCheckout({ withSibling = true, companionSource = null, spyWatcherArgvLog = null } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kcn-792-tree-"));
    extraRoots.push(root);
    const scripts = path.join(root, "plugins/kusabi-codex-notify/scripts");
    const kusabiScripts = path.join(root, "plugins/kusabi/scripts");
    fs.mkdirSync(scripts, { recursive: true });
    fs.mkdirSync(kusabiScripts, { recursive: true });
    const regScriptPath = path.join(scripts, "register-watch.mjs");
    fs.copyFileSync(SELF_REGISTER_WATCH, regScriptPath);
    if (spyWatcherArgvLog) {
      const origWatchChain = path.join(scripts, "watch-chain-orig.mjs");
      fs.copyFileSync(SELF_WATCH_CHAIN, origWatchChain);
      fs.writeFileSync(
        path.join(scripts, "watch-chain.mjs"),
        `import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export * from "./watch-chain-orig.mjs";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  fs.appendFileSync(${JSON.stringify(spyWatcherArgvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
  process.argv[1] = ${JSON.stringify(origWatchChain)};
  await import("./watch-chain-orig.mjs?run=" + Date.now());
}
`,
      );
    } else {
      fs.copyFileSync(SELF_WATCH_CHAIN, path.join(scripts, "watch-chain.mjs"));
    }
    const siblingPath = path.join(kusabiScripts, "kusabi-companion.mjs");
    if (withSibling) fs.writeFileSync(siblingPath, companionSource ?? companionBody(marker));
    const mod = await import(pathToFileURL(path.join(scripts, "watch-chain.mjs")).href);
    const regMod = await import(pathToFileURL(regScriptPath).href);
    return { root, mod, regMod, regScriptPath, siblingPath };
  }

  describe("parseCompanionShim", () => {
    it("accepts exactly what install-cli renders", () => {
      const target = "/opt/kusabi/plugins/kusabi/scripts/kusabi-companion.mjs";
      assert.equal(parseCompanionShim(renderCompanionShim(target)), target);
      assert.equal(parseCompanionShim(renderCompanionShim(companionPath)), companionPath);
    });

    it("rejects every other /bin/sh script", () => {
      const cases = [
        '#!/bin/sh\nexec node "/t" "$@"\necho extra\n',
        '#!/bin/sh\nnode "/t" "$@"\n',
        '#!/bin/sh\nexec nodejs "/t" "$@"\n',
        "#!/bin/sh\nexec node '/t' \"$@\"\n",
        '#!/bin/sh\nexec node "/t" $@\n',
        '#!/bin/bash\nexec node "/t" "$@"\n',
        "#!/bin/sh\nexit 0\n",
        "",
        null,
      ];
      for (const content of cases) assert.equal(parseCompanionShim(content), null, String(content));
    });
  });

  describe("launch resolution", () => {
    it("(A) runs a non-executable .mjs given by path through the running Node", () => {
      assert.equal(fs.statSync(companionPath).mode & 0o111, 0, "fixture must not be executable");
      const env = { PATH: noNodeBin, KEEP: "1" };
      const launch = resolveNodeLaunch(companionPath, ["task-wait", "job-792"], { cwd: tmpRoot, env });
      assert.equal(launch.viaNode, true);
      assert.equal(launch.command, process.execPath);
      assert.deepEqual(launch.args, [companionPath, "task-wait", "job-792"]);
      assert.equal(launch.env.PATH, `${noNodeBin}${path.delimiter}${path.dirname(process.execPath)}`);
      assert.equal(launch.env.KEEP, "1");
      assert.equal(env.PATH, noNodeBin, "caller env must not be mutated");
    });

    it("(A) resolves a bare .mjs name against cwd and supports .cjs/.js", () => {
      const launch = resolveNodeLaunch("mock-companion.mjs", ["x"], { cwd: tmpRoot, env: { PATH: noNodeBin } });
      assert.equal(launch.viaNode, true);
      assert.deepEqual(launch.args, [companionPath, "x"]);

      for (const ext of [".cjs", ".js"]) {
        const jsFile = writeFile(path.join(tmpRoot, `tool${ext}`), "console.log('ok');\n", 0o644);
        const res = resolveNodeLaunch(jsFile, ["arg"], { cwd: tmpRoot, env: { PATH: noNodeBin } });
        assert.equal(res.viaNode, true, ext);
        assert.equal(res.command, process.execPath, ext);
        assert.deepEqual(res.args, [jsFile, "arg"], ext);
      }
    });

    it("(B) runs the install-cli shim's target through the running Node", () => {
      const shimDir = path.join(tmpRoot, "shim-bin");
      fs.mkdirSync(shimDir);
      const shimPath = writeFile(path.join(shimDir, "kusabi-companion"), renderCompanionShim(companionPath), 0o755);

      const byPath = resolveNodeLaunch(shimPath, ["chain-wait", "c1"], { cwd: tmpRoot, env: { PATH: noNodeBin } });
      assert.equal(byPath.viaNode, true);
      assert.equal(byPath.command, process.execPath);
      assert.deepEqual(byPath.args, [companionPath, "chain-wait", "c1"]);
      assert.equal(byPath.resolvedPath, shimPath);

      const byName = resolveNodeLaunch("kusabi-companion", ["chain-wait", "c1"], {
        cwd: tmpRoot,
        env: { PATH: `${shimDir}${path.delimiter}${noNodeBin}` },
        defaultCompanion: true,
      });
      assert.equal(byName.viaNode, true);
      assert.equal(byName.command, process.execPath);
      assert.deepEqual(byName.args, [companionPath, "chain-wait", "c1"]);
    });

    it("(C) falls back to the checkout's sibling companion for the default", async () => {
      const { mod, siblingPath } = await makeCheckout();
      const launch = mod.resolveNodeLaunch("kusabi-companion", ["task-wait", "job-c"], {
        cwd: tmpRoot,
        env: { PATH: noNodeBin },
        defaultCompanion: true,
      });
      assert.equal(launch.viaNode, true);
      assert.equal(launch.command, process.execPath);
      assert.deepEqual(launch.args, [siblingPath, "task-wait", "job-c"]);
      assert.equal(launch.resolvedPath, siblingPath);
    });

    it("(C) leaves the default launch unchanged when the sibling is absent", async () => {
      const { mod } = await makeCheckout({ withSibling: false });
      const launch = mod.resolveNodeLaunch("kusabi-companion", ["task-wait", "job-c"], {
        cwd: tmpRoot,
        env: { PATH: noNodeBin },
        defaultCompanion: true,
      });
      assert.equal(launch.viaNode, false);
      assert.equal(launch.command, "kusabi-companion");
    });

    it("launches other /bin/sh scripts and native binaries unchanged", () => {
      const plainSh = writeFile(
        path.join(tmpRoot, "plain.sh"),
        '#!/bin/sh\nexec node "/nonexistent" "$@"\necho extra\n',
        0o755,
      );
      const bashShim = writeFile(
        path.join(tmpRoot, "bash-shim"),
        renderCompanionShim(companionPath).replace("#!/bin/sh", "#!/bin/bash"),
        0o755,
      );
      const native = path.join(tmpRoot, "native");
      fs.writeFileSync(native, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]), { mode: 0o755 });
      fs.chmodSync(native, 0o755);

      for (const file of [plainSh, bashShim, native]) {
        const launch = resolveNodeLaunch(file, ["a"], { cwd: tmpRoot, env: { PATH: noNodeBin } });
        assert.equal(launch.viaNode, false, file);
        assert.equal(launch.command, file, file);
      }
    });

    it("never swaps an explicit missing companion for the sibling", async () => {
      const missing = path.join(tmpRoot, "does-not-exist.mjs");
      const launch = resolveNodeLaunch(missing, ["task-wait", "j"], {
        cwd: tmpRoot,
        env: { PATH: noNodeBin },
        defaultCompanion: false,
      });
      assert.equal(launch.viaNode, false);
      assert.equal(launch.command, missing);

      const bare = resolveNodeLaunch("no-such-companion", [], { cwd: tmpRoot, env: { PATH: noNodeBin } });
      assert.equal(bare.viaNode, false);
      assert.equal(bare.command, "no-such-companion");

      // It still fails exactly as today (ENOENT), not by running the sibling.
      const res = await runResolvedProcess(missing, [], { cwd: tmpRoot, env: { PATH: noNodeBin } });
      assert.notEqual(res.exitCode, 0);
      assert.equal(fs.existsSync(marker), false);
    });

    it("leaves every form unchanged when the child PATH resolves node", () => {
      const shimDir = path.join(tmpRoot, "shim-bin-node");
      fs.mkdirSync(shimDir);
      const shimPath = writeFile(path.join(shimDir, "kusabi-companion"), renderCompanionShim(companionPath), 0o755);
      const env = { PATH: nodeBin };

      const a = resolveNodeLaunch(companionPath, ["x"], { cwd: tmpRoot, env });
      assert.equal(a.viaNode, false);
      assert.equal(a.command, companionPath);

      const b = resolveNodeLaunch(shimPath, ["x"], { cwd: tmpRoot, env });
      assert.equal(b.viaNode, false);
      assert.equal(b.command, shimPath);

      const c = resolveNodeLaunch("kusabi-companion", ["x"], { cwd: tmpRoot, env, defaultCompanion: true });
      assert.equal(c.viaNode, false);
      assert.equal(c.command, "kusabi-companion");
    });
  });

  describe("watchers reach the companion with node off PATH", () => {
    it("task-wait reaches (A) a non-executable .mjs companion", async () => {
      const jobId = "job-792a";
      setupJob(jobId);
      const res = await watchTask({
        jobId,
        threadId: "thread-792a",
        cwd: workspaceDir,
        stateDir,
        companionBin: companionPath,
        codexBin: codexPath,
        env: minimalEnv(),
      });
      assert.equal(res.outcome, OUTCOME_DELIVERED, JSON.stringify(res.record?.error));
      assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")).argv, ["task-wait", jobId]);
      assert.match(res.record.taskWait.stdout, /status=completed/);
    });

    it("task-wait reaches (B) an install-cli shim found on PATH under the bare name", async () => {
      const jobId = "job-792b";
      setupJob(jobId);
      const shimDir = path.join(tmpRoot, "shim-bin");
      fs.mkdirSync(shimDir);
      writeFile(path.join(shimDir, "kusabi-companion"), renderCompanionShim(companionPath), 0o755);
      const res = await watchTask({
        jobId,
        threadId: "thread-792b",
        cwd: workspaceDir,
        stateDir,
        codexBin: codexPath,
        env: minimalEnv({ PATH: `${shimDir}${path.delimiter}${noNodeBin}` }),
      });
      assert.equal(res.outcome, OUTCOME_DELIVERED, JSON.stringify(res.record?.error));
      assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")).argv, ["task-wait", jobId]);
    });

    it("task-wait reaches (B) an install-cli shim given by absolute path", async () => {
      const jobId = "job-792b2";
      setupJob(jobId);
      const shimPath = writeFile(path.join(tmpRoot, "kusabi-companion-shim"), renderCompanionShim(companionPath), 0o755);
      const res = await watchTask({
        jobId,
        threadId: "thread-792b2",
        cwd: workspaceDir,
        stateDir,
        companionBin: shimPath,
        codexBin: codexPath,
        env: minimalEnv(),
      });
      assert.equal(res.outcome, OUTCOME_DELIVERED, JSON.stringify(res.record?.error));
      assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")).argv, ["task-wait", jobId]);
    });

    it("task-wait reaches (C) the checkout's sibling companion for the default", async () => {
      const { mod } = await makeCheckout();
      const jobId = "job-792c";
      setupJob(jobId);
      const res = await mod.watchTask({
        jobId,
        threadId: "thread-792c",
        cwd: workspaceDir,
        stateDir,
        codexBin: codexPath,
        env: minimalEnv(),
      });
      assert.equal(res.outcome, mod.OUTCOME_DELIVERED, JSON.stringify(res.record?.error));
      assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")).argv, ["task-wait", jobId]);
    });

    it("task-wait never swaps an explicit missing --companion-bin or KUSABI_COMPANION_BIN for the sibling", async () => {
      const { mod } = await makeCheckout();
      const missing = path.join(tmpRoot, "does-not-exist.mjs");

      setupJob("job-792-explicit-flag");
      const r1 = await mod.watchTask({
        jobId: "job-792-explicit-flag",
        threadId: "thread-792ef",
        cwd: workspaceDir,
        stateDir,
        companionBin: missing,
        codexBin: codexPath,
        env: minimalEnv(),
      });
      assert.equal(r1.outcome, OUTCOME_TASK_WAIT_FAILURE);
      assert.equal(fs.existsSync(marker), false);

      setupJob("job-792-explicit-env");
      const r2 = await mod.watchTask({
        jobId: "job-792-explicit-env",
        threadId: "thread-792ee",
        cwd: workspaceDir,
        stateDir,
        codexBin: codexPath,
        env: minimalEnv({ KUSABI_COMPANION_BIN: missing }),
      });
      assert.equal(r2.outcome, OUTCOME_TASK_WAIT_FAILURE);
      assert.equal(fs.existsSync(marker), false);
    });

    it("chain-wait reaches the companion with node off PATH (A and C)", async () => {
      const chainId = "chain-792";
      setupChain(chainId);
      const res = await watchChain({
        chainId,
        threadId: "thread-792c",
        cwd: workspaceDir,
        stateDir,
        companionBin: companionPath,
        codexBin: codexPath,
        env: minimalEnv(),
      });
      assert.equal(res.outcome, OUTCOME_DELIVERED, JSON.stringify(res.record?.error));
      assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")).argv, ["chain-wait", chainId]);

      fs.rmSync(marker, { force: true });
      const { mod } = await makeCheckout();
      const chainIdC = "chain-792c";
      setupChain(chainIdC);
      const resC = await mod.watchChain({
        chainId: chainIdC,
        threadId: "thread-792c2",
        cwd: workspaceDir,
        stateDir,
        codexBin: codexPath,
        env: minimalEnv(),
      });
      assert.equal(resC.outcome, mod.OUTCOME_DELIVERED, JSON.stringify(resC.record?.error));
      assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")).argv, ["chain-wait", chainIdC]);
    });
  });

  describe("register-watch dispatch with node off PATH", () => {
    it("--launch reaches (A) a non-executable .mjs companion and (C) default sibling", async () => {
      const res = await launchAndWatch({
        companionBin: companionPath,
        codexBin: path.join(tmpRoot, "unused-codex"),
        args: ["--container", "c792"],
        threadId: "thread-792l",
        cwd: workspaceDir,
        stateDir,
        env: minimalEnv(),
        timeoutMs: 100,
      });
      assert.equal(res.success, false);
      assert.equal(res.failureKind, "dispatch");
      assert.equal(res.exitCode, 1, res.stderr);
      assert.match(res.stderr, /dispatch refused/);
      assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")).argv, ["chain-detach", "--container", "c792"]);

      fs.rmSync(marker, { force: true });
      const { regMod } = await makeCheckout();
      const resC = await regMod.launchAndWatch({
        codexBin: path.join(tmpRoot, "unused-codex"),
        args: ["--container", "c792"],
        threadId: "thread-792lc",
        cwd: workspaceDir,
        stateDir,
        env: minimalEnv(),
        timeoutMs: 100,
      });
      assert.equal(resC.success, false);
      assert.equal(resC.failureKind, "dispatch");
      assert.equal(resC.exitCode, 1, resC.stderr);
      assert.match(resC.stderr, /dispatch refused/);
      assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")).argv, ["chain-detach", "--container", "c792"]);
    });

    it("--launch-task reaches (B) an install-cli shim and (C) default sibling", async () => {
      const shimPath = writeFile(path.join(tmpRoot, "kusabi-companion-shim"), renderCompanionShim(companionPath), 0o755);
      const res = await launchTaskAndWatch({
        companionBin: shimPath,
        codexBin: path.join(tmpRoot, "unused-codex"),
        args: ["--container", "c792"],
        threadId: "thread-792t",
        cwd: workspaceDir,
        stateDir,
        env: minimalEnv(),
        timeoutMs: 100,
      });
      assert.equal(res.success, false);
      assert.equal(res.failureKind, "dispatch");
      assert.equal(res.exitCode, 1, res.stderr);
      assert.match(res.stderr, /dispatch refused/);
      assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")).argv, ["task-detach", "--container", "c792"]);

      fs.rmSync(marker, { force: true });
      const { regMod } = await makeCheckout();
      const resC = await regMod.launchTaskAndWatch({
        codexBin: path.join(tmpRoot, "unused-codex"),
        args: ["--container", "c792"],
        threadId: "thread-792tc",
        cwd: workspaceDir,
        stateDir,
        env: minimalEnv(),
        timeoutMs: 100,
      });
      assert.equal(resC.success, false);
      assert.equal(resC.failureKind, "dispatch");
      assert.equal(resC.exitCode, 1, resC.stderr);
      assert.match(resC.stderr, /dispatch refused/);
      assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")).argv, ["task-detach", "--container", "c792"]);
    });
  });

  describe("registered watcher end-to-end with node off PATH", () => {
    it("registered watcher completes chain-wait via default sibling after --launch succeeds (detached and sync)", async () => {
      const invocationLog = path.join(tmpRoot, "invocations-chain.jsonl");
      const watcherArgvLog = path.join(tmpRoot, "watcher-argv-chain.jsonl");
      const chainId = "chain-792rw";
      const { regMod, regScriptPath, siblingPath } = await makeCheckout({
        companionSource: launchingCompanionBody({ logFile: invocationLog, kusabiStateDir, cwd: workspaceDir, chainId }),
        spyWatcherArgvLog: watcherArgvLog,
      });

      const detachedStateDir = path.join(stateDir, "detached-chain");
      const cliRes = await runRegisterWatchCli(
        regScriptPath,
        [
          "--launch",
          "--thread", "thread-792rw-c1",
          "--cwd", workspaceDir,
          "--state-dir", detachedStateDir,
          "--codex-bin", codexPath,
          "--",
          "--container", "c792",
        ],
        minimalEnv(),
      );
      assert.equal(cliRes.exitCode, 0, cliRes.stderr);

      const recordPath = path.join(detachedStateDir, "records", `chain-${chainId}.json`);
      const record = await waitForTerminalRecord(recordPath);
      assert.equal(record.status, "delivered", JSON.stringify(record));
      assert.equal(record.outcome, OUTCOME_DELIVERED);

      const watcherArgvs = readJsonLines(watcherArgvLog);
      assert.equal(watcherArgvs.length, 1);
      assert.equal(watcherArgvs[0].includes("--companion-bin"), false, JSON.stringify(watcherArgvs[0]));

      const calls = readJsonLines(invocationLog);
      assert.deepEqual(calls.map((c) => c.argv), [
        ["chain-detach", "--container", "c792"],
        ["chain-wait", chainId],
      ]);
      for (const call of calls) {
        assert.equal(call.script, siblingPath);
      }
      assert.equal(fs.readdirSync(queueLogDir).length, 1);

      fs.rmSync(invocationLog, { force: true });
      const syncStateDir = path.join(stateDir, "sync-chain");
      const syncRes = await regMod.launchAndWatch({
        codexBin: codexPath,
        args: ["--container", "c792"],
        threadId: "thread-792rw-c2",
        cwd: workspaceDir,
        stateDir: syncStateDir,
        env: minimalEnv(),
        sync: true,
      });
      assert.equal(syncRes.success, true, syncRes.error?.message);
      assert.equal(syncRes.chainId, chainId);
      assert.equal(syncRes.registration.outcome, OUTCOME_DELIVERED);
      const syncCalls = readJsonLines(invocationLog);
      assert.deepEqual(syncCalls.map((c) => c.argv), [
        ["chain-detach", "--container", "c792"],
        ["chain-wait", chainId],
      ]);
      assert.equal(fs.readdirSync(queueLogDir).length, 2);
    });

    it("registered watcher completes task-wait via default sibling after --launch-task succeeds (detached and sync)", async () => {
      const invocationLog = path.join(tmpRoot, "invocations-task.jsonl");
      const watcherArgvLog = path.join(tmpRoot, "watcher-argv-task.jsonl");
      const jobId = "job-792rw";
      const { regMod, regScriptPath, siblingPath } = await makeCheckout({
        companionSource: launchingCompanionBody({ logFile: invocationLog, kusabiStateDir, cwd: workspaceDir, jobId }),
        spyWatcherArgvLog: watcherArgvLog,
      });

      const detachedStateDir = path.join(stateDir, "detached-task");
      const cliRes = await runRegisterWatchCli(
        regScriptPath,
        [
          "--launch-task",
          "--thread", "thread-792rw-t1",
          "--cwd", workspaceDir,
          "--state-dir", detachedStateDir,
          "--codex-bin", codexPath,
          "--",
          "--container", "c792",
        ],
        minimalEnv(),
      );
      assert.equal(cliRes.exitCode, 0, cliRes.stderr);

      const recordPath = path.join(detachedStateDir, "records", `task-${jobId}.json`);
      const record = await waitForTerminalRecord(recordPath);
      assert.equal(record.status, "delivered", JSON.stringify(record));
      assert.equal(record.outcome, OUTCOME_DELIVERED);

      const watcherArgvs = readJsonLines(watcherArgvLog);
      assert.equal(watcherArgvs.length, 1);
      assert.equal(watcherArgvs[0].includes("--companion-bin"), false, JSON.stringify(watcherArgvs[0]));

      const calls = readJsonLines(invocationLog);
      assert.deepEqual(calls.map((c) => c.argv), [
        ["task-detach", "--container", "c792"],
        ["task-wait", jobId],
      ]);
      for (const call of calls) {
        assert.equal(call.script, siblingPath);
      }
      assert.equal(fs.readdirSync(queueLogDir).length, 1);

      fs.rmSync(invocationLog, { force: true });
      const syncStateDir = path.join(stateDir, "sync-task");
      const syncRes = await regMod.launchTaskAndWatch({
        codexBin: codexPath,
        args: ["--container", "c792"],
        threadId: "thread-792rw-t2",
        cwd: workspaceDir,
        stateDir: syncStateDir,
        env: minimalEnv(),
        sync: true,
      });
      assert.equal(syncRes.success, true, syncRes.error?.message);
      assert.equal(syncRes.jobId, jobId);
      assert.equal(syncRes.registration.outcome, OUTCOME_DELIVERED);
      const syncCalls = readJsonLines(invocationLog);
      assert.deepEqual(syncCalls.map((c) => c.argv), [
        ["task-detach", "--container", "c792"],
        ["task-wait", jobId],
      ]);
      assert.equal(fs.readdirSync(queueLogDir).length, 2);
    });

    it("control: registered watcher receives exact explicit --companion-bin (and KUSABI_COMPANION_BIN propagates)", async () => {
      const siblingLog = path.join(tmpRoot, "sibling-ctrl.jsonl");
      const explicitLog = path.join(tmpRoot, "explicit-ctrl.jsonl");
      const watcherArgvLog = path.join(tmpRoot, "watcher-argv-ctrl.jsonl");
      const chainId = "chain-792ctrl";
      const jobId = "job-792ctrl";

      const { regScriptPath } = await makeCheckout({
        companionSource: launchingCompanionBody({ logFile: siblingLog, kusabiStateDir, cwd: workspaceDir, chainId, jobId }),
        spyWatcherArgvLog: watcherArgvLog,
      });
      const explicitCompanion = writeFile(
        path.join(tmpRoot, "explicit-companion.mjs"),
        launchingCompanionBody({ logFile: explicitLog, kusabiStateDir, cwd: workspaceDir, chainId, jobId }),
        0o644,
      );

      // 1. Explicit --companion-bin on --launch
      const chainStateDir = path.join(stateDir, "ctrl-chain-flag");
      const chainCliRes = await runRegisterWatchCli(
        regScriptPath,
        [
          "--launch",
          "--companion-bin", explicitCompanion,
          "--thread", "thread-792ctrl-c1",
          "--cwd", workspaceDir,
          "--state-dir", chainStateDir,
          "--codex-bin", codexPath,
          "--",
          "--container", "c792",
        ],
        minimalEnv(),
      );
      assert.equal(chainCliRes.exitCode, 0, chainCliRes.stderr);
      const chainRecord = await waitForTerminalRecord(path.join(chainStateDir, "records", `chain-${chainId}.json`));
      assert.equal(chainRecord.status, "delivered", JSON.stringify(chainRecord));

      // 2. Explicit --companion-bin on --launch-task
      const taskStateDir = path.join(stateDir, "ctrl-task-flag");
      const taskCliRes = await runRegisterWatchCli(
        regScriptPath,
        [
          "--launch-task",
          "--companion-bin", explicitCompanion,
          "--thread", "thread-792ctrl-t1",
          "--cwd", workspaceDir,
          "--state-dir", taskStateDir,
          "--codex-bin", codexPath,
          "--",
          "--container", "c792",
        ],
        minimalEnv(),
      );
      assert.equal(taskCliRes.exitCode, 0, taskCliRes.stderr);
      const taskRecord = await waitForTerminalRecord(path.join(taskStateDir, "records", `task-${jobId}.json`));
      assert.equal(taskRecord.status, "delivered", JSON.stringify(taskRecord));

      const watcherArgvs = readJsonLines(watcherArgvLog);
      assert.equal(watcherArgvs.length, 2);
      for (const argv of watcherArgvs) {
        const idx = argv.indexOf("--companion-bin");
        assert.ok(idx >= 0, `expected --companion-bin in watcher argv: ${JSON.stringify(argv)}`);
        assert.equal(argv[idx + 1], explicitCompanion);
      }

      // 3. Explicit KUSABI_COMPANION_BIN propagates through detached watcher for --launch and --launch-task
      const envChainDir = path.join(stateDir, "ctrl-chain-env");
      const envChainRes = await runRegisterWatchCli(
        regScriptPath,
        [
          "--launch",
          "--thread", "thread-792ctrl-c2",
          "--cwd", workspaceDir,
          "--state-dir", envChainDir,
          "--codex-bin", codexPath,
          "--",
          "--container", "c792",
        ],
        minimalEnv({ KUSABI_COMPANION_BIN: explicitCompanion }),
      );
      assert.equal(envChainRes.exitCode, 0, envChainRes.stderr);
      const envChainRecord = await waitForTerminalRecord(path.join(envChainDir, "records", `chain-${chainId}.json`));
      assert.equal(envChainRecord.status, "delivered", JSON.stringify(envChainRecord));

      const envTaskDir = path.join(stateDir, "ctrl-task-env");
      const envTaskRes = await runRegisterWatchCli(
        regScriptPath,
        [
          "--launch-task",
          "--thread", "thread-792ctrl-t2",
          "--cwd", workspaceDir,
          "--state-dir", envTaskDir,
          "--codex-bin", codexPath,
          "--",
          "--container", "c792",
        ],
        minimalEnv({ KUSABI_COMPANION_BIN: explicitCompanion }),
      );
      assert.equal(envTaskRes.exitCode, 0, envTaskRes.stderr);
      const envTaskRecord = await waitForTerminalRecord(path.join(envTaskDir, "records", `task-${jobId}.json`));
      assert.equal(envTaskRecord.status, "delivered", JSON.stringify(envTaskRecord));

      assert.equal(fs.existsSync(siblingLog), false, "sibling companion must not be called when explicit companion is given");
      const explicitCalls = readJsonLines(explicitLog);
      assert.deepEqual(explicitCalls.map((c) => c.argv), [
        ["chain-detach", "--container", "c792"],
        ["chain-wait", chainId],
        ["task-detach", "--container", "c792"],
        ["task-wait", jobId],
        ["chain-detach", "--container", "c792"],
        ["chain-wait", chainId],
        ["task-detach", "--container", "c792"],
        ["task-wait", jobId],
      ]);
      for (const call of explicitCalls) {
        assert.equal(call.script, explicitCompanion);
      }
    });
  });
});
