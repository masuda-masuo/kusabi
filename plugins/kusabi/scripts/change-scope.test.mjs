import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { renderChangeScope } from "./change-scope.mjs";

const SCRIPT = fileURLToPath(new URL("./change-scope.mjs", import.meta.url));
const fixtures = [];

// Windows-only trailing-space worktree paths and non-UTF-8 index paths from
// the harness both construct on this Linux container, so both are ported.

after(() => {
  for (const dir of fixtures) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LANG: "C", LC_ALL: "C" },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
  }
  return result.stdout;
}

function gitSha(cwd, ref) {
  return git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
}

function writeCommit(work, file, contents, message) {
  fs.writeFileSync(path.join(work, file), contents);
  git(work, ["add", "--", file]);
  git(work, ["commit", "-m", message]);
  return gitSha(work, "HEAD");
}

function createRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "change-scope-"));
  fixtures.push(root);
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  fs.mkdirSync(origin);
  fs.mkdirSync(work);
  git(origin, ["init", "--bare", "-b", "master"]);
  git(work, ["init", "-b", "master"]);
  git(work, ["config", "user.email", "change-scope@test.invalid"]);
  git(work, ["config", "user.name", "Change Scope"]);
  git(work, ["config", "commit.gpgsign", "false"]);
  writeCommit(work, "initial.txt", "initial\n", "initial");
  git(work, ["remote", "add", "origin", origin]);
  git(work, ["push", "-u", "origin", "master"]);
  return { root, origin, work };
}

function parseScope(args, cwd) {
  const text = renderChangeScope(args, cwd);
  assert.equal(text.endsWith("\n"), true);
  return { text, report: JSON.parse(text) };
}

function repoState(work) {
  return {
    status: git(work, ["status", "--porcelain=v1", "--untracked-files=all"]),
    head: git(work, ["rev-parse", "HEAD"]),
    refs: git(work, ["show-ref", "--head"]),
    index: git(work, ["ls-files", "-s"]),
    config: git(work, ["config", "--local", "--list"]),
  };
}

function runCli(cliArgs, cwd) {
  return spawnSync(process.execPath, [SCRIPT, ...cliArgs], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LANG: "C", LC_ALL: "C" },
  });
}

describe("change-scope", () => {
  it("fresh feature branch against origin/master", () => {
    const { work } = createRepo();
    git(work, ["switch", "-c", "feature"]);
    git(work, ["branch", "--set-upstream-to=origin/master"]);
    const headSha = writeCommit(work, "feature.txt", "feature\n", "feature");
    const originMaster = gitSha(work, "origin/master");

    const { report } = parseScope(["--base", "origin/master"], work);
    assert.equal(report.formatVersion, 1);
    assert.equal(report.input.base, "origin/master");
    assert.equal(report.input.head, "HEAD");
    assert.equal(report.resolved.baseSha, originMaster);
    assert.equal(report.resolved.headSha, headSha);
    assert.equal(report.resolved.mergeBaseSha, originMaster);
    assert.deepEqual(report.paths, {
      committed: ["feature.txt"],
      staged: [],
      unstaged: [],
      untracked: [],
    });

    git(work, ["push", "--set-upstream", "origin", "feature"]);
    const { report: afterPush } = parseScope(["--base", "origin/master"], work);
    assert.deepEqual(afterPush.paths.committed, ["feature.txt"]);
  });

  it("exact head above a stacked base; worktree dirt stays local", () => {
    const { work } = createRepo();
    git(work, ["switch", "-c", "foundation"]);
    writeCommit(work, "foundation.txt", "foundation\n", "foundation");
    git(work, ["switch", "-c", "topic"]);
    const topicSha = writeCommit(work, "topic.txt", "topic\n", "topic");
    writeCommit(work, "later.txt", "later\n", "later");
    fs.writeFileSync(path.join(work, "current-worktree.txt"), "dirt\n");

    const { report } = parseScope(["--base", "foundation", "--head", topicSha], work);
    assert.equal(report.input.head, topicSha);
    assert.equal(report.resolved.headSha, topicSha);
    assert.deepEqual(report.paths.committed, ["topic.txt"]);
    assert.equal(report.paths.committed.includes("later.txt"), false);
    assert.deepEqual(report.paths.untracked, ["current-worktree.txt"]);
  });

  it("four buckets independent; repo state unchanged", () => {
    const { work } = createRepo();
    writeCommit(work, "unstaged.txt", "base\n", "add unstaged.txt");
    const baseSha = gitSha(work, "HEAD");
    writeCommit(work, "committed.txt", "committed\n", "committed");

    fs.writeFileSync(path.join(work, "staged.txt"), "staged\n");
    git(work, ["add", "--", "staged.txt"]);

    fs.writeFileSync(path.join(work, "mixed.txt"), "staged-part\n");
    git(work, ["add", "--", "mixed.txt"]);
    fs.writeFileSync(path.join(work, "mixed.txt"), "staged-part\nunstaged-extra\n");

    fs.writeFileSync(path.join(work, "unstaged.txt"), "base\nedited\n");
    fs.writeFileSync(path.join(work, "untracked.txt"), "untracked\n");

    const before = repoState(work);
    const { report } = parseScope(["--base", baseSha], work);
    assert.deepEqual(report.paths, {
      committed: ["committed.txt"],
      staged: ["mixed.txt", "staged.txt"],
      unstaged: ["mixed.txt", "unstaged.txt"],
      untracked: ["untracked.txt"],
    });
    assert.deepEqual(repoState(work), before);

    const cli = runCli(["--base", baseSha], work);
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout).paths, report.paths);
    assert.deepEqual(repoState(work), before);
  });

  it("refuses missing --base", () => {
    const { work } = createRepo();
    assert.throws(
      () => renderChangeScope([], work),
      (err) => {
        assert.equal(err.message, "missing required --base <ref>");
        return true;
      },
    );
    const cli = runCli(["--head", "HEAD"], work);
    assert.equal(cli.status, 1);
    assert.equal(cli.stderr, "change-scope: missing required --base <ref>\n");
  });

  it("refuses --base missing", () => {
    const { work } = createRepo();
    assert.throws(
      () => renderChangeScope(["--base", "missing"], work),
      (err) => {
        assert.equal(err.message, "base ref missing does not resolve to a commit");
        return true;
      },
    );
  });

  it("refuses --base collision when a branch and a tag share the name", () => {
    const { work } = createRepo();
    git(work, ["branch", "collision"]);
    writeCommit(work, "tag-side.txt", "tag\n", "tag side");
    git(work, ["tag", "collision"]);
    assert.throws(
      () => renderChangeScope(["--base", "collision"], work),
      (err) => {
        assert.equal(err.message, "base ref collision is ambiguous");
        return true;
      },
    );
  });

  it("refuses --base blob-ref pointing at a blob", () => {
    const { work } = createRepo();
    const blob = git(work, ["hash-object", "-w", "initial.txt"]).trim();
    git(work, ["tag", "blob-ref", blob]);
    assert.throws(
      () => renderChangeScope(["--base", "blob-ref"], work),
      (err) => {
        assert.equal(err.message, "base ref blob-ref does not resolve to a commit");
        return true;
      },
    );
  });

  it("refuses --head missing", () => {
    const { work } = createRepo();
    assert.throws(
      () => renderChangeScope(["--base", "HEAD", "--head", "missing"], work),
      (err) => {
        assert.equal(err.message, "head ref missing does not resolve to a commit");
        return true;
      },
    );
  });

  it("emits deterministic JSON with sorted committed paths", () => {
    const { work } = createRepo();
    git(work, ["switch", "-c", "sorted"]);
    writeCommit(work, "zeta.txt", "z\n", "zeta");
    writeCommit(work, "alpha.txt", "a\n", "alpha");
    const first = renderChangeScope(["--base", "origin/master"], work);
    const second = renderChangeScope(["--base", "origin/master"], work);
    assert.equal(second, first);
    const report = JSON.parse(first);
    assert.equal(report.formatVersion, 1);
    assert.deepEqual(report.paths.committed, ["alpha.txt", "zeta.txt"]);
  });

  it("does not run a configured core.fsmonitor", () => {
    const { work } = createRepo();
    const sideEffect = path.join(work, "fsmonitor-ran");
    const hook = path.join(work, "fake-fsmonitor.sh");
    fs.writeFileSync(hook, `#!/bin/sh\ntouch "${sideEffect}"\n`);
    fs.chmodSync(hook, 0o755);
    git(work, ["config", "core.fsmonitor", hook]);
    renderChangeScope(["--base", "HEAD"], work);
    assert.equal(fs.existsSync(sideEffect), false);
  });

  it("preserves paths with spaces and a trailing space via NUL splitting", () => {
    const { work } = createRepo();
    fs.writeFileSync(path.join(work, "has space.txt"), "x\n");
    fs.writeFileSync(path.join(work, "trailing "), "x\n");
    const { report } = parseScope(["--base", "HEAD"], work);
    assert.deepEqual(report.paths.untracked, ["has space.txt", "trailing "]);
  });

  it("rejects a non-UTF-8 path in the index", () => {
    const { work } = createRepo();
    const badName = Buffer.from([0xff, 0xfe]);
    fs.writeFileSync(Buffer.concat([Buffer.from(`${work}/`, "utf8"), badName]), "x\n");
    const add = spawnSync("git", ["-C", work, "add", "-A"], {
      encoding: "buffer",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LANG: "C", LC_ALL: "C" },
    });
    assert.equal(add.status, 0, decodeLoose(add.stderr));
    assert.throws(
      () => renderChangeScope(["--base", "HEAD"], work),
      (err) => {
        assert.equal(
          err.message,
          "cannot inspect staged paths: Git path 1 is not valid UTF-8",
        );
        return true;
      },
    );
  });
});

function decodeLoose(buf) {
  if (!buf || buf.length === 0) return "";
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}
