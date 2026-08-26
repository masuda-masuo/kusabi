// change-scope.mjs — emit versioned JSON for a verified git change range.
//
// Reviewers currently guess the review range.  Given a verified `--base`
// and `--head`, this script resolves SHAs and four path buckets so a later
// job can inject the JSON mechanically.  It does not mutate the repository.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FORMAT_VERSION = 1;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const SHA1 = /^[0-9a-f]{40}$/;
const DIFF_FLAGS = [
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--no-renames",
  "--ignore-submodules=none",
  "--name-only",
  "-z",
];

const GIT_ENV_OVERRIDES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
];

function gitEnv() {
  const env = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    LANG: "C",
    LC_ALL: "C",
  };
  for (const key of GIT_ENV_OVERRIDES) delete env[key];
  return env;
}

function decodeUtf8Fatal(buf) {
  return new TextDecoder("utf-8", { fatal: true }).decode(buf);
}

function decodeUtf8Loose(buf) {
  if (!buf || buf.length === 0) return "";
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

function stripLineTerminator(text) {
  return text.replace(/(?:\r\n|\n|\r)$/, "");
}

function runGit(dir, gitArgs) {
  const result = spawnSync(
    "git",
    ["-C", dir, "-c", "core.fsmonitor=false", ...gitArgs],
    {
      env: gitEnv(),
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      encoding: null,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) {
    throw new Error(`git failed to start: ${result.error.message}`);
  }
  return result;
}

function decodeStdout(result, context) {
  const buf = result.stdout ?? Buffer.alloc(0);
  try {
    return decodeUtf8Fatal(buf);
  } catch {
    throw new Error(`${context}: output is not valid UTF-8`);
  }
}

function parseArgs(args) {
  let base;
  let head;
  let haveBase = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--base") {
      const val = args[++i];
      if (val === undefined || val.startsWith("--")) {
        throw new Error("missing required --base <ref>");
      }
      base = val;
      haveBase = true;
    } else if (arg === "--head") {
      const val = args[++i];
      if (val === undefined || val.startsWith("--")) {
        throw new Error("missing --head <ref>");
      }
      head = val;
    } else if (typeof arg === "string" && arg.startsWith("--")) {
      throw new Error(`unknown flag: ${arg}`);
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  if (!haveBase) {
    throw new Error("missing required --base <ref>");
  }
  if (head === undefined) head = "HEAD";
  return { base, head };
}

function resolveRepositoryRoot(cwd) {
  const result = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.status !== 0) {
    const stderr = decodeUtf8Loose(result.stderr).trim();
    throw new Error(stderr || "cannot resolve repository root");
  }
  return stripLineTerminator(decodeStdout(result, "cannot resolve repository root"));
}

function resolveCommit(root, ref, label) {
  const result = runGit(root, [
    "-c",
    "core.warnAmbiguousRefs=true",
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref}^{commit}`,
  ]);
  const stderr = decodeUtf8Loose(result.stderr);
  if (/\bambiguous\b/i.test(stderr)) {
    throw new Error(`${label} ref ${ref} is ambiguous`);
  }
  if (result.status !== 0) {
    throw new Error(`${label} ref ${ref} does not resolve to a commit`);
  }
  const stdout = decodeStdout(result, `cannot resolve ${label} ref`);
  const lines = stripLineTerminator(stdout).split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1 || !SHA1.test(lines[0])) {
    throw new Error(`${label} ref ${ref} does not resolve to a commit`);
  }
  return lines[0];
}

function resolveMergeBase(root, baseSha, headSha) {
  const result = runGit(root, ["merge-base", "--all", baseSha, headSha]);
  if (result.status !== 0) {
    throw new Error(`cannot determine merge-base of ${baseSha} and ${headSha}`);
  }
  const stdout = decodeStdout(result, "cannot determine merge-base");
  const lines = stripLineTerminator(stdout).split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    throw new Error(`cannot determine merge-base of ${baseSha} and ${headSha}`);
  }
  if (lines.length !== 1 || !SHA1.test(lines[0])) {
    throw new Error(`base and head have ${lines.length} merge-bases; need exactly one`);
  }
  return lines[0];
}

function decodeNulPaths(buf, context) {
  const paths = [];
  let start = 0;
  let index = 0;
  for (let i = 0; i <= buf.length; i += 1) {
    if (i === buf.length || buf[i] === 0) {
      if (i > start) {
        index += 1;
        const slice = buf.subarray(start, i);
        try {
          paths.push(decodeUtf8Fatal(slice));
        } catch {
          throw new Error(
            `cannot inspect ${context} paths: Git path ${index} is not valid UTF-8`,
          );
        }
      }
      start = i + 1;
    }
  }
  return paths;
}

function uniqueSorted(paths) {
  return [...new Set(paths)].sort();
}

function listPaths(root, gitArgs, context) {
  const result = runGit(root, gitArgs);
  if (result.status !== 0) {
    const stderr = decodeUtf8Loose(result.stderr).trim();
    throw new Error(`cannot inspect ${context} paths${stderr ? `: ${stderr}` : ""}`);
  }
  const buf = result.stdout ?? Buffer.alloc(0);
  return uniqueSorted(decodeNulPaths(buf, context));
}

export function renderChangeScope(args, cwd) {
  const { base, head } = parseArgs(args);
  const repositoryRoot = resolveRepositoryRoot(cwd);
  const baseSha = resolveCommit(repositoryRoot, base, "base");
  const headSha = resolveCommit(repositoryRoot, head, "head");
  const mergeBaseSha = resolveMergeBase(repositoryRoot, baseSha, headSha);
  const committed = listPaths(
    repositoryRoot,
    [...DIFF_FLAGS, mergeBaseSha, headSha, "--"],
    "committed",
  );
  const staged = listPaths(
    repositoryRoot,
    [...DIFF_FLAGS, "--cached", "--"],
    "staged",
  );
  const unstaged = listPaths(
    repositoryRoot,
    [...DIFF_FLAGS, "--"],
    "unstaged",
  );
  const untracked = listPaths(
    repositoryRoot,
    ["ls-files", "--others", "--exclude-standard", "-z", "--"],
    "untracked",
  );
  const report = {
    formatVersion: FORMAT_VERSION,
    repositoryRoot,
    input: { base, head },
    resolved: {
      baseSha,
      headSha,
      mergeBaseSha,
    },
    paths: {
      committed,
      staged,
      unstaged,
      untracked,
    },
  };
  return `${JSON.stringify(report, null, 2)}\n`;
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    process.stdout.write(renderChangeScope(process.argv.slice(2), process.cwd()));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`change-scope: ${message}\n`);
    process.exitCode = 1;
  }
}
