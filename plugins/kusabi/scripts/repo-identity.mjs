import { execFileSync } from "node:child_process";

/**
 * Parse a supported git origin URL into its owner/repository identity.
 *
 * @param {string} url
 * @returns {string|null}
 */
export function parseOwnerRepo(url) {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  const match = trimmed.match(/^(?:https:\/\/[^/\s]+\/|git@[^:/\s]+:|ssh:\/\/git@[^/\s]+\/)([^/\s]+)\/([^/\s]+)$/);
  if (!match) return null;
  const repo = match[2].endsWith(".git") ? match[2].slice(0, -4) : match[2];
  if (!match[1] || match[1] === "." || match[1] === ".." || !repo || repo === "." || repo === "..") return null;
  return match[1] + "/" + repo;
}

function defaultRun(cwd) {
  return execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Read the repository identity from the workspace's origin remote.
 *
 * @param {string} cwd
 * @param {{run?: (cwd: string) => string}} [options]
 * @returns {{repo: string|null, repoReason: string|null}}
 */
export function readOriginRepo(cwd, { run = defaultRun } = {}) {
  try {
    const url = run(cwd);
    const repo = parseOwnerRepo(url);
    if (repo) return { repo, repoReason: null };
    return {
      repo: null,
      repoReason: typeof url === "string" && url.trim()
        ? "unrecognised remote url"
        : "no origin remote",
    };
  } catch {
    return {
      repo: null,
      repoReason: "git remote get-url failed",
    };
  }
}
