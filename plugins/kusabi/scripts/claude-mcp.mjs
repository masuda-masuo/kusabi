// claude-mcp.mjs — MCP configuration for the Claude Code CLI backend (kusabi #426).

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import process from "node:process";

import { writeJson } from "./state-paths.mjs";

// =========================================================================
// MCP config — sunaba + kaiba entries extracted from the host claude config
// =========================================================================

/**
 * Path of the source claude config the sunaba and kaiba MCP entries are
 * extracted from.  Overridable via KUSABI_CLAUDE_MCP_SOURCE (tests point it
 * at a fixture).
 *
 * @returns {string}
 */
export function claudeMcpSourcePath() {
  return process.env.KUSABI_CLAUDE_MCP_SOURCE || path.join(os.homedir(), ".claude.json");
}

/**
 * Read and parse the source claude config.  Shared by the sunaba and kaiba
 * extractors so both report the same unreadable/unparseable errors, naming
 * the source path and the env override.
 *
 * @param {string} sourcePath
 * @returns {object} The parsed config.
 * @throws {Error} When the file is unreadable or not valid JSON.
 */
function readClaudeMcpSource(sourcePath) {
  let raw;
  try {
    raw = fs.readFileSync(sourcePath, "utf8");
  } catch (err) {
    throw new Error(
      `claude backend: cannot read MCP source config ${sourcePath}: ${err.message} ` +
      "(set KUSABI_CLAUDE_MCP_SOURCE to override the source file)"
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`claude backend: MCP source config ${sourcePath} is not valid JSON: ${err.message}`);
  }
  return parsed;
}

/**
 * Extract the `mcpServers.sunaba` entry from a claude config file.
 *
 * @param {string} sourcePath
 * @returns {object} The sunaba server entry.
 * @throws {Error} When the file is unreadable/unparseable or the entry is
 *         missing — the error names the source path and the env override.
 */
export function extractSunabaMcp(sourcePath) {
  const sunaba = readClaudeMcpSource(sourcePath)?.mcpServers?.sunaba;
  if (!sunaba) {
    throw new Error(
      `claude backend: no mcpServers.sunaba entry in ${sourcePath} — ` +
      "the claude backend needs the sunaba MCP server to run worker tools " +
      "(set KUSABI_CLAUDE_MCP_SOURCE to point at a config that has it)"
    );
  }
  return sunaba;
}

/**
 * Extract the `mcpServers.kaiba` entry from a claude config file, or null
 * when the entry is absent.
 *
 * kaiba is an OPTIONAL aid (kusabi #279): a machine that has not configured
 * it must keep dispatching exactly as it does today — no kaiba in the
 * generated config and no error.  This is deliberately the opposite of
 * extractSunabaMcp's throw-on-missing: without sunaba a worker cannot do
 * its work at all; without kaiba it merely cannot reach the shared
 * conclusion store.
 *
 * What is NOT an absence (all config errors, thrown the same way
 * extractSunabaMcp's are): an unreadable or unparseable FILE (the same
 * reader, the same messages) and — since the kusabi #279 follow-up — a
 * present-but-malformed ENTRY.  A value that could not be a server entry
 * (a string, a number, an array, an object with none of the
 * server-launching fields) used to be written straight into the generated
 * config, where it failed at MCP connect inside the claude session — an
 * error that names neither kusabi nor this key.  Failing here instead, in
 * pre-flight, is what makes the operator error actionable: the message
 * names the key, says what was found, and tells the operator that removing
 * the key restores the previous behaviour.
 *
 * @param {string} sourcePath
 * @returns {object|null} The kaiba server entry, or null when absent.
 * @throws {Error} When the file is unreadable/unparseable (same errors as
 *         extractSunabaMcp) or the entry is present but cannot be a server
 *         entry.
 */
export function extractKaibaMcp(sourcePath) {
  const kaiba = readClaudeMcpSource(sourcePath)?.mcpServers?.kaiba;
  if (kaiba === undefined) return null;
  if (!isKaibaServerEntryShape(kaiba)) {
    throw new Error(
      `claude backend: mcpServers.kaiba in ${sourcePath} is ${describeKaibaEntry(kaiba)}, not a server entry — ` +
      "a malformed kaiba entry is a config error, not an absence: remove the mcpServers.kaiba key " +
      "from the config to restore the previous behaviour (set KUSABI_CLAUDE_MCP_SOURCE to override " +
      "the source file)"
    );
  }
  return kaiba;
}

/**
 * The fields that declare HOW a server launches in the claude config
 * formats kusabi writes: a stdio server starts from `command`, a remote
 * server from `url`.  `type` declares the transport KIND, not a launcher —
 * it only accompanies a launcher field, and an entry carrying it alone
 * could not start a server ({"type": "stdio"} launches nothing).  Every
 * other entry field (args, env, cwd, headers, type, ...) only accompanies
 * one of these — an object with none of them could not start a server even
 * if every field were well-formed, so it is malformed in the same sense as
 * a string entry.  What the launcher fields CONTAIN is deliberately not
 * checked (is the command on PATH, does the url answer): that is claude's
 * call at connect time, and guessing at it here would duplicate a check
 * kusabi cannot do correctly.
 */
const KAIBA_SERVER_LAUNCH_FIELDS = ["command", "url"];

function isKaibaServerEntryShape(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    KAIBA_SERVER_LAUNCH_FIELDS.some((field) => field in value)
  );
}

/**
 * What a rejected kaiba entry turned out to be, for the error message: a
 * string is "a string", a number "a number", an array "an array", null
 * "null" — and an object that reached the rejection is always one with
 * none of the server-launching fields.
 *
 * @param {*} value
 * @returns {string}
 */
function describeKaibaEntry(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") {
    return `an object with none of the server-launching fields (${KAIBA_SERVER_LAUNCH_FIELDS.join(", ")})`;
  }
  return `a ${typeof value}`;
}

/**
 * Force a kaiba MCP entry to file conclusions and write progress under the
 * kusabi worker identity and optional job id (kusabi #279, #391).
 *
 * The host entry is the OPERATOR's own registration — its own Claude Code
 * session files conclusions under `KAIBA_AGENT=claude`.  A dispatched
 * kusabi worker is not that session, and conclusions it writes must not be
 * attributed to it: authorship exists precisely to tell those apart.  The
 * entry a worker session receives therefore always carries
 * `KAIBA_AGENT=worker` — the name the opencode workers already use — no
 * matter what the source entry said.  Every other part of the entry
 * (command, args, the remaining env such as KAIBA_WORKSPACE) passes
 * through untouched.
 *
 * When `jobId` is a non-empty string matching `^[a-zA-Z0-9_-]+$`,
 * `env.KAIBA_JOB` is set to that string.  When `jobId` is omitted, null, or
 * `""`, `env.KAIBA_JOB` is not set.  When `jobId` is present but does not
 * match the pattern, this function throws, naming the value.
 *
 * The source entry is never mutated — the changed env comes back on a copy
 * (the same rule applySunabaProfile follows).  An absent entry stays
 * absent, and a non-object entry passes through unchanged (as a pure
 * function; the dispatch path never feeds it one — extractKaibaMcp rejects
 * anything that could not be a server entry before this transform runs).
 *
 * @param {object|null|undefined} kaibaEntry
 * @param {string|null|undefined} [jobId]
 * @returns {object|null|undefined} The entry to write, or null/undefined
 *         when there is none.
 */
export function applyWorkerKaibaIdentity(kaibaEntry, jobId) {
  if (!kaibaEntry || typeof kaibaEntry !== "object" || Array.isArray(kaibaEntry)) return kaibaEntry;
  let jobVal;
  if (jobId !== undefined && jobId !== null && jobId !== "") {
    if (typeof jobId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(jobId)) {
      throw new Error(`invalid KAIBA_JOB id: ${JSON.stringify(jobId)}`);
    }
    jobVal = jobId;
  }
  const srcEnv =
    kaibaEntry.env && typeof kaibaEntry.env === "object" && !Array.isArray(kaibaEntry.env)
      ? kaibaEntry.env
      : {};
  const env = { ...srcEnv, KAIBA_AGENT: "worker" };
  if (jobVal !== undefined) {
    env.KAIBA_JOB = jobVal;
  }
  return { ...kaibaEntry, env };
}

/**
 * Return the sunaba MCP entry to write, with `profile=<name>` appended to
 * its `url` so the server sends only that profile's tool definitions
 * (sunaba #782).  The source entry is never mutated — a changed URL comes
 * back on a copy.
 *
 * Pass-through, unchanged, when: no profile was resolved
 * (`sunabaProfileForAgent` returned null); the entry has no `url` (stdio
 * transport — profiles are an HTTP query feature); or the source URL
 * already names a profile (an explicit profile in the host config wins).
 * Any other existing query parameters survive.
 *
 * There is NO fallback: if the server rejects the profile (a server
 * predating sunaba #782, or a name it does not know) the worker session
 * fails loud at MCP connect and the job errors — deliberately the same
 * fail-loud posture sunaba itself chose, so a filtered session is never
 * silently downgraded to an unfiltered one (kusabi #274).
 *
 * @param {object} sunabaEntry
 * @param {string|null|undefined} profile
 * @returns {object} The entry to write.
 */
export function applySunabaProfile(sunabaEntry, profile) {
  if (!profile || !sunabaEntry || typeof sunabaEntry.url !== "string") return sunabaEntry;
  const url = new URL(sunabaEntry.url);
  if (url.searchParams.has("profile")) return sunabaEntry;
  url.searchParams.set("profile", profile);
  return { ...sunabaEntry, url: url.toString() };
}

/**
 * Write a generated MCP config containing ONLY the sunaba server entry —
 * plus the kaiba entry when one was configured — and return its path.  The
 * generated file is what `--mcp-config` points at, so the claude session
 * never sees the host config's other servers.
 *
 * kaiba (kusabi #279) is the OPTIONAL half of the pair: a null/absent
 * kaiba entry writes exactly the pre-kaiba config (`mcpServers` with the
 * sunaba entry alone) — a machine that has not configured kaiba dispatches
 * unchanged.  A present entry must already carry the worker identity
 * (applyWorkerKaibaIdentity), because the generated config is what the
 * worker session reads — this function writes what it is given.
 *
 * The file is per-dispatch, NOT per-cwd (kusabi #276): the caller passes the
 * owning job's directory, so each dispatch's config lives at a path only it
 * ever writes.  Two dispatches in the same cwd whose spawn windows overlap
 * (a chain and a stand-alone task, or two tasks) therefore each hand their
 * `claude` process the config their own pre-flight wrote — one dispatch's
 * `?profile=` can never overwrite another's before the child has read it.
 *
 * Cleanup rule — explicit lifetime (kusabi #276): the config's lifetime is
 * its job's.  It is written in pre-flight, before the job record exists (a
 * missing or malformed `mcpServers.sunaba` entry must stay a loud throw,
 * not a job that reaches `running`), but it lives inside the job's own
 * directory from the moment of writing.  Nothing removes it, because
 * nothing in kusabi removes job artifacts at all — a job directory is a
 * permanent record.  That is the whole cleanup rule: no two dispatches
 * share a path and no code deletes another job's directory, so a config
 * belonging to a dispatch that has not yet spawned can never be removed by
 * anyone.  A dispatch that throws between this write and the job record
 * leaves a directory holding only this file; `listJobs` drops it, since it
 * keeps only directories from which a job record actually loads.
 *
 * @param {string} dir - the owning job's directory (jobDir(stateDir, jobId)).
 * @param {object} sunabaEntry
 * @param {object|null} [kaibaEntry] - the worker-identity kaiba entry, or
 *        null when the host config has no kaiba server.
 * @returns {string} Path of the generated config file.
 */
export function writeClaudeMcpConfig(dir, sunabaEntry, kaibaEntry = null) {
  const file = path.join(dir, "claude-mcp.json");
  const mcpServers = { sunaba: sunabaEntry };
  if (kaibaEntry) mcpServers.kaiba = kaibaEntry;
  writeJson(file, { mcpServers });
  return file;
}
