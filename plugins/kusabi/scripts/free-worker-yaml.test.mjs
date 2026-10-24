// plugins/kusabi/scripts/free-worker-yaml.test.mjs
// PR755 strict YAML replacement: acceptance tests authored BEFORE the
// implementation exists.  These pin the replacement of the hand-written
// line/regex parser with strict YAML parsing.
//
// Frozen acceptance criteria covered here:
// 1. Duplicate YAML mapping keys in security-relevant frontmatter are refused:
//    duplicate top-level `permission` (either order, quoted spelling of the
//    same key), duplicate constrained read/bash, and a duplicated nested skill
//    pattern.  The transform throws; the classifier reports "unknown".
// 2. Malformed YAML, unsupported tags, aliases/merge keys and non-mapping
//    permissions fail closed (never reinterpreted as an absent/default block).
//    Ordinary comments at any indentation, quoted keys/scalars and existing
//    nested skill mappings still parse.
// 3. Installed malformed content cannot be upgraded to trusted default/free by
//    a durable marker, and the real cmdInstallAgents entry path writes no
//    partial agent or marker for a duplicate-key template.
// 4. Shipped templates remain default-safe and transform idempotently to
//    read:allow / bash:deny (review also StructuredOutput:allow), preserving
//    vetted MCP/skill rules and bodies without expanding host keys/globs.
//
// Behaviour is asserted only through the public helpers the task names; no
// output formatting or parsing library is prescribed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { cmdInstallAgents } from "./host-cmd.mjs";
import { patchEnv } from "./fixtures.mjs";
import {
  assertInstalledAgentProfile,
  classifyInstalledAgentContent,
  detectInstalledAgentProfile,
  transformAgentForOptIn,
  writeInstalledAgentProfile,
} from "./free-worker-profile.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.resolve(__dirname, "..", "opencode-agents");

// Wrap a frontmatter body in an agent document with a trailing body.
function agentDoc(inner) {
  return `---\n${inner}\n---\nbody\n`;
}

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// Criterion 1: duplicate mapping keys are refused
// ---------------------------------------------------------------------------

describe("PR755 strict YAML: duplicate mapping keys in security-relevant frontmatter", () => {
  const VALID_PERMISSION = `permission:
  "*": deny
  read: allow
  bash: deny`;

  // Duplicate top-level `permission`.  A last-wins reader keeps the broadened
  // second block; a strict reader must refuse the duplicate.  `"permission"`
  // is the same key as `permission` in YAML, so quoting is not an escape.
  const DUP_TOP_LEVEL = [
    `name: kusabi-implement\n${VALID_PERMISSION}\npermission:\n  "*": deny\n  read: allow`,
    `name: kusabi-implement\n${VALID_PERMISSION}\n"permission":\n  "*": deny\n  read: allow`,
    `name: kusabi-implement\n"permission":\n  "*": deny\n  read: allow\n${VALID_PERMISSION}`,
    `name: kusabi-implement\npermission:\n  "*": deny\n  read: allow\n${VALID_PERMISSION}`,
  ];

  it("transform refuses duplicate top-level permission keys in either order and quoting", () => {
    for (const inner of DUP_TOP_LEVEL) {
      assert.throws(
        () => transformAgentForOptIn(agentDoc(inner)),
        /duplicate|permission|parse/i,
        `must refuse duplicate top-level permission:\n${inner}`,
      );
    }
  });

  it("classifier never reads duplicate-permission content as trusted default/free", () => {
    for (const inner of DUP_TOP_LEVEL) {
      assert.equal(
        classifyInstalledAgentContent(agentDoc(inner)),
        "unknown",
        `must classify unknown:\n${inner}`,
      );
    }
  });

  const DUP_RULE = [
    [
      "duplicate constrained read",
      `name: kusabi-implement\npermission:\n  "*": deny\n  read: allow\n  read: allow`,
    ],
    [
      "duplicate constrained bash",
      `name: kusabi-implement\npermission:\n  "*": deny\n  read: allow\n  bash: deny\n  bash: deny`,
    ],
    [
      "duplicate nested skill pattern",
      `name: kusabi-implement\npermission:\n  "*": deny\n  read: allow\n  bash: deny\n  skill:\n    "kusabi-*": allow\n    "kusabi-*": allow`,
    ],
  ];

  it("transform refuses duplicate constrained rules and a duplicated nested skill pattern", () => {
    for (const [label, inner] of DUP_RULE) {
      assert.throws(
        () => transformAgentForOptIn(agentDoc(inner)),
        /duplicate|skill|permission/i,
        label,
      );
    }
  });

  it("classifier marks duplicate-rule content unknown", () => {
    for (const [label, inner] of DUP_RULE) {
      assert.equal(classifyInstalledAgentContent(agentDoc(inner)), "unknown", label);
    }
  });
});

// ---------------------------------------------------------------------------
// Criterion 2: malformed / ambiguous YAML fails closed
// ---------------------------------------------------------------------------

describe("PR755 strict YAML: malformed or ambiguous frontmatter fails closed", () => {
  const MALFORMED = [
    ["tab-indented permission mapping", `name: kusabi-implement\npermission:\n\t"*": deny\n\tread: allow`],
    ["non-mapping scalar permission", "name: kusabi-implement\npermission: allow"],
    ["non-mapping sequence permission", "name: kusabi-implement\npermission:\n  - read"],
    ["undefined alias as permission", "name: kusabi-implement\npermission: *undefined_defaults"],
    [
      "undefined merge key inside permission",
      `name: kusabi-implement\npermission:\n  "<<": *undefined_base\n  "*": deny`,
    ],
    ["unsupported JS tag on permission", 'name: kusabi-implement\npermission: !!js/function "x"'],
  ];

  it("transform refuses malformed/ambiguous YAML instead of treating it as absent", () => {
    for (const [label, inner] of MALFORMED) {
      assert.throws(() => transformAgentForOptIn(agentDoc(inner)), Error, label);
    }
  });

  it("classifier marks malformed/ambiguous YAML unknown, never default", () => {
    for (const [label, inner] of MALFORMED) {
      assert.equal(classifyInstalledAgentContent(agentDoc(inner)), "unknown", label);
    }
  });

  it("ordinary comments, quoted keys/scalars and nested skill maps still parse", () => {
    const commented = `name: kusabi-implement
# leading comment
permission:
  # indented comment
  "*": deny   # wildcard
  sunaba_read_file_range: allow`;
    const once = transformAgentForOptIn(agentDoc(commented));
    assert.equal(
      transformAgentForOptIn(once),
      once,
      "valid commented input must transform idempotently",
    );

    const nested = `name: kusabi-implement
permission:
  "*": deny
  skill:
    "kusabi-*": allow`;
    const nestedOut = transformAgentForOptIn(agentDoc(nested));
    assert.match(nestedOut, /"kusabi-\*": allow/, "nested skill mapping must be preserved");
    assert.equal(
      transformAgentForOptIn(nestedOut),
      nestedOut,
      "valid nested input must transform idempotently",
    );
  });
});

// ---------------------------------------------------------------------------
// Criterion 3: markers cannot upgrade malformed installed content
// ---------------------------------------------------------------------------

describe("PR755 strict YAML: installed malformed content cannot be marker-upgraded", () => {
  it("a free marker cannot make duplicate-permission content trusted in opt-in", () => {
    const tmp = mkTmp("kusabi-pr755-yaml-free-");
    const dir = path.join(tmp, "agent");
    try {
      fs.mkdirSync(dir, { recursive: true });
      writeInstalledAgentProfile(dir, "free");
      fs.writeFileSync(
        path.join(dir, "kusabi-implement.md"),
        agentDoc(
          `name: kusabi-implement\npermission:\n  "*": deny\n  read: allow\n  bash: deny\npermission:\n  "*": deny\n  read: allow`,
        ),
        "utf8",
      );
      assert.equal(detectInstalledAgentProfile(dir), "unknown");
      assert.throws(() => assertInstalledAgentProfile(dir, true), /unknown|conflicting/i);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a default marker cannot make tab-indented malformed content trusted in opt-out", () => {
    const tmp = mkTmp("kusabi-pr755-yaml-default-");
    const dir = path.join(tmp, "agent");
    try {
      fs.mkdirSync(dir, { recursive: true });
      writeInstalledAgentProfile(dir, "default");
      fs.writeFileSync(
        path.join(dir, "kusabi-implement.md"),
        agentDoc(`name: kusabi-implement\npermission:\n\t"*": deny`),
        "utf8",
      );
      assert.equal(detectInstalledAgentProfile(dir), "unknown");
      assert.throws(() => assertInstalledAgentProfile(dir, false), /unknown|conflicting/i);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("real cmdInstallAgents writes no agent or marker for a duplicate-key template", () => {
    const tmp = mkTmp("kusabi-pr755-yaml-install-");
    const dest = path.join(tmp, "dest");
    const restoreEnv = patchEnv({
      KUSABI_OPENCODE_FREE_WORKER: "1",
      OPENCODE_AGENT_DIR: dest,
      KUSABI_OPENCODE_CONFIG_HOME: path.join(tmp, "cfg"),
    });
    try {
      const src = path.join(tmp, "agents");
      const skillSrc = path.join(tmp, "skills");
      fs.mkdirSync(src, { recursive: true });
      fs.mkdirSync(skillSrc, { recursive: true });
      fs.writeFileSync(
        path.join(src, "a-ok.md"),
        agentDoc(`name: kusabi-implement\npermission:\n  "*": deny\n  sunaba_sandbox_exec: allow`),
        "utf8",
      );
      fs.writeFileSync(
        path.join(src, "b-duplicate.md"),
        agentDoc(
          `name: kusabi-implement\npermission:\n  "*": deny\n  read: allow\n  bash: deny\npermission:\n  "*": deny\n  read: allow`,
        ),
        "utf8",
      );
      assert.throws(
        () => cmdInstallAgents({ sourceDir: src, skillSourceDir: skillSrc }),
        /duplicate|permission|parse/i,
        "the real install entry path must reject the duplicate-key template",
      );
      assert.equal(fs.existsSync(dest), false, "a refused install must not create the destination");
      assert.equal(
        fs.existsSync(path.join(dest, ".kusabi-install-profile.json")),
        false,
        "a refused install must not write the profile marker",
      );
    } finally {
      restoreEnv();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Criterion 4: shipped templates still transform safely
// ---------------------------------------------------------------------------

describe("PR755 strict YAML: shipped templates still transform safely", () => {
  it("every repository template is default-safe and transforms idempotently within the profile", () => {
    const files = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));
    assert.ok(files.length > 0, "must find repository templates");
    const forbiddenHostGrant = /^\s+(?:write|edit|patch|terminal|read\*|write\*|\*\*|sunaba_\*):/m;
    for (const file of files) {
      const src = fs.readFileSync(path.join(AGENTS_DIR, file), "utf8");
      assert.equal(classifyInstalledAgentContent(src), "default", `${file} template must be default-safe`);
      const once = transformAgentForOptIn(src);
      assert.equal(classifyInstalledAgentContent(once), "free", `${file} transformed must be free`);
      assert.equal(transformAgentForOptIn(once), once, `${file} must transform idempotently`);
      assert.match(once, /read:\s*allow/, `${file} must grant read: allow`);
      assert.match(once, /bash:\s*deny/, `${file} must deny bash`);
      assert.doesNotMatch(
        once,
        forbiddenHostGrant,
        `${file} must not introduce a host key or general glob`,
      );
    }
  });

  it("review gains StructuredOutput allow while vetted rules and bodies are preserved", () => {
    const review = fs.readFileSync(path.join(AGENTS_DIR, "kusabi-review.md"), "utf8");
    const reviewOut = transformAgentForOptIn(review);
    assert.match(reviewOut, /StructuredOutput:\s*allow/, "review agent must grant StructuredOutput: allow");
    assert.match(reviewOut, /shiori\*: allow/, "vetted shiori family glob must be preserved");
    assert.match(reviewOut, /kaiba_recall: allow/, "vetted MCP rule must be preserved");

    const implement = fs.readFileSync(path.join(AGENTS_DIR, "kusabi-implement.md"), "utf8");
    assert.match(
      transformAgentForOptIn(implement),
      /"kusabi-\*": allow/,
      "vetted nested skill mapping must be preserved",
    );

    const gofer = fs.readFileSync(path.join(AGENTS_DIR, "kusabi-gofer.md"), "utf8");
    const body = gofer.slice(gofer.indexOf("\n---\n") + 5);
    assert.ok(body.length > 0, "gofer template must have a body");
    assert.ok(
      transformAgentForOptIn(gofer).endsWith(body),
      "non-review agent body must be preserved verbatim",
    );
  });

  it("accepts both read: allow and legacy read: ask as free", () => {
    const freeAllow = agentDoc(`name: kusabi-implement\npermission:\n  "*": deny\n  read: allow\n  bash: deny`);
    assert.equal(classifyInstalledAgentContent(freeAllow), "free");

    const freeLegacyAsk = agentDoc(`name: kusabi-implement\npermission:\n  "*": deny\n  read: ask\n  bash: deny`);
    assert.equal(classifyInstalledAgentContent(freeLegacyAsk), "free");

    const invalidDeny = agentDoc(`name: kusabi-implement\npermission:\n  "*": deny\n  read: deny\n  bash: deny`);
    assert.equal(classifyInstalledAgentContent(invalidDeny), "unknown");
  });
});
