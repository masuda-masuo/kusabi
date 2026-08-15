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
