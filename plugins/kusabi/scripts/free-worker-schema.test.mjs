// plugins/kusabi/scripts/free-worker-schema.test.mjs
// Focused regression tests for Agenda2001 StructuredOutput repair:
// 1. Opt-in review agent permissions evaluation leaves StructuredOutput visible after *: deny
// 2. Existing host tools remain denied except read: allow
// 3. Non-review agent profiles remain unaffected (StructuredOutput disabled)
// 4. Default repository templates remain unchanged
// 5. Opt-in review body contains no conflicting JSONL mandates and instructs single StructuredOutput
// 6. Transform is idempotent and only modifies review body for review agent

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { transformAgentForOptIn } from "./free-worker-profile.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const AGENTS_DIR = path.join(PLUGIN_ROOT, "opencode-agents");

// Frontmatter YAML parser
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return null;

  const yaml = match[1];
  const result = { permission: {} };
  let currentKey = null;

  function unquote(s) {
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1);
    }
    return s;
  }

  function stripComment(v) {
    const idx = v.search(/\s+#/);
    return idx >= 0 ? v.slice(0, idx) : v;
  }

  for (const line of yaml.split("\n")) {
    const top = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (top) {
      currentKey = top[1];
      const value = top[2].trim();
      result[currentKey] = value ? unquote(value) : {};
      continue;
    }

    if (currentKey && /^\s/.test(line) && line.trim()) {
      const entry = line.match(/^\s+(.+?):\s+(.*)$/);
      if (entry) {
        const key = unquote(entry[1]);
        const value = unquote(stripComment(entry[2]).trim());
        const container = result[currentKey];
        if (typeof container === "object" && !Array.isArray(container)) {
          container[key] = value;
        }
      }
    }
  }

  return result;
}

// Behavioral evaluator modeling OpenCode v1.19.3 resolveTools / Permission.disabled logic:
// packages/opencode/src/session/llm/request.ts resolveTools & prompt.ts
function resolveToolPermission(toolName, permissions) {
  if (Object.prototype.hasOwnProperty.call(permissions, toolName)) {
    return permissions[toolName];
  }
  // Check glob patterns like "shiori*"
  for (const [pattern, rule] of Object.entries(permissions)) {
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      if (toolName.startsWith(prefix)) {
        return rule;
      }
    }
  }
  // Fall back to wildcard "*"
  if (Object.prototype.hasOwnProperty.call(permissions, "*")) {
    return permissions["*"];
  }
  return "allow"; // OpenCode default when unconstrained
}

function isToolDisabled(toolName, permissions) {
  const perm = resolveToolPermission(toolName, permissions);
  return perm === "deny";
}

describe("Agenda2001 StructuredOutput Repair Regressions", () => {
  const templateReviewContent = fs.readFileSync(path.join(AGENTS_DIR, "kusabi-review.md"), "utf8");
  const transformedReviewContent = transformAgentForOptIn(templateReviewContent);
  const parsedTransformedReview = parseFrontmatter(transformedReviewContent);

  describe("1. StructuredOutput permission and tool visibility evaluation", () => {
    it("leaves StructuredOutput visible (not disabled) after wildcard *: deny in opt-in review agent", () => {
      // Must have wildcard deny
      assert.equal(parsedTransformedReview.permission["*"], "deny", "wildcard must remain deny");
      // Must have explicit StructuredOutput: allow
      assert.equal(parsedTransformedReview.permission["StructuredOutput"], "allow", "StructuredOutput must be explicitly allowed");

      // Behavioral evaluation: resolveToolPermission must return allow
      const perm = resolveToolPermission("StructuredOutput", parsedTransformedReview.permission);
      assert.equal(perm, "allow", "resolved permission for StructuredOutput must be allow");

      // Behavioral check: tool is NOT disabled in OpenCode resolveTools
      assert.equal(
        isToolDisabled("StructuredOutput", parsedTransformedReview.permission),
        false,
        "StructuredOutput must not be disabled by permission evaluation"
      );
    });

    it("evaluates StructuredOutput as disabled under template review agent permissions", () => {
      const parsedTemplate = parseFrontmatter(templateReviewContent);
      assert.equal(parsedTemplate.permission["StructuredOutput"], undefined, "template must not have StructuredOutput");
      const perm = resolveToolPermission("StructuredOutput", parsedTemplate.permission);
      assert.equal(perm, "deny", "untransformed template must deny StructuredOutput via wildcard");
      assert.equal(
        isToolDisabled("StructuredOutput", parsedTemplate.permission),
        true,
        "StructuredOutput must be disabled in untransformed template"
      );
    });
  });

  describe("2. Host tool restrictions in opt-in review agent", () => {
    it("allows host read: allow while strictly denying bash and all other host tools", () => {
      assert.equal(parsedTransformedReview.permission["read"], "allow");
      assert.equal(parsedTransformedReview.permission["bash"], "deny");

      // Evaluation for bash
      assert.equal(resolveToolPermission("bash", parsedTransformedReview.permission), "deny");
      assert.equal(isToolDisabled("bash", parsedTransformedReview.permission), true);

      // Evaluation for other host modification tools
      const forbiddenHostTools = ["write", "edit", "patch", "terminal", "command", "browser"];
      for (const tool of forbiddenHostTools) {
        assert.equal(
          resolveToolPermission(tool, parsedTransformedReview.permission),
          "deny",
          `${tool} must resolve to deny`
        );
        assert.equal(
          isToolDisabled(tool, parsedTransformedReview.permission),
          true,
          `${tool} must be disabled`
        );
      }
    });

    it("preserves exact existing MCP grants (sunaba, shiori, kaiba)", () => {
      const origParsed = parseFrontmatter(templateReviewContent);
      for (const [tool, perm] of Object.entries(origParsed.permission)) {
        if (tool.startsWith("sunaba_") || tool.startsWith("shiori") || tool.startsWith("kaiba_")) {
          assert.equal(
            parsedTransformedReview.permission[tool],
            perm,
            `must preserve permission for MCP tool ${tool}`
          );
          assert.equal(
            isToolDisabled(tool, parsedTransformedReview.permission),
            false,
            `MCP tool ${tool} must remain enabled`
          );
        }
      }
    });
  });

  describe("3. Non-review agents remain unaffected by StructuredOutput grant", () => {
    const nonReviewFiles = fs.readdirSync(AGENTS_DIR)
      .filter((f) => f.endsWith(".md") && f !== "kusabi-review.md");

    assert.ok(nonReviewFiles.length > 0, "must find non-review agent files");

    for (const file of nonReviewFiles) {
      it(`does not grant StructuredOutput to ${file}`, () => {
        const origContent = fs.readFileSync(path.join(AGENTS_DIR, file), "utf8");
        const transformed = transformAgentForOptIn(origContent);
        const parsed = parseFrontmatter(transformed);

        // StructuredOutput must be undefined
        assert.equal(
          parsed.permission["StructuredOutput"],
          undefined,
          `${file} must not have StructuredOutput permission`
        );

        // Under evaluation, StructuredOutput must resolve to deny (disabled)
        assert.equal(
          resolveToolPermission("StructuredOutput", parsed.permission),
          "deny",
          `${file} must deny StructuredOutput via wildcard`
        );
        assert.equal(
          isToolDisabled("StructuredOutput", parsed.permission),
          true,
          `${file} must disable StructuredOutput`
        );

        // Host read: allow and bash: deny are present
        assert.equal(parsed.permission["read"], "allow", `${file} must have read: allow`);
        assert.equal(parsed.permission["bash"], "deny", `${file} must have bash: deny`);

        // Body must remain unchanged (only frontmatter permissions modified)
        const origBody = origContent.replace(/^---[\s\S]*?---\n/, "");
        const transBody = transformed.replace(/^---[\s\S]*?---\n/, "");
        assert.equal(transBody, origBody, `${file} body must be byte-for-byte identical`);
      });
    }
  });

  describe("4. Default repository templates unchanged", () => {
    it("ensures all repository agent templates remain default-safe on disk", () => {
      const agentFiles = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));
      for (const file of agentFiles) {
        const content = fs.readFileSync(path.join(AGENTS_DIR, file), "utf8");
        const parsed = parseFrontmatter(content);

        assert.equal(parsed.permission["StructuredOutput"], undefined, `${file} template must not grant StructuredOutput`);
        assert.equal(parsed.permission["read"], undefined, `${file} template must not have read: allow`);
        assert.equal(parsed.permission["bash"], undefined, `${file} template must not have bash: deny`);
        assert.equal(parsed.permission["*"], "deny", `${file} template must enforce *: deny`);
      }
    });

    it("ensures template kusabi-review.md retains default JSONL description and streaming body on disk", () => {
      const content = fs.readFileSync(path.join(AGENTS_DIR, "kusabi-review.md"), "utf8");
      assert.match(content, /Streams an adversarial review of a PR as JSONL records/);
      assert.match(content, /emitted as JSONL: one JSON object per line/);
      assert.match(content, /Do not hold the review back to emit one big object at the end/);
    });
  });

  describe("5. Review instructions adapted for StructuredOutput without JSONL conflicts", () => {
    it("removes conflicting JSONL mandates from opt-in review body", () => {
      assert.doesNotMatch(
        transformedReviewContent,
        /JSONL/i,
        "transformed review agent must contain no JSONL mentions"
      );
      assert.doesNotMatch(
        transformedReviewContent,
        /Do not hold the review back to emit one big object at the end/,
        "transformed review agent must not forbid emitting a single final object"
      );
      assert.doesNotMatch(
        transformedReviewContent,
        /one JSON object per line/,
        "transformed review agent must not instruct line-by-line streaming"
      );
    });

    it("instructs invoking StructuredOutput once using the canonical schema and aggregating fields", () => {
      assert.match(
        transformedReviewContent,
        /StructuredOutput once for the final review/i,
        "must instruct invoking StructuredOutput once for final review"
      );
      assert.match(
        transformedReviewContent,
        /Aggregate all `findings`, `unverified` items, and `next_steps` consistently/i,
        "must instruct aggregating findings, unverified, and next_steps"
      );
      assert.match(
        transformedReviewContent,
        /schema_version: 1`, `verdict`, and `summary`/i,
        "must require schema_version, verdict, and summary"
      );
    });

    it("preserves all substantive review and inspection restrictions in opt-in review agent", () => {
      assert.match(transformedReviewContent, /- Do not write code\./);
      assert.match(transformedReviewContent, /You cannot and must not post to issues or PRs\./);
      assert.match(transformedReviewContent, /Outward writes are the orchestrator's exclusive exit\./);
      assert.match(transformedReviewContent, /The absence of issue_write and pr_review_write tools is by design/);
      assert.match(transformedReviewContent, /You share the container with the implementer, so treat it as read-only\./);
      assert.match(transformedReviewContent, /Reports, PR descriptions, and commit messages are not evidence\./);
      assert.match(transformedReviewContent, /re-running the read-only verification tools verify_in_container/);
      assert.match(transformedReviewContent, /Audit the honesty of tests/);
    });
  });

  describe("6. Transform idempotency and agent name detection", () => {
    it("is strictly idempotent on review agent", () => {
      const once = transformAgentForOptIn(templateReviewContent);
      const twice = transformAgentForOptIn(once);
      const thrice = transformAgentForOptIn(twice);

      assert.equal(twice, once, "second transform must equal first transform");
      assert.equal(thrice, once, "third transform must equal first transform");
    });

    it("is strictly idempotent on non-review agents", () => {
      const nonReviewFiles = fs.readdirSync(AGENTS_DIR)
        .filter((f) => f.endsWith(".md") && f !== "kusabi-review.md");

      for (const file of nonReviewFiles) {
        const orig = fs.readFileSync(path.join(AGENTS_DIR, file), "utf8");
        const once = transformAgentForOptIn(orig);
        const twice = transformAgentForOptIn(once);
        assert.equal(twice, once, `transform of ${file} must be idempotent`);
      }
    });

    it("uses reliable agent-name detection and does not rewrite body for non-review agents", () => {
      const customAgent = `---
name: kusabi-implement
description: Implement worker
permission:
  "*": deny
  sunaba_sandbox_exec: allow
---
Some body text that must not be changed.
`;
      const transformed = transformAgentForOptIn(customAgent);
      assert.doesNotMatch(transformed, /StructuredOutput/);
      assert.match(transformed, /read: allow/);
      assert.match(transformed, /bash: deny/);
      assert.match(transformed, /Some body text that must not be changed\./);
    });
  });
});
