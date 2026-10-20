// free-worker-profile.mjs — helpers for opt-in OpenCode free worker profile (Agenda2001)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { kusabiOpencodeConfigHome } from "./state-paths.mjs";
import { analyzeAgentFrontmatter } from "./free-worker-yaml.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const SCHEMA_FILE = path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json");

// Default opt-in candidate chain: DeepSeek only.
// DeepSeek and GLM share OpenCode's free quota, so automatic fallback within
// OpenCode provides no quota recovery upon exhaustion. Cross-backend fallbacks
// (e.g. to AGY) belong in operator configuration rather than backend defaults.
export const OPENCODE_FREE_WORKER_CHAIN = [
  "opencode/deepseek-v4.1-flash-free",
];

// Supported free models recognized without paid/non-free route warnings.
// GLM remains a valid explicitly selected free model (as a manual or model-specific
// alternative, not an automatic quota recovery fallback).
export const OPENCODE_RECOGNIZED_FREE_MODELS = [
  "opencode/deepseek-v4.1-flash-free",
  "opencode/glm-5.3-flash-free",
];

// Durable marker recording which profile the phase agents on disk were
// installed for.  It lives beside the installed agents (the install
// destination), never in the shared state record, so it cannot leak across
// processes through a live serve.
export const AGENT_PROFILE_METADATA_FILE = ".kusabi-install-profile.json";
export const AGENT_PROFILE_METADATA_VERSION = 1;

export function isOpenCodeFreeWorkerEnabled() {
  return process.env.KUSABI_OPENCODE_FREE_WORKER === "1";
}

/**
 * True when the run's phase/kind/agent name expresses an actual review
 * intent.  Agent name is authoritative alongside phase and kind: a caller
 * that dispatches the review agent by name is a review run even when the
 * phase field is missing.  Never infer review intent from a format schema —
 * a json_schema format on a non-review run is not a review.
 */
export function isReviewIntent({ phase, kind, agent } = {}) {
  if (phase === "review" || kind === "review") return true;
  return agent === "kusabi-review" || agent === "review";
}

/**
 * The directory OpenCode itself discovers agents from for a serve spawned by
 * kusabi: `$XDG_CONFIG_HOME/opencode/agent`, with XDG_CONFIG_HOME pinned to
 * kusabiOpencodeConfigHome() by buildServeEnv().  OPENCODE_AGENT_DIR is a
 * PLACEMENT override honoured by install-agents only — OpenCode does not
 * read it — so it must never be mistaken for the discovery root here.
 */
export function opencodeAgentDiscoveryDir() {
  return path.join(kusabiOpencodeConfigHome(), "opencode", "agent");
}

let _cachedReviewSchema = null;
export function getReviewSchema() {
  if (!_cachedReviewSchema) {
    _cachedReviewSchema = JSON.parse(fs.readFileSync(SCHEMA_FILE, "utf8"));
  }
  return _cachedReviewSchema;
}

export function checkOpencodeVersion(bin = "opencode", timeoutMs = 5000) {
  let result;
  try {
    result = spawnSync(bin, ["--version"], {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(
      `Failed to execute "${bin} --version": ${err.message}. OpenCode free worker profile requires OpenCode V1 (>= 1.19.3). Please verify your OpenCode installation.`
    );
  }

  if (result.error) {
    throw new Error(
      `Failed to execute "${bin} --version": ${result.error.message}. OpenCode free worker profile requires OpenCode V1 (>= 1.19.3). Please verify your OpenCode installation.`
    );
  }

  if (result.status !== 0) {
    throw new Error(
      `"${bin} --version" exited with code ${result.status}. OpenCode free worker profile requires OpenCode V1 (>= 1.19.3). Please verify your OpenCode installation.`
    );
  }

  const output = (result.stdout || "").trim();
  const match = output.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) {
    throw new Error(
      `Unparseable OpenCode version output "${output}". OpenCode free worker profile requires OpenCode V1 (>= 1.19.3). Please verify your OpenCode installation.`
    );
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);

  if (major >= 2) {
    throw new Error(
      `OpenCode V2 (detected version ${output}) is not supported. OpenCode free worker profile requires stable OpenCode V1 (>= 1.19.3). Actionable: please switch to a supported OpenCode V1 release.`
    );
  }
  if (major < 1) {
    throw new Error(
      `OpenCode version ${output} is not supported. OpenCode free worker profile requires stable OpenCode V1 (>= 1.19.3).`
    );
  }
  if (minor < 19 || (minor === 19 && patch < 3)) {
    throw new Error(
      `Detected OpenCode version ${output}. Unsupported version: OpenCode free worker profile requires OpenCode V1 >= 1.19.3. Please upgrade OpenCode.`
    );
  }

  return { major, minor, patch, raw: output };
}

/**
 * Reject reusing a healthy recorded serve whose recorded mode is
 * incompatible with the current process mode.
 *
 * Opt-in (`KUSABI_OPENCODE_FREE_WORKER=1`) requires an explicitly free/pure
 * record: a default record AND an unidentified (legacy / mock) record both
 * fail, because neither proves the serve is isolated.  Opt-out accepts a
 * default record and a legacy unidentified record (the compatibility policy
 * for pre-metadata installs), but never a free/pure one.  Incompatible
 * servers are refused with restart instructions — never killed implicitly.
 */
export function checkServerProfileCompatibility(existing, stateDir = "") {
  if (!existing) return;
  const optIn = isOpenCodeFreeWorkerEnabled();

  const isFree = existing.profile === "free" || existing.pure === true;
  const isDefault = existing.profile === "default" || existing.pure === false;

  const loc = stateDir ? ` in ${stateDir}` : "";
  if (optIn && !isFree) {
    const detail = isDefault
      ? "is running in default mode (non-pure)"
      : "lacks free/default profile metadata (unidentified legacy record)";
    throw new Error(
      `Server profile mismatch: existing server (PID ${existing.pid}, port ${existing.port}${loc}) ${detail}, but opt-in free worker mode (KUSABI_OPENCODE_FREE_WORKER=1) is active. ` +
      `Actionable: stop the existing server using 'kusabi serve-stop' or terminate PID ${existing.pid}, then restart.`
    );
  }
  if (!optIn && isFree) {
    throw new Error(
      `Server profile mismatch: existing server (PID ${existing.pid}, port ${existing.port}${loc}) is running in opt-in free worker mode (--pure), but standard worker mode is active. ` +
      `Actionable: stop the existing server using 'kusabi serve-stop' or terminate PID ${existing.pid}, then restart.`
    );
  }
}

// ---------------------------------------------------------------------------
// Installed phase-agent profile metadata (isolation guard)
// ---------------------------------------------------------------------------
//
// `install-agents` is a host-level mutation of the shared OpenCode discovery
// directory.  Opt-in and default installs produce DIFFERENT agent files
// (opt-in adds `read: ask` / `bash: deny`, and for the review agent a
// synthetic `StructuredOutput: allow`).  Without a durable marker, flipping
// the env var leaves the previous mode's files in place and the next serve
// silently runs them.  The marker below records the installed mode; when it
// is missing, the files are classified structurally so a known free-installed
// tree is never silently trusted as default.

/**
 * Structural classification of one installed agent file:
 *   "free"    — a valid allowed permission block carrying opt-in additions
 *               (`read: ask`/`bash: deny`/`StructuredOutput: allow`)
 *   "default" — a valid allowed wildcard-deny block with none of those additions
 *   "unknown" — unparseable/ambiguous frontmatter, or a permission block that is
 *               malformed, broadened/duplicated, or carries an unsupported key
 *
 * Classification consumes the SAME strict parse and canonical validator as the
 * transform (`analyzeAgentFrontmatter`), so no comment, duplicate key, alias or
 * other ambiguity can truncate the block and make a broadened or malformed tree
 * look default.  A parse failure is "unknown", never "default".
 */
export function classifyInstalledAgentContent(content) {
  const analysis = analyzeAgentFrontmatter(content);
  if (!analysis.ok) return "unknown";
  const keys = new Set(analysis.rules.map((r) => r.key));
  const hasOptInAddition = keys.has("read") || keys.has("bash") || keys.has("StructuredOutput");
  return hasOptInAddition ? "free" : "default";
}

export function readInstalledAgentProfile(agentDir) {
  const file = path.join(agentDir, AGENT_PROFILE_METADATA_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && (parsed.profile === "free" || parsed.profile === "default")) return parsed;
  } catch { /* absent or unreadable — fall through to structural classification */ }
  return null;
}

/**
 * Determine the profile of the agents installed in *agentDir*:
 *   "free" | "default" | "unknown" | "absent".
 *
 * The installed kusabi agent files are ALWAYS classified structurally.  The
 * durable metadata does not replace that check: it must agree with the
 * content classification.  A marker that disagrees with the files on disk
 * (tampered, replaced or broadened content) is reported as "unknown" rather
 * than trusted, so a marker can never conceal incompatible content.
 *   - a homogeneous free-transformed tree is "free";
 *   - a homogeneous wildcard-deny tree is "default";
 *   - a mixed tree containing both free and default files is "unknown";
 *   - a tree with no recognizable kusabi agents is "absent";
 *   - any unclassifiable/malformed/broadened file, or a marker/content
 *     disagreement, makes the tree "unknown" (fail closed).
 */
export function detectInstalledAgentProfile(agentDir) {
  const meta = readInstalledAgentProfile(agentDir);

  let sawFile = false;
  let anyFree = false;
  let anyUnknown = false;
  let sawDefault = false;
  let entries = [];
  try {
    entries = fs.readdirSync(agentDir);
  } catch {
    return meta ? meta.profile : "absent";
  }
  for (const name of entries) {
    if (!name.endsWith(".md") || !name.startsWith("kusabi-")) continue;
    let content;
    try {
      content = fs.readFileSync(path.join(agentDir, name), "utf8");
    } catch {
      sawFile = true;
      anyUnknown = true; // unreadable: fail closed, never call it default
      continue;
    }
    sawFile = true;
    const cls = classifyInstalledAgentContent(content);
    if (cls === "free") anyFree = true;
    else if (cls === "default") sawDefault = true;
    else anyUnknown = true;
  }
  if (!sawFile) return meta ? meta.profile : "absent";
  if (anyUnknown || (anyFree && sawDefault)) return "unknown";
  const structural = anyFree ? "free" : sawDefault ? "default" : "unknown";
  if (meta) return meta.profile === structural ? meta.profile : "unknown";
  return structural;
}

/**
 * Fail closed before any worker execution when the installed agent profile
 * does not match the active mode.  Returns the detected profile so callers
 * (and tests) can observe it.
 *
 *  - opt-in requires a "free" install (default/unknown/absent are refused);
 *  - opt-out refuses a "free" install;
 *  - opt-out refuses an "unknown"/conflicting install as well, so a tree whose
 *    permission content cannot be trusted is never dispatched;
 *  - only an "absent" tree is a no-op in both modes.
 */
export function assertInstalledAgentProfile(agentDir, optIn = isOpenCodeFreeWorkerEnabled()) {
  const detected = detectInstalledAgentProfile(agentDir);
  if (detected === "absent") return detected;
  if (detected === "unknown") {
    throw Object.assign(new Error(
      `Installed phase agents at ${agentDir} have unknown or conflicting permission content and cannot be trusted. ` +
      `Actionable: reinstall with ${optIn ? "KUSABI_OPENCODE_FREE_WORKER=1 " : ""}(kusabi install-agents) before dispatching.`,
    ), { code: "KUSABI_AGENT_PROFILE_MISMATCH" });
  }
  if (optIn && detected !== "free") {
    throw Object.assign(new Error(
      `Installed phase agents at ${agentDir} are in "${detected}" mode, but opt-in free worker mode (KUSABI_OPENCODE_FREE_WORKER=1) is active. ` +
      `Actionable: reinstall with KUSABI_OPENCODE_FREE_WORKER=1 (kusabi install-agents) before dispatching.`,
    ), { code: "KUSABI_AGENT_PROFILE_MISMATCH" });
  }
  if (!optIn && detected === "free") {
    throw Object.assign(new Error(
      `Installed phase agents at ${agentDir} were installed for opt-in free worker mode, but standard worker mode is active. ` +
      `Actionable: reinstall without KUSABI_OPENCODE_FREE_WORKER (kusabi install-agents) before dispatching.`,
    ), { code: "KUSABI_AGENT_PROFILE_MISMATCH" });
  }
  return detected;
}

export function writeInstalledAgentProfile(agentDir, profile) {
  fs.mkdirSync(agentDir, { recursive: true });
  const record = {
    version: AGENT_PROFILE_METADATA_VERSION,
    profile,
    installedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(agentDir, AGENT_PROFILE_METADATA_FILE),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8"
  );
  return record;
}

// ---------------------------------------------------------------------------
// Agent-install preflight
// ---------------------------------------------------------------------------

/**
 * Read and (when opt-in) transform every repository agent template BEFORE
 * any install mutation.  A transform failure therefore aborts the install
 * with nothing written — no partial agent directory.
 *
 * @param {string} sourceDir  directory of `.md` templates
 * @param {{ optIn?: boolean }} [opts]
 * @returns {Array<{ f: string, srcFile: string, content: string|null }>}
 */
export function prepareAgentInstall(sourceDir, { optIn = isOpenCodeFreeWorkerEnabled() } = {}) {
  const files = fs.existsSync(sourceDir) ? fs.readdirSync(sourceDir).filter((f) => f.endsWith(".md")) : [];
  return files.map((f) => {
    const srcFile = path.join(sourceDir, f);
    if (!optIn) return { f, srcFile, content: null };
    return { f, srcFile, content: transformAgentForOptIn(fs.readFileSync(srcFile, "utf8")) };
  });
}

// ---------------------------------------------------------------------------
// Configured-route warning (operator precedence retained)
// ---------------------------------------------------------------------------

/**
 * True when *route* is one of the recognized free model entries (ignoring
 * a `:variant` suffix).  Routes with any other opencode provider/model are
 * operator-configured and are left untouched.
 */
export function isOpenCodeFreeCandidateRoute(route) {
  const base = String(route ?? "").split(":")[0];
  return OPENCODE_RECOGNIZED_FREE_MODELS.includes(base);
}

export function freeWorkerConfiguredRouteWarning(route) {
  return (
    `KUSABI_OPENCODE_FREE_WORKER=1 is enabled but the selected OpenCode route "${route}" is outside the free candidate chain ` +
    `(${OPENCODE_RECOGNIZED_FREE_MODELS.join(", ")}). The operator configuration is used unchanged — no automatic override is applied.`
  );
}

// ---------------------------------------------------------------------------
// Agent transform (fail-closed)
// ---------------------------------------------------------------------------

const JSONL_DESC_RE = /^description:\s*Phase chain ["']review["'] worker\..*?JSONL.*$/m;
const TARGET_REVIEW_DESC = 'description: Phase chain "review" worker. Emits an adversarial review of a PR via StructuredOutput conforming to the review-output schema.';

const JSONL_BODY_RE = /- Do not write code\.\s+The deliverable is the review itself[\s\S]*?JSONL[\s\S]*?The absence of issue_write and pr_review_write tools is by design, not an environment error\./;

const TARGET_REVIEW_BODY = `- Do not write code. The deliverable is the review itself, submitted by invoking StructuredOutput once for the final review using the provided canonical schema. Aggregate all \`findings\`, \`unverified\` items, and \`next_steps\` consistently into the final structured object along with \`schema_version: 1\`, \`verdict\`, and \`summary\` (plus optional \`discard_reason\`). Field names and values must strictly match the canonical schema. You cannot and must not post to issues or PRs. Outward writes are the orchestrator's exclusive exit. The absence of issue_write and pr_review_write tools is by design, not an environment error.`;

// ---------------------------------------------------------------------------
// Agent transform (fail-closed, strict YAML)
// ---------------------------------------------------------------------------
//
// The transform is only allowed to ADD the constrained rules `read: ask`,
// `bash: deny`, and (for the review agent) `StructuredOutput: allow` to a
// template whose parsed `permission:` mapping already passes the canonical
// allowlist validator in free-worker-yaml.mjs.  A template that carries any
// conflicting value, a duplicate key, an alias/merge or any other ambiguity is
// refused rather than silently normalised: otherwise a broader privilege
// (`read: allow`, a host builtin, a shadowing glob, ...) would survive the
// transform and last-match semantics would decide the effective policy.  Only
// the parsed `permission:` mapping is inspected; the agent body is never a
// source of permission rules.
//
// Insertion uses the parser's source ranges (the `*: deny` pair) so the source
// text — quotes, comments and the nested `skill:`/MCP rules — is preserved
// verbatim; a duplicated key is refused during parsing, never reinterpreted.

/**
 * Rewrite one repository agent template for the opt-in free worker profile.
 *
 * Fail-closed: a template without YAML frontmatter, without a `permission`
 * mapping, or whose first permission entry is not `"*": deny` is refused with a
 * descriptive, position-annotated error, so `install-agents` cannot write a
 * partially/incorrectly transformed agent.  The transform is idempotent and
 * never rewrites default templates in place — it only returns new content.
 *
 * @param {string} content   repository agent file contents
 * @param {string} [agentName] optional explicit agent name (tests)
 * @returns {string} transformed contents
 * @throws {Error} when the template cannot be transformed fail-closed
 */
export function transformAgentForOptIn(content, agentName = undefined) {
  const analysis = analyzeAgentFrontmatter(content);
  if (!analysis.ok) {
    throw new Error(`opt-in free worker agent transform failed: ${analysis.error}`);
  }
  const { fm, rules, name, description, wildcardPair } = analysis;

  const detectedName = agentName || name || "";
  const isReview =
    detectedName === "kusabi-review" ||
    detectedName === "review" ||
    (!detectedName && /Phase chain\s+["']?review["']?\s+worker/i.test(String(description)));

  const present = new Set(rules.map((r) => r.key));

  // Locate the (validated, first) wildcard rule in the source by its parsed
  // range, so insertion never reinterprets duplicated or quoted keys.
  const lines = fm.yaml.split("\n");
  const wildcardValueStart = wildcardPair.value.range && wildcardPair.value.range[0];
  if (wildcardValueStart == null) {
    throw new Error(
      "opt-in free worker agent transform failed: cannot locate the wildcard permission rule in the source"
    );
  }
  const wildcardLineIdx = fm.yaml.slice(0, wildcardValueStart).split("\n").length - 1;
  const baseIndent = (lines[wildcardLineIdx].match(/^[ \t]*/) || [""])[0];

  const inserts = [];
  if (!present.has("read")) inserts.push(`${baseIndent}read: ask`);
  if (!present.has("bash")) inserts.push(`${baseIndent}bash: deny`);
  if (isReview && !present.has("StructuredOutput")) inserts.push(`${baseIndent}StructuredOutput: allow`);

  const newLines = [
    ...lines.slice(0, wildcardLineIdx + 1),
    ...inserts,
    ...lines.slice(wildcardLineIdx + 1),
  ];
  let transformed = `---\n${newLines.join("\n")}\n---\n${fm.rest}`;

  if (isReview) {
    // Frontmatter description: remove conflicting JSONL-only stream description.
    if (JSONL_DESC_RE.test(transformed)) {
      transformed = transformed.replace(JSONL_DESC_RE, TARGET_REVIEW_DESC);
    }
    // Body: replace conflicting JSONL streaming paragraph with StructuredOutput instruction.
    if (JSONL_BODY_RE.test(transformed)) {
      transformed = transformed.replace(JSONL_BODY_RE, TARGET_REVIEW_BODY);
    }
  }

  return transformed;
}
