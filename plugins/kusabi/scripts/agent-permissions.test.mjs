import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Pure exported checker
// ---------------------------------------------------------------------------

/**
 * Check agent permission allowlist invariants.
 *
 * @param {Record<string, string>} permission - Parsed permission mapping,
 *   e.g. { "*": "deny", "sunaba_read_file_range": "allow" }.
 * @param {string} roleName - Role name (e.g. "implement", "draft").
 * @returns {string[]} List of violation descriptions (empty = all clear).
 */
export function checkAgentPermissions(permission, roleName) {
  const violations = [];
  const entries = Object.entries(permission);

  // 1. "*": deny must be the first entry (findLast semantics — last match wins).
  if (entries.length === 0 || entries[0][0] !== "*" || entries[0][1] !== "deny") {
    violations.push(`"*": deny must be the first entry in permission (role: ${roleName})`);
  }

  // 2. No deny entries for tools other than "*".
  for (const [tool, value] of entries) {
    if (tool !== "*" && value === "deny") {
      violations.push(`Deny entry for non-"*" tool "${tool}" (role: ${roleName})`);
    }
  }

  // 3. Common read-core tools required for every role.
  const requiredReadCore = [
    "sunaba_sandbox_attach",
    "sunaba_read_file_range",
    "sunaba_search_in_container",
    "sunaba_list_files",
    "sunaba_diff_in_container",
    "sunaba_issue_view",
  ];
  for (const tool of requiredReadCore) {
    if (permission[tool] !== "allow") {
      violations.push(`Missing common read-core tool "${tool}" (role: ${roleName})`);
    }
  }

  // 4. Forbidden tools — exact names.
  const forbiddenExact = [
    "sunaba_publish",
    "sunaba_sandbox_initialize",
    "sunaba_sandbox_stop",
    "sunaba_sandbox_pr_review_write",
    "sunaba_run_container_and_exec",
    "sunaba_secret_scan_override",
  ];
  for (const tool of forbiddenExact) {
    if (permission[tool] === "allow") {
      violations.push(`Forbidden tool "${tool}" is allowed (role: ${roleName})`);
    }
  }

  // 5. Forbidden patterns — sunaba_merge_* and sunaba_copy_*.
  for (const [tool, value] of entries) {
    if (value === "allow" && (tool.startsWith("sunaba_merge_") || tool.startsWith("sunaba_copy_"))) {
      violations.push(`Forbidden tool pattern matched: "${tool}" is allowed (role: ${roleName})`);
    }
  }

  // 6. sunaba_run_python: exclusive to implement/respond — both the negative
  //    check (nobody else may have it) and the positive check (those two MUST
  //    have it).
  if ((roleName === "implement" || roleName === "respond") && permission["sunaba_run_python"] !== "allow") {
    violations.push(`"sunaba_run_python" missing from "${roleName}" (implement/respond must have it)`);
  } else if (permission["sunaba_run_python"] === "allow" && roleName !== "implement" && roleName !== "respond") {
    violations.push(`"sunaba_run_python" granted to "${roleName}", but only implement/respond may have it`);
  }

  // 7. sunaba_sandbox_issue_write: exclusive to draft/investigate — both the
  //    negative check (nobody else may have it) and the positive check (those
  //    two MUST have it).
  if ((roleName === "draft" || roleName === "investigate") && permission["sunaba_sandbox_issue_write"] !== "allow") {
    violations.push(`"sunaba_sandbox_issue_write" missing from "${roleName}" (draft/investigate must have it)`);
  } else if (permission["sunaba_sandbox_issue_write"] === "allow" && roleName !== "draft" && roleName !== "investigate") {
    violations.push(`"sunaba_sandbox_issue_write" granted to "${roleName}", but only draft/investigate may have it`);
  }

  return violations;
}

// ---------------------------------------------------------------------------
// YAML frontmatter parser (string/regex only — no YAML library)
// ---------------------------------------------------------------------------

/**
 * Parse the YAML frontmatter from a markdown agent definition file.
 *
 * Returns a flat object with top-level keys.  The "permission" key, when
 * present, is a sub-object mapping tool names to "allow"/"deny".
 *
 * @param {string} content - Full file content.
 * @returns {Record<string, any>|null} Parsed frontmatter or null.
 */
export function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return null;

  const yaml = match[1];
  const result = {};
  let currentKey = null;

  /**
   * Strip YAML quoting from a scalar value or key.
   * YAML allows single/double quotes; we remove the outer pair.
   */
  function unquote(s) {
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1);
    }
    return s;
  }

  /**
   * Strip a YAML inline comment from a value string.
   * In YAML, "#" introduces a comment only when preceded by whitespace (or at
   * the start of the value), so `allow  # debug` → `allow` but `allow#1` is
   * kept as-is.
   */
  function stripComment(v) {
    const idx = v.search(/\s+#/);
    return idx >= 0 ? v.slice(0, idx) : v;
  }

  for (const line of yaml.split("\n")) {
    // Top-level key: value
    const top = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (top) {
      currentKey = top[1];
      const value = top[2].trim();
      // If no inline value, initialise as an empty mapping (will be filled by
      // subsequent indented lines).  Otherwise store the scalar.
      result[currentKey] = value ? unquote(value) : {};
      continue;
    }

    // Indented entries (inside permission:, etc.) — accept any amount of
    // leading whitespace rather than hardcoding two spaces.
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
/**
 * Derive role name from a file path like "kusabi-draft.md".
 *
 * @param {string} filePath - Absolute or relative file path.
 * @returns {string}
 */
export function roleNameFromPath(filePath) {
  const basename = filePath.replace(/^.*[/\\]/, "").replace(/\.md$/, "");
  // Convention: "kusabi-<rolename>.md" — strip the prefix.
  if (basename.startsWith("kusabi-")) {
    return basename.slice(7);
  }
  return basename;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const AGENTS_DIR = join(__dirname, "..", "opencode-agents");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agent permission allowlists", () => {
  // R4: Enumerate agent directory dynamically — no hardcoded list.
  const agentFiles = readdirSync(AGENTS_DIR)
    .filter(f => f.endsWith(".md"))
    .sort();
  const agentCount = agentFiles.length;

  it("discovers agent definition files", () => {
    assert.ok(agentCount > 0, `No .md files found in ${AGENTS_DIR}`);
  });

  // --- Real agent file checks --------------------------------------------------
  for (const file of agentFiles) {
    const filePath = join(AGENTS_DIR, file);
    const roleName = roleNameFromPath(file);

    it(`${roleName}: permission allowlist invariants hold`, () => {
      const content = readFileSync(filePath, "utf-8");
      const fm = parseFrontmatter(content);
      assert.ok(fm !== null, `Could not parse frontmatter in ${file}`);

      const permission = fm.permission;
      assert.ok(
        permission !== null &&
          typeof permission === "object" &&
          !Array.isArray(permission),
        `No "permission:" mapping in ${file}`,
      );

      const violations = checkAgentPermissions(permission, roleName);
      assert.deepEqual(
        violations,
        [],
        `${roleName}: Permission violations:\n  ${violations.join("\n  ")}`,
      );
    });
  }

  // --- Synthetic broken inputs (R3) --------------------------------------------
  describe("synthetic violations are detected", () => {
    it('"*": deny not first', () => {
      const violations = checkAgentPermissions(
        { "sunaba_read_file_range": "allow", "*": "deny" },
        "test-role",
      );
      assert.ok(violations.length > 0);
      assert.ok(violations[0].includes('"*": deny must be the first'));
    });

    it('deny entry for non-"*" tool', () => {
      const violations = checkAgentPermissions(
        { "*": "deny", "sunaba_sandbox_exec": "deny" },
        "test-role",
      );
      assert.ok(violations.length > 0);
      assert.ok(violations.some(v => v.includes('Deny entry for non-"*"')));
    });

    it("missing common read-core tool", () => {
      const violations = checkAgentPermissions(
        { "*": "deny", "sunaba_sandbox_attach": "allow", "sunaba_read_file_range": "allow" },
        "test-role",
      );
      assert.ok(violations.length > 0);
      assert.ok(violations.some(v => v.includes("Missing common read-core tool")));
    });

    it("forbidden tool granted", () => {
      const violations = checkAgentPermissions(
        { "*": "deny", "sunaba_publish": "allow" },
        "test-role",
      );
      assert.ok(violations.length > 0);
      assert.ok(violations.some(v => v.includes("sunaba_publish")));
    });

    it("forbidden pattern (sunaba_copy_*) granted", () => {
      const violations = checkAgentPermissions(
        { "*": "deny", "sunaba_copy_project": "allow" },
        "test-role",
      );
      assert.ok(violations.length > 0);
      assert.ok(violations.some(v => v.includes("sunaba_copy_")));
    });

    it("forbidden pattern (sunaba_merge_*) granted", () => {
      const violations = checkAgentPermissions(
        { "*": "deny", "sunaba_merge_branches": "allow" },
        "test-role",
      );
      assert.ok(violations.length > 0);
      assert.ok(violations.some(v => v.includes("sunaba_merge_")));
    });

    it('"sunaba_run_python" granted to wrong role', () => {
      const violations = checkAgentPermissions(
        { "*": "deny", "sunaba_run_python": "allow" },
        "review",
      );
      assert.ok(violations.length > 0);
      assert.ok(violations.some(v => v.includes("sunaba_run_python")));
    });

    it('"sunaba_run_python" on implement passes', () => {
      const violations = checkAgentPermissions(
        {
          "*": "deny",
          "sunaba_sandbox_attach": "allow",
          "sunaba_read_file_range": "allow",
          "sunaba_search_in_container": "allow",
          "sunaba_list_files": "allow",
          "sunaba_diff_in_container": "allow",
          "sunaba_issue_view": "allow",
          "sunaba_run_python": "allow",
        },
        "implement",
      );
      assert.deepEqual(violations, []);
    });

    it('"sunaba_run_python" on respond passes', () => {
      const violations = checkAgentPermissions(
        {
          "*": "deny",
          "sunaba_sandbox_attach": "allow",
          "sunaba_read_file_range": "allow",
          "sunaba_search_in_container": "allow",
          "sunaba_list_files": "allow",
          "sunaba_diff_in_container": "allow",
          "sunaba_issue_view": "allow",
          "sunaba_run_python": "allow",
        },
        "respond",
      );
      assert.deepEqual(violations, []);
    });

    it('"sunaba_sandbox_issue_write" granted to wrong role', () => {
      const violations = checkAgentPermissions(
        {
          "*": "deny",
          "sunaba_sandbox_attach": "allow",
          "sunaba_read_file_range": "allow",
          "sunaba_search_in_container": "allow",
          "sunaba_list_files": "allow",
          "sunaba_diff_in_container": "allow",
          "sunaba_issue_view": "allow",
          "sunaba_sandbox_issue_write": "allow",
        },
        "review",
      );
      assert.ok(violations.length > 0);
      assert.ok(violations.some(v => v.includes("sunaba_sandbox_issue_write")));
    });

    it('"sunaba_sandbox_issue_write" on draft passes', () => {
      const violations = checkAgentPermissions(
        {
          "*": "deny",
          "sunaba_sandbox_attach": "allow",
          "sunaba_read_file_range": "allow",
          "sunaba_search_in_container": "allow",
          "sunaba_list_files": "allow",
          "sunaba_diff_in_container": "allow",
          "sunaba_issue_view": "allow",
          "sunaba_sandbox_issue_write": "allow",
        },
        "draft",
      );
      assert.deepEqual(violations, []);
    });

    it('"sunaba_sandbox_issue_write" on investigate passes', () => {
      const violations = checkAgentPermissions(
        {
          "*": "deny",
          "sunaba_sandbox_attach": "allow",
          "sunaba_read_file_range": "allow",
          "sunaba_search_in_container": "allow",
          "sunaba_list_files": "allow",
          "sunaba_diff_in_container": "allow",
          "sunaba_issue_view": "allow",
          "sunaba_sandbox_issue_write": "allow",
        },
        "investigate",
      );
      assert.deepEqual(violations, []);
    });

    // --- Positive mandatory-presence checks (finding 1) ---
    it("implement missing sunaba_run_python", () => {
      const violations = checkAgentPermissions(
        {
          "*": "deny",
          "sunaba_sandbox_attach": "allow",
          "sunaba_read_file_range": "allow",
          "sunaba_search_in_container": "allow",
          "sunaba_list_files": "allow",
          "sunaba_diff_in_container": "allow",
          "sunaba_issue_view": "allow",
        },
        "implement",
      );
      assert.ok(violations.some(v => v.includes("sunaba_run_python") && v.includes("missing")));
    });

    it("respond missing sunaba_run_python", () => {
      const violations = checkAgentPermissions(
        {
          "*": "deny",
          "sunaba_sandbox_attach": "allow",
          "sunaba_read_file_range": "allow",
          "sunaba_search_in_container": "allow",
          "sunaba_list_files": "allow",
          "sunaba_diff_in_container": "allow",
          "sunaba_issue_view": "allow",
        },
        "respond",
      );
      assert.ok(violations.some(v => v.includes("sunaba_run_python") && v.includes("missing")));
    });

    it("draft missing sunaba_sandbox_issue_write", () => {
      const violations = checkAgentPermissions(
        {
          "*": "deny",
          "sunaba_sandbox_attach": "allow",
          "sunaba_read_file_range": "allow",
          "sunaba_search_in_container": "allow",
          "sunaba_list_files": "allow",
          "sunaba_diff_in_container": "allow",
          "sunaba_issue_view": "allow",
        },
        "draft",
      );
      assert.ok(violations.some(v => v.includes("sunaba_sandbox_issue_write") && v.includes("missing")));
    });

    it("investigate missing sunaba_sandbox_issue_write", () => {
      const violations = checkAgentPermissions(
        {
          "*": "deny",
          "sunaba_sandbox_attach": "allow",
          "sunaba_read_file_range": "allow",
          "sunaba_search_in_container": "allow",
          "sunaba_list_files": "allow",
          "sunaba_diff_in_container": "allow",
          "sunaba_issue_view": "allow",
        },
        "investigate",
      );
      assert.ok(violations.some(v => v.includes("sunaba_sandbox_issue_write") && v.includes("missing")));
    });
  });

  // --- Parser correctness (findings 2 and 3) ------------------------------------
  describe("parseFrontmatter", () => {
    it("strips YAML inline comments from permission values", () => {
      const content = "---\nmode: primary\npermission:\n  \"*\": deny\n  sunaba_read_file_range: allow  # read-side tool\n---\n";
      const fm = parseFrontmatter(content);
      assert.ok(fm !== null);
      assert.equal(fm.permission["sunaba_read_file_range"], "allow");
    });

    it("strips inline comment from deny value", () => {
      const content = "---\nmode: primary\npermission:\n  \"*\": deny  # deny-all fallback\n  sunaba_read_file_range: allow\n---\n";
      const fm = parseFrontmatter(content);
      assert.ok(fm !== null);
      assert.equal(fm.permission["*"], "deny");
    });

    it("keeps value with embedded # (no leading whitespace) intact", () => {
      // `allow#1` has no whitespace before # so it is NOT a comment.
      const content = "---\nmode: primary\npermission:\n  \"*\": deny\n  sunaba_read_file_range: allow#1\n---\n";
      const fm = parseFrontmatter(content);
      assert.ok(fm !== null);
      assert.equal(fm.permission["sunaba_read_file_range"], "allow#1");
    });

    it("accepts 4-space indentation for permission entries", () => {
      const content = "---\nmode: primary\npermission:\n    \"*\": deny\n    sunaba_read_file_range: allow\n---\n";
      const fm = parseFrontmatter(content);
      assert.ok(fm !== null);
      assert.equal(fm.permission["*"], "deny");
      assert.equal(fm.permission["sunaba_read_file_range"], "allow");
    });

    it("accepts tab indentation for permission entries", () => {
      const content = "---\nmode: primary\npermission:\n\t\"*\": deny\n\tsunaba_read_file_range: allow\n---\n";
      const fm = parseFrontmatter(content);
      assert.ok(fm !== null);
      assert.equal(fm.permission["*"], "deny");
      assert.equal(fm.permission["sunaba_read_file_range"], "allow");
    });

    it("strips YAML quoting from permission values, not only from keys", () => {
      // A formatter or editor that emits quoted scalars must not make every
      // entry look like a violation.  Both quote styles are valid YAML.
      const content = "---\nmode: primary\npermission:\n  \"*\": \"deny\"\n  sunaba_read_file_range: 'allow'\n  sunaba_list_files: \"allow\"\n---\n";
      const fm = parseFrontmatter(content);
      assert.ok(fm !== null);
      assert.equal(fm.permission["*"], "deny");
      assert.equal(fm.permission["sunaba_read_file_range"], "allow");
      assert.equal(fm.permission["sunaba_list_files"], "allow");
    });

    it("strips YAML quoting from top-level scalar values", () => {
      const content = "---\nmode: \"primary\"\ndescription: 'a worker'\npermission:\n  \"*\": deny\n---\n";
      const fm = parseFrontmatter(content);
      assert.ok(fm !== null);
      assert.equal(fm.mode, "primary");
      assert.equal(fm.description, "a worker");
    });

    it("strips an inline comment before unquoting a value", () => {
      const content = "---\npermission:\n  \"*\": \"deny\"  # everything is denied by default\n---\n";
      const fm = parseFrontmatter(content);
      assert.ok(fm !== null);
      assert.equal(fm.permission["*"], "deny");
    });

    it("returns null for content without frontmatter delimiters", () => {
      const fm = parseFrontmatter("no frontmatter here");
      assert.equal(fm, null);
    });

    it("returns null for unclosed frontmatter (only opening ---)", () => {
      const fm = parseFrontmatter("---\npermission:\n  \"*\": deny\n");
      assert.equal(fm, null);
    });
  });
});
