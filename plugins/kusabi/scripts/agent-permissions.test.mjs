import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
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

  // 6. sunaba_run_python: exclusive to implement/respond/gofer — both the
  //    negative check (nobody else may have it) and the positive check (those
  //    three MUST have it).  Gofer's grant is for post-collection compression
  //    of gathered evidence, not exploration (#216).
  const runPythonRoles = ["implement", "respond", "gofer"];
  if (runPythonRoles.includes(roleName) && permission["sunaba_run_python"] !== "allow") {
    violations.push(`"sunaba_run_python" missing from "${roleName}" (implement/respond/gofer must have it)`);
  } else if (permission["sunaba_run_python"] === "allow" && !runPythonRoles.includes(roleName)) {
    violations.push(`"sunaba_run_python" granted to "${roleName}", but only implement/respond/gofer may have it`);
  }

  // 7. sunaba_sandbox_issue_write: exclusive to draft/investigate — both the
  //    negative check (nobody else may have it) and the positive check (those
  //    two MUST have it).
  if ((roleName === "draft" || roleName === "investigate") && permission["sunaba_sandbox_issue_write"] !== "allow") {
    violations.push(`"sunaba_sandbox_issue_write" missing from "${roleName}" (draft/investigate must have it)`);
  } else if (permission["sunaba_sandbox_issue_write"] === "allow" && roleName !== "draft" && roleName !== "investigate") {
    violations.push(`"sunaba_sandbox_issue_write" granted to "${roleName}", but only draft/investigate may have it`);
  }

  // 8. kaiba permissions (kusabi #279, #391): `kaiba_recall` and
  //    `kaiba_progress` are the only grants that may appear under the
  //    kaiba prefix.  Write permission for conclusions (`remember`) follows
  //    the inspection hierarchy — an agent whose output is inspected reads
  //    the shared conclusion store and records in-flight progress notes,
  //    and the inspecting side (the orchestrator) is the only writer of
  //    durable conclusions; a worker that discovers a durable fact reports
  //    it instead of filing it.  A `kaiba*` glob would re-allow
  //    `kaiba_remember` under findLast, so the wildcard is a violation too.
  const allowedKaibaTools = new Set(["kaiba_recall", "kaiba_progress"]);
  for (const [tool, value] of entries) {
    if (value === "allow" && tool.startsWith("kaiba") && !allowedKaibaTools.has(tool)) {
      violations.push(`Forbidden kaiba grant "${tool}" is allowed (role: ${roleName})`);
    }
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

      // Read and progress access: rule 8 rejects any kaiba grant beyond
      // recall and progress, but only these assertions notice them going
      // missing entirely.
      assert.equal(
        permission["kaiba_recall"],
        "allow",
        `${roleName}: kaiba_recall must be granted — every worker phase reads the shared conclusion store`,
      );
      assert.equal(
        permission["kaiba_progress"],
        "allow",
        `${roleName}: kaiba_progress must be granted — every worker phase records in-flight progress notes`,
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

    // --- kaiba is read-only for every phase ---
    const READ_CORE = {
      "*": "deny",
      "sunaba_sandbox_attach": "allow",
      "sunaba_read_file_range": "allow",
      "sunaba_search_in_container": "allow",
      "sunaba_list_files": "allow",
      "sunaba_diff_in_container": "allow",
      "sunaba_issue_view": "allow",
    };

    it('"kaiba_remember" granted to any role', () => {
      const violations = checkAgentPermissions(
        { ...READ_CORE, "kaiba_recall": "allow", "kaiba_progress": "allow", "kaiba_remember": "allow" },
        "review",
      );
      assert.ok(violations.some(v => v.includes("kaiba_remember")));
    });

    it('a "kaiba*" glob is a violation — it re-allows remember by pattern', () => {
      const violations = checkAgentPermissions({ ...READ_CORE, "kaiba*": "allow" }, "review");
      assert.ok(violations.some(v => v.includes("kaiba*")));
    });

    it('"kaiba_recall" and "kaiba_progress" pass', () => {
      const violations = checkAgentPermissions(
        { ...READ_CORE, "kaiba_recall": "allow", "kaiba_progress": "allow" },
        "review",
      );
      assert.deepEqual(violations, []);
    });

    it('"kaiba_recall" alone passes', () => {
      const violations = checkAgentPermissions({ ...READ_CORE, "kaiba_recall": "allow" }, "review");
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

// ---------------------------------------------------------------------------
// kusabi #408 / #409 — the two new dispatch-only phase agents
// ---------------------------------------------------------------------------

describe("test-author and plan agent files", () => {
  const testAuthorPath = join(AGENTS_DIR, "kusabi-test-author.md");
  const planPath = join(AGENTS_DIR, "kusabi-plan.md");

  it("both new agent files exist", () => {
    assert.ok(existsSync(testAuthorPath), "kusabi-test-author.md missing");
    assert.ok(existsSync(planPath), "kusabi-plan.md missing");
  });

  it("kusabi-test-author: permission invariants hold and denies all first", () => {
    const fm = parseFrontmatter(readFileSync(testAuthorPath, "utf-8"));
    assert.ok(fm !== null, "could not parse frontmatter");
    const permission = fm.permission;
    assert.ok(permission !== null && typeof permission === "object");
    // \"*\": deny MUST be the first entry.
    assert.equal(permission["*"], "deny");
    const violations = checkAgentPermissions(permission, "test-author");
    assert.deepEqual(violations, [], `test-author violations:\n  ${violations.join("\n  ")}`);
    // Expected allows present (implement-family edit/read/verify tools).
    for (const tool of [
      "sunaba_write_file",
      "sunaba_edit_file",
      "sunaba_transform_file",
      "sunaba_undo_file_edit",
      "sunaba_verify_in_container",
      "sunaba_lint_in_container",
      "sunaba_type_check_in_container",
      "sunaba_sandbox_exec",
      "sunaba_sandbox_attach",
      "sunaba_read_file_range",
      "sunaba_search_in_container",
      "sunaba_list_files",
      "sunaba_diff_in_container",
      "sunaba_issue_view",
    ]) {
      assert.equal(permission[tool], "allow", `test-author must allow ${tool}`);
    }
    // Forbidden tools absent: issue write, publish / init / stop, run_python.
    for (const tool of [
      "sunaba_sandbox_issue_write",
      "sunaba_publish",
      "sunaba_sandbox_initialize",
      "sunaba_sandbox_stop",
      "sunaba_run_container_and_exec",
      "sunaba_run_python",
    ]) {
      assert.notEqual(permission[tool], "allow", `test-author must NOT allow ${tool}`);
    }
  });

  it("kusabi-plan: read-only invariants hold and denies all first", () => {
    const fm = parseFrontmatter(readFileSync(planPath, "utf-8"));
    assert.ok(fm !== null, "could not parse frontmatter");
    const permission = fm.permission;
    assert.ok(permission !== null && typeof permission === "object");
    assert.equal(permission["*"], "deny");
    const violations = checkAgentPermissions(permission, "plan");
    assert.deepEqual(violations, [], `plan violations:\n  ${violations.join("\n  ")}`);
    // Expected read-side allows present.
    for (const tool of [
      "sunaba_sandbox_attach",
      "sunaba_read_file_range",
      "sunaba_search_in_container",
      "sunaba_list_files",
      "sunaba_diff_in_container",
      "sunaba_issue_view",
      "sunaba_verify_in_container",
      "sunaba_lint_in_container",
      "sunaba_type_check_in_container",
      "sunaba_sandbox_exec",
    ]) {
      assert.equal(permission[tool], "allow", `plan must allow ${tool}`);
    }
    // Forbidden: no edit tools, no issue write, no shiori, no run_python,
    // no publish / init / stop.
    for (const tool of [
      "sunaba_write_file",
      "sunaba_edit_file",
      "sunaba_transform_file",
      "sunaba_undo_file_edit",
      "sunaba_sandbox_issue_write",
      "sunaba_run_python",
      "shiori*",
      "sunaba_publish",
      "sunaba_sandbox_initialize",
      "sunaba_sandbox_stop",
    ]) {
      assert.notEqual(permission[tool], "allow", `plan must NOT allow ${tool}`);
    }
  });
});
