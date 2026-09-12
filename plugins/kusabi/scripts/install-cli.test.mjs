import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import {
  ensureSymlink,
  formatSymlinkLine,
} from "./install-cli.mjs";

// ensureSymlink: no dangling links, atomic replacement (kusabi #256)
// ---------------------------------------------------------------------------
// A link to a source that does not exist resolves to nothing for Cursor while
// the install output says `created` — a broken checkout reported as success.
// And rm-then-symlink leaves the path absent in between, so a crash in that
// window destroys a stale-but-working link.

describe("ensureSymlink (kusabi #256)", () => {
  const INSTALL_CLI_MODULE = path.join(import.meta.dirname, "install-cli.mjs");
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-symlink-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("refuses a missing source: no link, distinct state, visible line", () => {
    const source = path.join(tmp, "plugin", "skills", "delegate");
    const link = path.join(tmp, "cursor", "skills", "delegate");
    const res = ensureSymlink(source, link);
    assert.equal(res.state, "missing");
    assert.equal(res.target, source);
    assert.equal(res.linkPath, link);
    assert.ok(!fs.existsSync(link), "no dangling link may be created");
    assert.ok(!fs.existsSync(path.dirname(link)), "not even the parent directory");
    assert.match(formatSymlinkLine(res), /^error: /);
    assert.ok(formatSymlinkLine(res).includes(source), formatSymlinkLine(res));
  });

  it("refuses a missing source even when a link is already there", () => {
    const source = path.join(tmp, "gone");
    const link = path.join(tmp, "link");
    fs.mkdirSync(path.join(tmp, "elsewhere"));
    fs.symlinkSync(path.join(tmp, "elsewhere"), link);
    assert.equal(ensureSymlink(source, link).state, "missing");
    // The existing link is left exactly as it was rather than destroyed.
    assert.equal(fs.readlinkSync(link), path.join(tmp, "elsewhere"));
  });

  it("creates a link to an existing source", () => {
    const source = path.join(tmp, "skills", "delegate");
    fs.mkdirSync(source, { recursive: true });
    const link = path.join(tmp, "cursor", "skills", "delegate");
    assert.equal(ensureSymlink(source, link).state, "created");
    assert.equal(fs.realpathSync(link), fs.realpathSync(source));
  });

  it("replaces a link pointing elsewhere and leaves no staging file behind", () => {
    const source = path.join(tmp, "skills", "delegate");
    const other = path.join(tmp, "elsewhere");
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    const linkDir = path.join(tmp, "cursor", "skills");
    fs.mkdirSync(linkDir, { recursive: true });
    const link = path.join(linkDir, "delegate");
    fs.symlinkSync(other, link);

    const res = ensureSymlink(source, link);
    assert.equal(res.state, "updated");
    assert.equal(res.previous, other);
    assert.equal(fs.realpathSync(link), fs.realpathSync(source));
    // The temp-name scheme must not leak: the directory holds the link alone.
    assert.deepEqual(fs.readdirSync(linkDir), ["delegate"]);
  });

  it("sweeps a stale staging entry from a crashed run before replacing (kusabi #258)", () => {
    const source = path.join(tmp, "skills", "delegate");
    const other = path.join(tmp, "elsewhere");
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    const linkDir = path.join(tmp, "cursor", "skills");
    fs.mkdirSync(linkDir, { recursive: true });
    const link = path.join(linkDir, "delegate");
    fs.symlinkSync(other, link);
    // Residue from a crashed previous run: a staging symlink left under a
    // pid that is provably dead — a short-lived child, already exited and
    // reaped by spawnSync.  The replace must sweep it regardless of pid.
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    const stale = path.join(linkDir, `delegate.kusabi-tmp-${deadPid}`);
    fs.symlinkSync(other, stale);

    const res = ensureSymlink(source, link);
    assert.equal(res.state, "updated");
    assert.equal(fs.realpathSync(link), fs.realpathSync(source));
    assert.ok(!fs.existsSync(stale), "stale staging entry must be swept");
    assert.deepEqual(fs.readdirSync(linkDir), ["delegate"]);
  });

  it("sweeps a stale staging entry when the link is already current (kusabi #258)", () => {
    const source = path.join(tmp, "skills", "delegate");
    fs.mkdirSync(source, { recursive: true });
    const linkDir = path.join(tmp, "cursor", "skills");
    fs.mkdirSync(linkDir, { recursive: true });
    const link = path.join(linkDir, "delegate");
    fs.symlinkSync(source, link);
    // Residue from a crashed replace beside a link that already points at the
    // right target: the current branch must still sweep it, or it would
    // survive forever (no replace ever happens again to clean it up).
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    const stale = path.join(linkDir, `delegate.kusabi-tmp-${deadPid}`);
    fs.symlinkSync(source, stale);

    const res = ensureSymlink(source, link);
    assert.equal(res.state, "current");
    assert.equal(fs.realpathSync(link), fs.realpathSync(source));
    assert.ok(!fs.existsSync(stale), "stale staging entry must be swept on the current branch");
    assert.deepEqual(fs.readdirSync(linkDir), ["delegate"]);
  });

  it("sweeps a stale staging entry when no link exists yet (kusabi #258)", () => {
    const source = path.join(tmp, "skills", "delegate");
    const other = path.join(tmp, "elsewhere");
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    const linkDir = path.join(tmp, "cursor", "skills");
    fs.mkdirSync(linkDir, { recursive: true });
    const link = path.join(linkDir, "delegate");
    // No link at all — e.g. the old one was removed after the crash — so this
    // run takes the create branch: it must still sweep the crashed run's
    // residue rather than leave it next to the freshly created link.
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    const stale = path.join(linkDir, `delegate.kusabi-tmp-${deadPid}`);
    fs.symlinkSync(other, stale);

    const res = ensureSymlink(source, link);
    assert.equal(res.state, "created");
    assert.equal(fs.realpathSync(link), fs.realpathSync(source));
    assert.ok(!fs.existsSync(stale), "stale staging entry must be swept on the create branch");
    assert.deepEqual(fs.readdirSync(linkDir), ["delegate"]);
  });

  it("leaves a stale staging entry for a different link name alone (kusabi #258)", () => {
    const source = path.join(tmp, "skills", "delegate");
    const other = path.join(tmp, "elsewhere");
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    const linkDir = path.join(tmp, "cursor", "skills");
    fs.mkdirSync(linkDir, { recursive: true });
    const link = path.join(linkDir, "delegate");
    fs.symlinkSync(other, link);
    // A stale entry belonging to a DIFFERENT link name in the same directory:
    // the sweep is per-link-name, so this one must survive untouched — even
    // with a provably dead pid of its own.
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    const foreignStale = path.join(linkDir, `result-handling.kusabi-tmp-${deadPid}`);
    fs.symlinkSync(other, foreignStale);

    const res = ensureSymlink(source, link);
    assert.equal(res.state, "updated");
    assert.equal(fs.realpathSync(link), fs.realpathSync(source));
    assert.ok(fs.existsSync(foreignStale), "another link's stale entry must survive");
  });

  it("leaves a live run's staging entry alone (kusabi #258)", () => {
    const source = path.join(tmp, "skills", "delegate");
    fs.mkdirSync(source, { recursive: true });
    const linkDir = path.join(tmp, "cursor", "skills");
    fs.mkdirSync(linkDir, { recursive: true });
    const link = path.join(linkDir, "delegate");
    fs.symlinkSync(source, link);
    // A concurrent run's in-flight staging: its owning pid is alive, so the
    // sweep's liveness probe must not mistake it for residue and delete it
    // between that run's symlinkSync and renameSync (deleting it would make
    // the other run's rename throw ENOENT).  The test's own pid is always
    // alive while the test runs.  (Planted on the current branch: on the
    // replace branch the name would collide with the staging entry
    // ensureSymlink itself creates under process.pid.)
    const liveStaging = path.join(linkDir, `delegate.kusabi-tmp-${process.pid}`);
    fs.symlinkSync(source, liveStaging);

    const res = ensureSymlink(source, link);
    assert.equal(res.state, "current");
    assert.equal(fs.realpathSync(link), fs.realpathSync(source));
    assert.ok(fs.existsSync(liveStaging), "a live run's staging entry must survive the sweep");
  });

  it("leaves an entry whose suffix is not a pid alone (kusabi #258)", () => {
    const source = path.join(tmp, "skills", "delegate");
    const other = path.join(tmp, "elsewhere");
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    const linkDir = path.join(tmp, "cursor", "skills");
    fs.mkdirSync(linkDir, { recursive: true });
    const link = path.join(linkDir, "delegate");
    fs.symlinkSync(other, link);
    // Not our pid scheme (no trailing number): could be another tool's file,
    // so the sweep must not guess — only provably-dead pids are swept.
    const foreign = path.join(linkDir, "delegate.kusabi-tmp-manual");
    fs.symlinkSync(other, foreign);

    const res = ensureSymlink(source, link);
    assert.equal(res.state, "updated");
    assert.equal(fs.realpathSync(link), fs.realpathSync(source));
    assert.ok(fs.existsSync(foreign), "non-pid-suffixed entry must be left alone");
  });

  it("still reports current / conflict as before", () => {
    const source = path.join(tmp, "skills", "delegate");
    fs.mkdirSync(source, { recursive: true });
    const link = path.join(tmp, "link");
    fs.symlinkSync(source, link);
    assert.equal(ensureSymlink(source, link).state, "current");

    const real = path.join(tmp, "real");
    fs.mkdirSync(real);
    assert.equal(ensureSymlink(source, real).state, "conflict");
    assert.ok(fs.lstatSync(real).isDirectory());
  });

  it("never removes the link before its replacement exists", () => {
    // Atomicity is a property of the replace path, not of an observable
    // moment in a single-threaded test: pin it structurally.
    const src = fs.readFileSync(INSTALL_CLI_MODULE, "utf8");
    const start = src.indexOf("export function ensureSymlink(");
    const end = src.indexOf("export function formatSymlinkLine(");
    assert.ok(start >= 0 && end > start, "could not slice ensureSymlink");
    const body = src.slice(start, end);
    assert.match(body, /renameSync\(/, "the replace path must rename over the old link");
    assert.doesNotMatch(body, /rmSync\(linkPath/, "the old link must never be removed first");
  });
});

// install-cli: Codex user-level skill discovery (kusabi #477)
// ---------------------------------------------------------------------------
// Codex finds user skills at <codexDir>/skills/<name>/SKILL.md, mirroring
// Cursor.  Tests point HOME at a temp dir so ~/.codex is absent by default;
// KUSABI_CODEX_DIR overrides the target.

describe("install-cli codex skill wiring", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");
  const PLUGIN_DIR = path.dirname(import.meta.dirname);
  const SKILLS = ["delegate", "kusabi-result-handling"];
  let tmpHome;
  let binDir;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-install-codex-home-"));
    binDir = path.join(tmpHome, "bin");
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function run(args = [], extraEnv = {}) {
    const env = {
      ...process.env,
      HOME: tmpHome,
      KUSABI_BIN_DIR: binDir,
      OPENCODE_BIN: "/nonexistent-opencode-bin",
      ...extraEnv,
    };
    for (const key of Object.keys(extraEnv)) {
      if (extraEnv[key] === undefined) delete env[key];
    }
    return spawnSync(process.execPath, [COMPANION_SCRIPT, "install-cli", ...args], {
      encoding: "utf8",
      env,
      timeout: 10_000,
    });
  }

  const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const skillSrc = (name) => path.join(PLUGIN_DIR, "skills", name);

  it("skips with one informational line when there is no codex directory", () => {
    const result = run([], { KUSABI_CODEX_DIR: undefined });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const skips = result.stdout.split("\n").filter((l) => l.startsWith("codex skills: skipped"));
    assert.equal(skips.length, 1, result.stdout);
    assert.ok(skips[0].includes(path.join(tmpHome, ".codex")), skips[0]);
    assert.ok(!fs.existsSync(path.join(tmpHome, ".codex")), "skip must not create ~/.codex");
    assert.doesNotMatch(result.stdout, /^(error|conflict):/m);
  });

  it("creates both skill symlinks under a temp KUSABI_CODEX_DIR", () => {
    const codexDir = path.join(tmpHome, "codex");
    const result = run([], { KUSABI_CODEX_DIR: codexDir });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    for (const name of SKILLS) {
      const link = path.join(codexDir, "skills", name);
      assert.ok(fs.lstatSync(link).isSymbolicLink(), `${link} is not a symlink`);
      assert.equal(fs.realpathSync(link), fs.realpathSync(skillSrc(name)));
      assert.ok(fs.existsSync(path.join(link, "SKILL.md")), `${link}/SKILL.md not reachable`);
      assert.match(result.stdout, new RegExp(`^created: ${rx(link)} -> ${rx(skillSrc(name))}$`, "m"));
    }
  });

  it("reports current and changes nothing on a re-run (idempotent)", () => {
    const codexDir = path.join(tmpHome, "codex");
    assert.equal(run([], { KUSABI_CODEX_DIR: codexDir }).status, 0);
    const before = SKILLS.map((name) => fs.readlinkSync(path.join(codexDir, "skills", name)));
    const second = run([], { KUSABI_CODEX_DIR: codexDir });
    assert.equal(second.status, 0, second.stderr + second.stdout);
    SKILLS.forEach((name, i) => {
      assert.match(second.stdout, new RegExp(`^current: ${rx(path.join(codexDir, "skills", name))} -> `, "m"));
      assert.equal(fs.readlinkSync(path.join(codexDir, "skills", name)), before[i]);
    });
    assert.doesNotMatch(second.stdout, /^(created|updated|conflict|error):/m);
  });

  it("leaves a real directory at the target untouched and reports conflict", () => {
    const codexDir = path.join(tmpHome, "codex");
    const link = path.join(codexDir, "skills", "delegate");
    fs.mkdirSync(link, { recursive: true });
    fs.writeFileSync(path.join(link, "SKILL.md"), "mine\n");
    const result = run([], { KUSABI_CODEX_DIR: codexDir });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, new RegExp(`^conflict: ${rx(link)} `, "m"));
    assert.ok(!fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(link, "SKILL.md"), "utf8"), "mine\n");
    // The conflict does not stop the other artifact.
    assert.match(result.stdout, new RegExp(`^created: ${rx(path.join(codexDir, "skills", "kusabi-result-handling"))} -> `, "m"));
  });

  it("wires ~/.codex when it exists and KUSABI_CODEX_DIR is unset", () => {
    const homeCodex = path.join(tmpHome, ".codex");
    fs.mkdirSync(homeCodex, { recursive: true });
    const result = run([], { KUSABI_CODEX_DIR: undefined });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    for (const name of SKILLS) {
      const link = path.join(homeCodex, "skills", name);
      assert.equal(fs.realpathSync(link), fs.realpathSync(skillSrc(name)));
      assert.match(result.stdout, new RegExp(`^created: ${rx(link)} -> `, "m"));
    }
  });

  it("wires KUSABI_CODEX_DIR (creating it) and leaves HOME untouched", () => {
    const codexDir = path.join(tmpHome, "codex");
    const result = run([], { KUSABI_CODEX_DIR: codexDir });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.ok(fs.lstatSync(path.join(codexDir, "skills", "delegate")).isSymbolicLink());
    assert.ok(!fs.existsSync(path.join(tmpHome, ".codex")), "HOME must not be touched");
  });
});
// install-cli: Codex plugin link for kusabi-codex-notify (kusabi #491)
// ---------------------------------------------------------------------------
// install-cli symlinks <codexDir>/plugins/kusabi-codex-notify to THIS
// checkout's plugins/kusabi-codex-notify so Codex loads the plugin from the
// kusabi repository (source of truth) instead of kairanban.  The same
// no-clobber / atomic-symlink discipline as the skills applies: a real user
// file or directory at the destination is a conflict and is never deleted,
// and the old kairanban symlink is atomically replaced.

describe("install-cli codex plugin link", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");
  const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
  const NOTIFY_SOURCE = path.join(REPO_ROOT, "plugins", "kusabi-codex-notify");
  let tmpHome;
  let binDir;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-install-plugin-home-"));
    binDir = path.join(tmpHome, "bin");
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function run(args = [], extraEnv = {}) {
    const env = {
      ...process.env,
      HOME: tmpHome,
      KUSABI_BIN_DIR: binDir,
      OPENCODE_BIN: "/nonexistent-opencode-bin",
      ...extraEnv,
    };
    for (const key of Object.keys(extraEnv)) {
      if (extraEnv[key] === undefined) delete env[key];
    }
    return spawnSync(process.execPath, [COMPANION_SCRIPT, "install-cli", ...args], {
      encoding: "utf8",
      env,
      timeout: 10_000,
    });
  }

  it("skips with one informational line when there is no codex plugins directory", () => {
    const result = run([], { KUSABI_CODEX_PLUGINS_DIR: undefined });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const skips = result.stdout.split("\n").filter((l) => l.startsWith("codex plugin: skipped"));
    assert.equal(skips.length, 1, result.stdout);
    assert.ok(skips[0].includes(path.join(tmpHome, ".codex", "plugins")), skips[0]);
    assert.ok(!fs.existsSync(path.join(tmpHome, ".codex")), "skip must not create ~/.codex");
  });

  it("creates the plugin symlink under a temp KUSABI_CODEX_PLUGINS_DIR pointing at this checkout", () => {
    const pluginsDir = path.join(tmpHome, "codex-plugins");
    const result = run([], { KUSABI_CODEX_PLUGINS_DIR: pluginsDir });
    assert.equal(result.status, 0, result.stderr + result.stdout);

    const link = path.join(pluginsDir, "kusabi-codex-notify");
    assert.ok(fs.lstatSync(link).isSymbolicLink(), `${link} is not a symlink`);
    assert.equal(fs.realpathSync(link), fs.realpathSync(NOTIFY_SOURCE));
    // The manifest the plugin validator checks is reachable through the link.
    assert.ok(fs.existsSync(path.join(link, ".codex-plugin", "plugin.json")), "plugin.json not reachable");
    assert.match(result.stdout, new RegExp(`^created: ${link.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} -> `, "m"));
  });

  it("reports current and changes nothing on a re-run (idempotent)", () => {
    const pluginsDir = path.join(tmpHome, "codex-plugins");
    assert.equal(run([], { KUSABI_CODEX_PLUGINS_DIR: pluginsDir }).status, 0);
    const before = fs.readlinkSync(path.join(pluginsDir, "kusabi-codex-notify"));
    const second = run([], { KUSABI_CODEX_PLUGINS_DIR: pluginsDir });
    assert.equal(second.status, 0, second.stderr + second.stdout);
    const link = path.join(pluginsDir, "kusabi-codex-notify");
    assert.match(second.stdout, new RegExp(`^current: ${link.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} -> `, "m"));
    assert.equal(fs.readlinkSync(link), before);
    assert.doesNotMatch(second.stdout, /^(created|updated|conflict|error):/m);
  });

  it("atomically replaces the old kairanban symlink (updated, previous recorded)", () => {
    const pluginsDir = path.join(tmpHome, "codex-plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });
    const link = path.join(pluginsDir, "kusabi-codex-notify");
    const kairanbanTarget = path.join(tmpHome, "agents", "codex-local", "plugins", "kusabi-codex-notify");
    fs.mkdirSync(path.join(kairanbanTarget, ".codex-plugin"), { recursive: true });
    fs.writeFileSync(path.join(kairanbanTarget, ".codex-plugin", "plugin.json"), "{}");
    fs.symlinkSync(kairanbanTarget, link);

    const result = run([], { KUSABI_CODEX_PLUGINS_DIR: pluginsDir });
    assert.equal(result.status, 0, result.stderr + result.stdout);

    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.realpathSync(link), fs.realpathSync(NOTIFY_SOURCE));
    assert.match(result.stdout, new RegExp(`^updated: ${link.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} -> ${NOTIFY_SOURCE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(was ${kairanbanTarget.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`, "m"));
    // The old kairanban checkout is left untouched.
    assert.ok(fs.existsSync(path.join(kairanbanTarget, ".codex-plugin", "plugin.json")));
  });

  it("leaves a real user directory at the destination untouched and reports conflict", () => {
    const pluginsDir = path.join(tmpHome, "codex-plugins");
    const link = path.join(pluginsDir, "kusabi-codex-notify");
    fs.mkdirSync(link, { recursive: true });
    fs.writeFileSync(path.join(link, "my-notes.txt"), "mine\n");

    const result = run([], { KUSABI_CODEX_PLUGINS_DIR: pluginsDir });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, new RegExp(`^conflict: ${link.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `, "m"));
    assert.ok(!fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(link, "my-notes.txt"), "utf8"), "mine\n");
  });

  it("wires ~/.codex/plugins when it exists and KUSABI_CODEX_PLUGINS_DIR is unset", () => {
    const homeCodex = path.join(tmpHome, ".codex");
    fs.mkdirSync(path.join(homeCodex, "plugins"), { recursive: true });
    const result = run([], { KUSABI_CODEX_PLUGINS_DIR: undefined });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const link = path.join(homeCodex, "plugins", "kusabi-codex-notify");
    assert.equal(fs.realpathSync(link), fs.realpathSync(NOTIFY_SOURCE));
    assert.match(result.stdout, new RegExp(`^created: ${link.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} -> `, "m"));
  });
});
