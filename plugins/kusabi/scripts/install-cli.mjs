// install-cli: the `kusabi-companion install-cli` surface.
//
// Writes the PATH-independent companion shim and wires Cursor's user-level
// skill/rule discovery paths to the plugin's own artifacts.  Extracted from
// kusabi-companion.mjs unchanged (kusabi #264): same output strings, same
// exit codes.
//
// The companion script's own path is threaded in as `selfPath` rather than
// derived from this module's `import.meta.url`.  Node resolves an imported
// module through realpath, so in a checkout whose sibling modules are
// symlinks into another tree this module would report that tree's plugin
// root instead of its own.  The companion is the process entry point, so its
// `import.meta.url` is the only trustworthy answer.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const SHIM_NAME = "kusabi-companion";

function companionBinDir() {
  return process.env.KUSABI_BIN_DIR || path.join(os.homedir(), ".local", "bin");
}

function companionShimPath(binDir = companionBinDir()) {
  return path.join(binDir, SHIM_NAME);
}

function renderCompanionShim(targetPath) {
  return `#!/bin/sh\nexec node ${JSON.stringify(targetPath)} "$@"\n`;
}

function parseShimExecTarget(content) {
  const m = String(content).match(/^\s*exec\s+node\s+"([^"]+)"\s+"\$@"\s*$/m);
  return m ? m[1] : null;
}

export function diagnoseCompanionShim({ binDir, selfPath } = {}) {
  const dir = binDir ?? companionBinDir();
  const shim = companionShimPath(dir);
  const expected = selfPath;
  if (!fs.existsSync(shim)) {
    return { state: "missing", shim, expected, target: null };
  }
  let content = "";
  try {
    content = fs.readFileSync(shim, "utf8");
  } catch {
    return { state: "stale", shim, expected, target: null };
  }
  const target = parseShimExecTarget(content);
  if (target === expected) {
    return { state: "ok", shim, expected, target };
  }
  return { state: "stale", shim, expected, target };
}

export function formatShimSetupLine(diag) {
  if (diag.state === "ok") {
    return `companion shim: ok (${diag.shim})`;
  }
  if (diag.state === "stale") {
    const pointed = diag.target ? `points at ${diag.target}` : "does not point at this CLI";
    return `companion shim: stale (${pointed}); run \`kusabi-companion install-cli\``;
  }
  return `companion shim: missing; run \`kusabi-companion install-cli\``;
}

function pathHasDir(dir) {
  const resolved = path.resolve(dir);
  return (process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((entry) => {
      try {
        return path.resolve(entry) === resolved;
      } catch {
        return false;
      }
    });
}

// Cursor discovers user-level skills at <cursorDir>/skills/<name>/SKILL.md and
// alwaysApply rules at <cursorDir>/rules/*.mdc (kusabi #247).  `--plugin-dir`
// covers a working copy under development; a default `cursor-agent` launch and
// the IDE chat see neither, so install-cli symlinks the two orchestrator-facing
// skills into the user directory.  Symlinks, not copies: a plugin update then
// reaches Cursor without a reinstall.
const CURSOR_SKILL_NAMES = ["delegate", "kusabi-result-handling"];
const CURSOR_RULE_FILE = "kusabi-delegate.mdc";

/** The plugin root (`plugins/kusabi`), resolved from the companion script, never cwd. */
function pluginRootDir(selfPath) {
  return path.dirname(path.dirname(selfPath));
}

function cursorUserDir() {
  return process.env.KUSABI_CURSOR_DIR || path.join(os.homedir(), ".cursor");
}

/**
 * Make `linkPath` a symlink to `target`, without ever clobbering user content.
 *
 * A real file or directory at linkPath is left alone and reported as
 * `conflict` — staying stale is strictly better than deleting something the
 * user put there.  Existing symlinks are compared by RESOLVED target, so a
 * relative and an absolute spelling of the same destination count as
 * `current`.
 *
 * A missing SOURCE is reported as `missing` and nothing is created: a link
 * to a path that does not exist resolves to nothing for Cursor while the
 * install output claims `created`, so a broken plugin checkout would be
 * reported as a success (kusabi #256).
 *
 * @param {string} target
 * @param {string} linkPath
 * @returns {{state: "created"|"current"|"updated"|"conflict"|"missing"|"error", target: string, linkPath: string, previous: string|null, error?: string}}
 */
/**
 * Remove stale staging symlinks from a crashed previous run (kusabi #258).
 *
 * A crash between symlink and rename leaves `<name>.kusabi-tmp-<pid>` behind
 * under whatever pid that run had.  Only entries whose owning pid is provably
 * dead are removed (a `process.kill(pid, 0)` liveness probe): a concurrent
 * install-cli run's in-flight staging has a live pid and is left alone, so
 * overlapping runs stay last-writer-wins instead of one deleting the other's
 * staging between its symlinkSync and renameSync.  Entries whose suffix is
 * not a pid (someone else's file) are likewise left alone.  Best-effort by
 * design: a sweep failure on one entry must not break the link operation
 * itself — the error-state path in ensureSymlink still covers real failures
 * of the operation.  ensureSymlink calls this once for every link that
 * passes its missing-source check, whichever branch it then takes (create,
 * replace, current, conflict), so residue from a crashed replace cannot
 * survive just because a later run found the link already current.  Only
 * entries prefixed with this link's own basename are touched, so a stale
 * staging entry for an unrelated link in the same directory is left alone.
 */
function sweepStaleStaging(linkPath) {
  const dir = path.dirname(linkPath);
  const prefix = `${path.basename(linkPath)}.kusabi-tmp-`;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return; // directory unreadable or gone: nothing to sweep, nothing to do
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const pid = Number(entry.slice(prefix.length));
    if (!Number.isInteger(pid) || pid <= 0) continue; // not our pid scheme: leave alone
    try {
      process.kill(pid, 0);
      continue; // the pid is alive: a concurrent run's in-flight staging, leave it
    } catch (err) {
      if (err.code === "EPERM") continue; // exists but owned by another user: leave it
      // ESRCH: no such process — residue from a crashed run, sweep it.
    }
    try {
      fs.rmSync(path.join(dir, entry), { force: true });
    } catch { /* best-effort: keep replacing */ }
  }
}

export function ensureSymlink(target, linkPath) {
  // Checked before linkPath is even inspected: with no source there is
  // nothing worth linking to, whatever is (or is not) at linkPath.
  if (!fs.existsSync(target)) {
    return { state: "missing", target, linkPath, previous: null };
  }

  // Sweep residue from a crashed previous run (dead pids only, best-effort)
  // on every branch past the missing-source check — create, replace, current,
  // and conflict alike — so it cannot survive just because this run found the
  // link already current (or found nothing at all) (kusabi #258).
  sweepStaleStaging(linkPath);

  let stat = null;
  try {
    stat = fs.lstatSync(linkPath);
  } catch { /* missing */ }

  if (stat && !stat.isSymbolicLink()) {
    return { state: "conflict", target, linkPath, previous: null };
  }

  let previous = null;
  if (stat) {
    try {
      const raw = fs.readlinkSync(linkPath);
      previous = path.resolve(path.dirname(linkPath), raw);
    } catch { /* unreadable link: treat as pointing nowhere and replace */ }
    if (previous === path.resolve(target)) {
      return { state: "current", target, linkPath, previous };
    }
  }

  try {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    if (stat) {
      // Atomic replace (kusabi #256): symlink under a temp name, then rename
      // over the old link.  rm-then-create leaves the path absent in
      // between, and a failure in that window leaves nothing at all where a
      // stale-but-working link used to be.  renameSync over an existing
      // entry is a single atomic step.
      const staging = `${linkPath}.kusabi-tmp-${process.pid}`;
      fs.rmSync(staging, { force: true });
      try {
        fs.symlinkSync(target, staging);
        fs.renameSync(staging, linkPath);
      } catch (err) {
        fs.rmSync(staging, { force: true });
        throw err;
      }
    } else {
      fs.symlinkSync(target, linkPath);
    }
  } catch (err) {
    return { state: "error", target, linkPath, previous, error: err.message };
  }
  return { state: stat ? "updated" : "created", target, linkPath, previous };
}

export function formatSymlinkLine(res) {
  switch (res.state) {
    case "conflict":
      return `conflict: ${res.linkPath} exists and is not a symlink; left untouched (expected a link to ${res.target})`;
    case "missing":
      return `error: ${res.linkPath}: symlink source does not exist: ${res.target} (nothing created)`;
    case "error":
      return `error: ${res.linkPath}: ${res.error}`;
    case "updated":
      return `updated: ${res.linkPath} -> ${res.target} (was ${res.previous ?? "an unreadable link"})`;
    default:
      return `${res.state}: ${res.linkPath} -> ${res.target}`;
  }
}

/**
 * Wire Cursor's user-level discovery paths to the plugin's own skills.
 *
 * A machine with no `~/.cursor` simply has no Cursor: that is information,
 * not a warning, and nothing is created there.  An explicit
 * KUSABI_CURSOR_DIR is a request, so that directory IS created.  Per-artifact
 * failures are reported and the rest continues — install-cli's primary job
 * (the shim) has already succeeded by the time this runs.
 *
 * @param {{ rule?: boolean, selfPath?: string }} [opts]
 * @returns {{lines: string[], failed: boolean}} One line per artifact (or one
 *   skip line); `failed` when any artifact rendered an `error:` line.
 */
function wireCursorSkills({ rule = false, selfPath } = {}) {
  const explicit = Boolean(process.env.KUSABI_CURSOR_DIR);
  const cursorDir = cursorUserDir();
  if (!explicit && !fs.existsSync(cursorDir)) {
    return {
      lines: [`cursor skills: skipped (${cursorDir} not found — no Cursor user directory on this machine)`],
      failed: false,
    };
  }
  const pluginDir = pluginRootDir(selfPath);
  const results = CURSOR_SKILL_NAMES.map((name) => ensureSymlink(
    path.join(pluginDir, "skills", name),
    path.join(cursorDir, "skills", name),
  ));
  if (rule) {
    results.push(ensureSymlink(
      path.join(pluginDir, "rules", CURSOR_RULE_FILE),
      path.join(cursorDir, "rules", CURSOR_RULE_FILE),
    ));
  }
  return {
    lines: results.map(formatSymlinkLine),
    // Any rendered `error:` line — a missing source (broken checkout) or a
    // destination-side failure — decides the exit code (kusabi #256, #258):
    // when install-cli's output reports an error, the caller must not read
    // success from `$?`.  The shim itself, install-cli's primary job, is
    // already written by the time we get here, but the wiring is still
    // incomplete, so the exit code follows the output.
    failed: results.some((r) => r.state === "missing" || r.state === "error"),
  };
}

export function cmdInstallCli({ flags, selfPath } = {}) {
  const binDir = companionBinDir();
  const shim = companionShimPath(binDir);
  const expected = renderCompanionShim(selfPath);
  fs.mkdirSync(binDir, { recursive: true });

  let status;
  if (fs.existsSync(shim)) {
    const current = fs.readFileSync(shim, "utf8");
    if (current === expected) {
      status = "current";
    } else {
      fs.writeFileSync(shim, expected, { encoding: "utf8" });
      fs.chmodSync(shim, 0o755);
      status = "updated";
    }
  } else {
    fs.writeFileSync(shim, expected, { encoding: "utf8", mode: 0o755 });
    fs.chmodSync(shim, 0o755);
    status = "created";
  }

  const lines = [`${status}: ${shim}`];
  if (!pathHasDir(binDir)) {
    lines.push(`warning: ${binDir} is not on PATH; add it so \`${SHIM_NAME}\` can be found`);
  }
  const cursor = wireCursorSkills({ rule: Boolean(flags?.cursorRule), selfPath });
  lines.push(...cursor.lines);
  const text = lines.join("\n");
  // Any rendered `error:` line means the wiring is incomplete; reporting it
  // on stdout and still exiting 0 would let a broken install read as a
  // successful one (kusabi #256, #258).
  return cursor.failed ? { text, exitCode: 1 } : text;
}
