// free-worker-profile.mjs — helpers for opt-in OpenCode free worker profile (Agenda2001)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const SCHEMA_FILE = path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json");

export const OPENCODE_FREE_WORKER_CHAIN = [
  "opencode/deepseek-v4.1-flash-free",
  "opencode/glm-5.3-flash-free",
];

export function isOpenCodeFreeWorkerEnabled() {
  return process.env.KUSABI_OPENCODE_FREE_WORKER === "1";
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

export function checkServerProfileCompatibility(existing, stateDir = "") {
  if (!existing) return;
  const optIn = isOpenCodeFreeWorkerEnabled();

  // Mode check is limited to records where profile or pure mode is known,
  // preserving fixture compatibility with mock server records while preventing
  // real legacy server bypass. Unknown records cannot prove isolation; operators
  // should ensure fresh isolated state for strict separation.
  const isFree = existing.profile === "free" || existing.pure === true;
  const isDefault = existing.profile === "default" || existing.pure === false;

  const loc = stateDir ? ` in ${stateDir}` : "";
  if (optIn && isDefault) {
    throw new Error(
      `Server profile mismatch: existing server (PID ${existing.pid}, port ${existing.port}${loc}) is running in default mode (non-pure), but opt-in free worker mode (KUSABI_OPENCODE_FREE_WORKER=1) is active. ` +
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

const JSONL_DESC_RE = /^description:\s*Phase chain ["']review["'] worker\..*?JSONL.*$/m;
const TARGET_REVIEW_DESC = 'description: Phase chain "review" worker. Emits an adversarial review of a PR via StructuredOutput conforming to the review-output schema.';

const JSONL_BODY_RE = /- Do not write code\.\s+The deliverable is the review itself[\s\S]*?JSONL[\s\S]*?The absence of issue_write and pr_review_write tools is by design, not an environment error\./;

const TARGET_REVIEW_BODY = `- Do not write code. The deliverable is the review itself, submitted by invoking StructuredOutput once for the final review using the provided canonical schema. Aggregate all \`findings\`, \`unverified\` items, and \`next_steps\` consistently into the final structured object along with \`schema_version: 1\`, \`verdict\`, and \`summary\` (plus optional \`discard_reason\`). Field names and values must strictly match the canonical schema. You cannot and must not post to issues or PRs. Outward writes are the orchestrator's exclusive exit. The absence of issue_write and pr_review_write tools is by design, not an environment error.`;

export function transformAgentForOptIn(content, agentName = undefined) {
  const detectedName = agentName || (content.match(/^name:\s*["']?([a-zA-Z0-9_-]+)["']?/m)?.[1] ?? "");
  const isReview = detectedName === "kusabi-review" || detectedName === "review" || (!detectedName && /Phase chain\s+["']?review["']?\s+worker/i.test(content));

  let transformed = content;

  if (isReview) {
    // 1. Permission transformation: add read: ask, bash: deny, and StructuredOutput: allow after *: deny
    if (!/^[ \t]*StructuredOutput:\s*allow[ \t]*$/m.test(transformed)) {
      if (/^[ \t]*bash:\s*deny[ \t]*$/m.test(transformed)) {
        transformed = transformed.replace(
          /(^[ \t]*bash:\s*deny[ \t]*$)/m,
          "$1\n  StructuredOutput: allow"
        );
      } else {
        transformed = transformed.replace(
          /(^[ \t]*["']?\*["']?:[ \t]*["']?deny["']?[ \t]*$)/m,
          "$1\n  read: ask\n  bash: deny\n  StructuredOutput: allow"
        );
      }
    } else if (!/^[ \t]*read:\s*ask[ \t]*$/m.test(transformed) || !/^[ \t]*bash:\s*deny[ \t]*$/m.test(transformed)) {
      transformed = transformed.replace(
        /(^[ \t]*["']?\*["']?:[ \t]*["']?deny["']?[ \t]*$)/m,
        "$1\n  read: ask\n  bash: deny"
      );
    }

    // 2. Frontmatter description: remove conflicting JSONL-only stream description
    if (JSONL_DESC_RE.test(transformed)) {
      transformed = transformed.replace(JSONL_DESC_RE, TARGET_REVIEW_DESC);
    }

    // 3. Body: replace conflicting JSONL streaming paragraph with StructuredOutput instruction
    if (JSONL_BODY_RE.test(transformed)) {
      transformed = transformed.replace(JSONL_BODY_RE, TARGET_REVIEW_BODY);
    }
  } else {
    // Non-review agents: only add read: ask and bash: deny after *: deny; do not alter body or grant StructuredOutput
    if (!/^[ \t]*read:\s*ask[ \t]*$/m.test(transformed) || !/^[ \t]*bash:\s*deny[ \t]*$/m.test(transformed)) {
      transformed = transformed.replace(
        /(^[ \t]*["']?\*["']?:[ \t]*["']?deny["']?[ \t]*$)/m,
        "$1\n  read: ask\n  bash: deny"
      );
    }
  }

  return transformed;
}
